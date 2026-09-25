"""
Point d'entrée ASGI : HTTP (Django) + WebSocket (Channels) sur /ws/.
"""
import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'koz.settings')

django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from channels.security.websocket import AllowedHostsOriginValidator  # noqa: E402
from django.urls import path  # noqa: E402

from chat.consumers import KozonsConsumer  # noqa: E402


def reset_presence():
    """Au démarrage, aucune connexion n'est ouverte : remet la présence à zéro."""
    try:
        from accounts.models import User
        User.objects.filter(online_count__gt=0).update(online_count=0)
    except Exception:
        pass  # base pas encore migrée


reset_presence()

application = ProtocolTypeRouter({
    'http': django_asgi_app,
    'websocket': AllowedHostsOriginValidator(
        AuthMiddlewareStack(URLRouter([path('ws/', KozonsConsumer.as_asgi())]))
    ),
})
