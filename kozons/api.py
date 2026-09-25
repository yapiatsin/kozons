"""Outils communs pour les vues JSON de l'API Kozons."""
import functools
import json
import os

from django.conf import settings
from django.core.cache import cache
from django.http import JsonResponse


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def api(methods=('GET',), auth=True):
    """Décorateur : méthodes autorisées, authentification, erreurs -> JSON."""
    def decorator(view):
        @functools.wraps(view)
        def wrapper(request, *args, **kwargs):
            if request.method not in methods:
                return JsonResponse({'error': 'Méthode non autorisée'}, status=405)
            if auth and not request.user.is_authenticated:
                return JsonResponse({'error': 'Non authentifié'}, status=401)
            try:
                result = view(request, *args, **kwargs)
            except ApiError as e:
                return JsonResponse({'error': e.message}, status=e.status)
            if isinstance(result, JsonResponse):
                return result
            return JsonResponse(result if result is not None else {'ok': True}, safe=False)
        return wrapper
    return decorator


def body(request):
    """Données de la requête : JSON ou formulaire multipart."""
    if request.content_type == 'application/json':
        try:
            return json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            raise ApiError('JSON invalide')
    return request.POST


def rate_limit(request, key, limit, window):
    """Limite `limit` actions par fenêtre de `window` secondes et par utilisateur/IP."""
    ident = request.user.pk if request.user.is_authenticated else request.META.get('REMOTE_ADDR')
    cache_key = f'rl:{key}:{ident}'
    added = cache.add(cache_key, 1, window)
    if not added:
        try:
            count = cache.incr(cache_key)
        except ValueError:
            cache.set(cache_key, 1, window)
            count = 1
        if count > limit:
            raise ApiError('Trop de requêtes, réessayez dans un instant.', 429)


IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.bmp'}
VIDEO_EXT = {'.mp4', '.webm', '.mov', '.mkv', '.m4v', '.3gp'}
AUDIO_EXT = {'.mp3', '.ogg', '.oga', '.wav', '.m4a', '.aac', '.opus', '.weba'}
BLOCKED_EXT = {'.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.js', '.jar', '.html', '.htm', '.svg'}


def media_kind(upload):
    """Détermine le type d'un fichier envoyé et refuse les fichiers dangereux ou trop gros."""
    if upload.size > settings.KOZONS_MAX_UPLOAD:
        raise ApiError('Fichier trop volumineux (100 Mo max).')
    ext = os.path.splitext(upload.name)[1].lower()
    ctype = (upload.content_type or '').lower()
    if ext in BLOCKED_EXT:
        raise ApiError('Type de fichier non autorisé.')
    if ext in IMAGE_EXT or ctype.startswith('image/'):
        return 'image'
    if ext in VIDEO_EXT or ctype.startswith('video/'):
        return 'video'
    if ext in AUDIO_EXT or ctype.startswith('audio/'):
        return 'audio'
    return 'file'


def as_bool(value):
    return str(value).lower() in ('1', 'true', 'on', 'yes')


def as_int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
