// Appels audio/vidéo WebRTC (signalisation par WebSocket) + historique des appels.
import { api } from '../api.js';
import { bus, state } from '../store.js';
import { send } from '../ws.js';
import { h, clear, icon, btn, avatar, menu, toast, errorToast, ringtone, duration, listTime, empty, spinner, debounce } from '../ui.js';

let current = null;
let iceServers = null;
let iceFetchedAt = 0;

// Les identifiants TURN sont temporaires (24 h) : on les redemande toutes les heures.
async function getIce() {
  if (!iceServers || Date.now() - iceFetchedAt > 3600 * 1000) {
    try {
      ({ ice_servers: iceServers } = await api.get('calls/ice'));
      iceFetchedAt = Date.now();
    } catch (e) { iceServers = iceServers || [{ urls: 'stun:stun.l.google.com:19302' }]; }
  }
  return iceServers;
}

async function getMedia(video) {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
  });
}

// ------------------------------------------------------------------ API publique

export async function startCall(peer, video) {
  if (current) return toast('Un appel est déjà en cours.');
  if (!navigator.mediaDevices) return toast('Les appels nécessitent HTTPS ou localhost.', { type: 'error' });
  let stream;
  try { stream = await getMedia(video); }
  catch (e) {
    if (!video) return toast('Accès au micro refusé.', { type: 'error' });
    try { stream = await getMedia(false); video = false; toast('Caméra indisponible : appel audio.'); }
    catch (e2) { return toast('Accès au micro refusé.', { type: 'error' }); }
  }
  current = { role: 'caller', peer, video, localStream: stream, call: null, accepted: true, candidates: [] };
  initAudio();
  showCallUI('Appel en cours…');
  send('call.start', { to: peer.id, video });
}

export function installCalls() {
  bus.on('call.created', ({ call, callee_online }) => {
    if (!current || current.call) return;
    current.call = call;
    setStatus(callee_online ? 'Sonnerie…' : 'Appel en cours…');
    current.stopRing = ringback();
    current.timeout = setTimeout(() => { if (current && current.call && !current.connectedAt) { send('call.end', { call_id: current.call.id }); } }, 45000);
  });

  bus.on('call.incoming', async ({ call }) => {
    if (current) {
      send('call.decline', { call_id: call.id });
      return;
    }
    current = { role: 'callee', peer: call.caller, video: call.video, call, accepted: false, candidates: [] };
    current.stopRing = ringtone();
    showIncomingUI();
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      try { new Notification(`${call.caller.name}`, { body: call.video ? 'Appel vidéo entrant' : 'Appel audio entrant', tag: 'call-' + call.id }); } catch (e) { /* ignoré */ }
    }
  });

  bus.on('call.handled', ({ call_id }) => {
    // Décroché depuis un autre appareil.
    if (current && current.call && current.call.id === call_id && !current.accepted) cleanup();
  });

  bus.on('call.accepted', async ({ call }) => {
    if (!current || !current.call || current.call.id !== call.id || current.role !== 'caller') return;
    stopRinging();
    setStatus('Connexion…');
    await createPeer();
    const offer = await current.pc.createOffer();
    await current.pc.setLocalDescription(offer);
    send('call.signal', { call_id: call.id, data: { sdp: current.pc.localDescription } });
  });

  bus.on('call.signal', async ({ call_id, data }) => {
    if (!current || !current.call || current.call.id !== call_id || !current.accepted || !current.pc) return;
    const pc = current.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of current.candidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send('call.signal', { call_id, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else current.candidates.push(data.candidate);
      }
    } catch (e) { console.error('[call] signal', e); }
  });

  bus.on('call.ended', ({ call, reason }) => {
    if (!current) return;
    if (current.call && current.call.id !== call.id) return;
    if (!current.call && current.role === 'caller' && reason === 'busy') { toast(`${current.peer.name} est déjà en ligne.`); return cleanup(); }
    const labels = { declined: 'Appel refusé', missed: current.role === 'caller' ? 'Pas de réponse' : 'Appel manqué', busy: 'Occupé', ended: 'Appel terminé' };
    toast(labels[reason] || 'Appel terminé');
    cleanup();
    bus.emit('calls:changed');
  });

  bus.on('error', ({ message, for: forType }) => {
    if (forType && forType.startsWith('call.')) { toast(message, { type: 'error' }); if (current && !current.call) cleanup(); }
  });

  window.addEventListener('beforeunload', () => { if (current && current.call) send('call.end', { call_id: current.call.id }); });
}

// ------------------------------------------------------------------ WebRTC

