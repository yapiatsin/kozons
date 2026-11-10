// WebSocket unique avec reconnexion automatique (backoff exponentiel) et heartbeat.
//
// Une seule connexion à la fois : une reconnexion ne laisse jamais l'ancienne WebSocket ouverte
// (sinon le serveur garderait une connexion « fantôme », visible par ex. en double dans une réunion).
import { bus } from './store.js';
import { isActive, onActivityChange } from './activity.js';

let socket = null;
let attempts = 0;
let heartbeat = null;
let retryTimer = null;
let closedByUs = false;
let everOpened = false;
const queue = [];

function detach(ws) {
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  try { ws.close(); } catch (e) { /* déjà fermée */ }
}

export function connect() {
  closedByUs = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  // Déjà connectée ou en cours de connexion : rien à faire.
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  detach(socket);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/`);
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    const reconnected = everOpened;
    everOpened = true;
    attempts = 0;
    bus.emit('ws:status', 'online');
    while (queue.length) ws.send(queue.shift());
    // « En ligne » seulement si l'utilisateur est réellement présent sur la plateforme.
    send('presence', { active: isActive() });
    clearInterval(heartbeat);
    heartbeat = setInterval(() => send('ping', { t: Date.now(), active: isActive() }), 25000);
    if (reconnected) bus.emit('ws:reconnected');
  };

  ws.onmessage = e => {
    if (socket !== ws) return;  // ancienne connexion : ses messages sont ignorés
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    bus.emit(msg.type, msg.data);
  };

  ws.onclose = e => {
    if (socket !== ws) return;
    clearInterval(heartbeat);
    bus.emit('ws:status', 'offline');
    if (e.code === 4401) { window.dispatchEvent(new Event('kozons:unauthorized')); return; } // session expirée
    if (closedByUs) return;
    scheduleReconnect();
  };

  ws.onerror = () => { if (socket === ws) ws.close(); };
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  const delay = Math.min(30000, 500 * 2 ** attempts) + Math.random() * 500;
  attempts++;
  retryTimer = setTimeout(connect, delay);
}

export function disconnect() {
  closedByUs = true;
  clearTimeout(retryTimer);
  clearInterval(heartbeat);
  detach(socket);
  socket = null;
  everOpened = false;
}

export function send(type, data = {}) {
  const payload = JSON.stringify({ type, ...data });
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
  else if (type !== 'ping' && type !== 'typing' && type !== 'presence') queue.push(payload);
}

/** Identifiant de cet onglet (nouveau à chaque chargement de page) : le serveur distingue ainsi une
 *  reconnexion du même onglet d'une seconde fenêtre / d'un autre appareil. */
export const TAB_ID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2);

// Passage actif <-> absent (onglet masqué, fenêtre en arrière-plan, inactivité) : signalé aussitôt.
onActivityChange(active => send('presence', { active }));

// Reconnexion immédiate au retour du réseau ou de l'onglet (connect() ignore une connexion déjà active).
// (Jamais avant le premier connect() : pas de connexion depuis l'écran de connexion.)
const reconnectNow = () => { if (!closedByUs && socket && socket.readyState > WebSocket.OPEN) { attempts = 0; connect(); } };
window.addEventListener('online', reconnectNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconnectNow(); });
