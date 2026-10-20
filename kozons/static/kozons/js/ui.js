// Utilitaires d'interface : création d'éléments sûre (pas d'innerHTML sur du contenu utilisateur),
// modales, menus, toasts, formats de date.
import { icon } from './icons.js';

export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export { icon };

export function btn(iconName, title, onclick, cls = '') {
  return h('button.icon-btn' + (cls ? '.' + cls : ''), { type: 'button', title, 'aria-label': title, onclick }, icon(iconName));
}

// ------------------------------------------------------------------ avatars

const COLORS = ['#0099cc', '#e1306c', '#7c4dff', '#ff9800', '#03a9f4', '#8bc34a', '#f44336', '#009688', '#795548', '#3f51b5'];

export function avatar(src, name = '?', size = 40, opts = {}) {
  const el = h('div.avatar', { style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px' } });
  if (opts.ring) el.classList.add('ring', opts.ring === 'seen' ? 'ring-seen' : opts.ring === 'live' ? 'ring-live' : 'ring-new');
  if (src) {
    el.appendChild(h('img', { src, alt: '', loading: 'lazy', draggable: 'false' }));
  } else if (opts.group) {
    el.appendChild(icon('users', Math.round(size * 0.55)));
    el.style.background = '#8696a0';
  } else {
    const initials = (name || '?').trim().split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
    el.textContent = initials || '?';
    let hash = 0;
    for (const ch of name || '') hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    el.style.background = COLORS[Math.abs(hash) % COLORS.length];
  }
  if (opts.online) el.appendChild(h('span.online-dot'));
  return el;
}

// ------------------------------------------------------------------ dates & formats

const pad = n => String(n).padStart(2, '0');

export function timeHM(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "Aujourd'hui";
  if (sameDay(d, yesterday)) return 'Hier';
  if (now - d < 6 * 86400000) return d.toLocaleDateString('fr-FR', { weekday: 'long' });
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

export function listTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return timeHM(iso);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Hier';
  if (now - d < 6 * 86400000) return d.toLocaleDateString('fr-FR', { weekday: 'short' });
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 604800) return `${Math.floor(s / 86400)} j`;
  return `${Math.floor(s / 604800)} sem`;
}

export function lastSeenLabel(user) {
  if (!user) return '';
  if (user.online) return 'en ligne';
  if (!user.last_seen) return '';
  const d = new Date(user.last_seen);
  const label = dayLabel(user.last_seen);
  return `vu(e) ${label === "Aujourd'hui" ? "aujourd'hui" : label.toLowerCase()} à ${timeHM(d)}`;
}

export function bytes(n) {
  if (!n) return '';
  const u = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function duration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const hh = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return hh ? `${hh}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function compact(n) {
  if (n === null || n === undefined) return '';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace('.0', '') + ' k';
  return (n / 1e6).toFixed(1).replace('.0', '') + ' M';
}

// ------------------------------------------------------------------ texte enrichi

const TOKEN_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])|(@[a-zA-Z0-9._]{3,30})|(#[\p{L}\p{N}_]{2,50})|(\*[^*\n]+\*)|(_[^_\n]+_)|(~[^~\n]+~)|(`[^`\n]+`)/gu;

/** Texte avec liens, mentions, hashtags et mise en forme WhatsApp (*gras*, _italique_, ~barré~, `code`). */
export function richText(text, { onMention, onTag } = {}) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const [tok, url, mention, tag, bold, ital, strike, code] = m;
    if (url) frag.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
    else if (mention) frag.appendChild(h('a.mention', { href: '/u/' + mention.slice(1), onclick: e => { e.preventDefault(); onMention ? onMention(mention.slice(1)) : window.kozons.go('/u/' + mention.slice(1)); } }, mention));
    else if (tag) frag.appendChild(h('a.mention', { href: '#', onclick: e => { e.preventDefault(); onTag ? onTag(tag) : window.kozons.go('/explore?q=' + encodeURIComponent(tag)); } }, tag));
    else if (bold) frag.appendChild(h('strong', tok.slice(1, -1)));
    else if (ital) frag.appendChild(h('em', tok.slice(1, -1)));
    else if (strike) frag.appendChild(h('s', tok.slice(1, -1)));
    else if (code) frag.appendChild(h('code', tok.slice(1, -1)));
    last = m.index + tok.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

export function isEmojiOnly(text) {
  const t = (text || '').trim();
  return t.length > 0 && t.length <= 12 && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t);
}

// ------------------------------------------------------------------ superpositions

const overlayRoot = () => document.getElementById('overlay-root');

export function modal(content, { title, onClose, wide, cls, closable = true } = {}) {
  const close = () => {
    back.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => back.remove(), 150);
    onClose && onClose();
  };
  const onKey = e => { if (e.key === 'Escape' && closable) close(); };
  const box = h('div.modal' + (wide ? '.wide' : '') + (cls ? '.' + cls : ''), { role: 'dialog', 'aria-modal': 'true' },
    title ? h('div.modal-head', h('h3', title), closable ? btn('close', 'Fermer', () => close()) : null) : null,
    h('div.modal-body', content));
  const back = h('div.modal-back', { onmousedown: e => { if (e.target === back && closable) close(); } }, box);
  document.addEventListener('keydown', onKey);
  overlayRoot().appendChild(back);
  const focusable = box.querySelector('input,textarea');
  if (focusable) setTimeout(() => focusable.focus(), 50);
  return { close, box, back };
}

