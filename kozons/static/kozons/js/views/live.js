// LIVE façon TikTok : liste des lives, préparation, écran animateur et spectateur.
// Vidéo : serveur média (WHIP/WHEP) en production, sinon pair-à-pair via le WebSocket.
import { api } from '../api.js';
import { bus, state } from '../store.js';
import { send } from '../ws.js';
import { h, clear, icon, btn, avatar, toast, errorToast, confirmDialog, modal, compact, duration, spinner, empty, menu, emojiPopover } from '../ui.js';
import { followButton } from './feed.js';

let prepStream = null;   // caméra ouverte à l'écran de préparation, reprise par l'écran animateur
let facing = 'user';

export function render(stage, params) {
  if (params.new) return renderPrep(stage);
  if (params.id) return renderLive(stage, params.id);
  return renderList(stage);
}

// ------------------------------------------------------------------ média

async function iceServers() {
  try { return (await api.get('calls/ice')).ice_servers; } catch (e) { return [{ urls: 'stun:stun.l.google.com:19302' }]; }
}

function getCamera() {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 }, frameRate: { ideal: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

function waitIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 2500); // on n'attend pas indéfiniment les derniers candidats
  });
}

/** WHIP / WHEP : une offre SDP complète en POST, la réponse SDP en retour (serveur média). */
async function negotiate(pc, url) {
  await pc.setLocalDescription(await pc.createOffer());
  await waitIce(pc);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
  if (!res.ok) throw new Error(res.status === 404 ? 'not_publishing' : `media_${res.status}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
}

async function publishWhip(url, stream) {
  const pc = new RTCPeerConnection({ iceServers: await iceServers() });
  stream.getTracks().forEach(t => pc.addTransceiver(t, { direction: 'sendonly', streams: [stream] }));
  await negotiate(pc, url);
  return pc;
}

async function playWhep(url, onStream) {
  const pc = new RTCPeerConnection({ iceServers: await iceServers() });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const remote = new MediaStream();
  pc.ontrack = e => { remote.addTrack(e.track); onStream(remote); };
  await negotiate(pc, url);
  return pc;
}

// ------------------------------------------------------------------ liste des lives

function renderList(stage) {
  const grid = h('div.live-grid', spinner());
  stage.appendChild(h('div.page.live-list',
    h('header.page-head',
      h('h2', h('span.live-dot'), ' LIVE'),
      h('button.btn.primary', { onclick: () => window.kozons.go('/live/new') }, icon('live', 18), ' Lancer un LIVE')),
    grid));
  const load = async () => {
    try {
      const { results } = await api.get('live');
      clear(grid, results.length ? results.map(liveCard)
        : empty('live', 'Aucun LIVE en ce moment', 'Lancez le vôtre : vos abonnés seront prévenus.',
          h('button.btn.primary', { onclick: () => window.kozons.go('/live/new') }, 'Passer en LIVE')));
    } catch (e) { clear(grid, h('p.muted', e.message)); }
  };
  load();
  const offs = [bus.on('live.started', load)];
  const timer = setInterval(load, 20000);
  return () => { offs.forEach(f => f()); clearInterval(timer); };
}

export function liveCard(l) {
  return h('button.live-card', { type: 'button', onclick: () => window.kozons.go('/live/' + l.id) },
    h('div.live-card-art', avatar(l.host.avatar, l.host.name, 96)),
    h('div.live-card-top', h('span.live-badge', 'LIVE'), h('span.live-viewers', icon('eye', 14), ' ', compact(l.viewers))),
    h('div.live-card-info', h('strong', l.host.name), l.title ? h('span', l.title) : null));
}

// ------------------------------------------------------------------ préparation (animateur)

function renderPrep(stage) {
  let handedOver = false;
  let audience = 'public';
  const video = h('video.live-video.mirror', { autoplay: true, playsinline: true, muted: true });
  const title = h('input.live-title-input', { placeholder: 'Ajouter un titre pour attirer les spectateurs…', maxlength: 80 });
  const chips = h('div.live-chips', [['public', 'Tout le monde'], ['followers', 'Mes abonnés']].map(([v, l]) =>
    h('button' + (v === audience ? '.active' : ''), {
      type: 'button',
      onclick: e => { audience = v; chips.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); },
    }, l)));
  const go = h('button.live-go', { type: 'button' }, 'Passer en LIVE');
  const status = h('div.live-status.hidden');

  const openCamera = async () => {
    try {
      if (prepStream) prepStream.getTracks().forEach(t => t.stop());
      prepStream = await getCamera();
      video.srcObject = prepStream;
      video.classList.toggle('mirror', facing === 'user');
      status.classList.add('hidden');
    } catch (e) {
      clear(status, icon('camOff', 32), h('p', "Autorisez l'accès à la caméra et au micro pour passer en LIVE."));
      status.classList.remove('hidden');
    }
  };
  openCamera();

  go.onclick = async () => {
    if (!prepStream) return toast('Caméra indisponible.', { type: 'error' });
    go.disabled = true;
    go.textContent = 'Démarrage…';
    try {
      const live = await api.post('live', { title: title.value.trim(), audience });
      handedOver = true;
      window.kozons.go('/live/' + live.id, { replace: true });
    } catch (e) { errorToast(e); go.disabled = false; go.textContent = 'Passer en LIVE'; }
  };

  stage.appendChild(h('div.live-page',
    h('div.live-stage',
      video, h('div.live-shade'), status,
      h('header.live-top', h('div'), h('div.row',
        btn('flip', 'Changer de caméra', () => { facing = facing === 'user' ? 'environment' : 'user'; openCamera(); }, 'live-icon'),
        btn('close', 'Fermer', () => history.length > 1 ? history.back() : window.kozons.go('/live'), 'live-icon'))),
      h('div.live-prep',
        h('div.row.gap', avatar(state.me.avatar, state.me.name, 44), title),
        h('div.live-label', 'Qui peut regarder ?'), chips,
        go,
        h('p.live-hint', 'Vos abonnés recevront une notification dès le début du LIVE.')))));
  return () => {
    if (!handedOver && prepStream) { prepStream.getTracks().forEach(t => t.stop()); prepStream = null; }
  };
}

// ------------------------------------------------------------------ écran du live

function renderLive(stage, id) {
  const page = h('div.live-page', h('div.live-stage', h('div.center.pad', spinner())));
  stage.appendChild(page);
  const ctx = { id, offs: [], timers: [], pcs: new Map(), pc: null, stream: null, closed: false };
  (async () => {
    let live;
    try { live = await api.get(`live/${id}`); }
    catch (e) { clear(page, h('div.live-stage', endedView(null, e.message))); return; }
    if (ctx.closed) return;
    if (live.status !== 'live') { clear(page, h('div.live-stage', endedView(live))); return; }
    if (live.banned) { clear(page, h('div.live-stage', endedView(live, "L'animateur vous a exclu de ce LIVE."))); return; }
    ctx.live = live;
    buildLiveUI(page, ctx);
  })();
  return () => teardown(ctx, true);
}

function teardown(ctx, leaving) {
  if (ctx.closed) return;
  ctx.closed = true;
  ctx.offs.forEach(f => f());
  ctx.timers.forEach(t => (t && typeof t.clear === 'function' ? t.clear() : clearInterval(t)));
  if (ctx.pc) ctx.pc.close();
  ctx.pcs.forEach(pc => pc.close());
  if (ctx.live && leaving && !ctx.live.is_host) send('live.leave', { live_id: ctx.live.id });
  if (ctx.stream) ctx.stream.getTracks().forEach(t => t.stop());
  if (ctx.live && ctx.live.is_host && prepStream === ctx.stream) prepStream = null;
}

function buildLiveUI(page, ctx) {
  const live = ctx.live;
  const isHost = live.is_host;
  const video = h('video.live-video', { autoplay: true, playsinline: true, muted: isHost });
  const status = h('div.live-status.hidden');
  const comments = h('div.live-comments');
  const pinned = h('div.live-pinned.hidden');
  const banners = h('div.live-banners');
  const hearts = h('div.live-hearts');
  const bigGift = h('div.live-biggift');
  const viewersEl = h('span', compact(live.viewers));
  const viewersAvatars = h('div.live-avatars');
  // « ♥ 7.9K » sous le nom de l'animateur, comme sur TikTok.
  const likesCount = h('span', likesLabel(live.likes));
  const likesEl = h('small.live-likes', { title: "J'aime" }, icon('heart', 11), likesCount);
  const timerEl = h('span.live-timer');
  let likesTotal = live.likes;

  const setStatus = (text, sub) => {
    if (!text) return status.classList.add('hidden');
    clear(status, spinner(28), h('p', text), sub ? h('small', sub) : null);
    status.classList.remove('hidden');
  };

  // ---- en-tête (au-dessus de la vidéo sur mobile, en haut du panneau sur ordinateur)
  const hostPill = h('div.live-host',
    h('button.row', { type: 'button', onclick: () => !isHost && window.kozons.go('/u/' + live.host.username) },
      avatar(live.host.avatar, live.host.name, 36),
      h('div.live-host-text', h('strong', live.host.name), likesEl)),
    !isHost ? followButton(live.host.id, null) : null);
  const viewersPill = h('button.live-viewers-pill', { type: 'button', onclick: () => isHost && showViewers(ctx) }, viewersAvatars, h('span.live-count', icon('eye', 14), ' ', viewersEl));
  const closeBtn = btn('close', isHost ? 'Terminer le LIVE' : 'Quitter', () => leaveOrEnd(), 'live-icon');
  const leaveOrEnd = async () => {
    if (!isHost) return history.length > 1 ? history.back() : window.kozons.go('/live');
    if (await confirmDialog('Terminer le LIVE ? Vos spectateurs verront la fin du direct.', { ok: 'Terminer', danger: true })) send('live.end', { live_id: live.id });
  };

  // ---- saisie : commentaire, éventuellement en réponse à un autre
  let replyTo = null;
  const replyBar = h('div.live-reply.hidden');
  const setReply = c => {
    replyTo = c;
    if (!c) return replyBar.classList.add('hidden');
    clear(replyBar, icon('reply', 14), h('span', 'Réponse à ', h('strong', c.user.name), ' : ', c.text),
      h('button', { type: 'button', 'aria-label': 'Annuler la réponse', onclick: () => setReply(null) }, icon('close', 14)));
    replyBar.classList.remove('hidden');
    input.focus();
  };
  const input = h('input.live-input', { placeholder: 'Ajouter un commentaire…', maxlength: 150, enterkeyhint: 'send' });
  const sendComment = () => {
    if (!input.value.trim()) return;
    send('live.comment', { live_id: live.id, text: input.value.trim(), reply_to: replyTo ? replyTo.id : undefined });
    input.value = '';
    setReply(null);
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendComment();
    if (e.key === 'Escape') setReply(null);
  });
  const emojiBtn = h('button.live-input-btn.wide-only', {
    type: 'button', 'aria-label': 'Emoji',
    onclick: e => emojiPopover(e.currentTarget, em => { input.value += em; input.focus(); }),
  }, icon('smile', 20));
  const sendBtn = h('button.live-send.wide-only', { type: 'button', 'aria-label': 'Envoyer', onclick: sendComment }, icon('send', 18));

  const likeBtn = h('button.live-action.like', { type: 'button', 'aria-label': "J'aime" }, icon('heart', 26));
  let pendingLikes = 0;
  const like = (x, y) => { pendingLikes++; heart(hearts, x, y, true); };
  likeBtn.onclick = () => like();
  ctx.timers.push(setInterval(() => {
    if (pendingLikes) { send('live.like', { live_id: live.id, count: Math.min(pendingLikes, 30) }); pendingLikes = 0; }
  }, 500));

  // Actions de la barre de saisie (mobile) ; sur ordinateur elles passent dans le panneau vidéo.
  const actions = isHost
    ? [btn('flip', 'Changer de caméra', () => flipCamera(ctx, video), 'live-action compact-only'),
      micButton(ctx, 'compact-only'),
      btn('share', 'Partager', () => shareLive(live), 'live-action compact-only')]
    : [h('button.live-action.compact-only', { type: 'button', 'aria-label': 'Cadeaux', onclick: () => giftSheet(ctx, page) }, icon('gift', 24)),
      btn('share', 'Partager', () => shareLive(live), 'live-action compact-only'),
      likeBtn];

  // ---- panneau vidéo : barre du bas (cadeaux pour les spectateurs, commandes pour l'animateur)
  const giftBar = isHost
    ? h('div.live-panelbar',
      h('button.live-tool', { type: 'button', onclick: () => flipCamera(ctx, video) }, icon('flip', 22), h('span', 'Caméra')),
      micButton(ctx, 'live-tool', true),
      h('button.live-tool', { type: 'button', onclick: () => shareLive(live) }, icon('share', 22), h('span', 'Partager')),
      h('button.live-tool', { type: 'button', onclick: () => showViewers(ctx) }, icon('users', 22), h('span', 'Spectateurs')),
      h('div.grow'),
      h('button.live-tool.end', { type: 'button', onclick: leaveOrEnd }, icon('close', 22), h('span', 'Terminer')))
    : h('div.live-panelbar',
      h('div.live-giftrow', live.gifts_catalog.map(g => h('button.live-gift', {
        type: 'button', title: `${g.name} (gratuit)`,
        onclick: e => {
          send('live.gift', { live_id: live.id, gift: g.code });
          const b = e.currentTarget; b.classList.remove('sent'); void b.offsetWidth; b.classList.add('sent');
        },
      }, h('span.live-gift-emoji', g.emoji), h('span.live-gift-name', g.name), h('span.live-gift-value', `💎${g.value}`)))),
      h('button.live-tool', { type: 'button', onclick: () => shareLive(live) }, icon('share', 22), h('span', 'Partager')));

  // ---- colonne de droite : spectateurs puis commentaires
  const viewersTitle = h('span');
  const viewersList = h('div.live-viewers-list');
  const viewersPanel = h('section.live-viewers-panel.wide-only', h('h3', viewersTitle), viewersList);
  const renderViewersTitle = n => { viewersTitle.textContent = `Spectateurs · ${compact(n)}`; };
  renderViewersTitle(live.viewers);
  let viewersLoadedAt = 0, viewersTimer = null;
  const loadViewers = () => {
    clearTimeout(viewersTimer);
    const wait = Math.max(0, 3000 - (Date.now() - viewersLoadedAt)); // au plus une requête toutes les 3 s
    viewersTimer = setTimeout(async () => {
      viewersLoadedAt = Date.now();
      try {
        const { results } = await api.get(`live/${live.id}/viewers`);
        clear(viewersList, results.length ? results.map(u => h('div.live-viewer', avatar(u.avatar, u.name, 28), h('span', u.name),
          isHost ? h('button.live-kick', { type: 'button', onclick: () => banUser(ctx, u) }, 'Exclure') : null))
          : h('p.live-muted', 'Aucun spectateur pour le moment.'));
      } catch (e) { /* ignoré */ }
    }, wait);
  };
  ctx.timers.push({ clear: () => clearTimeout(viewersTimer) });
  loadViewers();

  const panelTop = h('header.live-top', h('div.row.live-top-left', hostPill,
    btn('share', 'Partager', () => shareLive(live), 'live-icon wide-only')), h('div.row', viewersPill, closeBtn));
  const stageEl = h('div.live-stage', video, h('div.live-shade'), hearts, bigGift, status, banners);
  const main = h('div.live-main',
    h('div.live-video-area', stageEl),
    panelTop,
    isHost ? h('div.live-onair', h('span.live-badge', 'LIVE'), timerEl) : null,
    h('div.wide-only.live-panelbar-wrap', giftBar));
  const side = h('aside.live-side',
    viewersPanel,
    h('div.live-bottom', pinned, comments, replyBar,
      h('div.live-bar', h('div.live-inputwrap', input, emojiBtn, sendBtn), ...actions)));
  page.classList.add('room');
  clear(page, main, side);

  // Double-tap sur la vidéo : cœurs à l'endroit touché (comme TikTok).
  let lastTap = 0;
  stageEl.addEventListener('pointerup', e => {
    if (isHost || e.target.closest('button, input, .live-sheet')) return;
    const now = Date.now();
    if (now - lastTap < 300) { const r = stageEl.getBoundingClientRect(); like(e.clientX - r.left, e.clientY - r.top); }
    lastTap = now;
  });

  // ---- commentaires & événements
  const addRow = row => {
    const atBottom = comments.scrollHeight - comments.scrollTop - comments.clientHeight < 40;
    comments.appendChild(row);
    while (comments.children.length > 120) comments.firstChild.remove();
    if (atBottom) comments.scrollTop = comments.scrollHeight;
  };
  const commentRow = c => {
    const toMe = c.reply_to && c.reply_to.user_id === state.me.id;
    const row = h('div.live-comment' + (toMe ? '.to-me' : ''),
      avatar(c.user.avatar, c.user.name, 28),
      h('div.live-comment-body',
        h('strong', c.user.name),
        c.reply_to ? h('span.live-comment-quote', icon('reply', 12), ` ${c.reply_to.user_name} : ${c.reply_to.text}`) : null,
        h('span.live-comment-text', c.text)));
    if (c.user.id !== state.me.id) {
      row.classList.add('clickable');
      row.title = 'Répondre';
      row.onclick = e => {
        // Spectateurs : un clic = répondre. Animateur : répondre, épingler ou exclure.
        if (!isHost) return setReply(c);
        menu(null, [
          { label: 'Répondre', icon: 'reply', action: () => setReply(c) },
          { label: 'Épingler ce commentaire', icon: 'pin', action: () => send('live.pin', { live_id: live.id, comment_id: c.id }) },
          { label: `Exclure ${c.user.name}`, icon: 'block', danger: true, action: () => banUser(ctx, c.user) },
        ], { x: e.clientX, y: e.clientY });
      };
    }
    return row;
  };
  const showPinned = c => {
    if (!c) return pinned.classList.add('hidden');
    clear(pinned, icon('pin', 14), avatar(c.user.avatar, c.user.name, 22), h('div.live-pinned-text', h('strong', c.user.name), ' ', c.text),
      isHost ? h('button', { type: 'button', 'aria-label': 'Désépingler', onclick: () => send('live.pin', { live_id: live.id, comment_id: null }) }, icon('close', 14)) : null);
    pinned.classList.remove('hidden');
  };
  addRow(h('div.live-system', '🎬 Bienvenue dans le LIVE ! Touchez un commentaire pour y répondre. Soyez bienveillant(e) : les commentaires irrespectueux peuvent entraîner une exclusion.'));
  (live.comments || []).forEach(c => addRow(commentRow(c)));
  showPinned(live.pinned);

  const mine = handler => data => { if (data && data.live_id === live.id) handler(data); };
  ctx.offs.push(
    bus.on('live.comment', mine(c => addRow(commentRow(c)))),
    bus.on('live.event', mine(ev => {
      if (ev.kind === 'join') addRow(h('div.live-system', h('strong', ev.user.name), ' a rejoint 👋'));
      if (ev.kind === 'ban') addRow(h('div.live-system', `${ev.user.name} a été exclu(e) du LIVE`));
    })),
    bus.on('live.viewers', mine(v => {
      viewersEl.textContent = compact(v.count);
      renderViewersTitle(v.count);
      clear(viewersAvatars, (v.top || []).map(u => avatar(u.avatar, u.name, 24)));
      loadViewers();
    })),
    bus.on('live.likes', mine(l => {
      likesTotal = l.total;
      likesCount.textContent = likesLabel(likesTotal);
      if (l.user_id !== state.me.id) for (let i = 0; i < Math.min(l.n, 6); i++) setTimeout(() => heart(hearts), i * 120);
    })),
    bus.on('live.gift', mine(g => {
      giftBanner(banners, g);
      addRow(h('div.live-system.gift', h('strong', g.user.name), ` a envoyé ${g.gift.name} ${g.gift.emoji}`));
      if (g.gift.value >= 100) bigGiftAnimation(bigGift, g.gift);
    })),
    bus.on('live.pinned', mine(p => showPinned(p.comment))),
    bus.on('live.host_away', mine(() => !isHost && setStatus("Connexion de l'animateur instable…", 'Le LIVE reprend dès son retour.'))),
    bus.on('live.host_back', mine(() => { if (!isHost) { setStatus(null); if (ctx.mode === 'sfu') startViewerMedia(ctx, video, setStatus); } })),
    bus.on('live.kicked', mine(() => { toast("L'animateur vous a exclu de ce LIVE."); window.kozons.go('/live', { replace: true }); })),
    bus.on('live.ended', mine(e => {
      teardown(ctx, false);
      page.classList.remove('room');
      clear(page, h('div.live-stage', isHost ? summaryView(live, e.summary) : endedView(live)));
    })),
    bus.on('error', err => { if (err && err.for && err.for.startsWith('live.')) toast(err.message, { type: 'error' }); }),
    bus.on('ws:reconnected', () => send(isHost ? 'live.host' : 'live.join', { live_id: live.id })),
  );

  ctx.mode = live.media.mode;
  if (isHost) {
    const started = new Date(live.started_at).getTime();
    const tick = () => { timerEl.textContent = duration((Date.now() - started) / 1000); };
    tick();
    ctx.timers.push(setInterval(tick, 1000));
    ctx.timers.push(setInterval(() => send('live.heartbeat', { live_id: live.id }), 15000));
    startHostMedia(ctx, video, setStatus);
  } else {
    send('live.join', { live_id: live.id });
    setStatus('Connexion au LIVE…');
    if (ctx.mode === 'sfu') startViewerMedia(ctx, video, setStatus);
    else setupViewerP2P(ctx, video, setStatus);
    enableSwipe(stageEl, live.id);
  }
}

/** 1234 -> « 1.2K », 12400 -> « 12K » (format compact TikTok, sans espace). */
function likesLabel(n) {
  return compact(n || 0).replace(/\s/g, '').toUpperCase();
}

// ------------------------------------------------------------------ vidéo : animateur

async function startHostMedia(ctx, video, setStatus) {
  const live = ctx.live;
  try {
    ctx.stream = prepStream || await getCamera();
    prepStream = ctx.stream;
  } catch (e) {
    setStatus("Autorisez la caméra et le micro pour diffuser.");
    return;
  }
  video.srcObject = ctx.stream;
  video.classList.toggle('mirror', facing === 'user');
  send('live.host', { live_id: live.id });
  if (ctx.mode === 'sfu') {
    try {
      setStatus('Mise en ligne…');
      ctx.pc = await publishWhip(live.media.url, ctx.stream);
      setStatus(null);
      ctx.pc.onconnectionstatechange = () => {
        if (ctx.pc && ctx.pc.connectionState === 'failed') setStatus('Connexion perdue, reconnexion…');
      };
    } catch (e) { setStatus('Impossible de joindre le serveur vidéo.', e.message); }
    return;
  }
  // Pair-à-pair : une connexion par spectateur, ouverte à son arrivée.
  const offerTo = async peer => {
    if (ctx.closed || ctx.pcs.has(peer)) return;
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    ctx.pcs.set(peer, pc);
    ctx.stream.getTracks().forEach(t => {
      const sender = pc.addTrack(t, ctx.stream);
      if (t.kind === 'video') {
        const p = sender.getParameters();
        p.encodings = [{ maxBitrate: 700000 }]; // plusieurs flux sortants : débit plafonné par spectateur
        sender.setParameters(p).catch(() => {});
      }
    });
    pc.onicecandidate = e => e.candidate && send('live.signal', { live_id: ctx.live.id, to: peer, data: { candidate: e.candidate } });
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) { pc.close(); ctx.pcs.delete(peer); } };
    await pc.setLocalDescription(await pc.createOffer());
    send('live.signal', { live_id: ctx.live.id, to: peer, data: { sdp: pc.localDescription } });
  };
  const mine = handler => data => { if (data && data.live_id === live.id) handler(data); };
  ctx.offs.push(
    bus.on('live.hosting', mine(d => (d.peers || []).forEach(offerTo))),
    bus.on('live.peer', mine(d => offerTo(d.peer))),
    bus.on('live.peer_left', mine(d => { const pc = ctx.pcs.get(d.peer); if (pc) { pc.close(); ctx.pcs.delete(d.peer); } })),
    bus.on('live.signal', mine(async d => {
      const pc = ctx.pcs.get(d.from);
      if (!pc) return;
      try {
        if (d.data.sdp) await pc.setRemoteDescription(d.data.sdp);
        else if (d.data.candidate) await pc.addIceCandidate(d.data.candidate);
      } catch (e) { /* ignoré */ }
    })),
  );
}

async function flipCamera(ctx, video) {
  facing = facing === 'user' ? 'environment' : 'user';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 } } });
    const track = s.getVideoTracks()[0];
    const old = ctx.stream.getVideoTracks()[0];
    const pcs = [ctx.pc, ...ctx.pcs.values()].filter(Boolean);
    for (const pc of pcs) {
      const sender = pc.getSenders().find(x => x.track && x.track.kind === 'video');
      if (sender) await sender.replaceTrack(track);
    }
    if (old) { ctx.stream.removeTrack(old); old.stop(); }
    ctx.stream.addTrack(track);
    video.srcObject = ctx.stream;
    video.classList.toggle('mirror', facing === 'user');
  } catch (e) { toast('Aucune autre caméra disponible.'); facing = facing === 'user' ? 'environment' : 'user'; }
}

/** Bouton micro (barre mobile ou panneau ordinateur) ; tous les boutons restent synchronisés. */
function micButton(ctx, cls = 'live-action', labeled = false) {
  const b = h('button.' + cls.split(' ').join('.'), { type: 'button', 'aria-label': 'Micro' });
  const paint = on => {
    b.classList.toggle('off', !on);
    b.replaceChildren(icon(on ? 'mic' : 'micOff', labeled ? 22 : 24), labeled ? h('span', on ? 'Micro' : 'Micro coupé') : '');
  };
  paint(true);
  (ctx.micButtons = ctx.micButtons || []).push(paint);
  b.onclick = () => {
    const t = ctx.stream && ctx.stream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    ctx.micButtons.forEach(fn => fn(t.enabled));
    toast(t.enabled ? 'Micro activé' : 'Micro coupé');
  };
  return b;
}

// ------------------------------------------------------------------ vidéo : spectateur

function attachRemote(video, stream, setStatus) {
  if (video.srcObject !== stream) video.srcObject = stream;
  setStatus(null);
  video.play().catch(() => {
    // Lecture automatique avec son bloquée par le navigateur : on démarre sans son.
    video.muted = true;
    video.play().catch(() => {});
    const unmute = h('button.live-unmute', { type: 'button', onclick: () => { video.muted = false; unmute.remove(); } }, icon('volumeOff', 18), ' Activer le son');
    video.parentElement && video.parentElement.appendChild(unmute);
  });
}

async function startViewerMedia(ctx, video, setStatus, attempt = 0) {
  if (ctx.closed) return;
  if (ctx.pc) { ctx.pc.close(); ctx.pc = null; }
  try {
    ctx.pc = await playWhep(ctx.live.media.url, stream => attachRemote(video, stream, setStatus));
    ctx.pc.onconnectionstatechange = () => {
      if (ctx.pc && ctx.pc.connectionState === 'failed' && !ctx.closed) setTimeout(() => startViewerMedia(ctx, video, setStatus), 2000);
    };
  } catch (e) {
    // L'animateur n'a peut-être pas encore commencé à diffuser : on réessaie.
    if (attempt < 20 && !ctx.closed) setTimeout(() => startViewerMedia(ctx, video, setStatus, attempt + 1), 3000);
    else setStatus('Vidéo indisponible pour le moment.');
  }
}

function setupViewerP2P(ctx, video, setStatus) {
  const live = ctx.live;
  ctx.offs.push(bus.on('live.signal', async d => {
    if (d.live_id !== live.id || ctx.closed) return;
    try {
      if (d.data.sdp && d.data.sdp.type === 'offer') {
        if (ctx.pc) ctx.pc.close();
        const pc = ctx.pc = new RTCPeerConnection({ iceServers: await iceServers() });
        pc.ontrack = e => attachRemote(video, e.streams[0], setStatus);
        pc.onicecandidate = e => e.candidate && send('live.signal', { live_id: live.id, to: d.from, data: { candidate: e.candidate } });
        await pc.setRemoteDescription(d.data.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        send('live.signal', { live_id: live.id, to: d.from, data: { sdp: pc.localDescription } });
      } else if (d.data.candidate && ctx.pc) {
        await ctx.pc.addIceCandidate(d.data.candidate);
      }
    } catch (e) { console.warn('[live]', e); }
  }));
}

// ------------------------------------------------------------------ animations

function heart(container, x, y, big = false) {
  const colors = ['#ff3040', '#ff6b9a', '#ffb800', '#9b5cff', '#00c2ff', '#ff7a00'];
  const el = h('span.live-heart' + (big ? '.big' : ''), '❤');
  el.style.color = colors[Math.floor(Math.random() * colors.length)];
  const rect = container.getBoundingClientRect();
  const left = x ?? rect.width - 48 - Math.random() * 30;
  const top = y ?? rect.height - 150;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.setProperty('--dx', (Math.random() * 80 - 40) + 'px');
  container.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

const comboState = new Map();

function giftBanner(container, g) {
  const key = g.user.id + ':' + g.gift.code;
  const prev = comboState.get(key);
  if (prev && Date.now() - prev.at < 3000 && prev.el.isConnected) {
    prev.count++;
    prev.at = Date.now();
    prev.countEl.textContent = '×' + prev.count;
    prev.countEl.classList.remove('bump'); void prev.countEl.offsetWidth; prev.countEl.classList.add('bump');
    clearTimeout(prev.timeout);
    prev.timeout = setTimeout(() => prev.el.remove(), 3500);
    return;
  }
  const countEl = h('span.live-combo', '×1');
  const el = h('div.live-banner', avatar(g.user.avatar, g.user.name, 32),
    h('div', h('strong', g.user.name), h('small', `a envoyé ${g.gift.name}`)), h('span.live-banner-gift', g.gift.emoji), countEl);
  container.appendChild(el);
  while (container.children.length > 3) container.firstChild.remove();
  const entry = { el, count: 1, at: Date.now(), countEl, timeout: setTimeout(() => el.remove(), 3500) };
  comboState.set(key, entry);
}

function bigGiftAnimation(container, gift) {
  const el = h('div.live-biggift-item', h('span', gift.emoji), h('small', gift.name));
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ------------------------------------------------------------------ panneaux

function giftSheet(ctx, page) {
  const existing = page.querySelector('.live-sheet');
  if (existing) return existing.remove();
  const sheet = h('div.live-sheet',
    h('div.live-sheet-head', h('strong', 'Envoyer un cadeau'), h('small', 'Gratuit · soutenez l\'animateur'),
      btn('close', 'Fermer', () => sheet.remove(), 'small')),
    h('div.live-gifts', ctx.live.gifts_catalog.map(g => h('button.live-gift', {
      type: 'button',
      onclick: e => {
        send('live.gift', { live_id: ctx.live.id, gift: g.code });
        const b = e.currentTarget; b.classList.remove('sent'); void b.offsetWidth; b.classList.add('sent');
      },
    }, h('span.live-gift-emoji', g.emoji), h('span', g.name)))));
  page.querySelector('.live-stage').appendChild(sheet);
}

async function showViewers(ctx) {
  const body = h('div.pick-list', spinner());
  const m = modal(body, { title: 'Spectateurs' });
  try {
    const { results } = await api.get(`live/${ctx.live.id}/viewers`);
    clear(body, results.length ? results.map(u => h('div.pick-item', avatar(u.avatar, u.name, 40),
      h('div.pick-text', h('div.strong', u.name), h('div.muted', '@' + u.username)),
      h('button.btn.ghost.small', { onclick: () => { m.close(); banUser(ctx, u); } }, 'Exclure')))
      : h('p.muted.pad', 'Personne pour le moment. Partagez votre LIVE !'));
  } catch (e) { clear(body, h('p.muted', e.message)); }
}

async function banUser(ctx, user) {
  if (!await confirmDialog(`Exclure ${user.name} de ce LIVE ? Il/elle ne pourra plus le rejoindre ni commenter.`, { ok: 'Exclure', danger: true })) return;
  send('live.ban', { live_id: ctx.live.id, user_id: user.id });
}

async function shareLive(live) {
  const url = `${location.origin}/live/${live.id}`;
  try {
    if (navigator.share) await navigator.share({ title: `${live.host.name} est en LIVE sur Kozons`, url });
    else { await navigator.clipboard.writeText(url); toast('Lien du LIVE copié'); }
  } catch (e) { /* partage annulé */ }
}

/** Balayage vertical (ou flèches) : LIVE suivant / précédent, comme TikTok. */
function enableSwipe(stageEl, currentId) {
  let ids = null;
  const move = async dir => {
    try { ids = ids || (await api.get('live')).results.filter(l => !l.is_host).map(l => l.id); } catch (e) { return; }
    const i = ids.indexOf(currentId);
    const next = ids[(i + dir + ids.length) % ids.length];
    if (next && next !== currentId) window.kozons.go('/live/' + next, { replace: true });
    else toast('Aucun autre LIVE pour le moment.');
  };
  let startY = null;
  stageEl.addEventListener('touchstart', e => { if (!e.target.closest('.live-bottom, .live-sheet')) startY = e.touches[0].clientY; }, { passive: true });
  stageEl.addEventListener('touchend', e => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (Math.abs(dy) > 90) move(dy < 0 ? 1 : -1);
  });
  const onKey = e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowDown') move(1);
    if (e.key === 'ArrowUp') move(-1);
  };
  document.addEventListener('keydown', onKey);
  const obs = new MutationObserver(() => { if (!stageEl.isConnected) { document.removeEventListener('keydown', onKey); obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });
}

// ------------------------------------------------------------------ fin

function endedView(live, message) {
  return h('div.live-ended',
    live ? avatar(live.host.avatar, live.host.name, 96) : icon('live', 56),
    h('h2', message ? 'LIVE indisponible' : 'Le LIVE est terminé'),
    h('p', message || (live ? `Merci d'avoir regardé ${live.host.name} !` : '')),
    live && !live.is_host ? followButton(live.host.id, null) : null,
    h('button.btn.ghost', { onclick: () => window.kozons.go('/live', { replace: true }) }, 'Voir d\'autres LIVE'));
}

function summaryView(live, s) {
  const stat = (value, label) => h('div.live-stat', h('strong', value), h('span', label));
  return h('div.live-ended.summary',
    h('h2', 'LIVE terminé'),
    h('p', live.title || 'Merci pour ce direct !'),
    h('div.live-stats',
      stat(duration(s.duration), 'Durée'),
      stat(compact(s.total_viewers), 'Spectateurs'),
      stat(compact(s.peak_viewers), 'Pic simultané'),
      stat(compact(s.likes), "J'aime"),
      stat(compact(s.comments), 'Commentaires'),
      stat(`${compact(s.gifts)} (${compact(s.gifts_value)} 💎)`, 'Cadeaux'),
      stat(`+${compact(s.new_followers)}`, 'Nouveaux abonnés')),
    h('button.btn.primary', { onclick: () => window.kozons.go('/live', { replace: true }) }, 'Terminé'));
}
