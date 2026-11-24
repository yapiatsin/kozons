"""Vérifie la conversion des vidéos de statut sur ce serveur, sans rien publier.

Génère avec ffmpeg une vidéo de test de 100 s en 1080×1920 à 60 i/s (comme un téléphone),
la convertit avec les réglages des statuts, puis affiche résolution, durée, images/s et taille.
"""
import json
import os
import subprocess
import tempfile

from django.core.management.base import BaseCommand, CommandError

from social import storymedia


class Command(BaseCommand):
    help = 'Teste la conversion des vidéos de statut (MP4 H.264 720p, 90 s max) avec une vidéo générée.'

    def handle(self, *args, **options):
        exe, probe = storymedia.ffmpeg(), storymedia.ffprobe()
        if not exe or not probe:
            raise CommandError('ffmpeg / ffprobe introuvables sur ce serveur.')
        with tempfile.TemporaryDirectory() as tmp:
            src, out, poster = (os.path.join(tmp, n) for n in ('source.mp4', 'statut.mp4', 'statut.jpg'))
            self.stdout.write('Génération d’une vidéo de test (100 s, 1080×1920, 60 i/s)…')
            subprocess.run([exe, '-hide_banner', '-loglevel', 'error', '-y',
                            '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440',
                            '-t', '100', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '12M', '-c:a', 'aac', src],
                           check=True, timeout=600)
            self.stdout.write('Conversion avec les réglages des statuts…')
            if not storymedia.transcode(src, out, poster):
                raise CommandError('La conversion a échoué (voir les logs).')
            info = json.loads(subprocess.run(
                [probe, '-v', 'error', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate:format=duration,size',
                 '-of', 'json', out], capture_output=True, check=True).stdout)
            video = next(s for s in info['streams'] if s.get('width'))
            audio = [s['codec_name'] for s in info['streams'] if not s.get('width')]
            num, den = (int(x) for x in video['avg_frame_rate'].split('/'))
            self.stdout.write(self.style.SUCCESS(
                f"OK : {video['codec_name']} {video['width']}×{video['height']}, {num / max(den, 1):.0f} i/s, "
                f"son {', '.join(audio) or 'aucun'}, {float(info['format']['duration']):.1f} s, "
                f"{os.path.getsize(src) / 1048576:.1f} Mo → {int(info['format']['size']) / 1048576:.1f} Mo, "
                f"miniature {'oui' if os.path.exists(poster) and os.path.getsize(poster) else 'non'}"))
