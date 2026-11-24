"""Convertit les anciens messages vocaux (WebM / Ogg) en AAC lisible sur tous les téléphones,
et calcule leur forme d'onde. À lancer une fois après la mise à jour : sans risque à relancer."""
from django.core.files.base import File
from django.core.management.base import BaseCommand

from chat.audio import convert_voice, ffmpeg
from chat.models import Message


class Command(BaseCommand):
    help = 'Convertit les messages vocaux existants en AAC (.m4a) et calcule leur forme d’onde.'

    def handle(self, *args, **options):
        if not ffmpeg():
            self.stderr.write('ffmpeg est introuvable : rien à faire.')
            return
        qs = Message.objects.filter(kind='voice', deleted=False).exclude(file='')
        done = failed = 0
        for pk in list(qs.values_list('pk', flat=True)):
            msg = Message.objects.get(pk=pk)  # relu : un transfert déjà converti est ignoré
            if msg.file.name.endswith('.m4a') and msg.waveform:
                continue
            try:
                with msg.file.open('rb') as f:
                    converted = convert_voice(File(f, name=msg.file.name))
            except FileNotFoundError:
                failed += 1
                continue
            if not converted:
                failed += 1
                continue
            content, waveform, secs = converted
            old = msg.file.name
            msg.file.save(content.name, content, save=False)
            # Les vocaux transférés partagent le même fichier : tous pointent vers la version convertie.
            Message.objects.filter(file=old).update(
                file=msg.file.name, file_name=content.name, file_size=content.size,
                waveform=waveform or msg.waveform, duration=secs or msg.duration)
            if old != msg.file.name:
                msg.file.storage.delete(old)
            done += 1
        self.stdout.write(f'{done} vocal(aux) converti(s), {failed} impossible(s).')
