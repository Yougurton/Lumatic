import type { Spectrogram } from './spectrogram';

/**
 * The song's start as it will be: a short spectrogram with the map's beats and bars over it — the
 * silence put in front (or what's cut off) shaded, and where the song's first beat or strong beat
 * lands on the grid marked. Drawn again whenever the tempo, the silence or the grid change.
 */

export interface SilenceView {
  /** The song's own picture (null: not read yet). */
  spectrogram: Spectrogram | null;
  /** Seconds put in front of the song (below 0: cut off it). */
  lead: number;
  bpm: number;
  beatsPerBar: number;
  /** Where in the song (its own seconds) a beat was found, and the strong beat (null: unknown). */
  firstBeat: number | null;
  downbeat: number | null;
}

/** A level 0…1 as the timeline's spectrogram colours it (dark blue → purple → orange → yellow). */
function colour(v: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0, 8, 8, 30],
    [0.35, 70, 20, 110],
    [0.6, 190, 40, 90],
    [0.8, 250, 130, 30],
    [1, 255, 240, 160],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [p1, r1, g1, b1] = stops[i]!;
    const [p0, r0, g0, b0] = stops[i - 1]!;
    if (v <= p1) {
      const t = (v - p0) / (p1 - p0);
      return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t];
    }
  }
  return [255, 240, 160];
}

export function silencePreview() {
  const element = document.createElement('div');
  element.className = 'silence-preview';
  const canvas = document.createElement('canvas');
  const note = document.createElement('div');
  note.className = 'nm-dim';
  element.append(canvas, note);
  let view: SilenceView | null = null;

  const draw = () => {
    if (view === null) return;
    const width = Math.max(200, element.clientWidth || 460);
    const height = 84;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${String(width)}px`;
    canvas.style.height = `${String(height)}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, width, height);
    const { spectrogram, lead, bpm, beatsPerBar } = view;
    const beat = 60 / Math.max(1, bpm);
    const bar = beat * beatsPerBar;
    // the stretch shown: from the map's start to two bars past where the song begins (at least 4 s)
    const span = Math.max(4, Math.max(0, lead) + bar * 2);
    const toX = (seconds: number) => (seconds / span) * width;
    const top = 14;
    const body = height - top;
    // the song, put where it will be (`lead` seconds in)
    if (spectrogram !== null) {
      const image = ctx.createImageData(Math.round(width * ratio), Math.round(body * ratio));
      const w = image.width;
      const h = image.height;
      for (let x = 0; x < w; x++) {
        const songSeconds = (x / ratio / width) * span - lead;
        const frame = Math.floor(songSeconds / spectrogram.secondsPerFrame);
        if (songSeconds < 0 || frame >= spectrogram.frames) continue;
        for (let y = 0; y < h; y++) {
          const band = Math.floor((1 - y / h) * (spectrogram.bands - 1));
          const [r, g, b] = colour((spectrogram.values[frame * spectrogram.bands + band] ?? 0) / 255);
          const p = (y * w + x) * 4;
          image.data[p] = r;
          image.data[p + 1] = g;
          image.data[p + 2] = b;
          image.data[p + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, Math.round(top * ratio));
    }
    // the silence (or what's cut)
    if (lead > 0) {
      ctx.fillStyle = 'rgba(120,170,255,0.12)';
      ctx.fillRect(0, top, toX(lead), body);
      ctx.strokeStyle = 'rgba(140,180,255,0.35)';
      for (let x = -body; x < toX(lead); x += 8) {
        ctx.beginPath();
        ctx.moveTo(Math.max(0, x), top + Math.max(0, -x));
        ctx.lineTo(Math.min(toX(lead), x + body), top + body - Math.max(0, x + body - toX(lead)));
        ctx.stroke();
      }
    }
    // the grid: bars bright with their numbers, beats faint
    ctx.font = '600 10px system-ui, sans-serif';
    for (let k = 0; k * beat <= span; k++) {
      const x = toX(k * beat);
      const isBar = k % beatsPerBar === 0;
      ctx.fillStyle = isBar ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.25)';
      ctx.fillRect(Math.round(x), isBar ? 0 : top, 1, isBar ? height : body);
      if (isBar) {
        ctx.fillStyle = '#d9dce4';
        ctx.fillText(String(k / beatsPerBar + 1), x + 3, 10);
      }
    }
    // where the song's beat lands
    const mark = (songSeconds: number | null, color: string, text: string) => {
      if (songSeconds === null) return;
      const at = songSeconds + lead;
      if (at < 0 || at > span) return;
      const x = toX(at);
      ctx.fillStyle = color;
      ctx.fillRect(x - 1, top, 2, body);
      ctx.beginPath();
      ctx.moveTo(x - 5, top);
      ctx.lineTo(x + 5, top);
      ctx.lineTo(x, top + 7);
      ctx.fill();
      ctx.font = '600 10px system-ui, sans-serif';
      const w = ctx.measureText(text).width;
      ctx.fillText(text, Math.min(width - w - 2, x + 4), top + 18);
    };
    if (view.downbeat !== null) mark(view.downbeat, '#7fe39a', 'сильная доля');
    else mark(view.firstBeat, '#7fe39a', 'первая доля');
    const silenceText = lead > 1e-3 ? `Тишина: ${lead.toFixed(3)} с` : lead < -1e-3 ? `Отрежется: ${(-lead).toFixed(3)} с` : 'Песня начнётся сразу';
    const landing = (view.downbeat ?? view.firstBeat) === null ? '' : ` · ${view.downbeat !== null ? 'сильная доля' : 'первая доля'} встанет на долю ${(((view.downbeat ?? view.firstBeat)! + lead) / beat).toFixed(2)}`;
    note.textContent = `${silenceText}${landing}. Цифры сверху — такты.`;
  };

  new ResizeObserver(() => draw()).observe(element);
  return {
    element,
    update(next: SilenceView) {
      view = next;
      draw();
    },
  };
}
