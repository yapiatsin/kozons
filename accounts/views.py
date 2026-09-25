import hashlib
import hmac
import logging
import re
import secrets
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core import signing
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone

from kozons.api import ApiError, api, as_bool, body, media_kind, rate_limit

from .models import Block, OneTimeCode, User
from .serializers import user_brief, user_private
from .utils import (send_in_background, send_login_otp_email, send_password_changed_email,
                    send_password_reset_otp_email)

logger = logging.getLogger(__name__)

USERNAME_RE = re.compile(r'^[a-zA-Z0-9._]{3,30}$')
RESET_SALT = 'kozons.password-reset'
RESET_TOKEN_MAX_AGE = 15 * 60
RESEND_COOLDOWN = timedelta(seconds=60)
LOGIN_SALT = 'kozons.login-otp'


def clean_email(value, exclude_user=None):
    email = (value or '').strip().lower()
    try:
        validate_email(email)
    except ValidationError:
        raise ApiError('Adresse e-mail invalide.')
    taken = User.objects.filter(email__iexact=email)
    if exclude_user is not None:
        taken = taken.exclude(pk=exclude_user.pk)
    if taken.exists():
        raise ApiError('Cette adresse e-mail est déjà utilisée par un autre compte.')
    return email


def find_user(identifier):
    """Compte actif correspondant à un nom d'utilisateur ou à une adresse e-mail."""
    identifier = (identifier or '').strip().lstrip('@')
    if not identifier:
        return None
    field = 'email__iexact' if '@' in identifier else 'username__iexact'
    return User.objects.filter(**{field: identifier}, is_active=True).first()


@api(['POST'], auth=False)
def register(request):
    rate_limit(request, 'register', 10, 3600)
    data = body(request)
    username = (data.get('username') or '').strip().lower()
    password = data.get('password') or ''
    if not USERNAME_RE.match(username):
        raise ApiError("Nom d'utilisateur : 3 à 30 caractères (lettres, chiffres, . et _).")
    if User.objects.filter(username__iexact=username).exists():
        raise ApiError("Ce nom d'utilisateur est déjà pris.")
    email = clean_email(data.get('email'))
    user = User(username=username, display_name=(data.get('display_name') or '').strip()[:64], email=email)
    try:
        validate_password(password, user)
    except ValidationError as e:
        raise ApiError(' '.join(e.messages))
    user.set_password(password)
    try:
        user.save()
    except IntegrityError:
        raise ApiError("Ce nom d'utilisateur est déjà pris.")
    login(request, user)
    return {'user': user_private(user)}


@api(['POST'], auth=False)
def login_view(request):
    rate_limit(request, 'login', 20, 300)
    data = body(request)
    # Connexion par nom d'utilisateur ou par adresse e-mail.
    identifier = (data.get('username') or '').strip()
    account = find_user(identifier)
    user = authenticate(request, username=account.username if account else identifier.lower(),
                        password=data.get('password') or '')
    if user is None:
        raise ApiError('Identifiants incorrects.', 401)
    if not has_valid_email(user):
        # Impossible d'envoyer un code : connexion directe (compte créé avant l'e-mail obligatoire).
        logger.warning("Connexion sans code pour %s : aucune adresse e-mail valide (%r).", user.username, user.email)
        login(request, user)
        return {'otp_required': False, 'user': user_private(user)}
    # Mot de passe correct : on n'ouvre pas encore la session, un code part par e-mail.
    return _send_login_code(request, user)


def _send_login_code(request, user):
    code, otp = issue_code(user, OneTimeCode.PURPOSE_LOGIN, settings.LOGIN_OTP_MINUTES)
    if not send_login_otp_email(user, code, ip=request.META.get('REMOTE_ADDR')):
        otp.delete()
        raise ApiError("Le code de connexion n'a pas pu être envoyé. Réessayez dans quelques instants.", 503)
    return {
        'otp_required': True,
        'challenge': signing.dumps({'user': user.pk, 'otp': otp.pk}, salt=LOGIN_SALT),
        'email_hint': mask_email(user.email),
        'expires_in_minutes': settings.LOGIN_OTP_MINUTES,
        'resend_after_seconds': int(RESEND_COOLDOWN.total_seconds()),
    }


