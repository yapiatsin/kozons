// Thèmes (fonds d'écran) des discussions : par défaut l'image de la page de connexion.
// Choix enregistrés sur l'appareil : un thème général + un thème propre à chaque discussion (facultatif).
import { bus, prefs } from './store.js';
import { h, clear, icon, modal, toast, pickFiles } from './ui.js';

const SPACE = '/static/kozons/auth-bg.jpg';

export const THEMES = [
  { key: 'kozons', label: 'Espace Kozons', image: SPACE },
  { key: 'doodle', label: 'Motif Kozons', pattern: true },
  { key: 'plain', label: 'Uni' },
  { key: 'ocean', label: 'Océan', gradient: 'linear-gradient(160deg, #0b3d5c 0%, #0a1e2e 100%)' },
  { key: 'night', label: 'Nuit', gradient: 'linear-gradient(160deg, #1e1b4b 0%, #0f172a 100%)' },
  { key: 'forest', label: 'Forêt', gradient: 'linear-gradient(160deg, #14532d 0%, #0b2018 100%)' },
  { key: 'sunset', label: 'Coucher de soleil', gradient: 'linear-gradient(160deg, #7c2d5a 0%, #b4533a 55%, #3b1d2e 100%)' },
  { key: 'rose', label: 'Rose', gradient: 'linear-gradient(160deg, #f9d5e5 0%, #eeb5c9 100%)', light: true },
  { key: 'sky', label: 'Ciel', gradient: 'linear-gradient(160deg, #e0f2fe 0%, #bfdbfe 100%)', light: true },
  { key: 'sand', label: 'Sable', gradient: 'linear-gradient(160deg, #f5ecdd 0%, #e7d6bb 100%)', light: true },
];
const DEFAULT = { theme: 'kozons', dim: 0.35 };

const scopeKey = convId => (convId ? `chatTheme.conv.${convId}` : 'chatTheme');
const imageKey = convId => (convId ? `chatTheme.img.${convId}` : 'chatTheme.img');

/** Réglage effectif : celui de la discussion s'il existe, sinon le thème général. */
export function themeFor(convId) {
  const own = convId ? prefs.get(scopeKey(convId), null) : null;
  const general = prefs.get(scopeKey(null), DEFAULT);
  const t = own || general || DEFAULT;
  return { theme: t.theme || 'kozons', dim: typeof t.dim === 'number' ? t.dim : DEFAULT.dim, own: !!own, scope: own ? convId : null };
}

function customImage(scope) {
  try { return localStorage.getItem('kozons.' + imageKey(scope)); } catch (e) { return null; }
}

/** Applique le thème à la zone des messages (le fond reste fixe pendant le défilement). */
export function applyWallpaper(el, convId) {
  const t = themeFor(convId);
  paint(el, t.theme, t.dim, t.theme === 'custom' ? customImage(t.scope) : null);
}

function paint(el, key, dim, customUrl) {
  const theme = THEMES.find(x => x.key === key);
  el.classList.toggle('wallpaper', key === 'doodle');
  el.classList.toggle('wp-light', !!(theme && theme.light));
  const shade = `linear-gradient(rgba(0, 0, 0, ${dim}), rgba(0, 0, 0, ${dim}))`;
  if (key === 'custom' && customUrl) el.style.background = `${shade}, url("${customUrl}") center / cover no-repeat, #0b141a`;
  else if (theme && theme.image) el.style.background = `${shade}, url("${theme.image}") center / cover no-repeat, #05070d`;
  else if (theme && theme.gradient) el.style.background = theme.gradient;
  else el.style.background = '';
}

/** Réduit une photo (1600 px max, JPEG) pour la garder sur l'appareil. */
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Fenêtre « Thème de la discussion ».
 * convId : discussion concernée (null = thème général, depuis les paramètres).
 */
