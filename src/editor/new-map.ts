import { volumeControl, withGain } from './song-volume';
import { DEFAULT_NJS } from './jump';
import { difficultyPanel } from './difficulty-panel';
import { silencePreview } from './silence-preview';
import { writeSongSource } from './song-source';
import type { Spectrogram } from './spectrogram';
import { environmentCatalog, isGLSCapableEnvironment } from '../engine/renderer/environment/environment-catalog';
import { choiceLabel, environmentGallery, type EnvironmentChoice } from './environment-gallery';
import { readTags } from './song-tags';
import { decodeAudio, encodeOgg, findBpm, findDownbeat, playWithClicks } from './audio-tools';
import type { BpmResult } from './bpm-detect';
import { createMapFolder, type MapFolder } from './platform';
import { previewPicker, type PreviewPicker } from './song-picker';
import { computeSpectrogram } from './spectrogram';
import { setSettings as setEditorSettings, settings as editorSettings } from './settings';
import { oggQualitySlider } from './grids';

/**
 * "New map": a song (any audio file) → a map folder Beat Saber opens — the song as Ogg Vorbis
 * (with silence in front of it if wanted, lined up so the beats fall on the grid), Info.dat, an
 * empty difficulty (v3) and a cover. The tempo is found in the song (and can be checked by ear with
 * a metronome over it).
 */

export const SHOW_ENVIRONMENTS: [string, string][] = [
  ['TimbalandEnvironment', 'Timbaland'],
  ['PanicEnvironment', 'Panic'],
  ['OriginsEnvironment', 'Origins'],
  ['BigMirrorEnvironment', 'Big Mirror'],
];

/** The other environments with classic lights (the editor's events), as ChroPaper knows them. */
export const OTHER_ENVIRONMENTS: [string, string][] = environmentCatalog
  .filter((entry) => !isGLSCapableEnvironment(entry.id) && !SHOW_ENVIRONMENTS.some(([id]) => id === entry.id))
  .map((entry) => [entry.id, entry.title]);

/** The game's environments in the order they came out (oldest first; the ones not listed after them). */
const RELEASE_ORDER = [
  'DefaultEnvironment',
  'TriangleEnvironment',
  'NiceEnvironment',
  'BigMirrorEnvironment',
  'KDAEnvironment',
  'MonstercatEnvironment',
  'CrabRaveEnvironment',
  'DragonsEnvironment',
  'OriginsEnvironment',
  'GlassDesertEnvironment',
  'PanicEnvironment',
  'RocketEnvironment',
  'GreenDayEnvironment',
  'GreenDayGrenadeEnvironment',
  'TimbalandEnvironment',
  'FitBeatEnvironment',
  'LinkinParkEnvironment',
  'BTSEnvironment',
  'KaleidoscopeEnvironment',
  'InterscopeEnvironment',
  'SkrillexEnvironment',
  'BillieEnvironment',
  'HalloweenEnvironment',
  'GagaEnvironment',
  'WeaveEnvironment',
  'PyroEnvironment',
  'EDMEnvironment',
  'TheSecondEnvironment',
  'LizzoEnvironment',
  'TheWeekndEnvironment',
  'RockMixtapeEnvironment',
  'Dragons2Environment',
  'Panic2Environment',
  'QueenEnvironment',
  'LinkinPark2Environment',
  'TheRollingStonesEnvironment',
  'LatticeEnvironment',
  'DaftPunkEnvironment',
  'HipHopEnvironment',
  'ColliderEnvironment',
  'BritneyEnvironment',
  'Monstercat2Environment',
  'MetallicaEnvironment',
];

/** Every environment with classic lights the editor offers, in the order they came out in the game. */
export const STANDARD_ENVIRONMENTS: [string, string][] = [...SHOW_ENVIRONMENTS, ...OTHER_ENVIRONMENTS].sort(([a], [b]) => {
  const rank = (id: string) => {
    const index = RELEASE_ORDER.indexOf(id);
    return index < 0 ? RELEASE_ORDER.length : index;
  };
  return rank(a) - rank(b);
});

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
  /** The difficulties made (their mode, name, label, NJS and offset). */
  difficulties: { characteristic: string; difficulty: string; label: string; njs: number; offset: number }[];
  previewStart: number;
  previewDuration: number;
}