export function confirmDialog(message, { ok = 'Confirmer', danger = false, extra } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal(h('div.confirm',
      h('p', message),
      h('div.modal-actions',
        h('button.btn.ghost', { onclick: () => finish(false) }, 'Annuler'),
        extra ? h('button.btn.ghost', { onclick: () => finish(extra.value) }, extra.label) : null,
        h('button.btn' + (danger ? '.danger' : '.primary'), { onclick: () => finish(true) }, ok))),
      { onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}

export function promptDialog(title, { value = '', placeholder = '', multiline = false, ok = 'OK', maxlength } = {}) {
  return new Promise(resolve => {
    let done = false;
    const input = h(multiline ? 'textarea.input' : 'input.input', { value, placeholder, maxlength, rows: multiline ? 4 : undefined });
    const finish = v => { if (!done) { done = true; resolve(v); m.close(); } };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !multiline) finish(input.value); });
    const m = modal(h('div.prompt', input, h('div.modal-actions',
      h('button.btn.ghost', { onclick: () => finish(null) }, 'Annuler'),
      h('button.btn.primary', { onclick: () => finish(input.value) }, ok))),
    { title, onClose: () => { if (!done) { done = true; resolve(null); } } });
  });
}

/** Menu contextuel positionné près d'un élément ou d'un point. */
/** Menu contextuel. Éléments : { label, icon, action, danger, active, badge }, '-' (séparateur) ou
 *  { title } (intitulé de section). `side: 'right'` : ouvert à droite de l'ancre (barre latérale). */
export function menu(anchor, items, { x, y, side } = {}) {
  closeMenus();
  const list = h('div.menu', { role: 'menu' });
  for (const it of items.filter(Boolean)) {
    if (it === '-') { list.appendChild(h('div.menu-sep')); continue; }
    if (it.title) { list.appendChild(h('div.menu-title', it.title)); continue; }
    list.appendChild(h('button.menu-item' + (it.danger ? '.danger' : '') + (it.active ? '.active' : ''), {
      type: 'button', role: 'menuitem',
      onclick: e => { e.stopPropagation(); closeMenus(); it.action(); },
    }, it.icon ? icon(it.icon, 18) : null, h('span', it.label), it.badge ? h('span.menu-badge', it.badge > 99 ? '99+' : String(it.badge)) : null));
  }
  const layer = h('div.menu-layer', { onmousedown: e => { if (e.target === layer) closeMenus(); }, oncontextmenu: e => { e.preventDefault(); closeMenus(); } }, list);
  overlayRoot().appendChild(layer);
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, top: y, bottom: y };
  const mw = list.offsetWidth, mh = list.offsetHeight;
  let left = anchor ? r.right - mw : x;
  let top = r.bottom + 4;
  if (anchor && side === 'right') { left = r.right + 8; top = Math.min(r.top, window.innerHeight - mh - 8); }
  if (left < 8) left = Math.min(r.left, window.innerWidth - mw - 8);
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  list.style.left = Math.max(8, left) + 'px';
  list.style.top = top + 'px';
  return layer;
}

