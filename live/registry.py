"""Qui regarde quel live, en temps réel (en mémoire, un seul processus Daphne).

Chaque connexion WebSocket (canal) est comptée une fois ; un utilisateur sur deux appareils
compte donc deux fois, comme les « vues en cours » de TikTok.
"""
import threading

_lock = threading.Lock()
_viewers = {}  # live_id -> {channel: user_id}
_hosts = {}    # live_id -> canal de l'animateur


def join(live_id, channel, user_id):
    with _lock:
        _viewers.setdefault(live_id, {})[channel] = user_id
        return len(_viewers[live_id])


def leave(live_id, channel):
    with _lock:
        viewers = _viewers.get(live_id, {})
        viewers.pop(channel, None)
        if not viewers:
            _viewers.pop(live_id, None)
        return len(viewers)


def count(live_id):
    with _lock:
        return len(_viewers.get(live_id, {}))


def viewer_ids(live_id):
    with _lock:
        return list(dict.fromkeys(_viewers.get(live_id, {}).values()))


def channels_of(live_id, user_id=None):
    with _lock:
        return [c for c, u in _viewers.get(live_id, {}).items() if user_id is None or u == user_id]


def is_viewer_channel(live_id, channel):
    with _lock:
        return channel in _viewers.get(live_id, {})


def set_host(live_id, channel):
    with _lock:
        if channel is None:
            _hosts.pop(live_id, None)
        else:
            _hosts[live_id] = channel


def host_channel(live_id):
    with _lock:
        return _hosts.get(live_id)


def forget(live_id):
    with _lock:
        _viewers.pop(live_id, None)
        _hosts.pop(live_id, None)


def reset():
    with _lock:
        _viewers.clear()
        _hosts.clear()
