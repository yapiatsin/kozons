import hashlib
import hmac
import io
import json
import shutil
import tempfile
import time
from datetime import timedelta
from unittest import mock

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from django.utils import timezone
from PIL import Image

from accounts.models import User

from . import geniuspay
from .models import Order, Product, Subscription, SubscriptionPayment
from .subscription import add_months

MEDIA = tempfile.mkdtemp()


def jpost(client, url, data=None):
    return client.post('/api/' + url, json.dumps(data or {}), content_type='application/json')


def photo(name='photo.png', size=(2000, 1500)):
    buf = io.BytesIO()
    Image.new('RGB', size, (200, 80, 40)).save(buf, 'PNG')
    return SimpleUploadedFile(name, buf.getvalue(), content_type='image/png')


@override_settings(MEDIA_ROOT=MEDIA)
class ShopFlowTests(TestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        cache.clear()
        self.seller = User.objects.create_user('vendeur', password='x', display_name='Awa Boutique')
        self.buyer = User.objects.create_user('client', password='x', display_name='Koffi')
        Subscription.objects.create(user=self.seller, expires_at=timezone.now() + timedelta(days=30))
        self.cs, self.cb = Client(), Client()
        self.cs.force_login(self.seller)
        self.cb.force_login(self.buyer)

    def make_shop(self):
        r = self.cs.post('/api/shop/me', {'name': 'Chez Awa', 'city': 'Abidjan', 'phone': '0700000000',
                                          'default_delivery_fee': '1000', 'categories': ['Robes', 'Sacs']})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()['shop']

    def make_product(self, shop, **extra):
        data = {'title': 'Robe wax', 'price': '15000', 'cost_price': '9000', 'stock': '5',
                'category_id': str(shop['categories'][0]['id']), 'images': [photo()], **extra}
        r = self.cs.post('/api/shop/me/products', data)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()['product']

    def test_one_shop_per_account_and_three_categories(self):
        shop = self.make_shop()
        self.assertEqual((shop['slug'], [c['name'] for c in shop['categories']]), ('chez-awa', ['Robes', 'Sacs']))
        again = self.cs.post('/api/shop/me', {'name': 'Chez Awa 2'}).json()['shop']
        self.assertEqual(again['id'], shop['id'])                       # même boutique, renommée
        jpost(self.cs, 'shop/me/categories', {'action': 'add', 'name': 'Chaussures'})
        r = jpost(self.cs, 'shop/me/categories', {'action': 'add', 'name': 'Bijoux'})
        self.assertEqual(r.status_code, 400)
        self.assertIn('3 catégories', r.json()['error'])

    def test_product_photos_compressed_and_cost_private(self):
        shop = self.make_shop()
        p = self.make_product(shop)
        self.assertEqual((p['price'], p['cost_price'], len(p['images'])), (15000, 9000, 1))
        with Image.open(Product.objects.get(pk=p['id']).images.first().image.path) as img:
            self.assertLessEqual(max(img.size), 1280)
        public = self.cb.get(f'/api/shop/products/{p["id"]}').json()['product']
        self.assertNotIn('cost_price', public)                          # le prix d'achat reste privé
        self.assertEqual(self.cs.post('/api/shop/me/products', {'title': 'Sans photo', 'price': '10'}).status_code, 400)

    def test_full_order_flow_and_stats(self):
        shop = self.make_shop()
        p = self.make_product(shop)
        r = jpost(self.cb, 'shop/cart/set', {'product_id': p['id'], 'quantity': 2})
        self.assertEqual((r.json()['count'], r.json()['total']), (2, 30000))
        self.assertEqual(jpost(self.cs, 'shop/cart/set', {'product_id': p['id']}).status_code, 400)  # sa propre boutique
        self.assertEqual(jpost(self.cb, 'shop/checkout', {'address': 'x', 'phone': '07'}).status_code, 400)
        r = jpost(self.cb, 'shop/checkout', {'address': 'Cocody Angré, près de la pharmacie', 'phone': '0102030405'})
        self.assertEqual(r.status_code, 200, r.content)
        order = r.json()['orders'][0]
        self.assertEqual((order['status'], order['items_total'], order['delivery_fee']), ('pending', 30000, 1000))
        self.assertEqual(self.cb.get('/api/shop/cart').json()['count'], 0)
        oid = order['id']
        # Le client ne valide pas à la place du vendeur.
        self.assertEqual(jpost(self.cb, f'shop/orders/{oid}/accept').status_code, 403)
        seller_view = self.cs.get('/api/shop/me/orders?status=open').json()['results'][0]
        self.assertEqual((seller_view['profit'], seller_view['role']), (12000, 'seller'))
        r = jpost(self.cs, f'shop/orders/{oid}/accept', {'delivery_fee': 1500})
        self.assertEqual((r.json()['order']['status'], r.json()['order']['total']), ('accepted', 31500))
        self.assertEqual(Product.objects.get(pk=p['id']).stock, 3)      # stock réservé
        jpost(self.cs, f'shop/orders/{oid}/ship')
        tracking = self.cb.get(f'/api/shop/orders/{oid}').json()['order']
        self.assertEqual([e['status'] for e in tracking['events']], ['pending', 'accepted', 'shipping'])
        self.assertEqual(jpost(self.cb, f'shop/orders/{oid}/cancel').status_code, 400)  # déjà en route
        r = jpost(self.cb, f'shop/orders/{oid}/delivered')
        self.assertEqual((r.json()['order']['status'], r.json()['order']['delivered_by']), ('delivered', 'buyer'))
        stats = self.cs.get('/api/shop/me/stats').json()['stats']
        self.assertEqual((stats['orders'], stats['sales'], stats['cost'], stats['profit'], stats['delivery_fees']),
                         (1, 30000, 18000, 12000, 1500))
        self.assertEqual(stats['top_products'][0]['quantity'], 2)
        self.assertEqual(Product.objects.get(pk=p['id']).sold_count, 2)
        # Un inconnu ne voit pas la commande.
        other = Client()
        other.force_login(User.objects.create_user('curieux', password='x'))
        self.assertEqual(other.get(f'/api/shop/orders/{oid}').status_code, 404)

    def test_cancel_after_accept_releases_stock_and_seller_can_confirm_delivery(self):
        shop = self.make_shop()
        p = self.make_product(shop)
        for _ in range(2):
            jpost(self.cb, 'shop/cart/set', {'product_id': p['id'], 'quantity': 1})
            oid = jpost(self.cb, 'shop/checkout', {'address': 'Yopougon Maroc', 'phone': '0102030405'}).json()['orders'][0]['id']
            jpost(self.cs, f'shop/orders/{oid}/accept', {'delivery_fee': 500})
        first, second = Order.objects.order_by('id')
        self.assertEqual(Product.objects.get(pk=p['id']).stock, 3)
        jpost(self.cb, f'shop/orders/{first.pk}/cancel', {'reason': "J'ai changé d'avis"})
        self.assertEqual(Product.objects.get(pk=p['id']).stock, 4)
        r = jpost(self.cs, f'shop/orders/{second.pk}/delivered')
        self.assertEqual(r.json()['order']['delivered_by'], 'seller')

    def test_stock_and_refusal(self):
        shop = self.make_shop()
        p = self.make_product(shop, stock='1')
        self.assertEqual(jpost(self.cb, 'shop/cart/set', {'product_id': p['id'], 'quantity': 3}).status_code, 400)
        jpost(self.cb, 'shop/cart/set', {'product_id': p['id'], 'quantity': 1})
        oid = jpost(self.cb, 'shop/checkout', {'address': 'Marcory zone 4', 'phone': '0102030405'}).json()['orders'][0]['id']
        r = jpost(self.cs, f'shop/orders/{oid}/refuse', {'reason': 'Rupture de stock'})
        self.assertEqual((r.json()['order']['status'], r.json()['order']['reason']), ('refused', 'Rupture de stock'))
        self.assertEqual(jpost(self.cb, f'shop/orders/{oid}/delivered').status_code, 400)

    def test_marketplace_search(self):
        shop = self.make_shop()
        self.make_product(shop)
        self.make_product(shop, title='Sac en cuir', price='20000')
        res = self.cb.get('/api/shop/market?q=sac').json()['results']
        self.assertEqual([x['title'] for x in res], ['Sac en cuir'])
        detail = self.cb.get(f'/api/shop/s/{shop["slug"]}').json()
        self.assertEqual(len(detail['products']), 2)
        self.assertEqual(self.cb.get(f'/api/shop/user/{self.seller.pk}').json()['shop']['slug'], 'chez-awa')

    def test_expired_shop_is_hidden_from_everyone(self):
        # Abonnement terminé : la boutique se ferme pour tout le monde, même pour son propriétaire.
        shop = self.make_shop()
        p = self.make_product(shop)
        jpost(self.cb, 'shop/cart/set', {'product_id': p['id'], 'quantity': 1})
        oid = jpost(self.cb, 'shop/checkout', {'address': 'Cocody Riviera 3', 'phone': '0102030405'}).json()['orders'][0]['id']
        jpost(self.cb, 'shop/cart/set', {'product_id': p['id'], 'quantity': 1})
        Subscription.objects.filter(user=self.seller).update(expires_at=timezone.now() - timedelta(minutes=1))
        self.assertEqual(self.cb.get('/api/shop/market').json()['results'], [])
        detail = self.cb.get(f'/api/shop/s/{shop["slug"]}').json()
        self.assertEqual((detail['locked'], detail['products']), (True, []))
        self.assertTrue(self.cs.get(f'/api/shop/s/{shop["slug"]}').json()['locked'])      # même le vendeur
        self.assertEqual(self.cb.get(f'/api/shop/products/{p["id"]}').status_code, 404)
        self.assertEqual(self.cs.get(f'/api/shop/products/{p["id"]}').status_code, 404)
        self.assertEqual(self.cs.get('/api/shop/me/products').status_code, 402)
        self.assertEqual(self.cs.get('/api/shop/me/stats').status_code, 402)
        self.assertEqual(jpost(self.cs, f'shop/orders/{oid}/accept').status_code, 402)
        self.assertEqual(jpost(self.cb, 'shop/checkout', {'address': 'Cocody Riviera 3', 'phone': '0102030405'}).status_code, 400)
        self.assertIsNone(self.cb.get(f'/api/shop/user/{self.seller.pk}').json()['shop'])
        me = self.cs.get('/api/shop/me').json()
        self.assertEqual((me['shop']['subscribed'], me['subscription']['expired']), (False, True))
        self.assertEqual(self.cb.get(f'/api/shop/orders/{oid}').status_code, 200)        # le client garde sa commande
        # Renouvellement : tout revient.
        Subscription.objects.filter(user=self.seller).update(expires_at=timezone.now() + timedelta(days=30))
        self.assertEqual(len(self.cb.get('/api/shop/market').json()['results']), 1)


GP = dict(GENIUSPAY_API_KEY='pk_test', GENIUSPAY_API_SECRET='sk_test', GENIUSPAY_WEBHOOK_SECRET='whsec_test',
          PUBLIC_BASE_URL='https://kozons.test', SHOP_MONTHLY_PRICE=250)


def signed(client, payload, event, secret='whsec_test', ts=None):
    raw = json.dumps(payload)
    ts = str(ts or int(time.time()))
    sig = hmac.new(secret.encode(), f'{ts}.{raw}'.encode(), hashlib.sha256).hexdigest()
    return client.post('/api/shop/geniuspay/webhook', raw, content_type='application/json',
                       headers={'X-Webhook-Signature': f'sha256={sig}', 'X-Webhook-Timestamp': ts, 'X-Webhook-Event': event})


@override_settings(MEDIA_ROOT=MEDIA, **GP)
class SubscriptionTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user('vendeuse', password='x', email='awa@example.com', phone='0701020304')
        self.c = Client()
        self.c.force_login(self.user)

    def pay(self, months=3, reference='MTX-1'):
        created = {'id': 77, 'reference': reference, 'checkout_url': 'https://pay.genius.ci/checkout/abc', 'status': 'pending'}
        with mock.patch.object(geniuspay, 'create_payment', return_value=created) as create:
            r = jpost(self.c, 'shop/subscription/pay', {'months': months})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json(), create

    def test_plans_and_creation_requires_subscription(self):
        data = self.c.get('/api/shop/subscription').json()['subscription']
        self.assertEqual([(p['months'], p['price']) for p in data['plans']],
                         [(1, 250), (2, 500), (3, 750), (6, 1500), (12, 3000)])
        self.assertFalse(data['active'])
        r = self.c.post('/api/shop/me', {'name': 'Chez Awa'})
        self.assertEqual(r.status_code, 402)

    def test_payment_return_activates_and_extends(self):
        data, create = self.pay(months=3)
        self.assertEqual(data['checkout_url'], 'https://pay.genius.ci/checkout/abc')
        kwargs = create.call_args.kwargs
        self.assertEqual(create.call_args.args[0], 750)
        self.assertTrue(kwargs['success_url'].startswith('https://kozons.test/shop/subscribe?payment='))
        self.assertEqual(kwargs['customer']['phone'], '0701020304')
        pid = data['payment']['id']
        # Retour du navigateur : encore en attente, puis payé.
        with mock.patch.object(geniuspay, 'get_payment', return_value={'reference': 'MTX-1', 'status': 'pending'}):
            r = self.c.get(f'/api/shop/subscription/payments/{pid}').json()
        self.assertEqual((r['payment']['status'], r['subscription']['active']), ('pending', False))
        paid = {'reference': 'MTX-1', 'status': 'completed', 'amount': 750, 'payment_method': 'wave'}
        with mock.patch.object(geniuspay, 'get_payment', return_value=paid):
            r = self.c.get(f'/api/shop/subscription/payments/{pid}').json()
            again = self.c.get(f'/api/shop/subscription/payments/{pid}').json()   # idempotent
        self.assertEqual((r['payment']['status'], r['payment']['payment_method'], r['subscription']['active']),
                         ('completed', 'wave', True))
        end = Subscription.objects.get(user=self.user).expires_at
        self.assertEqual(again['subscription']['expires_at'], end.isoformat())
        self.assertGreaterEqual((end - timezone.now()).days, 88)
        self.assertEqual(self.c.post('/api/shop/me', {'name': 'Chez Awa'}).status_code, 200)
        # Renouvellement avant la fin : la nouvelle période s'ajoute à la fin de l'actuelle.
        data, _ = self.pay(months=1, reference='MTX-2')
        with mock.patch.object(geniuspay, 'get_payment', return_value={**paid, 'reference': 'MTX-2', 'amount': 250}):
            self.c.get(f'/api/shop/subscription/payments/{data["payment"]["id"]}')
        self.assertEqual(Subscription.objects.get(user=self.user).expires_at, add_months(end, 1))

    def test_webhook_signature_and_underpayment(self):
        data, _ = self.pay(months=12, reference='MTX-9')
        anon = Client()
        payload = {'event': 'payment.success', 'data': {'reference': 'MTX-9', 'status': 'completed', 'amount': 3000}}
        self.assertEqual(signed(anon, payload, 'payment.success', secret='mauvais').status_code, 401)
        self.assertEqual(signed(anon, payload, 'payment.success', ts=int(time.time()) - 3600).status_code, 401)
        low = {'event': 'payment.success', 'data': {'reference': 'MTX-9', 'status': 'completed', 'amount': 250}}
        self.assertEqual(signed(anon, low, 'payment.success').status_code, 200)
        self.assertFalse(Subscription.objects.filter(user=self.user, expires_at__isnull=False).exists())  # montant insuffisant
        self.assertEqual(signed(anon, payload, 'payment.success').status_code, 200)
        self.assertEqual(SubscriptionPayment.objects.get(reference='MTX-9').status, 'completed')
        # Un échec arrivé après coup ne défait pas le paiement.
        signed(anon, {'data': {'reference': 'MTX-9', 'status': 'failed'}}, 'payment.failed')
        self.assertEqual(SubscriptionPayment.objects.get(reference='MTX-9').status, 'completed')
        self.assertTrue(Subscription.objects.get(user=self.user).active)
        self.assertEqual(signed(anon, {'data': {'reference': 'inconnue'}}, 'payment.success').json()['status'], 'ignored')

    def test_gateway_errors(self):
        with override_settings(GENIUSPAY_API_KEY=''):
            self.assertEqual(jpost(self.c, 'shop/subscription/pay', {'months': 1}).status_code, 503)
        self.assertEqual(jpost(self.c, 'shop/subscription/pay', {'months': 5}).status_code, 400)
        with mock.patch.object(geniuspay, 'create_payment', side_effect=geniuspay.GeniusPayError('GeniusPay en panne')):
            r = jpost(self.c, 'shop/subscription/pay', {'months': 1})
        self.assertEqual((r.status_code, r.json()['error']), (502, 'GeniusPay en panne'))

    def test_client_retries_with_minimal_payload(self):
        calls = []

        def fake(method, url, headers, json, timeout):
            calls.append(json)
            if len(calls) == 1:
                return mock.Mock(status_code=422, text='', json=lambda: {'success': False, 'error': {'code': 'VALIDATION_ERROR'}})
            return mock.Mock(status_code=200, text='', json=lambda: {'success': True, 'data': {'reference': 'R', 'checkout_url': 'u'}})
        with mock.patch('shop.geniuspay.httpx.request', side_effect=fake):
            data = geniuspay.create_payment(250, description='Abonnement « Mensuel »', customer={'phone': '0701020304'},
                                            metadata={'payment_id': 1})
        self.assertEqual(data['reference'], 'R')
        self.assertEqual(calls[0]['customer']['phone'], '+2250701020304')
        self.assertEqual(set(calls[1]), {'amount', 'currency', 'description'})
        self.assertNotIn('«', calls[0]['description'])

