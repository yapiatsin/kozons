// Boîtes de dialogue des discussions : nouvelle discussion, groupe, transfert, contact, sondage, aperçu média.
import { api } from '../api.js';
import { state, sortedConversations, convTitle, convAvatar, peerOf } from '../store.js';
import { h, clear, icon, avatar, modal, debounce, errorToast, toast, pickFiles, spinner, bytes } from '../ui.js';

/** Sélecteur d'utilisateurs avec recherche ; `multi` pour une sélection multiple. */
function userPicker({ multi = false, onPick, exclude = new Set() }) {
  const selected = new Map();
  const chips = h('div.chips');
  const list = h('div.pick-list');
  const input = h('input.input', { placeholder: 'Rechercher un nom ou @utilisateur', type: 'search' });

  const known = () => {
    const users = new Map();
    for (const c of sortedConversations()) {
      for (const p of c.participants) if (p.user.id !== state.me.id && !exclude.has(p.user.id)) users.set(p.user.id, p.user);
    }
    return [...users.values()];
  };

  const renderList = (users, title) => {
    clear(list, title ? h('div.list-title', title) : null,
      users.length ? users.map(u => h('button.pick-item', { type: 'button', onclick: () => toggle(u) },
        avatar(u.avatar, u.name, 40),
        h('div.pick-text', h('div.strong', u.name), h('div.muted', '@' + u.username + (u.about ? ' · ' + u.about : ''))),
        multi ? h('span.checkbox' + (selected.has(u.id) ? '.on' : ''), selected.has(u.id) ? icon('check', 14) : null) : null))
        : h('div.muted.pad', 'Aucun résultat'));
  };

  const toggle = u => {
    if (!multi) return onPick(u);
    if (selected.has(u.id)) selected.delete(u.id); else selected.set(u.id, u);
    clear(chips, [...selected.values()].map(s => h('span.chip', avatar(s.avatar, s.name, 22), s.name,
      h('button', { type: 'button', onclick: () => toggle(s) }, icon('close', 12)))));
    search();
  };

  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) return renderList(known(), 'Contacts récents');
    try {
      const { results } = await api.get('users/search', { q });
      renderList(results.filter(u => !exclude.has(u.id)), 'Résultats');
    } catch (e) { errorToast(e); }
  }, 250);
  input.addEventListener('input', search);
  renderList(known(), 'Contacts récents');
  return { el: h('div.user-picker', input, chips, list), selected, input };
}

export function newChatDialog() {
  let m;
  const picker = userPicker({
    onPick: async u => {
      try {
        const conv = await api.post('conversations/direct', { user_id: u.id });
        m.close();
        window.kozons.go('/chats/' + conv.id);
      } catch (e) { errorToast(e); }
    },
  });
  m = modal(h('div',
    h('button.pick-item.accent', { type: 'button', onclick: () => { m.close(); newGroupDialog(); } },
      h('div.avatar.accent-bg', { style: { width: '40px', height: '40px' } }, icon('users', 22)), h('div.strong', 'Nouveau groupe')),
    picker.el), { title: 'Nouvelle discussion' });
}

export function newGroupDialog() {
  const picker = userPicker({ multi: true });
  let iconFile = null;
  const iconPreview = h('button.group-icon-pick', { type: 'button', title: 'Icône du groupe', onclick: async () => {
    const [f] = await pickFiles({ accept: 'image/*' });
    if (f) { iconFile = f; clear(iconPreview, h('img', { src: URL.createObjectURL(f), alt: '' })); }
  } }, icon('camera', 26));
  const title = h('input.input', { placeholder: 'Nom du groupe', maxlength: 100 });
  const desc = h('input.input', { placeholder: 'Description (facultatif)', maxlength: 1000 });
  const step2 = h('div.hidden', h('div.row.gap', iconPreview, h('div.grow', title, desc)));
  const nextBtn = h('button.btn.primary', { type: 'button' }, 'Suivant');
  let step = 1;
  nextBtn.onclick = async () => {
    if (step === 1) {
      if (!picker.selected.size) return toast('Sélectionnez au moins un participant.');
      step = 2;
      picker.el.classList.add('hidden');
      step2.classList.remove('hidden');
      nextBtn.textContent = 'Créer le groupe';
      title.focus();
      return;
    }
    if (!title.value.trim()) return toast('Donnez un nom au groupe.');
    nextBtn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('title', title.value.trim());
      fd.append('description', desc.value.trim());
      fd.append('member_ids', [...picker.selected.keys()].join(','));
      if (iconFile) fd.append('avatar', iconFile);
      const conv = await api.post('conversations/group', fd);
      m.close();
      window.kozons.go('/chats/' + conv.id);
    } catch (e) { errorToast(e); nextBtn.disabled = false; }
  };
  const m = modal(h('div', picker.el, step2, h('div.modal-actions', nextBtn)), { title: 'Nouveau groupe' });
}

