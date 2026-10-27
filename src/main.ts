import { Editor } from './editor/editor';
import { Inspector } from './editor/inspector';
import { encodeOgg, findBpm } from './editor/audio-tools';
import { GlsEditor } from './editor/gls-editor';
import { RingEditor } from './editor/ring-editor';
import { Library } from './editor/library';
import { mapSettingsDialog } from './editor/map-settings';
import { colorsDialog } from './editor/colors-dialog';
import { environmentDialog } from './editor/environment-dialog';
import { newMapDialog } from './editor/new-map';
import { isDesktop, openMapFolder, openRecentFolder, recentFolders, type MapFolder } from './editor/platform';
import { Preview } from './editor/preview';
import { GRIDS, MAX_RATE, MIN_RATE, Timeline } from './editor/timeline';
import { adjustDialog } from './editor/adjust-dialog';
import { actionFor, comboOf } from './editor/hotkeys';
import { hotkeysDialog } from './editor/hotkeys-dialog';
import { ask } from './editor/menu';
import type { StartMode } from './editor/model';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const preview = new Preview(byId<HTMLCanvasElement>('preview'));
const editor = new Editor(preview);
const timeline = new Timeline(editor, byId('timeline'));
new Inspector(editor, byId('inspector'));
const library = new Library(editor, byId('library'));
const presets = library.presets;
new GlsEditor(editor);
new RingEditor(editor);

// for tests and the console
(window as unknown as { chroeditor: unknown }).chroeditor = { editor, timeline, preview, presets, library, audio: { findBpm, encodeOgg } };

const status = byId('status');
const timeLabel = byId('time');
const playButton = byId<HTMLButtonElement>('play');
const difficultySelect = byId<HTMLSelectElement>('difficulty');
const saveButton = byId<HTMLButtonElement>('save');
const recentSelect = byId<HTMLSelectElement>('recent');

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes)}:${rest.toFixed(3).padStart(6, '0')}`;
}

function refreshToolbar() {
  status.textContent = `${editor.dirty ? '● ' : ''}${editor.status}`;
  saveButton.disabled = editor.project === null;
  byId<HTMLButtonElement>('settings').disabled = editor.project === null;
  byId<HTMLButtonElement>('environment').disabled = editor.project === null;
  byId<HTMLButtonElement>('map-colors').disabled = editor.project === null;
  const rows = editor.difficulties();
  difficultySelect.disabled = rows.length === 0;
  const key = rows.map((row) => row.key).join('|');
  if (difficultySelect.dataset.key !== key) {
    difficultySelect.dataset.key = key;
    difficultySelect.replaceChildren(
      ...rows.map((row) => {
        const option = document.createElement('option');
        option.value = row.key;
        option.textContent = `${row.label} (${row.key.split('/')[0] ?? ''})`;
        return option;
      }),
    );
  }
  if (editor.row !== null) difficultySelect.value = editor.row.key;
}

function tick() {
  editor.tickTrial();
  const seconds = editor.clock?.currentTime() ?? 0;
  timeLabel.textContent = `${formatTime(seconds)} · доля ${editor.playhead().toFixed(3)}`;
  playButton.textContent = editor.isPlaying() ? '❚❚' : '▶';
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

editor.onChange(() => refreshToolbar());

async function openFolder(folder: MapFolder | null) {
  if (folder === null) return;
  if (editor.dirty && !window.confirm('Несохранённые изменения пропадут. Открыть другую карту?')) return;
  try {
    await editor.open(folder);
    timeline.fit();
    void refreshRecent();
  } catch (error) {
    console.error(error);
    editor.setStatus(`Не удалось открыть: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function refreshRecent() {
  if (!isDesktop()) return;
  const list = await recentFolders();
  recentSelect.hidden = list.length === 0;
  recentSelect.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: 'Недавние…' }),
    ...list.map((path) => Object.assign(document.createElement('option'), { value: path, textContent: path.split(/[\\/]/).at(-1) ?? path, title: path })),
  );
}
void refreshRecent();

byId('open').addEventListener('click', () => void openMapFolder().then(openFolder));
byId('new-map').addEventListener('click', () => void newMap());

