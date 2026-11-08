import type { Editor } from './editor';
import { scrubStrip } from './gls-editor';
import { gridSelect } from './grids';
import { ringSystemName } from './library';
import { BANDS, pickOnsets } from './onsets';
import { DEFAULT_GLITCH, newGlitchBlock, type RingBlock, type RingGlitch } from './rings';

/**
 * "Ring glitch": the rings jerking about at random — for scratches and glitches in the song. How often
 * (on the grid, or at the song's own hits in a band), how far, how far apart the rings go, how sharp;
 * another throw of the dice; back where they were at the end. Over the picked stretch of the song if
 * there is one, else from the cursor. Tried live; double-click the block to change it again.
 */

const SOUNDS: [string, string][] = [
  ['', 'по сетке'],
  ['hats', 'по хэтам'],
  ['mid', 'по середине'],
  ['all', 'по всем ударам'],
];

let remembered: RingGlitch = { ...DEFAULT_GLITCH };
let rememberedSound = '';

export function ringGlitchDialog(editor: Editor, blockId: string | null, brush?: (block: RingBlock) => void) {
  if (editor.project === null || editor.ringInfo.length === 0) return;
  const old = blockId === null ? undefined : editor.ringBlockById(blockId);
  const range = editor.songRange;
  const start = old?.start ?? (range !== null ? Math.min(range.start, range.end) : editor.snapBeat(editor.playhead()));
  const glitch: RingGlitch = { ...(old?.glitch ?? remembered) };
  if (old === undefined && range !== null) glitch.length = Math.max(0.25, Math.abs(range.end - range.start));
  let sound = old !== undefined ? (old.glitch?.band ?? '') : rememberedSound;
  let system = old?.system || (editor.ringInfo.find((item) => editor.geometryRings.has(item.name))?.name ?? editor.ringInfo[0]!.name);
  editor.startTrying();

  const shade = document.createElement('div');
  shade.className = 'ce-shade adjust-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog adjust-dialog steps-dialog';
  box.innerHTML = `
    <div class="ce-dialog-title">Глитч колец</div>
    <label data-id="system-row">Кольца <select data-id="system">${editor.ringInfo.map((item) => `<option value="${item.name}">${ringSystemName(item.name)} (${String(item.rings)})</option>`).join('')}</select></label>
    <div class="adjust-pair">
      <label>Длится, долей <input type="number" data-id="length" min="0.25" step="0.5"></label>
      <label>Сила, ° <input type="number" data-id="strength" min="0" step="5"></label>
      <label>Разброс колец, ° <input type="number" data-id="chaos" min="0" step="2"></label>
    </div>
    <div class="steps-line"><span class="adjust-head">Рывки</span><span class="steps-buttons" data-id="sound"></span></div>
    <div class="steps-line" data-id="every-row"><span class="adjust-head">Каждые, долей</span><span class="steps-buttons" data-id="every"></span></div>
    <div class="steps-line"><span class="adjust-head">Резкость</span><span class="steps-buttons" data-id="snap"></span></div>
    <label class="adjust-check"><input type="checkbox" data-id="back"> В конце вернуть кольца как были</label>
    <canvas class="steps-picture" data-id="picture" width="400" height="56"></canvas>
    <div class="nm-dim" data-id="summary"></div>
    <div class="ce-dialog-buttons"><button type="button" data-id="dice" title="Другие случайные рывки">🎲 Другой вариант</button><span class="adjust-gap"></span><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="apply">${old === undefined ? (brush !== undefined ? 'Ставить мышью' : 'Поставить') : 'Готово'}</button></div>`;
  shade.append(box);
  document.body.append(shade);
  const el = <T extends HTMLElement>(name: string) => box.querySelector<T>(`[data-id="${name}"]`)!;
  el('system-row').hidden = editor.ringInfo.length < 2;
  el<HTMLSelectElement>('system').value = system;
  el<HTMLSelectElement>('system').addEventListener('change', () => {
    system = el<HTMLSelectElement>('system').value;
    update();
  });

  const buttons = <T,>(place: string, options: [string, T][], get: () => T, set: (value: T) => void) => {
    const holder = el(place);
    const draw = () =>
      holder.replaceChildren(
        ...options.map(([label, value]) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.textContent = label;
          item.classList.toggle('active', get() === value);
          item.addEventListener('click', () => {
            set(value);
            draw();
            update();
          });
          return item;
        }),
      );
    draw();
  };
  buttons<string>('sound', SOUNDS.map(([value, label]): [string, string] => [label, value]), () => sound, (value) => (sound = value));
  el('every').replaceChildren(
    gridSelect(glitch.every, (value) => {
      glitch.every = value;
      update();
    }, [1]),
  );
  buttons<number>('snap', [['Мгновенно', 0], ['Рывком', 0.15], ['Быстро', 0.35], ['Плавно', 0.8]], () => glitch.snap, (value) => (glitch.snap = value));
  for (const key of ['length', 'strength', 'chaos'] as const) {
    const input = el<HTMLInputElement>(key);
    input.value = String(glitch[key]);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      glitch[key] = Math.max(key === 'length' ? 0.25 : 0, value);
      update();
    });
  }
  const back = el<HTMLInputElement>('back');
  back.checked = glitch.back;
  back.addEventListener('change', () => {
    glitch.back = back.checked;
    update();
  });
  el('dice').addEventListener('click', () => {
    glitch.seed += 1;
    update();
  });

  /** The song's hits in the block (beats from its start) for the band picked; null: not known yet. */
  let hits: { key: string; beats: number[] } | null = null;
  const findHits = () => {
    const band = BANDS.find((item) => item.id === sound);
    if (band === undefined) return;
    const key = `${sound} ${String(start)} ${String(glitch.length)}`;
    if (hits?.key === key) return;
    const flux = editor.songFlux(band.lowHz, band.highHz);
    if (flux === null) {
      el('summary').textContent = 'Песня ещё загружается…';
      return;
    }
    void flux.then((found) => {
      const from = editor.beatToSeconds(start);
      const to = editor.beatToSeconds(start + glitch.length);
      const onsets = pickOnsets(found.flux, found.fps, found.offset, band.sensitivity + 0.15, 0.05, from, to);
      hits = { key, beats: onsets.map((onset) => Math.round((editor.secondsToBeat(onset.time) - start) * 1000) / 1000) };
      if (shade.isConnected) update();
    });
  };

  let current: RingBlock = newGlitchBlock(system, 'event', start, glitch);
  el('summary').before(scrubStrip(editor, () => current));
  const made = (): RingBlock => {
    const mode = editor.geometryRings.has(system) ? 'tracks' : (old?.mode ?? 'event');
    const settings: RingGlitch = { ...glitch };
    if (sound !== '' && hits !== null) settings.hits = hits.beats;
    else delete settings.hits;
    if (sound !== '') settings.band = sound;
    else delete settings.band;
    const block = newGlitchBlock(system, mode, start, settings);
    return { ...block, id: old?.id ?? current.id, name: old?.name ?? block.name };
  };

  // the angle of the first ring over the block, drawn
  const picture = el<HTMLCanvasElement>('picture');
  const draw = () => {
    const ctx = picture.getContext('2d')!;
    const width = picture.width;
    const height = picture.height;
    ctx.fillStyle = '#121318';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(0, height / 2, width, 1);
    const length = Math.max(0.25, current.end - current.start);
    const scale = (height / 2 - 4) / Math.max(1, glitch.strength);
    ctx.strokeStyle = '#d9a0ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let angle = 0;
    ctx.moveTo(0, height / 2);
    for (const pose of current.poses) {
      const x0 = (pose.beat / length) * width;
      const x1 = ((pose.beat + pose.duration) / length) * width;
      ctx.lineTo(x0, height / 2 - angle * scale);
      angle = pose.angle;
      ctx.lineTo(x1, height / 2 - angle * scale);
    }
    ctx.lineTo(width, height / 2 - angle * scale);
    ctx.stroke();
  };

  let timer = 0;
  const update = () => {
    el('every-row').hidden = sound !== '';
    if (sound !== '') findHits();
    current = made();
    draw();
    const waiting = sound !== '' && hits === null;
    el('summary').textContent = waiting ? 'Ищу удары в песне…' : `${String(current.poses.length)} рывков · ${String(Math.round((current.end - current.start) * 100) / 100)} долей с доли ${String(Math.round(start * 1000) / 1000)}${current.mode === 'tracks' ? ' · каждое кольцо отдельно' : ' · событиями колец'}`;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => editor.tryRingBlock(current), 80);
  };

  const close = (keep: boolean) => {
    window.clearTimeout(timer);
    // (a brush: the settings taken, the block put with the mouse — not here at the cursor)
    const asBrush = keep && brush !== undefined && old === undefined;
    if (keep) {
      editor.tryRingBlock(current);
      remembered = { ...glitch };
      delete remembered.hits;
      rememberedSound = sound;
    }
    editor.finishTrying(keep && !asBrush);
    shade.remove();
    window.removeEventListener('keydown', keys, true);
    if (asBrush) brush(current);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(false);
    } else if (event.key === 'Enter') {
      event.stopPropagation();
      close(true);
    } else if ((event.ctrlKey || event.metaKey) && /^[zy]$/iu.test(event.key)) event.stopPropagation();
  };
  window.addEventListener('keydown', keys, true);
  el('cancel').addEventListener('click', () => close(false));
  el('apply').addEventListener('click', () => close(true));
  update();
}
