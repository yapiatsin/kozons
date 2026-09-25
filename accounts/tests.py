import json
import re
from datetime import timedelta

from django.core import mail
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from accounts.models import OneTimeCode, User

LOCMEM = {'default': {'BACKEND': 'django.core.mail.backends.locmem.EmailBackend'}}


def jpost(client, url, data):
    return client.post('/api/' + url, json.dumps(data), content_type='application/json')


@override_settings(MAILERS=LOCMEM, KOZONS_EMAIL_ASYNC=False)
class PasswordRulesTests(TestCase):
    def setUp(self):
        cache.clear()  # compteurs de limitation de débit

    def register(self, password, username='nouveau', email='nouveau@example.com'):
        return jpost(Client(), 'auth/register', {'username': username, 'email': email, 'password': password})

    def test_rules(self):
        for weak, reason in [('Abc123', 'trop court'), ('abcdefg1', 'majuscule'), ('ABCDEFG1', 'minuscule'), ('Abcdefgh', 'chiffre')]:
            r = self.register(weak)
            self.assertEqual(r.status_code, 400, reason)
        self.assertIn('majuscule', self.register('abcdefg1').json()['error'])
        self.assertEqual(self.register('Kozons2026').status_code, 200)

    def test_email_required_and_unique(self):
        self.assertEqual(self.register('Kozons2026', email='').status_code, 400)
        self.assertEqual(self.register('Kozons2026', email='pas-un-email').status_code, 400)
        self.assertEqual(self.register('Kozons2026').status_code, 200)
        r = self.register('Kozons2026', username='autre', email='NOUVEAU@example.com')
        self.assertEqual(r.status_code, 400)

    def test_login_with_email(self):
        User.objects.create_user('lina', email='lina@example.com', password='Kozons2026')
        r = jpost(Client(), 'auth/login', {'username': 'Lina@Example.com', 'password': 'Kozons2026'})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['otp_required'])


