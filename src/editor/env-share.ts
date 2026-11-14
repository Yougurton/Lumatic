import type { Editor, SceneSnapshot } from './editor';
import { tr } from './i18n';
import { difficultyFile } from './map-io';
import { saveFileAs } from './platform';

/**
 * The scene taken out of the map and brought in: as a shared Chroma environment (a .dat file for
 * UserData/Chroma/Environments), into and out of Lumatic's own gallery of scenes — and the settings
 * the map recommends to the player (Heck's Settings Setter, in Info.dat).
 */

const dialog = (title: string, className = '') => {
  const shade = document.createElement('div');
  shade.className = 'ce-shade';
  const box = document.createElement('div');
  box.className = `ce-dialog share-dialog ${className}`;
  box.append(Object.assign(document.createElement('div'), { className: 'ce-dialog-title', textContent: tr(title) }));
  shade.append(box);
  document.body.append(shade);
  const close = () => shade.remove();
  shade.addEventListener('mousedown', (event) => {
    if (event.target === shade) close();
  });
  return { box, close };
};

const field = (box: HTMLElement, label: string, control: HTMLElement, hint = '') => {
  const line = document.createElement('label');
  line.className = 'share-field';
  if (hint !== '') line.title = tr(hint);
  line.append(Object.assign(document.createElement('span'), { textContent: tr(label) }), control);
  box.append(line);
  return control;
};

const buttons = (box: HTMLElement, ...items: [string, () => void, boolean?][]) => {
  const row = document.createElement('div');
  row.className = 'ce-dialog-buttons';
  for (const [text, run, primary] of items) {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: tr(text) });
    if (primary === true) button.classList.add('primary');
    button.addEventListener('click', run);
    row.append(button);
  }
  box.append(row);
};

/** The scene saved as a shared Chroma environment: a form, then a .dat file. */
export async function exportEnvironmentDialog(editor: Editor) {
  const project = editor.project;
  const map = editor.map;
  const row = editor.row;
  if (project === null || map === null || row === null) return;
  const fragment = await editor.environmentFragment();
  const environmentName = row.environmentId ?? 'DefaultEnvironment';
  const { box, close } = dialog('Сохранить как окружение Chroma');
  const text = (value: string) => Object.assign(document.createElement('input'), { type: 'text', value });
  const name = field(box, 'Название', text(map.parsed.mapMeta.title || 'My environment')) as HTMLInputElement;
  const author = field(box, 'Автор', text(map.parsed.mapMeta.mapper)) as HTMLInputElement;
  const version = field(box, 'Версия окружения', text('1.0.0')) as HTMLInputElement;
  const description = field(box, 'Описание', text('')) as HTMLInputElement;
  box.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr('Базовое окружение: {0}', environmentName) }));
  const chroma = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
  field(box, 'Цвета и номера ламп Chroma', chroma, 'useChromaEvents: включает свои цвета и номера ламп (нужно, если в сцене свои лампы)');
  const filter = document.createElement('select');
  for (const [value, label] of [['', 'не задавать'], ['AllEffects', 'все эффекты'], ['StrobeFilter', 'без стробов'], ['NoEffects', 'без эффектов']]) filter.append(Object.assign(document.createElement('option'), { value, textContent: tr(label!) }));
  field(box, 'Фильтр эффектов', filter, 'forceEffectsFilter: какие эффекты света окружение включает у игрока');
  const lights = Object.assign(document.createElement('input'), { type: 'checkbox', checked: false });
  field(box, 'Вшить события света этой сложности', lights, 'basicBeatmapEvents: свет этой сложности будет играть в любой карте с этим окружением (только сложности v3)');
  const skipped = fragment.customEvents.length;
  if (skipped > 0) box.append(Object.assign(document.createElement('div'), { className: 'ins-note env-warning', textContent: tr('Анимация, привязки, движения и игрок в файл окружения не попадут — формат их не поддерживает ({0} событий).', skipped) }));
  box.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr('Файл кладётся в папку игры UserData/Chroma/Environments и выбирается в настройках Chroma как окружение для любой карты.') }));
  buttons(
    box,
    ['Отмена', close],
    [
      'Сохранить…',
      () =>
        void (async () => {
          const features: Record<string, unknown> = {};
          if (chroma.checked) features.useChromaEvents = true;
          if (filter.value !== '') features.forceEffectsFilter = filter.value;
          if (lights.checked) {
            const difficulty = JSON.parse(await map.folder.readText(difficultyFile(row))) as { basicBeatmapEvents?: unknown };
            if (Array.isArray(difficulty.basicBeatmapEvents)) features.basicBeatmapEvents = difficulty.basicBeatmapEvents;
            else editor.setStatus(tr('События света вшиваются только из сложностей v3 — файл сохранён без них'));
          }
          const out = {
            version: '1.0.0',
            name: name.value.trim() || 'Environment',
            author: author.value.trim(),
            environmentVersion: version.value.trim() || '1.0.0',
            environmentName,
            description: description.value.trim(),
            features,
            environment: fragment.environment,
            ...(Object.keys(fragment.materials).length > 0 ? { materials: fragment.materials } : {}),
          };
          const file = `${(name.value.trim() || 'Environment').replace(/[\\/:*?\u0022<>|]+/g, '_')}.dat`;
          const saved = await saveFileAs(file, new TextEncoder().encode(JSON.stringify(out, null, 2)), tr('Окружение Chroma'), ['dat']);
          if (saved !== null) {
            close();
            editor.setStatus(tr('Окружение сохранено: {0}', saved));
          }
        })(),
      true,
    ],
  );
}

