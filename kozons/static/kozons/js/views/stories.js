// Stories / Statuts : barre de stories, visionneuse plein écran, création.
import { api } from '../api.js';
import { bus, state } from '../store.js';
import { h, clear, icon, btn, avatar, ago, toast, errorToast, pickFiles, modal, confirmDialog, QUICK_REACTIONS, spinner } from '../ui.js';

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
      const others = groups.filter(g => !g.is_me);
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

// ------------------------------------------------------------------ visionneuse

export function openViewer(groups, groupIndex, onClose, { storyIndex } = {}) {
  let gi = groupIndex;
  let si = storyIndex ?? Math.max(0, groups[gi].stories.findIndex(s => !s.seen));
  if (si < 0) si = 0;
  let timer = null, startedAt = 0, elapsed = 0, paused = false, current = null;
  const DURATION = 5000;

  const bars = h('div.sv-bars');
  const head = h('div.sv-head');
  const stage = h('div.sv-stage');
  const footer = h('div.sv-footer');
  const layer = h('div.story-viewer', { tabindex: '-1' },
    h('div.sv-frame', bars, head, stage, footer,
      h('button.sv-nav.prev', { type: 'button', 'aria-label': 'Précédent', onclick: prev }),
      h('button.sv-nav.next', { type: 'button', 'aria-label': 'Suivant', onclick: next })),
    btn('close', 'Fermer', close, 'sv-close'));

  function close() {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    layer.remove();
    onClose && onClose();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === ' ' && e.target.tagName !== 'INPUT') { e.preventDefault(); togglePause(); }
  }
  function next() {
    if (si < groups[gi].stories.length - 1) si++;
    else if (gi < groups.length - 1) { gi++; si = Math.max(0, groups[gi].stories.findIndex(s => !s.seen)); }
    else return close();
    show();
  }
  function prev() {
    if (si > 0) si--;
    else if (gi > 0) { gi--; si = 0; }
    show();
  }
  function togglePause(force) {
    paused = force ?? !paused;
    const v = stage.querySelector('video');
    if (paused) { elapsed += Date.now() - startedAt; if (v) v.pause(); }
    else { startedAt = Date.now(); if (v) v.play().catch(() => {}); }
  }

  function show() {
    clearInterval(timer);
    const group = groups[gi];
    current = group.stories[si];
    const isMine = group.is_me;
    elapsed = 0; paused = false;

    clear(bars, group.stories.map((s, i) => h('div.sv-bar', h('div', { style: { width: i < si ? '100%' : '0%' } }))));
    clear(head,
      h('button.row', { type: 'button', onclick: () => { close(); window.kozons.go('/u/' + group.user.username); } },
        avatar(group.user.avatar, group.user.name, 36),
        h('div', h('strong', isMine ? 'Vous' : group.user.name), h('span.muted', ' ' + ago(current.created_at))),
        current.close_friends_only ? h('span.close-friends-tag', 'Amis proches') : null),
      h('div.row',
        btn('pause', 'Pause', e => { togglePause(); e.currentTarget.replaceChildren(icon(paused ? 'play' : 'pause')); }),
        isMine ? btn('trash', 'Supprimer', async () => {
          togglePause(true);
          if (await confirmDialog('Supprimer cette story ?', { ok: 'Supprimer', danger: true })) {
            try {
              await api.del(`stories/${current.id}`);
              group.stories.splice(si, 1);
              if (!group.stories.length) { groups.splice(gi, 1); if (!groups.length) return close(); gi = Math.min(gi, groups.length - 1); si = 0; }
              else si = Math.min(si, group.stories.length - 1);
              show();
            } catch (e) { errorToast(e); }
          } else togglePause(false);
        }) : null));

    let media;
    if (current.kind === 'text') {
      media = h('div.sv-text', { style: { background: current.background } }, current.text);
    } else if (current.kind === 'video') {
      media = h('video', { src: current.file, autoplay: true, playsinline: true });
      media.addEventListener('loadedmetadata', () => { current._duration = Math.min(60000, media.duration * 1000); });
      media.addEventListener('ended', next);
    } else {
      media = h('img', { src: current.file, alt: '' });
    }
    clear(stage, media, current.kind !== 'text' && current.text ? h('div.sv-caption', current.text) : null);

    if (isMine) {
      clear(footer, h('button.sv-viewers', { type: 'button', onclick: () => showViewers(current) }, icon('eye', 20), ` ${current.view_count || 0} vue${current.view_count > 1 ? 's' : ''}`));
    } else {
      const input = h('input.sv-reply', { placeholder: `Répondre à ${group.user.name.split(' ')[0]}…`, maxlength: 1000 });
      input.addEventListener('focus', () => togglePause(true));
      input.addEventListener('blur', () => { if (!input.value) togglePause(false); });
      input.addEventListener('keydown', async e => {
        if (e.key !== 'Enter' || !input.value.trim()) return;
        const text = input.value.trim();
        input.value = '';
        input.blur();
        await replyToStory(group.user, current, text);
      });
      const like = h('button.sv-like' + (current.liked ? '.liked' : ''), {
        type: 'button', 'aria-label': "J'aime",
        onclick: async () => {
          try {
            const { liked } = await api.post(`stories/${current.id}`, { action: 'like' });
            current.liked = liked;
            like.classList.toggle('liked', liked);
          } catch (e) { errorToast(e); }
        },
      }, icon('heart', 26));
      clear(footer, h('div.sv-quick', QUICK_REACTIONS.slice(0, 5).map(e => h('button', { type: 'button', onclick: () => replyToStory(group.user, current, e) }, e))),
        h('div.row.gap', input, like, btn('send', 'Envoyer', () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })))));
      if (!current.seen) {
        current.seen = true;
        api.post(`stories/${current.id}`, { action: 'view' }).catch(() => {});
        group.all_seen = group.stories.every(s => s.seen);
      }
    }

    startedAt = Date.now();
    const fill = bars.children[si].firstChild;
    timer = setInterval(() => {
      if (paused) return;
      const total = current._duration || DURATION;
      const p = Math.min(1, (elapsed + Date.now() - startedAt) / total);
      fill.style.width = (p * 100) + '%';
      if (p >= 1 && current.kind !== 'video') next();
    }, 50);
  }

  // Maintenir appuyé pour mettre en pause (mobile et souris).
  let holdTimer;
  stage.addEventListener('pointerdown', () => { holdTimer = setTimeout(() => togglePause(true), 200); });
  stage.addEventListener('pointerup', () => { clearTimeout(holdTimer); if (paused) togglePause(false); });

  document.addEventListener('keydown', onKey);
  document.getElementById('overlay-root').appendChild(layer);
  layer.focus();
  show();
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

