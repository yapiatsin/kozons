import secrets

from django.conf import settings
from django.db import models
from django.utils import timezone

User = settings.AUTH_USER_MODEL

MAX_CATEGORIES = 3
MAX_IMAGES = 5


def shop_path(instance, filename):
    return f'shops/{timezone.now():%Y/%m}/{filename}'


def product_path(instance, filename):
    return f'products/{timezone.now():%Y/%m}/{filename}'


class Shop(models.Model):
    """Boutique : un compte = une boutique."""
    owner = models.OneToOneField(User, on_delete=models.CASCADE, related_name='shop')
    name = models.CharField(max_length=80)
    slug = models.SlugField(max_length=90, unique=True)
    description = models.TextField(max_length=1000, blank=True)
    logo = models.ImageField(upload_to=shop_path, blank=True)
    cover = models.ImageField(upload_to=shop_path, blank=True)
    city = models.CharField(max_length=80, blank=True)
    address = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=32, blank=True)
    delivery_info = models.CharField(max_length=300, blank=True)  # zones, délais…
    default_delivery_fee = models.PositiveIntegerField(default=0)  # proposé au vendeur à la validation
    is_open = models.BooleanField(default=True)                    # fermée : plus de nouvelles commandes
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        verbose_name = 'Boutique'
        verbose_name_plural = 'Boutiques'

    def __str__(self):
        return self.name

    @property
    def subscribed(self):
        """Abonnement du propriétaire en cours : sinon la boutique est fermée pour tout le monde."""
        return subscription_active(self.owner)


class Category(models.Model):
    shop = models.ForeignKey(Shop, on_delete=models.CASCADE, related_name='categories')
    name = models.CharField(max_length=40)
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ['position', 'id']
        verbose_name = 'Catégorie'
        verbose_name_plural = 'Catégories'

    def __str__(self):
        return self.name


class Product(models.Model):
    shop = models.ForeignKey(Shop, on_delete=models.CASCADE, related_name='products')
    category = models.ForeignKey(Category, null=True, blank=True, on_delete=models.SET_NULL, related_name='products')
    title = models.CharField(max_length=120)
    description = models.TextField(max_length=3000, blank=True)
    price = models.PositiveIntegerField()                       # prix de vente (FCFA)
    cost_price = models.PositiveIntegerField(default=0)         # prix d'achat : visible du seul vendeur (bénéfice)
    stock = models.PositiveIntegerField(null=True, blank=True)  # vide = illimité
    is_active = models.BooleanField(default=True)               # masqué de la vitrine sinon
    sold_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ['-created_at']
        verbose_name = 'Article'
        verbose_name_plural = 'Articles'

    def __str__(self):
        return self.title

    @property
    def available(self):
        return self.is_active and (self.stock is None or self.stock > 0) and self.shop.is_open and self.shop.subscribed


class ProductImage(models.Model):
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name='images')
    image = models.ImageField(upload_to=product_path)
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ['position', 'id']


class CartItem(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='cart_items')
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name='+')
    quantity = models.PositiveSmallIntegerField(default=1)
    added_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['added_at']
        constraints = [models.UniqueConstraint(fields=['user', 'product'], name='uniq_cart_product')]


def order_code():
    return 'CMD-' + secrets.token_hex(3).upper()


class Order(models.Model):
    """Commande passée à une boutique (un panier sur plusieurs boutiques = une commande par boutique).
    Paiement à la livraison."""
    PENDING, ACCEPTED, SHIPPING, DELIVERED, REFUSED, CANCELLED = 'pending', 'accepted', 'shipping', 'delivered', 'refused', 'cancelled'
    STATUSES = [
        (PENDING, 'En attente de validation'), (ACCEPTED, 'Validée'), (SHIPPING, 'En cours de livraison'),
        (DELIVERED, 'Livrée'), (REFUSED, 'Refusée'), (CANCELLED, 'Annulée'),
    ]
    OPEN = (PENDING, ACCEPTED, SHIPPING)

    code = models.CharField(max_length=12, unique=True, default=order_code)
    buyer = models.ForeignKey(User, on_delete=models.CASCADE, related_name='orders')
    shop = models.ForeignKey(Shop, on_delete=models.CASCADE, related_name='orders')
    status = models.CharField(max_length=10, choices=STATUSES, default=PENDING, db_index=True)
    items_total = models.PositiveIntegerField(default=0)
    cost_total = models.PositiveIntegerField(default=0)   # coût d'achat des articles (bénéfice du vendeur)
    delivery_fee = models.PositiveIntegerField(default=0)
    address = models.CharField(max_length=300)
    phone = models.CharField(max_length=32)
    note = models.CharField(max_length=500, blank=True)
    reason = models.CharField(max_length=300, blank=True)  # motif de refus / d'annulation
    delivered_by = models.CharField(max_length=10, blank=True)  # 'buyer' (reçu) ou 'seller' (livrée)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(default=timezone.now)
    delivered_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        verbose_name = 'Commande'
        verbose_name_plural = 'Commandes'

    def __str__(self):
        return f'{self.code} — {self.shop}'

    @property
    def total(self):
        return self.items_total + self.delivery_fee


