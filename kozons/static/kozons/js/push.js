// Notifications push (Web Push) : abonnement de l'appareil pour recevoir messages, appels et
// activité même quand Kozons est fermé.
import { api } from './api.js';

export function pushSupport() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

function keyToBytes(key) {
  const padding = '='.repeat((4 - key.length % 4) % 4);
  const raw = atob((key + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function sameKey(sub, key) {
  const current = sub.options && sub.options.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current), b = keyToBytes(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function subscribe() {
  const { enabled, public_key: key } = await api.get('push/key');
  if (!enabled || !key) return false;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; } // clés du serveur changées
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) });
  await api.post('push/subscribe', sub.toJSON());
  return true;
}

/** À chaque ouverture : si la permission est déjà accordée, (ré)enregistre l'appareil sans rien demander. */
export async function syncPush() {
  if (pushSupport() !== 'granted') return false;
  try { return await subscribe(); } catch (e) { console.warn('[push]', e); return false; }
}

/** Demande la permission (doit suivre un clic) puis abonne l'appareil. Retourne l'état final. */
export async function enablePush() {
  const support = pushSupport();
  if (support === 'unsupported' || support === 'insecure' || support === 'denied') return support;
  const permission = support === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  try { await subscribe(); } catch (e) { console.warn('[push]', e); return 'error'; }
  return 'granted';
}

/** Déconnexion : l'appareil ne doit plus recevoir les notifications de ce compte. */
export async function disablePush() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (!sub) return;
    await api.post('push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  } catch (e) { /* ignoré : la déconnexion ne doit jamais échouer pour ça */ }
}
