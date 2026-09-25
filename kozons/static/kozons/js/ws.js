// WebSocket unique avec reconnexion automatique (backoff exponentiel) et heartbeat.
import { bus } from './store.js';

let socket = null;
let attempts = 0;
let heartbeat = null;
let closedByUs = false;
const queue = [];

export function connect() {
  closedByUs = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws/`);

  socket.onopen = () => {
    const reconnected = attempts > 0;
    attempts = 0;
    bus.emit('ws:status', 'online');
    if (reconnected) bus.emit('ws:reconnected');
    while (queue.length) socket.send(queue.shift());
    clearInterval(heartbeat);
    heartbeat = setInterval(() => send('ping', { t: Date.now() }), 25000);
  };

  socket.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    bus.emit(msg.type, msg.data);
  };

  socket.onclose = e => {
    clearInterval(heartbeat);
    bus.emit('ws:status', 'offline');
    if (closedByUs || e.code === 4401) return;
    const delay = Math.min(30000, 500 * 2 ** attempts) + Math.random() * 500;
    attempts++;
    setTimeout(connect, delay);
  };

  socket.onerror = () => socket.close();
}

export function disconnect() {
  closedByUs = true;
  clearInterval(heartbeat);
  if (socket) socket.close();
}

export function send(type, data = {}) {
  const payload = JSON.stringify({ type, ...data });
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
  else if (type !== 'ping' && type !== 'typing') queue.push(payload);
}

// Reconnexion immédiate au retour du réseau ou de l'onglet.
window.addEventListener('online', () => { if (!socket || socket.readyState > 1) { attempts = 0; connect(); } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && socket && socket.readyState > 1 && !closedByUs) { attempts = 0; connect(); }
});
