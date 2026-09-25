// Fil d'actualité, carte de publication, détail avec commentaires, création de publication.
import { api } from '../api.js';
import { state } from '../store.js';
import { h, clear, icon, btn, avatar, ago, compact, richText, menu, modal, toast, errorToast, confirmDialog, promptDialog, pickFiles, onVisible, spinner, empty } from '../ui.js';
import { storiesBar } from './stories.js';
import { chooseConversations } from './dialogs.js';

export function render(stage) {
  const posts = h('div.feed-posts');
  const sentinel = h('div.sentinel');
  const bar = storiesBar();
  const side = h('aside.feed-side');
  const page = h('div.feed-page', h('div.feed-main', bar, posts, sentinel), side);
  stage.appendChild(page);

  let before = null, hasMore = true, loading = false;
  const load = async () => {
    if (loading || !hasMore) return;
    loading = true;
    sentinel.replaceChildren(spinner());
    try {
      const res = await api.get('feed', { before });
      res.results.forEach(p => posts.appendChild(postCard(p)));
      hasMore = res.has_more;
      if (res.results.length) before = res.results[res.results.length - 1].id;
      if (!posts.children.length) {
        posts.appendChild(empty('home', 'Bienvenue sur Kozons', 'Suivez des comptes pour voir leurs photos et vidéos ici.',
          h('button.btn.primary', { onclick: () => window.kozons.go('/explore') }, 'Découvrir des comptes')));
      }
    } catch (e) { errorToast(e); }
    sentinel.replaceChildren();
    loading = false;
  };
  const stopObs = onVisible(sentinel, load);
  load();
  renderSuggestions(side);
  return () => { stopObs(); bar.cleanup && bar.cleanup(); };
}

async function renderSuggestions(side) {
  try {
    const { results } = await api.get('suggestions');
    clear(side,
      h('div.row.me-card', avatar(state.me.avatar, state.me.name, 48),
        h('div.grow', h('a.strong', { href: '/u/' + state.me.username, onclick: e => { e.preventDefault(); window.kozons.go('/u/' + state.me.username); } }, state.me.username), h('div.muted', state.me.name))),
      results.length ? h('div.list-title', 'Suggestions pour vous') : null,
      results.slice(0, 8).map(u => h('div.row.suggestion',
        h('button.row.grow', { type: 'button', onclick: () => window.kozons.go('/u/' + u.username) }, avatar(u.avatar, u.name, 36),
          h('div.grow', h('div.strong', u.username), h('div.muted.small', u.name))),
        followButton(u.id, null, 'link'))),
      h('p.muted.small.footer-note', '© 2026 Kozons'));
  } catch (e) { /* facultatif */ }
}

export function followButton(userId, status, style = 'btn') {
  const b = h(style === 'link' ? 'button.link' : 'button.btn.primary.small', { type: 'button' });
  const set = s => {
    status = s;
    b.textContent = s === 'following' ? 'Abonné(e)' : s === 'requested' ? 'Demandé' : "S'abonner";
    if (style !== 'link') b.className = 'btn small ' + (s ? 'ghost' : 'primary');
  };
  set(status);
  b.onclick = async () => {
    if (status === 'following' && !await confirmDialog('Se désabonner ?', { ok: 'Se désabonner', danger: true })) return;
    try { const r = await api.post(`users/${userId}/follow`); set(r.follow_status); } catch (e) { errorToast(e); }
  };
  return b;
}

// ------------------------------------------------------------------ carte de publication