/** A new difficulty's file name. */
export const newDifficultyFile = (entry: { characteristic: string; difficulty: string }) => `${entry.difficulty}${entry.characteristic}.dat`;

/** Info.dat (v2.1.0: everything opens it) for a new map and its difficulties. */
export function infoText(settings: NewMapSettings, songFile: string, coverFile: string | null) {
  const sets = [...new Set(settings.difficulties.map((entry) => entry.characteristic))].map((characteristic) => ({
    _beatmapCharacteristicName: characteristic,
    _difficultyBeatmaps: settings.difficulties
      .filter((entry) => entry.characteristic === characteristic)
      .map((entry) => ({ ...entry, rank: DIFFICULTIES.find(([name]) => name === entry.difficulty)?.[1] ?? 9 }))
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => ({
        _difficulty: entry.difficulty,
        _difficultyRank: entry.rank,
        _beatmapFilename: newDifficultyFile(entry),
        _noteJumpMovementSpeed: entry.njs,
        _noteJumpStartBeatOffset: entry.offset,
        _customData: { ...(entry.label === '' ? {} : { _difficultyLabel: entry.label }), _suggestions: ['Chroma'] },
      })),
  }));
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
      _previewDuration: Math.round(settings.previewDuration * 100) / 100,
      _songFilename: songFile,
      _coverImageFilename: coverFile ?? '',
      _environmentName: settings.environment,
      _allDirectionsEnvironmentName: 'GlassDesertEnvironment',
      _songTimeOffset: 0,
      _customData: { _editors: { _lastEditedBy: 'Lumatic', Lumatic: { version: __APP_VERSION__ } } },
      _difficultyBeatmapSets: sets,
    },
    null,
    2,
  );
}

