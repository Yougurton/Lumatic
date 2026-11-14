import { tr } from './i18n';

/**
 * The song's own loudness, changed in the file itself (made louder or quieter when the map's song is
 * made): a slider in decibels, where its loudest moment ends up (the peak — over 0 dB it distorts),
 * "by the peak" (as loud as it can go without distorting) and a listen at that loudness.
 */

/** The loudest sample of a song (dB of full scale; -Infinity: silence). */
export function peakDb(buffer: AudioBuffer): number {
  let most = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      const value = Math.abs(data[i]!);
      if (value > most) most = value;
    }
  }
  return most > 0 ? 20 * Math.log10(most) : -Infinity;
}

/** A copy of the song `db` decibels louder (quieter below 0), what goes past full scale clipped. */
export function withGain(buffer: AudioBuffer, db: number): AudioBuffer {
  if (Math.abs(db) < 1e-6) return buffer;
  const factor = 10 ** (db / 20);
  const out = new AudioBuffer({ length: buffer.length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const from = buffer.getChannelData(channel);
    const to = out.getChannelData(channel);
    for (let i = 0; i < from.length; i++) to[i] = Math.max(-1, Math.min(1, from[i]! * factor));
  }
  return out;
}

/** The headroom "by the peak" leaves (dB under full scale). */
const HEADROOM = 0.3;

export interface VolumeControl {
  element: HTMLElement;
  /** The loudness picked (dB against the song it's made from). */
  value(): number;
  /** The song it's made from (its peak shown; null: none yet). */
  setSong(buffer: AudioBuffer | null): void;
  /** Stops listening. */
  stop(): void;
}

/** The control: `initial` dB; `listenFrom`: where in the song a listen starts (seconds). */
export function volumeControl(initial: number, listenFrom: () => number): VolumeControl {
  const element = document.createElement('div');
  element.className = 'nm-grid song-volume';
  element.innerHTML = `
    <label class="nm-wide">Громкость песни
      <span class="nm-row"><input type="range" data-id="gain" min="-12" max="12" step="0.5"><span data-id="gain-value" class="song-volume-value"></span></span>
    </label>
    <div class="nm-wide nm-row">
      <button type="button" data-id="gain-peak" title="Так громко, как можно без искажений: самый громкий момент — чуть ниже 0 дБ">Выровнять по пику</button>
      <button type="button" data-id="gain-reset" title="Как в исходном файле">0 дБ</button>
      <button type="button" data-id="gain-listen">▶ Послушать</button>
    </div>
    <div class="nm-wide nm-dim" data-id="gain-info"></div>`;
  const el = <T extends HTMLElement>(id: string) => element.querySelector<T>(`[data-id="${id}"]`)!;
  const slider = el<HTMLInputElement>('gain');
  slider.value = String(Math.round(initial * 2) / 2);
  let song: AudioBuffer | null = null;
  let peak = -Infinity;
  let playing: { context: AudioContext; gain: GainNode } | null = null;
  const value = () => Number(slider.value) || 0;
  const show = () => {
    const db = value();
    el('gain-value').textContent = `${db > 0 ? '+' : ''}${db.toFixed(1)} ${tr('дБ')}`;
    const info = el('gain-info');
    if (song === null || !Number.isFinite(peak)) {
      info.textContent = db === 0 ? tr('Как в исходном файле') : tr('Песня станет громче или тише в самом файле');
      return;
    }
    const after = peak + db;
    info.textContent = after > 0.05 ? tr('⚠ Пик {0} дБ — громкие места будут искажаться (клиппинг)', `+${after.toFixed(1)}`) : tr('Пик {0} дБ — без искажений', after.toFixed(1));
    info.classList.toggle('song-volume-warn', after > 0.05);
    if (playing !== null) playing.gain.gain.value = 10 ** (db / 20);
  };
  const stop = () => {
    if (playing === null) return;
    void playing.context.close();
    playing = null;
    el('gain-listen').textContent = tr('▶ Послушать');
  };
  slider.addEventListener('input', show);
  el('gain-reset').addEventListener('click', () => {
    slider.value = '0';
    show();
  });
  el('gain-peak').addEventListener('click', () => {
    if (!Number.isFinite(peak)) return;
    slider.value = String(Math.max(-12, Math.min(12, Math.floor((-HEADROOM - peak) * 2) / 2)));
    show();
  });
  el('gain-listen').addEventListener('click', () => {
    if (playing !== null) {
      stop();
      return;
    }
    if (song === null) return;
    const context = new AudioContext();
    const source = context.createBufferSource();
    source.buffer = song;
    const gain = context.createGain();
    gain.gain.value = 10 ** (value() / 20);
    source.connect(gain).connect(context.destination);
    source.start(0, Math.max(0, Math.min(song.duration - 1, listenFrom())), 12);
    source.addEventListener('ended', () => {
      if (playing?.context === context) stop();
    });
    playing = { context, gain };
    el('gain-listen').textContent = tr('■ Стоп');
  });
  show();
  return {
    element,
    value,
    setSong(buffer) {
      song = buffer;
      peak = buffer === null ? -Infinity : peakDb(buffer);
      for (const id of ['gain-peak', 'gain-listen']) el<HTMLButtonElement>(id).disabled = buffer === null;
      show();
    },
    stop,
  };
}
