// Stickers : panneau (récents, favoris, mes stickers), création avec éditeur, actions sur un sticker reçu.
import { api } from '../api.js';
import { bus } from '../store.js';
import { h, clear, icon, menu, modal, toast, errorToast, pickFiles, spinner } from '../ui.js';

// ------------------------------------------------------------------ collection (cache partagé)

let collection = null;
let loading = null;

export function loadStickers(force = false) {
  if (collection && !force) return Promise.resolve(collection);
  if (!loading) {
    loading = api.get('stickers')
      .then(data => { collection = data; bus.emit('stickers:changed'); return data; })
      .finally(() => { loading = null; });
  }
  return loading;
}

export function stickerState(id) {
  const all = collection ? [...collection.favorites, ...collection.mine, ...collection.recent] : [];
  const s = all.find(x => x.id === id);
  return { favorite: !!(s && s.favorite), saved: !!(s && s.saved) };
}

async function act(sticker, action) {
  try {
    const res = await api.post(`stickers/${sticker.id}`, { action });
    await loadStickers(true);
    return res;
  } catch (e) { errorToast(e); return null; }
}

function stickerMenu(sticker, anchor, ev) {
  const st = stickerState(sticker.id);
  menu(anchor, [
    { label: st.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: 'star', action: () => act(sticker, st.favorite ? 'unfavorite' : 'favorite').then(r => r && toast(r.favorite ? 'Ajouté aux favoris' : 'Retiré des favoris')) },
    st.saved
      ? { label: 'Retirer de mes stickers', icon: 'trash', action: () => act(sticker, 'remove') }
      : { label: 'Ajouter à mes stickers', icon: 'plus', action: () => act(sticker, 'save').then(r => r && toast('Ajouté à mes stickers')) },
    { label: 'Retirer des récents', icon: 'clock', action: () => act(sticker, 'forget') },
  ], ev ? { x: ev.clientX, y: ev.clientY } : {});
}

// ------------------------------------------------------------------ panneau

const TABS = [
  ['recent', 'clock', 'Récents', 'Les stickers que vous envoyez apparaîtront ici.'],
  ['favorites', 'star', 'Favoris', 'Ajoutez des stickers à vos favoris : clic droit ou appui long sur un sticker.'],
  ['mine', 'sticker', 'Mes stickers', 'Créez vos propres stickers à partir de vos photos.'],
];

/** Panneau de sélection. `onSend(sticker)` est appelé au clic sur un sticker. */
export function stickerPanel({ onSend }) {
  let tab = 'recent';
  const grid = h('div.sticker-grid');
  const tabsEl = h('div.sticker-tabs',
    TABS.map(([key, ic, label]) => h('button', { type: 'button', title: label, 'aria-label': label, dataset: { tab: key }, onclick: () => show(key) }, icon(ic, 22))),
    h('button', { type: 'button', title: 'Créer un sticker', 'aria-label': 'Créer un sticker', onclick: () => createStickerDialog({ onSend }) }, icon('plus', 22)));

  const tile = sticker => {
    const el = h('button.sticker-tile', {
      type: 'button', title: 'Envoyer',
      onclick: () => onSend(sticker),
      oncontextmenu: e => { e.preventDefault(); stickerMenu(sticker, null, e); },
    }, h('img', { src: sticker.url, alt: 'Sticker', loading: 'lazy', draggable: 'false' }),
    sticker.favorite ? h('span.sticker-fav', icon('star', 12)) : null);
    // Appui long (mobile) = menu, comme WhatsApp.
    let timer;
    el.addEventListener('touchstart', e => { timer = setTimeout(() => { timer = null; stickerMenu(sticker, el); }, 500); }, { passive: true });
    el.addEventListener('touchend', e => { if (timer) clearTimeout(timer); else e.preventDefault(); });
    return el;
  };

  function show(key) {
    tab = key;
    tabsEl.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === key));
    if (!collection) { clear(grid, spinner()); return; }
    const items = collection[key] || [];
    const [, ic, label, hint] = TABS.find(t => t[0] === key);
    const createTile = h('button.sticker-tile.create', { type: 'button', onclick: () => createStickerDialog({ onSend }) }, icon('plus', 26), h('span', 'Créer'));
    clear(grid,
      key !== 'favorites' ? createTile : null,
      items.map(tile),
      !items.length ? h('div.sticker-empty', icon(ic, 32), h('strong', label), h('span', hint)) : null);
  }

  const off = bus.on('stickers:changed', () => show(tab));
  loadStickers().then(data => {
    // Premier affichage : les récents s'il y en a, sinon les favoris, sinon mes stickers.
    show(data.recent.length ? 'recent' : data.favorites.length ? 'favorites' : 'mine');
  }).catch(e => clear(grid, h('div.sticker-empty', e.message)));
  show(tab);

  const el = h('div.sticker-panel', tabsEl, grid);
  el.cleanup = off;
  return el;
}

