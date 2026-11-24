import json
import logging

from django.db import transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from kozons.api import ApiError, api, as_bool, as_int, body, rate_limit

from . import geniuspay
from . import services as svc
from . import subscription as subs
from .models import (MAX_CATEGORIES, MAX_IMAGES, PLANS, CartItem, Category, Order, Product, ProductImage, Shop,
                     SubscriptionPayment)

logger = logging.getLogger(__name__)

EXPIRED_MESSAGE = 'Votre abonnement est terminé : votre boutique est fermée. Renouvelez-le pour la rouvrir.'


def _shops_qs():
    return Shop.objects.select_related('owner__shop_subscription').prefetch_related('categories')


def _my_shop(request):
    """Ma boutique, seulement si l'abonnement est en cours (sinon fermée, même pour moi)."""
    shop = _shops_qs().filter(owner=request.user).first()
    if shop is None:
        raise ApiError("Vous n'avez pas encore de boutique.", 404)
    if not shop.subscribed:
        raise ApiError(EXPIRED_MESSAGE, 402)
    return shop


def _products_qs():
    return Product.objects.select_related('shop__owner__shop_subscription', 'category').prefetch_related('images')


def _subscribed(prefix=''):
    """Filtre : boutiques dont l'abonnement est en cours."""
    return {f'{prefix}owner__shop_subscription__expires_at__gt': timezone.now()}


def _price(value, field='Le prix'):
    n = as_int(str(value).replace(' ', '') if value is not None else None)
    if n is None or n < 0 or n > 1_000_000_000:
        raise ApiError(f'{field} est invalide.')
    return n


# ---------------------------------------------------------------- ma boutique

@api(['GET', 'POST'])
def my_shop(request):
    """GET : ma boutique (ou null). POST : créer / modifier (multipart : logo, cover)."""
    shop = _shops_qs().filter(owner=request.user).first()
    if request.method == 'GET':
        return {'shop': svc.shop_data(shop, request.user, owner_view=True) if shop else None,
                'subscription': subs.status_data(request.user)}
    sub = subs.get(request.user)
    if not sub or not sub.active:
        raise ApiError(EXPIRED_MESSAGE if shop else 'Abonnez-vous pour créer votre boutique.', 402)
    data = body(request)
    name = (data.get('name') or (shop.name if shop else '')).strip()
    if len(name) < 2:
        raise ApiError('Donnez un nom à votre boutique.')
    creating = shop is None
    if creating:
        rate_limit(request, 'shop-create', 5, 3600)
        shop = Shop(owner=request.user)
    if creating or name != shop.name:
        shop.slug = svc.unique_slug(name, exclude_pk=shop.pk)
    shop.name = name[:80]
    for field, limit in (('description', 1000), ('city', 80), ('address', 200), ('phone', 32), ('delivery_info', 300)):
        if field in data:
            setattr(shop, field, (data.get(field) or '').strip()[:limit])
    if 'default_delivery_fee' in data:
        shop.default_delivery_fee = _price(data.get('default_delivery_fee') or 0, 'Le frais de livraison')
    if 'is_open' in data:
        shop.is_open = as_bool(data.get('is_open'))
    for field in ('logo', 'cover'):
        if request.FILES.get(field):
            setattr(shop, field, svc.compress_image(request.FILES[field], 600 if field == 'logo' else 1600))
    shop.save()
    if creating:
        # Catégories proposées à la création (3 au maximum).
        names = [n.strip()[:40] for n in (data.getlist('categories') if hasattr(data, 'getlist') else data.get('categories') or []) if n.strip()]
        for i, n in enumerate(dict.fromkeys(names)):
            if i >= MAX_CATEGORIES:
                break
            Category.objects.create(shop=shop, name=n, position=i)
    shop = _shops_qs().get(pk=shop.pk)
    return {'shop': svc.shop_data(shop, request.user, owner_view=True), 'subscription': subs.status_data(request.user)}


@api(['POST'])
def categories(request):
    """{action: add|rename|delete, id?, name?} — 3 catégories au maximum."""
    shop = _my_shop(request)
    data = body(request)
    action = data.get('action')
    name = (data.get('name') or '').strip()[:40]
    if action == 'add':
        if shop.categories.count() >= MAX_CATEGORIES:
            raise ApiError(f'{MAX_CATEGORIES} catégories au maximum par boutique.')
        if not name:
            raise ApiError('Donnez un nom à la catégorie.')
        if shop.categories.filter(name__iexact=name).exists():
            raise ApiError('Cette catégorie existe déjà.')
        Category.objects.create(shop=shop, name=name, position=shop.categories.count())
    else:
        cat = get_object_or_404(Category, pk=as_int(data.get('id')), shop=shop)
        if action == 'rename':
            if not name:
                raise ApiError('Donnez un nom à la catégorie.')
            cat.name = name
            cat.save(update_fields=['name'])
        elif action == 'delete':
            cat.delete()  # les articles restent, sans catégorie
        else:
            raise ApiError('Action inconnue.')
    shop = _shops_qs().get(pk=shop.pk)
    return {'shop': svc.shop_data(shop, request.user, owner_view=True)}


