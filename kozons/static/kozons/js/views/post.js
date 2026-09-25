// Page de détail d'une publication (/p/<id>) — mise en page inspirée des « pins » Pinterest :
// média à gauche, auteur / actions / commentaires à droite ; empilé sur mobile.
import { api } from '../api.js';
import { state } from '../store.js';
import {
  h, clear, icon, btn, avatar, ago, compact, richText, menu, toast, errorToast, confirmDialog, promptDialog,
  spinner, empty, emojiPopover,
} from '../ui.js';
import { followButton, sharePost, likersDialog } from './feed.js';
import { postGrid } from './explore.js';

export function render(stage, params) {
  const page = h('div.post-view', h('div.center.pad', spinner()));
  stage.appendChild(page);
  load(page, params.id);
}

function goBack() {
  if (history.length > 1) history.back();
  else window.kozons.go('/explore');
}

async function load(page, id) {
  let post;
  try {
    post = await api.get(`posts/${id}`);
  } catch (e) {
    return clear(page, topbar(), empty('image', 'Publication introuvable', "Elle a peut-être été supprimée, ou le compte est privé."));
  }
  const profile = await api.get(`profiles/${encodeURIComponent(post.author.username)}`).catch(() => null);
  clear(page, topbar(), pinCard(post, profile), morePosts(post));
  page.scrollTop = 0;
}

function topbar() {
  return h('header.post-topbar', btn('back', 'Retour', goBack), h('h2', 'Publication'));
}

// ------------------------------------------------------------------ carte principale

function pinCard(post, profile) {
  const commentsTitle = h('h3.pin-section-title');
  const setCommentsTitle = () => { commentsTitle.textContent = `Commentaires (${post.comment_count})`; };
  setCommentsTitle();

  const comments = commentsBlock(post, () => { setCommentsTitle(); updateCounts(); });
  const likeCount = h('span.pin-count');
  const commentCount = h('span.pin-count');
  const updateCounts = () => {
    likeCount.textContent = post.like_count === null ? "J'aime" : `${compact(post.like_count)} J'aime`;
    commentCount.textContent = `${compact(post.comment_count)} Commentaire${post.comment_count > 1 ? 's' : ''}`;
  };
  updateCounts();

  const likeBtn = h('button.pin-action' + (post.liked ? '.liked' : ''), { type: 'button', 'aria-label': "J'aime" }, icon('heart', 22), likeCount);
  const toggleLike = async (onlyLike = false) => {
    if (onlyLike && post.liked) return;
    post.liked = !post.liked;
    if (post.like_count !== null) post.like_count += post.liked ? 1 : -1;
    likeBtn.classList.toggle('liked', post.liked);
    updateCounts();
    try {
      const r = await api.post(`posts/${post.id}/like`);
      post.liked = r.liked;
      if (post.like_count !== null) post.like_count = r.like_count;
      likeBtn.classList.toggle('liked', post.liked);
      updateCounts();
    } catch (e) { errorToast(e); }
  };
  likeBtn.onclick = () => toggleLike();
  likeCount.addEventListener('click', e => { if (post.like_count) { e.stopPropagation(); likersDialog(post); } });

  const saveLabel = h('span.pin-count');
  const saveBtn = h('button.pin-action.save' + (post.saved ? '.saved' : ''), { type: 'button' }, icon('bookmark', 22), saveLabel);
  const renderSave = () => { saveLabel.textContent = post.saved ? 'Enregistré' : 'Enregistrer'; saveBtn.classList.toggle('saved', post.saved); };
  renderSave();
  saveBtn.onclick = async () => {
    try { post.saved = (await api.post(`posts/${post.id}/save`)).saved; renderSave(); toast(post.saved ? 'Publication enregistrée' : 'Retirée des enregistrements'); }
    catch (e) { errorToast(e); }
  };

  const actions = h('div.pin-actions',
    likeBtn,
    h('button.pin-action', { type: 'button', onclick: () => comments.focus() }, icon('comment', 22), commentCount),
    h('button.pin-action', { type: 'button', onclick: () => sharePost(post) }, icon('send', 22), h('span.pin-count', 'Partager')),
    saveBtn);

  const head = h('div.pin-head',
    h('button.pin-author', { type: 'button', onclick: () => window.kozons.go('/u/' + post.author.username) },
      avatar(post.author.avatar, post.author.name, 44, { ring: profile && profile.has_story ? 'new' : null }),
      h('div.pin-author-text',
        h('strong', post.author.name),
        h('span.muted', [`@${post.author.username}`, post.location].filter(Boolean).join(' · ')))),
    !post.own && profile ? followButton(post.author.id, profile.follow_status) : null,
    btn('moreH', 'Plus d\'options', e => pinMenu(post, e.currentTarget)));

  const body = h('div.pin-body',
    post.caption ? h('div.pin-caption', richText(post.caption)) : null,
    h('div.pin-date', new Date(post.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
      post.is_reel ? ' · Reel' : ''),
    commentsTitle,
    comments.list);

  const media = h('div.pin-media', mediaCarousel(post, () => toggleLike(true)));
  const first = post.media[0];
  if (first && first.kind === 'image') media.style.setProperty('--pin-bg', `url("${encodeURI(first.url)}")`);

  return h('article.pin', { dataset: { layout: post.media.length === 1 && post.media[0].kind === 'video' ? 'video' : 'image' } },
    media,
    head, actions, body, comments.compose);
}

function mediaCarousel(post, onDoubleTap) {
  let index = 0;
  const slides = post.media.map(m => m.kind === 'video'
    ? h('video', { src: m.url, controls: true, playsinline: true, loop: true, preload: 'metadata' })
    : h('img', { src: m.url, alt: post.caption ? post.caption.slice(0, 120) : 'Publication', draggable: 'false' }));
  const track = h('div.pin-track', slides);
  const dots = post.media.length > 1 ? h('div.carousel-dots', post.media.map((_, i) => h('span' + (i === 0 ? '.on' : '')))) : null;
  const prev = h('button.carousel-nav.prev.hidden', { type: 'button', 'aria-label': 'Précédent', onclick: () => go(index - 1) }, '‹');
  const next = h('button.carousel-nav.next' + (post.media.length > 1 ? '' : '.hidden'), { type: 'button', 'aria-label': 'Suivant', onclick: () => go(index + 1) }, '›');
  const counter = post.media.length > 1 ? h('span.count-badge', `1/${post.media.length}`) : null;
  const heart = h('div.big-heart', icon('heart', 110));

  function go(i) {
    index = Math.max(0, Math.min(post.media.length - 1, i));
    track.style.transform = `translateX(-${index * 100}%)`;
    if (dots) [...dots.children].forEach((d, j) => d.classList.toggle('on', j === index));
    if (counter) counter.textContent = `${index + 1}/${post.media.length}`;
    prev.classList.toggle('hidden', index === 0);
    next.classList.toggle('hidden', index === post.media.length - 1);
    slides.forEach((s, j) => { if (s.tagName === 'VIDEO' && j !== index) s.pause(); });
  }

  const wrap = h('div.pin-carousel', track, prev, next, dots, counter, heart);
  wrap.addEventListener('dblclick', e => {
    if (e.target.tagName === 'VIDEO') return;
    heart.classList.remove('pop'); void heart.offsetWidth; heart.classList.add('pop');
    onDoubleTap();
  });
  let startX = null;
  wrap.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  wrap.addEventListener('touchend', e => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) go(index + (dx < 0 ? 1 : -1));
    startX = null;
  });
  wrap.tabIndex = 0;
  wrap.addEventListener('keydown', e => { if (e.key === 'ArrowRight') go(index + 1); if (e.key === 'ArrowLeft') go(index - 1); });
  return wrap;
}

