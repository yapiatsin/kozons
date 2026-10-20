"""Client HTTP GeniusPay (paiement des abonnements de boutique). Les clés restent côté serveur."""
import hashlib
import hmac
import logging
import re
import time

import httpx
from django.conf import settings

logger = logging.getLogger(__name__)

TIMEOUT = 30
WEBHOOK_MAX_AGE_SECONDS = 300

MESSAGES = {
    'INVALID_API_KEY': 'Clé API GeniusPay invalide (GENIUSPAY_API_KEY / GENIUSPAY_API_SECRET, sandbox ou production).',
    'MISSING_API_KEY': 'Paiement en ligne indisponible pour le moment.',
    'MERCHANT_INACTIVE': 'Compte marchand GeniusPay désactivé.',
    'PAYMENT_INIT_FAILED': 'GeniusPay n’a pas pu initialiser le paiement. Réessayez dans un instant.',
    'VALIDATION_ERROR': 'Données de paiement invalides pour GeniusPay.',
    'COUNTRY_NOT_SUPPORTED': 'Pays non supporté par GeniusPay.',
}


class GeniusPayError(Exception):
    def __init__(self, message, code=None, http_status=None):
        super().__init__(message)
        self.code = code
        self.http_status = http_status


def configured():
    return bool(settings.GENIUSPAY_API_KEY and settings.GENIUSPAY_API_SECRET)


def _headers():
    if not configured():
        raise GeniusPayError(MESSAGES['MISSING_API_KEY'], code='MISSING_API_KEY', http_status=401)
    return {'X-API-Key': settings.GENIUSPAY_API_KEY, 'X-API-Secret': settings.GENIUSPAY_API_SECRET,
            'Content-Type': 'application/json', 'Accept': 'application/json'}


def normalize_phone(raw):
    """Téléphone international, ou '' si invalide. Côte d'Ivoire : +225 suivi de 10 chiffres."""
    raw = (raw or '').strip()
    digits = re.sub(r'\D', '', raw)
    if not digits:
        return ''
    if digits.startswith('225'):
        local = digits[3:]
        if len(local) == 10:
            return '+225' + local
        if len(local) == 8:
            return '+22507' + local
        return '+225' + local[-10:] if len(local) > 10 else ''
    if len(digits) == 10 and digits.startswith(('0', '1', '5', '7')):
        return '+225' + digits
    if len(digits) == 8:
        return '+22507' + digits
    if raw.startswith('+') and 10 <= len(digits) <= 15:
        return '+' + digits
    return ''


def _customer(customer):
    if not customer:
        return None
    out = {'country': (str(customer.get('country') or 'CI').strip().upper()[:2] or 'CI')}
    name = str(customer.get('name') or '').strip()[:120]
    email = str(customer.get('email') or '').strip()[:120]
    phone = normalize_phone(customer.get('phone'))
    if name:
        out['name'] = name
    if '@' in email:
        out['email'] = email
    if phone:
        out['phone'] = phone
    return out


def _clean_text(text, limit):
    # Certains caractères (°, guillemets…) font échouer la passerelle.
    return re.sub(r'[^\w\s\-./:@+]', '', str(text or '').replace('°', ''), flags=re.UNICODE).strip()[:limit]


def _metadata(metadata):
    out = {}
    for k, v in (metadata or {}).items():
        if v is None:
            continue
        v = v if isinstance(v, (int, float, bool)) else _clean_text(v, 200)
        if v != '':
            out[str(k)[:64]] = v
    return out or None


def _parse_error(payload, status):
    if not isinstance(payload, dict):
        return GeniusPayError(f'Réponse GeniusPay invalide (HTTP {status}).', http_status=status)
    err = payload.get('error') or {}
    code, message = None, None
    if isinstance(err, dict):
        code, message = err.get('code'), err.get('message') or err.get('detail')
    elif err:
        message = str(err)
    message = MESSAGES.get(code) or message or payload.get('message') or payload.get('detail') \
        or (f'Erreur GeniusPay ({code}).' if code else f'Erreur GeniusPay (HTTP {status}).')
    return GeniusPayError(message, code=code, http_status=status)


