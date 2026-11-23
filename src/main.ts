import { Editor } from './editor/editor';
import { refreshGameEnvironments } from './editor/game-environments';
import { Inspector } from './editor/inspector';
import { encodeOgg, findBpm } from './editor/audio-tools';
import { GlsEditor } from './editor/gls-editor';
import { RingEditor } from './editor/ring-editor';
import { Library } from './editor/library';
import { mapSettingsDialog } from './editor/map-settings';
import { colorsDialog } from './editor/colors-dialog';
import { environmentDialog } from './editor/environment-dialog';
import { newMapDialog } from './editor/new-map';
import { mapLibraryDialog } from './editor/map-library';
import { canSendToQuest, questDialog } from './editor/quest-dialog';
import { copyMapToWip, isDesktop, openMapFolder, openRecentFolder, recentFolders, saveFileAs, type MapFolder } from './editor/platform';
import { Preview } from './editor/preview';
import { MAX_RATE, MIN_RATE, Timeline } from './editor/timeline';
import { adjustDialog } from './editor/adjust-dialog';
import { actionFor, comboOf } from './editor/hotkeys';
import { ask, choose } from './editor/menu';
import type { StartMode } from './editor/model';
import { installTranslation, language, tr } from './editor/i18n';
import { Clicks } from './editor/clicks';
import { onSettings, settings } from './editor/settings';
import { beatsLabel, GRIDS } from './editor/grids';
import { settingsDialog } from './editor/settings-dialog';
import { setRingTickRate } from './engine/core/lighting/ring-motion';
import { NotePanel } from './editor/note-panel';
import { NoteInspector } from './editor/note-inspector';
import { FlyCamera } from './editor/fly-camera';
import { DetachedPreview } from './editor/detached-preview';
import { packForBeatSaver, packName } from './editor/beatsaver';
import { startUpdates } from './editor/updates';
import { EnvPanel, SHAPE_NAMES } from './editor/env-panel';
import { EnvView, type GizmoMode } from './editor/env-view';
import { SHAPES } from './editor/environment-mods';
import { showMenu } from './editor/menu';
import { SmoothScroll } from './editor/smooth-scroll';
import { NoteTrack, TRACK_POSE } from './editor/note-track';
import { mirrorObjects } from './editor/notes-timeline';
import { setSettings } from './editor/settings';

// (the rings ticking as often as the settings say the game's do)
setRingTickRate(settings().ringTicks);

// (in English: everything shown from here on goes through the dictionary)
installTranslation();
window.chroeditorNative?.setLanguage?.(language());

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const preview = new Preview(byId<HTMLCanvasElement>('preview'));
const editor = new Editor(preview);
// (the environments made from the user's game: known before a map is opened)
void refreshGameEnvironments();
const timeline = new Timeline(editor, byId('timeline'));
new Inspector(editor, byId('inspector'));
const library = new Library(editor, byId('library'));
const presets = library.presets;
new GlsEditor(editor);
new RingEditor(editor);
new NotePanel(editor, byId('note-panel'));
new NoteInspector(editor, byId('note-inspector'));

// ----- the two sides: the lights and the notes ---------------------------------------------------------

/** `environment`: the lights' side with the scene's tree and an object's settings in place of the
 *  effects and the events' ones. */
function syncInspectorPlacement(environment: boolean, detached: boolean) {
  const inspectors = [byId('inspector'), byId('note-inspector'), byId('env-inspector')];
  if (environment || detached) byId('side').append(...inspectors);
  else byId('timeline').append(...inspectors);
}
function setTab(tab: 'lights' | 'notes', environment = false) {
  document.body.classList.toggle('notes-tab', tab === 'notes');
  document.body.classList.toggle('env-tab', environment);
  byId('tab-lights').classList.toggle('active', tab === 'lights' && !environment);
  byId('tab-notes').classList.toggle('active', tab === 'notes');
  byId('tab-env').classList.toggle('active', environment);
  syncInspectorPlacement(environment, detachedPreview.active);
  editor.setEnvMode(environment);
  editor.setTab(tab);
  applySplit();
  applyNoteView();
  timeline.renderHeaders(true);
  timeline.redraw();
}
byId('tab-lights').addEventListener('click', () => setTab('lights'));
byId('tab-notes').addEventListener('click', () => setTab('notes'));
byId('tab-env').addEventListener('click', () => setTab('lights', true));
// ----- over the 3D view: the lights and the notes at a click, the camera flown back ------------------

