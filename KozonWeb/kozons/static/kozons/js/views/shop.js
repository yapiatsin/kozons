// Boutiques Kozons : vitrine, boutique, article, panier, commandes (suivi en temps réel), espace vendeur.
import { api } from '../api.js';
import { bus, state } from '../store.js';
import { h, clear, icon, btn, avatar, menu, modal, toast, errorToast, confirmDialog, promptDialog, spinner, empty, pickFiles, debounce, listTime } from '../ui.js';

const go = path => window.kozons.go(path);
export const money = n => `${Number(n || 0).toLocaleString('fr-FR')} FCFA`;
const STEPS = [['pending', 'Envoyée'], ['accepted', 'Validée'], ['shipping', 'En livraison'], ['delivered', 'Livrée']];
const STATUS_CLASS = { pending: 'warn', accepted: 'info', shipping: 'info', delivered: 'ok', refused: 'bad', cancelled: 'bad' };

export function render(stage, params) {
  const views = { market: renderMarket, shop: renderShop, product: renderProduct, cart: renderCart, orders: renderOrders, order: renderOrder, manage: renderManage, subscribe: renderSubscribe };
  return (views[params.page] || renderMarket)(stage, params);
}

function statusBadge(o) { return h('span.sh-status.' + (STATUS_CLASS[o.status] || ''), o.status_label); }
function cover(p) { return p.images && p.images[0] ? h('img', { src: p.images[0], alt: '', loading: 'lazy' }) : h('div.sh-noimg', icon('bag', 32)); }

function productCard(p) {
  return h('button.sh-card' + (p.available ? '' : '.soldout'), { type: 'button', onclick: () => go('/shop/p/' + p.id) },
    h('div.sh-card-img', cover(p), p.available ? null : h('span.sh-soldout', 'Indisponible')),
    h('div.sh-card-body', h('strong.sh-price', money(p.price)), h('span.sh-card-title', p.title),
      h('small.muted', p.shop.name + (p.shop.city ? ' · ' + p.shop.city : ''))));
}

function topBar(title, { back = true, extra = [] } = {}) {
  return h('header.sh-top', back ? btn('back', 'Retour', () => (history.length > 1 ? history.back() : go('/shop'))) : null,
    h('h2', title), h('div.row.gap', ...extra));
}

// Bouton panier avec le nombre d'articles (mis à jour après chaque ajout).
function cartButton() {
  const badge = h('span.badge.hidden');
  const b = h('button.icon-btn.sh-cart-btn', { type: 'button', title: 'Panier', 'aria-label': 'Panier', onclick: () => go('/shop/cart') }, icon('cart'), badge);
  const paint = n => { badge.textContent = n > 99 ? '99+' : String(n); badge.classList.toggle('hidden', !n); };
  api.get('shop/cart').then(c => paint(c.count)).catch(() => {});
  const off = bus.on('shop:cart', c => paint(c.count));
  b._off = off;
  return b;
}

// ------------------------------------------------------------------ vitrine

function renderMarket(stage) {
  let page = 1, q = '';
  const grid = h('div.sh-grid', spinner());
  const more = h('button.btn.ghost.hidden', { onclick: () => { page++; load(true); } }, 'Voir plus');
  const shopsRow = h('div.sh-shops');
  const search = h('input.search-input', { type: 'search', placeholder: 'Rechercher un article, une boutique…' });
  const cart = cartButton();
  const myShopBtn = h('button.btn.primary.small', { onclick: () => go('/shop/manage') }, icon('store', 16), ' Ma boutique');
  stage.appendChild(h('div.page.sh-page',
    topBar('Boutique', { back: false, extra: [
      h('button.btn.ghost.small', { onclick: () => go('/shop/orders') }, icon('truck', 16), h('span.sh-hide-sm', ' Mes commandes')),
      myShopBtn, cart] }),
    h('div.search-box', icon('search', 18), search),
    shopsRow,
    h('div.list-title', 'Articles en vente'),
    grid, h('div.center', more)));

  const load = async (append = false) => {
    if (!append) { page = 1; clear(grid, spinner()); }
    try {
      const r = await api.get('shop/market', { q, page });
      if (!append) {
        clear(shopsRow, r.shops.length ? r.shops.map(s => h('button.sh-shop-chip', { type: 'button', onclick: () => go('/shop/s/' + s.slug) },
          s.logo ? h('img', { src: s.logo, alt: '' }) : avatar(null, s.name, 44), h('span', s.name))) : null);
        clear(grid);
      }
      grid.append(...r.results.map(productCard));
      if (!grid.children.length) clear(grid, empty('bag', q ? 'Aucun résultat' : 'Aucun article en vente', q ? 'Essayez un autre mot.' : 'Créez votre boutique et soyez le premier à vendre !'));
      more.classList.toggle('hidden', !r.has_more);
    } catch (e) { clear(grid, h('p.muted', e.message)); }
  };
  search.addEventListener('input', debounce(() => { q = search.value.trim(); load(); }, 300));
  load();
  return () => cart._off();
}

// ------------------------------------------------------------------ page d'une boutique

