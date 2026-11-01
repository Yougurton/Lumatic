import type { Preview } from './preview';

/**
 * Flying about the 3D view (as in ChroMapper): the right mouse button held, the mouse turns the view,
 * W/A/S/D move on, back and aside, Space up, Ctrl down, Shift faster, the wheel sets the speed. The
 * view stays where it was flown to until it's reset (back to where the player stands).
 */

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE']);
const LOOK = 0.0025;

export class FlyCamera {
  private flying = false;
  private free = false;
  private pose = { position: [0, 1.7, 0] as [number, number, number], yaw: 0, pitch: 0 };
  private readonly keys = new Set<string>();
  /** Metres a second. */
  private speed = 8;
  private last = 0;
  /** The right button went down on the view (a context menu after it is not wanted). */
  private rightDown = false;
  private moved = false;
  private lastMouse: { x: number; y: number } | null = null;
  private readonly listeners: (() => void)[] = [];

  constructor(
    private readonly preview: Preview,
    private readonly canvas: HTMLCanvasElement,
    private readonly hint: (text: string) => void,
  ) {
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 2) return;
      event.preventDefault();
      this.downAt = { x: event.clientX, y: event.clientY };
      this.flew = false;
      this.start();
    });
    window.addEventListener('mouseup', (event) => {
      if (event.button === 2 && this.flying) this.stop();
    });
    window.addEventListener('contextmenu', (event) => {
      if (this.rightDown) {
        event.preventDefault();
        this.rightDown = false;
      }
    });
    window.addEventListener('mousemove', (event) => {
      if (!this.flying) return;
      // (the mouse locked: its own movement; not: how far it went since the last move — and a jump
      // some systems report on the first move is let go)
      const locked = document.pointerLockElement === this.canvas;
      const last = this.lastMouse;
      this.lastMouse = { x: event.clientX, y: event.clientY };
      const dx = locked ? event.movementX : last === null ? 0 : event.clientX - last.x;
      const dy = locked ? event.movementY : last === null ? 0 : event.clientY - last.y;
      if (Math.abs(dx) > 250 || Math.abs(dy) > 250 || (dx === 0 && dy === 0)) return;
      // (a hand's tremble is not a look around: a right click stays a click)
      if (!this.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      this.moved = true;
      this.pose.yaw -= dx * LOOK;
      this.pose.pitch = Math.max(-1.55, Math.min(1.55, this.pose.pitch - dy * LOOK));
      this.apply();
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.flying) return;
        event.preventDefault();
        event.stopPropagation();
        this.speed = Math.min(80, Math.max(1, this.speed * Math.exp(-event.deltaY * 0.0015)));
        this.hint(`Скорость полёта: ${this.speed.toFixed(1)} м/с`);
      },
      { passive: false },
    );
    // (while flying the keys move the camera — not play the song or change the brush)
    window.addEventListener(
      'keydown',
      (event) => {
        if (!this.flying || !MOVE_KEYS.has(event.code)) return;
        this.keys.add(event.code);
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    window.addEventListener(
      'keyup',
      (event) => {
        if (!this.keys.delete(event.code) && !this.flying) return;
        if (this.flying) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    window.addEventListener('blur', () => {
      this.keys.clear();
      if (this.flying) this.stop();
    });
  }

  /** Whether the view has been flown away from the player's place. */
  get isFree() {
    return this.free;
  }

  onChange(listener: () => void) {
    this.listeners.push(listener);
  }

  /** Where the camera stands when not flown (null: where the player stands). */
  private home: { position: [number, number, number]; yaw: number; pitch: number } | null = null;

  /** `keep`: the camera stays where it is (flown from there on), only "reset" goes to the new home. */
  setHome(pose: { position: [number, number, number]; yaw: number; pitch: number } | null, keep = false) {
    const here = this.preview.view.cameraPose();
    this.home = pose === null ? null : { position: [...pose.position], yaw: pose.yaw, pitch: pose.pitch };
    if (!keep) {
      this.reset();
      return;
    }
    this.pose = here;
    this.free = true;
    this.preview.view.setFreeCamera(here);
    for (const listener of this.listeners) listener();
  }

  /** Back home (where the player stands, or the notes track's view). */
  reset() {
    this.free = false;
    this.preview.view.setFreeCamera(this.home);
    for (const listener of this.listeners) listener();
  }

  private start() {
    if (this.flying) return;
    this.flying = true;
    this.rightDown = true;
    this.lastMouse = null;
    this.moved = false;
    if (!this.free) this.pose = this.home !== null ? { position: [...this.home.position], yaw: this.home.yaw, pitch: this.home.pitch } : this.preview.view.cameraPose();
    this.keys.clear();
    this.last = performance.now();
    try {
      void this.canvas.requestPointerLock?.();
    } catch {
      // (the mouse still turns the view without the lock, while it stays over the window)
    }
    requestAnimationFrame(this.step);
  }

  /** A right click that flew nothing (no mouse move, no keys): handed on (where it went down). */
  onRightClick: ((clientX: number, clientY: number) => void) | null = null;
  private downAt: { x: number; y: number } | null = null;
  private flew = false;

  private stop() {
    this.flying = false;
    if (!this.moved && !this.flew && this.downAt !== null) this.onRightClick?.(this.downAt.x, this.downAt.y);
    this.downAt = null;
    this.keys.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private apply() {
    if (!this.free) {
      this.free = true;
      for (const listener of this.listeners) listener();
    }
    this.preview.view.setFreeCamera(this.pose);
  }

  private readonly step = () => {
    if (!this.flying) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const { yaw, pitch } = this.pose;
    const forward = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const move = [0, 0, 0];
    const add = (vector: number[], sign: number) => {
      for (let i = 0; i < 3; i++) move[i]! += vector[i]! * sign;
    };
    if (this.keys.has('KeyW')) add(forward, 1);
    if (this.keys.has('KeyS')) add(forward, -1);
    if (this.keys.has('KeyD')) add(right, 1);
    if (this.keys.has('KeyA')) add(right, -1);
    if (this.keys.has('Space') || this.keys.has('KeyE')) move[1]! += 1;
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyQ')) move[1]! -= 1;
    const length = Math.hypot(move[0]!, move[1]!, move[2]!);
    if (length > 0) {
      this.flew = true;
      const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1;
      const distance = (this.speed * fast * dt) / length;
      for (let i = 0; i < 3; i++) this.pose.position[i]! += move[i]! * distance;
      this.moved = true;
      this.apply();
    }
    requestAnimationFrame(this.step);
  };
}
