from django.core.management.base import BaseCommand

from social.storymedia import purge_expired


class Command(BaseCommand):
    help = "Supprime les statuts expirés (fichiers et lignes), sauf ceux signalés et pas encore traités."

    def handle(self, *args, **options):
        total = 0
        while True:   # par lots de 500
            n = purge_expired()
            total += n
            if n < 500:
                break
        self.stdout.write(self.style.SUCCESS(f'{total} statut(s) supprimé(s).'))