function renderShop(stage, { slug }) {
  const page = h('div.page.sh-page', spinner());
  stage.appendChild(page);
  const cart = cartButton();
  (async () => {
    let data;
    try { data = await api.get('shop/s/' + encodeURIComponent(slug)); } catch (e) { clear(page, topBar('Boutique'), h('p.muted', e.message)); return; }
    const { shop, products } = data;
    if (data.locked) {
      clear(page, topBar(shop.name, { extra: [cart] }),
        h('section.sh-box.sh-locked', icon('lock', 40), h('h3', 'Boutique momentanément fermée'),
          h('p.muted', shop.is_mine ? 'Votre abonnement est terminé : personne ne voit vos articles, pas même vous. Renouvelez-le pour rouvrir votre boutique.'
            : 'Cette boutique n’est pas disponible pour le moment. Revenez bientôt !'),
          shop.is_mine ? h('button.btn.primary', { onclick: () => go('/shop/subscribe') }, 'Renouveler mon abonnement') : null));
      return;
    }
    let cat = null;
    const grid = h('div.sh-grid');
    const paint = () => {
      const list = products.filter(p => !cat || (p.category && p.category.id === cat));
      clear(grid, list.length ? list.map(productCard) : empty('bag', 'Aucun article', shop.is_mine ? 'Ajoutez vos premiers articles depuis « Gérer ».' : 'Revenez bientôt !'));
    };
    const chips = h('div.filter-chips', [{ id: null, name: 'Tout' }, ...shop.categories].map(c => h('button.chip-filter' + (c.id === cat ? '.active' : ''), {
      type: 'button', onclick: e => { cat = c.id; chips.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); paint(); },
    }, c.name)));
    clear(page,
      topBar(shop.name, { extra: [shop.is_mine ? h('button.btn.primary.small', { onclick: () => go('/shop/manage') }, 'Gérer') : null, cart] }),
      h('section.sh-hero', { style: shop.cover ? { backgroundImage: `url("${shop.cover}")` } : null },
        h('div.sh-hero-in',
          shop.logo ? h('img.sh-logo', { src: shop.logo, alt: '' }) : h('div.sh-logo', avatar(null, shop.name, 72)),
          h('div', h('h1', shop.name), h('p', [shop.city, shop.is_open ? null : 'Fermée temporairement'].filter(Boolean).join(' · '))))),
      shop.description ? h('p.sh-desc', shop.description) : null,
      h('div.sh-info',
        shop.delivery_info ? h('span', icon('truck', 16), ' ', shop.delivery_info) : null,
        h('span', icon('bag', 16), ' Paiement à la livraison'),
        !shop.is_mine ? h('button.btn.ghost.small', { onclick: () => contactSeller(shop.owner.id) }, icon('chat', 16), ' Contacter le vendeur') : null),
      shop.categories.length ? chips : null,
      grid);
    paint();
  })();
  return () => cart._off();
}

async function contactSeller(userId) {
  try { const c = await api.post('conversations/direct', { user_id: userId }); go('/chats/' + c.id); } catch (e) { errorToast(e); }
}

// ------------------------------------------------------------------ page d'un article

function renderProduct(stage, { id }) {
  const page = h('div.page.sh-page.sh-narrow', spinner());
  stage.appendChild(page);
  const cart = cartButton();
  (async () => {
    let p;
    try { ({ product: p } = await api.get('shop/products/' + id)); } catch (e) { clear(page, topBar('Article'), h('p.muted', e.message)); return; }
    let qty = 1, idx = 0;
    const main = h('div.sh-gallery-main');
    const thumbs = h('div.sh-thumbs');
    const showImg = i => {
      idx = i;
      clear(main, p.images[i] ? h('img', { src: p.images[i], alt: p.title }) : h('div.sh-noimg', icon('bag', 48)));
      thumbs.querySelectorAll('img').forEach((t, k) => t.classList.toggle('active', k === i));
    };
    clear(thumbs, p.images.length > 1 ? p.images.map((src, i) => h('img', { src, alt: '', onclick: () => showImg(i) })) : null);
    showImg(0);
    const qtyLabel = h('strong', '1');
    const setQty = n => { qty = Math.max(1, Math.min(n, p.stock ?? 99)); qtyLabel.textContent = String(qty); };
    const mine = p.cost_price !== undefined;  // prix d'achat renvoyé au seul vendeur
    const add = async goCart => {
      try {
        const c = await api.post('shop/cart/set', { product_id: p.id, quantity: qty, add: true });
        bus.emit('shop:cart', c);
        if (goCart) go('/shop/cart');
        else toast('Ajouté au panier', { action: { label: 'Voir le panier', run: () => go('/shop/cart') } });
      } catch (e) { errorToast(e); }
    };
    clear(page,
      topBar(p.shop.name, { extra: [cart] }),
      h('div.sh-product',
        h('div.sh-gallery', main, thumbs),
        h('div.sh-pinfo',
          p.category ? h('small.muted', p.category.name) : null,
          h('h1', p.title),
          h('div.sh-pprice', money(p.price)),
          p.stock !== null ? h('p.muted.small', p.stock > 0 ? `${p.stock} en stock` : 'Rupture de stock') : null,
          p.description ? h('p.sh-pdesc', p.description) : null,
          h('button.sh-shopline', { type: 'button', onclick: () => go('/shop/s/' + p.shop.slug) },
            p.shop.logo ? h('img', { src: p.shop.logo, alt: '' }) : avatar(null, p.shop.name, 36), h('span', h('strong', p.shop.name), h('small', p.shop.city || 'Voir la boutique')), icon('back', 16, 'sh-flip')),
          mine ? h('div.sh-note', `Votre article · prix d'achat ${money(p.cost_price)} · bénéfice ${money(p.price - p.cost_price)} par vente`) : p.available ? h('div.sh-buy',
            h('div.sh-qty', h('button.icon-btn', { type: 'button', onclick: () => setQty(qty - 1), 'aria-label': 'Moins' }, '−'), qtyLabel,
              h('button.icon-btn', { type: 'button', onclick: () => setQty(qty + 1), 'aria-label': 'Plus' }, '+')),
            h('button.btn.ghost', { onclick: () => add(false) }, icon('cart', 18), ' Ajouter au panier'),
            h('button.btn.primary', { onclick: () => add(true) }, 'Acheter')) : h('p.sh-note', 'Cet article n’est pas disponible pour le moment.'),
          h('p.muted.small', '💵 Paiement à la livraison · frais de livraison confirmés par la boutique.'))));
  })();
  return () => cart._off();
}

