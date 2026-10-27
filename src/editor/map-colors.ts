import type { InfoColorScheme } from '../engine/core/beatmap/info';
import type { Rgb } from './model';

/**
 * The map's own colours (Info.dat): the lights' left, right and white, the same for the boost, and if
 * asked the notes' and the walls' — as the game's colour scheme of every difficulty (Info 2.1 / 4)
 * and, in a v2 Info, also as SongCore's colours of each difficulty (what older game versions and
 * other editors read). And colours to suggest for them: the cover's main colours (k-means), the two
 * that stand out most and are far enough apart in hue for left and right, the next ones for the boost.
 */

export interface MapColors {
  left: Rgb;
  right: Rgb;
  white: Rgb;
  leftBoost: Rgb;
  rightBoost: Rgb;
  whiteBoost: Rgb;
  /** The notes and walls changed too. */
  notes: boolean;
  leftNote: Rgb;
  rightNote: Rgb;
  obstacle: Rgb;
}

/** The name of the scheme the editor writes (found again by it). */
const SCHEME = 'ChroEditor';

export function schemeOf(colors: MapColors): InfoColorScheme {
  return {
    name: SCHEME,
    overrideNotes: colors.notes,
    leftNote: colors.leftNote,
    rightNote: colors.rightNote,
    obstacle: colors.obstacle,
    overrideLights: true,
    supportsEnvironmentColorBoost: true,
    environmentLeft: colors.left,
    environmentRight: colors.right,
    environmentWhite: colors.white,
    environmentLeftBoost: colors.leftBoost,
    environmentRightBoost: colors.rightBoost,
    environmentWhiteBoost: colors.whiteBoost,
  };
}

export function colorsOf(scheme: Pick<InfoColorScheme, 'environmentLeft' | 'environmentRight' | 'environmentWhite' | 'environmentLeftBoost' | 'environmentRightBoost' | 'environmentWhiteBoost' | 'leftNote' | 'rightNote' | 'obstacle'>, notes = false): MapColors {
  const white = scheme.environmentWhite ?? [0.7, 0.7, 0.7];
  return {
    left: [...scheme.environmentLeft],
    right: [...scheme.environmentRight],
    white: [...white],
    leftBoost: [...scheme.environmentLeftBoost],
    rightBoost: [...scheme.environmentRightBoost],
    whiteBoost: [...(scheme.environmentWhiteBoost ?? white)],
    notes,
    leftNote: [...scheme.leftNote],
    rightNote: [...scheme.rightNote],
    obstacle: [...scheme.obstacle],
  };
}

