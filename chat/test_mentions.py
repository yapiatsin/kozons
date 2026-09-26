import json
from unittest import mock

from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from accounts import presence, push
from accounts.models import PushSubscription, User


def jpost(client, url, data=None):
    return client.post('/api/' + url, json.dumps(data or {}), content_type='application/json')


class ImmediateExecutor:
    def submit(self, fn, *args):
        fn(*args)


@override_settings(VAPID_PUBLIC_KEY='BPUBLIC', VAPID_PRIVATE_KEY='PRIVATE')
class MentionTests(TestCase):
    def setUp(self):
        cache.clear()
        presence.reset()
        self.alice = User.objects.create_user('alice', password='x', display_name='Allou Yao RGL')
        self.bob = User.objects.create_user('bob', password='x', display_name='Bob Kouassi')
        self.carol = User.objects.create_user('carol', password='x')
        self.outsider = User.objects.create_user('dave', password='x')
        self.ca, self.cb = Client(), Client()
        self.ca.force_login(self.alice)
        self.cb.force_login(self.bob)
        r = jpost(self.ca, 'conversations/group', {'title': 'Sortie', 'member_ids': [self.bob.pk, self.carol.pk]})
        self.gid = r.json()['id']

    def send(self, text, mentions, conv=None):
        r = jpost(self.ca, f'conversations/{conv or self.gid}/messages', {'text': text, 'mentions': mentions})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_mentions_saved_and_serialized(self):
        msg = self.send('Salut @Bob Kouassi, tu viens ?', [self.bob.pk])
        self.assertEqual(msg['mentions'], [{'id': self.bob.pk, 'name': 'Bob Kouassi', 'username': 'bob'}])
        seen = self.cb.get(f'/api/conversations/{self.gid}/messages').json()['results'][-1]
        self.assertEqual([m['id'] for m in seen['mentions']], [self.bob.pk])

    def test_only_group_members_can_be_mentioned(self):
        msg = self.send('@dave @Allou', [self.outsider.pk, self.alice.pk, 999999])
        self.assertEqual(msg['mentions'], [])  # non-membre, soi-même, inexistant : ignorés
        direct = jpost(self.ca, 'conversations/direct', {'user_id': self.bob.pk}).json()['id']
        self.assertEqual(self.send('@Bob Kouassi', [self.bob.pk], conv=direct)['mentions'], [])  # pas en privé

    def test_unread_mentions_badge(self):
        self.send('@Bob Kouassi regarde', [self.bob.pk])
        self.send('message sans mention', [])
        conv = self.cb.get(f'/api/conversations/{self.gid}').json()
        self.assertEqual((conv['unread'], conv['unread_mentions']), (2, 1))  # le message système ne compte pas
        last = self.cb.get(f'/api/conversations/{self.gid}/messages').json()['results'][-1]['id']
        jpost(self.cb, f'conversations/{self.gid}/read', {'message_id': last})
        self.assertEqual(self.cb.get(f'/api/conversations/{self.gid}').json()['unread_mentions'], 0)

    def test_mention_notifies_even_when_group_muted(self):
        mock.patch.object(push, '_executor', ImmediateExecutor()).start()
        webpush = mock.patch('pywebpush.webpush').start()
        self.addCleanup(mock.patch.stopall)
        PushSubscription.objects.create(user=self.bob, endpoint='https://push.example/b', p256dh='k', auth='a', last_active_at=timezone.now())
        PushSubscription.objects.create(user=self.carol, endpoint='https://push.example/c', p256dh='k', auth='a', last_active_at=timezone.now())
        jpost(self.cb, f'conversations/{self.gid}/settings', {'mute_hours': -1})  # Bob coupe le groupe
        with self.captureOnCommitCallbacks(execute=True):
            self.send('@Bob Kouassi réponds stp', [self.bob.pk])
        bodies = {c.kwargs['subscription_info']['endpoint']: json.loads(c.kwargs['data'])['body'] for c in webpush.call_args_list}
        self.assertIn('vous a mentionné', bodies['https://push.example/b'])
        self.assertTrue(bodies['https://push.example/c'].startswith('Allou Yao RGL : '))
