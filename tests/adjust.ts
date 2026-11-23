import { adjustClips, NO_ADJUSTMENT, type Adjustment } from '../src/editor/adjust';
import type { LightClip } from '../src/editor/model';

/**
 * Changing the selected events' light: brightness, hue, a gradient over them, per row, pulses, a flutter.
 *
 * npx tsx tests/adjust.ts
 */

let failures = 0;
let checks = 0;
const check = (ok: boolean, ...what: unknown[]) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('fail', ...what);
  }
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
const scheme = { left: [1, 0, 0] as [number, number, number], right: [0, 0, 1] as [number, number, number], white: [1, 1, 1] as [number, number, number] };
const clip = (id: string, start: number, end: number, row = 'a'): LightClip & { row: string } => ({ id, type: 0, ids: null, start, end, startMode: 'on', fadeIn: 0, endMode: 'off', color: { ref: 'left', brightness: 1 }, endColor: null, layer: 1, row });
const adjust = (patch: Partial<Adjustment>) => ({ ...structuredClone(NO_ADJUSTMENT), ...patch });

// brightness everywhere the same
let clips = [clip('a', 0, 1), clip('b', 2, 3)];
adjustClips(clips, adjust({ brightness: [0.5, 0.5] }), scheme);
check(clips.every((item) => near(item.color.brightness, 0.5) && item.color.ref === 'left' && item.endColor === null), 'brightness', clips);

// hue: red turned 120° is green, as a Chroma colour
clips = [clip('a', 0, 1)];
adjustClips(clips, adjust({ hue: [120, 120] }), scheme);
check(clips[0]!.color.ref === 'custom' && near(clips[0]!.color.rgb![1], 1) && near(clips[0]!.color.rgb![0], 0), 'hue', clips[0]!.color);

// gradient 1 → 0 over 0…4: the clip at 2…4 goes from half to nothing
clips = [clip('a', 0, 2), clip('b', 2, 4)];
adjustClips(clips, adjust({ brightness: [1, 0], gradient: true }), scheme);
check(near(clips[1]!.color.brightness, 0.5) && near(clips[1]!.endColor!.brightness, 0), 'gradient', clips[1]);

// per row: each row its own start and end
clips = [clip('a', 0, 1, 'x'), clip('b', 3, 4, 'x'), clip('c', 2, 3, 'y')];
adjustClips(clips, adjust({ brightness: [1, 0], gradient: true, perRow: true }), scheme, (item) => (item as LightClip & { row: string }).row);
check(near(clips[2]!.color.brightness, 1) && near(clips[2]!.endColor!.brightness, 0) && near(clips[0]!.color.brightness, 1), 'per row', clips);

// pulses: dimmest half way between the starts of the swells
clips = [clip('a', 0, 0.5), clip('b', 2, 2.5), clip('c', 3.5, 4)];
adjustClips(clips, adjust({ pulse: { cycles: 2, depth: 1 } }), scheme);
check(near(clips[0]!.color.brightness, 1) && near(clips[1]!.color.brightness, 1) && clips[0]!.endColor!.brightness < 0.6, 'pulse', clips.map((item) => [item.color.brightness, item.endColor?.brightness]));

// flutter: every clip split at its middle, the second half dimmer
clips = [clip('a', 0, 1), clip('b', 2, 4)];
const added = adjustClips(clips, adjust({ flutter: { multiplier: 0.5, turbulence: 0, seed: 1 } }), scheme);
check(added.length === 2 && near(clips[0]!.end, 0.5) && near(added[0]!.start, 0.5) && near(added[0]!.end, 1) && near(added[0]!.color.brightness, 0.5) && clips[0]!.endMode === 'stay', 'flutter', clips, added);
check(near(added[1]!.start, 3), 'flutter middle', added[1]);

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
