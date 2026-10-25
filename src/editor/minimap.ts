import type { Editor } from './editor';
import { clipLights, lightKey } from './model';
import { groupHue } from './names';

/**
 * The mini map: every lamp of the environment as a dot, seen from the player's place (the far end
 * of the tunnel drawn in towards the middle). The lamps of the light row picked last glow green (and stay
 * so here, while the 3D view only flashes them); the lamps the selected clips light are outlined;
 * the lamps picked for grouping are ringed in blue.
 *
 * Click: pick a lamp (Ctrl: add it to / take it from the picked ones); drag: pick all the lamps in a
 * box (Ctrl / Shift: add them).
 */

export class MiniMap {
  private readonly context: CanvasRenderingContext2D;
  private box: { x0: number; y0: number; x1: number; y1: number; additive: boolean } | null = null;

  constructor(private readonly editor: Editor, private readonly canvas: HTMLCanvasElement) {
    this.context = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    editor.onChange((what) => {
      if (what !== 'time') this.draw();
    });
    const local = (event: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const { x, y } = local(event);
      this.box = { x0: x, y0: y, x1: x, y1: y, additive: event.ctrlKey || event.metaKey || event.shiftKey };
    });
    window.addEventListener('mousemove', (event) => {
      if (this.box === null) return;
      const { x, y } = local(event);
      this.box.x1 = x;
      this.box.y1 = y;
      this.draw();
    });
    window.addEventListener('mouseup', (event) => {
      const box = this.box;
      this.box = null;
      if (box === null) return;
      if (Math.hypot(box.x1 - box.x0, box.y1 - box.y0) < 4) this.click(event);
      else {
        const [x0, x1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
        const [y0, y1] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
        const inside = this.projected().points.filter((point) => point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1);
        this.editor.selectLights(inside.map((point) => lightKey(point.light.type, point.light.lightId)), box.additive ? 'add' : 'replace');
      }
      this.draw();
    });
  }

  private projected() {
    const lights = this.editor.lightInfo.filter((light) => this.editor.lightsByType.has(light.type));
    if (lights.length === 0) return { points: [], scale: 1 };
    // (as from the player's place, the far end of the tunnel drawn in towards the middle)
    const forward = this.editor.forward;
    const raw = lights.map((light) => {
      const depth = 1 + Math.max(0, light.position[2] * forward) * 0.035;
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
    const groups = this.editor.groups;
    const litKeys = new Set<string>();
    for (const clip of selected) {
      for (const [type, ids] of clipLights(clip, groups)) for (const id of ids ?? this.editor.lightsByType.get(type) ?? []) litKeys.add(lightKey(type, id));
    }
    for (const { light, x, y } of points) {
      const isPicked = picked !== null && picked.type === light.type && picked.id === light.lightId;
      const lit = litKeys.has(lightKey(light.type, light.lightId));
      const chosen = this.editor.lightSelection.has(lightKey(light.type, light.lightId));
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
      if (chosen) {
        ctx.strokeStyle = '#5aaaff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 6.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (this.box !== null) {
      const { x0, y0, x1, y1 } = this.box;
      ctx.fillStyle = 'rgba(90,170,255,0.12)';
      ctx.strokeStyle = 'rgba(90,170,255,0.8)';
      ctx.lineWidth = 1;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    ctx.fillStyle = '#5d6270';
    ctx.font = '11px system-ui, sans-serif';
    const count = this.editor.lightSelection.size;
    ctx.fillText(count > 0 ? `Выбрано ламп: ${String(count)}` : 'Мини-карта', 8, 14);
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
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    if (best === null) {
      if (!additive) this.editor.selectLights([]);
      return;
    }
    const key = lightKey(best.type, best.id);
    this.editor.selectLights([key], additive ? 'toggle' : 'replace');
    if (this.editor.focus === null) {
      if (!(this.editor.project?.expanded.includes(best.type) ?? false)) this.editor.toggleExpanded(best.type);
      this.editor.reveal = `l${key}`;
    }
    this.editor.pickLight(best.type, best.id);
  }
}