export function closeMenus() {
  document.querySelectorAll('.menu-layer').forEach(el => el.remove());
}

export function toast(message, { type = 'info', timeout = 3500, action } = {}) {
  const el = h('div.toast.' + type, h('span', message),
    action ? h('button.toast-action', { onclick: () => { action.run(); el.remove(); } }, action.label) : null);
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, timeout);
}

export function errorToast(e) {
  toast(e && e.message ? e.message : 'Une erreur est survenue', { type: 'error' });
}

/** Visionneuse plein écran pour une image ou une vidéo. */
export function lightbox(src, kind = 'image', { caption, onForward } = {}) {
  const media = kind === 'video'
    ? h('video', { src, controls: true, autoplay: true, playsinline: true })
    : h('img', { src, alt: '' });
  const close = () => { layer.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const layer = h('div.lightbox', { onclick: e => { if (e.target === layer || e.target.classList.contains('lightbox-stage')) close(); } },
    h('div.lightbox-bar',
      caption ? h('div.lightbox-caption', caption) : h('div'),
      h('div.row',
        onForward ? btn('forward', 'Transférer', () => { close(); onForward(); }) : null,
        h('a.icon-btn', { href: src, download: '', title: 'Télécharger' }, icon('download')),
        btn('close', 'Fermer', close))),
    h('div.lightbox-stage', media));
  document.addEventListener('keydown', onKey);
  overlayRoot().appendChild(layer);
}

// ------------------------------------------------------------------ fichiers & divers

export function pickFiles({ accept = '', multiple = false, capture } = {}) {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept, multiple, capture, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function autoGrow(textarea, max = 160) {
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(max, textarea.scrollHeight) + 'px';
  };
  textarea.addEventListener('input', resize);
  return resize;
}

export function spinner(size = 28) {
  return h('div.spinner', { style: { width: size + 'px', height: size + 'px' } });
}

export function empty(iconName, title, text, action) {
  return h('div.empty', icon(iconName, 56), h('h3', title), text ? h('p', text) : null, action || null);
}

/** Observe l'arrivée d'un élément sentinelle à l'écran (défilement infini). */
export function onVisible(el, fn, root = null) {
  const io = new IntersectionObserver(entries => entries.forEach(e => e.isIntersecting && fn()), { root, rootMargin: '400px' });
  io.observe(el);
  return () => io.disconnect();
}

// ------------------------------------------------------------------ sons (WebAudio, sans fichier)

let audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

export function beep(kind = 'message') {
  try {
    const c = ctx();
    const notes = kind === 'message' ? [[880, 0, 0.08], [1320, 0.09, 0.12]] : [[660, 0, 0.1]];
    for (const [f, start, len] of notes) {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, c.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + len);
      o.connect(g).connect(c.destination);
      o.start(c.currentTime + start); o.stop(c.currentTime + start + len + 0.02);
    }
  } catch (e) { /* audio indisponible */ }
}

export function ringtone() {
  let stopped = false;
  const ring = () => {
    if (stopped) return;
    try {
      const c = ctx();
      [[0, 523], [0.18, 659], [0.36, 784]].forEach(([t, f]) => {
        const o = c.createOscillator(), g = c.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, c.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.15, c.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t + 0.16);
        o.connect(g).connect(c.destination);
        o.start(c.currentTime + t); o.stop(c.currentTime + t + 0.2);
      });
    } catch (e) { /* audio indisponible */ }
  };
  ring();
  const timer = setInterval(ring, 2000);
  return () => { stopped = true; clearInterval(timer); };
}

// ------------------------------------------------------------------ emoji