async function createPeer() {
  const pc = new RTCPeerConnection({ iceServers: await getIce() });
  current.pc = pc;
  current.remoteStream = new MediaStream();
  current.localStream.getTracks().forEach(t => pc.addTrack(t, current.localStream));
  pc.ontrack = e => {
    e.streams[0].getTracks().forEach(t => { if (!current.remoteStream.getTracks().includes(t)) current.remoteStream.addTrack(t); });
    attachStreams();
  };
  pc.onicecandidate = e => { if (e.candidate && current && current.call) send('call.signal', { call_id: current.call.id, data: { candidate: e.candidate } }); };
  pc.onconnectionstatechange = async () => {
    if (!current) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      if (!current.connectedAt) { current.connectedAt = Date.now(); startTimer(); }
      setStatus(null);
    } else if (s === 'disconnected') {
      setStatus('Reconnexion…');
    } else if (s === 'failed') {
      setStatus('Connexion instable…');
      // Redémarrage ICE : c'est l'appelant qui renégocie.
      if (current.role === 'caller') {
        try {
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          send('call.signal', { call_id: current.call.id, data: { sdp: pc.localDescription } });
        } catch (e) { /* ignoré */ }
      }
    }
  };
  return pc;
}

async function accept() {
  if (!current) return;
  stopRinging();
  initAudio();
  let stream;
  try { stream = await getMedia(current.video); }
  catch (e) {
    try { stream = await getMedia(false); current.video = false; }
    catch (e2) { toast('Accès au micro refusé.', { type: 'error' }); return decline(); }
  }
  current.localStream = stream;
  current.accepted = true;
  showCallUI('Connexion…');
  await createPeer();
  send('call.accept', { call_id: current.call.id });
}

function decline() {
  if (!current) return;
  send('call.decline', { call_id: current.call.id });
  cleanup();
}

function hangup() {
  if (!current) return;
  if (current.call) send('call.end', { call_id: current.call.id });
  cleanup();
}

function stopRinging() {
  if (current && current.stopRing) { current.stopRing(); current.stopRing = null; }
}

function cleanup() {
  if (!current) return;
  stopRinging();
  clearTimeout(current.timeout);
  clearInterval(current.timer);
  if (current.pc) try { current.pc.close(); } catch (e) { /* ignoré */ }
  for (const s of [current.localStream, current.screenStream]) if (s) s.getTracks().forEach(t => t.stop());
  if (current.ui) current.ui.remove();
  if (current.audio) current.audio.ctx.close().catch(() => {});
  current = null;
}

// ------------------------------------------------------------------ son : amplification et haut-parleur

// Gain appliqué au son de l'interlocuteur. Le compresseur évite la saturation quand on amplifie.
const VOLUME = { normal: 1.8, speaker: 3.2 };

function initAudio() {
  if (!current || current.audio) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22;
    comp.knee.value = 12;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    gain.connect(comp).connect(ctx.destination);
    ctx.resume().catch(() => {});
    current.audio = { ctx, gain, source: null };
    current.speaker = !!current.video; // appel vidéo : haut-parleur par défaut, comme WhatsApp
    applyVolume();
  } catch (e) {
    current.audio = null; // repli : lecture directe par les éléments <audio>/<video>
  }
}

function applyVolume() {
  if (!current || !current.audio) return;
  const { ctx, gain } = current.audio;
  gain.gain.setTargetAtTime(current.speaker ? VOLUME.speaker : VOLUME.normal, ctx.currentTime, 0.05);
  if (current.els && current.els.speakerBtn) {
    current.els.speakerBtn.classList.toggle('on', current.speaker);
    current.els.speakerBtn.setAttribute('aria-pressed', String(current.speaker));
  }
}

function routeRemoteAudio() {
  const a = current.audio;
  if (!a || a.source || !current.remoteStream || !current.remoteStream.getAudioTracks().length) return;
  try {
    a.source = a.ctx.createMediaStreamSource(current.remoteStream);
    a.source.connect(a.gain);
    a.ctx.resume().catch(() => {});
  } catch (e) { current.audio = null; }
}

