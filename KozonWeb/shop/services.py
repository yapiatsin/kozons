"""Règles des boutiques : sérialisation, photos, cycle de vie des commandes, statistiques."""
import io
import os
from datetime import timedelta

from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Count, F, Q, Sum
from django.utils import timezone
from django.utils.text import slugify

from accounts.push import TTL_SOCIAL, send_to_users
from accounts.serializers import user_brief
from chat.realtime import push
from kozons.api import ApiError

from .models import Order, OrderEvent, Product, Shop

STATUS_LABELS = dict(Order.STATUSES)
MAX_PHOTO = 1280


# ---------------------------------------------------------------- photos

def compress_image(upload, max_side=MAX_PHOTO):
    """Photo réduite (côté max 1280 px) et réencodée en JPEG : vitrine légère, même en 3G."""
    from PIL import Image, ImageOps
    if upload.size > 15 * 1024 * 1024:
        raise ApiError('Photo trop lourde (15 Mo maximum).')
    try:
        img = Image.open(upload)
        img = ImageOps.exif_transpose(img)
    except Exception:
        raise ApiError('Ce fichier n’est pas une image valide.')
    img.thumbnail((max_side, max_side), Image.LANCZOS)
    if img.mode not in ('RGB', 'L'):
        bg = Image.new('RGB', img.size, (255, 255, 255))
        bg.paste(img, mask=img.convert('RGBA').split()[-1])
        img = bg
    buf = io.BytesIO()
    img.convert('RGB').save(buf, 'JPEG', quality=84, optimize=True)
    name = os.path.splitext(os.path.basename(upload.name or 'photo'))[0][:40] or 'photo'
    return ContentFile(buf.getvalue(), name=f'{slugify(name) or "photo"}.jpg')


def unique_slug(name, exclude_pk=None):
    base = slugify(name)[:70] or 'boutique'
    slug, n = base, 2
    while Shop.objects.filter(slug=slug).exclude(pk=exclude_pk).exists():
        slug = f'{base}-{n}'
        n += 1
    return slug


# ---------------------------------------------------------------- sérialisation

def url(f):
    return f.url if f else None


def shop_data(shop, viewer=None, *, owner_view=False):
    data = {
        'id': shop.pk, 'name': shop.name, 'slug': shop.slug, 'description': shop.description,
        'logo': url(shop.logo), 'cover': url(shop.cover), 'city': shop.city, 'address': shop.address,
        'phone': shop.phone, 'delivery_info': shop.delivery_info, 'is_open': shop.is_open, 'subscribed': shop.subscribed,
        'owner': user_brief(shop.owner, viewer), 'is_mine': bool(viewer and shop.owner_id == viewer.pk),
        'categories': [{'id': c.pk, 'name': c.name} for c in shop.categories.all()],
        'created_at': shop.created_at.isoformat(),
    }
    if owner_view:
        data['default_delivery_fee'] = shop.default_delivery_fee
    return data


def product_data(p, viewer=None, *, owner_view=False):
    data = {
        'id': p.pk, 'title': p.title, 'description': p.description, 'price': p.price,
        'stock': p.stock, 'available': p.available, 'is_active': p.is_active, 'sold_count': p.sold_count,
        'category': {'id': p.category_id, 'name': p.category.name} if p.category_id else None,
        'images': [img.image.url for img in p.images.all()],
        'shop': {'id': p.shop_id, 'name': p.shop.name, 'slug': p.shop.slug, 'logo': url(p.shop.logo), 'city': p.shop.city},
        'created_at': p.created_at.isoformat(),
    }
    if owner_view:
        data['cost_price'] = p.cost_price
    return data


def order_data(order, viewer):
    seller_view = order.shop.owner_id == viewer.pk
    data = {
        'id': order.pk, 'code': order.code, 'status': order.status, 'status_label': STATUS_LABELS[order.status],
        'items_total': order.items_total, 'delivery_fee': order.delivery_fee, 'total': order.total,
        'address': order.address, 'phone': order.phone, 'note': order.note, 'reason': order.reason,
        'delivered_by': order.delivered_by,
        'created_at': order.created_at.isoformat(), 'updated_at': order.updated_at.isoformat(),
        'buyer': user_brief(order.buyer, viewer),
        'shop': {'id': order.shop_id, 'name': order.shop.name, 'slug': order.shop.slug, 'logo': url(order.shop.logo),
                 'phone': order.shop.phone, 'owner_id': order.shop.owner_id},
        'items': [{'product_id': i.product_id, 'title': i.title, 'price': i.price, 'quantity': i.quantity,
                   'subtotal': i.subtotal, 'image': i.image} for i in order.items.all()],
        'events': [{'status': e.status, 'label': STATUS_LABELS[e.status], 'note': e.note, 'at': e.created_at.isoformat()}
                   for e in order.events.all()],
        'role': 'seller' if seller_view else 'buyer',
    }
    if seller_view:
        data['cost_total'] = order.cost_total
        data['profit'] = order.items_total - order.cost_total
    return data