/** An empty difficulty: v3, or v2 (the settings' format for new maps). */
export function emptyDifficulty(format: '2' | '3' = '3') {
  if (format === '2') return JSON.stringify({ _version: '2.6.0', _notes: [], _obstacles: [], _events: [], _waypoints: [], _customData: {} });
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

/** Shows the dialog; resolves with the new map's folder and the ready-made environment to put on it
 *  (null: cancelled). */
export function newMapDialog(defaultMapper: string): Promise<{ folder: MapFolder; preset?: string } | null> {
  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'ce-shade';
    const box = document.createElement('form');
    box.className = 'ce-dialog nm-dialog nm-new';
    box.innerHTML = `
      <div class="ce-dialog-title">Новая карта</div>
      <div class="nm-scroll">
        <div class="nm-song">
          <button type="button" class="nm-cover-big" data-id="cover-pick" title="Обложка: картинка из тегов песни, своя — по клику, или нарисую сам из названия">
            <img data-id="cover-image" alt="" hidden><span>Обложка</span>
          </button>
          <div class="nm-song-main">
            <div class="nm-row"><button type="button" class="primary" data-id="pick">🎵 Выбрать песню…</button><span data-id="song" class="nm-dim">mp3, ogg, wav, flac, m4a — название, исполнитель и обложка возьмутся из тегов</span></div>
            <div class="nm-grid nm-names">
              <label>Название<input type="text" data-id="title"></label>
              <label>Исполнитель<input type="text" data-id="artist"></label>
              <label>Подзаголовок<input type="text" data-id="sub"></label>
              <label>Автор карты<input type="text" data-id="mapper"></label>
            </div>
            <div class="nm-dim">Обложка: <span data-id="cover">нарисую сам</span></div>
            <div class="nm-row nm-ogg" title="Песня переводится в Ogg Vorbis: выше — лучше звук и больше файл (6 — обычно достаточно)"><span class="nm-dim">Качество песни (ogg)</span><span data-id="ogg"></span></div>
          </div>
        </div>
        <div class="nm-cols">
          <section class="nm-col">
            <div class="nm-section">Темп и начало</div>
            <div class="nm-grid">
              <label>BPM
                <span class="nm-row"><input type="number" data-id="bpm" min="10" max="1000" step="0.01" value="120"><button type="button" data-id="detect" disabled>Определить</button></span>
              </label>
              <label>Проверка на слух
                <span class="nm-row"><button type="button" data-id="listen" disabled>▶ С метрономом</button></span>
              </label>
              <div class="nm-wide nm-row nm-alts" data-id="alts"></div>
              <div class="nm-wide nm-dim" data-id="bpm-info"></div>
              <label>Тишина в начале
                <span class="nm-row"><input type="number" data-id="silence" min="0" step="any" value="0"><select data-id="unit"><option value="bars">тактов</option><option value="beats">долей</option><option value="seconds">секунд</option></select></span>
              </label>
              <label>Долей в такте<input type="number" data-id="bar" min="1" max="16" step="1" value="4"></label>
              <label class="nm-wide">Подогнать к сетке<select data-id="align">
                <option value="bar">Сильная доля — на начало такта</option>
                <option value="beat">Первая доля — на целую долю</option>
                <option value="none">Без подгонки</option>
              </select></label>
              <div class="nm-wide nm-dim" data-id="silence-info"></div>
              <div class="nm-wide" data-id="silence-preview"></div>
            </div>
            <div class="nm-section">Громкость песни</div>
            <div data-id="volume"></div>
            <div class="nm-section">Окружение</div>
            <div class="env-plate" data-id="env"></div>
            <div class="nm-section">Превью в списке песен</div>
            <div class="nm-grid">
              <label>Превью с, сек<input type="number" data-id="preview" step="any" min="0"></label>
              <label>Превью длится, сек<input type="number" data-id="preview-length" step="any" min="1" value="10"></label>
            </div>
            <div data-id="picker"><div class="nm-dim">Появится, когда выберете песню.</div></div>
          </section>
          <section class="nm-col">
            <div class="nm-section">Сложности</div>
            <div data-id="diffs"></div>
          </section>
        </div>
      </div>
      <div class="nm-foot">
        <div class="nm-status" data-id="status"></div>
        <button type="button" data-id="cancel">Отмена</button><button type="submit" class="primary" data-id="create" disabled>Создать карту…</button>
      </div>`;
    shade.append(box);
    document.body.append(shade);
    const el = <T extends HTMLElement>(id: string) => box.querySelector<T>(`[data-id="${id}"]`)!;
    // the environment: a plate (picture, name, who made it) and the gallery to pick from
    let choice: EnvironmentChoice = { environment: SHOW_ENVIRONMENTS[0]![0] };
    environmentPlate(el<HTMLElement>('env'), choice, 'Окружение новой карты', (picked) => (choice = picked));
    // the difficulties (as ChroMapper shows them): Expert+ to start with
    const diffs = difficultyPanel({ bpm: 120, entries: [{ characteristic: 'Standard', difficulty: 'ExpertPlus', enabled: true, njs: DEFAULT_NJS.ExpertPlus ?? 16, offset: 0, label: '' }] });
    el('diffs').append(diffs.element);
    const jump = { set: (patch: { bpm?: number }) => patch.bpm !== undefined && diffs.setBpm(patch.bpm) };
    // the song's start as it will be (the silence, the beats)
    const startView = silencePreview();
    el('silence-preview').append(startView.element);
    // the preview typed in: the picker follows
    for (const id of ['preview', 'preview-length']) el(id).addEventListener('change', () => picker?.set(Number(el<HTMLInputElement>('preview').value) || 0, Number(el<HTMLInputElement>('preview-length').value) || 10));
    let spectrogram: Spectrogram | null = null;
    el<HTMLInputElement>('mapper').value = defaultMapper;
    el('ogg').append(oggQualitySlider(editorSettings().oggQuality, (quality) => setEditorSettings({ oggQuality: quality })));

    let audio: AudioBuffer | null = null;
    // (the song's loudness changed in the map's file; the original is kept as it is)
    const volume = volumeControl(0, () => (audio === null ? 0 : audio.duration * 0.35));
    volume.setSong(null);
    el('volume').append(volume.element);
    /** The picked file as it is (kept in the map as the song's source). */
    let original: { data: ArrayBuffer; name: string } | null = null;
    let detected: BpmResult | null = null;
    let cover: File | null = null;
    /** The cover came from the song's tags (another song's replaces it). */
    let coverFromSong = false;
    /** What the last song filled in (another song replaces it, what was typed stays). */
    let named = { title: '', artist: '' };
    let coverUrl = '';
    /** The cover chosen (a small picture of it) and where it comes from. */
    const showCover = (label: string) => {
      if (coverUrl !== '') URL.revokeObjectURL(coverUrl);
      coverUrl = cover === null ? '' : URL.createObjectURL(cover);
      const image = el<HTMLImageElement>('cover-image');
      image.hidden = cover === null;
      image.src = coverUrl;
      el('cover').textContent = label;
    };
    let stopListening: (() => void) | null = null;
    let busy = false;
    const status = el('status');
    const bpmInput = el<HTMLInputElement>('bpm');
    bpmInput.addEventListener('input', () => {
      if (Number(bpmInput.value) > 0) jump.set({ bpm: Number(bpmInput.value) });
    });
    const silenceInput = el<HTMLInputElement>('silence');
    const align = el<HTMLSelectElement>('align');
    const unit = el<HTMLSelectElement>('unit');
    const barInput = el<HTMLInputElement>('bar');
    const beatsPerBar = () => Math.max(1, Math.round(Number(barInput.value) || 4));
    /** The strong beat as found for a tempo, grid and bar (null: not looked for yet). */
    let downbeat: { key: string; time: number; confidence: number } | null = null;
    let picker: PreviewPicker | null = null;

    const firstBeat = () => {
      // (the grid's phase holds for the bpm typed in as long as it is the found one or a multiple)
      if (detected === null) return 0;
      const bpm = Number(bpmInput.value);
      const period = 60 / bpm;
      return ((detected.firstBeat % period) + period) % period;
    };
    const downbeatKey = () => `${bpmInput.value}|${firstBeat().toFixed(4)}|${String(beatsPerBar())}`;
    /** The silence asked for (in its units), in seconds. */
    const lead = () => {
      const value = Math.max(0, Number(silenceInput.value) || 0);
      const bpm = Number(bpmInput.value) || 120;
      return unit.value === 'seconds' ? value : unit.value === 'beats' ? (value * 60) / bpm : (value * beatsPerBar() * 60) / bpm;
    };
    const silence = () => {
      const bpm = Number(bpmInput.value);
      if (detected === null || !(bpm > 0) || align.value === 'none') return lead();
      if (align.value === 'beat' || downbeat === null || downbeat.key !== downbeatKey()) return alignedSilence(lead(), firstBeat(), bpm, true);
      // more silence, up to a bar: the strong beat at the start of a bar
      const barSeconds = (beatsPerBar() * 60) / bpm;
      const at = (((downbeat.time + lead()) % barSeconds) + barSeconds) % barSeconds;
      return lead() + ((barSeconds - at) % barSeconds);
    };
    /** Finds the strong beat when it is wanted and not found for this tempo yet. */
    const findStrong = async () => {
      if (audio === null || detected === null || align.value !== 'bar' || downbeat?.key === downbeatKey()) return;
      const key = downbeatKey();
      status.textContent = 'Ищу сильную долю…';
      try {
        const found = await findDownbeat(audio, Number(bpmInput.value), firstBeat(), beatsPerBar());
        downbeat = { key, time: found.downbeat, confidence: found.confidence };
        status.textContent = '';
      } catch (error) {
        status.textContent = `Не нашлась сильная доля: ${error instanceof Error ? error.message : String(error)}`;
      }
      refresh();
    };
    const refresh = () => {
      if (Number(bpmInput.value) > 0) jump.set({ bpm: Number(bpmInput.value) });
      const s = silence();
      const strong = align.value === 'bar' && downbeat !== null && downbeat.key === downbeatKey();
      const lands = strong ? Math.round(((downbeat!.time + s) * Number(bpmInput.value)) / 60) : 0;
      el('silence-info').textContent =
        audio === null
          ? ''
          : `В начало песни будет добавлено ${s.toFixed(3)} с тишины.${
              detected === null || align.value === 'none'
                ? ''
                : strong
                  ? ` Сильная доля встанет на долю ${String(lands)} — начало ${String(lands / beatsPerBar() + 1)}-го такта${downbeat!.confidence < 0.15 ? ' (найдена неуверенно — проверьте на слух)' : ''}.`
                  : ' Первая доля попадёт ровно на долю сетки.'
            }`;
      picker?.setLead(s);
      if (audio !== null) startView.update({ spectrogram, lead: s, bpm: Number(bpmInput.value) || 120, beatsPerBar: beatsPerBar(), firstBeat: detected?.firstBeat ?? null, downbeat: strong ? downbeat!.time : null });
      el<HTMLButtonElement>('create').disabled = audio === null || busy || !(Number(bpmInput.value) > 0) || el<HTMLInputElement>('title').value.trim() === '';
      el<HTMLButtonElement>('detect').disabled = audio === null || busy;
      el<HTMLButtonElement>('listen').disabled = audio === null || busy;
    };
    box.addEventListener('input', refresh);
    for (const control of [align, bpmInput, barInput, unit]) control.addEventListener('change', () => void findStrong());
    box.addEventListener('keydown', (event) => event.stopPropagation());

    const detect = async () => {
      if (audio === null) return;
      busy = true;
      refresh();
      status.textContent = 'Определяю BPM…';
      try {
        detected = await findBpm(audio);
        bpmInput.value = String(detected.bpm);
        downbeat = null;
        const sure = detected.confidence > 0.6 ? 'уверенно' : detected.confidence > 0.35 ? 'довольно уверенно' : 'неуверенно — проверьте на слух';
        el('bpm-info').textContent = `Найдено ${String(detected.bpm)} BPM (${sure}), первая доля на ${detected.firstBeat.toFixed(3)} с.`;
        const alts = el('alts');
        const others = detected.alternatives.slice(0, 3);
        alts.replaceChildren(
          ...(others.length > 0 ? [Object.assign(document.createElement('span'), { className: 'nm-dim', textContent: 'Или, может быть:' })] : []),
          ...others.map((value) => {
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
      await findStrong();
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
          const data = await file.arrayBuffer();
          audio = await decodeAudio(data);
          original = { data, name: file.name };
          volume.setSong(audio);
          const minutes = Math.floor(audio.duration / 60);
          el('song').textContent = `${file.name} · ${String(minutes)}:${String(Math.floor(audio.duration % 60)).padStart(2, '0')}`;
          // the title, the artist and the cover from the file's tags; else from its name: "Artist - Title"
          const tags = readTags(data);
          const base = file.name.replace(/\.[^.]+$/u, '');
          const parts = base.split(/\s+[-–—]\s+/u);
          const title = tags.title ?? (parts.length > 1 ? parts.slice(1).join(' - ') : base).trim();
          const artist = tags.artist ?? (parts.length > 1 ? parts[0]!.trim() : '');
          if (el<HTMLInputElement>('title').value === '' || el<HTMLInputElement>('title').value === named.title) el<HTMLInputElement>('title').value = title;
          if (el<HTMLInputElement>('artist').value === '' || el<HTMLInputElement>('artist').value === named.artist) el<HTMLInputElement>('artist').value = artist;
          named = { title, artist };
          if (tags.picture !== undefined && (cover === null || coverFromSong)) {
            cover = new File([new Uint8Array(tags.picture.data)], 'cover', { type: tags.picture.type });
            coverFromSong = true;
            showCover('из тегов песни');
          }
          status.textContent = '';
          busy = false;
          // the preview: picked on the song (a third of the way in, to start with)
          picker?.stop();
          const computed = computeSpectrogram(audio);
          void computed.then((made) => {
            spectrogram = made;
            refresh();
          });
          picker = previewPicker(audio, computed, audio.duration * 0.35, 10, (start, duration) => {
            el<HTMLInputElement>('preview').value = start.toFixed(2);
            el<HTMLInputElement>('preview-length').value = duration.toFixed(2);
          });
          el<HTMLInputElement>('preview').value = (silence() + audio.duration * 0.35).toFixed(2);
          el<HTMLInputElement>('preview-length').value = '10.00';
          el('picker').replaceChildren(picker.element);
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
      const strong = align.value === 'bar' && downbeat !== null && downbeat.key === downbeatKey() ? { downbeat: downbeat.time, beats: beatsPerBar() } : null;
      const listening = playWithClicks(audio, Number(bpmInput.value), firstBeat(), from, strong);
      stopListening = listening;
      startView.listen(listening);
      el('listen').textContent = '■ Стоп';
    });
    el('cover-pick').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', () => {
        cover = input.files?.[0] ?? null;
        coverFromSong = false;
        showCover(cover?.name ?? 'нарисую сам');
      });
      input.click();
    });
    const finish = (result: { folder: MapFolder; preset?: string } | null) => {
      document.querySelector('.dp-menu')?.remove();
      if (coverUrl !== '') URL.revokeObjectURL(coverUrl);
      stopListening?.();
      picker?.stop();
      volume.stop();
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
        environment: choice.environment,
        difficulties: diffs.entries().filter((entry) => entry.enabled),
        previewStart: picker?.value().start ?? silence() + audio.duration * 0.35,
        previewDuration: picker?.value().duration ?? 10,
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
          const gain = volume.value();
          const ogg = await encodeOgg(withGain(song, gain), settings.silence, (done) => (status.textContent = `Перевожу песню в ogg… ${String(Math.round(done * 100))}%`));
          status.textContent = 'Записываю карту…';
          if (settings.difficulties.length === 0) throw new Error('Отметьте хотя бы одну сложность');
          await folder.writeBinary('song.ogg', ogg.buffer.slice(ogg.byteOffset, ogg.byteOffset + ogg.byteLength) as ArrayBuffer);
          if (original !== null) await writeSongSource(folder, original.data, original.name, settings.silence, gain);
          await folder.writeBinary('cover.jpg', await coverJpeg(cover, settings.title, settings.artist));
          for (const entry of settings.difficulties) await folder.writeText(newDifficultyFile(entry), emptyDifficulty(editorSettings().newFormat));
          await folder.writeText('Info.dat', infoText(settings, 'song.ogg', 'cover.jpg'));
          await folder.refresh();
          try {
            localStorage.setItem('chroeditor.mapper', settings.mapper);
          } catch {
            // (only a convenience)
          }
          finish({ folder, ...(choice.preset === undefined ? {} : { preset: choice.preset }) });
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

/** A plate showing an environment (its picture, name, who made it) with a button opening the gallery to
 *  pick another (the new map's dialog and the map's settings). */
export function environmentPlate(plate: HTMLElement, initial: EnvironmentChoice, title: string, changed: (choice: EnvironmentChoice) => void) {
  const standard = STANDARD_ENVIRONMENTS;
  let choice = initial;
  const showPlate = () => {
    const label = choiceLabel(choice, standard);
    plate.replaceChildren();
    const image = document.createElement('img');
    image.src = label.image;
    image.alt = '';
    image.addEventListener('error', () => image.classList.add('missing'));
    const text = document.createElement('div');
    text.append(Object.assign(document.createElement('div'), { className: 'env-card-name', textContent: label.name }), Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: label.detail }));
    const change = document.createElement('button');
    change.type = 'button';
    change.textContent = 'Выбрать…';
    change.addEventListener('click', () => {
      const shade = document.createElement('div');
      shade.className = 'ce-shade';
      const picker = document.createElement('div');
      picker.className = 'ce-dialog env-dialog';
      picker.append(Object.assign(document.createElement('div'), { className: 'ce-dialog-title', textContent: title }));
      const close = () => shade.remove();
      picker.append(
        environmentGallery({
          mode: 'pick',
          current: choice,
          standard,
          version: 'new',
          choose: (picked) => {
            choice = picked;
            changed(picked);
            showPlate();
            close();
          },
        }),
      );
      const buttons = document.createElement('div');
      buttons.className = 'ce-dialog-buttons';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Отмена';
      cancel.addEventListener('click', close);
      buttons.append(cancel);
      picker.append(buttons);
      shade.append(picker);
      document.body.append(shade);
    });
    plate.append(image, text, change);
  };
  showPlate();
}
