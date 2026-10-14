// Kozons Meet : salle de réunion (vidéo, mosaïque, présentation, chat, participants, sous-titres, notes IA).
//
// Transport vidéo :
//  - « sfu » (production) : chacun publie sa caméra (et son écran) une seule fois vers le serveur média
//    MediaMTX (WHIP) et lit les flux des autres (WHEP). Tient la charge quel que soit le nombre de personnes.
//  - « p2p » (développement, sans serveur média) : une connexion WebRTC par paire de participants, avec
//    trois pistes fixes (micro, caméra, écran) pour ne jamais renégocier.
import { api } from '../api.js';
import { bus, state } from '../store.js';
import { send } from '../ws.js';
import { h, clear, icon, btn, avatar, menu, modal, toast, errorToast, confirmDialog, richText, timeHM, debounce, spinner, beep } from '../ui.js';

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const LAYOUTS = [['auto', 'Automatique'], ['grid', 'Mosaïque'], ['speaker', 'Intervenant'], ['sidebar', 'Barre latérale']];

let iceCache = null;
async function iceServers() {
  if (!iceCache || Date.now() - iceCache.at > 3600 * 1000) {
    try { iceCache = { at: Date.now(), servers: (await api.get('calls/ice')).ice_servers }; }
    catch (e) { return [{ urls: 'stun:stun.l.google.com:19302' }]; }
  }
  return iceCache.servers;
}

// ------------------------------------------------------------------ média local (aperçu + réunion)

export class LocalMedia {
  constructor() {
    this.stream = new MediaStream();
    this.audio = null;   // piste micro (gardée, activée / désactivée : bascule instantanée)
    this.video = null;   // piste caméra (arrêtée quand la caméra est coupée : voyant éteint)
    this.mic = true;
    this.cam = true;
    this.devices = { audio: localStorage.getItem('kozons.meet.mic') || '', video: localStorage.getItem('kozons.meet.cam') || '', output: localStorage.getItem('kozons.meet.out') || '' };
    this.listeners = new Set();
    this.errors = {};
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach(fn => { try { fn(this); } catch (e) { console.error(e); } }); }

  async start({ mic = true, cam = true } = {}) {
    if (!navigator.mediaDevices) { this.errors.all = 'Le micro et la caméra nécessitent une connexion sécurisée (HTTPS).'; this.mic = this.cam = false; this.emit(); return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
      this.setTrack('audio', s.getAudioTracks()[0]);
    } catch (e) { this.errors.audio = e.name === 'NotAllowedError' ? 'Accès au micro refusé.' : 'Aucun micro disponible.'; }
    this.mic = !!this.audio && mic;
    if (this.audio) this.audio.enabled = this.mic;
    if (cam) await this.setCam(true); else { this.cam = false; this.emit(); }
  }

  audioConstraints() {
    return { deviceId: this.devices.audio ? { ideal: this.devices.audio } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  }

  videoConstraints() {
    return { deviceId: this.devices.video ? { ideal: this.devices.video } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };
  }

  setTrack(kind, track) {
    const old = kind === 'audio' ? this.audio : this.video;
    if (old) { this.stream.removeTrack(old); old.stop(); }
    if (track) this.stream.addTrack(track);
    if (kind === 'audio') this.audio = track || null; else this.video = track || null;
  }

  setMic(on) {
    this.mic = !!on && !!this.audio;
    if (this.audio) this.audio.enabled = this.mic;
    this.emit();
    return this.mic;
  }

  async setCam(on) {
    if (!on) { this.setTrack('video', null); this.cam = false; this.emit(); return false; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints() });
      this.setTrack('video', s.getVideoTracks()[0]);
      this.cam = true;
      delete this.errors.video;
    } catch (e) {
      this.cam = false;
      this.errors.video = e.name === 'NotAllowedError' ? 'Accès à la caméra refusé.' : 'Aucune caméra disponible.';
    }
    this.emit();
    return this.cam;
  }

  async useDevice(kind, deviceId) {
    this.devices[kind] = deviceId;
    try { localStorage.setItem('kozons.meet.' + ({ audio: 'mic', video: 'cam', output: 'out' }[kind]), deviceId); } catch (e) { /* ignoré */ }
    if (kind === 'audio' && this.audio) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
      const t = s.getAudioTracks()[0];
      t.enabled = this.mic;
      this.setTrack('audio', t);
      this.emit();
    } else if (kind === 'video' && this.cam) {
      await this.setCam(true);
    } else this.emit();
  }

  stop() {
    this.setTrack('audio', null);
    this.setTrack('video', null);
    this.listeners.clear();
  }
}

export async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return { audio: all.filter(d => d.kind === 'audioinput'), video: all.filter(d => d.kind === 'videoinput'), output: all.filter(d => d.kind === 'audiooutput') };
  } catch (e) { return { audio: [], video: [], output: [] }; }
}

/** Réglages audio / vidéo (micro, caméra, haut-parleur), utilisés dans l'aperçu et en réunion. */
export async function devicesDialog(local, onOutput) {
  const devs = await listDevices();
  const select = (kind, list, label) => {
    const s = h('select.input', { onchange: async () => {
      try { await local.useDevice(kind, s.value); if (kind === 'output' && onOutput) onOutput(s.value); }
      catch (e) { toast('Impossible d’utiliser ce périphérique.', { type: 'error' }); }
    } }, h('option', { value: '' }, 'Par défaut'), list.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === local.devices[kind] }, d.label || `${label} ${i + 1}`)));
    return h('label.mt-field', h('span', label), s);
  };
  modal(h('div.mt-devices',
    select('audio', devs.audio, 'Micro'),
    devs.output.length && 'setSinkId' in HTMLMediaElement.prototype ? select('output', devs.output, 'Haut-parleur') : null,
    select('video', devs.video, 'Caméra'),
    h('p.muted.small', 'Réduction du bruit et annulation d’écho sont activées automatiquement.')),
  { title: 'Paramètres audio et vidéo' });
}

// ------------------------------------------------------------------ WHIP / WHEP (serveur média)

function waitIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 2500);
  });
}

