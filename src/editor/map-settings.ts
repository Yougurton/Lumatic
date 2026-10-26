import { decodeAudio, encodeOgg, findBpm, findDownbeat, playWithClicks } from './audio-tools';
import type { BpmResult } from './bpm-detect';
import type { Editor } from './editor';
import { difficultyFile, loadProject, projectFileName, transformDifficultyBeats, transformProjectBeats } from './map-io';
import { OTHER_ENVIRONMENTS, SHOW_ENVIRONMENTS } from './new-map';

/**
 * "Map settings": the song's name and authors, the environment, its tempo, its start — silence put
 * in front of the song (seconds, beats or bars; or cut off it), the first beat lined up with the
 * grid or the strong beat with the start of a bar — and its preview in the song list. Changing the
 * tempo keeps every event on its beat, or (asked for) at its time in the song; changing the start
 * moves every difficulty's notes, walls and lights with the song, so all stays in sync. The song is
 * made anew as Ogg Vorbis for that.
 */

interface InfoFields {
  version: '2' | '4';
  title: string;
  subTitle: string;
  artist: string;
  mapper: string;
  bpm: number;
  preview: number;
  /** How long the song list plays (seconds). */
  previewDuration: number;
  song: string;
  /** The environment of the difficulty being edited. */
  environment: string;
}

function readInfo(text: string, environment: string): InfoFields {
  const info = JSON.parse(text) as Record<string, unknown>;
  const v4 = typeof info.version === 'string' && info.version.startsWith('4');
  if (v4) {
    const song = (info.song ?? {}) as Record<string, unknown>;
    const audio = (info.audio ?? {}) as Record<string, unknown>;
    return { version: '4', title: String(song.title ?? ''), subTitle: String(song.subTitle ?? ''), artist: String(song.author ?? ''), mapper: '', bpm: Number(audio.bpm ?? 120), preview: Number(audio.previewStartTime ?? 0), previewDuration: Number(audio.previewDuration ?? 10), song: String(audio.songFilename ?? ''), environment };
  }
  return {
    version: '2',
    title: String(info._songName ?? ''),
    subTitle: String(info._songSubName ?? ''),
    artist: String(info._songAuthorName ?? ''),
    mapper: String(info._levelAuthorName ?? ''),
    bpm: Number(info._beatsPerMinute ?? 120),
    preview: Number(info._previewStartTime ?? 0),
    previewDuration: Number(info._previewDuration ?? 10),
    song: String(info._songFilename ?? ''),
    environment,
  };
}

/** Where the difficulty being edited takes its environment from. */
interface EnvironmentPlace {
  /** Its file (v4: its own entry names the environment). */
  file: string;
  /** 360° / 90° difficulties (v2: their own environment field). */
  allDirections: boolean;
}

function writeInfo(text: string, fields: InfoFields, place: EnvironmentPlace): string {
  const info = JSON.parse(text) as Record<string, unknown>;
  if (fields.version === '4') {
    // (Info v4: a list of environments, each difficulty points into it)
    const names = Array.isArray(info.environmentNames) ? (info.environmentNames as string[]) : [];
    let index = names.indexOf(fields.environment);
    if (index < 0) {
      names.push(fields.environment);
      index = names.length - 1;
    }
    info.environmentNames = names;
    for (const entry of (info.difficultyBeatmaps ?? []) as Record<string, unknown>[]) if (entry.beatmapDataFilename === place.file) entry.environmentNameIdx = index;
    const song = (info.song ?? {}) as Record<string, unknown>;
    song.title = fields.title;
    song.subTitle = fields.subTitle;
    song.author = fields.artist;
    info.song = song;
    const audio = (info.audio ?? {}) as Record<string, unknown>;
    audio.previewStartTime = Math.max(0, Math.round(fields.preview * 100) / 100);
    audio.previewDuration = Math.max(1, Math.round(fields.previewDuration * 100) / 100);
    info.audio = audio;
  } else {
    if (place.allDirections) info._allDirectionsEnvironmentName = fields.environment;
    else info._environmentName = fields.environment;
    info._previewDuration = Math.max(1, Math.round(fields.previewDuration * 100) / 100);
    info._songName = fields.title;
    info._songSubName = fields.subTitle;
    info._songAuthorName = fields.artist;
    info._levelAuthorName = fields.mapper;
    info._beatsPerMinute = fields.bpm;
    info._previewStartTime = Math.max(0, Math.round(fields.preview * 100) / 100);
  }
  return JSON.stringify(info, null, 2);
}

