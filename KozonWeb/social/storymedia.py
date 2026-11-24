"""Vidéos de statut : conversion, miniature, et ménage des statuts expirés.

Règles (réglages dans settings, valeurs par défaut ci-dessous) :
  · envoi : 100 Mo maximum (KOZONS_MAX_UPLOAD), n'importe quel format vidéo (MOV/HEVC d'iPhone, WebM…) ;
  · stockage : MP4 H.264 + AAC, 720 px sur le petit côté, 30 images/s max, ~1,5 Mbit/s,
    « faststart » (lecture immédiate) → environ 15 Mo pour 90 s ;
  · durée : 90 s maximum (au-delà, la vidéo est coupée) ;
  · conversion en arrière-plan, STORY_TRANSCODE_WORKERS à la fois (le VPS reste fluide) : le statut
    n'apparaît qu'une fois prêt ;
  · statuts expirés (24 h) : fichiers et lignes supprimés, sauf ceux signalés et pas encore traités.

Sans ffmpeg (développement), la vidéo est publiée telle quelle.
"""
import logging
import os
import shutil
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from django.conf import settings
from django.core.cache import cache
from django.core.files import File
from django.db import close_old_connections
from django.utils import timezone

from chat.audio import ffmpeg

logger = logging.getLogger(__name__)

PURGE_EVERY = 10 * 60          # au plus un ménage toutes les 10 minutes
STUCK_AFTER = timedelta(minutes=30)   # conversion interrompue (serveur redémarré…) : abandonnée

_executor = None
_executor_lock = threading.Lock()


def max_seconds():
    return getattr(settings, 'STORY_VIDEO_MAX_SECONDS', 90)


def daily_limit():
    return getattr(settings, 'STORY_DAILY_LIMIT', 30)


def ffprobe():
    return getattr(settings, 'FFPROBE_PATH', '') or shutil.which('ffprobe')


def _pool():
    global _executor
    with _executor_lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=getattr(settings, 'STORY_TRANSCODE_WORKERS', 2),
                                           thread_name_prefix='story-video')
        return _executor


def _run_async(fn, *args):
    if getattr(settings, 'KOZONS_STORY_ASYNC', True):
        _pool().submit(_in_thread, fn, *args)
    else:
        fn(*args)


def _in_thread(fn, *args):
    try:
        fn(*args)
    except Exception:  # la tâche tourne seule : une erreur ne doit rien casser
        logger.exception('Tâche des statuts (%s)', fn.__name__)
    finally:
        close_old_connections()


# ---------------------------------------------------------------- conversion

