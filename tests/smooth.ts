/**
 * The game view's smooth wheel: a notch glides about a grid step and lands on the grid; quick notches
 * go further and further; the song never goes before its start.
 *
 * npx tsx tests/smooth.ts
 */
let now = 0;
const frames: ((time: number) => void)[] = [];
Object.assign(globalThis, {
  requestAnimationFrame: (callback: (time: number) => void) => frames.push(callback),
  performance: { now: () => now },
  localStorage: { getItem: () => null, setItem: () => undefined },
});
const { SmoothScroll } = await import('../src/editor/smooth-scroll');

let checks = 0;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL', name, detail ?? '');
  }
};

let listener: ((event: WheelEvent) => void) | null = null;
const canvas = { addEventListener: (_type: string, callback: (event: WheelEvent) => void) => (listener = callback) } as unknown as HTMLCanvasElement;
let head = 8;
const seen: number[] = [];
const editor = { snap: 0.25, endBeat: 400, isPlaying: () => false, playhead: () => head, seek: (beat: number) => { head = beat; seen.push(beat); }, stepSnap: () => undefined } as never;
new SmoothScroll(editor, canvas, () => true);
const wheel = (deltaY: number) => listener!({ deltaY, deltaMode: 0, ctrlKey: false, metaKey: false, defaultPrevented: false, preventDefault: () => undefined } as unknown as WheelEvent);
/** Runs the frames (60 a second) for `seconds`. */
const run = (seconds: number) => {
  for (let k = 0; k < seconds * 60; k++) {
    now += 1000 / 60;
    const due = frames.splice(0);
    for (const frame of due) frame(now);
  }
};

wheel(-100);
run(1.5);
check('one notch: on to the next grid step or two', head > 8 && head <= 8.75 && Math.abs(head / 0.25 - Math.round(head / 0.25)) < 1e-9, head);
const steps = seen.slice(1).map((beat, k) => beat - seen[k]!);
check('smooth: many small moves, slowing down', seen.length > 10 && Math.max(...steps) < 0.1, { frames: seen.length, most: Math.max(...steps) });
check('no going back while gliding on', steps.every((step) => step >= -1e-9), steps.filter((step) => step < 0));

const from = head;
for (let k = 0; k < 6; k++) {
  wheel(-100);
  run(0.06);
}
run(3);
check('quick notches: further', head - from > 3, head - from);
check('settled on the grid', Math.abs(head / 0.25 - Math.round(head / 0.25)) < 1e-9, head);

head = 0.5;
wheel(300);
run(3);
check('never before the song', head === 0, head);

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