def _load_login_challenge(data):
    try:
        # Le défi reste valable le temps de saisir / redemander des codes, pas indéfiniment.
        payload = signing.loads(data.get('challenge') or '', salt=LOGIN_SALT, max_age=30 * 60)
    except signing.BadSignature:
        raise ApiError('Votre session de connexion a expiré. Saisissez à nouveau vos identifiants.', 400)
    user = User.objects.filter(pk=payload.get('user'), is_active=True).first()
    if user is None:
        raise ApiError('Votre session de connexion a expiré. Saisissez à nouveau vos identifiants.', 400)
    return user, payload.get('otp')


@api(['POST'], auth=False)
def login_verify(request):
    """Étape 2 de la connexion : le code reçu par e-mail ouvre la session."""
    rate_limit(request, 'login-verify', 20, 900)
    data = body(request)
    user, otp_id = _load_login_challenge(data)
    otp = active_code(user, OneTimeCode.PURPOSE_LOGIN, pk=otp_id)
    check_code(otp, user, data.get('code'))
    otp.used_at = timezone.now()
    otp.save(update_fields=['used_at'])
    login(request, user, backend='django.contrib.auth.backends.ModelBackend')
    return {'user': user_private(user)}


@api(['POST'], auth=False)
def login_resend(request):
    """Renvoie un nouveau code de connexion (1 par minute au plus)."""
    rate_limit(request, 'login-resend', 5, 900)
    user, _ = _load_login_challenge(body(request))
    last = OneTimeCode.objects.filter(user=user, purpose=OneTimeCode.PURPOSE_LOGIN).order_by('-created_at').first()
    if last and last.created_at > timezone.now() - RESEND_COOLDOWN:
        wait = int((last.created_at + RESEND_COOLDOWN - timezone.now()).total_seconds()) + 1
        raise ApiError(f'Patientez {wait} s avant de demander un nouveau code.', 429)
    return _send_login_code(request, user)


@api(['POST'])
def logout_view(request):
    logout(request)


@api(['GET', 'POST'], auth=False)
def me(request):
    if not request.user.is_authenticated:
        return {'user': None}
    user = request.user
    if request.method == 'POST':
        data = body(request)
        if 'email' in data and (data.get('email') or '').strip().lower() != user.email.lower():
            user.email = clean_email(data.get('email'), exclude_user=user)
        for field, limit in (('display_name', 64), ('about', 140), ('bio', 500), ('phone', 32)):
            if field in data:
                setattr(user, field, (data.get(field) or '').strip()[:limit])
        if 'website' in data:
            website = (data.get('website') or '').strip()
            if website and not website.startswith(('http://', 'https://')):
                website = 'https://' + website
            user.website = website[:200]
        for field in ('is_private', 'read_receipts'):
            if field in data:
                setattr(user, field, as_bool(data.get(field)))
        for field in ('last_seen_visibility', 'avatar_visibility'):
            if data.get(field) in ('everyone', 'contacts', 'nobody'):
                setattr(user, field, data.get(field))
        if 'avatar' in request.FILES:
            upload = request.FILES['avatar']
            if media_kind(upload) != 'image':
                raise ApiError('La photo de profil doit être une image.')
            user.avatar = upload
        elif as_bool(data.get('remove_avatar')):
            user.avatar = None
        user.save()
    return {'user': user_private(user)}


@api(['POST'])
def change_password(request):
    data = body(request)
    if not request.user.check_password(data.get('old_password') or ''):
        raise ApiError('Mot de passe actuel incorrect.')
    try:
        validate_password(data.get('new_password') or '', request.user)
    except ValidationError as e:
        raise ApiError(' '.join(e.messages))
    request.user.set_password(data['new_password'])
    request.user.save()
    update_session_auth_hash(request, request.user)


