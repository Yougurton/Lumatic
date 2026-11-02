import { paintSpectrogram, type Spectrogram } from './spectrogram';

/**
 * The song list's preview, picked on the song itself: the whole song as a spectrogram with the
 * preview a lit band over it — dragged by its middle to move, by its edges to stretch, a click
 * elsewhere puts it there; ▶ plays it. Times are seconds of the song file as it is now (`lead`: the
 * silence that will be put in front of it — the preview counts it in).
 */

export interface PreviewPicker {
  element: HTMLElement;
  /** Start and length (seconds of the finished song: `lead` counted in). */
  value(): { start: number; duration: number };
  set(start: number, duration: number): void;
  /** Silence that will be put in front of the song. */
  setLead(lead: number): void;
  stop(): void;
  /** While the tempo is checked by ear: the stretch being played, close, with the grid's beats over
   *  it (bars brighter) — null: the whole song again. */
  listen(state: ListenView | null): void;
}

export interface ListenView {
  /** Where it plays (seconds of the song file). */
  time(): number;
  active(): boolean;
  bpm: number;
  /** A beat of the grid (seconds of the song file). */
  firstBeat: number;
  /** The strong beats (null: every 4th). */
  bar: { downbeat: number; beats: number } | null;
}

const EDGE = 7;

