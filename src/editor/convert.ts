/**
 * A whole map from one format to the other: v3 (Info 2.1, a difficulty file with everything in it)
 * ↔ v4 (Info 4, each difficulty's notes in one file and its lights in a lightshow file, the tempo in
 * an audio data file; objects' positions and lights' values kept once each and pointed to). Notes,
 * bombs, walls, arcs, chains, lane rotations, the tempo, the basic lights, boost and the group
 * lighting system (colour, rotation, translation, FX) go across; custom data (Chroma, Noodle) is
 * carried as it is — v4's mods read it as far as they do. What can't go is listed in the warnings.
 */

type Json = Record<string, unknown>;
type Version = '3' | '4';

export interface ConvertInput {
  infoName: string;
  /** Every text file of the map (Info.dat and the difficulties among them). */
  texts: Record<string, string>;
  /** The song: for v4's audio data (where the tempo changes are put in samples). */
  song: { sampleCount: number; frequency: number };
}

export interface ConvertResult {
  /** The files to write (the others are copied as they are). */
  files: Record<string, string>;
  /** Files of the old format not needed any more. */
  dropped: string[];
  warnings: string[];
}

const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const num = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const object = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const withCustom = (target: Json, custom: unknown) => {
  if (Object.keys(object(custom)).length > 0) target.customData = custom;
  return target;
};

/** Values kept once: the index of each (the same one for equal values). */
class Pool {
  readonly items: Json[] = [];
  private readonly known = new Map<string, number>();
  index(item: Json) {
    const key = JSON.stringify(item);
    let at = this.known.get(key);
    if (at === undefined) {
      at = this.items.length;
      this.items.push(item);
      this.known.set(key, at);
    }
    return at;
  }
}

export function mapVersion(infoText: string): Version | '2' {
  const info = JSON.parse(infoText) as Json;
  return typeof info.version === 'string' && info.version.startsWith('4') ? '4' : '3';
}

// ----- v3 → v4 --------------------------------------------------------------------------------------

