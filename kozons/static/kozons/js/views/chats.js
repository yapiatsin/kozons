// Vue Discussions : liste à gauche, conversation ouverte à droite, panneau d'infos.
import { api } from '../api.js';
import { bus, state, sortedConversations, convTitle, convAvatar, peerOf, isMuted, prefs } from '../store.js';
import { send } from '../ws.js';
import {
  h, clear, icon, btn, avatar, menu, toast, errorToast, confirmDialog, listTime, dayLabel, lastSeenLabel,
  debounce, autoGrow, pickFiles, emojiPicker, empty, spinner, QUICK_REACTIONS, duration, closeMenus,
} from '../ui.js';
import {
  bucket, loadMessages, markRead, sendMessage, previewText, typingLabel, isConversationVisible, insertMessage,
} from '../chatdata.js';
import { renderMessage, signature, receiptStatus, ticks, replyQuote } from './message.js';
import {
  newChatDialog, newGroupDialog, forwardDialog, contactDialog, pollDialog, mediaPreviewDialog, reactionsDialog, messageInfoDialog,
} from './dialogs.js';
import { renderInfo } from './chatinfo.js';
import { stickerPanel, stickerActionsDialog, loadStickers } from './stickerpanel.js';
import { startCall } from './calls.js';

let root, listEl, paneEl, infoEl, searchInput;
let filter = 'all';
let showArchived = false;
let pane = null; // état de la conversation ouverte
let offs = [];

export function render(stage, params) {
  root = h('div.chats' + (params.id ? '.has-active' : ''));
  searchInput = h('input.search-input', { type: 'search', placeholder: 'Rechercher ou démarrer une discussion' });
  listEl = h('div.chat-list');
  const chipsEl = h('div.filter-chips', [['all', 'Toutes'], ['unread', 'Non lues'], ['groups', 'Groupes'], ['direct', 'Privées']].map(([k, label]) =>
    h('button.chip-filter' + (k === filter ? '.active' : ''), {
      type: 'button',
      onclick: e => { filter = k; chipsEl.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); renderList(); },
    }, label)));

  const sidebar = h('section.sidebar',
    h('header.side-head',
      h('h2', 'Discussions'),
      h('div.row',
        btn('edit', 'Nouvelle discussion', () => newChatDialog()),
        btn('more', 'Menu', e => menu(e.currentTarget, [
          { label: 'Nouveau groupe', icon: 'users', action: () => newGroupDialog() },
          { label: 'Messages importants', icon: 'star', action: () => window.kozons.go('/starred') },
          { label: showArchived ? 'Toutes les discussions' : 'Discussions archivées', icon: 'archive', action: () => { showArchived = !showArchived; renderList(); } },
          { label: 'Tout marquer comme lu', icon: 'checks', action: markAllRead },
          '-',
          { label: 'Paramètres', icon: 'settings', action: () => window.kozons.go('/settings') },
          { label: 'Se déconnecter', icon: 'logout', danger: true, action: () => window.kozons.logout() },
        ])))),
    h('div.search-box', icon('search', 18), searchInput),
    chipsEl,
    listEl);

  paneEl = h('section.pane');
  infoEl = h('aside.info-drawer');
  root.append(sidebar, paneEl, infoEl);
  stage.appendChild(root);

  searchInput.addEventListener('input', debounce(renderList, 150));
  offs = [
    bus.on('conversations:changed', debounce(renderList, 30)),
    bus.on('typing:changed', convId => { renderList(); if (pane && pane.convId === convId) updateHeader(); }),
    bus.on('presence:changed', () => { renderList(); if (pane) updateHeader(); }),
    bus.on('messages:changed', e => { if (pane && e.convId === pane.convId) renderMessages(e); }),
    bus.on('receipts:changed', convId => { if (pane && pane.convId === convId) renderMessages({}); }),
    bus.on('conversations:changed', id => {
      if (pane && (id === undefined || id === pane.convId)) {
        const conv = state.conversations.get(pane.convId);
        if (conv) { pane.conv = conv; updateHeader(); updateComposerState(); if (infoEl.classList.contains('open')) renderInfo(infoEl, conv, infoCtx()); }
      }
    }),
  ];
  const onFocus = () => { if (pane) markRead(pane.convId); };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  const onRerender = e => { if (pane) renderMessages({ updated: e.detail.id, force: true }); };
  window.addEventListener('kozons:rerender-message', onRerender);
  offs.push(() => window.removeEventListener('focus', onFocus), () => document.removeEventListener('visibilitychange', onFocus),
    () => window.removeEventListener('kozons:rerender-message', onRerender));

  renderList();
  update(params);
  return () => {
    offs.forEach(off => off());
    closePane();
    state.activeConversation = null;
  };
}

export function update(params) {
  root.classList.toggle('has-active', !!params.id);
  if (params.id) openConversation(params.id);
  else { closePane(); state.activeConversation = null; showWelcome(); renderList(); }
}

// ------------------------------------------------------------------ liste

function matches(conv, q) {
  if (!q) return true;
  const peer = peerOf(conv);
  return convTitle(conv).toLowerCase().includes(q) || (peer && peer.username.toLowerCase().includes(q));
}

