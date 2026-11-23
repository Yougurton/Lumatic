import { setAddedEnvironments } from '../engine/renderer/environment/environment-catalog';
import type { Editor } from './editor';
import { gameEnvironments, type GameFolder, type ImportedEnvironment } from './platform';
import { setSettings, settings } from './settings';

/**
 * Environments from the user's own game, in the settings: the game's folder is given, its
 * environments are listed — which the editor has, which are made from the game already, which are
 * not — and one can be made (electron/game-environments.ts runs the converter) and looked at in the
 * 3D view. What is made stays in the user's data folder.
 */

/** The game's file names of the environments the editor has of its own (the names differ from the ids). */
const BUILT_IN: Record<string, string> = {
  thefirst: 'DefaultEnvironment', origins: 'OriginsEnvironment', triangle: 'TriangleEnvironment', nice: 'NiceEnvironment', bigmirror: 'BigMirrorEnvironment',
  dragons: 'DragonsEnvironment', kda: 'KDAEnvironment', monstercat: 'MonstercatEnvironment', crabrave: 'CrabRaveEnvironment', panic: 'PanicEnvironment',
  rocket: 'RocketEnvironment', greenday: 'GreenDayEnvironment', timbaland: 'TimbalandEnvironment', fitbeat: 'FitBeatEnvironment', linkinpark: 'LinkinParkEnvironment',
  glassdesert: 'GlassDesertEnvironment', bts: 'BTSEnvironment', kaleidoscope: 'KaleidoscopeEnvironment', interscope: 'InterscopeEnvironment', gaga: 'GagaEnvironment',
  skrillex: 'SkrillexEnvironment', billie: 'BillieEnvironment', halloween: 'HalloweenEnvironment', weave: 'WeaveEnvironment', edm: 'EDMEnvironment',
  thesecond: 'TheSecondEnvironment', lizzo: 'LizzoEnvironment', theweeknd: 'TheWeekndEnvironment', dragons2: 'Dragons2Environment', lattice: 'LatticeEnvironment',
  daftpunk: 'DaftPunkEnvironment', hiphop: 'HipHopEnvironment', collider: 'ColliderEnvironment', grid: 'GridEnvironment',
};
/** Not environments of a map: the menu's and the game's own scenes. */
const NOT_MAPS = new Set(['multiplayer', 'tutorial']);

/** Tells the engine which environments are made from the game (at the start, and after one is made or removed). */
export async function refreshGameEnvironments(): Promise<ImportedEnvironment[]> {
  const imported = (await gameEnvironments()?.imported().catch(() => [])) ?? [];
  setAddedEnvironments(imported.map((item) => ({ id: item.id, title: item.title, gls: item.groups > 0 })));
  return imported;
}

function el(tag: 'div' | 'span', props?: Partial<HTMLElement>): HTMLElement;
function el(tag: 'input', props?: Partial<HTMLInputElement>): HTMLInputElement;
function el(tag: 'button', props?: Partial<HTMLButtonElement>): HTMLButtonElement;
function el(tag: string, props: object = {}): HTMLElement {
  return Object.assign(document.createElement(tag), props);
}

