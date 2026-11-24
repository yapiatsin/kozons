// Stories / Statuts : barre de stories, visionneuse plein écran, création.
import { api } from '../api.js';
import { bus, state } from '../store.js';
import { h, clear, icon, btn, avatar, ago, toast, errorToast, pickFiles, modal, menu, closeMenus, confirmDialog, QUICK_REACTIONS, spinner } from '../ui.js';
import { editImage } from '../imageeditor.js';

// Vidéos de statut : mêmes limites que le serveur (social/storymedia.py).
const STORY_VIDEO_MAX_MB = 100;
const STORY_VIDEO_MAX_SECONDS = 90;

// Résultat de la conversion d'une vidéo (faite en arrière-plan par le serveur).
bus.on('story.failed', d => errorToast(new Error(d.message)));
bus.on('story.published', d => toast(d.message));

export async function fetchStories() {
  const { results } = await api.get('stories');
  return results;
}

/** Barre horizontale de stories (en-tête du fil). */
export function storiesBar() {
  const bar = h('div.stories-bar', spinner(24));
  const load = async () => {
    try {
      const [groups, lives] = await Promise.all([
        fetchStories(),
        api.get('live').then(r => r.results.filter(l => !l.is_host)).catch(() => []),
      ]);
      const mine = groups.find(g => g.is_me);
      const others = groups.filter(g => !g.is_me && !g.muted);
      clear(bar,
        h('button.story-bubble', { type: 'button', onclick: () => mine ? openViewer(groups, 0, load) : createStoryDialog(load) },
          h('div.story-avatar-wrap', avatar(state.me.avatar, state.me.name, 62, { ring: mine ? (mine.all_seen ? 'seen' : 'new') : null }),
            !mine ? h('span.story-add', icon('plus', 14)) : null),
          h('span', 'Votre story')),
        lives.map(l => h('button.story-bubble.is-live', { type: 'button', onclick: () => window.kozons.go('/live/' + l.id) },
          h('div.story-avatar-wrap', avatar(l.host.avatar, l.host.name, 62, { ring: 'live' }), h('span.story-live-tag', 'LIVE')),
          h('span', l.host.username))),
        others.map(g => h('button.story-bubble', { type: 'button', onclick: () => openViewer(groups, groups.indexOf(g), load) },
          avatar(g.user.avatar, g.user.name, 62, { ring: g.all_seen ? 'seen' : 'new' }),
          h('span', g.user.username))));
    } catch (e) { clear(bar); }
  };
  load();
  const off = bus.on('story.new', load);
  bar.cleanup = off;
  return bar;
}

// ------------------------------------------------------------------ visionneuse (façon WhatsApp)
//
//  · toucher le bord gauche / droit : statut précédent / suivant (puis la personne précédente / suivante)
//  · balayer à gauche / à droite : personne suivante / précédente (rotation « cube »)
//  · balayer vers le bas : fermer
//  · maintenir appuyé : pause (l'interface s'efface pour voir le statut en entier)
//  · menu « ⋮ », réponse, liste des vues : pause tant qu'ils sont ouverts

const PHOTO_DURATION = 5000;
const TEXT_DURATION = 6000;

