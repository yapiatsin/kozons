import secrets

from django.conf import settings
from django.db import models
from django.utils import timezone

User = settings.AUTH_USER_MODEL

# Cadeaux virtuels (gratuits : aucun paiement), du plus modeste au plus spectaculaire.
GIFTS = {
    'rose': {'emoji': '🌹', 'name': 'Rose', 'value': 1},
    'heart': {'emoji': '💖', 'name': 'Cœur', 'value': 5},
    'fire': {'emoji': '🔥', 'name': 'Flamme', 'value': 10},
    'crown': {'emoji': '👑', 'name': 'Couronne', 'value': 50},
    'fireworks': {'emoji': '🎆', 'name': "Feu d'artifice", 'value': 100},
    'car': {'emoji': '🏎️', 'name': 'Bolide', 'value': 300},
    'lion': {'emoji': '🦁', 'name': 'Lion', 'value': 500},
    'galaxy': {'emoji': '🌌', 'name': 'Galaxie', 'value': 1000},
}


def media_key():
    return secrets.token_hex(12)


class LiveStream(models.Model):
    LIVE, ENDED = 'live', 'ended'
    AUDIENCES = [('public', 'Tout le monde'), ('followers', 'Abonnés uniquement')]

    host = models.ForeignKey(User, on_delete=models.CASCADE, related_name='lives')
    title = models.CharField(max_length=80, blank=True)
    audience = models.CharField(max_length=10, choices=AUDIENCES, default='public')
    status = models.CharField(max_length=8, choices=[(LIVE, 'En direct'), (ENDED, 'Terminé')], default=LIVE, db_index=True)
    media_key = models.CharField(max_length=32, default=media_key, unique=True)
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)
    host_seen_at = models.DateTimeField(default=timezone.now)
    pinned_comment = models.ForeignKey('LiveComment', null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    likes_count = models.PositiveIntegerField(default=0)
    comments_count = models.PositiveIntegerField(default=0)
    gifts_count = models.PositiveIntegerField(default=0)
    gifts_value = models.PositiveIntegerField(default=0)
    peak_viewers = models.PositiveIntegerField(default=0)
    total_viewers = models.PositiveIntegerField(default=0)
    new_followers = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ['-started_at']
        verbose_name = 'Live'
        verbose_name_plural = 'Lives'

    def __str__(self):
        return f'LIVE #{self.pk} — {self.host}' + (f' : {self.title}' if self.title else '')

    @property
    def is_live(self):
        return self.status == self.LIVE

    @property
    def media_path(self):
        return f'k{self.media_key}'


class LiveViewer(models.Model):
    """Spectateur ayant rejoint le live au moins une fois (spectateurs uniques)."""
    live = models.ForeignKey(LiveStream, on_delete=models.CASCADE, related_name='viewers')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='+')
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['live', 'user'], name='uniq_live_viewer')]
        verbose_name = 'Spectateur'
        verbose_name_plural = 'Spectateurs'


class LiveComment(models.Model):
    live = models.ForeignKey(LiveStream, on_delete=models.CASCADE, related_name='comments')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='+')
    text = models.CharField(max_length=150)
    # Réponse à un autre commentaire du même live.
    reply_to = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = 'Commentaire'
        verbose_name_plural = 'Commentaires'

    def __str__(self):
        return f'{self.user} : {self.text[:40]}'


class LiveGift(models.Model):
    live = models.ForeignKey(LiveStream, on_delete=models.CASCADE, related_name='gifts')
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name='+')
    gift = models.CharField(max_length=20, choices=[(k, v['name']) for k, v in GIFTS.items()])
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = 'Cadeau'
        verbose_name_plural = 'Cadeaux'


class LiveBan(models.Model):
    """Spectateur exclu par l'animateur : ne peut plus rejoindre ni commenter ce live."""
    live = models.ForeignKey(LiveStream, on_delete=models.CASCADE, related_name='bans')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['live', 'user'], name='uniq_live_ban')]
        verbose_name = 'Exclusion'
        verbose_name_plural = 'Exclusions'