async function speakerMenu(anchor) {
  const ctx = current && current.audio && current.audio.ctx;
  let outputs = [];
  if (ctx && typeof ctx.setSinkId === 'function' && navigator.mediaDevices.enumerateDevices) {
    try { outputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default'); }
    catch (e) { outputs = []; }
  }
  const toggle = () => { current.speaker = !current.speaker; applyVolume(); toast(current.speaker ? 'Haut-parleur activé' : 'Haut-parleur désactivé'); };
  // Une seule sortie audio (cas des téléphones) : simple bascule haut-parleur.
  if (outputs.length < 2) return toggle();
  menu(anchor, [
    { label: (current.speaker ? '✓ ' : '') + 'Haut-parleur (volume fort)', icon: 'volume', action: () => { if (!current.speaker) toggle(); } },
    { label: (!current.speaker ? '✓ ' : '') + 'Volume normal', icon: 'volume', action: () => { if (current.speaker) toggle(); } },
    '-',
    ...outputs.map(d => ({
      label: (current.audio.sinkId === d.deviceId ? '✓ ' : '') + (d.label || 'Sortie audio'),
      icon: 'volume',
      action: async () => {
        try { await ctx.setSinkId(d.deviceId); current.audio.sinkId = d.deviceId; toast('Sortie : ' + (d.label || 'audio')); }
        catch (e) { toast('Impossible de changer de sortie audio.', { type: 'error' }); }
      },
    })),
  ]);
}

// ------------------------------------------------------------------ vidéos : permutation et vignette déplaçable

/** Place les deux vidéos : l'une en plein écran, l'autre en vignette dans un coin. */
function layoutVideos() {
  if (!current || !current.els) return;
  const { remoteVideo, localVideo } = current.els;
  const remoteOn = !!(current.remoteStream && current.remoteStream.getVideoTracks().length);
  const localTrack = current.localStream && current.localStream.getVideoTracks()[0];
  const localOn = !!(localTrack && localTrack.enabled) || !!current.screenStream;
  const swapped = !!current.swapped && remoteOn && localOn;
  const [full, pip] = swapped ? [localVideo, remoteVideo] : [remoteVideo, localVideo];
  const corner = current.pipCorner || 'br';
  const corners = ['pip-br', 'pip-bl', 'pip-tr', 'pip-tl'];
  full.classList.remove('pip', ...corners);
  full.classList.add('full');
  pip.classList.remove('full', ...corners);
  pip.classList.add('pip', `pip-${corner}`);
  pip.title = remoteOn && localOn ? 'Toucher pour permuter · glisser pour déplacer' : '';
  current.ui.classList.toggle('swapped', swapped);
}

/** Vignette : un toucher permute les écrans, un glisser la déplace vers le coin le plus proche. */
function enablePip(video) {
  let start = null;
  video.addEventListener('pointerdown', e => {
    if (!video.classList.contains('pip')) return;
    start = { x: e.clientX, y: e.clientY, moved: false };
    video.setPointerCapture(e.pointerId);
  });
  video.addEventListener('pointermove', e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) start.moved = true;
    if (start.moved) video.style.translate = `${dx}px ${dy}px`;
  });
  video.addEventListener('pointerup', e => {
    if (!start || !current) return;
    const moved = start.moved;
    start = null;
    if (moved) {
      // Position au moment du lâcher (avant de retirer le décalage du glisser) -> coin le plus proche.
      const r = video.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      current.pipCorner = (cy < window.innerHeight / 2 ? 't' : 'b') + (cx < window.innerWidth / 2 ? 'l' : 'r');
      video.style.translate = '';
    } else {
      video.style.translate = '';
      current.swapped = !current.swapped;
    }
    layoutVideos();
  });
}

function ringback() {
  // Tonalité de retour d'appel discrète côté appelant.
  let stop = false;
  const tick = () => {
    if (stop) return;
    try {
      const c = new (window.AudioContext || window.webkitAudioContext)();
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 440; g.gain.value = 0.05;
      o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 1.2);
      setTimeout(() => c.close(), 1500);
    } catch (e) { /* ignoré */ }
  };
  tick();
  const t = setInterval(tick, 4000);
  return () => { stop = true; clearInterval(t); };
}

// ------------------------------------------------------------------ interface d'appel

function showIncomingUI() {
  const { peer, video } = current;
  current.ui = h('div.call-screen.incoming',
    h('div.call-center',
      avatar(peer.avatar, peer.name, 120),
      h('h2', peer.name),
      h('p', video ? 'Appel vidéo entrant…' : 'Appel audio entrant…')),
    h('div.call-controls',
      h('button.call-btn.hangup', { type: 'button', onclick: decline, 'aria-label': 'Refuser' }, icon('phoneOff', 28)),
      h('button.call-btn.accept', { type: 'button', onclick: accept, 'aria-label': 'Accepter' }, icon(video ? 'video' : 'phone', 28))));
  document.getElementById('overlay-root').appendChild(current.ui);
}