// Catégories dans l'ordre de WhatsApp : [clé, titre, icône de la barre du bas, emojis].
export const EMOJI_CATEGORIES = [
  ['people', 'Smileys et personnes', 'smile',
    '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 🫠 😉 😊 😇 🥰 😍 🤩 😘 😗 ☺️ 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🫢 🫣 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊 ' +
    '👋 🤚 🖐️ ✋ 🖖 🫱 🫲 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦵 🦶 👂 👃 🧠 👀 👁️ 👅 👄 💋 ' +
    '👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 👮 🕵️ 💂 👷 🤴 👸 👳 👲 🧕 🤵 👰 🤰 🤱 👼 🎅 🤶 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 🧟 💆 💇 🚶 🧍 🧎 🏃 💃 🕺 👯 🧖 🧗 🤺 🏇 ⛷️ 🏂 🏌️ 🏄 🚣 🏊 ⛹️ 🏋️ 🚴 🤸 🤼 🤽 🤾 🤹 🧘 🛀 🛌 👭 👫 👬 💏 💑 👪 🗣️ 👤 👥 👣 ' +
    '👓 🕶️ 🥽 👔 👕 👖 🧣 🧤 🧥 🧦 👗 👘 🥻 👙 👚 👛 👜 👝 🎒 👞 👟 🥾 🥿 👠 👡 👢 👑 👒 🎩 🎓 🧢 💄 💍 💼'],
  ['nature', 'Animaux et nature', 'paw',
    '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🐔 🐧 🐦 🐤 🐣 🐥 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🐛 🦋 🐌 🐞 🐜 🪰 🪲 🦟 🦗 🕷️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🦧 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🦢 🦩 🕊️ 🐇 🦝 🦨 🦡 🦦 🦥 🐁 🐀 🐿️ 🦔 ' +
    '🌵 🎄 🌲 🌳 🌴 🪵 🌱 🌿 ☘️ 🍀 🎍 🪴 🎋 🍃 🍂 🍁 🍄 🐚 🪨 🌾 💐 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌛 🌜 🌚 🌕 🌖 🌗 🌘 🌑 🌒 🌓 🌔 🌙 🌎 🌍 🌏 🪐 💫 ⭐ 🌟 ✨ ⚡ ☄️ 💥 🔥 🌪️ 🌈 ☀️ 🌤️ ⛅ 🌥️ ☁️ 🌦️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ ☃️ ⛄ 🌬️ 💨 💧 💦 ☔ ☂️ 🌊 🌫️'],
  ['food', 'Nourriture et boissons', 'coffee',
    '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🫓 🥪 🥙 🧆 🌮 🌯 🫔 🥗 🥘 🫕 🥫 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 🫖 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊 🥄 🍴 🍽️ 🥣 🥡 🥢 🧂'],
  ['activity', 'Activités', 'ball',
    '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎗️ 🎫 🎟️ 🎪 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🪘 🎷 🎺 🪗 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩 🎉 🎊 🎈 🎁 🎀 🪅 🎆 🎇 🧨 🎃 🎄 🎋 🎍 🎎 🎏 🎐 🎑 🧧'],
  ['travel', 'Voyages et lieux', 'car',
    '🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🦯 🦽 🦼 🛴 🚲 🛵 🏍️ 🛺 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🪝 ⛽ 🚧 🚦 🚥 🚏 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🛖 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🕍 🛕 🕋 ⛩️ 🛤️ 🛣️ 🗾 🎑 🏞️ 🌅 🌄 🌠 🎇 🎆 🌇 🌆 🏙️ 🌃 🌌 🌉 🌁'],
  ['objects', 'Objets', 'bulb',
    '⌚ 📱 📲 💻 ⌨️ 🖥️ 🖨️ 🖱️ 🖲️ 🕹️ 🗜️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 🎞️ 📞 ☎️ 📟 📠 📺 📻 🎙️ 🎚️ 🎛️ 🧭 ⏱️ ⏲️ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 🪙 💰 💳 💎 ⚖️ 🪜 🧰 🪛 🔧 🔨 ⚒️ 🛠️ ⛏️ 🪚 🔩 ⚙️ 🪤 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🪦 ⚱️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🩸 🧬 🦠 🧫 🧪 🌡️ 🧹 🪠 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪥 🪒 🧽 🪣 🧴 🛎️ 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🛌 🧸 🪆 🖼️ 🪞 🪟 🛍️ 🛒 🎁 🎈 🎏 🎀 🪄 🪅 🎊 🎉 🎎 🏮 🎐 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 🪧 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓'],
  ['symbols', 'Symboles', 'symbols',
    '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🛗 🈳 🈂️ 🛂 🛃 🛄 🛅 🚹 🚺 🚼 ⚧️ 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗 🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 🔢 #️⃣ *️⃣ ⏏️ ▶️ ⏸️ ⏯️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ ⏫ ⏬ ◀️ 🔼 🔽 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ ↪️ ↩️ ⤴️ ⤵️ 🔀 🔁 🔂 🔄 🔃 🎵 🎶 ➕ ➖ ➗ ✖️ 🟰 ♾️ 💲 💱 ™️ ©️ ®️ 〰️ ➰ ➿ 🔚 🔙 🔛 🔝 🔜 ✔️ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪️ ▫️ ◾ ◽ ◼️ ◻️ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🟫 🔈 🔇 🔉 🔊 🔔 🔕 📣 📢 💬 💭 🗯️ ♠️ ♣️ ♥️ ♦️ 🃏 🎴 🀄 🕐 🕑 🕒 🕓 🕔 🕕 🕖 🕗 🕘 🕙 🕚 🕛'],
  ['flags', 'Drapeaux', 'flag',
    '🇨🇮 🏳️ 🏴 🏁 🚩 🏳️‍🌈 🇿🇦 🇩🇿 🇦🇴 🇧🇯 🇧🇼 🇧🇫 🇧🇮 🇨🇲 🇨🇻 🇨🇫 🇹🇩 🇰🇲 🇨🇬 🇨🇩 🇩🇯 🇪🇬 🇬🇶 🇪🇷 🇸🇿 🇪🇹 🇬🇦 🇬🇲 🇬🇭 🇬🇳 🇬🇼 🇰🇪 🇱🇸 🇱🇷 🇱🇾 🇲🇬 🇲🇼 🇲🇱 🇲🇷 🇲🇺 🇲🇦 🇲🇿 🇳🇦 🇳🇪 🇳🇬 🇷🇼 🇸🇹 🇸🇳 🇸🇨 🇸🇱 🇸🇴 🇸🇸 🇸🇩 🇹🇿 🇹🇬 🇹🇳 🇺🇬 🇿🇲 🇿🇼 🇫🇷 🇧🇪 🇨🇭 🇨🇦 🇺🇸 🇬🇧 🇩🇪 🇪🇸 🇮🇹 🇵🇹 🇳🇱 🇱🇺 🇮🇪 🇸🇪 🇳🇴 🇩🇰 🇫🇮 🇵🇱 🇷🇺 🇺🇦 🇹🇷 🇬🇷 🇧🇷 🇦🇷 🇲🇽 🇨🇴 🇭🇹 🇨🇺 🇯🇲 🇨🇳 🇯🇵 🇰🇷 🇮🇳 🇵🇰 🇸🇦 🇦🇪 🇶🇦 🇱🇧 🇮🇱 🇵🇸 🇦🇺 🇳🇿 🇪🇺 🇺🇳'],
];

