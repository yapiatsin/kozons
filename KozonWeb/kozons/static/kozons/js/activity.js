// Présence de l'utilisateur sur la plateforme : onglet visible, fenêtre au premier plan et
// activité récente (clic, touche, défilement…). Sert à l'indicateur « en ligne » et à la
// déconnexion automatique après une longue absence.

const IDLE_AWAY_MS = 5 * 60 * 1000;   // sans interaction depuis 5 min : « absent »
const STORAGE_KEY = 'kozons.lastActive';
let lastInput = Date.now();
let active = null;
const listeners = new Set();

function computeActive() {
  return document.visibilityState === 'visible' && document.hasFocus() && Date.now() - lastInput < IDLE_AWAY_MS;
}

/** Dernière présence réelle, partagée entre onglets (localStorage) : survit à la fermeture. */
export function lastActiveAt() {
  try { return Number(localStorage.getItem(STORAGE_KEY)) || Date.now(); } catch (e) { return lastInput; }
}

function remember() {
  try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch (e) { /* ignoré */ }
}

export function isActive() {
  return active ?? computeActive();
}

/** Appelé à chaque changement actif <-> absent. Retourne une fonction de désabonnement. */
export function onActivityChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function refresh() {
  const now = computeActive();
  if (now) remember();
  if (now !== active) {
    active = now;
    listeners.forEach(fn => { try { fn(now); } catch (e) { console.error(e); } });
  }
}

let throttled = 0;
function onInput() {
  lastInput = Date.now();
  if (Date.now() - throttled > 15000 || !active) { throttled = Date.now(); refresh(); }
}

['pointerdown', 'keydown', 'touchstart', 'wheel', 'mousemove'].forEach(evt =>
  window.addEventListener(evt, onInput, { passive: true, capture: true }));
document.addEventListener('visibilitychange', refresh);
window.addEventListener('focus', () => { lastInput = Date.now(); refresh(); });
window.addEventListener('blur', refresh);
window.addEventListener('pagehide', () => { active = false; listeners.forEach(fn => fn(false)); });
setInterval(refresh, 15000); // détecte l'inactivité (plus d'interaction depuis 5 min)
refresh();
