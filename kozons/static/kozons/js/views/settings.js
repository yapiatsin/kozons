// Paramètres : profil, confidentialité, apparence, notifications, comptes bloqués, sécurité ; messages importants.
import { api } from '../api.js';
import { state, prefs, convTitle } from '../store.js';
import { h, clear, icon, avatar, toast, errorToast, pickFiles, spinner, empty, listTime } from '../ui.js';
import { previewText } from '../chatdata.js';
import { passwordInput, passwordChecklist, passwordIsValid } from './auth.js';

export function render(stage, params) {
  if (params.starred) return renderStarred(stage);
  const page = h('div.page.narrow.settings');
  stage.appendChild(page);
  build(page);
}

function setMe(user) {
  state.me = user;
  window.dispatchEvent(new CustomEvent('kozons:me', { detail: user }));
}

function build(page) {
  const me = state.me;
  const save = async data => {
    try { const { user } = await api.post('me', data); setMe(user); toast('Enregistré'); return user; }
    catch (e) { errorToast(e); }
  };

  // --- Profil
  const avatarBox = h('button.settings-avatar', {
    type: 'button',
    onclick: async () => {
      const [f] = await pickFiles({ accept: 'image/*' });
      if (!f) return;
      const fd = new FormData(); fd.append('avatar', f);
      const u = await save(fd);
      if (u) build(page);
    },
  }, avatar(me.avatar, me.name, 120), h('span.avatar-edit', icon('camera', 22), 'Changer'));
  const field = (label, key, { multiline, max, placeholder } = {}) => {
    const input = h(multiline ? 'textarea.input' : 'input.input', { value: me[key] || '', maxlength: max, placeholder, rows: multiline ? 3 : undefined });
    return h('label.field', { dataset: { key } }, h('span.label', label), input);
  };
  const fields = [
    field('Nom', 'display_name', { max: 64, placeholder: 'Votre nom' }),
    field('Infos (statut WhatsApp)', 'about', { max: 140 }),
    field('Bio', 'bio', { multiline: true, max: 500 }),
    field('Site web', 'website', { max: 200, placeholder: 'https://' }),
    field('Téléphone', 'phone', { max: 32 }),
    field('E-mail', 'email', { max: 254 }),
  ];
  const profileForm = h('div.settings-card',
    h('h3', 'Profil'),
    h('div.center', avatarBox, me.avatar ? h('button.link', { type: 'button', onclick: async () => { await save({ remove_avatar: true }); build(page); } }, 'Supprimer la photo') : null),
    h('div.muted.center', '@' + me.username),
    fields,
    h('div.modal-actions', h('button.btn.primary', {
      type: 'button',
      onclick: () => {
        const data = {};
        fields.forEach(f => { const input = f.querySelector('input,textarea'); data[f.dataset.key] = input.value; });
        save(data);
      },
    }, 'Enregistrer')));

  // --- Confidentialité
  const select = (label, key) => h('label.info-row', h('span.grow', label),
    h('select.input.compact', { onchange: e => save({ [key]: e.target.value }) },
      [['everyone', 'Tout le monde'], ['contacts', 'Mes contacts'], ['nobody', 'Personne']].map(([v, l]) => h('option', { value: v, selected: me[key] === v }, l))));
  const toggle = (label, key, hint) => h('label.info-row', h('div.grow', h('div', label), hint ? h('div.muted.small', hint) : null),
    h('input.toggle', { type: 'checkbox', checked: !!me[key], onchange: e => save({ [key]: e.target.checked }) }));
  const privacy = h('div.settings-card',
    h('h3', 'Confidentialité'),
    select('Vu à / En ligne', 'last_seen_visibility'),
    select('Photo de profil', 'avatar_visibility'),
    toggle('Confirmations de lecture', 'read_receipts', 'Si désactivé, vous ne verrez pas non plus les confirmations des autres dans les discussions privées.'),
    toggle('Compte privé', 'is_private', "Seuls vos abonnés approuvés voient vos publications et reels."));

  // --- Apparence
  const theme = prefs.get('theme', 'system');
  const wallpaper = prefs.get('wallpaper', 'default');
  const appearance = h('div.settings-card',
    h('h3', 'Apparence'),
    h('label.info-row', icon('moon'), h('span.grow', 'Thème'),
      h('select.input.compact', { onchange: e => { prefs.set('theme', e.target.value); window.kozons.applyTheme(); } },
        [['system', 'Système'], ['light', 'Clair'], ['dark', 'Sombre']].map(([v, l]) => h('option', { value: v, selected: theme === v }, l)))),
    h('label.info-row', icon('image'), h('span.grow', 'Fond des discussions'),
      h('select.input.compact', { onchange: e => prefs.set('wallpaper', e.target.value) },
        [['default', 'Motif Kozons'], ['none', 'Uni']].map(([v, l]) => h('option', { value: v, selected: wallpaper === v }, l)))));

  // --- Notifications
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const notifs = h('div.settings-card',
    h('h3', 'Notifications'),
    h('div.info-row', icon('bell'), h('div.grow', h('div', 'Notifications du navigateur'),
      h('div.muted.small', { granted: 'Activées', denied: 'Bloquées dans les réglages du navigateur', default: 'Non activées', unsupported: 'Non prises en charge' }[perm])),
    perm === 'default' ? h('button.btn.primary.small', { onclick: () => Notification.requestPermission().then(() => build(page)) }, 'Activer') : null));

  // --- Comptes bloqués
  const blockedList = h('div', spinner(20));
  api.get('users/blocked').then(({ results }) => clear(blockedList, results.length ? results.map(u => h('div.info-row',
    avatar(u.avatar, u.name, 36), h('span.grow', u.name),
    h('button.btn.ghost.small', { onclick: async () => { await api.post(`users/${u.id}/block`).catch(errorToast); build(page); } }, 'Débloquer')))
    : h('div.muted.small', 'Aucun compte bloqué'))).catch(() => clear(blockedList));
  const blocked = h('div.settings-card', h('h3', 'Comptes bloqués'), blockedList);

  // --- Sécurité
  const oldPwField = passwordInput({ name: 'old_password', placeholder: 'Mot de passe actuel' });
  const newPwField = passwordInput({ name: 'new_password', placeholder: 'Nouveau mot de passe', autocomplete: 'new-password' });
  const oldPw = oldPwField.input, newPw = newPwField.input;
  const security = h('div.settings-card',
    h('h3', 'Sécurité'),
    h('div.pw-stack', oldPwField.el, newPwField.el, passwordChecklist(newPw)),
    h('div.modal-actions', h('button.btn.ghost', {
      type: 'button',
      onclick: async () => {
        if (!passwordIsValid(newPw.value)) return toast('Le nouveau mot de passe ne respecte pas toutes les règles.', { type: 'error' });
        try { await api.post('auth/password', { old_password: oldPw.value, new_password: newPw.value }); oldPw.value = newPw.value = ''; newPw.dispatchEvent(new Event('input')); toast('Mot de passe modifié'); }
        catch (e) { errorToast(e); }
      },
    }, 'Changer le mot de passe')));

  const other = h('div.settings-card',
    h('button.info-row', { type: 'button', onclick: () => window.kozons.go('/starred') }, icon('star'), h('span.grow', 'Messages importants')),
    h('button.info-row', { type: 'button', onclick: () => window.kozons.go('/u/' + me.username) }, icon('user'), h('span.grow', 'Voir mon profil public')),
    h('button.info-row.danger', { type: 'button', onclick: () => window.kozons.logout() }, icon('logout'), h('span.grow', 'Se déconnecter')));

  clear(page, h('header.page-head', h('h2', 'Paramètres')), profileForm, privacy, appearance, notifs, blocked, security, other);
}

async function renderStarred(stage) {
  const list = h('div', spinner());
  stage.appendChild(h('div.page.narrow', h('header.page-head', h('h2', 'Messages importants')), list));
  try {
    const { results } = await api.get('messages/starred');
    clear(list, results.length ? results.map(m => {
      const conv = state.conversations.get(m.conversation_id);
      return h('button.starred-row', { type: 'button', onclick: () => window.kozons.go('/chats/' + m.conversation_id) },
        avatar(m.sender ? m.sender.avatar : null, m.sender ? m.sender.name : '?', 36),
        h('div.grow',
          h('div.row.space', h('span.strong', `${m.sender_id === state.me.id ? 'Vous' : (m.sender || {}).name} ▸ ${conv ? convTitle(conv) : ''}`), h('span.muted.small', listTime(m.created_at))),
          h('div.starred-text', previewText(m))),
        icon('star', 16, 'star'));
    }) : empty('star', 'Aucun message important', 'Appuyez longuement ou faites un clic droit sur un message pour le marquer comme important.'));
  } catch (e) { errorToast(e); }
}
