import json
import os
import shutil
import tempfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings

from accounts.models import User
from social.models import Notification, Story

MEDIA = tempfile.mkdtemp()


def make_user(username, **kw):
    u = User.objects.create_user(username=username, password='secret123', **kw, can_connect=True)
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
        # Mes stories arrivent avec la liste des vues (l'œil l'affiche sans attendre) ; pas celles des autres.
        mine = self.ca.get('/api/stories').json()['results'][0]['stories'][0]
        self.assertEqual(([v['id'] for v in mine['viewers']], mine['view_count']), ([self.bob.pk], 1))
        self.assertNotIn('viewers', self.cb.get('/api/stories').json()['results'][0]['stories'][0])
        # Amis proches uniquement : invisible pour les autres abonnés.
        self.ca.post('/api/stories', {'text': 'secret', 'close_friends_only': '1'})
        self.assertEqual(len(self.cb.get('/api/stories').json()['results'][0]['stories']), 1)
        jpost(self.ca, f'users/{self.bob.pk}/close-friend')
        self.assertEqual(len(self.cb.get('/api/stories').json()['results'][0]['stories']), 2)
        Story.objects.update(expires_at='2000-01-01T00:00:00Z')
        self.assertEqual(self.cb.get('/api/stories').json()['results'], [])

    def test_story_menu_mute_notify_report(self):
        from unittest import mock
        from social.models import StoryReport
        jpost(self.cb, f'users/{self.alice.pk}/follow')
        sid = self.ca.post('/api/stories', {'text': 'Premier'}).json()['id']
        group = self.cb.get('/api/stories').json()['results'][0]
        self.assertEqual((group['muted'], group['notify']), (False, False))
        # « Masquer » puis « Recevoir les notifications » (menu ⋮ de la visionneuse).
        self.assertEqual(jpost(self.cb, f'stories/prefs/{self.alice.pk}', {'muted': True}).json(), {'muted': True, 'notify': False})
        self.assertTrue(self.cb.get('/api/stories').json()['results'][0]['muted'])
        jpost(self.cb, f'stories/prefs/{self.alice.pk}', {'muted': False, 'notify': True})
        self.assertEqual(jpost(self.ca, f'stories/prefs/{self.alice.pk}', {'muted': True}).status_code, 400)
        # Nouveau statut : les abonnés aux notifications sont prévenus, même application ouverte.
        with mock.patch('social.views.send_to_users') as sent:
            self.ca.post('/api/stories', {'text': 'Second'})
        self.assertEqual(set(sent.call_args.args[0]), {self.bob.pk})
        self.assertEqual(sent.call_args.args[1]['kind'], 'story')
        self.assertFalse(sent.call_args.kwargs['only_offline'])
        # Signaler : le contenu est conservé pour la modération (une seule fois par personne).
        self.assertTrue(jpost(self.cb, f'stories/{sid}', {'action': 'report', 'reason': 'spam'}).json()['reported'])
        jpost(self.cb, f'stories/{sid}', {'action': 'report', 'reason': 'spam'})
        report = StoryReport.objects.get()
        self.assertEqual((report.author_id, report.reason, report.snapshot['text']), (self.alice.pk, 'spam', 'Premier'))


def video(name='clip.mov'):
    return SimpleUploadedFile(name, b'\x00\x00\x00\x18ftypqt  ' + b'0' * 256, content_type='video/quicktime')


