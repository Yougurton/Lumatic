import type { BasicEvent } from '../engine/core/beatmap/types';
import { customLightIds } from '../engine/core/lighting/basic-light';
import { isLightType, newId, type ClipColor, type LightClip, type RawEvent, type Rgb } from './model';

/**
 * A map's own light events → clips (layer 0), light by light, the way the game plays them: an
 * "on"/flash lasts until the light's next event, a transition becomes a gradient into it, the
 * game's fade a clip fading out over its 1.5 s. Clips that come out the same for several lights
 * become one clip for all of them. Everything that isn't a light (rings, zoom, lasers, boost) is
 * kept as it is.
 */

const isOn = (value: number) => value === 1 || value === 5 || value === 9;
const isFlash = (value: number) => value === 2 || value === 6 || value === 10;
const isFade = (value: number) => value === 3 || value === 7 || value === 11;
const isTransition = (value: number) => value === 4 || value === 8 || value === 12;

function colorOf(event: BasicEvent): ClipColor {
  const ref: ClipColor['ref'] = event.value >= 1 && event.value <= 4 ? 'right' : event.value >= 5 && event.value <= 8 ? 'left' : 'white';
  const raw = event.customData?._color ?? event.customData?.color;
  if (Array.isArray(raw) && raw.length >= 3 && event.value <= 8) {
    const [r, g, b, a] = raw.map((value) => (typeof value === 'number' ? value : 1)) as number[];
    return { ref: 'custom', rgb: [r ?? 1, g ?? 1, b ?? 1] as Rgb, brightness: round(event.floatValue * (a ?? 1)) };
  }
  return { ref, brightness: round(event.floatValue) };
}

const round = (value: number) => Math.round(value * 10000) / 10000;

function sameColor(a: ClipColor | null, b: ClipColor | null) {
  if (a === null || b === null) return a === b;
  return a.ref === b.ref && a.brightness === b.brightness && (a.rgb ?? []).join() === (b.rgb ?? []).join();
}

export function importEvents(
  events: readonly BasicEvent[],
  lights: ReadonlyMap<number, readonly number[]>,
  songEndBeat: number,
  beatsPerSecond: number,
): { clips: LightClip[]; raw: RawEvent[] } {
  const raw: RawEvent[] = [];
  const byType = new Map<number, BasicEvent[]>();
  for (const event of events) {
    if (!isLightType(event.type) || event.value > 12) {
      raw.push({
        id: newId('r'),
        beat: event.jsonTime,
        type: event.type,
        value: event.value,
        floatValue: event.floatValue,
        ...(event.customData === undefined ? {} : { customData: event.customData as Record<string, unknown> }),
      });
      continue;
    }
    const list = byType.get(event.type) ?? [];
    list.push(event);
    byType.set(event.type, list);
  }
  const clips: LightClip[] = [];
  for (const [type, list] of byType) {
    list.sort((a, b) => a.jsonTime - b.jsonTime);
    const known = lights.get(type) ?? [];
    const targeted = [...new Set(list.flatMap((event) => customLightIds(event) ?? []))];
    const ids: (number | null)[] = known.length > 0 || targeted.length > 0 ? [...new Set([...known, ...targeted])].sort((a, b) => a - b) : [null];
    const perLight: { id: number | null; clip: Omit<LightClip, 'id' | 'ids' | 'type' | 'layer'> }[] = [];
    for (const id of ids) {
      const mine = list.filter((event) => {
        const target = customLightIds(event);
        return id === null || target === undefined || target.includes(id);
      });
      let open: { start: number; startMode: LightClip['startMode']; fadeIn: number; color: ClipColor; hsv?: boolean } | null = null;
      let offAt: number | null = null;
      const close = (end: number, endMode: LightClip['endMode'], endColor: ClipColor | null, hsv = false) => {
        if (open === null) return;
        if (end > open.start + 1e-6) {
          const clip: (typeof perLight)[number]['clip'] = { start: open.start, end, startMode: open.startMode, fadeIn: open.fadeIn, endMode, color: open.color, endColor };
          if (hsv || open.hsv) clip.hsv = true;
          perLight.push({ id, clip });
        }
        open = null;
      };
      mine.forEach((event) => {
        const beat = event.jsonTime;
        const value = event.value;
        // (the game's fade is over after 1.5 s: it ends there, in the dark)
        if (open?.startMode === 'fade' && beat > open.start + 1.5 * beatsPerSecond) {
          const faded = open.start + 1.5 * beatsPerSecond;
          close(faded, 'stay', null);
          // (but nothing comes up out of a finished fade: the game doesn't blend from it)
          offAt = null;
        }
        if (value === 0) {
          close(beat, 'off', null);
          offAt = beat;
          return;
        }
        const color = colorOf(event);
        if (isTransition(value)) {
          if (open !== null) {
            // (the game doesn't blend out of a flash or a fade: it jumps to the new colour then)
            const blends = open.startMode !== 'flash' && open.startMode !== 'fade';
            const hsv = blends && String(event.customData?._lerpType ?? event.customData?.lerpType ?? '') === 'HSV';
            close(beat, 'stay', blends && !sameColor(open.color, color) ? color : null, hsv);
            open = { start: beat, startMode: 'on', fadeIn: 0.5, color };
          } else {
            // (from dark: it fades in from where it went out)
            const from = offAt ?? beat;
            open = { start: from, startMode: 'fadeIn', fadeIn: Math.max(0.01, beat - from), color };
            if (String(event.customData?._lerpType ?? event.customData?.lerpType ?? '') === 'HSV') open.hsv = true;
            if (beat - from < 1e-6) open.startMode = 'on';
          }
          offAt = null;
          return;
        }
        // (a new start right away: the one before simply hands over)
        close(beat, 'stay', null);
        offAt = null;
        if (isFade(value)) {
          open = { start: beat, startMode: 'fade', fadeIn: 0.5, color };
          return;
        }
        open = { start: beat, startMode: isFlash(value) ? 'flash' : isOn(value) ? 'on' : 'on', fadeIn: 0.5, color };
      });
      close(Math.max(songEndBeat, (mine.at(-1)?.jsonTime ?? 0) + 1), 'stay', null);
    }
    // the same clip on several lights: one clip for all of them
    const groups = new Map<string, { clip: (typeof perLight)[number]['clip']; ids: (number | null)[] }>();
    for (const { id, clip } of perLight) {
      const key = JSON.stringify(clip);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { clip, ids: [id] });
      else group.ids.push(id);
    }
    for (const { clip, ids: on } of groups.values()) {
      const lightIds = on.filter((id): id is number => id !== null);
      const everyLight = on.includes(null) || (known.length > 0 && known.every((id) => lightIds.includes(id)));
      clips.push({ ...clip, id: newId(), type, ids: everyLight ? null : lightIds, layer: 0 });
    }
  }
  clips.sort((a, b) => a.start - b.start || a.type - b.type);
  return { clips, raw };
}
