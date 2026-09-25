// Rendu d'une bulle de message et de ses variantes.
import { api } from '../api.js';
import { state } from '../store.js';
import { h, icon, avatar, richText, isEmojiOnly, timeHM, bytes, duration, lightbox, errorToast, toast } from '../ui.js';

const NAME_COLORS = ['#e542a3', '#1f7aec', '#d3a100', '#0099cc', '#7f66ff', '#fc5c65', '#35cd96', '#ff8a00'];

export function nameColor(userId) {
  return NAME_COLORS[(userId || 0) % NAME_COLORS.length];
}

/** 'pending' | 'failed' | 'sent' | 'delivered' | 'read' pour un message envoyé par moi. */
export function receiptStatus(conv, msg) {
  if (msg.pending) return 'pending';
  if (msg.failed) return 'failed';
  const others = conv.participants.filter(p => p.user.id !== state.me.id);
  if (!others.length) return 'sent';
  if (others.every(p => p.last_read_id >= msg.id)) return 'read';
  if (others.every(p => p.last_delivered_id >= msg.id)) return 'delivered';
  return 'sent';
}

export function ticks(status) {
  if (status === 'pending') return icon('clock', 15, 'tick');
  if (status === 'failed') return h('span.tick.failed', { title: "Échec de l'envoi" }, '!');
  if (status === 'sent') return icon('check', 16, 'tick');
  return icon('checks', 18, 'tick' + (status === 'read' ? ' read' : ''));
}

export function signature(conv, msg) {
  const mine = msg.sender_id === state.me.id;
  return JSON.stringify([msg.id, msg.text, msg.edited_at, msg.deleted, msg.reactions, msg.starred, msg.pending, msg.failed,
    msg.opened, msg.opened_by_peer, msg.poll, mine ? receiptStatus(conv, msg) : 0, msg.file]);
}

/** Construit la bulle. `ctx` : { conv, showSender, onMenu, onJump, onReply } */
export function renderMessage(msg, ctx) {
  const { conv } = ctx;
  if (msg.kind === 'system') {
    return h('div.msg-row.system', { dataset: { id: msg.id } }, h('div.system-pill', msg.text));
  }
  const mine = msg.sender_id === state.me.id;
  const bubbleless = !msg.deleted && (msg.kind === 'sticker' || (msg.kind === 'text' && isEmojiOnly(msg.text) && !msg.reply_to));
  const bubble = h('div.bubble' + (bubbleless ? '.bare' : '') + (msg.kind === 'text' && isEmojiOnly(msg.text) ? '.emoji-only' : ''));

  if (ctx.showSender && !mine && conv.kind === 'group') {
    bubble.appendChild(h('div.sender-name', { style: { color: nameColor(msg.sender_id) } }, msg.sender ? msg.sender.name : 'Utilisateur supprimé'));
  }
  if (msg.forwarded && !msg.deleted) bubble.appendChild(h('div.forwarded', icon('forward', 14), 'Transféré'));
  if (msg.reply_to) bubble.appendChild(replyQuote(msg.reply_to, () => ctx.onJump && ctx.onJump(msg.reply_to.id)));

  bubble.appendChild(body(msg, ctx));

  const meta = h('span.meta',
    msg.expires_at ? icon('timer', 12) : null,
    msg.starred ? icon('star', 12, 'star') : null,
    msg.edited_at && !msg.deleted ? h('span.edited', 'modifié') : null,
    h('span', timeHM(msg.created_at)),
    mine && !msg.deleted ? ticks(receiptStatus(conv, msg)) : null);
  bubble.appendChild(meta);

  if (msg.failed) {
    bubble.appendChild(h('button.retry', { onclick: () => msg.retry && msg.retry() }, 'Échec — Réessayer'));
  }
  if (msg.pending && msg.progress !== undefined && msg.file) {
    bubble.appendChild(h('div.upload-progress', h('div', { style: { width: Math.round((msg.progress || 0) * 100) + '%' } })));
  }

  const arrow = !msg.pending && !msg.failed && typeof msg.id === 'number'
    ? h('button.bubble-menu', { type: 'button', 'aria-label': 'Options du message', onclick: e => { e.stopPropagation(); ctx.onMenu(msg, e.currentTarget); } }, icon('arrowDown', 18))
    : null;
  if (arrow) bubble.appendChild(arrow);

  const reactions = msg.reactions && msg.reactions.length ? reactionChips(msg, ctx) : null;
  const row = h('div.msg-row' + (mine ? '.mine' : '.theirs'), { dataset: { id: msg.id } },
    h('div.bubble-wrap', bubble, reactions));
  if (typeof msg.id === 'number') {
    row.addEventListener('contextmenu', e => { e.preventDefault(); ctx.onMenu(msg, null, e); });
    row.addEventListener('dblclick', e => { if (!e.target.closest('a,button,video,audio,input')) ctx.onReply && ctx.onReply(msg); });
  }
  return row;
}