@override_settings(MEDIA_ROOT=MEDIA, KOZONS_STORY_ASYNC=False)
class StoryVideoTests(TestCase):
    """Vidéos de statut : conversion (MP4 720p, 90 s), publication une fois prête, quota, ménage."""

    def setUp(self):
        from django.core.cache import cache
        cache.clear()
        self.alice, self.ca = make_user('alice')
        self.bob, self.cb = make_user('bob')
        jpost(self.cb, f'users/{self.alice.pk}/follow')

    def fake_transcode(self, src, out, poster, **kw):
        with open(out, 'wb') as f:
            f.write(b'mp4-720p')
        with open(poster, 'wb') as f:
            f.write(b'jpeg')
        return True

    def post_video(self):
        return self.ca.post('/api/stories', {'file': video(), 'text': 'Le match !'})

    def test_video_is_converted_then_published(self):
        from unittest import mock
        from social import storymedia
        with mock.patch.object(storymedia, 'ffmpeg', return_value='ffmpeg'), \
                mock.patch.object(storymedia, 'transcode', side_effect=self.fake_transcode) as tr, \
                mock.patch.object(storymedia, 'probe_duration', return_value=125.0), \
                mock.patch('chat.realtime.push') as push:
            r = self.post_video()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()['processing'])
        story = Story.objects.get()
        self.assertFalse(story.processing)
        self.assertTrue(story.file.name.endswith('.mp4'))
        self.assertTrue(story.poster.name.endswith('.jpg'))
        self.assertEqual(story.duration, 90)  # coupée à 90 s
        self.assertTrue(tr.call_args.args[0].endswith('.mov'))
        events = {c.args[1]: c.args for c in push.call_args_list}
        self.assertIn(self.bob.pk, events['story.new'][0])
        self.assertIn('90 secondes', events['story.published'][2]['message'])
        shown = self.cb.get('/api/stories').json()['results'][0]['stories'][0]
        self.assertEqual((shown['kind'], shown['duration']), ('video', 90))
        self.assertTrue(shown['poster'].endswith('.jpg'))

    def test_chosen_sequence_and_mute(self):
        from unittest import mock
        from social import storymedia
        with mock.patch.object(storymedia, 'ffmpeg', return_value='ffmpeg'),                 mock.patch.object(storymedia, 'transcode', side_effect=self.fake_transcode) as tr,                 mock.patch.object(storymedia, 'probe_duration', return_value=125.0),                 mock.patch('chat.realtime.push') as push:
            r = self.ca.post('/api/stories', {'file': video(), 'trim_start': '10.5', 'trim_end': '25.5', 'mute': '1'})
        self.assertTrue(r.json()['processing'])
        self.assertEqual(tr.call_args.kwargs, {'start': 10.5, 'length': 15.0, 'mute': True})
        self.assertEqual(Story.objects.get().duration, 15)
        # Séquence choisie par la personne : pas d'avertissement « vidéo coupée ».
        self.assertNotIn('story.published', [c.args[1] for c in push.call_args_list])
        # Bornes incohérentes ou trop longues : 90 s au plus, depuis le début demandé.
        self.assertEqual(storymedia.clip_bounds('5', '200'), (5.0, 90.0))
        self.assertEqual(storymedia.clip_bounds('abc', None), (0.0, 90.0))
        self.assertEqual(storymedia.clip_bounds('30', '20'), (30.0, 90.0))

    def test_story_hidden_while_converting(self):
        from unittest import mock
        from social import storymedia
        with mock.patch.object(storymedia, 'ffmpeg', return_value='ffmpeg'), \
                mock.patch.object(storymedia, '_run_async') as later:
            self.assertTrue(self.post_video().json()['processing'])
        os.remove(later.call_args.args[2])  # fichier temporaire de la vidéo reçue
        self.assertEqual(self.cb.get('/api/stories').json()['results'], [])
        self.assertEqual(self.ca.get('/api/stories').json()['results'], [])

    def test_failed_conversion_removes_story(self):
        from unittest import mock
        from social import storymedia
        with mock.patch.object(storymedia, 'ffmpeg', return_value='ffmpeg'), \
                mock.patch.object(storymedia, 'transcode', return_value=False), \
                mock.patch.object(storymedia, 'probe_duration', return_value=None), \
                mock.patch('chat.realtime.push') as push:
            self.post_video()
        self.assertFalse(Story.objects.exists())
        self.assertEqual(push.call_args.args[:2], ([self.alice.pk], 'story.failed'))

    def test_without_ffmpeg_video_is_published_as_is(self):
        from unittest import mock
        from social import storymedia
        with mock.patch.object(storymedia, 'ffmpeg', return_value=None):
            r = self.post_video()
        self.assertNotIn('processing', r.json())
        self.assertEqual(len(self.cb.get('/api/stories').json()['results'][0]['stories']), 1)

    @override_settings(STORY_DAILY_LIMIT=2)
    def test_daily_limit(self):
        for text in ('un', 'deux'):
            self.assertEqual(self.ca.post('/api/stories', {'text': text}).status_code, 200)
        r = self.ca.post('/api/stories', {'text': 'trois'})
        self.assertEqual(r.status_code, 429)
        self.assertIn('2 statuts par 24 heures', r.json()['error'])

    def test_purge_expired_files_but_keeps_reported(self):
        from datetime import timedelta
        from django.core.files.base import ContentFile
        from django.utils import timezone
        from social import storymedia
        from social.models import StoryReport
        past = timezone.now() - timedelta(hours=1)
        old = Story.objects.create(user=self.alice, kind='video', expires_at=past)
        old.file.save('old.mp4', ContentFile(b'x'))
        old.poster.save('old.jpg', ContentFile(b'x'))
        paths = [old.file.path, old.poster.path]
        reported = Story.objects.create(user=self.alice, kind='text', text='signalé', expires_at=past)
        report = StoryReport.objects.create(story=reported, author=self.alice, reporter=self.bob)
        stuck = Story.objects.create(user=self.alice, kind='video', processing=True, created_at=timezone.now() - timedelta(hours=2))
        alive = Story.objects.create(user=self.alice, kind='text', text='en cours')
        self.assertEqual(storymedia.purge_expired(), 2)
        self.assertEqual(set(Story.objects.values_list('pk', flat=True)), {reported.pk, alive.pk})
        self.assertFalse(any(os.path.exists(p) for p in paths))
        self.assertFalse(Story.objects.filter(pk=stuck.pk).exists())
        # Signalement traité : le statut expiré peut partir à son tour.
        report.handled = True
        report.save()
        self.assertEqual(storymedia.purge_expired(), 1)
        self.assertEqual(list(Story.objects.values_list('pk', flat=True)), [alive.pk])