/** Info.dat with the song list's preview set: from `start` for `duration` seconds of the song. */
export function writePreview(text: string, start: number, duration: number): string {
  const info = JSON.parse(text) as Record<string, unknown>;
  const at = Math.max(0, Math.round(start * 100) / 100);
  const length = Math.max(1, Math.round(duration * 100) / 100);
  if (typeof info.version === 'string' && info.version.startsWith('4')) {
    const audio = (info.audio ?? {}) as Record<string, unknown>;
    audio.previewStartTime = at;
    audio.previewDuration = length;
    info.audio = audio;
  } else {
    info._previewStartTime = at;
    info._previewDuration = length;
  }
  return JSON.stringify(info, null, 2);
}

/** The song list's preview in Info.dat (seconds of the song). */
export function readPreview(text: string): { start: number; duration: number } {
  const info = JSON.parse(text) as Record<string, unknown>;
  const audio = (info.audio ?? {}) as Record<string, unknown>;
  return { start: Number(info._previewStartTime ?? audio.previewStartTime ?? 0), duration: Number(info._previewDuration ?? audio.previewDuration ?? 10) };
}

/** A song with `seconds` of silence put in front (cut off when negative). */
function withStart(buffer: AudioBuffer, seconds: number): { buffer: AudioBuffer; silence: number } {
  if (seconds >= 0) return { buffer, silence: seconds };
  const cut = Math.min(buffer.length - 1, Math.round(-seconds * buffer.sampleRate));
  const trimmed = new AudioBuffer({ length: buffer.length - cut, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) trimmed.copyToChannel(buffer.getChannelData(c).subarray(cut), c);
  return { buffer: trimmed, silence: 0 };
}

export async function mapSettingsDialog(editor: Editor): Promise<void> {
  const map = editor.map;
  if (map === null) return;
  const infoName = map.folder.files.find((name) => name.toLowerCase() === 'info.dat');
  if (infoName === undefined) return;
  const infoText = await map.folder.readText(infoName);
  const fields = readInfo(infoText, editor.row?.environmentId ?? 'DefaultEnvironment');
  const characteristic = editor.row?.infoDifficulty?.characteristic ?? 'Standard';
  const place: EnvironmentPlace = { file: editor.row === null ? '' : difficultyFile(editor.row), allDirections: characteristic === '360Degree' || characteristic === '90Degree' };

  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'ce-shade';
    const box = document.createElement('form');
    box.className = 'ce-dialog nm-dialog';
    box.innerHTML = `
      <div class="ce-dialog-title">Свойства карты</div>
      <div class="nm-grid">
        <label>Название<input type="text" data-id="title"></label>
        <label>Исполнитель<input type="text" data-id="artist"></label>
        <label>Подзаголовок<input type="text" data-id="sub"></label>
        <label>Автор карты<input type="text" data-id="mapper"></label>
        <label class="nm-wide">Окружение<select data-id="env"></select></label>
        <div class="nm-wide nm-dim" data-id="env-info"></div>
        <label>BPM
          <span class="nm-row"><input type="number" data-id="bpm" min="10" max="1000" step="any"><button type="button" data-id="detect">Определить</button></span>
        </label>
        <label>Проверка на слух
          <span class="nm-row"><button type="button" data-id="listen">▶ С метрономом</button><span data-id="alts" class="nm-alts"></span></span>
        </label>
        <div class="nm-wide nm-dim" data-id="bpm-info"></div>
        <label class="nm-wide nm-radio">При смене BPM события
          <span class="nm-row">
            <label><input type="radio" name="keep" value="beats" checked> остаются на своих долях</label>
            <label><input type="radio" name="keep" value="time"> остаются на своём месте в песне</label>
          </span>
        </label>
        <label>Тишина в начало
          <span class="nm-row"><input type="number" data-id="silence" step="any" value="0"><select data-id="unit"><option value="bars">тактов</option><option value="beats">долей</option><option value="seconds">секунд</option></select></span>
        </label>
        <label>Долей в такте<input type="number" data-id="bar" min="1" max="16" step="1" value="4"></label>
        <label class="nm-wide">Подогнать к сетке
          <span class="nm-row"><button type="button" data-id="align">Первая доля — на целую долю</button><button type="button" data-id="downbeat">Сильная доля — на начало такта</button><button type="button" data-id="unalign">Без подгонки</button></span>
        </label>
        <div class="nm-wide nm-dim" data-id="shift-info"></div>
        <label>Превью с, сек<input type="number" data-id="preview" step="any" min="0"></label>
        <label>Превью длится, сек
          <span class="nm-row"><input type="number" data-id="preview-length" step="any" min="1"><button type="button" data-id="from-range" title="Начало и длина превью — по участку, выделенному на таймлайне (Shift + протянуть по линейке или спектрограмме)">Из выделения</button></span>
        </label>
      </div>
      <div class="nm-status" data-id="status"></div>
      <div class="ce-dialog-buttons"><button type="button" data-id="cancel">Отмена</button><button type="submit" class="primary" data-id="apply">Применить</button></div>`;
    shade.append(box);
    document.body.append(shade);
    const el = <T extends HTMLElement>(id: string) => box.querySelector<T>(`[data-id="${id}"]`)!;
    el<HTMLInputElement>('title').value = fields.title;
    el<HTMLInputElement>('artist').value = fields.artist;
    el<HTMLInputElement>('sub').value = fields.subTitle;
    el<HTMLInputElement>('mapper').value = fields.mapper;
    el<HTMLInputElement>('bpm').value = String(fields.bpm);
    el<HTMLInputElement>('preview').value = String(fields.preview);
    el<HTMLInputElement>('preview-length').value = String(fields.previewDuration);
    // the environment: the classic ones (the editor's lights), the difficulty's own if it isn't one
    const env = el<HTMLSelectElement>('env');
    const known = new Set([...SHOW_ENVIRONMENTS, ...OTHER_ENVIRONMENTS].map(([id]) => id));
    const addGroup = (label: string, items: [string, string][]) => {
      const group = document.createElement('optgroup');
      group.label = label;
      for (const [id, name] of items) group.append(Object.assign(document.createElement('option'), { value: id, textContent: name }));
      env.append(group);
    };
    if (!known.has(fields.environment)) addGroup('Сейчас', [[fields.environment, fields.environment.replace(/Environment$/u, '')]]);
    addGroup('Шоу-окружения', SHOW_ENVIRONMENTS);
    addGroup('Остальные', OTHER_ENVIRONMENTS);
    env.value = fields.environment;
    const envInfo = () => {
      el('env-info').textContent =
        env.value === fields.environment
          ? fields.version === '4'
            ? 'Окружение этой сложности.'
            : `Окружение ${place.allDirections ? 'сложностей 360° и 90°' : 'всех обычных сложностей'} карты (в Info.dat v2 оно общее).`
          : 'Свет останется на тех же группах и light ID — у другого окружения их может быть другое число: проверьте строки ламп.';
    };
    env.addEventListener('change', envInfo);
    envInfo();
    el<HTMLButtonElement>('from-range').disabled = editor.songRange === null;
    el('from-range').addEventListener('click', () => {
      const range = editor.songRange;
      if (range === null) return;
      const start = editor.beatToSeconds(Math.min(range.start, range.end));
      const end = editor.beatToSeconds(Math.max(range.start, range.end));
      el<HTMLInputElement>('preview').value = Math.max(0, start).toFixed(2);
      el<HTMLInputElement>('preview-length').value = Math.max(1, end - start).toFixed(2);
    });
    if (fields.version === '4') {
      // (Info v4: the tempo lives in its audio data file — not changed here yet)
      el<HTMLInputElement>('bpm').disabled = true;
      el<HTMLInputElement>('mapper').disabled = true;
      for (const id of ['silence', 'unit', 'bar', 'align', 'downbeat', 'unalign']) el<HTMLInputElement>(id).disabled = true;
    }
    const hasBpmChanges = editor.bpmEvents.length > 0;
    if (hasBpmChanges) {
      for (const radio of box.querySelectorAll<HTMLInputElement>('input[name="keep"]')) radio.disabled = radio.value === 'time';
    }
    box.addEventListener('keydown', (event) => event.stopPropagation());
    const status = el('status');
    let audio: AudioBuffer | null = null;
    let detected: BpmResult | null = null;
    let stopListening: (() => void) | null = null;
    let busy = false;

    const song = async () => {
      if (audio !== null) return audio;
      const data = map.parsed.audioData;
      if (data === null) throw new Error('В карте нет песни');
      audio = await decodeAudio(data);
      return audio;
    };
    const bpmNow = () => Number(el<HTMLInputElement>('bpm').value) || fields.bpm;
    const beatsPerBar = () => Math.max(1, Math.round(Number(el<HTMLInputElement>('bar').value) || 4));
    const firstBeat = () => {
      if (detected === null) return 0;
      const period = 60 / bpmNow();
      return ((detected.firstBeat % period) + period) % period;
    };
    /** The silence asked for, in seconds (at the tempo in the box). */
    const silence = () => {
      const value = Number(el<HTMLInputElement>('silence').value) || 0;
      const unit = el<HTMLSelectElement>('unit').value;
      return unit === 'seconds' ? value : unit === 'beats' ? (value * 60) / bpmNow() : (value * beatsPerBar() * 60) / bpmNow();
    };
    /** On top of the silence: the nudge that lines the song up with the grid (seconds). */
    let align: { kind: 'none' | 'beat' | 'bar'; seconds: number; note: string } = { kind: 'none', seconds: 0, note: '' };
    const totalShift = () => (fields.version === '4' ? 0 : silence() + align.seconds);
    const showShift = () => {
      const total = totalShift();
      const parts = [
        Math.abs(total) < 1e-6 ? 'Начало песни не меняется.' : total > 0 ? `В начало песни добавится ${total.toFixed(3)} с тишины.` : `От начала песни отрежется ${(-total).toFixed(3)} с.`,
        align.note,
        Math.abs(total) > 1e-6 ? 'Ноты, стены и свет всех сложностей сдвинутся вместе с песней.' : '',
      ];
      el('shift-info').textContent = fields.version === '4' ? 'Для карт формата v4 темп и начало песни здесь пока не меняются.' : parts.filter((part) => part !== '').join(' ');
    };
    /** Works the nudge out again (the tempo, the silence or the bar changed). */
    const realign = async () => {
      if (align.kind === 'none') {
        align = { kind: 'none', seconds: 0, note: '' };
      } else {
        if (detected === null) await detect();
        if (detected === null) return;
        const lead = silence();
        if (align.kind === 'beat') {
          // the least change that puts the first beat on a whole beat
          const period = 60 / bpmNow();
          const at = (((firstBeat() + lead) % period) + period) % period;
          const seconds = at > period / 2 ? period - at : -at;
          align = { kind: 'beat', seconds, note: 'Доли песни лягут на целые доли сетки.' };
        } else {
          status.textContent = 'Ищу сильную долю…';
          busy = true;
          const bar = beatsPerBar();
          const found = await findDownbeat(await song(), bpmNow(), firstBeat(), bar);
          busy = false;
          status.textContent = '';
          // silence (not a cut) that puts the strong beat at the start of a bar — unless it is a hair late
          const barSeconds = (bar * 60) / bpmNow();
          const at = (((found.downbeat + lead) % barSeconds) + barSeconds) % barSeconds;
          let seconds = (barSeconds - at) % barSeconds;
          if (barSeconds - seconds < 0.03) seconds -= barSeconds;
          const lands = Math.round(((found.downbeat + lead + seconds) * bpmNow()) / 60);
          align = {
            kind: 'bar',
            seconds,
            note: `Сильная доля (в песне на ${found.downbeat.toFixed(2)} с${found.confidence < 0.15 ? ', найдена неуверенно — проверьте на слух' : ''}) встанет на долю ${String(lands)} — начало ${String(lands / bar + 1)}-го такта.`,
          };
        }
      }
      showShift();
    };
    const detect = async () => {
      busy = true;
      status.textContent = 'Определяю BPM…';
      try {
        detected = await findBpm(await song());
        const period = 60 / detected.bpm;
        const offset = ((detected.firstBeat % period) + period) % period;
        const off = offset > period / 2 ? offset - period : offset;
        el('bpm-info').textContent = `В песне ${String(detected.bpm)} BPM (в карте ${String(fields.bpm)}). Первая доля ${Math.abs(off) < 0.012 ? 'уже на сетке' : `${off > 0 ? 'позже' : 'раньше'} сетки на ${Math.abs(off * 1000).toFixed(0)} мс`}.`;
        el('alts').replaceChildren(
          ...[detected.bpm, ...detected.alternatives.slice(0, 2)].map((value) => {
            const pick = document.createElement('button');
            pick.type = 'button';
            pick.textContent = String(value);
            pick.addEventListener('click', () => (el<HTMLInputElement>('bpm').value = String(value)));
            return pick;
          }),
        );
        status.textContent = '';
      } catch (error) {
        status.textContent = `Не получилось: ${error instanceof Error ? error.message : String(error)}`;
      }
      busy = false;
    };
    el('detect').addEventListener('click', () => void detect());
    const alignTo = (kind: typeof align.kind) => {
      if (busy) return;
      align = { ...align, kind };
      void realign().catch((error: unknown) => {
        busy = false;
        status.textContent = `Не получилось: ${error instanceof Error ? error.message : String(error)}`;
      });
    };
    el('align').addEventListener('click', () => alignTo('beat'));
    el('downbeat').addEventListener('click', () => alignTo('bar'));
    el('unalign').addEventListener('click', () => alignTo('none'));
    for (const id of ['silence', 'unit', 'bar', 'bpm']) el(id).addEventListener('change', () => alignTo(align.kind));
    showShift();
    el('listen').addEventListener('click', () => {
      if (stopListening !== null) {
        stopListening();
        stopListening = null;
        el('listen').textContent = '▶ С метрономом';
        return;
      }
      void song().then((buffer) => {
        // (the map's own grid: beat 0 at the song's start)
        stopListening = playWithClicks(buffer, Number(el<HTMLInputElement>('bpm').value), 0, Math.max(0, buffer.duration * 0.3));
        el('listen').textContent = '■ Стоп';
      });
    });
    const finish = () => {
      stopListening?.();
      shade.remove();
      resolve();
    };
    el('cancel').addEventListener('click', () => {
      if (!busy) finish();
    });
    box.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      void (async () => {
        busy = true;
        try {
          if (editor.dirty) {
            status.textContent = 'Сохраняю изменения…';
            await editor.save();
          }
          const next: InfoFields = {
            ...fields,
            title: el<HTMLInputElement>('title').value.trim(),
            artist: el<HTMLInputElement>('artist').value.trim(),
            subTitle: el<HTMLInputElement>('sub').value.trim(),
            mapper: el<HTMLInputElement>('mapper').value.trim(),
            bpm: Number(el<HTMLInputElement>('bpm').value) || fields.bpm,
            preview: Number(el<HTMLInputElement>('preview').value) || 0,
            previewDuration: Number(el<HTMLInputElement>('preview-length').value) || fields.previewDuration,
            environment: env.value,
          };
          const shift = totalShift();
          const keepTime = box.querySelector<HTMLInputElement>('input[name="keep"]:checked')?.value === 'time';
          // the events: moved with the song's start (at the old tempo), then stretched to the new one
          const shiftBeats = (shift * fields.bpm) / 60;
          const scale = keepTime && next.bpm !== fields.bpm ? next.bpm / fields.bpm : 1;
          const beat = (b: number) => (b + shiftBeats) * scale;
          const length = (d: number) => d * scale;
          let dropped = 0;
          if (Math.abs(shift) > 1e-6 || scale !== 1) {
            for (const row of editor.difficulties()) {
              const file = difficultyFile(row);
              status.textContent = `Сдвигаю ${file}…`;
              const result = transformDifficultyBeats(await map.folder.readText(file), beat, length);
              dropped += result.dropped;
              await map.folder.writeText(file, result.text);
              const project = await loadProject(map.folder, file);
              if (project !== null) await map.folder.writeText(projectFileName(file), JSON.stringify(transformProjectBeats(project, beat, length)));
            }
          }
          if (Math.abs(shift) > 1e-6) {
            status.textContent = 'Перевожу песню…';
            const prepared = withStart(await song(), shift);
            const ogg = await encodeOgg(prepared.buffer, prepared.silence, (done) => (status.textContent = `Перевожу песню… ${String(Math.round(done * 100))}%`));
            await map.folder.writeBinary(fields.song, ogg.buffer.slice(ogg.byteOffset, ogg.byteOffset + ogg.byteLength) as ArrayBuffer);
            next.preview = Math.max(0, next.preview + shift);
          }
          await map.folder.writeText(infoName, writeInfo(await map.folder.readText(infoName), next, place));
          await map.folder.refresh();
          const key = editor.row?.key;
          status.textContent = 'Открываю карту заново…';
          await editor.open(map.folder);
          const row = editor.difficulties().find((item) => item.key === key);
          if (row !== undefined && row !== editor.row) await editor.openDifficulty(row);
          editor.setStatus(`Свойства карты изменены${dropped > 0 ? ` (отрезано событий до начала песни: ${String(dropped)})` : ''}`);
          finish();
        } catch (error) {
          console.error(error);
          status.textContent = `Не получилось: ${error instanceof Error ? error.message : String(error)}`;
          busy = false;
        }
      })();
    });
  });
}
