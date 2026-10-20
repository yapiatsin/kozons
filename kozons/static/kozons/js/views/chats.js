// Vue Discussions : liste à gauche, conversation ouverte à droite, panneau d'infos.
import { api } from '../api.js';
import { bus, state, sortedConversations, convTitle, convAvatar, peerOf, isMuted } from '../store.js';
import { send } from '../ws.js';
import {
  h, clear, icon, btn, avatar, menu, toast, errorToast, confirmDialog, listTime, dayLabel, lastSeenLabel,
  debounce, autoGrow, pickFiles, emojiPicker, empty, spinner, QUICK_REACTIONS, duration, closeMenus, onLongPress, resizablePanel,
} from '../ui.js';
import {
  bucket, loadMessages, markRead, sendMessage, previewText, typingLabel, isConversationVisible, insertMessage,
} from '../chatdata.js';
import { renderMessage, signature, receiptStatus, ticks, replyQuote } from './message.js';
import {
  newChatDialog, newGroupDialog, forwardDialog, forwardMessages, contactDialog, pollDialog, mediaPreviewDialog, reactionsDialog, messageInfoDialog,
} from './dialogs.js';
import { renderInfo } from './chatinfo.js';
import { stickerPanel, stickerActionsDialog, loadStickers } from './stickerpanel.js';
import { mentionInput } from './mentions.js';
import { startCall } from './calls.js';
import { applyWallpaper, themeDialog } from '../wallpapers.js';

let root, listEl, paneEl, infoEl, searchInput;
let filter = 'all';
let showArchived = false;
let pane = null; // état de la conversation ouverte
let offs = [];
let selected = null; // mode sélection (appui long) : ids des discussions cochées
let sideHead = null, selHead = null, selCount = null;

// Hauteur du clavier virtuel, mémorisée dans --kb-h : le panneau emoji prend exactement sa place.
(function trackKeyboardHeight() {
  const vv = window.visualViewport;
  if (!vv) return;
  try { const saved = localStorage.getItem('kozons.kbh'); if (saved) document.documentElement.style.setProperty('--kb-h', saved + 'px'); } catch (e) { /* stockage indisponible */ }
  let full = vv.height, width = vv.width;
  vv.addEventListener('resize', () => {
    if (vv.width !== width) { width = vv.width; full = vv.height; return; } // rotation
    if (vv.height > full) full = vv.height;
    const kb = Math.round(full - vv.height);
    if (kb < 150 || kb > full * 0.7) return; // pas un clavier (barre d'adresse, zoom…)
    document.documentElement.style.setProperty('--kb-h', kb + 'px');
    try { localStorage.setItem('kozons.kbh', kb); } catch (e) { /* stockage indisponible */ }
  });
})();