# ---------------------------------------------------------------- Mot de passe oublié

def _code_hash(user_id, code):
    """HMAC du code, lié à l'utilisateur : impossible à retrouver depuis la base."""
    return hmac.new(settings.SECRET_KEY.encode(), f'{user_id}:{code}'.encode(), hashlib.sha256).hexdigest()


def has_valid_email(user):
    try:
        validate_email(user.email)
        return True
    except ValidationError:
        return False


def mask_email(email):
    """« devnewtech10.10@gmail.com » -> « de************@gmail.com »."""
    local, _, domain = email.partition('@')
    return (local[:2] + '*' * max(1, len(local) - 2)) + '@' + domain


def issue_code(user, purpose, minutes):
    """Crée un nouveau code (les précédents du même usage sont invalidés) -> (code en clair, OneTimeCode)."""
    code = f'{secrets.randbelow(10 ** 6):06d}'
    with transaction.atomic():
        OneTimeCode.objects.filter(user=user, purpose=purpose, used_at__isnull=True).update(used_at=timezone.now())
        otp = OneTimeCode.objects.create(user=user, purpose=purpose, code_hash=_code_hash(user.pk, code),
                                         expires_at=timezone.now() + timedelta(minutes=minutes))
    return code, otp


def active_code(user, purpose, pk=None):
    qs = OneTimeCode.objects.filter(user=user, purpose=purpose, used_at__isnull=True, expires_at__gt=timezone.now())
    if pk is not None:
        qs = qs.filter(pk=pk)
    otp = qs.first()
    if otp is None:
        raise ApiError('Code invalide ou expiré. Demandez un nouveau code.')
    return otp


def check_code(otp, user, raw_code):
    """Vérifie un code : 5 essais maximum, comparaison en temps constant."""
    code = re.sub(r'\D', '', str(raw_code or ''))
    if len(code) != 6:
        raise ApiError('Saisissez les 6 chiffres du code.')
    otp.attempts += 1
    if otp.attempts > settings.PASSWORD_RESET_MAX_ATTEMPTS:
        otp.used_at = timezone.now()  # code grillé après trop d'essais
        otp.save(update_fields=['attempts', 'used_at'])
        raise ApiError("Trop d'essais. Demandez un nouveau code.", 429)
    otp.save(update_fields=['attempts'])
    if not hmac.compare_digest(otp.code_hash, _code_hash(user.pk, code)):
        left = settings.PASSWORD_RESET_MAX_ATTEMPTS - otp.attempts
        if left <= 0:
            raise ApiError('Code incorrect. Demandez un nouveau code.')
        raise ApiError(f'Code incorrect. Il vous reste {left} essai{"s" if left > 1 else ""}.')


@api(['POST'], auth=False)
def password_forgot(request):
    """Étape 1 : envoie un code à 6 chiffres à l'adresse e-mail du compte.

    La réponse est identique que le compte existe ou non (pas d'énumération des comptes)."""
    rate_limit(request, 'pwd-forgot', 5, 900)
    identifier = (body(request).get('identifier') or '').strip()
    if not identifier:
        raise ApiError("Saisissez votre adresse e-mail ou votre nom d'utilisateur.")
    minutes = settings.PASSWORD_RESET_OTP_MINUTES
    response = {
        'ok': True,
        'message': "Si un compte correspond, un code de vérification vient d'être envoyé à son adresse e-mail.",
        'expires_in_minutes': minutes,
        'resend_after_seconds': int(RESEND_COOLDOWN.total_seconds()),
    }
    # La réponse reste neutre pour l'utilisateur ; la raison exacte est écrite dans le
    # journal du serveur pour faciliter le diagnostic.
    user = find_user(identifier)
    if user is None:
        logger.warning('Mot de passe oublié : aucun compte actif pour « %s » — aucun e-mail envoyé.', identifier)
        return response
    if not has_valid_email(user):
        logger.warning("Mot de passe oublié : le compte %s n'a pas d'adresse e-mail valide (%r) — aucun e-mail envoyé.",
                       user.username, user.email)
        return response
    purpose = OneTimeCode.PURPOSE_PASSWORD_RESET
    if OneTimeCode.objects.filter(user=user, purpose=purpose, created_at__gt=timezone.now() - RESEND_COOLDOWN).exists():
        logger.info("Mot de passe oublié : code déjà envoyé à %s il y a moins d'une minute.", user.username)
        return response  # anti-spam : un seul e-mail par minute et par compte
    code, otp = issue_code(user, purpose, minutes)
    if not send_password_reset_otp_email(user, code):
        otp.delete()  # permet de redemander un code tout de suite
        raise ApiError("L'e-mail n'a pas pu être envoyé. Réessayez dans quelques instants.", 503)
    return response


