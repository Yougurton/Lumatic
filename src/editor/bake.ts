import { clipLights, clipPriority, type ClipColor, type LightClip, type LightGroup, type RawEvent, type Rgb } from './model';

/**
 * Clips → the plain light events the game plays (format-neutral; map-io.ts writes them in the
 * map's own format).
 *
 * Every clip is two or more events: its start (on / flash / an "on" at zero brightness that a
 * transition brings up), a transition to its end colour if it has a gradient, and its end (off, a
 * transition down to nothing, or nothing at all when it stays). Layers: light by light, a clip
 * covers what the layers under it do while it lasts, and where it ends the light is put back into
 * the state the layers under it have reached then (its colour mid-gradient, its brightness) — so a
 * wave passing over a glowing ring leaves the glow behind it. Clips on one layer that overlap on a
 * light: the later one takes over from its start.
 *
 * Events for several lights at the same moment doing the same thing become one event with all of
 * their light IDs (none at all when it's every light of the group).
 */

export interface OutEvent {
  beat: number;
  type: number;
  value: number;
  floatValue: number;
  /** Chroma colour (RGB + alpha), or none: the colour scheme's own. */
  color?: [number, number, number, number];
  /** Chroma light IDs; none: every light of the group. */
  lightIds?: number[];
  /** Raw events keep their own custom data. */
  customData?: Record<string, unknown>;
  /** A transition blending through hue (Chroma's lerpType HSV). */
  hsv?: boolean;
}

export interface SchemeColors {
  left: Rgb;
  right: Rgb;
  white: Rgb;
}

type Kind = 'on' | 'flash' | 'fade' | 'trans' | 'off';

interface Keyframe {
  beat: number;
  kind: Kind;
  /** null for off. */
  color: ClipColor | null;
  /** Its colour as RGB (for working out states under other layers). */
  rgb: Rgb;
  brightness: number;
  /** A transition blending through hue. */
  hsv?: boolean;
}

const KIND_RANK: Record<Kind, number> = { trans: 0, off: 1, on: 2, flash: 2, fade: 2 };

export function resolveRgb(color: ClipColor, scheme: SchemeColors): Rgb {
  if (color.ref === 'custom') return color.rgb ?? [1, 1, 1];
  return scheme[color.ref];
}

function keyframe(beat: number, kind: Kind, color: ClipColor | null, scheme: SchemeColors): Keyframe {
  return {
    beat,
    kind,
    color,
    rgb: color === null ? [0, 0, 0] : resolveRgb(color, scheme),
    brightness: color === null ? 0 : color.brightness,
  };
}

const dark = (color: ClipColor): ClipColor => ({ ...color, brightness: 0 });

/** A clip's own events, from its start; `until` cuts it short (another clip of its layer starts).
 *  `handOver`: another clip of its layer starts right where it ends (no need to put it out). */
function clipKeyframes(clip: LightClip, scheme: SchemeColors, until: number, handOver: boolean, beatsPerSecond: number): { frames: Keyframe[]; cut: boolean } {
  const cut = until < clip.end - 1e-6;
  const end = cut ? until : clip.end;
  const frames: Keyframe[] = [];
  const c0 = clip.color;
  const span = clip.end - clip.start;
  if (clip.startMode === 'flash') frames.push(keyframe(clip.start, 'flash', c0, scheme));
  else if (clip.startMode === 'fade') frames.push(keyframe(clip.start, 'fade', c0, scheme));
  else if (clip.startMode === 'fadeIn') {
    frames.push(keyframe(clip.start, 'on', dark(c0), scheme));
    const up = clip.start + Math.max(0.01, Math.min(clip.fadeIn, span));
    if (up < end - 1e-6 || (!cut && up <= end + 1e-6)) frames.push(keyframe(up, 'trans', c0, scheme));
  } else frames.push(keyframe(clip.start, 'on', c0, scheme));
  if (cut) return { frames, cut };
  if (clip.startMode === 'fade') {
    // (the game's fade ends in the dark by itself)
    if (clip.endMode === 'off' && !handOver) frames.push(keyframe(clip.end, 'off', null, scheme));
    return { frames, cut };
  }
  const ramps = clip.endMode === 'fade' || clip.endColor !== null;
  if (ramps && clip.startMode === 'flash') {
    // a transition can't start from a flash in the game: the flash settles first, then it goes on
    const settled = clip.start + Math.min(0.6 * beatsPerSecond, span / 2);
    frames.push(keyframe(settled, 'on', c0, scheme));
  }
  const last = clip.endColor ?? c0;
  if (clip.endMode === 'fade') frames.push(keyframe(clip.end, 'trans', dark(last), scheme));
  else {
    if (clip.endColor !== null) frames.push(keyframe(clip.end, 'trans', clip.endColor, scheme));
    if (clip.endMode === 'off' && !handOver) frames.push(keyframe(clip.end, 'off', null, scheme));
  }
  return { frames, cut };
}

function withBlend(result: { frames: Keyframe[]; cut: boolean }, clip: LightClip) {
  if (clip.hsv === true) for (const frame of result.frames) if (frame.kind === 'trans') frame.hsv = true;
  return result;
}