export function postCard(post, { onDeleted } = {}) {
  let index = 0;
  const track = h('div.carousel-track');
  post.media.forEach(m => track.appendChild(m.kind === 'video'
    ? h('video', { src: m.url, loop: true, muted: true, playsinline: true, preload: 'metadata', onclick: e => { const v = e.currentTarget; v.paused ? v.play() : v.pause(); } })
    : h('img', { src: m.url, alt: '', loading: 'lazy', draggable: 'false' })));
  const dots = post.media.length > 1 ? h('div.carousel-dots', post.media.map((_, i) => h('span' + (i === 0 ? '.on' : '')))) : null;
  const go = i => {
    index = Math.max(0, Math.min(post.media.length - 1, i));
    track.style.transform = `translateX(-${index * 100}%)`;
    if (dots) [...dots.children].forEach((d, j) => d.classList.toggle('on', j === index));
    prevB.classList.toggle('hidden', index === 0);
    nextB.classList.toggle('hidden', index === post.media.length - 1);
    track.querySelectorAll('video').forEach((v, j) => j === index ? v.play().catch(() => {}) : v.pause());
  };
  const prevB = h('button.carousel-nav.prev.hidden', { type: 'button', 'aria-label': 'Précédent', onclick: () => go(index - 1) }, '‹');
  const nextB = h('button.carousel-nav.next' + (post.media.length > 1 ? '' : '.hidden'), { type: 'button', 'aria-label': 'Suivant', onclick: () => go(index + 1) }, '›');
  const heart = h('div.big-heart', icon('heart', 96));
  const media = h('div.post-media', track, prevB, nextB, dots, heart);

  // Glisser pour changer de média (tactile).
  let touchX = null;
  media.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  media.addEventListener('touchend', e => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) go(index + (dx < 0 ? 1 : -1));
    touchX = null;
  });

  const likeBtn = h('button.icon-btn' + (post.liked ? '.liked' : ''), { type: 'button', 'aria-label': "J'aime" }, icon('heart', 26));
  const likes = h('button.post-likes', { type: 'button', onclick: () => likersDialog(post) });
  const renderLikes = () => { likes.textContent = post.like_count === null ? '' : `${compact(post.like_count)} J'aime`; likes.classList.toggle('hidden', !post.like_count); };
  renderLikes();
  const toggleLike = async (forceLike = false) => {
    if (forceLike && post.liked) return;
    post.liked = !post.liked;
    if (post.like_count !== null) post.like_count += post.liked ? 1 : -1;
    likeBtn.classList.toggle('liked', post.liked);
    renderLikes();
    try { const r = await api.post(`posts/${post.id}/like`); post.liked = r.liked; if (post.like_count !== null) post.like_count = r.like_count; renderLikes(); likeBtn.classList.toggle('liked', post.liked); }
    catch (e) { errorToast(e); }
  };
  likeBtn.onclick = () => toggleLike();
  media.addEventListener('dblclick', () => {
    heart.classList.remove('pop'); void heart.offsetWidth; heart.classList.add('pop');
    toggleLike(true);
  });

  const saveBtn = h('button.icon-btn' + (post.saved ? '.saved' : ''), {
    type: 'button', 'aria-label': 'Enregistrer',
    onclick: async () => {
      try { const r = await api.post(`posts/${post.id}/save`); post.saved = r.saved; saveBtn.classList.toggle('saved', r.saved); toast(r.saved ? 'Publication enregistrée' : 'Retirée des enregistrements'); }
      catch (e) { errorToast(e); }
    },
  }, icon('bookmark', 24));

  const card = h('article.post-card',
    h('header.post-head',
      h('button.row', { type: 'button', onclick: () => window.kozons.go('/u/' + post.author.username) },
        avatar(post.author.avatar, post.author.name, 34),
        h('div', h('div.strong', post.author.username), post.location ? h('div.small', post.location) : null)),
      h('span.muted.small', ' • ' + ago(post.created_at)),
      h('div.grow'),
      btn('moreH', 'Options', e => postMenu(post, e.currentTarget, card, onDeleted))),
    media,
    h('div.post-actions',
      likeBtn,
      btn('comment', 'Commenter', () => openPost(post)),
      btn('send', 'Partager', () => sharePost(post)),
      h('div.grow'),
      saveBtn),
    likes,
    post.caption ? h('div.post-caption', h('strong', post.author.username), ' ', richText(post.caption)) : null,
    post.comment_count ? h('button.post-comments-link', { type: 'button', onclick: () => openPost(post) }, `Voir les ${post.comment_count} commentaires`) : null,
    !post.comments_disabled ? quickComment(post) : null);

  // Lecture auto des vidéos visibles, pause sinon.
  if (post.media.some(m => m.kind === 'video')) {
    const io = new IntersectionObserver(([e]) => {
      const v = track.children[index];
      if (v && v.tagName === 'VIDEO') e.isIntersecting ? v.play().catch(() => {}) : v.pause();
    }, { threshold: 0.6 });
    io.observe(media);
  }
  return card;
}

