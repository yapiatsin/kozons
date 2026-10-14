"""Règles de Kozons Meet : rôles, admission, sérialisation, jetons du serveur média, notes IA."""
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone

from accounts.models import Block
from accounts.serializers import user_brief

from . import registry
from .models import Meeting, MeetingAttendance, MeetingInvite, MeetingNotes

TOKEN_SALT = 'kozons.meet-media'
TOKEN_MAX_AGE = 12 * 3600
MEDIA_PREFIX = 'mt_'


def group(meeting_id):
    return f'meet_{meeting_id}'


def broadcast(meeting_id, event, data):
    """Événement pour toutes les connexions admises dans la réunion."""
    def send():
        layer = get_channel_layer()
        if layer:
            async_to_sync(layer.group_send)(group(meeting_id), {'type': 'deliver', 'event': event, 'data': data})
    transaction.on_commit(send)


def send_to_channel(channel, event, data):
    layer = get_channel_layer()
    if layer and channel:
        async_to_sync(layer.send)(channel, {'type': 'deliver', 'event': event, 'data': data})


def normalize_code(value):
    """Accepte un code (« abc-defg-hij », « abcdefghij ») ou un lien complet vers la réunion."""
    raw = (value or '').strip().lower().rstrip('/')
    if '/' in raw:
        raw = raw.rsplit('/', 1)[-1]
    letters = ''.join(ch for ch in raw if ch.isalpha())
    if len(letters) == 10:
        return f'{letters[:3]}-{letters[3:7]}-{letters[7:]}'
    return raw


# ---------------------------------------------------------------- rôles et admission

def role_of(meeting, user):
    if meeting.host_id == user.pk:
        return 'host'
    invite = MeetingInvite.objects.filter(meeting=meeting, user=user).first()
    if invite is None:
        return 'guest'
    return 'cohost' if invite.cohost else 'invited'


def is_manager(role):
    return role in ('host', 'cohost')


def entry(meeting, user):
    """'join' (entre directement), 'ask' (salle d'attente) ou un message de refus."""
    if meeting.cancelled:
        return 'Cette réunion a été annulée.'
    if meeting.host_id != user.pk and Block.between(user, meeting.host):
        return "Vous ne pouvez pas rejoindre cette réunion."
    role = role_of(meeting, user)
    if role != 'guest' or meeting.access == Meeting.OPEN:
        return 'join'
    if meeting.access == Meeting.RESTRICTED:
        return "Cette réunion est réservée aux personnes invitées."
    return 'ask'


# ---------------------------------------------------------------- sérialisation

def settings_data(meeting):
    return {
        'access': meeting.access, 'chat_enabled': meeting.chat_enabled, 'reactions_enabled': meeting.reactions_enabled,
        'present_allowed': meeting.present_allowed, 'mic_allowed': meeting.mic_allowed, 'cam_allowed': meeting.cam_allowed,
        'notes_share': meeting.notes_share, 'notes_auto': meeting.notes_auto, 'language': meeting.language,
    }


def meeting_data(meeting, viewer, *, invites=True):
    role = role_of(meeting, viewer)
    data = {
        'id': meeting.pk,
        'code': meeting.code,
        'title': meeting.title,
        'label': meeting.label,
        'description': meeting.description,
        'host': user_brief(meeting.host, viewer),
        'scheduled_at': meeting.scheduled_at.isoformat() if meeting.scheduled_at else None,
        'duration_minutes': meeting.duration_minutes,
        'created_at': meeting.created_at.isoformat(),
        'cancelled': meeting.cancelled,
        'role': role,
        'is_manager': is_manager(role),
        'in_progress': registry.count(meeting.pk) > 0,
        'participants_now': registry.count(meeting.pk),
        'settings': settings_data(meeting),
        'url': f'/meet/{meeting.code}',
    }
    if invites and (is_manager(role) or role == 'invited'):
        data['invites'] = [
            {**user_brief(i.user, viewer), 'cohost': i.cohost}
            for i in meeting.invites.select_related('user').order_by('created_at')
        ]
    return data


def peer_data(peer, users):
    user = users.get(peer['user_id'])
    return {
        'peer': peer['peer'], 'user': user_brief(user) if user else None, 'role': peer['role'],
        'mic': peer['mic'], 'cam': peer['cam'], 'hand': peer['hand'], 'screen': peer['screen'],
        'joined_at': peer['joined_at'],
    }


def peers_list(meeting_id):
    from accounts.models import User
    current = registry.peers(meeting_id)
    users = {u.pk: u for u in User.objects.filter(pk__in={p['user_id'] for p in current.values()})}
    return [peer_data(p, users) for p in sorted(current.values(), key=lambda p: p['joined_at'])]


def waiting_list(meeting_id):
    from accounts.models import User
    current = registry.waiting(meeting_id)
    users = {u.pk: u for u in User.objects.filter(pk__in={w['user_id'] for w in current.values()})}
    return [{'id': w['id'], 'user': user_brief(users.get(w['user_id'])), 'since': w['since']}
            for w in sorted(current.values(), key=lambda w: w['since']) if users.get(w['user_id'])]


def message_data(m):
    return {'id': m.pk, 'user': user_brief(m.user), 'text': m.text, 'created_at': m.created_at.isoformat()}


# ---------------------------------------------------------------- serveur média (MediaMTX, comme les lives)

def media_mode():
    return 'sfu' if settings.LIVE_MEDIA_URL else 'p2p'


def media_path(meeting, peer_id, kind):
    return f'{MEDIA_PREFIX}{meeting.media_key}_{peer_id}_{kind}'