function renderList() {
  if (!listEl) return;
  const q = searchInput.value.trim().toLowerCase();
  const all = sortedConversations();
  const archivedCount = all.filter(c => c.me.archived).length;
  const convs = all.filter(c => (showArchived ? c.me.archived : !c.me.archived) && matches(c, q) && (
    filter === 'all' || (filter === 'unread' && (c.unread > 0 || c.me.marked_unread)) ||
    (filter === 'groups' && c.kind === 'group') || (filter === 'direct' && c.kind === 'direct')));

  const items = [];
  if (showArchived) {
    items.push(h('button.archived-row', { type: 'button', onclick: () => { showArchived = false; renderList(); } }, icon('back', 20), h('span', 'Discussions archivées')));
  } else if (archivedCount && !q) {
    items.push(h('button.archived-row', { type: 'button', onclick: () => { showArchived = true; renderList(); } }, icon('archive', 20), h('span', 'Archivées'), h('span.muted', String(archivedCount))));
  }
  items.push(...convs.map(chatItem));
  if (!convs.length && !q) {
    items.push(empty('chat', showArchived ? 'Aucune discussion archivée' : 'Aucune discussion',
      showArchived ? null : 'Commencez une discussion avec vos contacts.',
      showArchived ? null : h('button.btn.primary', { onclick: () => newChatDialog() }, 'Nouvelle discussion')));
  }
  if (q.length >= 2) items.push(messageSearchResults(q));
  clear(listEl, items);
}

const searchMessages = debounce(async (q, target) => {
  try {
    const { results } = await api.get('messages/search', { q });
    clear(target, results.length ? h('div.list-title', 'Messages') : null, results.slice(0, 30).map(m => {
      const conv = state.conversations.get(m.conversation_id);
      if (!conv) return null;
      return h('button.chat-item.compact', { type: 'button', onclick: () => { window.kozons.go('/chats/' + conv.id); setTimeout(() => jumpTo(m.id), 300); } },
        h('div.chat-main',
          h('div.chat-top', h('span.chat-name', convTitle(conv)), h('span.chat-time', listTime(m.created_at))),
          h('div.chat-preview', (m.sender_id === state.me.id ? 'Vous : ' : '') + m.text)));
    }));
  } catch (e) { /* silencieux */ }
}, 300);

function messageSearchResults(q) {
  const target = h('div');
  searchMessages(q, target);
  return target;
}

function chatItem(conv) {
  const title = convTitle(conv);
  const peer = peerOf(conv);
  const last = conv.last_message;
  const typing = typingLabel(conv.id);
  const unread = conv.unread > 0 || conv.me.marked_unread;
  let preview;
  if (typing) preview = h('span.typing', typing);
  else if (last) {
    const mine = last.sender_id === state.me.id;
    preview = h('span.preview-line',
      mine && last.kind !== 'system' && !last.deleted ? ticks(receiptStatus(conv, last)) : null,
      !mine && conv.kind === 'group' && last.sender && last.kind !== 'system' ? last.sender.name.split(' ')[0] + ' : ' : '',
      previewText(last));
  } else preview = h('span.muted', conv.kind === 'group' ? 'Groupe créé' : 'Démarrez la discussion');

  const item = h('a.chat-item' + (state.activeConversation === conv.id ? '.active' : '') + (unread ? '.unread' : ''), {
    href: '/chats/' + conv.id,
    onclick: e => { e.preventDefault(); window.kozons.go('/chats/' + conv.id); },
    oncontextmenu: e => { e.preventDefault(); chatMenu(conv, null, e); },
  },
  avatar(convAvatar(conv), title, 49, { group: conv.kind === 'group', online: peer && peer.online }),
  h('div.chat-main',
    h('div.chat-top', h('span.chat-name', title), h('span.chat-time' + (unread ? '.accent' : ''), last ? listTime(last.created_at) : '')),
    h('div.chat-bottom', h('div.chat-preview', preview),
      h('div.chat-flags',
        conv.disappearing_seconds ? icon('timer', 16) : null,
        isMuted(conv) ? icon('bellOff', 16) : null,
        conv.me.pinned ? icon('pin', 16) : null,
        conv.unread > 0 ? h('span.unread-badge' + (isMuted(conv) ? '.muted-badge' : ''), conv.unread > 999 ? '999+' : String(conv.unread))
          : conv.me.marked_unread ? h('span.unread-badge.dot') : null,
        h('button.item-menu', { type: 'button', 'aria-label': 'Options', onclick: e => { e.preventDefault(); e.stopPropagation(); chatMenu(conv, e.currentTarget); } }, icon('arrowDown', 18))))));
  return item;
}

function chatMenu(conv, anchor, ev) {
  const setting = data => api.post(`conversations/${conv.id}/settings`, data).then(c => { state.conversations.set(c.id, c); bus.emit('conversations:changed', c.id); }).catch(errorToast);
  menu(anchor, [
    { label: conv.me.archived ? 'Désarchiver' : 'Archiver', icon: 'archive', action: () => setting({ archived: !conv.me.archived }) },
    { label: isMuted(conv) ? 'Réactiver les notifications' : 'Mettre en sourdine', icon: 'bellOff', action: () => isMuted(conv) ? setting({ mute_hours: 0 }) : muteDialog(conv, setting) },
    !conv.me.archived ? { label: conv.me.pinned ? 'Désépingler' : 'Épingler', icon: 'pin', action: () => setting({ pinned: !conv.me.pinned }) } : null,
    conv.unread || conv.me.marked_unread
      ? { label: 'Marquer comme lu', icon: 'checks', action: () => { markRead(conv.id); setting({ marked_unread: false }); } }
      : { label: 'Marquer comme non lu', icon: 'chat', action: () => setting({ marked_unread: true }) },
    '-',
    { label: 'Vider la discussion', icon: 'trash', danger: true, action: () => clearChat(conv) },
    conv.kind === 'group' ? { label: 'Quitter le groupe', icon: 'logout', danger: true, action: () => leaveGroup(conv) } : null,
  ], ev ? { x: ev.clientX, y: ev.clientY } : {});
}