function pinMenu(post, anchor) {
  const update = async data => {
    try { Object.assign(post, await api.post(`posts/${post.id}`, data)); toast('Publication mise à jour'); window.kozons.go('/p/' + post.id); }
    catch (e) { errorToast(e); }
  };
  menu(anchor, [
    { label: 'Copier le lien', icon: 'link', action: () => navigator.clipboard.writeText(`${location.origin}/p/${post.id}`).then(() => toast('Lien copié')) },
    { label: 'Partager dans une discussion', icon: 'send', action: () => sharePost(post) },
    !post.own ? { label: 'Voir le profil', icon: 'user', action: () => window.kozons.go('/u/' + post.author.username) } : null,
    post.own ? { label: 'Modifier la légende', icon: 'edit', action: async () => { const v = await promptDialog('Légende', { value: post.caption, multiline: true, maxlength: 2200 }); if (v !== null) update({ caption: v }); } } : null,
    post.own ? { label: post.hide_likes ? "Afficher le nombre de J'aime" : "Masquer le nombre de J'aime", icon: 'heart', action: () => update({ hide_likes: !post.hide_likes }) } : null,
    post.own ? { label: post.comments_disabled ? 'Activer les commentaires' : 'Désactiver les commentaires', icon: 'comment', action: () => update({ comments_disabled: !post.comments_disabled }) } : null,
    post.own ? { label: post.archived ? 'Désarchiver' : 'Archiver', icon: 'archive', action: () => update({ archived: !post.archived }) } : null,
    post.own ? '-' : null,
    post.own ? { label: 'Supprimer', icon: 'trash', danger: true, action: async () => {
      if (!await confirmDialog('Supprimer cette publication ?', { ok: 'Supprimer', danger: true })) return;
      try { await api.del(`posts/${post.id}`); toast('Publication supprimée'); goBack(); } catch (e) { errorToast(e); }
    } } : null,
  ]);
}

// ------------------------------------------------------------------ commentaires

