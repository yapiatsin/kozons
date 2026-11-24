// Page « Statuts » façon WhatsApp : mon statut, mises à jour récentes, déjà vues.
import { bus, state } from '../store.js';
import { h, clear, icon, btn, avatar, ago, empty, spinner, errorToast } from '../ui.js';
import { fetchStories, openViewer, createStoryDialog, openStoryCamera } from './stories.js';

export function render(stage) {
  const list = h('div', spinner());
  const page = h('div.page.narrow',
    h('header.page-head', h('h2', 'Statuts'), h('div.row',
      btn('edit', 'Statut texte', () => createStoryDialog(load)),
      btn('camera', 'Appareil photo', () => openStoryCamera(load)))),
    list);
  stage.appendChild(page);

  async function load() {
    try {
      const groups = await fetchStories();
      const mine = groups.find(g => g.is_me);
      const recent = groups.filter(g => !g.is_me && !g.muted && !g.all_seen);
      const seen = groups.filter(g => !g.is_me && !g.muted && g.all_seen);
      const muted = groups.filter(g => !g.is_me && g.muted);
      const row = g => {
        const last = g.stories[g.stories.length - 1];
        return h('button.status-row' + (g.muted ? '.muted-row' : ''), { type: 'button', onclick: () => openViewer(groups, groups.indexOf(g), load) },
          avatar(g.user.avatar, g.user.name, 52, { ring: g.all_seen ? 'seen' : 'new' }),
          h('div.grow', h('div.strong', g.is_me ? 'Mon statut' : g.user.name),
            h('div.muted.small', `${g.stories.length} mise${g.stories.length > 1 ? 's' : ''} à jour · ${ago(last.created_at)}`)));
      };
      clear(list,
        mine ? row(mine) : h('button.status-row', { type: 'button', onclick: () => createStoryDialog(load) },
          h('div.story-avatar-wrap', avatar(state.me.avatar, state.me.name, 52), h('span.story-add', icon('plus', 14))),
          h('div.grow', h('div.strong', 'Mon statut'), h('div.muted.small', 'Appuyez pour ajouter une mise à jour'))),
        recent.length ? [h('div.list-title', 'Récents'), recent.map(row)] : null,
        seen.length ? [h('div.list-title', 'Vus'), seen.map(row)] : null,
        // « Masquer » (menu ⋮ de la visionneuse) : rangés à part, sans être lus à la suite des autres.
        muted.length ? h('details.status-muted', h('summary.list-title', `Statuts masqués (${muted.length})`), muted.map(row)) : null,
        !recent.length && !seen.length ? empty('status', 'Aucune mise à jour', 'Les statuts de vos contacts et des comptes que vous suivez disparaissent après 24 heures.') : null);
    } catch (e) { errorToast(e); }
  }
  load();
  return bus.on('story.new', load);
}
