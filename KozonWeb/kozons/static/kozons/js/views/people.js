// Retrouver des amis : lien d'invitation personnel (WhatsApp, SMS, e-mail…) et « Vous connaissez peut-être »
// (amis de vos amis, comme Facebook), pour créer une chaîne d'amitié.
import { api } from '../api.js';
import { state } from '../store.js';
import { h, clear, icon, btn, avatar, toast, errorToast, spinner, empty } from '../ui.js';
import { followButton } from './feed.js';

const go = path => window.kozons.go(path);

export function render(stage, params) {
  if (params.invite) return openInvite(stage, params.invite);
  const inviteBox = h('section.ppl-invite', spinner());
  const list = h('div.ppl-list', spinner());
  stage.appendChild(h('div.page.narrow.ppl-page',
    h('header.page-head', h('h2', 'Retrouver des amis')),
    inviteBox,
    h('div.list-title', 'Vous connaissez peut-être'),
    h('p.muted.small.ppl-hint', 'Les amis de vos amis et les personnes qui vous suivent.'),
    list));
  inviteCard(inviteBox);
  loadSuggestions(list, 40);
}

/** Lien /invite/<code> ouvert par quelqu'un qui a déjà un compte : on l'emmène sur le profil. */
async function openInvite(stage, code) {
  stage.appendChild(h('div.page.narrow', spinner()));
  try {
    const { inviter } = await api.get('invite/' + encodeURIComponent(code));
    if (inviter.username === state.me.username) toast('C’est votre propre lien d’invitation 😉');
    else toast(`Vous êtes déjà sur Kozons : voici le profil de ${inviter.name}.`);
    go(inviter.username === state.me.username ? '/people' : '/u/' + inviter.username);
  } catch (e) { toast('Invitation introuvable.'); go('/'); }
}

export async function inviteCard(box) {
  try {
    const { url, joined, recent } = await api.get('invite');
    const text = `Rejoins-moi sur Kozons : messages, appels audio et vidéo, statuts… gratuitement ! ${url}`;
    const enc = encodeURIComponent;
    const share = async () => {
      if (navigator.share) {
        try { await navigator.share({ title: 'Kozons', text: 'Rejoins-moi sur Kozons !', url }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
      copy();
    };
    const copy = async () => {
      try { await navigator.clipboard.writeText(url); toast('Lien copié ✅'); }
      catch (e) { field.select(); toast('Sélectionnez le lien pour le copier.'); }
    };
    const field = h('input.input.ppl-link', { value: url, readonly: true, onclick: e => e.target.select(), 'aria-label': 'Mon lien d’invitation' });
    const channel = (cls, label, ic, href) => h('a.ppl-chan.' + cls, { href, target: '_blank', rel: 'noopener' }, h('span.ppl-chan-ic', ic), h('small', label));
    clear(box,
      h('div.ppl-invite-head', h('div.ppl-invite-ic', icon('users', 26)),
        h('div', h('h3', 'Invitez vos amis sur Kozons'),
          h('p.muted.small', 'Quand quelqu’un s’inscrit avec votre lien, vous devenez amis automatiquement.'))),
      h('div.ppl-linkrow', field, btn('copy', 'Copier le lien', copy)),
      h('div.ppl-chans',
        channel('wa', 'WhatsApp', icon('chat', 20), `https://wa.me/?text=${enc(text)}`),
        channel('fb', 'Facebook', h('b', 'f'), `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`),
        channel('sms', 'SMS', icon('comment', 20), `sms:?&body=${enc(text)}`),
        channel('mail', 'E-mail', icon('doc', 20), `mailto:?subject=${enc('Rejoins-moi sur Kozons')}&body=${enc(text)}`),
        h('button.ppl-chan.more', { type: 'button', onclick: share }, h('span.ppl-chan-ic', icon('share', 20)), h('small', 'Plus'))),
      joined ? h('div.ppl-joined',
        h('div.ppl-avatars', recent.slice(0, 5).map(u => avatar(u.avatar, u.name, 28))),
        h('span.small', `${joined} personne${joined > 1 ? 's ont' : ' a'} rejoint Kozons grâce à vous 🎉`)) : null);
  } catch (e) { clear(box, h('p.muted', e.message)); }
}

/** Ligne de suggestion : photo, nom, raison (amis en commun…), S'abonner, écarter. */
function suggestionRow(u, onHide) {
  const row = h('div.ppl-row',
    h('button.ppl-who', { type: 'button', onclick: () => go('/u/' + u.username) }, avatar(u.avatar, u.name, 52),
      h('div.ppl-text', h('strong', u.name), h('small.muted', u.reason || '@' + u.username))),
    followButton(u.id, null),
    btn('close', 'Retirer cette suggestion', async () => {
      row.classList.add('leaving');
      setTimeout(() => { row.remove(); onHide && onHide(); }, 180);
      api.post(`suggestions/${u.id}/hide`).catch(() => {});
    }, 'ppl-hide'));
  return row;
}

async function loadSuggestions(list, limit) {
  try {
    const { results } = await api.get('suggestions', { limit });
    const paint = () => { if (!list.children.length) clear(list, empty('users', 'Aucune suggestion pour le moment', 'Invitez vos amis : leurs contacts apparaîtront ici.')); };
    clear(list, results.map(u => suggestionRow(u, paint)));
    paint();
  } catch (e) { clear(list, h('p.muted', e.message)); }
}

/** Carrousel « Vous connaissez peut-être » (fil d'actualité), comme Facebook. */
export function suggestionCarousel() {
  const track = h('div.ppl-track');
  const box = h('section.ppl-carousel.hidden',
    h('div.ppl-carousel-head', h('strong', 'Vous connaissez peut-être'), h('button.link', { type: 'button', onclick: () => go('/people') }, 'Voir tout')),
    track);
  api.get('suggestions', { limit: 12 }).then(({ results }) => {
    if (!results.length) return;
    const card = u => {
      const el = h('div.ppl-card',
        btn('close', 'Retirer', () => {
          el.classList.add('leaving');
          setTimeout(() => { el.remove(); if (!track.children.length) box.remove(); }, 180);
          api.post(`suggestions/${u.id}/hide`).catch(() => {});
        }, 'ppl-hide'),
        h('button.ppl-card-who', { type: 'button', onclick: () => go('/u/' + u.username) }, avatar(u.avatar, u.name, 72),
          h('strong', u.name), h('small.muted', u.reason || '')),
        followButton(u.id, null));
      return el;
    };
    clear(track, results.map(card), h('button.ppl-card.ppl-card-invite', { type: 'button', onclick: () => go('/people') },
      h('div.ppl-invite-ic', icon('plus', 26)), h('strong', 'Inviter des amis'), h('small.muted', 'Partager mon lien')));
    box.classList.remove('hidden');
  }).catch(() => {});
  return box;
}
