// Brady : l'assistant IA des idées (proposer, développer, méthodes et stratégies), comme Meta AI.
import { api, streamPost } from '../api.js';
import { state } from '../store.js';
import { h, clear, icon, btn, menu, toast, errorToast, confirmDialog, autoGrow, spinner, listTime, resizablePanel } from '../ui.js';

export const BRADY_LOGO = '/static/kozons/brady.png';
const go = path => window.kozons.go(path);

const STARTERS = [
  { emoji: '💡', title: 'Proposer des idées', text: 'Propose-moi des idées pour ', hint: 'Projets, business, contenus, événements…' },
  { emoji: '🚀', title: 'Développer mon idée', text: "Voici mon idée : \n\nAide-moi à la développer.", hint: 'Clarifier, enrichir, trouver la bonne version', caret: 16 },
  { emoji: '🧭', title: 'Méthodes et stratégies', text: 'Comment mettre en œuvre cette idée, étape par étape et avec quelle stratégie : ', hint: 'Plan d’action, outils, indicateurs' },
];

export function render(stage, params) {
  let threadId = params.id || null;
  let streaming = null;   // AbortController de la réponse en cours
  let threads = [];

  const list = h('div.by-threads');
  const side = h('aside.by-side',
    h('div.by-side-head', h('strong', 'Conversations'), btn('close', 'Fermer', () => root.classList.remove('show-side'), 'by-side-close')),
    h('button.btn.primary.block', { onclick: () => { root.classList.remove('show-side'); go('/brady'); } }, icon('plus', 18), ' Nouvelle conversation'),
    list);
  resizablePanel(side, 'brady', { min: 220 });
  const feed = h('div.by-feed');
  const scroller = h('div.by-scroll', feed);
  const input = h('textarea.by-input', { rows: 1, placeholder: 'Écris à Brady…', maxlength: 8000, 'aria-label': 'Message pour Brady' });
  const resize = autoGrow(input, 180);
  const sendBtn = h('button.by-send', { type: 'button', 'aria-label': 'Envoyer' }, icon('send', 20));
  const header = h('header.by-head',
    btn('back', 'Retour', () => history.length > 1 ? history.back() : go('/'), 'by-back'),
    h('img.by-logo', { src: BRADY_LOGO, alt: '' }),
    h('div.by-head-text', h('strong', 'Brady'), h('small', 'Assistant des idées · IA')),
    h('div.row',
      btn('edit', 'Nouvelle conversation', () => go('/brady')),
      btn('clock', 'Historique', () => root.classList.toggle('show-side'), 'by-history-btn'),
      btn('more', 'Plus', e => menu(e.currentTarget, [
        threadId ? { label: 'Supprimer cette conversation', icon: 'trash', danger: true, action: () => deleteThread(threadId) } : null,
        threads.length ? { label: "Effacer tout l'historique", icon: 'trash', danger: true, action: clearAll } : null,
        { label: 'À propos de Brady', icon: 'info', action: about },
      ].filter(Boolean)))));
  const composer = h('footer.by-composer',
    h('div.by-field', input, sendBtn),
    h('p.by-note', 'Brady peut se tromper : vérifie les informations importantes.'));
  const main = h('section.by-main', header, scroller, composer);
  const root = h('div.brady', side, main, h('div.by-backdrop', { onclick: () => root.classList.remove('show-side') }));
  stage.appendChild(root);

  // ---------------------------------------------------------- historique
  async function loadThreads() {
    try {
      ({ results: threads } = await api.get('brady/threads'));
      paintThreads();
    } catch (e) { /* silencieux */ }
  }
  function paintThreads() {
    clear(list, threads.length ? threads.map(t => h('div.by-thread' + (t.id === threadId ? '.active' : ''),
      h('button.by-thread-open', { type: 'button', onclick: () => { root.classList.remove('show-side'); go('/brady/' + t.id); } },
        h('span', t.title), h('small', listTime(t.updated_at))),
      btn('trash', 'Supprimer', () => deleteThread(t.id), 'by-thread-del')))
      : h('p.muted.small.by-empty', 'Tes conversations avec Brady apparaîtront ici.'));
  }
  async function deleteThread(id) {
    if (!await confirmDialog('Supprimer cette conversation avec Brady ?', { ok: 'Supprimer', danger: true })) return;
    try {
      await api.post(`brady/threads/${id}/delete`);
      threads = threads.filter(t => t.id !== id);
      paintThreads();
      if (id === threadId) go('/brady');
    } catch (e) { errorToast(e); }
  }
  async function clearAll() {
    if (!await confirmDialog("Effacer tout l'historique de tes conversations avec Brady ?", { ok: 'Tout effacer', danger: true })) return;
    try { await api.post('brady/threads/clear'); threads = []; paintThreads(); go('/brady'); } catch (e) { errorToast(e); }
  }
  function about() {
    toast('Brady est l’assistant IA de Kozons : il propose des idées, développe les tiennes et te montre comment les réaliser.', { timeout: 7000 });
  }

  // ---------------------------------------------------------- messages
  function bubble(role, content) {
    const body = h('div.by-md');
    const el = h('div.by-msg.' + role,
      role === 'assistant' ? h('img.by-avatar', { src: BRADY_LOGO, alt: '' }) : null,
      h('div.by-bubble', body,
        role === 'assistant' ? h('div.by-tools', btn('copy', 'Copier', () => copyText(el.dataset.raw))) : null));
    setContent(el, content);
    return el;
  }
  function setContent(el, text) {
    el.dataset.raw = text;
    clear(el.querySelector('.by-md'), el.classList.contains('assistant') ? markdown(text) : text);
  }
  function copyText(text) {
    navigator.clipboard.writeText(text || '').then(() => toast('Réponse copiée')).catch(() => toast('Copie impossible', { type: 'error' }));
  }
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const scrollDown = () => { scroller.scrollTop = scroller.scrollHeight; };

  function welcome() {
    const first = (state.me.name || '').split(' ')[0];
    clear(feed, h('div.by-welcome',
      h('img.by-hero', { src: BRADY_LOGO, alt: 'Brady' }),
      h('h2', `Bonjour${first ? ' ' + first : ''}, je suis Brady 👋`),
      h('p.muted', 'Ton assistant des idées : je propose des idées, je développe les tiennes et je te montre comment les réaliser, avec méthode.'),
      h('div.by-starters', STARTERS.map(s => h('button.by-starter', { type: 'button', onclick: () => useStarter(s) },
        h('span.by-starter-emoji', s.emoji), h('strong', s.title), h('small', s.hint))))));
  }
  function useStarter(s) {
    input.value = s.text;
    resize();
    input.focus();
    const pos = s.caret !== undefined ? s.caret : s.text.length;
    input.setSelectionRange(pos, pos);
  }

  async function openThread(id) {
    clear(feed, h('div.center.pad', spinner()));
    try {
      const { messages } = await api.get('brady/threads/' + id);
      clear(feed, messages.map(m => bubble(m.role, m.content)));
      scrollDown();
    } catch (e) {
      toast(e.message, { type: 'error' });
      go('/brady');
    }
  }

  // ---------------------------------------------------------- envoi + réponse au fil de l'eau
  async function sendMessage() {
    const text = input.value.trim();
    if (!text || streaming) return;
    if (feed.querySelector('.by-welcome')) clear(feed);
    feed.appendChild(bubble('user', text));
    input.value = '';
    resize();
    const reply = bubble('assistant', '');
    reply.classList.add('pending');
    clear(reply.querySelector('.by-md'), h('span.by-typing', h('i'), h('i'), h('i')));
    feed.appendChild(reply);
    scrollDown();
    streaming = new AbortController();
    paintSend();
    let raw = '', frame = 0;
    const paint = () => {
      frame = 0;
      const follow = atBottom();
      setContent(reply, raw);
      if (follow) scrollDown();
    };
    try {
      await streamPost('brady/chat', { text, thread_id: threadId }, ev => {
        if (ev.type === 'meta' && !threadId) {
          threadId = ev.thread.id;
          history.replaceState({}, '', '/brady/' + threadId);
          threads = [ev.thread, ...threads.filter(t => t.id !== threadId)];
          paintThreads();
        } else if (ev.type === 'delta') {
          raw += ev.text;
          reply.classList.remove('pending');
          if (!frame) frame = requestAnimationFrame(paint);
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }, { signal: streaming.signal });
    } catch (e) {
      if (e.name !== 'AbortError') {
        if (!raw) reply.remove();
        feed.appendChild(h('div.by-error', icon('info', 16), h('span', e.message)));
        if (!raw) { input.value = text; resize(); }
      }
    } finally {
      if (frame) cancelAnimationFrame(frame);
      if (raw) { setContent(reply, raw); reply.classList.remove('pending'); }
      streaming = null;
      paintSend();
      scrollDown();
      loadThreads();
    }
  }
  function paintSend() {
    clear(sendBtn, icon(streaming ? 'close' : 'send', 20));
    sendBtn.classList.toggle('stop', !!streaming);
    sendBtn.setAttribute('aria-label', streaming ? 'Arrêter la réponse' : 'Envoyer');
  }
  sendBtn.onclick = () => (streaming ? streaming.abort() : sendMessage());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.innerWidth > 760) { e.preventDefault(); sendMessage(); }
  });

  loadThreads();
  if (threadId) openThread(threadId); else welcome();
  if (window.innerWidth > 760) setTimeout(() => input.focus(), 50);
  return () => { if (streaming) streaming.abort(); };
}