function reactionChips(msg, ctx) {
  const counts = new Map();
  for (const r of msg.reactions) counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
  const mineR = msg.reactions.find(r => r.user_id === state.me.id);
  return h('button.reactions' + (mineR ? '.mine' : ''), {
    type: 'button', title: 'Voir les réactions', onclick: () => ctx.onReactions && ctx.onReactions(msg),
  }, [...counts.entries()].map(([e]) => h('span', e)), msg.reactions.length > 1 ? h('span.count', String(msg.reactions.length)) : null);
}

export function replyQuote(r, onclick) {
  const who = r.sender_id === state.me.id ? 'Vous' : r.sender_name;
  const labels = { image: '📷 Photo', video: '🎥 Vidéo', voice: '🎤 Message vocal', audio: '🎵 Audio', file: '📄 Document', location: '📍 Position', contact: '👤 Contact', poll: '📊 Sondage', sticker: 'Autocollant', post: '🖼️ Publication' };
  return h('div.quote', { onclick, style: { borderColor: nameColor(r.sender_id) } },
    h('div.quote-text',
      h('div.quote-name', { style: { color: nameColor(r.sender_id) } }, who),
      h('div.quote-body', r.deleted ? 'Message supprimé' : (r.text || labels[r.kind] || ''))),
    r.file && r.kind !== 'voice' ? h('img.quote-thumb', { src: r.file, alt: '' }) : null);
}