def _request(method, path, json_body=None):
    url = f'{settings.GENIUSPAY_BASE_URL}{path}'
    try:
        r = httpx.request(method, url, headers=_headers(), json=json_body, timeout=TIMEOUT)
    except httpx.HTTPError as exc:
        logger.warning('GeniusPay injoignable : %s', exc)
        raise GeniusPayError('Impossible de joindre GeniusPay. Réessayez dans un instant.') from exc
    try:
        payload = r.json()
    except ValueError:
        payload = {}
    if r.status_code >= 400 or (isinstance(payload, dict) and payload.get('success') is False):
        logger.warning('GeniusPay erreur %s %s : HTTP %s %s', method, path, r.status_code, (r.text or '')[:300])
        raise _parse_error(payload, r.status_code)
    return payload['data'] if isinstance(payload, dict) and 'data' in payload else payload


def create_payment(amount, *, description, customer=None, metadata=None, success_url=None, error_url=None):
    """Paiement en mode « checkout » : renvoie data (id, reference, checkout_url, status…)."""
    amount = int(amount)
    if amount < settings.GENIUSPAY_MIN_AMOUNT:
        raise GeniusPayError(f'Le montant minimum GeniusPay est de {settings.GENIUSPAY_MIN_AMOUNT} FCFA.',
                             code='VALIDATION_ERROR', http_status=422)
    minimal = {'amount': amount, 'currency': 'XOF', 'description': _clean_text(description, 500) or 'Abonnement Kozons'}
    if success_url:
        minimal['success_url'] = str(success_url)[:500]
    if error_url:
        minimal['error_url'] = str(error_url)[:500]
    body = dict(minimal)
    if _customer(customer):
        body['customer'] = _customer(customer)
    if _metadata(metadata):
        body['metadata'] = _metadata(metadata)
    try:
        return _request('POST', '/payments', body)
    except GeniusPayError as exc:
        # Second essai sans client ni métadonnées : certains comptes sandbox les refusent.
        retryable = exc.code in ('PAYMENT_INIT_FAILED', 'VALIDATION_ERROR', None) or exc.http_status in (400, 422)
        if not retryable or body == minimal or exc.code == 'MISSING_API_KEY':
            raise
        logger.warning('GeniusPay : nouvel essai minimal après %s', exc.code or exc.http_status)
        return _request('POST', '/payments', minimal)


def get_payment(reference):
    if not reference:
        raise GeniusPayError('Référence de paiement manquante.', code='VALIDATION_ERROR', http_status=422)
    return _request('GET', f'/payments/{str(reference).strip()}')


def verify_webhook(raw_body, timestamp, signature):
    """signature = HMAC-SHA256(f'{timestamp}.{corps brut}', GENIUSPAY_WEBHOOK_SECRET), 5 minutes au plus."""
    secret = settings.GENIUSPAY_WEBHOOK_SECRET
    if not secret:
        logger.warning('GENIUSPAY_WEBHOOK_SECRET vide : webhook rejeté.')
        return False
    try:
        ts = int(str(timestamp).strip())
    except (TypeError, ValueError):
        return False
    if not signature or abs(int(time.time()) - ts) > WEBHOOK_MAX_AGE_SECONDS:
        return False
    payload = raw_body.decode('utf-8', 'replace') if isinstance(raw_body, bytes) else str(raw_body or '')
    expected = hmac.new(secret.encode(), f'{ts}.{payload}'.encode(), hashlib.sha256).hexdigest()
    provided = str(signature).strip()
    if provided.lower().startswith('sha256='):
        provided = provided.split('=', 1)[1]
    return hmac.compare_digest(expected, provided)