/** A shared Chroma environment (a .dat file) brought into the scene. */
export function importEnvironmentFile(editor: Editor) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.dat,.json' });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file === undefined) return;
    void file.text().then((text) => {
      try {
        editor.importEnvironmentFile(JSON.parse(text) as Record<string, unknown>);
      } catch {
        editor.setStatus(tr('Не удалось прочитать файл окружения'));
      }
    });
  });
  input.click();
}

// ----- the gallery ---------------------------------------------------------------------------------------

interface GalleryEntry {
  id: string;
  name: string;
  date: string;
  snapshot: SceneSnapshot;
}

const GALLERY_KEY = 'lumatic.sceneGallery';

function readGallery(): GalleryEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem(GALLERY_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? (list as GalleryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeGallery(list: GalleryEntry[]): boolean {
  try {
    localStorage.setItem(GALLERY_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Lumatic's own gallery of scenes: the scene saved into it, a saved one put into the map. */
export function galleryDialog(editor: Editor) {
  const { box, close } = dialog('Галерея сцен', 'gallery-dialog');
  const list = document.createElement('div');
  list.className = 'gallery-list';
  const render = () => {
    const entries = readGallery();
    list.replaceChildren();
    if (entries.length === 0) list.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr('Галерея пуста. Сохраните сюда сцену, чтобы применять её к другим картам.') }));
    for (const entry of entries) {
      const line = document.createElement('div');
      line.className = 'gallery-item';
      const snapshot = entry.snapshot;
      const about = tr('{0} · своих объектов: {1} · изменений: {2} · анимаций: {3}', snapshot.environment, (snapshot.objects ?? []).length, (snapshot.scene ?? []).length, (snapshot.anims ?? []).length);
      const text = document.createElement('div');
      text.append(Object.assign(document.createElement('b'), { textContent: entry.name }), Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: `${about} · ${entry.date}` }));
      const act = (label: string, title: string, run: () => void) => {
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: tr(label), title: tr(title) });
        button.addEventListener('click', run);
        return button;
      };
      line.append(
        text,
        act('Добавить', 'Добавить к сцене этой карты', () => {
          editor.applySceneSnapshot(snapshot, false);
          close();
        }),
        act('Заменить', 'Заменить сцену этой карты этой', () => {
          if (!window.confirm(tr('Заменить сцену этой карты сценой «{0}»? (Ctrl+Z вернёт)', entry.name))) return;
          editor.applySceneSnapshot(snapshot, true);
          close();
        }),
        act('🗑', 'Удалить из галереи', () => {
          if (!window.confirm(tr('Удалить «{0}» из галереи?', entry.name))) return;
          writeGallery(readGallery().filter((item) => item.id !== entry.id));
          render();
        }),
      );
      list.append(line);
    }
  };
  box.append(list);
  const save = document.createElement('div');
  save.className = 'gallery-save';
  const name = Object.assign(document.createElement('input'), { type: 'text', placeholder: tr('Название сцены'), value: editor.map?.parsed.mapMeta.title ?? '' });
  const add = Object.assign(document.createElement('button'), { type: 'button', textContent: tr('Сохранить текущую сцену') });
  add.addEventListener('click', () => {
    const title = name.value.trim() || tr('Сцена');
    const entry: GalleryEntry = { id: `g${Date.now().toString(36)}`, name: title, date: new Date().toLocaleDateString(), snapshot: editor.sceneSnapshot() };
    if (!writeGallery([entry, ...readGallery()])) {
      editor.setStatus(tr('Не удалось сохранить в галерею (нет места)'));
      return;
    }
    editor.setStatus(tr('Сцена «{0}» сохранена в галерею', title));
    render();
  });
  save.append(name, add);
  box.append(save);
  box.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: tr('Сцена применяется целиком к картам с тем же окружением. К другому окружению переносятся только свои объекты, материалы и туман.') }));
  buttons(box, ['Закрыть', close, true]);
  render();
}

