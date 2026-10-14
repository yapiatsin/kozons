import secrets
import string

from django.conf import settings
from django.db import models
from django.utils import timezone

User = settings.AUTH_USER_MODEL


def meeting_code():
    """Code lisible façon « abc-defg-hij » (lettres minuscules, sans ambiguïté de saisie)."""
    letters = string.ascii_lowercase
    part = lambda n: ''.join(secrets.choice(letters) for _ in range(n))  # noqa: E731
    return f'{part(3)}-{part(4)}-{part(3)}'


def media_key():
    return secrets.token_hex(8)


class Meeting(models.Model):
    """Réunion Kozons Meet. Le lien reste valable : on peut s'y retrouver plusieurs fois."""
    OPEN, TRUSTED, RESTRICTED = 'open', 'trusted', 'restricted'
    ACCESS = [
        (OPEN, 'Ouvert : tout le monde entre sans demander'),
        (TRUSTED, 'Fiable : les invités entrent, les autres demandent'),
        (RESTRICTED, 'Restreint : seuls les invités peuvent participer'),
    ]

    code = models.CharField(max_length=12, unique=True, default=meeting_code)
    media_key = models.CharField(max_length=16, unique=True, default=media_key)
    host = models.ForeignKey(User, on_delete=models.CASCADE, related_name='hosted_meetings')
    title = models.CharField(max_length=120, blank=True)
    description = models.TextField(max_length=2000, blank=True)
    scheduled_at = models.DateTimeField(null=True, blank=True, db_index=True)
    duration_minutes = models.PositiveSmallIntegerField(default=60)
    created_at = models.DateTimeField(default=timezone.now)
    cancelled = models.BooleanField(default=False)
    # Dernière séance : début (premier arrivé) et fin (dernier parti / « terminer pour tous »).
    started_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)

    # Gestion par l'organisateur
    access = models.CharField(max_length=10, choices=ACCESS, default=TRUSTED)
    chat_enabled = models.BooleanField(default=True)
    reactions_enabled = models.BooleanField(default=True)
    present_allowed = models.BooleanField(default=True)   # tous peuvent présenter leur écran
    mic_allowed = models.BooleanField(default=True)       # les participants peuvent activer leur micro
    cam_allowed = models.BooleanField(default=True)
    # Notes IA : qui les reçoit, et démarrage automatique à l'ouverture.
    notes_share = models.CharField(max_length=8, choices=[('all', 'Tous les participants'), ('hosts', 'Organisateurs')], default='all')
    notes_auto = models.BooleanField(default=False)
    language = models.CharField(max_length=8, default='fr-FR')

    class Meta:
        ordering = ['-created_at']
        verbose_name = 'Réunion'
        verbose_name_plural = 'Réunions'

    def __str__(self):
        return f'{self.code} — {self.title or "Réunion"}'

    @property
    def label(self):
        return self.title or f'Réunion {self.code}'


class MeetingInvite(models.Model):
    """Invité (entre directement en mode « fiable »). cohost = co-organisateur."""
    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name='invites')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='meeting_invites')
    cohost = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['meeting', 'user'], name='uniq_meeting_invite')]
        verbose_name = 'Invité'
        verbose_name_plural = 'Invités'


class MeetingAttendance(models.Model):
    """Passage d'un participant dans la réunion (une ligne par connexion)."""
    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name='attendances')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='+')
    joined_at = models.DateTimeField(default=timezone.now)
    left_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['joined_at']
        verbose_name = 'Présence'
        verbose_name_plural = 'Présences'


class MeetingMessage(models.Model):
    """Message du chat de la réunion (conservé, contrairement à Google Meet, et repris dans les notes)."""
    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name='messages')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='+')
    text = models.CharField(max_length=2000)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['created_at']
        verbose_name = 'Message'
        verbose_name_plural = 'Messages'


class MeetingNotes(models.Model):
    """Prise de notes IA : transcription pendant la réunion, puis compte rendu rédigé par Claude."""
    RECORDING, PROCESSING, READY, FAILED, EMPTY, NO_AI = 'recording', 'processing', 'ready', 'failed', 'empty', 'no_ai'
    STATUSES = [
        (RECORDING, 'Prise de notes en cours'), (PROCESSING, 'Rédaction du compte rendu'), (READY, 'Prêt'),
        (FAILED, 'Échec'), (EMPTY, 'Rien à résumer'), (NO_AI, 'Transcription seule (IA non configurée)'),
    ]

    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name='notes')
    started_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name='+')
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=12, choices=STATUSES, default=RECORDING, db_index=True)
    summary = models.JSONField(null=True, blank=True)
    model = models.CharField(max_length=64, blank=True)
    error = models.CharField(max_length=500, blank=True)
    # Destinataires : participants présents pendant la prise de notes (+ organisateurs).
    recipients = models.ManyToManyField(User, blank=True, related_name='meeting_notes')

    class Meta:
        ordering = ['-started_at']
        verbose_name = 'Notes IA'
        verbose_name_plural = 'Notes IA'

    def __str__(self):
        return f'Notes {self.meeting.code} ({self.started_at:%d/%m/%Y %H:%M})'


class TranscriptLine(models.Model):
    """Phrase prononcée (reconnue par le navigateur de la personne qui parle)."""
    notes = models.ForeignKey(MeetingNotes, on_delete=models.CASCADE, related_name='lines')
    user = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name='+')
    speaker = models.CharField(max_length=80)
    text = models.TextField(max_length=4000)
    spoken_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['spoken_at', 'id']
        verbose_name = 'Ligne de transcription'
        verbose_name_plural = 'Transcription'
