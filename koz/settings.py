import os
from pathlib import Path

from decouple import Csv, config

BASE_DIR = Path(__file__).resolve().parent.parent

# Valeurs lues dans .env (voir .env.example), puis dans les variables d'environnement.
SECRET_KEY = config('SECRET_KEY')
DEBUG = config('DEBUG', default=False, cast=bool)
ALLOWED_HOSTS = config('ALLOWED_HOSTS', default='localhost,127.0.0.1,*', cast=Csv())
CSRF_TRUSTED_ORIGINS = config('CSRF_TRUSTED_ORIGINS', default='', cast=Csv())

# Derrière Caddy (HTTPS terminé par le proxy) : Django doit savoir que la requête était en https.
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG

INSTALLED_APPS = [
    'daphne',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'channels',
    'accounts',
    'chat',
    'social',
    'live',
    'kozons',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'accounts.middleware.IdleLogoutMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'koz.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'koz.wsgi.application'
ASGI_APPLICATION = 'koz.asgi.application'

if config('DB_ENGINE', default='sqlite') == 'postgresql':
    # Production (VPS) : conteneur kozons-db, variables imposées par docker-compose.yml.
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': config('DB_NAME', default='kozons'),
            'USER': config('DB_USER', default='kozons'),
            'PASSWORD': config('DB_PASSWORD'),
            'HOST': config('DB_HOST', default='kozons-db'),
            'PORT': config('DB_PORT', default='5432'),
            # Connexions réutilisées entre requêtes (Daphne : un seul processus).
            'CONN_MAX_AGE': 60,
            'CONN_HEALTH_CHECKS': True,
        }
    }
else:
    # Développement : SQLite.
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': config('SQLITE_PATH', default=str(BASE_DIR / 'db.sqlite3')),
            'OPTIONS': {
                # WAL : lectures concurrentes pendant les écritures (temps réel).
                'init_command': 'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;',
                'transaction_mode': 'IMMEDIATE',
                'timeout': 20,
            },
        }
    }

# Redis si disponible (multi-processus / production), sinon mémoire (dev).
if os.environ.get('KOZONS_REDIS_URL'):
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels_redis.core.RedisChannelLayer',
            'CONFIG': {'hosts': [os.environ['KOZONS_REDIS_URL']]},
        }
    }
else:
    CHANNEL_LAYERS = {'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}}

AUTH_USER_MODEL = 'accounts.User'

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 8}},
    {'NAME': 'accounts.validators.CharacterClassesValidator'},
]

LANGUAGE_CODE = 'fr-fr'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

# 100 Mo par fichier (vidéos, documents).
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024
KOZONS_MAX_UPLOAD = 100 * 1024 * 1024

SESSION_COOKIE_AGE = 60 * 60 * 24 * 60
LOGIN_URL = '/'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# E-mail — Django 6.1 : configuration via MAILERS (les réglages EMAIL_HOST… sont dépréciés).
_email_backend = config('EMAIL_BACKEND', default='django.core.mail.backends.console.EmailBackend')
_email_options = {}
if _email_backend.endswith('smtp.EmailBackend'):
    _email_options = {
        'host': config('EMAIL_HOST', default='localhost'),
        'port': config('EMAIL_PORT', default=587, cast=int),
        'username': config('EMAIL_HOST_USER', default=''),
        # Mot de passe d'application Gmail : les espaces affichés par Google sont retirés.
        'password': config('EMAIL_HOST_PASSWORD', default='').replace(' ', ''),
        'use_tls': config('EMAIL_USE_TLS', default=True, cast=bool),
        'use_ssl': config('EMAIL_USE_SSL', default=False, cast=bool),
        'timeout': config('EMAIL_TIMEOUT', default=30, cast=int),
    }
MAILERS = {'default': {'BACKEND': _email_backend, 'OPTIONS': _email_options}}
DEFAULT_FROM_EMAIL = config('DEFAULT_FROM_EMAIL', default='Kozons <noreply@localhost>')

# Mot de passe oublié : validité du code, essais autorisés, envoi en tâche de fond.
PASSWORD_RESET_OTP_MINUTES = config('PASSWORD_RESET_OTP_MINUTES', default=10, cast=int)
PASSWORD_RESET_MAX_ATTEMPTS = 5
# Déconnexion automatique après ce délai passé hors de la plateforme.
IDLE_LOGOUT_MINUTES = config('IDLE_LOGOUT_MINUTES', default=45, cast=int)

# Lives : serveur média MediaMTX (WHIP/WHEP). Vide = mode pair-à-pair (petite audience, développement).
LIVE_MEDIA_URL = config('LIVE_MEDIA_URL', default='').rstrip('/')
LIVE_P2P_MAX_VIEWERS = config('LIVE_P2P_MAX_VIEWERS', default=20, cast=int)

# Notifications push (Web Push) : envoyées aux utilisateurs sans application ouverte.
VAPID_PUBLIC_KEY = config('VAPID_PUBLIC_KEY', default='')
VAPID_PRIVATE_KEY = config('VAPID_PRIVATE_KEY', default='')
VAPID_SUBJECT = config('VAPID_SUBJECT', default='mailto:admin@localhost')

# Connexion en deux étapes : code envoyé par e-mail après le mot de passe.
LOGIN_OTP_MINUTES = config('LOGIN_OTP_MINUTES', default=10, cast=int)
KOZONS_EMAIL_ASYNC = True

# Journalisation : tout sur la console (erreurs d'envoi d'e-mail, diagnostics).
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {'simple': {'format': '[{asctime}] {levelname} {name} {message}', 'style': '{'}},
    'handlers': {'console': {'class': 'logging.StreamHandler', 'formatter': 'simple'}},
    'root': {'handlers': ['console'], 'level': config('LOG_LEVEL', default='INFO')},
    'loggers': {
        'django.server': {'level': 'WARNING'},  # pas une ligne par requête HTTP
    },
}
