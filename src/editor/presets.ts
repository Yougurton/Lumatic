import { tr } from './i18n';
import { resolveRgb } from './bake';
import type { Editor } from './editor';
import type { RingBlock } from './rings';
import type { Effect } from './effects';
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
  /** Effects (their settings, the group they ran over by name, their events). */
  effects?: { effect: Omit<Effect, 'id'>; targetName?: string; children: PresetClip[] }[];
  /** The rings' Lumatic events (poses, spins, the lasers' moves): put in, the poses of each kind and
   *  rings together become one group. */
  rings?: Omit<RingBlock, 'id'>[];
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
  const effects = editor.selectedEffects();
  const rings = editor.selectedRingBlocks();
  if (clips.length + raw.length + effects.length + rings.length === 0) return null;
  const first = Math.min(...clips.map((clip) => clip.start), ...raw.map((event) => event.beat), ...effects.map((effect) => effect.start), ...rings.map((block) => block.start));
  const last = Math.max(...clips.map((clip) => clip.end), ...raw.map((event) => event.beat), ...effects.map((effect) => effect.end), ...rings.map((block) => block.end));
  const groups = editor.groups;
  const save = (clip: LightClip): PresetClip => savedClip(editor, clip, first);
  return {
    id: newId('p'),
    name,
    length: last - first,
    clips: clips.map(save),
    raw: raw.map(({ id: _id, ...event }) => ({ ...event, beat: event.beat - first })),
    ...(rings.length === 0 ? {} : { rings: rings.map(({ id: _id, ...block }) => ({ ...structuredClone(block), start: block.start - first, end: block.end - first })) }),
    effects: effects.map((effect) => {
      const { id: _id, ...rest } = structuredClone(effect);
      const targetName = effect.target === undefined ? undefined : findGroup(groups, effect.target)?.group.name;
      // (a GLS block's further groups: their names kept, to find them again in another map)
      for (const lane of rest.gls?.lanes ?? []) {
        const name = lane.target === undefined ? undefined : findGroup(groups, lane.target)?.group.name;
        if (name !== undefined) lane.targetName = name;
      }
      return { effect: { ...rest, start: effect.start - first, end: effect.end - first }, ...(targetName === undefined ? {} : { targetName }), children: editor.effectChildren(effect.id).map(save) };
    }),
  };
}

/** A clip as a preset keeps it: its times from `first` (divided by `scale`: a stretched copy's back to
 *  the preset's own), a clip on a group remembering the group's name and lights. */
function savedClip(editor: Editor, clip: LightClip, first: number, scale = 1): PresetClip {
  const { id: _id, group: _group, ...rest } = cloneClip(clip, { start: (clip.start - first) / scale, end: (clip.end - first) / scale });
  const saved: PresetClip = rest;
  if (clip.target !== undefined) {
    const groups = editor.groups;
    const group = findGroup(groups, clip.target)?.group;
    if (group !== undefined) saved.targetName = group.name;
    saved.lights = [...clipLights(clip, groups)].flatMap(([type, ids]) => (ids ?? editor.lightsByType.get(type) ?? []).map((id): LightRef => ({ kind: 'light', type, id })));
  }
  return saved;
}

/** The map's presets. */
export function mapPresets(editor: Editor): Preset[] {
  return editor.mapPresets() as Preset[];
}

/** A preset kept with the map's others (first in the list). */
export function addPreset(editor: Editor, preset: Preset) {
  editor.setMapPresets([preset, ...mapPresets(editor)]);
  window.dispatchEvent(new Event('lumatic-presets'));
}

