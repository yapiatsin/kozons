import json
from datetime import timedelta
from unittest import mock

from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from accounts.models import User

from . import ai, registry, services as svc
from .models import Meeting, MeetingInvite, MeetingMessage, MeetingNotes, TranscriptLine


def jpost(client, url, data=None):
    return client.post('/api/' + url, json.dumps(data or {}), content_type='application/json')


class MeetApiTests(TestCase):
    def setUp(self):
        cache.clear()
        registry.reset()
        self.host = User.objects.create_user('host', password='x', display_name='Organisatrice')
        self.guest = User.objects.create_user('guest', password='x', display_name='Invité')
        self.other = User.objects.create_user('other', password='x')
        self.ch, self.cg, self.co = Client(), Client(), Client()
        self.ch.force_login(self.host)
        self.cg.force_login(self.guest)
        self.co.force_login(self.other)

    def test_create_schedule_and_list(self):
        when = (timezone.now() + timedelta(days=1)).replace(microsecond=0)
        r = jpost(self.ch, 'meet', {'title': 'Point hebdo', 'scheduled_at': when.isoformat(), 'invitees': [self.guest.pk]})
        self.assertEqual(r.status_code, 200, r.content)
        meeting = r.json()
        self.assertRegex(meeting['code'], r'^[a-z]{3}-[a-z]{4}-[a-z]{3}$')
        self.assertEqual((meeting['role'], meeting['is_manager']), ('host', True))
        self.assertEqual([i['id'] for i in meeting['invites']], [self.guest.pk])
        scheduled = self.cg.get('/api/meet').json()['scheduled']
        self.assertEqual([m['code'] for m in scheduled], [meeting['code']])
        self.assertEqual(scheduled[0]['role'], 'invited')
        self.assertEqual(self.co.get('/api/meet').json()['scheduled'], [])

    def test_entry_rules(self):
        code = jpost(self.ch, 'meet').json()['code']
        meeting = Meeting.objects.get(code=code)
        MeetingInvite.objects.create(meeting=meeting, user=self.guest)
        # Lien collé tel quel, ou code sans tirets : même réunion.
        detail = self.co.get(f'/api/meet/{code.replace("-", "")}').json()
        self.assertEqual((detail['code'], detail['entry']), (code, 'ask'))
        self.assertEqual(self.cg.get(f'/api/meet/{code}').json()['entry'], 'join')
        meeting.access = Meeting.RESTRICTED
        meeting.save()
        detail = self.co.get(f'/api/meet/{code}').json()
        self.assertEqual(detail['entry'], 'denied')
        self.assertIn('invitées', detail['denied_reason'])
        meeting.access = Meeting.OPEN
        meeting.save()
        self.assertEqual(self.co.get(f'/api/meet/{code}').json()['entry'], 'join')
        self.assertEqual(self.co.get('/api/meet/zzz-zzzz-zzz').status_code, 404)

    def test_only_host_updates_and_cancels(self):
        code = jpost(self.ch, 'meet', {'title': 'A'}).json()['code']
        self.assertEqual(jpost(self.co, f'meet/{code}/update', {'title': 'B'}).status_code, 403)
        r = jpost(self.ch, f'meet/{code}/update', {'title': 'B', 'invitees': [self.guest.pk], 'cohosts': [self.guest.pk]})
        self.assertEqual(r.json()['invites'][0]['cohost'], True)
        self.assertEqual(self.cg.get(f'/api/meet/{code}').json()['role'], 'cohost')
        self.assertEqual(jpost(self.cg, f'meet/{code}/cancel').status_code, 403)
        jpost(self.ch, f'meet/{code}/cancel')
        self.assertEqual(self.cg.get(f'/api/meet/{code}').json()['entry'], 'denied')

    @override_settings(LIVE_MEDIA_URL='https://kozonstic.com/live-media')
    def test_media_tokens(self):
        meeting = Meeting.objects.create(host=self.host)
        info = svc.media_info(meeting, self.host, 'aaaa1111')
        cam = svc.media_path(meeting, 'aaaa1111', 'cam')

        def auth(action, token, path):
            return Client().post('/api/live/media-auth', json.dumps({'action': action, 'path': path, 'query': f'token={token}'}),
                                 content_type='application/json').status_code

        self.assertEqual(auth('publish', info['publish_token'], cam), 401)   # pas encore dans la réunion
        registry.admit(meeting.pk, 'chan-host', self.host.pk, role='host')
        self.assertEqual(auth('publish', info['publish_token'], cam), 200)
        self.assertEqual(auth('publish', info['publish_token'], svc.media_path(meeting, 'aaaa1111', 'scr')), 200)
        self.assertEqual(auth('publish', info['publish_token'], svc.media_path(meeting, 'bbbb2222', 'cam')), 401)  # flux d'un autre
        self.assertEqual(auth('read', info['read_token'], svc.media_path(meeting, 'bbbb2222', 'cam')), 200)
        self.assertEqual(auth('read', info['publish_token'], cam), 401)
        other = Meeting.objects.create(host=self.host)
        self.assertEqual(auth('read', info['read_token'], svc.media_path(other, 'bbbb2222', 'cam')), 401)
        registry.leave(meeting.pk, 'chan-host')
        self.assertEqual(auth('read', info['read_token'], cam), 401)          # parti : plus d'accès


