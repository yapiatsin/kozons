// Kozons Meet : accueil (nouvelle réunion, rejoindre, agenda), salle d'attente / aperçu, notes IA.
import { api } from '../api.js';
import { bus, state } from '../store.js';
import { send } from '../ws.js';
import { h, clear, icon, btn, avatar, menu, modal, toast, errorToast, confirmDialog, debounce, spinner, empty, timeHM } from '../ui.js';
import { LocalMedia, devicesDialog } from './meetroom.js';

const go = path => window.kozons.go(path);
const meetUrl = code => `${location.origin}/meet/${code}`;

export function render(stage, params) {
  if (params.notes) return params.id ? renderNotesDetail(stage, params.id) : renderNotesList(stage);
  if (params.code) return renderMeeting(stage, params.code, params);
  return renderHome(stage);
}

function copy(text, done = 'Lien copié') {
  navigator.clipboard.writeText(text).then(() => toast(done)).catch(() => toast(text, { timeout: 8000 }));
}

function fmtRange(m) {
  if (!m.scheduled_at) return 'Réunion instantanée';
  const start = new Date(m.scheduled_at);
  const end = new Date(start.getTime() + m.duration_minutes * 60000);
  return `${start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

// ------------------------------------------------------------------ accueil

function renderHome(stage) {
  let selected = startOfDay(new Date());
  let stripStart = addDays(selected, -1);   // 7 jours affichés à partir d'hier
  let data = { scheduled: [], recent: [], ai_enabled: false };
  const code = h('input.input.mt-code-input', { placeholder: 'Saisir un code ou un lien', 'aria-label': 'Code ou lien de la réunion' });
  const joinBtn = h('button.btn.ghost', { disabled: true, onclick: () => joinCode() }, 'Participer');
  code.addEventListener('input', () => { joinBtn.disabled = !code.value.trim(); });
  code.addEventListener('keydown', e => { if (e.key === 'Enter' && code.value.trim()) joinCode(); });
  const joinCode = () => {
    const raw = code.value.trim();
    const value = raw.includes('/') ? raw.replace(/\/+$/, '').split('/').pop() : raw;
    go('/meet/' + encodeURIComponent(value.toLowerCase().replace(/\s+/g, '')));
  };

  const newBtn = h('button.btn.primary', { onclick: e => menu(e.currentTarget, [
    { label: 'Démarrer une réunion instantanée', icon: 'video', action: instantMeeting },
    { label: 'Créer une réunion pour plus tard', icon: 'link', action: laterMeeting },
    { label: 'Programmer une réunion', icon: 'clock', action: () => scheduleDialog(null, () => load()) },
  ]) }, icon('video', 18), ' Nouvelle réunion');

  const days = h('div.mt-days');
  const list = h('div.mt-agenda', spinner());
  const recent = h('div.mt-recent');
  const dateLabel = h('h3.mt-date');

  const shift = n => { stripStart = addDays(stripStart, n); selected = addDays(stripStart, 1); paintDays(); paintList(); load(); };
  const paintDays = () => {
    clear(days,
      btn('back', 'Jours précédents', () => shift(-7)),
      h('div.mt-days-track', Array.from({ length: 7 }, (_, i) => {
        const d = addDays(stripStart, i);
        const count = data.scheduled.filter(m => sameDay(new Date(m.scheduled_at), d)).length;
        return h('button.mt-day' + (sameDay(d, selected) ? '.active' : '') + (sameDay(d, new Date()) ? '.today' : ''), { type: 'button', onclick: () => { selected = d; paintDays(); paintList(); } },
          h('small', d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '').toUpperCase()), h('strong', String(d.getDate())), count ? h('span.mt-day-dot') : null);
      })),
      h('button.icon-btn', { type: 'button', title: 'Jours suivants', onclick: () => shift(7) }, h('span.mt-flip', icon('back'))));
    // Jour choisi visible dans la bande (elle défile seule sur téléphone).
    const track = days.querySelector('.mt-days-track');
    const active = days.querySelector('.mt-day.active');
    if (active) requestAnimationFrame(() => { track.scrollLeft = active.offsetLeft - track.offsetLeft - (track.clientWidth - active.offsetWidth) / 2; });
    dateLabel.textContent = selected.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  const paintList = () => {
    const items = data.scheduled.filter(m => sameDay(new Date(m.scheduled_at), selected));
    clear(list, items.length ? items.map(m => meetingCard(m, load)) : h('div.mt-empty',
      h('div.mt-empty-art', icon('clock', 48)),
      h('h3', sameDay(selected, new Date()) ? "Aucune réunion programmée pour aujourd'hui" : 'Aucune réunion programmée ce jour-là'),
      h('p.muted', 'Planifiez une réunion ou profitez de votre temps libre'),
      h('button.btn.primary', { onclick: () => scheduleDialog(selected, () => load()) }, icon('plus', 18), ' Programmer')));
    clear(recent, data.recent.length ? [h('h4.mt-section-title', 'Réunions récentes'), ...data.recent.slice(0, 6).map(m => h('div.mt-recent-item',
      h('div.mt-recent-icon', icon('video', 18)),
      h('div.mt-recent-text', h('strong', m.label), h('small', m.code + (m.in_progress ? ` · en cours (${m.participants_now})` : ''))),
      h('button.btn.small.' + (m.in_progress ? 'primary' : 'ghost'), { onclick: () => go('/meet/' + m.code) }, m.in_progress ? 'Rejoindre' : 'Relancer')))] : null);
  };

  const load = async () => {
    try {
      data = await api.get(`meet?from=${encodeURIComponent(addDays(stripStart, -1).toISOString())}&days=9`);
      paintDays();
      paintList();
    } catch (e) { clear(list, h('p.muted', e.message)); }
  };

  stage.appendChild(h('div.page.mt-home',
    h('header.mt-home-head',
      h('div.mt-brand', h('span.mt-logo', icon('video', 22)), h('strong', 'Kozons'), h('span', ' Meet')),
      h('div.mt-home-actions',
        h('button.btn.ghost', { onclick: () => go('/meet/notes') }, icon('doc', 18), ' Notes IA'))),
    h('section.mt-hero',
      h('div.mt-hero-text',
        h('h1', 'Visioconférences pour tous, sans limite de durée'),
        h('p.muted', 'Réunions vidéo, partage d’écran, sous-titres en direct et comptes rendus rédigés par l’IA, directement dans Kozons.'),
        h('div.mt-hero-actions', newBtn, h('div.mt-code-box', icon('keyboard', 20), code), joinBtn))),
    h('section.mt-schedule',
      h('div.mt-schedule-head', dateLabel, days),
      list,
      recent)));
  paintDays();
  load();
  const offs = [bus.on('meet.invited', load), bus.on('meet.cancelled', load)];
  return () => offs.forEach(f => f());
}

function meetingCard(m, reload) {
  return h('div.mt-card' + (m.in_progress ? '.live' : ''),
    h('div.mt-card-time', fmtRange(m)),
    h('div.mt-card-body',
      h('strong', m.label),
      h('small.muted', m.role === 'host' ? 'Vous organisez' : `Organisée par ${m.host.name}`),
      m.in_progress ? h('span.mt-live-badge', `● En cours · ${m.participants_now}`) : null),
    h('div.mt-card-actions',
      h('button.btn.small.primary', { onclick: () => go('/meet/' + m.code) }, 'Participer'),
      btn('more', 'Options', e => menu(e.currentTarget, [
        { label: 'Copier le lien', icon: 'copy', action: () => copy(meetUrl(m.code)) },
        m.role === 'host' || m.role === 'cohost' ? { label: 'Modifier', icon: 'edit', action: async () => {
          try { scheduleDialog(null, reload, await api.get('meet/' + m.code)); } catch (e) { errorToast(e); }
        } } : null,
        m.role === 'host' ? { label: 'Annuler la réunion', icon: 'trash', danger: true, action: async () => {
          if (!await confirmDialog('Annuler cette réunion ? Les invités seront prévenus.', { ok: 'Annuler la réunion', danger: true })) return;
          try { await api.post(`meet/${m.code}/cancel`); toast('Réunion annulée'); reload(); } catch (e) { errorToast(e); }
        } } : null,
      ].filter(Boolean)))));
}

async function instantMeeting() {
  try {
    const m = await api.post('meet', {});
    go(`/meet/${m.code}?direct=1`);
  } catch (e) { errorToast(e); }
}

async function laterMeeting() {
  try {
    const m = await api.post('meet', {});
    shareDialog(m, 'Voici les informations pour rejoindre votre réunion');
  } catch (e) { errorToast(e); }
}

function shareDialog(m, title) {
  const url = meetUrl(m.code);
  const dlg = modal(h('div.mt-share',
    h('p.muted', 'Copiez ce lien et envoyez-le aux personnes que vous souhaitez inviter. Enregistrez-le pour pouvoir l’utiliser plus tard.'),
    h('div.mt-link-row', h('span.mt-link', url), btn('copy', 'Copier', () => copy(url))),
    h('div.modal-actions',
      navigator.share ? h('button.btn.ghost', { onclick: () => navigator.share({ title: m.label, url }).catch(() => {}) }, icon('share', 16), ' Partager') : null,
      h('button.btn.primary', { onclick: () => { dlg.close(); go('/meet/' + m.code); } }, 'Participer maintenant'))),
  { title });
}

// ------------------------------------------------------------------ programmation

function scheduleDialog(day, onSaved, existing = null) {
  const base = existing && existing.scheduled_at ? new Date(existing.scheduled_at) : roundUp(day ? new Date(Math.max(day.getTime() + 9 * 3600000, Date.now())) : new Date());
  const title = h('input.input', { value: existing ? existing.title : '', placeholder: 'Ajouter un titre', maxlength: 120 });
  const date = h('input.input', { type: 'date', value: isoDate(base) });
  const time = h('input.input', { type: 'time', value: base.toTimeString().slice(0, 5), step: 300 });
  const duration = h('select.input', [15, 30, 45, 60, 90, 120, 180, 240].map(n => h('option', { value: n, selected: n === (existing ? existing.duration_minutes : 60) }, durationLabel(n))));
  const description = h('textarea.input', { rows: 3, placeholder: 'Ajouter une description', maxlength: 2000, value: existing ? existing.description : '' });
  const access = h('select.input', [['trusted', 'Fiable : les invités entrent, les autres demandent'], ['open', 'Ouvert : tout le monde entre'], ['restricted', 'Restreint : invités uniquement']]
    .map(([v, l]) => h('option', { value: v, selected: v === (existing ? existing.settings.access : 'trusted') }, l)));
  const notesAuto = h('input', { type: 'checkbox', checked: existing ? existing.settings.notes_auto : false });
  const invited = new Map((existing && existing.invites || []).map(u => [u.id, u]));
  const chips = h('div.mt-chips');
  const paintChips = () => clear(chips, [...invited.values()].map(u => h('span.mt-chip', avatar(u.avatar, u.name, 22), u.name,
    h('label.mt-chip-cohost', { title: 'Co-organisateur' }, h('input', { type: 'checkbox', checked: !!u.cohost, onchange: e => { u.cohost = e.target.checked; } }), 'co-org.'),
    h('button', { type: 'button', 'aria-label': 'Retirer', onclick: () => { invited.delete(u.id); paintChips(); } }, '×'))));
  paintChips();
  const search = h('input.input', { type: 'search', placeholder: 'Ajouter des invités (nom ou @identifiant)' });
  const results = h('div.mt-search-results');
  search.addEventListener('input', debounce(async () => {
    const q = search.value.trim();
    if (!q) return clear(results);
    try {
      const { results: users } = await api.get('users/search?q=' + encodeURIComponent(q));
      clear(results, users.filter(u => !invited.has(u.id)).slice(0, 6).map(u => h('button.mt-result', { type: 'button', onclick: () => { invited.set(u.id, u); paintChips(); search.value = ''; clear(results); search.focus(); } },
        avatar(u.avatar, u.name, 28), h('span', u.name), h('small.muted', '@' + u.username))));
    } catch (e) { /* ignoré */ }
  }, 250));
  const save = h('button.btn.primary', { onclick: async () => {
    const when = new Date(`${date.value}T${time.value}`);
    if (Number.isNaN(when.getTime())) return toast('Date ou heure invalide.', { type: 'error' });
    save.disabled = true;
    const payload = {
      title: title.value.trim(), description: description.value.trim(), scheduled_at: when.toISOString(), duration_minutes: +duration.value,
      access: access.value, notes_auto: notesAuto.checked,
      invitees: [...invited.keys()], cohosts: [...invited.values()].filter(u => u.cohost).map(u => u.id),
    };
    try {
      const m = existing ? await api.post(`meet/${existing.code}/update`, payload) : await api.post('meet', payload);
      dlg.close();
      onSaved && onSaved(m);
      if (!existing) shareDialog(m, 'Réunion programmée');
      else toast('Réunion mise à jour : les nouveaux invités ont été prévenus.');
    } catch (e) { errorToast(e); save.disabled = false; }
  } }, existing ? 'Enregistrer' : 'Programmer');
  const dlg = modal(h('div.mt-form',
    title,
    h('div.mt-form-row', date, time, duration),
    description,
    h('div.mt-info-title', 'Invités'), search, results, chips,
    h('label.mt-field', h('span', 'Accès'), access),
    h('label.mt-check', notesAuto, h('span', 'Démarrer la prise de notes IA automatiquement')),
    h('p.muted.small', 'Les invités reçoivent une notification avec le lien de la réunion.'),
    h('div.modal-actions', h('button.btn.ghost', { onclick: () => dlg.close() }, 'Annuler'), save)),
  { title: existing ? 'Modifier la réunion' : 'Programmer une réunion', wide: true });
}

// ------------------------------------------------------------------ aperçu avant de participer + salle

function renderMeeting(stage, rawCode, params) {
  const direct = new URLSearchParams(location.search).get('direct') === '1';
  const page = h('div.mt-lobby-page', h('div.center.pad', spinner()));
  stage.appendChild(page);
  const local = new LocalMedia();
  let roomCleanup = null, closed = false, waitingFor = null, info = null;
  const offs = [];

  const preview = h('video.mt-preview-video.mirror', { autoplay: true, playsinline: true, muted: true });
  const previewArt = h('div.mt-art');
  const previewMsg = h('div.mt-preview-msg');
  const micB = h('button.mt-ctl', { type: 'button', onclick: () => { if (!local.audio) return toast(local.errors.audio || 'Aucun micro.', { type: 'error' }); local.setMic(!local.mic); } });
  const camB = h('button.mt-ctl', { type: 'button', onclick: async () => { const ok = await local.setCam(!local.cam); if (!ok && local.errors.video) toast(local.errors.video, { type: 'error' }); } });
  const paintPreview = () => {
    if (preview.srcObject !== local.stream) preview.srcObject = local.stream;
    preview.play().catch(() => {});
    preview.classList.toggle('hidden', !local.cam);
    previewArt.classList.toggle('hidden', local.cam);
    previewMsg.textContent = local.errors.all || (!local.cam ? (local.errors.video || 'La caméra est désactivée') : '');
    micB.classList.toggle('off', !local.mic);
    clear(micB, icon(local.mic ? 'mic' : 'micOff', 22));
    micB.title = local.mic ? 'Désactiver le micro' : 'Activer le micro';
    camB.classList.toggle('off', !local.cam);
    clear(camB, icon(local.cam ? 'video' : 'camOff', 22));
    camB.title = local.cam ? 'Désactiver la caméra' : 'Activer la caméra';
  };
  offs.push(local.onChange(paintPreview));

  const side = h('div.mt-lobby-side');
  const paintSide = (status = null) => {
    if (!info) return;
    const present = info.present || [];
    const who = present.length === 0 ? 'Personne d’autre n’est là'
      : present.length === 1 ? `${present[0].name} participe à l’appel`
        : present.length === 2 ? `${present[0].name} et ${present[1].name} participent à l’appel`
          : `${present[0].name}, ${present[1].name} et ${info.participants_now - 2} autre(s) participent à l’appel`;
    let action;
    if (info.entry === 'denied') action = h('p.mt-warn', info.denied_reason);
    else if (status === 'waiting') {
      action = h('div.mt-wait', spinner(26), h('p', 'Demande envoyée. Vous pourrez participer dès que quelqu’un dans la réunion vous y aura autorisé.'),
        waitingFor === false ? h('p.muted.small', "L'organisateur n'est pas encore là : il a été prévenu par notification.") : null,
        h('button.btn.ghost', { onclick: () => { send('meet.cancel_wait', { code: info.code }); paintSide(); } }, 'Annuler la demande'));
    } else if (status === 'denied') {
      action = h('div', h('p.mt-warn', 'Quelqu’un dans l’appel a refusé votre demande de participation.'), h('button.btn.ghost', { onclick: () => go('/meet') }, "Revenir à l'accueil"));
    } else if (status === 'joining') action = h('div.mt-wait', spinner(26), h('p', 'Connexion…'));
    else {
      action = h('div.mt-lobby-actions',
        h('button.btn.primary.mt-join', { onclick: () => join() }, info.entry === 'join' ? 'Participer' : 'Demander à participer'),
        h('button.btn.ghost', { onclick: e => menu(e.currentTarget, [
          { label: 'Copier le lien de la réunion', icon: 'copy', action: () => copy(meetUrl(info.code)) },
          { label: 'Paramètres audio et vidéo', icon: 'settings', action: () => devicesDialog(local) },
        ]) }, 'Autres options'));
    }
    clear(side,
      h('h2', info.entry === 'denied' ? 'Impossible de participer' : 'Prêt à participer ?'),
      h('p.mt-lobby-title', info.label),
      info.scheduled_at ? h('p.muted.small', new Date(info.scheduled_at).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })) : null,
      h('div.mt-present', present.slice(0, 4).map(u => avatar(u.avatar, u.name, 28)), h('span', who)),
      action);
  };

  const join = () => {
    paintSide('joining');
    send('meet.join', { code: info.code, mic: local.mic, cam: local.cam });
  };

  const showRoom = async joined => {
    if (roomCleanup || closed) return;
    const { startRoom } = await import('./meetroom.js');
    const host = h('div.mt-room-host');
    clear(page, host);
    page.classList.add('in-room');
    roomCleanup = startRoom(host, joined, local, { onExit: (reason, extra) => { roomCleanup = null; leftScreen(reason, extra); } });
  };

  const leftScreen = (reason, extra) => {
    page.classList.remove('in-room');
    const titles = { removed: 'Vous avez été retiré(e) de la réunion', ended: "L'organisateur a mis fin à la réunion", ended_by_me: 'Vous avez mis fin à la réunion pour tous',
      alone_timeout: 'La réunion a pris fin : vous étiez seul(e) et inactif(ve) depuis 15 minutes' };
    clear(page, h('div.mt-left',
      h('h2', titles[reason] || 'Vous avez quitté la réunion'),
      extra && extra.notesActive ? h('p.muted', '📝 Les notes IA de cette réunion vous seront envoyées dès qu’elles seront prêtes.') : null,
      h('div.row.gap.center',
        reason !== 'removed' && reason !== 'ended' ? h('button.btn.ghost', { onclick: () => go(`/meet/${rawCode}`) }, 'Participer de nouveau') : null,
        h('button.btn.primary', { onclick: () => go('/meet') }, "Revenir à l'écran d'accueil")),
      h('button.btn.ghost.small', { onclick: () => go('/meet/notes') }, icon('doc', 16), ' Voir mes notes IA')));
  };

  const mine = fn => d => { if (info && d && d.meeting_id === info.id && !closed) fn(d); };
  offs.push(
    bus.on('meet.joined', d => { if (info && d.meeting.id === info.id && !closed && !roomCleanup) showRoom(d); }),
    bus.on('meet.waiting', mine(d => { waitingFor = d.managers_present; paintSide('waiting'); })),
    bus.on('meet.admitted', mine(() => send('meet.join', { code: info.code, mic: local.mic, cam: local.cam }))),
    bus.on('meet.denied', mine(() => paintSide('denied'))),
    bus.on('meet.ended', mine(() => { if (!roomCleanup) paintSide('denied'); })),
    bus.on('error', e => { if (e && e.for === 'meet.join' && !roomCleanup && !closed) { toast(e.message, { type: 'error' }); paintSide(); } }),
  );

  (async () => {
    try { info = await api.get('meet/' + encodeURIComponent(rawCode)); }
    catch (e) {
      clear(page, h('div.mt-left', h('h2', 'Réunion introuvable'), h('p.muted', e.message),
        h('button.btn.primary', { onclick: () => go('/meet') }, "Revenir à l'écran d'accueil")));
      return;
    }
    if (closed) return;
    if (info.code !== rawCode) history.replaceState({}, '', '/meet/' + info.code);
    clear(page, h('div.mt-lobby',
      h('div.mt-preview',
        h('div.mt-preview-box', previewArt, preview, previewMsg,
          h('div.mt-preview-name', state.me.name),
          h('div.mt-preview-ctl', micB, camB),
          btn('settings', 'Paramètres audio et vidéo', () => devicesDialog(local), 'mt-preview-gear')),
        h('p.muted.small.center', 'Vérifiez votre micro et votre caméra avant d’entrer.')),
      side));
    clear(previewArt, avatar(state.me.avatar, state.me.name, 96));
    paintSide();
    await local.start({ mic: true, cam: true });
    paintPreview();
    if (direct && info.entry === 'join' && !closed) { history.replaceState({}, '', '/meet/' + info.code); join(); }
  })();

  return () => {
    closed = true;
    offs.forEach(f => f());
    if (roomCleanup) roomCleanup();
    else {
      if (info) send('meet.cancel_wait', { code: info.code });
      local.stop();
    }
  };
}

// ------------------------------------------------------------------ notes IA

const STATUS = {
  recording: ['Prise de notes en cours', 'info'], processing: ['Rédaction en cours…', 'info'], ready: ['Prêt', 'ok'],
  failed: ['Échec du résumé', 'warn'], empty: ['Rien à résumer', 'muted'], no_ai: ['Transcription seule', 'muted'],
};

function renderNotesList(stage) {
  const list = h('div.mt-notes-list', spinner());
  stage.appendChild(h('div.page.mt-notes-page',
    h('header.page-head', h('div.row.gap', btn('back', 'Retour', () => go('/meet')), h('h2', 'Notes IA des réunions'))),
    h('p.muted', 'Comptes rendus rédigés par l’IA à partir des réunions où la prise de notes était activée.'),
    list));
  const load = async () => {
    try {
      const { results } = await api.get('meet/notes');
      clear(list, results.length ? results.map(n => h('button.mt-note-card', { type: 'button', onclick: () => go('/meet/notes/' + n.id) },
        h('div.mt-note-icon', icon('doc', 22)),
        h('div.mt-note-text', h('strong', n.title), h('small.muted', `${n.meeting.label} · ${new Date(n.started_at).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}`),
          n.overview ? h('p', n.overview + (n.overview.length >= 220 ? '…' : '')) : null),
        statusBadge(n.status)))
        : empty('doc', 'Aucune note pour le moment', 'Lancez la prise de notes pendant une réunion : le compte rendu arrivera ici.'));
    } catch (e) { clear(list, h('p.muted', e.message)); }
  };
  load();
  const off = bus.on('meet.notes_ready', load);
  return off;
}

function statusBadge(status) {
  const [label, kind] = STATUS[status] || [status, 'muted'];
  return h('span.mt-status.' + kind, label);
}

function renderNotesDetail(stage, id) {
  const page = h('div.page.mt-notes-page', spinner());
  stage.appendChild(page);
  let tab = 'summary';
  const load = async () => {
    let n;
    try { n = await api.get('meet/notes/' + id); } catch (e) { clear(page, h('p.muted', e.message)); return; }
    const s = n.summary;
    const tabs = h('div.mt-tabs', [['summary', 'Compte rendu'], ['transcript', `Transcription (${n.transcript.length})`], ['chat', `Chat (${n.chat.length})`]]
      .map(([k, l]) => h('button' + (tab === k ? '.active' : ''), { type: 'button', onclick: () => { tab = k; load(); } }, l)));
    let body;
    if (tab === 'transcript') {
      body = n.transcript.length ? h('div.mt-transcript', n.transcript.map(l => h('p', h('span.mt-ts', clock(l.offset)), h('strong', l.speaker + ' : '), l.text)))
        : h('p.muted', 'Aucune parole transcrite.');
    } else if (tab === 'chat') {
      body = n.chat.length ? h('div.mt-transcript', n.chat.map(l => h('p', h('span.mt-ts', clock(l.offset)), h('strong', l.name + ' : '), l.text)))
        : h('p.muted', 'Aucun message dans le chat pendant la prise de notes.');
    } else if (n.status === 'processing' || n.status === 'recording') {
      body = h('div.mt-wait', spinner(28), h('p', 'L’IA rédige le compte rendu… Cette page se met à jour automatiquement.'));
    } else if (!s) {
      body = h('div',
        n.status === 'failed' ? h('p.mt-warn', 'Le compte rendu n’a pas pu être rédigé : ' + (n.error || 'erreur inconnue')) : null,
        n.status === 'no_ai' ? h('p.mt-warn', 'L’IA n’est pas configurée sur le serveur : seule la transcription est disponible.') : null,
        n.status === 'empty' ? h('p.muted', 'Rien n’a été dit ni écrit pendant la prise de notes.') : null,
        n.can_retry ? h('button.btn.primary', { onclick: async () => { try { await api.post(`meet/notes/${id}/retry`); load(); } catch (e) { errorToast(e); } } }, 'Rédiger le compte rendu') : null);
    } else {
      body = h('div.mt-summary',
        s.truncated ? h('p.mt-warn', 'Réunion très longue : seule la première partie a été résumée.') : null,
        h('section', h('h3', 'Résumé'), s.summary.split(/\n{2,}/).map(p => h('p', p))),
        list('Points clés', s.key_points),
        list('Décisions', s.decisions),
        s.action_items.length ? h('section', h('h3', 'Tâches à faire'), h('table.mt-tasks',
          h('tr', h('th', 'Tâche'), h('th', 'Responsable'), h('th', 'Échéance')),
          s.action_items.map(a => h('tr', h('td', a.task), h('td', a.owner || '—'), h('td', a.due || '—'))))) : null,
        s.chapters.length ? h('section', h('h3', 'Chapitres'), h('ol.mt-chapters', s.chapters.map(c => h('li', h('span.mt-ts', c.debut), h('div', h('strong', c.title), h('p', c.summary)))))) : null,
        list('Questions en suspens', s.open_questions),
        h('p.muted.small', `Rédigé par l’IA (${n.model || 'Claude'}) à partir de la transcription automatique : vérifiez les informations importantes.`));
    }
    clear(page,
      h('header.page-head', h('div.row.gap', btn('back', 'Retour', () => go('/meet/notes')), h('h2', n.title)),
        h('div.row.gap',
          s ? btn('copy', 'Copier le compte rendu', () => copy(markdown(n), 'Compte rendu copié')) : null,
          s ? btn('download', 'Télécharger (.md)', () => download(n)) : null,
          btn('trash', 'Supprimer', async () => {
            if (!await confirmDialog('Supprimer ces notes de votre liste ?', { ok: 'Supprimer', danger: true })) return;
            try { await api.post(`meet/notes/${id}/delete`); go('/meet/notes'); } catch (e) { errorToast(e); }
          }))),
      h('div.mt-notes-meta', statusBadge(n.status),
        h('span.muted', `${n.meeting.label} · ${new Date(n.started_at).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })}${n.ended_at ? ' – ' + timeHM(n.ended_at) : ''}`),
        h('div.mt-notes-people', n.participants.slice(0, 8).map(u => avatar(u.avatar, u.name, 24)), n.participants.length ? h('small.muted', `${n.participants.length} participant(s)`) : null)),
      tabs, body);
  };
  const list = (title, items) => items && items.length ? h('section', h('h3', title), h('ul', items.map(i => h('li', i)))) : null;
  load();
  const off = bus.on('meet.notes_ready', d => { if (d.notes && d.notes.id === +id) load(); });
  return off;
}

function clock(sec) {
  const m = Math.floor(sec / 60), s = sec % 60, hh = Math.floor(m / 60);
  return hh ? `${hh}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function markdown(n) {
  const s = n.summary;
  const out = [`# ${s.title}`, '', `_${n.meeting.label} — ${new Date(n.started_at).toLocaleString('fr-FR')}_`, '', '## Résumé', '', s.summary];
  const sec = (title, items) => { if (items && items.length) out.push('', `## ${title}`, '', ...items.map(i => `- ${i}`)); };
  sec('Points clés', s.key_points);
  sec('Décisions', s.decisions);
  if (s.action_items.length) out.push('', '## Tâches', '', ...s.action_items.map(a => `- [ ] ${a.task}${a.owner ? ` — ${a.owner}` : ''}${a.due ? ` (échéance : ${a.due})` : ''}`));
  if (s.chapters.length) out.push('', '## Chapitres', '', ...s.chapters.map(c => `- **${c.debut} ${c.title}** : ${c.summary}`));
  sec('Questions en suspens', s.open_questions);
  return out.join('\n');
}

function download(n) {
  const blob = new Blob([markdown(n)], { type: 'text/markdown;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `compte-rendu-${n.meeting.code}.md` });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ------------------------------------------------------------------ dates

function durationLabel(n) {
  if (n < 60) return `${n} min`;
  return n % 60 ? `${Math.floor(n / 60)} h ${n % 60}` : `${n / 60} h`;
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function roundUp(d) { const x = new Date(d); x.setMinutes(Math.ceil((x.getMinutes() + 1) / 15) * 15, 0, 0); return x; }