const fly = new FlyCamera(preview, byId<HTMLCanvasElement>('preview'), (text) => editor.setStatus(text));
const remotePreviewState = () => ({
  revision: [preview.revision, editor.noteVersion, editor.version, editor.tab, editor.noteView, editor.envMode, editor.snap, editor.viewSnap ?? '', [...editor.noteSelection].join(','), editor.envSelection.join(','), [...editor.animSelection].join(','), editor.precision, editor.animAuto].join('|'),
  state: {
    viewTitle: editor.map === null || editor.row === null ? '' : `${editor.map.parsed.mapMeta.title} — ${editor.row.label} (${editor.row.environmentId ?? editor.project?.environment ?? 'DefaultEnvironment'})`,
    project: editor.project === null ? null : { environmentMods: editor.project.environmentMods },
    objects: editor.objects,
    fakeWalls: editor.fakeWalls,
    infoDifficulty: editor.row?.infoDifficulty ?? null,
    songBpm: editor.songBpm,
    bpmEvents: editor.bpmEvents,
    tab: editor.tab,
    noteView: editor.noteView,
    noteVersion: editor.noteVersion,
    noteSelection: [...editor.noteSelection],
    noteTool: editor.noteTool,
    noteRow: editor.noteRow,
    wallKind: editor.wallKind,
    wallStrobe: editor.wallStrobe,
    precision: editor.precision,
    snap: editor.snap,
    viewSnap: editor.viewSnap,
    envMode: editor.envMode,
    envSelection: editor.envSelection,
    envSceneData: editor.envSceneData,
    version: editor.version,
    animAuto: editor.animAuto,
    animSelection: [...editor.animSelection],
    linkPicking: editor.linkPicking,
  },
});
const detachedPreview = new DetachedPreview(preview, () => editor.playhead(), () => editor.isPlaying(), () => (editor.bpmAt(editor.playhead()) * editor.rate) / 60, remotePreviewState, (detached) => {
  document.body.classList.toggle('detached-preview', detached);
  byId('preview-attach').hidden = !detached;
  syncInspectorPlacement(editor.envMode, detached);
  timeline.setFillSpace(detached);
  applySplit();
});
window.chroeditorNative?.preview?.onPatch((patch) => {
  if (patch.options !== undefined) setSettings(patch.options);
  if (patch.values !== undefined) {
    const { noteView, ...values } = patch.values;
    Object.assign(editor, values);
    if (noteView !== undefined) {
      editor.noteView = noteView;
      applyNoteView(true);
    }
    editor.emit('selection');
  }
  if (patch.objects !== undefined) {
    editor.noteCheckpoint('detached');
    editor.objects = patch.objects;
    if (patch.noteSelection !== undefined) editor.noteSelection = new Set(patch.noteSelection);
    editor.notesChanged(true);
  } else if (patch.noteSelection !== undefined) editor.selectNotes(patch.noteSelection);
  if (patch.envSelection !== undefined) editor.selectEnv(patch.envSelection);
  if (patch.animSelection !== undefined) editor.selectAnimKeys(patch.animSelection);
  if (patch.environmentMods !== undefined && editor.project !== null) {
    editor.checkpoint();
    editor.project.environmentMods = patch.environmentMods;
    editor.dirty = true;
    editor.version++;
    void editor.previewEnvironmentMods(patch.environmentMods).then(() => editor.emit('selection'));
  }
  if (patch.seek !== undefined) editor.seek(patch.seek);
  if (patch.snapStep !== undefined) editor.stepSnap?.(patch.snapStep);
  if (patch.status !== undefined) editor.setStatus(patch.status);
});
byId('view-detach').hidden = !detachedPreview.available;
byId('view-detach').addEventListener('click', () => {
  void detachedPreview.detach().catch((error: unknown) => editor.setStatus(`Не удалось открепить 3D-вид: ${error instanceof Error ? error.message : String(error)}`));
});
byId('preview-attach').addEventListener('click', () => detachedPreview.close());
function syncViewTools() {
  byId('view-lights').classList.toggle('active', settings().previewLights);
  byId('view-lights').title = settings().previewLights ? 'Свет карты в 3D включён. Выключить: все лампы будут гореть белым на 30 %' : 'Свет карты в 3D выключен: лампы горят белым на 30 %. Включить';
  const notesShown = editor.tab === 'notes' || settings().notes;
  byId('view-notes').classList.toggle('active', notesShown);
  (byId('view-notes') as HTMLButtonElement).disabled = editor.tab === 'notes';
  byId('view-notes').title = editor.tab === 'notes' ? 'На вкладке «Ноты» ноты видны всегда' : settings().notes ? 'Ноты, бомбы и стены в 3D видны. Скрыть' : 'Показать ноты, бомбы и стены в 3D';
  byId('view-reset').hidden = !fly.isFree;
  const mode = byId('view-mode');
  mode.hidden = editor.tab !== 'notes';
  mode.textContent = editor.noteView === 'track' ? '🎮 Как в игре' : '🛤 Дорожка';
  mode.title = editor.noteView === 'track' ? 'Показать ноты как в игре: они летят к игроку' : 'Вернуть дорожку редактора: ноты стоят вдоль неё, ставятся на стену у курсора';
}
byId('view-lights').addEventListener('click', () => setSettings({ previewLights: !settings().previewLights }));
byId('view-notes').addEventListener('click', () => setSettings({ notes: !settings().notes }));
byId('view-reset').addEventListener('click', () => fly.reset());
fly.onChange(syncViewTools);
const noteTrack = new NoteTrack(editor, byId<HTMLCanvasElement>('preview'));
// the Environment side: the scene's tree and settings, picking and handles in the 3D view
const envPanel = new EnvPanel(editor, byId('env-scene'), byId('env-inspector'));
const envView = new EnvView(editor, byId<HTMLCanvasElement>('preview'));
envView.onPick = (key) => envPanel.reveal(key);
editor.showMaterial = (name) => envPanel.openMaterial(name);
editor.showInScene = (keys) => {
  setTab('lights', true);
  editor.selectEnv(keys);
  if (keys[0] !== undefined) envPanel.reveal(keys[0]);
};
envPanel.placeAhead = () => envView.placeAhead();
envView.onMode = () => {
  for (const button of byId('env-tools-main').querySelectorAll<HTMLButtonElement>('button[data-mode]')) button.classList.toggle('active', button.dataset.mode === envView.mode);
  byId('env-snap').classList.toggle('active', envView.snap);
};
for (const button of byId('env-tools-main').querySelectorAll<HTMLButtonElement>('button[data-mode]')) button.addEventListener('click', () => envView.setMode(button.dataset.mode as GizmoMode));
byId('env-snap').addEventListener('click', () => envView.setSnap(!envView.snap));
byId('env-auto').addEventListener('click', () => {
  editor.animAuto = !editor.animAuto;
  byId('env-auto').classList.toggle('active', editor.animAuto);
  editor.setStatus(tr(editor.animAuto ? 'Автоключ включён: любое изменение положения, поворота или масштаба ставит ключ на текущей доле' : 'Автоключ выключен: меняется исходное положение объекта (у уже анимированного свойства — ключ на текущей доле)'));
});
byId('env-add').addEventListener('click', (event) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 2, SHAPES.map((shape) => ({ label: SHAPE_NAMES[shape], action: () => envPanel.addShape(shape, false) })));
});
byId('env-add-light').addEventListener('click', () => envPanel.addShape('Cube', true));
// (on the Environment side: Ctrl+D copies what's picked, Delete removes it — before the lights' keys)
window.addEventListener(
  'keydown',
  (event) => {
    if (!editor.envMode || editor.project === null || document.querySelector('.ce-shade') !== null) return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.code === 'KeyC' && editor.animSelection.size > 0) editor.copyAnimKeys();
    else if (ctrl && event.code === 'KeyV' && editor.pasteAnimKeys()) void 0;
    else if (ctrl && event.code === 'KeyD') envPanel.copy();
    else if (!ctrl && (event.code === 'Delete' || event.code === 'Backspace')) {
      // (keys or a motion picked on the timeline: they go first, not the object)
      if (editor.animSelection.size > 0) editor.removeAnimKeys(new Set(editor.animSelection));
      else if (editor.motionSelection !== null) editor.removeMotion(editor.motionSelection);
      else envPanel.remove();
    } else if (!ctrl && event.code === 'KeyK' && editor.envSelection.length > 0) editor.addAnimKeys(editor.envSelection, [envView.mode === 'rotate' ? 'rotation' : envView.mode === 'scale' ? 'scale' : 'position']);
    else if (!ctrl && event.code === 'Escape' && editor.linkPicking !== null) {
      editor.linkPicking = null;
      editor.setStatus(tr('Привязка отменена'));
      editor.emit('selection');
    } else if (!ctrl && event.code === 'Escape' && editor.animSelection.size > 0) editor.selectAnimKeys([]);
    else if (!ctrl && event.code === 'Escape' && editor.envSelection.length > 0) editor.selectEnv([]);
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);
// (the game's view of the notes side: the wheel takes the song on or back smoothly)
new SmoothScroll(editor, byId<HTMLCanvasElement>('preview'), () => editor.tab === 'notes' && editor.noteView === 'game' && editor.project !== null);
/** The notes side's 3D view: the editor's track (the camera behind its wall) or the game's view.
 *  `keep`: the camera stays where it is (switching between the track and the game's view). */