export function openViewer(groups, groupIndex, onClose, { storyIndex } = {}) {
  let gi = groupIndex;
  let si = storyIndex ?? firstUnseen(groups[gi]);
  // Commencer par un statut masqué n'enchaîne que les statuts masqués (et inversement), comme WhatsApp.
  const startMuted = !!groups[gi].muted;
  let current = null, media = null, fill = null, raf = 0, closed = false;
  let elapsed = 0, startedAt = 0;
  const pauses = new Set();  // raisons de pause en cours : 'hold', 'menu', 'reply', 'loading', 'hidden'…

  const bars = h('div.sv-bars');
  const head = h('div.sv-head');
  const stage = h('div.sv-stage');
  const footer = h('div.sv-footer');
  const loader = h('div.sv-loader.hidden', spinner(36));
  const frame = h('div.sv-frame', bars, head, stage, loader, footer);
  const sidePrev = h('button.sv-side.prev', { type: 'button', 'aria-label': 'Personne précédente', onclick: () => switchGroup(-1) }, icon('back', 26));
  const sideNext = h('button.sv-side.next', { type: 'button', 'aria-label': 'Personne suivante', onclick: () => switchGroup(1) }, icon('back', 26));
  const layer = h('div.story-viewer', { tabindex: '-1', role: 'dialog', 'aria-label': 'Statuts' }, sidePrev, frame, sideNext);

  // ---------------------------------------------------------- pause / reprise
  function pause(reason) {
    if (!pauses.size && startedAt) elapsed += Date.now() - startedAt;
    pauses.add(reason);
    if (media && media.tagName === 'VIDEO') media.pause();
  }
  function resume(reason) {
    if (!pauses.delete(reason) || pauses.size || closed) return;
    startedAt = Date.now();
    if (media && media.tagName === 'VIDEO') media.play().catch(() => {});
  }

  // ---------------------------------------------------------- navigation
  function firstUnseen(group) {
    const i = group.stories.findIndex(s => !s.seen);
    return i < 0 ? 0 : i;
  }
  function neighbor(dir) {
    for (let i = gi + dir; i >= 0 && i < groups.length; i += dir) {
      if (groups[i].stories.length && !!groups[i].muted === startMuted) return i;
    }
    return -1;
  }
  function next() {
    if (si < groups[gi].stories.length - 1) { si++; return show(); }
    const n = neighbor(1);
    if (n < 0) return close();
    gi = n; si = firstUnseen(groups[gi]);
    show();
  }
  function prev() {
    if (si > 0) { si--; return show(); }
    const p = neighbor(-1);
    if (p < 0) return show();  // tout premier statut : il recommence
    gi = p; si = 0;
    show();
  }

  // Changement de personne avec la rotation « cube » (balayage, flèches du clavier, boutons latéraux).
  let turning = false;
  function switchGroup(dir, fromDx = 0) {
    const target = neighbor(dir);
    if (turning) return;
    if (target < 0) {
      if (dir > 0) return close();
      return snapBack();
    }
    turning = true;
    const w = frame.offsetWidth || window.innerWidth;
    frame.style.transition = 'transform .22s ease-in';
    frame.style.transformOrigin = dir > 0 ? 'right center' : 'left center';
    frame.style.transform = `translateX(${-dir * w * 0.5}px) rotateY(${dir * 70}deg)`;
    frame.style.opacity = '0.4';
    setTimeout(() => {
      gi = target; si = firstUnseen(groups[gi]);
      show();
      frame.style.transition = 'none';
      frame.style.transformOrigin = dir > 0 ? 'left center' : 'right center';
      frame.style.transform = `translateX(${dir * w * 0.5}px) rotateY(${-dir * 70}deg)`;
      void frame.offsetWidth;
      frame.style.transition = 'transform .24s ease-out, opacity .24s ease-out';
      frame.style.transform = '';
      frame.style.opacity = '';
      setTimeout(() => { turning = false; frame.style.transition = ''; frame.style.transformOrigin = ''; }, 260);
    }, fromDx ? 160 : 220);
  }
  function snapBack() {
    frame.style.transition = 'transform .2s ease-out, opacity .2s ease-out';
    frame.style.transform = '';
    frame.style.opacity = '';
    setTimeout(() => { frame.style.transition = ''; }, 220);
  }

  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    offViewed();
    closeMenus();
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', onViewport);
    if (media && media.tagName === 'VIDEO') media.pause();
    layer.classList.add('closing');
    setTimeout(() => layer.remove(), 160);
    onClose && onClose();
  }

  // Téléphone : le clavier ne doit pas cacher la barre de réponse (iPhone ne redimensionne pas la page).
  function onViewport() {
    const vv = window.visualViewport;
    layer.style.setProperty('--sv-kb', Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px');
  }
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewport);
  const onVisibility = () => (document.visibilityState === 'hidden' ? pause('hidden') : resume('hidden'));
  document.addEventListener('visibilitychange', onVisibility);

  // Quelqu'un vient de voir mon statut : compteur à jour sans recharger.
  let paintViewCount = () => {};
  const offViewed = bus.on('story.viewed', ({ story_id }) => {
    if (!current || current.id !== story_id || !groups[gi].is_me) return;
    api.get(`stories/${story_id}/viewers`).then(({ results }) => {
      current.viewers = results;
      current.view_count = results.length;
      paintViewCount();
    }).catch(() => {});
  });

  function onKey(e) {
    if (e.target.tagName === 'INPUT' && e.key !== 'Escape') return;
    if (document.querySelector('#overlay-root .modal-back, #overlay-root .menu-layer')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'ArrowDown') switchGroup(1);
    else if (e.key === 'ArrowUp') switchGroup(-1);
    else if (e.key === ' ') { e.preventDefault(); if (pauses.has('key')) resume('key'); else pause('key'); }
  }

  // ---------------------------------------------------------- menu « ⋮ »
  function openMenu(anchor) {
    const group = groups[gi];
    const story = current;
    pause('menu');
    const user = group.user;
    const leaveTo = fn => () => { close(); fn(); };
    const items = group.is_me ? [
      { label: `Vues (${story.view_count || 0})`, icon: 'eye', action: () => { pause('sheet'); showViewers(story, () => resume('sheet')); } },
      { label: 'Supprimer', icon: 'trash', danger: true, action: () => removeStory(group, story) },
    ] : [
      { label: 'Message', icon: 'chat', action: leaveTo(() => openChat(user)) },
      { label: 'Appel vocal', icon: 'phone', action: leaveTo(() => import('./calls.js').then(m => m.startCall(user, false))) },
      { label: 'Appel vidéo', icon: 'video', action: leaveTo(() => import('./calls.js').then(m => m.startCall(user, true))) },
      { label: 'Afficher le contact', icon: 'user', action: leaveTo(() => window.kozons.go('/u/' + user.username)) },
      { label: group.notify ? 'Ne plus recevoir les notifications' : 'Recevoir les notifications', icon: group.notify ? 'bellOff' : 'bell',
        action: () => setPreference(group, { notify: !group.notify }) },
      { label: group.muted ? 'Ne plus masquer' : 'Masquer', icon: group.muted ? 'eye' : 'eyeOff',
        action: () => setPreference(group, { muted: !group.muted }) },
      { label: 'Signaler', icon: 'flag', danger: true, action: () => reportStory(group, story) },
    ];
    menu(anchor, items, { onClose: () => resume('menu') });
  }

  async function setPreference(group, change) {
    try {
      const res = await api.post(`stories/prefs/${group.user.id}`, change);
      Object.assign(group, res);
      if ('muted' in change) toast(res.muted ? `Les statuts de ${group.user.name} sont masqués` : `Les statuts de ${group.user.name} ne sont plus masqués`);
      else toast(res.notify ? `Vous serez prévenu(e) des nouveaux statuts de ${group.user.name}` : 'Notifications des statuts désactivées');
    } catch (e) { errorToast(e); }
  }

  function reportStory(group, story) {
    pause('sheet');
    const reasons = [['spam', 'Spam'], ['inappropriate', 'Contenu inapproprié'], ['harassment', 'Harcèlement'], ['false', 'Fausse information'], ['other', 'Autre raison']];
    const m = modal(h('div.pick-list',
      h('p.muted.small', `Signaler ce statut de ${group.user.name} ? Il ne saura pas que vous l'avez signalé.`),
      reasons.map(([value, label]) => h('button.pick-item', { type: 'button', onclick: async () => {
        m.close();
        try { await api.post(`stories/${story.id}`, { action: 'report', reason: value }); toast('Merci, le statut a été signalé.'); }
        catch (e) { errorToast(e); }
      } }, h('div.pick-text', h('div.strong', label))))),
    { title: 'Signaler', onClose: () => resume('sheet') });
  }

  async function removeStory(group, story) {
    pause('sheet');
    const ok = await confirmDialog('Supprimer ce statut ?', { ok: 'Supprimer', danger: true });
    resume('sheet');
    if (!ok) return;
    try {
      await api.del(`stories/${story.id}`);
      const i = group.stories.indexOf(story);
      if (i >= 0) group.stories.splice(i, 1);
      if (!group.stories.length) {
        const n = neighbor(1) >= 0 ? neighbor(1) : neighbor(-1);
        groups.splice(gi, 1);
        if (n < 0) return close();
        gi = n > gi ? n - 1 : n; si = firstUnseen(groups[gi]);
      } else si = Math.min(si, group.stories.length - 1);
      show();
    } catch (e) { errorToast(e); }
  }

  // ---------------------------------------------------------- affichage d'un statut
  function show() {
    if (closed) return;
    const group = groups[gi];
    current = group.stories[si];
    const story = current;
    const isMine = group.is_me;
    elapsed = 0; startedAt = Date.now();
    ['hold', 'drag', 'loading', 'key'].forEach(r => pauses.delete(r));
    layer.classList.remove('holding');
    sidePrev.classList.toggle('hidden', neighbor(-1) < 0);
    sideNext.classList.toggle('hidden', neighbor(1) < 0);

    clear(bars, group.stories.map((s, i) => h('div.sv-bar', h('div', { style: { width: i < si ? '100%' : '0%' } }))));
    fill = bars.children[si].firstChild;

    clear(head,
      h('button.sv-back', { type: 'button', 'aria-label': 'Retour', onclick: close }, icon('back', 24)),
      h('button.sv-who', { type: 'button', onclick: () => { close(); window.kozons.go('/u/' + group.user.username); } },
        avatar(group.user.avatar, group.user.name, 40),
        h('div.sv-who-text',
          h('strong', isMine ? 'Mon statut' : group.user.name),
          h('span', ago(story.created_at), story.close_friends_only ? h('span.close-friends-tag', 'Amis proches') : null))),
      h('button.sv-more', { type: 'button', 'aria-label': 'Plus d’options', onclick: e => { e.stopPropagation(); openMenu(e.currentTarget); } }, icon('more', 24)));

    // Média : la progression attend qu'il soit chargé (réseau lent), un indicateur s'affiche entre-temps.
    if (media && media.tagName === 'VIDEO') media.pause();
    if (story.kind === 'text') {
      media = h('div.sv-text', { style: { background: story.background } }, story.text);
    } else if (story.kind === 'video') {
      media = h('video', { src: story.file, poster: story.poster || undefined, playsinline: true, preload: 'auto' });
      pause('loading');
      media.addEventListener('loadedmetadata', () => { story._duration = Math.min(STORY_VIDEO_MAX_SECONDS * 1000, (media.duration || 15) * 1000); });
      media.addEventListener('canplay', () => { if (current === story) { loader.classList.add('hidden'); resume('loading'); if (!pauses.size) media.play().catch(() => {}); } }, { once: true });
      media.addEventListener('ended', () => { if (current === story) next(); });
      media.addEventListener('error', () => { if (current === story) { loader.classList.add('hidden'); resume('loading'); } });
    } else {
      media = h('img', { src: story.file, alt: '', draggable: 'false' });
      if (!media.complete) {
        pause('loading');
        const ready = () => { if (current === story) { loader.classList.add('hidden'); resume('loading'); } };
        media.addEventListener('load', ready, { once: true });
        media.addEventListener('error', ready, { once: true });
      }
    }
    loader.classList.toggle('hidden', !pauses.has('loading'));
    clear(stage, media, story.kind !== 'text' && story.text ? h('div.sv-caption', story.text) : null);

    paintFooter(group, story);
    if (!isMine && !story.seen) {
      story.seen = true;
      api.post(`stories/${story.id}`, { action: 'view' }).catch(() => {});
      group.all_seen = group.stories.every(s => s.seen);
    }
    preloadNext();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!current || !fill) return;
    let p;
    if (media && media.tagName === 'VIDEO' && media.duration) p = media.currentTime / media.duration;
    else {
      if (pauses.size) return;
      const total = current._duration || (current.kind === 'text' ? TEXT_DURATION : PHOTO_DURATION);
      p = Math.min(1, (elapsed + Date.now() - startedAt) / total);
    }
    fill.style.width = (p * 100) + '%';
    if (p >= 1 && current.kind !== 'video') next();
  }

  // Le statut suivant se charge pendant qu'on regarde celui-ci : pas d'attente en touchant l'écran.
  function preloadNext() {
    const group = groups[gi];
    const n = neighbor(1);
    const upcoming = si < group.stories.length - 1 ? group.stories[si + 1] : n >= 0 ? groups[n].stories[firstUnseen(groups[n])] : null;
    if (upcoming && upcoming.kind === 'image' && upcoming.file) { const img = new Image(); img.src = upcoming.file; }
  }

  function paintFooter(group, story) {
    footer.classList.remove('typing');
    if (group.is_me) {
      const count = h('span');
      paintViewCount = () => { if (current === story) count.textContent = `${story.view_count || 0} vue${story.view_count > 1 ? 's' : ''}`; };
      paintViewCount();
      clear(footer, h('button.sv-viewers', { type: 'button', onclick: () => { pause('sheet'); showViewers(story, () => resume('sheet')); } }, icon('eye', 20), count));
      return;
    }
    paintViewCount = () => {};
    // Barre de réponse : « Répondre » + 🙏 😂 dans la bulle, cœur à côté ; en écrivant, la ligne
    // de réactions apparaît au-dessus et le bouton d'envoi remplace le cœur.
    const input = h('input.sv-reply', { placeholder: 'Répondre', maxlength: 1000, enterkeyhint: 'send', 'aria-label': `Répondre à ${group.user.name}` });
    const sendReply = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      paintTyping();
      input.blur();
      await replyToStory(group.user, story, text);
    };
    const react = e => { replyToStory(group.user, story, e); input.blur(); };
    input.addEventListener('focus', () => { pause('reply'); footer.classList.add('typing'); });
    input.addEventListener('blur', () => { footer.classList.remove('typing'); if (!input.value) resume('reply'); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendReply(); } });
    const like = h('button.sv-round.sv-like' + (story.liked ? '.liked' : ''), {
      type: 'button', 'aria-label': "J'aime", title: "J'aime",
      onclick: async () => {
        try {
          const { liked } = await api.post(`stories/${story.id}`, { action: 'like' });
          story.liked = liked;
          like.classList.toggle('liked', liked);
        } catch (e) { errorToast(e); }
      },
    }, icon('heart', 24));
    const sendBtn = h('button.sv-round.sv-send.hidden', { type: 'button', 'aria-label': 'Envoyer', onmousedown: e => e.preventDefault(), onclick: sendReply }, icon('send', 22));
    const quick = h('span.sv-pill-quick', ['🙏', '😂'].map(e => h('button', { type: 'button', title: e, onmousedown: ev => ev.preventDefault(), onclick: () => react(e) }, e)));
    const paintTyping = () => {
      const typing = !!input.value.trim();
      quick.classList.toggle('hidden', typing);
      sendBtn.classList.toggle('hidden', !typing);
      like.classList.toggle('hidden', typing);
    };
    input.addEventListener('input', paintTyping);
    clear(footer,
      h('div.sv-quick', QUICK_REACTIONS.slice(0, 6).map(e => h('button', { type: 'button', title: e, onmousedown: ev => ev.preventDefault(), onclick: () => react(e) }, e))),
      h('div.sv-replybar', h('label.sv-pill', input, quick), like, sendBtn));
  }

  // ---------------------------------------------------------- gestes (toucher, maintenir, balayer)
  let g = null;
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (turning) return;
    g = { x: e.clientX, y: e.clientY, t: Date.now(), mode: null };
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignoré */ }
    g.timer = setTimeout(() => {
      if (g && !g.mode) { g.mode = 'hold'; pause('hold'); layer.classList.add('holding'); }
    }, 220);
  });
  stage.addEventListener('pointermove', e => {
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.mode || g.mode === 'hold') {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) startDrag('swipe');
      else if (dy > 12 && dy > Math.abs(dx) * 1.2) startDrag('down');
    }
    const w = frame.offsetWidth || window.innerWidth;
    if (g.mode === 'swipe') {
      const dir = dx < 0 ? 1 : -1;
      const resist = neighbor(dir) < 0 ? 0.25 : 1;  // rien de ce côté : la page résiste
      const ratio = Math.max(-1, Math.min(1, dx / w)) * resist;
      frame.style.transition = 'none';
      frame.style.transformOrigin = dx < 0 ? 'right center' : 'left center';
      frame.style.transform = `translateX(${ratio * w * 0.5}px) rotateY(${-ratio * 70}deg)`;
    } else if (g.mode === 'down') {
      frame.style.transition = 'none';
      frame.style.transform = `translateY(${Math.max(0, dy)}px) scale(${1 - Math.min(0.15, dy / 2000)})`;
      layer.style.setProperty('--sv-fade', String(Math.max(0.3, 1 - dy / 500)));
    }
  });
  function startDrag(mode) {
    clearTimeout(g.timer);
    if (g.mode === 'hold') layer.classList.remove('holding');
    g.mode = mode;
    pause('drag');
  }
  const endGesture = (e, cancelled = false) => {
    if (!g) return;
    clearTimeout(g.timer);
    const { mode, x, y, t } = g;
    g = null;
    const dx = e.clientX - x, dy = e.clientY - y, dt = Math.max(1, Date.now() - t);
    const w = frame.offsetWidth || window.innerWidth;
    if (mode === 'hold') { layer.classList.remove('holding'); resume('hold'); return; }
    if (mode === 'swipe') {
      resume('drag');
      if (!cancelled && (Math.abs(dx) > w * 0.22 || Math.abs(dx) / dt > 0.5)) switchGroup(dx < 0 ? 1 : -1, dx);
      else snapBack();
      return;
    }
    if (mode === 'down') {
      resume('drag');
      layer.style.removeProperty('--sv-fade');
      if (!cancelled && (dy > 140 || dy / dt > 0.6)) close(); else snapBack();
      return;
    }
    if (cancelled || dt > 400) return;
    // Toucher : bord gauche = précédent, reste de l'écran = suivant.
    const r = frame.getBoundingClientRect();
    if (e.clientX - r.left < r.width * 0.3) prev(); else next();
  };
  stage.addEventListener('pointerup', e => endGesture(e));
  stage.addEventListener('pointercancel', e => endGesture(e, true));
  stage.addEventListener('contextmenu', e => e.preventDefault());  // appui long sur mobile : pas de menu système

  document.addEventListener('keydown', onKey);
  document.getElementById('overlay-root').appendChild(layer);
  layer.focus();
  show();
}