export function muteDialog(conv, setting) {
  menu(null, [
    { label: '8 heures', action: () => setting({ mute_hours: 8 }) },
    { label: '1 semaine', action: () => setting({ mute_hours: 168 }) },
    { label: 'Toujours', action: () => setting({ mute_hours: -1 }) },
  ], { x: window.innerWidth / 2 - 80, y: window.innerHeight / 2 - 60 });
}

export async function clearChat(conv) {
  if (!await confirmDialog('Vider cette discussion ? Les messages seront supprimés de cet appareil pour vous uniquement.', { ok: 'Vider', danger: true })) return;
  try {
    const c = await api.post(`conversations/${conv.id}/settings`, { clear: true });
    state.conversations.set(c.id, c);
    state.messages.delete(conv.id);
    bus.emit('conversations:changed', c.id);
    if (pane && pane.convId === conv.id) { await loadMessages(conv.id); }
  } catch (e) { errorToast(e); }
}

export async function leaveGroup(conv) {
  if (!await confirmDialog(`Quitter le groupe « ${conv.title} » ?`, { ok: 'Quitter', danger: true })) return;
  try { await api.post(`conversations/${conv.id}/members`, { action: 'leave' }); } catch (e) { errorToast(e); }
}

async function markAllRead() {
  for (const c of state.conversations.values()) {
    if (c.unread || c.me.marked_unread) {
      const b = state.messages.get(c.id);
      const lastId = (c.last_message && c.last_message.id) || (b && b.items.length && b.items[b.items.length - 1].id);
      if (lastId) api.post(`conversations/${c.id}/read`, { message_id: lastId }).catch(() => {});
      c.unread = 0; c.me.marked_unread = false;
    }
  }
  bus.emit('conversations:changed');
}

// ------------------------------------------------------------------ conversation ouverte

function showWelcome() {
  clear(paneEl, h('div.welcome',
    h('img', { src: '/static/kozons/icon.svg', alt: '' }),
    h('h2', 'Kozons Web'),
    h('p', 'Envoyez et recevez des messages, passez des appels audio et vidéo, partagez des statuts.'),
    h('p.muted.small', icon('lock', 14), ' Vos conversations privées restent entre vous.')));
  infoEl.classList.remove('open');
}

function closePane() {
  if (pane) {
    pane.cleanup.forEach(f => f());
    if (pane.recorder) pane.recorder.cancel();
    sendTyping('stop');
  }
  pane = null;
}

async function openConversation(convId) {
  if (pane && pane.convId === convId) return;
  closePane();
  let conv = state.conversations.get(convId);
  if (!conv) {
    try { conv = await api.get(`conversations/${convId}`); state.conversations.set(conv.id, conv); }
    catch (e) { toast('Discussion introuvable', { type: 'error' }); return window.kozons.go('/', { replace: true }); }
  }
  state.activeConversation = convId;
  renderList();

  const header = h('header.pane-head');
  const scroller = h('div.messages');
  const listWrap = h('div.messages-inner');
  const topLoader = h('div.top-loader');
  scroller.append(topLoader, listWrap);
  const downBtn = h('button.scroll-down.hidden', { type: 'button', 'aria-label': 'Aller en bas', onclick: () => scrollToBottom(true) }, icon('arrowDown', 22), h('span.badge.hidden'));
  const composer = h('footer.composer');
  const wallpaper = prefs.get('wallpaper', 'default');
  const paneBody = h('div.pane-body' + (wallpaper !== 'none' ? '.wallpaper' : ''), scroller, downBtn);
  clear(paneEl, header, paneBody, composer);

  pane = {
    convId, conv, header, scroller, listWrap, topLoader, downBtn, composer, paneBody,
    nodes: new Map(), sigs: new Map(), replyTo: null, editing: null, cleanup: [], atBottom: true, loadingOlder: false, newWhileAway: 0,
  };

  scroller.addEventListener('scroll', onScroll, { passive: true });
  setupDrop(paneBody);
  updateHeader();
  buildComposer();
  infoEl.classList.remove('open');

  const b = bucket(convId);
  if (b.loaded) {
    renderMessages({ initial: true });
  } else {
    clear(listWrap, h('div.center.pad', spinner()));
    try { await loadMessages(convId); } catch (e) { errorToast(e); }
  }
  if (!pane || pane.convId !== convId) return;
  scrollToFirstUnread(conv);
  markRead(convId);
  if (window.innerWidth > 900) pane.input && pane.input.focus();
}

function scrollToFirstUnread(conv) {
  const b = bucket(conv.id);
  const firstUnread = b.items.find(m => typeof m.id === 'number' && m.id > conv.me.last_read_id && m.sender_id !== state.me.id && m.kind !== 'system');
  if (firstUnread && conv.unread > 3) {
    const node = pane.nodes.get(firstUnread.id);
    if (node) {
      const marker = h('div.unread-marker', `${conv.unread} message${conv.unread > 1 ? 's' : ''} non lu${conv.unread > 1 ? 's' : ''}`);
      node.before(marker);
      pane.scroller.scrollTop = marker.offsetTop - 80;
      return;
    }
  }
  scrollToBottom(false);
}

function subtitle(conv) {
  const t = typingLabel(conv.id);
  if (t) return h('span.typing', t);
  if (conv.kind === 'group') {
    const names = conv.participants.map(p => p.user.id === state.me.id ? 'Vous' : p.user.name.split(' ')[0]);
    return h('span', names.join(', '));
  }
  const peer = peerOf(conv);
  if (conv.blocked.by_them) return h('span', '');
  return h('span', lastSeenLabel(peer) || 'Appuyez ici pour les infos du contact');
}

