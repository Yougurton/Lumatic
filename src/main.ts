import { Editor } from './editor/editor';
import { Inspector } from './editor/inspector';
import { encodeOgg, findBpm } from './editor/audio-tools';
import { MiniMap } from './editor/minimap';
import { GlsEditor } from './editor/gls-editor';
import { RingEditor } from './editor/ring-editor';
import { Library } from './editor/library';
import { mapSettingsDialog } from './editor/map-settings';
import { newMapDialog } from './editor/new-map';
import { isDesktop, openMapFolder, openRecentFolder, recentFolders, type MapFolder } from './editor/platform';
import { Preview } from './editor/preview';
import { Timeline } from './editor/timeline';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const preview = new Preview(byId<HTMLCanvasElement>('preview'));
const editor = new Editor(preview);
const timeline = new Timeline(editor, byId('timeline'));
new Inspector(editor, byId('inspector'));
new MiniMap(editor, byId<HTMLCanvasElement>('minimap'));
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
  const folder = await newMapDialog(mapper);
  if (folder === null) return;
  editor.dirty = false;
  await openFolder(folder);
  editor.setStatus(`Карта создана: ${folder.name}`);
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
byId('undo').addEventListener('click', () => editor.undo());
byId('redo').addEventListener('click', () => editor.redo());
playButton.addEventListener('click', () => editor.togglePlay());
byId<HTMLSelectElement>('snap').addEventListener('change', (event) => {
  editor.snap = Number((event.target as HTMLSelectElement).value);
  timeline.redraw();
});
byId('zoom-in').addEventListener('click', () => timeline.zoom(1.5));
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

// (keys by their place on the keyboard — with a Russian layout Ctrl+Z is Ctrl+Я)
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (document.querySelector('.ce-shade') !== null) return;
  const typing = target.tagName === 'TEXTAREA' || (target instanceof HTMLInputElement && ['text', 'number', 'search'].includes(target.type));
  if (typing) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const code = event.code;
  if (target.tagName === 'SELECT' && !ctrl) return;
  if (ctrl && code === 'KeyO') void openMapFolder().then(openFolder);
  else if (ctrl && code === 'KeyN') void newMap();
  else if (ctrl && code === 'KeyS') void save();
  else if (ctrl && code === 'KeyZ' && !event.shiftKey) editor.undo();
  else if (ctrl && (code === 'KeyY' || (code === 'KeyZ' && event.shiftKey))) editor.redo();
  else if (ctrl && code === 'KeyC') editor.copy();
  else if (ctrl && code === 'KeyX') {
    editor.copy();
    editor.deleteSelection();
  } else if (ctrl && code === 'KeyV') editor.paste(editor.snapBeat(editor.playhead()));
  else if (ctrl && code === 'KeyD') editor.duplicateSelection();
  else if (ctrl && code === 'KeyA') editor.selectAll();
  else if (ctrl && code === 'KeyG') void timeline.groupSelected();
  else if (ctrl && event.shiftKey && code === 'KeyP') void presets.saveSelection();
  else if (ctrl) return;
  else if (code === 'Space') editor.togglePlay();
  else if (code === 'Delete' || code === 'Backspace') editor.deleteSelection();
  else if (code === 'Escape') {
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
  } else if (code === 'ArrowLeft' || code === 'ArrowRight') editor.seek(editor.snapBeat(editor.playhead()) + (code === 'ArrowLeft' ? -1 : 1) * (editor.snap || 0.25));
  else if (code === 'ArrowUp' || code === 'ArrowDown') timeline.scrollRows(code === 'ArrowUp' ? -60 : 60);
  else if (code === 'Home') editor.seek(0);
  else return;
  event.preventDefault();
});

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
    const top = Math.min(window.innerHeight - 220, Math.max(140, event.clientY - 40));
    app.style.gridTemplateRows = `40px ${String(top)}px 6px 1fr`;
  });
}

refreshToolbar();