/** The light's state at `beat` from a keyframe list: its colour and brightness (null: off). */
function stateAt(frames: readonly Keyframe[], beat: number, secondsPerBeat: number): { color: ClipColor; rgb: Rgb; brightness: number; resting: Keyframe | null } | null {
  let index = -1;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]!.beat <= beat + 1e-9) index = i;
    else break;
  }
  if (index < 0) return null;
  const current = frames[index]!;
  const next = frames[index + 1];
  if (current.kind === 'off' && (next === undefined || next.kind !== 'trans')) return null;
  if (next !== undefined && next.kind === 'trans' && current.kind !== 'flash' && current.kind !== 'fade') {
    const span = next.beat - current.beat;
    const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (beat - current.beat) / span));
    const fromRgb = current.kind === 'off' ? next.rgb : current.rgb;
    const fromBrightness = current.kind === 'off' ? 0 : current.brightness;
    const rgb: Rgb = next.hsv === true ? lerpHsv(fromRgb, next.rgb, t) : [
      fromRgb[0] + (next.rgb[0] - fromRgb[0]) * t,
      fromRgb[1] + (next.rgb[1] - fromRgb[1]) * t,
      fromRgb[2] + (next.rgb[2] - fromRgb[2]) * t,
    ];
    const brightness = fromBrightness + (next.brightness - fromBrightness) * t;
    if (t <= 0 && current.kind !== 'off' && current.color !== null) return { color: current.color, rgb: current.rgb, brightness: current.brightness, resting: current };
    return { color: { ref: 'custom', rgb, brightness }, rgb, brightness, resting: null };
  }
  if (current.kind === 'off' || current.color === null) return null;
  if (current.kind === 'fade') {
    // (the game's fade: down to nothing over 1.5 s)
    const elapsed = (beat - current.beat) * secondsPerBeat;
    const brightness = current.brightness * Math.max(0, 1 - elapsed / 1.5);
    if (brightness <= 0.001) return null;
    return { color: { ...current.color, brightness }, rgb: current.rgb, brightness, resting: null };
  }
  return { color: current.color, rgb: current.rgb, brightness: current.brightness, resting: current.kind === 'on' ? current : null };
}

function sortFrames(frames: Keyframe[]) {
  // (stable: frames at one moment keep their order — a gradient's last step before the light goes out)
  return frames
    .map((frame, order) => ({ frame, order }))
    .sort((a, b) => a.frame.beat - b.frame.beat || KIND_RANK[a.frame.kind] - KIND_RANK[b.frame.kind] || a.order - b.order)
    .map((item) => item.frame);
}

/** A clip as the bake sees it: on one event type, with the rank it covers others by. */
type BakeClip = LightClip & { rank: number };

/** Where a clip stands among the others on a light: its layer, then what it was drawn on (see
 *  `clipPriority`). */
export function clipRank(clip: LightClip, groups: readonly LightGroup[]) {
  return clip.layer * 16 + clipPriority(clip, groups);
}

/** One light's events from all the clips on it. */
function bakeLight(clips: readonly BakeClip[], scheme: SchemeColors, secondsPerBeat: number): Keyframe[] {
  const beatsPerSecond = 1 / secondsPerBeat;
  const layers = [...new Set(clips.map((clip) => clip.rank))].sort((a, b) => a - b);
  let base: Keyframe[] = [];
  for (const layer of layers) {
    const onLayer = clips.filter((clip) => clip.rank === layer).sort((a, b) => a.start - b.start || a.end - b.end);
    const below = base;
    let kept = base;
    const added: Keyframe[] = [];
    onLayer.forEach((clip, index) => {
      const next = onLayer.slice(index + 1).find((other) => other.start > clip.start - 1e-9 && other.start < clip.end + 1e-9 && other !== clip);
      const until = next === undefined ? clip.end : Math.min(clip.end, next.start);
      // (a later clip of this layer starting right where this one ends takes over: no going back
      // to the layer below in between)
      const handOver = next !== undefined && next.start <= clip.end + 1e-9;
      const { frames, cut } = withBlend(clipKeyframes(clip, scheme, until, handOver, beatsPerSecond), clip);
      const end = cut ? until : clip.end;
      // the layers below don't show while it lasts
      kept = kept.filter((frame) => frame.beat < clip.start - 1e-9 || frame.beat >= end - 1e-9);
      if (!cut && !handOver && clip.endMode !== 'stay' && below.length > 0) {
        const under = stateAt(below, end, secondsPerBeat);
        if (under !== null) {
          // back to what's underneath: fading into it, or straight back to it
          const restore: ClipColor = under.resting?.color ?? under.color;
          if (clip.endMode === 'fade') {
            const last = frames.pop();
            if (last !== undefined && last.kind === 'trans') frames.push(keyframe(end, 'trans', restore, scheme));
            else if (last !== undefined) frames.push(last);
          } else {
            const offAt = frames.findIndex((frame) => frame.kind === 'off' && Math.abs(frame.beat - end) < 1e-9);
            if (offAt >= 0) frames.splice(offAt, 1);
            frames.push(keyframe(end, 'on', restore, scheme));
          }
        }
      }
      added.push(...frames);
    });
    base = sortFrames([...kept, ...added]);
  }
  return base;
}

