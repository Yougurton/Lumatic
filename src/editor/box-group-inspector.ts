import type { AnyEvent } from './box-groups';
import { KIND_NAMES } from './box-group-lanes';
import type { BoxGroupBlock } from './box-groups';
import { tr } from './i18n';

/**
 * What the inspector shows of the map's own GLS block while it is picked (in place of the brush):
 * a read-over panel — the block's kind and place, and inside it, what every box picks and spreads.
 * The reading stage can't change a map's block, so there is nothing to edit here yet.
 */

/** The game's index filter kinds. */
const FILTER_NAMES: Record<number, string> = { 1: 'секции', 2: 'шаг и смещение', 3: 'куски' };
/** The distribution's shapes: what a box's spread means (1: a wave over the elements, 2: each from the start). */
const SPREAD_NAMES: Record<number, string> = { 1: 'волной', 2: 'с начала каждого' };
/** The common easings of the game's events (the rest stay numbers). */
const EASING_NAMES: Record<number, string> = { 0: 'сразу', 1: 'разгоном', 2: 'торможением', 3: 'разгоном и торможением' };
const AXIS_LETTERS = ['X', 'Y', 'Z'];
const MAX_EVENTS_SHOWN = 8;

const easingName = (easing: number) => EASING_NAMES[easing] ?? `${tr('сглаживание')} ${String(easing)}`;

/** A box's filter in words ("секции: каждая 2-я с 1-й, в обратном порядке…"). */
function filterText(box: { indexFilter: { type: number; param0: number; param1: number; reverse: number; chunks: number; random: number; seed: number; limit: number } }): string {
  const filter = box.indexFilter;
  const parts: string[] = [];
  const name = FILTER_NAMES[filter.type] ?? `тип ${String(filter.type)}`;
  if (filter.type === 2) parts.push(`${name}: шаг ${String(filter.param0)} со смещения ${String(filter.param1)}`);
  else parts.push(`${name}: ${String(filter.param0)} / ${String(filter.param1)}`);
  if (filter.reverse === 1) parts.push('в обратном порядке');
  if (filter.chunks > 0) parts.push(`кусков: ${String(filter.chunks)}`);
  if (filter.random !== 0) parts.push(`случайный порядок (зерно ${String(filter.seed)})`);
  if (filter.limit > 0) parts.push(`не больше ${String(Math.round(filter.limit * 100))}% элементов`);
  return parts.join(', ');
}

/** A box's two spreads ("по времени: волной 4 доли, по значению: с начала каждого"). */
function spreadsText(box: { beatDistribution: number; beatDistributionType: number; distribution: number; distributionType: number }): string {
  const time = box.beatDistributionType === 0 ? 'все сразу' : `${SPREAD_NAMES[box.beatDistributionType] ?? String(box.beatDistributionType)} на ${String(box.beatDistribution)} доли`;
  const value = box.distributionType === 0 ? `значение ${String(box.distribution)}` : `${SPREAD_NAMES[box.distributionType] ?? String(box.distributionType)} от ${String(box.distribution)}`;
  return `${tr('по времени')}: ${time}, ${tr('по значению')}: ${value}`;
}

/** One event of a box in words, by the block's kind. */
function eventText(block: BoxGroupBlock, event: AnyEvent): string {
  const at = `+${String(Math.round(event.relativeJsonTime * 100) / 100)}`;
  const previous = 'usePrevious' in event && event.usePrevious === 1 ? tr('как предыдущее') : null;
  if (block.kind === 'color') {
    const color = event as { color: number; brightness: number; easing: number; frequency: number };
    const lamp = color.color === 0 ? tr('левый') : color.color === 1 ? tr('правый') : String(color.color);
    const strobe = color.frequency > 0 ? `, ${tr('строб')} ${String(color.frequency)}` : '';
    return `${at} · ${lamp}, ${String(color.brightness)} ${easingName(color.easing)}${strobe}`;
  }
  if (block.kind === 'rotation') {
    const turn = event as { rotation: number; direction: number; loop: number; easing: number };
    const way = turn.direction === 1 ? tr('по часовой') : turn.direction === 2 ? tr('против часовой') : tr('как выходит');
    const turns = turn.loop > 0 ? `, ${String(turn.loop)} ${tr('оборотов')}` : '';
    return `${at} · ${String(turn.rotation)}° ${way}${turns}, ${easingName(turn.easing)}`;
  }
  if (block.kind === 'translation') {
    const move = event as { translation: number; easing: number };
    return `${at} · сдвиг ${String(move.translation)}, ${easingName(move.easing)}`;
  }
  const effect = event as { value: number; easing: number };
  return `${at} · значение ${String(effect.value)}, ${easingName(effect.easing)}`;
}

/** The panel itself: its heading, the block's numbers, and a part per box. `count`: the group's
 *  number of elements (0: not known). */
export function renderBoxBlockPanel(root: HTMLElement, block: BoxGroupBlock, groupLabel: string, count: number): void {
  const axis = block.axes.length > 0 ? ` ${block.axes.map((axis) => AXIS_LETTERS[axis] ?? String(axis)).join('/')}` : '';
  const title = document.createElement('h3');
  title.textContent = `${groupLabel} — ${tr(KIND_NAMES[block.kind])}${axis}`;
  root.append(title);

  const facts = document.createElement('div');
  facts.className = 'ins-note';
  facts.textContent = [
    `${tr('Доля')} ${String(Math.round(block.beat * 100) / 100)}`,
    `${tr('длина')} ${String(Math.round(block.length * 100) / 100)}`,
    tr('боксов {0}', String(block.boxes.length)),
    tr('событий {0}', String(block.events)),
    count > 0 ? tr('элементов {0}', String(count)) : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');
  root.append(facts);

  const note = document.createElement('div');
  note.className = 'ins-note';
  note.textContent = tr('Блок карты — только просмотр: правка блоков карты будет на следующем этапе.');
  root.append(note);

  block.boxes.forEach((box, index) => {
    const head = document.createElement('div');
    head.className = 'gls-heading';
    head.textContent = block.boxes.length > 1 ? tr('Бокс {0}', String(index + 1)) : tr('Бокс');
    root.append(head);

    const lines = document.createElement('div');
    lines.className = 'ins-note';
    const rows = [`${tr('Фильтр')}: ${filterText(box)}`, `${tr('Разброс')}: ${spreadsText(box)}`];
    for (const line of rows) {
      const row = document.createElement('div');
      row.textContent = line;
      lines.append(row);
    }
    root.append(lines);

    if (box.events.length > 0) {
      const list = document.createElement('div');
      list.className = 'ins-note';
      for (const event of box.events.slice(0, MAX_EVENTS_SHOWN)) {
        const row = document.createElement('div');
        row.textContent = eventText(block, event);
        list.append(row);
      }
      if (box.events.length > MAX_EVENTS_SHOWN) {
        const more = document.createElement('div');
        more.textContent = tr('+ ещё {0} событий', String(box.events.length - MAX_EVENTS_SHOWN));
        list.append(more);
      }
      root.append(list);
    }
  });

  if (block.customData !== undefined) {
    const custom = document.createElement('div');
    custom.className = 'ins-note';
    custom.textContent = tr('У блока есть custom data — при сохранении останется как было.');
    root.append(custom);
  }
}