// Mots-clés (sans accents) pour la recherche d'emoji.
const EMOJI_KEYWORDS = [
  ['rire rigole mdr lol drole content joie heureux sourire', '😂 🤣 😆 😄 😁 😀 😃 😅 😹 🙂 😊'],
  ['amour love coeur aime bisou bebe cheri', '❤️ 🥰 😍 😘 😚 💕 💖 💗 💘 💞 💓 💋 🫶 😻 🤍 💛 💚 💙 💜 🧡 🖤'],
  ['triste pleure larme chagrin', '😢 😭 🥲 😞 😔 😿 💔 🥺 😥 😓'],
  ['colere fache enerve rage', '😡 😠 🤬 😤 👿 💢'],
  ['peur choc surpris wow', '😱 😨 😰 😮 😲 😳 🙀 😯'],
  ['fatigue dodo sommeil dormir nuit', '😴 🥱 😪 💤 🛌 🌙 🌛'],
  ['malade fievre masque', '😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶'],
  ['ok bien top pouce bravo accord valide', '👍 👌 🙌 👏 ✅ ✔️ 💯 🆗 🤙'],
  ['non pas refuse', '👎 ❌ 🙅 🚫 ⛔ ✖️'],
  ['merci priere svp stp amen dieu', '🙏 🛐 ✝️ ☪️ 😇'],
  ['salut bonjour coucou au revoir main', '👋 🤚 ✋ 🖐️ 🙋'],
  ['fete anniversaire joyeux bravo felicitations', '🎉 🎊 🥳 🎂 🎁 🎈 🍾 🥂 🎆 🎇'],
  ['feu chaud hot fire', '🔥 🥵 🌶️ ☀️'],
  ['cool lunettes classe', '😎 🕶️ 🤓 🆒'],
  ['reflechir pense hmm', '🤔 🧐 🤨 💭'],
  ['secret chut silence', '🤫 🤐 🙊 😶'],
  ['argent money sous billet riche', '💰 💵 💸 🤑 💳 🪙 💶 💷 💴 🏦'],
  ['muscle force sport gym', '💪 🏋️ 🦾 🏃 ⚽ 🏀'],
  ['foot football ballon match', '⚽ 🥅 🏆 🏟️ 🇨🇮'],
  ['musique chanson chanter danse', '🎵 🎶 🎤 🎧 💃 🕺 🎸 🥁'],
  ['manger nourriture repas faim', '🍽️ 🍔 🍕 🍗 🍛 🍲 🍚 🥘 🍟 🍜'],
  ['boire boisson the cafe', '☕ 🍵 🥤 🧃 🍺 🍷 🥂 🍹 🧋'],
  ['fruit banane mangue ananas', '🍌 🥭 🍍 🍉 🍊 🍎 🍓 🥥 🍇'],
  ['soleil chaleur beau temps', '☀️ 🌞 🌤️ 😎 🏖️'],
  ['pluie orage nuage', '🌧️ ⛈️ ☔ ☁️ 🌩️ 💧'],
  ['fleur rose nature', '🌹 🌸 🌺 🌻 🌷 💐 🌼'],
  ['chien chat animal', '🐶 🐕 🐱 🐈 🐭 🐰'],
  ['voiture taxi bus voyage', '🚗 🚕 🚙 🚌 ✈️ 🚀 🏍️ 🛵'],
  ['maison domicile', '🏠 🏡 🏘️ 🛋️'],
  ['ecole etude livre cours examen', '🏫 📚 📖 🎓 ✏️ 📝'],
  ['travail bureau ordinateur', '💼 💻 🖥️ 📊 📈 🏢'],
  ['telephone appel', '📱 📞 ☎️ 📲'],
  ['photo camera', '📷 📸 🎥 📹'],
  ['etoile brillant magie', '⭐ 🌟 ✨ 💫 🪄'],
  ['diable demon', '😈 👿'],
  ['mort crane rip', '💀 ☠️ ⚰️ 🪦'],
  ['caca crotte', '💩'],
  ['clin oeil', '😉 😜'],
  ['langue', '😛 😜 😝 🤪 😋'],
  ['ange', '😇 👼'],
  ['bebe enfant', '👶 🍼 🧒'],
  ['cote ivoire ivoirien abidjan', '🇨🇮'],
  ['afrique drapeau', '🇨🇮 🇸🇳 🇨🇲 🇳🇬 🇬🇭 🇲🇱 🇧🇫 🇹🇬 🇧🇯 🇬🇳'],
  ['france francais', '🇫🇷'],
  ['regarder yeux voir', '👀 👁️ 🙈'],
  ['main applaudir', '👏 🙌 🤝 🙏'],
];

