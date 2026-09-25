"""Stickers : conversion en WebP 512×512, collection personnelle (récents, favoris, mes stickers)."""
import hashlib
import io

from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from PIL import Image, ImageSequence, UnidentifiedImageError

from kozons.api import ApiError, api, as_int, body, rate_limit

from .models import Message, Sticker, UserSticker

SIZE = 512
MAX_INPUT = 10 * 1024 * 1024
MAX_STATIC = 500 * 1024
MAX_ANIMATED = 1024 * 1024
MAX_FRAMES = 200
ALLOWED_FORMATS = {'PNG', 'JPEG', 'WEBP', 'GIF', 'BMP', 'MPO'}
RECENT_LIMIT = 32

Image.MAX_IMAGE_PIXELS = 40_000_000  # protège contre les « bombes » de décompression


def _fit(frame):
    """Centre l'image dans un carré transparent de 512 px, sans la déformer."""
    frame = frame.convert('RGBA')
    frame.thumbnail((SIZE, SIZE), Image.LANCZOS)
    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(frame, ((SIZE - frame.width) // 2, (SIZE - frame.height) // 2), frame)
    return canvas


def convert_to_sticker(data):
    """Octets d'une image -> (octets WebP, animé ?). Lève ApiError si l'image est refusée."""
    if len(data) > MAX_INPUT:
        raise ApiError('Image trop lourde pour un sticker (10 Mo max).')
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ApiError("Ce fichier n'est pas une image valide.")
    if img.format not in ALLOWED_FORMATS:
        raise ApiError('Format non pris en charge (PNG, JPEG, WebP ou GIF).')

    out = io.BytesIO()
    animated = getattr(img, 'is_animated', False) and getattr(img, 'n_frames', 1) > 1
    if animated:
        frames, durations = [], []
        for i, frame in enumerate(ImageSequence.Iterator(img)):
            if i >= MAX_FRAMES:
                break
            frames.append(_fit(frame))
            durations.append(max(20, frame.info.get('duration', img.info.get('duration', 80)) or 80))
        frames[0].save(out, 'WEBP', save_all=True, append_images=frames[1:], duration=durations,
                       loop=0, quality=75, method=4)
        if out.tell() > MAX_ANIMATED:
            raise ApiError('Sticker animé trop lourd (1 Mo max après conversion). Raccourcissez l\'animation.')
    else:
        canvas = _fit(img)
        for quality in (90, 75, 60):
            out = io.BytesIO()
            canvas.save(out, 'WEBP', quality=quality, method=6)
            if out.tell() <= MAX_STATIC:
                break
        else:
            raise ApiError('Image trop détaillée pour un sticker.')
    return out.getvalue(), animated


def create_sticker(data, user):
    """Crée (ou retrouve, s'il existe déjà) le sticker correspondant à une image."""
    webp, animated = convert_to_sticker(data)
    digest = hashlib.sha256(webp).hexdigest()
    sticker = Sticker.objects.filter(sha256=digest).first()
    if sticker is None:
        try:
            with transaction.atomic():
                sticker = Sticker(sha256=digest, animated=animated, created_by=user)
                sticker.file.save(f'{digest}.webp', ContentFile(webp), save=False)
                sticker.save()
        except IntegrityError:  # créé en parallèle par une autre requête
            sticker = Sticker.objects.get(sha256=digest)
    return sticker


def link(user, sticker):
    return UserSticker.objects.get_or_create(user=user, sticker=sticker)[0]


def mark_used(user, sticker):
    UserSticker.objects.update_or_create(user=user, sticker=sticker, defaults={'last_used_at': timezone.now()})


def can_access(user, sticker):
    """Un utilisateur manipule un sticker qu'il possède déjà ou qu'on lui a envoyé."""
    return (UserSticker.objects.filter(user=user, sticker=sticker).exists()
            or Message.objects.filter(sticker=sticker, deleted=False, conversation__participants__user=user).exists())


def sticker_data(sticker, link_row=None):
    return {
        'id': sticker.pk,
        'url': sticker.file.url,
        'animated': sticker.animated,
        'favorite': bool(link_row and link_row.favorite),
        'saved': bool(link_row and link_row.saved),
    }


def _get_accessible(user, pk):
    sticker = get_object_or_404(Sticker, pk=pk)
    if not can_access(user, sticker):
        raise ApiError('Sticker introuvable.', 404)
    return sticker


# ---------------------------------------------------------------- API

@api(['GET', 'POST'])
def sticker_collection(request):
    if request.method == 'POST':
        rate_limit(request, 'sticker-create', 60, 3600)
        upload = request.FILES.get('file')
        if not upload:
            raise ApiError('Choisissez une image.')
        sticker = create_sticker(upload.read(), request.user)
        row = link(request.user, sticker)
        row.saved = True
        row.saved_at = timezone.now()
        row.save(update_fields=['saved', 'saved_at'])
        return sticker_data(sticker, row)

    rows = list(UserSticker.objects.filter(user=request.user).select_related('sticker'))
    def pick(cond, key):
        return [sticker_data(r.sticker, r) for r in sorted(filter(cond, rows), key=key, reverse=True)]
    epoch = timezone.now().replace(year=2000)
    return {
        'recent': pick(lambda r: r.last_used_at, lambda r: r.last_used_at)[:RECENT_LIMIT],
        'favorites': pick(lambda r: r.favorite, lambda r: r.favorited_at or epoch),
        'mine': pick(lambda r: r.saved, lambda r: r.saved_at or epoch),
    }


@api(['POST'])
def sticker_action(request, pk):
    """{action: favorite|unfavorite|save|remove|forget} sur un sticker accessible."""
    sticker = _get_accessible(request.user, pk)
    return apply_action(request.user, sticker, body(request).get('action'))


def apply_action(user, sticker, action):
    row = link(user, sticker)
    now = timezone.now()
    if action in ('favorite', 'unfavorite', 'toggle_favorite'):
        row.favorite = (not row.favorite) if action == 'toggle_favorite' else action == 'favorite'
        row.favorited_at = now if row.favorite else None
    elif action == 'save':
        row.saved, row.saved_at = True, now
    elif action == 'remove':
        row.saved, row.saved_at = False, None
    elif action == 'forget':  # retire des récents
        row.last_used_at = None
    else:
        raise ApiError('Action inconnue.')
    if not (row.saved or row.favorite or row.last_used_at):
        row.delete()
        return sticker_data(sticker, None)
    row.save()
    return sticker_data(sticker, row)


@api(['POST'])
def sticker_from_message(request, pk):
    """Ajoute aux favoris / à « mes stickers » le sticker d'un message reçu."""
    from . import services as svc
    msg = get_object_or_404(Message, pk=pk)
    svc.get_participant(request.user, msg.conversation_id)
    if msg.kind != 'sticker' or msg.deleted or not msg.file:
        raise ApiError("Ce message n'est pas un sticker.")
    sticker = msg.sticker
    if sticker is None:  # ancien message : on crée le sticker à partir du fichier
        with msg.file.open('rb') as f:
            sticker = create_sticker(f.read(), request.user)
    return apply_action(request.user, sticker, body(request).get('action') or 'toggle_favorite')


def resolve_for_message(user, data, upload):
    """Sticker à envoyer : un sticker existant (sticker_id) ou une image importée."""
    if upload is not None:
        sticker = create_sticker(upload.read(), user)
    else:
        sticker = _get_accessible(user, as_int(data.get('sticker_id')))
    mark_used(user, sticker)
    return sticker