// ------------------------------------------------------------------ sticker reçu dans une discussion

export async function stickerActionsDialog(msg) {
  await loadStickers().catch(() => {});
  const st = msg.sticker_id ? stickerState(msg.sticker_id) : { favorite: false, saved: false };
  const run = async action => {
    try {
      const r = await api.post(`messages/${msg.id}/sticker`, { action });
      await loadStickers(true);
      m.close();
      toast({ favorite: 'Ajouté aux favoris', unfavorite: 'Retiré des favoris', save: 'Ajouté à mes stickers', remove: 'Retiré de mes stickers' }[action] || 'OK');
      return r;
    } catch (e) { errorToast(e); }
  };
  const m = modal(h('div.sticker-preview',
    h('img', { src: msg.file, alt: 'Sticker' }),
    h('div.sticker-preview-actions',
      h('button.btn.primary', { type: 'button', onclick: () => run(st.favorite ? 'unfavorite' : 'favorite') }, icon('star', 18), st.favorite ? ' Retirer des favoris' : ' Ajouter aux favoris'),
      h('button.btn.ghost', { type: 'button', onclick: () => run(st.saved ? 'remove' : 'save') }, st.saved ? 'Retirer de mes stickers' : 'Ajouter à mes stickers'))),
  { title: 'Sticker' });
}

// ------------------------------------------------------------------ création

const SIZE = 512;
const TEXT_COLORS = ['#ffffff', '#111111', '#ffd400', '#ff3b30', '#0099cc', '#34c759'];

