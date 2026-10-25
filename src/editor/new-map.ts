import { environmentCatalog, isGLSCapableEnvironment } from '../engine/renderer/environment/environment-catalog';
import { decodeAudio, encodeOgg, findBpm, playWithClicks } from './audio-tools';
import type { BpmResult } from './bpm-detect';
import { createMapFolder, type MapFolder } from './platform';

/**
 * "New map": a song (any audio file) → a map folder Beat Saber opens — the song as Ogg Vorbis
 * (with silence in front of it if wanted, lined up so the beats fall on the grid), Info.dat, an
 * empty difficulty (v3) and a cover. The tempo is found in the song (and can be checked by ear with
 * a metronome over it).
 */

const SHOW_ENVIRONMENTS: [string, string][] = [
  ['TimbalandEnvironment', 'Timbaland'],
  ['PanicEnvironment', 'Panic'],
  ['OriginsEnvironment', 'Origins'],
  ['BigMirrorEnvironment', 'Big Mirror'],
];

/** The other environments with classic lights (the editor's events), as ChroPaper knows them. */
const OTHER_ENVIRONMENTS: [string, string][] = environmentCatalog
  .filter((entry) => !isGLSCapableEnvironment(entry.id) && !SHOW_ENVIRONMENTS.some(([id]) => id === entry.id))
  .map((entry) => [entry.id, entry.title]);

const DIFFICULTIES: [string, number][] = [
  ['ExpertPlus', 9],
  ['Expert', 7],
  ['Hard', 5],
  ['Normal', 3],
  ['Easy', 1],
];

export interface NewMapSettings {
  title: string;
  subTitle: string;
  artist: string;
  mapper: string;
  bpm: number;
  /** Seconds of silence put in front of the song. */
  silence: number;
  environment: string;
  difficulty: string;
  label: string;
  previewStart: number;
}

/** Info.dat (v2.1.0: everything opens it) for a map with one difficulty (v3). */
export function infoText(settings: NewMapSettings, difficultyFile: string, songFile: string, coverFile: string | null) {
  const rank = DIFFICULTIES.find(([name]) => name === settings.difficulty)?.[1] ?? 9;
  return JSON.stringify(
    {
      _version: '2.1.0',
      _songName: settings.title,
      _songSubName: settings.subTitle,
      _songAuthorName: settings.artist,
      _levelAuthorName: settings.mapper,
      _beatsPerMinute: settings.bpm,
      _shuffle: 0,
      _shufflePeriod: 0.5,
      _previewStartTime: Math.round(settings.previewStart * 100) / 100,
      _previewDuration: 10,
      _songFilename: songFile,
      _coverImageFilename: coverFile ?? '',
      _environmentName: settings.environment,
      _allDirectionsEnvironmentName: 'GlassDesertEnvironment',
      _songTimeOffset: 0,
      _customData: { _editors: { _lastEditedBy: 'ChroEditor', ChroEditor: { version: '0.3.0' } } },
      _difficultyBeatmapSets: [
        {
          _beatmapCharacteristicName: 'Standard',
          _difficultyBeatmaps: [
            {
              _difficulty: settings.difficulty,
              _difficultyRank: rank,
              _beatmapFilename: difficultyFile,
              _noteJumpMovementSpeed: 16,
              _noteJumpStartBeatOffset: 0,
              _customData: { _difficultyLabel: settings.label, _suggestions: ['Chroma'] },
            },
          ],
        },
      ],
    },
    null,
    2,
  );
}

/** An empty v3 difficulty. */
export function emptyDifficulty() {
  return JSON.stringify({
    version: '3.3.0',
    bpmEvents: [],
    rotationEvents: [],
    colorNotes: [],
    bombNotes: [],
    obstacles: [],
    sliders: [],
    burstSliders: [],
    waypoints: [],
    basicBeatmapEvents: [],
    colorBoostBeatmapEvents: [],
    lightColorEventBoxGroups: [],
    lightRotationEventBoxGroups: [],
    lightTranslationEventBoxGroups: [],
    vfxEventBoxGroups: [],
    _fxEventsCollection: { _fl: [], _il: [] },
    basicEventTypesWithKeywords: { d: [] },
    useNormalEventsAsCompatibleEvents: true,
    customData: {},
  });
}

