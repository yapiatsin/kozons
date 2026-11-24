// Panneau latéral « Infos du contact / du groupe ».
import { api } from '../api.js';
import { bus, state, peerOf, isMuted, convTitle, convAvatar } from '../store.js';
import { h, clear, icon, btn, avatar, menu, errorToast, promptDialog, pickFiles, lastSeenLabel, listTime, spinner, bytes, lightbox, toast } from '../ui.js';
import { addMembersDialog } from './dialogs.js';

export function renderInfo(el, conv, ctx) {
  const isGroup = conv.kind === 'group';
  const peer = peerOf(conv);
  const me = conv.me;
  const canEdit = isGroup && (me.role === 'admin' || !conv.only_admins_can_edit);
  const setting = data => api.post(`conversations/${conv.id}/settings`, data)
    .then(c => { state.conversations.set(c.id, c); bus.emit('conversations:changed', c.id); }).catch(errorToast);
  const update = data => api.post(`conversations/${conv.id}/update`, data).catch(errorToast);

  const mediaStrip = h('div.media-strip', spinner(20));
  loadMedia(conv, mediaStrip, 'media', 6);

  const head = h('div.info-hero',
    h('div.info-avatar' + (canEdit ? '.editable' : ''), {
      onclick: async () => {
        if (!canEdit) { const src = convAvatar(conv); if (src) lightbox(src); return; }
        const [f] = await pickFiles({ accept: 'image/*' });
        if (f) { const fd = new FormData(); fd.append('avatar', f); update(fd); }
      },
    }, avatar(convAvatar(conv), convTitle(conv), 180, { group: isGroup }), canEdit ? h('div.avatar-edit', icon('camera', 24), 'Changer') : null),
    h('h2', convTitle(conv), canEdit ? btn('edit', 'Renommer', async () => {
      const v = await promptDialog('Nom du groupe', { value: conv.title, maxlength: 100 });
      if (v && v.trim()) update({ title: v.trim() });
    }, 'small') : null),
    isGroup ? h('div.muted', `Groupe · ${conv.participants.length} participant${conv.participants.length > 1 ? 's' : ''}`)
      : h('div.muted', '@' + peer.username + (peer.online !== null ? ' · ' + (lastSeenLabel(peer) || '') : '')),
    !isGroup ? h('div.info-actions',
      h('button', { type: 'button', onclick: () => ctx.onCall(peer, false) }, icon('phone'), 'Audio'),
      h('button', { type: 'button', onclick: () => ctx.onCall(peer, true) }, icon('video'), 'Vidéo'),
      h('button', { type: 'button', onclick: () => window.kozons.go('/u/' + peer.username) }, icon('user'), 'Profil'),
      h('button', { type: 'button', onclick: () => ctx.close() }, icon('search'), 'Chercher')) : null);

  const about = isGroup
    ? h('div.info-section.clickable', { onclick: async () => {
      if (!canEdit) return;
      const v = await promptDialog('Description du groupe', { value: conv.description, multiline: true, maxlength: 1000 });
      if (v !== null) update({ description: v });
    } },
    h('div.muted.small', 'Description'),
    h('div.pre', conv.description || (canEdit ? 'Ajouter une description au groupe' : 'Aucune description')),
    h('div.muted.small', `Créé le ${new Date(conv.created_at).toLocaleDateString('fr-FR')}`))
    : h('div.info-section', h('div.muted.small', 'Infos'), h('div', peer.about || '—'));

  const sections = [
    head, about,
    h('div.info-section',
      h('div.row.space', h('span.muted.small', 'Médias, liens et documents'), h('button.link', { type: 'button', onclick: () => mediaBrowser(el, conv, ctx) }, 'Tout voir ›')),
      mediaStrip),
    h('div.info-section.list',
      h('button.info-row', { type: 'button', onclick: () => window.kozons.go('/starred') }, icon('star'), h('span.grow', 'Messages importants')),
      h('label.info-row', icon('bellOff'), h('span.grow', 'Mettre en sourdine'),
        h('input.toggle', { type: 'checkbox', checked: !!isMuted(conv), onchange: e => setting({ mute_hours: e.target.checked ? -1 : 0 }) })),
      h('button.info-row', { type: 'button', onclick: () => import('./chats.js').then(m => m.disappearingDialog(conv)) }, icon('timer'),
        h('div.grow', h('div', 'Messages éphémères'), h('div.muted.small', conv.disappearing_seconds ? ({ 86400: '24 heures', 604800: '7 jours', 7776000: '90 jours' })[conv.disappearing_seconds] : 'Désactivé'))),
      h('div.info-row', icon('lock'), h('div.grow', h('div', 'Confidentialité'), h('div.muted.small', 'Seuls les membres de la discussion peuvent lire les messages.')))),
  ];

  if (isGroup) {
    if (me.role === 'admin') {
      sections.push(h('div.info-section.list',
        h('div.muted.small', "Paramètres d'administration"),
        h('label.info-row', h('span.grow', 'Seuls les admins envoient des messages'),
          h('input.toggle', { type: 'checkbox', checked: conv.only_admins_can_send, onchange: e => update({ only_admins_can_send: e.target.checked }) })),
        h('label.info-row', h('span.grow', 'Seuls les admins modifient les infos'),
          h('input.toggle', { type: 'checkbox', checked: conv.only_admins_can_edit, onchange: e => update({ only_admins_can_edit: e.target.checked }) }))));
    }
    const members = [...conv.participants].sort((a, b) => (b.user.id === state.me.id) - (a.user.id === state.me.id) || (b.role === 'admin') - (a.role === 'admin') || a.user.name.localeCompare(b.user.name));
    sections.push(h('div.info-section.list',
      h('div.muted.small', `${conv.participants.length} participants`),
      me.role === 'admin' ? h('button.info-row.accent', { type: 'button', onclick: () => addMembersDialog(conv) },
        h('div.avatar.accent-bg', { style: { width: '40px', height: '40px' } }, icon('plus', 20)), h('span', 'Ajouter des participants')) : null,
      members.map(p => h('button.info-row.member', {
        type: 'button',
        onclick: e => p.user.id !== state.me.id && memberMenu(conv, p, e.currentTarget),
      }, avatar(p.user.avatar, p.user.name, 40, { online: p.user.online }),
      h('div.grow', h('div', p.user.id === state.me.id ? 'Vous' : p.user.name), h('div.muted.small.ellipsis', p.user.about || '@' + p.user.username)),
      p.role === 'admin' ? h('span.admin-tag', 'Admin') : null))));
  }

  sections.push(h('div.info-section.list',
    !isGroup ? h('button.info-row.danger', { type: 'button', onclick: () => import('./chats.js').then(m => m.toggleBlock(conv, peer)) }, icon('block'),
      h('span', conv.blocked.by_me ? `Débloquer ${peer.name}` : `Bloquer ${peer.name}`)) : null,
    h('button.info-row.danger', { type: 'button', onclick: () => import('./chats.js').then(m => m.clearChat(conv)) }, icon('trash'), h('span', 'Vider la discussion')),
    isGroup ? h('button.info-row.danger', { type: 'button', onclick: () => import('./chats.js').then(m => m.leaveGroup(conv)) }, icon('logout'), h('span', 'Quitter le groupe')) : null));

  clear(el,
    h('header.drawer-head', btn('close', 'Fermer', ctx.close), h('h3', isGroup ? 'Infos du groupe' : 'Infos du contact')),
    h('div.drawer-body', sections));
}

