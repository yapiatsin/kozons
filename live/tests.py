import json
from datetime import timedelta

from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from accounts.models import User
from social.models import Follow

from . import registry, services as svc
from .models import LiveComment, LiveStream


def jpost(client, url, data=None):
    return client.post('/api/' + url, json.dumps(data or {}), content_type='application/json')


class LiveApiTests(TestCase):
    def setUp(self):
        cache.clear()
        registry.reset()
        self.host = User.objects.create_user('host', password='x', display_name='Animateur')
        self.fan = User.objects.create_user('fan', password='x')
        self.stranger = User.objects.create_user('stranger', password='x')
        self.ch, self.cf, self.cs = Client(), Client(), Client()
        self.ch.force_login(self.host)
        self.cf.force_login(self.fan)
        self.cs.force_login(self.stranger)
        Follow.objects.create(follower=self.fan, following=self.host)

    def test_start_list_detail_end(self):
        r = jpost(self.ch, 'live', {'title': 'Soirée questions', 'audience': 'public'})
        self.assertEqual(r.status_code, 200, r.content)
        live = r.json()
        self.assertEqual((live['is_host'], live['media']['mode']), (True, 'p2p'))
        listed = self.cf.get('/api/live').json()['results']
        self.assertEqual([(l['id'], l['following']) for l in listed], [(live['id'], True)])
        detail = self.cs.get(f'/api/live/{live["id"]}').json()
        self.assertEqual((detail['status'], detail['comments'], detail['banned']), ('live', [], False))
        self.assertEqual(len(detail['gifts_catalog']), 8)
        end = jpost(self.ch, f'live/{live["id"]}/end').json()
        self.assertIn('duration', end['summary'])
        self.assertEqual(self.cf.get('/api/live').json()['results'], [])
        self.assertEqual(jpost(self.cf, f'live/{live["id"]}/end').status_code, 404)  # pas l'animateur

    def test_one_live_at_a_time(self):
        first = jpost(self.ch, 'live').json()['id']
        jpost(self.ch, 'live')
        self.assertEqual(LiveStream.objects.get(pk=first).status, 'ended')

    def test_followers_only(self):
        live = jpost(self.ch, 'live', {'audience': 'followers'}).json()['id']
        self.assertEqual(self.cf.get(f'/api/live/{live}').status_code, 200)
        self.assertEqual(self.cs.get(f'/api/live/{live}').status_code, 403)
        self.assertEqual(self.cs.get('/api/live').json()['results'], [])

    def test_stale_live_expires(self):
        live = jpost(self.ch, 'live').json()['id']
        LiveStream.objects.filter(pk=live).update(host_seen_at=timezone.now() - timedelta(minutes=2))
        self.assertEqual(self.cf.get('/api/live').json()['results'], [])
        self.assertEqual(LiveStream.objects.get(pk=live).status, 'ended')

    @override_settings(LIVE_MEDIA_URL='https://kozonstic.com/live-media')
    def test_media_server_tokens(self):
        live = jpost(self.ch, 'live').json()
        self.assertTrue(live['media']['url'].startswith('https://kozonstic.com/live-media/k'))
        self.assertIn('/whip?token=', live['media']['url'])
        obj = LiveStream.objects.get(pk=live['id'])
        publish = svc.media_token(obj, self.host, 'publish')
        read = svc.media_token(obj, self.fan, 'read')

        def auth(action, token, path=obj.media_path):
            return Client().post('/api/live/media-auth', json.dumps({'action': action, 'path': path, 'query': f'token={token}'}),
                                 content_type='application/json').status_code

        self.assertEqual(auth('publish', publish), 200)
        self.assertEqual(auth('read', read), 200)
        self.assertEqual(auth('publish', read), 401)                      # un spectateur ne publie pas
        self.assertEqual(auth('read', read, path='kautre'), 401)          # autre live
        self.assertEqual(auth('publish', svc.media_token(obj, self.fan, 'publish')), 401)
        obj.bans.create(user=self.fan)
        self.assertEqual(auth('read', read), 401)                         # exclu
        self.assertIn('/whep?token=', self.cs.get(f'/api/live/{obj.pk}').json()['media']['url'])

    def test_new_follower_counted(self):
        live = jpost(self.ch, 'live').json()['id']
        jpost(self.cs, f'users/{self.host.pk}/follow')
        self.assertEqual(LiveStream.objects.get(pk=live).new_followers, 1)