function updateHeader() {
  if (!pane) return;
  const conv = pane.conv = state.conversations.get(pane.convId) || pane.conv;
  const peer = peerOf(conv);
  clear(pane.header,
    btn('back', 'Retour', () => window.kozons.go('/'), 'back-btn'),
    h('button.head-info', { type: 'button', onclick: toggleInfo },
      avatar(convAvatar(conv), convTitle(conv), 40, { group: conv.kind === 'group' }),
      h('div.head-text', h('div.head-title', convTitle(conv)), h('div.head-sub', subtitle(conv)))),
    h('div.row',
      conv.kind === 'direct' && peer && !conv.blocked.by_me && !conv.blocked.by_them ? [
        btn('video', 'Appel vidéo', () => startCall(peer, true)),
        btn('phone', 'Appel audio', () => startCall(peer, false)),
      ] : null,
      btn('search', 'Rechercher', () => openSearch()),
      btn('more', 'Menu', e => menu(e.currentTarget, [
        { label: conv.kind === 'group' ? 'Infos du groupe' : 'Infos du contact', icon: 'info', action: toggleInfo },
        { label: 'Médias, liens et docs', icon: 'image', action: () => { openInfo(); } },
        { label: isMuted(conv) ? 'Réactiver les notifications' : 'Mettre en sourdine', icon: 'bellOff', action: () => {
          const setting = data => api.post(`conversations/${conv.id}/settings`, data).then(c => { state.conversations.set(c.id, c); bus.emit('conversations:changed', c.id); }).catch(errorToast);
          isMuted(conv) ? setting({ mute_hours: 0 }) : muteDialog(conv, setting);
        } },
        { label: 'Messages éphémères', icon: 'timer', action: () => disappearingDialog(conv) },
        { label: 'Fermer la discussion', icon: 'close', action: () => window.kozons.go('/') },
        '-',
        { label: 'Vider la discussion', icon: 'trash', danger: true, action: () => clearChat(conv) },
        conv.kind === 'direct' && peer ? { label: conv.blocked.by_me ? 'Débloquer' : 'Bloquer', icon: 'block', danger: !conv.blocked.by_me, action: () => toggleBlock(conv, peer) } : null,
        conv.kind === 'group' ? { label: 'Quitter le groupe', icon: 'logout', danger: true, action: () => leaveGroup(conv) } : null,
      ]))));
}

export function disappearingDialog(conv) {
  const choose = seconds => api.post(`conversations/${conv.id}/update`, { disappearing_seconds: seconds }).catch(errorToast);
  menu(null, [
    { label: (conv.disappearing_seconds === 86400 ? '✓ ' : '') + '24 heures', action: () => choose(86400) },
    { label: (conv.disappearing_seconds === 604800 ? '✓ ' : '') + '7 jours', action: () => choose(604800) },
    { label: (conv.disappearing_seconds === 7776000 ? '✓ ' : '') + '90 jours', action: () => choose(7776000) },
    { label: (!conv.disappearing_seconds ? '✓ ' : '') + 'Désactivé', action: () => choose(0) },
  ], { x: window.innerWidth / 2 - 80, y: window.innerHeight / 2 - 80 });
}

export async function toggleBlock(conv, peer) {
  const blocking = !conv.blocked.by_me;
  if (blocking && !await confirmDialog(`Bloquer ${peer.name} ? Cette personne ne pourra plus vous appeler ni vous envoyer de messages.`, { ok: 'Bloquer', danger: true })) return;
  try {
    await api.post(`users/${peer.id}/block`);
    conv.blocked.by_me = blocking;
    bus.emit('conversations:changed', conv.id);
    toast(blocking ? `${peer.name} est bloqué(e)` : `${peer.name} est débloqué(e)`);
  } catch (e) { errorToast(e); }
}

function infoCtx() {
  return {
    close: () => infoEl.classList.remove('open'),
    jumpTo,
    onCall: (u, video) => startCall(u, video),
  };
}

function openInfo() {
  if (!pane) return;
  infoEl.classList.add('open');
  renderInfo(infoEl, pane.conv, infoCtx());
}

function toggleInfo() {
  if (infoEl.classList.contains('open')) infoEl.classList.remove('open');
  else openInfo();
}

function openSearch() {
  if (!pane) return;
  infoEl.classList.add('open');
  const input = h('input.input', { type: 'search', placeholder: 'Rechercher dans la discussion…' });
  const results = h('div.pick-list');
  input.addEventListener('input', debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return clear(results);
    try {
      const { results: items } = await api.get('messages/search', { q, conversation: pane.convId });
      clear(results, items.length ? items.map(m => h('button.search-hit', { type: 'button', onclick: () => jumpTo(m.id) },
        h('div.muted.small', listTime(m.created_at) + ' · ' + (m.sender_id === state.me.id ? 'Vous' : (m.sender || {}).name)),
        h('div', m.text))) : h('div.muted.pad', 'Aucun message trouvé'));
    } catch (e) { errorToast(e); }
  }, 250));
  clear(infoEl, h('header.drawer-head', btn('close', 'Fermer', () => infoEl.classList.remove('open')), h('h3', 'Rechercher des messages')),
    h('div.pad', input), results);
  input.focus();
}

// ------------------------------------------------------------------ rendu des messages

