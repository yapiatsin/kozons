// État global de l'application et bus d'événements.

class Bus {
  constructor() { this.handlers = new Map(); }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event).delete(fn);
  }
  emit(event, data) {
    for (const fn of this.handlers.get(event) || []) {
      try { fn(data); } catch (e) { console.error(`[bus] ${event}`, e); }
    }
  }
}

export const bus = new Bus();

export const state = {
  me: null,
  conversations: new Map(),   // id -> conversation
  messages: new Map(),        // conversationId -> { items: Message[], hasMore, loaded }
  typing: new Map(),          // conversationId -> Map(userId -> {name, state, timer})
  activeConversation: null,
  notifications: { unread: 0, requests: 0 },
  wsStatus: 'offline',
};

export function upsertConversation(conv) {
  const prev = state.conversations.get(conv.id);
  state.conversations.set(conv.id, prev ? { ...prev, ...conv } : conv);
  bus.emit('conversations:changed', conv.id);
}

export function sortedConversations() {
  return [...state.conversations.values()].sort((a, b) => {
    if (a.me.pinned !== b.me.pinned) return a.me.pinned ? -1 : 1;
    const ta = (a.last_message && a.last_message.created_at) || a.updated_at;
    const tb = (b.last_message && b.last_message.created_at) || b.updated_at;
    return tb.localeCompare(ta);
  });
}

export function peerOf(conv) {
  if (!conv || conv.kind !== 'direct') return null;
  const p = conv.participants.find(p => p.user.id !== state.me.id);
  return p ? p.user : null;
}

export function convTitle(conv) {
  if (conv.kind === 'group') return conv.title;
  const peer = peerOf(conv);
  return peer ? peer.name : 'Discussion';
}

export function convAvatar(conv) {
  if (conv.kind === 'group') return conv.avatar;
  const peer = peerOf(conv);
  return peer ? peer.avatar : null;
}

export function isMuted(conv) {
  return conv.me.muted_until && new Date(conv.me.muted_until) > new Date();
}

export function findUser(userId) {
  for (const conv of state.conversations.values()) {
    const p = conv.participants.find(p => p.user.id === userId);
    if (p) return p.user;
  }
  return null;
}

// Préférences locales (thème, fond d'écran…) — jamais bloquant si le stockage est indisponible.
export const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem('kozons.' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('kozons.' + key, JSON.stringify(value)); } catch (e) { /* ignoré */ }
  },
};
