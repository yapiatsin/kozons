import time

from django.conf import settings
from django.contrib.auth import logout
from django.utils import timezone

# Les requêtes d'authentification ne comptent pas comme activité et ne sont jamais bloquées.
EXEMPT_PREFIXES = ('/api/auth/', '/api/push/key')
TOUCH_EVERY = 60  # secondes : on n'écrit la session qu'une fois par minute au plus


class IdleLogoutMiddleware:
    """Déconnexion automatique après IDLE_LOGOUT_MINUTES passées hors de la plateforme.

    Le navigateur marque ses requêtes `X-Kozons-Active: 1` quand l'utilisateur est réellement
    présent (onglet visible, fenêtre active, activité récente). Seules ces requêtes prolongent la
    session : une page oubliée en arrière-plan, ou un navigateur fermé, expire donc au bout du
    délai, et la prochaine requête trouve la session fermée.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = getattr(request, 'user', None)
        if (user is not None and user.is_authenticated and request.path.startswith('/api/')
                and not request.path.startswith(EXEMPT_PREFIXES)):
            now = time.time()
            last = request.session.get('kz_last_active')
            if last is not None and now - last > settings.IDLE_LOGOUT_MINUTES * 60:
                logout(request)  # la vue voit un utilisateur anonyme -> 401 / écran de connexion
            elif request.headers.get('X-Kozons-Active') == '1' or last is None:
                if last is None or now - last >= TOUCH_EVERY:
                    request.session['kz_last_active'] = now
                    self._touch_devices(request)
        return self.get_response(request)

    @staticmethod
    def _touch_devices(request):
        from .models import PushSubscription
        key = request.session.session_key
        if key:
            PushSubscription.objects.filter(session_key=key).update(last_active_at=timezone.now())
