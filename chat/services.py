"""Logique métier des discussions : accès, envoi de messages, diffusion temps réel."""
from datetime import timedelta

from django.db import transaction
from django.db.models import Count, F, OuterRef, Prefetch, Subquery
from django.shortcuts import get_object_or_404
from django.utils import timezone

from accounts.models import Block
from kozons.api import ApiError

from .models import Conversation, HiddenMessage, Message, Participant, StarredMessage, ViewOnceOpened
from .realtime import push
from .serializers import MESSAGE_PREFETCH, MESSAGE_RELATED, conversation_data, message_data


def get_participant(user, conversation_id):
    part = (Participant.objects.select_related('conversation')
            .filter(user=user, conversation_id=conversation_id).first())
    if part is None:
        raise ApiError('Discussion introuvable.', 404)
    return part


def member_ids(conversation):
    return list(conversation.participants.values_list('user_id', flat=True))


def direct_peer(conversation, user):
    return conversation.participants.exclude(user=user).select_related('user').first()


def block_state(conversation, user):
    if conversation.is_group:
        return None
    peer = direct_peer(conversation, user)
    if peer is None:
        return None
    return {
        'by_me': Block.objects.filter(blocker=user, blocked=peer.user).exists(),
        'by_them': Block.objects.filter(blocker=peer.user, blocked=user).exists(),
    }


def visible_messages(conversation_id, user, cleared_before_id=0):
    return (Message.objects.filter(conversation_id=conversation_id, id__gt=cleared_before_id)
            .exclude(hidden_for__user=user)
            .exclude(expires_at__lte=timezone.now()))


def serialize_messages(messages, user):
    ids = [m.pk for m in messages]
    starred = set(StarredMessage.objects.filter(user=user, message_id__in=ids).values_list('message_id', flat=True))
    opened = set(ViewOnceOpened.objects.filter(user=user, message_id__in=ids).values_list('message_id', flat=True))
    return [message_data(m, user, starred, opened) for m in messages]


def load_messages(queryset):
    return queryset.select_related(*MESSAGE_RELATED).prefetch_related(*MESSAGE_PREFETCH)


def conversations_for(user, only_ids=None):
    """Liste complète des discussions d'un utilisateur avec dernier message et non-lus,
    en un nombre constant de requêtes."""
    now = timezone.now()
    last_msg = (Message.objects.filter(conversation_id=OuterRef('conversation_id'), id__gt=OuterRef('cleared_before_id'))
                .exclude(hidden_for__user=user).exclude(expires_at__lte=now).order_by('-id').values('id')[:1])
    parts = (Participant.objects.filter(user=user)
             .select_related('conversation')
             .prefetch_related(Prefetch('conversation__participants',
                                        queryset=Participant.objects.select_related('user').order_by('joined_at')))
             .annotate(last_id=Subquery(last_msg)))
    if only_ids is not None:
        parts = parts.filter(conversation_id__in=only_ids)
    parts = list(parts)

    conv_ids = [p.conversation_id for p in parts]
    unread = dict(
        Message.objects.filter(conversation_id__in=conv_ids, conversation__participants__user=user,
                               # « Vider la discussion » avance aussi last_read_id, donc
                               # id > last_read_id implique id > cleared_before_id.
                               id__gt=F('conversation__participants__last_read_id'))
        .exclude(sender=user).exclude(kind='system').exclude(deleted=True)
        .exclude(expires_at__lte=now)
        .values('conversation_id').annotate(n=Count('id')).values_list('conversation_id', 'n')
    )
    last_ids = [p.last_id for p in parts if p.last_id]
    messages = {m.pk: m for m in load_messages(Message.objects.filter(pk__in=last_ids))}
    serialized = {d['id']: d for d in serialize_messages(list(messages.values()), user)}

    # États de blocage des discussions privées, en une requête.
    blocks = list(Block.objects.filter(blocker=user).values_list('blocked_id', flat=True))
    blocked_by = list(Block.objects.filter(blocked=user).values_list('blocker_id', flat=True))

    result = []
    for p in parts:
        conv = p.conversation
        members = list(conv.participants.all())
        blocked = None
        if not conv.is_group:
            peer = next((m for m in members if m.user_id != user.pk), None)
            if peer:
                blocked = {'by_me': peer.user_id in blocks, 'by_them': peer.user_id in blocked_by}
        result.append(conversation_data(conv, p, user, members, serialized.get(p.last_id),
                                        unread.get(conv.pk, 0), blocked))
    result.sort(key=lambda c: (c['me']['pinned'], (c['last_message'] or {}).get('created_at') or c['updated_at']), reverse=True)
    return result


def conversation_for(user, conversation_id):
    items = conversations_for(user, only_ids=[conversation_id])
    if not items:
        raise ApiError('Discussion introuvable.', 404)
    return items[0]


def broadcast_conversation(conversation):
    """Envoie à chaque membre sa propre vue à jour de la discussion."""
    def send():
        for part in Participant.objects.filter(conversation=conversation).select_related('user'):
            try:
                data = conversation_for(part.user, conversation.pk)
            except ApiError:
                continue
            push([part.user_id], 'conversation.update', data)
    transaction.on_commit(send)


