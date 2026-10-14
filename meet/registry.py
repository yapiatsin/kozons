"""Qui est dans quelle réunion, en temps réel (en mémoire, un seul processus Daphne, comme les lives).

Chaque connexion WebSocket admise reçoit un identifiant court (`peer`) : un même compte connecté
sur deux appareils apparaît deux fois, comme dans Google Meet.
"""
import secrets
import threading
import time

_lock = threading.Lock()
# meeting_id -> {'peers': {channel: {...}}, 'waiting': {channel: {...}}, 'notes': id|None, 'captions': set(channels)}
_rooms = {}


def _room(meeting_id):
    return _rooms.setdefault(meeting_id, {'peers': {}, 'waiting': {}, 'notes': None, 'captions': set()})


def new_peer_id():
    return secrets.token_hex(4)


def admit(meeting_id, channel, user_id, *, mic=True, cam=True, role='guest'):
    with _lock:
        room = _room(meeting_id)
        room['waiting'].pop(channel, None)
        existing = room['peers'].get(channel)
        if existing:
            return dict(existing), False
        peer = {
            'peer': new_peer_id(), 'user_id': user_id, 'role': role, 'mic': bool(mic), 'cam': bool(cam),
            'hand': None, 'screen': False, 'joined_at': time.time(),
        }
        room['peers'][channel] = peer
        return dict(peer), True


def leave(meeting_id, channel):
    """Retire la connexion ; renvoie (pair retiré ou None, salle désormais vide ?)."""
    with _lock:
        room = _rooms.get(meeting_id)
        if not room:
            return None, True
        peer = room['peers'].pop(channel, None)
        room['waiting'].pop(channel, None)
        room['captions'].discard(channel)
        empty = not room['peers']
        if empty and not room['waiting']:
            _rooms.pop(meeting_id, None)
        return peer, empty


def update(meeting_id, channel, **changes):
    with _lock:
        peer = _rooms.get(meeting_id, {}).get('peers', {}).get(channel)
        if peer is None:
            return None
        peer.update(changes)
        return dict(peer)


def peers(meeting_id):
    with _lock:
        return {c: dict(p) for c, p in _rooms.get(meeting_id, {}).get('peers', {}).items()}


def peer(meeting_id, channel):
    with _lock:
        p = _rooms.get(meeting_id, {}).get('peers', {}).get(channel)
        return dict(p) if p else None


def channel_of(meeting_id, peer_id):
    with _lock:
        for c, p in _rooms.get(meeting_id, {}).get('peers', {}).items():
            if p['peer'] == peer_id:
                return c
    return None


def user_ids(meeting_id):
    with _lock:
        return list(dict.fromkeys(p['user_id'] for p in _rooms.get(meeting_id, {}).get('peers', {}).values()))


def is_admitted_user(meeting_id, user_id):
    with _lock:
        return any(p['user_id'] == user_id for p in _rooms.get(meeting_id, {}).get('peers', {}).values())


def count(meeting_id):
    with _lock:
        return len(_rooms.get(meeting_id, {}).get('peers', {}))


def manager_channels(meeting_id):
    """Connexions de l'organisateur et des co-organisateurs (pour la salle d'attente)."""
    with _lock:
        return [c for c, p in _rooms.get(meeting_id, {}).get('peers', {}).items() if p['role'] in ('host', 'cohost')]


# ---------------------------------------------------------------- salle d'attente

def wait(meeting_id, channel, user_id):
    with _lock:
        _room(meeting_id)['waiting'][channel] = {'user_id': user_id, 'since': time.time(), 'id': new_peer_id()}
        return dict(_rooms[meeting_id]['waiting'][channel])


def waiting(meeting_id):
    with _lock:
        return {c: dict(w) for c, w in _rooms.get(meeting_id, {}).get('waiting', {}).items()}


def waiting_channel(meeting_id, request_id):
    with _lock:
        for c, w in _rooms.get(meeting_id, {}).get('waiting', {}).items():
            if w['id'] == request_id:
                return c
    return None


def approve(meeting_id, channel):
    """Admis par un organisateur : sa prochaine demande « meet.join » le fait entrer."""
    with _lock:
        entry = _rooms.get(meeting_id, {}).get('waiting', {}).get(channel)
        if entry:
            entry['approved'] = True


def unwait(meeting_id, channel):
    with _lock:
        room = _rooms.get(meeting_id)
        if room:
            room['waiting'].pop(channel, None)


# ---------------------------------------------------------------- notes et sous-titres

def set_notes(meeting_id, notes_id):
    with _lock:
        if notes_id is None and meeting_id not in _rooms:
            return
        _room(meeting_id)['notes'] = notes_id


def notes(meeting_id):
    with _lock:
        return _rooms.get(meeting_id, {}).get('notes')


def set_captions(meeting_id, channel, on):
    """Sous-titres demandés par cette connexion ; renvoie True si au moins une personne les veut."""
    with _lock:
        room = _rooms.get(meeting_id)
        if not room:
            return False
        if on and channel in room['peers']:
            room['captions'].add(channel)
        else:
            room['captions'].discard(channel)
        return bool(room['captions'])


def captions_wanted(meeting_id):
    with _lock:
        return bool(_rooms.get(meeting_id, {}).get('captions'))


def forget(meeting_id):
    with _lock:
        return _rooms.pop(meeting_id, None)


def reset():
    with _lock:
        _rooms.clear()
