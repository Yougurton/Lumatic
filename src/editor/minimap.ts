import type { Editor } from './editor';
import { groupHue } from './names';

/**
 * The mini map: every lamp of the environment as a dot, seen from the player's place (the far end
 * of the tunnel drawn in towards the middle). The lamps of the light row picked last glow green (and stay
 * so here, while the 3D view only flashes them); the lamps the selected clips light are outlined.
 */

export class MiniMap {
  private readonly context: CanvasRenderingContext2D;

  constructor(private readonly editor: Editor, private readonly canvas: HTMLCanvasElement) {
    this.context = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    editor.onChange((what) => {
      if (what !== 'time') this.draw();
    });
    canvas.addEventListener('click', (event) => this.click(event));
  }

  private projected() {
    const lights = this.editor.lightInfo.filter((light) => this.editor.lightsByType.has(light.type));
    if (lights.length === 0) return { points: [], scale: 1 };
    // (as from the player's place, the far end of the tunnel drawn in towards the middle)
    const raw = lights.map((light) => {
      const depth = 1 + Math.max(0, light.position[2]) * 0.035;
      return { light, u: light.position[0] / depth, v: (light.position[1] - 1.5) / depth };
    });
    const us = raw.map((p) => p.u);
    const vs = raw.map((p) => p.v);
    const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const scale = Math.min((width - 24) / Math.max(1, u1 - u0), (height - 24) / Math.max(1, v1 - v0));
    return {
      points: raw.map((p) => ({ light: p.light, x: 12 + (p.u - u0) * scale + (width - 24 - (u1 - u0) * scale) / 2, y: height - 12 - (p.v - v0) * scale - (height - 24 - (v1 - v0) * scale) / 2 })),
      scale,
    };
  }

  draw() {
    const canvas = this.canvas;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const ctx = this.context;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#0e0f13';
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    const { points } = this.projected();
    if (points.length === 0) {
      ctx.fillStyle = '#4b4f5c';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Мини-карта ламп', 12, 22);
      return;
    }
    const picked = this.editor.pickedLight;
    const selected = this.editor.selectedClips();
    for (const { light, x, y } of points) {
      const isPicked = picked !== null && picked.type === light.type && picked.id === light.lightId;
      const lit = selected.some((clip) => clip.type === light.type && (clip.ids === null || clip.ids.includes(light.lightId)));
      ctx.fillStyle = isPicked ? '#3dff7a' : `hsl(${String(groupHue(light.type))} 60% ${lit ? '70%' : '45%'})`;
      ctx.beginPath();
      ctx.arc(x, y, isPicked ? 5 : 2.6, 0, Math.PI * 2);
      ctx.fill();
      if (isPicked) {
        ctx.strokeStyle = 'rgba(61,255,122,0.5)';
        ctx.lineWidth = 6;
        ctx.stroke();
      }
      if (lit) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /** A click on a lamp picks its light (and opens its group on the timeline). */
  private click(event: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: { type: number; id: number; d: number } | null = null;
    for (const point of this.projected().points) {
      const d = Math.hypot(point.x - x, point.y - y);
      if (d < 9 && (best === null || d < best.d)) best = { type: point.light.type, id: point.light.lightId, d };
    }
    if (best === null) return;
    if (!(this.editor.project?.expanded.includes(best.type) ?? false)) this.editor.toggleExpanded(best.type);
    this.editor.pickLight(best.type, best.id);
  }
}
