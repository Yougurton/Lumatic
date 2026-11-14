import type { Editor, LightRow } from './editor';
import { isLightRow } from './editor';
import type { ClipColor, LightClip } from './model';
import { BANDS, pickOnsets, type Onset } from './onsets';

/**
 * "Light from the sound": where a band of the song hits (the kick drum, the snare, the hi-hats…),
 * events on the chosen rows — all at once, taking turns or at random; flashes, fades, or on until the
 * next hit; brighter for the harder hits if asked. Tried on the timeline as the settings change;
 * "Apply" keeps them (one undo step).
 */

type Look = 'fade' | 'flash' | 'on-fade' | 'until-next';
type Colors = 'left' | 'right' | 'white' | 'alternate' | 'brush';
type Spread = 'all' | 'turns' | 'random';

export function soundDialog(editor: Editor, row: LightRow | null = null) {
  const project = editor.project;
  if (project === null) return;
  const rows = editor.rows.filter(isLightRow);
  if (rows.length === 0) return;
  const picked = editor.selectedClips();
  const chosen = new Set<string>(
    row !== null
      ? [row.key]
      : rows.filter((item) => editor.rowClips(item).some((shown) => shown.role === 'own' && picked.some((clip) => clip.id === shown.clip.id))).map((item) => item.key),
  );
  if (chosen.size === 0) chosen.add(rows[0]!.key);
  const range = editor.songRange;
  const settings = {
    band: BANDS[0]!.id,
    lowHz: BANDS[0]!.lowHz,
    highHz: BANDS[0]!.highHz,
    sensitivity: BANDS[0]!.sensitivity,
    gap: 0.125,
    grid: editor.snap > 0 ? Math.min(editor.snap, 0.25) : 0,
    from: range !== null ? Math.min(range.start, range.end) : 0,
    to: range !== null ? Math.max(range.start, range.end) : Math.ceil(editor.secondsToBeat(editor.duration)),
    look: 'fade' as Look,
    length: 0.5,
    colors: 'alternate' as Colors,
    strength: true,
    spread: 'all' as Spread,
  };
  editor.startTrying();

  const shade = document.createElement('div');
  shade.className = 'ce-shade adjust-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog adjust-dialog sound-dialog';
  const options = (list: [string, string][]) => list.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  box.innerHTML = `
    <div class="ce-dialog-title">Свет по звуку</div>
    <div class="sound-bands" data-id="bands">${BANDS.map((band) => `<button type="button" data-band="${band.id}">${band.name}</button>`).join('')}</div>
    <div class="adjust-pair">
      <label>От, Гц <input type="number" data-id="lowHz" min="20" max="20000" step="10"></label>
      <label>До, Гц <input type="number" data-id="highHz" min="20" max="20000" step="10"></label>
    </div>
    <label>Чувствительность <input type="range" data-id="sensitivity" min="0" max="1" step="0.05"><span data-id="sensitivity-value"></span></label>
    <div class="adjust-pair">
      <label>Не чаще, чем раз в <select data-id="gap">${options([['0.0625', '1/16 доли'], ['0.125', '1/8 доли'], ['0.25', '1/4 доли'], ['0.5', '1/2 доли'], ['1', '1 долю']])}</select></label>
      <label>К сетке <select data-id="grid">${options([['0', 'как в песне'], ['0.0625', '1/16'], ['0.125', '1/8'], ['0.25', '1/4'], ['0.5', '1/2']])}</select></label>
    </div>
    <div class="adjust-pair">
      <label>С доли <input type="number" data-id="from" min="0" step="1"></label>
      <label>По долю <input type="number" data-id="to" min="0" step="1"></label>
    </div>
    <div class="adjust-pair">
      <label>Событие <select data-id="look">${options([['fade', 'Вспышка и гаснет (Fade)'], ['flash', 'Вспышка (Flash)'], ['on-fade', 'Вкл. и плавно гаснет'], ['until-next', 'Горит до следующего удара']])}</select></label>
      <label data-id="length-label">Длина, доли <input type="number" data-id="length" min="0.0625" step="0.125"></label>
    </div>
    <div class="adjust-pair">
      <label>Цвет <select data-id="colors">${options([['alternate', 'левый / правый по очереди'], ['left', 'левый'], ['right', 'правый'], ['white', 'белый'], ['brush', 'как у кисти']])}</select></label>
      <label>По строкам <select data-id="spread">${options([['all', 'на всех сразу'], ['turns', 'по очереди'], ['random', 'вразброс']])}</select></label>
    </div>
    <label class="adjust-check"><input type="checkbox" data-id="strength"> Сильнее удар — ярче свет</label>
    <div class="adjust-head">Строки</div>
    <div class="adjust-rows" data-id="rows"></div>
    <div class="nm-dim" data-id="status"></div>
    <div class="ce-dialog-buttons"><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="apply">Применить</button></div>`;
  shade.append(box);
  document.body.append(shade);
  const el = <T extends HTMLElement>(id: string) => box.querySelector<T>(`[data-id="${id}"]`)!;
  const status = el<HTMLElement>('status');

  // ----- the rows
  const list = el<HTMLElement>('rows');
  const checks = rows.map((item) => {
    const label = document.createElement('label');
    label.className = 'adjust-check';
    label.style.paddingLeft = `${String(item.depth * 12)}px`;
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = chosen.has(item.key);
    check.addEventListener('change', schedule);
    label.append(check, ` ${item.label}`);
    list.append(label);
    return { row: item, check };
  });

  // ----- the settings
  const fields = ['lowHz', 'highHz', 'sensitivity', 'gap', 'grid', 'from', 'to', 'look', 'length', 'colors', 'spread'] as const;
  const show = () => {
    for (const key of fields) el<HTMLInputElement>(key).value = String(settings[key]);
    el<HTMLInputElement>('strength').checked = settings.strength;
    el('sensitivity-value').textContent = settings.sensitivity.toFixed(2);
    el('length-label').style.visibility = settings.look === 'until-next' || settings.look === 'fade' ? 'hidden' : '';
    box.querySelectorAll<HTMLElement>('[data-band]').forEach((button) => button.classList.toggle('active', button.dataset.band === settings.band));
  };
  for (const key of fields) {
    el<HTMLInputElement>(key).addEventListener('input', () => {
      const raw = el<HTMLInputElement>(key).value;
      if (key === 'look' || key === 'colors' || key === 'spread') (settings as Record<string, unknown>)[key] = raw;
      else {
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        settings[key] = value;
        if (key === 'lowHz' || key === 'highHz') settings.band = '';
      }
      show();
      schedule();
    });
  }
  el<HTMLInputElement>('strength').addEventListener('change', () => {
    settings.strength = el<HTMLInputElement>('strength').checked;
    schedule();
  });
  box.querySelectorAll<HTMLElement>('[data-band]').forEach((button) =>
    button.addEventListener('click', () => {
      const band = BANDS.find((item) => item.id === button.dataset.band)!;
      Object.assign(settings, { band: band.id, lowHz: band.lowHz, highHz: band.highHz, sensitivity: band.sensitivity });
      show();
      schedule();
    }),
  );

  // ----- the hits → events
  const colorOf = (index: number, brush: ClipColor): ClipColor => {
    if (settings.colors === 'brush') return { ...brush };
    const ref = settings.colors === 'alternate' ? (index % 2 === 0 ? 'left' : 'right') : settings.colors;
    return { ref, brightness: 1 };
  };
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const clipsFor = (onsets: Onset[]): LightClip[] => {
    const targets = checks.filter((item) => item.check.checked).map((item) => item.row);
    if (targets.length === 0) return [];
    seed = 1;
    // (on the grid: one hit per step, the stronger)
    const hits = new Map<number, Onset & { beat: number }>();
    for (const onset of onsets) {
      const exact = editor.secondsToBeat(onset.time);
      const beat = settings.grid > 0 ? Math.round(exact / settings.grid) * settings.grid : Math.round(exact * 1000) / 1000;
      if (beat < settings.from || beat > settings.to) continue;
      const known = hits.get(beat);
      if (known === undefined || known.strength < onset.strength) hits.set(beat, { ...onset, beat });
    }
    const sorted = [...hits.values()].sort((a, b) => a.beat - b.beat);
    const placed: { row: LightRow; beat: number; strength: number; index: number }[] = [];
    sorted.forEach((hit, index) => {
      const on = settings.spread === 'all' ? targets : [targets[settings.spread === 'turns' ? index % targets.length : Math.floor(random() * targets.length)]!];
      for (const target of on) placed.push({ row: target, beat: hit.beat, strength: hit.strength, index });
    });
    const out: LightClip[] = [];
    placed.forEach((item, at) => {
      const next = placed.slice(at + 1).find((other) => other.row === item.row);
      const length = settings.look === 'until-next' ? Math.min(8, (next?.beat ?? item.beat + 1) - item.beat) : settings.look === 'fade' ? Math.min(0.5, (next?.beat ?? item.beat + 1) - item.beat) : settings.length;
      const clip = editor.newClipForRow(item.row, item.beat, item.beat + Math.max(1 / 16, length));
      if (clip === null) return;
      const color = colorOf(item.index, clip.color);
      if (settings.strength) color.brightness = Math.round(color.brightness * (0.35 + 0.65 * item.strength) * 100) / 100;
      Object.assign(clip, {
        startMode: settings.look === 'fade' ? 'fade' : settings.look === 'flash' ? 'flash' : 'on',
        fadeIn: 0,
        endMode: settings.look === 'on-fade' ? 'fade' : 'off',
        color,
        endColor: null,
      });
      out.push(clip);
    });
    return out;
  };

  let timer = 0;
  let asked = 0;
  let made: LightClip[] = [];
  function schedule() {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 150);
  }
  const run = async () => {
    const flux = editor.songFlux(Math.round(settings.lowHz), Math.round(settings.highHz));
    if (flux === null) {
      status.textContent = editor.map?.parsed.audioData == null ? 'У карты нет песни.' : 'Песня ещё загружается…';
      // (asked again when it may have come)
      if (shade.isConnected) timer = window.setTimeout(() => void run(), 1000);
      return;
    }
    const ask = ++asked;
    status.textContent = 'Слушаю песню…';
    const found = await flux.catch((error: unknown) => {
      status.textContent = `Не получилось: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    });
    if (found === null || ask !== asked || !shade.isConnected) return;
    const from = editor.beatToSeconds(settings.from) - 0.05;
    const to = editor.beatToSeconds(settings.to) + 0.05;
    const onsets = pickOnsets(found.flux, found.fps, found.offset, settings.sensitivity, editor.beatToSeconds(settings.from + settings.gap) - editor.beatToSeconds(settings.from) - 0.005, from, to);
    made = clipsFor(onsets);
    editor.tryClips(made);
    status.textContent = `Ударов: ${String(onsets.length)}, событий: ${String(made.length)}`;
  };

  const close = (keep: boolean) => {
    window.clearTimeout(timer);
    asked++;
    editor.finishTrying(keep);
    if (keep) editor.setStatus(`Свет по звуку: ${String(made.length)} событий`);
    shade.remove();
    window.removeEventListener('keydown', keys, true);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(false);
    } else if ((event.ctrlKey || event.metaKey) && /^[zy]$/iu.test(event.key)) event.stopPropagation();
  };
  window.addEventListener('keydown', keys, true);
  el('cancel').addEventListener('click', () => close(false));
  el('apply').addEventListener('click', () => close(true));
  show();
  void run();
}