// ------------------------------------------------------------------ panier

function renderCart(stage) {
  const page = h('div.page.sh-page.sh-narrow', spinner());
  stage.appendChild(page);
  const paint = c => {
    bus.emit('shop:cart', c);
    if (!c.groups.length) {
      clear(page, topBar('Mon panier'), empty('cart', 'Votre panier est vide', 'Parcourez les boutiques et ajoutez des articles.',
        h('button.btn.primary', { onclick: () => go('/shop') }, 'Voir les articles')));
      return;
    }
    const setQty = async (it, n) => { try { paint(await api.post('shop/cart/set', { product_id: it.product.id, quantity: n })); } catch (e) { errorToast(e); } };
    const address = h('textarea.input', { rows: 2, placeholder: 'Adresse de livraison (commune, quartier, repère…)', maxlength: 300 });
    const phone = h('input.input', { type: 'tel', placeholder: 'Téléphone pour la livraison', value: state.me.phone || '', maxlength: 32 });
    const note = h('input.input', { placeholder: 'Instructions (facultatif)', maxlength: 500 });
    const submit = h('button.btn.primary.block', { onclick: async () => {
      submit.disabled = true;
      try {
        const { orders } = await api.post('shop/checkout', { address: address.value, phone: phone.value, note: note.value });
        bus.emit('shop:cart', { count: 0 });
        toast(orders.length > 1 ? `${orders.length} commandes envoyées aux boutiques` : 'Commande envoyée à la boutique');
        go(orders.length === 1 ? '/shop/orders/' + orders[0].id : '/shop/orders');
      } catch (e) { errorToast(e); submit.disabled = false; }
    } }, `Commander · ${money(c.total)}`);
    clear(page, topBar('Mon panier'),
      c.groups.map(g => h('section.sh-box',
        h('div.sh-box-head', g.shop.logo ? h('img', { src: g.shop.logo, alt: '' }) : avatar(null, g.shop.name, 28), h('strong', g.shop.name)),
        g.items.map(it => h('div.sh-line',
          h('button.sh-line-img', { type: 'button', onclick: () => go('/shop/p/' + it.product.id) }, cover(it.product)),
          h('div.sh-line-text', h('span', it.product.title), h('strong', money(it.product.price)),
            it.product.available ? null : h('small.danger-text', 'Plus disponible')),
          h('div.sh-qty',
            h('button.icon-btn', { type: 'button', 'aria-label': 'Moins', onclick: () => setQty(it, it.quantity - 1) }, it.quantity > 1 ? '−' : icon('trash', 16)),
            h('strong', String(it.quantity)),
            h('button.icon-btn', { type: 'button', 'aria-label': 'Plus', onclick: () => setQty(it, it.quantity + 1) }, '+')))),
        h('div.sh-sum', h('span', 'Sous-total'), h('strong', money(g.subtotal))),
        h('div.sh-sum.muted', h('span', 'Livraison'), h('span', g.shop.delivery_fee ? `≈ ${money(g.shop.delivery_fee)} (confirmé par la boutique)` : 'Fixée par la boutique à la validation')))),
      h('section.sh-box',
        h('h3', 'Livraison'), address, phone, note,
        h('p.muted.small', '💵 Vous payez à la livraison. Chaque boutique valide votre commande et vous indique le prix de la livraison.'),
        submit));
  };
  api.get('shop/cart').then(paint).catch(e => clear(page, topBar('Mon panier'), h('p.muted', e.message)));
}

// ------------------------------------------------------------------ mes commandes (client)

function orderCard(o, onOpen) {
  return h('button.sh-order', { type: 'button', onclick: onOpen },
    h('div.sh-order-head', h('strong', o.role === 'seller' ? o.buyer.name : o.shop.name), statusBadge(o)),
    h('small.muted', `${o.code} · ${listTime(o.created_at)} · ${o.items.reduce((n, i) => n + i.quantity, 0)} article(s)`),
    h('div.sh-order-items', o.items.slice(0, 4).map(i => i.image ? h('img', { src: i.image, alt: '' }) : h('div.sh-noimg.small', icon('bag', 16)))),
    h('div.sh-sum', h('span', 'Total'), h('strong', money(o.total))));
}

function renderOrders(stage) {
  const list = h('div.sh-orders', spinner());
  stage.appendChild(h('div.page.sh-page.sh-narrow', topBar('Mes commandes'), list));
  const load = async () => {
    try {
      const { results } = await api.get('shop/orders');
      clear(list, results.length ? results.map(o => orderCard(o, () => go('/shop/orders/' + o.id)))
        : empty('truck', 'Aucune commande', 'Vos achats et leur suivi apparaîtront ici.', h('button.btn.primary', { onclick: () => go('/shop') }, 'Voir les articles')));
    } catch (e) { clear(list, h('p.muted', e.message)); }
  };
  load();
  return bus.on('shop.order', load);
}

function tracking(o) {
  if (o.status === 'refused' || o.status === 'cancelled') {
    return h('div.sh-track-stop', icon('close', 18), h('span', o.status_label + (o.reason ? ` : ${o.reason}` : '')));
  }
  const reached = STEPS.findIndex(([k]) => k === o.status);
  return h('ol.sh-track', STEPS.map(([k, label], i) => {
    const ev = [...o.events].reverse().find(e => e.status === k);
    return h('li' + (i <= reached ? '.done' : '') + (i === reached ? '.current' : ''),
      h('span.sh-dot', i < reached || o.status === 'delivered' ? icon('check', 14) : ''), h('div', h('strong', label), ev ? h('small', listTime(ev.at)) : null));
  }));
}