@override_settings(MAILERS=LOCMEM, KOZONS_EMAIL_ASYNC=False, DEFAULT_FROM_EMAIL='Kozons <noreply@test>')
class ForgotPasswordTests(TestCase):
    def setUp(self):
        cache.clear()  # compteurs de limitation de débit
        self.user = User.objects.create_user('alice', email='alice@example.com', password='Ancien2026', display_name='Alice')
        self.client = Client()

    def request_code(self, identifier='alice@example.com'):
        r = jpost(self.client, 'auth/password/forgot', {'identifier': identifier})
        self.assertEqual(r.status_code, 200)
        return r.json()

    def last_code(self):
        return re.search(r'\b(\d{6})\b', mail.outbox[-1].subject).group(1)

    def test_full_flow(self):
        self.request_code('alice')  # par nom d'utilisateur
        self.assertEqual(len(mail.outbox), 1)
        email = mail.outbox[0]
        self.assertEqual(email.to, ['alice@example.com'])
        code = self.last_code()
        self.assertIn(code, email.alternatives[0].content)  # version HTML
        self.assertIn(code, email.body)  # version texte
        self.assertNotIn(code, OneTimeCode.objects.get().code_hash)  # jamais stocké en clair

        r = jpost(self.client, 'auth/password/verify', {'identifier': 'alice', 'code': code})
        self.assertEqual(r.status_code, 200, r.content)
        token = r.json()['reset_token']
        self.assertEqual(jpost(self.client, 'auth/password/reset', {'reset_token': token, 'new_password': 'faible'}).status_code, 400)
        r = jpost(self.client, 'auth/password/reset', {'reset_token': token, 'new_password': 'Nouveau2026'})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.client.get('/api/me').json()['user']['username'], 'alice')  # connecté
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('Nouveau2026'))
        self.assertEqual(len(mail.outbox), 2)  # e-mail de confirmation
        # Le jeton ne sert qu'une fois.
        self.assertEqual(jpost(Client(), 'auth/password/reset', {'reset_token': token, 'new_password': 'Autre2026x'}).status_code, 400)

    def test_unknown_account_same_response(self):
        known = self.request_code()
        unknown = self.request_code('personne@example.com')
        self.assertEqual(known['message'], unknown['message'])
        self.assertEqual(len(mail.outbox), 1)

    def test_wrong_code_and_attempt_limit(self):
        self.request_code()
        code = self.last_code()
        wrong = '000000' if code != '000000' else '111111'
        for i in range(4):
            r = jpost(self.client, 'auth/password/verify', {'identifier': 'alice@example.com', 'code': wrong})
            self.assertEqual(r.status_code, 400)
            self.assertIn(f'{4 - i}', r.json()['error'])
        jpost(self.client, 'auth/password/verify', {'identifier': 'alice@example.com', 'code': wrong})
        # 6e essai, même avec le bon code : le code est grillé.
        r = jpost(self.client, 'auth/password/verify', {'identifier': 'alice@example.com', 'code': code})
        self.assertEqual(r.status_code, 429)

    def test_expired_code(self):
        self.request_code()
        code = self.last_code()
        OneTimeCode.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        r = jpost(self.client, 'auth/password/verify', {'identifier': 'alice@example.com', 'code': code})
        self.assertEqual(r.status_code, 400)

    def test_resend_cooldown_and_new_code_replaces_old(self):
        self.request_code()
        first = self.last_code()
        self.request_code()
        self.assertEqual(len(mail.outbox), 1)  # moins d'une minute : pas de nouvel envoi
        OneTimeCode.objects.update(created_at=timezone.now() - timedelta(minutes=2))
        self.request_code()
        self.assertEqual(len(mail.outbox), 2)
        second = self.last_code()
        if first != second:
            r = jpost(self.client, 'auth/password/verify', {'identifier': 'alice@example.com', 'code': first})
            self.assertEqual(r.status_code, 400)  # l'ancien code est invalidé
        r = jpost(self.client, 'auth/password/verify', {'identifier': 'alice@example.com', 'code': second})
        self.assertEqual(r.status_code, 200)

    def test_other_sessions_logged_out(self):
        other = Client()
        other.force_login(self.user)
        self.request_code()
        token = jpost(self.client, 'auth/password/verify', {'identifier': 'alice', 'code': self.last_code()}).json()['reset_token']
        jpost(self.client, 'auth/password/reset', {'reset_token': token, 'new_password': 'Nouveau2026'})
        self.assertIsNone(other.get('/api/me').json()['user'])

    def test_email_contains_inline_logo(self):
        self.request_code()
        msg = mail.outbox[0].message()
        types = [p.get_content_type() for p in msg.walk()]
        self.assertIn('multipart/related', types)
        logo = next(p for p in msg.walk() if p.get_content_type() == 'image/png')
        self.assertEqual(logo['Content-ID'], '<kozons_logo>')
        self.assertIn('cid:kozons_logo', mail.outbox[0].alternatives[0].content)

    def test_invalid_email_is_skipped(self):
        User.objects.create_user('sansmail', email='admin', password='Ancien2026')
        self.request_code('sansmail')
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(OneTimeCode.objects.filter(user__username='sansmail').exists())

    def test_smtp_failure_reports_error(self):
        from unittest import mock
        with mock.patch('accounts.utils._send_branded_email', side_effect=OSError('SMTP indisponible')), \
                self.assertLogs('accounts.utils', level='ERROR'):
            r = jpost(self.client, 'auth/password/forgot', {'identifier': 'alice'})
        self.assertEqual(r.status_code, 503)
        self.assertFalse(OneTimeCode.objects.exists())  # on peut redemander immédiatement
        self.request_code('alice')
        self.assertEqual(len(mail.outbox), 1)


