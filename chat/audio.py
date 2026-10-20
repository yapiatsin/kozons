"""Messages vocaux : conversion en un format lisible partout, forme d'onde et durée exacte.

Android (Chrome, Firefox) enregistre en WebM/Opus, que beaucoup d'iPhone ne savent pas lire :
le destinataire appuyait sur lecture et n'entendait rien. Chaque vocal est donc converti avec
ffmpeg en AAC mono 32 kbit/s (.m4a) : lisible par tous les navigateurs, ~240 Ko par minute,
démarrage immédiat (« faststart »). Sans ffmpeg (développement), le fichier est gardé tel quel.
"""
import array
import logging
import os
import re
import shutil
import subprocess
import tempfile

from django.conf import settings
from django.core.files.base import ContentFile

logger = logging.getLogger(__name__)

BARS = 48
LEVELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'   # 32 niveaux, un caractère par barre
WAVEFORM_RE = re.compile(f'^[{LEVELS}]{{1,64}}$')
PCM_RATE = 8000                              # échantillonnage pour la forme d'onde


def ffmpeg():
    return getattr(settings, 'FFMPEG_PATH', '') or shutil.which('ffmpeg')


def clean_waveform(value):
    """Forme d'onde envoyée par le navigateur : acceptée si elle est bien formée."""
    value = (value or '').strip()
    return value if WAVEFORM_RE.match(value) else ''


def waveform_from_pcm(pcm):
    """Échantillons 16 bits → BARS niveaux (pic par tranche, normalisé, racine pour la lisibilité)."""
    samples = array.array('h')
    samples.frombytes(pcm[:len(pcm) - len(pcm) % 2])
    n = len(samples)
    if not n:
        return ''
    step = max(1, n // BARS)
    peaks = []
    for i in range(BARS):
        chunk = samples[i * step:(i + 1) * step] if i < BARS - 1 else samples[i * step:]
        peaks.append(max((abs(x) for x in chunk), default=0))
    top = max(peaks) or 1
    return ''.join(LEVELS[min(31, int(((p / top) ** 0.6) * 31))] for p in peaks)


def convert_voice(upload):
    """Convertit un vocal. Retourne (ContentFile .m4a, forme d'onde, durée en s) ou None si impossible."""
    exe = ffmpeg()
    if not exe:
        return None
    src = None
    try:
        with tempfile.NamedTemporaryFile(suffix=os.path.splitext(upload.name or '')[1] or '.bin', delete=False) as f:
            src = f.name
            for chunk in upload.chunks():
                f.write(chunk)
        out = src + '.m4a'
        # Une seule passe : le fichier AAC + le son brut 8 kHz (sur la sortie standard) pour la forme d'onde.
        proc = subprocess.run(
            [exe, '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
             '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', out,
             '-map', '0:a:0', '-vn', '-ac', '1', '-ar', str(PCM_RATE), '-f', 's16le', 'pipe:1'],
            capture_output=True, timeout=120)
        if proc.returncode != 0 or not os.path.exists(out) or not os.path.getsize(out):
            logger.warning('Conversion du vocal impossible : %s', proc.stderr.decode(errors='replace')[:300])
            return None
        with open(out, 'rb') as f:
            data = f.read()
        os.remove(out)
        pcm = proc.stdout
        duration = round(len(pcm) / 2 / PCM_RATE, 1)
        name = os.path.splitext(os.path.basename(upload.name or 'vocal'))[0][:60] + '.m4a'
        return ContentFile(data, name=name), waveform_from_pcm(pcm), duration
    except (OSError, subprocess.SubprocessError):
        logger.exception('Conversion du vocal')
        return None
    finally:
        if src and os.path.exists(src):
            os.remove(src)
