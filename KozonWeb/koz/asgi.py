"""
Point d'entrée ASGI : HTTP (Django) + WebSocket (Channels) sur /ws/.
"""
import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'koz.settings')

django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from django.urls import path  # noqa: E402

from accounts.ws_auth import OriginOrTokenValidator, TokenAuthMiddleware  # noqa: E402
from chat.consumers import KozonsConsumer  # noqa: E402


# Navigateur : cookie de session + origine vérifiée. Application mobile : en-tête « Authorization: Token kz_… ».
application = ProtocolTypeRouter({
    'http': django_asgi_app,
    'websocket': OriginOrTokenValidator(
        AuthMiddlewareStack(TokenAuthMiddleware(URLRouter([path('ws/', KozonsConsumer.as_asgi())])))
    ),
})