const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
const object = ([r, g, b]: Rgb, alpha = false) => ({ r: round(r), g: round(g), b: round(b), ...(alpha ? { a: 1 } : {}) });
const hex = ([r, g, b]: Rgb) => `#${[r, g, b, 1].map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const fromObject = (value: unknown): Rgb | undefined => {
  const item = value as { r?: unknown; g?: unknown; b?: unknown } | undefined;
  return typeof item?.r === 'number' && typeof item.g === 'number' && typeof item.b === 'number' ? [item.r, item.g, item.b] : undefined;
};
const fromHex = (value: unknown): Rgb | undefined => {
  const text = typeof value === 'string' ? value.replace(/^#/u, '') : '';
  return /^[0-9a-f]{6}([0-9a-f]{2})?$/iu.test(text) ? [0, 2, 4].map((at) => Number.parseInt(text.slice(at, at + 2), 16) / 255) as Rgb : undefined;
};

/** SongCore's colours of a v2 difficulty (`_customData`), lights first. */
const SONGCORE: [keyof MapColors, string][] = [
  ['left', '_envColorLeft'],
  ['right', '_envColorRight'],
  ['white', '_envColorWhite'],
  ['leftBoost', '_envColorLeftBoost'],
  ['rightBoost', '_envColorRightBoost'],
  ['whiteBoost', '_envColorWhiteBoost'],
  ['leftNote', '_colorLeft'],
  ['rightNote', '_colorRight'],
  ['obstacle', '_obstacleColor'],
];

type Json = Record<string, unknown>;

/** The map's colours as the editor wrote them (its scheme; else SongCore's of the first difficulty
 *  that has them). Null: none. */
export function readMapColors(text: string): MapColors | null {
  const info = JSON.parse(text) as Json;
  if (typeof info.version === 'string' && info.version.startsWith('4')) {
    const scheme = ((info.colorSchemes ?? []) as Json[]).find((item) => item.colorSchemeName === SCHEME);
    if (scheme === undefined) return null;
    const get = (key: string, fallback: Rgb) => fromHex(scheme[key]) ?? fallback;
    const left = get('environmentColor0', [1, 0, 0]);
    const right = get('environmentColor1', [0, 0, 1]);
    const white = get('environmentColorW', [0.7, 0.7, 0.7]);
    return { left, right, white, leftBoost: get('environmentColor0Boost', left), rightBoost: get('environmentColor1Boost', right), whiteBoost: get('environmentColorWBoost', white), notes: scheme.overrideNotes === true, leftNote: get('saberAColor', left), rightNote: get('saberBColor', right), obstacle: get('obstaclesColor', right) };
  }
  const scheme = ((info._colorSchemes ?? []) as Json[]).find((item) => (item.colorScheme as Json | undefined)?.colorSchemeId === SCHEME);
  if (scheme !== undefined) {
    const colors = scheme.colorScheme as Json;
    const get = (key: string, fallback: Rgb) => fromObject(colors[key]) ?? fallback;
    const left = get('environmentColor0', [1, 0, 0]);
    const right = get('environmentColor1', [0, 0, 1]);
    const white = get('environmentColorW', [0.7, 0.7, 0.7]);
    return { left, right, white, leftBoost: get('environmentColor0Boost', left), rightBoost: get('environmentColor1Boost', right), whiteBoost: get('environmentColorWBoost', white), notes: hasNoteColors(info), leftNote: get('saberAColor', left), rightNote: get('saberBColor', right), obstacle: get('obstaclesColor', right) };
  }
  for (const data of difficultyData(info)) {
    const left = fromObject(data._envColorLeft);
    const right = fromObject(data._envColorRight);
    if (left === undefined || right === undefined) continue;
    const white = fromObject(data._envColorWhite) ?? [0.7, 0.7, 0.7];
    return { left, right, white, leftBoost: fromObject(data._envColorLeftBoost) ?? left, rightBoost: fromObject(data._envColorRightBoost) ?? right, whiteBoost: fromObject(data._envColorWhiteBoost) ?? white, notes: fromObject(data._colorLeft) !== undefined, leftNote: fromObject(data._colorLeft) ?? left, rightNote: fromObject(data._colorRight) ?? right, obstacle: fromObject(data._obstacleColor) ?? right };
  }
  return null;
}

function difficultyData(info: Json): Json[] {
  return ((info._difficultyBeatmapSets ?? []) as Json[]).flatMap((set) => ((set._difficultyBeatmaps ?? []) as Json[]).map((difficulty) => (difficulty._customData ?? {}) as Json));
}

const hasNoteColors = (info: Json) => difficultyData(info).some((data) => data._colorLeft !== undefined);

/** Info.dat with the map's colours set (null: taken away — the environment's own again). */
export function writeMapColors(text: string, colors: MapColors | null): string {
  const info = JSON.parse(text) as Json;
  if (typeof info.version === 'string' && info.version.startsWith('4')) {
    const schemes = ((info.colorSchemes ?? []) as Json[]).slice();
    const at = schemes.findIndex((item) => item.colorSchemeName === SCHEME);
    const entries = (info.difficultyBeatmaps ?? []) as Json[];
    if (colors === null) {
      if (at >= 0) {
        schemes.splice(at, 1);
        for (const entry of entries) {
          const index = Number(entry.beatmapColorSchemeIdx ?? 0);
          if (index === at) entry.beatmapColorSchemeIdx = 0;
          else if (index > at) entry.beatmapColorSchemeIdx = index - 1;
        }
      }
    } else {
      const scheme: Json = {
        useOverride: true,
        colorSchemeName: SCHEME,
        overrideNotes: colors.notes,
        saberAColor: hex(colors.leftNote),
        saberBColor: hex(colors.rightNote),
        obstaclesColor: hex(colors.obstacle),
        overrideLights: true,
        environmentColor0: hex(colors.left),
        environmentColor1: hex(colors.right),
        environmentColorW: hex(colors.white),
        environmentColor0Boost: hex(colors.leftBoost),
        environmentColor1Boost: hex(colors.rightBoost),
        environmentColorWBoost: hex(colors.whiteBoost),
      };
      const index = at >= 0 ? at : schemes.length;
      schemes[index] = scheme;
      for (const entry of entries) entry.beatmapColorSchemeIdx = index;
    }
    info.colorSchemes = schemes;
    return JSON.stringify(info, null, 2);
  }
  // v2: the scheme where the Info has them (2.1), SongCore's colours on every difficulty
  const schemed = typeof info._version === 'string' && info._version !== '2.0.0' && Array.isArray(info._colorSchemes);
  const difficulties = ((info._difficultyBeatmapSets ?? []) as Json[]).flatMap((set) => (set._difficultyBeatmaps ?? []) as Json[]);
  if (schemed) {
    const schemes = (info._colorSchemes as Json[]).slice();
    const at = schemes.findIndex((item) => (item.colorScheme as Json | undefined)?.colorSchemeId === SCHEME);
    if (colors === null) {
      if (at >= 0) {
        schemes.splice(at, 1);
        for (const difficulty of difficulties) {
          const index = Number(difficulty._beatmapColorSchemeIdx ?? 0);
          if (index === at) difficulty._beatmapColorSchemeIdx = 0;
          else if (index > at) difficulty._beatmapColorSchemeIdx = index - 1;
        }
      }
    } else {
      const scheme: Json = {
        useOverride: true,
        colorScheme: {
          colorSchemeId: SCHEME,
          // (a v2 scheme changes the notes too: they keep theirs unless asked)
          saberAColor: object(colors.leftNote, true),
          saberBColor: object(colors.rightNote, true),
          obstaclesColor: object(colors.obstacle, true),
          environmentColor0: object(colors.left, true),
          environmentColor1: object(colors.right, true),
          environmentColorW: object(colors.white, true),
          environmentColor0Boost: object(colors.leftBoost, true),
          environmentColor1Boost: object(colors.rightBoost, true),
          environmentColorWBoost: object(colors.whiteBoost, true),
        },
      };
      const index = at >= 0 ? at : schemes.length;
      schemes[index] = scheme;
      for (const difficulty of difficulties) difficulty._beatmapColorSchemeIdx = index;
    }
    info._colorSchemes = schemes;
  }
  for (const difficulty of difficulties) {
    const data = { ...((difficulty._customData ?? {}) as Json) };
    for (const [, key] of SONGCORE) delete data[key];
    if (colors !== null) for (const [field, key] of SONGCORE.slice(0, colors.notes ? SONGCORE.length : 6)) data[key] = object(colors[field] as Rgb);
    if (Object.keys(data).length > 0) difficulty._customData = data;
    else delete difficulty._customData;
  }
  return JSON.stringify(info, null, 2);
}

// ----- colours from the cover ---------------------------------------------------------------------

export interface PaletteColor {
  rgb: Rgb;
  /** How much of the picture (0…1). */
  weight: number;
}

function hsv([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta + 6) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  return [hue * 60, max === 0 ? 0 : delta / max, max];
}

/** The main colours of a picture (RGBA bytes, as a canvas gives them): k-means over its pixels. */
export function paletteOf(pixels: Uint8ClampedArray | Uint8Array, count = 8): PaletteColor[] {
  const points: Rgb[] = [];
  const step = Math.max(1, Math.floor(pixels.length / 4 / 6000));
  for (let i = 0; i + 3 < pixels.length; i += 4 * step) if (pixels[i + 3]! > 128) points.push([pixels[i]! / 255, pixels[i + 1]! / 255, pixels[i + 2]! / 255]);
  if (points.length === 0) return [];
  const distance = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // (k-means++ start, without chance: each next centre the point farthest from the ones there are)
  const centres: Rgb[] = [points[Math.floor(points.length / 2)]!];
  const nearest = points.map((point) => distance(point, centres[0]!));
  while (centres.length < Math.min(count, points.length)) {
    let far = 0;
    for (let i = 1; i < points.length; i++) if (nearest[i]! > nearest[far]!) far = i;
    if (nearest[far]! === 0) break;
    centres.push([...points[far]!]);
    for (let i = 0; i < points.length; i++) nearest[i] = Math.min(nearest[i]!, distance(points[i]!, points[far]!));
  }
  const owner = new Int32Array(points.length);
  for (let round = 0; round < 12; round++) {
    points.forEach((point, index) => {
      let best = 0;
      for (let c = 1; c < centres.length; c++) if (distance(point, centres[c]!) < distance(point, centres[best]!)) best = c;
      owner[index] = best;
    });
    const sums = centres.map(() => [0, 0, 0, 0]);
    points.forEach((point, index) => {
      const sum = sums[owner[index]!]!;
      sum[0]! += point[0];
      sum[1]! += point[1];
      sum[2]! += point[2];
      sum[3]! += 1;
    });
    sums.forEach((sum, c) => {
      if (sum[3]! > 0) centres[c] = [sum[0]! / sum[3]!, sum[1]! / sum[3]!, sum[2]! / sum[3]!];
    });
  }
  const weights = centres.map(() => 0);
  for (let i = 0; i < points.length; i++) weights[owner[i]!]! += 1 / points.length;
  return centres.map((rgb, index) => ({ rgb, weight: weights[index]! })).filter((item) => item.weight > 0).sort((a, b) => b.weight - a.weight);
}

/** A colour made as bright as a light is (its brightest channel at 1), its hue and saturation kept. */
export const lit = (rgb: Rgb): Rgb => {
  const max = Math.max(...rgb);
  return max <= 0 ? [1, 1, 1] : (rgb.map((value) => round(value / max)) as Rgb);
};

const hueGap = (a: Rgb, b: Rgb) => {
  const gap = Math.abs(hsv(a)[0] - hsv(b)[0]) % 360;
  return Math.min(gap, 360 - gap);
};

/** A colour turned `degrees` round the hue circle (and its saturation made `saturation`). */
function turned(rgb: Rgb, degrees: number, saturation?: number): Rgb {
  const [h, own, v] = hsv(rgb);
  const s = saturation ?? own;
  const hue = (((h + degrees) % 360) + 360) % 360;
  const f = (n: number) => {
    const k = (n + hue / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [round(f(5)), round(f(3)), round(f(1))];
}

/**
 * Colours for the map from a palette: left and right the two of its colourful ones that stand out
 * most and are at least 45° apart in hue (`variant`: the next such pair, and so on), the boost the
 * pair after (or the left and right turned a little), white the palette's lightest pale colour.
 */
export function suggestColors(palette: readonly PaletteColor[], variant = 0, notes = false): MapColors {
  const colourful = palette.filter((item) => hsv(item.rgb)[1] >= 0.25 && hsv(item.rgb)[2] >= 0.2).map((item) => ({ ...item, score: item.weight * (0.4 + hsv(item.rgb)[1]) * (0.5 + hsv(item.rgb)[2]) }));
  const pairs: [Rgb, Rgb, number][] = [];
  for (let a = 0; a < colourful.length; a++)
    for (let b = 0; b < colourful.length; b++) {
      if (a === b) continue;
      const gap = hueGap(colourful[a]!.rgb, colourful[b]!.rgb);
      // (the warmer one left, as the game's own red left and blue right)
      if (gap >= 45 && warmth(colourful[a]!.rgb) >= warmth(colourful[b]!.rgb)) pairs.push([colourful[a]!.rgb, colourful[b]!.rgb, (colourful[a]!.score + colourful[b]!.score) * (0.6 + gap / 180)]);
    }
  pairs.sort((x, y) => y[2] - x[2]);
  let left: Rgb;
  let right: Rgb;
  let leftBoost: Rgb;
  let rightBoost: Rgb;
  if (pairs.length > 0) {
    const pair = pairs[variant % pairs.length]!;
    [left, right] = [vivid(pair[0]), vivid(pair[1])];
    const next = pairs.find((other) => hueGap(other[0], pair[0]) > 15 && hueGap(other[1], pair[1]) > 15);
    [leftBoost, rightBoost] = next !== undefined ? [vivid(next[0]), vivid(next[1])] : [turned(left, -25), turned(right, 25)];
  } else {
    // (one colour or none: it and its opposite)
    const base = colourful[variant % Math.max(1, colourful.length)]?.rgb ?? [1, 0.2, 0.2];
    left = vivid(base);
    right = turned(left, 180 + (variant % 3) * 30);
    leftBoost = turned(left, -30);
    rightBoost = turned(right, 30);
  }
  const pale = palette.filter((item) => hsv(item.rgb)[1] < 0.25 && hsv(item.rgb)[2] > 0.55).sort((a, b) => hsv(b.rgb)[2] - hsv(a.rgb)[2])[0];
  const white: Rgb = pale !== undefined ? lit(pale.rgb) : [1, 1, 1];
  return { left, right, white, leftBoost, rightBoost, whiteBoost: white, notes, leftNote: left, rightNote: right, obstacle: right };
}

/** A cover's colour as a light: bright, and a pale one made more saturated (pastel lights wash out). */
const vivid = (rgb: Rgb): Rgb => lit(turned(rgb, 0, Math.min(1, 0.5 + 0.5 * hsv(rgb)[1])));

/** Red, orange, yellow, magenta: warm (1); cyan, blue: cold (0). */
function warmth(rgb: Rgb) {
  const hue = hsv(rgb)[0];
  return Math.cos(((hue - 20) * Math.PI) / 180) * 0.5 + 0.5;
}
