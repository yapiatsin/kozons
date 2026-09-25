// Notifications (J'aime, commentaires, abonnements, mentions) et demandes d'abonnement.
import { api } from '../api.js';
import { bus, state } from '../store.js';
import { h, clear, avatar, ago, spinner, empty, errorToast } from '../ui.js';
import { followButton, openPost } from './feed.js';

const VERBS = {
  like: "a aimé votre publication.",
  comment: 'a commenté :',
  reply: 'a répondu à votre commentaire :',
  follow: 'a commencé à vous suivre.',
  follow_request: 'souhaite vous suivre.',
  follow_accept: 'a accepté votre demande d\'abonnement.',
  mention: 'vous a mentionné(e).',
  comment_like: 'a aimé votre commentaire :',
  story_like: 'a aimé votre story.',
};

export function render(stage) {
  const reqs = h('div');
  const list = h('div', spinner());
  stage.appendChild(h('div.page.narrow', h('header.page-head', h('h2', 'Notifications')), reqs, list));

  const load = async () => {
    try {
      const [{ results }, { results: requests }] = await Promise.all([api.get('notifications'), api.get('follow-requests')]);
      clear(reqs, requests.length ? [h('div.list-title', `Demandes d'abonnement (${requests.length})`), requests.map(u => h('div.notif-row',
        h('button.row.grow', { type: 'button', onclick: () => window.kozons.go('/u/' + u.username) }, avatar(u.avatar, u.name, 44),
          h('div', h('div.strong', u.username), h('div.muted.small', u.name))),
        h('button.btn.primary.small', { onclick: () => respond(u, 'accept') }, 'Confirmer'),
        h('button.btn.ghost.small', { onclick: () => respond(u, 'reject') }, 'Supprimer')))] : null);
      clear(list, results.length ? results.filter(n => n.verb !== 'follow_request').map(n => h('div.notif-row' + (n.read ? '' : '.unread'),
        h('button', { type: 'button', onclick: () => window.kozons.go('/u/' + n.actor.username) }, avatar(n.actor.avatar, n.actor.name, 44)),
        h('div.grow.notif-text', { onclick: () => n.post_id ? openPostById(n.post_id) : window.kozons.go('/u/' + n.actor.username) },
          h('strong', n.actor.username), ' ', VERBS[n.verb] || '', n.comment ? ' ' + n.comment : '', h('span.muted', ' ' + ago(n.created_at))),
        n.post_thumb ? h('img.notif-thumb', { src: n.post_thumb, alt: '', onclick: () => openPostById(n.post_id) })
          : n.verb === 'follow' ? followButton(n.actor.id, null) : null))
        : empty('heart', 'Aucune activité', "Quand quelqu'un aimera ou commentera vos publications, vous le verrez ici."));
      await api.post('notifications');
      state.notifications.requests = requests.length;
      bus.emit('notifications:seen');
    } catch (e) { errorToast(e); }
  };
  const respond = async (u, action) => {
    try { await api.post(`users/${u.id}/follow-request`, { action }); load(); } catch (e) { errorToast(e); }
  };
  load();
  return bus.on('notification', load);
}

function openPostById(id) {
  openPost(id);
}
