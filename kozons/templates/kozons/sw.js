// Service worker Kozons : installation (PWA) et notifications push, même application fermée.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const ICON = '/static/kozons/icon-192.png';
const BADGE = '/static/kozons/badge-96.png';

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'Kozons', body: event.data ? event.data.text() : '' }; }
  const isCall = data.kind === 'call';
  const options = {
    body: data.body || '',
    icon: data.icon || ICON,
    badge: BADGE,
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),          // re-sonne même si la notification du même fil existe déjà
    requireInteraction: isCall,           // un appel reste affiché jusqu'à une action
    vibrate: isCall ? [400, 200, 400, 200, 400, 200, 400] : [120, 60, 120],
    timestamp: data.timestamp || Date.now(),
    data: { url: data.url || '/', kind: data.kind },
    actions: isCall ? [{ action: 'open', title: 'Répondre' }] : [],
  };
  // Le navigateur exige d'afficher une notification pour chaque push reçu.
  event.waitUntil(self.registration.showNotification(data.title || 'Kozons', options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ('focus' in client) {
        client.postMessage({ type: 'open', url });
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});

// Le navigateur a renouvelé l'abonnement (clé ou point d'accès expiré) : on se réabonne.
// L'enregistrement côté serveur se fait à la prochaine ouverture de l'application (requête
// protégée par CSRF) : un service worker ne doit pas pouvoir abonner un appareil sans elle.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const res = await fetch('/api/push/key', { credentials: 'same-origin' });
    const { public_key: key } = await res.json();
    if (!key) return;
    const padding = '='.repeat((4 - key.length % 4) % 4);
    const raw = atob((key + padding).replace(/-/g, '+').replace(/_/g, '/'));
    await self.registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)),
    });
  })());
});
