from datetime import datetime, timedelta

from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone

from accounts.models import User
from accounts.serializers import user_brief
from kozons.api import ApiError, api, as_bool, as_int, body, rate_limit

from . import ai, registry, services as svc
from .consumer import notify_invited
from .models import Meeting, MeetingAttendance, MeetingInvite, MeetingMessage, MeetingNotes

MAX_INVITES = 100


def _parse_when(value):
    if not value:
        return None
    try:
        when = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        raise ApiError('Date de réunion invalide.')
    if timezone.is_naive(when):
        when = timezone.make_aware(when)
    return when


def _invitee_ids(request, raw):
    ids = {as_int(v) for v in (raw or []) if as_int(v)} - {request.user.pk}
    if len(ids) > MAX_INVITES:
        raise ApiError(f'{MAX_INVITES} invités au maximum.')
    return set(User.objects.filter(pk__in=ids, is_active=True).values_list('pk', flat=True))


def _visible_meetings(user):
    return Meeting.objects.filter(Q(host=user) | Q(invites__user=user)).distinct().select_related('host')


@api(['GET', 'POST'])
def meetings(request):
    """GET : réunions programmées (organisées ou invitées) + réunions récentes. POST : créer."""
    if request.method == 'POST':
        return create_meeting(request)
    user = request.user
    now = timezone.now()
    try:
        start = _parse_when(request.GET.get('from')) or now - timedelta(days=1)
    except ApiError:
        start = now - timedelta(days=1)
    end = start + timedelta(days=int(request.GET.get('days') or 30))
    scheduled = _visible_meetings(user).filter(scheduled_at__gte=start, scheduled_at__lt=end, cancelled=False).order_by('scheduled_at')
    recent_ids = (MeetingAttendance.objects.filter(user=user).order_by('-joined_at')
                  .values_list('meeting_id', flat=True)[:60])
    seen, recent = set(), []
    for mid in recent_ids:
        if mid not in seen:
            seen.add(mid)
            recent.append(mid)
    recent_meetings = {m.pk: m for m in Meeting.objects.filter(pk__in=recent[:12]).select_related('host')}
    return {
        'scheduled': [svc.meeting_data(m, user, invites=False) for m in scheduled[:200]],
        'recent': [svc.meeting_data(recent_meetings[i], user, invites=False) for i in recent[:12] if i in recent_meetings],
        'ai_enabled': ai.enabled(),
        'media_mode': svc.media_mode(),
    }


def create_meeting(request):
    rate_limit(request, 'meet-create', 60, 3600)
    data = body(request)
    meeting = Meeting(
        host=request.user,
        title=(data.get('title') or '').strip()[:120],
        description=(data.get('description') or '').strip()[:2000],
        scheduled_at=_parse_when(data.get('scheduled_at')),
        duration_minutes=max(5, min(as_int(data.get('duration_minutes'), 60), 24 * 60)),
    )
    if data.get('access') in (Meeting.OPEN, Meeting.TRUSTED, Meeting.RESTRICTED):
        meeting.access = data['access']
    if 'notes_auto' in data:
        meeting.notes_auto = as_bool(data['notes_auto'])
    # Code unique (collision très improbable : 26^10 combinaisons).
    while Meeting.objects.filter(code=meeting.code).exists():
        meeting.code = Meeting._meta.get_field('code').default()
    meeting.save()
    invitees = _invitee_ids(request, data.get('invitees'))
    cohosts = {as_int(v) for v in data.get('cohosts') or []}
    MeetingInvite.objects.bulk_create([MeetingInvite(meeting=meeting, user_id=u, cohost=u in cohosts) for u in invitees])
    notify_invited(meeting, invitees, request.user)
    return svc.meeting_data(meeting, request.user)


def _meeting(request, code):
    meeting = Meeting.objects.select_related('host').filter(code=svc.normalize_code(code)).first()
    if meeting is None:
        raise ApiError("Cette réunion n'existe pas. Vérifiez le code ou le lien.", 404)
    return meeting


@api(['GET'])
def meeting_detail(request, code):
    """Écran d'accueil de la réunion : rôle, accès, personnes déjà présentes (aperçu)."""
    meeting = _meeting(request, code)
    data = svc.meeting_data(meeting, request.user)
    decision = svc.entry(meeting, request.user)
    data['entry'] = decision if decision in ('join', 'ask') else 'denied'
    data['denied_reason'] = None if decision in ('join', 'ask') else decision
    present = User.objects.filter(pk__in=registry.user_ids(meeting.pk)[:6])
    data['present'] = [user_brief(u, request.user) for u in present]
    data['ai_enabled'] = ai.enabled()
    return data


