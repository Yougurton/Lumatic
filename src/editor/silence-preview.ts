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

/** The colours of the 256 levels (drawn every frame while listening). */
const PALETTE = Array.from({ length: 256 }, (_, level) => colour(level / 255));

export function silencePreview() {
  const element = document.createElement('div');
  element.className = 'silence-preview';
  const canvas = document.createElement('canvas');
  const note = document.createElement('div');
  note.className = 'nm-dim';
  element.append(canvas, note);
  let view: SilenceView | null = null;
  /** While the tempo is checked by ear: the stretch being played, close, the strip following it. */
  let listening: { time(): number; active(): boolean } | null = null;

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
    if (listening !== null && !listening.active()) listening = null;
    // the stretch shown (seconds of the map): from its start to two bars past where the song begins
    // (at least 4 s) — while listening, 6 s around where it plays
    const now = listening === null ? null : listening.time() + lead;
    const span = now === null ? Math.max(4, Math.max(0, lead) + bar * 2) : 6;
    const start = now === null ? 0 : now - span / 3;
    const toX = (seconds: number) => ((seconds - start) / span) * width;
    const top = 14;
    const body = height - top;
    // the song, put where it will be (`lead` seconds in)
    if (spectrogram !== null) {
      const image = ctx.createImageData(Math.round(width * ratio), Math.round(body * ratio));
      const w = image.width;
      const h = image.height;
      for (let x = 0; x < w; x++) {
        const songSeconds = start + (x / ratio / width) * span - lead;
        const frame = Math.floor(songSeconds / spectrogram.secondsPerFrame);
        if (songSeconds < 0 || frame >= spectrogram.frames) continue;
        for (let y = 0; y < h; y++) {
          const band = Math.floor((1 - y / h) * (spectrogram.bands - 1));
          const [r, g, b] = PALETTE[Math.max(0, Math.min(255, Math.round(spectrogram.values[frame * spectrogram.bands + band] ?? 0)))]!;
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
    if (lead > 0 && toX(lead) > 0) {
      const x0 = Math.max(0, toX(0));
      const x1 = toX(lead);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, top, x1 - x0, body);
      ctx.clip();
      ctx.fillStyle = 'rgba(120,170,255,0.12)';
      ctx.fillRect(x0, top, x1 - x0, body);
      ctx.strokeStyle = 'rgba(140,180,255,0.35)';
      for (let x = x0 - body; x < x1; x += 8) {
        ctx.beginPath();
        ctx.moveTo(x, top + body);
        ctx.lineTo(x + body, top);
        ctx.stroke();
      }
      ctx.restore();
    }
    // the grid: bars bright with their numbers, beats faint
    ctx.font = '600 10px system-ui, sans-serif';
    for (let k = Math.max(0, Math.ceil(start / beat - 1e-6)); k * beat <= start + span; k++) {
      const x = toX(k * beat);
      const isBar = k % beatsPerBar === 0;
      ctx.fillStyle = isBar ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.25)';
      ctx.fillRect(Math.round(x), isBar ? 0 : top, 1, isBar ? height : body);
      if (now !== null) {
        // (the half beats, faint)
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(Math.round(toX((k + 0.5) * beat)), top + body * 0.6, 1, body * 0.4);
      }
      if (isBar) {
        ctx.fillStyle = '#d9dce4';
        ctx.fillText(String(k / beatsPerBar + 1), x + 3, 10);
      }
    }
    // where the song's beat lands
    const mark = (songSeconds: number | null, color: string, text: string) => {
      if (songSeconds === null) return;
      const at = songSeconds + lead;
      if (at < start || at > start + span) return;
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
    if (now !== null) {
      // where it plays
      ctx.fillStyle = '#ff4d6d';
      ctx.fillRect(toX(now) - 1, 0, 2, height);
      const label = `${String(Math.round(bpm * 100) / 100)} BPM · ${now.toFixed(1)} с`;
      ctx.font = '11px system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(10,11,15,0.8)';
      ctx.fillRect(width - tw - 12, height - 20, tw + 8, 16);
      ctx.fillStyle = '#e8eaf0';
      ctx.fillText(label, width - tw - 8, height - 8);
    }
  };

  new ResizeObserver(() => draw()).observe(element);
  return {
    element,
    update(next: SilenceView) {
      view = next;
      draw();
    },
    /** The metronome playing (`time`: seconds of the song file) — null: the song's start again. */
    listen(state: { time(): number; active(): boolean } | null) {
      listening = state;
      if (state === null) {
        draw();
        return;
      }
      const tick = () => {
        if (listening !== state) return;
        draw();
        if (listening === state) requestAnimationFrame(tick);
        else draw();
      };
      requestAnimationFrame(tick);
    },
  };
}
