import type { MapNote } from './notes';

/** The arrow's turn as the game has it (degrees; 0: a down note). */
const ROLL: Record<number, number> = { 0: 180, 1: 0, 2: -90, 3: 90, 4: -135, 5: 135, 6: -45, 7: 45, 8: 0 };

/**
 * A note drawn flat as the player sees it in the game: the whole block turned to its direction (a
 * diagonal one stands on its corner), its arrow a wide chevron on the side the cut starts from,
 * pointing where it goes; a dot in the middle for a dot note.
 */
export function drawGameNote(ctx: CanvasRenderingContext2D, note: Pick<MapNote, 'd' | 'a'>, x: number, y: number, size: number, color: string, picked: boolean) {
  const half = size / 2;
  ctx.save();
  ctx.translate(x, y);
  // (the game turns the block counter-clockwise by its angle; the canvas turns clockwise)
  ctx.rotate((-((ROLL[note.d] ?? 0) + (note.d === 8 ? 0 : note.a)) * Math.PI) / 180);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(-half, -half, size, size, size * 0.18);
  ctx.fill();
  // (lit from above: a lighter top, a darker bottom)
  const light = ctx.createLinearGradient(0, -half, 0, half);
  light.addColorStop(0, 'rgba(255,255,255,0.22)');
  light.addColorStop(0.5, 'rgba(255,255,255,0)');
  light.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = light;
  ctx.fill();
  ctx.strokeStyle = picked ? '#ffe27a' : 'rgba(0,0,0,0.5)';
  ctx.lineWidth = picked ? Math.max(2, size * 0.07) : 1;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  if (note.d === 8) {
    ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2);
  } else {
    // (a down note: the chevron in the upper half, pointing down)
    ctx.moveTo(-size * 0.32, -size * 0.32);
    ctx.lineTo(size * 0.32, -size * 0.32);
    ctx.lineTo(0, -size * 0.08);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}
