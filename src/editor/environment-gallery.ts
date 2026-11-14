import { findPreset, PRESET_COLLECTIONS, PRESETS, type Preset } from './environment-mods';

/**
 * The environments as cards: the game's own (a picture of each from the editor's 3D view) and the
 * ready-made Chroma ones (their authors' pictures, their authors named on them), with filters. Picking
 * one ('pick') or putting one on the map and taking it off ('apply').
 */

export interface EnvironmentChoice {
  /** The game's environment. */
  environment: string;
  /** A ready-made one built on it (its id). */
  preset?: string;
}

export interface GalleryOptions {
  mode: 'pick' | 'apply';
  /** What's chosen now. */
  current: EnvironmentChoice;
  /** The game's environments offered (id, name). */
  standard: readonly (readonly [string, string])[];
  /** The difficulty's file version ('new': a new map, v3). */
  version: '2' | '3' | '4' | 'new';
  /** Picked (pick), or put on / taken off (apply: `preset` undefined — taken off). */
  choose: (choice: EnvironmentChoice) => void;
}

const environmentName = (id: string) => id.replace(/Environment$/u, '').replace(/([a-z])([A-Z])/gu, '$1 $2');

/** Why a ready-made environment can't go into the difficulty (null: it can). */
export function presetBlocked(preset: Preset, version: GalleryOptions['version']) {
  if (version === '4') return 'Карты v4 редактор пока не сохраняет.';
  if (version === '2' && !preset.v2) return 'Только для карт v3 (в этом окружении есть то, чего нет в v2).';
  return null;
}

export function presetImage(preset: Preset) {
  return `custom-envs/${preset.id}.jpg`;
}

export function standardImage(environment: string) {
  return `environment-previews/${environment}.jpg`;
}

/** The plate a choice shows as: picture, name, who made it, what it's built on. */
export function choiceLabel(choice: EnvironmentChoice, standard: GalleryOptions['standard']) {
  const preset = findPreset(choice.preset);
  if (preset !== undefined) return { image: presetImage(preset), name: preset.name, detail: `автор: ${preset.author} · на ${environmentName(preset.environment)}${preset.noodle ? ' · Noodle' : ''}` };
  const name = standard.find(([id]) => id === choice.environment)?.[1] ?? environmentName(choice.environment);
  return { image: standardImage(choice.environment), name, detail: 'окружение игры' };
}

