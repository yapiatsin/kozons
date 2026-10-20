// Point d'entrée : authentification, coque de l'application, routeur, événements globaux.
import { api } from './api.js';
import { bus, state, prefs } from './store.js';
import { connect, disconnect } from './ws.js';
import { h, clear, icon, avatar, toast, menu } from './ui.js';
import { installRealtime, loadConversations, notifyMessage } from './chatdata.js';
import { renderAuth } from './views/auth.js';
import { installCalls } from './views/calls.js';
import { syncPush, disablePush, askForPush } from './push.js';
import { isActive, lastActiveAt, onActivityChange } from './activity.js';

const ROUTES = [
  [/^\/$/, () => import('./views/chats.js'), () => ({})],
  [/^\/chats\/(\d+)$/, () => import('./views/chats.js'), m => ({ id: +m[1] })],
  [/^\/status$/, () => import('./views/status.js'), () => ({})],
  [/^\/people$/, () => import('./views/people.js'), () => ({})],
  [/^\/invite\/([\w-]+)$/, () => import('./views/people.js'), m => ({ invite: m[1] })],
  [/^\/calls$/, () => import('./views/calls.js'), () => ({ page: true })],
  [/^\/feed$/, () => import('./views/feed.js'), () => ({})],
  [/^\/explore$/, () => import('./views/explore.js'), () => ({ q: new URLSearchParams(location.search).get('q') || '' })],
  [/^\/reels$/, () => import('./views/reels.js'), () => ({})],
  [/^\/live$/, () => import('./views/live.js'), () => ({})],
  [/^\/live\/new$/, () => import('./views/live.js'), () => ({ new: true })],
  [/^\/live\/(\d+)$/, () => import('./views/live.js'), m => ({ id: +m[1] })],
  [/^\/meet$/, () => import('./views/meet.js'), () => ({})],
  [/^\/meet\/notes$/, () => import('./views/meet.js'), () => ({ notes: true })],
  [/^\/meet\/notes\/(\d+)$/, () => import('./views/meet.js'), m => ({ notes: true, id: +m[1] })],
  [/^\/meet\/([a-z0-9-]+)$/i, () => import('./views/meet.js'), m => ({ code: m[1].toLowerCase() })],
  [/^\/shop$/, () => import('./views/shop.js'), () => ({ page: 'market' })],
  [/^\/shop\/s\/([^/]+)$/, () => import('./views/shop.js'), m => ({ page: 'shop', slug: decodeURIComponent(m[1]) })],
  [/^\/shop\/p\/(\d+)$/, () => import('./views/shop.js'), m => ({ page: 'product', id: +m[1] })],
  [/^\/shop\/cart$/, () => import('./views/shop.js'), () => ({ page: 'cart' })],
  [/^\/shop\/orders$/, () => import('./views/shop.js'), () => ({ page: 'orders' })],
  [/^\/shop\/orders\/(\d+)$/, () => import('./views/shop.js'), m => ({ page: 'order', id: +m[1] })],
  [/^\/shop\/manage(?:\/(\w+))?$/, () => import('./views/shop.js'), m => ({ page: 'manage', tab: m[1] })],
  [/^\/shop\/subscribe$/, () => import('./views/shop.js'), () => ({ page: 'subscribe' })],
  [/^\/brady$/, () => import('./views/brady.js'), () => ({})],
  [/^\/brady\/(\d+)$/, () => import('./views/brady.js'), m => ({ id: +m[1] })],
  [/^\/notifications$/, () => import('./views/notifications.js'), () => ({})],
  [/^\/u\/([^/]+)$/, () => import('./views/profile.js'), m => ({ username: decodeURIComponent(m[1]) })],
  [/^\/p\/(\d+)$/, () => import('./views/post.js'), m => ({ id: +m[1] })],
  [/^\/settings$/, () => import('./views/settings.js'), () => ({})],
  [/^\/starred$/, () => import('./views/settings.js'), () => ({ starred: true })],
];