function commentsBlock(post, onChange) {
  const list = h('div.pin-comments', h('div.center.pad', spinner(22)));
  let replyTo = null;
  const input = h('input.pin-input', {
    placeholder: post.comments_disabled ? 'Les commentaires sont désactivés' : 'Ajouter un commentaire…',
    maxlength: 2200, disabled: post.comments_disabled, 'aria-label': 'Commentaire',
  });
  const replyBar = h('div.pin-reply.hidden');
  const setReply = c => {
    replyTo = c;
    if (!c) { replyBar.classList.add('hidden'); return; }
    clear(replyBar, h('span', `Réponse à @${c.user.username}`), btn('close', 'Annuler la réponse', () => { setReply(null); input.value = ''; }, 'small'));
    replyBar.classList.remove('hidden');
    input.value = '@' + c.user.username + ' ';
    input.focus();
  };

  const row = (c, isReply = false) => {
    const likeB = h('button.comment-like' + (c.liked ? '.liked' : ''), { type: 'button', 'aria-label': "J'aime" }, icon('heart', 14));
    const likes = h('span', c.like_count ? `${c.like_count} J'aime` : '');
    likeB.onclick = async () => {
      try { const r = await api.post(`comments/${c.id}`); c.liked = r.liked; c.like_count = r.like_count; likeB.classList.toggle('liked', r.liked); likes.textContent = r.like_count ? `${r.like_count} J'aime` : ''; }
      catch (e) { errorToast(e); }
    };
    const replies = h('div.replies');
    const el = h('div.comment' + (isReply ? '.reply' : ''),
      h('button', { type: 'button', onclick: () => window.kozons.go('/u/' + c.user.username) }, avatar(c.user.avatar, c.user.name, isReply ? 28 : 34)),
      h('div.grow',
        h('div.comment-bubble', h('strong', c.user.username), ' ', richText(c.text)),
        h('div.comment-meta', h('span', ago(c.created_at)), likes,
          !post.comments_disabled ? h('button.link-muted', { type: 'button', onclick: () => setReply(isReply ? { id: c.parent_id, user: c.user } : c) }, 'Répondre') : null,
          (c.user.id === state.me.id || post.own) ? h('button.link-muted', {
            type: 'button',
            onclick: async () => {
              if (!await confirmDialog('Supprimer ce commentaire ?', { ok: 'Supprimer', danger: true })) return;
              try { await api.del(`comments/${c.id}`); el.remove(); post.comment_count = Math.max(0, post.comment_count - 1); onChange(); } catch (e) { errorToast(e); }
            },
          }, 'Supprimer') : null),
        c.reply_count ? h('button.link-muted.view-replies', {
          type: 'button',
          onclick: async e => {
            e.currentTarget.remove();
            try { (await api.get(`posts/${post.id}/comments`, { parent: c.id })).results.forEach(r => replies.appendChild(row(r, true))); }
            catch (err) { errorToast(err); }
          },
        }, `— Voir les réponses (${c.reply_count})`) : null,
        replies),
      likeB);
    return el;
  };

  const load = async () => {
    try {
      const { results } = await api.get(`posts/${post.id}/comments`);
      clear(list, results.length ? results.map(c => row(c))
        : h('div.pin-empty', icon('comment', 28), h('span', post.comments_disabled ? 'Commentaires désactivés.' : 'Aucun commentaire pour le moment. Lancez la conversation !')));
    } catch (e) { clear(list, h('p.muted', e.message)); }
  };
  load();

  const publish = h('button.pin-publish', { type: 'button', disabled: true }, 'Publier');
  input.addEventListener('input', () => { publish.disabled = !input.value.trim(); });
  const submit = async () => {
    const text = input.value.trim();
    if (!text || post.comments_disabled) return;
    input.disabled = publish.disabled = true;
    try {
      await api.post(`posts/${post.id}/comments`, { text, parent_id: replyTo ? replyTo.id : undefined });
      post.comment_count++;
      input.value = '';
      setReply(null);
      onChange();
      await load();
    } catch (e) { errorToast(e); }
    input.disabled = false;
    publish.disabled = !input.value.trim();
    input.focus();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  publish.onclick = submit;

  const emojiBtn = btn('smile', 'Emoji', e => emojiPopover(e.currentTarget, em => {
    const s = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, s) + em + input.value.slice(input.selectionEnd ?? s);
    input.selectionStart = input.selectionEnd = s + em.length;
    publish.disabled = !input.value.trim();
    input.focus();
  }));
  if (post.comments_disabled) emojiBtn.disabled = true;

  const compose = h('div.pin-compose',
    replyBar,
    h('div.pin-compose-row',
      avatar(state.me.avatar, state.me.name, 34),
      h('div.pin-pill', input, emojiBtn),
      publish));

  return { list, compose, focus: () => { if (!post.comments_disabled) input.focus(); } };
}

// ------------------------------------------------------------------ plus de publications

function morePosts(post) {
  const grid = h('div.post-grid');
  const section = h('section.pin-more.hidden', h('h3', `Plus de publications de @${post.author.username}`), grid);
  api.get(`profiles/${encodeURIComponent(post.author.username)}/posts`).then(({ results }) => {
    const others = results.filter(p => p.id !== post.id).slice(0, 9);
    if (!others.length) return;
    grid.append(...postGrid(others));
    section.classList.remove('hidden');
  }).catch(() => {});
  return section;
}
