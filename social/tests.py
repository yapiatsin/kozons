import json
import shutil
import tempfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings

from accounts.models import User
from social.models import Notification, Story

MEDIA = tempfile.mkdtemp()


def make_user(username, **kw):
    u = User.objects.create_user(username=username, password='secret123', **kw)
    c = Client()
    c.force_login(u)
    return u, c


def img(name='a.jpg'):
    return SimpleUploadedFile(name, b'\xff\xd8\xff' + b'0' * 64, content_type='image/jpeg')


def jpost(client, url, data=None):
    return client.post('/api/' + url, json.dumps(data or {}), content_type='application/json')


@override_settings(MEDIA_ROOT=MEDIA)
class SocialTests(TestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        self.alice, self.ca = make_user('alice')
        self.bob, self.cb = make_user('bob')

    def create_post(self, client, caption='Coucou #soleil', **extra):
        r = client.post('/api/posts', {'files': [img()], 'caption': caption, **extra})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_feed_follow_like_comment(self):
        post = self.create_post(self.ca, 'Hello @bob #soleil')
        self.assertEqual(self.cb.get('/api/feed').json()['results'], [])
        self.assertEqual(jpost(self.cb, f'users/{self.alice.pk}/follow').json()['follow_status'], 'following')
        feed = self.cb.get('/api/feed').json()['results']
        self.assertEqual([p['id'] for p in feed], [post['id']])
        self.assertTrue(jpost(self.cb, f'posts/{post["id"]}/like').json()['liked'])
        r = jpost(self.cb, f'posts/{post["id"]}/comments', {'text': 'Superbe !'})
        self.assertEqual(r.status_code, 200)
        jpost(self.ca, f'posts/{post["id"]}/comments', {'text': 'Merci', 'parent_id': r.json()['id']})
        detail = self.cb.get(f'/api/posts/{post["id"]}').json()
        self.assertEqual(detail['like_count'], 1)
        self.assertEqual(detail['comment_count'], 2)
        verbs = set(Notification.objects.values_list('verb', flat=True))
        self.assertTrue({'mention', 'follow', 'like', 'comment', 'reply'} <= verbs)
        self.assertEqual(len(self.cb.get('/api/explore?q=%23soleil').json()['results']), 1)

    def test_private_account(self):
        self.alice.is_private = True
        self.alice.save()
        post = self.create_post(self.ca)
        self.assertEqual(self.cb.get(f'/api/posts/{post["id"]}').status_code, 404)
        self.assertEqual(self.cb.get('/api/profiles/alice/posts').json()['results'], [])
        self.assertEqual(jpost(self.cb, f'users/{self.alice.pk}/follow').json()['follow_status'], 'requested')
        self.assertEqual(self.cb.get(f'/api/posts/{post["id"]}').status_code, 404)
        jpost(self.ca, f'users/{self.bob.pk}/follow-request', {'action': 'accept'})
        self.assertEqual(self.cb.get(f'/api/posts/{post["id"]}').status_code, 200)

    def test_block_hides_content(self):
        post = self.create_post(self.ca)
        jpost(self.ca, f'users/{self.bob.pk}/block')
        self.assertEqual(self.cb.get(f'/api/posts/{post["id"]}').status_code, 404)
        self.assertEqual(self.cb.get('/api/profiles/alice').status_code, 404)

    def test_hide_likes_and_delete(self):
        post = self.create_post(self.ca, hide_likes='1')
        jpost(self.cb, f'users/{self.alice.pk}/follow')
        self.assertIsNone(self.cb.get(f'/api/posts/{post["id"]}').json()['like_count'])
        self.assertEqual(self.ca.get(f'/api/posts/{post["id"]}').json()['like_count'], 0)
        self.assertEqual(self.cb.delete(f'/api/posts/{post["id"]}').status_code, 403)
        self.assertEqual(self.ca.delete(f'/api/posts/{post["id"]}').status_code, 200)

    def test_reel_requires_video(self):
        r = self.ca.post('/api/posts', {'files': [img()], 'is_reel': '1'})
        self.assertEqual(r.status_code, 400)

    def test_stories_visibility_and_views(self):
        r = self.ca.post('/api/stories', {'text': 'Bonne journée', 'background': '#000'})
        self.assertEqual(r.status_code, 200, r.content)
        sid = r.json()['id']
        self.assertEqual(self.cb.get('/api/stories').json()['results'], [])
        jpost(self.cb, f'users/{self.alice.pk}/follow')
        groups = self.cb.get('/api/stories').json()['results']
        self.assertEqual(groups[0]['user']['id'], self.alice.pk)
        self.assertFalse(groups[0]['all_seen'])
        jpost(self.cb, f'stories/{sid}', {'action': 'view'})
        self.assertTrue(self.cb.get('/api/stories').json()['results'][0]['all_seen'])
        viewers = self.ca.get(f'/api/stories/{sid}/viewers').json()['results']
        self.assertEqual([v['id'] for v in viewers], [self.bob.pk])
        # Amis proches uniquement : invisible pour les autres abonnés.
        self.ca.post('/api/stories', {'text': 'secret', 'close_friends_only': '1'})
        self.assertEqual(len(self.cb.get('/api/stories').json()['results'][0]['stories']), 1)
        jpost(self.ca, f'users/{self.bob.pk}/close-friend')
        self.assertEqual(len(self.cb.get('/api/stories').json()['results'][0]['stories']), 2)
        Story.objects.update(expires_at='2000-01-01T00:00:00Z')
        self.assertEqual(self.cb.get('/api/stories').json()['results'], [])
