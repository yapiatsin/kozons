// Données des discussions : chargement, synchronisation temps réel, envoi optimiste.
import { api } from './api.js';
import { bus, state, upsertConversation, isMuted, convTitle, convAvatar } from './store.js';
import { send } from './ws.js';
import { beep } from './ui.js';

export async function loadConversations() {
  const { results } = await api.get('conversations');
  const ids = new Set(results.map(c => c.id));
  for (const id of [...state.conversations.keys()]) if (!ids.has(id)) state.conversations.delete(id);
  results.forEach(c => state.conversations.set(c.id, c));
  bus.emit('conversations:changed');
}

export function bucket(convId) {
  if (!state.messages.has(convId)) state.messages.set(convId, { items: [], hasMore: true, loaded: false });
  return state.messages.get(convId);
}

export async function loadMessages(convId, { older = false } = {}) {
  const b = bucket(convId);
  const firstReal = b.items.find(m => typeof m.id === 'number');
  const params = older && firstReal ? { before: firstReal.id } : {};
  const res = await api.get(`conversations/${convId}/messages`, params);
  if (older) {
    b.items = [...res.results, ...b.items];
  } else {
    const pending = b.items.filter(m => m.pending || m.failed);
    b.items = [...res.results, ...pending];
  }
  b.hasMore = res.has_more;
  b.loaded = true;
  bus.emit('messages:changed', { convId, older });
  return res;
}

/** Après une reconnexion : récupère les messages manqués sans tout recharger. */
export async function catchUp(convId) {
  const b = bucket(convId);
  const lastReal = [...b.items].reverse().find(m => typeof m.id === 'number');
  if (!b.loaded || !lastReal) return;
  let after = lastReal.id;
  for (let i = 0; i < 10; i++) {
    const res = await api.get(`conversations/${convId}/messages`, { after });
    res.results.forEach(m => insertMessage(m, { silent: true }));
    if (!res.has_newer || !res.results.length) break;
    after = res.results[res.results.length - 1].id;
  }
}

export function insertMessage(msg, { silent = false } = {}) {
  const b = state.messages.get(msg.conversation_id);
  if (b && b.loaded) {
    const idx = b.items.findIndex(m => m.id === msg.id || (m.client_id && m.client_id === msg.client_id));
    if (idx >= 0) b.items[idx] = msg;
    else {
      // Insertion triée : les messages en attente restent en bas.
      let pos = b.items.length;
      while (pos > 0 && (b.items[pos - 1].pending || b.items[pos - 1].failed || (typeof b.items[pos - 1].id === 'number' && b.items[pos - 1].id > msg.id))) pos--;
      b.items.splice(pos, 0, msg);
    }
    bus.emit('messages:changed', { convId: msg.conversation_id, newMessage: msg, silent });
  }
}

export function updateMessage(msg) {
  const b = state.messages.get(msg.conversation_id);
  if (b) {
    const idx = b.items.findIndex(m => m.id === msg.id);
    if (idx >= 0) {
      b.items[idx] = { ...msg, starred: b.items[idx].starred, opened: b.items[idx].opened || msg.opened };
      bus.emit('messages:changed', { convId: msg.conversation_id, updated: msg.id });
    }
  }
  const conv = state.conversations.get(msg.conversation_id);
  if (conv && conv.last_message && conv.last_message.id === msg.id) {
    conv.last_message = msg;
    bus.emit('conversations:changed', conv.id);
  }
}

export function isConversationVisible(convId) {
  return state.activeConversation === convId && document.visibilityState === 'visible' && document.hasFocus();
}

export function markRead(convId) {
  const conv = state.conversations.get(convId);
  const b = state.messages.get(convId);
  if (!conv || !b) return;
  const last = [...b.items].reverse().find(m => typeof m.id === 'number');
  if (!last) return;
  if (conv.unread === 0 && !conv.me.marked_unread && conv.me.last_read_id >= last.id) return;
  conv.unread = 0;
  conv.unread_mentions = 0;
  conv.me.marked_unread = false;
  conv.me.last_read_id = Math.max(conv.me.last_read_id, last.id);
  bus.emit('conversations:changed', convId);
  api.post(`conversations/${convId}/read`, { message_id: last.id }).catch(() => {});
}

let tempId = 0;

