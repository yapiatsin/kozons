// Explorer : recherche de comptes / hashtags et grille de publications.
import { api } from '../api.js';
import { h, clear, icon, avatar, debounce, onVisible, spinner, empty, errorToast, compact } from '../ui.js';
import { openPost } from './feed.js';

export function postGrid(posts, { onOpen } = {}) {
  return posts.map(p => {
    const first = p.media[0];
    return h('button.grid-item', { type: 'button', onclick: () => (onOpen || openPost)(p) },
      first && first.kind === 'video' ? h('video', { src: first.url, muted: true, preload: 'metadata' }) : h('img', { src: first ? first.url : '', alt: '', loading: 'lazy' }),
      p.media.length > 1 ? h('span.grid-badge', icon('grid', 16)) : p.is_reel || (first && first.kind === 'video') ? h('span.grid-badge', icon('reels', 16)) : null,
      h('div.grid-hover', p.like_count !== null ? h('span', icon('heart', 18), ' ', compact(p.like_count)) : null, h('span', icon('comment', 18), ' ', compact(p.comment_count))));
  });
}

export function render(stage, params) {
  const input = h('input.search-input', { type: 'search', placeholder: 'Rechercher des comptes, #hashtags, lieux', value: params.q || '' });
  const users = h('div.user-results');
  const grid = h('div.post-grid');
  const sentinel = h('div.sentinel');
  stage.appendChild(h('div.page', h('div.search-box.big', icon('search', 18), input), users, grid, sentinel));

  let before = null, hasMore = true, loading = false, query = params.q || '';
  const loadPosts = async (reset = false) => {
    if (reset) { before = null; hasMore = true; clear(grid); }
    if (loading || !hasMore) return;
    loading = true;
    sentinel.replaceChildren(spinner());
    try {
      const res = await api.get('explore', { q: query, before });
      grid.append(...postGrid(res.results));
      hasMore = res.has_more;
      if (res.results.length) before = res.results[res.results.length - 1].id;
      if (!grid.children.length) grid.appendChild(empty('explore', query ? 'Aucun résultat' : 'Rien à explorer pour le moment', query ? 'Essayez un autre mot-clé.' : 'Les publications publiques apparaîtront ici.'));
    } catch (e) { errorToast(e); }
    sentinel.replaceChildren();
    loading = false;
  };
  const searchUsers = async () => {
    if (!query || query.startsWith('#')) return clear(users);
    try {
      const { results } = await api.get('users/search', { q: query });
      clear(users, results.slice(0, 8).map(u => h('button.user-result', { type: 'button', onclick: () => window.kozons.go('/u/' + u.username) },
        avatar(u.avatar, u.name, 44), h('div', h('div.strong', u.username), h('div.muted.small', u.name)))));
    } catch (e) { /* ignoré */ }
  };
  input.addEventListener('input', debounce(() => {
    query = input.value.trim();
    history.replaceState({}, '', query ? '/explore?q=' + encodeURIComponent(query) : '/explore');
    searchUsers();
    loadPosts(true);
  }, 300));
  const stop = onVisible(sentinel, () => loadPosts());
  searchUsers();
  loadPosts();
  return stop;
}