def probe_duration(path):
    exe = ffprobe()
    if not exe:
        return None
    try:
        proc = subprocess.run([exe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                              capture_output=True, timeout=30)
        return float(proc.stdout.decode().strip() or 'nan') if proc.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def clip_bounds(trim_start=None, trim_end=None):
    """Séquence choisie par l'utilisateur (secondes) → (début, longueur), longueur ≤ max_seconds()."""
    try:
        start = max(0.0, float(trim_start or 0))
    except (TypeError, ValueError):
        start = 0.0
    try:
        end = float(trim_end) if trim_end not in (None, '') else None
    except (TypeError, ValueError):
        end = None
    length = max_seconds() if end is None or end <= start else min(end - start, max_seconds())
    return round(start, 2), round(max(0.5, length), 2)


def transcode(src, out, poster, start=0.0, length=None, mute=False):
    """Convertit la séquence [start, start + length] de `src` en MP4 720p (`out`), sans le son si
    `mute`, et extrait une miniature JPEG (`poster`). True si réussi."""
    exe = ffmpeg()
    side = getattr(settings, 'STORY_VIDEO_SIDE', 720)
    rate = getattr(settings, 'STORY_VIDEO_KBPS', 1500)
    # Petit côté ramené à `side` (vidéo verticale : 720×1280), dimensions paires (exigées par H.264).
    scale = (f"scale=w='if(gt(iw,ih),-2,trunc(min({side},iw)/2)*2)'"
             f":h='if(gt(iw,ih),trunc(min({side},ih)/2)*2,-2)',format=yuv420p")
    length = min(length or max_seconds(), max_seconds())
    # -ss avant -i : accès direct au début de la séquence (précis, la vidéo étant réencodée).
    cmd = [exe, '-hide_banner', '-loglevel', 'error', '-y', '-ss', f'{start:.2f}', '-i', src, '-t', f'{length:.2f}',
           '-map', '0:v:0'] + ([] if mute else ['-map', '0:a:0?']) + ['-vf', scale, '-fpsmax', '30',
           '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', f'{rate}k', '-bufsize', f'{rate * 2}k',
           '-profile:v', 'high', '-threads', '2']
    cmd += ['-an'] if mute else ['-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '44100']
    cmd += ['-movflags', '+faststart', out]
    if shutil.which('nice'):
        cmd = ['nice', '-n', '10'] + cmd   # la conversion passe après les requêtes des utilisateurs
    proc = subprocess.run(cmd, capture_output=True, timeout=600)
    if proc.returncode != 0 or not os.path.exists(out) or not os.path.getsize(out):
        logger.warning('Conversion de la vidéo de statut impossible : %s', proc.stderr.decode(errors='replace')[:400])
        return False
    subprocess.run([exe, '-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.3', '-i', out, '-frames:v', '1',
                    '-vf', "scale='min(480,iw)':-2", '-q:v', '5', poster], capture_output=True, timeout=60)
    return True


def save_upload(upload):
    """Copie l'envoi dans un fichier temporaire à nous (Django supprime le sien à la fin de la requête)."""
    ext = os.path.splitext(upload.name or '')[1][:8] or '.mp4'
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
        for chunk in upload.chunks():
            f.write(chunk)
        return f.name


def start_processing(story, upload, *, trim_start=None, trim_end=None, mute=False):
    """Vidéo de statut reçue : conversion en arrière-plan de la séquence choisie. Retourne True si
    elle est en cours (le statut sera publié à la fin), False si ffmpeg est absent (publiée telle quelle)."""
    if not ffmpeg():
        logger.info('ffmpeg absent : vidéo de statut %s publiée sans conversion', story.pk)
        return False
    src = save_upload(upload)
    start, length = clip_bounds(trim_start, trim_end)
    _run_async(process, story.pk, src, start, length, bool(mute))
    return True


def process(story_id, src, start=0.0, length=None, mute=False):
    from .models import Story
    out = src + '.out.mp4'
    poster = src + '.jpg'
    try:
        story = Story.objects.select_related('user').filter(pk=story_id).first()
        if story is None:
            return
        source = probe_duration(src)
        length = length or max_seconds()
        if not transcode(src, out, poster, start=start, length=length, mute=mute):
            return fail(story)
        base = f'{story.user_id}_{story.pk}'
        with open(out, 'rb') as f:
            story.file.save(base + '.mp4', File(f), save=False)
        if os.path.exists(poster) and os.path.getsize(poster):
            with open(poster, 'rb') as f:
                story.poster.save(base + '.jpg', File(f), save=False)
        available = (source - start) if source else None
        story.duration = round(min(available, length), 1) if available and available > 0 else round(length, 1)
        story.processing = False
        story.save(update_fields=['file', 'poster', 'duration', 'processing'])
        # Coupée d'office seulement si la personne n'a pas choisi elle-même une séquence plus courte.
        publish(story, trimmed=bool(available and available > length + 0.5 and length >= max_seconds()))
    finally:
        for path in (src, out, poster):
            if os.path.exists(path):
                os.remove(path)


def fail(story):
    from chat.realtime import push
    user_id = story.user_id
    delete_story_files(story)
    story.delete()
    push([user_id], 'story.failed', {'message': "Votre vidéo n'a pas pu être publiée (format non reconnu). Essayez une autre vidéo."})


def publish(story, trimmed=False):
    """Statut prêt : prévient son audience (et l'auteur, qui le voit apparaître)."""
    from chat.realtime import push
    from .views import story_audience_viewers
    push(story_audience_viewers(story.user, story), 'story.new', {'user_id': story.user_id})
    if trimmed:
        push([story.user_id], 'story.published', {'message': f'Statut publié : la vidéo a été coupée à {max_seconds()} secondes.'})


# ---------------------------------------------------------------- ménage

def delete_story_files(story):
    for field in (story.file, story.poster):
        if field:
            try:
                field.delete(save=False)
            except OSError:
                logger.warning('Fichier de statut introuvable : %s', field.name)


def purge_expired(now=None):
    """Supprime les statuts expirés (fichiers + lignes), sauf ceux signalés et non traités, et les
    conversions bloquées. Retourne le nombre de statuts supprimés."""
    from .models import Story
    now = now or timezone.now()
    expired = Story.objects.filter(expires_at__lte=now).exclude(reports__handled=False)
    stuck = Story.objects.filter(processing=True, created_at__lte=now - STUCK_AFTER)
    count = 0
    for story in list(expired.distinct()[:500]) + list(stuck[:100]):
        delete_story_files(story)
        story.delete()
        count += 1
    if count:
        logger.info('%s statut(s) expiré(s) supprimé(s)', count)
    return count


def maybe_purge():
    """Ménage déclenché par l'activité (au plus toutes les 10 min), en arrière-plan."""
    if cache.add('kozons:story-purge', 1, PURGE_EVERY):
        _run_async(purge_expired)