function renderMessages(ev = {}) {
  if (!pane) return;
  const { conv, listWrap, scroller } = pane;
  const b = bucket(pane.convId);
  const wasAtBottom = pane.atBottom;
  const prevHeight = scroller.scrollHeight;
  const prevTop = scroller.scrollTop;

  const frag = [];
  let lastDay = null, prevMsg = null;
  const seen = new Set();
  if (!b.hasMore && b.loaded) {
    frag.push(h('div.encryption-note', icon('lock', 14), ' Les messages sont protégés : seuls les membres de cette discussion peuvent les lire.'));
    if (conv.disappearing_seconds) frag.push(h('div.encryption-note', icon('timer', 14), ' Les messages éphémères sont activés.'));
  }
  for (const msg of b.items) {
    const day = new Date(msg.created_at).toDateString();
    if (day !== lastDay) {
      frag.push(h('div.day-sep', h('span', dayLabel(msg.created_at))));
      lastDay = day;
      prevMsg = null;
    }
    const showSender = !prevMsg || prevMsg.sender_id !== msg.sender_id || prevMsg.kind === 'system' ||
      new Date(msg.created_at) - new Date(prevMsg.created_at) > 5 * 60000;
    const key = msg.id;
    const sig = signature(conv, msg) + showSender;
    let node = pane.nodes.get(key);
    if (!node || pane.sigs.get(key) !== sig || (ev.force && ev.updated === key)) {
      node = renderMessage(msg, {
        conv, showSender,
        onMenu: messageMenu, onJump: jumpTo, onReply: setReply,
        onReactions: m => reactionsDialog(m, conv), onForward: m => forwardDialog(m),
      });
      if (showSender) node.classList.add('first');
      pane.nodes.set(key, node);
      pane.sigs.set(key, sig);
    }
    seen.add(key);
    frag.push(node);
    prevMsg = msg;
  }
  for (const k of [...pane.nodes.keys()]) if (!seen.has(k)) { pane.nodes.delete(k); pane.sigs.delete(k); }
  if (!b.items.length) frag.push(h('div.center.pad.muted', 'Aucun message. Dites bonjour ! 👋'));
  const marker = listWrap.querySelector('.unread-marker');
  clear(listWrap, frag);
  if (marker && ev.initial === undefined && !ev.newMessage) {
    const firstUnread = b.items.find(m => typeof m.id === 'number' && m.id > pane.conv.me.last_read_id && m.sender_id !== state.me.id);
    if (firstUnread && pane.nodes.get(firstUnread.id)) pane.nodes.get(firstUnread.id).before(marker);
  }

  clear(pane.topLoader, b.hasMore ? spinner(22) : null);

  if (ev.older) {
    scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
  } else if (ev.newMessage) {
    const own = ev.own || ev.newMessage.sender_id === state.me.id;
    if (own || wasAtBottom) scrollToBottom(own ? false : true);
    else if (!ev.silent) {
      pane.newWhileAway++;
      const badge = pane.downBtn.querySelector('.badge');
      badge.textContent = String(pane.newWhileAway);
      badge.classList.remove('hidden');
    }
    if (isConversationVisible(pane.convId) && !own) markRead(pane.convId);
  } else if (wasAtBottom && !ev.initial) {
    scrollToBottom(false);
  }
}

function onScroll() {
  if (!pane) return;
  const { scroller } = pane;
  pane.atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  pane.downBtn.classList.toggle('hidden', pane.atBottom);
  if (pane.atBottom) {
    pane.newWhileAway = 0;
    pane.downBtn.querySelector('.badge').classList.add('hidden');
  }
  if (scroller.scrollTop < 300 && !pane.loadingOlder) {
    const b = bucket(pane.convId);
    if (b.hasMore && b.loaded) {
      pane.loadingOlder = true;
      const convId = pane.convId;
      loadMessages(convId, { older: true }).catch(errorToast).finally(() => { if (pane && pane.convId === convId) pane.loadingOlder = false; });
    }
  }
}