function difficultyToV4(root: Json, warnings: string[], name: string): { beatmap: Json; lightshow: Json; bpm: Json[] } {
  const notes = new Pool();
  const bombs = new Pool();
  const walls = new Pool();
  const arcs = new Pool();
  const chains = new Pool();
  const rotations = new Pool();
  const beatmap: Json = { version: '4.0.0' };
  beatmap.colorNotes = list(root.colorNotes).map((note) => withCustom({ b: num(note.b), r: 0, i: notes.index({ x: num(note.x), y: num(note.y), c: num(note.c), d: num(note.d), a: num(note.a) }) }, note.customData));
  beatmap.bombNotes = list(root.bombNotes).map((bomb) => withCustom({ b: num(bomb.b), r: 0, i: bombs.index({ x: num(bomb.x), y: num(bomb.y) }) }, bomb.customData));
  beatmap.obstacles = list(root.obstacles).map((wall) => withCustom({ b: num(wall.b), r: 0, i: walls.index({ d: num(wall.d), x: num(wall.x), y: num(wall.y), w: num(wall.w), h: num(wall.h) }) }, wall.customData));
  beatmap.arcs = list(root.sliders).map((arc) =>
    withCustom(
      {
        hb: num(arc.b),
        tb: num(arc.tb),
        hr: 0,
        tr: 0,
        hi: notes.index({ x: num(arc.x), y: num(arc.y), c: num(arc.c), d: num(arc.d), a: 0 }),
        ti: notes.index({ x: num(arc.tx), y: num(arc.ty), c: num(arc.c), d: num(arc.tc), a: 0 }),
        ai: arcs.index({ m: num(arc.mu), tm: num(arc.tmu), a: num(arc.m) }),
      },
      arc.customData,
    ),
  );
  beatmap.chains = list(root.burstSliders).map((chain) =>
    withCustom(
      {
        hb: num(chain.b),
        tb: num(chain.tb),
        hr: 0,
        tr: 0,
        i: notes.index({ x: num(chain.x), y: num(chain.y), c: num(chain.c), d: num(chain.d), a: 0 }),
        ci: chains.index({ tx: num(chain.tx), ty: num(chain.ty), c: num(chain.sc), s: num(chain.s, 1) }),
      },
      chain.customData,
    ),
  );
  beatmap.spawnRotations = list(root.rotationEvents).map((event) => ({ b: num(event.b), i: rotations.index({ t: num(event.e), r: num(event.r) }) }));
  beatmap.colorNotesData = notes.items;
  beatmap.bombNotesData = bombs.items;
  beatmap.obstaclesData = walls.items;
  beatmap.arcsData = arcs.items;
  beatmap.chainsData = chains.items;
  beatmap.spawnRotationsData = rotations.items;
  beatmap.njsEvents = [];
  beatmap.njsEventData = [];
  const custom = object(root.customData);
  if (Object.keys(custom).length > 0) beatmap.customData = custom;

  // the lights
  const events = new Pool();
  const boosts = new Pool();
  const waypoints = new Pool();
  const lightshow: Json = { version: '4.0.0' };
  lightshow.waypoints = list(root.waypoints).map((point) => ({ b: num(point.b), i: waypoints.index({ x: num(point.x), y: num(point.y), d: num(point.d) }) }));
  lightshow.waypointsData = waypoints.items;
  lightshow.basicEvents = list(root.basicBeatmapEvents).map((event) => withCustom({ b: num(event.b), i: events.index({ t: num(event.et), i: num(event.i), f: num(event.f, 1) }) }, event.customData));
  lightshow.basicEventsData = events.items;
  lightshow.colorBoostEvents = list(root.colorBoostBeatmapEvents).map((event) => ({ b: num(event.b), i: boosts.index({ b: event.o === true ? 1 : 0 }) }));
  lightshow.colorBoostEventsData = boosts.items;
  Object.assign(lightshow, glsToV4(root, warnings, name));
  lightshow.basicEventTypesWithKeywords = object(root.basicEventTypesWithKeywords).d !== undefined ? root.basicEventTypesWithKeywords : { d: [] };
  lightshow.useNormalEventsAsCompatibleEvents = root.useNormalEventsAsCompatibleEvents !== false;
  return { beatmap, lightshow, bpm: list(root.bpmEvents) };
}

/** The group lighting system: v3's groups with everything in them → v4's groups pointing to boxes,
 *  filters and events kept once each. */