async function newMap() {
  if (editor.dirty && !window.confirm('Несохранённые изменения пропадут. Создать новую карту?')) return;
  let mapper = '';
  try {
    mapper = localStorage.getItem('chroeditor.mapper') ?? '';
  } catch {
    // (only a convenience)
  }
  const made = await newMapDialog(mapper);
  if (made === null) return;
  editor.dirty = false;
  await openFolder(made.folder);
  // (a ready-made environment: put on the new difficulty as the Environment window does)
  if (made.preset !== undefined) await editor.setEnvironmentMods({ preset: made.preset });
  editor.setStatus(`Карта создана: ${made.folder.name}`);
}
recentSelect.addEventListener('change', () => {
  const path = recentSelect.value;
  recentSelect.value = '';
  if (path !== '') void openRecentFolder(path).then(openFolder);
});
difficultySelect.addEventListener('change', () => {
  const row = editor.difficulties().find((item) => item.key === difficultySelect.value);
  if (row === undefined) return;
  if (editor.dirty && !window.confirm('Несохранённые изменения пропадут. Переключить сложность?')) {
    refreshToolbar();
    return;
  }
  void editor.openDifficulty(row);
});
saveButton.addEventListener('click', () => void save());
byId('settings').addEventListener('click', () => void mapSettingsDialog(editor));
byId('environment').addEventListener('click', () => void environmentDialog(editor));
byId('map-colors').addEventListener('click', () => void colorsDialog(editor));
byId('undo').addEventListener('click', () => editor.undo());
byId('redo').addEventListener('click', () => editor.redo());
playButton.addEventListener('click', () => editor.togglePlay());
byId('zoom-in').addEventListener('click', () => timeline.zoom(1.5));
byId('bookmark').addEventListener('click', () => void timeline.addBookmarkHere());
byId('zoom-out').addEventListener('click', () => timeline.zoom(1 / 1.5));
byId('zoom-fit').addEventListener('click', () => timeline.fit());

