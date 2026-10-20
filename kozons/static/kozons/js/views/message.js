// Rendu d'une bulle de message et de ses variantes.
import { api } from '../api.js';
import { state } from '../store.js';
import { h, icon, avatar, richText, isEmojiOnly, timeHM, bytes, duration, lightbox, errorToast, toast, onLongPress } from '../ui.js';

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
    if (ctx.onSelect && msg.kind !== 'system') {
      // Téléphone : appui long = sélection (barre d'actions + réactions), comme WhatsApp.
      onLongPress(row, () => ctx.onSelect(msg));
      row.addEventListener('click', e => {
        if (!ctx.isSelecting || !ctx.isSelecting()) return;
        e.preventDefault();
        e.stopPropagation();
        ctx.onSelect(msg);
      }, true);
    }
    row.addEventListener('dblclick', e => { if (!e.target.closest('a,button,video,audio,input')) ctx.onReply && ctx.onReply(msg); });
    if (ctx.onReply && !msg.deleted) swipeToReply(row, () => ctx.onReply(msg), () => !!(ctx.isSelecting && ctx.isSelecting()));
  }
  return row;
}

/** Téléphone : glisser un message de la gauche vers la droite pour y répondre (comme WhatsApp Android).
    La bulle suit le doigt, l'icône « répondre » apparaît à gauche ; au-delà du seuil, petite vibration
    et, au lâcher, la réponse est préparée. Un geste plutôt vertical laisse défiler la discussion. */
const SWIPE_MAX = 90, SWIPE_TRIGGER = 58;
function swipeToReply(row, onReply, disabled) {
  const wrap = row.querySelector('.bubble-wrap');
  let hint = null, sx = 0, sy = 0, dx = 0, mode = null, armed = false;
  const reset = () => {
    wrap.style.transition = 'transform .2s ease-out';
    wrap.style.transform = '';
    if (hint) { hint.style.transition = 'opacity .2s'; hint.style.opacity = '0'; }
    mode = null; armed = false; dx = 0;
  };
  row.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || disabled() || e.target.closest('.vp-wave')) { mode = 'off'; return; }  // glisser sur un vocal = avancer
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; mode = null; armed = false;
  }, { passive: true });
  row.addEventListener('touchmove', e => {
    if (mode === 'off' || e.touches.length !== 1) return;
    const x = e.touches[0].clientX - sx, y = e.touches[0].clientY - sy;
    if (!mode) {
      if (Math.abs(x) < 10 && Math.abs(y) < 10) return;
      // Glissement nettement horizontal vers la droite : on prend la main ; sinon on laisse défiler.
      mode = x > 0 && Math.abs(x) > Math.abs(y) * 1.4 ? 'swipe' : 'off';
      if (mode !== 'swipe') return;
      if (!hint) { hint = h('span.swipe-reply', icon('reply', 20)); row.appendChild(hint); }
      wrap.style.transition = hint.style.transition = 'none';
      row.dispatchEvent(new Event('touchcancel'));  // annule l'appui long en cours
    }
    if (mode !== 'swipe') return;
    e.preventDefault();
    dx = Math.max(0, Math.min(SWIPE_MAX, x * 0.75));
    wrap.style.transform = `translateX(${dx}px)`;
    const p = Math.min(1, dx / SWIPE_TRIGGER);
    hint.style.opacity = String(p);
    hint.style.transform = `translateY(-50%) scale(${0.6 + 0.4 * p})`;
    if (dx >= SWIPE_TRIGGER && !armed) { armed = true; if (navigator.vibrate) navigator.vibrate(12); }
    else if (dx < SWIPE_TRIGGER) armed = false;
  }, { passive: false });
  const end = () => {
    if (mode !== 'swipe') { mode = null; return; }
    const fire = armed;
    reset();
    if (fire) onReply();
  };
  row.addEventListener('touchend', end);
  row.addEventListener('touchcancel', e => { if (e.isTrusted) end(); });
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
    ? h('div.text.caption', textWithMentions(msg.text, msg.mentions)) : null;

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
      return h('div.text', textWithMentions(msg.text || '', msg.mentions));
  }
}