/** Envoi optimiste : la bulle apparaît immédiatement avec une horloge, puis est remplacée. */
export async function sendMessage(convId, fields, { file, onProgress } = {}) {
  const clientId = 'c' + Date.now() + '_' + (++tempId);
  const temp = {
    id: clientId, client_id: clientId, conversation_id: convId, sender_id: state.me.id, sender: state.me,
    kind: fields.kind || 'text', text: fields.text || '', file: file ? URL.createObjectURL(file) : (fields.preview_url || null),
    file_name: file ? file.name : '', file_size: file ? file.size : 0, duration: fields.duration || 0,
    reply_to: fields.reply_preview || null, created_at: new Date().toISOString(), reactions: [],
    pending: true, progress: 0, view_once: !!fields.view_once, mentions: fields.mention_preview || [],
    latitude: fields.latitude, longitude: fields.longitude,
  };
  if (file && !fields.kind) {
    temp.kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file';
  }
  const b = bucket(convId);
  b.items.push(temp);
  bus.emit('messages:changed', { convId, newMessage: temp, own: true });

  const payload = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'reply_preview' || k === 'preview_url' || k === 'mention_preview' || v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach(x => payload.append(k, x));
    else payload.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
  }
  if (file) payload.append('file', file, file.name || 'fichier');
  temp.retry = () => {
    temp.failed = false; temp.pending = true;
    bus.emit('messages:changed', { convId, updated: clientId });
    doSend();
  };
  const doSend = async () => {
    try {
      const msg = await api.post(`conversations/${convId}/messages`, payload, {
        onProgress: file ? p => { temp.progress = p; onProgress && onProgress(p); bus.emit('message:progress', { clientId, p }); } : undefined,
      });
      const idx = b.items.findIndex(m => m.client_id === clientId);
      const already = b.items.findIndex(m => m.id === msg.id);
      if (already >= 0) b.items.splice(idx, 1); // déjà reçu par WebSocket
      else if (idx >= 0) b.items[idx] = msg;
      if (temp.file && temp.file.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(temp.file), 5000);
      bus.emit('messages:changed', { convId, updated: msg.id });
      const conv = state.conversations.get(convId);
      if (conv) { conv.last_message = msg; conv.updated_at = msg.created_at; bus.emit('conversations:changed', convId); }
    } catch (e) {
      temp.pending = false; temp.failed = true; temp.error = e.message;
      bus.emit('messages:changed', { convId, updated: clientId });
      throw e;
    }
  };
  return doSend();
}

// ------------------------------------------------------------------ événements temps réel

const typingTimers = new Map();

export function installRealtime(notify) {
  bus.on('message.new', async msg => {
    let conv = state.conversations.get(msg.conversation_id);
    if (!conv) {
      try { conv = await api.get(`conversations/${msg.conversation_id}`); upsertConversation(conv); } catch (e) { return; }
    }
    const mine = msg.sender_id === state.me.id;
    // Le message remplace une éventuelle bulle optimiste identique encore en vol.
    insertMessage(msg);
    conv.last_message = msg;
    conv.updated_at = msg.created_at;
    if (!mine && msg.kind !== 'system') {
      send('delivered', { conversation_id: msg.conversation_id, message_id: msg.id });
      if (isConversationVisible(msg.conversation_id)) {
        markRead(msg.conversation_id);
      } else {
        conv.unread = (conv.unread || 0) + 1;
        if ((msg.mentions || []).some(m => m.id === state.me.id)) conv.unread_mentions = (conv.unread_mentions || 0) + 1;
        if (!isMuted(conv)) notify(conv, msg);
      }
      clearTyping(msg.conversation_id, msg.sender_id);
    }
    bus.emit('conversations:changed', conv.id);
  });

  bus.on('message.update', updateMessage);

  bus.on('message.hidden', ({ id, conversation_id }) => {
    const b = state.messages.get(conversation_id);
    if (b) { b.items = b.items.filter(m => m.id !== id); bus.emit('messages:changed', { convId: conversation_id }); }
    loadConversations().catch(() => {});
  });

  bus.on('message.starred', ({ id, conversation_id, starred }) => {
    const b = state.messages.get(conversation_id);
    const m = b && b.items.find(x => x.id === id);
    if (m) { m.starred = starred; bus.emit('messages:changed', { convId: conversation_id, updated: id }); }
  });

  bus.on('message.opened', ({ id, conversation_id }) => {
    const b = state.messages.get(conversation_id);
    const m = b && b.items.find(x => x.id === id);
    if (m) { m.opened_by_peer = true; bus.emit('messages:changed', { convId: conversation_id, updated: id }); }
  });

  bus.on('receipt', ({ conversation_id, user_id, last_read_id, last_delivered_id }) => {
    const conv = state.conversations.get(conversation_id);
    if (!conv) return;
    const p = conv.participants.find(p => p.user.id === user_id);
    if (p) {
      if (last_read_id) p.last_read_id = Math.max(p.last_read_id, last_read_id);
      if (last_delivered_id) p.last_delivered_id = Math.max(p.last_delivered_id, last_delivered_id);
    }
    bus.emit('receipts:changed', conversation_id);
  });

  bus.on('conversation.update', conv => upsertConversation(conv));
  bus.on('conversation.read', ({ conversation_id, last_read_id }) => {
    const conv = state.conversations.get(conversation_id);
    if (conv) { conv.unread = 0; conv.unread_mentions = 0; conv.me.last_read_id = last_read_id; conv.me.marked_unread = false; bus.emit('conversations:changed', conversation_id); }
  });
  bus.on('conversation.removed', ({ conversation_id }) => {
    state.conversations.delete(conversation_id);
    state.messages.delete(conversation_id);
    bus.emit('conversations:changed');
    if (state.activeConversation === conversation_id) window.kozons.go('/');
  });

  bus.on('typing', ({ conversation_id, user_id, name, state: st }) => {
    if (st === 'stop') return clearTyping(conversation_id, user_id);
    if (!state.typing.has(conversation_id)) state.typing.set(conversation_id, new Map());
    state.typing.get(conversation_id).set(user_id, { name, state: st });
    const key = conversation_id + ':' + user_id;
    clearTimeout(typingTimers.get(key));
    typingTimers.set(key, setTimeout(() => clearTyping(conversation_id, user_id), 7000));
    bus.emit('typing:changed', conversation_id);
  });

  bus.on('presence', ({ user_id, online, last_seen }) => {
    for (const conv of state.conversations.values()) {
      const p = conv.participants.find(p => p.user.id === user_id);
      if (p) { p.user.online = online; p.user.last_seen = last_seen; }
    }
    bus.emit('presence:changed', user_id);
  });

  bus.on('ws:reconnected', async () => {
    await loadConversations().catch(() => {});
    for (const convId of state.messages.keys()) catchUp(convId).catch(() => {});
  });
}

