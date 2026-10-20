// Notifications push (Web Push) : abonnement de l'appareil pour recevoir messages, appels et
// activité même quand Kozons est fermé.
import { api } from './api.js';
import { h, icon, modal, toast } from './ui.js';

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

// ------------------------------------------------------------------ invitation à activer les notifications

const ASK_KEY = 'kozons.pushAsk';
const DAY = 24 * 3600 * 1000;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function snoozed(days) {
  try { return Date.now() - (+localStorage.getItem(ASK_KEY) || 0) < days * DAY; } catch (e) { return false; }
}
function snooze() {
  try { localStorage.setItem(ASK_KEY, String(Date.now())); } catch (e) { /* stockage indisponible */ }
}

function promptBox(iconName, title, text, extra, actions) {
  return h('div.push-ask',
    h('div.push-ask-icon', icon(iconName, 34)),
    h('h3', title), h('p.muted', text), extra,
    h('div.push-ask-actions', actions));
}

/** À l'ouverture de l'application : propose d'activer les notifications (comme une application mobile).
 *  « Plus tard » : on redemande dans 3 jours. Bloquées : explication pour les réautoriser (tous les 14 jours).
 *  iPhone hors écran d'accueil : Safari n'autorise les notifications qu'aux applications installées. */
export function askForPush() {
  const support = pushSupport();
  if (support === 'granted' || support === 'insecure') return;
  if (support === 'unsupported') {
    if (!isIOS() || isInstalled() || snoozed(7)) return;
    const m = modal(promptBox('bell', 'Installez Kozons pour recevoir les notifications',
      'Sur iPhone, les notifications fonctionnent quand Kozons est ajouté à l’écran d’accueil :',
      h('ol.push-ask-steps', h('li', 'Touchez le bouton Partager ⬆️ en bas de Safari'), h('li', 'Choisissez « Sur l’écran d’accueil »'),
        h('li', 'Ouvrez Kozons depuis sa nouvelle icône et activez les notifications')),
      [h('button.btn.primary.block', { onclick: () => { snooze(); m.close(); } }, 'J’ai compris')]), { cls: 'push-modal' });
    return;
  }
  if (support === 'denied') {
    if (snoozed(14)) return;
    const m = modal(promptBox('bellOff', 'Notifications bloquées',
      'Vous ne recevrez ni messages ni appels quand Kozons est fermé. Pour les réactiver :',
      h('ol.push-ask-steps',
        h('li', isInstalled() ? 'Ouvrez les Paramètres du téléphone › Applications › Kozons' : 'Touchez le cadenas 🔒 à gauche de l’adresse du site'),
        h('li', 'Notifications › Autoriser'), h('li', 'Revenez sur Kozons')),
      [h('button.btn.primary.block', { onclick: () => { snooze(); m.close(); } }, 'J’ai compris')]), { cls: 'push-modal' });
    return;
  }
  if (snoozed(3)) return;
  const activate = h('button.btn.primary.block', { onclick: async () => {
    activate.disabled = true;
    const result = await enablePush();
    m.close();
    if (result === 'granted') toast('Notifications activées sur cet appareil ✅');
    else if (result === 'denied') { snooze(); toast('Notifications refusées. Vous pourrez les activer dans Paramètres.'); }
    else if (result !== 'default') toast('Impossible d’activer les notifications pour le moment.', { type: 'error' });
  } }, icon('bell', 18), ' Activer les notifications');
  const m = modal(promptBox('bell', 'Activer vos notifications',
    'Soyez prévenu comme avec une application mobile, même quand Kozons est fermé :',
    h('ul.push-ask-list',
      h('li', '💬 Nouveaux messages et appels entrants'),
      h('li', '❤️ Mentions, commentaires et abonnés'),
      h('li', '🛍️ Commandes de votre boutique'),
      h('li', '🔴 LIVE et réunions Meet')),
    [activate, h('button.btn.ghost.block', { onclick: () => { snooze(); m.close(); } }, 'Plus tard')]),
  { cls: 'push-modal', onClose: () => {} });
}