def create_message(conversation, sender, **fields):
    """Crée un message, met à jour la discussion et le diffuse à tous les membres."""
    if conversation.disappearing_seconds and fields.get('kind') != 'system':
        fields['expires_at'] = timezone.now() + timedelta(seconds=conversation.disappearing_seconds)
    with transaction.atomic():
        msg = Message.objects.create(conversation=conversation, sender=sender, **fields)
        Conversation.objects.filter(pk=conversation.pk).update(updated_at=msg.created_at)
        if sender is not None:
            Participant.objects.filter(conversation=conversation, user=sender).update(
                last_read_id=msg.pk, last_delivered_id=msg.pk, marked_unread=False)
        msg = load_messages(Message.objects.filter(pk=msg.pk)).get()
        push(member_ids(conversation), 'message.new', message_data(msg))
    return msg


def system_message(conversation, actor, text):
    return create_message(conversation, actor, kind='system', text=text)


def broadcast_message_update(msg):
    msg = load_messages(Message.objects.filter(pk=msg.pk)).get()
    push(member_ids(msg.conversation), 'message.update', message_data(msg))


def can_send(part):
    conv = part.conversation
    if conv.is_group and conv.only_admins_can_send and not part.is_admin:
        raise ApiError('Seuls les administrateurs peuvent envoyer des messages.', 403)
    if not conv.is_group:
        state = block_state(conv, part.user)
        if state and state['by_me']:
            raise ApiError('Vous avez bloqué ce contact. Débloquez-le pour envoyer un message.', 403)
        if state and state['by_them']:
            raise ApiError("Impossible d'envoyer un message à ce contact.", 403)


def get_or_create_direct(user, other):
    if Block.objects.filter(blocker=other, blocked=user).exists():
        raise ApiError("Impossible de contacter cet utilisateur.", 403)
    key = f'{min(user.pk, other.pk)}:{max(user.pk, other.pk)}'
    with transaction.atomic():
        conv, created = Conversation.objects.get_or_create(
            direct_key=key, defaults={'kind': Conversation.DIRECT, 'created_by': user})
        if created:
            Participant.objects.bulk_create([
                Participant(conversation=conv, user=user),
                Participant(conversation=conv, user=other),
            ])
    return conv


def mark_read(user, conversation_id, message_id):
    part = get_participant(user, conversation_id)
    message_id = min(int(message_id), Message.objects.filter(conversation_id=conversation_id).order_by('-id').values_list('id', flat=True).first() or 0)
    updates = {'marked_unread': False}
    if message_id > part.last_read_id:
        updates['last_read_id'] = message_id
    if message_id > part.last_delivered_id:
        updates['last_delivered_id'] = message_id
    Participant.objects.filter(pk=part.pk).update(**updates)
    if message_id > part.last_read_id:
        payload = {'conversation_id': conversation_id, 'user_id': user.pk,
                   'last_delivered_id': max(message_id, part.last_delivered_id)}
        if user.read_receipts:
            payload['last_read_id'] = message_id
        push(member_ids(part.conversation), 'receipt', payload)
    # Synchronise les autres appareils de l'utilisateur (compteur de non-lus).
    push([user.pk], 'conversation.read', {'conversation_id': conversation_id, 'last_read_id': max(message_id, part.last_read_id)})


def mark_delivered(user, conversation_id, message_id):
    part = Participant.objects.filter(user=user, conversation_id=conversation_id).first()
    if part is None or message_id <= part.last_delivered_id:
        return
    Participant.objects.filter(pk=part.pk, last_delivered_id__lt=message_id).update(last_delivered_id=message_id)
    push(member_ids(part.conversation), 'receipt', {
        'conversation_id': conversation_id, 'user_id': user.pk, 'last_delivered_id': message_id})


def mark_all_delivered(user):
    """À la connexion : tous les messages en attente passent en « distribué »."""
    latest = (Message.objects.filter(conversation_id=OuterRef('conversation_id')).order_by('-id').values('id')[:1])
    parts = (Participant.objects.filter(user=user).annotate(latest=Subquery(latest))
             .filter(latest__gt=F('last_delivered_id')).select_related('conversation'))
    for part in parts:
        mark_delivered(user, part.conversation_id, part.latest)


def hide_message(user, msg):
    HiddenMessage.objects.get_or_create(user=user, message=msg)


def purge_expired():
    """Supprime définitivement les messages éphémères expirés et leurs fichiers."""
    expired = Message.objects.filter(expires_at__lte=timezone.now())
    for msg in expired.exclude(file=''):
        delete_file_if_unused(msg)
    expired.delete()


def delete_file_if_unused(msg):
    """Les messages transférés partagent le même fichier : on ne le supprime
    du disque que s'il n'est plus référencé ailleurs."""
    from .models import Sticker
    if (msg.file and not Message.objects.filter(file=msg.file.name).exclude(pk=msg.pk).exists()
            and not Sticker.objects.filter(file=msg.file.name).exists()):
        msg.file.delete(save=False)


def conversation_or_404(pk):
    return get_object_or_404(Conversation, pk=pk)