# ---------------------------------------------------------------- articles

@api(['GET', 'POST'])
def my_products(request):
    shop = _my_shop(request)
    if request.method == 'GET':
        return {'results': [svc.product_data(p, request.user, owner_view=True) for p in _products_qs().filter(shop=shop)]}
    return _save_product(request, shop, Product(shop=shop))


@api(['POST'])
def product_update(request, pk):
    shop = _my_shop(request)
    return _save_product(request, shop, get_object_or_404(Product, pk=pk, shop=shop))


@api(['POST'])
def product_delete(request, pk):
    get_object_or_404(Product, pk=pk, shop=_my_shop(request)).delete()
    return {'ok': True}


def _save_product(request, shop, product):
    """Création / modification (multipart). Photos : `images` (nouvelles), `keep` (urls conservées, dans l'ordre)."""
    data = body(request)
    creating = product.pk is None
    if creating:
        rate_limit(request, 'shop-product', 120, 3600)
    title = (data.get('title') if 'title' in data else product.title or '').strip()
    if len(title) < 2:
        raise ApiError("Donnez un titre à l'article.")
    product.title = title[:120]
    if 'description' in data:
        product.description = (data.get('description') or '').strip()[:3000]
    if 'price' in data or creating:
        product.price = _price(data.get('price'))
        if product.price < 1:
            raise ApiError('Indiquez un prix de vente.')
    if 'cost_price' in data:
        product.cost_price = _price(data.get('cost_price') or 0, "Le prix d'achat")
    if 'stock' in data:
        raw = str(data.get('stock') or '').strip()
        product.stock = None if raw == '' else _price(raw, 'Le stock')
    if 'is_active' in data:
        product.is_active = as_bool(data.get('is_active'))
    if 'category_id' in data:
        cid = as_int(data.get('category_id'))
        product.category = shop.categories.filter(pk=cid).first() if cid else None
    files = request.FILES.getlist('images')
    keep = data.getlist('keep') if hasattr(data, 'getlist') else data.get('keep') or []
    existing = list(product.images.all()) if not creating else []
    kept = [img for url in keep for img in existing if img.image.url == url]
    if len(kept) + len(files) > MAX_IMAGES:
        raise ApiError(f'{MAX_IMAGES} photos au maximum par article.')
    if creating and not files:
        raise ApiError("Ajoutez au moins une photo de l'article.")
    if not creating and not kept and not files:
        raise ApiError("Gardez au moins une photo de l'article.")
    photos = [svc.compress_image(f) for f in files]
    with transaction.atomic():
        product.save()
        if not creating:
            for img in existing:
                if img not in kept:
                    img.image.delete(save=False)
                    img.delete()
            for i, img in enumerate(kept):
                ProductImage.objects.filter(pk=img.pk).update(position=i)
        for i, photo in enumerate(photos, start=len(kept)):
            ProductImage.objects.create(product=product, image=photo, position=i)
    return {'product': svc.product_data(_products_qs().get(pk=product.pk), request.user, owner_view=True)}


# ---------------------------------------------------------------- vitrine (acheteurs)

@api(['GET'])
def marketplace(request):
    """Articles disponibles de toutes les boutiques (recherche, filtre par boutique ou catégorie)."""
    qs = _products_qs().filter(is_active=True, shop__is_open=True, **_subscribed('shop__'))
    q = (request.GET.get('q') or '').strip()
    if q:
        qs = qs.filter(svc.search_filter(q))
    page = max(1, as_int(request.GET.get('page'), 1))
    items = list(qs[(page - 1) * 30: page * 30 + 1])
    shops = _shops_qs().filter(is_open=True, products__is_active=True, **_subscribed()).distinct()
    return {
        'results': [svc.product_data(p, request.user) for p in items[:30]],
        'has_more': len(items) > 30,
        'shops': [svc.shop_data(s, request.user) for s in shops.order_by('-created_at')[:20]] if page == 1 and not q else [],
    }


@api(['GET'])
def shop_detail(request, slug):
    shop = get_object_or_404(_shops_qs(), slug=slug)
    mine = shop.owner_id == request.user.pk
    if not shop.subscribed:
        # Abonnement terminé : boutique fermée, articles invisibles pour tout le monde.
        return {'shop': svc.shop_data(shop, request.user), 'products': [], 'locked': True}
    products = _products_qs().filter(shop=shop)
    if not mine:
        products = products.filter(is_active=True)
    return {'shop': svc.shop_data(shop, request.user, owner_view=mine),
            'products': [svc.product_data(p, request.user, owner_view=mine) for p in products]}