class OrderItem(models.Model):
    """Article commandé : copie du titre, du prix et du coût au moment de la commande."""
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name='items')
    product = models.ForeignKey(Product, null=True, on_delete=models.SET_NULL, related_name='+')
    title = models.CharField(max_length=120)
    price = models.PositiveIntegerField()
    cost_price = models.PositiveIntegerField(default=0)
    quantity = models.PositiveSmallIntegerField()
    image = models.CharField(max_length=300, blank=True)

    @property
    def subtotal(self):
        return self.price * self.quantity


class OrderEvent(models.Model):
    """Étape du suivi de commande (affichée au client en temps réel)."""
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name='events')
    status = models.CharField(max_length=10, choices=Order.STATUSES)
    note = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['created_at', 'id']


# ---------------------------------------------------------------- abonnement des boutiques

# Durées proposées (mois) : le prix est SHOP_MONTHLY_PRICE × durée.
PLANS = {1: 'Mensuel', 2: 'Bimestriel', 3: 'Trimestriel', 6: 'Semestriel', 12: 'Annuel'}


def subscription_active(user):
    try:
        sub = user.shop_subscription
    except Subscription.DoesNotExist:
        return False
    return sub.active


class Subscription(models.Model):
    """Abonnement d'un compte à la vente en boutique : requis pour créer, puis pour garder ouverte la boutique."""
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='shop_subscription')
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True)
    started_at = models.DateTimeField(default=timezone.now)

    class Meta:
        verbose_name = 'Abonnement boutique'
        verbose_name_plural = 'Abonnements boutique'

    def __str__(self):
        return f'{self.user} → {self.expires_at:%d/%m/%Y}' if self.expires_at else str(self.user)

    @property
    def active(self):
        return bool(self.expires_at and self.expires_at > timezone.now())


class SubscriptionPayment(models.Model):
    """Paiement GeniusPay d'une période d'abonnement."""
    PENDING, COMPLETED, FAILED, CANCELLED, EXPIRED = 'pending', 'completed', 'failed', 'cancelled', 'expired'
    STATUSES = [(PENDING, 'En attente'), (COMPLETED, 'Payé'), (FAILED, 'Échoué'),
                (CANCELLED, 'Annulé'), (EXPIRED, 'Expiré')]

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='shop_subscription_payments')
    months = models.PositiveSmallIntegerField(choices=list(PLANS.items()))
    amount = models.PositiveIntegerField()
    status = models.CharField(max_length=10, choices=STATUSES, default=PENDING, db_index=True)
    reference = models.CharField(max_length=100, blank=True, db_index=True)  # référence GeniusPay
    gateway_id = models.CharField(max_length=100, blank=True)
    checkout_url = models.URLField(max_length=1000, blank=True)
    payment_method = models.CharField(max_length=40, blank=True)             # wave, orange_money…
    raw = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    paid_at = models.DateTimeField(null=True, blank=True)
    period_end = models.DateTimeField(null=True, blank=True)                 # fin d'abonnement obtenue

    class Meta:
        ordering = ['-created_at']
        verbose_name = "Paiement d'abonnement"
        verbose_name_plural = "Paiements d'abonnement"

    def __str__(self):
        return f'{self.user} · {self.months} mois · {self.amount} FCFA · {self.status}'