export function environmentGallery(options: GalleryOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = 'env-gallery';
  const bar = document.createElement('div');
  bar.className = 'env-filter';
  const group = document.createElement('select');
  const groups: [string, string][] = [
    ['standard', 'Окружения игры'],
    ['all', 'Все готовые'],
    ...PRESET_COLLECTIONS.map((collection): [string, string] => [collection.id, `${collection.name} — ${collection.author}`]),
  ];
  for (const [value, label] of groups) group.append(Object.assign(document.createElement('option'), { value, textContent: label }));
  const base = document.createElement('select');
  base.title = 'На каком окружении игры';
  base.append(Object.assign(document.createElement('option'), { value: '', textContent: 'Любое окружение' }));
  for (const id of [...new Set(PRESETS.map((preset) => preset.environment))].sort()) base.append(Object.assign(document.createElement('option'), { value: id, textContent: environmentName(id) }));
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Поиск: название, автор';
  bar.append(group, base, search);
  const grid = document.createElement('div');
  grid.className = 'env-grid';
  const credits = document.createElement('div');
  credits.className = 'nm-dim env-note env-credits';
  root.append(bar, grid, credits);
  group.value = options.current.preset !== undefined ? (findPreset(options.current.preset)?.collection ?? 'all') : 'standard';

  const card = (image: string, name: string, lines: string[], active: boolean, notes: string, action: { label: string; disabled?: string | null; run: () => void }) => {
    const element = document.createElement('div');
    element.className = `env-card${active ? ' active' : ''}`;
    const picture = document.createElement('img');
    picture.src = image;
    picture.alt = name;
    picture.loading = 'lazy';
    picture.addEventListener('error', () => picture.classList.add('missing'));
    const title = document.createElement('div');
    title.className = 'env-card-name';
    title.textContent = name;
    element.append(picture, title);
    for (const line of lines) element.append(Object.assign(document.createElement('div'), { className: 'nm-dim env-card-text', textContent: line }));
    if (notes !== '') {
      const details = document.createElement('details');
      details.className = 'env-card-lights';
      details.innerHTML = '<summary>Свет и как пользоваться</summary>';
      details.append(Object.assign(document.createElement('div'), { textContent: notes }));
      element.append(details);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    if (action.disabled) {
      button.disabled = true;
      button.title = action.disabled;
    }
    button.addEventListener('click', action.run);
    element.append(button);
    if (options.mode === 'pick' && !action.disabled) element.addEventListener('dblclick', action.run);
    return element;
  };

  const render = () => {
    grid.replaceChildren();
    const query = search.value.trim().toLowerCase();
    if (group.value === 'standard') {
      base.hidden = true;
      for (const [id, name] of options.standard) {
        if (query !== '' && !`${id} ${name}`.toLowerCase().includes(query)) continue;
        const active = options.current.preset === undefined && options.current.environment === id;
        const action =
          options.mode === 'pick'
            ? { label: active ? 'Выбрано' : 'Выбрать', run: () => options.choose({ environment: id }) }
            : { label: active ? 'Стоит сейчас' : 'Поставить', disabled: active ? 'Это окружение уже стоит' : options.version === '4' ? 'Карты v4 редактор пока не сохраняет.' : null, run: () => options.choose({ environment: id }) };
        grid.append(card(standardImage(id), name, ['окружение игры'], active, '', action));
      }
      credits.textContent = 'Картинки окружений игры — кадры из 3D-вида редактора.';
      return;
    }
    base.hidden = false;
    const shown = PRESETS.filter(
      (preset) =>
        (group.value === 'all' || preset.collection === group.value) &&
        (base.value === '' || preset.environment === base.value) &&
        (query === '' || `${preset.name} ${preset.author} ${preset.summary}`.toLowerCase().includes(query)),
    );
    for (const preset of shown) {
      const active = findPreset(options.current.preset)?.id === preset.id;
      const blocked = presetBlocked(preset, options.version);
      const lines = [`автор: ${preset.author}`, `на ${environmentName(preset.environment)}${preset.noodle ? ' · нужен Noodle Extensions' : ''}`, ...(preset.summary !== '' ? [preset.summary] : [])];
      const action =
        options.mode === 'pick'
          ? { label: active ? 'Выбрано' : 'Выбрать', disabled: blocked, run: () => options.choose({ environment: preset.environment, preset: preset.id }) }
          : active
            ? { label: 'Убрать', run: () => options.choose({ environment: preset.environment }) }
            : { label: 'Поставить', disabled: blocked, run: () => options.choose({ environment: preset.environment, preset: preset.id }) };
      grid.append(card(presetImage(preset), preset.name, lines, active, preset.lights, action));
    }
    if (shown.length === 0) grid.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'Ничего не нашлось.' }));
    // whose they are: every collection shown, its source and licence
    credits.replaceChildren();
    for (const collection of PRESET_COLLECTIONS.filter((item) => shown.some((preset) => preset.collection === item.id))) {
      const line = document.createElement('div');
      line.append(`${collection.name} — ${collection.author} (`);
      const link = document.createElement('a');
      link.href = collection.source;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = collection.source.replace(/^https:\/\//u, '');
      line.append(link, `). ${collection.license} `);
      const license = document.createElement('details');
      license.innerHTML = '<summary>Текст</summary>';
      const text = document.createElement('pre');
      text.className = 'env-license';
      license.append(text);
      license.addEventListener('toggle', () => {
        if (license.open && text.textContent === '') void fetch(`custom-envs/licenses/${collection.id}.txt`).then(async (response) => (text.textContent = await response.text()));
      });
      line.append(license);
      credits.append(line);
    }
  };
  group.addEventListener('change', render);
  base.addEventListener('change', render);
  search.addEventListener('input', render);
  render();
  return root;
}
