import { FlyCamera } from './editor/fly-camera';
import { Preview } from './editor/preview';
import type { PreviewSnapshot, PreviewTick, RemoteEditorSnapshot } from './editor/preview-state';
import { createRemoteEditor } from './editor/remote-editor';
import { actionFor, comboOf } from './editor/hotkeys';
import { NoteTrack, TRACK_POSE } from './editor/note-track';
import { EnvView } from './editor/env-view';
import { onSettings, setSettings, settings } from './editor/settings';
import { beatsLabel, GRIDS } from './editor/grids';
import { SmoothScroll } from './editor/smooth-scroll';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = byId<HTMLCanvasElement>('preview');
const status = byId('status');
const preview = new Preview(canvas);
const fly = new FlyCamera(preview, canvas, (text) => {
  status.textContent = text;
  window.setTimeout(() => {
    if (status.textContent === text) status.textContent = '';
  }, 1800);
});
byId('view-reset').addEventListener('click', () => fly.reset());

const api = window.chroeditorNative?.preview;
const remote = createRemoteEditor(preview, (patch) => api?.patch(patch));
const noteTrack = new NoteTrack(remote.editor, canvas);
const envView = new EnvView(remote.editor, canvas);
new SmoothScroll(remote.editor, canvas, () => current?.tab === 'notes' && current.noteView === 'game' && current.project !== null);
fly.onRightClick = (x, y) => noteTrack.rightClick(x, y);
let current: RemoteEditorSnapshot | null = null;
let homeSet = false;

function syncViewTools() {
  byId('track-title').textContent = current?.viewTitle ?? '';
  byId('view-lights').classList.toggle('active', settings().previewLights);
  byId('view-notes').classList.toggle('active', current?.tab === 'notes' || settings().notes);
  byId<HTMLButtonElement>('view-notes').disabled = current?.tab === 'notes';
  const mode = byId('view-mode');
  mode.hidden = current?.tab !== 'notes';
  mode.textContent = current?.noteView === 'track' ? '🎮 Как в игре' : '🛤 Дорожка';
  const grid = current?.snap ?? 0.25;
  const view = current?.viewSnap ?? null;
  const name = (value: number) => GRIDS.find(([known]) => Math.abs(known - value) < 1e-9)?.[1] ?? (value > 0 ? beatsLabel(value) : 'нет');
  byId('grid-badge').querySelector<HTMLElement>('.gb-value')!.textContent = view === null ? name(grid) : `${name(grid)} → ${name(view)}`;
}
onSettings(syncViewTools);
byId('view-lights').addEventListener('click', () => {
  const value = !settings().previewLights;
  setSettings({ previewLights: value });
  api?.patch({ options: { previewLights: value } });
});
byId('view-notes').addEventListener('click', () => {
  const value = !settings().notes;
  setSettings({ notes: value });
  api?.patch({ options: { notes: value } });
});
byId('view-mode').addEventListener('click', () => {
  if (current !== null) remote.editor.noteView = current.noteView === 'track' ? 'game' : 'track';
});

let applying: Promise<void> = Promise.resolve();
api?.onSnapshot((state: PreviewSnapshot) => {
  applying = applying
    .then(async () => {
      await preview.applySnapshot(state);
      if (state.editor !== undefined) {
        current = state.editor.state;
        remote.applySnapshot(current);
        const track = current.tab === 'notes' && current.noteView === 'track';
        noteTrack.setActive(track);
        fly.setHome(track ? TRACK_POSE : null, homeSet);
        homeSet = true;
      }
      syncViewTools();
    })
    .catch((error: unknown) => {
      console.error('[lumatic] detached preview update failed', error);
      status.textContent = `Ошибка обновления 3D: ${error instanceof Error ? error.message : String(error)}`;
    });
});
let lastTick: PreviewTick | null = null;
api?.onTick((state) => {
  lastTick = state;
  preview.applyTick(state);
  remote.applyTick(state);
});

const held = new Set<string>();
window.addEventListener('blur', () => {
  for (const code of held) api?.keyState(code, false);
  held.clear();
});
window.addEventListener('keyup', (event) => {
  held.delete(event.code);
  api?.keyState(event.code, false);
});
window.addEventListener(
  'keydown',
  (event) => {
    held.add(event.code);
    api?.keyState(event.code, true);
    const target = event.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || (target instanceof HTMLInputElement && ['text', 'number', 'search'].includes(target.type))) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const action = event.code === 'Escape' && !ctrl ? 'escape' : actionFor(comboOf(event) ?? '', current?.tab);
    if (action === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (action === 'play' && lastTick !== null) {
      const playing = !lastTick.playing;
      lastTick = { ...lastTick, playing, beatRate: playing ? (current?.songBpm ?? 120) / 60 : 0 };
      preview.applyTick(lastTick);
      remote.applyTick(lastTick);
    } else if (action === 'finer' || action === 'coarser') {
      remote.editor.stepSnap?.(action === 'finer');
      if (current !== null) current.snap = remote.editor.snap;
      syncViewTools();
      return;
    } else if (action === 'precision') {
      remote.editor.precision = !remote.editor.precision;
      if (current !== null) current.precision = remote.editor.precision;
      return;
    }
    api?.hotkey(action);
  },
  true,
);

const topButton = byId<HTMLButtonElement>('view-top');
let alwaysOnTop = false;
function showAlwaysOnTop(value: boolean) {
  alwaysOnTop = value;
  topButton.classList.toggle('active', value);
  topButton.title = value ? 'Окно закреплено поверх других. Открепить' : 'Держать 3D-окно поверх других окон';
}
api?.onAlwaysOnTop(showAlwaysOnTop);
topButton.addEventListener('click', () => {
  if (api !== undefined) void api.setAlwaysOnTop(!alwaysOnTop).then(showAlwaysOnTop);
});
byId('view-attach').addEventListener('click', () => api?.close());

let fpsFrames = 0;
let fpsSince = performance.now();
function countFps(now: number) {
  fpsFrames++;
  if (now - fpsSince >= 500) {
    const label = byId('fps');
    label.hidden = !settings().fps;
    if (settings().fps) label.textContent = `${String(Math.round((fpsFrames * 1000) / (now - fpsSince)))} FPS`;
    fpsFrames = 0;
    fpsSince = now;
  }
  requestAnimationFrame(countFps);
}
requestAnimationFrame(countFps);
if (api === undefined) status.textContent = 'Отдельный 3D-вид доступен в приложении Lumatic';
else api.ready();

(window as unknown as { chroeditorDetached: unknown }).chroeditorDetached = { preview, fly, remote, noteTrack, envView };