// Navigation regroupée (comme WhatsApp : peu d'onglets, avec libellés sur téléphone).
//  - Discussions, Statuts et Appels : accès direct ;
//  - « Actus » : le réseau social (fil, explorer, reels, LIVE) + « Créer » ;
//  - « Services » : Meet, Boutique, Brady ;
//  - « Moi » (téléphone) : profil, notifications, messages importants, paramètres.
const SOCIAL_VIEWS = ['feed', 'explore', 'reels', 'live'];
const SERVICE_VIEWS = ['meet', 'shop', 'brady'];
const ME_VIEWS = ['profile', 'notifications', 'settings', 'people'];
const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
let currentView = '';

let stage = null;
let current = { module: null, cleanup: null };
let navEls = {};

function applyTheme() {
  const t = prefs.get('theme', 'system');
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

async function boot() {
  applyTheme();
  window.kozons = { go, applyTheme, logout };
  window.addEventListener('popstate', () => route());
  // Session fermée par le serveur (ex. inactivité) : retour à l'écran de connexion.
  window.addEventListener('kozons:unauthorized', () => {
    if (!state.me) return;
    if (!state.remember && Date.now() - lastActiveAt() > IDLE_MS) try { sessionStorage.setItem('kozons.idleLogout', '1'); } catch (e) { /* ignoré */ }
    logoutLocal();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'open' && e.data.url) go(e.data.url); });
  }
  let me = null;
  try { ({ user: me, remember: state.remember } = await api.get('me')); } catch (e) { /* hors ligne */ }
  if (me) start(me); else showAuth();
}

function showAuth() {
  const root = document.getElementById('app');
  let notice = '';
  try {
    if (sessionStorage.getItem('kozons.idleLogout')) {
      notice = `Vous avez été déconnecté(e) après ${Math.round(IDLE_MS / 60000)} minutes d'absence.`;
      sessionStorage.removeItem('kozons.idleLogout');
    }
  } catch (e) { /* ignoré */ }
  // Lien d'invitation (kozonstic.com/invite/<code>) : retenu jusqu'à l'inscription.
  let invite = '';
  const m = location.pathname.match(/^\/invite\/([\w-]+)$/);
  try {
    if (m) localStorage.setItem('kozons.invite', m[1]);
    invite = m ? m[1] : localStorage.getItem('kozons.invite') || '';
  } catch (e) { invite = m ? m[1] : ''; }
  renderAuth(root, (user, remember) => { state.remember = !!remember; start(user); }, { notice, invite });
}

