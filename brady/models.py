from django.conf import settings
from django.db import models
from django.utils import timezone

User = settings.AUTH_USER_MODEL


class Thread(models.Model):
    """Conversation avec Brady (historique propre à chaque utilisateur)."""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='brady_threads')
    title = models.CharField(max_length=120, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ['-updated_at']
        verbose_name = 'Conversation Brady'
        verbose_name_plural = 'Conversations Brady'

    def __str__(self):
        return self.title or f'Conversation {self.pk}'


class Message(models.Model):
    USER, ASSISTANT = 'user', 'assistant'
    thread = models.ForeignKey(Thread, on_delete=models.CASCADE, related_name='messages')
    role = models.CharField(max_length=10, choices=[(USER, 'Utilisateur'), (ASSISTANT, 'Brady')])
    content = models.TextField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['created_at', 'id']
        verbose_name = 'Message Brady'
        verbose_name_plural = 'Messages Brady'