async function showViewers(story) {
  const body = h('div.pick-list', spinner());
  modal(body, { title: 'Vues' });
  try {
    const { results } = await api.get(`stories/${story.id}/viewers`);
    clear(body, results.length ? results.map(u => h('div.pick-item', avatar(u.avatar, u.name, 40),
      h('div.pick-text', h('div.strong', u.name), h('div.muted.small', ago(u.viewed_at))),
      u.liked ? h('span.liked-heart', icon('heart', 18)) : null)) : h('p.muted.pad', 'Personne pour le moment.'));
  } catch (e) { clear(body, h('p.muted', e.message)); }
}

// ------------------------------------------------------------------ création

const BACKGROUNDS = ['#128C7E', '#25D366', '#34B7F1', '#7c4dff', '#e1306c', '#ff9800', '#f44336', '#3f51b5', '#212121', 'linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)'];

export function createStoryDialog(onDone) {
  let file = null;
  let bgIndex = 0;
  const preview = h('div.story-create-preview');
  const text = h('textarea.story-text-input', { placeholder: 'Tapez un statut', maxlength: 700, rows: 3 });
  const caption = h('input.input', { placeholder: 'Ajouter une légende…', maxlength: 700 });
  const closeFriends = h('input', { type: 'checkbox' });
  const setBg = () => { preview.style.background = BACKGROUNDS[bgIndex]; };
  const textMode = () => {
    file = null;
    clear(preview, text);
    setBg();
    caption.classList.add('hidden');
    text.focus();
  };
  textMode();

  const pick = async () => {
    const [f] = await pickFiles({ accept: 'image/*,video/*' });
    if (!f) return;
    file = f;
    const url = URL.createObjectURL(f);
    preview.style.background = '#000';
    clear(preview, f.type.startsWith('video/') ? h('video', { src: url, controls: true, autoplay: true, muted: true }) : h('img', { src: url, alt: '' }));
    caption.classList.remove('hidden');
  };

  const share = h('button.btn.primary', { type: 'button' }, 'Partager');
  share.onclick = async () => {
    const fd = new FormData();
    if (file) { fd.append('file', file); fd.append('text', caption.value.trim()); }
    else {
      if (!text.value.trim()) return toast('Écrivez quelque chose.');
      fd.append('text', text.value.trim());
      fd.append('background', BACKGROUNDS[bgIndex]);
    }
    fd.append('close_friends_only', closeFriends.checked ? '1' : '0');
    share.disabled = true;
    try {
      await api.post('stories', fd, { onProgress: p => { share.textContent = `Envoi… ${Math.round(p * 100)} %`; } });
      m.close();
      toast('Story publiée');
      onDone && onDone();
    } catch (e) { errorToast(e); share.disabled = false; share.textContent = 'Partager'; }
  };

  const m = modal(h('div.story-create',
    preview,
    h('div.row.gap.wrap',
      h('button.btn.ghost', { type: 'button', onclick: textMode }, icon('edit', 18), ' Texte'),
      h('button.btn.ghost', { type: 'button', onclick: () => { bgIndex = (bgIndex + 1) % BACKGROUNDS.length; if (!file) setBg(); } }, '🎨 Couleur'),
      h('button.btn.ghost', { type: 'button', onclick: pick }, icon('image', 18), ' Photo / vidéo')),
    caption,
    h('label.switch-row', closeFriends, h('span', 'Amis proches uniquement')),
    h('div.modal-actions', share)), { title: 'Nouvelle story' });
}