function glsToV4(root: Json, warnings: string[], name: string): Json {
  const filters = new Pool();
  const pools = { color: new Pool(), colorEvents: new Pool(), rotation: new Pool(), rotationEvents: new Pool(), translation: new Pool(), translationEvents: new Pool(), fx: new Pool(), fxEvents: new Pool() };
  const groups: Json[] = [];
  const filter = (box: Json) => {
    const f = object(box.f);
    return filters.index({ f: num(f.f), p: num(f.p), t: num(f.t), r: num(f.r), c: num(f.c), n: num(f.n), s: num(f.s), l: num(f.l), d: num(f.d) });
  };
  let eased = false;
  for (const group of list(root.lightColorEventBoxGroups)) {
    groups.push(
      withCustom(
        {
          b: num(group.b),
          g: num(group.g),
          t: 1,
          e: list(group.e).map((box) => ({
            f: filter(box),
            e: pools.color.index({ w: num(box.w), d: num(box.d, 1), s: num(box.r), t: num(box.t, 1), b: num(box.b), e: num(box.i), a: 0, f: 0 }),
            l: list(box.e).map((event) => {
              if (event.customData !== undefined) eased = true;
              const transition = num(event.i);
              return { b: num(event.b), i: pools.colorEvents.index({ c: num(event.c), b: num(event.s), e: transition === 0 ? -1 : 0, p: transition === 2 ? 1 : 0, f: num(event.f), sb: num(event.sb), sf: num(event.sf) }) };
            }),
          })),
        },
        group.customData,
      ),
    );
  }
  for (const [key, type, events] of [['lightRotationEventBoxGroups', 2, 'rotation'], ['lightTranslationEventBoxGroups', 3, 'translation']] as const) {
    for (const group of list(root[key])) {
      groups.push(
        withCustom(
          {
            b: num(group.b),
            g: num(group.g),
            t: type,
            e: list(group.e).map((box) => ({
              f: filter(box),
              e: pools[events].index({ w: num(box.w), d: num(box.d, 1), s: num(box.s), t: num(box.t, 1), b: num(box.b), e: num(box.i), a: num(box.a), f: num(box.r) }),
              l: list(box.l).map((event) => {
                if (event.customData !== undefined) eased = true;
                const data = type === 2 ? { r: num(event.r), d: num(event.o), e: num(event.e), l: num(event.l), p: num(event.p) } : { t: num(event.t), e: num(event.e), p: num(event.p) };
                return { b: num(event.b), i: pools[type === 2 ? 'rotationEvents' : 'translationEvents'].index(data) };
              }),
            })),
          },
          group.customData,
        ),
      );
    }
  }
  const floats = list(object(root._fxEventsCollection)._fl);
  for (const group of list(root.vfxEventBoxGroups)) {
    groups.push(
      withCustom(
        {
          b: num(group.b),
          g: num(group.g),
          t: 4,
          e: list(group.e).map((box) => ({
            f: filter(box),
            e: pools.fx.index({ w: num(box.w), d: num(box.d, 1), s: num(box.s), t: num(box.t, 1), b: num(box.b), e: num(box.i), a: 0, f: 0 }),
            l: (Array.isArray(box.l) ? (box.l as number[]) : []).flatMap((index) => {
              const event = floats[index];
              return event === undefined ? [] : [{ b: num(event.b), i: pools.fxEvents.index({ v: num(event.v), e: num(event.i), p: num(event.p) }) }];
            }),
          })),
        },
        group.customData,
      ),
    );
  }
  if (eased) warnings.push(`${name}: у событий групп света была своя custom data — в v4 ей места нет, она не перенесена`);
  groups.sort((a, b) => num(a.b) - num(b.b));
  return {
    eventBoxGroups: groups,
    indexFilters: filters.items,
    lightColorEventBoxes: pools.color.items,
    lightColorEvents: pools.colorEvents.items,
    lightRotationEventBoxes: pools.rotation.items,
    lightRotationEvents: pools.rotationEvents.items,
    lightTranslationEventBoxes: pools.translation.items,
    lightTranslationEvents: pools.translationEvents.items,
    fxEventBoxes: pools.fx.items,
    floatFxEvents: pools.fxEvents.items,
  };
}

/** The tempo as v4 keeps it: stretches of the song in samples and the beats they span. */
function audioData(bpm: number, changes: Json[], song: ConvertInput['song']): Json {
  const points = [{ b: 0, m: bpm }, ...changes.map((event) => ({ b: num(event.b), m: num(event.m, bpm) })).filter((event) => event.m > 0)].sort((a, b) => a.b - b.b);
  // (a change at beat 0 replaces the Info's tempo)
  const marks = points.filter((point, index) => !(point.b === points[index + 1]?.b));
  const regions: Json[] = [];
  let seconds = 0;
  marks.forEach((mark, index) => {
    const next = marks[index + 1];
    const start = Math.round(seconds * song.frequency);
    if (next === undefined) {
      const end = Math.max(start + 1, song.sampleCount);
      regions.push({ si: start, ei: end, sb: mark.b, eb: mark.b + ((end - start) / song.frequency) * (mark.m / 60) });
    } else {
      seconds += ((next.b - mark.b) * 60) / mark.m;
      regions.push({ si: start, ei: Math.round(seconds * song.frequency), sb: mark.b, eb: next.b });
    }
  });
  return { version: '4.0.0', songChecksum: '', songSampleCount: song.sampleCount, songFrequency: song.frequency, bpmData: regions, lufsData: [] };
}