export function previewPicker(buffer: AudioBuffer, spectrogram: Spectrogram | Promise<Spectrogram> | null, start: number, duration: number, onChange: (start: number, duration: number) => void): PreviewPicker {
  const wrap = document.createElement('div');
  wrap.className = 'pp-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'pp-canvas';
  canvas.title = 'Превью песни: тяните светлую полосу, её края — длину; клик — поставить туда';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'pp-play';
  play.textContent = '▶';
  play.title = 'Послушать превью';
  wrap.append(canvas, play);
  let picture: Spectrogram | null = spectrogram instanceof Promise ? null : spectrogram;
  if (spectrogram instanceof Promise) {
    void spectrogram.then((done) => {
      paintSpectrogram(done, { floor: 0.15, contrast: 1.3 });
      picture = done;
      draw();
    });
  }
  let lead = 0;
  // (kept in seconds of the song file)
  let from = Math.max(0, start);
  let length = Math.max(1, duration);
  const songLength = buffer.duration;
  let drag: { part: 'body' | 'start' | 'end'; grab: number; from: number; length: number } | null = null;
  let playing: { context: AudioContext; started: number } | null = null;

  const geometry = () => {
    const width = canvas.clientWidth;
    return { width, height: canvas.clientHeight, toX: (t: number) => (t / songLength) * width, toTime: (x: number) => (x / width) * songLength };
  };
  const clamp = () => {
    length = Math.min(Math.max(1, length), songLength);
    from = Math.min(Math.max(0, from), Math.max(0, songLength - length));
  };
  let listening: ListenView | null = null;
  /** The stretch being played, close up: its spectrogram, the beats over it, where it is. */
  const drawListening = (ctx: CanvasRenderingContext2D, state: ListenView, width: number, height: number) => {
    const now = state.time();
    const span = 6;
    const t0 = now - span / 3;
    const toX = (t: number) => ((t - t0) / span) * width;
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(0, 0, width, height);
    if (picture !== null) {
      const f0 = t0 / picture.secondsPerFrame;
      const f1 = (t0 + span) / picture.secondsPerFrame;
      const from = Math.max(0, f0);
      const to = Math.min(picture.frames, f1);
      if (to > from) ctx.drawImage(picture.image, from, 0, to - from, picture.image.height, toX(from * picture.secondsPerFrame), 0, toX(to * picture.secondsPerFrame) - toX(from * picture.secondsPerFrame), height);
    }
    const period = 60 / Math.max(1, state.bpm);
    ctx.font = '600 11px system-ui, sans-serif';
    for (let k = Math.floor((t0 - state.firstBeat) / period); state.firstBeat + k * period <= t0 + span; k++) {
      const t = state.firstBeat + k * period;
      const bar = state.bar;
      const index = bar === null ? k : Math.round((t - bar.downbeat) / period);
      const beats = bar?.beats ?? 4;
      const strong = ((index % beats) + beats) % beats === 0;
      const x = toX(t);
      ctx.fillStyle = strong ? 'rgba(255,230,160,0.9)' : 'rgba(255,255,255,0.35)';
      ctx.fillRect(Math.round(x), 0, strong ? 2 : 1, height);
      // (the half beats, faint)
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(Math.round(toX(t + period / 2)), height * 0.6, 1, height * 0.4);
      if (strong) {
        ctx.fillStyle = '#ffe3a8';
        ctx.fillText(String(Math.floor(index / beats) + 1), x + 4, 13);
      }
    }
    ctx.fillStyle = '#ff4d6d';
    ctx.fillRect(toX(now), 0, 2, height);
    const label = `${String(Math.round(state.bpm * 100) / 100)} BPM · ${now.toFixed(1)} с`;
    ctx.font = '11px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,11,15,0.8)';
    ctx.fillRect(width - tw - 12, height - 20, tw + 8, 16);
    ctx.fillStyle = '#e8eaf0';
    ctx.fillText(label, width - tw - 8, height - 8);
  };
  const draw = () => {
    if (!canvas.isConnected || canvas.clientWidth === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (listening !== null) {
      if (listening.active()) {
        drawListening(ctx, listening, canvas.clientWidth, canvas.clientHeight);
        return;
      }
      listening = null;
    }
    const g = geometry();
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(0, 0, g.width, g.height);
    if (picture !== null) {
      const frames = Math.min(picture.frames, songLength / picture.secondsPerFrame);
      ctx.drawImage(picture.image, 0, 0, frames, picture.image.height, 0, 0, g.toX(frames * picture.secondsPerFrame), g.height);
    } else {
      ctx.fillStyle = '#4b4f5c';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Спектрограмма считается…', 10, g.height / 2);
    }
    // the rest dimmed, the preview lit
    const x0 = g.toX(from);
    const x1 = g.toX(from + length);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, x0, g.height);
    ctx.fillRect(x1, 0, g.width - x1, g.height);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(x0, 0, x1 - x0, g.height);
    ctx.fillStyle = 'rgba(255,220,150,0.95)';
    ctx.fillRect(x0, 0, 2, g.height);
    ctx.fillRect(x1 - 2, 0, 2, g.height);
    // where it plays
    if (playing !== null) {
      const t = from + (playing.context.currentTime - playing.started);
      if (t > from + length) stopPlaying();
      else {
        ctx.fillStyle = '#ff4d6d';
        ctx.fillRect(g.toX(t), 0, 2, g.height);
      }
    }
    ctx.font = '11px system-ui, sans-serif';
    const label = `${(from + lead).toFixed(2)} с · ${length.toFixed(2)} с`;
    const tw = ctx.measureText(label).width;
    const lx = Math.min(Math.max(2, x0 + 4), g.width - tw - 6);
    ctx.fillStyle = 'rgba(10,11,15,0.8)';
    ctx.fillRect(lx - 2, 3, tw + 6, 15);
    ctx.fillStyle = '#ffe3a8';
    ctx.fillText(label, lx + 1, 14);
  };
  const changed = () => {
    clamp();
    onChange(from + lead, length);
    draw();
  };
  const stopPlaying = () => {
    if (playing === null) return;
    void playing.context.close();
    playing = null;
    play.textContent = '▶';
  };
  play.addEventListener('click', () => {
    if (playing !== null) {
      stopPlaying();
      return;
    }
    const context = new AudioContext();
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    // (faded in and out, as the song list plays it)
    const at = context.currentTime + 0.05;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.8, at + 0.4);
    gain.gain.setValueAtTime(0.8, at + Math.max(0.4, length - 0.8));
    gain.gain.linearRampToValueAtTime(0, at + length);
    source.connect(gain).connect(context.destination);
    source.start(at, from, length);
    playing = { context, started: at };
    play.textContent = '■';
    const tick = () => {
      if (playing === null) return;
      draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  canvas.addEventListener('mousedown', (event) => {
    const g = geometry();
    const x = event.clientX - canvas.getBoundingClientRect().left;
    const x0 = g.toX(from);
    const x1 = g.toX(from + length);
    let part: 'body' | 'start' | 'end';
    if (Math.abs(x - x0) <= EDGE) part = 'start';
    else if (Math.abs(x - x1) <= EDGE) part = 'end';
    else if (x > x0 && x < x1) part = 'body';
    else {
      from = g.toTime(x) - length / 2;
      changed();
      part = 'body';
    }
    drag = { part, grab: g.toTime(x), from, length };
    const move = (moveEvent: MouseEvent) => {
      if (drag === null) return;
      const t = geometry().toTime(moveEvent.clientX - canvas.getBoundingClientRect().left);
      const delta = t - drag.grab;
      if (drag.part === 'body') from = drag.from + delta;
      else if (drag.part === 'start') {
        const end = drag.from + drag.length;
        from = Math.min(end - 1, Math.max(0, drag.from + delta));
        length = end - from;
      } else length = Math.max(1, drag.length + delta);
      changed();
    };
    const up = () => {
      drag = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  canvas.addEventListener('mousemove', (event) => {
    if (drag !== null) return;
    const g = geometry();
    const x = event.clientX - canvas.getBoundingClientRect().left;
    const x0 = g.toX(from);
    const x1 = g.toX(from + length);
    canvas.style.cursor = Math.abs(x - x0) <= EDGE || Math.abs(x - x1) <= EDGE ? 'ew-resize' : x > x0 && x < x1 ? 'grab' : 'pointer';
  });
  new ResizeObserver(() => draw()).observe(canvas);
  requestAnimationFrame(draw);
  return {
    element: wrap,
    value: () => ({ start: from + lead, duration: length }),
    set: (start, duration) => {
      from = start - lead;
      length = duration;
      clamp();
      draw();
    },
    setLead: (value) => {
      lead = value;
      draw();
    },
    stop: stopPlaying,
    listen: (state) => {
      listening = state;
      if (state === null) {
        draw();
        return;
      }
      const tick = () => {
        if (listening !== state) return;
        draw();
        if (listening === state) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
  };
}
