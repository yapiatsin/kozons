import json
import shutil
import tempfile

from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TransactionTestCase, override_settings

from accounts.models import User
from chat.models import Message, Participant

MEDIA = tempfile.mkdtemp()


def make_user(username, **kw):
    u = User.objects.create_user(username=username, password='secret123', **kw)
    c = Client()
    c.force_login(u)
    return u, c


def post(client, url, data=None, **kw):
    if data is not None and not kw.get('multipart'):
        return client.post('/api/' + url, json.dumps(data), content_type='application/json')
    return client.post('/api/' + url, data or {})


@override_settings(MEDIA_ROOT=MEDIA)
class ChatApiTests(TransactionTestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        cache.clear()  # compteurs de limitation de débit
        self.alice, self.ca = make_user('alice', display_name='Alice')
        self.bob, self.cb = make_user('bob', display_name='Bob')
        self.carol, self.cc = make_user('carol')

    def direct(self):
        r = post(self.ca, 'conversations/direct', {'user_id': self.bob.pk})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()['id']

    def test_auth_flow(self):
        c = Client()
        r = post(c, 'auth/register', {'username': 'dave', 'password': 'Motdepasse1', 'email': 'dave@example.com'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(c.get('/api/me').json()['user']['username'], 'dave')
        r = post(Client(), 'auth/register', {'username': 'dave', 'password': 'Motdepasse1', 'email': 'dave@example.com'})
        self.assertEqual(r.status_code, 400)
        r = post(Client(), 'auth/login', {'username': 'dave', 'password': 'mauvais'})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(Client().get('/api/conversations').status_code, 401)

    def test_direct_is_unique(self):
        a = self.direct()
        b = post(self.cb, 'conversations/direct', {'user_id': self.alice.pk}).json()['id']
        self.assertEqual(a, b)

    def test_send_read_and_unread_counts(self):
        cid = self.direct()
        for i in range(3):
            r = post(self.ca, f'conversations/{cid}/messages', {'text': f'salut {i}'})
            self.assertEqual(r.status_code, 200, r.content)
        convs = self.cb.get('/api/conversations').json()['results']
        self.assertEqual(convs[0]['unread'], 3)
        self.assertEqual(convs[0]['last_message']['text'], 'salut 2')
        last = convs[0]['last_message']['id']
        post(self.cb, f'conversations/{cid}/read', {'message_id': last})
        self.assertEqual(self.cb.get('/api/conversations').json()['results'][0]['unread'], 0)
        alice_view = self.ca.get(f'/api/conversations/{cid}').json()
        bob_part = next(p for p in alice_view['participants'] if p['user']['id'] == self.bob.pk)
        self.assertEqual(bob_part['last_read_id'], last)

    def test_outsider_cannot_read(self):
        cid = self.direct()
        self.assertEqual(self.cc.get(f'/api/conversations/{cid}/messages').status_code, 404)
        self.assertEqual(post(self.cc, f'conversations/{cid}/messages', {'text': 'intrus'}).status_code, 404)

    def test_pagination(self):
        cid = self.direct()
        conv_msgs = [Message(conversation_id=cid, sender=self.alice, text=str(i)) for i in range(120)]
        Message.objects.bulk_create(conv_msgs)
        r = self.cb.get(f'/api/conversations/{cid}/messages').json()
        self.assertEqual(len(r['results']), 50)
        self.assertTrue(r['has_more'])
        self.assertEqual(r['results'][-1]['text'], '119')
        older = self.cb.get(f'/api/conversations/{cid}/messages?before={r["results"][0]["id"]}').json()
        self.assertEqual(older['results'][-1]['text'], '69')

    def test_edit_delete_react_star(self):
        cid = self.direct()
        mid = post(self.ca, f'conversations/{cid}/messages', {'text': 'bonjour'}).json()['id']
        self.assertEqual(post(self.cb, f'messages/{mid}/edit', {'text': 'pirate'}).status_code, 403)
        self.assertEqual(post(self.ca, f'messages/{mid}/edit', {'text': 'bonsoir'}).status_code, 200)
        post(self.cb, f'messages/{mid}/react', {'emoji': '❤️'})
        post(self.cb, f'messages/{mid}/star')
        msg = self.cb.get(f'/api/conversations/{cid}/messages').json()['results'][-1]
        self.assertEqual(msg['text'], 'bonsoir')
        self.assertEqual(msg['reactions'], [{'user_id': self.bob.pk, 'emoji': '❤️'}])
        self.assertTrue(msg['starred'])
        self.assertEqual(post(self.cb, f'messages/{mid}/delete', {'scope': 'everyone'}).status_code, 403)
        post(self.cb, f'messages/{mid}/delete', {'scope': 'me'})
        self.assertEqual(self.cb.get(f'/api/conversations/{cid}/messages').json()['results'], [])
        post(self.ca, f'messages/{mid}/delete', {'scope': 'everyone'})
        msg = self.ca.get(f'/api/conversations/{cid}/messages').json()['results'][-1]
        self.assertTrue(msg['deleted'])
        self.assertEqual(msg['text'], '')

    def test_block(self):
        cid = self.direct()
        post(self.cb, f'users/{self.alice.pk}/block')
        r = post(self.ca, f'conversations/{cid}/messages', {'text': 'hello'})
        self.assertEqual(r.status_code, 403)
        post(self.cb, f'users/{self.alice.pk}/block')  # débloque
        self.assertEqual(post(self.ca, f'conversations/{cid}/messages', {'text': 'hello'}).status_code, 200)

    def test_group_permissions(self):
        r = post(self.ca, 'conversations/group', {'title': 'Équipe', 'member_ids': [self.bob.pk]})
        self.assertEqual(r.status_code, 200, r.content)
        gid = r.json()['id']
        self.assertEqual(post(self.cb, f'conversations/{gid}/members', {'action': 'add', 'member_ids': [self.carol.pk]}).status_code, 403)
        post(self.ca, f'conversations/{gid}/members', {'action': 'add', 'member_ids': [self.carol.pk]})
        self.assertTrue(Participant.objects.filter(conversation_id=gid, user=self.carol).exists())
        post(self.ca, f'conversations/{gid}/update', {'only_admins_can_send': True})
        self.assertEqual(post(self.cc, f'conversations/{gid}/messages', {'text': 'x'}).status_code, 403)
        post(self.ca, f'conversations/{gid}/members', {'action': 'promote', 'member_ids': [self.carol.pk]})
        self.assertEqual(post(self.cc, f'conversations/{gid}/messages', {'text': 'x'}).status_code, 200)
        # Le dernier admin qui part transmet ses droits.
        post(self.cc, f'conversations/{gid}/members', {'action': 'demote', 'member_ids': [self.carol.pk]})
        post(self.ca, f'conversations/{gid}/members', {'action': 'leave'})
        self.assertTrue(Participant.objects.filter(conversation_id=gid, role='admin').exists())

    def test_poll(self):
        cid = self.direct()
        r = self.ca.post(f'/api/conversations/{cid}/messages', {'kind': 'poll', 'text': 'Pizza ?', 'options': ['Oui', 'Non']})
        self.assertEqual(r.status_code, 200, r.content)
        msg = r.json()
        opt = msg['poll']['options'][0]['id']
        post(self.cb, f'messages/{msg["id"]}/vote', {'option_id': opt})
        poll = self.ca.get(f'/api/conversations/{cid}/messages').json()['results'][-1]['poll']
        self.assertEqual(poll['options'][0]['votes'], [self.bob.pk])

    def test_file_upload_and_view_once(self):
        cid = self.direct()
        png = SimpleUploadedFile('photo.png', b'\x89PNG\r\n\x1a\n' + b'0' * 100, content_type='image/png')
        r = self.ca.post(f'/api/conversations/{cid}/messages', {'file': png, 'view_once': '1'})
        self.assertEqual(r.status_code, 200, r.content)
        msg = r.json()
        self.assertEqual(msg['kind'], 'image')
        bob_msg = self.cb.get(f'/api/conversations/{cid}/messages').json()['results'][-1]
        self.assertIsNone(bob_msg['file'])  # caché jusqu'à l'ouverture
        self.assertEqual(post(self.cb, f'messages/{msg["id"]}/open').status_code, 200)
        self.assertEqual(post(self.cb, f'messages/{msg["id"]}/open').status_code, 410)
        bad = SimpleUploadedFile('x.html', b'<script>', content_type='text/html')
        self.assertEqual(self.ca.post(f'/api/conversations/{cid}/messages', {'file': bad}).status_code, 400)

    def test_forward_and_search(self):
        cid = self.direct()
        other = post(self.ca, 'conversations/direct', {'user_id': self.carol.pk}).json()['id']
        mid = post(self.ca, f'conversations/{cid}/messages', {'text': 'réunion demain 10h'}).json()['id']
        self.assertEqual(post(self.ca, f'messages/{mid}/forward', {'conversation_ids': [other]}).status_code, 200)
        fwd = self.cc.get(f'/api/conversations/{other}/messages').json()['results'][-1]
        self.assertTrue(fwd['forwarded'])
        hits = self.cc.get('/api/messages/search?q=réunion').json()['results']
        self.assertEqual(len(hits), 1)  # Carol ne voit pas la discussion Alice-Bob

    def test_disappearing(self):
        cid = self.direct()
        post(self.ca, f'conversations/{cid}/update', {'disappearing_seconds': 86400})
        m = post(self.ca, f'conversations/{cid}/messages', {'text': 'éphémère'}).json()
        self.assertIsNotNone(m['expires_at'])
        Message.objects.filter(pk=m['id']).update(expires_at='2000-01-01T00:00:00Z')
        texts = [x['text'] for x in self.cb.get(f'/api/conversations/{cid}/messages').json()['results']]
        self.assertNotIn('éphémère', texts)


class ConsumerTests(TransactionTestCase):
    async def test_realtime_message_typing_and_call(self):
        alice = await sync_to_async(User.objects.create_user)('alice', password='secret123')
        bob = await sync_to_async(User.objects.create_user)('bob', password='secret123')

        # On attache l'utilisateur au scope directement (sans cookie de session).
        from chat.consumers import KozonsConsumer

        async def connect_direct(user):
            comm = WebsocketCommunicator(KozonsConsumer.as_asgi(), '/ws/')
            comm.scope['user'] = user
            ok, _ = await comm.connect()
            self.assertTrue(ok)
            return comm

        wa = await connect_direct(alice)
        wb = await connect_direct(bob)

        from chat import services
        conv = await sync_to_async(services.get_or_create_direct)(alice, bob)
        await sync_to_async(services.create_message)(conv, alice, kind='text', text='yo')
        evt = await wb.receive_json_from(timeout=2)
        while evt['type'] != 'message.new':
            evt = await wb.receive_json_from(timeout=2)
        self.assertEqual(evt['data']['text'], 'yo')

        await wb.send_json_to({'type': 'typing', 'conversation_id': conv.pk, 'state': 'typing'})
        evt = await wa.receive_json_from(timeout=2)
        while evt['type'] != 'typing':
            evt = await wa.receive_json_from(timeout=2)
        self.assertEqual(evt['data']['user_id'], bob.pk)

        await wa.send_json_to({'type': 'call.start', 'to': bob.pk, 'video': True})
        got_incoming = False
        for _ in range(6):
            evt = await wb.receive_json_from(timeout=2)
            if evt['type'] == 'call.incoming':
                got_incoming = True
                call_id = evt['data']['call']['id']
                break
        self.assertTrue(got_incoming)
        await wb.send_json_to({'type': 'call.accept', 'call_id': call_id})
        for _ in range(6):
            evt = await wa.receive_json_from(timeout=2)
            if evt['type'] == 'call.accepted':
                break
        self.assertEqual(evt['type'], 'call.accepted')
        await wa.send_json_to({'type': 'call.signal', 'call_id': call_id, 'data': {'sdp': {'type': 'offer', 'sdp': 'x'}}})
        for _ in range(6):
            evt = await wb.receive_json_from(timeout=2)
            if evt['type'] == 'call.signal':
                break
        self.assertEqual(evt['data']['data']['sdp']['type'], 'offer')

        await wa.disconnect()
        await wb.disconnect()
