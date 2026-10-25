import { Editor } from './editor/editor';
import { Inspector } from './editor/inspector';
import { MiniMap } from './editor/minimap';
import { isDesktop, openMapFolder, openRecentFolder, recentFolders, type MapFolder } from './editor/platform';
import { Preview } from './editor/preview';
import { Timeline } from './editor/timeline';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const preview = new Preview(byId<HTMLCanvasElement>('preview'));
const editor = new Editor(preview);
const timeline = new Timeline(editor, byId('timeline'));
new Inspector(editor, byId('inspector'));
new MiniMap(editor, byId<HTMLCanvasElement>('minimap'));

// for tests and the console
(window as unknown as { chroeditor: unknown }).chroeditor = { editor, timeline, preview };

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

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (ctrl && key === 'o') void openMapFolder().then(openFolder);
  else if (ctrl && key === 's') void save();
  else if (ctrl && key === 'z' && !event.shiftKey) editor.undo();
  else if (ctrl && (key === 'y' || (key === 'z' && event.shiftKey))) editor.redo();
  else if (ctrl && key === 'c') editor.copy();
  else if (ctrl && key === 'x') {
    editor.copy();
    editor.deleteSelection();
  } else if (ctrl && key === 'v') editor.paste(editor.snapBeat(editor.playhead()));
  else if (ctrl && key === 'd') editor.duplicateSelection();
  else if (ctrl && key === 'a') editor.selectAll();
  else if (key === ' ') editor.togglePlay();
  else if (key === 'delete' || key === 'backspace') editor.deleteSelection();
  else if (key === 'escape') editor.select([]);
  else if (key === 'arrowleft' || key === 'arrowright') editor.seek(editor.snapBeat(editor.playhead()) + (key === 'arrowleft' ? -1 : 1) * (editor.snap || 0.25));
  else if (key === 'home') editor.seek(0);
  else return;
  event.preventDefault();
});

window.addEventListener('beforeunload', (event) => {
  if (editor.dirty) event.preventDefault();
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