class FriendSuggestionTests(TestCase):
    def setUp(self):
        from django.core.cache import cache
        cache.clear()
        from social.models import Follow
        self.Follow = Follow
        self.me, self.c = make_user('moi', display_name='Moi')
        self.awa, _ = make_user('awa', display_name='Awa')
        self.koffi, _ = make_user('koffi', display_name='Koffi')
        self.yao, _ = make_user('yao', display_name='Yao')        # ami d'Awa et de Koffi
        self.ama, _ = make_user('ama', display_name='Ama')        # amie d'Awa seulement
        self.fan, _ = make_user('fan', display_name='Fan')        # me suit, je ne le suis pas
        for a, b in [(self.me, self.awa), (self.koffi, self.me), (self.me, self.koffi), (self.awa, self.yao), (self.yao, self.koffi), (self.ama, self.awa), (self.fan, self.me)]:
            Follow.objects.create(follower=a, following=b)

    def test_friends_of_friends_ranked_by_mutual_friends(self):
        res = self.c.get('/api/suggestions').json()['results']
        names = [u['username'] for u in res]
        self.assertEqual(names[:3], ['yao', 'fan', 'ama'])               # 2 amis en commun > me suit > 1 ami
        self.assertNotIn('awa', names)                                    # déjà mon amie
        self.assertNotIn('moi', names)
        self.assertEqual(res[0]['mutual_count'], 2)
        self.assertIn('2 amis en commun', res[0]['reason'])
        self.assertEqual(res[1]['reason'], 'Vous suit')
        self.assertEqual(res[2]['reason'], '1 ami en commun : Awa')
        # « ✕ » : la suggestion ne revient plus.
        jpost(self.c, f'suggestions/{self.yao.pk}/hide')
        self.assertNotIn('yao', [u['username'] for u in self.c.get('/api/suggestions').json()['results']])


class InviteTests(TestCase):
    def setUp(self):
        from django.core.cache import cache
        cache.clear()
        self.awa, self.ca = make_user('awa', display_name='Awa Koné')

    def test_invite_link_signup_makes_friends(self):
        from social.models import Follow
        info = self.ca.get('/api/invite').json()
        code = info['url'].rsplit('/', 1)[1]
        self.assertEqual((len(code), info['joined']), (8, 0))
        self.assertEqual(self.ca.get('/api/invite').json()['url'], info['url'])     # lien stable
        self.assertEqual(Client().get(f'/api/invite/{code}').json()['inviter']['name'], 'Awa Koné')
        self.assertEqual(Client().get('/api/invite/inconnu').status_code, 404)
        # Aperçu du lien partagé (WhatsApp, Facebook…).
        self.assertContains(Client().get(f'/invite/{code}'), 'Awa Koné vous invite sur Kozons')
        c = Client()
        r = jpost(c, 'auth/register', {'username': 'koffi', 'email': 'koffi@example.com', 'password': 'Motdepasse1!', 'invite': code})
        self.assertEqual(r.status_code, 200, r.content)
        koffi = User.objects.get(username='koffi')
        self.assertEqual(koffi.invited_by, self.awa)
        self.assertTrue(Follow.objects.filter(follower=koffi, following=self.awa, accepted=True).exists())
        self.assertTrue(Follow.objects.filter(follower=self.awa, following=koffi, accepted=True).exists())
        self.assertTrue(Notification.objects.filter(recipient=self.awa, actor=koffi, verb='invite_joined').exists())
        self.assertEqual(self.ca.get('/api/invite').json()['joined'], 1)
        # Code invalide : l'inscription marche quand même, sans parrain.
        r = jpost(Client(), 'auth/register', {'username': 'yao', 'email': 'yao@example.com', 'password': 'Motdepasse1!', 'invite': 'xxxx'})
        self.assertEqual((r.status_code, User.objects.get(username='yao').invited_by), (200, None))