function orderBody(o) {
  return [
    h('section.sh-box', h('div.sh-box-head', h('strong', o.code), statusBadge(o)), tracking(o),
      o.events.length ? h('details.sh-history', h('summary', 'Historique'), o.events.map(e => h('p', h('small.muted', listTime(e.at) + ' · '), e.label, e.note ? ` — ${e.note}` : ''))) : null),
    h('section.sh-box',
      o.items.map(i => h('div.sh-line',
        h('div.sh-line-img', i.image ? h('img', { src: i.image, alt: '' }) : h('div.sh-noimg', icon('bag', 20))),
        h('div.sh-line-text', h('span', i.title), h('small.muted', `${i.quantity} × ${money(i.price)}`)), h('strong', money(i.subtotal)))),
      h('div.sh-sum', h('span', 'Articles'), h('span', money(o.items_total))),
      h('div.sh-sum', h('span', 'Livraison'), h('span', o.status === 'pending' ? 'à confirmer par la boutique' : money(o.delivery_fee))),
      h('div.sh-sum.total', h('span', 'Total à payer à la livraison'), h('strong', money(o.total))),
      o.role === 'seller' ? h('div.sh-sum.profit', h('span', 'Votre bénéfice'), h('strong', money(o.profit))) : null),
    h('section.sh-box',
      h('div.sh-kv', h('span', icon('location', 16), ' Livraison'), h('span', o.address)),
      h('div.sh-kv', h('span', icon('phone', 16), ' Téléphone'), h('a', { href: 'tel:' + o.phone }, o.phone)),
      o.note ? h('div.sh-kv', h('span', icon('info', 16), ' Note'), h('span', o.note)) : null),
  ];
}

function renderOrder(stage, { id }) {
  const page = h('div.page.sh-page.sh-narrow', spinner());
  stage.appendChild(page);
  let order = null;
  const paint = () => {
    const o = order;
    const act = async (action, data) => { try { ({ order } = await api.post(`shop/orders/${o.id}/${action}`, data || {})); paint(); } catch (e) { errorToast(e); } };
    clear(page, topBar('Suivi de commande'),
      h('div.sh-order-shop', h('button.sh-shopline', { type: 'button', onclick: () => go('/shop/s/' + o.shop.slug) },
        o.shop.logo ? h('img', { src: o.shop.logo, alt: '' }) : avatar(null, o.shop.name, 36), h('span', h('strong', o.shop.name), h('small', 'Voir la boutique')))),
      ...orderBody(o),
      h('div.sh-actions',
        ['accepted', 'shipping'].includes(o.status) ? h('button.btn.primary', { onclick: async () => {
          if (await confirmDialog('Confirmez-vous avoir reçu votre commande (et payé le livreur) ?', { ok: "Oui, j'ai reçu" })) act('delivered');
        } }, icon('check', 18), " J'ai reçu ma commande") : null,
        ['pending', 'accepted'].includes(o.status) ? h('button.btn.ghost', { onclick: async () => {
          const reason = await promptDialog('Annuler la commande', { placeholder: 'Motif (facultatif)', ok: 'Annuler la commande' });
          if (reason !== null) act('cancel', { reason });
        } }, 'Annuler la commande') : null,
        h('button.btn.ghost', { onclick: () => contactSeller(o.shop.owner_id) }, icon('chat', 16), ' Contacter la boutique')));
  };
  api.get('shop/orders/' + id).then(r => { order = r.order; paint(); }).catch(e => clear(page, topBar('Suivi de commande'), h('p.muted', e.message)));
  // Suivi en temps réel : chaque étape validée par la boutique s'affiche aussitôt.
  return bus.on('shop.order', ({ order: o }) => { if (order && o.id === order.id) { order = o; paint(); } });
}

// ------------------------------------------------------------------ espace vendeur