function applyNoteView(keep = false) {
  const track = editor.tab === 'notes' && editor.noteView === 'track';
  noteTrack.setActive(track);
  // (the notes side: its track's field of view in the game's view too; the lights side its own)
  preview.view.setHorizontalFov(editor.tab === 'notes' ? 80 : null);
  fly.setHome(track ? TRACK_POSE : null, keep);
  editor.rebuildPreview(true);
  syncViewTools();
}
byId('view-mode').addEventListener('click', () => {
  editor.noteView = editor.noteView === 'track' ? 'game' : 'track';
  applyNoteView(true);
});
fly.onRightClick = (x, y) => noteTrack.rightClick(x, y);
editor.stepSnap = (finer) => stepGrid(finer);
syncViewTools();

// for tests and the console
(window as unknown as { chroeditor: unknown }).chroeditor = { editor, timeline, preview, presets, library, noteTrack, audio: { findBpm, encodeOgg } };

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
  saveButton.disabled = editor.project === null || editor.map?.folder.readOnly === true;
  saveButton.title = editor.map?.folder.readOnly === true ? 'CustomLevels открыт только для чтения: при редактировании будет предложена копия в CustomWIPLevels' : '';
  byId<HTMLButtonElement>('settings').disabled = editor.project === null;
  byId<HTMLButtonElement>('beatsaver').disabled = editor.project === null;
  byId<HTMLButtonElement>('quest').disabled = editor.project === null;
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

/** What's selected and what's copied, in sight on the toolbar (looked at every frame — drawn only when
 *  it changes). */
