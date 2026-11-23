import { readFileSync } from 'node:fs';
import { parseInfo } from '../src/engine/core/beatmap/info';
import { parseDifficulty } from '../src/engine/core/beatmap/parse';
import { createBasicLightTimeline, customLightIds, sampleBasicLightTimeline, resolveBasicLightColor, resolveBasicLightAlpha } from '../src/engine/core/lighting/basic-light';
import type { BasicEvent } from '../src/engine/core/beatmap/types';
import { importEvents } from '../src/editor/import';
import { bakeLights } from '../src/editor/bake';
import { isLightType } from '../src/editor/model';

const dir = process.argv[2]!;
const info = parseInfo(readFileSync(dir + '/Info.dat', 'utf8'));
const diff = parseDifficulty(readFileSync(dir + '/ExpertStandard.dat', 'utf8'), info.beatsPerMinute ?? (info as any).bpm);
const bpm = (info as any).beatsPerMinute ?? (info as any).bpm;
const events = diff.events;
const light = events.filter((e) => isLightType(e.type) && e.value <= 12);
const ids = new Map<number, number[]>();
for (const e of light) { const l = customLightIds(e) ?? []; ids.set(e.type, [...new Set([...(ids.get(e.type) ?? []), ...l])]); }
const end = Math.max(...events.map((e) => e.jsonTime)) + 4;
const t0 = Date.now();
const { clips, raw } = importEvents(events, ids, end, bpm / 60);
const scheme = { left: [1, 0, 0] as [number, number, number], right: [0, 0, 1] as [number, number, number], white: [1, 1, 1] as [number, number, number] };
const baked = bakeLights(clips, ids, scheme, 60 / bpm);
console.log('events', light.length, 'clips', clips.length, 'raw', raw.length, 'baked', baked.length, 'ms', Date.now() - t0);
const toBasic = (b: typeof baked): BasicEvent[] => b.map((e) => ({ jsonTime: e.beat, songBpmTime: e.beat, type: e.type, value: e.value, floatValue: e.floatValue, customData: { ...(e.color ? { color: e.color } : {}), ...(e.lightIds ? { lightID: e.lightIds } : {}), ...(e.hsv ? { lerpType: 'HSV' } : {}) } }));
const cs = { environmentLeft: scheme.left, environmentRight: scheme.right, environmentWhite: scheme.white, environmentLeftBoost: scheme.left, environmentRightBoost: scheme.right, environmentWhiteBoost: scheme.white } as any;
const cache = new Map<string, ReturnType<typeof createBasicLightTimeline>>();
const sample = (evs: BasicEvent[], type: number, id: number, beat: number) => {
  const key = (evs === light ? 'a' : 'b') + type + '|' + id;
  let tl = cache.get(key);
  if (tl === undefined) { const mine = evs.filter((e) => e.type === type && (customLightIds(e) === undefined || customLightIds(e)!.includes(id))); tl = createBasicLightTimeline(mine); cache.set(key, tl); }
  const s = sampleBasicLightTimeline(tl, beat, { songBpm: bpm, offIntensity: 0, lightOnStart: false });
  const c = resolveBasicLightColor(s, cs, false, false); const a = resolveBasicLightAlpha(s);
  return c.map((v) => v * a);
};
const bakedBasic = toBasic(baked);
let worst = 0, n = 0, bad = 0;
for (const [type, list] of ids) {
  for (const id of list.length ? list : [0]) {
    for (let b = 0; b < end; b += 0.13) {
      const x = sample(light, type, id, b), y = sample(bakedBasic, type, id, b);
      const d = Math.max(...x.map((v, i) => Math.abs(v - y[i]!)));
      n++; if (d > 0.02) { bad++; if (bad < 6) console.log('diff', type, id, b.toFixed(2), x.map((v) => v.toFixed(2)), y.map((v) => v.toFixed(2))); }
      worst = Math.max(worst, d);
    }
  }
}
console.log('samples', n, 'bad', bad, 'worst', worst.toFixed(3));