const RECENT_EMOJI_KEY = 'kozons.emoji.recent';
const noAccent = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function recentEmojis() {
  try { return JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY)) || []; } catch (e) { return []; }
}

function rememberEmoji(e) {
  try { localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify([e, ...recentEmojis().filter(x => x !== e)].slice(0, 32))); } catch (e2) { /* stockage indisponible */ }
}

function searchEmojis(q) {
  q = noAccent(q.trim());
  if (!q) return [];
  const found = [];
  for (const [words, list] of EMOJI_KEYWORDS) {
    if (words.split(' ').some(w => w.startsWith(q))) found.push(...list.split(' '));
  }
  if (q.length >= 3) {
    for (const [, label, , list] of EMOJI_CATEGORIES) if (noAccent(label).includes(q)) found.push(...list.split(' '));
  }
  return [...new Set(found)];
}

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/**
 * Sélecteur d'emoji façon WhatsApp : défilement continu par sections (Récents, Smileys et personnes…),
 * barre des catégories en bas qui suit le défilement, recherche par mot-clé (« rire », « merci »…).
 * `searchOpen: false` : champ de recherche masqué, ouvert par `picker.toggleSearch()` (panneau du chat).
 */
export function emojiPicker(onPick, { searchOpen = true } = {}) {
  const pick = e => { rememberEmoji(e); onPick(e); };
  const emojiBtn = e => h('button.emoji', { type: 'button', onclick: () => pick(e) }, e);
  const scroll = h('div.emoji-scroll');
  const cats = h('div.emoji-cats');
  const sections = [];
  const recentGrid = h('div.emoji-grid');
  const recentSec = h('section.emoji-section', { dataset: { cat: 'recent' } }, h('div.emoji-sec-title', 'Récents'), recentGrid);
  const refreshRecent = () => {
    const list = recentEmojis();
    clear(recentGrid, list.map(emojiBtn));
    recentSec.classList.toggle('hidden', !list.length);
  };
  sections.push(recentSec);
  for (const [key, label, , list] of EMOJI_CATEGORIES) {
    sections.push(h('section.emoji-section', { dataset: { cat: key } }, h('div.emoji-sec-title', label), h('div.emoji-grid', list.split(' ').map(emojiBtn))));
  }
  const results = h('div.emoji-grid');
  const resultsSec = h('section.emoji-section.hidden', h('div.emoji-sec-title', 'Résultats'), results);
  scroll.append(resultsSec, ...sections);

  const setActive = key => cats.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.cat === key));
  const goTo = key => {
    if (input.value) { input.value = ''; runSearch(); }
    const sec = sections.find(s => s.dataset.cat === key);
    scroll.scrollTop = sec.offsetTop - 2;
    setActive(key);
  };
  [['recent', 'Récents', 'clock'], ...EMOJI_CATEGORIES].forEach(([key, label, ic]) =>
    cats.appendChild(h('button', { type: 'button', title: label, 'aria-label': label, dataset: { cat: key }, onclick: () => goTo(key) }, icon(ic, 22))));
  // La catégorie active suit le défilement.
  scroll.addEventListener('scroll', () => {
    if (input.value) return;
    const y = scroll.scrollTop + 12;
    let current = sections.find(s => !s.classList.contains('hidden'));
    for (const s of sections) if (!s.classList.contains('hidden') && s.offsetTop <= y) current = s;
    if (current) setActive(current.dataset.cat);
  }, { passive: true });

  // Recherche.
  const input = h('input.emoji-search-input', { type: 'search', placeholder: 'Rechercher un emoji', 'aria-label': 'Rechercher un emoji', enterkeyhint: 'search' });
  const searchBar = h('div.emoji-search' + (searchOpen ? '' : '.hidden'), icon('search', 18), input);
  const runSearch = () => {
    const q = input.value.trim();
    const found = searchEmojis(q);
    resultsSec.classList.toggle('hidden', !q);
    sections.forEach(s => s.classList.toggle('search-hidden', !!q));
    resultsSec.firstChild.textContent = found.length ? 'Résultats' : 'Aucun emoji trouvé';
    clear(results, found.map(emojiBtn));
    root.classList.toggle('searching', !!q);
    scroll.scrollTop = 0;
  };
  input.addEventListener('input', runSearch);

  const root = h('div.emoji-picker', searchBar, scroll, cats);
  root.refreshRecent = () => { refreshRecent(); if (!input.value) setActive(recentSec.classList.contains('hidden') ? 'people' : 'recent'); };
  root.toggleSearch = (open = searchBar.classList.contains('hidden')) => {
    searchBar.classList.toggle('hidden', !open);
    if (open) input.focus();
    else if (input.value) { input.value = ''; runSearch(); }
    return open;
  };
  root.refreshRecent();
  return root;
}