function body(msg, ctx) {
  if (msg.deleted) {
    return h('div.text.deleted', icon('block', 14), msg.sender_id === state.me.id ? 'Vous avez supprimé ce message' : 'Ce message a été supprimé');
  }
  const caption = msg.text && msg.kind !== 'text' && msg.kind !== 'poll' && msg.kind !== 'story_reply'
    ? h('div.text.caption', richText(msg.text)) : null;

  if (msg.view_once) return viewOnce(msg);

  switch (msg.kind) {
    case 'image':
    case 'sticker':
      return h('div', h('img.media' + (msg.kind === 'sticker' ? '.sticker' : ''), {
        src: msg.file, alt: '', loading: 'lazy',
        onclick: () => msg.kind === 'sticker' && typeof msg.id === 'number'
          ? import('./stickerpanel.js').then(m => m.stickerActionsDialog(msg))
          : lightbox(msg.file, 'image', { caption: msg.text, onForward: ctx.onForward ? () => ctx.onForward(msg) : null }),
      }), caption);
    case 'video':
      return h('div', h('video.media', { src: msg.file, controls: true, preload: 'metadata', playsinline: true }), caption);
    case 'voice':
    case 'audio':
      return h('div', voicePlayer(msg), caption);
    case 'file':
      return h('div', h('a.doc', { href: msg.file, target: '_blank', rel: 'noopener', download: msg.file_name },
        h('div.doc-icon', icon('doc', 26)),
        h('div.doc-info', h('div.doc-name', msg.file_name || 'Document'), h('div.doc-size', [bytes(msg.file_size), (msg.file_name.split('.').pop() || '').toUpperCase()].filter(Boolean).join(' · '))),
        icon('download', 20)), caption);
    case 'location': {
      const { latitude: lat, longitude: lng } = msg;
      const d = 0.004;
      return h('div.location',
        h('iframe', { src: `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&layer=mapnik&marker=${lat},${lng}`, loading: 'lazy', title: 'Carte', referrerpolicy: 'no-referrer' }),
        h('a', { href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`, target: '_blank', rel: 'noopener' }, icon('location', 16), ' Ouvrir la carte'));
    }
    case 'contact': {
      const u = msg.contact;
      if (!u) return h('div.text', 'Contact indisponible');
      return h('div.contact-card',
        h('div.row', avatar(u.avatar, u.name, 44), h('div', h('strong', u.name), h('div.muted', '@' + u.username))),
        h('div.contact-actions',
          h('button', { onclick: () => startChatWith(u.id) }, 'Écrire'),
          h('button', { onclick: () => window.kozons.go('/u/' + u.username) }, 'Voir le profil')));
    }
    case 'poll':
      return pollView(msg);
    case 'post': {
      const p = msg.shared_post;
      if (!p) return h('div.text.deleted', 'Publication indisponible');
      return h('div', h('div.shared-post', { onclick: () => window.kozons.go('/p/' + p.id) },
        h('div.row.shared-post-head', avatar(p.author.avatar, p.author.name, 26), h('strong', p.author.username)),
        p.media ? (p.media_kind === 'video' ? h('video', { src: p.media, muted: true, preload: 'metadata' }) : h('img', { src: p.media, alt: '', loading: 'lazy' })) : null,
        p.caption ? h('div.shared-post-caption', p.caption) : null), caption);
    }
    case 'story_reply': {
      const s = msg.story;
      return h('div',
        h('div.story-quote',
          h('div.muted.small', msg.sender_id === state.me.id ? 'Vous avez répondu à sa story' : 'A répondu à votre story'),
          s && !s.expired ? (s.kind === 'text'
            ? h('div.story-quote-text', { style: { background: s.background } }, s.text)
            : s.kind === 'video' ? h('video', { src: s.file, muted: true }) : h('img', { src: s.file, alt: '' }))
            : h('div.muted.small', 'Story expirée')),
        msg.text ? h('div.text', richText(msg.text)) : null);
    }
    default:
      return h('div.text', richText(msg.text || ''));
  }
}

function viewOnce(msg) {
  const mine = msg.sender_id === state.me.id;
  const label = msg.kind === 'video' ? 'Vidéo' : msg.kind === 'voice' ? 'Message vocal' : 'Photo';
  if (mine) return h('div.view-once.done', icon('once', 20), `${label} · vue unique${msg.opened_by_peer ? ' · ouverte' : ''}`);
  if (msg.opened) return h('div.view-once.done', icon('once', 20), 'Ouvert');
  return h('button.view-once', {
    type: 'button',
    onclick: async () => {
      try {
        const { file, kind } = await api.post(`messages/${msg.id}/open`);
        msg.opened = true;
        if (kind === 'voice') { const a = new Audio(file); a.play(); } else lightbox(file, kind);
        window.dispatchEvent(new CustomEvent('kozons:rerender-message', { detail: msg }));
      } catch (e) { errorToast(e); }
    },
  }, icon('once', 20), `${label} · appuyez pour voir`);
}

function pollView(msg) {
  const poll = msg.poll;
  if (!poll) return h('div.text', msg.text);
  const voters = new Set(poll.options.flatMap(o => o.votes));
  const max = Math.max(1, ...poll.options.map(o => o.votes.length));
  return h('div.poll',
    h('div.poll-q', msg.text),
    h('div.muted.small', poll.multiple ? 'Sélectionnez une ou plusieurs options' : 'Sélectionnez une option'),
    poll.options.map(o => {
      const voted = o.votes.includes(state.me.id);
      return h('button.poll-opt' + (voted ? '.voted' : ''), {
        type: 'button',
        onclick: () => api.post(`messages/${msg.id}/vote`, { option_id: o.id }).catch(errorToast),
      },
      h('span.poll-check', voted ? icon('check', 14) : null),
      h('div.poll-main',
        h('div.row.poll-row', h('span', o.text), h('span.muted', String(o.votes.length))),
        h('div.poll-bar', h('div', { style: { width: (o.votes.length / max * 100) + '%' } }))));
    }),
    h('div.muted.small.center', `${voters.size} votant${voters.size > 1 ? 's' : ''}`));
}

// Lecteur audio unique : un seul vocal joue à la fois, lecture enchaînée possible.
let playing = null;

export function voicePlayer(msg) {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = msg.file;
  const playBtn = h('button.vp-play', { type: 'button', 'aria-label': 'Lire' }, icon('play', 20));
  const bar = h('input.vp-bar', { type: 'range', min: 0, max: 1000, value: 0 });
  const time = h('span.vp-time', duration(msg.duration));
  const speedBtn = h('button.vp-speed', { type: 'button' }, '1×');
  const speeds = [1, 1.5, 2];
  let speedIdx = 0;
  const set = playingNow => clearIcon(playBtn, playingNow ? 'pause' : 'play');
  playBtn.onclick = () => {
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.play().catch(() => toast('Lecture impossible', { type: 'error' }));
    } else audio.pause();
  };
  speedBtn.onclick = () => {
    speedIdx = (speedIdx + 1) % speeds.length;
    audio.playbackRate = speeds[speedIdx];
    speedBtn.textContent = speeds[speedIdx] + '×';
  };
  audio.onplay = () => set(true);
  audio.onpause = () => set(false);
  audio.onended = () => { set(false); bar.value = 0; };
  audio.ontimeupdate = () => {
    const d = isFinite(audio.duration) ? audio.duration : msg.duration;
    if (d) bar.value = (audio.currentTime / d) * 1000;
    time.textContent = duration(audio.currentTime || d);
  };
  bar.oninput = () => {
    const d = isFinite(audio.duration) ? audio.duration : msg.duration;
    if (d) audio.currentTime = (bar.value / 1000) * d;
  };
  const who = msg.sender || state.me;
  return h('div.voice',
    msg.kind === 'voice' ? avatar(who.avatar, who.name, 40) : h('div.doc-icon', icon('volume', 22)),
    playBtn, h('div.vp-track', bar, h('div.row.vp-foot', time, speedBtn)));
}

function clearIcon(button, name) {
  button.replaceChildren(icon(name, 20));
}

async function startChatWith(userId) {
  try {
    const conv = await api.post('conversations/direct', { user_id: userId });
    window.kozons.go('/chats/' + conv.id);
  } catch (e) { errorToast(e); }
}
