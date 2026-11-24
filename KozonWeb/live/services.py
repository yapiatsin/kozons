"""Règles des lives : visibilité, sérialisation, jetons du serveur média, fin du live."""
from datetime import timedelta

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone

from accounts.models import Block
from accounts.serializers import user_brief

from . import registry
from .models import GIFTS, LiveComment, LiveStream

HOST_TIMEOUT = timedelta(seconds=45)  # sans signe de l'animateur : le live est considéré terminé
TOKEN_SALT = 'kozons.live-media'
TOKEN_MAX_AGE = 12 * 3600


def group(live_id):
    return f'live_{live_id}'


def broadcast(live_id, event, data):
    """Envoie un événement à tous les participants du live (spectateurs + animateur)."""
    def send():
        layer = get_channel_layer()
        if layer:
            async_to_sync(layer.group_send)(group(live_id), {'type': 'deliver', 'event': event, 'data': data})
    transaction.on_commit(send)


def send_to_channel(channel, event, data):
    layer = get_channel_layer()
    if layer and channel:
        async_to_sync(layer.send)(channel, {'type': 'deliver', 'event': event, 'data': data})


def can_view(user, live):
    if live.host_id == user.pk:
        return True
    if Block.between(user, live.host):
        return False
    if live.audience == 'followers':
        from social.models import Follow
        return Follow.objects.filter(follower=user, following=live.host, accepted=True).exists()
    return True


def expire_stale():
    """Lives dont l'animateur ne donne plus signe de vie (appli fermée, réseau coupé)."""
    for live in LiveStream.objects.filter(status=LiveStream.LIVE, host_seen_at__lt=timezone.now() - HOST_TIMEOUT):
        end_live(live, reason='host_lost')


def end_live(live, reason='ended'):
    if live.status != LiveStream.LIVE:
        return summary(live)
    live.status = LiveStream.ENDED
    live.ended_at = timezone.now()
    live.save(update_fields=['status', 'ended_at'])
    data = summary(live)
    broadcast(live.pk, 'live.ended', {'live_id': live.pk, 'reason': reason, 'summary': data})
    transaction.on_commit(lambda: registry.forget(live.pk))
    return data


def summary(live):
    end = live.ended_at or timezone.now()
    return {
        'duration': int((end - live.started_at).total_seconds()),
        'total_viewers': live.total_viewers,
        'peak_viewers': live.peak_viewers,
        'likes': live.likes_count,
        'comments': live.comments_count,
        'gifts': live.gifts_count,
        'gifts_value': live.gifts_value,
        'new_followers': live.new_followers,
    }


def comment_data(c, viewer=None):
    reply = c.reply_to
    return {
        'id': c.pk, 'user': user_brief(c.user, viewer), 'text': c.text, 'created_at': c.created_at.isoformat(),
        'reply_to': {'id': reply.pk, 'user_id': reply.user_id, 'user_name': reply.user.name, 'text': reply.text[:90]} if reply else None,
    }


def live_data(live, viewer):
    data = {
        'id': live.pk,
        'host': user_brief(live.host, viewer),
        'title': live.title,
        'audience': live.audience,
        'status': live.status,
        'started_at': live.started_at.isoformat(),
        'ended_at': live.ended_at.isoformat() if live.ended_at else None,
        'viewers': registry.count(live.pk),
        'likes': live.likes_count,
        'is_host': live.host_id == viewer.pk,
    }
    if live.status == LiveStream.ENDED:
        data['summary'] = summary(live)
    return data


def gifts_catalog():
    return [{'code': code, **g} for code, g in GIFTS.items()]


# ---------------------------------------------------------------- serveur média (MediaMTX)

def media_mode():
    return 'sfu' if settings.LIVE_MEDIA_URL else 'p2p'


def media_token(live, user, action):
    return signing.dumps({'l': live.pk, 'u': user.pk, 'a': action}, salt=TOKEN_SALT)


def media_info(live, user, action):
    """Adresses WHIP (publication) / WHEP (lecture) signées pour cet utilisateur."""
    if media_mode() != 'sfu':
        return {'mode': 'p2p', 'max_viewers': settings.LIVE_P2P_MAX_VIEWERS}
    endpoint = 'whip' if action == 'publish' else 'whep'
    token = media_token(live, user, action)
    return {'mode': 'sfu', 'url': f'{settings.LIVE_MEDIA_URL}/{live.media_path}/{endpoint}?token={token}'}


def check_media_token(token, path, action):
    """Appelé par MediaMTX : ce jeton autorise-t-il `action` sur `path` ?"""
    try:
        payload = signing.loads(token, salt=TOKEN_SALT, max_age=TOKEN_MAX_AGE)
    except signing.BadSignature:
        return False
    if payload.get('a') != action:
        return False
    live = LiveStream.objects.filter(pk=payload.get('l'), status=LiveStream.LIVE).select_related('host').first()
    if live is None or live.media_path != path:
        return False
    if action == 'publish':
        return live.host_id == payload.get('u')
    from accounts.models import User
    user = User.objects.filter(pk=payload.get('u'), is_active=True).first()
    return user is not None and can_view(user, live) and not live.bans.filter(user=user).exists()


def recent_comments(live, viewer, limit=40):
    qs = LiveComment.objects.filter(live=live).select_related('user', 'reply_to__user').order_by('-id')[:limit]
    return [comment_data(c, viewer) for c in reversed(list(qs))]