class LiveRealtimeTests(TransactionTestCase):
    async def recv(self, comm, kind):
        for _ in range(30):
            evt = await comm.receive_json_from(timeout=2)
            if evt['type'] == kind:
                return evt['data']
        raise AssertionError(f'{kind} non reçu')

    async def connect(self, user):
        from chat.consumers import KozonsConsumer
        comm = WebsocketCommunicator(KozonsConsumer.as_asgi(), '/ws/')
        comm.scope['user'] = user
        ok, _ = await comm.connect()
        self.assertTrue(ok)
        return comm

    async def test_full_live_session(self):
        registry.reset()
        host = await sync_to_async(User.objects.create_user)('host', password='x')
        fan = await sync_to_async(User.objects.create_user)('fan', password='x')
        live = await sync_to_async(LiveStream.objects.create)(host=host, title='Test')
        wh, wf = await self.connect(host), await self.connect(fan)

        await wh.send_json_to({'type': 'live.host', 'live_id': live.pk})
        self.assertEqual((await self.recv(wh, 'live.hosting'))['viewers'], 0)

        await wf.send_json_to({'type': 'live.join', 'live_id': live.pk})
        self.assertEqual((await self.recv(wf, 'live.joined'))['viewers'], 1)
        self.assertEqual((await self.recv(wh, 'live.viewers'))['count'], 1)
        peer = (await self.recv(wh, 'live.peer'))['peer']  # mode pair-à-pair : l'animateur est prévenu

        # Signalisation vidéo animateur -> spectateur.
        await wh.send_json_to({'type': 'live.signal', 'live_id': live.pk, 'to': peer, 'data': {'sdp': 'offre'}})
        self.assertEqual((await self.recv(wf, 'live.signal'))['data'], {'sdp': 'offre'})

        await wf.send_json_to({'type': 'live.comment', 'live_id': live.pk, 'text': '  Bravo   !  '})
        comment = await self.recv(wh, 'live.comment')
        self.assertEqual(comment['text'], 'Bravo !')
        await wf.send_json_to({'type': 'live.like', 'live_id': live.pk, 'count': 12})
        self.assertEqual((await self.recv(wh, 'live.likes'))['total'], 12)
        await wf.send_json_to({'type': 'live.gift', 'live_id': live.pk, 'gift': 'lion'})
        self.assertEqual((await self.recv(wh, 'live.gift'))['gift']['emoji'], '🦁')

        # Réponse de l'animateur au commentaire du spectateur.
        await wh.send_json_to({'type': 'live.comment', 'live_id': live.pk, 'text': 'Merci !', 'reply_to': comment['id']})
        reply = await self.recv(wf, 'live.comment')
        while reply['text'] != 'Merci !':  # écho du propre commentaire du spectateur, reçu avant
            reply = await self.recv(wf, 'live.comment')
        self.assertEqual((reply['text'], reply['reply_to']['id'], reply['reply_to']['text'], reply['reply_to']['user_id']),
                         ('Merci !', comment['id'], 'Bravo !', fan.pk))

        await wh.send_json_to({'type': 'live.pin', 'live_id': live.pk, 'comment_id': comment['id']})
        self.assertEqual((await self.recv(wf, 'live.pinned'))['comment']['text'], 'Bravo !')

        # Un spectateur ne peut pas épingler ni terminer le live.
        await wf.send_json_to({'type': 'live.end', 'live_id': live.pk})
        self.assertIn('animateur', (await self.recv(wf, 'error'))['message'])

        await wh.send_json_to({'type': 'live.ban', 'live_id': live.pk, 'user_id': fan.pk})
        await self.recv(wf, 'live.kicked')
        await wf.send_json_to({'type': 'live.join', 'live_id': live.pk})
        self.assertIn('exclu', (await self.recv(wf, 'error'))['message'])

        await wh.send_json_to({'type': 'live.end', 'live_id': live.pk})
        summary = (await self.recv(wh, 'live.ended'))['summary']
        self.assertEqual((summary['likes'], summary['comments'], summary['gifts'], summary['gifts_value'], summary['total_viewers']),
                         (12, 2, 1, 500, 1))
        self.assertEqual(await sync_to_async(LiveComment.objects.count)(), 2)
        await wh.disconnect()
        await wf.disconnect()