/** Sélecteur d'emoji en surimpression, placé au-dessus ou en dessous du bouton selon la place
 *  disponible et toujours entièrement visible (y compris sur mobile). Reste ouvert pour en
 *  choisir plusieurs ; se ferme au clic à l'extérieur ou avec Échap. */
export function emojiPopover(anchor, onPick) {
  closeMenus();
  const pop = h('div.menu.emoji-pop', emojiPicker(onPick));
  const onKey = e => { if (e.key === 'Escape') { closeMenus(); document.removeEventListener('keydown', onKey); } };
  const layer = h('div.menu-layer', { onmousedown: e => { if (e.target === layer) { closeMenus(); document.removeEventListener('keydown', onKey); } } }, pop);
  document.addEventListener('keydown', onKey);
  overlayRoot().appendChild(layer);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, ph = pop.offsetHeight, gap = 8;
  let top = r.top - ph - gap;                      // au-dessus de préférence (champ en bas d'écran)
  if (top < gap) top = r.bottom + gap;             // sinon en dessous
  top = Math.max(gap, Math.min(top, window.innerHeight - ph - gap));
  const left = Math.max(gap, Math.min(r.left, window.innerWidth - w - gap));
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
  return layer;
}

// ------------------------------------------------------------------ appui long (sélection, comme WhatsApp)

