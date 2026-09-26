import json
from urllib.parse import unquote

from django.db.models import Q
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from accounts.models import Block, User
from accounts.push import TTL_SOCIAL, send_to_users
from accounts.serializers import user_brief
from chat.realtime import push
from kozons.api import ApiError, api, body, rate_limit

from . import registry, services as svc
from .models import LiveStream


def _visible_live(request, pk):
    live = get_object_or_404(LiveStream.objects.select_related('host'), pk=pk)
    if not svc.can_view(request.user, live):
        raise ApiError('Ce live est réservé aux abonnés.', 403)
    return live


@api(['GET', 'POST'])
def lives(request):
    """GET : lives en cours visibles (abonnements d'abord, puis les plus regardés). POST : démarrer."""
    if request.method == 'POST':
        return start_live(request)
    svc.expire_stale()
    from social.models import Follow
    followed = set(Follow.objects.filter(follower=request.user, accepted=True).values_list('following_id', flat=True))
    blocked = Block.objects.filter(Q(blocker=request.user) | Q(blocked=request.user)).values_list('blocker_id', 'blocked_id')
    blocked_ids = {i for pair in blocked for i in pair} - {request.user.pk}
    items = []
    for live in LiveStream.objects.filter(status=LiveStream.LIVE).select_related('host').exclude(host_id__in=blocked_ids):
        if live.audience == 'followers' and live.host_id not in followed and live.host_id != request.user.pk:
            continue
        data = svc.live_data(live, request.user)
        data['following'] = live.host_id in followed
        items.append(data)
    items.sort(key=lambda d: (d['is_host'], d['following'], d['viewers'], d['started_at']), reverse=True)
    return {'results': items, 'mode': svc.media_mode()}


def start_live(request):
    rate_limit(request, 'live-start', 10, 3600)
    data = body(request)
    audience = data.get('audience') if data.get('audience') in ('public', 'followers') else 'public'
    # Un seul live à la fois par animateur.
    for old in LiveStream.objects.filter(host=request.user, status=LiveStream.LIVE):
        svc.end_live(old)
    live = LiveStream.objects.create(host=request.user, title=(data.get('title') or '').strip()[:80], audience=audience)

    # Abonnés prévenus : événement en direct (application ouverte) + notification push.
    from social.models import Follow
    followers = list(Follow.objects.filter(following=request.user, accepted=True).values_list('follower_id', flat=True))
    push(followers, 'live.started', {'live': svc.live_data(live, request.user)})
    send_to_users(followers, {
        'kind': 'live',
        'title': f'🔴 {request.user.name} est en direct',
        'body': live.title or 'Rejoignez le LIVE maintenant !',
        'icon': request.user.avatar.url if request.user.avatar else None,
        'url': f'/live/{live.pk}',
        'tag': f'live-{live.pk}',
    }, ttl=3600, urgency='high')
    return {**svc.live_data(live, request.user), 'media': svc.media_info(live, request.user, 'publish')}


@api(['GET'])
def live_detail(request, pk):
    svc.expire_stale()
    live = _visible_live(request, pk)
    data = svc.live_data(live, request.user)
    data['gifts_catalog'] = svc.gifts_catalog()
    if live.is_live:
        data['comments'] = svc.recent_comments(live, request.user)
        data['pinned'] = svc.comment_data(live.pinned_comment, request.user) if live.pinned_comment else None
        data['banned'] = live.bans.filter(user=request.user).exists()
        data['media'] = svc.media_info(live, request.user, 'publish' if data['is_host'] else 'read')
    return data


@api(['POST'])
def live_end(request, pk):
    live = get_object_or_404(LiveStream, pk=pk, host=request.user)
    return {'summary': svc.end_live(live)}


@api(['GET'])
def live_viewers(request, pk):
    """Spectateurs en cours (visible par tous les participants ; l'animateur peut les exclure)."""
    live = _visible_live(request, pk)
    users = User.objects.filter(pk__in=registry.viewer_ids(live.pk)).order_by('display_name', 'username')[:200]
    return {'results': [user_brief(u, request.user) for u in users]}


@csrf_exempt
@require_POST
def media_auth(request):
    """Autorisation demandée par MediaMTX (authMethod: http) pour chaque publication / lecture.
    Réponse 200 = autorisé, 401 = refusé. Le jeton signé voyage dans la requête (?token=)."""
    try:
        data = json.loads(request.body or b'{}')
    except json.JSONDecodeError:
        return HttpResponse(status=400)
    action, path = data.get('action'), (data.get('path') or '').strip('/')
    query = data.get('query') or ''
    token = next((part[6:] for part in query.split('&') if part.startswith('token=')), '') or data.get('token') or ''
    if action in ('publish', 'read') and svc.check_media_token(unquote(token), path, action):
        return HttpResponse(status=200)
    return HttpResponse(status=401)


def follower_gained(host):
    """Nouvel abonné pendant un live : compté dans le résumé de fin."""
    from django.db.models import F
    LiveStream.objects.filter(host=host, status=LiveStream.LIVE).update(new_followers=F('new_followers') + 1)