def load_order(pk):
    return (Order.objects.select_related('buyer', 'shop__owner')
            .prefetch_related('items', 'events').filter(pk=pk).first())


# ---------------------------------------------------------------- cycle de vie des commandes

NOTIFY = {
    Order.PENDING: ('🛍️ Nouvelle commande', 'seller'),
    Order.ACCEPTED: ('✅ Commande validée', 'buyer'),
    Order.SHIPPING: ('🚚 Commande en cours de livraison', 'buyer'),
    Order.REFUSED: ('❌ Commande refusée', 'buyer'),
}


def set_status(order, status, *, by=None, note='', **fields):
    """Change le statut, garde la trace dans le suivi et prévient l'autre partie en temps réel."""
    order.status = status
    order.updated_at = timezone.now()
    for k, v in fields.items():
        setattr(order, k, v)
    order.save()
    OrderEvent.objects.create(order=order, status=status, note=note)
    notify(order, status, by=by)


def notify(order, status, by=None):
    """Événement temps réel aux deux parties + notification push à l'autre partie."""
    buyer_id, seller_id = order.buyer_id, order.shop.owner_id

    def send():
        fresh = load_order(order.pk)
        from accounts.models import User
        for uid in {buyer_id, seller_id}:
            viewer = User.objects.get(pk=uid)
            push([uid], 'shop.order', {'order': order_data(fresh, viewer)})
    transaction.on_commit(send)

    title, target = NOTIFY.get(status, (None, None))
    if status == Order.DELIVERED:
        title, target = '📦 Commande livrée', ('seller' if by == buyer_id else 'buyer')
    if status == Order.CANCELLED:
        title, target = '🚫 Commande annulée', 'seller'
    if not title:
        return
    to = seller_id if target == 'seller' else buyer_id
    body = f'{order.code} · {order.shop.name} · {order.total:,} FCFA'.replace(',', ' ')
    url_ = '/shop/manage/orders' if to == seller_id else f'/shop/orders/{order.pk}'
    send_to_users([to], {'kind': 'shop', 'title': title, 'body': body, 'url': url_, 'tag': f'order-{order.pk}'},
                  ttl=TTL_SOCIAL, urgency='high', only_offline=False)


def checkout(user, address, phone, note=''):
    """Valide le panier : une commande par boutique, prix figés, panier vidé."""
    from .models import CartItem, OrderItem
    address, phone = (address or '').strip(), (phone or '').strip()
    if len(address) < 5:
        raise ApiError('Indiquez une adresse de livraison précise.')
    if len(phone) < 8:
        raise ApiError('Indiquez un numéro de téléphone valide.')
    items = list(CartItem.objects.filter(user=user).select_related('product__shop__owner__shop_subscription').prefetch_related('product__images'))
    if not items:
        raise ApiError('Votre panier est vide.')
    by_shop = {}
    for it in items:
        p = it.product
        if p.shop.owner_id == user.pk:
            raise ApiError(f'« {p.title} » est un article de votre propre boutique.')
        if not p.available:
            raise ApiError(f'« {p.title} » n’est plus disponible : retirez-le du panier.')
        if p.stock is not None and it.quantity > p.stock:
            raise ApiError(f'Il ne reste que {p.stock} « {p.title} » en stock.')
        by_shop.setdefault(p.shop, []).append(it)
    orders = []
    with transaction.atomic():
        for shop, lines in by_shop.items():
            order = Order.objects.create(
                buyer=user, shop=shop, address=address[:300], phone=phone[:32], note=(note or '').strip()[:500],
                items_total=sum(l.product.price * l.quantity for l in lines),
                cost_total=sum(l.product.cost_price * l.quantity for l in lines),
                delivery_fee=shop.default_delivery_fee)
            while Order.objects.filter(code=order.code).exclude(pk=order.pk).exists():  # code unique
                order.code = Order._meta.get_field('code').default()
                order.save(update_fields=['code'])
            for l in lines:
                first = l.product.images.first()
                OrderItem.objects.create(order=order, product=l.product, title=l.product.title, price=l.product.price,
                                         cost_price=l.product.cost_price, quantity=l.quantity,
                                         image=first.image.url if first else '')
            OrderEvent.objects.create(order=order, status=Order.PENDING, note='Commande envoyée à la boutique')
            notify(order, Order.PENDING, by=user.pk)
            orders.append(order)
        CartItem.objects.filter(pk__in=[i.pk for i in items]).delete()
    return orders


