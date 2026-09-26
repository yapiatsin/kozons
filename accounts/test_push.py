import json
from unittest import mock

from django.core.cache import cache
from django.test import Client, TestCase, override_settings

from accounts import presence, push
from accounts.models import PushSubscription, User

VAPID = dict(VAPID_PUBLIC_KEY='BPUBLIC', VAPID_PRIVATE_KEY='PRIVATE', VAPID_SUBJECT='mailto:test@example.com')


class ImmediateExecutor:
    """Remplace le pool de threads : les envois s'exécutent tout de suite dans le test."""
    def submit(self, fn, *args):
        fn(*args)


def jpost(client, url, data=None):
    return client.post('/api/' + url, json.dumps(data or {}), content_type='application/json')


def subscription(n=1):
    return {'endpoint': f'https://fcm.googleapis.com/fcm/send/abc{n}', 'keys': {'p256dh': 'BKEY', 'auth': 'AUTH'}}


@override_settings(**VAPID)
class PushTests(TestCase):
    def setUp(self):
        cache.clear()
        presence.reset()
        self.alice = User.objects.create_user('alice', password='x', display_name='Alice')
        self.bob = User.objects.create_user('bob', password='x', display_name='Bob')
        self.ca, self.cb = Client(), Client()
        self.ca.force_login(self.alice)
        self.cb.force_login(self.bob)
        executor = mock.patch.object(push, '_executor', ImmediateExecutor())
        executor.start()
        self.addCleanup(executor.stop)
        self.webpush = mock.patch('pywebpush.webpush').start()
        self.addCleanup(mock.patch.stopall)

    def sent(self):
        return [json.loads(c.kwargs['data']) for c in self.webpush.call_args_list]

    def test_key_and_subscribe_unsubscribe(self):
        self.assertEqual(Client().get('/api/push/key').json(), {'enabled': True, 'public_key': 'BPUBLIC'})
        self.assertEqual(jpost(self.cb, 'push/subscribe', subscription()).status_code, 200)
        jpost(self.cb, 'push/subscribe', subscription())  # idempotent
        self.assertEqual(PushSubscription.objects.filter(user=self.bob).count(), 1)
        self.assertEqual(jpost(self.cb, 'push/subscribe', {'endpoint': 'http://insecure', 'keys': {}}).status_code, 400)
        jpost(self.cb, 'push/unsubscribe', {'endpoint': subscription()['endpoint']})
        self.assertFalse(PushSubscription.objects.exists())

    def test_message_pushed_only_to_offline_unmuted_members(self):
        jpost(self.cb, 'push/subscribe', subscription())
        cid = jpost(self.ca, 'conversations/direct', {'user_id': self.bob.pk}).json()['id']
        with self.captureOnCommitCallbacks(execute=True):
            jpost(self.ca, f'conversations/{cid}/messages', {'text': 'Tu es là ?'})
        payload = self.sent()[-1]
        self.assertEqual((payload['kind'], payload['title'], payload['body'], payload['url']), ('message', 'Alice', 'Tu es là ?', f'/chats/{cid}'))
        self.assertEqual(self.webpush.call_args.kwargs['headers']['Topic'], f'conv-{cid}')

        # Bob a l'application ouverte : pas de push (il reçoit l'événement par WebSocket).
        presence.register(self.bob.pk, 'canal-bob')
        self.webpush.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            jpost(self.ca, f'conversations/{cid}/messages', {'text': 'encore'})
        self.assertFalse(self.webpush.called)

        # Discussion en sourdine : pas de push non plus.
        presence.unregister(self.bob.pk, 'canal-bob')
        jpost(self.cb, f'conversations/{cid}/settings', {'mute_hours': -1})
        with self.captureOnCommitCallbacks(execute=True):
            jpost(self.ca, f'conversations/{cid}/messages', {'text': 'silence'})
        self.assertFalse(self.webpush.called)

    def test_dead_subscription_is_removed(self):
        from pywebpush import WebPushException
        jpost(self.cb, 'push/subscribe', subscription())
        self.webpush.side_effect = WebPushException('gone', response=mock.Mock(status_code=410))
        with self.captureOnCommitCallbacks(execute=True):
            push.send_to_users([self.bob.pk], {'title': 't'})
        self.assertFalse(PushSubscription.objects.exists())

    def test_social_notification_pushed(self):
        from social.models import Post
        jpost(self.ca, 'push/subscribe', subscription(2))
        post = Post.objects.create(author=self.alice, caption='Salut')
        with self.captureOnCommitCallbacks(execute=True):
            jpost(self.cb, f'posts/{post.pk}/like')
        payload = self.sent()[-1]
        self.assertEqual((payload['kind'], payload['title'], payload['url']), ('social', 'Bob', f'/p/{post.pk}'))
        self.assertIn('aimé', payload['body'])

    def test_test_endpoint(self):
        self.assertEqual(jpost(self.cb, 'push/test').status_code, 400)  # aucun appareil
        jpost(self.cb, 'push/subscribe', subscription())
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(jpost(self.cb, 'push/test').json(), {'devices': 1})
        self.assertEqual(self.sent()[-1]['kind'], 'test')

    @override_settings(VAPID_PUBLIC_KEY='', VAPID_PRIVATE_KEY='')
    def test_disabled_without_keys(self):
        self.assertEqual(Client().get('/api/push/key').json()['enabled'], False)
        with self.captureOnCommitCallbacks(execute=True):
            push.send_to_users([self.bob.pk], {'title': 't'})
        self.assertFalse(self.webpush.called)

    def test_ringing_call_pushed_and_missed_call_replaces_it(self):
        from chat.consumers import KozonsConsumer
        from chat.models import Call
        jpost(self.cb, 'push/subscribe', subscription())
        consumer = KozonsConsumer()
        consumer.user = self.alice
        with self.captureOnCommitCallbacks(execute=True):
            consumer._call_start({'to': self.bob.pk, 'video': True})
        ring = self.sent()[-1]
        self.assertEqual((ring['kind'], ring['body']), ('call', 'Appel vidéo entrant…'))
        self.assertEqual(self.webpush.call_args.kwargs['ttl'], push.TTL_CALL)
        self.assertEqual(self.webpush.call_args.kwargs['headers']['Urgency'], 'high')
        call = Call.objects.get()
        with self.captureOnCommitCallbacks(execute=True):
            consumer._finish_call(call, 'missed')
        missed = self.sent()[-1]
        self.assertEqual(missed['kind'], 'missed_call')
        self.assertEqual(self.webpush.call_args.kwargs['headers']['Topic'], f'call-{call.pk}')
