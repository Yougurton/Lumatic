import { paletteOf, readMapColors, suggestColors, writeMapColors, type MapColors } from '../src/editor/map-colors';
import { colorSchemeForDifficulty, parseInfo } from '../src/engine/core/beatmap/info';
import { resolveColorScheme } from '../src/engine/core/colors';

/**
 * The map's colours: written into Info.dat (v2.0, v2.1, v4), read back as written, read by the
 * viewer's own Info parser as the difficulties' colours, taken out again; and colours from a cover.
 *
 * npx tsx tests/colors.ts
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
const near = (a: readonly number[] | undefined, b: readonly number[]) => a !== undefined && a.every((value, index) => Math.abs(value - b[index]!) < 0.005);

const colors: MapColors = { left: [1, 0.5, 0], right: [0, 0.5, 1], white: [0.9, 0.9, 1], leftBoost: [1, 0, 0.5], rightBoost: [0, 1, 0.5], whiteBoost: [1, 1, 1], notes: false, leftNote: [0.75, 0.1, 0.1], rightNote: [0.1, 0.4, 0.75], obstacle: [1, 0, 0] };

const difficulty = (name: string, extra: Record<string, unknown> = {}) => ({ _difficulty: name, _difficultyRank: 7, _beatmapFilename: `${name}Standard.dat`, _noteJumpMovementSpeed: 16, _noteJumpStartBeatOffset: 0, _beatmapColorSchemeIdx: 0, _environmentNameIdx: 0, ...extra });
const v2 = (version: string) =>
  JSON.stringify({
    _version: version, _songName: 'S', _songSubName: '', _songAuthorName: 'A', _levelAuthorName: 'M', _beatsPerMinute: 120, _songTimeOffset: 0, _shuffle: 0, _shufflePeriod: 0.5, _previewStartTime: 0, _previewDuration: 10,
    _songFilename: 'song.ogg', _coverImageFilename: 'cover.png', _environmentName: 'DefaultEnvironment', _allDirectionsEnvironmentName: 'GlassDesertEnvironment', _environmentNames: ['DefaultEnvironment'], _colorSchemes: [],
    _difficultyBeatmapSets: [{ _beatmapCharacteristicName: 'Standard', _difficultyBeatmaps: [difficulty('Expert', { _customData: { _difficultyLabel: 'X', _requirements: ['Chroma'] } }), difficulty('Hard')] }],
  });
const v4 = JSON.stringify({
  version: '4.0.1', song: { title: 'S', subTitle: '', author: 'A' }, audio: { songFilename: 'song.ogg', songDuration: 100, audioDataFilename: 'BPMInfo.dat', bpm: 120, lufs: 0, previewStartTime: 0, previewDuration: 10 },
  songPreviewFilename: 'song.ogg', coverImageFilename: 'cover.png', environmentNames: ['DefaultEnvironment'], colorSchemes: [],
  difficultyBeatmaps: ['Expert', 'Hard'].map((name) => ({ characteristic: 'Standard', difficulty: name, beatmapAuthors: { mappers: [], lighters: [] }, environmentNameIdx: 0, beatmapColorSchemeIdx: 0, noteJumpMovementSpeed: 16, noteJumpStartBeatOffset: 0, beatmapDataFilename: `${name}.dat`, lightshowDataFilename: 'Lightshow.dat' })),
});

const environment = { colorLeft: [0.7, 0, 0], colorRight: [0, 0.4, 0.7], obstacleColor: [1, 0, 0], envColorLeft: [1, 0, 0], envColorRight: [0, 0, 1], envColorWhite: [0.7, 0.7, 0.7], envColorLeftBoost: [1, 0, 1], envColorRightBoost: [0, 1, 1], envColorWhiteBoost: [0.7, 0.7, 0.7], supportsEnvironmentColorBoost: true } as const;
for (const [name, text] of [['v2.0', v2('2.0.0')], ['v2.1', v2('2.1.0')], ['v4', v4]] as const) {
  check(readMapColors(text) === null, name, 'none at first');
  const written = writeMapColors(text, colors);
  const back = readMapColors(written);
  check(back !== null && near(back.left, colors.left) && near(back.rightBoost, colors.rightBoost) && near(back.white, colors.white) && back.notes === false, name, 'read back', back);
  // the viewer's parser: every difficulty's lights in these colours, its notes kept (a v2.1 scheme
  // has notes too: the dialog gives it the environment's)
  const info = parseInfo(written);
  for (const item of info.difficultySets.flatMap((set) => set.difficulties)) {
    const scheme = resolveColorScheme(environment, colorSchemeForDifficulty(info, item));
    check(near(scheme.environmentLeft, colors.left) && near(scheme.environmentRightBoost, colors.rightBoost) && near(scheme.leftNote, name === 'v2.1' ? colors.leftNote : environment.colorLeft), name, item.difficulty, 'scheme', scheme);
  }
  // written again: still one scheme
  const twice = writeMapColors(written, { ...colors, left: [1, 1, 0] });
  const parsed = JSON.parse(twice) as { colorSchemes?: unknown[]; _colorSchemes?: unknown[] };
  check((parsed.colorSchemes ?? parsed._colorSchemes ?? []).length <= 1 && near(readMapColors(twice)?.left, [1, 1, 0]), name, 'once');
  // taken out: as it was (the difficulty's own data kept)
  const removed = writeMapColors(twice, null);
  check(readMapColors(removed) === null, name, 'removed');
  check(JSON.stringify(JSON.parse(removed)) === JSON.stringify(JSON.parse(text)), name, 'as before', removed);
}

// the cover: a picture in orange and blue with a white strip — orange left, blue right, white white
const pixels = new Uint8ClampedArray(100 * 100 * 4);
for (let i = 0; i < 100 * 100; i++) {
  const x = i % 100;
  const rgb = x < 45 ? [230, 120, 20] : x < 90 ? [20, 60, 200] : [240, 240, 240];
  pixels.set([...rgb, 255], i * 4);
}
const palette = paletteOf(pixels, 6);
check(palette.length >= 3 && palette[0]!.weight > 0.4, 'palette', palette);
const suggested = suggestColors(palette);
check(suggested.left[0] > 0.9 && suggested.left[2] < 0.2 && suggested.right[2] > 0.9 && suggested.right[0] < 0.2, 'suggested sides', suggested);
check(near(suggested.white, [1, 1, 1]), 'suggested white', suggested.white);
// a picture of one colour: its opposite on the right
const single = suggestColors([{ rgb: [0.9, 0.1, 0.1], weight: 1 }]);
check(single.right[1] > 0.5 || single.right[2] > 0.5, 'one colour', single);

console.log('checks', checks, 'failures', failures);
if (failures > 0) process.exit(1);
