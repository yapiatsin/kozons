"""Notifications push (Web Push / VAPID).

Chrome, Edge et Android passent par le service de Google (FCM), Firefox par Mozilla, Safari par
Apple : on parle à tous avec le même protocole standard. Le service de push conserve la
notification (durée = TTL) tant que l'appareil est hors ligne et la livre dès qu'il retrouve
Internet.
"""
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from django.conf import settings
from django.db import close_old_connections, transaction
from django.utils import timezone

from . import presence

logger = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix='webpush')

TTL_MESSAGE = 28 * 24 * 3600   # maximum accepté par FCM : livré même après des jours hors ligne
TTL_CALL = 45                  # un appel entrant n'a plus de sens après la sonnerie
TTL_SOCIAL = 7 * 24 * 3600


def enabled():
    return bool(settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY)


def send_to_users(user_ids, payload, *, ttl=TTL_MESSAGE, urgency='normal', topic=None, only_offline=True):
    """Envoie `payload` à tous les appareils abonnés des utilisateurs, après validation de la
    transaction. Par défaut, seuls les utilisateurs sans application ouverte sont notifiés
    (ceux qui sont connectés reçoivent déjà l'événement par WebSocket)."""
    if not enabled():
        return
    ids = {int(u) for u in user_ids}
    if not ids:
        return

    def dispatch():
        from .models import PushSubscription
        targets = [u for u in ids if not presence.is_connected(u)] if only_offline else ids
        now = timezone.now()
        stamp = int(now.timestamp() * 1000)
        # Pastille sur l'icône de l'application (comme WhatsApp) : nombre propre à chaque destinataire.
        badges = badge_counts(targets) if payload.get('kind') != 'call' else {}
        # Appareil déconnecté pour inactivité : notification sans contenu (session expirée).
        idle_limit = now - timedelta(minutes=settings.IDLE_LOGOUT_MINUTES)
        subs = PushSubscription.objects.filter(user_id__in=targets).values_list(
            'pk', 'user_id', 'endpoint', 'p256dh', 'auth', 'last_active_at')
        bodies = {}
        for pk, user_id, endpoint, p256dh, auth, last_active in subs:
            locked = last_active is None or last_active < idle_limit
            key = (user_id, locked)
            if key not in bodies:
                data = {**(locked_payload(payload) if locked else payload), 'timestamp': stamp}
                if user_id in badges:
                    data['badge'] = badges[user_id]
                bodies[key] = json.dumps(data)
            _executor.submit(_deliver, pk, endpoint, p256dh, auth, bodies[key], ttl, urgency, topic)

    transaction.on_commit(dispatch)


def badge_counts(user_ids):
    """Nombre affiché sur l'icône de l'application : discussions non lues (hors archivées)
    + notifications non lues. {user_id: n}"""
    from django.db.models import Count, F

    ids = list(user_ids)
    counts = dict.fromkeys(ids, 0)
    try:
        from chat.models import Message, Participant
        now = timezone.now()
        unread = (Message.objects
                  .filter(conversation__participants__user_id__in=ids, conversation__participants__archived=False,
                          id__gt=F('conversation__participants__last_read_id'))
                  .exclude(sender_id=F('conversation__participants__user_id'))
                  .exclude(kind='system').exclude(deleted=True).exclude(expires_at__lte=now)
                  .values('conversation__participants__user_id')
                  .annotate(n=Count('conversation_id', distinct=True)))
        for row in unread:
            counts[row['conversation__participants__user_id']] += row['n']
        marked = (Participant.objects.filter(user_id__in=ids, marked_unread=True, archived=False)
                  .values('user_id').annotate(n=Count('id')))
        for row in marked:
            counts[row['user_id']] += row['n']
        from social.models import Notification
        for row in Notification.objects.filter(recipient_id__in=ids, read=False).values('recipient_id').annotate(n=Count('id')):
            counts[row['recipient_id']] += row['n']
    except Exception:
        logger.exception('Calcul de la pastille de notifications')
    return counts


GENERIC = {
    'message': 'Vous avez reçu un nouveau message.',
    'call': 'Appel entrant…',
    'missed_call': 'Vous avez manqué un appel.',
    'social': 'Vous avez une nouvelle notification.',
}


def locked_payload(payload):
    """Version sans contenu (ni expéditeur, ni texte) pour un appareil dont la session a expiré."""
    kind = payload.get('kind', 'message')
    if kind == 'test':
        return payload
    return {
        'kind': kind,
        'title': 'Kozons',
        'body': GENERIC.get(kind, 'Vous avez une nouvelle notification.') + ' Connectez-vous pour le voir.',
        'url': '/',
        'tag': payload.get('tag'),
    }


def _deliver(sub_id, endpoint, p256dh, auth, body, ttl, urgency, topic):
    from pywebpush import WebPushException, webpush

    from .models import PushSubscription
    headers = {'Urgency': urgency}
    if topic:
        headers['Topic'] = topic[:32]  # remplace une notification non encore livrée du même sujet
    try:
        webpush(
            subscription_info={'endpoint': endpoint, 'keys': {'p256dh': p256dh, 'auth': auth}},
            data=body,
            vapid_private_key=settings.VAPID_PRIVATE_KEY,
            vapid_claims={'sub': settings.VAPID_SUBJECT},
            ttl=ttl,
            headers=headers,
            timeout=10,
        )
        PushSubscription.objects.filter(pk=sub_id).update(last_success_at=timezone.now(), failures=0)
    except WebPushException as e:
        status = getattr(e.response, 'status_code', None)
        if status in (404, 410):
            # Abonnement expiré ou révoqué (application désinstallée, permission retirée…).
            PushSubscription.objects.filter(pk=sub_id).delete()
        else:
            logger.warning('Échec push (%s) vers %s : %s', status, endpoint[:60], e)
            _count_failure(sub_id)
    except Exception:
        logger.exception('Échec push vers %s', endpoint[:60])
        _count_failure(sub_id)
    finally:
        close_old_connections()


def _count_failure(sub_id):
    from django.db.models import F

    from .models import PushSubscription
    PushSubscription.objects.filter(pk=sub_id).update(failures=F('failures') + 1)
    PushSubscription.objects.filter(pk=sub_id, failures__gte=10).delete()