@override_settings(MAILERS=LOCMEM, KOZONS_EMAIL_ASYNC=False)
class LoginOtpTests(TestCase):
    def setUp(self):
        cache.clear()  # compteurs de limitation de débit
        self.user = User.objects.create_user('alice', email='alice@example.com', password='Kozons2026')
        self.client = Client()

    def start(self, password='Kozons2026'):
        return jpost(self.client, 'auth/login', {'username': 'alice', 'password': password})

    def code(self):
        return re.search(r'([0-9]{6})', mail.outbox[-1].subject).group(1)

    def test_password_then_code_opens_session(self):
        r = self.start()
        self.assertEqual(r.status_code, 200, r.content)
        data = r.json()
        self.assertTrue(data['otp_required'])
        self.assertNotIn('user', data)
        self.assertEqual(data['email_hint'], 'al***@example.com')
        self.assertIsNone(self.client.get('/api/me').json()['user'])  # pas encore connecté
        self.assertEqual(mail.outbox[0].to, ['alice@example.com'])
        self.assertIn('connexion', mail.outbox[0].subject)
        r = jpost(self.client, 'auth/login/verify', {'challenge': data['challenge'], 'code': self.code()})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.client.get('/api/me').json()['user']['username'], 'alice')
        # Le code ne sert qu'une fois.
        r = jpost(Client(), 'auth/login/verify', {'challenge': data['challenge'], 'code': self.code()})
        self.assertEqual(r.status_code, 400)

    def test_wrong_password_sends_nothing(self):
        self.assertEqual(self.start('Mauvais2026').status_code, 401)
        self.assertEqual(len(mail.outbox), 0)

    def test_wrong_code_and_attempt_limit(self):
        challenge = self.start().json()['challenge']
        good = self.code()
        wrong = '000000' if good != '000000' else '111111'
        for _ in range(5):
            self.assertEqual(jpost(self.client, 'auth/login/verify', {'challenge': challenge, 'code': wrong}).status_code, 400)
        r = jpost(self.client, 'auth/login/verify', {'challenge': challenge, 'code': good})
        self.assertEqual(r.status_code, 429)
        self.assertIsNone(self.client.get('/api/me').json()['user'])

    def test_tampered_challenge_rejected(self):
        challenge = self.start().json()['challenge']
        r = jpost(self.client, 'auth/login/verify', {'challenge': challenge + 'x', 'code': self.code()})
        self.assertEqual(r.status_code, 400)
        self.assertIn('session de connexion', r.json()['error'])

    def test_resend_cooldown_and_new_code(self):
        challenge = self.start().json()['challenge']
        first = self.code()
        self.assertEqual(jpost(self.client, 'auth/login/resend', {'challenge': challenge}).status_code, 429)
        OneTimeCode.objects.update(created_at=timezone.now() - timedelta(minutes=2))
        r = jpost(self.client, 'auth/login/resend', {'challenge': challenge})
        self.assertEqual(r.status_code, 200)
        new_challenge = r.json()['challenge']
        second = self.code()
        if first != second:
            self.assertEqual(jpost(self.client, 'auth/login/verify', {'challenge': new_challenge, 'code': first}).status_code, 400)
        self.assertEqual(jpost(self.client, 'auth/login/verify', {'challenge': new_challenge, 'code': second}).status_code, 200)

    def test_account_without_valid_email_logs_in_directly(self):
        User.objects.create_user('ancien', email='admin', password='Kozons2026')
        r = jpost(self.client, 'auth/login', {'username': 'ancien', 'password': 'Kozons2026'})
        self.assertFalse(r.json()['otp_required'])
        self.assertEqual(self.client.get('/api/me').json()['user']['username'], 'ancien')
        self.assertEqual(len(mail.outbox), 0)

    def test_smtp_failure_reports_error(self):
        from unittest import mock
        with mock.patch('accounts.utils._send_branded_email', side_effect=OSError('SMTP')),                 self.assertLogs('accounts.utils', level='ERROR'):
            r = self.start()
        self.assertEqual(r.status_code, 503)
        self.assertFalse(OneTimeCode.objects.filter(purpose='login').exists())