// ------------------------------------------------------------------ mise en forme (Markdown simple, sans HTML brut)

function inline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**') || t.startsWith('__')) out.push(h('strong', inline(t.slice(2, -2))));
    else if (t.startsWith('`')) out.push(h('code', t.slice(1, -1)));
    else if (t.startsWith('[')) {
      const [, label, url] = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label));
    } else if (t.startsWith('http')) out.push(h('a', { href: t, target: '_blank', rel: 'noopener noreferrer' }, t));
    else out.push(h('em', inline(t.slice(1, -1))));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function markdown(src) {
  const lines = (src || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(h('pre', h('code', code.join('\n'))));
      continue;
    }
    const head = line.match(/^(#{1,4})\s+(.*)$/);
    if (head) { blocks.push(h('h' + Math.min(head[1].length + 2, 6), inline(head[2]))); i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { blocks.push(h('hr')); i++; continue; }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(h('blockquote', inline(q.join(' '))));
      continue;
    }
    if (/^\s*([-*•])\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*([-*•])\s+/).test(lines[i])) {
        let item = lines[i++].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*([-*•])\s+/, '');
        // Lignes de suite (indentées) rattachées à l'élément.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(h('li', inline(item)));
      }
      blocks.push(h(ordered ? 'ol' : 'ul', items));
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*•])\s+|\s*\d+[.)]\s+|\s*>)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(h('p', para.flatMap((l, k) => (k ? [h('br'), ...inline(l)] : inline(l)))));
  }
  return blocks;
}
