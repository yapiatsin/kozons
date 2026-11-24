"""Notes vidéo (vidéos rondes des discussions, façon WhatsApp) : conversion en un format lisible partout.

Le navigateur enregistre en WebM (Android, ordinateur) ou MP4 (iPhone) ; beaucoup d'iPhone ne lisent
pas le WebM. Chaque note est donc convertie avec ffmpeg en MP4 H.264 + AAC, image carrée 480 × 480
(la bulle ronde est découpée à l'affichage), 60 s maximum, « faststart » pour une lecture immédiate :
environ 4 à 6 Mo par minute. Sans ffmpeg (développement), le fichier est gardé tel quel.
"""
import logging
import os
import subprocess
import tempfile

from django.core.files.base import ContentFile

from .audio import ffmpeg

logger = logging.getLogger(__name__)

MAX_SECONDS = 60
SIDE = 480


def convert_video_note(upload):
    """Convertit une note vidéo. Retourne un ContentFile .mp4, ou None si la conversion est impossible."""
    exe = ffmpeg()
    if not exe:
        return None
    src = None
    out = None
    try:
        with tempfile.NamedTemporaryFile(suffix=os.path.splitext(upload.name or '')[1] or '.bin', delete=False) as f:
            src = f.name
            for chunk in upload.chunks():
                f.write(chunk)
        out = src + '.mp4'
        # Carré centré (la note est déjà carrée, mais un fichier quelconque doit l'être aussi), 30 images/s max.
        vf = f"crop='min(iw,ih)':'min(iw,ih)',scale={SIDE}:{SIDE},setsar=1,fps=30"
        proc = subprocess.run(
            [exe, '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-t', str(MAX_SECONDS),
             '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf,
             '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-threads', '2',
             '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-ar', '44100', '-movflags', '+faststart', out],
            capture_output=True, timeout=180)
        if proc.returncode != 0 or not os.path.exists(out) or not os.path.getsize(out):
            logger.warning('Conversion de la note vidéo impossible : %s', proc.stderr.decode(errors='replace')[:300])
            return None
        with open(out, 'rb') as f:
            data = f.read()
        name = os.path.splitext(os.path.basename(upload.name or 'note'))[0][:60] + '.mp4'
        return ContentFile(data, name=name)
    except (OSError, subprocess.SubprocessError):
        logger.exception('Conversion de la note vidéo')
        return None
    finally:
        for path in (src, out):
            if path and os.path.exists(path):
                os.remove(path)