function memberMenu(conv, p, anchor) {
  const isAdmin = conv.me.role === 'admin';
  const action = (a, label) => api.post(`conversations/${conv.id}/members`, { action: a, member_ids: [p.user.id] })
    .then(() => toast(label)).catch(errorToast);
  menu(anchor, [
    { label: `Envoyer un message à ${p.user.name}`, icon: 'chat', action: async () => {
      try { const c = await api.post('conversations/direct', { user_id: p.user.id }); window.kozons.go('/chats/' + c.id); } catch (e) { errorToast(e); }
    } },
    { label: 'Voir le profil', icon: 'user', action: () => window.kozons.go('/u/' + p.user.username) },
    isAdmin && p.role !== 'admin' ? { label: 'Nommer admin du groupe', icon: 'star', action: () => action('promote', `${p.user.name} est maintenant admin`) } : null,
    isAdmin && p.role === 'admin' ? { label: 'Retirer les droits admin', icon: 'star', action: () => action('demote', 'Droits admin retirés') } : null,
    isAdmin ? { label: `Retirer ${p.user.name}`, icon: 'trash', danger: true, action: () => action('remove', `${p.user.name} a été retiré(e)`) } : null,
  ]);
}

async function loadMedia(conv, target, type, limit) {
  try {
    const { results } = await api.get(`conversations/${conv.id}/media`, { type });
    const items = limit ? results.slice(0, limit) : results;
    if (!items.length) return clear(target, h('div.muted.small', 'Aucun élément'));
    if (type === 'media') {
      clear(target, items.map(m => h('button.media-thumb', { type: 'button', onclick: () => lightbox(m.file, m.kind) },
        m.kind === 'video' ? [h('video', { src: m.file, preload: 'metadata', muted: true }), h('span.play-badge', icon('play', 14))] : h('img', { src: m.file, alt: '', loading: 'lazy' }))));
    } else if (type === 'docs') {
      clear(target, items.map(m => h('a.doc', { href: m.file, target: '_blank', rel: 'noopener', download: m.file_name },
        h('div.doc-icon', icon('doc', 22)), h('div.doc-info', h('div.doc-name', m.file_name), h('div.doc-size', bytes(m.file_size) + ' · ' + listTime(m.created_at))))));
    } else {
      const links = items.flatMap(m => (m.text.match(/https?:\/\/[^\s<]+/g) || []).map(url => ({ url, at: m.created_at })));
      clear(target, links.map(l => h('a.link-row', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 18), h('span.ellipsis', l.url))));
    }
  } catch (e) { clear(target, h('div.muted.small', e.message)); }
}

function mediaBrowser(el, conv, ctx) {
  const body = h('div.media-browser');
  const tabs = h('div.tabs');
  const show = type => {
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.type === type));
    clear(body, spinner());
    loadMedia(conv, body, type, 0);
    body.className = 'media-browser ' + (type === 'media' ? 'media-grid' : 'list');
  };
  [['media', 'Médias'], ['docs', 'Documents'], ['links', 'Liens']].forEach(([t, l]) => tabs.appendChild(h('button', { type: 'button', dataset: { type: t }, onclick: () => show(t) }, l)));
  clear(el, h('header.drawer-head', btn('back', 'Retour', () => renderInfo(el, state.conversations.get(conv.id) || conv, ctx)), h('h3', 'Médias, liens et docs')), tabs, h('div.drawer-body', body));
  show('media');
}