def accept(order, delivery_fee):
    """Le vendeur valide (frais de livraison fixés) : le stock est réservé."""
    if order.status != Order.PENDING:
        raise ApiError('Cette commande a déjà été traitée.')
    with transaction.atomic():
        for item in order.items.select_related('product'):
            p = item.product
            if p is None:
                continue
            if p.stock is not None:
                if p.stock < item.quantity:
                    raise ApiError(f'Stock insuffisant pour « {item.title} » ({p.stock} restant).')
                Product.objects.filter(pk=p.pk).update(stock=F('stock') - item.quantity)
        set_status(order, Order.ACCEPTED, note=f'Frais de livraison : {delivery_fee} FCFA', delivery_fee=delivery_fee)


def release_stock(order):
    """Commande annulée après validation : les articles réservés retournent en stock."""
    for item in order.items.all():
        if item.product_id:
            Product.objects.filter(pk=item.product_id, stock__isnull=False).update(stock=F('stock') + item.quantity)


def mark_delivered(order, user):
    if order.status not in (Order.ACCEPTED, Order.SHIPPING):
        raise ApiError('La commande doit être validée par la boutique avant d’être livrée.')
    by = 'seller' if user.pk == order.shop.owner_id else 'buyer'
    with transaction.atomic():
        for item in order.items.all():
            if item.product_id:
                Product.objects.filter(pk=item.product_id).update(sold_count=F('sold_count') + item.quantity)
        set_status(order, Order.DELIVERED, by=user.pk, delivered_by=by, delivered_at=timezone.now(),
                   note='Réception confirmée par le client' if by == 'buyer' else 'Livraison confirmée par la boutique')


# ---------------------------------------------------------------- statistiques du vendeur

def stats(shop, days=None):
    qs = Order.objects.filter(shop=shop)
    if days:
        qs = qs.filter(created_at__gte=timezone.now() - timedelta(days=days))
    by_status = dict(qs.values_list('status').annotate(n=Count('id')))
    done = qs.filter(status=Order.DELIVERED)
    agg = done.aggregate(sales=Sum('items_total'), cost=Sum('cost_total'), delivery=Sum('delivery_fee'))
    sales, cost = agg['sales'] or 0, agg['cost'] or 0
    top = (done.values('items__title').annotate(qty=Sum('items__quantity'), amount=Sum(F('items__price') * F('items__quantity')))
           .order_by('-qty')[:5])
    # Ventes par jour (livrées) pour le graphique.
    span = days or 30
    since = timezone.now() - timedelta(days=span - 1)
    daily = {}
    for created, total in done.filter(delivered_at__gte=since.replace(hour=0, minute=0, second=0, microsecond=0)).values_list('delivered_at', 'items_total'):
        key = timezone.localtime(created).date().isoformat()
        daily[key] = daily.get(key, 0) + total
    return {
        'orders': sum(by_status.values()),
        'by_status': {k: by_status.get(k, 0) for k, _ in Order.STATUSES},
        'open_orders': sum(by_status.get(k, 0) for k in Order.OPEN),
        'sales': sales,                      # chiffre d'affaires (articles des commandes livrées)
        'cost': cost,                        # coût d'achat de ces articles
        'profit': sales - cost,              # bénéfice
        'delivery_fees': agg['delivery'] or 0,
        'pending_value': qs.filter(status__in=Order.OPEN).aggregate(v=Sum('items_total'))['v'] or 0,
        'top_products': [{'title': t['items__title'], 'quantity': t['qty'], 'amount': t['amount']} for t in top if t['items__title']],
        'daily': [{'date': (since + timedelta(days=i)).date().isoformat(),
                   'sales': daily.get((since + timedelta(days=i)).date().isoformat(), 0)} for i in range(span)],
        'products': shop.products.count(),
        'customers': qs.values('buyer').distinct().count(),
    }


def search_filter(q):
    return Q(title__icontains=q) | Q(description__icontains=q) | Q(shop__name__icontains=q) | Q(category__name__icontains=q)