def make_notes(host, guest):
    meeting = Meeting.objects.create(host=host, title='Lancement produit')
    notes = MeetingNotes.objects.create(meeting=meeting, started_by=host, status=MeetingNotes.PROCESSING)
    notes.recipients.add(host, guest)
    TranscriptLine.objects.create(notes=notes, user=host, speaker='Organisatrice', text='on lance la version 2 vendredi')
    TranscriptLine.objects.create(notes=notes, user=guest, speaker='Invité', text='je prépare la page de vente')
    MeetingMessage.objects.create(meeting=meeting, user=guest, text='lien du maquettage : figma')
    notes.ended_at = timezone.now()
    notes.save(update_fields=['ended_at'])
    return notes


class MeetAiTests(TestCase):
    def setUp(self):
        self.host = User.objects.create_user('host', password='x', display_name='Organisatrice')
        self.guest = User.objects.create_user('guest', password='x', display_name='Invité')

    def test_document_includes_speakers_and_chat(self):
        doc, has_content = ai.build_document(make_notes(self.host, self.guest))
        self.assertTrue(has_content)
        self.assertIn('Intervenants : Invité, Organisatrice', doc)
        self.assertIn('] Invité : je prépare la page de vente', doc)
        self.assertIn('<chat>', doc)

    @override_settings(ANTHROPIC_API_KEY='')
    def test_without_key_keeps_transcript(self):
        notes = ai.summarize(make_notes(self.host, self.guest).pk)
        self.assertEqual(notes.status, MeetingNotes.NO_AI)

    @override_settings(ANTHROPIC_API_KEY='sk-test')
    def test_summary_saved(self):
        result = {'title': 'Lancement v2', 'summary': 'La v2 sort vendredi.', 'key_points': [], 'decisions': ['Sortie vendredi'],
                  'action_items': [{'task': 'Page de vente', 'owner': 'Invité', 'due': ''}], 'chapters': [], 'open_questions': []}
        with mock.patch.object(ai, '_ask_claude', return_value=(json.dumps(result), 'claude-opus-5-5')) as ask:
            notes = ai.summarize(make_notes(self.host, self.guest).pk)
        self.assertEqual((notes.status, notes.summary['decisions'], notes.model), ('ready', ['Sortie vendredi'], 'claude-opus-5-5'))
        self.assertIs(ask.call_args.kwargs['schema'], ai.NOTES_SCHEMA)
        client = Client()
        client.force_login(self.guest)
        detail = client.get(f'/api/meet/notes/{notes.pk}').json()
        self.assertEqual((detail['title'], len(detail['transcript']), len(detail['chat'])), ('Lancement v2', 2, 1))
        self.assertEqual([n['id'] for n in client.get('/api/meet/notes').json()['results']], [notes.pk])
        stranger = Client()
        stranger.force_login(User.objects.create_user('x', password='x'))
        self.assertEqual(stranger.get(f'/api/meet/notes/{notes.pk}').status_code, 404)

    @override_settings(ANTHROPIC_API_KEY='sk-test')
    def test_failure_is_reported(self):
        with mock.patch.object(ai, '_ask_claude', side_effect=RuntimeError('panne')):
            notes = ai.summarize(make_notes(self.host, self.guest).pk)
        self.assertEqual((notes.status, notes.error), ('failed', 'panne'))