export function addMembersDialog(conv, onDone) {
  const exclude = new Set(conv.participants.map(p => p.user.id));
  const picker = userPicker({ multi: true, exclude });
  const m = modal(h('div', picker.el, h('div.modal-actions',
    h('button.btn.primary', {
      type: 'button',
      onclick: async () => {
        if (!picker.selected.size) return;
        try {
          await api.post(`conversations/${conv.id}/members`, { action: 'add', member_ids: [...picker.selected.keys()] });
          m.close(); onDone && onDone();
        } catch (e) { errorToast(e); }
      },
    }, 'Ajouter'))), { title: 'Ajouter des participants' });
}

/** Choix de discussions (transfert de message, partage de publication). */
export function chooseConversations(title, onConfirm, { max = 5 } = {}) {
  const selected = new Set();
  const list = h('div.pick-list');
  const input = h('input.input', { type: 'search', placeholder: 'Rechercher' });
  const confirm = h('button.btn.primary', { type: 'button', disabled: true }, 'Envoyer');
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const convs = sortedConversations().filter(c => !q || convTitle(c).toLowerCase().includes(q));
    clear(list, convs.map(c => h('button.pick-item', {
      type: 'button',
      onclick: () => {
        if (selected.has(c.id)) selected.delete(c.id);
        else if (selected.size < max) selected.add(c.id);
        else toast(`${max} discussions maximum.`);
        confirm.disabled = !selected.size;
        render();
      },
    }, avatar(convAvatar(c), convTitle(c), 40, { group: c.kind === 'group' }),
    h('div.pick-text', h('div.strong', convTitle(c)), h('div.muted', c.kind === 'group' ? `${c.participants.length} participants` : '@' + (peerOf(c) || {}).username)),
    h('span.checkbox' + (selected.has(c.id) ? '.on' : ''), selected.has(c.id) ? icon('check', 14) : null))));
  };
  input.addEventListener('input', render);
  render();
  confirm.onclick = async () => {
    confirm.disabled = true;
    try { await onConfirm([...selected]); m.close(); } catch (e) { errorToast(e); confirm.disabled = false; }
  };
  const m = modal(h('div', input, list, h('div.modal-actions', confirm)), { title });
}

export function forwardDialog(msg) {
  chooseConversations('Transférer le message', async ids => {
    await api.post(`messages/${msg.id}/forward`, { conversation_ids: ids });
    toast(ids.length > 1 ? `Transféré à ${ids.length} discussions` : 'Message transféré');
  });
}

export function contactDialog(onPick) {
  let m;
  const picker = userPicker({ onPick: u => { m.close(); onPick(u); } });
  m = modal(picker.el, { title: 'Partager un contact' });
}