function renderManage(stage, params) {
  const page = h('div.page.sh-page', spinner());
  stage.appendChild(page);
  let shop = null, sub = null, tab = params.tab || 'orders';
  const offs = [];
  const body = h('div.sh-manage-body');

  const load = async () => {
    try { ({ shop, subscription: sub } = await api.get('shop/me')); } catch (e) { clear(page, h('p.muted', e.message)); return; }
    if (!sub.active) {
      // Pas (ou plus) d'abonnement : boutique fermée, on ne montre que l'abonnement.
      clear(page, topBar(shop ? shop.name : 'Créer ma boutique'), subscribePanel(sub, shop));
      return;
    }
    if (!shop) return createForm();
    const tabs = h('div.sh-tabs', [['orders', 'Commandes', 'truck'], ['products', 'Articles', 'bag'], ['stats', 'Statistiques', 'poll'], ['settings', 'Ma boutique', 'store']]
      .map(([k, label, ic]) => h('button' + (k === tab ? '.active' : ''), { type: 'button', onclick: () => { tab = k; history.replaceState({}, '', '/shop/manage/' + k); load(); } }, icon(ic, 18), h('span', label))));
    clear(page,
      topBar(shop.name, { extra: [h('button.btn.ghost.small', { onclick: () => go('/shop/s/' + shop.slug) }, 'Voir ma vitrine')] }),
      sub.renew_soon ? renewBanner(sub) : null,
      tabs, body);
    ({ orders: ordersTab, products: productsTab, stats: statsTab, settings: settingsTab }[tab] || ordersTab)();
  };

  function createForm() {
    clear(page, topBar('Créer ma boutique'),
      h('section.sh-box.sh-intro', icon('store', 40), h('h3', 'Vendez vos articles sur Kozons'),
        h('p.muted', 'Un compte = une boutique. Créez-la, ajoutez jusqu’à 3 catégories et publiez vos articles. Vos clients paient à la livraison.'),
        h('span.sh-sub-chip.ok', icon('check', 14), ` Abonnement actif jusqu’au ${dateFr(sub.expires_at)}`)),
      shopForm(null, saved => { shop = saved; tab = 'products'; toast('Boutique créée 🎉'); load(); }));
  }

  // --- commandes reçues
  function ordersTab() {
    let filter = 'open';
    const list = h('div.sh-orders', spinner());
    const chips = h('div.filter-chips', [['open', 'En cours'], ['delivered', 'Livrées'], ['all', 'Toutes']].map(([k, l]) =>
      h('button.chip-filter' + (k === filter ? '.active' : ''), { type: 'button', onclick: e => { filter = k; chips.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); refresh(); } }, l)));
    const refresh = async () => {
      try {
        const { results } = await api.get('shop/me/orders', filter === 'all' ? {} : { status: filter });
        clear(list, results.length ? results.map(sellerOrder) : empty('truck', 'Aucune commande', filter === 'open' ? 'Les nouvelles commandes apparaîtront ici en temps réel.' : ''));
      } catch (e) { clear(list, h('p.muted', e.message)); }
    };
    const sellerOrder = o => {
      const act = async (action, data) => { try { await api.post(`shop/orders/${o.id}/${action}`, data || {}); refresh(); } catch (e) { errorToast(e); } };
      return h('section.sh-box.sh-sorder',
        h('div.sh-box-head', avatar(o.buyer.avatar, o.buyer.name, 32), h('div', h('strong', o.buyer.name), h('small.muted', ` ${o.code} · ${listTime(o.created_at)}`)), statusBadge(o)),
        o.items.map(i => h('div.sh-sum', h('span', `${i.quantity} × ${i.title}`), h('span', money(i.subtotal)))),
        h('div.sh-sum', h('span', 'Livraison'), h('span', o.status === 'pending' ? 'à fixer' : money(o.delivery_fee))),
        h('div.sh-sum.total', h('span', 'Total client'), h('strong', money(o.total))),
        h('div.sh-sum.profit', h('span', 'Bénéfice'), h('strong', money(o.profit))),
        h('div.sh-kv', h('span', icon('location', 16)), h('span', o.address)),
        h('div.sh-kv', h('span', icon('phone', 16)), h('a', { href: 'tel:' + o.phone }, o.phone), o.note ? h('small.muted', ' · ' + o.note) : null),
        h('div.sh-actions',
          o.status === 'pending' ? [
            h('button.btn.primary.small', { onclick: async () => {
              const fee = await promptDialog('Frais de livraison (FCFA)', { value: String(o.delivery_fee || shop.default_delivery_fee || 0), ok: 'Valider la commande' });
              if (fee !== null) act('accept', { delivery_fee: fee.replace(/\s/g, '') || 0 });
            } }, icon('check', 16), ' Valider'),
            h('button.btn.ghost.small', { onclick: async () => {
              const reason = await promptDialog('Refuser la commande', { placeholder: 'Motif (ex. rupture de stock)', ok: 'Refuser' });
              if (reason !== null) act('refuse', { reason });
            } }, 'Refuser')] : null,
          o.status === 'accepted' ? h('button.btn.primary.small', { onclick: () => act('ship') }, icon('truck', 16), ' En livraison') : null,
          ['accepted', 'shipping'].includes(o.status) ? h('button.btn.ghost.small', { onclick: async () => {
            if (await confirmDialog('Confirmer que la commande a été livrée et payée ?', { ok: 'Livrée' })) act('delivered');
          } }, 'Marquer livrée') : null,
          h('button.btn.ghost.small', { onclick: () => contactSeller(o.buyer.id) }, icon('chat', 16), ' Client')));
    };
    clear(body, chips, list);
    refresh();
    offs.push(bus.on('shop.order', ({ order: o }) => { if (o.role === 'seller' && tab === 'orders') refresh(); }));
  }

  // --- articles
  function productsTab() {
    const grid = h('div.sh-grid', spinner());
    clear(body,
      h('div.row.gap.sh-row', h('button.btn.primary', { onclick: () => productDialog(shop, null, refresh) }, icon('plus', 18), ' Ajouter un article'),
        h('span.muted.small', `${shop.categories.length}/3 catégories`)),
      grid);
    const refresh = async () => {
      try {
        const { results } = await api.get('shop/me/products');
        clear(grid, results.length ? results.map(p => h('div.sh-mcard',
          h('button.sh-card' + (p.is_active ? '' : '.soldout'), { type: 'button', onclick: () => productDialog(shop, p, refresh) },
            h('div.sh-card-img', cover(p), p.is_active ? null : h('span.sh-soldout', 'Masqué')),
            h('div.sh-card-body', h('strong.sh-price', money(p.price)), h('span.sh-card-title', p.title),
              h('small.muted', `Achat ${money(p.cost_price)} · ${p.stock === null ? 'stock illimité' : p.stock + ' en stock'} · ${p.sold_count} vendu(s)`)))))
          : empty('bag', 'Aucun article', 'Ajoutez votre premier article avec ses photos et son prix.'));
      } catch (e) { clear(grid, h('p.muted', e.message)); }
    };
    refresh();
  }

  // --- statistiques
  function statsTab() {
    let days = 30;
    const box = h('div', spinner());
    const periods = h('div.filter-chips', [[7, '7 jours'], [30, '30 jours'], [90, '3 mois'], [0, 'Tout']].map(([d, l]) =>
      h('button.chip-filter' + (d === days ? '.active' : ''), { type: 'button', onclick: e => { days = d; periods.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); refresh(); } }, l)));
    clear(body, periods, box);
    const refresh = async () => {
      try {
        const { stats: s } = await api.get('shop/me/stats', days ? { days } : {});
        const max = Math.max(1, ...s.daily.map(d => d.sales));
        const card = (label, value, cls = '') => h('div.sh-stat' + cls, h('small', label), h('strong', value));
        clear(box,
          h('div.sh-stats',
            card('Commandes', String(s.orders)),
            card('Chiffre d’affaires', money(s.sales)),
            card('Bénéfice', money(s.profit), '.good'),
            card('Coût des articles', money(s.cost)),
            card('Frais de livraison', money(s.delivery_fees)),
            card('En cours', `${s.open_orders} · ${money(s.pending_value)}`)),
          h('p.muted.small', 'Chiffre d’affaires et bénéfice : commandes livrées. Bénéfice = ventes − prix d’achat des articles.'),
          h('section.sh-box', h('h3', 'Ventes par jour'),
            h('div.sh-chart', s.daily.map(d => h('div.sh-bar', { title: `${new Date(d.date).toLocaleDateString('fr-FR')} : ${money(d.sales)}` },
              h('span', { style: { height: Math.round((d.sales / max) * 100) + '%' } })))),
            h('div.sh-chart-axis', h('small', new Date(s.daily[0].date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })),
              h('small', new Date(s.daily[s.daily.length - 1].date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })))),
          h('section.sh-box', h('h3', 'Statut des commandes'),
            [['pending', 'En attente'], ['accepted', 'Validées'], ['shipping', 'En livraison'], ['delivered', 'Livrées'], ['refused', 'Refusées'], ['cancelled', 'Annulées']]
              .map(([k, l]) => h('div.sh-sum', h('span', l), h('strong', String(s.by_status[k] || 0))))),
          s.top_products.length ? h('section.sh-box', h('h3', 'Meilleures ventes'),
            s.top_products.map(t => h('div.sh-sum', h('span', `${t.title} (${t.quantity})`), h('strong', money(t.amount))))) : null,
          h('p.muted.small', `${s.products} article(s) · ${s.customers} client(s)`));
      } catch (e) { clear(box, h('p.muted', e.message)); }
    };
    refresh();
  }

  // --- réglages de la boutique + catégories (3 max)
  function settingsTab() {
    const cats = h('div.sh-cats');
    const paintCats = () => clear(cats,
      shop.categories.map(c => h('div.sh-cat', h('span', c.name),
        btn('edit', 'Renommer', async () => {
          const name = await promptDialog('Renommer la catégorie', { value: c.name, maxlength: 40 });
          if (name) catAction({ action: 'rename', id: c.id, name });
        }),
        btn('trash', 'Supprimer', async () => {
          if (await confirmDialog(`Supprimer la catégorie « ${c.name} » ? Ses articles restent en vente, sans catégorie.`, { ok: 'Supprimer', danger: true })) catAction({ action: 'delete', id: c.id });
        }))),
      shop.categories.length < 3 ? h('button.btn.ghost.small', { onclick: async () => {
        const name = await promptDialog('Nouvelle catégorie', { placeholder: 'Ex. Robes, Accessoires…', maxlength: 40 });
        if (name) catAction({ action: 'add', name });
      } }, icon('plus', 16), ' Ajouter une catégorie') : h('small.muted', '3 catégories au maximum.'));
    const catAction = async data => { try { ({ shop } = await api.post('shop/me/categories', data)); paintCats(); } catch (e) { errorToast(e); } };
    paintCats();
    clear(body,
      h('section.sh-box', h('h3', 'Abonnement'),
        h('div.sh-sum', h('span', 'Actif jusqu’au'), h('strong', dateFr(sub.expires_at))),
        h('p.muted.small', `${sub.days_left} jour(s) restant(s). Une nouvelle période s’ajoute à la fin de l’abonnement en cours.`),
        h('button.btn.ghost.small', { onclick: () => go('/shop/subscribe') }, 'Prolonger mon abonnement')),
      h('section.sh-box', h('h3', 'Catégories (3 au maximum)'), cats),
      shopForm(shop, saved => { shop = saved; toast('Boutique enregistrée'); load(); }));
  }

  load();
  offs.push(bus.on('shop.subscription', () => load()));
  return () => offs.forEach(f => f());
}

