import { decodeAudio, encodeOgg, findBpm, playWithClicks } from './audio-tools';
import type { BpmResult } from './bpm-detect';
import type { Editor } from './editor';
import { difficultyFile, loadProject, projectFileName, transformDifficultyBeats, transformProjectBeats } from './map-io';

/**
 * "Map settings": the song's name and authors, its tempo, and its start — silence put in front of
 * the song (or cut off it), the first beat lined up with the grid. Changing the tempo keeps every
 * event on its beat, or (asked for) at its time in the song; changing the start moves every
 * difficulty's notes, walls and lights with the song, so all stays in sync. The song is made anew
 * as Ogg Vorbis for that.
 */

interface InfoFields {
  version: '2' | '4';
  title: string;
  subTitle: string;
  artist: string;
  mapper: string;
  bpm: number;
  preview: number;
  song: string;
}

function readInfo(text: string): InfoFields {
  const info = JSON.parse(text) as Record<string, unknown>;
  const v4 = typeof info.version === 'string' && info.version.startsWith('4');
  if (v4) {
    const song = (info.song ?? {}) as Record<string, unknown>;
    const audio = (info.audio ?? {}) as Record<string, unknown>;
    return { version: '4', title: String(song.title ?? ''), subTitle: String(song.subTitle ?? ''), artist: String(song.author ?? ''), mapper: '', bpm: Number(audio.bpm ?? 120), preview: Number(audio.previewStartTime ?? 0), song: String(audio.songFilename ?? '') };
  }
  return {
    version: '2',
    title: String(info._songName ?? ''),
    subTitle: String(info._songSubName ?? ''),
    artist: String(info._songAuthorName ?? ''),
    mapper: String(info._levelAuthorName ?? ''),
    bpm: Number(info._beatsPerMinute ?? 120),
    preview: Number(info._previewStartTime ?? 0),
    song: String(info._songFilename ?? ''),
  };
}

function writeInfo(text: string, fields: InfoFields): string {
  const info = JSON.parse(text) as Record<string, unknown>;
  if (fields.version === '4') {
    const song = (info.song ?? {}) as Record<string, unknown>;
    song.title = fields.title;
    song.subTitle = fields.subTitle;
    song.author = fields.artist;
    info.song = song;
    const audio = (info.audio ?? {}) as Record<string, unknown>;
    audio.previewStartTime = Math.max(0, Math.round(fields.preview * 100) / 100);
    info.audio = audio;
  } else {
    info._songName = fields.title;
    info._songSubName = fields.subTitle;
    info._songAuthorName = fields.artist;
    info._levelAuthorName = fields.mapper;
    info._beatsPerMinute = fields.bpm;
    info._previewStartTime = Math.max(0, Math.round(fields.preview * 100) / 100);
  }
  return JSON.stringify(info, null, 2);
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
  const fields = readInfo(infoText);

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
        <label>BPM
          <span class="nm-row"><input type="number" data-id="bpm" min="10" max="1000" step="0.01"><button type="button" data-id="detect">Определить</button></span>
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
        <label>Добавить тишины в начало, с<input type="number" data-id="shift" step="0.001" value="0"></label>
        <label>Подогнать к сетке
          <span class="nm-row"><button type="button" data-id="align" disabled>Первая доля — на целую долю</button></span>
        </label>
        <div class="nm-wide nm-dim" data-id="shift-info">Отрицательное значение отрезает начало песни. Ноты, стены и свет всех сложностей сдвинутся вместе с песней.</div>
        <label>Превью с, сек<input type="number" data-id="preview" step="0.1"></label>
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
    if (fields.version === '4') {
      // (Info v4: the tempo lives in its audio data file — not changed here yet)
      el<HTMLInputElement>('bpm').disabled = true;
      el<HTMLInputElement>('mapper').disabled = true;
      el<HTMLInputElement>('shift').disabled = true;
      el('shift-info').textContent = 'Для карт формата v4 темп и начало песни здесь пока не меняются.';
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
    const firstBeat = () => {
      if (detected === null) return 0;
      const period = 60 / Number(el<HTMLInputElement>('bpm').value);
      return ((detected.firstBeat % period) + period) % period;
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
        el<HTMLButtonElement>('align').disabled = fields.version === '4';
        status.textContent = '';
      } catch (error) {
        status.textContent = `Не получилось: ${error instanceof Error ? error.message : String(error)}`;
      }
      busy = false;
    };
    el('detect').addEventListener('click', () => void detect());
    el('align').addEventListener('click', () => {
      // the least change that puts the first beat on a whole beat (some silence, or a bit cut)
      const period = 60 / Number(el<HTMLInputElement>('bpm').value);
      const offset = firstBeat();
      const shift = offset > period / 2 ? period - offset : -offset;
      el<HTMLInputElement>('shift').value = shift.toFixed(3);
    });
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
          };
          const shift = Number(el<HTMLInputElement>('shift').value) || 0;
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
          await map.folder.writeText(infoName, writeInfo(await map.folder.readText(infoName), next));
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
