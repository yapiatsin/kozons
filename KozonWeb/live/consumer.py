"""Temps réel des lives, greffé sur la connexion WebSocket unique (chat.consumers.KozonsConsumer).

Toutes ces méthodes sont synchrones : le consumer les exécute dans un thread
(database_sync_to_async), d'où l'usage d'async_to_sync pour le channel layer.
"""
import time

from asgiref.sync import async_to_sync
from django.conf import settings
from django.db.models import F
from django.utils import timezone

from accounts.models import User
from accounts.serializers import user_brief

from . import registry, services as svc
from .models import GIFTS, LiveBan, LiveComment, LiveGift, LiveStream, LiveViewer

COMMENT_INTERVAL = 1.0   # secondes minimum entre deux commentaires d'un même appareil
GIFT_INTERVAL = 0.3


class LiveConsumerMixin:
    LIVE_HANDLERS = {
        'live.host': '_live_host', 'live.join': '_live_join', 'live.leave': '_live_leave',
        'live.comment': '_live_comment', 'live.like': '_live_like', 'live.gift': '_live_gift',
        'live.pin': '_live_pin', 'live.ban': '_live_ban', 'live.heartbeat': '_live_heartbeat',
        'live.end': '_live_end', 'live.signal': '_live_signal',
    }

    def _live_init(self):
        self.live_joined = set()
        self.live_hosting = None
        self._live_last = {}

    # ------------------------------------------------------------ outils

    def _get_live(self, content, host=False):
        live = LiveStream.objects.select_related('host').filter(pk=int(content.get('live_id') or 0)).first()
        if live is None:
            raise ValueError('Live introuvable.')
        if host and live.host_id != self.user.pk:
            raise ValueError("Seul l'animateur peut faire cela.")
        return live

    def _group_add(self, live_id):
        async_to_sync(self.channel_layer.group_add)(svc.group(live_id), self.channel_name)

    def _group_discard(self, live_id, channel=None):
        async_to_sync(self.channel_layer.group_discard)(svc.group(live_id), channel or self.channel_name)

    def _throttle(self, key, interval):
        now = time.monotonic()
        if now - self._live_last.get(key, 0) < interval:
            return True
        self._live_last[key] = now
        return False

    def _in_live(self, live):
        return live.pk in self.live_joined or self.live_hosting == live.pk

    def _broadcast_viewers(self, live_id):
        count = registry.count(live_id)
        top = [user_brief(u) for u in User.objects.filter(pk__in=registry.viewer_ids(live_id)[:3])]
        svc.broadcast(live_id, 'live.viewers', {'live_id': live_id, 'count': count, 'top': top})
        return count

    # ------------------------------------------------------------ animateur

    def _live_host(self, content):
        live = self._get_live(content, host=True)
        if not live.is_live:
            return {'type': 'live.ended', 'data': {'live_id': live.pk, 'reason': 'ended', 'summary': svc.summary(live)}}
        registry.set_host(live.pk, self.channel_name)
        self.live_hosting = live.pk
        self._group_add(live.pk)
        LiveStream.objects.filter(pk=live.pk).update(host_seen_at=timezone.now())
        svc.broadcast(live.pk, 'live.host_back', {'live_id': live.pk})
        # Mode pair-à-pair : l'animateur (re)crée une connexion vers chaque spectateur présent.
        peers = registry.channels_of(live.pk) if svc.media_mode() == 'p2p' else []
        return {'type': 'live.hosting', 'data': {'live_id': live.pk, 'viewers': registry.count(live.pk), 'peers': peers}}

    def _live_heartbeat(self, content):
        live = self._get_live(content, host=True)
        if live.is_live:
            LiveStream.objects.filter(pk=live.pk).update(host_seen_at=timezone.now())
        return None

    def _live_end(self, content):
        live = self._get_live(content, host=True)
        svc.end_live(live)
        self.live_hosting = None
        return None

    def _live_pin(self, content):
        live = self._get_live(content, host=True)
        comment = LiveComment.objects.select_related('user', 'reply_to__user').filter(pk=content.get('comment_id') or 0, live=live).first()
        LiveStream.objects.filter(pk=live.pk).update(pinned_comment=comment)
        svc.broadcast(live.pk, 'live.pinned', {'live_id': live.pk, 'comment': svc.comment_data(comment) if comment else None})
        return None

    def _live_ban(self, content):
        live = self._get_live(content, host=True)
        target = User.objects.filter(pk=int(content.get('user_id') or 0)).first()
        if target is None or target.pk == self.user.pk:
            raise ValueError('Spectateur introuvable.')
        LiveBan.objects.get_or_create(live=live, user=target)
        for channel in registry.channels_of(live.pk, target.pk):
            registry.leave(live.pk, channel)
            self._group_discard(live.pk, channel)
            svc.send_to_channel(channel, 'live.kicked', {'live_id': live.pk})
        svc.broadcast(live.pk, 'live.event', {'live_id': live.pk, 'kind': 'ban', 'user': user_brief(target)})
        self._broadcast_viewers(live.pk)
        return None

    # ------------------------------------------------------------ spectateurs

    def _live_join(self, content):
        live = self._get_live(content)
        if not live.is_live:
            return {'type': 'live.ended', 'data': {'live_id': live.pk, 'reason': 'ended', 'summary': svc.summary(live)}}
        if not svc.can_view(self.user, live):
            raise ValueError('Ce live est réservé aux abonnés.')
        if live.bans.filter(user=self.user).exists():
            raise ValueError("L'animateur vous a exclu de ce live.")
        if live.host_id == self.user.pk:
            return self._live_host(content)
        if svc.media_mode() == 'p2p' and registry.count(live.pk) >= settings.LIVE_P2P_MAX_VIEWERS \
                and not registry.is_viewer_channel(live.pk, self.channel_name):
            raise ValueError('Ce live est complet pour le moment.')
        self._group_add(live.pk)
        count = registry.join(live.pk, self.channel_name, self.user.pk)
        self.live_joined.add(live.pk)
        _, created = LiveViewer.objects.get_or_create(live=live, user_id=self.user.pk)
        if created:
            LiveStream.objects.filter(pk=live.pk).update(total_viewers=F('total_viewers') + 1)
        LiveStream.objects.filter(pk=live.pk, peak_viewers__lt=count).update(peak_viewers=count)
        user = User.objects.get(pk=self.user.pk)
        svc.broadcast(live.pk, 'live.event', {'live_id': live.pk, 'kind': 'join', 'user': user_brief(user)})
        self._broadcast_viewers(live.pk)
        if svc.media_mode() == 'p2p':
            # L'animateur ouvre une connexion vidéo vers ce nouveau spectateur.
            svc.send_to_channel(registry.host_channel(live.pk), 'live.peer', {'live_id': live.pk, 'peer': self.channel_name})
        return {'type': 'live.joined', 'data': {'live_id': live.pk, 'viewers': count}}

    def _live_leave(self, content):
        live_id = int(content.get('live_id') or 0)
        self._leave(live_id)
        return None

    def _leave(self, live_id):
        if live_id in self.live_joined:
            self.live_joined.discard(live_id)
            registry.leave(live_id, self.channel_name)
            self._group_discard(live_id)
            svc.send_to_channel(registry.host_channel(live_id), 'live.peer_left', {'live_id': live_id, 'peer': self.channel_name})
            self._broadcast_viewers(live_id)

    def _live_disconnect(self):
        for live_id in list(getattr(self, 'live_joined', ())):
            self._leave(live_id)
        hosting = getattr(self, 'live_hosting', None)
        if hosting and registry.host_channel(hosting) == self.channel_name:
            # Coupure réseau de l'animateur : le live attend son retour (fin auto après 45 s).
            registry.set_host(hosting, None)
            svc.broadcast(hosting, 'live.host_away', {'live_id': hosting})

    def _live_comment(self, content):
        live = self._get_live(content)
        if not live.is_live or not self._in_live(live):
            raise ValueError("Rejoignez le live pour commenter.")
        if live.bans.filter(user=self.user).exists():
            raise ValueError("L'animateur vous a exclu de ce live.")
        text = ' '.join((content.get('text') or '').split())[:150]
        if not text:
            return None
        if self._throttle(('comment', live.pk), COMMENT_INTERVAL):
            raise ValueError('Doucement ! Attendez un instant avant de recommenter.')
        reply_to = LiveComment.objects.filter(pk=int(content.get('reply_to') or 0), live=live).first()
        comment = LiveComment.objects.create(live=live, user_id=self.user.pk, text=text, reply_to=reply_to)
        LiveStream.objects.filter(pk=live.pk).update(comments_count=F('comments_count') + 1)
        comment = LiveComment.objects.select_related('user', 'reply_to__user').get(pk=comment.pk)
        svc.broadcast(live.pk, 'live.comment', {'live_id': live.pk, **svc.comment_data(comment)})
        return None

    def _live_like(self, content):
        live = self._get_live(content)
        if not live.is_live or not self._in_live(live):
            return None
        n = max(1, min(int(content.get('count') or 1), 30))  # les tapotements sont regroupés côté client
        LiveStream.objects.filter(pk=live.pk).update(likes_count=F('likes_count') + n)
        total = LiveStream.objects.filter(pk=live.pk).values_list('likes_count', flat=True).first()
        svc.broadcast(live.pk, 'live.likes', {'live_id': live.pk, 'total': total, 'n': n, 'user_id': self.user.pk})
        return None

    def _live_gift(self, content):
        live = self._get_live(content)
        code = content.get('gift')
        if code not in GIFTS:
            raise ValueError('Cadeau inconnu.')
        if not live.is_live or live.pk not in self.live_joined:
            raise ValueError('Rejoignez le live pour envoyer un cadeau.')
        if self._throttle(('gift', live.pk), GIFT_INTERVAL):
            return None
        LiveGift.objects.create(live=live, sender_id=self.user.pk, gift=code)
        LiveStream.objects.filter(pk=live.pk).update(gifts_count=F('gifts_count') + 1,
                                                     gifts_value=F('gifts_value') + GIFTS[code]['value'])
        user = User.objects.get(pk=self.user.pk)
        svc.broadcast(live.pk, 'live.gift', {'live_id': live.pk, 'user': user_brief(user), 'gift': {'code': code, **GIFTS[code]}})
        return None

    # ------------------------------------------------------------ vidéo pair-à-pair (sans serveur média)

    def _live_signal(self, content):
        live_id = int(content.get('live_id') or 0)
        target = content.get('to') or ''
        host_channel = registry.host_channel(live_id)
        is_host = self.live_hosting == live_id and host_channel == self.channel_name
        allowed = (is_host and registry.is_viewer_channel(live_id, target)) or \
                  (live_id in self.live_joined and target == host_channel)
        if not allowed:
            return None
        svc.send_to_channel(target, 'live.signal', {'live_id': live_id, 'from': self.channel_name, 'data': content.get('data')})
        return None