async function save() {
  try {
    await editor.save();
  } catch (error) {
    console.error(error);
    editor.setStatus(`Не сохранено: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// the keys (hotkeys.ts: by their place on the keyboard — with a Russian layout Ctrl+Z is Ctrl+Я; the
// user's own from "⌨")
const brushStart = (mode: StartMode, name: string) => {
  editor.brush.startMode = mode;
  editor.emit('selection');
  editor.setStatus(`Кисть: ${name}`);
};
const brushColor = (ref: 'left' | 'right' | 'white', name: string) => {
  editor.brush.color = { ...editor.brush.color, ref };
  delete editor.brush.color.rgb;
  editor.emit('selection');
  editor.setStatus(`Кисть: ${name}`);
};
const stepGrid = (finer: boolean) => {
  const grids = GRIDS.filter(([value]) => value > 0).map(([value]) => value);
  const at = grids.findIndex((value) => Math.abs(value - editor.snap) < 1e-9);
  const next = grids[Math.min(grids.length - 1, Math.max(0, (at < 0 ? grids.indexOf(0.25) : at) + (finer ? 1 : -1)))]!;
  editor.snap = next;
  timeline.redraw();
  timeline.syncPlayControls();
  editor.setStatus(`Сетка: ${GRIDS.find(([value]) => value === next)?.[1] ?? ''}`);
};
const stepRate = (up: boolean) => {
  const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round((editor.rate + (up ? 0.1 : -0.1)) * 100) / 100));
  editor.setRate(rate);
  editor.setStatus(`Скорость: ${String(rate)}×`);
};
const ACTIONS_RUN: Record<string, () => void> = {
  play: () => editor.togglePlay(),
  start: () => editor.seek(0),
  back: () => editor.seek(Math.max(0, editor.snapBeat(editor.playhead()) - (editor.snap || 0.25))),
  forward: () => editor.seek(editor.snapBeat(editor.playhead()) + (editor.snap || 0.25)),
  goto: () =>
    void ask('Перейти к доле', String(Math.round(editor.playhead() * 1000) / 1000)).then((text) => {
      const beat = Number(text?.replace(',', '.'));
      if (text !== null && Number.isFinite(beat)) editor.seek(Math.max(0, beat));
    }),
  faster: () => stepRate(true),
  slower: () => stepRate(false),
  finer: () => stepGrid(true),
  coarser: () => stepGrid(false),
  zoomIn: () => timeline.zoom(1.5),
  zoomOut: () => timeline.zoom(1 / 1.5),
  fit: () => timeline.fit(),
  rowsUp: () => timeline.scrollRows(-60),
  rowsDown: () => timeline.scrollRows(60),
  bookmark: () => void timeline.addBookmarkHere(),
  prevBookmark: () => {
    const bookmark = editor.nextBookmark(-1);
    if (bookmark !== undefined) editor.seek(bookmark.beat);
  },
  nextBookmark: () => {
    const bookmark = editor.nextBookmark(1);
    if (bookmark !== undefined) editor.seek(bookmark.beat);
  },
  on: () => brushStart('on', 'включить'),
  flash: () => brushStart('flash', 'вспышка'),
  fade: () => brushStart('fade', 'угасание'),
  fadeIn: () => brushStart('fadeIn', 'нарастание'),
  left: () => brushColor('left', 'левый цвет'),
  right: () => brushColor('right', 'правый цвет'),
  white: () => brushColor('white', 'белый цвет'),
  undo: () => editor.undo(),
  redo: () => editor.redo(),
  copy: () => editor.copy(),
  cut: () => {
    editor.copy();
    editor.deleteSelection();
  },
  paste: () => editor.paste(editor.snapBeat(editor.playhead())),
  duplicate: () => editor.duplicateSelection(),
  delete: () => editor.deleteSelection(),
  selectAll: () => editor.selectAll(),
  mirror: () => {
    const moved = editor.mirrorAcrossRows();
    editor.setStatus(moved > 0 ? `Отзеркалено по строкам: ${String(moved)} событий` : 'Для зеркала по строкам выделите события на двух строках и больше');
  },
  mirrorTime: () => editor.mirrorInTime(),
  adjust: () => adjustDialog(editor),
  group: () => void timeline.groupSelected(),
  preset: () => void presets.saveSelection(),
  save: () => void save(),
  open: () => void openMapFolder().then(openFolder),
  new: () => void newMap(),
};
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (document.querySelector('.ce-shade') !== null) return;
  const typing = target.tagName === 'TEXTAREA' || (target instanceof HTMLInputElement && ['text', 'number', 'search'].includes(target.type));
  if (typing) return;
  const ctrl = event.ctrlKey || event.metaKey;
  if (target.tagName === 'SELECT' && !ctrl) return;
  if (event.code === 'Escape' && !ctrl) {
    if (editor.previewExtra !== null) editor.stopTrial();
    else if (editor.songRange !== null) editor.setSongRange(null);
    else if (editor.tool.kind !== 'clip') {
      editor.tool = { kind: 'clip' };
      library.render();
      editor.setStatus('Рисование обычного света');
    } else if (editor.selection.size > 0 && editor.openEffect === null) editor.select([]);
    else if (editor.openEffect !== null) editor.enterEffect(null);
    else if (editor.lightSelection.size > 0) editor.selectLights([]);
    else if (editor.focus !== null) editor.enterGroup(editor.focusPath().at(-2)?.id ?? null);
    event.preventDefault();
    return;
  }
  const combo = comboOf(event);
  const action = combo === null ? null : actionFor(combo);
  if (action === null) return;
  ACTIONS_RUN[action]?.();
  event.preventDefault();
});
byId('hotkeys').addEventListener('click', () => void hotkeysDialog());

// (a clicked button gives the focus back: Space is play, not "press that button again")
document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target instanceof HTMLButtonElement || (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'range' || target.type === 'color'))) target.blur();
});
document.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  if (target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === 'range')) target.blur();
});

// leaving with unsaved changes: the desktop window asks (electron/main.ts — it calls these two); a
// browser has only its own question
Object.assign(window, {
  chroeditorUnsaved: () => (editor.dirty && editor.project !== null ? `${editor.map?.parsed.mapMeta.title ?? ''} — ${editor.row?.label ?? ''}: изменения не сохранены.` : null),
  chroeditorSave: async () => {
    try {
      await editor.save();
      return !editor.dirty;
    } catch (error) {
      console.error(error);
      return false;
    }
  },
});
window.addEventListener('beforeunload', (event) => {
  if (!isDesktop() && editor.dirty) event.preventDefault();
});

// the splitter between the 3D view and the timeline
{
  const app = byId('app');
  const splitter = byId('splitter');
  let dragging = false;
  splitter.addEventListener('mousedown', () => (dragging = true));
  window.addEventListener('mouseup', () => (dragging = false));
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const bar = byId('toolbar').getBoundingClientRect().bottom;
    const top = Math.min(window.innerHeight - 220, Math.max(140, event.clientY - bar));
    app.style.gridTemplateRows = `auto ${String(top)}px 6px 1fr`;
  });
}

refreshToolbar();
