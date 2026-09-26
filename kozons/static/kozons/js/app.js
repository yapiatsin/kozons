// Point d'entrée : authentification, coque de l'application, routeur, événements globaux.
import { api } from './api.js';
import { bus, state, prefs } from './store.js';
import { connect, disconnect } from './ws.js';
import { h, clear, icon, avatar, toast, menu } from './ui.js';
import { installRealtime, loadConversations, notifyMessage } from './chatdata.js';
import { renderAuth } from './views/auth.js';
import { installCalls } from './views/calls.js';
import { syncPush, enablePush, disablePush } from './push.js';
import { isActive, lastActiveAt, onActivityChange } from './activity.js';

const ROUTES = [
  [/^\/$/, () => import('./views/chats.js'), () => ({})],
  [/^\/chats\/(\d+)$/, () => import('./views/chats.js'), m => ({ id: +m[1] })],
  [/^\/status$/, () => import('./views/status.js'), () => ({})],
  [/^\/calls$/, () => import('./views/calls.js'), () => ({ page: true })],
  [/^\/feed$/, () => import('./views/feed.js'), () => ({})],
  [/^\/explore$/, () => import('./views/explore.js'), () => ({ q: new URLSearchParams(location.search).get('q') || '' })],
  [/^\/reels$/, () => import('./views/reels.js'), () => ({})],
  [/^\/live$/, () => import('./views/live.js'), () => ({})],
  [/^\/live\/new$/, () => import('./views/live.js'), () => ({ new: true })],
  [/^\/live\/(\d+)$/, () => import('./views/live.js'), m => ({ id: +m[1] })],
  [/^\/notifications$/, () => import('./views/notifications.js'), () => ({})],
  [/^\/u\/([^/]+)$/, () => import('./views/profile.js'), m => ({ username: decodeURIComponent(m[1]) })],
  [/^\/p\/(\d+)$/, () => import('./views/post.js'), m => ({ id: +m[1] })],
  [/^\/settings$/, () => import('./views/settings.js'), () => ({})],
  [/^\/starred$/, () => import('./views/settings.js'), () => ({ starred: true })],
];

const NAV = [
  ['/', 'chat', 'Discussions', 'chats'],
  ['/status', 'status', 'Statuts', 'status'],
  ['/calls', 'phone', 'Appels', 'calls'],
  ['/feed', 'home', 'Accueil', 'feed'],
  ['/explore', 'explore', 'Explorer', 'explore'],
  ['/reels', 'reels', 'Reels', 'reels'],
  ['/live', 'live', 'LIVE', 'live'],
  ['/notifications', 'heart', 'Notifications', 'notifications'],
];

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
    if (Date.now() - lastActiveAt() > IDLE_MS) try { sessionStorage.setItem('kozons.idleLogout', '1'); } catch (e) { /* ignoré */ }
    logoutLocal();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'open' && e.data.url) go(e.data.url); });
  }
  let me = null;
  try { ({ user: me } = await api.get('me')); } catch (e) { /* hors ligne */ }
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
  renderAuth(root, user => start(user), { notice });
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
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => toast('Activez les notifications pour ne rater aucun message.', {
      timeout: 10000, action: { label: 'Activer', run: () => enablePush().then(s => s === 'granted' && toast('Notifications activées sur cet appareil')) },
    }), 2500);
  }
}

function shell() {
  navEls = {};
  const rail = h('nav.rail', { 'aria-label': 'Navigation principale' },
    h('div.rail-logo', { title: 'Kozons', onclick: () => go('/') }, h('img', { src: '/static/kozons/icon.svg', alt: 'Kozons' })),
    ...NAV.map(([path, ic, label, key]) => {
      const el = h('a.rail-item', { href: path, title: label, 'aria-label': label, onclick: e => { e.preventDefault(); go(path); } },
        icon(ic, 24), h('span.rail-label', label), h('span.badge.hidden'));
      navEls[key] = el;
      return el;
    }),
    h('div.rail-spacer'),
    (navEls.create = h('button.rail-item', {
      title: 'Créer', 'aria-label': 'Créer',
      onclick: e => menu(e.currentTarget, [
        { label: 'Publication', icon: 'image', action: () => import('./views/feed.js').then(m => m.createPostDialog()) },
        { label: 'Reel', icon: 'reels', action: () => import('./views/feed.js').then(m => m.createPostDialog({ reel: true })) },
        { label: 'Story', icon: 'status', action: () => import('./views/stories.js').then(m => m.createStoryDialog()) },
        { label: 'LIVE', icon: 'live', action: () => go('/live/new') },
      ]),
    }, icon('plusSquare', 24), h('span.rail-label', 'Créer'))),
    (navEls.settings = h('a.rail-item', { href: '/settings', title: 'Paramètres', onclick: e => { e.preventDefault(); go('/settings'); } }, icon('settings', 24), h('span.rail-label', 'Paramètres'))),
    (navEls.profile = h('a.rail-item.rail-me', { href: '/u/' + state.me.username, title: 'Profil', onclick: e => { e.preventDefault(); go('/u/' + state.me.username); } },
      avatar(state.me.avatar, state.me.name, 28), h('span.rail-label', 'Profil'))),
  );
  stage = h('main.stage');
  return h('div.shell', rail, stage, h('div.offline-bar', 'Connexion perdue — reconnexion en cours…'));
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
  document.title = unreadChats ? `(${unreadChats}) Kozons` : 'Kozons';
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
  const key = Object.entries({ '/': 'chats', '/chats': 'chats', '/status': 'status', '/calls': 'calls', '/feed': 'feed', '/explore': 'explore', '/reels': 'reels', '/live': 'live', '/notifications': 'notifications', '/settings': 'settings', '/u/': 'profile' })
    .find(([p]) => p === '/' ? path === '/' : path.startsWith(p));
  Object.entries(navEls).forEach(([k, el]) => el.classList.toggle('active', key && key[1] === k && (k !== 'profile' || path === '/u/' + state.me.username)));
  document.body.dataset.view = key ? key[1] : '';

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
    if (!isActive() && Date.now() - lastActiveAt() > IDLE_MS) return logout({ idle: true });
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
