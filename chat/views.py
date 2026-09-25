from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone

from accounts.models import User
from kozons.api import ApiError, api, as_bool, as_int, body, media_kind, rate_limit

from . import services as svc
from .models import (Call, Conversation, Message, Participant, PollOption, PollVote, Reaction,
                     StarredMessage, ViewOnceOpened)
from .realtime import push
from .serializers import call_data, message_data

EDIT_WINDOW = timedelta(minutes=15)
DELETE_FOR_ALL_WINDOW = timedelta(days=2)


# ---------------------------------------------------------------- Discussions

@api(['GET'])
def conversation_list(request):
    return {'results': svc.conversations_for(request.user)}


@api(['GET'])
def conversation_detail(request, pk):
    return svc.conversation_for(request.user, pk)


@api(['POST'])
def start_direct(request):
    data = body(request)
    other = get_object_or_404(User, pk=as_int(data.get('user_id')), is_active=True)
    if other == request.user:
        raise ApiError('Choisissez un autre utilisateur.')
    conv = svc.get_or_create_direct(request.user, other)
    return svc.conversation_for(request.user, conv.pk)


def _member_ids_from(data):
    raw = data.getlist('member_ids') if hasattr(data, 'getlist') else data.get('member_ids', [])
    if isinstance(raw, str):
        raw = raw.split(',')
    if len(raw) == 1 and isinstance(raw[0], str) and ',' in raw[0]:
        raw = raw[0].split(',')
    return {i for i in (as_int(x) for x in raw) if i}


@api(['POST'])
def create_group(request):
    data = body(request)
    title = (data.get('title') or '').strip()[:100]
    if not title:
        raise ApiError('Le groupe doit avoir un nom.')
    ids = _member_ids_from(data) - {request.user.pk}
    members = list(User.objects.filter(pk__in=ids, is_active=True).exclude(blocking__blocked=request.user))
    if len(members) > 1023:
        raise ApiError('Un groupe peut contenir au maximum 1024 membres.')
    with transaction.atomic():
        conv = Conversation.objects.create(kind=Conversation.GROUP, title=title, created_by=request.user,
                                           description=(data.get('description') or '')[:1000])
        if 'avatar' in request.FILES and media_kind(request.FILES['avatar']) == 'image':
            conv.avatar = request.FILES['avatar']
            conv.save(update_fields=['avatar'])
        Participant.objects.create(conversation=conv, user=request.user, role=Participant.ADMIN)
        Participant.objects.bulk_create([Participant(conversation=conv, user=u) for u in members])
        svc.system_message(conv, request.user, f'{request.user.name} a créé le groupe « {title} »')
    svc.broadcast_conversation(conv)
    return svc.conversation_for(request.user, conv.pk)


@api(['POST'])
def update_conversation(request, pk):
    part = svc.get_participant(request.user, pk)
    conv = part.conversation
    data = body(request)
    changes = []
    if conv.is_group:
        can_edit = part.is_admin or not conv.only_admins_can_edit
        if ('title' in data or 'description' in data or 'avatar' in request.FILES) and not can_edit:
            raise ApiError('Seuls les administrateurs peuvent modifier le groupe.', 403)
        if 'title' in data and (data.get('title') or '').strip():
            conv.title = data['title'].strip()[:100]
            changes.append(f'{request.user.name} a renommé le groupe en « {conv.title} »')
        if 'description' in data:
            conv.description = (data.get('description') or '')[:1000]
            changes.append(f'{request.user.name} a modifié la description du groupe')
        if 'avatar' in request.FILES:
            if media_kind(request.FILES['avatar']) != 'image':
                raise ApiError("L'icône du groupe doit être une image.")
            conv.avatar = request.FILES['avatar']
            changes.append(f"{request.user.name} a changé l'icône du groupe")
        for field in ('only_admins_can_send', 'only_admins_can_edit'):
            if field in data:
                if not part.is_admin:
                    raise ApiError('Réservé aux administrateurs.', 403)
                setattr(conv, field, as_bool(data.get(field)))
                changes.append(f'{request.user.name} a modifié les paramètres du groupe')
    if 'disappearing_seconds' in data:
        if conv.is_group and not part.is_admin and conv.only_admins_can_edit:
            raise ApiError('Réservé aux administrateurs.', 403)
        seconds = as_int(data.get('disappearing_seconds'), 0)
        if seconds not in (0, 86400, 7 * 86400, 90 * 86400):
            raise ApiError('Durée invalide.')
        conv.disappearing_seconds = seconds
        label = {0: 'désactivé', 86400: '24 heures', 604800: '7 jours', 7776000: '90 jours'}[seconds]
        changes.append(f'{request.user.name} a réglé les messages éphémères sur : {label}')
    conv.save()
    for text in dict.fromkeys(changes):
        svc.system_message(conv, request.user, text)
    svc.broadcast_conversation(conv)
    return svc.conversation_for(request.user, pk)