/** The app's own presets (kept by the app before presets went into maps). */
export function appPresets(): Preset[] {
  return loadPresets();
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
  const put = (saved: PresetClip, group: string | undefined) => {
    const { targetName, lights, ...clip } = saved;
    const base: LightClip = { ...structuredClone(clip), id: newId(), start: clip.start + at, end: clip.end + at };
    if (group === undefined) delete base.group;
    else base.group = group;
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
          if (group === undefined) added.push(part.id);
        }
        return;
      }
    }
    project.clips.push(base);
    if (group === undefined) added.push(base.id);
  };
  for (const saved of preset.clips) put(saved, undefined);
  for (const { effect, targetName, children } of preset.effects ?? []) {
    const copy: Effect = { ...structuredClone(effect), id: newId('e'), start: effect.start + at, end: effect.end + at };
    if (copy.target !== undefined && findGroup(groups, copy.target) === null) {
      const same = targetName === undefined ? null : byName(targetName, groups);
      if (same !== null) copy.target = same.id;
      else if (copy.custom === true) {
        // its group isn't here: its events go onto the same lights, as plain clips
        for (const child of children) put({ ...child, group: undefined }, undefined);
        continue;
      } else delete copy.target;
    }
    // (its further groups: found by name where theirs aren't here; left out when none is)
    if (copy.gls?.lanes !== undefined) {
      copy.gls.lanes = copy.gls.lanes.filter((lane) => {
        if (lane.target === undefined || findGroup(groups, lane.target) !== null) return true;
        const same = lane.targetName === undefined ? null : byName(lane.targetName, groups);
        if (same === null) return false;
        lane.target = same.id;
        return true;
      });
    }
    editor.effects.push(copy);
    if (copy.custom === true) for (const child of children) put(child, copy.id);
    else for (const child of editor.previewEffectChildren(copy)) project.clips.push(child);
    added.push(copy.id);
  }
  for (const event of preset.raw) {
    const copy: RawEvent = { ...structuredClone(event), id: newId('r'), beat: event.beat + at };
    project.raw.push(copy);
    added.push(copy.id);
  }
  // the rings' events: the poses of each kind and rings one group (edited pose by pose, moved whole);
  // spins, the lasers' moves, groups as they were
  const together = new Map<string, Omit<RingBlock, 'id'>[]>();
  for (const block of preset.rings ?? []) {
    const single = block.poses.length >= 1 && block.spin === undefined && block.lasers === undefined && block.steps === undefined && block.glitch === undefined;
    if (!single) {
      const copy: RingBlock = { ...structuredClone(block), id: newId('k'), start: block.start + at, end: block.end + at, poses: block.poses.map((pose) => ({ ...structuredClone(pose), id: newId('p') })) };
      editor.ringBlocks.push(copy);
      added.push(copy.id);
      continue;
    }
    const key = `${block.kind ?? 'rotation'}|${block.system}`;
    together.set(key, [...(together.get(key) ?? []), block]);
  }
  for (const blocks of together.values()) {
    const start = Math.min(...blocks.map((block) => block.start)) + at;
    const end = Math.max(...blocks.map((block) => block.end)) + at;
    const first = blocks[0]!;
    const poses = blocks.flatMap((block) => block.poses.map((pose) => ({ ...structuredClone(pose), id: newId('p'), beat: Math.round((block.start + at + pose.beat - start) * 1e6) / 1e6 })));
    const group: RingBlock = { ...structuredClone(first), id: newId('k'), name: preset.name, start, end, poses, ...(poses.length > 1 ? { group: true } : {}) };
    delete group.steps;
    delete group.glitch;
    editor.ringBlocks.push(group);
    added.push(group.id);
  }
  // its loose events: one group, named as the preset (the effects stay effects)
  const loose = project.clips.filter((clip) => added.includes(clip.id) && clip.group === undefined);
  const looseRaw = project.raw.filter((event) => added.includes(event.id) && event.group === undefined);
  if (loose.length + looseRaw.length > 0) {
    const group = editor.groupOf(preset.name, loose, looseRaw);
    // (a copy of the map's preset: kept the same as its others)
    if (mapPresets(editor).some((item) => item.id === preset.id)) linkGroup(group, preset);
    const grouped = new Set([...loose.map((clip) => clip.id), ...looseRaw.map((event) => event.id)]);
    editor.selection = new Set([...added.filter((id) => !grouped.has(id)), group.id]);
  } else editor.selection = new Set(added);
  editor.changed();
}

