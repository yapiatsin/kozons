from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone


def avatar_path(instance, filename):
    return f'avatars/{instance.pk or "new"}/{timezone.now():%Y%m%d%H%M%S}_{filename}'


class User(AbstractUser):
    VISIBILITY = [('everyone', 'Tout le monde'), ('contacts', 'Mes contacts'), ('nobody', 'Personne')]

    display_name = models.CharField(max_length=64, blank=True)
    avatar = models.ImageField(upload_to=avatar_path, blank=True)
    about = models.CharField(max_length=140, default="Salut ! J'utilise Kozons.", blank=True)
    bio = models.TextField(max_length=500, blank=True)
    website = models.URLField(blank=True)
    phone = models.CharField(max_length=32, blank=True)
    is_private = models.BooleanField(default=False)

    # Présence
    last_seen = models.DateTimeField(null=True, blank=True)
    online_count = models.PositiveIntegerField(default=0)

    # Confidentialité
    last_seen_visibility = models.CharField(max_length=10, choices=VISIBILITY, default='everyone')
    avatar_visibility = models.CharField(max_length=10, choices=VISIBILITY, default='everyone')
    read_receipts = models.BooleanField(default=True)

    @property
    def name(self):
        return self.display_name or self.username

    @property
    def is_online(self):
        return self.online_count > 0


class Block(models.Model):
    blocker = models.ForeignKey(User, on_delete=models.CASCADE, related_name='blocking')
    blocked = models.ForeignKey(User, on_delete=models.CASCADE, related_name='blocked_by')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['blocker', 'blocked'], name='uniq_block')]

    @staticmethod
    def between(a, b):
        """Vrai si l'un des deux utilisateurs a bloqué l'autre."""
        return Block.objects.filter(
            models.Q(blocker=a, blocked=b) | models.Q(blocker=b, blocked=a)
        ).exists()


class OneTimeCode(models.Model):
    """Code à 6 chiffres envoyé par e-mail (mot de passe oublié, extensible à d'autres usages).

    Seul un HMAC du code est stocké : une fuite de la base ne révèle aucun code valide."""
    PURPOSE_PASSWORD_RESET = 'password_reset'
    PURPOSE_LOGIN = 'login'
    PURPOSE_CHOICES = [
        (PURPOSE_PASSWORD_RESET, 'Réinitialisation du mot de passe'),
        (PURPOSE_LOGIN, 'Vérification de connexion'),
    ]

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='one_time_codes')
    purpose = models.CharField(max_length=32, choices=PURPOSE_CHOICES, default=PURPOSE_PASSWORD_RESET, db_index=True)
    code_hash = models.CharField(max_length=64)
    attempts = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    @property
    def is_active(self):
        return self.used_at is None and timezone.now() < self.expires_at