// ------------------------------------------------------------------ abonnement (GeniusPay)

const dateFr = iso => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

function renewBanner(sub) {
  return h('div.sh-renew', icon('clock', 18),
    h('span', sub.days_left ? `Votre abonnement se termine dans ${sub.days_left} jour(s) (${dateFr(sub.expires_at)}).` : `Votre abonnement se termine le ${dateFr(sub.expires_at)}.`,
      ' Sans renouvellement, votre boutique sera fermée.'),
    h('button.btn.primary.small', { onclick: () => go('/shop/subscribe') }, 'Renouveler'));
}

// Choix de la formule puis paiement sur la page sécurisée GeniusPay (Wave, Orange Money, MTN, Moov, carte).
function subscribePanel(sub, shop) {
  let months = 1;
  const plans = h('div.sh-plans');
  const phone = h('input.input', { type: 'tel', placeholder: 'Numéro Mobile Money (facultatif)', value: state.me.phone || '', maxlength: 32 });
  const pay = h('button.btn.primary.block');
  const paint = () => {
    const chosen = sub.plans.find(p => p.months === months);
    clear(plans, sub.plans.map(p => h('button.sh-plan' + (p.months === months ? '.active' : ''), { type: 'button', onclick: () => { months = p.months; paint(); } },
      h('strong', p.label), h('span.sh-plan-price', money(p.price)),
      h('small.muted', p.months === 1 ? 'par mois' : `${p.months} mois`))));
    pay.textContent = `Payer ${money(chosen.price)}`;
    pay.disabled = !sub.payment_available;
  };
  pay.onclick = async () => {
    pay.disabled = true;
    try {
      const { checkout_url } = await api.post('shop/subscription/pay', { months, phone: phone.value.trim() });
      window.location.href = checkout_url;   // page de paiement GeniusPay, retour sur /shop/subscribe
    } catch (e) { errorToast(e); pay.disabled = false; }
  };
  paint();
  const closed = shop && sub.expired;
  return h('div.sh-narrow',
    h('section.sh-box.sh-intro' + (closed ? '.sh-locked' : ''), icon(closed ? 'lock' : 'store', 40),
      h('h3', closed ? 'Votre boutique est fermée' : shop ? 'Abonnement boutique' : 'Abonnez-vous pour ouvrir votre boutique'),
      h('p.muted', closed
        ? `Votre abonnement s’est terminé le ${dateFr(sub.expires_at)}. Vos articles sont invisibles pour tout le monde, vous compris, jusqu’au renouvellement. Tout réapparaît dès le paiement.`
        : `Vendre sur Kozons coûte ${money(sub.plans[0].price)} par mois. Choisissez la durée qui vous convient : vous payez une fois, sans renouvellement automatique.`)),
    h('section.sh-box',
      h('h3', 'Choisissez votre formule'), plans,
      phone,
      sub.payment_available ? null : h('p.danger-text.small', 'Le paiement en ligne est indisponible pour le moment. Réessayez plus tard.'),
      pay,
      h('p.muted.small', '🔒 Paiement sécurisé par GeniusPay : Wave, Orange Money, MTN MoMo, Moov Money ou carte bancaire.')));
}