async function negotiate(pc, url) {
  await pc.setLocalDescription(await pc.createOffer());
  await waitIce(pc);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
  if (!res.ok) throw new Error(res.status === 404 ? 'not_publishing' : `media_${res.status}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
}

function capBitrate(sender, bps) {
  try {
    const p = sender.getParameters();
    p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = bps;
    sender.setParameters(p).catch(() => {});
  } catch (e) { /* navigateur sans setParameters */ }
}

// ------------------------------------------------------------------ salle

/**
 * Démarre la salle dans `root` avec les données de « meet.joined ».
 * Renvoie une fonction de nettoyage (quitter la réunion).
 */
export function startRoom(root, joined, local, { onExit }) {
  const ctx = {
    meeting: joined.meeting, me: joined.me, media: joined.media, reactions: joined.reactions,
    settings: joined.meeting.settings, notes: joined.notes,
    peers: new Map(),            // peerId -> { data, tile, streams: {cam, scr}, pc, whep: {cam, scr}, pending: [] }
    pubs: { cam: null, scr: null },
    screen: null,                // MediaStream de mon partage d'écran
    waiting: joined.waiting || [],
    messages: joined.messages || [],
    unread: 0,
    panel: null, layout: localStorage.getItem('kozons.meet.layout') || 'auto', pinned: null,
    captionsOn: false, captions: new Map(), speaking: new Map(),
    offs: [], timers: [], closed: false, exitReason: null,
    audioCtx: null, meters: new Map(),
  };
  const isManager = () => { const me = ctx.peers.get(ctx.me); return !!me && ['host', 'cohost'].includes(me.data.role); };

  // ---------------------------------------------------------- squelette
  const grid = h('div.mt-grid');
  const strip = h('div.mt-strip');
  const mainEl = h('div.mt-main');
  const stageEl = h('div.mt-stage', mainEl, grid, strip);
  const captionsEl = h('div.mt-captions.hidden');
  const reactionsLayer = h('div.mt-reaction-layer');
  const toastsEl = h('div.mt-toasts');
  const panelEl = h('aside.mt-panel.hidden');
  const clock = h('span.mt-clock');
  const notesPill = h('button.mt-notes-pill.hidden', { type: 'button', onclick: () => openPanel('activities') }, icon('doc', 16), h('span', 'Notes IA'));
  const titleEl = h('div.mt-title', clock, h('span.mt-sep', '|'), h('span.mt-code', ctx.meeting.title || ctx.meeting.code), notesPill);

  const micBtn = h('button.mt-ctl', { type: 'button', onclick: () => toggleMic() });
  const camBtn = h('button.mt-ctl', { type: 'button', onclick: () => toggleCam() });
  const ccBtn = h('button.mt-ctl', { type: 'button', title: 'Sous-titres (c)', 'aria-label': 'Sous-titres', onclick: () => toggleCaptions() }, h('span.mt-cc', 'CC'));
  const reactBtn = h('button.mt-ctl', { type: 'button', title: 'Réactions', 'aria-label': 'Réactions', onclick: e => reactionPicker(e.currentTarget) }, icon('smile', 22));
  const shareBtn = h('button.mt-ctl', { type: 'button', title: 'Présenter maintenant', 'aria-label': 'Présenter', onclick: () => toggleScreen() }, icon('screen', 22));
  const handBtn = h('button.mt-ctl', { type: 'button', title: 'Lever la main (Ctrl+Alt+H)', 'aria-label': 'Lever la main', onclick: () => toggleHand() }, h('span.mt-emoji', '✋'));
  const moreBtn = h('button.mt-ctl', { type: 'button', title: "Plus d'options", 'aria-label': "Plus d'options", onclick: e => moreMenu(e.currentTarget) }, icon('more', 22));
  const leaveBtn = h('button.mt-ctl.mt-leave', { type: 'button', title: "Quitter l'appel", 'aria-label': "Quitter l'appel", onclick: e => leaveMenu(e.currentTarget) }, icon('phoneOff', 24));
  const sideBtn = (key, ic, label) => h('button.mt-side-btn', { type: 'button', title: label, 'aria-label': label, dataset: { panel: key }, onclick: () => openPanel(key) }, icon(ic, 22), h('span.badge.hidden'));
  const sideBtns = { info: sideBtn('info', 'info', 'Informations sur la réunion'), people: sideBtn('people', 'users', 'Participants'),
    chat: sideBtn('chat', 'chat', 'Chat'), activities: sideBtn('activities', 'grid', 'Notes IA et activités'), host: sideBtn('host', 'lock', "Commandes de l'organisateur") };
  const peopleCount = h('span.mt-count');
  // Mains levées : indicateur visible dans la barre (ouvre la liste des participants, mains en tête).
  const handsCount = h('span.mt-hands-count');
  const handsBtn = h('button.mt-side-btn.mt-hands.hidden', { type: 'button', onclick: () => { if (ctx.panel !== 'people') openPanel('people'); } }, h('span.mt-emoji', '✋'), handsCount);
  sideBtns.people.appendChild(peopleCount);

  const bar = h('footer.mt-bar',
    h('div.mt-bar-left', titleEl),
    h('div.mt-bar-center', micBtn, camBtn, ccBtn, reactBtn, shareBtn, handBtn, moreBtn, leaveBtn),
    h('div.mt-bar-right', handsBtn, ...Object.values(sideBtns)));
  const room = h('div.mt-room', h('div.mt-body', stageEl, panelEl), captionsEl, reactionsLayer, toastsEl, bar);
  clear(root, room);
  document.body.classList.add('in-meeting');

  const tick = () => { clock.textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); };
  tick();
  ctx.timers.push(setInterval(tick, 15000));

  // ---------------------------------------------------------- petits messages dans la salle
  function notice(text, { timeout = 4500, action } = {}) {
    const el = h('div.mt-toast', h('span', text), action ? h('button', { type: 'button', onclick: () => { action.run(); el.remove(); } }, action.label) : null);
    toastsEl.appendChild(el);
    setTimeout(() => el.remove(), timeout);
  }

  // ---------------------------------------------------------- participants et vignettes
  function nameOf(peer) {
    if (!peer) return '';
    if (peer.data.peer === ctx.me) return 'Vous';
    return (peer.data.user && peer.data.user.name) || 'Participant';
  }

  function makeTile(peerId) {
    const video = h('video.mt-video', { autoplay: true, playsinline: true });
    if (peerId === ctx.me) { video.muted = true; video.classList.add('mirror'); }
    const art = h('div.mt-art');
    const label = h('div.mt-label');
    const badges = h('div.mt-badges');
    const tileMenu = btn('more', 'Plus d’options', e => { e.stopPropagation(); tileOptions(peerId, e.currentTarget); }, 'mt-tile-menu');
    const tile = h('div.mt-tile', { dataset: { peer: peerId }, ondblclick: () => pin(ctx.pinned === peerId ? null : peerId) }, art, video, badges, label, tileMenu);
    return { tile, video, art, label, badges };
  }

  function paintTile(peerId) {
    const peer = ctx.peers.get(peerId);
    if (!peer) return;
    const { data, view } = peer;
    const mine = peerId === ctx.me;
    const camOn = mine ? local.cam : data.cam;
    clear(view.art, avatar(data.user && data.user.avatar, data.user && data.user.name, 96));
    view.tile.classList.toggle('cam-off', !camOn);
    view.tile.classList.toggle('pinned', ctx.pinned === peerId);
    clear(view.label, h('span', nameOf(peer) + (data.role === 'host' ? ' · Organisateur' : data.role === 'cohost' ? ' · Co-organisateur' : '')));
    clear(view.badges,
      data.hand ? h('span.mt-badge.hand', '✋', h('small', String(handRank(peerId)))) : null,
      !(mine ? local.mic : data.mic) ? h('span.mt-badge.muted', icon('micOff', 15)) : null);
    const stream = mine ? local.stream : peer.streams.cam;
    if (stream && view.video.srcObject !== stream) {
      view.video.srcObject = stream;
      view.video.play().catch(() => {});
      if (!mine && local.devices.output && view.video.setSinkId) view.video.setSinkId(local.devices.output).catch(() => {});
    }
  }

  function handRank(peerId) {
    const raised = [...ctx.peers.values()].filter(p => p.data.hand).sort((a, b) => a.data.hand - b.data.hand);
    return raised.findIndex(p => p.data.peer === peerId) + 1;
  }

  function upsertPeer(data) {
    let peer = ctx.peers.get(data.peer);
    const isNew = !peer;
    if (isNew) {
      peer = { data, view: makeTile(data.peer), streams: { cam: null, scr: null }, pc: null, whep: { cam: null, scr: null }, pending: [] };
      ctx.peers.set(data.peer, peer);
    }
    const prev = peer.data;
    peer.data = data;
    paintTile(data.peer);
    if (data.peer !== ctx.me) {
      if (isNew) connectPeer(peer);
      if (ctx.media.mode === 'sfu' && prev.screen !== data.screen) {
        if (data.screen) subscribe(peer, 'scr'); else dropSubscription(peer, 'scr');
      }
      if (!isNew && !prev.hand && data.hand && isManager()) notice(`✋ ${nameOf(peer)} lève la main`);
    }
    if (prev.screen !== data.screen || isNew) layout();
    refreshPeople();
    return peer;
  }

  function removePeer(peerId) {
    const peer = ctx.peers.get(peerId);
    if (!peer) return;
    lastInteraction = Date.now();  // de nouveau seul(e) : le délai d'inactivité repart de zéro
    closePeerMedia(peer);
    peer.view.tile.remove();
    ctx.peers.delete(peerId);
    ctx.captions.delete(peerId);
    if (ctx.pinned === peerId) ctx.pinned = null;
    stopMeter(peerId);
    layout();
    refreshPeople();
  }

  // ---------------------------------------------------------- disposition (mosaïque / présentation)
  function presenter() {
    if (ctx.screen) return { peerId: ctx.me, kind: 'scr' };
    for (const p of ctx.peers.values()) if (p.data.screen && p.data.peer !== ctx.me && p.streams.scr) return { peerId: p.data.peer, kind: 'scr' };
    return null;
  }

  let screenView = null;
  function layout() {
    if (ctx.closed) return;
    const pres = presenter();
    const focus = ctx.pinned ? { peerId: ctx.pinned, kind: 'cam' } : (pres && ctx.layout !== 'grid' ? pres : null);
    const speakerMode = !focus && ctx.layout === 'speaker' && ctx.peers.size > 1;
    const tiles = [...ctx.peers.values()].map(p => p.view.tile);
    stageEl.classList.toggle('focus', !!focus || speakerMode);
    stageEl.classList.toggle('sidebar', ctx.layout === 'sidebar' && (!!focus || speakerMode));
    if (focus && focus.kind === 'scr') {
      if (!screenView) screenView = h('video.mt-screen', { autoplay: true, playsinline: true, muted: true });
      const stream = focus.peerId === ctx.me ? ctx.screen : ctx.peers.get(focus.peerId).streams.scr;
      if (screenView.srcObject !== stream) { screenView.srcObject = stream; screenView.play().catch(() => {}); }
      const who = focus.peerId === ctx.me ? 'Vous présentez' : `${nameOf(ctx.peers.get(focus.peerId))} présente`;
      clear(mainEl, screenView, h('div.mt-label', h('span', who)),
        focus.peerId === ctx.me ? h('button.btn.small.mt-stop-share', { onclick: () => toggleScreen() }, 'Arrêter la présentation') : null);
      tiles.forEach(t => { t.style.gridColumn = ''; });
      clear(strip, tiles);
      clear(grid);
    } else if (focus || speakerMode) {
      const mainId = focus ? focus.peerId : loudest() || [...ctx.peers.keys()].find(k => k !== ctx.me);
      const main = ctx.peers.get(mainId);
      ctx.peers.forEach(p => { p.view.tile.style.gridColumn = ''; });
      clear(mainEl, main ? main.view.tile : null);
      clear(strip, tiles.filter(t => !main || t !== main.view.tile));
      clear(grid);
    } else {
      clear(mainEl);
      clear(strip);
      // Seul(e) : sa propre vignette en grand. Sinon : mosaïque qui remplit l'écran.
      const ordered = [...ctx.peers.values()].sort((a, b) => (b.data.peer === ctx.me) - (a.data.peer === ctx.me) || a.data.joined_at - b.data.joined_at);
      const visible = ordered.length > 1 ? [...ordered.slice(1), ordered[0]] : ordered;
      clear(grid, visible.map(p => p.view.tile));
      fitGrid();
    }
  }

  function fitGrid() {
    const n = grid.children.length;
    if (!n) return;
    // Téléphone : les vignettes se partagent tout l'écran (2 = moitiés haut/bas, 3-4 = 2×2…), comme Meet mobile.
    const fill = window.innerWidth <= 760;
    grid.classList.toggle('fill', fill);
    [...grid.children].forEach(t => { t.style.gridColumn = ''; });
    if (fill) {
      const cols = n <= 2 ? 1 : n <= 6 ? 2 : 3;
      const rows = Math.ceil(n / cols);
      grid.style.setProperty('--cols', cols);
      grid.style.setProperty('--rows', rows);
      // Ligne incomplète : la dernière vignette prend la place restante (pas de trou).
      const missing = rows * cols - n;
      if (missing) grid.lastElementChild.style.gridColumn = `span ${missing + 1}`;
      return;
    }
    const W = grid.clientWidth, H = grid.clientHeight, gap = 8;
    let best = { cols: 1, w: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9);
      if (w > best.w) best = { cols, w };
    }
    grid.style.setProperty('--cols', best.cols);
    grid.style.setProperty('--tile-w', Math.max(120, Math.floor(best.w)) + 'px');
  }
  const ro = new ResizeObserver(() => fitGrid());
  ro.observe(grid);

  function pin(peerId) {
    ctx.pinned = peerId && ctx.peers.has(peerId) ? peerId : null;
    ctx.peers.forEach((p, id) => p.view.tile.classList.toggle('pinned', id === ctx.pinned));
    layout();
  }

  // ---------------------------------------------------------- niveau sonore : intervenant actif
  function meter(peerId, stream) {
    stopMeter(peerId);
    const track = stream && stream.getAudioTracks()[0];
    if (!track) return;
    try {
      ctx.audioCtx = ctx.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      // Mon micro : on mesure une copie toujours active (pour prévenir « vous parlez micro coupé »).
      const t = peerId === ctx.me ? track.clone() : track;
      if (peerId === ctx.me) t.enabled = true;
      const src = ctx.audioCtx.createMediaStreamSource(new MediaStream([t]));
      const an = ctx.audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      ctx.meters.set(peerId, { an, src, clone: peerId === ctx.me ? t : null, buf: new Uint8Array(an.fftSize), level: 0 });
    } catch (e) { /* AudioContext indisponible */ }
  }
  function stopMeter(peerId) {
    const m = ctx.meters.get(peerId);
    if (!m) return;
    try { m.src.disconnect(); } catch (e) { /* ignoré */ }
    if (m.clone) m.clone.stop();
    ctx.meters.delete(peerId);
  }
  function loudest() {
    let best = null, lvl = 0.02;
    ctx.meters.forEach((m, id) => { if (id !== ctx.me && m.level > lvl) { lvl = m.level; best = id; } });
    return best;
  }
  let mutedTalkSince = 0, mutedWarned = 0, lastSpeaker = null;
  ctx.timers.push(setInterval(() => {
    ctx.meters.forEach((m, id) => {
      m.an.getByteTimeDomainData(m.buf);
      let sum = 0;
      for (let i = 0; i < m.buf.length; i++) { const v = (m.buf[i] - 128) / 128; sum += v * v; }
      m.level = m.level * 0.6 + Math.sqrt(sum / m.buf.length) * 0.4;
      const peer = ctx.peers.get(id);
      const live = id === ctx.me ? local.mic : peer && peer.data.mic;
      if (peer) peer.view.tile.classList.toggle('speaking', !!live && m.level > 0.035);
      if (id === ctx.me) micBtn.style.setProperty('--lvl', live ? Math.min(1, m.level * 8).toFixed(2) : 0);
    });
    // Micro coupé mais la personne parle : on la prévient (une fois par minute au plus).
    const mine = ctx.meters.get(ctx.me);
    if (mine && !local.mic && local.audio) {
      if (mine.level > 0.06) { mutedTalkSince = mutedTalkSince || Date.now(); } else mutedTalkSince = 0;
      if (mutedTalkSince && Date.now() - mutedTalkSince > 1200 && Date.now() - mutedWarned > 60000) {
        mutedWarned = Date.now();
        notice('Vous parlez ? Votre micro est coupé.', { action: { label: 'Activer', run: () => toggleMic(true) } });
      }
    }
    if (ctx.layout === 'speaker' && !ctx.pinned && !presenter()) {
      const sp = loudest();
      if (sp && sp !== lastSpeaker) { lastSpeaker = sp; layout(); }
    }
  }, 150));

  // ---------------------------------------------------------- transport : serveur média (sfu)
  function mediaUrl(peerId, kind, endpoint) {
    const token = endpoint === 'whip' ? ctx.media.publish_token : ctx.media.read_token;
    return `${ctx.media.base}/${ctx.media.prefix}${peerId}_${kind}/${endpoint}?token=${encodeURIComponent(token)}`;
  }

  async function publish(kind) {
    if (ctx.media.mode !== 'sfu' || ctx.closed) return;
    const old = ctx.pubs[kind];
    if (old) old.close();
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    ctx.pubs[kind] = pc;
    if (kind === 'cam') {
      pc.addTransceiver(local.audio || 'audio', { direction: 'sendonly', streams: [local.stream] });
      const v = pc.addTransceiver(local.video || 'video', { direction: 'sendonly', streams: [local.stream] });
      capBitrate(v.sender, 1_200_000);
    } else {
      ctx.screen.getTracks().forEach(t => pc.addTransceiver(t, { direction: 'sendonly', streams: [ctx.screen] }));
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && ctx.pubs[kind] === pc && !ctx.closed) setTimeout(() => publish(kind), 1500);
    };
    try { await negotiate(pc, mediaUrl(ctx.me, kind, 'whip')); }
    catch (e) {
      if (ctx.pubs[kind] === pc && !ctx.closed) setTimeout(() => publish(kind), 3000);
    }
  }

  async function subscribe(peer, kind, attempt = 0) {
    if (ctx.closed || !ctx.peers.has(peer.data.peer)) return;
    dropSubscription(peer, kind);
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    peer.whep[kind] = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const stream = new MediaStream();
    pc.ontrack = e => {
      stream.addTrack(e.track);
      peer.streams[kind] = stream;
      if (kind === 'cam') { paintTile(peer.data.peer); if (e.track.kind === 'audio') meter(peer.data.peer, stream); }
      else layout();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && peer.whep[kind] === pc) setTimeout(() => subscribe(peer, kind), 2000);
    };
    try { await negotiate(pc, mediaUrl(peer.data.peer, kind, 'whep')); }
    catch (e) {
      // Le participant n'a pas encore fini de publier : on réessaie.
      if (peer.whep[kind] === pc && attempt < 30 && (kind === 'cam' || peer.data.screen)) setTimeout(() => subscribe(peer, kind, attempt + 1), 1500);
    }
  }

  function dropSubscription(peer, kind) {
    if (peer.whep[kind]) { peer.whep[kind].close(); peer.whep[kind] = null; }
    if (kind === 'scr' && peer.streams.scr) { peer.streams.scr = null; layout(); }
  }

  // ---------------------------------------------------------- transport : pair-à-pair (p2p)
  async function makePc(peer) {
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    peer.pc = pc;
    peer.pending = [];
    pc.onicecandidate = e => e.candidate && send('meet.signal', { meeting_id: ctx.meeting.id, to: peer.data.peer, data: { candidate: e.candidate } });
    pc.ontrack = e => {
      const index = pc.getTransceivers().indexOf(e.transceiver);
      const kind = index === 2 ? 'scr' : 'cam';
      if (!peer.streams[kind]) peer.streams[kind] = new MediaStream();
      peer.streams[kind].addTrack(e.track);
      if (kind === 'cam') { paintTile(peer.data.peer); if (e.track.kind === 'audio') meter(peer.data.peer, peer.streams.cam); }
      e.track.onunmute = () => { if (kind === 'scr') layout(); };
      layout();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && peer.pc === pc && ctx.me < peer.data.peer) {
        pc.restartIce();
        offer(peer);
      }
    };
    return pc;
  }

  function attachLocalTracks(pc) {
    const tr = pc.getTransceivers();
    if (tr.length < 3) return;
    tr[0].sender.replaceTrack(local.audio || null).catch(() => {});
    tr[1].sender.replaceTrack(local.video || null).catch(() => {});
    tr[2].sender.replaceTrack(ctx.screen ? ctx.screen.getVideoTracks()[0] : null).catch(() => {});
    const n = Math.max(1, ctx.peers.size - 1);
    capBitrate(tr[1].sender, n > 4 ? 300_000 : n > 2 ? 600_000 : 1_200_000);
  }

  async function offer(peer) {
    const pc = peer.pc;
    await pc.setLocalDescription(await pc.createOffer());
    send('meet.signal', { meeting_id: ctx.meeting.id, to: peer.data.peer, data: { sdp: pc.localDescription } });
  }

  async function connectPeer(peer) {
    if (ctx.media.mode === 'sfu') {
      subscribe(peer, 'cam');
      if (peer.data.screen) subscribe(peer, 'scr');
      return;
    }
    // Pair-à-pair : celui dont l'identifiant est le plus petit fait l'offre (pas de collision).
    if (ctx.me < peer.data.peer) {
      const pc = await makePc(peer);
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      attachLocalTracks(pc);
      await offer(peer);
    }
  }

  async function onSignal({ from, data }) {
    const peer = ctx.peers.get(from);
    if (!peer || ctx.media.mode !== 'p2p') return;
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          const pc = peer.pc || await makePc(peer);
          await pc.setRemoteDescription(data.sdp);
          pc.getTransceivers().forEach(t => { t.direction = 'sendrecv'; });
          attachLocalTracks(pc);
          await pc.setLocalDescription(await pc.createAnswer());
          send('meet.signal', { meeting_id: ctx.meeting.id, to: from, data: { sdp: pc.localDescription } });
        } else if (peer.pc) await peer.pc.setRemoteDescription(data.sdp);
        for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
      } else if (data.candidate) {
        if (peer.pc && peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pending.push(data.candidate);
      }
    } catch (e) { console.warn('[meet] signalisation', e); }
  }

  function closePeerMedia(peer) {
    if (peer.pc) { peer.pc.close(); peer.pc = null; }
    dropSubscription(peer, 'cam');
    dropSubscription(peer, 'scr');
    peer.streams = { cam: null, scr: null };
  }

  // Changement de piste locale (micro, caméra, périphérique) : on remplace sans renégocier.
  function syncLocalTracks() {
    if (ctx.media.mode === 'sfu') {
      const pc = ctx.pubs.cam;
      if (pc) {
        const [a, v] = pc.getTransceivers();
        if (a) a.sender.replaceTrack(local.audio || null).catch(() => {});
        if (v) v.sender.replaceTrack(local.video || null).catch(() => {});
      }
    } else ctx.peers.forEach(p => p.pc && p.pc.getTransceivers().length >= 3 && attachLocalTracks(p.pc));
    const me = ctx.peers.get(ctx.me);
    if (me) paintTile(ctx.me);
    meter(ctx.me, local.stream);
  }
  ctx.offs.push(local.onChange(() => { syncLocalTracks(); paintControls(); }));

  // ---------------------------------------------------------- commandes
  function paintControls() {
    const me = ctx.peers.get(ctx.me);
    const manager = isManager();
    const micLocked = !manager && !ctx.settings.mic_allowed;
    const camLocked = !manager && !ctx.settings.cam_allowed;
    micBtn.classList.toggle('off', !local.mic);
    micBtn.classList.toggle('locked', micLocked);
    clear(micBtn, icon(local.mic ? 'mic' : 'micOff', 22));
    micBtn.title = micLocked ? "L'organisateur a désactivé les micros" : local.mic ? 'Désactiver le micro (Ctrl+D)' : 'Activer le micro (Ctrl+D)';
    micBtn.setAttribute('aria-label', micBtn.title);
    camBtn.classList.toggle('off', !local.cam);
    camBtn.classList.toggle('locked', camLocked);
    clear(camBtn, icon(local.cam ? 'video' : 'camOff', 22));
    camBtn.title = camLocked ? "L'organisateur a désactivé les caméras" : local.cam ? 'Désactiver la caméra (Ctrl+E)' : 'Activer la caméra (Ctrl+E)';
    camBtn.setAttribute('aria-label', camBtn.title);
    ccBtn.classList.toggle('on', ctx.captionsOn);
    handBtn.classList.toggle('on', !!(me && me.data.hand));
    shareBtn.classList.toggle('on', !!ctx.screen);
    shareBtn.classList.toggle('locked', !manager && !ctx.settings.present_allowed);
    reactBtn.classList.toggle('locked', !manager && !ctx.settings.reactions_enabled);
    sideBtns.host.classList.toggle('hidden', !manager);
    peopleCount.textContent = String(ctx.peers.size);
    const hands = [...ctx.peers.values()].filter(p => p.data.hand).sort((a, b) => a.data.hand - b.data.hand);
    handsBtn.classList.toggle('hidden', !hands.length);
    handsCount.textContent = String(hands.length);
    handsBtn.title = hands.length ? `Main levée : ${hands.map(nameOf).join(', ')}` : '';
    handsBtn.setAttribute('aria-label', handsBtn.title || 'Mains levées');
    setBadge(sideBtns.people, manager ? ctx.waiting.length : 0);
    setBadge(sideBtns.chat, ctx.unread);
    notesPill.classList.toggle('hidden', !ctx.notes.active);
    document.title = `${ctx.meeting.title || ctx.meeting.code} · Kozons Meet`;
  }
  function setBadge(button, n) {
    const b = button.querySelector('.badge');
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('hidden', !n);
  }

  function toggleMic(force) {
    const on = force === undefined ? !local.mic : force;
    if (on && !local.audio) return toast(local.errors.audio || 'Aucun micro disponible.', { type: 'error' });
    if (on && !isManager() && !ctx.settings.mic_allowed) return notice("L'organisateur a désactivé les micros.");
    local.setMic(on);
    send('meet.state', { meeting_id: ctx.meeting.id, mic: local.mic });
    updateRecognition();
  }

  async function toggleCam(force) {
    const on = force === undefined ? !local.cam : force;
    if (on && !isManager() && !ctx.settings.cam_allowed) return notice("L'organisateur a désactivé les caméras.");
    const ok = await local.setCam(on);
    if (on && !ok) toast(local.errors.video || 'Caméra indisponible.', { type: 'error' });
    send('meet.state', { meeting_id: ctx.meeting.id, cam: local.cam });
  }

  function toggleHand() {
    const me = ctx.peers.get(ctx.me);
    send('meet.state', { meeting_id: ctx.meeting.id, hand: !(me && me.data.hand) });
  }

  async function toggleScreen() {
    if (ctx.screen) return stopScreen();
    if (!isManager() && !ctx.settings.present_allowed) return notice("Seul l'organisateur peut présenter.");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return notice("Ce navigateur ne permet pas de partager l'écran.");
    try {
      ctx.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: true });
    } catch (e) { return; }
    const vt = ctx.screen.getVideoTracks()[0];
    if (vt) { vt.contentHint = 'detail'; vt.onended = () => stopScreen(); }
    ctx.pinned = null;
    if (ctx.media.mode === 'sfu') publish('scr');
    else ctx.peers.forEach(p => p.pc && p.pc.getTransceivers().length >= 3 && attachLocalTracks(p.pc));
    send('meet.state', { meeting_id: ctx.meeting.id, screen: true });
    paintControls();
    layout();
  }

  function stopScreen() {
    if (!ctx.screen) return;
    ctx.screen.getTracks().forEach(t => t.stop());
    ctx.screen = null;
    if (ctx.pubs.scr) { ctx.pubs.scr.close(); ctx.pubs.scr = null; }
    ctx.peers.forEach(p => p.pc && p.pc.getTransceivers().length >= 3 && attachLocalTracks(p.pc));
    send('meet.state', { meeting_id: ctx.meeting.id, screen: false });
    paintControls();
    layout();
  }

  function reactionPicker(anchor) {
    if (!isManager() && !ctx.settings.reactions_enabled) return notice("L'organisateur a désactivé les réactions.");
    const existing = room.querySelector('.mt-react-menu');
    if (existing) return existing.remove();
    const pop = h('div.mt-react-menu', ctx.reactions.map(e => h('button.mt-react-btn', { type: 'button', title: e, onclick: () => send('meet.react', { meeting_id: ctx.meeting.id, emoji: e }) }, e)));
    room.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left + r.width / 2 - pop.offsetWidth / 2)) + 'px';
    pop.style.bottom = (window.innerHeight - r.top + 10) + 'px';
    const away = ev => { if (!pop.contains(ev.target) && !anchor.contains(ev.target)) { pop.remove(); document.removeEventListener('pointerdown', away, true); } };
    document.addEventListener('pointerdown', away, true);
  }

  function showReaction(peerId, emoji) {
    const peer = ctx.peers.get(peerId);
    const el = h('div.mt-reaction', { style: { left: (8 + Math.random() * 18) + '%' } }, h('span.mt-reaction-emoji', emoji), h('span.mt-reaction-name', nameOf(peer)));
    reactionsLayer.appendChild(el);
    setTimeout(() => el.remove(), 4200);
    if (peer) {
      const pop = h('span.mt-tile-react', emoji);
      peer.view.tile.appendChild(pop);
      setTimeout(() => pop.remove(), 2500);
    }
  }

  function moreMenu(anchor) {
    const small = window.innerWidth <= 900;
    menu(anchor, [
      small ? { label: ctx.screen ? 'Arrêter la présentation' : 'Présenter mon écran', icon: 'screen', action: () => toggleScreen() } : null,
      small ? { label: 'Informations sur la réunion', icon: 'info', action: () => openPanel('info') } : null,
      small && isManager() ? { label: "Commandes de l'organisateur", icon: 'lock', action: () => openPanel('host') } : null,
      { label: 'Modifier la mise en page', icon: 'grid', action: layoutDialog },
      { label: document.fullscreenElement ? 'Quitter le plein écran' : 'Plein écran', icon: 'arrowOut', action: () => document.fullscreenElement ? document.exitFullscreen() : room.requestFullscreen().catch(() => {}) },
      { label: 'Me mettre à jour (résumé IA)', icon: 'doc', action: () => { openPanel('activities'); requestCatchup(); } },
      { label: ctx.captionsOn ? 'Désactiver les sous-titres' : 'Activer les sous-titres', icon: 'comment', action: () => toggleCaptions() },
      { label: 'Copier le lien de la réunion', icon: 'link', action: copyLink },
      { label: 'Paramètres audio et vidéo', icon: 'settings', action: () => devicesDialog(local, id => ctx.peers.forEach(p => p.view.video.setSinkId && p.data.peer !== ctx.me && p.view.video.setSinkId(id).catch(() => {}))) },
      small ? null : { label: 'Raccourcis clavier', icon: 'keyboard', action: shortcutsDialog },
    ].filter(Boolean));
  }

  function layoutDialog() {
    const m = modal(h('div.mt-layouts', LAYOUTS.map(([key, label]) => h('label.mt-radio',
      h('input', { type: 'radio', name: 'mt-layout', checked: ctx.layout === key, onchange: () => {
        ctx.layout = key;
        try { localStorage.setItem('kozons.meet.layout', key); } catch (e) { /* ignoré */ }
        layout();
        m.close();
      } }), h('span', label))),
    h('p.muted.small', 'Astuce : double-cliquez sur une vignette pour l’épingler en grand.')), { title: 'Mise en page' });
  }

  function shortcutsDialog() {
    const rows = [['Ctrl + D', 'Activer / désactiver le micro'], ['Ctrl + E', 'Activer / désactiver la caméra'], ['Ctrl + Alt + H', 'Lever / baisser la main'],
      ['Ctrl + Alt + C', 'Ouvrir / fermer le chat'], ['Ctrl + Alt + P', 'Ouvrir / fermer les participants'], ['C', 'Sous-titres'], ['Espace (maintenir)', 'Parler micro coupé (talkie-walkie)']];
    modal(h('table.mt-keys', rows.map(([k, v]) => h('tr', h('td', h('kbd', k)), h('td', v)))), { title: 'Raccourcis clavier' });
  }

  function copyLink() {
    const url = location.origin + '/meet/' + ctx.meeting.code;
    navigator.clipboard.writeText(url).then(() => notice('Lien de la réunion copié')).catch(() => notice(url));
  }

  function leaveMenu(anchor) {
    if (!isManager()) return exit('left');
    menu(anchor, [
      { label: "Quitter l'appel", icon: 'logout', action: () => exit('left') },
      { label: "Mettre fin à l'appel pour tous", icon: 'phoneOff', danger: true, action: async () => {
        if (await confirmDialog("Mettre fin à l'appel pour tous les participants ?", { ok: 'Mettre fin', danger: true })) {
          send('meet.end', { meeting_id: ctx.meeting.id });
          exit('ended_by_me', false);
        }
      } },
    ]);
  }

  // ---------------------------------------------------------- panneaux latéraux
  function openPanel(key) {
    ctx.panel = ctx.panel === key ? null : key;
    Object.entries(sideBtns).forEach(([k, b]) => b.classList.toggle('active', k === ctx.panel));
    panelEl.classList.toggle('hidden', !ctx.panel);
    room.classList.toggle('with-panel', !!ctx.panel);
    if (ctx.panel === 'chat') { ctx.unread = 0; paintControls(); }
    renderPanel();
    setTimeout(fitGrid, 50);
  }

  function panelShell(title, ...body) {
    return [h('header.mt-panel-head', h('h3', title), btn('close', 'Fermer', () => openPanel(ctx.panel))), h('div.mt-panel-body', ...body)];
  }

  function renderPanel() {
    if (!ctx.panel) return clear(panelEl);
    const render = { info: infoPanel, people: peoplePanel, chat: chatPanel, activities: activitiesPanel, host: hostPanel }[ctx.panel];
    clear(panelEl, render());
  }
  const refreshPeople = debounce(() => { paintControls(); if (ctx.panel === 'people') renderPanel(); }, 60);

  function infoPanel() {
    const url = location.origin + '/meet/' + ctx.meeting.code;
    const m = ctx.meeting;
    return panelShell('Informations sur la réunion',
      h('div.mt-info-block',
        h('div.mt-info-title', 'Informations de connexion'),
        h('div.mt-link', url),
        h('div.row.gap',
          h('button.btn.small.ghost', { onclick: copyLink }, icon('copy', 16), " Copier l'adresse"),
          navigator.share ? h('button.btn.small.ghost', { onclick: () => navigator.share({ title: m.label, url }).catch(() => {}) }, icon('share', 16), ' Partager') : null),
        h('p.muted.small', 'Code de la réunion : ', h('strong', m.code))),
      m.scheduled_at ? h('div.mt-info-block', h('div.mt-info-title', 'Horaire'), h('p', new Date(m.scheduled_at).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }))) : null,
      m.description ? h('div.mt-info-block', h('div.mt-info-title', 'Description'), h('p.mt-pre', m.description)) : null,
      h('div.mt-info-block', h('div.mt-info-title', 'Organisateur'), h('div.row.gap', avatar(m.host.avatar, m.host.name, 32), h('span', m.host.name))),
      h('p.muted.small', ctx.media.mode === 'sfu' ? 'Les flux audio et vidéo passent par le serveur Kozons.' : 'Connexion directe entre participants (mode développement).'));
  }

  function peoplePanel() {
    const manager = isManager();
    const search = h('input.input', { type: 'search', placeholder: 'Rechercher des participants' });
    const list = h('div.mt-people');
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const peers = [...ctx.peers.values()]
        .filter(p => !q || nameOf(p).toLowerCase().includes(q) || (p.data.user && p.data.user.name.toLowerCase().includes(q)))
        .sort((a, b) => (!!b.data.hand - !!a.data.hand) || (a.data.hand || 0) - (b.data.hand || 0) || (b.data.peer === ctx.me) - (a.data.peer === ctx.me) || a.data.joined_at - b.data.joined_at);
      clear(list, peers.map(p => h('div.mt-person',
        avatar(p.data.user && p.data.user.avatar, p.data.user && p.data.user.name, 36),
        h('div.mt-person-name', h('strong', nameOf(p) === 'Vous' ? `${p.data.user ? p.data.user.name : ''} (Vous)` : nameOf(p)),
          p.data.role === 'host' ? h('small', 'Organisateur de la réunion') : p.data.role === 'cohost' ? h('small', 'Co-organisateur') : null),
        p.data.hand ? h('span.mt-person-hand', '✋') : null,
        p.data.screen ? icon('screen', 18) : null,
        h('span.mt-person-mic' + ((p.data.peer === ctx.me ? local.mic : p.data.mic) ? '' : '.off'), icon((p.data.peer === ctx.me ? local.mic : p.data.mic) ? 'mic' : 'micOff', 18)),
        btn('more', 'Options', e => tileOptions(p.data.peer, e.currentTarget)))));
    };
    search.addEventListener('input', paint);
    paint();
    const waitingBox = manager && ctx.waiting.length ? h('div.mt-waiting',
      h('div.row.space', h('strong', `Dans la salle d'attente (${ctx.waiting.length})`),
        ctx.waiting.length > 1 ? h('button.btn.small.primary', { onclick: () => send('meet.admit', { meeting_id: ctx.meeting.id, all: true }) }, 'Tout admettre') : null),
      ctx.waiting.map(w => h('div.mt-person',
        avatar(w.user.avatar, w.user.name, 36), h('div.mt-person-name', h('strong', w.user.name), h('small', 'Demande à participer')),
        h('button.btn.small.ghost', { onclick: () => send('meet.admit', { meeting_id: ctx.meeting.id, request_id: w.id, allow: false }) }, 'Refuser'),
        h('button.btn.small.primary', { onclick: () => send('meet.admit', { meeting_id: ctx.meeting.id, request_id: w.id }) }, 'Admettre')))) : null;
    return panelShell('Participants',
      manager ? h('button.btn.primary.small', { onclick: invitePeople }, icon('plus', 16), ' Ajouter des personnes') : null,
      search, waitingBox,
      manager ? h('div.row.gap.mt-people-actions',
        h('button.btn.small.ghost', { onclick: () => send('meet.mute', { meeting_id: ctx.meeting.id, all: true }) }, icon('micOff', 16), ' Couper tous les micros'),
        [...ctx.peers.values()].some(p => p.data.hand) ? h('button.btn.small.ghost', { onclick: () => send('meet.lower_hand', { meeting_id: ctx.meeting.id, all: true }) }, '✋ Baisser toutes les mains') : null) : null,
      h('div.mt-info-title', `Dans la réunion (${ctx.peers.size})`),
      list);
  }

  function tileOptions(peerId, anchor) {
    const peer = ctx.peers.get(peerId);
    if (!peer) return;
    const mine = peerId === ctx.me;
    const manager = isManager();
    const iAmHost = ctx.peers.get(ctx.me) && ctx.peers.get(ctx.me).data.role === 'host';
    menu(anchor, [
      { label: ctx.pinned === peerId ? 'Retirer l’épingle' : 'Épingler en grand', icon: 'pin', action: () => pin(ctx.pinned === peerId ? null : peerId) },
      !mine && manager && peer.data.mic ? { label: 'Couper le micro', icon: 'micOff', action: () => send('meet.mute', { meeting_id: ctx.meeting.id, peer: peerId }) } : null,
      !mine && manager && peer.data.hand ? { label: 'Baisser la main', icon: 'arrowDown', action: () => send('meet.lower_hand', { meeting_id: ctx.meeting.id, peer: peerId }) } : null,
      !mine && iAmHost && peer.data.role !== 'host' ? {
        label: peer.data.role === 'cohost' ? 'Retirer le rôle de co-organisateur' : 'Nommer co-organisateur', icon: 'users',
        action: () => send('meet.cohost', { meeting_id: ctx.meeting.id, peer: peerId, on: peer.data.role !== 'cohost' }),
      } : null,
      !mine && manager && peer.data.role !== 'host' ? { label: 'Retirer de la réunion', icon: 'block', danger: true, action: async () => {
        if (await confirmDialog(`Retirer ${nameOf(peer)} de la réunion ?`, { ok: 'Retirer', danger: true })) send('meet.remove', { meeting_id: ctx.meeting.id, peer: peerId });
      } } : null,
    ].filter(Boolean));
  }

  async function invitePeople() {
    const input = h('input.input', { type: 'search', placeholder: 'Nom ou @identifiant' });
    const results = h('div.mt-search-results');
    const existing = new Set((ctx.meeting.invites || []).map(u => u.id));
    input.addEventListener('input', debounce(async () => {
      const q = input.value.trim();
      if (!q) return clear(results);
      try {
        const { results: users } = await api.get('users/search?q=' + encodeURIComponent(q));
        const row = u => {
          if (existing.has(u.id)) return h('span.muted.small', 'Invité');
          const b = h('button.btn.small.primary', { type: 'button' }, 'Inviter');
          b.onclick = async () => {
            b.disabled = true;
            existing.add(u.id);
            try {
              const updated = await api.post(`meet/${ctx.meeting.code}/update`, { add_invitees: [u.id] });
              ctx.meeting.invites = updated.invites;
              notice(`${u.name} a été invité(e) : une notification lui a été envoyée.`);
              b.replaceWith(h('span.muted.small', 'Invité'));
            } catch (err) { existing.delete(u.id); b.disabled = false; errorToast(err); }
          };
          return b;
        };
        clear(results, users.map(u => h('div.mt-person', avatar(u.avatar, u.name, 32),
          h('div.mt-person-name', h('strong', u.name), h('small', '@' + u.username)), row(u))));
      } catch (e) { errorToast(e); }
    }, 250));
    modal(h('div.mt-invite', input, results, h('p.muted.small', 'Ou partagez le lien : ', h('a', { href: '#', onclick: e => { e.preventDefault(); copyLink(); } }, 'copier le lien de la réunion'))), { title: 'Ajouter des personnes' });
  }

  function chatPanel() {
    const manager = isManager();
    const allowed = manager || ctx.settings.chat_enabled;
    const list = h('div.mt-chat-list', ctx.messages.length ? ctx.messages.map(chatItem)
      : h('p.muted.small.center', 'Les messages sont visibles par les participants présents et sont repris dans les notes IA de la réunion.'));
    const input = h('textarea.input.mt-chat-input', { rows: 1, maxlength: 2000, placeholder: allowed ? 'Envoyer un message' : "L'organisateur a désactivé le chat", disabled: !allowed });
    const sendMsg = () => {
      const text = input.value.trim();
      if (!text) return;
      send('meet.chat', { meeting_id: ctx.meeting.id, text });
      input.value = '';
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
    setTimeout(() => { list.scrollTop = list.scrollHeight; if (allowed && !isTouch()) input.focus(); }, 30);
    return panelShell('Messages dans l’appel',
      manager ? h('label.mt-switch', h('input', { type: 'checkbox', checked: ctx.settings.chat_enabled, onchange: e => send('meet.settings', { meeting_id: ctx.meeting.id, chat_enabled: e.target.checked }) }), h('span', 'Autoriser tout le monde à envoyer des messages')) : null,
      list,
      h('div.mt-chat-compose', input, h('button.mt-send', { type: 'button', 'aria-label': 'Envoyer', disabled: !allowed, onclick: sendMsg }, icon('send', 20))));
  }

  function chatItem(m) {
    return h('div.mt-chat-item', h('div.mt-chat-meta', h('strong', m.user.id === state.me.id ? 'Vous' : m.user.name), h('span', timeHM(m.created_at))), h('div.mt-chat-text', richText(m.text)));
  }

  function activitiesPanel() {
    const manager = isManager();
    const n = ctx.notes;
    const status = n.active
      ? h('div.mt-notes-status.on', h('span.mt-rec-dot'), h('div', h('strong', 'Prise de notes en cours'),
        h('small', `Depuis ${timeHM(n.started_at)}. Les paroles sont transcrites puis résumées par l’IA à la fin.`)))
      : h('div.mt-notes-status', h('div', h('strong', 'Prise de notes IA'), h('small', 'L’IA transcrit la réunion, puis rédige un compte rendu : résumé, décisions, tâches et chapitres.')));
    const reasons = [];
    if (!SpeechRecognition) reasons.push('Votre navigateur ne transcrit pas la voix (utilisez Chrome ou Edge) : vos paroles ne seront pas dans les notes.');
    else if (isTouch()) reasons.push('Sur téléphone, la transcription de votre voix est désactivée (elle couperait le micro de l’appel).');
    if (!n.ai_enabled) reasons.push('IA non configurée sur ce serveur : les notes contiendront la transcription seule.');
    return panelShell('Activités',
      h('div.mt-activity', status,
        manager ? h('button.btn.' + (n.active ? 'ghost' : 'primary'), { onclick: () => toggleNotes() }, n.active ? 'Arrêter la prise de notes' : 'Commencer la prise de notes')
          : (!n.active ? h('p.muted.small', "Seuls l'organisateur et les co-organisateurs peuvent lancer la prise de notes.") : null),
        reasons.map(r => h('p.mt-warn', r)),
        h('p.muted.small', ctx.settings.notes_share === 'all' ? 'Les notes seront envoyées à tous les participants présents pendant la prise de notes.' : 'Les notes seront envoyées aux organisateurs.')),
      h('div.mt-activity',
        h('strong', 'Me mettre à jour'),
        h('p.muted.small', 'Arrivé(e) en retard ? L’IA vous résume ce qui a été dit depuis le début de la prise de notes.'),
        h('button.btn.ghost', { disabled: !n.active || !n.ai_enabled, onclick: requestCatchup }, icon('doc', 16), ' Résumer ce que j’ai manqué'),
        catchupBox),
      h('div.mt-activity',
        h('strong', 'Sous-titres en direct'),
        h('p.muted.small', 'Affiche ce que disent les participants, en temps réel.'),
        h('button.btn.ghost', { onclick: () => toggleCaptions() }, ctx.captionsOn ? 'Désactiver les sous-titres' : 'Activer les sous-titres')));
  }
  const catchupBox = h('div.mt-catchup.hidden');

  function requestCatchup() {
    if (!ctx.notes.active) return notice("Lancez la prise de notes pour pouvoir résumer la réunion.");
    clear(catchupBox, spinner(22), h('span.muted.small', ' Rédaction du résumé…'));
    catchupBox.classList.remove('hidden');
    send('meet.catchup', { meeting_id: ctx.meeting.id });
  }

  function toggleNotes() {
    send('meet.notes', { meeting_id: ctx.meeting.id, on: !ctx.notes.active });
  }

  function hostPanel() {
    const s = ctx.settings;
    const set = (key, value) => send('meet.settings', { meeting_id: ctx.meeting.id, [key]: value });
    const sw = (key, label, hint) => h('label.mt-switch', h('input', { type: 'checkbox', checked: !!s[key], onchange: e => set(key, e.target.checked) }), h('span', label, hint ? h('small', hint) : null));
    const access = [['open', 'Ouvert', 'Tout le monde avec le lien entre sans demander'], ['trusted', 'Fiable', 'Les invités entrent, les autres demandent à participer'], ['restricted', 'Restreint', 'Seules les personnes invitées peuvent participer']];
    return panelShell("Commandes de l'organisateur",
      h('p.muted.small', "Seuls l'organisateur et les co-organisateurs voient ces réglages."),
      h('div.mt-info-title', "Accès à la réunion"),
      access.map(([k, label, hint]) => h('label.mt-radio', h('input', { type: 'radio', name: 'mt-access', checked: s.access === k, onchange: () => set('access', k) }), h('span', label, h('small', hint)))),
      h('div.mt-info-title', 'Autoriser les participants à :'),
      sw('present_allowed', 'Partager leur écran'),
      sw('chat_enabled', 'Envoyer des messages dans le chat'),
      sw('reactions_enabled', 'Envoyer des réactions'),
      sw('mic_allowed', 'Activer leur micro', 'Désactiver coupe immédiatement les micros'),
      sw('cam_allowed', 'Activer leur caméra'),
      h('div.mt-info-title', 'Notes IA'),
      sw('notes_auto', 'Démarrer automatiquement la prise de notes', 'À l’ouverture des prochaines séances'),
      h('label.mt-switch', h('input', { type: 'checkbox', checked: s.notes_share === 'all', onchange: e => set('notes_share', e.target.checked ? 'all' : 'hosts') }),
        h('span', 'Envoyer les notes à tous les participants', h('small', 'Sinon, seulement aux organisateurs'))),
      h('label.mt-field', h('span', 'Langue de la réunion (sous-titres)'),
        h('select.input', { onchange: e => set('language', e.target.value) },
          [['fr-FR', 'Français'], ['en-US', 'Anglais'], ['es-ES', 'Espagnol'], ['pt-BR', 'Portugais'], ['de-DE', 'Allemand'], ['ar-SA', 'Arabe']]
            .map(([v, l]) => h('option', { value: v, selected: s.language === v }, l)))));
  }

  // ---------------------------------------------------------- sous-titres et transcription (navigateur)
  let rec = null, recWanted = false, recSeq = 0, lastInterim = 0, recFailed = false;
  function shouldTranscribe() {
    return ctx.notes.transcribe && local.mic && !!SpeechRecognition && !isTouch() && !recFailed && !ctx.closed;
  }
  function updateRecognition() {
    const want = shouldTranscribe();
    if (want === recWanted && (rec || !want)) return;
    recWanted = want;
    if (want) startRec(); else if (rec) { try { rec.stop(); } catch (e) { /* ignoré */ } }
  }
  function startRec() {
    if (rec || !recWanted) return;
    rec = new SpeechRecognition();
    rec.lang = ctx.settings.language || 'fr-FR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (r.isFinal) { recSeq++; send('meet.caption', { meeting_id: ctx.meeting.id, text, final: true, seq: recSeq }); }
        else if (Date.now() - lastInterim > 400) { lastInterim = Date.now(); send('meet.caption', { meeting_id: ctx.meeting.id, text, final: false, seq: recSeq + 1 }); }
      }
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { recFailed = true; notice('Transcription de votre voix impossible : autorisation refusée.'); }
    };
    rec.onend = () => {
      rec = null;
      if (recWanted && shouldTranscribe()) setTimeout(startRec, 300);  // le navigateur s'arrête seul après un silence
      else recWanted = false;
    };
    try { rec.start(); } catch (e) { rec = null; }
  }

  function toggleCaptions() {
    ctx.captionsOn = !ctx.captionsOn;
    captionsEl.classList.toggle('hidden', !ctx.captionsOn);
    send('meet.captions', { meeting_id: ctx.meeting.id, on: ctx.captionsOn });
    if (ctx.captionsOn && !SpeechRecognition) notice('Votre navigateur ne transcrit pas votre voix, mais vous verrez les sous-titres des autres.');
    paintControls();
    if (ctx.panel === 'activities') renderPanel();
  }

  function onCaption(c) {
    if (!ctx.captionsOn) return;
    const entry = ctx.captions.get(c.peer) || { lines: [], interim: '' };
    if (c.final) { entry.lines.push(c.text); entry.lines = entry.lines.slice(-2); entry.interim = ''; }
    else entry.interim = c.text;
    entry.at = Date.now();
    entry.name = c.peer === ctx.me ? 'Vous' : c.name;
    ctx.captions.set(c.peer, entry);
    paintCaptions();
  }
  function paintCaptions() {
    const recent = [...ctx.captions.entries()].filter(([, e]) => Date.now() - e.at < 6000).sort((a, b) => a[1].at - b[1].at).slice(-2);
    clear(captionsEl, recent.map(([peerId, e]) => {
      const peer = ctx.peers.get(peerId);
      const user = peer && peer.data.user;
      return h('div.mt-caption', avatar(user && user.avatar, user ? user.name : e.name, 28),
        h('div', h('strong', e.name), h('p', [...e.lines, e.interim].filter(Boolean).join(' ').slice(-220))));
    }));
  }
  ctx.timers.push(setInterval(() => { if (ctx.captionsOn) paintCaptions(); }, 1000));

  // ---------------------------------------------------------- événements du serveur
  const mine = fn => data => { if (data && data.meeting_id === ctx.meeting.id && !ctx.closed) fn(data); };
  ctx.offs.push(
    bus.on('meet.peer', mine(d => upsertPeer(d))),
    bus.on('meet.peer_left', mine(d => { const p = ctx.peers.get(d.peer); if (p && d.peer !== ctx.me) { notice(`${nameOf(p)} a quitté la réunion`, { timeout: 2500 }); removePeer(d.peer); } })),
    bus.on('meet.signal', mine(onSignal)),
    bus.on('meet.chat', mine(m => {
      ctx.messages.push(m);
      if (ctx.panel === 'chat') {
        const list = panelEl.querySelector('.mt-chat-list');
        if (list) { if (ctx.messages.length === 1) clear(list); list.appendChild(chatItem(m)); list.scrollTop = list.scrollHeight; }
      } else if (m.user.id !== state.me.id) {
        ctx.unread++;
        paintControls();
        notice(`${m.user.name} : ${m.text.slice(0, 90)}`, { action: { label: 'Ouvrir', run: () => openPanel('chat') } });
      }
    })),
    bus.on('meet.react', mine(d => showReaction(d.peer, d.emoji))),
    bus.on('meet.waiting_list', mine(d => {
      const before = ctx.waiting.length;
      ctx.waiting = d.waiting;
      if (ctx.waiting.length > before && isManager()) {
        const w = ctx.waiting[ctx.waiting.length - 1];
        notice(`${w.user.name} souhaite participer`, { timeout: 15000, action: { label: 'Afficher', run: () => { if (ctx.panel !== 'people') openPanel('people'); } } });
      }
      refreshPeople();
    })),
    bus.on('meet.muted', mine(d => { local.setMic(false); updateRecognition(); notice(`${d.by} a coupé votre micro`); })),
    bus.on('meet.forced', mine(d => {
      if (d.mic === false) { local.setMic(false); updateRecognition(); notice("L'organisateur a désactivé les micros."); }
      if (d.cam === false) { local.setCam(false); notice("L'organisateur a désactivé les caméras."); }
      if (d.screen === false) { stopScreen(); notice("L'organisateur a désactivé la présentation."); }
    })),
    bus.on('meet.settings', mine(d => { ctx.settings = d.settings; ctx.meeting.settings = d.settings; paintControls(); if (ctx.panel) renderPanel(); })),
    bus.on('meet.notes', mine(d => {
      const was = ctx.notes.active;
      ctx.notes = d;
      if (d.active && !was) notice("📝 La prise de notes a commencé : les paroles sont transcrites pour le compte rendu.", { timeout: 7000 });
      if (!d.active && was) notice('Prise de notes arrêtée : le compte rendu sera envoyé après rédaction.', { timeout: 6000 });
      updateRecognition();
      paintControls();
      if (ctx.panel === 'activities') renderPanel();
    })),
    bus.on('meet.caption', mine(onCaption)),
    bus.on('meet.catchup', mine(d => {
      if (d.pending) return;
      catchupBox.classList.remove('hidden');
      clear(catchupBox, d.error ? h('p.mt-warn', d.error) : h('div.mt-pre', d.text));
      if (ctx.panel !== 'activities') openPanel('activities');
    })),
    bus.on('meet.removed', mine(() => exit('removed', false))),
    bus.on('meet.ended', mine(() => exit('ended', false))),
    bus.on('meet.joined', data => { if (data.meeting.id === ctx.meeting.id && !ctx.closed) resync(data); }),
    bus.on('error', e => { if (e && e.for && e.for.startsWith('meet.') && !ctx.closed) notice(e.message); }),
    // Connexion temps réel rétablie : le serveur nous a perdus, on rejoint à nouveau.
    bus.on('ws:reconnected', () => { if (!ctx.closed) send('meet.join', { code: ctx.meeting.code, mic: local.mic, cam: local.cam }); }),
  );

  // Retour après une coupure : nouvel identifiant, on reconstruit toutes les connexions vidéo.
  function resync(data) {
    if (data.me === ctx.me) return;
    ctx.peers.forEach(p => closePeerMedia(p));
    ctx.peers.forEach((p, id) => { p.view.tile.remove(); stopMeter(id); });
    ctx.peers.clear();
    Object.values(ctx.pubs).forEach(pc => pc && pc.close());
    ctx.pubs = { cam: null, scr: null };
    ctx.me = data.me;
    ctx.media = data.media;
    ctx.settings = data.meeting.settings;
    ctx.notes = data.notes;
    ctx.waiting = data.waiting || [];
    boot(data.peers);
    if (ctx.screen) { send('meet.state', { meeting_id: ctx.meeting.id, screen: true }); if (ctx.media.mode === 'sfu') publish('scr'); }
  }

  // ---------------------------------------------------------- raccourcis clavier
  let spaceHeld = false;
  const onKey = e => {
    if (ctx.closed) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'd') { e.preventDefault(); toggleMic(); }
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'e') { e.preventDefault(); toggleCam(); }
    else if (e.ctrlKey && e.altKey && k === 'h') { e.preventDefault(); toggleHand(); }
    else if (e.ctrlKey && e.altKey && k === 'c') { e.preventDefault(); openPanel('chat'); }
    else if (e.ctrlKey && e.altKey && k === 'p') { e.preventDefault(); openPanel('people'); }
    else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && k === 'c') toggleCaptions();
    else if (!typing && e.code === 'Space' && !local.mic && !spaceHeld && local.audio && (isManager() || ctx.settings.mic_allowed)) {
      // Talkie-walkie : maintenir Espace pour parler micro coupé.
      e.preventDefault();
      spaceHeld = true;
      toggleMic(true);
    }
  };
  const onKeyUp = e => { if (e.code === 'Space' && spaceHeld) { spaceHeld = false; toggleMic(false); } };
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);
  const onUnload = () => send('meet.leave', { meeting_id: ctx.meeting.id });
  window.addEventListener('beforeunload', onUnload);

  // ---------------------------------------------------------- seul(e) et inactif : fin automatique
  // Seul participant sans aucune interaction pendant 15 min : compte à rebours de 15 s
  // (« Rester » / « Quitter ») ; sans réponse, la réunion prend fin automatiquement.
  const ALONE_IDLE_MS = 15 * 60 * 1000;
  const ALONE_COUNTDOWN_S = 15;
  let lastInteraction = Date.now(), lastMove = 0, aloneBox = null, aloneTimer = null;
  const touchActivity = () => { lastInteraction = Date.now(); };
  const onMove = () => { if (Date.now() - lastMove > 2000) { lastMove = Date.now(); touchActivity(); } };
  const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  ACTIVITY_EVENTS.forEach(ev => document.addEventListener(ev, touchActivity, { capture: true, passive: true }));
  document.addEventListener('mousemove', onMove, { passive: true });

  function closeAloneBox() {
    clearInterval(aloneTimer);
    aloneTimer = null;
    if (aloneBox) { aloneBox.remove(); aloneBox = null; }
  }

  function showAloneBox() {
    const deadline = Date.now() + ALONE_COUNTDOWN_S * 1000;
    const count = h('span.mt-alone-count', String(ALONE_COUNTDOWN_S));
    const ring = h('div.mt-alone-ring', count);
    aloneBox = h('div.mt-alone-back', h('div.mt-alone', { role: 'alertdialog', 'aria-live': 'assertive' },
      ring,
      h('h3', 'Êtes-vous toujours là ?'),
      h('p', 'Vous êtes seul(e) dans cette réunion depuis un moment. Elle prendra fin automatiquement à la fin du décompte.'),
      h('div.mt-alone-actions',
        h('button.btn.ghost', { type: 'button', onclick: () => { closeAloneBox(); exit('left'); } }, 'Quitter'),
        h('button.btn.primary', { type: 'button', onclick: () => { closeAloneBox(); touchActivity(); } }, 'Rester'))));
    room.appendChild(aloneBox);
    aloneBox.querySelector('.btn.primary').focus();
    beep('message');
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      count.textContent = String(left);
      ring.style.setProperty('--p', (left / ALONE_COUNTDOWN_S).toFixed(3));
      if (left <= 0) { closeAloneBox(); exit('alone_timeout'); }
    };
    tick();
    aloneTimer = setInterval(tick, 250);
  }

  ctx.timers.push(setInterval(() => {
    if (ctx.closed) return;
    if (ctx.peers.size > 1) { if (aloneBox) closeAloneBox(); return; }  // quelqu'un est là : rien à faire
    if (!aloneBox && Date.now() - lastInteraction >= ALONE_IDLE_MS) showAloneBox();
  }, 5000));

  // ---------------------------------------------------------- départ
  function exit(reason, notify = true) {
    if (ctx.closed) return;
    ctx.closed = true;
    ctx.exitReason = reason;
    closeAloneBox();
    ACTIVITY_EVENTS.forEach(ev => document.removeEventListener(ev, touchActivity, { capture: true }));
    document.removeEventListener('mousemove', onMove);
    if (notify) send('meet.leave', { meeting_id: ctx.meeting.id });
    recWanted = false;
    if (rec) { try { rec.abort(); } catch (e) { /* ignoré */ } }
    ctx.offs.forEach(f => f());
    ctx.timers.forEach(t => clearInterval(t));
    ro.disconnect();
    ctx.peers.forEach(p => closePeerMedia(p));
    ctx.meters.forEach((m, id) => stopMeter(id));
    Object.values(ctx.pubs).forEach(pc => pc && pc.close());
    if (ctx.screen) ctx.screen.getTracks().forEach(t => t.stop());
    if (ctx.audioCtx) ctx.audioCtx.close().catch(() => {});
    local.stop();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('beforeunload', onUnload);
    document.body.classList.remove('in-meeting');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.title = 'Kozons';
    onExit && onExit(reason, { notesActive: ctx.notes.active, meeting: ctx.meeting });
  }

  // ---------------------------------------------------------- démarrage
  function boot(peers) {
    // Moi d'abord (pour connaître mon rôle), puis les autres.
    const meData = peers.find(p => p.peer === ctx.me);
    if (meData) upsertPeer(meData);
    peers.filter(p => p.peer !== ctx.me).forEach(upsertPeer);
    meter(ctx.me, local.stream);
    if (ctx.media.mode === 'sfu') publish('cam');
    paintControls();
    layout();
    updateRecognition();
  }
  boot(joined.peers);
  if (ctx.media.mode === 'p2p' && joined.peers.length > 8) notice('Beaucoup de participants en connexion directe : la qualité peut baisser.', { timeout: 8000 });

  return () => exit('navigated');
}
