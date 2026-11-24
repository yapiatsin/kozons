// Reels : vidéos verticales plein écran avec défilement magnétique et lecture auto.
import { api } from '../api.js';
import { h, icon, btn, avatar, compact, richText, onVisible, spinner, empty, errorToast } from '../ui.js';
import { openPost, sharePost, followButton } from './feed.js';

let muted = true;

export function render(stage) {
  const list = h('div.reels');
  const sentinel = h('div.sentinel');
  list.appendChild(sentinel);
  stage.appendChild(h('div.reels-page', list));

  const io = new IntersectionObserver(entries => entries.forEach(e => {
    const v = e.target.querySelector('video');
    if (!v) return;
    if (e.isIntersecting) { v.muted = muted; v.play().catch(() => {}); } else { v.pause(); }
  }), { root: list, threshold: 0.65 });

  let before = null, hasMore = true, loading = false;
  const load = async () => {
    if (loading || !hasMore) return;
    loading = true;
    sentinel.replaceChildren(spinner());
    try {
      const res = await api.get('reels', { before });
      res.results.forEach(p => { const el = reel(p); list.insertBefore(el, sentinel); io.observe(el); });
      hasMore = res.has_more;
      if (res.results.length) before = res.results[res.results.length - 1].id;
      if (list.children.length === 1) list.insertBefore(empty('reels', 'Aucun reel', 'Publiez une vidéo en tant que reel pour la voir ici.'), sentinel);
    } catch (e) { errorToast(e); }
    sentinel.replaceChildren();
    loading = false;
  };
  const stop = onVisible(sentinel, load, list);
  load();
  return () => { stop(); io.disconnect(); list.querySelectorAll('video').forEach(v => v.pause()); };
}

function reel(post) {
  const m = post.media[0];
  const video = h('video', { src: m.url, loop: true, playsinline: true, preload: 'metadata', muted: true });
  const muteB = btn(muted ? 'volumeOff' : 'volume', 'Son', () => {
    muted = !muted;
    document.querySelectorAll('.reel video').forEach(v => { v.muted = muted; });
    document.querySelectorAll('.reel .mute-btn').forEach(b => b.replaceChildren(icon(muted ? 'volumeOff' : 'volume')));
  }, 'mute-btn');
  video.addEventListener('click', () => (video.paused ? video.play() : video.pause()));
  const likeB = h('button.reel-action' + (post.liked ? '.liked' : ''), { type: 'button' }, icon('heart', 28), h('span', post.like_count === null ? '' : compact(post.like_count)));
  likeB.onclick = async () => {
    try {
      const r = await api.post(`posts/${post.id}/like`);
      post.liked = r.liked; post.like_count = r.like_count;
      likeB.classList.toggle('liked', r.liked);
      likeB.lastChild.textContent = post.hide_likes && !post.own ? '' : compact(r.like_count);
    } catch (e) { errorToast(e); }
  };
  video.addEventListener('dblclick', () => { if (!post.liked) likeB.click(); });
  return h('div.reel',
    video,
    muteB,
    h('div.reel-info',
      h('div.row.gap',
        h('button.row', { type: 'button', onclick: () => window.kozons.go('/u/' + post.author.username) }, avatar(post.author.avatar, post.author.name, 32), h('strong', post.author.username)),
        !post.own ? followButton(post.author.id, null, 'btn') : null),
      post.caption ? h('div.reel-caption', richText(post.caption)) : null),
    h('div.reel-actions',
      likeB,
      h('button.reel-action', { type: 'button', onclick: () => openPost(post) }, icon('comment', 28), h('span', compact(post.comment_count))),
      h('button.reel-action', { type: 'button', onclick: () => sharePost(post) }, icon('send', 28))));
}