function openChat(user) {
  api.post('conversations/direct', { user_id: user.id })
    .then(conv => window.kozons.go('/chats/' + conv.id))
    .catch(errorToast);
}

async function replyToStory(user, story, text) {
  try {
    const conv = await api.post('conversations/direct', { user_id: user.id });
    const fd = new FormData();
    fd.append('kind', 'story_reply');
    fd.append('story_id', story.id);
    fd.append('text', text);
    await api.post(`conversations/${conv.id}/messages`, fd);
    toast('Réponse envoyée');
  } catch (e) { errorToast(e); }
}

/** Liste « Vues » : affichée aussitôt avec les vues déjà reçues (jointes à mes stories),
 *  puis mise à jour en arrière-plan et en temps réel. */
function showViewers(story, onClose) {
  const body = h('div.pick-list');
  const paint = list => clear(body, list.length ? list.map(u => h('div.pick-item', avatar(u.avatar, u.name, 40),
    h('div.pick-text', h('div.strong', u.name), h('div.muted.small', ago(u.viewed_at))),
    u.liked ? h('span.liked-heart', icon('heart', 18)) : null)) : h('p.muted.pad', 'Personne pour le moment.'));
  const refresh = () => api.get(`stories/${story.id}/viewers`).then(({ results }) => {
    story.viewers = results;
    story.view_count = results.length;
    paint(results);
  }).catch(e => { if (!story.viewers) clear(body, h('p.muted', e.message)); });
  if (story.viewers) paint(story.viewers); else clear(body, spinner());
  const off = bus.on('story.viewed', ({ story_id }) => { if (story_id === story.id) refresh(); });
  modal(body, { title: `Vues · ${story.view_count || 0}`, cls: 'sv-viewers-sheet', onClose: () => { off(); onClose && onClose(); } });
  refresh();
}

