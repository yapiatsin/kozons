"""Présence en temps réel, par appareil (connexion WebSocket).

- « connecté » : au moins une connexion ouverte (application ouverte, même en arrière-plan) ;
- « en ligne » : au moins une connexion *active*, c'est-à-dire onglet visible, fenêtre au premier
  plan et activité récente de l'utilisateur. C'est ce qui est affiché aux contacts.

Chaque connexion doit se manifester (ping) régulièrement : sans nouvelles depuis STALE secondes,
elle ne compte plus. Le registre vit en mémoire : il repart de zéro à chaque redémarrage du
serveur, si bien qu'un état « en ligne » ne peut jamais rester bloqué. (Il suppose un seul
processus Daphne, comme en production actuellement.)
"""
import threading
import time

STALE = 75  # secondes sans ping avant qu'une connexion soit ignorée (ping client toutes les 25 s)

_lock = threading.Lock()
_connections = {}  # user_id -> {channel_name: {'active': bool, 'seen': float}}


def _alive(conn, now):
    return now - conn['seen'] < STALE


def _online(user_id, now):
    return any(c['active'] and _alive(c, now) for c in _connections.get(user_id, {}).values())


def register(user_id, channel):
    with _lock:
        _connections.setdefault(user_id, {})[channel] = {'active': False, 'seen': time.monotonic()}


def update(user_id, channel, active=None):
    """Ping d'une connexion (et éventuellement changement d'état actif / absent).
    Retourne (était en ligne, est en ligne) pour savoir s'il faut prévenir les contacts."""
    now = time.monotonic()
    with _lock:
        before = _online(user_id, now)
        conn = _connections.setdefault(user_id, {}).setdefault(channel, {'active': False, 'seen': now})
        conn['seen'] = now
        if active is not None:
            conn['active'] = bool(active)
        return before, _online(user_id, now)


def unregister(user_id, channel):
    """Fermeture d'une connexion. Retourne (était en ligne, est en ligne, reste-t-il une connexion)."""
    now = time.monotonic()
    with _lock:
        before = _online(user_id, now)
        conns = _connections.get(user_id, {})
        conns.pop(channel, None)
        remaining = any(_alive(c, now) for c in conns.values())
        if not conns:
            _connections.pop(user_id, None)
        return before, _online(user_id, now), remaining


def is_online(user_id):
    with _lock:
        return _online(user_id, time.monotonic())


def is_connected(user_id):
    with _lock:
        now = time.monotonic()
        return any(_alive(c, now) for c in _connections.get(user_id, {}).values())


def reset():
    """Pour les tests."""
    with _lock:
        _connections.clear()