// ----- recommended settings ---------------------------------------------------------------------------------

type SettingKind = 'bool' | [string, string][];
/** The settings worth recommending (Heck's Settings Setter): category, name, what it is, its values. */
const SETTINGS: { group: string; category: string; name: string; label: string; kind: SettingKind }[] = [
  { group: 'Игрок', category: '_playerOptions', name: '_leftHanded', label: 'Режим левши', kind: 'bool' },
  { group: 'Игрок', category: '_playerOptions', name: '_noTextsAndHuds', label: 'Без текста и интерфейса', kind: 'bool' },
  { group: 'Игрок', category: '_playerOptions', name: '_hideNoteSpawnEffect', label: 'Скрыть вспышку появления нот', kind: 'bool' },
  { group: 'Игрок', category: '_playerOptions', name: '_reduceDebris', label: 'Меньше осколков', kind: 'bool' },
  { group: 'Игрок', category: '_playerOptions', name: '_environmentEffectsFilterDefaultPreset', label: 'Фильтр эффектов (до Expert)', kind: [['AllEffects', 'все эффекты'], ['StrobeFilter', 'без стробов'], ['NoEffects', 'без эффектов']] },
  { group: 'Игрок', category: '_playerOptions', name: '_environmentEffectsFilterExpertPlusPreset', label: 'Фильтр эффектов (Expert+)', kind: [['AllEffects', 'все эффекты'], ['StrobeFilter', 'без стробов'], ['NoEffects', 'без эффектов']] },
  { group: 'Окружение и цвета', category: '_environments', name: '_overrideEnvironments', label: 'Подменять окружение своим', kind: 'bool' },
  { group: 'Окружение и цвета', category: '_colors', name: '_overrideDefaultColors', label: 'Подменять цвета своими', kind: 'bool' },
  { group: 'Графика', category: '_graphics', name: '_mirrorGraphicsSettings', label: 'Зеркала', kind: [['0', 'выкл.'], ['1', 'низкие'], ['2', 'средние'], ['3', 'высокие']] },
  { group: 'Графика', category: '_graphics', name: '_mainEffectGraphicsSettings', label: 'Свечение (bloom)', kind: [['0', 'выкл.'], ['1', 'вкл.']] },
  { group: 'Графика', category: '_graphics', name: '_smokeGraphicsSettings', label: 'Дым', kind: [['0', 'выкл.'], ['1', 'вкл.']] },
  { group: 'Графика', category: '_graphics', name: '_screenDisplacementEffectsEnabled', label: 'Искажения экрана', kind: 'bool' },
  { group: 'Графика', category: '_graphics', name: '_maxShockwaveParticles', label: 'Ударные волны', kind: [['0', 'нет'], ['1', 'одна'], ['2', 'много']] },
  { group: 'Chroma', category: '_chroma', name: '_disableChromaEvents', label: 'Выключить события Chroma', kind: 'bool' },
  { group: 'Chroma', category: '_chroma', name: '_disableEnvironmentEnhancements', label: 'Выключить изменения окружения', kind: 'bool' },
  { group: 'Chroma', category: '_chroma', name: '_disableNoteColoring', label: 'Выключить цвета нот Chroma', kind: 'bool' },
  { group: 'Chroma', category: '_chroma', name: '_forceZenModeWalls', label: 'Стены в режиме дзен', kind: 'bool' },
];

/** The difficulty entries of Info.dat v2 (the settings are kept in theirs). */
function infoEntries(info: Record<string, unknown>): { characteristic: string; entry: Record<string, unknown> }[] {
  const sets = Array.isArray(info._difficultyBeatmapSets) ? (info._difficultyBeatmapSets as Record<string, unknown>[]) : [];
  return sets.flatMap((set) => (Array.isArray(set._difficultyBeatmaps) ? (set._difficultyBeatmaps as Record<string, unknown>[]) : []).map((entry) => ({ characteristic: String(set._beatmapCharacteristicName ?? 'Standard'), entry })));
}