/** The settings' section (desktop app only). */
export function gameEnvironmentsSection(editor: Editor): HTMLElement[] {
  const native = gameEnvironments();
  const intro = el('div', {
    className: 'nm-dim set-hint',
    textContent:
      'В редакторе есть данные не всех окружений игры. Недостающие можно сделать из вашей установленной копии Beat Saber: укажите её папку. Сделанное остаётся на этом компьютере, в папке данных Lumatic, и в карты не попадает.',
  });
  if (native === undefined) return [intro, el('div', { className: 'set-hint', textContent: 'Доступно только в приложении для компьютера.' })];

  const path = el('input', { type: 'text', className: 'set-text', value: settings().gameFolder, placeholder: '…\\steamapps\\common\\Beat Saber', spellcheck: false });
  path.style.flex = '1';
  const pick = el('button', { type: 'button', textContent: 'Выбрать…' });
  const line = el('div', { className: 'set-row' });
  line.append(el('div', { className: 'set-name', textContent: 'Папка игры' }), path, pick);
  const status = el('div', { className: 'nm-dim set-hint' });
  const list = el('div', { className: 'game-envs' });
  list.style.cssText = 'display:grid;grid-template-columns:1fr auto auto;gap:4px 12px;align-items:center;margin-top:8px;max-height:46vh;overflow:auto';
  const message = el('div', { className: 'set-hint' });
  message.style.whiteSpace = 'pre-wrap';

  let game: GameFolder | null = null;
  let busy = false;

  const draw = async () => {
    const imported = await refreshGameEnvironments();
    list.replaceChildren();
    if (game === null) return;
    const rows = game.environments.filter((item) => !NOT_MAPS.has(item.name));
    // (those the editor hasn't got first)
    const state = (name: string) => (BUILT_IN[name] !== undefined ? 2 : imported.some((item) => item.id.toLowerCase() === `${name}environment`) ? 1 : 0);
    rows.sort((a, b) => state(a.name) - state(b.name) || a.name.localeCompare(b.name));
    for (const item of rows) {
      const made = imported.find((entry) => entry.id.toLowerCase() === `${item.name}environment`);
      const builtIn = BUILT_IN[item.name];
      const name = el('div', { textContent: made?.title ?? item.name });
      const note = el('div', { className: 'nm-dim' });
      const actions = el('span', { className: 'steps-buttons' });
      if (builtIn !== undefined) {
        note.textContent = 'есть в редакторе';
      } else if (made !== undefined) {
        const missing = made.notUnderstood.reduce((sum, [, count]) => sum + count, 0);
        note.textContent = `сделано из игры ${made.gameVersion}${made.groups > 0 ? ` · групп света: ${String(made.groups)}` : ''}${missing > 0 ? ` · не разобрано: ${String(missing)}` : ''}`;
        note.title = made.notUnderstood.map(([what, count]) => `${String(count)} × ${what}`).join('\n');
      } else {
        note.textContent = 'нет в редакторе';
      }
      if (builtIn === undefined) {
        const make = el('button', { type: 'button', textContent: made === undefined ? 'Сделать' : 'Сделать заново', disabled: busy });
        make.addEventListener('click', () => void run(item.name));
        actions.append(make);
        if (made !== undefined) {
          const show = el('button', { type: 'button', textContent: 'Показать', title: 'Показать окружение в 3D-окне (карта не меняется)' });
          show.addEventListener('click', () => {
            message.textContent = `Показываю ${made.title} в 3D-окне…`;
            void editor.showEnvironment(made.id).then((ok) => (message.textContent = ok ? `В 3D-окне сейчас ${made.title}. Карта не изменена: откройте сложность заново, чтобы вернуть её окружение.` : `Не удалось показать ${made.title}: подробности в журнале.`));
          });
          const remove = el('button', { type: 'button', textContent: 'Убрать', disabled: busy });
          remove.addEventListener('click', () => void native.remove(made.id).then(draw));
          actions.append(show, remove);
        }
      }
      list.append(name, note, actions);
    }
  };

  const run = async (name: string) => {
    if (game === null || busy) return;
    busy = true;
    message.textContent = `Делаю ${name} из файлов игры — это может занять до минуты…`;
    await draw();
    const result = await native.importEnvironment(game.folder, name);
    busy = false;
    if (result.ok) message.textContent = `Готово: ${result.environment.title}. Нажмите «Показать», чтобы увидеть его в 3D-окне.`;
    else if (result.reason === 'no-python') message.textContent = 'Не найден Python. Конвертеру нужен Python 3 (python.org), после установки выполните в командной строке:\npy -3 -m pip install UnityPy Pillow';
    else if (result.reason === 'no-modules') message.textContent = `Python найден, но в нём нет нужных модулей. Выполните в командной строке:\n${result.detail} -m pip install UnityPy Pillow`;
    else message.textContent = `Не получилось сделать ${name}:\n${result.detail}`;
    await draw();
  };

  const read = async () => {
    const folder = path.value.trim();
    setSettings({ gameFolder: folder });
    if (folder === '') {
      game = null;
      status.textContent = '';
      await draw();
      return;
    }
    game = await native.folder(folder);
    status.textContent = game === null ? 'В этой папке нет Beat Saber (нужна папка, где лежит Beat Saber.exe).' : `Beat Saber ${game.version === '' ? '' : game.version} · окружений в игре: ${String(game.environments.filter((item) => !NOT_MAPS.has(item.name)).length)}`;
    await draw();
  };

  path.addEventListener('change', () => void read());
  pick.addEventListener('click', () => {
    void native.pickFolder().then((folder) => {
      if (folder === null) return;
      path.value = folder;
      void read();
    });
  });
  void read();
  return [intro, line, status, list, message];
}
