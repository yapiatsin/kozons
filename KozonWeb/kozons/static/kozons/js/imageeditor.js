// Retouche d'une photo avant publication (comme WhatsApp) : recadrer (libre ou format), pivoter, filtres.
// editImage(file) -> Promise<File | null> : la photo retouchée (JPEG), ou null si l'utilisateur annule.
import { h, clear, icon, btn } from './ui.js';

const MAX_SIDE = 2160;         // côté maximal de la photo exportée
const MIN_CROP = 0.08;         // taille minimale du cadre (part de l'image)

// Filtres = matrices de couleur 3×4 (r, g, b, décalage) : même rendu à l'écran et à l'export.
const I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
const mul = (a, b) => a.map(row => [0, 1, 2, 3].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j] + (j === 3 ? row[3] : 0)));
const saturate = s => [
  [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0],
  [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0],
  [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0]];
const gains = (r, g, b) => [[r, 0, 0, 0], [0, g, 0, 0], [0, 0, b, 0]];
const contrast = (c, bright = 1) => [[c * bright, 0, 0, 128 * (1 - c)], [0, c * bright, 0, 128 * (1 - c)], [0, 0, c * bright, 128 * (1 - c)]];
const SEPIA = [[0.393, 0.769, 0.189, 0], [0.349, 0.686, 0.168, 0], [0.272, 0.534, 0.131, 0]];
const GRAY = [[0.2126, 0.7152, 0.0722, 0], [0.2126, 0.7152, 0.0722, 0], [0.2126, 0.7152, 0.0722, 0]];
const FILTERS = [
  ['Original', I],
  ['Lumineux', contrast(1.06, 1.12)],
  ['Vif', mul(contrast(1.08), saturate(1.45))],
  ['Chaud', mul(gains(1.08, 1.0, 0.86), saturate(1.1))],
  ['Froid', mul(gains(0.9, 1.0, 1.1), saturate(0.95))],
  ['N&B', mul(contrast(1.12), GRAY)],
  ['Sépia', SEPIA],
  ['Rétro', mul(contrast(0.9, 1.05), mul(saturate(0.6), gains(1.06, 1.0, 0.88)))],
];
const RATIOS = [['Libre', null], ['Original', 'orig'], ['9:16', 9 / 16], ['1:1', 1], ['4:5', 4 / 5], ['16:9', 16 / 9]];

function applyMatrix(ctx, w, h, m) {
  if (m === I) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [r0, g0, b0] = m;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = r0[0] * r + r0[1] * g + r0[2] * b + r0[3];
    d[i + 1] = g0[0] * r + g0[1] * g + g0[2] * b + g0[3];
    d[i + 2] = b0[0] * r + b0[1] * g + b0[2] * b + b0[3];
  }
  ctx.putImageData(img, 0, 0);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible')); };
    img.src = url;
  });
}

/** Image pivotée de `rot` quarts de tour, réduite à `maxSide` (canvas). */
function rotated(img, rot, maxSide) {
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * scale), hh = Math.round(h0 * scale);
  const swap = rot % 2 === 1;
  const c = document.createElement('canvas');
  c.width = swap ? hh : w;
  c.height = swap ? w : hh;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rot * Math.PI / 2);
  ctx.drawImage(img, -w / 2, -hh / 2, w, hh);
  return c;
}