def media_info(meeting, user, peer_id):
    """Publication de ses propres flux (caméra, écran) et lecture de ceux des autres participants."""
    if media_mode() != 'sfu':
        return {'mode': 'p2p'}
    publish = signing.dumps({'m': meeting.pk, 'u': user.pk, 'p': peer_id, 'a': 'publish'}, salt=TOKEN_SALT)
    read = signing.dumps({'m': meeting.pk, 'u': user.pk, 'a': 'read'}, salt=TOKEN_SALT)
    return {
        'mode': 'sfu', 'base': settings.LIVE_MEDIA_URL, 'prefix': f'{MEDIA_PREFIX}{meeting.media_key}_',
        'publish_token': publish, 'read_token': read,
    }


def check_media_token(token, path, action):
    """Appelé par MediaMTX (via live.views.media_auth) pour les chemins « mt_… »."""
    try:
        payload = signing.loads(token, salt=TOKEN_SALT, max_age=TOKEN_MAX_AGE)
    except signing.BadSignature:
        return False
    if payload.get('a') != action:
        return False
    meeting = Meeting.objects.filter(pk=payload.get('m'), cancelled=False).first()
    if meeting is None or not path.startswith(f'{MEDIA_PREFIX}{meeting.media_key}_'):
        return False
    user_id = payload.get('u')
    if not registry.is_admitted_user(meeting.pk, user_id):
        return False
    if action == 'publish':
        peer_id = payload.get('p')
        return path in (media_path(meeting, peer_id, 'cam'), media_path(meeting, peer_id, 'scr'))
    return True


# ---------------------------------------------------------------- séances, présences, fin

def mark_joined(meeting, user):
    now = timezone.now()
    if registry.count(meeting.pk) <= 1:
        Meeting.objects.filter(pk=meeting.pk).update(started_at=now, ended_at=None)
    return MeetingAttendance.objects.create(meeting=meeting, user=user, joined_at=now)


def mark_left(meeting_id, user_id):
    att = MeetingAttendance.objects.filter(meeting_id=meeting_id, user_id=user_id, left_at__isnull=True).order_by('-joined_at').first()
    if att:
        att.left_at = timezone.now()
        att.save(update_fields=['left_at'])


def close_session(meeting_id):
    """Plus personne : fin de la séance, arrêt de la prise de notes (le compte rendu est rédigé)."""
    Meeting.objects.filter(pk=meeting_id).update(ended_at=timezone.now())
    MeetingAttendance.objects.filter(meeting_id=meeting_id, left_at__isnull=True).update(left_at=timezone.now())
    stop_notes(meeting_id)
    registry.forget(meeting_id)


# ---------------------------------------------------------------- notes IA

def start_notes(meeting, user):
    current = registry.notes(meeting.pk)
    if current:
        return MeetingNotes.objects.get(pk=current)
    notes = MeetingNotes.objects.create(meeting=meeting, started_by=user)
    registry.set_notes(meeting.pk, notes.pk)
    _add_recipients(notes, registry.user_ids(meeting.pk))
    broadcast(meeting.pk, 'meet.notes', notes_state(meeting.pk))
    return notes


def stop_notes(meeting_id):
    notes_id = registry.notes(meeting_id)
    registry.set_notes(meeting_id, None)
    if not notes_id:
        return None
    notes = MeetingNotes.objects.select_related('meeting').filter(pk=notes_id, status=MeetingNotes.RECORDING).first()
    if notes is None:
        return None
    notes.ended_at = timezone.now()
    notes.status = MeetingNotes.PROCESSING
    notes.save(update_fields=['ended_at', 'status'])
    broadcast(meeting_id, 'meet.notes', notes_state(meeting_id))
    from . import ai
    transaction.on_commit(lambda: ai.summarize_async(notes.pk))
    return notes


def _add_recipients(notes, user_ids):
    meeting = notes.meeting
    ids = set(user_ids) | {meeting.host_id} | set(meeting.invites.filter(cohost=True).values_list('user_id', flat=True))
    if meeting.notes_share == 'hosts':
        ids &= {meeting.host_id} | set(meeting.invites.filter(cohost=True).values_list('user_id', flat=True))
    notes.recipients.add(*ids)


def add_notes_recipient(meeting, user_id):
    notes_id = registry.notes(meeting.pk)
    if notes_id:
        notes = MeetingNotes.objects.select_related('meeting').get(pk=notes_id)
        _add_recipients(notes, [user_id])


def notes_state(meeting_id):
    notes_id = registry.notes(meeting_id)
    started = None
    if notes_id:
        started = MeetingNotes.objects.filter(pk=notes_id).values_list('started_at', flat=True).first()
    return {
        'meeting_id': meeting_id, 'active': bool(notes_id), 'notes_id': notes_id,
        'started_at': started.isoformat() if started else None,
        'transcribe': bool(notes_id) or registry.captions_wanted(meeting_id),
        'ai_enabled': bool(settings.ANTHROPIC_API_KEY),
    }


def notes_summary_data(notes, viewer):
    return {
        'id': notes.pk,
        'meeting': {'code': notes.meeting.code, 'label': notes.meeting.label, 'host': user_brief(notes.meeting.host, viewer)},
        'started_at': notes.started_at.isoformat(),
        'ended_at': notes.ended_at.isoformat() if notes.ended_at else None,
        'status': notes.status,
        'title': (notes.summary or {}).get('title') or notes.meeting.label,
        'overview': ((notes.summary or {}).get('summary') or '')[:220],
    }
