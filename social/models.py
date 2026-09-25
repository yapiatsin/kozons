from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

User = settings.AUTH_USER_MODEL


def post_media_path(instance, filename):
    return f'posts/{timezone.now():%Y/%m}/{filename}'


def story_path(instance, filename):
    return f'stories/{timezone.now():%Y/%m/%d}/{filename}'


def story_expiry():
    return timezone.now() + timedelta(hours=24)


class Follow(models.Model):
    follower = models.ForeignKey(User, on_delete=models.CASCADE, related_name='following_set')
    following = models.ForeignKey(User, on_delete=models.CASCADE, related_name='followers_set')
    accepted = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['follower', 'following'], name='uniq_follow')]


class CloseFriend(models.Model):
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name='close_friends')
    friend = models.ForeignKey(User, on_delete=models.CASCADE, related_name='+')

    class Meta:
        constraints = [models.UniqueConstraint(fields=['owner', 'friend'], name='uniq_close_friend')]


class Post(models.Model):
    author = models.ForeignKey(User, on_delete=models.CASCADE, related_name='posts')
    caption = models.TextField(max_length=2200, blank=True)
    location = models.CharField(max_length=100, blank=True)
    is_reel = models.BooleanField(default=False)
    comments_disabled = models.BooleanField(default=False)
    hide_likes = models.BooleanField(default=False)
    archived = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)


class PostMedia(models.Model):
    post = models.ForeignKey(Post, on_delete=models.CASCADE, related_name='media')
    file = models.FileField(upload_to=post_media_path)
    kind = models.CharField(max_length=10, default='image')
    order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ['order']


class Like(models.Model):
    post = models.ForeignKey(Post, on_delete=models.CASCADE, related_name='likes')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='likes')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['post', 'user'], name='uniq_like')]


class SavedPost(models.Model):
    post = models.ForeignKey(Post, on_delete=models.CASCADE, related_name='saves')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='saved_posts')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['post', 'user'], name='uniq_save')]


class Comment(models.Model):
    post = models.ForeignKey(Post, on_delete=models.CASCADE, related_name='comments')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='comments')
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.CASCADE, related_name='replies')
    text = models.TextField(max_length=2200)
    created_at = models.DateTimeField(auto_now_add=True)


class CommentLike(models.Model):
    comment = models.ForeignKey(Comment, on_delete=models.CASCADE, related_name='likes')
    user = models.ForeignKey(User, on_delete=models.CASCADE)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['comment', 'user'], name='uniq_comment_like')]


class Story(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='stories')
    file = models.FileField(upload_to=story_path, blank=True)
    kind = models.CharField(max_length=10, default='image')  # image | video | text
    text = models.CharField(max_length=700, blank=True)
    background = models.CharField(max_length=32, default='#128C7E')
    close_friends_only = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField(default=story_expiry, db_index=True)


class StoryView(models.Model):
    story = models.ForeignKey(Story, on_delete=models.CASCADE, related_name='views')
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    liked = models.BooleanField(default=False)
    viewed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['story', 'user'], name='uniq_story_view')]


class Notification(models.Model):
    VERBS = [(v, v) for v in ('like', 'comment', 'reply', 'follow', 'follow_request', 'follow_accept', 'mention', 'comment_like', 'story_like')]

    recipient = models.ForeignKey(User, on_delete=models.CASCADE, related_name='notifications')
    actor = models.ForeignKey(User, on_delete=models.CASCADE, related_name='+')
    verb = models.CharField(max_length=20, choices=VERBS)
    post = models.ForeignKey(Post, null=True, blank=True, on_delete=models.CASCADE)
    comment = models.ForeignKey(Comment, null=True, blank=True, on_delete=models.CASCADE)
    read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
