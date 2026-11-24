"""Connexion WebSocket unique par appareil : messages, présence, saisie, appels."""
import asyncio
import logging
import time

from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from datetime import timedelta

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from accounts import presence
from accounts.models import Block, User
from accounts.push import TTL_CALL, TTL_SOCIAL, send_to_users
from accounts.serializers import contact_ids
from live.consumer import LiveConsumerMixin
from meet.consumer import MeetConsumerMixin

from . import services as svc
from .models import Call, Participant
from .realtime import push, user_group
from .serializers import call_data

logger = logging.getLogger(__name__)


# Coupure de la connexion temps réel pendant un appel (réseau mobile qui change, écran verrouillé,
# application en arrière-plan…) : l'audio/vidéo WebRTC continue souvent sans elle. On laisse à
# l'appareil ce délai (secondes, réglage CALL_RECONNECT_GRACE) pour se reconnecter avant de raccrocher.
def call_grace():
    return getattr(settings, 'CALL_RECONNECT_GRACE', 40)
# Au-delà, un appel « en cours » jamais terminé (serveur redémarré…) est considéré comme abandonné.
CALL_MAX_DURATION = timedelta(hours=12)


def ring_timeout():
    """Durée de sonnerie (secondes) avant « appel manqué », décidée par le serveur (réglage CALL_RING_TIMEOUT)."""
    return getattr(settings, 'CALL_RING_TIMEOUT', 45)


def finish_call(call, status):
    """Termine l'appel une seule fois, même si deux fins arrivent en même temps (décroché pendant
    l'expiration, raccrocher des deux côtés…). Renvoie False s'il était déjà terminé."""
    now = timezone.now()
    if not Call.objects.filter(pk=call.pk, status__in=('ringing', 'ongoing')).update(status=status, ended_at=now):
        return False
    call.status, call.ended_at = status, now
    if status == 'missed':
        # Remplace la notification « appel entrant » (même tag) par « appel manqué ». Envoyée même si
        # l'application est ouverte en arrière-plan ; le service worker l'ignore si elle est à l'écran.
        send_to_users([call.callee_id], {
            'kind': 'missed_call',
            'title': 'Appel manqué',
            'body': f"{call.caller.name} · {'appel vidéo' if call.video else 'appel audio'}",
            'icon': call.caller.avatar.url if call.caller.avatar else None,
            'url': '/calls',
            'tag': f'call-{call.pk}',
        }, ttl=TTL_SOCIAL, topic=f'call-{call.pk}', only_offline=False)
    push([call.caller_id, call.callee_id], 'call.ended', {'call': call_data(call), 'reason': status})
    return True


def expire_ringing(call_id):
    """Fin de la sonnerie sans réponse : appel manqué (même si le client de l'appelant ne le dit pas)."""
    call = Call.objects.filter(pk=call_id, status='ringing').select_related('caller', 'callee').first()
    if call:
        finish_call(call, 'missed')


def end_calls_if_gone(user_id):
    """Fin du délai de grâce : l'utilisateur ne s'est reconnecté sur aucun appareil -> on raccroche."""
    if presence.is_connected(user_id):
        return
    for call in Call.objects.filter(Q(caller_id=user_id) | Q(callee_id=user_id), status__in=('ringing', 'ongoing')).select_related('caller'):
        finish_call(call, 'missed' if call.status == 'ringing' else 'ended')


# Depuis quand un utilisateur n'a plus aucun appareil connecté (en mémoire, comme la présence).
_gone_since = {}


def _absent_too_long(user_id):
    if presence.is_connected(user_id):
        return False
    since = _gone_since.get(user_id)
    # Inconnu : le serveur a redémarré depuis, l'appel ne peut plus être réel.
    return since is None or time.monotonic() - since > call_grace()


def is_stale(call):
    """Appel « en cours » fantôme : un participant absent au-delà du délai de grâce, ou durée irréaliste."""
    started = call.answered_at or call.started_at
    if started and timezone.now() - started > CALL_MAX_DURATION:
        return True
    return _absent_too_long(call.caller_id) or _absent_too_long(call.callee_id)


async def _expire_ring_later(call_id, delay):
    await asyncio.sleep(delay)
    try:
        await database_sync_to_async(expire_ringing)(call_id)
    except Exception:
        logger.exception('Fin de sonnerie de l\'appel %s', call_id)


