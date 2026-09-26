import json
import time
from datetime import timedelta
from unittest import mock

from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from accounts import presence, push
from accounts.models import PushSubscription, User
from accounts.serializers import user_brief

ACTIVE = {'HTTP_X_KOZONS_ACTIVE': '1'}


class PresenceRegistryTests(TestCase):
    def setUp(self):
        presence.reset()

    def test_connected_is_not_online_until_active(self):
        presence.register(1, 'a')
        self.assertTrue(presence.is_connected(1))
        self.assertFalse(presence.is_online(1))  # application ouverte en arrière-plan
        self.assertEqual(presence.update(1, 'a', True), (False, True))
        self.assertTrue(presence.is_online(1))
        self.assertEqual(presence.update(1, 'a', False), (True, False))

    def test_multi_device(self):
        presence.register(1, 'phone')
        presence.register(1, 'laptop')
        presence.update(1, 'phone', True)
        self.assertEqual(presence.update(1, 'laptop', False), (True, True))  # le téléphone reste actif
        self.assertEqual(presence.unregister(1, 'phone'), (True, False, True))
        self.assertEqual(presence.unregister(1, 'laptop'), (False, False, False))

    def test_silent_connection_expires(self):
        presence.register(1, 'a')
        presence.update(1, 'a', True)
        with mock.patch('accounts.presence.time.monotonic', return_value=time.monotonic() + presence.STALE + 1):
            self.assertFalse(presence.is_online(1))
            self.assertFalse(presence.is_connected(1))

    def test_user_brief_uses_presence(self):
        u = User.objects.create_user('alice', password='x')
        self.assertFalse(user_brief(u)['online'])
        presence.register(u.pk, 'a')
        presence.update(u.pk, 'a', True)
        self.assertTrue(user_brief(u)['online'])


@override_settings(IDLE_LOGOUT_MINUTES=45)
class IdleLogoutTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user('alice', password='x')
        self.client = Client()
        self.client.force_login(self.user)

    def set_last_active(self, minutes_ago):
        session = self.client.session
        session['kz_last_active'] = time.time() - minutes_ago * 60
        session.save()

    def test_active_requests_keep_session(self):
        self.set_last_active(44)
        self.assertEqual(self.client.get('/api/conversations', **ACTIVE).status_code, 200)
        self.assertLess(time.time() - self.client.session['kz_last_active'], 5)  # prolongée

    def test_background_requests_do_not_extend(self):
        self.set_last_active(30)
        before = self.client.session['kz_last_active']
        self.assertEqual(self.client.get('/api/conversations', HTTP_X_KOZONS_ACTIVE='0').status_code, 200)
        self.assertEqual(self.client.session['kz_last_active'], before)

    def test_logged_out_after_45_minutes_away(self):
        self.set_last_active(46)
        self.assertEqual(self.client.get('/api/conversations', **ACTIVE).status_code, 401)
        self.assertIsNone(self.client.get('/api/me', **ACTIVE).json()['user'])

    def test_heartbeat(self):
        self.set_last_active(10)
        r = self.client.post('/api/presence/heartbeat', **ACTIVE)
        self.assertEqual(r.json()['idle_logout_minutes'], 45)


VAPID = dict(VAPID_PUBLIC_KEY='BPUBLIC', VAPID_PRIVATE_KEY='PRIVATE')


class ImmediateExecutor:
    def submit(self, fn, *args):
        fn(*args)


@override_settings(**VAPID, IDLE_LOGOUT_MINUTES=45)
class LockedPushTests(TestCase):
    def setUp(self):
        presence.reset()
        self.bob = User.objects.create_user('bob', password='x')
        patcher = mock.patch.object(push, '_executor', ImmediateExecutor())
        patcher.start()
        self.webpush = mock.patch('pywebpush.webpush').start()
        self.addCleanup(mock.patch.stopall)
        self.sub = PushSubscription.objects.create(user=self.bob, endpoint='https://push.example/1', p256dh='k', auth='a',
                                                   last_active_at=timezone.now())
        self.payload = {'kind': 'message', 'title': 'Alice', 'body': 'Secret !', 'url': '/chats/1', 'tag': 'conv-1'}

    def body(self):
        return json.loads(self.webpush.call_args.kwargs['data'])

    def test_recent_device_gets_content(self):
        with self.captureOnCommitCallbacks(execute=True):
            push.send_to_users([self.bob.pk], self.payload)
        self.assertEqual(self.body()['body'], 'Secret !')

    def test_idle_logged_out_device_gets_generic_notification(self):
        PushSubscription.objects.filter(pk=self.sub.pk).update(last_active_at=timezone.now() - timedelta(minutes=50))
        with self.captureOnCommitCallbacks(execute=True):
            push.send_to_users([self.bob.pk], self.payload)
        body = self.body()
        self.assertEqual(body['title'], 'Kozons')
        self.assertNotIn('Secret', body['body'])
        self.assertNotIn('Alice', json.dumps(body))


class ConsumerPresenceTests(TransactionTestCase):
    async def test_online_only_when_active_and_broadcast_to_contacts(self):
        from chat import services
        from chat.consumers import KozonsConsumer
        presence.reset()
        alice = await sync_to_async(User.objects.create_user)('alice', password='x')
        bob = await sync_to_async(User.objects.create_user)('bob', password='x')
        await sync_to_async(services.get_or_create_direct)(alice, bob)

        async def connect(user):
            comm = WebsocketCommunicator(KozonsConsumer.as_asgi(), '/ws/')
            comm.scope['user'] = user
            ok, _ = await comm.connect()
            self.assertTrue(ok)
            return comm

        wa = await connect(alice)
        wb = await connect(bob)
        self.assertFalse(presence.is_online(bob.pk))  # connecté mais pas encore actif
        await wb.send_json_to({'type': 'presence', 'active': True})
        evt = await wa.receive_json_from(timeout=2)
        while evt['type'] != 'presence':
            evt = await wa.receive_json_from(timeout=2)
        self.assertEqual((evt['data']['user_id'], evt['data']['online']), (bob.pk, True))

        await wb.send_json_to({'type': 'presence', 'active': False})  # onglet masqué
        evt = await wa.receive_json_from(timeout=2)
        while evt['type'] != 'presence':
            evt = await wa.receive_json_from(timeout=2)
        self.assertFalse(evt['data']['online'])
        self.assertTrue(presence.is_connected(bob.pk))
        await wa.disconnect()
        await wb.disconnect()
        self.assertFalse(presence.is_connected(bob.pk))