export function themeDialog(convId = null, title = convId ? 'Thème de la discussion' : 'Thème des discussions') {
  const current = themeFor(convId);
  let selected = current.theme;
  let dim = current.dim;
  let photo = current.theme === 'custom' ? customImage(current.scope) : null;
  let forAll = !convId;

  const preview = h('div.wp-preview',
    h('div.wp-bubble.in', 'Salut ! Tu as vu le nouveau thème ? 😄'),
    h('div.wp-bubble.out', 'Oui, il est magnifique ✨'));
  const grid = h('div.wp-grid');
  const dimRow = h('label.wp-dim', h('span', 'Assombrir l’image'),
    h('input', { type: 'range', min: 0, max: 0.7, step: 0.05, value: dim, oninput: e => { dim = +e.target.value; refresh(); } }));

  const tile = (key, label, style, extra) => h('button.wp-tile' + (selected === key ? '.active' : ''), {
    type: 'button', title: label, onclick: () => { selected = key; refresh(); },
  }, h('span.wp-swatch', { style }, extra), h('small', label));

  function refresh() {
    clear(grid,
      THEMES.map(t => tile(t.key, t.label,
        t.image ? { backgroundImage: `url("${t.image}")` } : t.gradient ? { background: t.gradient } : {},
        t.pattern ? h('span.wp-pattern') : t.key === 'plain' ? h('span.wp-plain') : null)),
      h('button.wp-tile' + (selected === 'custom' ? '.active' : ''), { type: 'button', title: 'Votre photo', onclick: async () => {
        const [file] = await pickFiles({ accept: 'image/*' });
        if (!file) return;
        try { photo = await shrink(file); selected = 'custom'; refresh(); }
        catch (e) { toast('Image illisible.', { type: 'error' }); }
      } },
      h('span.wp-swatch.wp-upload', photo ? { style: { backgroundImage: `url("${photo}")` } } : null, photo ? null : icon('image', 26)),
      h('small', photo ? 'Votre photo' : 'Importer une photo')));
    const isImage = selected === 'kozons' || selected === 'custom';
    dimRow.classList.toggle('hidden', !isImage);
    paint(preview, selected, isImage ? dim : 0, photo);
  }
  refresh();

  const scope = convId ? h('div.wp-scope',
    h('label', h('input', { type: 'radio', name: 'wp-scope', checked: true, onchange: () => { forAll = false; } }), ' Cette discussion uniquement'),
    h('label', h('input', { type: 'radio', name: 'wp-scope', onchange: () => { forAll = true; } }), ' Toutes les discussions')) : null;

  const save = () => {
    if (selected === 'custom' && !photo) return toast('Choisissez d’abord une photo.', { type: 'error' });
    const scopeId = forAll ? null : convId;
    try {
      if (selected === 'custom') localStorage.setItem('kozons.' + imageKey(scopeId), photo);
      else localStorage.removeItem('kozons.' + imageKey(scopeId));
    } catch (e) { return toast('Photo trop lourde pour être enregistrée sur cet appareil.', { type: 'error' }); }
    prefs.set(scopeKey(scopeId), { theme: selected, dim });
    // « Toutes les discussions » depuis une discussion : elle suit désormais le thème général.
    if (forAll && convId) { try { localStorage.removeItem('kozons.' + scopeKey(convId)); localStorage.removeItem('kozons.' + imageKey(convId)); } catch (e) { /* ignoré */ } }
    bus.emit('wallpaper:changed', { convId: scopeId });
    m.close();
    toast('Thème appliqué');
  };
  const reset = () => {
    try {
      localStorage.removeItem('kozons.' + scopeKey(convId));
      localStorage.removeItem('kozons.' + imageKey(convId));
    } catch (e) { /* ignoré */ }
    bus.emit('wallpaper:changed', { convId });
    m.close();
    toast(convId ? 'La discussion reprend le thème général' : 'Thème par défaut rétabli');
  };

  const m = modal(h('div.wp-dialog',
    preview, grid, dimRow, scope,
    h('div.modal-actions',
      (convId ? current.own : prefs.get(scopeKey(null), null)) ? h('button.btn.ghost', { onclick: reset }, 'Par défaut') : null,
      h('button.btn.ghost', { onclick: () => m.close() }, 'Annuler'),
      h('button.btn.primary', { onclick: save }, 'Appliquer'))),
  { title, wide: true });
  // La fenêtre donne le focus au curseur : on revient en haut pour voir l'aperçu.
  setTimeout(() => { if (document.activeElement) document.activeElement.blur(); m.box.querySelector('.modal-body').scrollTop = 0; }, 80);
}