function valueOf(kind: Kind, color: ClipColor | null): number {
  if (kind === 'off' || color === null) return 0;
  const base = color.ref === 'left' ? 5 : color.ref === 'white' ? 9 : 1;
  return base + (kind === 'on' ? 0 : kind === 'flash' ? 1 : kind === 'fade' ? 2 : 3);
}

/** Every light event of the show. `lights`: each light group's light IDs (from the environment);
 *  `groups`: the user's light groups (clips drawn on them light their lights). */
export function bakeLights(
  clips: readonly LightClip[],
  lights: ReadonlyMap<number, readonly number[]>,
  scheme: SchemeColors,
  secondsPerBeat: number,
  groups: readonly LightGroup[] = [],
): OutEvent[] {
  const out: (OutEvent & { rank: number; order: number })[] = [];
  let order = 0;
  const byType = new Map<number, BakeClip[]>();
  for (const clip of clips) {
    if (clip.end <= clip.start) continue;
    const rank = clipRank(clip, groups);
    for (const [type, ids] of clipLights(clip, groups)) {
      if (ids !== null && ids.length === 0) continue;
      const list = byType.get(type) ?? [];
      list.push({ ...clip, type, ids, rank });
      byType.set(type, list);
    }
  }
  for (const [type, typeClips] of byType) {
    const known = lights.get(type) ?? [];
    const ids = [...new Set([...known, ...typeClips.flatMap((clip) => clip.ids ?? [])])].sort((a, b) => a - b);
    // A group with no light IDs known and clips for all of it: as group events, as they are.
    if (ids.length === 0) {
      for (const frame of bakeLight(typeClips, scheme, secondsPerBeat)) {
        out.push({ ...toEvent(type, frame), rank: KIND_RANK[frame.kind], order: order++ });
      }
      continue;
    }
    // light by light, then the same moments merged back together
    const merged = new Map<string, OutEvent & { rank: number; order: number }>();
    for (const id of ids) {
      const onLight = typeClips.filter((clip) => clip.ids === null || clip.ids.includes(id));
      if (onLight.length === 0) continue;
      for (const frame of bakeLight(onLight, scheme, secondsPerBeat)) {
        const event = toEvent(type, frame);
        const key = `${event.beat.toFixed(5)}|${String(event.value)}|${event.floatValue.toFixed(4)}|${event.color?.map((c) => c.toFixed(4)).join(',') ?? ''}|${event.hsv === true ? 'h' : ''}`;
        const existing = merged.get(key);
        if (existing === undefined) merged.set(key, { ...event, lightIds: [id], rank: KIND_RANK[frame.kind], order: order++ });
        else existing.lightIds!.push(id);
      }
    }
    for (const event of merged.values()) {
      if (event.lightIds !== undefined && known.length > 0 && event.lightIds.length >= known.length && known.every((id) => event.lightIds!.includes(id))) {
        delete event.lightIds;
      }
      out.push(event);
    }
  }
  out.sort((a, b) => a.beat - b.beat || a.rank - b.rank || a.order - b.order);
  return out.map(({ rank: _rank, order: _order, ...event }) => event);
}

function toEvent(type: number, frame: Keyframe): OutEvent {
  const event: OutEvent = {
    beat: Math.round(frame.beat * 10000) / 10000,
    type,
    value: valueOf(frame.kind, frame.color),
    floatValue: frame.kind === 'off' ? 0 : Math.round(frame.brightness * 10000) / 10000,
  };
  if (frame.hsv === true && frame.kind === 'trans') event.hsv = true;
  if (frame.color !== null && frame.color.ref === 'custom' && frame.kind !== 'off') {
    const rgb = frame.color.rgb ?? [1, 1, 1];
    event.color = [round4(rgb[0]), round4(rgb[1]), round4(rgb[2]), 1];
  }
  return event;
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

/** Raw (non-light) events as they were. */
export function rawEvents(raw: readonly RawEvent[]): OutEvent[] {
  return raw.map((event) => ({
    beat: event.beat,
    type: event.type,
    value: event.value,
    floatValue: event.floatValue,
    ...(event.customData === undefined ? {} : { customData: event.customData }),
  }));
}

function rgbToHsv([r, g, b]: Rgb): Rgb {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return [hue, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb([h, s, v]: Rgb): Rgb {
  const section = Math.floor(h * 6);
  const f = h * 6 - section;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((section % 6) + 6) % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/** Through hue, the short way round (as Chroma does). */
export function lerpHsv(from: Rgb, to: Rgb, t: number): Rgb {
  const a = rgbToHsv(from);
  const b = rgbToHsv(to);
  let dh = b[0] - a[0];
  if (dh > 0.5) dh -= 1;
  if (dh < -0.5) dh += 1;
  return hsvToRgb([(a[0] + dh * t + 1) % 1, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}