export function pollDialog(onCreate) {
  const question = h('input.input', { placeholder: 'Posez une question', maxlength: 255 });
  const options = h('div.poll-edit');
  const multiple = h('input', { type: 'checkbox', checked: true });
  const addOption = (value = '') => {
    const input = h('input.input', { placeholder: 'Option ' + (options.children.length + 1), maxlength: 100, value });
    input.addEventListener('input', () => {
      const inputs = [...options.querySelectorAll('input')];
      if (input === inputs[inputs.length - 1] && input.value && inputs.length < 12) addOption();
    });
    options.appendChild(input);
  };
  addOption(); addOption();
  const m = modal(h('div',
    h('label.label', 'Question'), question,
    h('label.label', 'Options'), options,
    h('label.switch-row', multiple, h('span', 'Autoriser plusieurs réponses')),
    h('div.modal-actions', h('button.btn.primary', {
      type: 'button',
      onclick: () => {
        const opts = [...options.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
        if (!question.value.trim() || opts.length < 2) return toast('Une question et au moins 2 options sont requises.');
        m.close();
        onCreate({ question: question.value.trim(), options: opts, multiple: multiple.checked });
      },
    }, 'Envoyer'))), { title: 'Créer un sondage' });
}

/** Aperçu avant envoi de fichiers, avec légende et option « vue unique ». */
export function mediaPreviewDialog(files, onSend, { viewOnce = false } = {}) {
  let index = 0;
  const captions = files.map(() => '');
  const stage = h('div.preview-stage');
  const thumbs = h('div.preview-thumbs');
  const caption = h('input.input', { placeholder: 'Ajouter une légende…', maxlength: 4000 });
  const once = h('input', { type: 'checkbox', checked: viewOnce });
  const isVisual = f => f.type.startsWith('image/') || f.type.startsWith('video/');
  const show = i => {
    captions[index] = caption.value;
    index = i;
    const f = files[i];
    const url = URL.createObjectURL(f);
    clear(stage, f.type.startsWith('image/') ? h('img', { src: url, alt: '' })
      : f.type.startsWith('video/') ? h('video', { src: url, controls: true })
        : h('div.preview-doc', icon('doc', 64), h('div.strong', f.name), h('div.muted', bytes(f.size))));
    caption.value = captions[i];
    thumbs.querySelectorAll('button').forEach((b, j) => b.classList.toggle('active', j === i));
  };
  files.forEach((f, i) => thumbs.appendChild(h('button.preview-thumb', { type: 'button', onclick: () => show(i) },
    f.type.startsWith('image/') ? h('img', { src: URL.createObjectURL(f), alt: '' }) : icon(f.type.startsWith('video/') ? 'video' : 'doc', 22))));
  show(0);
  caption.addEventListener('keydown', e => { if (e.key === 'Enter') sendAll(); });
  const sendAll = () => {
    captions[index] = caption.value;
    m.close();
    files.forEach((f, i) => onSend(f, captions[i], once.checked && isVisual(f)));
  };
  const m = modal(h('div.media-preview', stage, files.length > 1 ? thumbs : null,
    h('div.row.gap.preview-bar', caption,
      files.some(isVisual) ? h('label.once-toggle', { title: 'Vue unique' }, once, icon('once', 20)) : null,
      h('button.send-btn', { type: 'button', onclick: sendAll, 'aria-label': 'Envoyer' }, icon('send', 22)))),
  { title: files.length > 1 ? `${files.length} fichiers` : 'Envoyer', wide: true });
}

export function reactionsDialog(msg, conv) {
  const users = new Map(conv.participants.map(p => [p.user.id, p.user]));
  modal(h('div.pick-list', msg.reactions.map(r => {
    const u = r.user_id === state.me.id ? state.me : users.get(r.user_id) || { name: 'Utilisateur', avatar: null, username: '' };
    return h('div.pick-item', avatar(u.avatar, u.name, 36),
      h('div.pick-text', h('div.strong', r.user_id === state.me.id ? 'Vous' : u.name),
        r.user_id === state.me.id ? h('div.muted.small', 'Appuyez pour retirer') : null),
      h('span.big-emoji', { onclick: () => r.user_id === state.me.id && api.post(`messages/${msg.id}/react`, { emoji: r.emoji }).catch(errorToast) }, r.emoji));
  })), { title: `${msg.reactions.length} réaction${msg.reactions.length > 1 ? 's' : ''}` });
}

export async function messageInfoDialog(msg) {
  const body = h('div', spinner());
  modal(body, { title: 'Infos du message' });
  try {
    const { results } = await api.get(`messages/${msg.id}/info`);
    const read = results.filter(r => r.read), delivered = results.filter(r => r.delivered && !r.read), pending = results.filter(r => !r.delivered);
    const section = (title, items, ic) => items.length ? h('div', h('div.list-title', icon(ic, 16), ' ', title),
      items.map(r => h('div.pick-item', avatar(r.user.avatar, r.user.name, 36), h('div.strong', r.user.name)))) : null;
    clear(body, section('Lu par', read, 'checks'), section('Distribué à', delivered, 'checks'), section('En attente', pending, 'clock'));
  } catch (e) { clear(body, h('p.muted', e.message)); }
}