/** The presets panel: the list (each with a sketch of its clips), saving the selection as one. */
export class PresetPanel {
  private presets: Preset[] = [];

  constructor(private readonly editor: Editor, private readonly root: HTMLElement) {
    editor.onChange((what) => {
      if (what === 'selection' || what === 'all') this.renderButton();
    });
    // (a preset saved elsewhere — the GLS editor: the list read again)
    window.addEventListener('lumatic-presets', () => this.render());
    // (another map opened: its presets)
    editor.onChange((what) => {
      if (what === 'all') this.render();
    });
    // a copy of a preset changed inside: the preset and its other copies with it
    editor.groupEditedHook = (group) => syncPresetCopies(editor, group);
    // (asked for from the timeline's menu)
    window.addEventListener('lumatic-save-preset', () => void this.saveSelection());
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
    addPreset(this.editor, preset);
    // the events it was made of: one group now, named as the preset — its first copy, kept in step
    // with the others put in later
    const group = this.editor.groupSelection(name);
    if (group !== null) linkGroup(group, preset);
    this.editor.setStatus(group === null ? `Пресет «${name}» сохранён` : `Пресет «${name}» сохранён, его события собраны в группу`);
  }

  render() {
    this.presets = mapPresets(this.editor);
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
    const more = document.createElement('div');
    more.className = 'pr-more';
    const fromMap = document.createElement('button');
    fromMap.textContent = 'Импорт из карты…';
    fromMap.title = 'Добавить пресеты другой карты (её папка)';
    fromMap.hidden = window.chroeditorNative?.paletteFromMap === undefined;
    fromMap.addEventListener('click', () => void this.importFromMap());
    const fromApp = document.createElement('button');
    fromApp.textContent = 'Из общих…';
    fromApp.title = 'Пресеты, сохранённые в приложении раньше (до того как пресеты стали храниться в карте)';
    fromApp.hidden = appPresets().length === 0;
    fromApp.addEventListener('click', (event) => this.fromApp(event.clientX, event.clientY));
    more.append(fromMap, fromApp);
    root.append(more);
    this.renderButton();
    const list = document.createElement('div');
    list.className = 'pr-list';
    if (this.presets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pr-empty';
      empty.textContent = 'Выделите события на таймлайне и сохраните их как пресет — он сохранится в этой карте; вставленные копии меняются вместе.';
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
    const effects = preset.effects?.length ?? 0;
    const copies = this.editor.effects.filter((effect) => effect.preset === preset.id && effect.presetSync === true).length;
    info.textContent = [formatBeats(preset.length), tr('{0} соб.', preset.clips.length + preset.raw.length + (preset.rings ?? []).length), ...(effects > 0 ? [tr('{0} эфф.', effects)] : []), ...(copies > 0 ? [`${String(copies)} ⇄`] : [])].join(' · ');
    if (copies > 0) info.title = `Копий на таймлайне, меняющихся вместе: ${String(copies)}`;
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
    this.editor.setMapPresets(this.presets.map((item) => (item.id === preset.id ? { ...item, name } : item)));
    this.render();
  }

  private remove(preset: Preset) {
    if (!window.confirm(`Удалить пресет «${preset.name}»? Его копии на таймлайне останутся обычными группами.`)) return;
    this.editor.setMapPresets(this.presets.filter((item) => item.id !== preset.id));
    for (const effect of this.editor.effects) if (effect.preset === preset.id) delete effect.presetSync;
    this.render();
  }

  /** Another map's presets added (the ones this map hasn't got yet). */
  private async importFromMap() {
    const found = await window.chroeditorNative?.paletteFromMap?.();
    if (found === null || found === undefined) return;
    const have = new Set(this.presets.map((item) => item.id));
    const fresh = ((found.presets ?? []) as Preset[]).filter((item) => typeof item === 'object' && item !== null && typeof item.id === 'string' && !have.has(item.id));
    if (fresh.length > 0) this.editor.setMapPresets([...this.presets, ...fresh]);
    this.editor.setStatus(fresh.length > 0 ? `Из карты «${found.name}» добавлено пресетов: ${String(fresh.length)}` : `В карте «${found.name}» новых пресетов нет`);
    this.render();
  }

  /** The app's own presets (from before): one, or all, copied into the map. */
  private fromApp(x: number, y: number) {
    const own = appPresets();
    const have = new Set(this.presets.map((item) => item.id));
    const take = (list: Preset[]) => {
      const fresh = list.filter((item) => !have.has(item.id));
      if (fresh.length > 0) this.editor.setMapPresets([...this.presets, ...structuredClone(fresh)]);
      this.render();
    };
    showMenu(x, y, [
      { label: 'Общие пресеты приложения', heading: true },
      { label: 'Все в эту карту', hint: String(own.length), action: () => take(own) },
      null,
      ...own.map((item) => ({ label: item.name, hint: have.has(item.id) ? 'уже есть' : formatBeats(item.length), disabled: have.has(item.id), action: () => take([item]) })),
    ]);
  }

  /** A sketch of the preset: a row per thing its clips light, each clip in its colour. */
  private drawSketch(canvas: HTMLCanvasElement, preset: Preset) {
    const ctx = canvas.getContext('2d')!;
    const { width, height } = canvas;
    ctx.fillStyle = '#0e0f13';
    ctx.fillRect(0, 0, width, height);
    const rowKey = (clip: PresetClip) => clip.targetName ?? (clip.ids === null ? `t${String(clip.type)}` : `t${String(clip.type)}:${clip.ids.join(',')}`);
    const all = [...preset.clips, ...(preset.effects ?? []).flatMap((item) => item.children)];
    const rows = [...new Set(all.map(rowKey))];
    const length = Math.max(preset.length, 0.25);
    const rowH = Math.max(3, Math.min(14, (height - 4) / Math.max(1, rows.length)));
    const colors = this.editor.preview.colors;
    const scheme = { left: [...colors.environmentLeft] as [number, number, number], right: [...colors.environmentRight] as [number, number, number], white: [...colors.environmentWhite] as [number, number, number] };
    for (const clip of all) {
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
  return tr(value === 1 ? '{0} доля' : value > 1 && value < 5 && Number.isInteger(value) ? '{0} доли' : '{0} долей', value);
}

// ----- copies kept in step ------------------------------------------------------------------------------

/** A group made a copy of a map's preset: changed inside, the preset and its other copies change too. */
export function linkGroup(group: Effect, preset: Preset) {
  group.preset = preset.id;
  group.presetSync = true;
  group.presetScale = Math.max(1e-6, (group.end - group.start) / Math.max(1e-6, preset.length));
}

/** What a copy holds now, to tell when it has changed. */
const lastSync = new Map<string, string>();

function copySignature(editor: Editor, group: Effect) {
  const clips = editor.effectChildren(group.id).map((clip) => [Math.round((clip.start - group.start) * 1e4), Math.round((clip.end - group.start) * 1e4), clip.type, clip.ids, clip.target ?? '', clip.color, clip.endColor, clip.startMode, clip.endMode, clip.fadeIn, clip.fadeOut ?? 0, clip.layer]);
  const raw = editor.effectRaw(group.id).map((event) => [Math.round((event.beat - group.start) * 1e4), event.type, event.value, event.floatValue, event.customData ?? null]);
  return JSON.stringify([clips.sort(), raw.sort(), Math.round((group.end - group.start) * 1e4)]);
}

/**
 * A copy of a preset changed inside (`group`, gone into): the map's preset made what it is now and its
 * other copies (the ones kept in step) made anew from it — each at its own length (a stretched copy's
 * events stretched with it).
 */
export function syncPresetCopies(editor: Editor, group: Effect) {
  const project = editor.project;
  if (project === null || group.preset === undefined || group.presetSync !== true) return;
  const signature = copySignature(editor, group);
  if (lastSync.get(group.id) === signature) return;
  lastSync.set(group.id, signature);
  const presets = mapPresets(editor);
  const index = presets.findIndex((item) => item.id === group.preset);
  if (index < 0) return;
  const scale = group.presetScale ?? 1;
  const old = presets[index]!;
  const updated: Preset = {
    ...old,
    length: (group.end - group.start) / scale,
    clips: editor.effectChildren(group.id).map((clip) => savedClip(editor, clip, group.start, scale)),
    raw: editor.effectRaw(group.id).map(({ id: _id, group: _group, ...event }) => ({ ...event, beat: (event.beat - group.start) / scale })),
  };
  const next = [...presets];
  next[index] = updated;
  editor.setMapPresets(next);
  for (const other of editor.effects) {
    if (other === group || other.preset !== group.preset || other.presetSync !== true) continue;
    const otherScale = other.presetScale ?? 1;
    project.clips = project.clips.filter((clip) => clip.group !== other.id);
    project.raw = project.raw.filter((event) => event.group !== other.id);
    for (const saved of updated.clips) for (const clip of placedClips(editor, saved, other.start, otherScale)) project.clips.push({ ...clip, group: other.id });
    for (const event of updated.raw) project.raw.push({ ...structuredClone(event), id: newId('r'), beat: other.start + event.beat * otherScale, group: other.id });
    other.end = other.start + updated.length * otherScale;
    lastSync.set(other.id, copySignature(editor, other));
  }
  window.dispatchEvent(new Event('lumatic-presets'));
}

/** A preset's clip put into the show from `at` (its times × `scale`): onto its group (found by name
 *  when the id isn't here), else onto the lights it lit. */
function placedClips(editor: Editor, saved: PresetClip, at: number, scale = 1): LightClip[] {
  const groups = editor.groups;
  const byName = (name: string, list: readonly LightGroup[]): LightGroup | null => {
    for (const group of list) {
      if (group.name === name) return group;
      const inner = byName(name, group.items.filter((item): item is LightGroup => item.kind === 'group'));
      if (inner !== null) return inner;
    }
    return null;
  };
  const { targetName, lights, ...clip } = saved;
  const base: LightClip = { ...structuredClone(clip), id: newId(), start: at + clip.start * scale, end: at + clip.end * scale };
  delete base.group;
  if (base.target === undefined || findGroup(groups, base.target) !== null) return [base];
  const same = targetName === undefined ? null : byName(targetName, groups);
  if (same !== null) return [{ ...base, target: same.id }];
  // (no such group here: onto the lights it lit)
  delete base.target;
  const perType = new Map<number, number[]>();
  for (const light of lights ?? []) perType.set(light.type, [...(perType.get(light.type) ?? []), light.id]);
  return [...perType].map(([type, ids]): LightClip => ({ ...structuredClone(base), id: newId(), type, ids, ...(ids.length === 1 ? { scope: 'light' as const } : {}) }));
}

/** A copy let go of its preset (its events stay as they are) — or, `on`, tied to it again (made
 *  anew from the preset, at its own length). One undo step. */
export function setGroupSync(editor: Editor, group: Effect, on: boolean) {
  const project = editor.project;
  if (project === null || group.preset === undefined) return;
  editor.checkpoint();
  if (!on) delete group.presetSync;
  else {
    const preset = mapPresets(editor).find((item) => item.id === group.preset);
    if (preset !== undefined) {
      group.presetSync = true;
      const scale = (group.end - group.start) / Math.max(1e-6, preset.length);
      group.presetScale = scale;
      project.clips = project.clips.filter((clip) => clip.group !== group.id);
      project.raw = project.raw.filter((event) => event.group !== group.id);
      for (const saved of preset.clips) for (const clip of placedClips(editor, saved, group.start, scale)) project.clips.push({ ...clip, group: group.id });
      for (const event of preset.raw) project.raw.push({ ...structuredClone(event), id: newId('r'), beat: group.start + event.beat * scale, group: group.id });
      lastSync.set(group.id, copySignature(editor, group));
    }
  }
  editor.changed();
  window.dispatchEvent(new Event('lumatic-presets'));
}
