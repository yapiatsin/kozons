// Mentions « @membre » dans la zone de saisie d'un groupe, comme sur WhatsApp :
// « @ » ouvre la liste des membres, les lettres tapées la filtrent, la sélection insère
// « @Nom » affiché en bleu, et Retour arrière efface la mention d'un coup.
import { h, clear, avatar } from '../ui.js';

const normalize = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * @param input    textarea de saisie
 * @param members  () => [{ id, name, username, avatar }] membres mentionnables (sans soi-même)
 * @param enabled  () => bool (mentions uniquement dans les groupes)
 */
export function mentionInput(input, { members, enabled }) {
  let mentions = [];      // [{ id, name, username }] insérées dans le texte
  let matches = [];       // membres proposés
  let activeIndex = 0;
  let query = null;       // texte tapé après « @ » (null = liste fermée)

  // Calque sous le champ (rendu transparent) : même texte, mentions en couleur.
  const backdrop = h('div.mention-backdrop', { 'aria-hidden': 'true' });
  const field = h('div.mention-field', backdrop, input);
  const list = h('div.mention-list', { role: 'listbox' });
  const picker = h('div.mention-picker.hidden', list);

  const tokens = () => [...mentions].sort((a, b) => b.name.length - a.name.length);

  /** Mentions toujours présentes dans le texte (celles effacées ou modifiées sont oubliées). */
  function current() {
    const seen = new Set();
    return mentions.filter(m => input.value.includes('@' + m.name) && !seen.has(m.id) && seen.add(m.id));
  }

  function renderBackdrop() {
    const text = input.value;
    const frag = document.createDocumentFragment();
    const sorted = tokens();
    let buf = '';
    for (let i = 0; i < text.length;) {
      const m = text[i] === '@' && sorted.find(t => text.startsWith('@' + t.name, i));
      if (m) {
        if (buf) { frag.appendChild(document.createTextNode(buf)); buf = ''; }
        frag.appendChild(h('span.mention-hl', '@' + m.name));
        i += m.name.length + 1;
      } else {
        buf += text[i];
        i++;
      }
    }
    // Un saut de ligne final doit occuper une ligne, comme dans le textarea.
    frag.appendChild(document.createTextNode(buf + (text.endsWith('\n') ? ' ' : '')));
    backdrop.replaceChildren(frag);
    backdrop.scrollTop = input.scrollTop;
  }

  function close() {
    query = null;
    picker.classList.add('hidden');
  }

  function renderList() {
    clear(list, matches.map((u, i) => h('button.mention-item' + (i === activeIndex ? '.active' : ''), {
      type: 'button', role: 'option', 'aria-selected': String(i === activeIndex),
      // mousedown : on garde le focus dans la zone de saisie.
      onmousedown: e => { e.preventDefault(); select(u); },
    }, avatar(u.avatar, u.name, 32), h('div.mention-text', h('strong', u.name), h('span', '@' + u.username)))));
    const active = list.children[activeIndex];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  /** Détecte « @texte » juste avant le curseur et met à jour la liste filtrée. */
  function detect() {
    if (!enabled()) return close();
    const caret = input.selectionStart;
    if (caret !== input.selectionEnd) return close();
    const m = input.value.slice(0, caret).match(/(^|\s)@([^\s@]{0,30})$/);
    if (!m) return close();
    query = m[2];
    const q = normalize(query);
    const all = members();
    matches = all
      .filter(u => !q || normalize(u.name).split(/\s+/).some(w => w.startsWith(q)) || normalize(u.name).includes(q) || normalize(u.username).startsWith(q))
      .sort((a, b) => Number(normalize(b.name).startsWith(q)) - Number(normalize(a.name).startsWith(q)) || a.name.localeCompare(b.name, 'fr'));
    if (!matches.length) return close();
    activeIndex = Math.min(activeIndex, matches.length - 1);
    picker.classList.remove('hidden');
    renderList();
  }

  function select(user) {
    const caret = input.selectionStart;
    const start = caret - query.length - 1; // position du « @ »
    const insert = '@' + user.name + ' ';
    input.value = input.value.slice(0, start) + insert + input.value.slice(caret);
    const pos = start + insert.length;
    input.setSelectionRange(pos, pos);
    if (!mentions.some(m => m.id === user.id)) mentions.push({ id: user.id, name: user.name, username: user.username });
    close();
    input.dispatchEvent(new Event('input')); // redimensionnement, bouton d'envoi, calque
    input.focus();
  }

  /** Retour arrière juste après une mention : elle est supprimée entièrement. */
  function eraseMention(e) {
    const caret = input.selectionStart;
    if (caret !== input.selectionEnd) return false;
    const before = input.value.slice(0, caret);
    const m = tokens().find(t => before.endsWith('@' + t.name) || before.endsWith('@' + t.name + ' '));
    if (!m) return false;
    const token = before.endsWith('@' + m.name + ' ') ? '@' + m.name + ' ' : '@' + m.name;
    e.preventDefault();
    const start = caret - token.length;
    input.value = input.value.slice(0, start) + input.value.slice(caret);
    input.setSelectionRange(start, start);
    input.dispatchEvent(new Event('input'));
    return true;
  }

  // Phase de capture : passe avant le raccourci « Entrée = envoyer » de la zone de saisie.
  input.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (query !== null && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        return renderList();
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        return select(matches[activeIndex]);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        return close();
      }
    }
    if (e.key === 'Backspace' && mentions.length && eraseMention(e)) e.stopImmediatePropagation();
  }, true);

  input.addEventListener('input', () => { activeIndex = 0; renderBackdrop(); detect(); });
  input.addEventListener('click', detect);
  input.addEventListener('keyup', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') detect(); });
  input.addEventListener('scroll', () => { backdrop.scrollTop = input.scrollTop; });
  input.addEventListener('blur', () => setTimeout(close, 150));
  renderBackdrop();

  return {
    field,
    picker,
    /** Mentions à envoyer avec le message. */
    list: current,
    clear() { mentions = []; close(); renderBackdrop(); },
    refresh: renderBackdrop,
  };
}
