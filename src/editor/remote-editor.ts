import { Editor } from './editor';
import { nextGrid } from './grids';
import type { Preview } from './preview';
import type { PreviewTick, RemoteEditorPatch, RemoteEditorSnapshot } from './preview-state';

const NOTE_CHANGES = new Set(['addObjects', 'removeObjects', 'updateObjects', 'restrobe']);
const SCENE_CHANGES = new Set(['applyScene', 'setLinkParent']);
const FORWARDED_VALUES = new Set(['noteTool', 'noteRow', 'noteView', 'wallKind', 'wallStrobe', 'precision', 'animAuto', 'linkPicking']);
const LOCAL_ONLY = new Set(['rebuildPreview', 'showScene', 'previewEnvironmentMods']);

export function createRemoteEditor(preview: Preview, send: (patch: RemoteEditorPatch) => void) {
  const target = new Editor(preview);
  let applying = false;
  let beat = 0;
  let beatRate = 0;
  let beatAt = 0;
  let playing = false;
  let queued: RemoteEditorPatch | null = null;

  const queue = (patch: RemoteEditorPatch) => {
    if (applying) return;
    if (queued === null) {
      queued = {};
      queueMicrotask(() => {
        const next = queued;
        queued = null;
        if (next !== null) send(next);
      });
    }
    Object.assign(queued, patch);
    if (patch.values !== undefined) queued.values = { ...queued.values, ...patch.values };
  };

  const proxy = new Proxy(target, {
    get(editor, property, receiver) {
      if (property === 'playhead') return () => beat + ((performance.now() - beatAt) / 1000) * beatRate;
      if (property === 'isPlaying') return () => playing;
      const value = Reflect.get(editor, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (LOCAL_ONLY.has(String(property))) return () => undefined;
      return (...args: unknown[]) => {
        const result = (value as (...args: unknown[]) => unknown).apply(receiver, args);
        if (NOTE_CHANGES.has(String(property))) queue({ objects: editor.objects, noteSelection: [...editor.noteSelection] });
        else if (SCENE_CHANGES.has(String(property))) queue({ environmentMods: editor.project?.environmentMods ?? {} });
        else if (property === 'selectNotes') queue({ noteSelection: [...editor.noteSelection] });
        else if (property === 'selectEnv') queue({ envSelection: editor.envSelection });
        else if (property === 'selectAnimKeys') queue({ animSelection: [...editor.animSelection] });
        else if (property === 'seek') queue({ seek: args[0] as number });
        else if (property === 'setStatus') queue({ status: args[0] as string });
        return result;
      };
    },
    set(editor, property, value, receiver) {
      const result = Reflect.set(editor, property, value, receiver);
      if (FORWARDED_VALUES.has(String(property))) queue({ values: { [property]: value } });
      return result;
    },
  });

  target.stepSnap = (up) => {
    target.snap = nextGrid(target.snap, up);
    queue({ snapStep: up });
  };

  return {
    editor: proxy,
    applySnapshot(state: RemoteEditorSnapshot) {
      applying = true;
      try {
        target.project = state.project === null ? null : { format: 'lumatic', version: 1, difficulty: '', environment: '', clips: [], raw: [], expanded: [], environmentMods: state.project.environmentMods };
        target.objects = state.objects;
        target.fakeWalls = state.fakeWalls;
        target.row = state.infoDifficulty === null ? null : ({ infoDifficulty: state.infoDifficulty } as Editor['row']);
        target.songBpm = state.songBpm;
        target.bpmEvents = state.bpmEvents;
        target.tab = state.tab;
        target.noteView = state.noteView;
        target.noteVersion = state.noteVersion;
        target.noteSelection = new Set(state.noteSelection);
        target.noteTool = state.noteTool;
        target.noteRow = state.noteRow;
        target.wallKind = state.wallKind;
        target.wallStrobe = state.wallStrobe;
        target.precision = state.precision;
        target.snap = state.snap;
        target.viewSnap = state.viewSnap;
        target.envMode = state.envMode;
        target.envSelection = state.envSelection;
        target.envSceneData = state.envSceneData;
        target.version = state.version;
        target.animAuto = state.animAuto;
        target.animSelection = new Set(state.animSelection);
        target.linkPicking = state.linkPicking;
        target.emit('all');
      } finally {
        applying = false;
      }
    },
    applyTick(state: PreviewTick) {
      beat = state.beat;
      beatRate = state.beatRate;
      beatAt = performance.now();
      playing = state.playing;
    },
  };
}
