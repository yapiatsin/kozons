from django.contrib.auth.backends import ModelBackend


class CanConnectBackend(ModelBackend):
    """ModelBackend qui refuse aussi les comptes dont `can_connect` n'est pas à True.

    Vérifié à la connexion (authenticate) et à chaque requête (get_user) : retirer l'accès à un
    compte ferme donc aussi ses sessions déjà ouvertes, y compris les WebSockets.
    """

    def user_can_authenticate(self, user):
        return super().user_can_authenticate(user) and getattr(user, 'can_connect', False) is True