@api(['GET'])
def shop_of_user(request, user_id):
    shop = _shops_qs().filter(owner_id=user_id).first()
    if shop and not shop.subscribed and shop.owner_id != request.user.pk:
        shop = None
    return {'shop': svc.shop_data(shop, request.user) if shop else None}


@api(['GET'])
def product_detail(request, pk):
    p = get_object_or_404(_products_qs(), pk=pk)
    mine = p.shop.owner_id == request.user.pk
    if not p.shop.subscribed:
        raise ApiError('Cette boutique est momentanément fermée.', 404)
    if not p.is_active and not mine:
        raise ApiError("Cet article n'est plus en vente.", 404)
    return {'product': svc.product_data(p, request.user, owner_view=mine)}


# ---------------------------------------------------------------- panier

def _cart(request):
    items = (CartItem.objects.filter(user=request.user)
             .select_related('product__shop__owner__shop_subscription', 'product__category').prefetch_related('product__images'))
    groups = {}
    for it in items:
        g = groups.setdefault(it.product.shop_id, {'shop': {'id': it.product.shop_id, 'name': it.product.shop.name,
                                                             'slug': it.product.shop.slug, 'logo': svc.url(it.product.shop.logo),
                                                             'delivery_fee': it.product.shop.default_delivery_fee,
                                                             'delivery_info': it.product.shop.delivery_info},
                                                   'items': [], 'subtotal': 0})
        g['items'].append({'id': it.pk, 'quantity': it.quantity, 'product': svc.product_data(it.product, request.user)})
        g['subtotal'] += it.product.price * it.quantity
    groups = list(groups.values())
    return {'groups': groups, 'count': sum(i['quantity'] for g in groups for i in g['items']),
            'total': sum(g['subtotal'] for g in groups)}


@api(['GET'])
def cart(request):
    return _cart(request)


@api(['POST'])
def cart_set(request):
    """{product_id, quantity} : quantité 0 = retirer ; `add: true` ajoute à la quantité existante."""
    data = body(request)
    product = get_object_or_404(Product.objects.select_related('shop'), pk=as_int(data.get('product_id')))
    if product.shop.owner_id == request.user.pk:
        raise ApiError('Vous ne pouvez pas acheter dans votre propre boutique.')
    qty = max(0, min(as_int(data.get('quantity'), 1), 99))
    item = CartItem.objects.filter(user=request.user, product=product).first()
    if as_bool(data.get('add')):
        qty = min(99, (item.quantity if item else 0) + max(qty, 1))
    if qty == 0:
        if item:
            item.delete()
        return _cart(request)
    if not product.available:
        raise ApiError("Cet article n'est plus disponible.")
    if product.stock is not None and qty > product.stock:
        raise ApiError(f'Il ne reste que {product.stock} exemplaire(s) en stock.')
    CartItem.objects.update_or_create(user=request.user, product=product, defaults={'quantity': qty})
    return _cart(request)


@api(['POST'])
def checkout(request):
    rate_limit(request, 'shop-checkout', 20, 3600)
    data = body(request)
    orders = svc.checkout(request.user, data.get('address'), data.get('phone'), data.get('note'))
    return {'orders': [svc.order_data(svc.load_order(o.pk), request.user) for o in orders]}


# ---------------------------------------------------------------- commandes

def _order_for(request, pk):
    order = svc.load_order(pk)
    if order is None or request.user.pk not in (order.buyer_id, order.shop.owner_id):
        raise ApiError('Commande introuvable.', 404)
    return order


@api(['GET'])
def my_orders(request):
    qs = (Order.objects.filter(buyer=request.user).select_related('buyer', 'shop__owner')
          .prefetch_related('items', 'events'))[:100]
    return {'results': [svc.order_data(o, request.user) for o in qs]}


@api(['GET'])
def shop_orders(request):
    shop = _my_shop(request)
    qs = Order.objects.filter(shop=shop).select_related('buyer', 'shop__owner').prefetch_related('items', 'events')
    status = request.GET.get('status')
    if status == 'open':
        qs = qs.filter(status__in=Order.OPEN)
    elif status in dict(Order.STATUSES):
        qs = qs.filter(status=status)
    return {'results': [svc.order_data(o, request.user) for o in qs[:200]]}


@api(['GET'])
def order_detail(request, pk):
    return {'order': svc.order_data(_order_for(request, pk), request.user)}