export async function createStickerDialog({ onSend } = {}) {
  const [file] = await pickFiles({ accept: 'image/png,image/jpeg,image/webp,image/gif' });
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return toast('Image trop lourde (10 Mo max).', { type: 'error' });
  // Les GIF animés sont convertis par le serveur (animation conservée), sans retouche.
  if (file.type === 'image/gif') return confirmUpload(file, URL.createObjectURL(file), true, onSend);

  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = url; });
  } catch (e) { return toast("Impossible de lire cette image.", { type: 'error' }); }

  const st = { zoom: 1, x: 0, y: 0, shape: 'original', outline: true, text: '', color: '#ffffff', textPos: 'bottom' };
  const canvas = h('canvas.sticker-canvas', { width: SIZE, height: SIZE });
  const ctx = canvas.getContext('2d');
  const base = Math.min(SIZE / img.width, SIZE / img.height); // l'image entière tient dans le carré

  function drawImage(target) {
    const c = target.getContext('2d');
    const w = img.width * base * st.zoom, hgt = img.height * base * st.zoom;
    c.save();
    if (st.shape !== 'original') {
      c.beginPath();
      if (st.shape === 'circle') c.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 24, 0, Math.PI * 2);
      else c.roundRect(24, 24, SIZE - 48, SIZE - 48, 72);
      c.clip();
    }
    c.drawImage(img, (SIZE - w) / 2 + st.x, (SIZE - hgt) / 2 + st.y, w, hgt);
    c.restore();
  }

  function render() {
    ctx.clearRect(0, 0, SIZE, SIZE);
    const layer = document.createElement('canvas');
    layer.width = layer.height = SIZE;
    drawImage(layer);
    if (st.outline) {
      // Contour blanc façon WhatsApp : silhouette blanche décalée tout autour de l'image.
      const sil = document.createElement('canvas');
      sil.width = sil.height = SIZE;
      const s = sil.getContext('2d');
      s.drawImage(layer, 0, 0);
      s.globalCompositeOperation = 'source-in';
      s.fillStyle = '#fff';
      s.fillRect(0, 0, SIZE, SIZE);
      const r = 10;
      for (let a = 0; a < 360; a += 20) {
        ctx.drawImage(sil, Math.cos(a * Math.PI / 180) * r, Math.sin(a * Math.PI / 180) * r);
      }
    }
    ctx.drawImage(layer, 0, 0);
    if (st.text.trim()) {
      let size = 64;
      ctx.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
      while (ctx.measureText(st.text).width > SIZE - 40 && size > 20) {
        size -= 2;
        ctx.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = st.textPos === 'top' ? 'top' : 'bottom';
      const y = st.textPos === 'top' ? 24 : SIZE - 24;
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(6, size / 6);
      ctx.strokeStyle = st.color === '#111111' ? '#ffffff' : '#111111';
      ctx.strokeText(st.text, SIZE / 2, y);
      ctx.fillStyle = st.color;
      ctx.fillText(st.text, SIZE / 2, y);
    }
  }

  // Déplacement à la souris / au doigt, zoom à la molette.
  let drag = null;
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, sx: st.x, sy: st.y }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const scale = SIZE / canvas.getBoundingClientRect().width;
    st.x = drag.sx + (e.clientX - drag.x) * scale;
    st.y = drag.sy + (e.clientY - drag.y) * scale;
    render();
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    st.zoom = Math.min(4, Math.max(0.3, st.zoom * (e.deltaY < 0 ? 1.08 : 0.92)));
    zoom.value = st.zoom;
    render();
  }, { passive: false });

  const zoom = h('input.sticker-zoom', { type: 'range', min: 0.3, max: 4, step: 0.01, value: 1, 'aria-label': 'Zoom' });
  zoom.addEventListener('input', () => { st.zoom = +zoom.value; render(); });

  const choice = (items, key) => {
    const wrap = h('div.seg');
    items.forEach(([value, label]) => wrap.appendChild(h('button' + (st[key] === value ? '.active' : ''), {
      type: 'button',
      onclick: e => { st[key] = value; wrap.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); render(); },
    }, label)));
    return wrap;
  };

  const text = h('input.input', { placeholder: 'Ajouter un texte (facultatif)', maxlength: 40 });
  text.addEventListener('input', () => { st.text = text.value; render(); });
  const colors = h('div.color-dots', TEXT_COLORS.map(c => h('button' + (c === st.color ? '.active' : ''), {
    type: 'button', style: { background: c }, 'aria-label': 'Couleur ' + c,
    onclick: e => { st.color = c; colors.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); render(); },
  })));
  const outline = h('input', { type: 'checkbox', checked: true });
  outline.addEventListener('change', () => { st.outline = outline.checked; render(); });

  const exportBlob = () => new Promise(resolve => canvas.toBlob(b => {
    if (b && b.type === 'image/webp') resolve(b);
    else canvas.toBlob(resolve, 'image/png'); // navigateurs sans encodeur WebP
  }, 'image/webp', 0.92));

  const saveBtn = h('button.btn.ghost', { type: 'button' }, 'Enregistrer');
  const sendBtn = onSend ? h('button.btn.primary', { type: 'button' }, 'Enregistrer et envoyer') : null;
  const submit = async send => {
    [saveBtn, sendBtn].forEach(b => b && (b.disabled = true));
    try {
      const blob = await exportBlob();
      const sticker = await upload(new File([blob], 'sticker.' + (blob.type === 'image/webp' ? 'webp' : 'png'), { type: blob.type }));
      m.close();
      URL.revokeObjectURL(url);
      toast('Sticker créé');
      if (send && onSend) onSend(sticker);
    } catch (e) {
      errorToast(e);
      [saveBtn, sendBtn].forEach(b => b && (b.disabled = false));
    }
  };
  saveBtn.onclick = () => submit(false);
  if (sendBtn) sendBtn.onclick = () => submit(true);

  const m = modal(h('div.sticker-editor',
    h('div.sticker-stage', canvas),
    h('div.sticker-tools',
      h('label.label', 'Zoom (ou molette, glisser pour déplacer)'), zoom,
      h('label.label', 'Forme'), choice([['original', 'Original'], ['rounded', 'Arrondi'], ['circle', 'Cercle']], 'shape'),
      h('label.switch-row', outline, h('span', 'Contour blanc')),
      h('label.label', 'Texte'), text,
      h('div.row.space.wrap', colors, choice([['top', 'Haut'], ['bottom', 'Bas']], 'textPos')),
      h('div.modal-actions', saveBtn, sendBtn))),
  { title: 'Créer un sticker', wide: true, onClose: () => URL.revokeObjectURL(url) });
  render();
}

async function upload(file) {
  const fd = new FormData();
  fd.append('file', file);
  const sticker = await api.post('stickers', fd);
  await loadStickers(true);
  return sticker;
}

function confirmUpload(file, url, animated, onSend) {
  const saveBtn = h('button.btn.ghost', { type: 'button' }, 'Enregistrer');
  const sendBtn = onSend ? h('button.btn.primary', { type: 'button' }, 'Enregistrer et envoyer') : null;
  const submit = async send => {
    [saveBtn, sendBtn].forEach(b => b && (b.disabled = true));
    try {
      const sticker = await upload(file);
      m.close();
      toast('Sticker animé créé');
      if (send && onSend) onSend(sticker);
    } catch (e) { errorToast(e); [saveBtn, sendBtn].forEach(b => b && (b.disabled = false)); }
  };
  saveBtn.onclick = () => submit(false);
  if (sendBtn) sendBtn.onclick = () => submit(true);
  const m = modal(h('div.sticker-preview',
    h('img', { src: url, alt: '' }),
    animated ? h('p.muted.small', "L'animation sera conservée (512 × 512, 1 Mo max après conversion).") : null,
    h('div.modal-actions', saveBtn, sendBtn)), { title: 'Créer un sticker', onClose: () => URL.revokeObjectURL(url) });
}