class MeetRealtimeTests(TransactionTestCase):
    async def recv(self, comm, kind, match=None):
        for _ in range(40):
            evt = await comm.receive_json_from(timeout=2)
            if evt['type'] == kind and (match is None or match(evt['data'])):
                return evt['data']
        raise AssertionError(f'{kind} non reçu')

    async def connect(self, user):
        from chat.consumers import KozonsConsumer
        comm = WebsocketCommunicator(KozonsConsumer.as_asgi(), '/ws/')
        comm.scope['user'] = user
        ok, _ = await comm.connect()
        self.assertTrue(ok)
        return comm

    @override_settings(ANTHROPIC_API_KEY='')
    async def test_full_meeting(self):
        registry.reset()
        host = await sync_to_async(User.objects.create_user)('host', password='x', display_name='Awa')
        guest = await sync_to_async(User.objects.create_user)('guest', password='x', display_name='Koffi')
        meeting = await sync_to_async(Meeting.objects.create)(host=host, title='Réunion test')
        wh, wg = await self.connect(host), await self.connect(guest)

        await wh.send_json_to({'type': 'meet.join', 'code': meeting.code, 'mic': True, 'cam': False})
        joined = await self.recv(wh, 'meet.joined')
        self.assertEqual((joined['meeting']['role'], len(joined['peers']), joined['media']['mode']), ('host', 1, 'p2p'))
        host_peer = joined['me']

        # Invité non invité en mode « fiable » : salle d'attente, puis admis par l'organisatrice.
        await wg.send_json_to({'type': 'meet.join', 'code': meeting.code})
        self.assertTrue((await self.recv(wg, 'meet.waiting'))['managers_present'])
        knock = await self.recv(wh, 'meet.waiting_list', lambda d: d['waiting'])
        self.assertEqual(knock['waiting'][0]['user']['name'], 'Koffi')
        await wh.send_json_to({'type': 'meet.admit', 'meeting_id': meeting.pk, 'request_id': knock['waiting'][0]['id']})
        await self.recv(wg, 'meet.admitted')
        await wg.send_json_to({'type': 'meet.join', 'code': meeting.code})
        gjoined = await self.recv(wg, 'meet.joined')
        guest_peer = gjoined['me']
        self.assertEqual(len(gjoined['peers']), 2)
        self.assertEqual((await self.recv(wh, 'meet.peer', lambda d: d['peer'] == guest_peer))['user']['name'], 'Koffi')

        # Signalisation pair-à-pair, état, chat, réactions.
        await wg.send_json_to({'type': 'meet.signal', 'meeting_id': meeting.pk, 'to': host_peer, 'data': {'sdp': 'offre'}})
        sig = await self.recv(wh, 'meet.signal')
        self.assertEqual((sig['from'], sig['data']), (guest_peer, {'sdp': 'offre'}))
        await wg.send_json_to({'type': 'meet.state', 'meeting_id': meeting.pk, 'hand': True})
        self.assertIsNotNone((await self.recv(wh, 'meet.peer', lambda d: d['peer'] == guest_peer and d['hand']))['hand'])
        await wg.send_json_to({'type': 'meet.chat', 'meeting_id': meeting.pk, 'text': 'Bonjour à tous'})
        self.assertEqual((await self.recv(wh, 'meet.chat'))['text'], 'Bonjour à tous')
        await wg.send_json_to({'type': 'meet.react', 'meeting_id': meeting.pk, 'emoji': '🎉'})
        self.assertEqual((await self.recv(wh, 'meet.react'))['emoji'], '🎉')

        # Un participant ne gère pas la réunion.
        await wg.send_json_to({'type': 'meet.mute', 'meeting_id': meeting.pk, 'peer': host_peer})
        self.assertIn('organisateur', (await self.recv(wg, 'error'))['message'])

        # Micros désactivés par l'organisatrice : celui de l'invité est coupé et ne peut être rallumé.
        await wh.send_json_to({'type': 'meet.settings', 'meeting_id': meeting.pk, 'mic_allowed': False})
        self.assertEqual(await self.recv(wg, 'meet.forced'), {'meeting_id': meeting.pk, 'mic': False})
        await wg.send_json_to({'type': 'meet.state', 'meeting_id': meeting.pk, 'mic': True})
        self.assertIn('micros', (await self.recv(wg, 'error'))['message'])

        # Notes : la transcription envoyée par le navigateur est enregistrée, puis traitée à l'arrêt.
        await wh.send_json_to({'type': 'meet.notes', 'meeting_id': meeting.pk, 'on': True})
        state = await self.recv(wg, 'meet.notes', lambda d: d['active'])
        self.assertTrue(state['transcribe'])
        await wg.send_json_to({'type': 'meet.caption', 'meeting_id': meeting.pk, 'text': 'je présente le budget', 'final': True})
        caption = await self.recv(wh, 'meet.caption')
        self.assertEqual((caption['name'], caption['text']), ('Koffi', 'je présente le budget'))
        await wh.send_json_to({'type': 'meet.notes', 'meeting_id': meeting.pk, 'on': False})
        await self.recv(wg, 'meet.notes', lambda d: not d['active'])
        notes = await sync_to_async(MeetingNotes.objects.get)(meeting=meeting)
        self.assertEqual(await sync_to_async(notes.lines.count)(), 1)
        recipients = await sync_to_async(lambda: set(notes.recipients.values_list('pk', flat=True)))()
        self.assertEqual(recipients, {host.pk, guest.pk})

        # Retrait d'un participant, puis fin de la réunion.
        await wh.send_json_to({'type': 'meet.remove', 'meeting_id': meeting.pk, 'peer': guest_peer})
        await self.recv(wg, 'meet.removed')
        self.assertEqual((await self.recv(wh, 'meet.peer_left'))['peer'], guest_peer)
        await wh.send_json_to({'type': 'meet.end', 'meeting_id': meeting.pk})
        await self.recv(wh, 'meet.ended')
        self.assertEqual(registry.count(meeting.pk), 0)
        ended = await sync_to_async(Meeting.objects.get)(pk=meeting.pk)
        self.assertIsNotNone(ended.ended_at)
        await wh.disconnect()
        await wg.disconnect()

    async def test_disconnect_leaves(self):
        registry.reset()
        host = await sync_to_async(User.objects.create_user)('host', password='x')
        meeting = await sync_to_async(Meeting.objects.create)(host=host)
        wh = await self.connect(host)
        await wh.send_json_to({'type': 'meet.join', 'code': meeting.code})
        await self.recv(wh, 'meet.joined')
        self.assertEqual(registry.count(meeting.pk), 1)
        await wh.disconnect()
        self.assertEqual(registry.count(meeting.pk), 0)