function scrollToBottom(smooth) {
  if (!pane) return;
  const s = pane.scroller;
  requestAnimationFrame(() => {
    s.scrollTo({ top: s.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    pane.atBottom = true;
    pane.downBtn.classList.add('hidden');
  });
}

/** Fait défiler jusqu'à un message, en le chargeant si nécessaire. */
async function jumpTo(messageId) {
  if (!pane) return;
  let node = pane.nodes.get(messageId);
  if (!node) {
    try {
      const res = await api.get(`conversations/${pane.convId}/messages`, { around: messageId, limit: 60 });
      const b = bucket(pane.convId);
      // On remplace la fenêtre chargée par celle autour du message.
      b.items = res.results;
      b.hasMore = true;
      renderMessages({ initial: true });
      node = pane.nodes.get(messageId);
      if (res.has_newer) {
        // Pour revenir au présent, un clic sur « aller en bas » recharge les derniers messages.
        pane.downBtn.classList.remove('hidden');
        pane.downBtn.onclick = async () => { await loadMessages(pane.convId); scrollToBottom(false); pane.downBtn.onclick = () => scrollToBottom(true); };
      }
    } catch (e) { return errorToast(e); }
  }
  if (node) {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }
}

function messageMenu(msg, anchor, ev) {
  if (!pane) return;
  const conv = pane.conv;
  const mine = msg.sender_id === state.me.id;
  const me = conv.me;
  const canEdit = mine && msg.kind === 'text' && !msg.deleted && Date.now() - new Date(msg.created_at) < 15 * 60000;
  const canDeleteAll = !msg.deleted && ((mine && Date.now() - new Date(msg.created_at) < 2 * 86400000) || (conv.kind === 'group' && me.role === 'admin'));
  const layer = menu(anchor, [
    !msg.deleted ? { label: 'Répondre', icon: 'reply', action: () => setReply(msg) } : null,
    msg.text && !msg.deleted ? { label: 'Copier', icon: 'copy', action: () => navigator.clipboard.writeText(msg.text).then(() => toast('Copié')) } : null,
    !msg.deleted && !msg.view_once && msg.kind !== 'poll' ? { label: 'Transférer', icon: 'forward', action: () => forwardDialog(msg) } : null,
    msg.kind === 'sticker' && !msg.deleted ? { label: 'Sticker : favoris et collection', icon: 'sticker', action: () => stickerActionsDialog(msg) } : null,
    !msg.deleted ? { label: msg.starred ? 'Retirer des importants' : 'Marquer comme important', icon: 'star', action: () => api.post(`messages/${msg.id}/star`).catch(errorToast) } : null,
    canEdit ? { label: 'Modifier', icon: 'edit', action: () => setEditing(msg) } : null,
    mine && !msg.deleted ? { label: 'Infos', icon: 'info', action: () => messageInfoDialog(msg) } : null,
    msg.file && !msg.deleted && !msg.view_once ? { label: 'Télécharger', icon: 'download', action: () => { const a = h('a', { href: msg.file, download: msg.file_name || '' }); document.body.appendChild(a); a.click(); a.remove(); } } : null,
    '-',
    { label: 'Supprimer', icon: 'trash', danger: true, action: () => deleteMessage(msg, canDeleteAll) },
  ], ev ? { x: ev.clientX, y: ev.clientY } : {});
  // Barre de réactions rapides en tête du menu.
  if (!msg.deleted) {
    const list = layer.querySelector('.menu');
    const bar = h('div.quick-reactions', QUICK_REACTIONS.map(e => h('button', {
      type: 'button',
      onclick: () => { closeMenus(); api.post(`messages/${msg.id}/react`, { emoji: e }).catch(errorToast); },
    }, e)), h('button', { type: 'button', title: "Plus d'emojis", onclick: () => {
      closeMenus();
      const picker = emojiPicker(e => { api.post(`messages/${msg.id}/react`, { emoji: e }).catch(errorToast); closeMenus(); });
      const l = h('div.menu-layer', { onmousedown: ev2 => { if (ev2.target === l) closeMenus(); } }, h('div.menu.emoji-menu', picker));
      document.getElementById('overlay-root').appendChild(l);
      const m = l.firstChild;
      m.style.left = Math.max(8, Math.min(window.innerWidth - 340, (ev ? ev.clientX : (anchor || pane.paneBody).getBoundingClientRect().left) - 150)) + 'px';
      m.style.top = Math.max(8, Math.min(window.innerHeight - 330, (ev ? ev.clientY : (anchor || pane.paneBody).getBoundingClientRect().top))) + 'px';
    } }, '+'));
    list.prepend(bar);
    const r = list.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) list.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
  }
}

async function deleteMessage(msg, canDeleteAll) {
  const choice = await confirmDialog('Supprimer ce message ?', {
    ok: 'Supprimer pour moi', danger: true,
    extra: canDeleteAll ? { label: 'Supprimer pour tous', value: 'everyone' } : null,
  });
  if (!choice) return;
  try { await api.post(`messages/${msg.id}/delete`, { scope: choice === 'everyone' ? 'everyone' : 'me' }); } catch (e) { errorToast(e); }
}

// ------------------------------------------------------------------ composition

let typingSentAt = 0;
function sendTyping(st) {
  if (!pane) return;
  const now = Date.now();
  if (st === 'typing' && now - typingSentAt < 3000) return;
  typingSentAt = st === 'stop' ? 0 : now;
  send('typing', { conversation_id: pane.convId, state: st });
}

function updateComposerState() {
  if (!pane) return;
  const conv = pane.conv;
  const blocked = conv.kind === 'direct' && (conv.blocked.by_me || conv.blocked.by_them);
  const adminsOnly = conv.kind === 'group' && conv.only_admins_can_send && conv.me.role !== 'admin';
  const notice = blocked
    ? (conv.blocked.by_me ? h('button.composer-notice', { type: 'button', onclick: () => toggleBlock(conv, peerOf(conv)) }, 'Vous avez bloqué ce contact. Appuyez pour débloquer.') : h('div.composer-notice', "Vous ne pouvez pas répondre à cette discussion."))
    : adminsOnly ? h('div.composer-notice', 'Seuls les administrateurs peuvent envoyer des messages.') : null;
  pane.composer.classList.toggle('locked', !!notice);
  const existing = pane.composer.querySelector('.composer-notice');
  if (existing) existing.remove();
  if (notice) pane.composer.appendChild(notice);
}

function buildComposer() {
  const { composer } = pane;
  const input = h('textarea.composer-input', { rows: 1, placeholder: 'Écrire un message', 'aria-label': 'Message' });
  const resize = autoGrow(input, 140);
  const emojiTab = emojiPicker(e => {
    const s = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, s) + e + input.value.slice(input.selectionEnd ?? s);
    input.selectionStart = input.selectionEnd = s + e.length;
    input.focus(); resize(); toggleSend();
  });
  // Panneau emoji / stickers (barre d'onglets en bas, comme WhatsApp). Stickers chargés à la demande.
  let stickersTab = null;
  const pickerBody = h('div.picker-body', emojiTab);
  const pickerTabs = h('div.picker-switch');
  const showPicker = which => {
    if (which === 'stickers' && !stickersTab) {
      stickersTab = stickerPanel({ onSend: sticker => { sendSticker(sticker); emojiPanel.classList.add('hidden'); } });
      pane.cleanup.push(() => stickersTab.cleanup());
    }
    pickerBody.replaceChildren(which === 'stickers' ? stickersTab : emojiTab);
    pickerTabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  };
  pickerTabs.append(
    h('button.active', { type: 'button', dataset: { tab: 'emoji' }, title: 'Emoji', onclick: () => showPicker('emoji') }, icon('smile', 20)),
    h('button', { type: 'button', dataset: { tab: 'stickers' }, title: 'Stickers', onclick: () => showPicker('stickers') }, icon('sticker', 20)));
  const emojiPanel = h('div.emoji-panel.hidden', h('div.picker', pickerBody, pickerTabs));
  const topBar = h('div.composer-top');
  const sendBtn = h('button.send-btn', { type: 'button', 'aria-label': 'Envoyer' }, icon('mic', 22));
  pane.input = input;
  pane.topBar = topBar;

  const toggleSend = () => {
    const hasText = input.value.trim().length > 0;
    sendBtn.replaceChildren(icon(hasText || pane.editing ? 'send' : 'mic', 22));
    sendBtn.setAttribute('aria-label', hasText ? 'Envoyer' : 'Enregistrer un message vocal');
  };
  pane.toggleSend = toggleSend;

  input.addEventListener('input', () => { toggleSend(); if (input.value) sendTyping('typing'); });
  input.addEventListener('blur', () => sendTyping('stop'));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.innerWidth > 700) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { setReply(null); setEditing(null); }
    if (e.key === 'ArrowUp' && !input.value) {
      const b = bucket(pane.convId);
      const lastMine = [...b.items].reverse().find(m => m.sender_id === state.me.id && m.kind === 'text' && !m.deleted && typeof m.id === 'number');
      if (lastMine && Date.now() - new Date(lastMine.created_at) < 15 * 60000) { e.preventDefault(); setEditing(lastMine); }
    }
  });
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData || {}).files || []];
    if (files.length) { e.preventDefault(); mediaPreviewDialog(files, sendFile); }
  });

  const submit = async () => {
    const text = input.value.trim();
    if (pane.editing) {
      const msg = pane.editing;
      if (!text) return;
      setEditing(null);
      input.value = ''; resize(); toggleSend();
      try { await api.post(`messages/${msg.id}/edit`, { text }); } catch (e) { errorToast(e); }
      return;
    }
    if (!text) return startRecording();
    const reply = pane.replyTo;
    input.value = ''; resize(); toggleSend();
    setReply(null);
    sendTyping('stop');
    emojiPanel.classList.add('hidden');
    // Messages très longs : découpés comme WhatsApp (65 536 caractères max).
    sendMessage(pane.convId, { kind: 'text', text, reply_to: reply && reply.id, reply_preview: reply && quotePreview(reply) }).catch(e => errorToast(e));
  };
  sendBtn.onclick = submit;

  const attach = btn('attach', 'Joindre', e => menu(e.currentTarget, [
    { label: 'Photos et vidéos', icon: 'image', action: async () => { const f = await pickFiles({ accept: 'image/*,video/*', multiple: true }); if (f.length) mediaPreviewDialog(f.slice(0, 30), sendFile); } },
    { label: 'Caméra', icon: 'camera', action: async () => { const f = await pickFiles({ accept: 'image/*,video/*', capture: 'environment' }); if (f.length) mediaPreviewDialog(f, sendFile); } },
    { label: 'Photo à vue unique', icon: 'once', action: async () => { const f = await pickFiles({ accept: 'image/*,video/*' }); if (f.length) mediaPreviewDialog(f, sendFile, { viewOnce: true }); } },
    { label: 'Document', icon: 'doc', action: async () => { const f = await pickFiles({ multiple: true }); if (f.length) mediaPreviewDialog(f.slice(0, 30), sendFile); } },
    { label: 'Audio', icon: 'volume', action: async () => { const f = await pickFiles({ accept: 'audio/*' }); if (f.length) f.forEach(x => sendFile(x, '')); } },
    { label: 'Position', icon: 'location', action: sendLocation },
    { label: 'Contact', icon: 'contact', action: () => contactDialog(u => sendMessage(pane.convId, { kind: 'contact', contact_id: u.id }).catch(errorToast)) },
    { label: 'Sondage', icon: 'poll', action: () => pollDialog(({ question, options, multiple }) => sendMessage(pane.convId, { kind: 'poll', text: question, options, multiple }).catch(errorToast)) },
  ]));
  const emojiBtn = btn('smile', 'Emoji et stickers', () => emojiPanel.classList.toggle('hidden'));

  // Fermeture automatique : clic / toucher en dehors du panneau, ou touche Échap.
  // Les menus et fenêtres ouverts depuis le panneau (#overlay-root) ne le ferment pas.
  const closePicker = () => emojiPanel.classList.add('hidden');
  const onOutside = e => {
    if (emojiPanel.classList.contains('hidden')) return;
    if (emojiPanel.contains(e.target) || emojiBtn.contains(e.target)) return;
    if (e.target.closest && e.target.closest('#overlay-root')) return;
    closePicker();
  };
  const onEscape = e => {
    if (e.key === 'Escape' && !emojiPanel.classList.contains('hidden') && !document.querySelector('#overlay-root > *')) closePicker();
  };
  // buildComposer est rappelé (ex. après un vocal) : on retire les écouteurs précédents.
  if (pane.removePickerListeners) pane.removePickerListeners();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onEscape);
  pane.removePickerListeners = () => {
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEscape);
  };
  if (!pane.pickerCleanupRegistered) {
    pane.pickerCleanupRegistered = true;
    pane.cleanup.push(() => pane.removePickerListeners && pane.removePickerListeners());
  }

  clear(composer, emojiPanel, topBar, h('div.composer-row', emojiBtn, attach, h('div.composer-field', input), sendBtn));
  updateComposerState();
}