export function render(stage, params) {
  root = h('div.chats' + (params.id ? '.has-active' : ''));
  searchInput = h('input.search-input', { type: 'search', placeholder: 'Rechercher ou démarrer une discussion' });
  listEl = h('div.chat-list');
  const chipsEl = h('div.filter-chips', [['all', 'Toutes'], ['unread', 'Non lues'], ['groups', 'Groupes'], ['direct', 'Privées']].map(([k, label]) =>
    h('button.chip-filter' + (k === filter ? '.active' : ''), {
      type: 'button',
      onclick: e => { filter = k; chipsEl.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); renderList(); },
    }, label)));

  selected = null;
  selCount = h('strong.sel-count');
  // Barre du mode sélection (comme WhatsApp) : nombre, supprimer, quitter.
  selHead = h('header.side-head.sel-head.hidden',
    btn('back', 'Annuler la sélection', () => setSelection(null)),
    selCount,
    h('div.row',
      btn('trash', 'Supprimer les discussions', () => deleteChats([...selected])),
      btn('more', 'Plus', e => menu(e.currentTarget, [
        { label: 'Tout sélectionner', icon: 'checks', action: () => setSelection(new Set(visibleConvIds())) },
        { label: 'Archiver', icon: 'archive', action: () => archiveSelected() },
      ]))));
  // Téléphone : bouton flottant pour parler à Brady (comme Meta AI dans WhatsApp).
  const bradyFab = h('a.brady-fab', { href: '/brady', title: 'Brady · Assistant des idées', 'aria-label': 'Parler à Brady',
    onclick: e => { e.preventDefault(); window.kozons.go('/brady'); } }, h('img', { src: '/static/kozons/brady-96.png', alt: '' }));
  const sidebar = h('section.sidebar', selHead, bradyFab,
    sideHead = h('header.side-head',
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
  resizablePanel(sidebar, 'chats');
  root.append(sidebar, paneEl, infoEl);
  stage.appendChild(root);

  searchInput.addEventListener('input', debounce(renderList, 150));
  const onEsc = e => { if (e.key === 'Escape' && selected) setSelection(null); };
  document.addEventListener('keydown', onEsc);
  offs = [
    () => document.removeEventListener('keydown', onEsc),
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

let lastVisible = [];
const visibleConvIds = () => lastVisible;

function setSelection(set) {
  selected = set && set.size ? set : null;
  if (selHead) {
    selHead.classList.toggle('hidden', !selected);
    sideHead.classList.toggle('hidden', !!selected);
    if (selected) selCount.textContent = String(selected.size);
  }
  if (listEl) listEl.classList.toggle('selecting', !!selected);
  renderList();
}

function toggleSelected(id) {
  const set = new Set(selected || []);
  if (set.has(id)) set.delete(id); else set.add(id);
  setSelection(set);
}

async function deleteChats(ids) {
  if (!ids.length) return;
  const n = ids.length;
  const ok = await confirmDialog(`${n > 1 ? `Supprimer ces ${n} discussions` : 'Supprimer cette discussion'} ? `
    + 'Les messages seront effacés pour vous uniquement ; la discussion réapparaîtra si un nouveau message arrive.', { ok: 'Supprimer', danger: true });
  if (!ok) return;
  try {
    await api.post('conversations/delete', { ids });
    toast(n > 1 ? `${n} discussions supprimées` : 'Discussion supprimée');
    setSelection(null);
  } catch (e) { errorToast(e); }
}

async function archiveSelected() {
  const ids = [...(selected || [])];
  setSelection(null);
  for (const id of ids) {
    try {
      const c = await api.post(`conversations/${id}/settings`, { archived: true });
      state.conversations.set(c.id, c);
    } catch (e) { errorToast(e); }
  }
  bus.emit('conversations:changed');
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
  lastVisible = convs.map(c => c.id);
  if (selected) {
    // Discussions disparues (supprimées ailleurs…) : on les retire de la sélection.
    for (const id of [...selected]) if (!state.conversations.has(id)) selected.delete(id);
    if (!selected.size) return setSelection(null);
    selCount.textContent = String(selected.size);
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

  const isSel = !!(selected && selected.has(conv.id));
  const item = h('a.chat-item' + (state.activeConversation === conv.id && !selected ? '.active' : '') + (unread ? '.unread' : '') + (isSel ? '.selected' : ''), {
    href: '/chats/' + conv.id,
    onclick: e => { e.preventDefault(); if (selected) toggleSelected(conv.id); else window.kozons.go('/chats/' + conv.id); },
    oncontextmenu: e => { e.preventDefault(); if (selected) toggleSelected(conv.id); else chatMenu(conv, null, e); },
  },
  h('div.sel-avatar', avatar(convAvatar(conv), title, 49, { group: conv.kind === 'group', online: peer && peer.online }), isSel ? h('span.sel-check', icon('check', 14)) : null),
  h('div.chat-main',
    h('div.chat-top', h('span.chat-name', title), h('span.chat-time' + (unread ? '.accent' : ''), last ? listTime(last.created_at) : '')),
    h('div.chat-bottom', h('div.chat-preview', preview),
      h('div.chat-flags',
        conv.disappearing_seconds ? icon('timer', 16) : null,
        isMuted(conv) ? icon('bellOff', 16) : null,
        conv.me.pinned ? icon('pin', 16) : null,
        conv.unread_mentions > 0 ? h('span.mention-badge', { title: 'Vous avez été mentionné(e)' }, '@') : null,
        conv.unread > 0 ? h('span.unread-badge' + (isMuted(conv) ? '.muted-badge' : ''), conv.unread > 999 ? '999+' : String(conv.unread))
          : conv.me.marked_unread ? h('span.unread-badge.dot') : null,
        h('button.item-menu', { type: 'button', 'aria-label': 'Options', onclick: e => { e.preventDefault(); e.stopPropagation(); chatMenu(conv, e.currentTarget); } }, icon('arrowDown', 18))))));
  // Appui long : mode sélection (supprimer, archiver plusieurs discussions).
  onLongPress(item, () => toggleSelected(conv.id));
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
    { label: 'Sélectionner', icon: 'check', action: () => toggleSelected(conv.id) },
    { label: 'Vider la discussion', icon: 'trash', action: () => clearChat(conv) },
    { label: 'Supprimer la discussion', icon: 'trash', danger: true, action: () => deleteChats([conv.id]) },
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
    document.querySelectorAll('.reaction-pill:not(.in-menu)').forEach(e => e.remove());
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
  const paneBody = h('div.pane-body', scroller, downBtn);
  // Fond d'écran sous les messages ET sous la barre de saisie (qui flotte dessus, comme WhatsApp).
  const paneMain = h('div.pane-main', paneBody, composer);
  applyWallpaper(paneMain, convId);
  clear(paneEl, header, paneMain);

  pane = {
    convId, conv, header, scroller, listWrap, topLoader, downBtn, composer, paneBody,
    nodes: new Map(), sigs: new Map(), replyTo: null, editing: null, cleanup: [], atBottom: true, loadingOlder: false, newWhileAway: 0,
    msgSel: null, // messages sélectionnés (appui long)
  };

  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('scroll', () => placeReactionPill(), { passive: true });
  // Thème changé (cette discussion ou thème général) : appliqué tout de suite.
  pane.cleanup.push(bus.on('wallpaper:changed', () => { if (pane && pane.convId === convId) applyWallpaper(paneMain, convId); }));
  const onSelEsc = e => { if (e.key === 'Escape' && pane && pane.msgSel) setMessageSelection(null); };
  document.addEventListener('keydown', onSelEsc);
  pane.cleanup.push(() => document.removeEventListener('keydown', onSelEsc));
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
  pane.header.classList.toggle('sel-head', !!pane.msgSel);
  if (pane.msgSel) return clear(pane.header, ...selectionBar());
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
        { label: 'Thème de la discussion', icon: 'image', action: () => themeDialog(conv.id) },
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
        onSelect: toggleMessage, isSelecting: () => !!(pane && pane.msgSel),
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
  if (pane.msgSel) {
    // Messages disparus (supprimés…) : retirés de la sélection.
    for (const id of [...pane.msgSel]) if (!pane.nodes.has(id)) pane.msgSel.delete(id);
    if (!pane.msgSel.size) setMessageSelection(null); else { paintMessageSelection(); updateHeader(); }
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

// ------------------------------------------------------------------ sélection de messages (appui long, comme WhatsApp)

function selectedMessages() {
  if (!pane || !pane.msgSel) return [];
  return bucket(pane.convId).items.filter(m => pane.msgSel.has(m.id));
}

function toggleMessage(msg) {
  if (!pane || typeof msg.id !== 'number' || msg.kind === 'system') return;
  const set = new Set(pane.msgSel || []);
  if (set.has(msg.id)) set.delete(msg.id); else set.add(msg.id);
  setMessageSelection(set);
}

function setMessageSelection(set) {
  if (!pane) return;
  pane.msgSel = set && set.size ? set : null;
  closeMenus();
  paintMessageSelection();
  updateHeader();
}

function paintMessageSelection() {
  pane.nodes.forEach((node, id) => node.classList.toggle('msg-selected', !!(pane.msgSel && pane.msgSel.has(id))));
  pane.paneBody.classList.toggle('selecting', !!pane.msgSel);
  placeReactionPill(true);
}

/** Barre de réactions au-dessus du message sélectionné (un seul message). */
function placeReactionPill(rebuild = false) {
  let pill = document.querySelector('.reaction-pill:not(.in-menu)');
  const msgs = selectedMessages();
  const msg = msgs.length === 1 && !msgs[0].deleted ? msgs[0] : null;
  const node = msg && pane && pane.nodes.get(msg.id);
  if (!node) { if (pill) pill.remove(); return; }
  if (rebuild || !pill || +pill.dataset.id !== msg.id) {
    if (pill) pill.remove();
    pill = reactionStrip(msg, () => setMessageSelection(null));
    document.body.appendChild(pill);
  }
  // Au-dessus de la bulle, ou en dessous s'il n'y a pas la place ; masquée hors de la zone des messages.
  const r = node.querySelector('.bubble').getBoundingClientRect();
  const area = pane.scroller.getBoundingClientRect();
  const ph = pill.offsetHeight, pw = pill.offsetWidth;
  let top = r.top - ph - 8;
  if (top < area.top + 4) top = r.bottom + 8;
  pill.style.visibility = r.bottom > area.top && r.top < area.bottom ? 'visible' : 'hidden';
  const left = msg.sender_id === state.me.id ? r.right - pw : r.left;
  pill.style.top = Math.max(area.top + 4, Math.min(top, area.bottom - ph - 4)) + 'px';
  pill.style.left = Math.max(8, Math.min(left, window.innerWidth - pw - 8)) + 'px';
}

function selectionBar() {
  const msgs = selectedMessages();
  const n = msgs.length;
  const live = msgs.filter(m => !m.deleted);
  const one = n === 1 ? msgs[0] : null;
  const mine = !!one && one.sender_id === state.me.id;
  const canForward = n > 0 && msgs.every(m => !m.deleted && !m.view_once && m.kind !== 'poll' && m.kind !== 'system');
  const allStarred = live.length > 0 && live.every(m => m.starred);
  const canEdit = mine && one.kind === 'text' && !one.deleted && Date.now() - new Date(one.created_at) < 15 * 60000;
  const texts = live.filter(m => m.text).map(m => m.text);
  const done = () => setMessageSelection(null);
  const more = [
    texts.length ? { label: 'Copier', icon: 'copy', action: () => { navigator.clipboard.writeText(texts.join('\n')).then(() => toast('Copié')); done(); } } : null,
    canEdit ? { label: 'Modifier', icon: 'edit', action: () => { done(); setEditing(one); } } : null,
    mine && !one.deleted ? { label: 'Infos', icon: 'info', action: () => { done(); messageInfoDialog(one); } } : null,
    one && one.file && !one.deleted && !one.view_once ? { label: 'Télécharger', icon: 'download', action: () => {
      const a = h('a', { href: one.file, download: one.file_name || '' }); document.body.appendChild(a); a.click(); a.remove(); done();
    } } : null,
    one && one.kind === 'sticker' && !one.deleted ? { label: 'Sticker : favoris et collection', icon: 'sticker', action: () => { done(); stickerActionsDialog(one); } } : null,
  ].filter(Boolean);
  return [
    btn('back', 'Annuler la sélection', done),
    h('strong.sel-count', String(n)),
    h('div.row.sel-actions',
      one && !one.deleted ? btn('reply', 'Répondre', () => { done(); setReply(one); }) : null,
      live.length ? btn('star', allStarred ? 'Retirer des importants' : 'Marquer comme important', async () => {
        done();
        for (const m of live) if (!!m.starred === allStarred) await api.post(`messages/${m.id}/star`).catch(errorToast);
        toast(allStarred ? 'Retiré des importants' : 'Marqué comme important');
      }) : null,
      btn('trash', 'Supprimer', () => deleteMessages(msgs)),
      canForward ? btn('forward', 'Transférer', () => { done(); forwardMessages(msgs); }) : null,
      more.length ? btn('more', 'Plus', e => menu(e.currentTarget, more)) : null),
  ];
}

async function deleteMessages(msgs) {
  if (!pane || !msgs.length) return;
  const conv = pane.conv;
  const canAll = msgs.every(m => !m.deleted && ((m.sender_id === state.me.id && Date.now() - new Date(m.created_at) < 2 * 86400000)
    || (conv.kind === 'group' && conv.me.role === 'admin')));
  const n = msgs.length;
  const choice = await confirmDialog(n > 1 ? `Supprimer ces ${n} messages ?` : 'Supprimer ce message ?', {
    ok: 'Supprimer pour moi', danger: true,
    extra: canAll ? { label: 'Supprimer pour tous', value: 'everyone' } : null,
  });
  if (!choice) return;
  setMessageSelection(null);
  for (const m of msgs) {
    try { await api.post(`messages/${m.id}/delete`, { scope: choice === 'everyone' ? 'everyone' : 'me' }); } catch (e) { errorToast(e); }
  }
}

function messageMenu(msg, anchor, ev) {
  if (!pane) return;
  // Téléphone : même comportement que l'appui long (barre d'actions + réactions), comme WhatsApp.
  if (window.innerWidth <= 760) { toggleMessage(msg); return; }
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
    { label: 'Sélectionner', icon: 'check', action: () => toggleMessage(msg) },
    '-',
    { label: 'Supprimer', icon: 'trash', danger: true, action: () => deleteMessage(msg, canDeleteAll) },
  ], ev ? { x: ev.clientX, y: ev.clientY } : {});
  if (msg.deleted) return;
  // Réactions : bulle séparée posée au-dessus du menu, comme WhatsApp Web.
  const list = layer.querySelector('.menu');
  const pill = reactionStrip(msg, () => closeMenus());
  pill.classList.add('in-menu');
  layer.appendChild(pill);
  const gap = 8;
  let r = list.getBoundingClientRect();
  const ph = pill.offsetHeight, pw = pill.offsetWidth;
  if (r.top - ph - gap < 8) {
    // Pas la place au-dessus : on descend le menu sous la bulle.
    list.style.top = Math.min(window.innerHeight - r.height - 8, 8 + ph + gap) + 'px';
    r = list.getBoundingClientRect();
  }
  pill.style.top = Math.max(8, r.top - ph - gap) + 'px';
  pill.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + 'px';
}

/** Rangée de réactions rapides (👍 ❤️ 😂 😮 😢 🙏 +), commune au menu ordinateur et à la sélection mobile. */
function reactionStrip(msg, after) {
  const react = e => { api.post(`messages/${msg.id}/react`, { emoji: e }).catch(errorToast); after(); };
  return h('div.reaction-pill', { dataset: { id: msg.id } },
    QUICK_REACTIONS.map(e => h('button', { type: 'button', title: e, onclick: () => react(e) }, e)),
    h('button.more', { type: 'button', 'aria-label': "Plus d'emojis", title: "Plus d'emojis", onclick: () => {
      after();
      const picker = emojiPicker(e => { closeMenus(); react(e); });
      const l = h('div.menu-layer', { onmousedown: ev => { if (ev.target === l) closeMenus(); } }, h('div.menu.emoji-menu', picker));
      document.getElementById('overlay-root').appendChild(l);
      const box = l.firstChild;
      box.style.left = Math.max(8, (window.innerWidth - box.offsetWidth) / 2) + 'px';
      box.style.top = Math.max(8, (window.innerHeight - box.offsetHeight) / 2) + 'px';
    } }, icon('plus', 20)));
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
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  const input = h('textarea.composer-input', { rows: 1, placeholder: isPhone() ? 'Message' : 'Entrez un message', 'aria-label': 'Message' });
  const baseResize = autoGrow(input, 140);
  // Mentions « @membre » (groupes uniquement).
  const mention = mentionInput(input, {
    members: () => (pane ? pane.conv.participants.map(p => p.user).filter(u => u.id !== state.me.id) : []),
    enabled: () => !!pane && pane.conv.kind === 'group',
  });
  const resize = () => { baseResize(); mention.refresh(); };
  // Téléphone : le panneau emoji prend la place du clavier (comme WhatsApp), on ne redonne donc
  // pas le focus au champ après un emoji, sinon le clavier réapparaîtrait.
  const emojiTab = emojiPicker(e => {
    const s = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, s) + e + input.value.slice(input.selectionEnd ?? s);
    input.selectionStart = input.selectionEnd = s + e.length;
    if (!isPhone()) input.focus();
    resize(); toggleSend();
  }, { searchOpen: false });
  // Panneau emoji / stickers comme WhatsApp : en haut, loupe · [emoji | stickers] · touche effacer ;
  // les catégories d'emoji sont en bas. Stickers chargés à la demande.
  let stickersTab = null;
  const pickerBody = h('div.picker-body', emojiTab);
  const pickerSeg = h('div.picker-seg');
  const searchBtn = btn('search', 'Rechercher un emoji', () => emojiTab.toggleSearch(), 'picker-search');
  const showPicker = which => {
    if (which === 'stickers' && !stickersTab) {
      stickersTab = stickerPanel({ onSend: sticker => { sendSticker(sticker); closePicker(); } });
      pane.cleanup.push(() => stickersTab.cleanup());
    }
    if (which === 'stickers') emojiTab.toggleSearch(false);
    pickerBody.replaceChildren(which === 'stickers' ? stickersTab : emojiTab);
    pickerSeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === which));
    searchBtn.classList.toggle('invisible', which === 'stickers');
  };
  pickerSeg.append(
    h('button.active', { type: 'button', dataset: { tab: 'emoji' }, title: 'Emoji', 'aria-label': 'Emoji', onclick: () => showPicker('emoji') }, icon('smile', 22)),
    h('button', { type: 'button', dataset: { tab: 'stickers' }, title: 'Stickers', 'aria-label': 'Stickers', onclick: () => showPicker('stickers') }, icon('sticker', 22)));
  // Touche « effacer » : supprime le caractère (ou l'emoji entier) avant le curseur ; maintenue, elle répète.
  const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('fr', { granularity: 'grapheme' }) : null;
  const deleteBackward = () => {
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    let from = start;
    if (start === end) {
      if (!start) return;
      const before = input.value.slice(0, start);
      const last = graphemes ? [...graphemes.segment(before)].pop().segment : Array.from(before).pop();
      from = start - last.length;
    }
    input.value = input.value.slice(0, from) + input.value.slice(end);
    input.selectionStart = input.selectionEnd = from;
    resize(); toggleSend();
  };
  const delBtn = btn('backspace', 'Effacer', null, 'picker-del');
  let repeat = null;
  const stopRepeat = () => { clearTimeout(repeat); clearInterval(repeat); repeat = null; };
  delBtn.addEventListener('pointerdown', e => {
    e.preventDefault();
    deleteBackward();
    stopRepeat();
    repeat = setTimeout(() => { repeat = setInterval(deleteBackward, 70); }, 420);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => delBtn.addEventListener(ev, stopRepeat));
  pane.cleanup.push(stopRepeat);
  const pickerHead = h('div.picker-head', h('span.picker-grip'), h('div.picker-bar', searchBtn, pickerSeg, delBtn));
  const emojiPanel = h('div.emoji-panel.hidden', h('div.picker', pickerHead, pickerBody));
  const topBar = h('div.composer-top');
  const sendBtn = h('button.send-btn', { type: 'button', 'aria-label': 'Envoyer' }, icon('mic', 22));
  pane.input = input;
  pane.topBar = topBar;

  const toggleSend = () => {
    const hasText = input.value.trim().length > 0;
    sendBtn.replaceChildren(icon(hasText || pane.editing ? 'send' : 'mic', 22));
    sendBtn.setAttribute('aria-label', hasText ? 'Envoyer' : 'Enregistrer un message vocal');
    composer.classList.toggle('has-text', hasText);  // téléphone : l'appareil photo s'efface pendant la saisie
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
    const mentions = mention.list();
    input.value = ''; mention.clear(); resize(); toggleSend();
    setReply(null);
    sendTyping('stop');
    if (!isPhone()) closePicker();
    // Messages très longs : découpés comme WhatsApp (65 536 caractères max).
    sendMessage(pane.convId, {
      kind: 'text', text, reply_to: reply && reply.id, reply_preview: reply && quotePreview(reply),
      mentions: mentions.length ? mentions.map(m => m.id) : undefined, mention_preview: mentions,
    }).catch(e => errorToast(e));
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
  // Ouvrir le panneau : sur téléphone, on ferme le clavier et le panneau prend sa place,
  // le bouton devient « clavier ». Le refermer depuis ce bouton rouvre le clavier.
  const setPicker = open => {
    if (open) emojiTab.refreshRecent();
    else emojiTab.toggleSearch(false);
    emojiPanel.classList.toggle('hidden', !open);
    composer.classList.toggle('picker-open', open);
    const kb = open && isPhone();
    emojiBtn.replaceChildren(icon(kb ? 'keyboard' : 'smile'));
    emojiBtn.title = kb ? 'Clavier' : 'Emoji et stickers';
    emojiBtn.setAttribute('aria-label', emojiBtn.title);
  };
  const closePicker = () => setPicker(false);
  const emojiBtn = btn('smile', 'Emoji et stickers', () => {
    const open = emojiPanel.classList.contains('hidden');
    if (isPhone()) {
      if (open) input.blur();
      else input.focus();
    }
    setPicker(open);
  });
  // Toucher le champ pendant que le panneau est ouvert : le clavier revient à sa place.
  input.addEventListener('focus', () => { if (isPhone() && !emojiPanel.classList.contains('hidden')) closePicker(); });

  // Fermeture automatique : clic / toucher en dehors du panneau, ou touche Échap.
  // Les menus et fenêtres ouverts depuis le panneau (#overlay-root) ne le ferment pas.
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

  const camBtn = btn('camera', 'Appareil photo', async () => {
    const f = await pickFiles({ accept: 'image/*,video/*', capture: 'environment' });
    if (f.length) mediaPreviewDialog(f, sendFile);
  });
  camBtn.classList.add('composer-cam');
  attach.classList.add('composer-attach');
  emojiBtn.classList.add('composer-emoji');
  // Barre façon WhatsApp : une « pilule » (réponse citée au-dessus du champ) + bouton rond micro / envoyer.
  // Téléphone : emoji · champ · trombone · appareil photo, bouton rond à côté.
  // Ordinateur : trombone · emoji · champ, micro / envoyer dans la même barre (ordre réglé en CSS).
  const pill = h('div.composer-pill', topBar,
    h('div.composer-line', emojiBtn, h('div.composer-field', mention.field), attach, camBtn));
  // Le panneau est placé après la barre de saisie : sur téléphone il occupe la place du clavier.
  clear(composer, mention.picker, h('div.composer-row', pill, sendBtn), emojiPanel);
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

// Formats préférés : AAC (lisible partout) puis Opus. Le serveur convertit de toute façon en AAC.
const REC_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
const WAVE_LEVELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';

/** Niveaux enregistrés (0..1) → 48 barres codées en lettres (envoyées avec le vocal). */
function encodeWaveform(levels) {
  if (!levels.length) return '';
  const out = [];
  for (let i = 0; i < 48; i++) {
    const a = Math.floor(i * levels.length / 48), b = Math.max(a + 1, Math.floor((i + 1) * levels.length / 48));
    out.push(Math.max(...levels.slice(a, b)));
  }
  const top = Math.max(...out) || 1;
  return out.map(v => WAVE_LEVELS[Math.min(31, Math.round(Math.pow(v / top, 0.6) * 31))]).join('');
}

// Enregistrement façon WhatsApp : durée + onde en direct + « vue unique », puis
// corbeille · Pause (écouter avant d'envoyer, reprendre) · Envoyer.
async function startRecording() {
  if (!pane || pane.recorder) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast("L'enregistrement audio n'est pas pris en charge par ce navigateur.", { type: 'error' });
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { return toast('Accès au micro refusé.', { type: 'error' }); }
  if (!pane) { stream.getTracks().forEach(t => t.stop()); return; }
  const mime = REC_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  const levels = [];
  const started = Date.now();
  let cancelled = false, paused = false, pausedFor = 0, pausedAt = 0, viewOnce = false, preview = null;
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const convId = pane.convId;
  const reply = pane.replyTo;
  const elapsed = () => (Date.now() - started - pausedFor - (paused ? Date.now() - pausedAt : 0)) / 1000;

  // Niveau du micro (onde en direct + forme d'onde du message) : un seul petit analyseur, 12 mesures/s.
  let ctx = null, analyser = null, buf = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    buf = new Uint8Array(analyser.fftSize);
    ctx.createMediaStreamSource(stream).connect(analyser);
  } catch (e) { analyser = null; }
  const canvas = h('canvas.rec-wave');
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, hh = canvas.clientHeight;
    if (!w) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    g.fillStyle = getComputedStyle(canvas).color;
    const step = 4, n = Math.floor(w / step);
    const shown = levels.slice(-n);
    shown.forEach((v, i) => {
      const bh = Math.max(2, Math.min(1, v * 4) * hh);
      g.fillRect(w - (shown.length - i) * step, (hh - bh) / 2, 2, bh);
    });
    for (let x = w - shown.length * step - step; x > 0; x -= step) g.fillRect(x, hh / 2 - 1, 2, 2);  // pointillés
  };
  const sample = () => {
    if (paused) return;
    let v = 0.0125;
    if (analyser) {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
      v = Math.sqrt(sum / buf.length);  // niveau brut : la forme d'onde est normalisée à l'envoi
    }
    levels.push(v);
    draw();
  };

  const finish = () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(timer);
    clearInterval(typingTimer);
    if (ctx) ctx.close().catch(() => {});
    if (preview) { preview.pause(); URL.revokeObjectURL(preview.src); }
    send('typing', { conversation_id: convId, state: 'stop' });
    if (pane) { pane.recorder = null; buildComposer(); }
  };
  rec.onstop = () => {
    finish();
    if (cancelled || !chunks.length) return;
    const secs = elapsed();
    if (secs < 0.8) return toast('Message vocal trop court.');
    const type = rec.mimeType || 'audio/webm';
    const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
    const file = new File(chunks, `vocal-${Date.now()}.${ext}`, { type: type.split(';')[0] });
    sendMessage(convId, { kind: 'voice', duration: secs.toFixed(1), waveform: encodeWaveform(levels), view_once: viewOnce || undefined, reply_to: reply && reply.id }, { file }).catch(errorToast);
    if (pane) setReply(null);
  };
  rec.start(250);

  const time = h('span.rec-time', '0:00');
  const timer = setInterval(() => {
    sample();
    time.textContent = duration(elapsed());
    if (elapsed() > 900) rec.stop();          // 15 minutes au plus
  }, 80);
  send('typing', { conversation_id: convId, state: 'recording' });
  const typingTimer = setInterval(() => { if (!paused) send('typing', { conversation_id: convId, state: 'recording' }); }, 4000);

  // Pause : on peut réécouter ce qui est enregistré, puis reprendre.
  const listenBtn = h('button.rec-listen.hidden', { type: 'button', 'aria-label': 'Écouter' }, icon('play', 22));
  const pauseBtn = h('button.rec-pause', { type: 'button' });
  const paintPause = () => {
    pauseBtn.replaceChildren(icon(paused ? 'mic' : 'pause', 22), h('span', paused ? 'Reprendre' : 'Pause'));
    pauseBtn.classList.toggle('resume', paused);
    listenBtn.classList.toggle('hidden', !paused);
    row.classList.toggle('paused', paused);
  };
  pauseBtn.onclick = () => {
    if (!paused) {
      rec.pause(); paused = true; pausedAt = Date.now();
      try { rec.requestData(); } catch (e) { /* ignoré */ }
      send('typing', { conversation_id: convId, state: 'stop' });
    } else {
      if (preview) preview.pause();
      rec.resume(); paused = false; pausedFor += Date.now() - pausedAt;
    }
    paintPause();
  };
  listenBtn.onclick = () => {
    if (preview && !preview.paused) { preview.pause(); return; }
    if (preview) URL.revokeObjectURL(preview.src);
    preview = new Audio(URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })));
    preview.onplay = () => listenBtn.replaceChildren(icon('pause', 22));
    preview.onpause = preview.onended = () => listenBtn.replaceChildren(icon('play', 22));
    preview.play().catch(() => toast('Écoute indisponible sur cet appareil : envoyez ou reprenez.'));
  };
  const onceBtn = h('button.rec-once', { type: 'button', title: 'Vue unique', 'aria-label': 'Vue unique', 'aria-pressed': 'false', onclick: () => {
    viewOnce = !viewOnce;
    onceBtn.classList.toggle('active', viewOnce);
    onceBtn.setAttribute('aria-pressed', String(viewOnce));
    toast(viewOnce ? 'Vue unique : le vocal ne pourra être écouté qu’une fois.' : 'Vue unique désactivée.');
  } }, '1');

  pane.recorder = { cancel: () => { cancelled = true; if (rec.state !== 'inactive') rec.stop(); else finish(); } };
  const row = h('div.rec-panel',
    h('div.rec-top', h('span.rec-dot'), time, listenBtn, canvas, onceBtn),
    h('div.rec-actions',
      h('button.rec-trash', { type: 'button', 'aria-label': 'Supprimer', title: 'Supprimer', onclick: () => pane.recorder && pane.recorder.cancel() }, icon('trash', 22)),
      pauseBtn,
      h('button.send-btn.rec-send', { type: 'button', 'aria-label': 'Envoyer le vocal', onclick: () => rec.state !== 'inactive' && rec.stop() }, icon('send', 22))));
  paintPause();
  clear(pane.composer, row);
}

export { insertMessage };