/** The settings the map recommends to the player: a choice a setting ("not set" — left to them). */
export async function settingsDialog(editor: Editor) {
  const map = editor.map;
  const row = editor.row;
  const infoName = map?.folder.files.find((name) => name.toLowerCase() === 'info.dat');
  if (map === null || row === null || infoName === undefined) return;
  const info = JSON.parse(await map.folder.readText(infoName)) as Record<string, unknown>;
  const { box, close } = dialog('Рекомендованные настройки', 'settings-setter');
  if (typeof info.version === 'string' && info.version.startsWith('4')) {
    box.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: tr('Рекомендованные настройки пишутся в Info.dat версии 2. У этой карты Info.dat версии 4 — Heck описывает настройки только для v2.') }));
    buttons(box, ['Закрыть', close, true]);
    return;
  }
  const file = difficultyFile(row);
  const mine = infoEntries(info).find((item) => item.entry._beatmapFilename === file)?.entry;
  const current = ((mine?._customData as Record<string, unknown> | undefined)?._settings ?? {}) as Record<string, Record<string, unknown>>;
  box.append(Object.assign(document.createElement('div'), { className: 'ins-note', textContent: tr('Игроку предложат включить эти настройки перед картой. Указывайте только то, без чего карта действительно выглядит неправильно, — например, выключить левшу, если в окружении есть текст.') }));
  const controls = new Map<string, HTMLSelectElement>();
  const grid = document.createElement('div');
  grid.className = 'settings-grid';
  let group = '';
  for (const setting of SETTINGS) {
    if (setting.group !== group) {
      group = setting.group;
      grid.append(Object.assign(document.createElement('div'), { className: 'env-section', textContent: tr(group) }));
    }
    const select = document.createElement('select');
    select.append(Object.assign(document.createElement('option'), { value: '', textContent: tr('не задавать') }));
    const options: [string, string][] = setting.kind === 'bool' ? [['true', 'включить'], ['false', 'выключить']] : setting.kind;
    for (const [value, label] of options) select.append(Object.assign(document.createElement('option'), { value, textContent: tr(label) }));
    const now = current[setting.category]?.[setting.name];
    select.value = now === undefined ? '' : String(now);
    controls.set(`${setting.category}.${setting.name}`, select);
    field(grid, setting.label, select);
  }
  // the useful ones, at once
  const quick = document.createElement('div');
  quick.className = 'ins-buttons';
  const preset = (label: string, values: Record<string, string>) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: tr(label) });
    button.addEventListener('click', () => {
      for (const [key, value] of Object.entries(values)) {
        const select = controls.get(key);
        if (select !== undefined) select.value = value;
      }
    });
    quick.append(button);
  };
  preset('Выключить левшу', { '_playerOptions._leftHanded': 'false' });
  preset('Включить зеркала', { '_graphics._mirrorGraphicsSettings': '3' });
  preset('Не подменять окружение и цвета', { '_environments._overrideEnvironments': 'false', '_colors._overrideDefaultColors': 'false' });
  preset('Включить Chroma', { '_chroma._disableChromaEvents': 'false', '_chroma._disableEnvironmentEnhancements': 'false' });
  box.append(quick, grid);
  const every = Object.assign(document.createElement('input'), { type: 'checkbox', checked: false });
  field(box, 'Для всех сложностей карты', every);
  buttons(
    box,
    ['Отмена', close],
    [
      'Сохранить',
      () =>
        void (async () => {
          const settings: Record<string, Record<string, unknown>> = {};
          for (const setting of SETTINGS) {
            const value = controls.get(`${setting.category}.${setting.name}`)!.value;
            if (value === '') continue;
            (settings[setting.category] ??= {})[setting.name] = value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number(value) : value;
          }
          const fresh = JSON.parse(await map.folder.readText(infoName)) as Record<string, unknown>;
          for (const { entry } of infoEntries(fresh)) {
            if (!every.checked && entry._beatmapFilename !== file) continue;
            const custom = (entry._customData ?? {}) as Record<string, unknown>;
            if (Object.keys(settings).length > 0) custom._settings = settings;
            else delete custom._settings;
            if (Object.keys(custom).length > 0) entry._customData = custom;
            else delete entry._customData;
          }
          await map.folder.writeText(infoName, JSON.stringify(fresh, null, 2));
          close();
          editor.setStatus(Object.keys(settings).length > 0 ? tr('Рекомендованные настройки записаны в Info.dat') : tr('Рекомендованные настройки убраны'));
        })(),
      true,
    ],
  );
}
