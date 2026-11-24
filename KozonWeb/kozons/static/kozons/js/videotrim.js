// Découpe d'une vidéo avant publication (façon WhatsApp) : pellicule de miniatures, deux poignées
// pour choisir le début et la fin, fenêtre déplaçable, curseur de lecture, « 🔊 0:13 • 1,8 Mo ».
// La découpe elle-même est faite par le serveur (ffmpeg) : on n'envoie que les bornes choisies.
import { h, icon } from './ui.js';

const MIN_SECONDS = 1;
const OUT_KBPS = 1500 + 96;   // débit après conversion (vidéo + son), voir social/storymedia.py

const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * @param video   élément <video> de l'aperçu (déjà chargé avec la source)
 * @param opts    { maxSeconds, fileSize }
 * @returns {{ el, range: () => ({start, end}), muted: () => boolean, destroy }}
 */
export function videoTrimmer(video, { maxSeconds = 90, fileSize = 0 } = {}) {
  let duration = 0, start = 0, end = 0, mute = false, drag = null, destroyed = false;

  const canvas = h('canvas.vt-thumbs');
  const shadeL = h('div.vt-shade.left');
  const shadeR = h('div.vt-shade.right');
  const handleL = h('span.vt-handle.left', { role: 'slider', 'aria-label': 'Début de la séquence', tabindex: '0' });
  const handleR = h('span.vt-handle.right', { role: 'slider', 'aria-label': 'Fin de la séquence', tabindex: '0' });
  const sel = h('div.vt-sel', handleL, handleR);
  const playhead = h('div.vt-playhead');
  const strip = h('div.vt-strip', canvas, shadeL, shadeR, sel, playhead);
  const durEl = h('span.vt-dur');
  const sizeEl = h('span.vt-size');
  const muteBtn = h('button.vt-mute', { type: 'button', 'aria-label': 'Couper le son', title: 'Publier sans le son', onclick: () => setMute(!mute) }, icon('volume', 18));
  const info = h('div.vt-info', muteBtn, durEl, h('span.vt-dot', '•'), sizeEl);
  const el = h('div.vt', strip, info);

  function setMute(on) {
    mute = on;
    video.muted = on;
    muteBtn.replaceChildren(icon(on ? 'volumeOff' : 'volume', 18));
    muteBtn.classList.toggle('off', on);
    muteBtn.setAttribute('aria-label', on ? 'Remettre le son' : 'Couper le son');
    paint();
  }

  function paint() {
    if (!duration) return;
    const l = (start / duration) * 100, r = (end / duration) * 100;
    sel.style.left = l + '%';
    sel.style.width = (r - l) + '%';
    shadeL.style.width = l + '%';
    shadeR.style.left = r + '%';
    const len = end - start;
    durEl.textContent = fmt(Math.round(len));
    // Taille estimée après compression (jamais plus que la part correspondante du fichier d'origine).
    let bytes = len * OUT_KBPS * 1000 / 8;
    if (fileSize && duration) bytes = Math.min(bytes, fileSize * (len / duration));
    if (mute) bytes *= 0.94;
    sizeEl.textContent = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
    handleL.setAttribute('aria-valuetext', fmt(start));
    handleR.setAttribute('aria-valuetext', fmt(end));
  }

  // ---------------------------------------------------------- miniatures (pellicule)
  async function buildThumbs() {
    const probe = h('video', { src: video.currentSrc || video.src, muted: true, playsinline: true, preload: 'auto' });
    probe.muted = true;
    try {
      await new Promise((ok, ko) => { probe.onloadeddata = ok; probe.onerror = ko; setTimeout(ko, 8000); });
    } catch (e) { return; }
    const w = strip.clientWidth || 300, hgt = strip.clientHeight || 52;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(hgt * ratio);
    const ctx = canvas.getContext('2d');
    const vw = probe.videoWidth || 9, vh = probe.videoHeight || 16;
    const slotW = Math.max(24, hgt * (vw / vh));
    const n = Math.max(4, Math.ceil(w / slotW));
    for (let i = 0; i < n && !destroyed; i++) {
      const t = Math.min(duration - 0.05, (duration * (i + 0.5)) / n);
      try {
        await new Promise((ok, ko) => { probe.onseeked = ok; probe.onerror = ko; probe.currentTime = t; setTimeout(ok, 2500); });
        // Recadrage centré (comme une vignette « cover ») dans chaque case.
        const cellW = (w / n) * ratio, cellH = hgt * ratio;
        const scale = Math.max(cellW / vw, cellH / vh);
        const sw = cellW / scale, sh = cellH / scale;
        ctx.drawImage(probe, (vw - sw) / 2, (vh - sh) / 2, sw, sh, i * cellW, 0, cellW + 1, cellH);
      } catch (e) { /* image manquante : la case reste sombre */ }
    }
    probe.removeAttribute('src');
    probe.load();
  }

  // ---------------------------------------------------------- poignées et fenêtre
  const timeAt = clientX => {
    const r = strip.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };
  const onDown = (what, e) => {
    if (!duration) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { what, x0: e.clientX, s0: start, e0: end, playing: !video.paused };
    video.pause();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignoré */ }
    el.classList.add('dragging');
  };
  const onMove = e => {
    if (!drag) return;
    const t = timeAt(e.clientX);
    if (drag.what === 'start') {
      start = Math.max(0, Math.min(t, end - MIN_SECONDS));
      if (end - start > maxSeconds) end = start + maxSeconds;   // la fenêtre suit : 90 s au plus
      video.currentTime = start;
    } else if (drag.what === 'end') {
      end = Math.min(duration, Math.max(t, start + MIN_SECONDS));
      if (end - start > maxSeconds) start = end - maxSeconds;
      video.currentTime = Math.max(start, end - 0.05);
    } else {
      const len = drag.e0 - drag.s0;
      const r = strip.getBoundingClientRect();
      const dt = ((e.clientX - drag.x0) / r.width) * duration;
      start = Math.max(0, Math.min(duration - len, drag.s0 + dt));
      end = start + len;
      video.currentTime = start;
    }
    paint();
  };
  const onUp = () => {
    if (!drag) return;
    const resume = drag.playing;
    drag = null;
    el.classList.remove('dragging');
    video.currentTime = start;
    if (resume) video.play().catch(() => {});
  };
  handleL.addEventListener('pointerdown', e => onDown('start', e));
  handleR.addEventListener('pointerdown', e => onDown('end', e));
  sel.addEventListener('pointerdown', e => { if (e.target === sel) onDown('move', e); });
  // Toucher la pellicule hors de la sélection : la fenêtre s'y déplace.
  strip.addEventListener('pointerdown', e => {
    if (!duration || e.target !== strip && e.target !== canvas && !e.target.classList.contains('vt-shade')) return;
    const t = timeAt(e.clientX), len = end - start;
    start = Math.max(0, Math.min(duration - len, t - len / 2));
    end = start + len;
    video.currentTime = start;
    paint();
  });
  [handleL, handleR, sel].forEach(x => {
    x.addEventListener('pointermove', onMove);
    x.addEventListener('pointerup', onUp);
    x.addEventListener('pointercancel', onUp);
  });
  // Clavier : flèches = ±0,5 s sur la poignée ciblée.
  const nudge = (which, d) => {
    if (which === 'start') start = Math.max(0, Math.min(end - MIN_SECONDS, start + d));
    else end = Math.min(duration, Math.max(start + MIN_SECONDS, end + d));
    if (end - start > maxSeconds) { if (which === 'start') end = start + maxSeconds; else start = end - maxSeconds; }
    video.currentTime = which === 'start' ? start : end - 0.05;
    paint();
  };
  handleL.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); nudge('start', e.key === 'ArrowLeft' ? -0.5 : 0.5); } });
  handleR.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); nudge('end', e.key === 'ArrowLeft' ? -0.5 : 0.5); } });

  // ---------------------------------------------------------- lecture en boucle dans la sélection
  const onTime = () => {
    if (!duration || drag) return;
    if (video.currentTime >= end - 0.03 || video.currentTime < start - 0.25) {
      video.currentTime = start;
      if (video.paused && !video.ended) return;
    }
    playhead.style.left = (video.currentTime / duration) * 100 + '%';
  };
  video.addEventListener('timeupdate', onTime);
  const tick = () => { if (!destroyed) { onTime(); requestAnimationFrame(tick); } };

  const init = () => {
    duration = video.duration;
    if (duration === Infinity) {
      // WebM enregistré par un navigateur : durée inconnue tant qu'on n'a pas lu jusqu'au bout.
      // Aller très loin la révèle (« durationchange »), puis on revient au début.
      video.addEventListener('durationchange', function once() {
        if (!isFinite(video.duration)) return;
        video.removeEventListener('durationchange', once);
        video.currentTime = 0;
        init();
      });
      video.currentTime = 1e101;
      return;
    }
    if (!duration || !isFinite(duration)) return;
    start = 0;
    end = Math.min(duration, maxSeconds);
    paint();
    requestAnimationFrame(tick);
    buildThumbs();
  };
  if (video.readyState >= 1) init(); else video.addEventListener('loadedmetadata', init, { once: true });

  return {
    el,
    range: () => ({ start, end }),
    trimmed: () => start > 0.05 || end < duration - 0.05,
    muted: () => mute,
    destroy: () => { destroyed = true; video.removeEventListener('timeupdate', onTime); },
  };
}