function quickComment(post) {
  const input = h('input.quick-comment', { placeholder: 'Ajouter un commentaire…', maxlength: 2200 });
  const sendB = h('button.link.hidden', { type: 'button' }, 'Publier');
  input.addEventListener('input', () => sendB.classList.toggle('hidden', !input.value.trim()));
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; sendB.classList.add('hidden');
    try { await api.post(`posts/${post.id}/comments`, { text }); post.comment_count++; toast('Commentaire publié'); }
    catch (e) { errorToast(e); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  sendB.onclick = submit;
  return h('div.row.quick-comment-row', input, sendB);
}

function postMenu(post, anchor, card, onDeleted) {
  const own = post.own;
  const update = async data => {
    try { Object.assign(post, await api.post(`posts/${post.id}`, data)); toast('Publication mise à jour'); }
    catch (e) { errorToast(e); }
  };
  menu(anchor, [
    { label: 'Voir la publication', icon: 'image', action: () => openPost(post) },
    { label: 'Copier le lien', icon: 'link', action: () => navigator.clipboard.writeText(`${location.origin}/p/${post.id}`).then(() => toast('Lien copié')) },
    { label: 'Partager dans une discussion', icon: 'send', action: () => sharePost(post) },
    !own ? { label: 'Voir le profil', icon: 'user', action: () => window.kozons.go('/u/' + post.author.username) } : null,
    own ? { label: 'Modifier la légende', icon: 'edit', action: async () => { const v = await promptDialog('Légende', { value: post.caption, multiline: true, maxlength: 2200 }); if (v !== null) update({ caption: v }); } } : null,
    own ? { label: post.hide_likes ? 'Afficher le nombre de J\'aime' : 'Masquer le nombre de J\'aime', icon: 'heart', action: () => update({ hide_likes: !post.hide_likes }) } : null,
    own ? { label: post.comments_disabled ? 'Activer les commentaires' : 'Désactiver les commentaires', icon: 'comment', action: () => update({ comments_disabled: !post.comments_disabled }) } : null,
    own ? { label: post.archived ? 'Désarchiver' : 'Archiver', icon: 'archive', action: () => update({ archived: !post.archived }).then(() => card.remove()) } : null,
    own ? '-' : null,
    own ? { label: 'Supprimer', icon: 'trash', danger: true, action: async () => {
      if (!await confirmDialog('Supprimer cette publication ?', { ok: 'Supprimer', danger: true })) return;
      try { await api.del(`posts/${post.id}`); card.remove(); onDeleted && onDeleted(post); toast('Publication supprimée'); } catch (e) { errorToast(e); }
    } } : null,
  ]);
}

export function sharePost(post) {
  chooseConversations('Partager', async ids => {
    for (const id of ids) {
      const fd = new FormData();
      fd.append('kind', 'post');
      fd.append('post_id', post.id);
      await api.post(`conversations/${id}/messages`, fd);
    }
    toast('Publication partagée');
  });
}

export async function likersDialog(post) {
  const body = h('div.pick-list', spinner());
  modal(body, { title: "J'aime" });
  try {
    const { results } = await api.get(`posts/${post.id}/likers`);
    clear(body, results.length ? results.map(u => h('div.pick-item',
      h('button.row.grow', { type: 'button', onclick: () => window.kozons.go('/u/' + u.username) }, avatar(u.avatar, u.name, 40),
        h('div.pick-text', h('div.strong', u.username), h('div.muted', u.name))))) : h('p.muted.pad', "Aucun J'aime pour le moment."));
  } catch (e) { clear(body, h('p.muted', e.message)); }
}

/** Ouvre la page de détail d'une publication (vue dédiée /p/<id>). */
export function openPost(post) {
  window.kozons.go('/p/' + (post.id ?? post));
}

// ------------------------------------------------------------------ création

export async function createPostDialog({ reel = false } = {}) {
  const files = await pickFiles({ accept: reel ? 'video/*' : 'image/*,video/*', multiple: !reel });
  if (!files.length) return;
  if (files.length > 10) toast('10 médias maximum : seuls les 10 premiers seront publiés.');
  const chosen = files.slice(0, 10);
  const isReel = h('input', { type: 'checkbox', checked: reel || (chosen.length === 1 && chosen[0].type.startsWith('video/')) });
  const caption = h('textarea.input', { placeholder: 'Écrivez une légende… (#hashtags, @mentions)', maxlength: 2200, rows: 5 });
  const location = h('input.input', { placeholder: 'Ajouter un lieu', maxlength: 100 });
  const hideLikes = h('input', { type: 'checkbox' });
  const noComments = h('input', { type: 'checkbox' });
  const counter = h('div.muted.small.right', '0/2200');
  caption.addEventListener('input', () => { counter.textContent = `${caption.value.length}/2200`; });

  let idx = 0;
  const stage = h('div.create-stage');
  const showMedia = i => {
    idx = (i + chosen.length) % chosen.length;
    const f = chosen[idx];
    const url = URL.createObjectURL(f);
    clear(stage, f.type.startsWith('video/') ? h('video', { src: url, controls: true, autoplay: true, muted: true, loop: true }) : h('img', { src: url, alt: '' }),
      chosen.length > 1 ? [
        h('button.carousel-nav.prev', { type: 'button', onclick: () => showMedia(idx - 1) }, '‹'),
        h('button.carousel-nav.next', { type: 'button', onclick: () => showMedia(idx + 1) }, '›'),
        h('div.count-badge', `${idx + 1}/${chosen.length}`)] : null);
  };
  showMedia(0);

  const share = h('button.btn.primary', { type: 'button' }, 'Partager');
  share.onclick = async () => {
    const fd = new FormData();
    chosen.forEach(f => fd.append('files', f));
    fd.append('caption', caption.value);
    fd.append('location', location.value);
    fd.append('is_reel', isReel.checked ? '1' : '0');
    fd.append('hide_likes', hideLikes.checked ? '1' : '0');
    fd.append('comments_disabled', noComments.checked ? '1' : '0');
    share.disabled = true;
    try {
      const post = await api.post('posts', fd, { onProgress: p => { share.textContent = `Publication… ${Math.round(p * 100)} %`; } });
      m.close();
      toast('Publication partagée');
      window.kozons.go(post.is_reel ? '/reels' : '/u/' + state.me.username);
    } catch (e) { errorToast(e); share.disabled = false; share.textContent = 'Partager'; }
  };

  const m = modal(h('div.create-post',
    stage,
    h('div.create-side',
      h('div.row.gap', avatar(state.me.avatar, state.me.name, 28), h('strong', state.me.username)),
      caption, counter, location,
      h('label.switch-row', isReel, h('span', 'Publier en tant que reel (une vidéo)')),
      h('details', h('summary', 'Paramètres avancés'),
        h('label.switch-row', hideLikes, h('span', "Masquer le nombre de J'aime")),
        h('label.switch-row', noComments, h('span', 'Désactiver les commentaires'))),
      h('div.modal-actions', share))), { title: 'Créer une publication', wide: true });
}