/** A cover: the picture the user chose (cropped square), or one drawn from the title. */
async function coverJpeg(picture: File | null, title: string, artist: string): Promise<ArrayBuffer> {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  if (picture !== null) {
    const bitmap = await createImageBitmap(picture);
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  } else {
    let hash = 0;
    for (const char of title + artist) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, `hsl(${String(hash)} 70% 22%)`);
    gradient.addColorStop(1, `hsl(${String((hash + 140) % 360)} 70% 12%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = `hsla(${String(hash)} 90% 65% / 0.55)`;
    ctx.lineWidth = 3;
    for (let i = 0; i < 7; i++) {
      const inset = 40 + i * 26;
      ctx.strokeRect(inset, inset, size - inset * 2, size - inset * 2);
    }
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 44px system-ui, sans-serif';
    wrapText(ctx, title || 'Без названия', size / 2, size - 120, size - 60, 48);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillText(artist, size / 2, size - 40);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (blob === null) throw new Error('cover');
  return blob.arrayBuffer();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, bottom: number, width: number, line: number) {
  const words = text.split(/\s+/u);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current === '' ? word : `${current} ${word}`;
    if (ctx.measureText(next).width > width && current !== '') {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current !== '') lines.push(current);
  const shown = lines.slice(0, 3);
  shown.forEach((text, index) => ctx.fillText(text, x, bottom - (shown.length - 1 - index) * line));
}

/** File and folder names Windows accepts. */
export function safeName(text: string) {
  return text.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 80) || 'Новая карта';
}

/**
 * Silence to put in front so the first beat lands on a whole beat of the grid: at least `wanted`
 * seconds (0 when `align` is off: just `wanted`).
 */
export function alignedSilence(wanted: number, firstBeat: number, bpm: number, align: boolean) {
  if (!align || bpm <= 0) return Math.max(0, wanted);
  const period = 60 / bpm;
  const beats = Math.ceil((Math.max(0, wanted) + firstBeat) / period - 1e-6);
  return Math.max(0, beats * period - firstBeat);
}

/** Shows the dialog; resolves with the new map's folder (null: cancelled). */
export function newMapDialog(defaultMapper: string): Promise<MapFolder | null> {
  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'ce-shade';
    const box = document.createElement('form');
    box.className = 'ce-dialog nm-dialog';
    box.innerHTML = `
      <div class="ce-dialog-title">Новая карта</div>
      <div class="nm-grid">
        <label class="nm-wide">Песня
          <span class="nm-row"><button type="button" data-id="pick">Выбрать файл…</button><span data-id="song" class="nm-dim">mp3, ogg, wav, flac, m4a</span></span>
        </label>
        <label>Название<input type="text" data-id="title"></label>
        <label>Исполнитель<input type="text" data-id="artist"></label>
        <label>Подзаголовок<input type="text" data-id="sub"></label>
        <label>Автор карты<input type="text" data-id="mapper"></label>
        <label>BPM
          <span class="nm-row"><input type="number" data-id="bpm" min="10" max="1000" step="0.01" value="120"><button type="button" data-id="detect" disabled>Определить</button></span>
        </label>
        <label>Проверка на слух
          <span class="nm-row"><button type="button" data-id="listen" disabled>▶ С метрономом</button><span data-id="alts" class="nm-alts"></span></span>
        </label>
        <div class="nm-wide nm-dim" data-id="bpm-info"></div>
        <label>Тишина в начале, с<input type="number" data-id="silence" min="0" max="30" step="0.1" value="0"></label>
        <label class="nm-check"><input type="checkbox" data-id="align" checked> Первая доля — на целой доле сетки</label>
        <div class="nm-wide nm-dim" data-id="silence-info"></div>
        <label>Окружение<select data-id="env"></select></label>
        <label>Сложность<select data-id="diff"></select></label>
        <label>Подпись сложности<input type="text" data-id="label" value="Lightshow"></label>
        <label>Обложка
          <span class="nm-row"><button type="button" data-id="cover-pick">Картинка…</button><span data-id="cover" class="nm-dim">нарисую сам</span></span>
        </label>
      </div>
      <div class="nm-status" data-id="status"></div>
      <div class="ce-dialog-buttons"><button type="button" data-id="cancel">Отмена</button><button type="submit" class="primary" data-id="create" disabled>Создать карту…</button></div>`;
    shade.append(box);
    document.body.append(shade);
    const el = <T extends HTMLElement>(id: string) => box.querySelector<T>(`[data-id="${id}"]`)!;
    const env = el<HTMLSelectElement>('env');
    const addGroup = (label: string, items: [string, string][]) => {
      const group = document.createElement('optgroup');
      group.label = label;
      for (const [id, name] of items) group.append(Object.assign(document.createElement('option'), { value: id, textContent: name }));
      env.append(group);
    };
    addGroup('Шоу-окружения', SHOW_ENVIRONMENTS);
    addGroup('Остальные', OTHER_ENVIRONMENTS);
    const diff = el<HTMLSelectElement>('diff');
    for (const [name] of DIFFICULTIES) diff.append(Object.assign(document.createElement('option'), { value: name, textContent: name === 'ExpertPlus' ? 'Expert+' : name }));
    el<HTMLInputElement>('mapper').value = defaultMapper;

    let audio: AudioBuffer | null = null;
    let detected: BpmResult | null = null;
    let cover: File | null = null;
    let stopListening: (() => void) | null = null;
    let busy = false;
    const status = el('status');
    const bpmInput = el<HTMLInputElement>('bpm');
    const silenceInput = el<HTMLInputElement>('silence');
    const align = el<HTMLInputElement>('align');

    const firstBeat = () => {
      // (the grid's phase holds for the bpm typed in as long as it is the found one or a multiple)
      if (detected === null) return 0;
      const bpm = Number(bpmInput.value);
      const period = 60 / bpm;
      return ((detected.firstBeat % period) + period) % period;
    };
    const silence = () => alignedSilence(Number(silenceInput.value) || 0, firstBeat(), Number(bpmInput.value), align.checked && detected !== null);
    const refresh = () => {
      const s = silence();
      el('silence-info').textContent = audio === null ? '' : `В начало песни будет добавлено ${s.toFixed(3)} с тишины.${detected !== null && align.checked ? ' Первая доля попадёт ровно на долю сетки.' : ''}`;
      el<HTMLButtonElement>('create').disabled = audio === null || busy || !(Number(bpmInput.value) > 0) || el<HTMLInputElement>('title').value.trim() === '';
      el<HTMLButtonElement>('detect').disabled = audio === null || busy;
      el<HTMLButtonElement>('listen').disabled = audio === null || busy;
    };
    box.addEventListener('input', refresh);
    box.addEventListener('keydown', (event) => event.stopPropagation());

    const detect = async () => {
      if (audio === null) return;
      busy = true;
      refresh();
      status.textContent = 'Определяю BPM…';
      try {
        detected = await findBpm(audio);
        bpmInput.value = String(detected.bpm);
        const sure = detected.confidence > 0.6 ? 'уверенно' : detected.confidence > 0.35 ? 'довольно уверенно' : 'неуверенно — проверьте на слух';
        el('bpm-info').textContent = `Найдено ${String(detected.bpm)} BPM (${sure}), первая доля на ${detected.firstBeat.toFixed(3)} с.`;
        const alts = el('alts');
        alts.replaceChildren(
          ...detected.alternatives.slice(0, 3).map((value) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = String(value);
            button.title = 'Взять этот темп';
            button.addEventListener('click', () => {
              bpmInput.value = String(value);
              refresh();
            });
            return button;
          }),
        );
        status.textContent = '';
      } catch (error) {
        status.textContent = `Не получилось определить BPM: ${error instanceof Error ? error.message : String(error)}`;
      }
      busy = false;
      refresh();
    };

    el('pick').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*,.ogg,.egg,.mp3,.wav,.flac,.m4a,.aac,.opus';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (file === undefined) return;
        busy = true;
        refresh();
        status.textContent = `Читаю ${file.name}…`;
        try {
          audio = await decodeAudio(await file.arrayBuffer());
          const minutes = Math.floor(audio.duration / 60);
          el('song').textContent = `${file.name} · ${String(minutes)}:${String(Math.floor(audio.duration % 60)).padStart(2, '0')}`;
          // the title (and the artist) from the file name: "Artist - Title"
          const base = file.name.replace(/\.[^.]+$/u, '');
          const parts = base.split(/\s+[-–—]\s+/u);
          if (el<HTMLInputElement>('title').value === '') el<HTMLInputElement>('title').value = (parts.length > 1 ? parts.slice(1).join(' - ') : base).trim();
          if (el<HTMLInputElement>('artist').value === '' && parts.length > 1) el<HTMLInputElement>('artist').value = parts[0]!.trim();
          status.textContent = '';
          busy = false;
          await detect();
        } catch (error) {
          audio = null;
          status.textContent = `Не удалось прочитать звук: ${error instanceof Error ? error.message : String(error)}`;
        }
        busy = false;
        refresh();
      });
      input.click();
    });
    el('detect').addEventListener('click', () => void detect());
    el('listen').addEventListener('click', () => {
      if (stopListening !== null) {
        stopListening();
        stopListening = null;
        el('listen').textContent = '▶ С метрономом';
        return;
      }
      if (audio === null) return;
      const from = Math.max(0, audio.duration * 0.3);
      stopListening = playWithClicks(audio, Number(bpmInput.value), firstBeat(), from);
      el('listen').textContent = '■ Стоп';
    });
    el('cover-pick').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', () => {
        cover = input.files?.[0] ?? null;
        el('cover').textContent = cover?.name ?? 'нарисую сам';
      });
      input.click();
    });
    const finish = (result: MapFolder | null) => {
      stopListening?.();
      shade.remove();
      resolve(result);
    };
    el('cancel').addEventListener('click', () => {
      if (!busy) finish(null);
    });
    box.addEventListener('submit', (event) => {
      event.preventDefault();
      if (audio === null || busy) return;
      const settings: NewMapSettings = {
        title: el<HTMLInputElement>('title').value.trim(),
        subTitle: el<HTMLInputElement>('sub').value.trim(),
        artist: el<HTMLInputElement>('artist').value.trim(),
        mapper: el<HTMLInputElement>('mapper').value.trim(),
        bpm: Number(bpmInput.value),
        silence: silence(),
        environment: env.value,
        difficulty: diff.value,
        label: el<HTMLInputElement>('label').value.trim(),
        previewStart: silence() + audio.duration * 0.35,
      };
      const song = audio;
      void (async () => {
        busy = true;
        refresh();
        try {
          const folder = await createMapFolder(safeName(settings.artist === '' ? settings.title : `${settings.artist} - ${settings.title}`));
          if (folder === null) {
            busy = false;
            refresh();
            return;
          }
          status.textContent = 'Перевожу песню в ogg… 0%';
          const ogg = await encodeOgg(song, settings.silence, (done) => (status.textContent = `Перевожу песню в ogg… ${String(Math.round(done * 100))}%`));
          status.textContent = 'Записываю карту…';
          const difficultyFile = `${settings.difficulty}Standard.dat`;
          await folder.writeBinary('song.ogg', ogg.buffer.slice(ogg.byteOffset, ogg.byteOffset + ogg.byteLength) as ArrayBuffer);
          await folder.writeBinary('cover.jpg', await coverJpeg(cover, settings.title, settings.artist));
          await folder.writeText(difficultyFile, emptyDifficulty());
          await folder.writeText('Info.dat', infoText(settings, difficultyFile, 'song.ogg', 'cover.jpg'));
          await folder.refresh();
          try {
            localStorage.setItem('chroeditor.mapper', settings.mapper);
          } catch {
            // (only a convenience)
          }
          finish(folder);
        } catch (error) {
          status.textContent = `Не получилось: ${error instanceof Error ? error.message : String(error)}`;
          busy = false;
          refresh();
        }
      })();
    });
    refresh();
  });
}