function showCallUI(status) {
  if (current.ui) current.ui.remove();
  const { peer } = current;
  // Le son passe par l'amplificateur Web Audio : les éléments restent attachés au flux mais muets
  // (Chrome ne fait circuler l'audio WebRTC vers Web Audio que si le flux est aussi lu par un élément).
  const routed = !!current.audio;
  const remoteVideo = h('video.remote-video', { autoplay: true, playsinline: true, muted: routed });
  const remoteAudio = h('audio', { autoplay: true, muted: routed });
  const localVideo = h('video.local-video', { autoplay: true, playsinline: true, muted: true });
  const statusEl = h('p.call-status', status || '');
  const center = h('div.call-center', avatar(peer.avatar, peer.name, 120), h('h2', peer.name), statusEl);

  const micBtn = h('button.call-btn', { type: 'button', 'aria-label': 'Micro' }, icon('mic', 24));
  micBtn.onclick = () => {
    const t = current.localStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    micBtn.classList.toggle('off', !t.enabled);
    micBtn.replaceChildren(icon(t.enabled ? 'mic' : 'micOff', 24));
  };
  const camBtn = h('button.call-btn', { type: 'button', 'aria-label': 'Caméra' }, icon(current.video ? 'video' : 'camOff', 24));
  camBtn.onclick = async () => {
    let t = current.localStream.getVideoTracks()[0];
    if (!t) {
      // Passage de l'audio à la vidéo en cours d'appel.
      try {
        const vs = await navigator.mediaDevices.getUserMedia({ video: true });
        t = vs.getVideoTracks()[0];
        current.localStream.addTrack(t);
        if (current.pc) {
          current.pc.addTrack(t, current.localStream);
          const offer = await current.pc.createOffer();
          await current.pc.setLocalDescription(offer);
          send('call.signal', { call_id: current.call.id, data: { sdp: current.pc.localDescription } });
        }
        current.video = true;
        attachStreams();
      } catch (e) { return toast('Caméra indisponible.', { type: 'error' }); }
    } else {
      t.enabled = !t.enabled;
    }
    camBtn.classList.toggle('off', !t.enabled);
    camBtn.replaceChildren(icon(t.enabled ? 'video' : 'camOff', 24));
    localVideo.classList.toggle('hidden', !t.enabled);
    layoutVideos();
  };
  const flipBtn = h('button.call-btn', { type: 'button', 'aria-label': 'Changer de caméra', onclick: flipCamera }, icon('flip', 24));
  const screenBtn = navigator.mediaDevices.getDisplayMedia ? h('button.call-btn', { type: 'button', 'aria-label': "Partager l'écran", onclick: toggleScreen }, icon('screen', 24)) : null;
  const speakerBtn = h('button.call-btn', { type: 'button', 'aria-label': 'Haut-parleur', title: 'Haut-parleur', onclick: e => speakerMenu(e.currentTarget) }, icon('volume', 24));
  enablePip(remoteVideo);
  enablePip(localVideo);

  current.ui = h('div.call-screen' + (current.video ? '.video' : ''),
    remoteVideo, remoteAudio, center, localVideo,
    h('div.call-top', h('span', icon('lock', 14), ' Appel privé Kozons')),
    h('div.call-controls', speakerBtn, micBtn, camBtn, flipBtn, screenBtn,
      h('button.call-btn.hangup', { type: 'button', onclick: hangup, 'aria-label': 'Raccrocher' }, icon('phoneOff', 28))));
  current.els = { remoteVideo, remoteAudio, localVideo, statusEl, center, speakerBtn };
  document.getElementById('overlay-root').appendChild(current.ui);
  applyVolume();
  attachStreams();
}

function attachStreams() {
  if (!current || !current.els) return;
  const { remoteVideo, remoteAudio, localVideo } = current.els;
  if (current.localStream && localVideo.srcObject !== current.localStream) localVideo.srcObject = current.localStream;
  localVideo.classList.toggle('hidden', !current.localStream || !current.localStream.getVideoTracks().length);
  if (current.remoteStream) {
    const hasVideo = current.remoteStream.getVideoTracks().length > 0;
    if (hasVideo && remoteVideo.srcObject !== current.remoteStream) remoteVideo.srcObject = current.remoteStream;
    current.ui.classList.toggle('has-remote-video', hasVideo);
    if (current.audio) {
      if (remoteAudio.srcObject !== current.remoteStream) remoteAudio.srcObject = current.remoteStream;
      routeRemoteAudio();
    } else {
      // Repli sans Web Audio : un seul élément lit le son, au volume maximal.
      if (!hasVideo && remoteAudio.srcObject !== current.remoteStream) remoteAudio.srcObject = current.remoteStream;
      if (hasVideo) remoteAudio.srcObject = null;
      remoteVideo.volume = remoteAudio.volume = 1;
    }
  }
  layoutVideos();
}

