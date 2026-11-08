import type { Editor } from './editor';
import { settings } from './settings';

/**
 * The wheel over the 3D view in the game's view of the notes side: the song taken on or back smoothly
 * — each notch a push (quick notches one after another: harder and harder), the song slowing down on
 * its own and settling on the grid's nearest step ahead. Up: on through the song (as the 3D track).
 */
export class SmoothScroll {
  /** Beats a second. */
  private velocity = 0;
  private position = 0;
  /** The grid's step it settles on once slow (null: still gliding). */
  private target: number | null = null;
  private running = false;
  private last = 0;
  private notches: number[] = [];
  private gridWheel = 0;

  /** How quickly a glide dies down (1/s): an isolated notch goes about a grid step. */
  private static readonly FRICTION = 5;

  constructor(
    private readonly editor: Editor,
    canvas: HTMLCanvasElement,
    private readonly enabled: () => boolean,
  ) {
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.enabled() || event.defaultPrevented) return;
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          // Ctrl+wheel: the grid finer / coarser (as on the 3D track)
          this.gridWheel += event.deltaY;
          if (Math.abs(this.gridWheel) >= 40) {
            editor.stepSnap?.(this.gridWheel < 0);
            this.gridWheel = 0;
          }
          return;
        }
        this.push(event);
      },
      { passive: false },
    );
  }

  /** Stops gliding (the song played, the view left). */
  stop() {
    this.running = false;
    this.velocity = 0;
    this.target = null;
  }

  private push(event: WheelEvent) {
    const editor = this.editor;
    if (editor.isPlaying()) return;
    const lines = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    const notch = (-lines / 100) * settings().wheelSpeed;
    if (notch === 0) return;
    const now = performance.now();
    if (!this.running) {
      this.position = editor.playhead();
      this.velocity = 0;
    }
    // (notches in quick succession push harder: up to four times)
    this.notches = this.notches.filter((at) => now - at < 350);
    this.notches.push(now);
    const boost = Math.min(4, 1 + (this.notches.length - 1) * 0.5);
    const step = editor.snap > 0 ? editor.snap : 0.25;
    // (turning back: the glide the other way stopped first)
    if (Math.sign(this.velocity) !== Math.sign(notch)) this.velocity = 0;
    this.velocity += notch * step * SmoothScroll.FRICTION * boost;
    const most = step * 160;
    this.velocity = Math.max(-most, Math.min(most, this.velocity));
    this.target = null;
    if (!this.running) {
      this.running = true;
      this.last = now;
      requestAnimationFrame((time) => this.frame(time));
    }
  }

  private frame(now: number) {
    if (!this.running) return;
    const editor = this.editor;
    if (editor.isPlaying() || !this.enabled()) {
      this.stop();
      return;
    }
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const step = editor.snap > 0 ? editor.snap : 0.25;
    if (this.target === null) {
      this.position += this.velocity * dt;
      this.velocity *= Math.exp(-dt * SmoothScroll.FRICTION);
      // (slow enough: on to the grid's next step the way it goes)
      if (Math.abs(this.velocity) < step * 1.2) {
        const ahead = this.position / step;
        this.target = Math.max(0, (this.velocity >= 0 ? Math.ceil(ahead - 1e-6) : Math.floor(ahead + 1e-6)) * step);
      }
    } else {
      this.position += (this.target - this.position) * (1 - Math.exp(-dt * 14));
      if (Math.abs(this.target - this.position) < 1e-3) this.position = this.target;
    }
    const end = editor.endBeat > 0 ? editor.endBeat : Infinity;
    if (this.position <= 0 || this.position >= end) {
      this.position = Math.max(0, Math.min(end, this.position));
      this.velocity = 0;
      this.target ??= this.position;
    }
    editor.seek(this.position);
    if (this.target !== null && this.position === this.target) {
      this.stop();
      return;
    }
    requestAnimationFrame((time) => this.frame(time));
  }
}
