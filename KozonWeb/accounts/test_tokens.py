"""Jetons d'API des applications mobiles (Authorization: Token kz_…), en HTTP et en WebSocket."""
import json

from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.test import Client, TestCase, TransactionTestCase

from accounts import tokens
from accounts.models import ApiToken, User


def app_client():
    # Comme une application native : pas de cookie, et le contrôle CSRF appliqué comme en production.
    return Client(enforce_csrf_checks=True)


def jpost(client, url, data, **headers):
    return client.post(url, json.dumps(data), content_type='application/json', headers=headers)


class ApiTokenTests(TestCase):
    def setUp(self):
        cache.clear()
        self.alice = User.objects.create_user('alice', email='alice@example.com', password='Secret123', can_connect=True)

    def login(self, client=None, username='alice', password='Secret123', **extra):
        return jpost(client or app_client(), '/api/auth/token', dict(username=username, password=password, **extra))

    def auth(self, key):
        return {'Authorization': f'Token {key}'}

    def test_token_login_rules(self):
        self.assertEqual(self.login(password='mauvais').status_code, 401)
        r = self.login(username='alice@example.com', device='Pixel 10')   # e-mail accepté, comme sur le web
        self.assertEqual(r.status_code, 200, r.content)
        data = r.json()
        self.assertTrue(data['token'].startswith('kz_'))
        self.assertEqual(data['user']['username'], 'alice')
        token = ApiToken.objects.get(user=self.alice)
        self.assertEqual(token.device, 'Pixel 10')
        self.assertNotIn(data['token'], token.key_hash)   # seule l'empreinte est gardée
        # Compte en attente d'autorisation : même message que la connexion web.
        User.objects.create_user('bob', password='Secret123', can_connect=False)
        self.assertEqual(self.login(username='bob').status_code, 403)

    def test_requests_with_token_need_no_cookie_nor_csrf(self):
        key = self.login().json()['token']
        c = app_client()
        r = c.get('/api/me', headers=self.auth(key))
        self.assertEqual(r.json()['user']['username'], 'alice')
        self.assertTrue(r.json()['remember'])
        # POST sans jeton CSRF accepté avec le jeton…
        r = jpost(c, '/api/me', {'about': 'Depuis le mobile'}, **self.auth(key))
        self.assertEqual(r.status_code, 200, r.content)
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.about, 'Depuis le mobile')
        # … et aucune session créée côté serveur.
        self.assertNotIn('sessionid', r.cookies)
        # « Bearer » aussi accepté.
        self.assertEqual(c.get('/api/me', headers={'Authorization': f'Bearer {key}'}).json()['user']['username'], 'alice')

    def test_session_cookie_still_needs_csrf(self):
        c = app_client()
        c.force_login(self.alice)
        self.assertEqual(jpost(c, '/api/me', {'about': 'x'}).status_code, 403)

    def test_bad_or_foreign_tokens(self):
        c = app_client()
        r = c.get('/api/me', headers=self.auth('kz_inconnu'))
        self.assertEqual(r.status_code, 401)
        self.assertIn('Reconnectez-vous', r.json()['error'])
        # Un autre en-tête Authorization (ex. MediaMTX) est ignoré : requête anonyme normale.
        self.assertEqual(c.get('/api/me', headers={'Authorization': 'Bearer abc.def'}).json(), {'user': None})
        # Un vieux jeton envoyé par erreur n'empêche pas de se reconnecter.
        r = jpost(c, '/api/auth/token', {'username': 'alice', 'password': 'Secret123'}, **self.auth('kz_perime'))
        self.assertEqual(r.status_code, 200)

    def test_logout_revokes_only_this_device(self):
        k1, k2 = self.login().json()['token'], self.login().json()['token']
        c = app_client()
        self.assertEqual(jpost(c, '/api/auth/logout', {}, **self.auth(k1)).status_code, 200)
        self.assertEqual(c.get('/api/me', headers=self.auth(k1)).status_code, 401)
        self.assertEqual(c.get('/api/me', headers=self.auth(k2)).json()['user']['username'], 'alice')

    def test_password_change_keeps_this_device_only(self):
        mine, other = self.login().json()['token'], self.login().json()['token']
        c = app_client()
        r = jpost(c, '/api/auth/password', {'old_password': 'Secret123', 'new_password': 'Nouveau456'}, **self.auth(mine))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(c.get('/api/me', headers=self.auth(mine)).json()['user']['username'], 'alice')
        self.assertEqual(c.get('/api/me', headers=self.auth(other)).status_code, 401)

    def test_access_withdrawn_closes_tokens(self):
        key = self.login().json()['token']
        User.objects.filter(pk=self.alice.pk).update(can_connect=False)
        self.assertEqual(app_client().get('/api/me', headers=self.auth(key)).status_code, 401)

    def test_old_devices_pruned(self):
        for _ in range(tokens.MAX_PER_USER + 3):
            tokens.issue(self.alice)
        self.assertEqual(ApiToken.objects.filter(user=self.alice).count(), tokens.MAX_PER_USER)


class TokenWebSocketTests(TransactionTestCase):
    async def connect(self, headers):
        from koz.asgi import application
        comm = WebsocketCommunicator(application, '/ws/', headers=headers)
        connected, code = await comm.connect()
        return comm, connected, code

    async def test_mobile_websocket(self):
        user = await sync_to_async(User.objects.create_user)('alice', password='Secret123', can_connect=True)
        key = await sync_to_async(tokens.issue)(user)
        # Application native : pas d'Origin, jeton dans l'en-tête → connectée.
        comm, connected, _ = await self.connect([(b'authorization', f'Token {key}'.encode())])
        self.assertTrue(connected)
        await comm.disconnect()
        # Jeton inconnu : refusée (4401), même chose qu'une session fermée.
        comm, connected, code = await self.connect([(b'authorization', b'Token kz_inconnu')])
        self.assertFalse(connected)
        self.assertEqual(code, 4401)
        # Sans jeton ni Origin (ni cookie) : refusée par le contrôle d'origine, comme avant.
        comm, connected, _ = await self.connect([])
        self.assertFalse(connected)
