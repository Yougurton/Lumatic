import type { Editor } from './editor';
import { settings } from './settings';

/**
 * The wheel over the 3D view in the game's view of the notes side: the song taken on or back smoothly
 * — each notch a grid step further (quick notches one after another: two, three, four steps a notch),
 * the song speeding up and slowing down on the way to it, landing on the grid. Up: on through the song
 * (as the 3D track).
 */
export class SmoothScroll {
  /** Where the song is shown (beats) and how fast it goes there (beats a second). */
  private position = 0;
  private velocity = 0;
  /** The grid's step it is going to. */
  private goal = 0;
  private running = false;
  private last = 0;
  private notches: number[] = [];
  /** A touchpad's small turns, added up to whole notches. */
  private partial = 0;
  private gridWheel = 0;

  /** How quickly it gets there (1/s): a spring, as fast as it can without going past. */
  private static readonly SPRING = 16;

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

  /** Stops (the song played, the view left). */
  stop() {
    this.running = false;
    this.velocity = 0;
  }

  private push(event: WheelEvent) {
    const editor = this.editor;
    if (editor.isPlaying()) return;
    const lines = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    // (a mouse's notch is about 100; a touchpad's turns are small: added up)
    this.partial += (-lines / 100) * settings().wheelSpeed;
    const notches = Math.trunc(this.partial + Math.sign(this.partial) * 1e-6);
    if (notches === 0) return;
    this.partial -= notches;
    const step = editor.snap > 0 ? editor.snap : 0.25;
    const now = performance.now();
    if (!this.running) {
      this.position = editor.playhead();
      this.velocity = 0;
      this.goal = Math.round(this.position / step) * step;
    } else if (Math.sign(this.goal - this.position) !== Math.sign(notches) && Math.abs(this.goal - this.position) > 1e-6) {
      // (turning back: from the step it is passing)
      this.goal = (notches > 0 ? Math.ceil(this.position / step - 1e-6) : Math.floor(this.position / step + 1e-6)) * step;
      this.notches = [];
    }
    // (notches in quick succession go further: up to four steps a notch)
    this.notches = this.notches.filter((at) => now - at < 300);
    this.notches.push(now);
    const reach = Math.min(4, 1 + Math.floor((this.notches.length - 1) / 2));
    const end = editor.endBeat > 0 ? editor.endBeat : Infinity;
    this.goal = Math.max(0, Math.min(Math.floor(end / step) * step, Math.round((this.goal + notches * reach * step) / step) * step));
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
    // (a critically damped spring: speeds up, slows down, never past the goal)
    const w = SmoothScroll.SPRING;
    const pull = this.goal - this.position;
    this.velocity += (w * w * pull - 2 * w * this.velocity) * dt;
    this.position += this.velocity * dt;
    if ((this.goal - this.position) * pull < 0) {
      this.position = this.goal;
      this.velocity = 0;
    }
    if (Math.abs(this.goal - this.position) < 5e-4 && Math.abs(this.velocity) < 0.05) {
      this.position = this.goal;
      editor.seek(this.position);
      this.stop();
      return;
    }
    editor.seek(this.position);
    requestAnimationFrame((time) => this.frame(time));
  }
}
