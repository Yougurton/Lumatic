import { resolveRgb } from './bake';
import type { Editor } from './editor';
import { ask, showMenu } from './menu';
import { clipLights, cloneClip, findGroup, newId, type LightClip, type LightGroup, type LightRef, type RawEvent } from './model';

/**
 * The user's presets: clips (and other events) saved from one show to be put into any other — kept
 * by the app, not by a map. A clip drawn on a group remembers the group (by name) and its lights:
 * put into a show with a group of that name it lands on that group, otherwise on the same lights.
 */

interface PresetClip extends Omit<LightClip, 'id'> {
  /** For a clip on a group: the group's name and lights when it was saved. */
  targetName?: string;
  lights?: LightRef[];
}

export interface Preset {
  id: string;
  name: string;
  /** Beats from its first event to its last. */
  length: number;
  clips: PresetClip[];
  raw: Omit<RawEvent, 'id'>[];
}

const STORE = 'chroeditor.presets.v1';

export function loadPresets(): Preset[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE) ?? '[]') as unknown;
    return Array.isArray(list) ? (list as Preset[]) : [];
  } catch {
    return [];
  }
}

function storePresets(list: Preset[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch (error) {
    console.error('[chroeditor] presets not saved', error);
  }
}

/** The selected clips and events as a preset (null: nothing selected). */
export function presetFromSelection(editor: Editor, name: string): Preset | null {
  const project = editor.project;
  if (project === null) return null;
  const clips = editor.selectedClips();
  const raw = project.raw.filter((event) => editor.selection.has(event.id));
  if (clips.length + raw.length === 0) return null;
  const first = Math.min(...clips.map((clip) => clip.start), ...raw.map((event) => event.beat));
  const last = Math.max(...clips.map((clip) => clip.end), ...raw.map((event) => event.beat));
  const groups = editor.groups;
  return {
    id: newId('p'),
    name,
    length: last - first,
    clips: clips.map((clip) => {
      const { id: _id, ...rest } = cloneClip(clip, { start: clip.start - first, end: clip.end - first });
      const saved: PresetClip = rest;
      if (clip.target !== undefined) {
        const group = findGroup(groups, clip.target)?.group;
        if (group !== undefined) saved.targetName = group.name;
        saved.lights = [...clipLights(clip, groups)].flatMap(([type, ids]) => (ids ?? editor.lightsByType.get(type) ?? []).map((id): LightRef => ({ kind: 'light', type, id })));
      }
      return saved;
    }),
    raw: raw.map(({ id: _id, ...event }) => ({ ...event, beat: event.beat - first })),
  };
}

/** Puts a preset into the show from `at` (selected afterwards). */
export function insertPreset(editor: Editor, preset: Preset, at: number) {
  const project = editor.project;
  if (project === null) return;
  const groups = editor.groups;
  const byName = (name: string, list: readonly LightGroup[]): LightGroup | null => {
    for (const group of list) {
      if (group.name === name) return group;
      const inner = byName(name, group.items.filter((item): item is LightGroup => item.kind === 'group'));
      if (inner !== null) return inner;
    }
    return null;
  };
  editor.checkpoint();
  const added: string[] = [];
  for (const saved of preset.clips) {
    const { targetName, lights, ...clip } = saved;
    const base: LightClip = { ...structuredClone(clip), id: newId(), start: clip.start + at, end: clip.end + at };
    if (base.target !== undefined && findGroup(groups, base.target) === null) {
      const same = targetName === undefined ? null : byName(targetName, groups);
      if (same !== null) base.target = same.id;
      else {
        // no such group here: onto the lights it lit
        delete base.target;
        const perType = new Map<number, number[]>();
        for (const light of lights ?? []) perType.set(light.type, [...(perType.get(light.type) ?? []), light.id]);
        for (const [type, ids] of perType) {
          const part: LightClip = { ...structuredClone(base), id: newId(), type, ids };
          if (ids.length === 1) part.scope = 'light';
          project.clips.push(part);
          added.push(part.id);
        }
        continue;
      }
    }
    project.clips.push(base);
    added.push(base.id);
  }
  for (const event of preset.raw) {
    const copy: RawEvent = { ...structuredClone(event), id: newId('r'), beat: event.beat + at };
    project.raw.push(copy);
    added.push(copy.id);
  }
  editor.selection = new Set(added);
  editor.changed();
}

/** The presets panel: the list (each with a sketch of its clips), saving the selection as one. */
export class PresetPanel {
  private presets = loadPresets();

  constructor(private readonly editor: Editor, private readonly root: HTMLElement) {
    editor.onChange((what) => {
      if (what === 'selection' || what === 'all') this.renderButton();
    });
    this.render();
  }

  private saveButton: HTMLButtonElement | null = null;

  private renderButton() {
    if (this.saveButton === null) return;
    const project = this.editor.project;
    this.saveButton.disabled = project === null || this.editor.selection.size === 0;
  }

  async saveSelection() {
    const name = await ask('Название пресета', `Пресет ${String(this.presets.length + 1)}`);
    if (name === null) return;
    const preset = presetFromSelection(this.editor, name);
    if (preset === null) return;
    this.presets = [preset, ...loadPresets()];
    storePresets(this.presets);
    this.render();
    this.editor.setStatus(`Пресет «${name}» сохранён`);
  }

  render() {
    const root = this.root;
    root.replaceChildren();
    const head = document.createElement('div');
    head.className = 'pr-head';
    const title = document.createElement('span');
    title.textContent = 'Пресеты';
    const save = document.createElement('button');
    save.textContent = '＋ Из выделенного';
    save.title = 'Сохранить выделенные события как пресет';
    save.addEventListener('click', () => void this.saveSelection());
    this.saveButton = save;
    head.append(title, save);
    root.append(head);
    this.renderButton();
    const list = document.createElement('div');
    list.className = 'pr-list';
    if (this.presets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pr-empty';
      empty.textContent = 'Выделите события на таймлайне и сохраните их как пресет — он будет доступен в любой карте.';
      list.append(empty);
    }
    for (const preset of this.presets) list.append(this.item(preset));
    root.append(list);
  }

  private item(preset: Preset) {
    const item = document.createElement('div');
    item.className = 'pr-item';
    item.title = 'Двойной клик — вставить в позицию курсора; ПКМ — действия';
    const sketch = document.createElement('canvas');
    sketch.className = 'pr-sketch';
    sketch.width = 96 * 2;
    sketch.height = 30 * 2;
    this.drawSketch(sketch, preset);
    const text = document.createElement('div');
    text.className = 'pr-text';
    const name = document.createElement('div');
    name.className = 'pr-name';
    name.textContent = preset.name;
    const info = document.createElement('div');
    info.className = 'pr-info';
    info.textContent = `${formatBeats(preset.length)} · ${String(preset.clips.length + preset.raw.length)} соб.`;
    text.append(name, info);
    const insert = document.createElement('button');
    insert.textContent = 'Вставить';
    insert.title = 'Вставить в позицию курсора (красная линия)';
    insert.addEventListener('click', () => this.insert(preset));
    item.append(sketch, text, insert);
    item.addEventListener('dblclick', () => this.insert(preset));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showMenu(event.clientX, event.clientY, [
        { label: 'Вставить в позицию курсора', action: () => this.insert(preset) },
        { label: 'Переименовать…', action: () => void this.rename(preset) },
        null,
        { label: 'Удалить пресет', action: () => this.remove(preset) },
      ]);
    });
    return item;
  }

  private insert(preset: Preset) {
    if (this.editor.project === null) return;
    insertPreset(this.editor, preset, this.editor.snapBeat(this.editor.playhead()));
  }

  private async rename(preset: Preset) {
    const name = await ask('Новое название', preset.name);
    if (name === null) return;
    preset.name = name;
    storePresets(this.presets);
    this.render();
  }

  private remove(preset: Preset) {
    if (!window.confirm(`Удалить пресет «${preset.name}»?`)) return;
    this.presets = this.presets.filter((item) => item.id !== preset.id);
    storePresets(this.presets);
    this.render();
  }

  /** A sketch of the preset: a row per thing its clips light, each clip in its colour. */
  private drawSketch(canvas: HTMLCanvasElement, preset: Preset) {
    const ctx = canvas.getContext('2d')!;
    const { width, height } = canvas;
    ctx.fillStyle = '#0e0f13';
    ctx.fillRect(0, 0, width, height);
    const rowKey = (clip: PresetClip) => clip.targetName ?? (clip.ids === null ? `t${String(clip.type)}` : `t${String(clip.type)}:${clip.ids.join(',')}`);
    const rows = [...new Set(preset.clips.map(rowKey))];
    const length = Math.max(preset.length, 0.25);
    const rowH = Math.max(3, Math.min(14, (height - 4) / Math.max(1, rows.length)));
    const colors = this.editor.preview.colors;
    const scheme = { left: [...colors.environmentLeft] as [number, number, number], right: [...colors.environmentRight] as [number, number, number], white: [...colors.environmentWhite] as [number, number, number] };
    for (const clip of preset.clips) {
      const row = rows.indexOf(rowKey(clip));
      const x = 2 + (clip.start / length) * (width - 4);
      const w = Math.max(2, ((clip.end - clip.start) / length) * (width - 4));
      const rgb = resolveRgb(clip.color, scheme).map((v) => Math.round(Math.min(1, v) * 255));
      ctx.fillStyle = `rgb(${rgb.join(',')})`;
      ctx.fillRect(x, 2 + row * rowH, w, Math.max(2, rowH - 1));
    }
    ctx.fillStyle = '#c9a0ff';
    for (const event of preset.raw) ctx.fillRect(2 + (event.beat / length) * (width - 4), height - 4, 2, 3);
  }
}

function formatBeats(beats: number) {
  const value = Math.round(beats * 100) / 100;
  return `${String(value)} ${value === 1 ? 'доля' : value > 1 && value < 5 && Number.isInteger(value) ? 'доли' : 'долей'}`;
}
