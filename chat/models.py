from django.conf import settings
from django.db import models
from django.utils import timezone

User = settings.AUTH_USER_MODEL


def chat_file_path(instance, filename):
    return f'chat/{instance.conversation_id}/{timezone.now():%Y/%m}/{filename}'


def group_avatar_path(instance, filename):
    return f'groups/{timezone.now():%Y%m%d%H%M%S}_{filename}'


def sticker_path(instance, filename):
    return f'stickers/{instance.sha256[:2]}/{instance.sha256}.webp'


class Sticker(models.Model):
    """Sticker WebP 512×512 (statique ou animé), stocké une seule fois quel que soit le
    nombre d'utilisateurs qui l'enregistrent ou l'envoient (dédoublonné par empreinte)."""
    file = models.FileField(upload_to=sticker_path)
    sha256 = models.CharField(max_length=64, unique=True)
    animated = models.BooleanField(default=False)
    created_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)


class UserSticker(models.Model):
    """Lien d'un utilisateur avec un sticker : dans sa collection, en favori, utilisé récemment."""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='stickers')
    sticker = models.ForeignKey(Sticker, on_delete=models.CASCADE, related_name='owners')
    saved = models.BooleanField(default=False)
    favorite = models.BooleanField(default=False)
    favorited_at = models.DateTimeField(null=True, blank=True)
    saved_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'sticker'], name='uniq_user_sticker')]


class Conversation(models.Model):
    DIRECT, GROUP = 'direct', 'group'
    KINDS = [(DIRECT, 'Discussion'), (GROUP, 'Groupe')]

    kind = models.CharField(max_length=10, choices=KINDS)
    title = models.CharField(max_length=100, blank=True)
    description = models.TextField(max_length=1000, blank=True)
    avatar = models.ImageField(upload_to=group_avatar_path, blank=True)
    # "idmin:idmax" pour garantir une seule discussion privée par paire.
    direct_key = models.CharField(max_length=64, unique=True, null=True, blank=True)
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(default=timezone.now, db_index=True)
    only_admins_can_send = models.BooleanField(default=False)
    only_admins_can_edit = models.BooleanField(default=False)
    disappearing_seconds = models.PositiveIntegerField(default=0)

    @property
    def is_group(self):
        return self.kind == self.GROUP


class Participant(models.Model):
    MEMBER, ADMIN = 'member', 'admin'

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='participants')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='participations')
    role = models.CharField(max_length=10, choices=[(MEMBER, 'Membre'), (ADMIN, 'Admin')], default=MEMBER)
    joined_at = models.DateTimeField(auto_now_add=True)
    last_read_id = models.BigIntegerField(default=0)
    last_delivered_id = models.BigIntegerField(default=0)
    pinned = models.BooleanField(default=False)
    archived = models.BooleanField(default=False)
    muted_until = models.DateTimeField(null=True, blank=True)
    cleared_before_id = models.BigIntegerField(default=0)
    marked_unread = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['conversation', 'user'], name='uniq_participant')]

    @property
    def is_admin(self):
        return self.role == self.ADMIN


class Message(models.Model):
    KINDS = [(k, k) for k in (
        'text', 'image', 'video', 'audio', 'voice', 'file', 'sticker',
        'location', 'contact', 'poll', 'post', 'story_reply', 'system',
    )]

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='messages')
    kind = models.CharField(max_length=12, choices=KINDS, default='text')
    text = models.TextField(max_length=65536, blank=True)
    file = models.FileField(upload_to=chat_file_path, blank=True)
    file_name = models.CharField(max_length=255, blank=True)
    file_size = models.BigIntegerField(default=0)
    duration = models.FloatField(default=0)
    reply_to = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    forwarded = models.BooleanField(default=False)
    view_once = models.BooleanField(default=False)
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    shared_post = models.ForeignKey('social.Post', null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    story = models.ForeignKey('social.Story', null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    contact_user = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    sticker = models.ForeignKey(Sticker, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(default=timezone.now)
    edited_at = models.DateTimeField(null=True, blank=True)
    deleted = models.BooleanField(default=False)
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True)

    class Meta:
        indexes = [models.Index(fields=['conversation', '-id'])]


class Reaction(models.Model):
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='reactions')
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    emoji = models.CharField(max_length=16)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['message', 'user'], name='uniq_reaction')]


class HiddenMessage(models.Model):
    """Message supprimé « pour moi »."""
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='hidden_for')
    user = models.ForeignKey(User, on_delete=models.CASCADE)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['message', 'user'], name='uniq_hidden')]


class StarredMessage(models.Model):
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='starred_by')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='starred')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['message', 'user'], name='uniq_star')]


class ViewOnceOpened(models.Model):
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='opened_by')
    user = models.ForeignKey(User, on_delete=models.CASCADE)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['message', 'user'], name='uniq_viewonce')]


class PollOption(models.Model):
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='poll_options')
    text = models.CharField(max_length=100)
    multiple = models.BooleanField(default=False)


class PollVote(models.Model):
    option = models.ForeignKey(PollOption, on_delete=models.CASCADE, related_name='votes')
    user = models.ForeignKey(User, on_delete=models.CASCADE)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['option', 'user'], name='uniq_vote')]


class Call(models.Model):
    STATUSES = [(s, s) for s in ('ringing', 'ongoing', 'ended', 'missed', 'declined', 'busy')]

    caller = models.ForeignKey(User, on_delete=models.CASCADE, related_name='calls_made')
    callee = models.ForeignKey(User, on_delete=models.CASCADE, related_name='calls_received')
    video = models.BooleanField(default=False)
    status = models.CharField(max_length=10, choices=STATUSES, default='ringing')
    started_at = models.DateTimeField(default=timezone.now)
    answered_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