async def _end_calls_later(user_id, delay):
    await asyncio.sleep(delay)
    try:
        await database_sync_to_async(end_calls_if_gone)(user_id)
    except Exception:  # la tâche tourne seule : une erreur ne doit rien casser
        import logging
        logging.getLogger(__name__).exception('Fin des appels après déconnexion')


class KozonsConsumer(LiveConsumerMixin, MeetConsumerMixin, AsyncJsonWebsocketConsumer):
    async def connect(self):
        user = self.scope.get('user')
        if user is None or not user.is_authenticated:
            await self.close(code=4401)
            return
        self.user = user
        self.conv_ids = set()
        self._live_init()
        self._meet_init()
        # Session expirée pour inactivité : pas de temps réel (le client se déconnecte).
        if not await database_sync_to_async(self._session_alive)():
            self.user = None
            await self.close(code=4401)
            return
        await self.channel_layer.group_add(user_group(user.pk), self.channel_name)
        _gone_since.pop(user.pk, None)
        await self.accept()
        await database_sync_to_async(self._on_connect)()

    async def disconnect(self, code):
        if getattr(self, 'user', None) is None:
            return
        await self.channel_layer.group_discard(user_group(self.user.pk), self.channel_name)
        last_device = await database_sync_to_async(self._on_disconnect)()
        if last_device:
            _gone_since[self.user.pk] = time.monotonic()
            # Plus aucun appareil connecté : on attend une éventuelle reconnexion avant de raccrocher.
            if call_grace() <= 0:
                await database_sync_to_async(end_calls_if_gone)(self.user.pk)
            else:
                asyncio.ensure_future(_end_calls_later(self.user.pk, call_grace()))

    async def deliver(self, event):
        await self.send_json({'type': event['event'], 'data': event['data']})

    async def receive_json(self, content, **kwargs):
        kind = content.get('type')
        handler = {
            'ping': self._ping,
            'presence': self._presence,
            'typing': self._typing,
            'delivered': self._delivered,
            'call.start': self._call_start,
            'call.accept': self._call_accept,
            'call.decline': self._call_decline,
            'call.end': self._call_end,
            'call.signal': self._call_signal,
        }.get(kind)
        if handler is None and kind in self.LIVE_HANDLERS:
            handler = getattr(self, self.LIVE_HANDLERS[kind])
        if handler is None and kind in self.MEET_HANDLERS:
            handler = getattr(self, self.MEET_HANDLERS[kind])
        if handler is None:
            return
        try:
            result = await database_sync_to_async(handler)(content)
        except Exception as exc:  # une erreur ne doit jamais couper la connexion
            error = {'message': str(exc), 'for': kind}
            if getattr(exc, 'code', None):
                error['code'] = exc.code
            await self.send_json({'type': 'error', 'data': error})
            return
        if result is not None:
            await self.send_json(result)
            if kind == 'call.start' and result.get('type') == 'call.created':
                # Sonnerie limitée côté serveur : l'appel devient « manqué » même si l'appelant a fermé l'application.
                asyncio.ensure_future(_expire_ring_later(result['data']['call']['id'], ring_timeout()))

    # ------------------------------------------------------------ présence

    def _presence_audience(self):
        user = User.objects.get(pk=self.user.pk)
        if user.last_seen_visibility == 'nobody':
            return user, []
        return user, list(contact_ids(user) - {user.pk})

    def _session_alive(self):
        if self.scope.get('auth_token') is not None:
            return True  # application mobile (jeton) : pas d'expiration pour inactivité
        session = self.scope.get('session')
        if session is not None and session.get('kz_remember'):
            return True  # « Se souvenir de moi » : pas d'expiration pour inactivité
        last = session.get('kz_last_active') if session is not None else None
        return last is None or timezone.now().timestamp() - last <= settings.IDLE_LOGOUT_MINUTES * 60

    def _broadcast_presence(self, online):
        now = timezone.now()
        if not online:
            User.objects.filter(pk=self.user.pk).update(last_seen=now)
        user, audience = self._presence_audience()
        push(audience, 'presence', {'user_id': user.pk, 'online': online, 'last_seen': (user.last_seen or now).isoformat()})

    def _on_connect(self):
        # Connecté ≠ en ligne : l'appareil ne devient « en ligne » qu'une fois actif (message presence).
        presence.register(self.user.pk, self.channel_name)
        self.conv_ids = set(Participant.objects.filter(user=self.user).values_list('conversation_id', flat=True))
        user = User.objects.get(pk=self.user.pk)
        svc.mark_all_delivered(user)
        # Ouverture de l'application depuis une notification d'appel : l'appel sonne encore ?
        # Uniquement à CET appareil : les autres sonnent déjà (un doublon leur ferait refuser l'appel).
        recent = timezone.now() - timedelta(seconds=ring_timeout())
        for call in Call.objects.filter(callee=user, status='ringing', started_at__gte=recent).select_related('caller', 'callee'):
            self._to_me('call.incoming', {'call': call_data(call)})
        # Reconnexion pendant un appel : on renvoie à cet appareil ce qu'il a pu manquer pendant la coupure.
        mine = Q(caller=user) | Q(callee=user)
        for call in Call.objects.filter(mine, status='ongoing', caller=user).select_related('caller', 'callee'):
            self._to_me('call.accepted', {'call': call_data(call), 'resync': True})
        for call in Call.objects.filter(mine, ended_at__gte=timezone.now() - timedelta(minutes=2)).exclude(status__in=('ringing', 'ongoing')).select_related('caller', 'callee'):
            self._to_me('call.ended', {'call': call_data(call), 'reason': call.status, 'resync': True})

    def _to_me(self, event, data):
        async_to_sync(self.channel_layer.send)(self.channel_name, {'type': 'deliver', 'event': event, 'data': data})

    def _on_disconnect(self):
        # Chaque nettoyage est isolé : une erreur dans un live ne doit pas laisser un fantôme en réunion.
        for cleanup in (self._live_disconnect, self._meet_disconnect):
            try:
                cleanup()
            except Exception:
                logger.exception('Nettoyage à la déconnexion (%s)', cleanup.__name__)
        was_online, online, remaining = presence.unregister(self.user.pk, self.channel_name)
        if was_online and not online:
            self._broadcast_presence(False)
        # Plus aucun appareil connecté : les appels seront raccrochés après le délai de grâce.
        return not remaining

    def _ping(self, content):
        # Le ping (toutes les 25 s) indique aussi si l'utilisateur est actif sur la plateforme.
        active = content.get('active')
        self._set_presence(None if active is None else bool(active))
        self._meet_heartbeat()
        return {'type': 'pong', 'data': {'t': content.get('t')}}

    def _presence(self, content):
        """Changement immédiat : onglet visible et actif / masqué ou inactif."""
        self._set_presence(bool(content.get('active')))
        return None

    def _set_presence(self, active):
        was_online, online = presence.update(self.user.pk, self.channel_name, active)
        if was_online != online:
            self._broadcast_presence(online)

    # ------------------------------------------------------------ discussions

    def _member(self, conversation_id):
        if conversation_id not in self.conv_ids:
            if not Participant.objects.filter(user=self.user, conversation_id=conversation_id).exists():
                return False
            self.conv_ids.add(conversation_id)
        return True

    def _typing(self, content):
        cid = int(content.get('conversation_id') or 0)
        if not self._member(cid):
            return None
        state = content.get('state') if content.get('state') in ('typing', 'recording', 'stop') else 'stop'
        others = Participant.objects.filter(conversation_id=cid).exclude(user=self.user).values_list('user_id', flat=True)
        push(others, 'typing', {'conversation_id': cid, 'user_id': self.user.pk, 'name': self.user.name, 'state': state})
        return None

    def _delivered(self, content):
        cid = int(content.get('conversation_id') or 0)
        if self._member(cid):
            svc.mark_delivered(self.user, cid, int(content.get('message_id') or 0))
        return None

    # ------------------------------------------------------------ appels (signalisation WebRTC)

    def _call_for_me(self, content):
        call = Call.objects.select_related('caller', 'callee').filter(pk=int(content.get('call_id') or 0)).first()
        if call is None or self.user.pk not in (call.caller_id, call.callee_id):
            raise ValueError('Appel introuvable.')
        return call

    def _call_start(self, content):
        # `ref` : identifiant choisi par le client, renvoyé tel quel pour qu'il reconnaisse SA demande
        # (et ignore les événements d'un appel précédent arrivés en retard).
        ref = str(content.get('ref') or '')[:40]
        callee = User.objects.filter(pk=int(content.get('to') or 0), is_active=True).first()
        if callee is None or callee.pk == self.user.pk:
            raise ValueError('Destinataire invalide.')
        if Block.between(self.user, callee):
            raise ValueError("Impossible d'appeler ce contact.")
        caller = User.objects.get(pk=self.user.pk)
        # Sonneries restées sans suite : l'appel précédent de l'appelant (il rappelle) et les
        # sonneries trop anciennes (serveur redémarré, application fermée) deviennent « manqués ».
        too_old = timezone.now() - timedelta(seconds=ring_timeout())
        involved = Q(caller=caller) | Q(callee=caller) | Q(caller=callee) | Q(callee=callee)
        for old in Call.objects.filter(involved, status='ringing').select_related('caller', 'callee'):
            if old.caller_id == caller.pk or old.started_at < too_old:
                finish_call(old, 'missed')
        call = Call.objects.create(caller=caller, callee=callee, video=bool(content.get('video')))
        busy = False
        for other in Call.objects.filter(Q(caller=callee) | Q(callee=callee), status='ongoing').exclude(pk=call.pk).select_related('caller'):
            if is_stale(other):
                finish_call(other, 'ended')  # appel fantôme : ne bloque plus les nouveaux appels
            else:
                busy = True
        if busy:
            call.status = 'busy'
            call.ended_at = timezone.now()
            call.save()
            return {'type': 'call.ended', 'data': {'call': call_data(call), 'reason': 'busy', 'ref': ref}}
        push([callee.pk], 'call.incoming', {'call': call_data(call)})
        # Notification push (sonnerie) sur ses appareils : application fermée, en arrière-plan ou
        # téléphone verrouillé. Le service worker ne l'affiche pas si Kozons est déjà à l'écran.
        send_to_users([callee.pk], {
            'kind': 'call',
            'title': caller.name,
            'body': 'Appel vidéo entrant…' if call.video else 'Appel audio entrant…',
            'icon': caller.avatar.url if caller.avatar else None,
            'url': '/calls',
            'tag': f'call-{call.pk}',
        }, ttl=TTL_CALL, urgency='high', topic=f'call-{call.pk}', only_offline=False)
        # Sans réponse au bout de ring_timeout() : appel manqué (voir receive_json).
        return {'type': 'call.created', 'data': {
            'call': call_data(call), 'callee_online': presence.is_connected(callee.pk), 'ref': ref,
            'ring_timeout': ring_timeout(),
        }}

    def _call_accept(self, content):
        call = self._call_for_me(content)
        # Atomique : un décroché au moment exact où la sonnerie expire ne peut pas « réussir » à moitié.
        now = timezone.now()
        if call.callee_id != self.user.pk or not Call.objects.filter(pk=call.pk, status='ringing').update(status='ongoing', answered_at=now):
            raise ValueError("Cet appel n'est plus disponible.")
        call.status, call.answered_at = 'ongoing', now
        push([call.caller_id], 'call.accepted', {'call': call_data(call)})
        # Arrête la sonnerie sur les autres appareils du destinataire.
        push([call.callee_id], 'call.handled', {'call_id': call.pk, 'channel': self.channel_name})
        return None

    def _call_decline(self, content):
        call = self._call_for_me(content)
        if call.status == 'ringing':
            # `busy` : le destinataire est déjà en communication (son application répond pour lui).
            self._finish_call(call, 'busy' if content.get('busy') else 'declined')
        return None

    def _call_end(self, content):
        call = self._call_for_me(content)
        if call.status in ('ringing', 'ongoing'):
            self._finish_call(call, 'missed' if call.status == 'ringing' else 'ended')
        return None

    def _finish_call(self, call, status):
        finish_call(call, status)

    def _call_signal(self, content):
        call = self._call_for_me(content)
        if call.status not in ('ringing', 'ongoing'):
            return None
        other = call.callee_id if call.caller_id == self.user.pk else call.caller_id
        push([other], 'call.signal', {'call_id': call.pk, 'from': self.user.pk, 'data': content.get('data')})
        return None