// /shop/subscribe : choix de la formule, ou retour de GeniusPay (?payment=ID&status=success|error).
function renderSubscribe(stage) {
  const page = h('div.page.sh-page', spinner());
  stage.appendChild(page);
  const qs = new URLSearchParams(location.search);
  const paymentId = +qs.get('payment');
  let stopped = false, timer = null;
  const showPlans = async () => {
    try {
      const { shop, subscription } = await api.get('shop/me');
      clear(page, topBar('Abonnement boutique'), subscribePanel(subscription, shop));
    } catch (e) { clear(page, topBar('Abonnement boutique'), h('p.muted', e.message)); }
  };
  if (!paymentId) { showPlans(); return () => {}; }
  history.replaceState({}, '', '/shop/subscribe');
  const box = h('section.sh-box.sh-intro', spinner(), h('h3', 'Vérification du paiement…'), h('p.muted', 'Cela prend quelques secondes.'));
  clear(page, topBar('Abonnement boutique'), h('div.sh-narrow', box));
  let tries = 0;
  const check = async () => {
    if (stopped) return;
    try {
      const { payment, subscription } = await api.get('shop/subscription/payments/' + paymentId);
      if (payment.status === 'completed') {
        clear(box, icon('check', 40), h('h3', 'Paiement reçu 🎉'),
          h('p.muted', `Abonnement ${payment.label.toLowerCase()} actif jusqu’au ${dateFr(subscription.expires_at)}.`),
          h('button.btn.primary', { onclick: () => go('/shop/manage') }, 'Aller à ma boutique'));
        return;
      }
      if (payment.status !== 'pending' || (qs.get('status') === 'error' && tries >= 2) || tries >= 40) {
        clear(box, icon('close', 40), h('h3', payment.status === 'pending' ? 'Paiement non confirmé' : 'Paiement non abouti'),
          h('p.muted', payment.status === 'pending'
            ? 'Nous n’avons pas encore reçu la confirmation de GeniusPay. Si vous avez été débité, votre abonnement s’activera automatiquement dans quelques minutes.'
            : 'Le paiement a échoué ou a été annulé. Aucun montant n’a été prélevé pour cet essai.'),
          h('button.btn.primary', { onclick: showPlans }, 'Choisir une formule'));
        return;
      }
    } catch (e) { if (tries >= 3) { clear(box, h('p.muted', e.message)); return; } }
    tries++;
    timer = setTimeout(check, 3000);
  };
  check();
  // Confirmation par le webhook : l'écran se met à jour aussitôt.
  const off = bus.on('shop.subscription', () => { clearTimeout(timer); tries = Math.min(tries, 39); check(); });
  return () => { stopped = true; clearTimeout(timer); off(); };
}

function shopForm(shop, onSaved) {
  const v = shop || {};
  const name = h('input.input', { placeholder: 'Nom de la boutique', value: v.name || '', maxlength: 80 });
  const description = h('textarea.input', { rows: 3, placeholder: 'Présentez votre boutique', maxlength: 1000 }, v.description || '');
  const city = h('input.input', { placeholder: 'Ville / commune', value: v.city || '', maxlength: 80 });
  const address = h('input.input', { placeholder: 'Adresse (facultatif)', value: v.address || '', maxlength: 200 });
  const phone = h('input.input', { type: 'tel', placeholder: 'Téléphone de la boutique', value: v.phone || state.me.phone || '', maxlength: 32 });
  const fee = h('input.input', { type: 'number', min: 0, step: 100, placeholder: 'Frais de livraison habituels (FCFA)', value: v.default_delivery_fee ?? '' });
  const delivery = h('input.input', { placeholder: 'Zones et délais de livraison (ex. Abidjan, 24 h)', value: v.delivery_info || '', maxlength: 300 });
  const open = h('input', { type: 'checkbox', checked: v.is_open !== false });
  const cats = shop ? null : [0, 1, 2].map(i => h('input.input', { placeholder: `Catégorie ${i + 1}${i ? ' (facultatif)' : ''}`, maxlength: 40 }));
  let logo = null, coverFile = null;
  const logoPrev = h('div.sh-logo-pick', v.logo ? h('img', { src: v.logo, alt: '' }) : icon('image', 26));
  const coverPrev = h('div.sh-cover-pick', { style: v.cover ? { backgroundImage: `url("${v.cover}")` } : null }, v.cover ? null : h('span', icon('image', 22), ' Photo de couverture'));
  logoPrev.onclick = async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) { logo = f; clear(logoPrev, h('img', { src: URL.createObjectURL(f), alt: '' })); } };
  coverPrev.onclick = async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) { coverFile = f; coverPrev.style.backgroundImage = `url("${URL.createObjectURL(f)}")`; clear(coverPrev); } };
  const save = h('button.btn.primary.block', { onclick: async () => {
    const fd = new FormData();
    fd.append('name', name.value.trim());
    [['description', description.value], ['city', city.value], ['address', address.value], ['phone', phone.value], ['delivery_info', delivery.value]].forEach(([k, val]) => fd.append(k, val));
    fd.append('default_delivery_fee', fee.value || '0');
    fd.append('is_open', open.checked ? '1' : '0');
    if (cats) cats.forEach(c => c.value.trim() && fd.append('categories', c.value.trim()));
    if (logo) fd.append('logo', logo);
    if (coverFile) fd.append('cover', coverFile);
    save.disabled = true;
    try { const { shop: s } = await api.post('shop/me', fd); onSaved(s); } catch (e) { errorToast(e); save.disabled = false; }
  } }, shop ? 'Enregistrer' : 'Créer ma boutique');
  return h('section.sh-box.sh-form',
    coverPrev, h('div.row.gap', logoPrev, h('div.grow', name)),
    description, h('div.sh-2col', city, phone), address,
    h('div.sh-2col', fee, delivery),
    cats ? [h('small.muted', 'Catégories de vos articles (3 au maximum, modifiables plus tard)'), ...cats] : null,
    shop ? h('label.mt-check', open, h('span', 'Boutique ouverte (accepte les commandes)')) : null,
    save);
}

