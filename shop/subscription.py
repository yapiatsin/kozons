"""Abonnement des boutiques : formules, paiement GeniusPay, prolongation de la période payée."""
import calendar
import math
import logging

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from chat.realtime import push
from kozons.api import ApiError

from . import geniuspay
from .geniuspay import GeniusPayError
from .models import PLANS, Subscription, SubscriptionPayment

logger = logging.getLogger(__name__)

GATEWAY_STATUS = {
    'completed': SubscriptionPayment.COMPLETED, 'success': SubscriptionPayment.COMPLETED,
    'succeeded': SubscriptionPayment.COMPLETED, 'paid': SubscriptionPayment.COMPLETED,
    'failed': SubscriptionPayment.FAILED, 'cancelled': SubscriptionPayment.CANCELLED,
    'canceled': SubscriptionPayment.CANCELLED, 'expired': SubscriptionPayment.EXPIRED,
}
FINAL = (SubscriptionPayment.COMPLETED, SubscriptionPayment.FAILED, SubscriptionPayment.CANCELLED,
         SubscriptionPayment.EXPIRED)
RENEW_WARNING_DAYS = 3


def price(months):
    return settings.SHOP_MONTHLY_PRICE * months


def add_months(dt, months):
    """Même jour, `months` mois plus tard (31 janvier + 1 mois = 28/29 février)."""
    m = dt.month - 1 + months
    year, month = dt.year + m // 12, m % 12 + 1
    return dt.replace(year=year, month=month, day=min(dt.day, calendar.monthrange(year, month)[1]))


def get(user):
    return Subscription.objects.filter(user=user).first()


def plans():
    return [{'months': m, 'label': label, 'price': price(m), 'monthly': settings.SHOP_MONTHLY_PRICE}
            for m, label in PLANS.items()]


def status_data(user):
    sub = get(user)
    now = timezone.now()
    active = bool(sub and sub.active)
    days_left = math.ceil((sub.expires_at - now).total_seconds() / 86400) if active else 0
    return {
        'active': active,
        'expires_at': sub.expires_at.isoformat() if sub and sub.expires_at else None,
        'expired': bool(sub and sub.expires_at and not active),  # déjà abonné, période terminée
        'days_left': days_left,
        'renew_soon': active and days_left <= RENEW_WARNING_DAYS,
        'plans': plans(),
        'payment_available': geniuspay.configured(),
    }


def payment_data(p):
    return {'id': p.pk, 'months': p.months, 'label': PLANS.get(p.months, ''), 'amount': p.amount,
            'status': p.status, 'payment_method': p.payment_method, 'reference': p.reference,
            'created_at': p.created_at.isoformat(), 'paid_at': p.paid_at.isoformat() if p.paid_at else None,
            'period_end': p.period_end.isoformat() if p.period_end else None}


def _public_base(request):
    return settings.PUBLIC_BASE_URL or request.build_absolute_uri('/').rstrip('/')


def start_payment(request, months, phone=''):
    """Crée le paiement chez GeniusPay et renvoie la page de paiement où envoyer l'utilisateur."""
    if months not in PLANS:
        raise ApiError('Formule inconnue.')
    if not geniuspay.configured():
        raise ApiError('Le paiement en ligne est indisponible pour le moment. Réessayez plus tard.', 503)
    user = request.user
    payment = SubscriptionPayment.objects.create(user=user, months=months, amount=price(months))
    base = f'{_public_base(request)}/shop/subscribe?payment={payment.pk}'
    try:
        data = geniuspay.create_payment(
            payment.amount,
            description=f'Abonnement boutique Kozons {PLANS[months]} {months} mois',
            customer={'name': user.display_name or user.username, 'email': user.email,
                      'phone': phone or user.phone, 'country': 'CI'},
            metadata={'kind': 'shop_subscription', 'payment_id': payment.pk, 'user_id': user.pk, 'months': months},
            success_url=f'{base}&status=success', error_url=f'{base}&status=error')
    except GeniusPayError as exc:
        payment.status = SubscriptionPayment.FAILED
        payment.raw = {'error': str(exc), 'code': exc.code}
        payment.save(update_fields=['status', 'raw'])
        raise ApiError(str(exc), 502)
    data = data if isinstance(data, dict) else {}
    payment.reference = str(data.get('reference') or '')[:100]
    payment.gateway_id = str(data.get('id') or '')[:100]
    payment.checkout_url = str(data.get('checkout_url') or data.get('payment_url') or '')[:1000]
    payment.raw = data
    if not payment.checkout_url or not payment.reference:
        payment.status = SubscriptionPayment.FAILED
        payment.save()
        raise ApiError('GeniusPay n’a pas renvoyé de page de paiement. Réessayez.', 502)
    payment.save()
    return payment


def sync(payment):
    """Interroge GeniusPay (retour du navigateur) : applique le paiement s'il est réussi."""
    if payment.status in FINAL or not payment.reference:
        return payment
    try:
        data = geniuspay.get_payment(payment.reference)
    except GeniusPayError as exc:
        logger.warning('GeniusPay : statut illisible pour %s (%s)', payment.reference, exc)
        return payment
    return apply_gateway(payment, data if isinstance(data, dict) else {})


def apply_gateway(payment, data, event=''):
    """Met à jour le paiement d'après GeniusPay (statut ou événement de webhook). Idempotent."""
    status = GATEWAY_STATUS.get(str(data.get('status') or '').lower(), SubscriptionPayment.PENDING)
    if event == 'payment.success':
        status = SubscriptionPayment.COMPLETED
    elif event in ('payment.failed', 'payment.cancelled', 'payment.expired'):
        status = GATEWAY_STATUS[event.split('.', 1)[1]]
    if status == SubscriptionPayment.COMPLETED:
        return confirm(payment, data)
    if status != SubscriptionPayment.PENDING:
        # Un échec arrivé après la réussite (webhooks dans le désordre) ne défait rien.
        SubscriptionPayment.objects.filter(pk=payment.pk, status=SubscriptionPayment.PENDING).update(status=status, raw=data)
        payment.refresh_from_db()
    return payment


def confirm(payment, data):
    """Paiement réussi : la période payée s'ajoute à la fin de l'abonnement (ou commence maintenant)."""
    with transaction.atomic():
        payment = SubscriptionPayment.objects.select_for_update().get(pk=payment.pk)
        if payment.status == SubscriptionPayment.COMPLETED:
            return payment
        paid = data.get('amount')
        try:
            paid = int(float(paid)) if paid is not None else payment.amount
        except (TypeError, ValueError):
            paid = payment.amount
        if paid < payment.amount:
            logger.error('GeniusPay : montant %s < %s pour le paiement %s', paid, payment.amount, payment.pk)
            payment.raw = data
            payment.save(update_fields=['raw'])
            return payment
        sub, _ = Subscription.objects.select_for_update().get_or_create(user_id=payment.user_id)
        now = timezone.now()
        start = sub.expires_at if sub.expires_at and sub.expires_at > now else now
        sub.expires_at = add_months(start, payment.months)
        sub.save(update_fields=['expires_at'])
        payment.status = SubscriptionPayment.COMPLETED
        payment.paid_at = now
        payment.period_end = sub.expires_at
        payment.payment_method = str(data.get('payment_method') or data.get('provider') or '')[:40]
        payment.raw = data
        payment.save()
        user_id = payment.user_id
        transaction.on_commit(lambda: _notify(user_id))
    return payment


def _notify(user_id):
    from accounts.models import User
    user = User.objects.filter(pk=user_id).first()
    if user:
        push([user_id], 'shop.subscription', {'subscription': status_data(user)})

