"""WebSocket /ws/ des applications mobiles : authentification par jeton à l'ouverture.

Le navigateur s'identifie par son cookie de session, et son en-tête Origin est vérifié (une page
d'un autre site ne doit pas pouvoir ouvrir le WebSocket avec ce cookie). Une application native
n'envoie pas d'Origin : elle présente « Authorization: Token kz_… » à l'ouverture. Un navigateur ne
peut pas ajouter cet en-tête à un WebSocket ; quand il est présent, seul le jeton compte (le
cookie éventuel est ignoré), si bien que l'origine n'a plus à être vérifiée.
"""
from channels.db import database_sync_to_async
from channels.security.websocket import AllowedHostsOriginValidator
from django.contrib.auth.models import AnonymousUser

from . import tokens


def token_from_scope(scope):
    for name, value in scope.get('headers') or []:
        if name == b'authorization':
            return tokens.parse_header(value)
    return None


class TokenAuthMiddleware:
    """À placer à l'intérieur d'AuthMiddlewareStack : remplace l'utilisateur de la session par celui du jeton."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        key = token_from_scope(scope)
        if key is not None:
            token = await database_sync_to_async(tokens.authenticate)(key)
            scope = dict(scope, user=token.user if token else AnonymousUser(), auth_token=token)
        return await self.inner(scope, receive, send)


class OriginOrTokenValidator:
    """Navigateur : origine vérifiée (AllowedHostsOriginValidator). Application avec jeton : acceptée."""

    def __init__(self, inner):
        self.inner = inner
        self.checked = AllowedHostsOriginValidator(inner)

    async def __call__(self, scope, receive, send):
        if token_from_scope(scope) is not None:
            return await self.inner(scope, receive, send)
        return await self.checked(scope, receive, send)
