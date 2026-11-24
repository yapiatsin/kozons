import base64

from cryptography.hazmat.primitives import serialization
from django.core.management.base import BaseCommand
from py_vapid import Vapid01


class Command(BaseCommand):
    help = 'Génère une paire de clés VAPID pour les notifications push (à copier dans .env).'

    def handle(self, *args, **options):
        vapid = Vapid01()
        vapid.generate_keys()
        b64 = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b'=').decode()
        private = b64(vapid.private_key.private_numbers().private_value.to_bytes(32, 'big'))
        public = b64(vapid.public_key.public_bytes(serialization.Encoding.X962,
                                                   serialization.PublicFormat.UncompressedPoint))
        self.stdout.write(f'VAPID_PUBLIC_KEY={public}\nVAPID_PRIVATE_KEY={private}')
