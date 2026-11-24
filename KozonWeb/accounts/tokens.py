"""Jetons d'API des applications mobiles : « Authorization: Token kz_… ».

Le navigateur garde le cookie de session + le jeton CSRF. Une application native n'a ni cookie ni
en-tête Referer (exigé par Django en HTTPS) : elle s'identifie avec un jeton, obtenu une fois par
POST /api/auth/token avec ses identifiants, gardé dans le stockage sécurisé du téléphone et envoyé
à chaque requête HTTP et à l'ouverture du WebSocket.

Seuls les jetons préfixés « kz_ » sont reconnus : un autre en-tête Authorization (ex. MediaMTX)
est ignoré.
"""
import hashlib
import secrets
from datetime import timedelta

from django.utils import timezone
from django.utils.crypto import constant_time_compare

PREFIX = 'kz_'
TOUCH_EVERY = timedelta(minutes=5)   # last_used_at écrit au plus toutes les 5 minutes
MAX_PER_USER = 20                    # au-delà, les plus anciens appareils sont déconnectés


def digest(key):
    return hashlib.sha256(key.encode()).hexdigest()


def parse_header(value):
    """« Token kz_… » ou « Bearer kz_… » → le jeton ; tout autre contenu → None."""
    if not value:
        return None
    if isinstance(value, bytes):
        value = value.decode('latin-1')
    scheme, _, key = value.strip().partition(' ')
    key = key.strip()
    if scheme.lower() not in ('token', 'bearer') or not key.startswith(PREFIX) or len(key) > 200:
        return None
    return key


def issue(user, device=''):
    """Crée un jeton pour cet utilisateur et le renvoie (il n'est plus jamais lisible ensuite)."""
    from .models import ApiToken
    key = PREFIX + secrets.token_urlsafe(32)
    ApiToken.objects.create(user=user, key_hash=digest(key), auth_hash=user.get_session_auth_hash(),
                            device=(device or '').strip()[:100])
    stale = ApiToken.objects.filter(user=user).values_list('pk', flat=True)[MAX_PER_USER:]
    ApiToken.objects.filter(pk__in=list(stale)).delete()
    return key


def authenticate(key):
    """Jeton valide → ApiToken (avec .user) ; inconnu, compte désactivé ou mot de passe changé → None."""
    from .models import ApiToken
    if not key:
        return None
    token = ApiToken.objects.select_related('user').filter(key_hash=digest(key)).first()
    if token is None:
        return None
    user = token.user
    # Mêmes règles que les sessions : compte actif, accès autorisé (can_connect), mot de passe inchangé.
    if not user.is_active or getattr(user, 'can_connect', False) is not True:
        return None
    if not constant_time_compare(token.auth_hash, user.get_session_auth_hash()):
        return None
    now = timezone.now()
    if token.last_used_at is None or now - token.last_used_at >= TOUCH_EVERY:
        ApiToken.objects.filter(pk=token.pk).update(last_used_at=now)
        token.last_used_at = now
    return token


def refresh(token, user):
    """Après un changement de mot de passe depuis cet appareil : il reste connecté (les autres non)."""
    token.auth_hash = user.get_session_auth_hash()
    token.save(update_fields=['auth_hash'])