async function start(me) {
  state.me = me;
  const root = document.getElementById('app');
  clear(root, shell());
  installRealtime(notifyMessage);
  installCalls();
  connect();
  syncPush();
  watchIdle();
  bus.on('ws:status', s => {
    state.wsStatus = s;
    document.body.classList.toggle('is-offline', s === 'offline');
  });
  // Un compte suivi passe en LIVE (application ouverte).
  bus.on('live.started', ({ live }) => {
    if (!live || live.is_host || location.pathname.startsWith('/live/')) return;
    toast(`🔴 ${live.host.name} est en LIVE${live.title ? ' : ' + live.title : ''}`, {
      timeout: 8000, action: { label: 'Regarder', run: () => go('/live/' + live.id) },
    });
  });
  // Kozons Meet : invitation à une réunion, notes IA prêtes.
  bus.on('meet.invited', ({ meeting, by }) => {
    const when = meeting.scheduled_at ? new Date(meeting.scheduled_at).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : 'maintenant';
    toast(`📅 ${by.name} vous invite : ${meeting.label} (${when})`, { timeout: 10000, action: { label: 'Voir', run: () => go('/meet/' + meeting.code) } });
  });
  bus.on('meet.notes_ready', ({ notes }) => {
    if (!notes || !['ready', 'no_ai', 'failed'].includes(notes.status) || location.pathname === '/meet/notes/' + notes.id) return;
    toast(`📝 Notes de réunion prêtes : ${notes.title}`, { timeout: 10000, action: { label: 'Ouvrir', run: () => go('/meet/notes/' + notes.id) } });
  });
  // Barres de défilement : visibles seulement pendant le défilement (comme WhatsApp), voir app.css.
  document.addEventListener('scroll', e => {
    const el = e.target === document ? document.documentElement : e.target;
    if (!el.classList) return;
    el.classList.add('is-scrolling');
    clearTimeout(el._scrollTimer);
    el._scrollTimer = setTimeout(() => el.classList.remove('is-scrolling'), 900);
  }, { capture: true, passive: true });
  // Boutiques : nouvelle commande (vendeur) ou étape de suivi (client), hors des pages concernées.
  bus.on('shop.order', ({ order }) => {
    if (!order || location.pathname.startsWith('/shop/manage') || location.pathname === '/shop/orders/' + order.id) return;
    const mine = order.role === 'buyer';
    if (mine && order.status === 'pending') return;  // sa propre commande vient d'être envoyée
    if (!mine && !['pending', 'cancelled', 'delivered'].includes(order.status)) return;
    const text = mine ? `🛍️ ${order.shop.name} : ${order.status_label.toLowerCase()} (${order.code})`
      : order.status === 'pending' ? `🛍️ Nouvelle commande de ${order.buyer.name} (${order.code})` : `${order.code} : ${order.status_label.toLowerCase()}`;
    toast(text, { timeout: 9000, action: { label: 'Voir', run: () => go(mine ? '/shop/orders/' + order.id : '/shop/manage/orders') } });
  });
  bus.on('notification', n => {
    state.notifications.unread++;
    updateBadges();
    const verbs = { like: 'a aimé votre publication', comment: 'a commenté : ', reply: 'a répondu : ', follow: 'a commencé à vous suivre',
      follow_request: 'souhaite vous suivre', follow_accept: 'a accepté votre demande', mention: 'vous a mentionné', comment_like: 'a aimé votre commentaire', story_like: 'a aimé votre story' };
    toast(`${n.actor.name} ${verbs[n.verb] || ''}${n.comment || ''}`);
  });
  bus.on('conversations:changed', updateBadges);
  try { await loadConversations(); } catch (e) { toast(e.message, { type: 'error' }); }
  api.get('notifications').then(r => { state.notifications.unread = r.unread; state.notifications.requests = r.requests; updateBadges(); }).catch(() => {});
  route();
  // Invitation à activer les notifications (fenêtre « Activer vos notifications »).
  setTimeout(askForPush, 1500);
}

function socialMenu() {
  const v = currentView;
  return [
    { title: 'Actus' },
    { label: 'Accueil (fil d’actualité)', icon: 'home', active: v === 'feed', action: () => go('/feed') },
    { label: 'Explorer', icon: 'explore', active: v === 'explore', action: () => go('/explore') },
    { label: 'Reels', icon: 'reels', active: v === 'reels', action: () => go('/reels') },
    { label: 'LIVE', icon: 'live', active: v === 'live', action: () => go('/live') },
    { title: 'Créer' },
    { label: 'Publication', icon: 'image', action: () => import('./views/feed.js').then(m => m.createPostDialog()) },
    { label: 'Reel', icon: 'plusSquare', action: () => import('./views/feed.js').then(m => m.createPostDialog({ reel: true })) },
    { label: 'Story', icon: 'plus', action: () => import('./views/stories.js').then(m => m.createStoryDialog()) },
    { label: 'Lancer un LIVE', icon: 'camera', action: () => go('/live/new') },
  ];
}

function servicesMenu() {
  const p = location.pathname;
  return [
    { title: 'Services' },
    { label: 'Kozons Meet', icon: 'video', active: currentView === 'meet', action: () => go('/meet') },
    { label: 'Boutique', icon: 'bag', active: p === '/shop' || p.startsWith('/shop/s/') || p.startsWith('/shop/p/'), action: () => go('/shop') },
    { label: 'Ma boutique', icon: 'store', active: p.startsWith('/shop/manage') || p === '/shop/subscribe', action: () => go('/shop/manage') },
    { label: 'Mes commandes', icon: 'truck', active: p.startsWith('/shop/orders'), action: () => go('/shop/orders') },
    { label: 'Brady · Assistant IA', icon: 'bulb', active: currentView === 'brady', action: () => go('/brady') },
  ];
}