const unprefixed = (data: Json) => Object.fromEntries(Object.entries(data).map(([key, value]) => [key.replace(/^_/u, ''), value]));
const prefixed = (data: Json) => Object.fromEntries(Object.entries(data).map(([key, value]) => [key.startsWith('_') ? key : `_${key}`, value]));
const toHex = (value: unknown) => {
  const color = object(value);
  return `#${[color.r, color.g, color.b, color.a ?? 1].map((channel) => Math.round(Math.min(1, Math.max(0, num(channel))) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
};
const fromHex = (value: unknown) => {
  const text = typeof value === 'string' ? value.replace(/^#/u, '') : '';
  const part = (at: number, fallback = 0) => (/^[0-9a-f]{2}$/iu.test(text.slice(at, at + 2)) ? Math.round((Number.parseInt(text.slice(at, at + 2), 16) / 255) * 10000) / 10000 : fallback);
  return { r: part(0), g: part(2), b: part(4), a: part(6, 1) };
};
const SCHEME_COLORS = ['saberAColor', 'saberBColor', 'obstaclesColor', 'environmentColor0', 'environmentColor1', 'environmentColorW', 'environmentColor0Boost', 'environmentColor1Boost', 'environmentColorWBoost'];

function toV4(input: ConvertInput): ConvertResult {
  const info = JSON.parse(input.texts[input.infoName]!) as Json;
  const warnings: string[] = [];
  const files: Record<string, string> = {};
  const bpm = num(info._beatsPerMinute, 120);
  if (num(info._songTimeOffset) !== 0) warnings.push('У карты есть _songTimeOffset — в v4 его нет, песня будет начинаться без него');
  const mappers = typeof info._levelAuthorName === 'string' && info._levelAuthorName !== '' ? [info._levelAuthorName] : [];
  const environmentNames = list(info._environmentNames).length > 0 ? [...(info._environmentNames as unknown as string[])] : [String(info._environmentName ?? 'DefaultEnvironment')];
  const environmentIndex = (name: string) => {
    let at = environmentNames.indexOf(name);
    if (at < 0) {
      environmentNames.push(name);
      at = environmentNames.length - 1;
    }
    return at;
  };
  let changes: Json[] | null = null;
  const entries: Json[] = [];
  for (const set of list(info._difficultyBeatmapSets)) {
    const characteristic = String(set._beatmapCharacteristicName ?? 'Standard');
    for (const difficulty of list(set._difficultyBeatmaps)) {
      const file = String(difficulty._beatmapFilename ?? '');
      const text = input.texts[file];
      if (text === undefined) {
        warnings.push(`${file}: нет такого файла — сложность пропущена`);
        continue;
      }
      const root = JSON.parse(text) as Json;
      const version = typeof root.version === 'string' ? root.version : String(root._version ?? '2');
      if (!version.startsWith('3')) {
        warnings.push(`${file}: формат v${version.slice(0, 1)} — переводятся только v3, сложность пропущена`);
        continue;
      }
      const made = difficultyToV4(root, warnings, file);
      const lightshowName = file.replace(/\.dat$/iu, '') + '.lightshow.dat';
      files[file] = JSON.stringify(made.beatmap);
      files[lightshowName] = JSON.stringify(made.lightshow);
      if (changes === null) changes = made.bpm;
      else if (JSON.stringify(changes) !== JSON.stringify(made.bpm)) warnings.push(`${file}: смены темпа не такие, как в других сложностях — в v4 темп один на карту, взят из первой`);
      const allDirections = characteristic === '360Degree' || characteristic === '90Degree';
      const ownIndex = num(difficulty._environmentNameIdx, -1);
      const environment = list(info._environmentNames).length > 0 && ownIndex >= 0 ? (environmentNames[ownIndex] ?? environmentNames[0]!) : String((allDirections ? info._allDirectionsEnvironmentName : info._environmentName) ?? 'DefaultEnvironment');
      const custom = unprefixed(object(difficulty._customData));
      entries.push({
        characteristic,
        difficulty: String(difficulty._difficulty ?? 'Expert'),
        beatmapAuthors: { mappers, lighters: [] },
        environmentNameIdx: environmentIndex(environment),
        beatmapColorSchemeIdx: num(difficulty._beatmapColorSchemeIdx),
        noteJumpMovementSpeed: num(difficulty._noteJumpMovementSpeed),
        noteJumpStartBeatOffset: num(difficulty._noteJumpStartBeatOffset),
        lightshowDataFilename: lightshowName,
        beatmapDataFilename: file,
        ...(Object.keys(custom).length > 0 ? { customData: custom } : {}),
      });
    }
  }
  files['BPMInfo.dat'] = JSON.stringify(audioData(bpm, changes ?? [], input.song));
  const song = String(info._songFilename ?? 'song.ogg');
  const v4: Json = {
    version: '4.0.1',
    song: { title: info._songName ?? '', subTitle: info._songSubName ?? '', author: info._songAuthorName ?? '' },
    audio: { songFilename: song, songDuration: Math.round((input.song.sampleCount / input.song.frequency) * 1000) / 1000, audioDataFilename: 'BPMInfo.dat', bpm, lufs: 0, previewStartTime: num(info._previewStartTime), previewDuration: num(info._previewDuration, 10) },
    songPreviewFilename: song,
    coverImageFilename: info._coverImageFilename ?? '',
    environmentNames,
    colorSchemes: list(info._colorSchemes).map((entry) => {
      const scheme = object(entry.colorScheme);
      return {
        useOverride: entry.useOverride === true,
        colorSchemeName: scheme.colorSchemeId ?? '',
        overrideNotes: entry.useOverride === true,
        overrideLights: entry.useOverride === true,
        ...Object.fromEntries(SCHEME_COLORS.filter((key) => scheme[key] !== undefined).map((key) => [key, toHex(scheme[key])])),
      };
    }),
    difficultyBeatmaps: entries,
  };
  const custom = unprefixed(object(info._customData));
  if (Object.keys(custom).length > 0) v4.customData = custom;
  files[input.infoName] = JSON.stringify(v4, null, 2);
  return { files, dropped: [], warnings };
}

// ----- v4 → v3 --------------------------------------------------------------------------------------

function difficultyToV3(beatmap: Json, lightshow: Json | null, bpmEvents: Json[], warnings: string[], name: string): Json {
  const data = (key: string) => list(beatmap[key]);
  const notes = data('colorNotesData');
  const bombs = data('bombNotesData');
  const walls = data('obstaclesData');
  const arcs = data('arcsData');
  const chains = data('chainsData');
  const rotations = data('spawnRotationsData');
  let lanes = false;
  const lane = (value: unknown) => {
    if (num(value) !== 0) lanes = true;
  };
  const root: Json = { version: '3.3.0', bpmEvents };
  root.rotationEvents = list(beatmap.spawnRotations).flatMap((event) => {
    const item = rotations[num(event.i)];
    return item === undefined ? [] : [{ b: num(event.b), e: num(item.t), r: num(item.r) }];
  });
  root.colorNotes = list(beatmap.colorNotes).flatMap((note) => {
    const item = notes[num(note.i)];
    lane(note.r);
    return item === undefined ? [] : [withCustom({ b: num(note.b), x: num(item.x), y: num(item.y), a: num(item.a), c: num(item.c), d: num(item.d) }, note.customData)];
  });
  root.bombNotes = list(beatmap.bombNotes).flatMap((bomb) => {
    const item = bombs[num(bomb.i)];
    lane(bomb.r);
    return item === undefined ? [] : [withCustom({ b: num(bomb.b), x: num(item.x), y: num(item.y) }, bomb.customData)];
  });
  root.obstacles = list(beatmap.obstacles).flatMap((wall) => {
    const item = walls[num(wall.i)];
    lane(wall.r);
    return item === undefined ? [] : [withCustom({ b: num(wall.b), x: num(item.x), y: num(item.y), d: num(item.d), w: num(item.w), h: num(item.h) }, wall.customData)];
  });
  root.sliders = list(beatmap.arcs).flatMap((arc) => {
    const head = notes[num(arc.hi)];
    const tail = notes[num(arc.ti)];
    const item = arcs[num(arc.ai)];
    lane(arc.hr);
    if (head === undefined || tail === undefined || item === undefined) return [];
    return [withCustom({ c: num(head.c), b: num(arc.hb), x: num(head.x), y: num(head.y), d: num(head.d), mu: num(item.m), tb: num(arc.tb), tx: num(tail.x), ty: num(tail.y), tc: num(tail.d), tmu: num(item.tm), m: num(item.a) }, arc.customData)];
  });
  root.burstSliders = list(beatmap.chains).flatMap((chain) => {
    const head = notes[num(chain.i)];
    const item = chains[num(chain.ci)];
    lane(chain.hr);
    if (head === undefined || item === undefined) return [];
    return [withCustom({ c: num(head.c), b: num(chain.hb), x: num(head.x), y: num(head.y), d: num(head.d), tb: num(chain.tb), tx: num(item.tx), ty: num(item.ty), sc: num(item.c), s: num(item.s, 1) }, chain.customData)];
  });
  if (lanes) warnings.push(`${name}: у объектов были свои дорожки поворота (r) — в v3 их нет, повороты остались только событиями`);
  if (list(beatmap.njsEvents).length > 0) warnings.push(`${name}: события скорости нот (NJS) есть только в v4 — не перенесены`);
  const show = lightshow ?? {};
  const waypoints = list(show.waypointsData);
  root.waypoints = list(show.waypoints).flatMap((point) => {
    const item = waypoints[num(point.i)];
    return item === undefined ? [] : [{ b: num(point.b), x: num(item.x), y: num(item.y), d: num(item.d) }];
  });
  const basic = list(show.basicEventsData);
  root.basicBeatmapEvents = list(show.basicEvents).flatMap((event) => {
    const item = basic[num(event.i)];
    return item === undefined ? [] : [withCustom({ b: num(event.b), et: num(item.t), i: num(item.i), f: num(item.f, 1) }, event.customData)];
  });
  const boosts = list(show.colorBoostEventsData);
  root.colorBoostBeatmapEvents = list(show.colorBoostEvents).flatMap((event) => {
    const item = boosts[num(event.i)];
    return item === undefined ? [] : [{ b: num(event.b), o: num(item.b) === 1 }];
  });
  Object.assign(root, glsToV3(show, warnings, name));
  root.basicEventTypesWithKeywords = object(show.basicEventTypesWithKeywords).d !== undefined ? show.basicEventTypesWithKeywords : { d: [] };
  root.useNormalEventsAsCompatibleEvents = show.useNormalEventsAsCompatibleEvents !== false;
  const custom = { ...object(show.customData), ...object(beatmap.customData) };
  if (Object.keys(custom).length > 0) root.customData = custom;
  return root;
}

function glsToV3(show: Json, warnings: string[], name: string): Json {
  const filters = list(show.indexFilters);
  const boxData = { 1: list(show.lightColorEventBoxes), 2: list(show.lightRotationEventBoxes), 3: list(show.lightTranslationEventBoxes), 4: list(show.fxEventBoxes) } as Record<number, Json[]>;
  const out: Json = { lightColorEventBoxGroups: [], lightRotationEventBoxGroups: [], lightTranslationEventBoxGroups: [], vfxEventBoxGroups: [], _fxEventsCollection: { _fl: [], _il: [] } };
  const floats: Json[] = [];
  let easings = false;
  for (const group of list(show.eventBoxGroups)) {
    const type = num(group.t);
    const boxes = list(group.e).flatMap((box): Json[] => {
      const filter = filters[num(box.f)];
      const data = boxData[type]?.[num(box.e)];
      if (filter === undefined || data === undefined) return [];
      const events = list(box.l);
      const base = { f: { ...filter }, w: num(data.w), d: num(data.d, 1), t: num(data.t, 1), b: num(data.b), i: num(data.e) };
      if (type === 1) {
        const colors = list(show.lightColorEvents);
        return [
          {
            ...base,
            r: num(data.s),
            e: events.flatMap((event) => {
              const item = colors[num(event.i)];
              if (item === undefined) return [];
              if (num(item.e) > 0) easings = true;
              return [{ b: num(event.b), i: num(item.p) === 1 ? 2 : num(item.e) === -1 ? 0 : 1, c: num(item.c), s: num(item.b), f: num(item.f), sb: num(item.sb), sf: num(item.sf) }];
            }),
          },
        ];
      }
      if (type === 2 || type === 3) {
        const items = list(type === 2 ? show.lightRotationEvents : show.lightTranslationEvents);
        return [
          {
            ...base,
            s: num(data.s),
            a: num(data.a),
            r: num(data.f),
            l: events.flatMap((event) => {
              const item = items[num(event.i)];
              if (item === undefined) return [];
              return [type === 2 ? { b: num(event.b), p: num(item.p), e: num(item.e), l: num(item.l), r: num(item.r), o: num(item.d) } : { b: num(event.b), p: num(item.p), e: num(item.e), t: num(item.t) }];
            }),
          },
        ];
      }
      if (type === 4) {
        const items = list(show.floatFxEvents);
        return [
          {
            ...base,
            s: num(data.s),
            l: events.flatMap((event) => {
              const item = items[num(event.i)];
              if (item === undefined) return [];
              floats.push({ b: num(event.b), p: num(item.p), i: num(item.e), v: num(item.v) });
              return [floats.length - 1];
            }),
          },
        ];
      }
      return [];
    });
    const made = withCustom({ b: num(group.b), g: num(group.g), e: boxes }, group.customData);
    const key = type === 1 ? 'lightColorEventBoxGroups' : type === 2 ? 'lightRotationEventBoxGroups' : type === 3 ? 'lightTranslationEventBoxGroups' : type === 4 ? 'vfxEventBoxGroups' : null;
    if (key === null) continue;
    if (type === 4) made.t = 0;
    (out[key] as Json[]).push(made);
  }
  (out._fxEventsCollection as Json)._fl = floats;
  if (easings) warnings.push(`${name}: у переходов цвета групп света были кривые (easing) — в v3 переход только линейный`);
  return out;
}

function toV3(input: ConvertInput): ConvertResult {
  const info = JSON.parse(input.texts[input.infoName]!) as Json;
  const warnings: string[] = [];
  const files: Record<string, string> = {};
  const dropped = new Set<string>();
  const audio = object(info.audio);
  const bpm = num(audio.bpm, 120);
  // the tempo: back to changes of it (from the audio data's stretches)
  let bpmEvents: Json[] = [];
  const audioName = String(audio.audioDataFilename ?? '');
  const audioText = input.texts[audioName];
  if (audioText !== undefined) {
    dropped.add(audioName);
    const data = JSON.parse(audioText) as Json;
    const frequency = num(data.songFrequency, 44100);
    const regions = list(data.bpmData);
    bpmEvents = regions.map((region) => {
      const samples = num(region.ei) - num(region.si);
      const beats = num(region.eb) - num(region.sb);
      const raw = samples > 0 ? (beats / samples) * frequency * 60 : bpm;
      const rounded = Math.round(raw * 1000) / 1000;
      return { b: num(region.sb), m: Math.abs(Math.round(raw) - raw) < 0.01 ? Math.round(raw) : rounded };
    });
    if (bpmEvents.length === 1 && Math.abs(num(bpmEvents[0]!.m) - bpm) < 0.01 && num(bpmEvents[0]!.b) === 0) bpmEvents = [];
  }
  const environmentNames = list(info.environmentNames) as unknown as string[];
  const sets = new Map<string, Json[]>();
  const mappers = new Set<string>();
  for (const entry of list(info.difficultyBeatmaps)) {
    const file = String(entry.beatmapDataFilename ?? '');
    const text = input.texts[file];
    if (text === undefined) {
      warnings.push(`${file}: нет такого файла — сложность пропущена`);
      continue;
    }
    const lightshowName = String(entry.lightshowDataFilename ?? '');
    const lightshowText = input.texts[lightshowName];
    if (lightshowName !== '' && lightshowText === undefined) warnings.push(`${file}: нет файла света ${lightshowName}`);
    if (lightshowText !== undefined && lightshowName !== file) dropped.add(lightshowName);
    files[file] = JSON.stringify(difficultyToV3(JSON.parse(text) as Json, lightshowText === undefined ? null : (JSON.parse(lightshowText) as Json), bpmEvents, warnings, file));
    for (const mapper of list(object(entry.beatmapAuthors).mappers) as unknown as string[]) mappers.add(mapper);
    const custom = prefixed(object(entry.customData));
    const characteristic = String(entry.characteristic ?? 'Standard');
    const difficulty = String(entry.difficulty ?? 'Expert');
    sets.set(characteristic, [
      ...(sets.get(characteristic) ?? []),
      {
        _difficulty: difficulty,
        _difficultyRank: { Easy: 1, Normal: 3, Hard: 5, Expert: 7, ExpertPlus: 9 }[difficulty] ?? 7,
        _beatmapFilename: file,
        _noteJumpMovementSpeed: num(entry.noteJumpMovementSpeed),
        _noteJumpStartBeatOffset: num(entry.noteJumpStartBeatOffset),
        _beatmapColorSchemeIdx: num(entry.beatmapColorSchemeIdx),
        _environmentNameIdx: num(entry.environmentNameIdx),
        ...(Object.keys(custom).length > 0 ? { _customData: custom } : {}),
      },
    ]);
  }
  for (const set of sets.values()) set.sort((a, b) => num(a._difficultyRank) - num(b._difficultyRank));
  // (the environment of the first standard difficulty is the map's; others by their index)
  const firstStandard = list(info.difficultyBeatmaps).find((entry) => entry.characteristic !== '360Degree' && entry.characteristic !== '90Degree');
  const firstRotating = list(info.difficultyBeatmaps).find((entry) => entry.characteristic === '360Degree' || entry.characteristic === '90Degree');
  const v2: Json = {
    _version: '2.1.0',
    _songName: object(info.song).title ?? '',
    _songSubName: object(info.song).subTitle ?? '',
    _songAuthorName: object(info.song).author ?? '',
    _levelAuthorName: [...mappers].join(', '),
    _beatsPerMinute: bpm,
    _shuffle: 0,
    _shufflePeriod: 0.5,
    _previewStartTime: num(audio.previewStartTime),
    _previewDuration: num(audio.previewDuration, 10),
    _songFilename: audio.songFilename ?? 'song.ogg',
    _coverImageFilename: info.coverImageFilename ?? '',
    _environmentName: environmentNames[num(firstStandard?.environmentNameIdx)] ?? 'DefaultEnvironment',
    _allDirectionsEnvironmentName: firstRotating === undefined ? 'GlassDesertEnvironment' : (environmentNames[num(firstRotating.environmentNameIdx)] ?? 'GlassDesertEnvironment'),
    _songTimeOffset: 0,
    _environmentNames: environmentNames,
    _colorSchemes: list(info.colorSchemes).map((scheme) => ({
      useOverride: scheme.useOverride === true,
      colorScheme: { colorSchemeId: scheme.colorSchemeName ?? '', ...Object.fromEntries(SCHEME_COLORS.filter((key) => scheme[key] !== undefined).map((key) => [key, fromHex(scheme[key])])) },
    })),
    _difficultyBeatmapSets: [...sets].map(([characteristic, difficulties]) => ({ _beatmapCharacteristicName: characteristic, _difficultyBeatmaps: difficulties })),
  };
  const custom = prefixed(object(info.customData));
  if (Object.keys(custom).length > 0) v2._customData = custom;
  if (typeof info.songPreviewFilename === 'string' && info.songPreviewFilename !== '' && info.songPreviewFilename !== audio.songFilename) warnings.push(`Отдельный файл превью (${info.songPreviewFilename}) в v3 не используется`);
  files[input.infoName] = JSON.stringify(v2, null, 2);
  return { files, dropped: [...dropped].filter((name) => files[name] === undefined), warnings };
}

/** The map in the other format (`to`). */
export function convertMap(input: ConvertInput, to: Version): ConvertResult {
  return to === '4' ? toV4(input) : toV3(input);
}