function setStatus(text) {
  if (current && current.els && (text || !current.connectedAt)) current.els.statusEl.textContent = text || '';
}

function startTimer() {
  const tick = () => { if (current && current.els) current.els.statusEl.textContent = duration((Date.now() - current.connectedAt) / 1000); };
  tick();
  current.timer = setInterval(tick, 1000);
}

async function replaceVideoTrack(track) {
  if (!current.pc) return;
  const sender = current.pc.getSenders().find(s => s.track && s.track.kind === 'video');
  if (sender) await sender.replaceTrack(track);
}

async function flipCamera() {
  const t = current.localStream.getVideoTracks()[0];
  if (!t) return;
  const facing = (t.getSettings().facingMode === 'environment') ? 'user' : 'environment';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
    const nt = s.getVideoTracks()[0];
    await replaceVideoTrack(nt);
    current.localStream.removeTrack(t); t.stop();
    current.localStream.addTrack(nt);
    current.els.localVideo.srcObject = current.localStream;
  } catch (e) { toast('Aucune autre caméra disponible.'); }
}

async function toggleScreen() {
  if (current.screenStream) {
    const cam = current.localStream.getVideoTracks()[0];
    await replaceVideoTrack(cam || null);
    current.screenStream.getTracks().forEach(t => t.stop());
    current.screenStream = null;
    current.els.localVideo.srcObject = current.localStream;
    layoutVideos();
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = s.getVideoTracks()[0];
    if (!current.pc.getSenders().some(x => x.track && x.track.kind === 'video')) {
      return toast("Activez d'abord la caméra pour partager l'écran.");
    }
    current.screenStream = s;
    await replaceVideoTrack(track);
    current.els.localVideo.srcObject = s;
    layoutVideos();
    track.onended = () => current && current.screenStream && toggleScreen();
  } catch (e) { /* annulé */ }
}

// ------------------------------------------------------------------ page Historique

export function render(stage) {
  const list = h('div.call-list', spinner());
  const search = h('input.search-input', { type: 'search', placeholder: 'Rechercher un contact à appeler' });
  const results = h('div');
  const page = h('div.page.narrow',
    h('header.page-head', h('h2', 'Appels')),
    h('div.search-box', icon('search', 18), search),
    results,
    h('div.list-title', 'Récents'),
    list);
  stage.appendChild(page);

  search.addEventListener('input', debounce(async () => {
    const q = search.value.trim();
    if (!q) return clear(results);
    try {
      const { results: users } = await api.get('users/search', { q });
      clear(results, users.map(u => callRow(u, null)));
    } catch (e) { errorToast(e); }
  }, 250));

  const load = async () => {
    try {
      const { results: calls } = await api.get('calls');
      if (!calls.length) return clear(list, empty('phone', 'Aucun appel', 'Vos appels audio et vidéo apparaîtront ici.'));
      clear(list, calls.map(c => {
        const outgoing = c.caller.id === state.me.id;
        const other = outgoing ? c.callee : c.caller;
        return callRow(other, c);
      }));
    } catch (e) { clear(list, h('p.muted.pad', e.message)); }
  };
  load();
  const off = bus.on('calls:changed', load);
  return off;
}

function callRow(user, call) {
  let meta = null;
  if (call) {
    const outgoing = call.caller.id === state.me.id;
    const missed = !outgoing && (call.status === 'missed' || call.status === 'declined');
    const len = call.answered_at && call.ended_at ? duration((new Date(call.ended_at) - new Date(call.answered_at)) / 1000) : null;
    meta = h('div.call-meta' + (missed ? '.missed' : ''),
      icon(outgoing ? 'arrowOut' : 'arrowIn', 16), icon(call.video ? 'video' : 'phone', 14),
      ` ${listTime(call.started_at)}${len ? ' · ' + len : ''}`);
  }
  return h('div.call-row',
    h('button.row.grow', { type: 'button', onclick: () => window.kozons.go('/u/' + user.username) },
      avatar(user.avatar, user.name, 46),
      h('div.grow', h('div.strong' + (call && call.caller.id !== state.me.id && call.status === 'missed' ? '.danger-text' : ''), user.name), meta || h('div.muted', '@' + user.username))),
    btn('phone', 'Appel audio', () => startCall(user, false)),
    btn('video', 'Appel vidéo', () => startCall(user, true)));
}