function meMenu() {
  const n = state.notifications.unread + state.notifications.requests;
  return [
    { label: 'Mon profil', icon: 'user', active: location.pathname === '/u/' + state.me.username, action: () => go('/u/' + state.me.username) },
    { label: 'Notifications', icon: 'heart', badge: n, active: currentView === 'notifications', action: () => go('/notifications') },
    { label: 'Inviter / retrouver des amis', icon: 'users', active: currentView === 'people', action: () => go('/people') },
    { label: 'Messages importants', icon: 'star', action: () => go('/starred') },
    { label: 'Paramètres', icon: 'settings', active: currentView === 'settings', action: () => go('/settings') },
  ];
}

function shell() {
  navEls = {};
  const link = (key, path, ic, label, extra = '') => (navEls[key] = h('a.rail-item' + extra, {
    href: path, title: label, 'aria-label': label, onclick: e => { e.preventDefault(); go(path); },
  }, icon(ic, 24), h('span.rail-label', label), h('span.badge.hidden')));
  const group = (key, ic, label, items) => (navEls[key] = h('button.rail-item.rail-group', {
    type: 'button', title: label, 'aria-label': label, 'aria-haspopup': 'menu',
    onclick: e => menu(e.currentTarget, items(), { side: isPhone() ? undefined : 'right' }),
  }, icon(ic, 24), h('span.rail-label', label), h('span.badge.hidden')));

  const rail = h('nav.rail', { 'aria-label': 'Navigation principale' },
    h('div.rail-logo', { title: 'Kozons', onclick: () => go('/') }, h('img', { src: '/static/kozons/icon.svg', alt: 'Kozons' })),
    link('chats', '/', 'chat', 'Discussions'),
    link('status', '/status', 'status', 'Statuts'),
    link('calls', '/calls', 'phone', 'Appels'),
    group('social', 'explore', 'Actus', socialMenu),
    group('services', 'grid', 'Services', servicesMenu),
    // Brady, l'assistant IA des idées (comme Meta AI dans WhatsApp) : accès direct sur ordinateur.
    h('div.rail-sep'),
    (navEls.brady = h('a.rail-item.rail-brady', { href: '/brady', title: 'Brady · Assistant des idées', 'aria-label': 'Brady, assistant IA',
      onclick: e => { e.preventDefault(); go('/brady'); } }, h('img', { src: '/static/kozons/brady-96.png', alt: '' }), h('span.rail-label', 'Brady'))),
    h('div.rail-spacer'),
    link('notifications', '/notifications', 'heart', 'Notifications', '.rail-desk'),
    link('settings', '/settings', 'settings', 'Paramètres', '.rail-desk'),
    // Profil : direct sur ordinateur ; sur téléphone, menu « Moi » (profil, notifications, paramètres…).
    (navEls.profile = h('a.rail-item.rail-me', { href: '/u/' + state.me.username, title: 'Profil', 'aria-label': 'Moi',
      onclick: e => {
        e.preventDefault();
        if (isPhone()) menu(e.currentTarget, meMenu());
        else go('/u/' + state.me.username);
      } },
      avatar(state.me.avatar, state.me.name, 28), h('span.rail-label', 'Moi'), h('span.badge.hidden'))),
  );
  stage = h('main.stage');
  // Pas de bandeau « Connexion perdue » : la reconnexion se fait en arrière-plan, sans rien afficher.
  return h('div.shell', rail, stage);
}

export function refreshMe(user) {
  state.me = user;
  if (navEls.profile) {
    const old = navEls.profile.querySelector('.avatar');
    old.replaceWith(avatar(user.avatar, user.name, 28));
    navEls.profile.href = '/u/' + user.username;
  }
}
window.addEventListener('kozons:me', e => refreshMe(e.detail));

