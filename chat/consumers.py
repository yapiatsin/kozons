"""Connexion WebSocket unique par appareil : messages, présence, saisie, appels."""
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

from . import services as svc
from .models import Call, Participant
from .realtime import push, user_group
from .serializers import call_data


class KozonsConsumer(LiveConsumerMixin, AsyncJsonWebsocketConsumer):
    async def connect(self):
        user = self.scope.get('user')
        if user is None or not user.is_authenticated:
            await self.close(code=4401)
            return
        self.user = user
        self.conv_ids = set()
        self._live_init()
        # Session expirée pour inactivité : pas de temps réel (le client se déconnecte).
        if not await database_sync_to_async(self._session_alive)():
            self.user = None
            await self.close(code=4401)
            return
        await self.channel_layer.group_add(user_group(user.pk), self.channel_name)
        await self.accept()
        await database_sync_to_async(self._on_connect)()

    async def disconnect(self, code):
        if getattr(self, 'user', None) is None:
            return
        await self.channel_layer.group_discard(user_group(self.user.pk), self.channel_name)
        await database_sync_to_async(self._on_disconnect)()

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
        if handler is None:
            return
        try:
            result = await database_sync_to_async(handler)(content)
        except Exception as exc:  # une erreur ne doit jamais couper la connexion
            await self.send_json({'type': 'error', 'data': {'message': str(exc), 'for': kind}})
            return
        if result is not None:
            await self.send_json(result)

    # ------------------------------------------------------------ présence

    def _presence_audience(self):
        user = User.objects.get(pk=self.user.pk)
        if user.last_seen_visibility == 'nobody':
            return user, []
        return user, list(contact_ids(user) - {user.pk})

    def _session_alive(self):
        session = self.scope.get('session')
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
        recent = timezone.now() - timedelta(seconds=45)
        for call in Call.objects.filter(callee=user, status='ringing', started_at__gte=recent).select_related('caller', 'callee'):
            push([user.pk], 'call.incoming', {'call': call_data(call)})

    def _on_disconnect(self):
        self._live_disconnect()
        was_online, online, remaining = presence.unregister(self.user.pk, self.channel_name)
        if was_online and not online:
            self._broadcast_presence(False)
        if not remaining:
            # Plus aucun appareil connecté : on raccroche les appels en cours.
            for call in Call.objects.filter(Q(caller=self.user) | Q(callee=self.user), status__in=('ringing', 'ongoing')).select_related('caller'):
                self._finish_call(call, 'missed' if call.status == 'ringing' else 'ended')

    def _ping(self, content):
        # Le ping (toutes les 25 s) indique aussi si l'utilisateur est actif sur la plateforme.
        active = content.get('active')
        self._set_presence(None if active is None else bool(active))
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
        callee = User.objects.filter(pk=int(content.get('to') or 0), is_active=True).first()
        if callee is None or callee.pk == self.user.pk:
            raise ValueError('Destinataire invalide.')
        if Block.between(self.user, callee):
            raise ValueError("Impossible d'appeler ce contact.")
        caller = User.objects.get(pk=self.user.pk)
        call = Call.objects.create(caller=caller, callee=callee, video=bool(content.get('video')))
        busy = Call.objects.filter(Q(caller=callee) | Q(callee=callee), status='ongoing').exclude(pk=call.pk).exists()
        if busy:
            call.status = 'busy'
            call.ended_at = timezone.now()
            call.save()
            return {'type': 'call.ended', 'data': {'call': call_data(call), 'reason': 'busy'}}
        push([callee.pk], 'call.incoming', {'call': call_data(call)})
        # Application fermée : notification push (sonnerie) sur ses appareils.
        send_to_users([callee.pk], {
            'kind': 'call',
            'title': caller.name,
            'body': 'Appel vidéo entrant…' if call.video else 'Appel audio entrant…',
            'icon': caller.avatar.url if caller.avatar else None,
            'url': '/calls',
            'tag': f'call-{call.pk}',
        }, ttl=TTL_CALL, urgency='high', topic=f'call-{call.pk}')
        # Le client de l'appelant raccroche (appel manqué) après 45 s sans réponse.
        return {'type': 'call.created', 'data': {'call': call_data(call), 'callee_online': presence.is_connected(callee.pk)}}

    def _call_accept(self, content):
        call = self._call_for_me(content)
        if call.callee_id != self.user.pk or call.status != 'ringing':
            raise ValueError("Cet appel n'est plus disponible.")
        call.status = 'ongoing'
        call.answered_at = timezone.now()
        call.save()
        push([call.caller_id], 'call.accepted', {'call': call_data(call)})
        # Arrête la sonnerie sur les autres appareils du destinataire.
        push([call.callee_id], 'call.handled', {'call_id': call.pk, 'channel': self.channel_name})
        return None

    def _call_decline(self, content):
        call = self._call_for_me(content)
        if call.status == 'ringing':
            self._finish_call(call, 'declined')
        return None

    def _call_end(self, content):
        call = self._call_for_me(content)
        if call.status in ('ringing', 'ongoing'):
            self._finish_call(call, 'missed' if call.status == 'ringing' else 'ended')
        return None

    def _finish_call(self, call, status):
        call.status = status
        call.ended_at = timezone.now()
        if status == 'missed':
            # Remplace la notification « appel entrant » par « appel manqué ».
            send_to_users([call.callee_id], {
                'kind': 'missed_call',
                'title': 'Appel manqué',
                'body': f"{call.caller.name} · {'appel vidéo' if call.video else 'appel audio'}",
                'icon': call.caller.avatar.url if call.caller.avatar else None,
                'url': '/calls',
                'tag': f'call-{call.pk}',
            }, ttl=TTL_SOCIAL, topic=f'call-{call.pk}')
        call.save()
        push([call.caller_id, call.callee_id], 'call.ended', {'call': call_data(call), 'reason': status})

    def _call_signal(self, content):
        call = self._call_for_me(content)
        if call.status not in ('ringing', 'ongoing'):
            return None
        other = call.callee_id if call.caller_id == self.user.pk else call.caller_id
        push([other], 'call.signal', {'call_id': call.pk, 'from': self.user.pk, 'data': content.get('data')})
        return None
