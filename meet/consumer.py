"""Temps réel de Kozons Meet, greffé sur la connexion WebSocket unique (chat.consumers.KozonsConsumer).

Méthodes synchrones exécutées dans un thread (database_sync_to_async), comme pour les lives.
"""
import time

from asgiref.sync import async_to_sync
from django.utils import timezone

from accounts.models import User
from accounts.push import send_to_users
from accounts.serializers import user_brief
from chat.realtime import push

from . import registry, services as svc
from .models import Meeting, MeetingInvite, MeetingMessage, TranscriptLine

REACTIONS = ['💖', '👍', '🎉', '👏', '😂', '😮', '😢', '🤔', '👎']
SETTINGS_FIELDS = {
    'access': lambda v: v if v in (Meeting.OPEN, Meeting.TRUSTED, Meeting.RESTRICTED) else None,
    'chat_enabled': bool, 'reactions_enabled': bool, 'present_allowed': bool, 'mic_allowed': bool, 'cam_allowed': bool,
    'notes_share': lambda v: v if v in ('all', 'hosts') else None, 'notes_auto': bool,
    'language': lambda v: v if isinstance(v, str) and 2 <= len(v) <= 8 else None,
}


class MeetConsumerMixin:
    MEET_HANDLERS = {
        'meet.join': '_meet_join', 'meet.cancel_wait': '_meet_cancel_wait', 'meet.admit': '_meet_admit',
        'meet.leave': '_meet_leave', 'meet.state': '_meet_state', 'meet.chat': '_meet_chat',
        'meet.react': '_meet_react', 'meet.mute': '_meet_mute', 'meet.lower_hand': '_meet_lower_hand',
        'meet.remove': '_meet_remove', 'meet.end': '_meet_end', 'meet.settings': '_meet_settings',
        'meet.cohost': '_meet_cohost', 'meet.signal': '_meet_signal', 'meet.caption': '_meet_caption',
        'meet.captions': '_meet_captions', 'meet.notes': '_meet_notes', 'meet.catchup': '_meet_catchup',
    }

    def _meet_init(self):
        self.meet_rooms = set()     # réunions où cette connexion est admise
        self.meet_waiting = set()   # réunions où elle attend d'être admise
        self._meet_last = {}

    # ------------------------------------------------------------ outils

    def _meeting(self, content):
        meeting_id = content.get('meeting_id')
        if meeting_id:
            meeting = Meeting.objects.select_related('host').filter(pk=int(meeting_id)).first()
        else:
            meeting = Meeting.objects.select_related('host').filter(code=svc.normalize_code(content.get('code'))).first()
        if meeting is None:
            raise ValueError('Réunion introuvable.')
        return meeting

    def _me_in(self, meeting_id, manager=False):
        """Pair de cette connexion dans la réunion (erreur si elle n'y est pas / plus)."""
        peer = registry.peer(int(meeting_id or 0), self.channel_name)
        if peer is None:
            raise ValueError("Vous n'êtes pas dans cette réunion.")
        if manager and not svc.is_manager(peer['role']):
            raise ValueError("Réservé à l'organisateur.")
        return peer

    def _meet_throttle(self, key, interval):
        now = time.monotonic()
        if now - self._meet_last.get(key, 0) < interval:
            return True
        self._meet_last[key] = now
        return False

    def _meet_group(self, meeting_id, add=True, channel=None):
        fn = self.channel_layer.group_add if add else self.channel_layer.group_discard
        async_to_sync(fn)(svc.group(meeting_id), channel or self.channel_name)

    def _notify_managers_waiting(self, meeting):
        data = {'meeting_id': meeting.pk, 'waiting': svc.waiting_list(meeting.pk)}
        for channel in registry.manager_channels(meeting.pk):
            svc.send_to_channel(channel, 'meet.waiting_list', data)

    def _broadcast_peer(self, meeting_id, channel):
        peer = registry.peer(meeting_id, channel)
        if peer:
            users = {u.pk: u for u in User.objects.filter(pk=peer['user_id'])}
            svc.broadcast(meeting_id, 'meet.peer', {'meeting_id': meeting_id, **svc.peer_data(peer, users)})

    # ------------------------------------------------------------ arrivée, salle d'attente

    def _meet_join(self, content):
        meeting = self._meeting(content)
        user = User.objects.get(pk=self.user.pk)
        decision = svc.entry(meeting, user)
        if decision not in ('join', 'ask'):
            raise ValueError(decision)
        if registry.peer(meeting.pk, self.channel_name):
            return self._meet_welcome(meeting, user)
        waiting = registry.waiting(meeting.pk).get(self.channel_name)
        if decision == 'ask' and not (waiting and waiting.get('approved')):
            if not waiting:
                registry.wait(meeting.pk, self.channel_name, user.pk)
                self.meet_waiting.add(meeting.pk)
                self._notify_managers_waiting(meeting)
                if not registry.manager_channels(meeting.pk):
                    # Organisateur absent : il est prévenu (il peut ouvrir la réunion pour admettre).
                    send_to_users([meeting.host_id], {
                        'kind': 'meet', 'title': f'🙋 {user.name} attend dans votre réunion',
                        'body': meeting.label, 'url': f'/meet/{meeting.code}', 'tag': f'meet-knock-{meeting.pk}',
                    }, ttl=600, urgency='high', only_offline=False)
            return {'type': 'meet.waiting', 'data': {
                'meeting_id': meeting.pk, 'managers_present': bool(registry.manager_channels(meeting.pk))}}
        return self._meet_enter(meeting, user, bool(content.get('mic', True)), bool(content.get('cam', True)))

    def _meet_enter(self, meeting, user, mic, cam):
        role = svc.role_of(meeting, user)
        if not svc.is_manager(role):
            mic = mic and meeting.mic_allowed
            cam = cam and meeting.cam_allowed
        registry.admit(meeting.pk, self.channel_name, user.pk, mic=mic, cam=cam, role=role)
        self.meet_waiting.discard(meeting.pk)
        self.meet_rooms.add(meeting.pk)
        self._meet_group(meeting.pk)
        svc.mark_joined(meeting, user)
        svc.add_notes_recipient(meeting, user.pk)
        self._broadcast_peer(meeting.pk, self.channel_name)
        self._notify_managers_waiting(meeting)
        if meeting.notes_auto and registry.count(meeting.pk) == 1 and svc.is_manager(role):
            svc.start_notes(meeting, user)
        return self._meet_welcome(meeting, user)

    def _meet_welcome(self, meeting, user):
        me = registry.peer(meeting.pk, self.channel_name)
        messages = MeetingMessage.objects.filter(meeting=meeting).select_related('user')
        if meeting.started_at:
            messages = messages.filter(created_at__gte=meeting.started_at)
        return {'type': 'meet.joined', 'data': {
            'meeting': svc.meeting_data(meeting, user),
            'me': me['peer'],
            'peers': svc.peers_list(meeting.pk),
            'waiting': svc.waiting_list(meeting.pk) if svc.is_manager(me['role']) else [],
            'messages': [svc.message_data(m) for m in list(messages.order_by('-id')[:200])[::-1]],
            'notes': svc.notes_state(meeting.pk),
            'media': svc.media_info(meeting, user, me['peer']),
            'reactions': REACTIONS,
        }}

    def _meet_cancel_wait(self, content):
        meeting = self._meeting(content)
        registry.unwait(meeting.pk, self.channel_name)
        self.meet_waiting.discard(meeting.pk)
        self._notify_managers_waiting(meeting)
        return None

    def _meet_admit(self, content):
        meeting = self._meeting(content)
        self._me_in(meeting.pk, manager=True)
        allow = bool(content.get('allow', True))
        waiting = registry.waiting(meeting.pk)
        if content.get('all'):
            targets = list(waiting)
        else:
            channel = registry.waiting_channel(meeting.pk, content.get('request_id'))
            targets = [channel] if channel else []
        for channel in targets:
            if allow:
                # La personne refait « meet.join » depuis son appareil : elle est alors admise.
                registry.approve(meeting.pk, channel)
                svc.send_to_channel(channel, 'meet.admitted', {'meeting_id': meeting.pk})
            else:
                registry.unwait(meeting.pk, channel)
                svc.send_to_channel(channel, 'meet.denied', {'meeting_id': meeting.pk})
        self._notify_managers_waiting(meeting)
        return None

    # ------------------------------------------------------------ départ

    def _meet_leave(self, content):
        self._meet_exit(int(content.get('meeting_id') or 0))
        return None

    def _meet_exit(self, meeting_id, channel=None):
        channel = channel or self.channel_name
        if channel == self.channel_name:
            self.meet_rooms.discard(meeting_id)
            if meeting_id in self.meet_waiting:
                self.meet_waiting.discard(meeting_id)
                registry.unwait(meeting_id, channel)
                meeting = Meeting.objects.filter(pk=meeting_id).first()
                if meeting:
                    self._notify_managers_waiting(meeting)
        peer, empty = registry.leave(meeting_id, channel)
        if peer is None:
            return
        self._meet_group(meeting_id, add=False, channel=channel)
        svc.mark_left(meeting_id, peer['user_id'])
        svc.broadcast(meeting_id, 'meet.peer_left', {'meeting_id': meeting_id, 'peer': peer['peer']})
        if empty:
            svc.close_session(meeting_id)
        else:
            # Ses sous-titres ne sont plus demandés : l'état de la transcription peut changer.
            svc.broadcast(meeting_id, 'meet.notes', svc.notes_state(meeting_id))

    def _meet_disconnect(self):
        for meeting_id in list(getattr(self, 'meet_rooms', ())) + list(getattr(self, 'meet_waiting', ())):
            self._meet_exit(meeting_id)

    # ------------------------------------------------------------ état : micro, caméra, main, écran

    def _meet_state(self, content):
        meeting = self._meeting(content)
        me = self._me_in(meeting.pk)
        manager = svc.is_manager(me['role'])
        changes = {}
        if 'mic' in content:
            if content['mic'] and not manager and not meeting.mic_allowed:
                raise ValueError("L'organisateur a désactivé les micros.")
            changes['mic'] = bool(content['mic'])
        if 'cam' in content:
            if content['cam'] and not manager and not meeting.cam_allowed:
                raise ValueError("L'organisateur a désactivé les caméras.")
            changes['cam'] = bool(content['cam'])
        if 'screen' in content:
            if content['screen'] and not manager and not meeting.present_allowed:
                raise ValueError("Seul l'organisateur peut présenter.")
            changes['screen'] = bool(content['screen'])
        if 'hand' in content:
            changes['hand'] = time.time() if content['hand'] else None
        if changes:
            registry.update(meeting.pk, self.channel_name, **changes)
            self._broadcast_peer(meeting.pk, self.channel_name)
        return None

    def _meet_lower_hand(self, content):
        meeting = self._meeting(content)
        self._me_in(meeting.pk, manager=True)
        targets = [c for c, p in registry.peers(meeting.pk).items() if p['hand']] if content.get('all') \
            else [registry.channel_of(meeting.pk, content.get('peer'))]
        for channel in filter(None, targets):
            registry.update(meeting.pk, channel, hand=None)
            self._broadcast_peer(meeting.pk, channel)
        return None

    # ------------------------------------------------------------ chat, réactions

    def _meet_chat(self, content):
        meeting = self._meeting(content)
        me = self._me_in(meeting.pk)
        if not meeting.chat_enabled and not svc.is_manager(me['role']):
            raise ValueError("L'organisateur a désactivé le chat.")
        text = (content.get('text') or '').strip()[:2000]
        if not text:
            return None
        if self._meet_throttle(('chat', meeting.pk), 0.5):
            raise ValueError('Doucement ! Attendez un instant.')
        message = MeetingMessage.objects.create(meeting=meeting, user_id=self.user.pk, text=text)
        message = MeetingMessage.objects.select_related('user').get(pk=message.pk)
        svc.broadcast(meeting.pk, 'meet.chat', {'meeting_id': meeting.pk, **svc.message_data(message)})
        return None

    def _meet_react(self, content):
        meeting = self._meeting(content)
        me = self._me_in(meeting.pk)
        emoji = content.get('emoji')
        if emoji not in REACTIONS or (not meeting.reactions_enabled and not svc.is_manager(me['role'])):
            return None
        if self._meet_throttle(('react', meeting.pk), 0.25):
            return None
        svc.broadcast(meeting.pk, 'meet.react', {'meeting_id': meeting.pk, 'peer': me['peer'], 'emoji': emoji})
        return None

    # ------------------------------------------------------------ gestion par l'organisateur

    def _meet_mute(self, content):
        meeting = self._meeting(content)
        me = self._me_in(meeting.pk, manager=True)
        if content.get('all'):
            targets = [c for c, p in registry.peers(meeting.pk).items() if not svc.is_manager(p['role']) and p['mic']]
        else:
            targets = [registry.channel_of(meeting.pk, content.get('peer'))]
        by = User.objects.get(pk=self.user.pk).name
        for channel in filter(None, targets):
            registry.update(meeting.pk, channel, mic=False)
            svc.send_to_channel(channel, 'meet.muted', {'meeting_id': meeting.pk, 'by': by, 'by_peer': me['peer']})
            self._broadcast_peer(meeting.pk, channel)
        return None

    def _meet_remove(self, content):
        meeting = self._meeting(content)
        self._me_in(meeting.pk, manager=True)
        channel = registry.channel_of(meeting.pk, content.get('peer'))
        target = registry.peer(meeting.pk, channel) if channel else None
        if target is None:
            raise ValueError('Participant introuvable.')
        if target['role'] == 'host':
            raise ValueError("L'organisateur ne peut pas être retiré.")
        svc.send_to_channel(channel, 'meet.removed', {'meeting_id': meeting.pk})
        self._meet_exit(meeting.pk, channel=channel)
        return None

    def _meet_end(self, content):
        meeting = self._meeting(content)
        self._me_in(meeting.pk, manager=True)
        svc.broadcast(meeting.pk, 'meet.ended', {'meeting_id': meeting.pk, 'by': User.objects.get(pk=self.user.pk).name})
        for channel in list(registry.peers(meeting.pk)) + list(registry.waiting(meeting.pk)):
            if channel != self.channel_name:
                svc.send_to_channel(channel, 'meet.ended', {'meeting_id': meeting.pk})
        self.meet_rooms.discard(meeting.pk)
        svc.close_session(meeting.pk)
        return None

    def _meet_settings(self, content):
        meeting = self._meeting(content)
        self._me_in(meeting.pk, manager=True)
        updated = []
        for field, cast in SETTINGS_FIELDS.items():
            if field in content:
                value = cast(content[field])
                if value is not None:
                    setattr(meeting, field, value)
                    updated.append(field)
        if not updated:
            return None
        meeting.save(update_fields=updated)
        svc.broadcast(meeting.pk, 'meet.settings', {'meeting_id': meeting.pk, 'settings': svc.settings_data(meeting)})
        # Micros / caméras / présentation désactivés : on coupe ceux des participants (hors organisateurs).
        for channel, peer in registry.peers(meeting.pk).items():
            if svc.is_manager(peer['role']):
                continue
            off = {}
            if 'mic_allowed' in updated and not meeting.mic_allowed and peer['mic']:
                off['mic'] = False
            if 'cam_allowed' in updated and not meeting.cam_allowed and peer['cam']:
                off['cam'] = False
            if 'present_allowed' in updated and not meeting.present_allowed and peer['screen']:
                off['screen'] = False
            if off:
                registry.update(meeting.pk, channel, **off)
                svc.send_to_channel(channel, 'meet.forced', {'meeting_id': meeting.pk, **off})
                self._broadcast_peer(meeting.pk, channel)
        return None

    def _meet_cohost(self, content):
        meeting = self._meeting(content)
        me = self._me_in(meeting.pk)
        if me['role'] != 'host':
            raise ValueError("Seul l'organisateur peut nommer des co-organisateurs.")
        channel = registry.channel_of(meeting.pk, content.get('peer'))
        target = registry.peer(meeting.pk, channel) if channel else None
        if target is None or target['role'] == 'host':
            raise ValueError('Participant introuvable.')
        on = bool(content.get('on', True))
        invite, _ = MeetingInvite.objects.get_or_create(meeting=meeting, user_id=target['user_id'])
        invite.cohost = on
        invite.save(update_fields=['cohost'])
        role = 'cohost' if on else 'invited'
        for c, p in registry.peers(meeting.pk).items():
            if p['user_id'] == target['user_id']:
                registry.update(meeting.pk, c, role=role)
                self._broadcast_peer(meeting.pk, c)
                if on:
                    svc.send_to_channel(c, 'meet.waiting_list', {'meeting_id': meeting.pk, 'waiting': svc.waiting_list(meeting.pk)})
        return None

    # ------------------------------------------------------------ vidéo pair-à-pair (sans serveur média)

    def _meet_signal(self, content):
        meeting_id = int(content.get('meeting_id') or 0)
        me = registry.peer(meeting_id, self.channel_name)
        target = registry.channel_of(meeting_id, content.get('to'))
        if me is None or target is None:
            return None
        svc.send_to_channel(target, 'meet.signal', {'meeting_id': meeting_id, 'from': me['peer'], 'data': content.get('data')})
        return None

    # ------------------------------------------------------------ sous-titres, notes IA

    def _meet_captions(self, content):
        meeting = self._meeting(content)
        self._me_in(meeting.pk)
        registry.set_captions(meeting.pk, self.channel_name, bool(content.get('on')))
        svc.broadcast(meeting.pk, 'meet.notes', svc.notes_state(meeting.pk))
        return None

    def _meet_caption(self, content):
        meeting_id = int(content.get('meeting_id') or 0)
        me = self._me_in(meeting_id)
        text = ' '.join((content.get('text') or '').split())[:1000]
        if not text:
            return None
        final = bool(content.get('final'))
        user = User.objects.get(pk=self.user.pk)
        svc.broadcast(meeting_id, 'meet.caption', {
            'meeting_id': meeting_id, 'peer': me['peer'], 'name': user.name, 'text': text, 'final': final,
            'seq': content.get('seq'),
        })
        notes_id = registry.notes(meeting_id)
        if final and notes_id:
            TranscriptLine.objects.create(notes_id=notes_id, user=user, speaker=user.name[:80], text=text)
        return None

    def _meet_notes(self, content):
        meeting = self._meeting(content)
        self._me_in(meeting.pk, manager=True)
        user = User.objects.get(pk=self.user.pk)
        if content.get('on'):
            svc.start_notes(meeting, user)
        else:
            svc.stop_notes(meeting.pk)
        return None

    def _meet_catchup(self, content):
        from . import ai
        meeting = self._meeting(content)
        self._me_in(meeting.pk)
        notes_id = registry.notes(meeting.pk)
        if not notes_id:
            raise ValueError("Activez la prise de notes pour obtenir un résumé de ce qui a été dit.")
        if not ai.enabled():
            raise ValueError("L'IA n'est pas configurée sur ce serveur (clé AI_API_KEY).")
        if self._meet_throttle(('catchup', meeting.pk), 30):
            raise ValueError('Résumé déjà demandé, patientez quelques secondes.')
        ai.catchup_async(notes_id, self.channel_name, meeting.pk)
        return {'type': 'meet.catchup', 'data': {'meeting_id': meeting.pk, 'pending': True}}


def notify_invited(meeting, user_ids, inviter):
    """Invitation : événement temps réel + notification push."""
    from .services import meeting_data
    user_ids = [u for u in set(user_ids) if u != inviter.pk]
    if not user_ids:
        return
    when = meeting.scheduled_at
    for uid in user_ids:
        viewer = User.objects.filter(pk=uid).first()
        if viewer:
            push([uid], 'meet.invited', {'meeting': meeting_data(meeting, viewer, invites=False), 'by': user_brief(inviter)})
    body = f"Le {timezone.localtime(when):%d/%m à %H:%M}" if when else 'Rejoignez la réunion maintenant'
    send_to_users(user_ids, {
        'kind': 'meet', 'title': f'📅 {inviter.name} vous invite : {meeting.label}', 'body': body,
        'url': f'/meet/{meeting.code}', 'tag': f'meet-invite-{meeting.pk}',
    }, ttl=86400)