function updateBadges() {
  let unreadChats = 0;
  for (const c of state.conversations.values()) if ((c.unread > 0 || c.me.marked_unread) && !c.me.archived) unreadChats++;
  setBadge('chats', unreadChats);
  setBadge('notifications', state.notifications.unread + state.notifications.requests);
  setBadge('profile', state.notifications.unread + state.notifications.requests);  // « Moi » sur téléphone
  document.title = unreadChats ? `(${unreadChats}) Kozons` : 'Kozons';
  // Pastille sur l'icône de l'application installée (écran d'accueil, barre des tâches).
  const total = unreadChats + state.notifications.unread + state.notifications.requests;
  if ('setAppBadge' in navigator) (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
}
bus.on('notifications:seen', () => { state.notifications.unread = 0; updateBadges(); });

function setBadge(key, n) {
  const el = navEls[key] && navEls[key].querySelector('.badge');
  if (!el) return;
  el.textContent = n > 99 ? '99+' : String(n);
  el.classList.toggle('hidden', !n);
}

export function go(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return route();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
}

async function route() {
  if (!state.me || !stage) return;
  const path = location.pathname;
  let found = null;
  for (const [re, loader, params] of ROUTES) {
    const m = path.match(re);
    if (m) { found = [loader, params(m)]; break; }
  }
  if (!found) return go('/', { replace: true });
  const [loader, params] = found;
  const module = await loader();
  const key = Object.entries({ '/': 'chats', '/chats': 'chats', '/status': 'status', '/calls': 'calls', '/feed': 'feed', '/explore': 'explore', '/reels': 'reels', '/live': 'live', '/meet': 'meet', '/shop': 'shop', '/brady': 'brady', '/people': 'people', '/notifications': 'notifications', '/settings': 'settings', '/u/': 'profile' })
    .find(([p]) => p === '/' ? path === '/' : path.startsWith(p));
  currentView = key ? key[1] : '';
  const group = SOCIAL_VIEWS.includes(currentView) ? 'social' : SERVICE_VIEWS.includes(currentView) ? 'services' : null;
  Object.entries(navEls).forEach(([k, el]) => el.classList.toggle('active',
    k === group || (k === 'profile' && ME_VIEWS.includes(currentView) && (currentView !== 'profile' || path === '/u/' + state.me.username)) ||
    (k === currentView && k !== 'profile')));
  document.body.dataset.view = currentView;

  // Même vue (ex. passage d'une discussion à une autre) : mise à jour sans reconstruction.
  if (current.module === module && module.update) {
    module.update(params);
    return;
  }
  if (current.cleanup) { try { current.cleanup(); } catch (e) { console.error(e); } }
  clear(stage);
  current = { module, cleanup: module.render(stage, params) || null };
}

// ------------------------------------------------------------------ déconnexion après une longue absence

const IDLE_MS = (Number(document.body.dataset.idleMinutes) || 45) * 60 * 1000;
const HEARTBEAT_MS = 4 * 60 * 1000;

function watchIdle() {
  let lastBeat = 0;
  const beat = () => {
    // Présent sur la plateforme : on prolonge la session côté serveur (toutes les 4 min au plus).
    if (isActive() && Date.now() - lastBeat > HEARTBEAT_MS) {
      lastBeat = Date.now();
      api.post('presence/heartbeat').catch(() => {});
    }
  };
  const check = () => {
    if (!state.me) return;
    // « Se souvenir de moi » : pas de déconnexion pour inactivité sur cet appareil.
    if (!state.remember && !isActive() && Date.now() - lastActiveAt() > IDLE_MS) return logout({ idle: true });
    beat();
  };
  onActivityChange(check);
  document.addEventListener('visibilitychange', check);
  setInterval(check, 60000);
  check();
}

export async function logout({ idle = false } = {}) {
  // Déconnexion volontaire : l'appareil ne reçoit plus rien. Pour inactivité : il reste abonné,
  // mais le serveur n'envoie plus que des notifications sans contenu (« Nouveau message »).
  if (!idle) await disablePush();
  else try { sessionStorage.setItem('kozons.idleLogout', '1'); } catch (e) { /* ignoré */ }
  try { await api.post('auth/logout'); } catch (e) { /* ignoré */ }
  logoutLocal();
}

function logoutLocal() {
  disconnect();
  location.href = '/';
}

boot();
