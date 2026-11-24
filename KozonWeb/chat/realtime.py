"""Diffusion d'événements temps réel vers les connexions WebSocket des utilisateurs."""
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction


def user_group(user_id):
    return f'user_{user_id}'


def push(user_ids, event_type, data):
    """Envoie un événement à tous les appareils connectés des utilisateurs donnés,
    une fois la transaction en cours validée (jamais de données fantômes)."""
    user_ids = list({int(u) for u in user_ids})
    if not user_ids:
        return

    def send():
        layer = get_channel_layer()
        if layer is None:
            return
        payload = {'type': 'deliver', 'event': event_type, 'data': data}
        for uid in user_ids:
            async_to_sync(layer.group_send)(user_group(uid), payload)

    transaction.on_commit(send)