@api(['POST'])
def meeting_update(request, code):
    meeting = _meeting(request, code)
    if not svc.is_manager(svc.role_of(meeting, request.user)):
        raise ApiError("Seul l'organisateur peut modifier la réunion.", 403)
    data = body(request)
    fields = []
    for field, limit in (('title', 120), ('description', 2000)):
        if field in data:
            setattr(meeting, field, (data.get(field) or '').strip()[:limit])
            fields.append(field)
    if 'scheduled_at' in data:
        meeting.scheduled_at = _parse_when(data.get('scheduled_at'))
        fields.append('scheduled_at')
    if 'duration_minutes' in data:
        meeting.duration_minutes = max(5, min(as_int(data.get('duration_minutes'), 60), 24 * 60))
        fields.append('duration_minutes')
    if data.get('access') in (Meeting.OPEN, Meeting.TRUSTED, Meeting.RESTRICTED):
        meeting.access = data['access']
        fields.append('access')
    if 'notes_auto' in data:
        meeting.notes_auto = as_bool(data['notes_auto'])
        fields.append('notes_auto')
    if fields:
        meeting.save(update_fields=fields)
    if 'invitees' in data and meeting.host_id == request.user.pk:
        wanted = _invitee_ids(request, data.get('invitees'))
        cohosts = {as_int(v) for v in data.get('cohosts') or []}
        existing = set(meeting.invites.values_list('user_id', flat=True))
        meeting.invites.exclude(user_id__in=wanted).delete()
        MeetingInvite.objects.bulk_create([MeetingInvite(meeting=meeting, user_id=u) for u in wanted - existing])
        for invite in meeting.invites.all():
            if invite.cohost != (invite.user_id in cohosts):
                invite.cohost = invite.user_id in cohosts
                invite.save(update_fields=['cohost'])
        notify_invited(meeting, wanted - existing, request.user)
    if data.get('add_invitees'):
        # Ajout pendant la réunion (organisateur ou co-organisateur) : jamais de retrait.
        added = _invitee_ids(request, data.get('add_invitees')) - set(meeting.invites.values_list('user_id', flat=True))
        MeetingInvite.objects.bulk_create([MeetingInvite(meeting=meeting, user_id=u) for u in added])
        notify_invited(meeting, added, request.user)
    return svc.meeting_data(meeting, request.user)


@api(['POST'])
def meeting_cancel(request, code):
    meeting = _meeting(request, code)
    if meeting.host_id != request.user.pk:
        raise ApiError("Seul l'organisateur peut annuler la réunion.", 403)
    meeting.cancelled = True
    meeting.save(update_fields=['cancelled'])
    from chat.realtime import push
    invitees = list(meeting.invites.values_list('user_id', flat=True))
    push(invitees, 'meet.cancelled', {'code': meeting.code, 'label': meeting.label})
    return {'ok': True}


@api(['GET'])
def meeting_messages(request, code):
    meeting = _meeting(request, code)
    if svc.role_of(meeting, request.user) == 'guest' and not registry.is_admitted_user(meeting.pk, request.user.pk):
        raise ApiError('Accès refusé.', 403)
    qs = MeetingMessage.objects.filter(meeting=meeting).select_related('user').order_by('-id')[:300]
    return {'results': [svc.message_data(m) for m in reversed(list(qs))]}


# ---------------------------------------------------------------- notes IA

def _notes_for(user):
    return MeetingNotes.objects.filter(Q(recipients=user) | Q(meeting__host=user)).distinct().select_related('meeting__host')


@api(['GET'])
def notes_list(request):
    qs = _notes_for(request.user).exclude(status=MeetingNotes.RECORDING).order_by('-started_at')[:100]
    return {'results': [svc.notes_summary_data(n, request.user) for n in qs], 'ai_enabled': ai.enabled()}


@api(['GET'])
def notes_detail(request, pk):
    notes = get_object_or_404(_notes_for(request.user), pk=pk)
    start = notes.started_at
    chat = MeetingMessage.objects.filter(meeting=notes.meeting, created_at__gte=start).select_related('user')
    if notes.ended_at:
        chat = chat.filter(created_at__lte=notes.ended_at)
    return {
        **svc.notes_summary_data(notes, request.user),
        'summary': notes.summary,
        'error': notes.error,
        'model': notes.model,
        'can_retry': notes.meeting.host_id == request.user.pk and notes.status in (MeetingNotes.FAILED, MeetingNotes.NO_AI) and ai.enabled(),
        'transcript': [
            {'speaker': line.speaker, 'text': line.text, 'offset': int((line.spoken_at - start).total_seconds())}
            for line in notes.lines.all()
        ],
        'chat': [{'name': m.user.name, 'text': m.text, 'offset': int((m.created_at - start).total_seconds())} for m in chat],
        'participants': [user_brief(u, request.user) for u in notes.recipients.all()[:200]],
    }


@api(['POST'])
def notes_retry(request, pk):
    notes = get_object_or_404(MeetingNotes, pk=pk, meeting__host=request.user)
    if not ai.enabled():
        raise ApiError("L'IA n'est pas configurée sur ce serveur.")
    if notes.status not in (MeetingNotes.FAILED, MeetingNotes.NO_AI):
        raise ApiError('Ces notes ne peuvent pas être régénérées.')
    rate_limit(request, 'meet-notes-retry', 10, 3600)
    notes.status = MeetingNotes.PROCESSING
    notes.save(update_fields=['status'])
    ai.summarize_async(notes.pk)
    return svc.notes_summary_data(notes, request.user)


@api(['POST'])
def notes_delete(request, pk):
    notes = get_object_or_404(_notes_for(request.user), pk=pk)
    if notes.meeting.host_id == request.user.pk:
        notes.delete()
    else:
        notes.recipients.remove(request.user)
    return {'ok': True}
