// Profil façon Instagram : en-tête, statistiques, grille, abonnés/abonnements.
import { api } from '../api.js';
import { state } from '../store.js';
import { h, clear, icon, btn, avatar, compact, richText, menu, modal, toast, errorToast, confirmDialog, onVisible, spinner, empty, lightbox } from '../ui.js';
import { followButton, createPostDialog } from './feed.js';
import { postGrid } from './explore.js';
import { fetchStories, openViewer, createStoryDialog } from './stories.js';
import { startCall } from './calls.js';

export function render(stage, params) {
  const page = h('div.page.profile-page', spinner());
  stage.appendChild(page);
  let stopGrid = null;
  load();

  async function load() {
    let p;
    try { p = await api.get(`profiles/${encodeURIComponent(params.username)}`); }
    catch (e) { return clear(page, empty('user', 'Profil introuvable', "Ce compte n'existe pas ou n'est plus disponible.")); }

    const openStory = async () => {
      const groups = await fetchStories();
      const idx = groups.findIndex(g => g.user.id === p.id);
      if (idx >= 0) openViewer(groups, idx, load);
      else if (p.avatar) lightbox(p.avatar);
    };
    const message = async () => {
      try { const c = await api.post('conversations/direct', { user_id: p.id }); window.kozons.go('/chats/' + c.id); } catch (e) { errorToast(e); }
    };

    const actions = p.is_me
      ? [h('button.btn.ghost.small', { onclick: () => window.kozons.go('/settings') }, 'Modifier le profil'),
        h('button.btn.ghost.small', { onclick: () => createStoryDialog(load) }, 'Ajouter une story'),
        btn('settings', 'Paramètres', () => window.kozons.go('/settings'))]
      : [followButton(p.id, p.follow_status),
        h('button.btn.ghost.small', { onclick: message }, 'Écrire'),
        btn('phone', 'Appeler', () => startCall(p, false)),
        btn('moreH', 'Plus', e => menu(e.currentTarget, [
          { label: 'Appel vidéo', icon: 'video', action: () => startCall(p, true) },
          p.follow_status === 'following' ? { label: p.is_close_friend ? 'Retirer des amis proches' : 'Ajouter aux amis proches', icon: 'star', action: async () => {
            try { const r = await api.post(`users/${p.id}/close-friend`); p.is_close_friend = r.close_friend; toast(r.close_friend ? 'Ajouté(e) aux amis proches' : 'Retiré(e) des amis proches'); } catch (e) { errorToast(e); }
          } } : null,
          p.follows_you ? { label: 'Retirer cet abonné', icon: 'users', action: async () => {
            try { await api.post(`users/${p.id}/remove-follower`); toast('Abonné retiré'); load(); } catch (e) { errorToast(e); }
          } } : null,
          { label: 'Copier le lien du profil', icon: 'link', action: () => navigator.clipboard.writeText(`${location.origin}/u/${p.username}`).then(() => toast('Lien copié')) },
          '-',
          { label: p.blocked ? 'Débloquer' : 'Bloquer', icon: 'block', danger: !p.blocked, action: async () => {
            if (!p.blocked && !await confirmDialog(`Bloquer ${p.username} ? Il/elle ne pourra plus vous contacter ni voir vos publications.`, { ok: 'Bloquer', danger: true })) return;
            try { await api.post(`users/${p.id}/block`); load(); } catch (e) { errorToast(e); }
          } },
        ]))];

    // Zones indépendantes placées par une grille CSS : disposition « bureau » (avatar à gauche,
    // tout le reste à droite) ou « mobile » façon Instagram (chiffres à côté de l'avatar, boutons pleine largeur).
    const stat = (n, label, onclick) => h('button.stat', { type: 'button', onclick, disabled: !onclick }, h('strong', compact(n)), h('span', label));
    const header = h('header.profile-head',
      h('button.profile-avatar', { type: 'button', onclick: openStory, 'aria-label': p.has_story ? 'Voir la story' : 'Photo de profil' },
        avatar(p.avatar, p.name, 150, { ring: p.has_story ? 'new' : null })),
      h('div.profile-title', h('h2', p.username), p.is_private ? icon('lock', 18) : null),
      h('div.profile-actions', ...actions),
      h('div.profile-stats',
        stat(p.post_count, 'publications'),
        stat(p.followers, 'abonnés', p.can_view ? () => followList(p, 'followers') : null),
        stat(p.following, 'abonnements', p.can_view ? () => followList(p, 'following') : null)),
      h('div.profile-bio',
        p.name && p.name !== p.username ? h('div.strong', p.name) : h('div.strong', p.username),
        p.bio ? h('div.pre.bio', richText(p.bio)) : null,
        p.website ? h('a.website', { href: p.website, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 14), ' ', p.website.replace(/^https?:\/\//, '')) : null,
        p.follows_you && !p.is_me ? h('div.muted.small', 'Vous suit') : null));

    const tabs = h('div.profile-tabs');
    const grid = h('div.post-grid');
    const sentinel = h('div.sentinel');
    const tabDefs = [['posts', 'grid', 'Publications'], ['reels', 'reels', 'Reels'], ['tagged', 'user', 'Identifié(e)']];
    if (p.is_me) tabDefs.splice(2, 0, ['saved', 'bookmark', 'Enregistrements'], ['archived', 'archive', 'Archives']);

    let tab = 'posts', before = null, hasMore = true, loading = false;
    const loadGrid = async (reset) => {
      if (reset) { before = null; hasMore = true; clear(grid); }
      if (loading || !hasMore) return;
      loading = true;
      sentinel.replaceChildren(spinner());
      try {
        const res = await api.get(`profiles/${encodeURIComponent(p.username)}/posts`, { tab, before });
        grid.append(...postGrid(res.results));
        hasMore = res.has_more;
        if (res.results.length) before = res.results[res.results.length - 1].id;
        if (!grid.children.length) {
          grid.appendChild(p.is_me && tab === 'posts'
            ? empty('camera', 'Partagez des photos', 'Vos publications apparaîtront sur votre profil.', h('button.btn.primary', { onclick: () => createPostDialog() }, 'Partager votre première photo'))
            : empty('image', 'Aucune publication', null));
        }
      } catch (e) { errorToast(e); }
      sentinel.replaceChildren();
      loading = false;
    };
    tabDefs.forEach(([key, ic, label]) => tabs.appendChild(h('button' + (key === tab ? '.active' : ''), {
      type: 'button',
      onclick: e => { tab = key; tabs.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); loadGrid(true); },
      title: label, 'aria-label': label,
    }, icon(ic, 16), h('span.tab-label', label))));

    let body;
    if (p.blocked) body = empty('block', 'Vous avez bloqué ce compte', 'Débloquez-le pour voir ses publications.');
    else if (!p.can_view) body = empty('lock', 'Ce compte est privé', 'Abonnez-vous pour voir ses photos et vidéos.');
    else body = h('div', tabs, grid, sentinel);

    clear(page, header, body);
    if (stopGrid) stopGrid();
    if (p.can_view && !p.blocked) { stopGrid = onVisible(sentinel, () => loadGrid()); loadGrid(true); }
  }
  return () => stopGrid && stopGrid();
}

async function followList(p, which) {
  const body = h('div.pick-list', spinner());
  const m = modal(body, { title: which === 'followers' ? 'Abonnés' : 'Abonnements' });
  try {
    const { results } = await api.get(`profiles/${encodeURIComponent(p.username)}/${which}`);
    clear(body, results.length ? results.map(u => h('div.pick-item',
      h('button.row.grow', { type: 'button', onclick: () => { m.close(); window.kozons.go('/u/' + u.username); } }, avatar(u.avatar, u.name, 44),
        h('div.pick-text', h('div.strong', u.username), h('div.muted', u.name))),
      u.id !== state.me.id ? followButton(u.id, u.followed ? 'following' : null) : null)) : h('p.muted.pad', 'Personne pour le moment.'));
  } catch (e) { clear(body, h('p.muted', e.message)); }
}