@api(['POST'])
def order_action(request, pk, action):
    order = _order_for(request, pk)
    data = body(request)
    is_seller = order.shop.owner_id == request.user.pk
    if is_seller and not order.shop.subscribed:
        raise ApiError(EXPIRED_MESSAGE, 402)
    if action == 'accept':
        if not is_seller:
            raise ApiError('Réservé à la boutique.', 403)
        svc.accept(order, _price(data.get('delivery_fee') or 0, 'Le frais de livraison'))
    elif action == 'refuse':
        if not is_seller:
            raise ApiError('Réservé à la boutique.', 403)
        if order.status != Order.PENDING:
            raise ApiError('Cette commande a déjà été traitée.')
        reason = (data.get('reason') or '').strip()[:300]
        svc.set_status(order, Order.REFUSED, note=reason or 'Commande refusée par la boutique', reason=reason)
    elif action == 'ship':
        if not is_seller:
            raise ApiError('Réservé à la boutique.', 403)
        if order.status != Order.ACCEPTED:
            raise ApiError('La commande doit être validée avant la livraison.')
        svc.set_status(order, Order.SHIPPING, note='Le colis est en route')
    elif action == 'delivered':
        svc.mark_delivered(order, request.user)
    elif action == 'cancel':
        if is_seller:
            raise ApiError('La boutique peut refuser la commande, pas l’annuler.', 403)
        if order.status not in (Order.PENDING, Order.ACCEPTED):
            raise ApiError('La commande est déjà en route : contactez la boutique.')
        with transaction.atomic():
            if order.status == Order.ACCEPTED:
                svc.release_stock(order)
            reason = (data.get('reason') or '').strip()[:300]
            svc.set_status(order, Order.CANCELLED, note=reason or 'Annulée par le client', reason=reason)
    else:
        raise ApiError('Action inconnue.', 404)
    return {'order': svc.order_data(svc.load_order(order.pk), request.user)}


@api(['GET'])
def shop_stats(request):
    shop = _my_shop(request)
    days = as_int(request.GET.get('days'))
    return {'stats': svc.stats(shop, days if days in (7, 30, 90, 365) else None), 'days': days}


# ---------------------------------------------------------------- abonnement (GeniusPay)

@api(['GET'])
def subscription(request):
    payments = SubscriptionPayment.objects.filter(user=request.user).exclude(reference='')
    return {'subscription': subs.status_data(request.user),
            'payments': [subs.payment_data(p) for p in payments[:10]]}


@api(['POST'])
def subscription_pay(request):
    """{months, phone?} : crée le paiement GeniusPay et renvoie la page de paiement (checkout_url)."""
    rate_limit(request, 'shop-subscribe', 10, 3600)
    data = body(request)
    months = as_int(data.get('months'))
    if months not in PLANS:
        raise ApiError('Choisissez une formule.')
    payment = subs.start_payment(request, months, (data.get('phone') or '').strip())
    return {'checkout_url': payment.checkout_url, 'payment': subs.payment_data(payment)}


@api(['GET'])
def subscription_payment(request, pk):
    """Retour de la page de paiement : statut vérifié auprès de GeniusPay."""
    payment = subs.sync(get_object_or_404(SubscriptionPayment, pk=pk, user=request.user))
    return {'payment': subs.payment_data(payment), 'subscription': subs.status_data(request.user)}


@csrf_exempt
@require_POST
def geniuspay_webhook(request):
    """Notification signée de GeniusPay (payment.success, payment.failed…)."""
    raw = request.body or b''
    if not geniuspay.verify_webhook(raw, request.headers.get('X-Webhook-Timestamp'),
                                    request.headers.get('X-Webhook-Signature')):
        return JsonResponse({'status': 401, 'detail': 'Invalid signature'}, status=401)
    try:
        payload = json.loads(raw.decode('utf-8') or '{}')
    except ValueError:
        return JsonResponse({'status': 400, 'detail': 'Invalid JSON'}, status=400)
    event = request.headers.get('X-Webhook-Event') or payload.get('event') or ''
    data = payload.get('data') if isinstance(payload.get('data'), dict) else {}
    reference = str(data.get('reference') or '')
    meta = data.get('metadata') if isinstance(data.get('metadata'), dict) else {}
    payment = SubscriptionPayment.objects.filter(reference=reference).first() if reference else None
    if payment is None and meta.get('kind') == 'shop_subscription':
        payment = SubscriptionPayment.objects.filter(pk=as_int(meta.get('payment_id'))).first()
    if payment is None:
        logger.warning('Webhook GeniusPay sans paiement local (ref=%s)', reference)
        return JsonResponse({'status': 'ignored'})
    try:
        subs.apply_gateway(payment, data, event)
    except Exception:
        logger.exception('Webhook GeniusPay : erreur pour le paiement %s', payment.pk)
        return JsonResponse({'status': 500, 'detail': 'Server error'}, status=500)
    return JsonResponse({'status': 'ok'})