@api(['POST'])
def conversation_settings(request, pk):
    """Réglages personnels : épingler, archiver, sourdine, marquer non lu, vider."""
    part = svc.get_participant(request.user, pk)
    data = body(request)
    if 'pinned' in data:
        pinned = as_bool(data.get('pinned'))
        if pinned and Participant.objects.filter(user=request.user, pinned=True).exclude(pk=part.pk).count() >= 5:
            raise ApiError('Vous pouvez épingler 5 discussions maximum.')
        part.pinned = pinned
    if 'archived' in data:
        part.archived = as_bool(data.get('archived'))
        if part.archived:
            part.pinned = False
    if 'mute_hours' in data:
        hours = as_int(data.get('mute_hours'), 0)
        part.muted_until = None if hours == 0 else (
            timezone.now() + timedelta(days=36500) if hours < 0 else timezone.now() + timedelta(hours=hours))
    if 'marked_unread' in data:
        part.marked_unread = as_bool(data.get('marked_unread'))
    if as_bool(data.get('clear')):
        latest = Message.objects.filter(conversation_id=pk).order_by('-id').values_list('id', flat=True).first() or 0
        part.cleared_before_id = latest
        part.last_read_id = max(part.last_read_id, latest)
    part.save()
    result = svc.conversation_for(request.user, pk)
    push([request.user.pk], 'conversation.update', result)
    return result


@api(['POST'])
def manage_members(request, pk):
    part = svc.get_participant(request.user, pk)
    conv = part.conversation
    if not conv.is_group:
        raise ApiError("Ce n'est pas un groupe.")
    data = body(request)
    action = data.get('action')
    removed_ids = []

    if action == 'leave':
        with transaction.atomic():
            part.delete()
            remaining = Participant.objects.filter(conversation=conv)
            if part.is_admin and not remaining.filter(role=Participant.ADMIN).exists():
                first = remaining.order_by('joined_at').first()
                if first:
                    first.role = Participant.ADMIN
                    first.save(update_fields=['role'])
            svc.system_message(conv, request.user, f'{request.user.name} a quitté le groupe')
        push([request.user.pk], 'conversation.removed', {'conversation_id': conv.pk})
        svc.broadcast_conversation(conv)
        return {'left': True}

    if not part.is_admin:
        raise ApiError('Réservé aux administrateurs.', 403)
    ids = _member_ids_from(data)
    targets = list(User.objects.filter(pk__in=ids))
    with transaction.atomic():
        if action == 'add':
            existing = set(conv.participants.values_list('user_id', flat=True))
            new = [u for u in targets if u.pk not in existing]
            if len(existing) + len(new) > 1024:
                raise ApiError('Un groupe peut contenir au maximum 1024 membres.')
            Participant.objects.bulk_create([Participant(conversation=conv, user=u) for u in new])
            if new:
                svc.system_message(conv, request.user,
                                   f"{request.user.name} a ajouté {', '.join(u.name for u in new)}")
        elif action == 'remove':
            for u in targets:
                if u == request.user:
                    continue
                if Participant.objects.filter(conversation=conv, user=u).delete()[0]:
                    removed_ids.append(u.pk)
                    svc.system_message(conv, request.user, f'{request.user.name} a retiré {u.name}')
        elif action in ('promote', 'demote'):
            role = Participant.ADMIN if action == 'promote' else Participant.MEMBER
            qs = Participant.objects.filter(conversation=conv, user__in=targets)
            if action == 'demote' and conv.created_by_id:
                qs = qs.exclude(user_id=conv.created_by_id)  # le créateur reste admin
            qs.update(role=role)
        else:
            raise ApiError('Action inconnue.')
    if removed_ids:
        push(removed_ids, 'conversation.removed', {'conversation_id': conv.pk})
    svc.broadcast_conversation(conv)
    return svc.conversation_for(request.user, pk)


# ---------------------------------------------------------------- Messages