function sendSticker(sticker) {
  if (!pane) return;
  const reply = pane.replyTo;
  setReply(null);
  sendMessage(pane.convId, {
    kind: 'sticker', sticker_id: sticker.id, preview_url: sticker.url,
    reply_to: reply && reply.id, reply_preview: reply && quotePreview(reply),
  }).then(() => loadStickers(true).catch(() => {})).catch(errorToast);
}

function quotePreview(msg) {
  return { id: msg.id, sender_id: msg.sender_id, sender_name: msg.sender ? msg.sender.name : '', kind: msg.kind, text: msg.text, file: ['image', 'video', 'sticker'].includes(msg.kind) && !msg.view_once ? msg.file : null };
}

function setReply(msg) {
  if (!pane) return;
  pane.replyTo = msg;
  if (msg) pane.editing = null;
  clear(pane.topBar, msg ? h('div.reply-bar', replyQuote(quotePreview(msg), () => jumpTo(msg.id)), btn('close', 'Annuler', () => setReply(null))) : null);
  if (msg) pane.input.focus();
  pane.toggleSend && pane.toggleSend();
}

function setEditing(msg) {
  if (!pane) return;
  pane.editing = msg;
  if (msg) {
    pane.replyTo = null;
    pane.input.value = msg.text;
    pane.input.dispatchEvent(new Event('input'));
    pane.input.focus();
  } else if (pane.input.value && !msg) {
    pane.input.value = '';
    pane.input.dispatchEvent(new Event('input'));
  }
  clear(pane.topBar, msg ? h('div.reply-bar.edit-bar', icon('edit', 18), h('div.grow', h('div.strong.accent', 'Modifier le message'), h('div.muted.ellipsis', msg.text)), btn('close', 'Annuler', () => setEditing(null))) : null);
  pane.toggleSend && pane.toggleSend();
}