const selectionInfo = byId('selection-info');
const clipboardInfo = byId('clipboard-info');
let shownInfo = '';
function showSelection() {
  const notes = editor.tab === 'notes';
  const selected = notes ? editor.noteSelection.size : editor.selection.size;
  const board = notes ? (editor.notesClipboardSize() > 0 ? { count: editor.notesClipboardSize(), rows: 1 } : null) : editor.clipboardInfo();
  const key = `${String(notes)}|${String(selected)}|${board === null ? '' : `${String(board.count)}/${String(board.rows)}`}`;
  if (key === shownInfo) return;
  shownInfo = key;
  selectionInfo.hidden = selected === 0;
  selectionInfo.textContent = tr('▣ Выделено: {0}', selected);
  selectionInfo.title = notes ? tr('Выделено объектов: {0}. Esc — снять выделение', selected) : tr('Выделено событий: {0}. Esc — снять выделение', selected);
  clipboardInfo.hidden = board === null || board.count === 0;
  if (board !== null) {
    clipboardInfo.textContent = board.rows > 1 ? tr('📋 В буфере: {0} ({1} стр.)', board.count, board.rows) : tr('📋 В буфере: {0}', board.count);
    clipboardInfo.title = tr('Скопировано: {0}. Ctrl+V — вставить, правый клик по пустому месту таймлайна — куда вставить', board.count);
  }
}

// frames a second, counted over the last half second (the 3D view draws once a frame)
const fpsLabel = byId('fps');
let fpsFrames = 0;
let fpsSince = performance.now();
function countFrame(now: number) {
  fpsFrames++;
  if (now - fpsSince < 500) return;
  const on = settings().fps;
  fpsLabel.hidden = !on;
  if (on) fpsLabel.textContent = `${String(Math.round((fpsFrames * 1000) / (now - fpsSince)))} FPS`;
  fpsFrames = 0;
  fpsSince = now;
}

// the grid in big figures in the 3D view's lower left: bright for a moment when it changes, dimmed after
const gridBadge = byId('grid-badge');
const gridValue = gridBadge.querySelector<HTMLElement>('.gb-value')!;
let shownGrid = Number.NaN;
let gridFade = 0;
let shownView: number | null = null;
function showGrid() {
  const grid = editor.snap;
  const view = editor.viewSnap;
  if (grid === shownGrid && view === shownView) return;
  const first = Number.isNaN(shownGrid);
  const changed = grid !== shownGrid;
  shownGrid = grid;
  shownView = view;
  const name = (value: number) => GRIDS.find(([known]) => Math.abs(known - value) < 1e-9)?.[1] ?? (value > 0 ? beatsLabel(value) : tr('нет'));
  // (the timeline seen from far: events go on the grid that shows there)
  gridValue.textContent = view === null ? name(grid) : `${name(grid)} → ${name(view)}`;
  gridBadge.title = view === null ? '' : tr('Таймлайн отдалён: события ставятся и двигаются по видимой сетке ({0})', name(view));
  if (first || !changed) return;
  // (the drums of beats everywhere step by the grid: drawn again)
  editor.emit('grid');
  gridBadge.classList.add('changed');
  window.clearTimeout(gridFade);
  gridFade = window.setTimeout(() => gridBadge.classList.remove('changed'), 900);
}

// the song's speed over the grid, when it isn't the usual
const speedBadge = byId('speed-badge');
let shownRate = Number.NaN;
function showRate() {
  if (editor.rate === shownRate) return;
  shownRate = editor.rate;
  speedBadge.hidden = Math.abs(shownRate - 1) < 1e-6;
  speedBadge.textContent = `${String(Math.round(shownRate * 100))}%`;
}

function tick(now: number) {
  countFrame(now);
  detachedPreview.tick(now);
  showGrid();
  showRate();
  editor.tickTrial();
  const seconds = editor.clock?.currentTime() ?? 0;
  timeLabel.textContent = tr('{0} · доля {1}', formatTime(seconds), editor.playhead().toFixed(3));
  playButton.textContent = editor.isPlaying() ? '❚❚' : '▶';
  showSelection();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

editor.onChange(() => refreshToolbar());

async function openFolder(folder: MapFolder | null) {
  if (folder === null) return;
  if (editor.dirty && !window.confirm('Несохранённые изменения пропадут. Открыть другую карту?')) return;
  try {
    timeline.saveView();
    await editor.open(folder);
    timeline.restoreView();
    void refreshRecent();
  } catch (error) {
    console.error(error);
    editor.setStatus(`Не удалось открыть: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let copyingMap = false;
editor.onDirty = () => {
  const map = editor.map;
  if (map?.folder.readOnly !== true || copyingMap) return;
  copyingMap = true;
  const original = map.folder;
  void (async () => {
    const answer = await choose(
      'Чужая карта из CustomLevels',
      'Она открыта только для чтения. Создать копию в CustomWIPLevels и редактировать уже её? Оригинал не будет изменён.',
      ['Создать копию в CustomWIPLevels', 'Отмена'],
    );
    try {
      if (answer === 0) {
        const copy = await copyMapToWip(original.name, settings().mapFolder || settings().gameFolder);
        if (copy === null) throw new Error('не удалось создать копию');
        map.folder = copy;
        editor.setStatus(`Создана копия в CustomWIPLevels: ${copy.name}`);
      } else {
        timeline.saveView();
        await editor.open(original);
        timeline.restoreView();
      }
    } catch (error) {
      console.error(error);
      editor.setStatus(`Не удалось создать копию: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      copyingMap = false;
    }
  })();
};

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