@api(['POST'], auth=False)
def password_verify(request):
    """Étape 2 : vérifie le code et renvoie un jeton signé (15 min) pour choisir le mot de passe."""
    rate_limit(request, 'pwd-verify', 20, 900)
    data = body(request)
    user = find_user(data.get('identifier'))
    if user is None:
        raise ApiError('Code invalide ou expiré. Demandez un nouveau code.')
    otp = active_code(user, OneTimeCode.PURPOSE_PASSWORD_RESET)
    check_code(otp, user, data.get('code'))
    return {'reset_token': signing.dumps({'otp': otp.pk, 'user': user.pk}, salt=RESET_SALT)}


@api(['POST'], auth=False)
def password_reset(request):
    """Étape 3 : enregistre le nouveau mot de passe et connecte l'utilisateur."""
    rate_limit(request, 'pwd-reset', 20, 900)
    data = body(request)
    try:
        payload = signing.loads(data.get('reset_token') or '', salt=RESET_SALT, max_age=RESET_TOKEN_MAX_AGE)
    except signing.BadSignature:
        raise ApiError('Session de réinitialisation expirée. Recommencez la procédure.')
    otp = OneTimeCode.objects.select_related('user').filter(
        pk=payload.get('otp'), user_id=payload.get('user'), used_at__isnull=True).first()
    if otp is None or not otp.user.is_active:
        raise ApiError('Ce code a déjà été utilisé. Recommencez la procédure.')
    user = otp.user
    password = data.get('new_password') or ''
    try:
        validate_password(password, user)
    except ValidationError as e:
        raise ApiError(' '.join(e.messages))
    with transaction.atomic():
        user.set_password(password)  # invalide aussi les sessions ouvertes sur les autres appareils
        user.save(update_fields=['password'])
        OneTimeCode.objects.filter(user=user, purpose=otp.purpose, used_at__isnull=True).update(used_at=timezone.now())
    login(request, user)
    send_in_background(send_password_changed_email, user)
    return {'user': user_private(user)}


@api(['GET'])
def search_users(request):
    q = (request.GET.get('q') or '').strip().lstrip('@')
    if not q:
        return {'results': []}
    blocked = Block.objects.filter(blocked=request.user).values('blocker_id')
    users = (User.objects.filter(Q(username__icontains=q) | Q(display_name__icontains=q))
             .exclude(pk__in=blocked).exclude(pk=request.user.pk).filter(is_active=True)[:30])
    return {'results': [user_brief(u, request.user) for u in users]}


@api(['POST'])
def toggle_block(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    if target == request.user:
        raise ApiError('Impossible de vous bloquer vous-même.')
    block, created = Block.objects.get_or_create(blocker=request.user, blocked=target)
    if not created:
        block.delete()
    else:
        # Bloquer retire aussi les abonnements mutuels.
        from social.models import Follow
        Follow.objects.filter(Q(follower=request.user, following=target) | Q(follower=target, following=request.user)).delete()
    return {'blocked': created}


@api(['GET'])
def blocked_list(request):
    blocks = Block.objects.filter(blocker=request.user).select_related('blocked')
    return {'results': [user_brief(b.blocked, request.user) for b in blocks]}