function sendFile(file, caption, viewOnce) {
  if (!pane) return;
  const reply = pane.replyTo;
  setReply(null);
  sendMessage(pane.convId, { text: caption || '', view_once: viewOnce || undefined, reply_to: reply && reply.id, reply_preview: reply && quotePreview(reply) }, { file })
    .catch(e => errorToast(e));
}

function sendLocation() {
  if (!navigator.geolocation) return toast('Géolocalisation indisponible.', { type: 'error' });
  const convId = pane.convId;
  navigator.geolocation.getCurrentPosition(
    pos => sendMessage(convId, { kind: 'location', latitude: pos.coords.latitude, longitude: pos.coords.longitude }).catch(errorToast),
    () => toast("Impossible d'obtenir votre position.", { type: 'error' }),
    { enableHighAccuracy: true, timeout: 15000 });
}

function setupDrop(target) {
  let depth = 0;
  const overlay = h('div.drop-overlay', icon('attach', 48), h('div', 'Déposez vos fichiers ici'));
  target.appendChild(overlay);
  target.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { depth++; overlay.classList.add('show'); } });
  target.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.classList.remove('show'); } });
  target.addEventListener('dragover', e => e.preventDefault());
  target.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; overlay.classList.remove('show');
    const files = [...e.dataTransfer.files];
    if (files.length && pane && !pane.composer.classList.contains('locked')) mediaPreviewDialog(files.slice(0, 30), sendFile);
  });
}

// ------------------------------------------------------------------ messages vocaux

async function startRecording() {
  if (!pane || pane.recorder) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast("L'enregistrement audio n'est pas pris en charge par ce navigateur.", { type: 'error' });
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { return toast("Accès au micro refusé.", { type: 'error' }); }
  if (!pane) { stream.getTracks().forEach(t => t.stop()); return; }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  const started = Date.now();
  let cancelled = false, paused = false, pausedFor = 0, pausedAt = 0;
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const convId = pane.convId;
  const reply = pane.replyTo;
  const elapsed = () => (Date.now() - started - pausedFor - (paused ? Date.now() - pausedAt : 0)) / 1000;
  rec.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(timer);
    clearInterval(typingTimer);
    send('typing', { conversation_id: convId, state: 'stop' });
    if (pane) { pane.recorder = null; buildComposer(); }
    if (cancelled || !chunks.length) return;
    const secs = elapsed();
    if (secs < 0.8) return toast('Message vocal trop court.');
    const type = rec.mimeType || 'audio/webm';
    const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
    const file = new File(chunks, `vocal-${Date.now()}.${ext}`, { type });
    sendMessage(convId, { kind: 'voice', duration: secs.toFixed(1), reply_to: reply && reply.id }, { file }).catch(errorToast);
    if (pane) setReply(null);
  };
  rec.start(250);

  const time = h('span.rec-time', '0:00');
  const pauseBtn = btn('pause', 'Pause', () => {
    if (!paused) { rec.pause(); paused = true; pausedAt = Date.now(); pauseBtn.replaceChildren(icon('mic', 22)); }
    else { rec.resume(); paused = false; pausedFor += Date.now() - pausedAt; pauseBtn.replaceChildren(icon('pause', 22)); }
  });
  const timer = setInterval(() => { time.textContent = duration(elapsed()); if (elapsed() > 900) rec.stop(); }, 250);
  send('typing', { conversation_id: convId, state: 'recording' });
  const typingTimer = setInterval(() => send('typing', { conversation_id: convId, state: 'recording' }), 4000);

  pane.recorder = { cancel: () => { cancelled = true; if (rec.state !== 'inactive') rec.stop(); } };
  clear(pane.composer, h('div.composer-row.recording',
    btn('trash', 'Annuler', () => pane.recorder && pane.recorder.cancel()),
    h('div.rec-indicator', h('span.rec-dot'), time, h('span.muted', ' Enregistrement…')),
    pauseBtn,
    h('button.send-btn', { type: 'button', 'aria-label': 'Envoyer le vocal', onclick: () => rec.state !== 'inactive' && rec.stop() }, icon('send', 22))));
}

export { insertMessage };