byId('open').addEventListener('click', () => {
  if (isDesktop()) void mapLibraryDialog(openFolder);
  else void openMapFolder().then(openFolder);
});
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
  if (path !== '') void openRecentFolder(path, settings().mapFolder || settings().gameFolder).then(openFolder);
});
difficultySelect.addEventListener('change', () => {
  const row = editor.difficulties().find((item) => item.key === difficultySelect.value);
  if (row === undefined) return;
  if (editor.dirty && !window.confirm('Несохранённые изменения пропадут. Переключить сложность?')) {
    refreshToolbar();
    return;
  }
  timeline.saveView();
  void editor.openDifficulty(row).then(() => timeline.restoreView());
});
// (where the timeline is: kept now and then, and when the window closes)
window.setInterval(() => timeline.saveView(), 2000);
window.addEventListener('beforeunload', () => timeline.saveView());
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
byId('quest').hidden = !canSendToQuest();
byId('quest').addEventListener('click', () => questDialog(editor, save));

async function save() {
  try {
    await editor.save();
  } catch (error) {
    console.error(error);
    editor.setStatus(`Не сохранено: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** What goes into the BeatSaver zip besides the map (null: cancelled): Lumatic's projects, the choice
 *  remembered. */
function packOptions(): Promise<{ lumatic: boolean } | null> {
  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'ce-shade';
    const box = document.createElement('div');
    box.className = 'ce-dialog adjust-dialog';
    box.innerHTML = `
      <div class="ce-dialog-title">Архив для BeatSaver</div>
      <div class="nm-dim">Карта сохранится, в архив попадут Info.dat и файлы, на которые он указывает: песня, обложка, сложности.</div>
      <label class="adjust-check"><input type="checkbox" data-id="lumatic"> Добавить файлы Lumatic (проекты сложностей: эффекты, группы, кольца — чтобы продолжить работу в Lumatic)</label>
      <div class="ce-dialog-buttons"><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="pack">Собрать</button></div>`;
    shade.append(box);
    document.body.append(shade);
    const check = box.querySelector<HTMLInputElement>('[data-id="lumatic"]')!;
    check.checked = settings().packLumatic;
    const close = (result: { lumatic: boolean } | null) => {
      shade.remove();
      window.removeEventListener('keydown', keys, true);
      resolve(result);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(null);
      } else if (event.key === 'Enter') {
        event.stopPropagation();
        box.querySelector<HTMLButtonElement>('[data-id="pack"]')!.click();
      }
    };
    window.addEventListener('keydown', keys, true);
    box.querySelector('[data-id="cancel"]')!.addEventListener('click', () => close(null));
    box.querySelector('[data-id="pack"]')!.addEventListener('click', () => {
      setSettings({ packLumatic: check.checked });
      close({ lumatic: check.checked });
    });
  });
}

/** The map packed for BeatSaver: saved first, then Info.dat and what it points to in a zip where the
 *  user picks. */
async function exportBeatSaver() {
  const map = editor.map;
  if (map === null) return;
  const options = await packOptions();
  if (options === null) return;
  try {
    if (editor.dirty) await editor.save();
    editor.setStatus(tr('Собираю архив для BeatSaver…'));
    const pack = await packForBeatSaver(map.folder.files, (name) => map.folder.readBinary(name), options);
    if (pack.missing.length > 0 && !window.confirm(tr('Info.dat указывает на файлы, которых нет в папке: {0}. Всё равно собрать архив?', pack.missing.join(', ')))) {
      editor.setStatus(tr('Архив не собран'));
      return;
    }
    const infoName = map.folder.files.find((name) => name.toLowerCase() === 'info.dat')!;
    const where = await saveFileAs(packName(await map.folder.readText(infoName)), pack.data, 'Zip', ['zip']);
    if (where === null) {
      editor.setStatus(tr('Архив не собран'));
      return;
    }
    const size = (pack.data.byteLength / 1024 / 1024).toFixed(1);
    editor.setStatus(tr('Архив для BeatSaver: {0} ({1} МБ, файлов: {2})', where, size, pack.files.length));
    if (pack.warnings.length > 0) window.alert(`${tr('Архив сохранён, но BeatSaver может быть недоволен:')}\n\n${pack.warnings.map((line) => `• ${line}`).join('\n')}`);
  } catch (error) {
    console.error(error);
    editor.setStatus(tr('Архив не собран: {0}', error instanceof Error ? error.message : String(error)));
  }
}
byId('beatsaver').addEventListener('click', () => void exportBeatSaver());
// (what's new after an update; a newer version asked about)
startUpdates(editor);

// ----- the settings (settings.ts): what applies at once, the window, a restart for the rest ----------

new Clicks(editor);
const applyScale = () => window.chroeditorNative?.setZoom?.(settings().uiScale);
applyScale();
onSettings((now, before) => {
  if (now.volume !== before.volume) editor.clock?.setVolume(now.volume);
  if (now.uiScale !== before.uiScale) applyScale();
  if (now.notes !== before.notes || now.previewLights !== before.previewLights) editor.rebuildPreview(true);
  syncViewTools();
  if (now.ringTicks !== before.ringTicks) {
    setRingTickRate(now.ringTicks);
    editor.ringTimingChanged();
  }
  if (now.paste !== before.paste || now.follow !== before.follow) timeline.redraw();
});

/** The editor started again (the language, the reflections): with the same map and difficulty open
 *  when it can be (the desktop app), the changes saved first if the user wants. */
async function restart() {
  if (editor.dirty) {
    if (!window.confirm('Сохранить изменения и перезапустить редактор?')) return;
    await save();
    if (editor.dirty) return;
  }
  try {
    if (editor.map !== null && isDesktop()) sessionStorage.setItem(REOPEN, JSON.stringify({ folder: editor.map.folder.name, difficulty: editor.row?.key ?? '' }));
  } catch {
    // (opened again by hand then)
  }
  window.location.reload();
}
const REOPEN = 'lumatic.reopen';
{
  let again: { folder: string; difficulty: string } | null = null;
  try {
    again = JSON.parse(sessionStorage.getItem(REOPEN) ?? 'null') as typeof again;
    sessionStorage.removeItem(REOPEN);
  } catch {
    again = null;
  }
  if (again !== null) {
    const { folder, difficulty } = again;
    void openRecentFolder(folder, settings().mapFolder || settings().gameFolder)
      .then(openFolder)
      .then(async () => {
        const row = editor.difficulties().find((item) => item.key === difficulty);
        if (row !== undefined && row !== editor.row) await editor.openDifficulty(row);
        timeline.restoreView();
      });
  }
}
byId('app-settings').addEventListener('click', () => settingsDialog(() => void restart(), editor));

// the last moment the hands were on the mouse or the keys: saving waits for a pause in the work
// (a fifth of a second of a big map's saving, in the middle of a drag, is a freeze)
let lastInput = 0;
let buttonsDown = 0;
for (const name of ['keydown', 'pointerdown', 'pointermove', 'pointerup', 'wheel'] as const)
  window.addEventListener(
    name,
    (event) => {
      lastInput = performance.now();
      if (event instanceof PointerEvent) buttonsDown = event.buttons;
    },
    { capture: true, passive: true },
  );
window.addEventListener('blur', () => (buttonsDown = 0));
/** Nothing touched for a moment, no button held, the song not playing. */
const quietNow = () => buttonsDown === 0 && performance.now() - lastInput > 1500 && !editor.isPlaying();

// saved by itself every so many minutes while there are changes (not while a window is open or
// something is being tried; in a pause of the work)
{
  let dirtySince: number | null = null;
  let saving = false;
  window.setInterval(() => {
    const minutes = settings().autosave;
    if (!editor.dirty || editor.project === null || minutes <= 0) {
      dirtySince = null;
      return;
    }
    dirtySince ??= Date.now();
    const busy = saving || !quietNow() || document.querySelector('.ce-shade') !== null || editor.previewExtra !== null || editor.isTrying();
    if (busy || Date.now() - dirtySince < minutes * 60_000) return;
    saving = true;
    void save().finally(() => {
      saving = false;
      dirtySince = null;
    });
  }, 1000);
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
const stepGrid = (finer: boolean) => timeline.stepGrid(finer);
const stepRate = (up: boolean) => editor.stepRate(up);
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
  loop: () => editor.toggleLoop(),
  precision: () => editor.togglePrecision(),
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
  paste: () => {
    // (as the settings say: into the rows the events came from or the row under the mouse — the picked
    // row when the mouse isn't over the timeline; at the song cursor or the mouse)
    const { paste, pasteAt } = settings();
    const over = timeline.pointer();
    const at = editor.snapBeat(pasteAt === 'mouse' && over !== null ? over.beat : editor.playhead());
    editor.paste(at, paste === 'row' ? (over?.row ?? editor.libraryRow()?.key ?? null) : null);
  },
  duplicate: () => editor.duplicateSelection(),
  delete: () => editor.deleteSelection(),
  selectAll: () => editor.selectAll(),
  deselect: () => {
    editor.select([]);
    editor.selectLights([]);
  },
  mirror: () => {
    const moved = editor.mirrorAcrossRows();
    editor.setStatus(moved > 0 ? `Отзеркалено по строкам: ${String(moved)} событий` : 'Для зеркала по строкам выделите события на двух строках и больше');
  },
  mirrorTime: () => editor.mirrorInTime(),
  adjust: () => adjustDialog(editor),
  group: () => void timeline.groupSelected(),
  preset: () => void presets.saveSelection(),
  noteRed: () => noteKind('red'),
  noteBlue: () => noteKind('blue'),
  noteBomb: () => noteKind('bomb'),
  noteWall: () => noteKind('wall'),
  dirUp: () => editor.setNoteDirection(held.has('KeyA') ? 4 : held.has('KeyD') ? 5 : 0),
  dirDown: () => editor.setNoteDirection(held.has('KeyA') ? 6 : held.has('KeyD') ? 7 : 1),
  dirLeft: () => editor.setNoteDirection(held.has('KeyW') ? 4 : held.has('KeyS') ? 6 : 2),
  dirRight: () => editor.setNoteDirection(held.has('KeyW') ? 5 : held.has('KeyS') ? 7 : 3),
  dirUpLeft: () => editor.setNoteDirection(4),
  dirUpRight: () => editor.setNoteDirection(5),
  dirDownLeft: () => editor.setNoteDirection(6),
  dirDownRight: () => editor.setNoteDirection(7),
  dirDot: () => editor.setNoteDirection(8),
  swapColor: () =>
    editor.updateObjects(editor.noteSelection, (_kind, item) => {
      if ('c' in item) item.c = 1 - item.c;
    }),
  noteArc: () => void editor.makeArc(),
  noteChain: () => void editor.makeChain(),
  notesTab: () => setTab(editor.tab === 'notes' ? 'lights' : 'notes'),
  save: () => void save(),
  open: () => void openMapFolder().then(openFolder),
  new: () => void newMap(),
};
/** On the notes side the editing keys work on its objects. */
const NOTES_RUN: Record<string, () => void> = {
  copy: () => editor.copyNotes(),
  cut: () => editor.cutNotes(),
  paste: () => {
    const over = timeline.pointer();
    editor.pasteNotes(editor.snapBeat(settings().pasteAt === 'mouse' && over !== null ? over.beat : editor.playhead()));
  },
  duplicate: () => {
    editor.copyNotes();
    const picked = editor.selectedObjects();
    if (picked.length === 0) return;
    const last = Math.max(...picked.map(({ item }) => item.b));
    editor.pasteNotes(last + (editor.snap || 0.25));
  },
  delete: () => editor.deleteNoteSelection(),
  selectAll: () => editor.selectAllNotes(),
  deselect: () => editor.selectNotes([]),
  mirror: () => mirrorObjects(editor),
};

function noteKind(kind: 'red' | 'blue' | 'bomb' | 'wall') {
  editor.noteTool = { ...editor.noteTool, kind };
  // (notes picked: they take the colour)
  if ((kind === 'red' || kind === 'blue') && editor.noteSelection.size > 0) {
    editor.updateObjects(editor.noteSelection, (objectKind, item) => {
      if (objectKind === 'notes' && 'c' in item) item.c = kind === 'red' ? 0 : 1;
    });
  } else editor.emit('selection');
}

/** The direction keys held (two at once: a diagonal). */
const held = new Set<string>();
window.addEventListener('keydown', (event) => held.add(event.code));
window.addEventListener('keyup', (event) => held.delete(event.code));
window.addEventListener('blur', () => held.clear());

// the number pad types its digits in a field whether NumLock is on or not (off, its keys are arrows,
// Home, End… — and in a number field the arrows would change the number), its point a point in a
// number field (a Russian layout gives a comma there, which a number field won't take)
window.addEventListener(
  'keydown',
  (event) => {
    const target = event.target;
    const number = target instanceof HTMLInputElement && target.type === 'number';
    const text = target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && ['text', 'search'].includes(target.type));
    if ((!number && !text) || event.ctrlKey || event.metaKey || event.altKey) return;
    const char = /^Numpad(\d)$/u.exec(event.code)?.[1] ?? (number && event.code === 'NumpadDecimal' ? '.' : undefined);
    if (char === undefined || event.key === char) return;
    event.preventDefault();
    document.execCommand('insertText', false, char);
  },
  true,
);
function runEditorAction(action: string) {
  if (action === 'escape') {
    if (editor.tab === 'notes') {
      if (editor.previewExtra !== null) editor.stopTrial();
      else if (editor.songRange !== null) editor.setSongRange(null);
      else editor.selectNotes([]);
      return;
    }
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
    return;
  }
  if (editor.tab === 'notes' && NOTES_RUN[action] !== undefined) NOTES_RUN[action]();
  else ACTIONS_RUN[action]?.();
}
window.chroeditorNative?.preview?.onHotkey(runEditorAction);
window.chroeditorNative?.preview?.onKeyState((code, down) => {
  if (down) held.add(code);
  else held.delete(code);
});
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (document.querySelector('.ce-shade') !== null) return;
  const typing = target.tagName === 'TEXTAREA' || (target instanceof HTMLInputElement && ['text', 'number', 'search'].includes(target.type));
  if (typing) return;
  const ctrl = event.ctrlKey || event.metaKey;
  if (target.tagName === 'SELECT' && !ctrl) return;
  if (event.code === 'Escape' && !ctrl) {
    runEditorAction('escape');
    event.preventDefault();
    return;
  }
  const combo = comboOf(event);
  const action = combo === null ? null : actionFor(combo, editor.tab);
  if (action === null) return;
  runEditorAction(action);
  event.preventDefault();
});

// (a click anywhere else leaves the field being typed in — also on the timeline, which keeps the focus
// where it is: the panels are drawn again only once their fields are left)
window.addEventListener(
  'mousedown',
  (event) => {
    const active = document.activeElement;
    const typing = active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && ['text', 'number', 'search'].includes(active.type));
    if (typing && event.target instanceof Node && !active.contains(event.target)) active.blur();
  },
  true,
);

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

// a press on the timeline, the 3D view or any other drawing (not on a field): the field typed into
// before lets go of the keyboard — else Ctrl+Z and the other keys went on to it (several canvases stop
// the browser moving the focus themselves)
window.addEventListener(
  'mousedown',
  (event) => {
    const target = event.target as HTMLElement | null;
    const active = document.activeElement;
    if (target === null || !(active instanceof HTMLElement) || active === document.body) return;
    if (target.closest('input, textarea, select, [contenteditable="true"]') !== null || active.contains(target)) return;
    const editable = active instanceof HTMLInputElement ? !['button', 'checkbox', 'radio', 'range', 'color'].includes(active.type) : active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
    if (editable) active.blur();
  },
  true,
);

// unsaved changes copied aside every 2 minutes (Lumatic backups/autosave): a hang or a crash loses
// little — the map offers them back when it's opened next. In a pause of the work (else at most
// 3 minutes late: then at once)
{
  let lastCopy = performance.now();
  let copying = false;
  window.setInterval(() => {
    const since = performance.now() - lastCopy;
    if (copying || since < 120_000 || (!quietNow() && since < 300_000)) return;
    copying = true;
    lastCopy = performance.now();
    void editor
      .autosaveCopy()
      .catch((error: unknown) => console.warn('[lumatic] autosave failed', error))
      .finally(() => (copying = false));
  }, 1000);
}

// the desktop window: the keyboard back after the page's own confirm / alert boxes (Windows leaves
// the window looking focused while no field takes keys — a grey selection), and on a click into a
// page that has lost it
{
  const native = window.chroeditorNative;
  if (native?.refocus !== undefined) {
    const refocus = native.refocus;
    const confirmBox = window.confirm.bind(window);
    const alertBox = window.alert.bind(window);
    window.confirm = (message?: string) => {
      const answer = confirmBox(message);
      refocus();
      return answer;
    };
    window.alert = (message?: string) => {
      alertBox(message);
      refocus();
    };
    window.addEventListener('mousedown', () => {
      if (!document.hasFocus()) refocus();
    }, true);
  }
  // what goes wrong on the page: into the app's log too — and what was done just before (keys, buttons,
  // the status line), so a hang or an error can be traced back
  if (native?.log !== undefined) {
    const write = native.log;
    window.addEventListener(
      'keydown',
      (event) => {
        const target = event.target as HTMLElement;
        const typing = target instanceof HTMLInputElement && ['text', 'number', 'search'].includes(target.type);
        // (what's typed into fields isn't written: only the keys that do something)
        if (typing && !['Enter', 'Escape', 'Tab'].includes(event.key) && !event.ctrlKey) return;
        write('key', `${event.ctrlKey ? 'Ctrl+' : ''}${event.shiftKey ? 'Shift+' : ''}${event.altKey ? 'Alt+' : ''}${event.code}${typing ? ` in ${target.className || 'a field'}` : ''}`);
      },
      true,
    );
    window.addEventListener(
      'click',
      (event) => {
        const button = (event.target as HTMLElement | null)?.closest('button');
        if (button !== null && button !== undefined) write('click', (button.textContent ?? '').trim().slice(0, 60) || button.title.slice(0, 60) || button.className);
      },
      true,
    );
    editor.onStatus((text) => write('status', text));
    window.addEventListener('error', (event) => write('error', `${event.message} (${event.filename}:${String(event.lineno)})${event.error instanceof Error && event.error.stack !== undefined ? `\n${event.error.stack}` : ''}`));
    window.addEventListener('unhandledrejection', (event) => write('rejection', event.reason instanceof Error ? (event.reason.stack ?? event.reason.message) : String(event.reason)));
  }
  // started again after a hang or a crash: the map that was open, opened again
  const reopen = new URLSearchParams(window.location.search).get('reopen');
  if (reopen !== null && reopen !== '') void openRecentFolder(reopen, settings().mapFolder || settings().gameFolder).then(openFolder);
}

// the splitter between the 3D view and the timeline (where it is: kept for each side — the notes side
// gives the 3D view more room at first)
const SPLIT_KEY = 'lumatic.split';
function applySplit() {
  const app = byId('app');
  if (detachedPreview.active) {
    app.style.gridTemplateRows = 'auto 0 0 minmax(0, 1fr)';
    return;
  }
  let saved: Record<string, number> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? '{}') as Record<string, number>;
  } catch {
    saved = {};
  }
  const mode = editor.envMode ? 'scene' : editor.tab;
  const top = saved[mode];
  if (top !== undefined) app.style.gridTemplateRows = `auto ${String(Math.min(window.innerHeight - 220, Math.max(140, top)))}px 6px 1fr`;
  else if (editor.envMode) app.style.gridTemplateRows = 'auto minmax(120px, 32%) 6px 1fr';
  else app.style.gridTemplateRows = editor.tab === 'notes' ? 'auto minmax(160px, 62%) 6px 1fr' : '';
}
{
  const app = byId('app');
  const splitter = byId('splitter');
  let dragging = false;
  splitter.addEventListener('mousedown', () => (dragging = true));
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    try {
      const saved = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? '{}') as Record<string, number>;
      saved[editor.envMode ? 'scene' : editor.tab] = byId('preview-wrap').getBoundingClientRect().height;
      localStorage.setItem(SPLIT_KEY, JSON.stringify(saved));
    } catch {
      // (only a convenience)
    }
  });
  splitter.addEventListener('dblclick', () => {
    try {
      const saved = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? '{}') as Record<string, number>;
      delete saved[editor.envMode ? 'scene' : editor.tab];
      localStorage.setItem(SPLIT_KEY, JSON.stringify(saved));
    } catch {
      // (only a convenience)
    }
    applySplit();
  });
  splitter.title = 'Тяните, чтобы поменять высоту таймлайна (у света и у нот она своя); двойной клик — как было';
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const bar = byId('toolbar').getBoundingClientRect().bottom;
    const top = Math.min(window.innerHeight - 220, Math.max(140, event.clientY - bar));
    app.style.gridTemplateRows = `auto ${String(top)}px 6px 1fr`;
  });
}
applySplit();

refreshToolbar();

// (the notes side's track and camera too, for tests and the console)
Object.assign((window as unknown as { chroeditor: Record<string, unknown> }).chroeditor, { noteTrack, fly, detachedPreview });