function productDialog(shop, p, onSaved) {
  const v = p || {};
  const title = h('input.input', { placeholder: "Titre de l'article", value: v.title || '', maxlength: 120 });
  const desc = h('textarea.input', { rows: 4, placeholder: 'Description (taille, couleur, état…)', maxlength: 3000 }, v.description || '');
  const price = h('input.input', { type: 'number', min: 1, placeholder: 'Prix de vente (FCFA)', value: v.price ?? '' });
  const cost = h('input.input', { type: 'number', min: 0, placeholder: "Prix d'achat (privé)", value: v.cost_price ?? '' });
  const stock = h('input.input', { type: 'number', min: 0, placeholder: 'Stock (vide = illimité)', value: v.stock ?? '' });
  const cat = h('select.input', h('option', { value: '' }, 'Sans catégorie'), shop.categories.map(c => h('option', { value: c.id, selected: v.category && v.category.id === c.id }, c.name)));
  const active = h('input', { type: 'checkbox', checked: v.is_active !== false });
  const margin = h('small.muted');
  const paintMargin = () => { const m = (+price.value || 0) - (+cost.value || 0); margin.textContent = price.value ? `Bénéfice par vente : ${money(m)}` : ''; };
  price.oninput = cost.oninput = paintMargin;
  paintMargin();
  let keep = [...(v.images || [])];
  const added = [];
  const photos = h('div.sh-photos');
  const paintPhotos = () => clear(photos,
    keep.map(src => h('div.sh-photo', h('img', { src, alt: '' }), h('button', { type: 'button', 'aria-label': 'Retirer', onclick: () => { keep = keep.filter(x => x !== src); paintPhotos(); } }, '×'))),
    added.map(f => h('div.sh-photo', h('img', { src: f.url, alt: '' }), h('button', { type: 'button', 'aria-label': 'Retirer', onclick: () => { added.splice(added.indexOf(f), 1); paintPhotos(); } }, '×'))),
    keep.length + added.length < 5 ? h('button.sh-photo.add', { type: 'button', onclick: async () => {
      const files = await pickFiles({ accept: 'image/*', multiple: true });
      files.slice(0, 5 - keep.length - added.length).forEach(file => added.push({ file, url: URL.createObjectURL(file) }));
      paintPhotos();
    } }, icon('camera', 22), h('small', 'Ajouter')) : null);
  paintPhotos();
  const save = h('button.btn.primary', { onclick: async () => {
    const fd = new FormData();
    fd.append('title', title.value.trim());
    fd.append('description', desc.value.trim());
    fd.append('price', price.value);
    fd.append('cost_price', cost.value || '0');
    fd.append('stock', stock.value);
    fd.append('category_id', cat.value);
    fd.append('is_active', active.checked ? '1' : '0');
    keep.forEach(src => fd.append('keep', src));
    added.forEach(a => fd.append('images', a.file));
    save.disabled = true;
    try {
      await api.post(p ? `shop/me/products/${p.id}/update` : 'shop/me/products', fd);
      dlg.close();
      toast(p ? 'Article mis à jour' : 'Article publié');
      onSaved();
    } catch (e) { errorToast(e); save.disabled = false; }
  } }, p ? 'Enregistrer' : 'Publier');
  const dlg = modal(h('div.sh-form',
    h('small.muted', 'Photos (5 au maximum)'), photos,
    title, desc, h('div.sh-2col', price, cost), margin, h('div.sh-2col', stock, cat),
    p ? h('label.mt-check', active, h('span', 'En vente (visible dans la vitrine)')) : null,
    h('div.modal-actions',
      p ? h('button.btn.ghost', { onclick: async () => {
        if (!await confirmDialog(`Supprimer « ${p.title} » ?`, { ok: 'Supprimer', danger: true })) return;
        try { await api.post(`shop/me/products/${p.id}/delete`); dlg.close(); onSaved(); } catch (e) { errorToast(e); }
      } }, 'Supprimer') : null,
      h('button.btn.ghost', { onclick: () => dlg.close() }, 'Annuler'), save)),
  { title: p ? "Modifier l'article" : 'Nouvel article', wide: true });
}
