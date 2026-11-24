// Appareil photo intégré, façon WhatsApp : aperçu plein écran, photo, vidéo et note vidéo.
//
//  · Photo : toucher le déclencheur ; le maintenir filme (glisser vers le haut = zoom), le relâcher arrête.
//  · Vidéo, Note vidéo : toucher pour démarrer, toucher pour arrêter (durée maximale, anneau de progression).
//  · Flash : lampe de l'appareil (caméra arrière) ou écran blanc (caméra avant, ordinateur).
//  · Pincer ou molette = zoom, toucher = mise au point, double toucher = changer de caméra,
//    glisser à gauche / à droite = changer de mode, glisser vers le haut = galerie.
//
// Ce qu'on voit est ce qu'on obtient : cadrage, zoom, miroir et filtre sont appliqués au fichier.
// Photo : image dessinée dans un canvas. Vidéo : canvas redessiné à chaque image et enregistré par
// MediaRecorder avec le micro (le serveur convertit ensuite en MP4).
import { h, clear, icon, toast, pickFiles, spinner } from './ui.js';

const MODES = [
  { id: 'video', label: 'Vidéo', hint: 'Appuyez pour filmer', aria: 'Filmer' },
  { id: 'photo', label: 'Photo', hint: 'Appuyez pour une photo, maintenez pour filmer', aria: 'Prendre une photo' },
  { id: 'note', label: 'Note vidéo', hint: 'Appuyez pour enregistrer une note vidéo', aria: 'Enregistrer une note vidéo' },
];

const FILTERS = [
  { label: 'Normal', css: 'none' },
  { label: 'Vif', css: 'saturate(1.45) contrast(1.08)' },
  { label: 'Chaud', css: 'sepia(.22) saturate(1.35) hue-rotate(-8deg)' },
  { label: 'Froid', css: 'saturate(1.1) hue-rotate(14deg) brightness(1.03)' },
  { label: 'N&B', css: 'grayscale(1) contrast(1.12)' },
  { label: 'Sépia', css: 'sepia(.85) contrast(1.05)' },
  { label: 'Rétro', css: 'contrast(.86) brightness(1.08) saturate(.75) sepia(.18)' },
  { label: 'Drame', css: 'contrast(1.35) saturate(.85) brightness(.92)' },
];

const MESSAGES = {
  insecure: ['Caméra indisponible', "Le navigateur n'autorise la caméra que sur une connexion sécurisée (https://). Utilisez l'appareil photo du téléphone ou choisissez dans la galerie."],
  unsupported: ['Caméra non prise en charge', "Ce navigateur ne donne pas accès à la caméra. Utilisez l'appareil photo du téléphone ou choisissez dans la galerie."],
  denied: ['Accès à la caméra refusé', "Autorisez la caméra pour Kozons dans les réglages du navigateur (icône à gauche de l'adresse), puis réessayez."],
  nocam: ['Aucune caméra détectée', 'Branchez une caméra, ou choisissez une photo ou une vidéo dans la galerie.'],
  busy: ['Caméra occupée', 'Une autre application (ou un appel en cours) utilise la caméra. Fermez-la, puis réessayez.'],
  ended: ['Caméra interrompue', 'La caméra a été coupée. Réessayez.'],
  error: ["Impossible d'ouvrir la caméra", 'Réessayez, ou choisissez dans la galerie.'],
};

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const MAX_ZOOM = 5;
const NOTE_SECONDS = 60;        // comme les notes vidéo de WhatsApp
const MIN_CLIP_MS = 800;        // en dessous : appui involontaire, rien n'est gardé
const HOLD_MS = 320;            // appui long sur le déclencheur en mode Photo = vidéo
const VIDEO_SHORT_SIDE = 720;   // vidéo enregistrée : 720 px sur le petit côté (le serveur sort du 720p)
const NOTE_SIDE = 480;          // note vidéo des discussions : carré 480 × 480 (comme le serveur)
const PHOTO_LONG_SIDE = 1920;

const canFilter = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;
const coarse = () => window.matchMedia('(pointer: coarse)').matches;
const wait = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const even = n => Math.max(2, Math.round(n / 2) * 2);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const stamp = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Format d'enregistrement : WebM (Chrome, Firefox, Android), sinon MP4 (Safari). */
function recorderType() {
  if (!window.MediaRecorder) return null;
  const types = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'];
  return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } }) || '';
}

function errorKind(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'nocam';
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'busy';
  return 'error';
}