// ------------------------------------------------------------------ création

const BACKGROUNDS = ['#128C7E', '#25D366', '#34B7F1', '#7c4dff', '#e1306c', '#ff9800', '#f44336', '#3f51b5', '#212121', 'linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)'];

/** Appareil photo intégré (photo, vidéo, note vidéo, galerie), puis compositeur avec le fichier obtenu. */
export function openStoryCamera(onDone) {
  import('../camera.js').then(({ openCamera }) => openCamera({
    maxVideoSeconds: STORY_VIDEO_MAX_SECONDS,
    onCapture: ([file]) => createStoryDialog(onDone, { file, fromCamera: true }),
  })).catch(errorToast);
}

export function createStoryDialog(onDone, { file: initialFile = null, fromCamera = false } = {}) {
  let file = null, adjust = null, trimmer = null;
  let bgIndex = 0;
  const preview = h('div.story-create-preview');
  const text = h('textarea.story-text-input', { placeholder: 'Tapez un statut', maxlength: 700, rows: 3 });
  const caption = h('input.input', { placeholder: 'Ajouter une légende…', maxlength: 700 });
  const closeFriends = h('input', { type: 'checkbox' });
  const setBg = () => { preview.style.background = BACKGROUNDS[bgIndex]; };
  const dropTrimmer = () => { if (trimmer) { trimmer.destroy(); trimmer = null; } };
  const textMode = () => {
    file = null;
    dropTrimmer();
    if (adjust) adjust.classList.add('hidden');
    clear(preview, text);
    setBg();
    caption.classList.add('hidden');
    text.focus();
  };
  textMode();

  adjust = h('button.btn.ghost.story-adjust.hidden', { type: 'button', onclick: async () => {
    const edited = await editImage(file);
    if (edited) showFile(edited);
  } }, icon('crop', 18), ' Ajuster');
  const showFile = f => {
    const isVideo = f.type.startsWith('video/');
    // Vérifié avant l'envoi : pas de données mobiles gaspillées pour une vidéo refusée.
    if (isVideo && f.size > STORY_VIDEO_MAX_MB * 1024 * 1024) {
      return toast(`Vidéo trop lourde (${Math.round(f.size / 1048576)} Mo) : ${STORY_VIDEO_MAX_MB} Mo maximum.`, { type: 'error' });
    }
    file = f;
    dropTrimmer();
    const url = URL.createObjectURL(f);
    preview.style.background = '#000';
    const isImage = f.type.startsWith('image/') && f.type !== 'image/gif';
    if (isVideo) {
      // Vidéo : pellicule en haut pour choisir la séquence à publier (90 s max), lecture en boucle
      // dans la sélection ; toucher la vidéo la met en pause / la relance (comme WhatsApp).
      const media = h('video.story-trim-video', { src: url, autoplay: true, muted: true, playsinline: true, loop: false, preload: 'auto' });
      const playBtn = h('button.story-play.hidden', { type: 'button', 'aria-label': 'Lecture' }, icon('play', 34));
      const toggle = () => { if (media.paused) media.play().catch(() => {}); else media.pause(); };
      media.addEventListener('click', toggle);
      playBtn.addEventListener('click', toggle);
      media.addEventListener('play', () => playBtn.classList.add('hidden'));
      media.addEventListener('pause', () => playBtn.classList.remove('hidden'));
      import('../videotrim.js').then(({ videoTrimmer }) => {
        if (file !== f) return;
        trimmer = videoTrimmer(media, { maxSeconds: STORY_VIDEO_MAX_SECONDS, fileSize: f.size });
        preview.prepend(trimmer.el);
      });
      clear(preview, media, playBtn);
      preview.classList.add('is-video');
    } else {
      preview.classList.remove('is-video');
      clear(preview, h('img', { src: url, alt: '' }), isImage ? adjust : null);
    }
    adjust.classList.toggle('hidden', !isImage);
    caption.classList.remove('hidden');
  };
  const pick = async () => {
    const [f] = await pickFiles({ accept: 'image/*,video/*' });
    if (f) showFile(f);
  };

  const share = h('button.btn.primary', { type: 'button' }, 'Partager');
  share.onclick = async () => {
    const fd = new FormData();
    if (file) {
      fd.append('file', file);
      fd.append('text', caption.value.trim());
      // Séquence choisie et son : la découpe est faite par le serveur à la conversion.
      if (trimmer) {
        const { start, end } = trimmer.range();
        fd.append('trim_start', start.toFixed(2));
        fd.append('trim_end', end.toFixed(2));
        if (trimmer.muted()) fd.append('mute', '1');
      }
    }
    else {
      if (!text.value.trim()) return toast('Écrivez quelque chose.');
      fd.append('text', text.value.trim());
      fd.append('background', BACKGROUNDS[bgIndex]);
    }
    fd.append('close_friends_only', closeFriends.checked ? '1' : '0');
    share.disabled = true;
    try {
      const res = await api.post('stories', fd, { onProgress: p => { share.textContent = `Envoi… ${Math.round(p * 100)} %`; } });
      dropTrimmer();
      m.close();
      // Vidéo : le serveur la convertit (720p, compressée) puis la publie ; elle apparaît d'elle-même.
      toast(res.processing ? 'Vidéo envoyée : votre statut sera publié dans quelques instants.' : 'Story publiée', { timeout: 5000 });
      onDone && onDone();
    } catch (e) { errorToast(e); share.disabled = false; share.textContent = 'Partager'; }
  };

  // Retour à l'appareil photo : « Reprendre » après une prise, « Caméra » sinon.
  const camera = () => { m.close(); openStoryCamera(onDone); };
  const m = modal(h('div.story-create',
    preview,
    h('div.row.gap.wrap',
      h('button.btn.ghost', { type: 'button', onclick: textMode }, icon('edit', 18), ' Texte'),
      h('button.btn.ghost', { type: 'button', onclick: () => { bgIndex = (bgIndex + 1) % BACKGROUNDS.length; if (!file) setBg(); } }, '🎨 Couleur'),
      h('button.btn.ghost', { type: 'button', onclick: camera }, icon('camera', 18), fromCamera ? ' Reprendre' : ' Caméra'),
      h('button.btn.ghost', { type: 'button', onclick: pick }, icon('image', 18), ' Photo / vidéo')),
    caption,
    h('label.switch-row', closeFriends, h('span', 'Amis proches uniquement')),
    h('div.modal-actions', share)), { title: 'Nouvelle story', onClose: dropTrimmer, focus: !initialFile });
  if (initialFile) showFile(initialFile);
}
