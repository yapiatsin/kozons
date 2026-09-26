from django.utils import timezone

from accounts.serializers import user_brief


def _iso(dt):
    return dt.isoformat() if dt else None


def reply_preview(msg):
    if msg is None:
        return None
    return {
        'id': msg.pk,
        'sender_id': msg.sender_id,
        'sender_name': msg.sender.name if msg.sender else '',
        'kind': msg.kind,
        'text': '' if msg.deleted else msg.text[:200],
        'file': msg.file.url if msg.file and msg.kind in ('image', 'video', 'sticker') and not msg.view_once and not msg.deleted else None,
        'deleted': msg.deleted,
    }


def post_preview(post):
    if post is None:
        return None
    first = next(iter(post.media.all()), None)
    return {
        'id': post.pk,
        'author': {'id': post.author_id, 'username': post.author.username, 'name': post.author.name,
                   'avatar': post.author.avatar.url if post.author.avatar else None},
        'caption': post.caption[:200],
        'media': first.file.url if first else None,
        'media_kind': first.kind if first else None,
    }


def story_preview(story):
    if story is None:
        return None
    return {
        'id': story.pk,
        'kind': story.kind,
        'file': story.file.url if story.file else None,
        'text': story.text[:100],
        'background': story.background,
        'expired': story.expires_at is not None and story.expires_at <= timezone.now(),
    }


def message_data(msg, viewer=None, starred_ids=None, opened_ids=None):
    """Représentation JSON d'un message. `viewer=None` : version diffusée à tous."""
    viewer_id = getattr(viewer, 'pk', None)
    hide_file = msg.deleted or (
        msg.view_once and msg.sender_id != viewer_id
    )
    data = {
        'id': msg.pk,
        'conversation_id': msg.conversation_id,
        'sender_id': msg.sender_id,
        'sender': user_brief(msg.sender) if msg.sender else None,
        'kind': msg.kind,
        'text': '' if msg.deleted else msg.text,
        'file': None if hide_file or not msg.file else msg.file.url,
        'file_name': '' if msg.deleted else msg.file_name,
        'file_size': msg.file_size,
        'duration': msg.duration,
        'reply_to': None if msg.deleted else reply_preview(msg.reply_to),
        'forwarded': msg.forwarded,
        'view_once': msg.view_once,
        'opened': bool(opened_ids and msg.pk in opened_ids),
        'latitude': None if msg.deleted else msg.latitude,
        'longitude': None if msg.deleted else msg.longitude,
        'shared_post': None if msg.deleted else post_preview(msg.shared_post),
        'story': None if msg.deleted else story_preview(msg.story),
        'contact': None if msg.deleted else user_brief(msg.contact_user),
        'sticker_id': None if msg.deleted else msg.sticker_id,
        'mentions': [] if msg.deleted else [{'id': u.pk, 'name': u.name, 'username': u.username} for u in msg.mentions.all()],
        'created_at': _iso(msg.created_at),
        'edited_at': _iso(msg.edited_at),
        'expires_at': _iso(msg.expires_at),
        'deleted': msg.deleted,
        'reactions': [] if msg.deleted else [{'user_id': r.user_id, 'emoji': r.emoji} for r in msg.reactions.all()],
        'starred': bool(starred_ids and msg.pk in starred_ids),
        'poll': None,
    }
    if msg.kind == 'poll' and not msg.deleted:
        options = list(msg.poll_options.all())
        data['poll'] = {
            'multiple': any(o.multiple for o in options),
            'options': [{'id': o.pk, 'text': o.text, 'votes': [v.user_id for v in o.votes.all()]} for o in options],
        }
    return data


MESSAGE_RELATED = ('sender', 'reply_to__sender', 'shared_post__author', 'story', 'contact_user')
MESSAGE_PREFETCH = ('reactions', 'poll_options__votes', 'shared_post__media', 'mentions')


def participant_data(p, viewer=None):
    return {
        'user': user_brief(p.user, viewer),
        'role': p.role,
        'last_read_id': p.last_read_id if p.user.read_receipts else 0,
        'last_delivered_id': p.last_delivered_id,
    }


def conversation_data(conv, me_part, viewer, participants, last_message=None, unread=0, blocked=None, unread_mentions=0):
    return {
        'id': conv.pk,
        'kind': conv.kind,
        'title': conv.title,
        'description': conv.description,
        'avatar': conv.avatar.url if conv.avatar else None,
        'created_by': conv.created_by_id,
        'created_at': _iso(conv.created_at),
        'updated_at': _iso(conv.updated_at),
        'only_admins_can_send': conv.only_admins_can_send,
        'only_admins_can_edit': conv.only_admins_can_edit,
        'disappearing_seconds': conv.disappearing_seconds,
        'participants': [participant_data(p, viewer) for p in participants],
        'me': {
            'role': me_part.role,
            'pinned': me_part.pinned,
            'archived': me_part.archived,
            'muted_until': _iso(me_part.muted_until),
            'marked_unread': me_part.marked_unread,
            'last_read_id': me_part.last_read_id,
            'cleared_before_id': me_part.cleared_before_id,
        },
        'unread': unread,
        'unread_mentions': unread_mentions,
        'last_message': last_message,
        'blocked': blocked or {'by_me': False, 'by_them': False},
    }


def call_data(call, viewer=None):
    return {
        'id': call.pk,
        'caller': user_brief(call.caller, viewer),
        'callee': user_brief(call.callee, viewer),
        'video': call.video,
        'status': call.status,
        'started_at': _iso(call.started_at),
        'answered_at': _iso(call.answered_at),
        'ended_at': _iso(call.ended_at),
    }