function clearTyping(convId, userId) {
  const map = state.typing.get(convId);
  if (map && map.delete(userId)) bus.emit('typing:changed', convId);
}

export function typingLabel(convId) {
  const map = state.typing.get(convId);
  if (!map || !map.size) return '';
  const conv = state.conversations.get(convId);
  const entries = [...map.values()];
  const verb = entries.some(e => e.state === 'recording') ? 'enregistre un audio' : 'écrit';
  if (conv && conv.kind === 'direct') return verb === 'écrit' ? 'écrit…' : 'enregistre un audio…';
  if (entries.length === 1) return `${entries[0].name.split(' ')[0]} ${verb}…`;
  return `${entries.length} personnes écrivent…`;
}

export function previewText(msg) {
  if (!msg) return '';
  if (msg.deleted) return '🚫 Ce message a été supprimé';
  const labels = {
    image: '📷 Photo', video: '🎥 Vidéo', audio: '🎵 Audio', voice: '🎤 Message vocal', file: '📄 ' + (msg.file_name || 'Document'),
    sticker: '🏷️ Autocollant', location: '📍 Position', contact: '👤 Contact', poll: '📊 ' + msg.text, post: '🖼️ Publication',
    story_reply: '↩️ ' + (msg.text || 'A répondu à une story'),
  };
  if (msg.view_once) return msg.kind === 'voice' ? '🎤 Vocal (vue unique)' : '① ' + (msg.kind === 'video' ? 'Vidéo' : 'Photo') + ' (vue unique)';
  if (msg.kind === 'text' || msg.kind === 'system') return msg.text;
  const base = labels[msg.kind] || msg.text;
  return msg.text && ['image', 'video', 'file'].includes(msg.kind) ? `${base.split(' ')[0]} ${msg.text}` : base;
}

export function notifyMessage(conv, msg) {
  beep('message');
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const title = conv.kind === 'group' ? `${convTitle(conv)} — ${msg.sender ? msg.sender.name : ''}` : convTitle(conv);
  const opts = { body: previewText(msg), icon: convAvatar(conv) || '/static/kozons/icon.svg', tag: 'conv-' + conv.id, data: { url: '/chats/' + conv.id } };
  navigator.serviceWorker && navigator.serviceWorker.getRegistration().then(reg => {
    if (reg) reg.showNotification(title, opts);
    else new Notification(title, opts);
  }).catch(() => {});
}
