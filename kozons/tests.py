import io
import shutil
import tempfile
from datetime import timedelta

from django.contrib import admin
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from PIL import Image

from accounts.models import Block, OneTimeCode, User
from chat.models import (Call, Conversation, HiddenMessage, Message, Participant, PollOption, PollVote, Reaction,
                         StarredMessage, Sticker, UserSticker, ViewOnceOpened)
from social.models import (CloseFriend, Comment, CommentLike, Follow, Like, Notification, Post, PostMedia, SavedPost,
                           Story, StoryView)

MEDIA = tempfile.mkdtemp()


def image(name='x.png'):
    buf = io.BytesIO()
    Image.new('RGB', (20, 20), 'red').save(buf, 'PNG')
    return SimpleUploadedFile(name, buf.getvalue(), content_type='image/png')


@override_settings(MEDIA_ROOT=MEDIA)
class AdminPagesTests(TestCase):
    """Chaque liste, recherche et fiche de l'admin s'affiche avec des données réelles."""

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        self.admin_user = User.objects.create_superuser('root', 'root@example.com', 'Kozons2026')
        self.client.force_login(self.admin_user)
        a = User.objects.create_user('alice', avatar=image())
        b = User.objects.create_user('bob')
        now = timezone.now()
        Block.objects.create(blocker=a, blocked=b)
        OneTimeCode.objects.create(user=a, code_hash='x' * 64, expires_at=now + timedelta(minutes=5))
        group = Conversation.objects.create(kind='group', title='Groupe', created_by=a, disappearing_seconds=86400)
        direct = Conversation.objects.create(kind='direct', direct_key='1:2')
        for conv in (group, direct):
            Participant.objects.create(conversation=conv, user=a, role='admin')
            Participant.objects.create(conversation=conv, user=b)
        sticker = Sticker(sha256='a' * 64, created_by=a)
        sticker.file.save('s.webp', image('s.webp'), save=False)
        sticker.save()
        UserSticker.objects.create(user=a, sticker=sticker, favorite=True, last_used_at=now)
        msg = Message.objects.create(conversation=group, sender=a, text='Bonjour', edited_at=now)
        Message.objects.create(conversation=group, sender=a, kind='image', file=image())
        Message.objects.create(conversation=group, sender=a, kind='sticker', sticker=sticker, file=sticker.file.name)
        Message.objects.create(conversation=direct, sender=b, kind='voice', file=image('v.webm'), deleted=True)
        poll = Message.objects.create(conversation=group, sender=a, kind='poll', text='Pizza ?')
        option = PollOption.objects.create(message=poll, text='Oui')
        PollVote.objects.create(option=option, user=b)
        Reaction.objects.create(message=msg, user=b, emoji='👍')
        StarredMessage.objects.create(message=msg, user=b)
        HiddenMessage.objects.create(message=msg, user=b)
        ViewOnceOpened.objects.create(message=msg, user=b)
        Call.objects.create(caller=a, callee=b, video=True, status='ended', answered_at=now, ended_at=now + timedelta(seconds=75))
        Follow.objects.create(follower=b, following=a, accepted=False)
        CloseFriend.objects.create(owner=a, friend=b)
        post = Post.objects.create(author=a, caption='Belle journée #soleil', is_reel=False)
        PostMedia.objects.create(post=post, file=image(), kind='image')
        PostMedia.objects.create(post=Post.objects.create(author=a, is_reel=True), file=image('r.mp4'), kind='video')
        Like.objects.create(post=post, user=b)
        SavedPost.objects.create(post=post, user=b)
        comment = Comment.objects.create(post=post, user=b, text='Super')
        Comment.objects.create(post=post, user=a, text='Merci', parent=comment)
        CommentLike.objects.create(comment=comment, user=a)
        story = Story.objects.create(user=a, kind='text', text='Salut', background='#0099cc')
        Story.objects.create(user=a, kind='image', file=image(), expires_at=now - timedelta(hours=1))
        StoryView.objects.create(story=story, user=b, liked=True)
        Notification.objects.create(recipient=a, actor=b, verb='comment', post=post, comment=comment)

    def test_every_admin_page_renders(self):
        for model, model_admin in admin.site._registry.items():
            if model._meta.app_label not in ('accounts', 'chat', 'social'):
                continue
            base = f'/admin/{model._meta.app_label}/{model._meta.model_name}/'
            with self.subTest(model=model._meta.label):
                self.assertTrue(model.objects.exists(), f'aucune donnée de test pour {model._meta.label}')
                for url in (base, base + '?q=a', f'{base}{model.objects.first().pk}/change/'):
                    self.assertEqual(self.client.get(url).status_code, 200, url)

    def test_one_time_codes_are_read_only(self):
        base = '/admin/accounts/onetimecode/'
        self.assertEqual(self.client.get(base + 'add/').status_code, 403)
        page = self.client.get(f'{base}{OneTimeCode.objects.first().pk}/change/').content.decode()
        self.assertNotIn('x' * 64, page)  # l'empreinte du code n'est jamais affichée