/** Appui long au doigt (~0,5 s) : appelle fn. Le clic qui suit est ignoré, et le menu natif
    du navigateur (Android, iOS) est remplacé. Sur ordinateur, rien ne change (clic droit libre). */
export function onLongPress(el, fn, ms = 480) {
  let timer = null, sx = 0, sy = 0, firedAt = 0;
  const fire = e => { firedAt = Date.now(); if (navigator.vibrate) navigator.vibrate(15); fn(e); };
  el.addEventListener('touchstart', e => {
    const p = e.touches[0];
    sx = p.clientX; sy = p.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => fire(e), ms);
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    const p = e.touches[0];
    if (Math.abs(p.clientX - sx) + Math.abs(p.clientY - sy) > 10) clearTimeout(timer);
  }, { passive: true });
  ['touchend', 'touchcancel'].forEach(ev => el.addEventListener(ev, () => clearTimeout(timer)));
  // Android déclenche aussi « contextmenu » sur un appui long : même action, sans doublon.
  el.addEventListener('contextmenu', e => {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    clearTimeout(timer);
    if (Date.now() - firedAt > 800) fire(e);
  }, true);
  el.addEventListener('click', e => {
    if (Date.now() - firedAt < 800) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

/**
 * Panneau latéral redimensionnable à la souris (comme WhatsApp Desktop) : une poignée sur le bord droit.
 * La largeur est mémorisée par `key` ; double-clic sur la poignée = largeur par défaut. Ordinateur uniquement.
 */
export function resizablePanel(panel, key, { min = 260, max = 720 } = {}) {
  const storeKey = 'kozons.width.' + key;
  const clamp = w => Math.round(Math.max(min, Math.min(w, max, window.innerWidth * 0.6)));
  const apply = w => panel.style.setProperty('--side-w', w + 'px');
  // Au chargement, pas de limite liée à la fenêtre (le CSS plafonne à 60vw) : la largeur choisie revient
  // telle quelle quand la fenêtre est à nouveau assez grande.
  try { const saved = +localStorage.getItem(storeKey); if (saved) apply(Math.max(min, Math.min(saved, max))); } catch (e) { /* stockage indisponible */ }
  const save = w => { try { localStorage.setItem(storeKey, String(w)); } catch (e) { /* stockage indisponible */ } };
  const handle = h('div.resize-handle', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Ajuster la largeur', title: 'Glisser pour ajuster la largeur (double-clic : par défaut)', tabindex: 0 });
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = panel.getBoundingClientRect().width;
    let w = startW;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('col-resizing');
    const move = ev => { w = clamp(startW + ev.clientX - startX); apply(w); };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('col-resizing');
      save(w);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => { panel.style.removeProperty('--side-w'); try { localStorage.removeItem(storeKey); } catch (e) { /* stockage indisponible */ } });
  handle.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const w = clamp(panel.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 20 : -20));
    apply(w); save(w);
  });
  panel.appendChild(handle);
  return handle;
}