export async function editImage(file) {
  let loaded;
  try { loaded = await loadImage(file); } catch (e) { return null; }
  const { img, url } = loaded;
  let rot = 0, filter = 0, ratio = null;
  let crop = { x: 0, y: 0, w: 1, h: 1 };       // cadre en proportions de l'image pivotée
  let preview = null;                          // canvas d'aperçu (image pivotée, réduite)

  const canvas = h('canvas.ie-canvas');
  const box = h('div.ie-crop', ['nw', 'ne', 'sw', 'se'].map(c => h('span.ie-handle.' + c, { dataset: { c } })),
    h('span.ie-grid'));
  const area = h('div.ie-area', h('div.ie-stage', canvas, box));
  const ratioBar = h('div.ie-chips');
  const filterBar = h('div.ie-filters');

  return new Promise(resolve => {
    const finish = result => {
      window.removeEventListener('resize', layout);
      document.removeEventListener('keydown', onKey);
      layer.remove();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const onKey = e => { if (e.key === 'Escape') finish(null); };

    // --- aperçu
    const imgRatio = () => preview.width / preview.height;
    function render() {
      preview = rotated(img, rot, 1100);
      const ctx = canvas.getContext('2d');
      canvas.width = preview.width;
      canvas.height = preview.height;
      ctx.drawImage(preview, 0, 0);
      applyMatrix(ctx, canvas.width, canvas.height, FILTERS[filter][1]);
      layout();
      paintFilters();
    }
    function layout() {
      const aw = area.clientWidth - 24, ah = area.clientHeight - 24;
      if (!preview || aw <= 0 || ah <= 0) return;
      const s = Math.min(aw / preview.width, ah / preview.height);
      canvas.style.width = Math.round(preview.width * s) + 'px';
      canvas.style.height = Math.round(preview.height * s) + 'px';
      paintCrop();
    }
    function paintCrop() {
      Object.assign(box.style, { left: crop.x * 100 + '%', top: crop.y * 100 + '%', width: crop.w * 100 + '%', height: crop.h * 100 + '%' });
    }
    // Cadre le plus grand possible au format r (largeur / hauteur), centré.
    function fitRatio(r) {
      const ir = imgRatio();
      if (!r) return { x: 0, y: 0, w: 1, h: 1 };
      let w = 1, hh = ir / r;
      if (hh > 1) { hh = 1; w = r / ir; }
      return { x: (1 - w) / 2, y: (1 - hh) / 2, w, h: hh };
    }
    const ratioValue = () => (ratio === 'orig' ? imgRatio() : ratio);

    // --- déplacer / redimensionner le cadre (souris et doigt)
    box.addEventListener('pointerdown', e => {
      e.preventDefault();
      const corner = e.target.dataset && e.target.dataset.c;
      const rect = canvas.getBoundingClientRect();
      const start = { ...crop }, sx = e.clientX, sy = e.clientY;
      box.setPointerCapture(e.pointerId);
      const move = ev => {
        const dx = (ev.clientX - sx) / rect.width, dy = (ev.clientY - sy) / rect.height;
        let { x, y, w, h: hh } = start;
        if (!corner) {
          x = Math.min(Math.max(0, x + dx), 1 - w);
          y = Math.min(Math.max(0, y + dy), 1 - hh);
        } else {
          const left = corner.includes('w'), top = corner.includes('n');
          let nw = Math.max(MIN_CROP, w + (left ? -dx : dx));
          let nh = Math.max(MIN_CROP, hh + (top ? -dy : dy));
          const r = ratioValue();
          if (r) {
            // Format imposé : la hauteur suit la largeur (en pixels réels).
            nh = nw * imgRatio() / r;
            if (nh < MIN_CROP) { nh = MIN_CROP; nw = nh * r / imgRatio(); }
          }
          // Reste dans l'image.
          const maxW = left ? x + w : 1 - x, maxH = top ? y + hh : 1 - y;
          if (nw > maxW) { nw = maxW; if (r) nh = nw * imgRatio() / r; }
          if (nh > maxH) { nh = maxH; if (r) nw = nh * r / imgRatio(); }
          if (left) x = x + w - nw;
          if (top) y = y + hh - nh;
          w = nw; hh = nh;
        }
        crop = { x, y, w, h: hh };
        paintCrop();
      };
      const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); box.removeEventListener('pointercancel', up); };
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
      box.addEventListener('pointercancel', up);
    });

    // --- outils
    function paintRatios() {
      clear(ratioBar, RATIOS.map(([label, r]) => h('button.ie-chip' + (r === ratio ? '.active' : ''), {
        type: 'button', onclick: () => { ratio = r; crop = fitRatio(ratioValue()); paintCrop(); paintRatios(); },
      }, label)));
    }
    function paintFilters() {
      // Vignettes : la photo en petit avec chaque filtre.
      const thumb = rotated(img, rot, 120);
      clear(filterBar, FILTERS.map(([name, m], i) => {
        const c = document.createElement('canvas');
        c.width = thumb.width; c.height = thumb.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(thumb, 0, 0);
        applyMatrix(ctx, c.width, c.height, m);
        return h('button.ie-filter' + (i === filter ? '.active' : ''), { type: 'button', onclick: () => { filter = i; render(); } },
          h('span.ie-thumb', c), h('small', name));
      }));
    }
    const rotate = () => {
      // Le cadre tourne avec l'image (quart de tour vers la gauche).
      crop = { x: crop.y, y: 1 - crop.x - crop.w, w: crop.h, h: crop.w };
      rot = (rot + 3) % 4;
      if (ratio === 'orig') ratio = null;
      render();
      if (ratio) { crop = fitRatio(ratioValue()); paintCrop(); }
      paintRatios();
    };
    const reset = () => { rot = 0; filter = 0; ratio = null; crop = { x: 0, y: 0, w: 1, h: 1 }; render(); paintRatios(); };

    // --- export : recadrage + rotation + filtre, en pleine définition (côté max 2160 px)
    async function done() {
      doneBtn.disabled = true;
      const full = rotated(img, rot, Math.max(img.naturalWidth, img.naturalHeight));
      const sx = Math.round(crop.x * full.width), sy = Math.round(crop.y * full.height);
      const sw = Math.max(1, Math.round(crop.w * full.width));
      let sh = Math.max(1, Math.round(crop.h * full.height));
      const r = ratioValue();
      if (r) sh = Math.max(1, Math.min(full.height - sy, Math.round(sw / r)));  // format exact (pas de pixel en trop)
      const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
      const out = document.createElement('canvas');
      out.width = Math.round(sw * scale);
      out.height = Math.round(sh * scale);
      const ctx = out.getContext('2d');
      ctx.drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);
      applyMatrix(ctx, out.width, out.height, FILTERS[filter][1]);
      out.toBlob(blob => {
        if (!blob) return finish(null);
        const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
        finish(new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }));
      }, 'image/jpeg', 0.9);
    }

    const doneBtn = h('button.btn.primary.small', { type: 'button', onclick: done }, icon('check', 18), ' Terminé');
    const layer = h('div.ie-layer', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ajuster la photo' },
      h('header.ie-top', btn('close', 'Annuler', () => finish(null)), h('strong', 'Ajuster la photo'), doneBtn),
      area,
      h('div.ie-tools',
        h('div.ie-row', btn('rotate', 'Pivoter', rotate, 'ie-rotate'), ratioBar,
          h('button.ie-reset', { type: 'button', onclick: reset }, 'Réinitialiser')),
        filterBar));
    document.getElementById('overlay-root').appendChild(layer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', layout);
    render();
    paintRatios();
  });
}