@api(['GET', 'POST'])
def messages(request, pk):
    part = svc.get_participant(request.user, pk)
    if request.method == 'GET':
        qs = svc.visible_messages(pk, request.user, part.cleared_before_id)
        before = as_int(request.GET.get('before'))
        after = as_int(request.GET.get('after'))
        around = as_int(request.GET.get('around'))
        limit = min(as_int(request.GET.get('limit'), 50), 100)
        if around:
            older = list(svc.load_messages(qs.filter(id__lte=around).order_by('-id'))[:limit // 2])
            newer = list(svc.load_messages(qs.filter(id__gt=around).order_by('id'))[:limit // 2])
            items = list(reversed(older)) + newer
            return {'results': svc.serialize_messages(items, request.user), 'has_more': True, 'has_newer': len(newer) == limit // 2}
        if after:
            items = list(svc.load_messages(qs.filter(id__gt=after).order_by('id'))[:limit])
            return {'results': svc.serialize_messages(items, request.user), 'has_more': False, 'has_newer': len(items) == limit}
        if before:
            qs = qs.filter(id__lt=before)
        items = list(svc.load_messages(qs.order_by('-id'))[:limit + 1])
        has_more = len(items) > limit
        items = list(reversed(items[:limit]))
        return {'results': svc.serialize_messages(items, request.user), 'has_more': has_more, 'has_newer': False}
    return send_message(request, part)


def send_message(request, part):
    rate_limit(request, 'send', 120, 60)
    svc.can_send(part)
    conv = part.conversation
    data = body(request)
    kind = data.get('kind') or 'text'
    fields = {'text': (data.get('text') or '')[:65536]}

    reply_id = as_int(data.get('reply_to'))
    if reply_id:
        fields['reply_to'] = Message.objects.filter(pk=reply_id, conversation=conv).first()

    upload = request.FILES.get('file')
    if kind == 'sticker':
        # Sticker de la collection (sticker_id) ou image importée, toujours normalisée en WebP.
        from .stickers import resolve_for_message
        sticker = resolve_for_message(request.user, data, upload)
        fields.update(sticker=sticker, file=sticker.file.name, file_name='sticker.webp', file_size=sticker.file.size, text='')
    elif upload:
        detected = media_kind(upload)
        if kind == 'voice' and detected in ('audio', 'video'):
            detected = 'voice'
        kind = detected
        fields.update(file=upload, file_name=upload.name[:255], file_size=upload.size,
                      duration=float(data.get('duration') or 0), view_once=as_bool(data.get('view_once')) and kind in ('image', 'video', 'voice'))
    elif kind == 'location':
        try:
            fields['latitude'] = float(data.get('latitude'))
            fields['longitude'] = float(data.get('longitude'))
        except (TypeError, ValueError):
            raise ApiError('Position invalide.')
    elif kind == 'contact':
        fields['contact_user'] = get_object_or_404(User, pk=as_int(data.get('contact_id')))
    elif kind == 'post':
        from social.models import Post
        from social.views import can_view_post
        post = get_object_or_404(Post, pk=as_int(data.get('post_id')))
        if not can_view_post(request.user, post):
            raise ApiError('Publication introuvable.', 404)
        fields['shared_post'] = post
    elif kind == 'story_reply':
        from social.models import Story
        fields['story'] = get_object_or_404(Story, pk=as_int(data.get('story_id')))
    elif kind == 'poll':
        options = data.getlist('options') if hasattr(data, 'getlist') else data.get('options', [])
        options = [o.strip()[:100] for o in options if o and o.strip()]
        if not fields['text'].strip() or len(options) < 2 or len(options) > 12:
            raise ApiError('Un sondage doit avoir une question et 2 à 12 options.')
    else:
        kind = 'text'
        if not fields['text'].strip():
            raise ApiError('Message vide.')

    fields['kind'] = kind
    fields['forwarded'] = False
    with transaction.atomic():
        if kind == 'poll':
            multiple = as_bool(data.get('multiple'))
            msg = Message.objects.create(conversation=conv, sender=request.user, **fields,
                                         expires_at=(timezone.now() + timedelta(seconds=conv.disappearing_seconds)) if conv.disappearing_seconds else None)
            PollOption.objects.bulk_create([PollOption(message=msg, text=o, multiple=multiple) for o in options])
            Conversation.objects.filter(pk=conv.pk).update(updated_at=msg.created_at)
            Participant.objects.filter(pk=part.pk).update(last_read_id=msg.pk, last_delivered_id=msg.pk)
            msg = svc.load_messages(Message.objects.filter(pk=msg.pk)).get()
            push(svc.member_ids(conv), 'message.new', message_data(msg))
        else:
            msg = svc.create_message(conv, request.user, **fields)
    return svc.serialize_messages([msg], request.user)[0]


def _own_message(request, pk):
    msg = get_object_or_404(Message.objects.select_related('conversation'), pk=pk)
    svc.get_participant(request.user, msg.conversation_id)
    return msg


@api(['POST'])
def edit_message(request, pk):
    msg = _own_message(request, pk)
    if msg.sender_id != request.user.pk or msg.kind != 'text' or msg.deleted:
        raise ApiError('Ce message ne peut pas être modifié.', 403)
    if timezone.now() - msg.created_at > EDIT_WINDOW:
        raise ApiError('Les messages ne peuvent être modifiés que pendant 15 minutes.')
    text = (body(request).get('text') or '').strip()
    if not text:
        raise ApiError('Message vide.')
    msg.text = text[:65536]
    msg.edited_at = timezone.now()
    msg.save(update_fields=['text', 'edited_at'])
    svc.broadcast_message_update(msg)
    return {'ok': True}


@api(['POST'])
def delete_message(request, pk):
    msg = _own_message(request, pk)
    scope = body(request).get('scope', 'me')
    if scope == 'everyone':
        part = svc.get_participant(request.user, msg.conversation_id)
        is_group_admin = msg.conversation.is_group and part.is_admin
        if msg.sender_id != request.user.pk and not is_group_admin:
            raise ApiError('Vous ne pouvez supprimer pour tous que vos propres messages.', 403)
        if msg.sender_id == request.user.pk and timezone.now() - msg.created_at > DELETE_FOR_ALL_WINDOW:
            raise ApiError('Trop tard pour supprimer ce message pour tout le monde.')
        with transaction.atomic():
            svc.delete_file_if_unused(msg)
            msg.deleted = True
            msg.text = ''
            msg.file = ''
            msg.save()
            msg.reactions.all().delete()
            svc.broadcast_message_update(msg)
    else:
        svc.hide_message(request.user, msg)
        push([request.user.pk], 'message.hidden', {'id': msg.pk, 'conversation_id': msg.conversation_id})
    return {'ok': True}


@api(['POST'])
def react(request, pk):
    msg = _own_message(request, pk)
    if msg.deleted:
        raise ApiError('Message supprimé.')
    emoji = (body(request).get('emoji') or '')[:16]
    existing = Reaction.objects.filter(message=msg, user=request.user).first()
    if not emoji or (existing and existing.emoji == emoji):
        if existing:
            existing.delete()
    elif existing:
        existing.emoji = emoji
        existing.save(update_fields=['emoji'])
    else:
        Reaction.objects.create(message=msg, user=request.user, emoji=emoji)
    svc.broadcast_message_update(msg)
    return {'ok': True}


@api(['POST'])
def star(request, pk):
    msg = _own_message(request, pk)
    obj, created = StarredMessage.objects.get_or_create(message=msg, user=request.user)
    if not created:
        obj.delete()
    push([request.user.pk], 'message.starred', {'id': msg.pk, 'conversation_id': msg.conversation_id, 'starred': created})
    return {'starred': created}


@api(['POST'])
def forward(request, pk):
    msg = _own_message(request, pk)
    if msg.deleted or msg.view_once or msg.kind in ('system', 'poll'):
        raise ApiError('Ce message ne peut pas être transféré.')
    data = body(request)
    raw = data.get('conversation_ids') or []
    if isinstance(raw, str):
        raw = raw.split(',')
    targets = [as_int(x) for x in raw if as_int(x)][:5]
    if not targets:
        raise ApiError('Choisissez au moins une discussion.')
    for cid in targets:
        part = svc.get_participant(request.user, cid)
        svc.can_send(part)
        svc.create_message(part.conversation, request.user, kind=msg.kind, text=msg.text, file=msg.file.name if msg.file else '',
                           file_name=msg.file_name, file_size=msg.file_size, duration=msg.duration,
                           latitude=msg.latitude, longitude=msg.longitude, shared_post=msg.shared_post,
                           contact_user=msg.contact_user, sticker=msg.sticker, forwarded=True)
    return {'ok': True, 'count': len(targets)}


@api(['POST'])
def vote(request, pk):
    msg = _own_message(request, pk)
    if msg.kind != 'poll' or msg.deleted:
        raise ApiError("Ce message n'est pas un sondage.")
    option = get_object_or_404(PollOption, pk=as_int(body(request).get('option_id')), message=msg)
    with transaction.atomic():
        existing = PollVote.objects.filter(option=option, user=request.user)
        if existing.exists():
            existing.delete()
        else:
            if not option.multiple:
                PollVote.objects.filter(option__message=msg, user=request.user).delete()
            PollVote.objects.create(option=option, user=request.user)
        svc.broadcast_message_update(msg)
    return {'ok': True}


@api(['POST'])
def open_view_once(request, pk):
    msg = _own_message(request, pk)
    if not msg.view_once or not msg.file:
        raise ApiError('Média indisponible.')
    if msg.sender_id != request.user.pk:
        _, created = ViewOnceOpened.objects.get_or_create(message=msg, user=request.user)
        if not created:
            raise ApiError('Ce média a déjà été ouvert.', 410)
        push([msg.sender_id], 'message.opened', {'id': msg.pk, 'conversation_id': msg.conversation_id, 'user_id': request.user.pk})
    return {'file': msg.file.url, 'kind': msg.kind}


@api(['POST'])
def read(request, pk):
    svc.mark_read(request.user, pk, as_int(body(request).get('message_id'), 0))
    return {'ok': True}


@api(['GET'])
def message_info(request, pk):
    """Qui a reçu / lu le message (infos du message, style WhatsApp)."""
    msg = _own_message(request, pk)
    parts = msg.conversation.participants.select_related('user').exclude(user=msg.sender_id)
    from accounts.serializers import user_brief
    return {'results': [{
        'user': user_brief(p.user, request.user),
        'read': p.user.read_receipts and p.last_read_id >= msg.pk,
        'delivered': p.last_delivered_id >= msg.pk,
    } for p in parts]}


@api(['GET'])
def starred_list(request):
    ids = StarredMessage.objects.filter(user=request.user).order_by('-created_at').values_list('message_id', flat=True)[:200]
    msgs = list(svc.load_messages(Message.objects.filter(pk__in=list(ids), conversation__participants__user=request.user)).order_by('-id'))
    return {'results': svc.serialize_messages(msgs, request.user)}


@api(['GET'])
def search(request):
    q = (request.GET.get('q') or '').strip()
    if len(q) < 2:
        return {'results': []}
    conv = as_int(request.GET.get('conversation'))
    qs = (Message.objects.filter(conversation__participants__user=request.user, text__icontains=q, deleted=False)
          .exclude(kind='system').exclude(hidden_for__user=request.user).exclude(expires_at__lte=timezone.now()))
    if conv:
        qs = qs.filter(conversation_id=conv)
    msgs = list(svc.load_messages(qs.order_by('-id'))[:100])
    return {'results': svc.serialize_messages(msgs, request.user)}


@api(['GET'])
def media_gallery(request, pk):
    """Médias, liens et documents d'une discussion."""
    part = svc.get_participant(request.user, pk)
    qs = svc.visible_messages(pk, request.user, part.cleared_before_id).filter(deleted=False, view_once=False)
    kind = request.GET.get('type', 'media')
    if kind == 'media':
        qs = qs.filter(kind__in=('image', 'video'))
    elif kind == 'docs':
        qs = qs.filter(kind__in=('file', 'audio'))
    else:
        qs = qs.filter(Q(text__icontains='http://') | Q(text__icontains='https://'))
    msgs = list(svc.load_messages(qs.order_by('-id'))[:200])
    return {'results': svc.serialize_messages(msgs, request.user)}


@api(['GET'])
def call_history(request):
    calls = (Call.objects.filter(Q(caller=request.user) | Q(callee=request.user))
             .select_related('caller', 'callee').order_by('-started_at')[:100])
    return {'results': [call_data(c, request.user) for c in calls]}


@api(['GET'])
def ice_servers(request):
    """Serveurs STUN/TURN pour WebRTC (configurez KOZONS_TURN_* en production)."""
    import os
    servers = [{'urls': ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']}]
    if os.environ.get('KOZONS_TURN_URL'):
        servers.append({'urls': os.environ['KOZONS_TURN_URL'],
                        'username': os.environ.get('KOZONS_TURN_USER', ''),
                        'credential': os.environ.get('KOZONS_TURN_PASSWORD', '')})
    return {'ice_servers': servers}

