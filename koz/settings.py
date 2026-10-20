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
    'meet',
    'brady',
    'shop',
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

# Intelligence artificielle (Brady, notes de réunion Meet) — modèle GRATUIT par défaut :
# GPT-OSS 120B servi par Groq (clé gratuite sur console.groq.com, sans carte bancaire), via une API
# « compatible OpenAI ». Autre fournisseur gratuit : changer AI_API_BASE et AI_MODEL, par exemple
#   Gemini     : https://generativelanguage.googleapis.com/v1beta/openai  + gemini-2.5-flash
#   OpenRouter : https://openrouter.ai/api/v1                              + un modèle « :free »
# Sans aucune clé : Brady est indisponible et les notes Meet contiennent la transcription seule.
AI_API_KEY = config('AI_API_KEY', default='')  # la clé se met dans .env, jamais ici
AI_API_BASE = config('AI_API_BASE', default='https://api.groq.com/openai/v1').rstrip('/')
AI_MODEL = config('AI_MODEL', default='openai/gpt-oss-120b')
AI_REASONING_EFFORT = config('AI_REASONING_EFFORT', default='low')  # low | medium | high (modèles GPT-OSS)
# Texte envoyé en une fois au modèle (le quota gratuit limite les jetons par minute) :
# au-delà, les comptes rendus de réunion sont rédigés morceau par morceau.
AI_MAX_INPUT_CHARS = config('AI_MAX_INPUT_CHARS', default=12000, cast=int)

# Optionnel (payant) : Claude, utilisé seulement si AI_API_KEY est vide.
ANTHROPIC_API_KEY = config('ANTHROPIC_API_KEY', default='')
MEET_AI_MODEL = config('MEET_AI_MODEL', default='claude-opus-5-5')
BRADY_AI_MODEL = config('BRADY_AI_MODEL', default='claude-opus-5-5')

# Notifications push (Web Push) : envoyées aux utilisateurs sans application ouverte.
VAPID_PUBLIC_KEY = config('VAPID_PUBLIC_KEY', default='')
VAPID_PRIVATE_KEY = config('VAPID_PRIVATE_KEY', default='')
VAPID_SUBJECT = config('VAPID_SUBJECT', default='mailto:admin@localhost')

KOZONS_EMAIL_ASYNC = True

# Abonnement des boutiques : paiement en ligne GeniusPay (Wave, Orange Money, MTN, Moov, carte).
# Les clés se mettent dans .env, jamais ici. Webhook à déclarer chez GeniusPay :
#   <PUBLIC_BASE_URL>/api/shop/geniuspay/webhook
PUBLIC_BASE_URL = config('PUBLIC_BASE_URL', default='').strip().rstrip('/')  # ex. https://kozons.com
GENIUSPAY_API_KEY = config('GENIUSPAY_API_KEY', default='').strip()
GENIUSPAY_API_SECRET = config('GENIUSPAY_API_SECRET', default='').strip()
GENIUSPAY_BASE_URL = config('GENIUSPAY_BASE_URL', default='https://pay.genius.ci/api/v1/merchant').strip().rstrip('/')
GENIUSPAY_WEBHOOK_SECRET = config('GENIUSPAY_WEBHOOK_SECRET', default='').strip()
GENIUSPAY_MIN_AMOUNT = 200
# Prix de l'abonnement de base (FCFA par mois).
SHOP_MONTHLY_PRICE = config('SHOP_MONTHLY_PRICE', default=250, cast=int)

# Journalisation : tout sur la console (erreurs d'envoi d'e-mail, diagnostics).
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {'simple': {'format': '[{asctime}] {levelname} {name} {message}', 'style': '{'}},
    'handlers': {'console': {'class': 'logging.StreamHandler', 'formatter': 'simple'}},
    'root': {'handlers': ['console'], 'level': config('LOG_LEVEL', default='INFO')},
    'loggers': {
        'django.server': {'level': 'WARNING'},  # pas une ligne par requête HTTP
        'httpx': {'level': 'WARNING'},          # appels au service d'IA : seulement les problèmes
    },
}