/** Texte d'un message avec les mentions « @Nom » en bleu (cliquables vers le profil). */
function textWithMentions(text, mentions) {
  if (!mentions || !mentions.length) return richText(text);
  const sorted = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const frag = document.createDocumentFragment();
  let buf = '';
  for (let i = 0; i < text.length;) {
    const m = text[i] === '@' && sorted.find(t => text.startsWith('@' + t.name, i));
    if (m) {
      if (buf) { frag.appendChild(richText(buf)); buf = ''; }
      frag.appendChild(h('a.mention-tag' + (m.id === state.me.id ? '.me' : ''), {
        href: '/u/' + m.username,
        onclick: e => { e.preventDefault(); e.stopPropagation(); window.kozons.go('/u/' + m.username); },
      }, '@' + m.name));
      i += m.name.length + 1;
    } else {
      buf += text[i];
      i++;
    }
  }
  if (buf) frag.appendChild(richText(buf));
  return frag;
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
        if (kind === 'voice') { const a = new Audio(file); a.play().catch(() => toast('Lecture impossible', { type: 'error' })); } else lightbox(file, kind);
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

// ------------------------------------------------------------------ messages vocaux (façon WhatsApp)
//
// Un seul élément <audio> pour toute l'application (au lieu d'un par message) : rien n'est téléchargé
// avant d'appuyer sur lecture, un seul vocal joue à la fois, et la lecture continue même si la bulle
// est redessinée. La durée et la forme d'onde viennent du serveur (vocal converti en AAC).

const WAVE_LEVELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
const BARS = 46;  // barres affichées (la forme d'onde stockée en a 48) : bien séparées même sur petit écran
const SPEEDS = [1, 1.5, 2];
const voice = { audio: null, id: null, msg: null, loading: false, switching: false, subs: new Map(), pos: new Map(), msgs: new Map(), raf: 0 };
let voiceSpeed = (() => { try { return SPEEDS.includes(+localStorage.getItem('kozons.voiceSpeed')) ? +localStorage.getItem('kozons.voiceSpeed') : 1; } catch (e) { return 1; } })();

function playedSet() {
  try { return new Set(JSON.parse(localStorage.getItem('kozons.voicePlayed')) || []); } catch (e) { return new Set(); }
}
function markPlayed(id) {
  if (typeof id !== 'number') return;
  const s = playedSet();
  if (s.has(id)) return;
  s.add(id);
  try { localStorage.setItem('kozons.voicePlayed', JSON.stringify([...s].slice(-400))); } catch (e) { /* stockage indisponible */ }
}

/** Niveaux 0..1 des 48 barres : forme d'onde du serveur, sinon motif stable tiré de l'id. */
function waveLevels(msg) {
  const w = msg.waveform || '';
  if (w) {
    const raw = [...w].map(c => Math.max(0, WAVE_LEVELS.indexOf(c)) / 31);
    return Array.from({ length: BARS }, (_, i) => {
      const from = Math.floor(i * raw.length / BARS), to = Math.max(from + 1, Math.floor((i + 1) * raw.length / BARS));
      return Math.max(...raw.slice(from, to));
    });
  }
  let seed = (typeof msg.id === 'number' ? msg.id : 7) * 9301 + 49297;
  return Array.from({ length: BARS }, () => { seed = (seed * 9301 + 49297) % 233280; return 0.25 + 0.6 * (seed / 233280); });
}

const voiceDuration = msg => {
  const a = voice.audio;
  if (a && voice.id === msg.id && isFinite(a.duration) && a.duration > 0) return a.duration;
  return msg.duration || 0;
};

function emitVoice(id) {
  const set = voice.subs.get(id);
  if (!set) return;
  for (const fn of [...set]) fn();
}

function tick() {
  emitVoice(voice.id);
  if (voice.audio && !voice.audio.paused) voice.raf = requestAnimationFrame(tick);
}

function engine() {
  if (voice.audio) return voice.audio;
  const a = new Audio();
  a.preload = 'auto';
  a.addEventListener('playing', () => { voice.loading = false; voice.switching = false; cancelAnimationFrame(voice.raf); tick(); });
  a.addEventListener('waiting', () => { voice.loading = true; emitVoice(voice.id); });
  a.addEventListener('pause', () => {
    cancelAnimationFrame(voice.raf);
    if (!voice.switching && voice.id !== null) voice.pos.set(voice.id, a.currentTime);  // reprise au même endroit
    emitVoice(voice.id);
  });
  a.addEventListener('ended', () => {
    const done = voice.id;
    voice.pos.delete(done);
    cancelAnimationFrame(voice.raf);
    emitVoice(done);
    playNextVoice(done);
  });
  a.addEventListener('error', () => {
    if (!voice.id) return;
    const id = voice.id;
    voice.loading = false;
    voice.id = null;
    emitVoice(id);
    toast('Impossible de lire ce message vocal. Vérifiez votre connexion.', { type: 'error' });
  });
  voice.audio = a;
  return a;
}

export function playVoice(msg) {
  const a = engine();
  if (voice.id === msg.id) {
    if (a.paused) a.play().catch(playFailed);
    else a.pause();
    return;
  }
  if (voice.id !== null && !a.paused) { voice.pos.set(voice.id, a.currentTime); a.pause(); }
  const prev = voice.id;
  voice.switching = true;
  voice.id = msg.id;
  voice.msg = msg;
  voice.loading = true;
  a.src = msg.file;
  a.playbackRate = voiceSpeed;
  const resume = voice.pos.get(msg.id) || 0;
  if (resume) a.addEventListener('loadedmetadata', () => { try { a.currentTime = resume; } catch (e) { /* ignoré */ } }, { once: true });
  // Doit suivre directement le toucher (iPhone) : aucun await avant play().
  a.play().catch(playFailed);
  markPlayed(msg.id);
  if (prev !== null) emitVoice(prev);
  emitVoice(msg.id);
  mediaSession(msg);
}

function playFailed(e) {
  if (e && e.name === 'AbortError') return;  // un autre vocal a été lancé entre-temps
  voice.switching = false;
  const id = voice.id;
  voice.loading = false;
  voice.id = null;
  emitVoice(id);
  toast(e && e.name === 'NotAllowedError' ? 'Appuyez à nouveau sur lecture.' : 'Ce message vocal ne peut pas être lu sur cet appareil.', { type: 'error' });
}

/** Vocal suivant de la discussion (messages consécutifs), comme WhatsApp. */
function playNextVoice(id) {
  const row = document.querySelector(`.msg-row[data-id="${id}"]`);
  let next = row && row.nextElementSibling;
  while (next && !next.classList.contains('msg-row')) next = next.nextElementSibling;
  const el = next && next.querySelector('.voice[data-voice]');
  const msg = el && voice.msgs.get(+el.dataset.voice);
  if (msg && msg.kind === 'voice') playVoice(msg);
  else if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
}

/** Commandes sur l'écran verrouillé / la notification média du téléphone. */
function mediaSession(msg) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  const who = msg.sender || state.me;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Message vocal', artist: who ? who.name : 'Kozons', album: 'Kozons',
      artwork: who && who.avatar ? [{ src: who.avatar, sizes: '256x256' }] : [{ src: '/static/kozons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    });
    const a = engine();
    navigator.mediaSession.setActionHandler('play', () => a.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => a.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => { a.currentTime = Math.max(0, a.currentTime - 5); });
    navigator.mediaSession.setActionHandler('seekforward', () => { a.currentTime = Math.min(voiceDuration(voice.msg), a.currentTime + 5); });
  } catch (e) { /* non pris en charge */ }
}

export function voicePlayer(msg) {
  voice.msgs.set(msg.id, msg);
  const mine = msg.sender_id === state.me.id;
  const levels = waveLevels(msg);
  const bars = () => h('div.vp-bars', levels.map(l => h('i', { style: { height: Math.max(12, Math.round(l * 100)) + '%' } })));
  const played = bars();
  played.classList.add('vp-played');
  const thumb = h('span.vp-thumb');
  const wave = h('div.vp-wave', { role: 'slider', tabindex: 0, 'aria-label': 'Position dans le message vocal', 'aria-valuemin': 0 }, bars(), played, thumb);
  const time = h('span.vp-time');
  const playBtn = h('button.vp-play', { type: 'button', 'aria-label': 'Lire le message vocal', onclick: e => { e.stopPropagation(); playVoice(msg); } });
  const speedBtn = h('button.vp-speed', { type: 'button', 'aria-label': 'Vitesse de lecture', onclick: e => {
    e.stopPropagation();
    voiceSpeed = SPEEDS[(SPEEDS.indexOf(voiceSpeed) + 1) % SPEEDS.length];
    try { localStorage.setItem('kozons.voiceSpeed', String(voiceSpeed)); } catch (err) { /* stockage indisponible */ }
    if (voice.audio) voice.audio.playbackRate = voiceSpeed;
    paint();
  } });
  // Disposition WhatsApp : ▶ · onde (avec le point) · photo + micro ; la durée sous l'onde.
  // Mes vocaux : la photo passe à gauche. Pendant la lecture, la vitesse remplace la photo.
  const who = msg.sender || state.me;
  const side = h('div.vp-side',
    msg.kind === 'voice' ? avatar(who.avatar, who.name, 44) : h('div.doc-icon', icon('volume', 22)),
    msg.kind === 'voice' ? h('span.vp-mic', icon('mic', 18)) : null, speedBtn);
  const el = h('div.voice' + (mine ? '.mine' : ''), { dataset: { voice: msg.id } },
    side, playBtn, h('div.vp-main', wave, h('div.vp-foot', time)));

  let lastIcon = '';
  function paint() {
    const current = voice.id === msg.id;
    const a = voice.audio;
    const playing = current && a && !a.paused;
    const loading = current && voice.loading;
    const d = voiceDuration(msg);
    const t = current && a ? a.currentTime : (voice.pos.get(msg.id) || 0);
    const p = d ? Math.min(1, t / d) : 0;
    played.style.clipPath = `inset(0 ${100 - p * 100}% 0 0)`;
    thumb.style.left = p * 100 + '%';
    wave.setAttribute('aria-valuenow', Math.round(t));
    wave.setAttribute('aria-valuemax', Math.round(d));
    time.textContent = duration(playing || t >= 1 ? t : d);
    const ic = loading ? 'load' : playing ? 'pause' : 'play';
    if (ic !== lastIcon) {
      lastIcon = ic;
      playBtn.replaceChildren(ic === 'load' ? h('span.vp-spin') : icon(ic, 26));
      playBtn.setAttribute('aria-label', playing ? 'Mettre en pause' : 'Lire le message vocal');
    }
    // Pendant la lecture, la vitesse remplace la photo (comme WhatsApp).
    el.classList.toggle('active', current && (playing || loading || t > 0));
    el.classList.toggle('playing', !!playing);
    el.style.setProperty('--p', p.toFixed(4));
    speedBtn.textContent = String(voiceSpeed).replace('.', ',') + '×';
    el.classList.toggle('unplayed', !mine && typeof msg.id === 'number' && !playedSet().has(msg.id));
  }

  // Avancer / reculer en touchant ou en glissant sur la forme d'onde.
  wave.addEventListener('pointerdown', e => {
    e.stopPropagation();
    const d = voiceDuration(msg);
    if (!d) return;
    wave.setPointerCapture(e.pointerId);
    const seek = ev => {
      const r = wave.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * d;
      if (voice.id === msg.id && voice.audio) voice.audio.currentTime = t;
      else voice.pos.set(msg.id, t);
      paint();
    };
    seek(e);
    const up = () => { wave.removeEventListener('pointermove', seek); wave.removeEventListener('pointerup', up); wave.removeEventListener('pointercancel', up); };
    wave.addEventListener('pointermove', seek);
    wave.addEventListener('pointerup', up);
    wave.addEventListener('pointercancel', up);
  });
  wave.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 5 : -5;
    if (voice.id === msg.id && voice.audio) voice.audio.currentTime = Math.max(0, voice.audio.currentTime + step);
    else voice.pos.set(msg.id, Math.max(0, (voice.pos.get(msg.id) || 0) + step));
    paint();
  });

  // Abonnement à l'état du lecteur partagé ; retiré quand la bulle n'est plus affichée.
  const fn = () => { if (!el.isConnected && voice.id !== msg.id) { unsubscribe(); return; } paint(); };
  const unsubscribe = () => { const set = voice.subs.get(msg.id); if (set) { set.delete(fn); if (!set.size) voice.subs.delete(msg.id); } };
  if (!voice.subs.has(msg.id)) voice.subs.set(msg.id, new Set());
  voice.subs.get(msg.id).add(fn);
  paint();
  return el;
}

async function startChatWith(userId) {
  try {
    const conv = await api.post('conversations/direct', { user_id: userId });
    window.kozons.go('/chats/' + conv.id);
  } catch (e) { errorToast(e); }
}