/** Anneau de progression SVG (contenu statique). */
function ring(cls, r) {
  const el = document.createElement('span');
  el.className = cls;
  el.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="cam-ring-track" cx="50" cy="50" r="${r}"/>`
    + `<circle class="cam-ring-prog" cx="50" cy="50" r="${r}" pathLength="100"/></svg>`;
  return el;
}

let opened = null;
// « Retour » lancé par la fermeture précédente : la prochaine ouverture attend qu'il soit fini,
// sinon son événement popstate refermerait aussitôt la nouvelle caméra.
let backPending = null;

function historyBack() {
  backPending = new Promise(resolve => {
    const done = () => { window.removeEventListener('popstate', done); clearTimeout(t); backPending = null; resolve(); };
    const t = setTimeout(done, 3000);   // filet de sécurité : le popstate arrive normalement en quelques ms
    window.addEventListener('popstate', done);
  });
  history.back();
}

/**
 * Ouvre l'appareil photo plein écran. `onCapture(files, info)` reçoit la prise (ou les fichiers choisis
 * dans la galerie) une fois l'appareil photo fermé ; info.kind : 'photo' | 'video' | 'note' | 'gallery',
 * info.duration : durée en secondes (vidéo, note).
 *
 *  noteStyle 'story' : la note vidéo devient une vidéo verticale (cercle sur fond sombre) ;
 *            'chat'  : vidéo carrée, la bulle ronde est découpée à l'affichage (comme WhatsApp).
 *  reviewNote : après une note vidéo, relecture en boucle avec « Supprimer » / « Envoyer ».
 *  multiple   : plusieurs fichiers à la fois depuis la galerie.
 */
export function openCamera({
  onCapture, maxVideoSeconds = 90, noteSeconds = NOTE_SECONDS, noteStyle = 'story', reviewNote = false, multiple = false,
} = {}) {
  if (opened) return opened;

  let stream = null, audioTrack = null, micRefused = false, mutedWarned = false;
  let facing = 'environment', facingBeforeNote = null, mirror = false, cameras = 0;
  let mode = 'photo', filter = 0, flash = false, zoom = 1;
  let rec = null, review = null, closed = false, busy = false, flipping = false, startSeq = 0;
  let noteD = 0, noteCy = 0, msgKind = null;
  const timers = {};

  // ------------------------------------------------------------------ éléments
  const video = h('video.cam-video', { autoplay: true, muted: true, playsInline: true, disablePictureInPicture: true });
  video.setAttribute('playsinline', '');
  const media = h('div.cam-media', video);
  const noteRing = ring('cam-note-ring', 48.5);
  const focusEl = h('div.cam-focus');
  const zoomEl = h('div.cam-zoom');
  const badge = h('div.cam-badge');
  const hint = h('div.cam-hint');
  const loader = h('div.cam-loader', spinner(36));
  const msg = h('div.cam-msg.hidden');
  const timer = h('div.cam-timer', { 'aria-live': 'polite' }, '0:00');
  const round = (name, label, onclick, cls = '') =>
    h('button.cam-round' + (cls ? '.' + cls : ''), { type: 'button', title: label, 'aria-label': label, onclick }, icon(name, 22));
  const closeBtn = round('close', 'Fermer', () => close());
  const flashBtn = round('flashOff', 'Flash désactivé', () => toggleFlash(), 'cam-flash');
  const galleryBtn = round('image', 'Galerie', () => openGallery(), 'cam-gallery');
  const wandBtn = round('wand', 'Filtres', () => toggleFilters(), 'cam-wand');
  const flipBtn = round('flip', 'Changer de caméra', () => flip(), 'cam-flip');
  const upBtn = h('button.cam-up', { type: 'button', title: 'Galerie', 'aria-label': 'Ouvrir la galerie', onclick: () => openGallery() }, icon('chevronUp', 22));
  const shutterRing = ring('cam-shutter-ring', 46);
  const shutter = h('button.cam-shutter', { type: 'button', 'aria-label': 'Prendre une photo' }, shutterRing, h('span.cam-shutter-core'));
  const filtersEl = h('div.cam-filters.hidden', { 'aria-label': 'Filtres' });
  const modeBtns = MODES.map(m => h('button.cam-mode', { type: 'button', dataset: { mode: m.id }, onclick: () => setMode(m.id) }, m.label));
  const modeTrack = h('div.cam-modes-track', modeBtns);
  const modesEl = h('div.cam-modes', modeTrack);
  // Relecture d'une note vidéo avant l'envoi (discussions).
  const reviewVideo = h('video.cam-review-video', { playsInline: true, loop: true, preload: 'auto', disablePictureInPicture: true });
  reviewVideo.setAttribute('playsinline', '');
  const reviewMuted = h('span.cam-review-muted.hidden', icon('volumeOff', 18));
  const reviewEl = h('div.cam-review', { title: 'Son / pause' }, reviewVideo, reviewMuted);
  const reviewLen = h('span.cam-review-len');
  const sendBtn = h('button.cam-send', { type: 'button', title: 'Envoyer', 'aria-label': 'Envoyer la note vidéo', onclick: () => sendReview() }, icon('send', 24));
  const reviewBar = h('div.cam-review-bar',
    round('trash', 'Supprimer et recommencer', () => discardReview(), 'cam-review-del'), reviewLen, sendBtn);
  const view = h('div.cam-view',
    media, noteRing, reviewEl, focusEl, zoomEl, badge, loader, msg, reviewBar,
    h('div.cam-top', closeBtn, timer, flashBtn),
    h('div.cam-bottom', hint, filtersEl, upBtn,
      h('div.cam-controls', galleryBtn, wandBtn, shutter, h('span'), flipBtn)));
  const screenFlash = h('div.cam-screenflash');
  const layer = h('div.cam.loading', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Appareil photo', tabindex: '-1' },
    h('div.cam-frame', view, modesEl), screenFlash);
  if (!canFilter) wandBtn.classList.add('hidden');
  flipBtn.classList.add('hidden');
  flashBtn.classList.add('hidden');

  const track = () => (stream ? stream.getVideoTracks()[0] : null);
  const ready = () => !!(stream && video.readyState >= 2 && video.videoWidth);

  // ------------------------------------------------------------------ caméra
  function videoConstraints() {
    return { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  }

  function stopVideo() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
  }

  async function start() {
    const seq = ++startSeq;
    stopVideo();
    hideMsg();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showMsg(window.isSecureContext === false ? 'insecure' : 'unsupported');
    }
    layer.classList.add('loading');
    const wantAudio = !audioTrack && !micRefused;
    let s = null, err = null;
    try {
      s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio: wantAudio ? AUDIO : false });
    } catch (e) { err = e; }
    if (!s && wantAudio) {
      // Micro refusé ou absent : la caméra seule suffit (photos ; vidéos sans son).
      try { s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() }); micRefused = true; err = null; } catch (e) { err = e; }
    }
    if (closed || seq !== startSeq) { if (s) s.getTracks().forEach(t => t.stop()); return; }
    if (!s) { layer.classList.remove('loading', 'switching'); return showMsg(errorKind(err)); }
    const a = s.getAudioTracks()[0];
    if (a) audioTrack = a;
    stream = new MediaStream(s.getVideoTracks());
    video.srcObject = stream;
    // play() peut rester en attente (page masquée) : on attend seulement les dimensions de l'image.
    video.play().catch(() => {});
    if (!video.videoWidth) await new Promise(r => { video.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 1500); });
    if (closed || seq !== startSeq) return;
    if (!cameras) {
      try { cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').length; } catch (e) { cameras = 1; }
    }
    const t = track();
    const st = (t && t.getSettings) ? t.getSettings() : {};
    // Caméra avant (ou webcam d'ordinateur) : aperçu en miroir, comme dans un miroir de salle de bain.
    mirror = st.facingMode ? st.facingMode === 'user' : (facing === 'user' || cameras <= 1);
    // Caméra coupée par le système (autre application…) ; en arrière-plan, la reprise est automatique.
    if (t) t.addEventListener('ended', () => { if (!closed && track() === t && !document.hidden) { stopRecording(); showMsg('ended'); } });
    flipBtn.classList.toggle('hidden', cameras < 2);
    applyView();
    updateFlashBtn();
    if (rec && flash && torchCapable()) setTorch(true);
    layer.classList.remove('loading', 'switching');
  }

  function torchCapable() {
    const t = track();
    try { return !!(t && t.getCapabilities && t.getCapabilities().torch); } catch (e) { return false; }
  }

  async function setTorch(on) {
    const t = track();
    if (!t) return;
    try { await t.applyConstraints({ advanced: [{ torch: on }] }); } catch (e) { /* lampe indisponible */ }
  }

  // ------------------------------------------------------------------ aperçu
  function applyView() {
    video.style.transform = `scale(${(mirror ? -1 : 1) * zoom}, ${zoom})`;
    video.style.filter = FILTERS[filter].css === 'none' ? '' : FILTERS[filter].css;
  }

  function setZoom(z, show = true) {
    const next = clamp(z, 1, MAX_ZOOM);
    if (Math.abs(next - zoom) < 0.005) return;
    zoom = next;
    applyView();
    if (!show) return;
    zoomEl.textContent = zoom.toFixed(1).replace('.', ',') + '×';
    flashClass(zoomEl, 'show', 900, 'zoom');
  }

  /** Affiche brièvement un élément (classe ajoutée puis retirée). */
  function flashClass(el, cls, ms, key) {
    el.classList.add(cls);
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => el.classList.remove(cls), ms);
  }

  function showHint(text, ms = 2600) {
    hint.textContent = text;
    flashClass(hint, 'show', ms, 'hint');
  }

  function showBadge(text) {
    badge.textContent = text;
    flashClass(badge, 'show', 900, 'badge');
  }

  function layout() {
    const vw = view.clientWidth, vh = view.clientHeight;
    if (!vw || !vh) return;
    noteD = Math.round(Math.min(vw * 0.8, vh * 0.56));
    noteCy = Math.round(vh * 0.45);
    view.style.setProperty('--note-d', noteD + 'px');
    view.style.setProperty('--note-cy', noteCy + 'px');
    const b = modeTrack.querySelector('.active');
    if (b) modeTrack.style.transform = `translateX(${Math.round(modesEl.clientWidth / 2 - (b.offsetLeft + b.offsetWidth / 2))}px)`;
  }

  /** Mise au point et exposition sur le point touché (si l'appareil le permet). */
  function focusAt(x, y) {
    const r = view.getBoundingClientRect();
    focusEl.style.left = (x - r.left) + 'px';
    focusEl.style.top = (y - r.top) + 'px';
    focusEl.classList.remove('show');
    void focusEl.offsetWidth;
    flashClass(focusEl, 'show', 1000, 'focus');
    const t = track();
    if (!t || !t.getCapabilities || !video.videoWidth) return;
    let caps = {};
    try { caps = t.getCapabilities(); } catch (e) { return; }
    if (!caps.focusMode && !caps.exposureMode) return;
    const m = media.getBoundingClientRect();
    let nx = (x - m.left) / m.width, ny = (y - m.top) / m.height;
    if (mirror) nx = 1 - nx;
    nx = 0.5 + (nx - 0.5) / zoom;
    ny = 0.5 + (ny - 0.5) / zoom;
    // object-fit: cover — position dans l'image entière du capteur.
    const s = Math.max(m.width / video.videoWidth, m.height / video.videoHeight);
    const dw = video.videoWidth * s, dh = video.videoHeight * s;
    const px = clamp((nx * m.width + (dw - m.width) / 2) / dw, 0, 1);
    const py = clamp((ny * m.height + (dh - m.height) / 2) / dh, 0, 1);
    const c = { pointsOfInterest: [{ x: px, y: py }] };
    if (caps.focusMode && caps.focusMode.includes('single-shot')) c.focusMode = 'single-shot';
    if (caps.exposureMode && caps.exposureMode.includes('single-shot')) c.exposureMode = 'single-shot';
    t.applyConstraints({ advanced: [c] }).catch(() => {});
  }

  // ------------------------------------------------------------------ dessin (photo et vidéo)
  /** Zone du capteur visible à l'écran pour des proportions données (cadrage « cover » + zoom). */
  function cropRect(aspect) {
    const vw = video.videoWidth, vh = video.videoHeight;
    let sw = vw, sh = vh;
    if (vw / vh > aspect) sw = vh * aspect; else sh = vw / aspect;
    sw /= zoom;
    sh /= zoom;
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
  }

  function drawVideo(ctx, x, y, w, hgt, src, css = FILTERS[filter].css) {
    ctx.save();
    if (canFilter) ctx.filter = css;
    if (mirror) {
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(video, src.sx, src.sy, src.sw, src.sh, 0, 0, w, hgt);
    } else {
      ctx.drawImage(video, src.sx, src.sy, src.sw, src.sh, x, y, w, hgt);
    }
    ctx.restore();
  }

  function snapshot() {
    const aspect = media.clientWidth / media.clientHeight || 9 / 16;
    const src = cropRect(aspect);
    const k = Math.min(1, PHOTO_LONG_SIDE / Math.max(src.sw, src.sh));
    const c = h('canvas', { width: Math.round(src.sw * k), height: Math.round(src.sh * k) });
    drawVideo(c.getContext('2d'), 0, 0, c.width, c.height, src);
    return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('photo'))), 'image/jpeg', 0.92));
  }

  // ------------------------------------------------------------------ photo
  async function takePhoto() {
    if (busy || rec || !ready()) return;
    busy = true;
    const torch = flash && torchCapable();
    const screen = flash && !torch && mirror;
    try {
      if (torch) { await setTorch(true); await wait(650); }       // le capteur ajuste l'exposition
      if (screen) { screenFlash.classList.add('on'); await wait(380); }
      const blob = await snapshot();
      view.classList.remove('blink');
      void view.offsetWidth;
      view.classList.add('blink');
      if (navigator.vibrate) navigator.vibrate(12);
      finish(new File([blob], `Kozons-IMG-${stamp()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }), { kind: 'photo' });
    } catch (e) {
      toast('Impossible de prendre la photo.', { type: 'error' });
    } finally {
      if (torch && !closed) setTorch(false);
      screenFlash.classList.remove('on');
      busy = false;
    }
  }

  // ------------------------------------------------------------------ vidéo et note vidéo
  function startRecording(kind) {
    if (rec || busy || !ready()) return;
    const type = recorderType();
    if (type === null || !HTMLCanvasElement.prototype.captureStream) {
      toast("Ce navigateur ne permet pas de filmer ici : utilisez la galerie.", { type: 'error' });
      return;
    }
    const note = kind === 'note';
    const square = note && noteStyle === 'chat';   // discussions : image carrée, la bulle ronde est découpée à l'affichage
    const vw = view.clientWidth, vh = view.clientHeight;
    const aspect = clamp(vw / vh, 9 / 21, 21 / 9);
    const W = square ? NOTE_SIDE : even(aspect < 1 ? VIDEO_SHORT_SIDE : VIDEO_SHORT_SIDE * aspect);
    const H = square ? NOTE_SIDE : even(aspect < 1 ? VIDEO_SHORT_SIDE / aspect : VIDEO_SHORT_SIDE);
    const canvas = h('canvas', { width: W, height: H });
    const ctx = canvas.getContext('2d', { alpha: false });
    // Note vidéo : le cercle de l'aperçu, à l'échelle de la vidéo, sur le même fond.
    const k = W / vw;
    const geo = { cx: W / 2, cy: noteCy * k, r: (noteD / 2) * k };
    const bg = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, Math.max(W, H) * 0.75);
    bg.addColorStop(0, '#1f3a44');
    bg.addColorStop(1, '#0b141a');
    const paint = () => {
      if (video.readyState < 2 || !video.videoWidth) return;   // caméra en cours de changement : dernière image gardée
      if (!note || square) return drawVideo(ctx, 0, 0, W, H, cropRect(W / H));
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.beginPath();
      ctx.arc(geo.cx, geo.cy, geo.r, 0, Math.PI * 2);
      ctx.clip();
      drawVideo(ctx, geo.cx - geo.r, geo.cy - geo.r, geo.r * 2, geo.r * 2, cropRect(1));
      ctx.restore();
      ctx.lineWidth = Math.max(3, W / 200);
      ctx.strokeStyle = 'rgba(255, 255, 255, .92)';
      ctx.beginPath();
      ctx.arc(geo.cx, geo.cy, geo.r + ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.stroke();
    };
    paint();
    const out = canvas.captureStream(30);
    const tracks = out.getVideoTracks();
    if (audioTrack && audioTrack.readyState === 'live') tracks.push(audioTrack);
    else if (!mutedWarned) { mutedWarned = true; toast('Micro indisponible : la vidéo sera enregistrée sans son.'); }
    let recorder;
    try {
      recorder = new MediaRecorder(new MediaStream(tracks),
        Object.assign(type ? { mimeType: type } : {}, { videoBitsPerSecond: square ? 1500000 : 3000000, audioBitsPerSecond: 128000 }));
    } catch (e) {
      out.getTracks().forEach(t => t.stop());
      toast("Impossible de démarrer l'enregistrement.", { type: 'error' });
      return;
    }
    const chunks = [];
    const max = (note ? noteSeconds : maxVideoSeconds) * 1000;
    const r = rec = { recorder, kind, startedAt: performance.now(), stoppedAt: 0, discard: false, raf: 0, tick: 0 };
    let last = 0;
    const loop = now => {
      r.raf = requestAnimationFrame(loop);
      if (now - last < 30) return;          // ~30 images/s
      last = now;
      paint();
    };
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onerror = () => stopRecording(true);
    recorder.onstop = () => {
      cancelAnimationFrame(r.raf);
      clearInterval(r.tick);
      out.getVideoTracks().forEach(t => t.stop());
      if (rec === r) rec = null;
      setRecordingUi(false);
      if (flash && torchCapable() && !closed) setTorch(false);
      if (r.discard || closed && !r.keep) return;
      if ((r.stoppedAt || performance.now()) - r.startedAt < MIN_CLIP_MS || !chunks.length) {
        showHint(kind === 'hold' ? 'Maintenez le déclencheur pour filmer, appuyez pour une photo' : 'Vidéo trop courte');
        return;
      }
      const mime = (recorder.mimeType || type || 'video/webm').split(';')[0];
      const file = new File([new Blob(chunks, { type: mime })], `Kozons-VID-${stamp()}.${mime.includes('mp4') ? 'mp4' : 'webm'}`,
        { type: mime, lastModified: Date.now() });
      const info = { kind: note ? 'note' : 'video', duration: Math.round(((r.stoppedAt || performance.now()) - r.startedAt) / 100) / 10 };
      if (note && reviewNote && !closed) enterReview(file, info);
      else finish(file, info);
    };
    recorder.start(1000);
    r.raf = requestAnimationFrame(loop);
    if (flash && torchCapable()) setTorch(true);
    setRecordingUi(true, kind);
    if (navigator.vibrate) navigator.vibrate(15);
    r.tick = setInterval(() => {
      const ms = performance.now() - r.startedAt;
      timer.textContent = mmss(ms / 1000);
      setProgress(ms / max);
      if (ms >= max) stopRecording();
    }, 200);
  }

  function stopRecording(discard = false) {
    const r = rec;
    if (!r || r.stoppedAt) return;
    r.stoppedAt = performance.now();
    r.discard = discard;
    try { r.recorder.stop(); } catch (e) { r.recorder.onstop && r.recorder.onstop(); }
  }

  function setProgress(p) {
    const off = String(100 - clamp(p, 0, 1) * 100);
    shutterRing.querySelector('.cam-ring-prog').style.strokeDashoffset = off;
    noteRing.querySelector('.cam-ring-prog').style.strokeDashoffset = off;
  }

  function setRecordingUi(on, kind) {
    layer.classList.toggle('recording', on);
    layer.classList.toggle('hold', !!on && kind === 'hold');
    timer.textContent = '0:00';
    setProgress(0);
    if (on) filtersEl.classList.add('hidden');
    shutter.setAttribute('aria-label', on ? "Arrêter l'enregistrement" : MODES.find(m => m.id === mode).aria);
  }

  function shoot() {
    if (review || layer.classList.contains('blocked')) return;
    if (mode === 'photo') takePhoto();
    else if (rec) stopRecording();
    else startRecording(mode);
  }

  // ------------------------------------------------------------------ commandes
  function setMode(id, initial = false) {
    if (rec || review || (id === mode && !initial)) return;
    const prev = mode;
    mode = id;
    MODES.forEach(m => layer.classList.toggle('mode-' + m.id, m.id === id));
    modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === id));
    layer.classList.toggle('is-note', id === 'note');
    shutter.setAttribute('aria-label', MODES.find(m => m.id === id).aria);
    layout();
    showHint(MODES.find(m => m.id === id).hint);
    if (initial) return;
    // Note vidéo : caméra avant par défaut (comme WhatsApp), caméra d'origine rendue en sortant.
    if (id === 'note' && facing !== 'user' && cameras > 1) { facingBeforeNote = facing; switchTo('user'); }
    else if (prev === 'note' && facingBeforeNote && facingBeforeNote !== facing) { const f = facingBeforeNote; facingBeforeNote = null; switchTo(f); }
    else if (prev === 'note') facingBeforeNote = null;
  }

  function stepMode(d) {
    const i = MODES.findIndex(m => m.id === mode) + d;
    if (i >= 0 && i < MODES.length) setMode(MODES[i].id);
  }

  async function switchTo(f) {
    if (flipping) return;
    flipping = true;
    facing = f;
    layer.classList.add('switching');
    setZoom(1, false);
    await start();
    flipping = false;
  }

  function flip() {
    if (cameras < 2 || flipping) return;
    facingBeforeNote = null;
    flipBtn.classList.remove('spin');
    void flipBtn.offsetWidth;
    flipBtn.classList.add('spin');
    switchTo(facing === 'user' ? 'environment' : 'user');
  }

  function updateFlashBtn() {
    // Caméra arrière sans lampe (iPhone, certains navigateurs) : pas de flash possible.
    const usable = torchCapable() || mirror;
    flashBtn.classList.toggle('hidden', !usable);
    const label = flash ? 'Flash activé' : 'Flash désactivé';
    clear(flashBtn, icon(flash ? 'flash' : 'flashOff', 22));
    flashBtn.title = label;
    flashBtn.setAttribute('aria-label', label);
    flashBtn.setAttribute('aria-pressed', String(flash));
    flashBtn.classList.toggle('on', flash);
  }

  function toggleFlash() {
    flash = !flash;
    updateFlashBtn();
    showBadge(flash ? 'Flash activé' : 'Flash désactivé');
    if (rec && torchCapable()) setTorch(flash);
  }

  function thumbnail() {
    if (!ready()) return '';
    const c = h('canvas', { width: 96, height: 96 });
    drawVideo(c.getContext('2d'), 0, 0, 96, 96, cropRect(1), 'none');
    try { return c.toDataURL('image/jpeg', 0.7); } catch (e) { return ''; }
  }

  function toggleFilters() {
    if (!filtersEl.classList.contains('hidden')) { filtersEl.classList.add('hidden'); wandBtn.classList.remove('on'); return; }
    const src = thumbnail();
    clear(filtersEl, FILTERS.map((f, i) => h('button.cam-filter' + (i === filter ? '.active' : ''), {
      type: 'button', 'aria-pressed': String(i === filter), onclick: () => setFilter(i),
    }, src ? h('img', { src, alt: '', style: { filter: f.css } }) : h('span.cam-filter-blank', { style: { filter: f.css } }), h('span', f.label))));
    filtersEl.classList.remove('hidden');
    wandBtn.classList.add('on');
    const a = filtersEl.querySelector('.active');
    if (a) a.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function setFilter(i) {
    filter = i;
    applyView();
    filtersEl.querySelectorAll('.cam-filter').forEach((b, j) => { b.classList.toggle('active', j === i); b.setAttribute('aria-pressed', String(j === i)); });
    showBadge(FILTERS[i].label);
  }

  async function openGallery() {
    if (rec || review) return;
    const files = await pickFiles({ accept: 'image/*,video/*', multiple });
    if (files.length && !closed) finish(files, { kind: 'gallery' });
  }

  /** Repli sans caméra intégrée (http, permission refusée…) : appareil photo natif du téléphone. */
  async function nativeCamera() {
    const [f] = await pickFiles({ accept: mode === 'photo' ? 'image/*' : 'video/*', capture: mode === 'note' ? 'user' : 'environment' });
    if (f && !closed) finish(f, { kind: 'gallery' });
  }

  // ------------------------------------------------------------------ relecture d'une note vidéo
  function enterReview(file, info) {
    review = { file, info, url: URL.createObjectURL(file) };
    startSeq++;
    stopVideo();          // caméra éteinte pendant la relecture
    reviewLen.textContent = mmss(info.duration);
    reviewVideo.src = review.url;
    reviewVideo.muted = false;
    // Lecture avec le son (le toucher sur le déclencheur l'autorise) ; sinon muette, toucher pour le son.
    reviewVideo.play().catch(() => { reviewVideo.muted = true; reviewVideo.play().catch(() => {}); });
    layer.classList.add('reviewing');
  }

  function leaveReview() {
    if (!review) return null;
    const r = review;
    review = null;
    reviewVideo.pause();
    reviewVideo.removeAttribute('src');
    reviewVideo.load();
    URL.revokeObjectURL(r.url);
    layer.classList.remove('reviewing');
    return r;
  }

  function discardReview() {
    if (!leaveReview()) return;
    showHint(MODES.find(m => m.id === mode).hint);
    start();
  }

  function sendReview() {
    const r = leaveReview();
    if (r) finish(r.file, r.info);
  }

  reviewVideo.addEventListener('volumechange', () => reviewMuted.classList.toggle('hidden', !reviewVideo.muted));
  reviewEl.addEventListener('click', () => {
    if (reviewVideo.muted) { reviewVideo.muted = false; reviewVideo.play().catch(() => {}); }
    else if (reviewVideo.paused) reviewVideo.play().catch(() => {});
    else reviewVideo.pause();
  });

  function showMsg(kind) {
    msgKind = kind;
    const [title, text] = MESSAGES[kind] || MESSAGES.error;
    const retry = !['insecure', 'unsupported', 'nocam'].includes(kind);
    clear(msg,
      icon('camOff', 46),
      h('h3', title),
      h('p', text),
      h('div.cam-msg-actions',
        retry ? h('button.btn.primary', { type: 'button', onclick: () => start() }, 'Réessayer') : null,
        coarse() || kind === 'insecure' || kind === 'unsupported'
          ? h('button.btn.cam-msg-btn', { type: 'button', onclick: () => nativeCamera() }, icon('camera', 18), "Appareil photo du téléphone") : null,
        h('button.btn.cam-msg-btn', { type: 'button', onclick: () => openGallery() }, icon('image', 18), 'Galerie')));
    msg.classList.remove('hidden');
    layer.classList.add('blocked');
    layer.classList.remove('loading');
  }

  function hideMsg() {
    msgKind = null;
    msg.classList.add('hidden');
    layer.classList.remove('blocked');
  }

  // ------------------------------------------------------------------ fermeture
  function finish(files, info) {
    close({ keep: true });
    if (onCapture) onCapture(Array.isArray(files) ? files : [files], info);
  }

  function close({ keep = false } = {}) {
    if (closed) return;
    closed = true;
    opened = null;
    if (rec) { rec.keep = keep; stopRecording(!keep); }
    leaveReview();
    startSeq++;
    stopVideo();
    if (audioTrack) { audioTrack.stop(); audioTrack = null; }
    Object.values(timers).forEach(clearTimeout);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('popstate', onPop);
    ro.disconnect();
    layer.classList.add('closing');
    setTimeout(() => layer.remove(), 160);
    if (history.state && history.state.kozCamera) historyBack();
  }

  // ------------------------------------------------------------------ gestes
  shutter.addEventListener('contextmenu', e => e.preventDefault());
  let press = null;
  shutter.addEventListener('pointerdown', e => {
    if (e.button !== 0 || layer.classList.contains('blocked')) return;
    e.preventDefault();
    try { shutter.setPointerCapture(e.pointerId); } catch (err) { /* ignoré */ }
    press = { id: e.pointerId, y: e.clientY, zoom0: zoom, held: false, timer: 0 };
    shutter.classList.add('pressed');
    if (mode === 'photo' && !rec) {
      press.timer = setTimeout(() => {
        if (!press || !ready()) return;
        press.held = true;
        startRecording('hold');
      }, HOLD_MS);
    }
  });
  shutter.addEventListener('pointermove', e => {
    // Pendant l'appui long : glisser vers le haut zoome (comme WhatsApp).
    if (press && e.pointerId === press.id && press.held) setZoom(press.zoom0 + Math.max(0, press.y - e.clientY) / 70);
  });
  const release = (e, cancel) => {
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    clearTimeout(p.timer);
    shutter.classList.remove('pressed');
    if (p.held) return stopRecording();
    if (!cancel) shoot();
  };
  shutter.addEventListener('pointerup', e => release(e, false));
  shutter.addEventListener('pointercancel', e => release(e, true));
  shutter.addEventListener('click', e => { if (e.detail === 0) shoot(); });   // clavier (Entrée, Espace)

  const pts = new Map();
  let g = null, lastTap = { t: 0, x: 0, y: 0 };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
  view.addEventListener('pointerdown', e => {
    if (review || e.target.closest('button, .cam-filters, .cam-msg')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { view.setPointerCapture(e.pointerId); } catch (err) { /* ignoré */ }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      g = { pinch: true, d0: dist(a, b), z0: zoom };
    } else if (pts.size === 1) {
      g = { x: e.clientX, y: e.clientY, t: Date.now() };
    }
  });
  view.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g && g.pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      setZoom(g.z0 * dist(a, b) / g.d0);
    }
  });
  const viewUp = (e, cancel) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    if (g.pinch) { if (!pts.size) g = null; return; }
    const { x, y, t } = g;
    g = null;
    if (cancel || layer.classList.contains('blocked')) return;
    const dx = e.clientX - x, dy = e.clientY - y, dt = Date.now() - t;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) return stepMode(dx < 0 ? 1 : -1);
    if (dy < -70 && Math.abs(dy) > Math.abs(dx) * 1.5) return openGallery();
    if (Math.abs(dx) + Math.abs(dy) > 14 || dt > 500) return;
    const now = Date.now();
    if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 50) {
      lastTap.t = 0;
      return flip();
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    if (!filtersEl.classList.contains('hidden')) { filtersEl.classList.add('hidden'); wandBtn.classList.remove('on'); return; }
    focusAt(e.clientX, e.clientY);
  };
  view.addEventListener('pointerup', e => viewUp(e, false));
  view.addEventListener('pointercancel', e => viewUp(e, true));
  view.addEventListener('wheel', e => {
    if (review || layer.classList.contains('blocked')) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });
  view.addEventListener('contextmenu', e => e.preventDefault());

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (e.key === ' ' && !(e.target.closest && e.target.closest('button'))) { e.preventDefault(); shoot(); }
    else if (e.key === 'ArrowLeft') stepMode(-1);
    else if (e.key === 'ArrowRight') stepMode(1);
  }

  // Application en arrière-plan : on libère la caméra (et on garde la vidéo en cours) ; reprise au retour.
  function onVisibility() {
    if (closed) return;
    if (review) { if (document.hidden) reviewVideo.pause(); return; }   // relecture : la caméra reste éteinte
    if (document.hidden) {
      if (rec) stopRecording();
      startSeq++;
      stopVideo();
      if (audioTrack) { audioTrack.stop(); audioTrack = null; }
    } else if (!stream && !['insecure', 'unsupported', 'nocam', 'denied'].includes(msgKind)) {
      start();
    }
  }

  // Bouton « Retour » du téléphone ou du navigateur : ferme l'appareil photo sans quitter la page.
  function onPop() { if (!(history.state && history.state.kozCamera)) close(); }

  const ro = new ResizeObserver(() => layout());
  ro.observe(view);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVisibility);
  const armBack = () => {
    if (closed) return;
    try { history.pushState({ kozCamera: true }, ''); } catch (e) { return; }
    window.addEventListener('popstate', onPop);
  };
  if (backPending) backPending.then(armBack); else armBack();

  document.getElementById('overlay-root').appendChild(layer);
  setMode('photo', true);
  layout();
  layer.focus();
  start();

  opened = { close };
  return opened;
}
