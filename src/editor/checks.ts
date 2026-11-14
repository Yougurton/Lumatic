import { wallKindOf, type MapNote, type MapObjects, type MapWall } from './notes';

/**
 * What's wrong with a difficulty's notes, bombs, walls, arcs and chains — after BSMG's mapping guide
 * and glossary (bsmg.wiki/mapping), BeatLeader's ranking criteria and ScoreSaber's mapping criteria and
 * technical limitations. Each rule can be switched off in the settings. Errors: what breaks the map or
 * keeps it from being ranked; warnings: what's uncomfortable or risky to play; a note: worth a look.
 */

export type IssueLevel = 'error' | 'warn' | 'info';

export interface MapIssue {
  rule: string;
  level: IssueLevel;
  /** Where (map beat) — the timeline and the list go there. */
  beat: number;
  /** The objects at fault (selected when the issue is clicked). */
  ids: string[];
  text: string;
  /** Stays the same from session to session while the issue does (for ignoring it). */
  key: string;
}

export interface CheckRule {
  id: string;
  name: string;
  /** Whose rule it is. */
  source: string;
  group: 'notes' | 'bombs' | 'walls' | 'arcs' | 'timing' | 'situational';
  about: string;
}

export const CHECK_RULES: CheckRule[] = [
  { id: 'stacked', name: 'Merged objects', source: 'BSMG · BL · SS', group: 'notes', about: 'Две ноты или нота и бомба в одной клетке в одно время' },
  { id: 'handclap', name: 'Handclap', source: 'BSMG · BL', group: 'notes', about: 'Красная и синяя ноты в одно время направляют руки навстречу друг другу (controller clash)' },
  { id: 'parallel', name: 'Parallel notes', source: 'BL · SS', group: 'notes', about: 'Ноты одного цвета в один swing стоят рядом поперёк замаха, а не по его линии' },
  { id: 'sameSwingAngle', name: 'Cut direction в одном swing', source: 'BL · SS', group: 'notes', about: 'Стрелки нот одного цвета в одно время расходятся больше чем на 45°' },
  { id: 'preSwing', name: 'Pre-swing path', source: 'BL · SS', group: 'notes', about: 'Нота стоит в pre-swing (замахе) сабли другого цвета' },
  { id: 'postSwing', name: 'Hitbox abuse', source: 'BSMG · SS', group: 'notes', about: 'Сразу после удара в его follow-through стоит нота другого цвета' },
  { id: 'doubleDirectional', name: 'Double directional (DD)', source: 'BSMG · SS', group: 'notes', about: 'Две ноты одного цвета подряд в одну сторону без bomb reset: ближе 1,5 доли — ошибка, дальше — предупреждение' },
  { id: 'visionBlock', name: 'Vision block (VB)', source: 'BSMG · BL', group: 'notes', about: 'Нота в центре среднего ряда закрывает свою половину сетки (левая — левую, правая — правую) на половину прыжка' },
  { id: 'angleOffset', name: 'Angle offset', source: 'SS', group: 'notes', about: 'У arrow-нот angle offset должен быть 0, у dot-нот — кратен 45°' },
  { id: 'sliderSpacing', name: 'Неровный slider', source: 'BL', group: 'notes', about: 'В slider из 3+ нот промежутки между нотами разные' },
  { id: 'fastStream', name: 'EBPM выше 350', source: 'SS', group: 'notes', about: 'Удары одной рукой быстрее 350 EBPM дольше 8 долей (или быстрее 425)' },
  { id: 'hammerHit', name: 'Hammer hit', source: 'BSMG · BL · SS', group: 'bombs', about: 'Arrow-нота указывает на бомбу рядом, или бомба стоит в pre-swing' },
  { id: 'bombSpacing', name: 'Бомбы слишком часто', source: 'BL · SS', group: 'bombs', about: 'Бомбы в одной клетке ближе 20 мс (SS) или 30 мс (BL)' },
  { id: 'inWall', name: 'Нота в стене', source: 'BL · SS', group: 'walls', about: 'Нота или бомба внутри стены' },
  { id: 'wallShape', name: 'Неправильная стена', source: 'BL · SS', group: 'walls', about: 'Нулевая ширина (fake wall), короче 15 мс (BL: 13,8 мс), не полная и не crouch, выходит за сетку' },
  { id: 'dangerDash', name: 'Danger dash', source: 'BSMG · SS', group: 'walls', about: 'Полные стены закрывают обе средние дорожки — выгоняют игрока на край (3-wide wall)' },
  { id: 'rapidDodge', name: 'Rapid dodge walls', source: 'BSMG · BL', group: 'walls', about: 'Dodge walls заставляют двигать голову больше 3 раз в секунду' },
  { id: 'arcs', name: 'Arcs', source: 'SS', group: 'arcs', about: 'Arc не связана с нотой; multiplier вне 0,1–1,5' },
  { id: 'chains', name: 'Chains', source: 'SS', group: 'arcs', about: 'ScoreSaber не ранкает карты с chains' },
  { id: 'hotStart', name: 'Hot start', source: 'BSMG · BL · SS', group: 'timing', about: 'Первые объекты раньше 1,5 с (SS), 1,33 с (BL) или 2 с (BSMG)' },
  { id: 'coldEnd', name: 'Cold end', source: 'BL · SS', group: 'timing', about: 'После последнего объекта меньше 2 с песни' },
  { id: 'longOutro', name: 'Долгий outro', source: 'SS', group: 'timing', about: 'После последнего объекта больше 15 с без нот (если там нет света)' },
  { id: 'mapLength', name: 'Длина карты', source: 'BL · SS', group: 'timing', about: 'Короче 45 с от первой ноты до последней (BL); песня короче 20 с или длиннее 10 минут (SS)' },
  { id: 'cross', name: 'Cross', source: 'BSMG', group: 'notes', about: 'Скрещённые руки бьют навстречу друг другу (X): handclap со скрещёнными руками' },
  { id: 'disembodied', name: 'Disembodied notes', source: 'BSMG', group: 'walls', about: 'Нота спрятана за стеной: стена в её клетке кончается прямо перед ней' },
  { id: 'bombWall', name: 'Bomb wall', source: 'BSMG', group: 'bombs', about: 'Бомбы в одно время закрывают почти всю сетку (9+ клеток из 12)' },
  { id: 'bombSpam', name: 'Bomb spam', source: 'BSMG', group: 'bombs', about: 'Слишком много бомб: больше 24 за 4 доли' },
  { id: 'widePrecision', name: 'Wide precision', source: 'BSMG', group: 'bombs', about: 'Двойной удар по краям с бомбами в середине: руки идут внутрь и задевают бомбы' },
  { id: 'incorrectSide', name: 'Incorrect side hits', source: 'BSMG', group: 'situational', about: 'Двойной crossover вбок: при ударе влево красная должна быть сверху, вправо — синяя' },
  { id: 'rapidCrossover', name: 'Rapid crossovers', source: 'BSMG', group: 'situational', about: 'Рука уходит в дальнюю дорожку чужой стороны и обратно быстрее чем за 1 с' },
  { id: 'wideInward', name: 'Wide inward doubles', source: 'BSMG', group: 'situational', about: 'Двойной удар по краям внутрь или двойной вниз с верхнего ряда' },
  { id: 'towers', name: 'Excessive towers', source: 'BSMG', group: 'situational', about: 'Башни из 3+ нот одного цвета много раз подряд (3 за 4 доли)' },
  { id: 'detachedWalls', name: 'Detached walls', source: 'BSMG', group: 'situational', about: 'Соседние одинаковые стены в одно время — лучше одна широкая' },
  { id: 'extendedCrouch', name: 'Extended crouch', source: 'BSMG', group: 'situational', about: 'Присед дольше 3 секунд подряд' },
  { id: 'cornerCrouch', name: 'Corner crouch', source: 'BSMG', group: 'situational', about: 'Crouch wall вместе с dodge wall: присесть и уйти в угол' },
  { id: 'skyStream', name: 'Sky streams', source: 'BSMG', group: 'situational', about: '8+ нот одной руки подряд в верхнем ряду' },
  { id: 'visualClutter', name: 'Visual clutter', source: 'BSMG', group: 'situational', about: 'Стрелка и dot одного цвета в один удар' },
  { id: 'armTangle', name: 'Arm tangle', source: 'BSMG', group: 'situational', about: 'Скрещённые руки бьют в разные стороны по вертикали' },
  { id: 'facePuncher', name: 'Face puncher', source: 'BSMG', group: 'situational', about: 'Crossover в верхний угол чужой стороны с ударом вверх наружу' },
  { id: 'jump', name: 'NJS, JD и NPS', source: 'BSMG', group: 'timing', about: 'Note jump speed, jump distance, reaction time и notes per second по таблицам BSMG' },
];


/** The rules a standard has. */
export function rulesOf(standards: Iterable<CheckSource>) {
  const wanted = new Set(standards);
  return CHECK_RULES.filter((rule) => rule.source.split(' · ').some((source) => wanted.has(source as CheckSource))).map((rule) => rule.id);
}

/** The sites whose criteria can be checked against. */
export type CheckSource = 'BSMG' | 'BL' | 'SS';
export const CHECK_SOURCES: CheckSource[] = ['BSMG', 'BL', 'SS'];

export interface CheckInput {
  objects: MapObjects;
  /** Map beat → seconds of the song. */
  seconds: (beat: number) => number;
  /** The song's length (seconds, with the silence put in front). */
  songSeconds: number;
  difficulty?: string;
  /** Rules switched off. */
  disabled?: Iterable<string>;
  /** Whose thresholds (default: all — the strictest of each). */
  standards?: Iterable<CheckSource>;
  /** The difficulty's half jump (beats): BSMG's vision blocks last that long. */
  halfJump?: number;
}

/** Cut directions (0 up … 7 down-right; 8 a dot) as steps on the grid (x right, y up). */
const DIR: [number, number][] = [
  [0, 1],
  [0, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [1, 1],
  [-1, -1],
  [1, -1],
];

/** A note's cut (a unit step, turned by its angle offset), or null for a dot. */
function cutOf(note: { d: number; a?: number }): [number, number] | null {
  const step = DIR[note.d];
  if (step === undefined) return null;
  const angle = Math.atan2(step[1], step[0]) + ((note.a ?? 0) * Math.PI) / 180;
  return [Math.cos(angle), Math.sin(angle)];
}

const angleBetween = (a: [number, number], b: [number, number]) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI;

/** Same moment: the same beat to within a thousandth. */
const SAME = 1e-3;
/** At most this many issues of one rule (the rest are summed up). */
const CAP = 150;

const fmt = (seconds: number) => `${seconds.toFixed(2)} с`;
const ms = (seconds: number) => `${String(Math.round(seconds * 1000))} мс`;

export function checkMap(input: CheckInput): MapIssue[] {
  const off = new Set(input.disabled ?? []);
  const picked = new Set<CheckSource>(input.standards ?? CHECK_SOURCES);
  const bl = picked.has('BL');
  const ss = picked.has('SS');
  const bsmgOn = picked.has('BSMG');
  const issues: MapIssue[] = [];
  const counts = new Map<string, number>();
  const add = (rule: string, level: IssueLevel, beat: number, ids: string[], text: string) => {
    if (off.has(rule)) return;
    const count = (counts.get(rule) ?? 0) + 1;
    counts.set(rule, count);
    if (count <= CAP) issues.push({ rule, level, beat, ids, text, key: '' });
  };
  const on = (rule: string) => !off.has(rule);
  const { objects } = input;
  const sec = input.seconds;
  const notes = [...objects.notes].sort((a, b) => a.b - b.b);
  const bombs = [...objects.bombs].sort((a, b) => a.b - b.b);
  const walls = [...objects.walls].sort((a, b) => a.b - b.b);

  // ----- objects in one another --------------------------------------------------------------
  if (on('stacked')) {
    const cells = new Map<string, { id: string; b: number; bomb: boolean }[]>();
    const put = (item: { id: string; b: number; x: number; y: number }, bomb: boolean) => {
      const cell = `${String(item.x)},${String(item.y)}`;
      let list = cells.get(cell);
      if (list === undefined) cells.set(cell, (list = []));
      list.push({ id: item.id, b: item.b, bomb });
    };
    for (const note of notes) put(note, false);
    for (const bomb of bombs) put(bomb, true);
    for (const list of cells.values()) {
      list.sort((a, b) => a.b - b.b);
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1]!;
        const b = list[i]!;
        if (a.bomb && b.bomb) continue;
        if (Math.abs(sec(b.b) - sec(a.b)) < 0.01) add('stacked', 'error', b.b, [a.id, b.id], a.bomb || b.bomb ? 'Нота и бомба в одной клетке в одно время' : 'Две ноты в одной клетке в одно время');
      }
    }
  }

  // ----- notes at one moment -----------------------------------------------------------------
  const moments: MapNote[][] = [];
  for (const note of notes) {
    const last = moments[moments.length - 1];
    if (last !== undefined && Math.abs(last[0]!.b - note.b) < SAME) last.push(note);
    else moments.push([note]);
  }
  for (const moment of moments) {
    const beat = moment[0]!.b;
    for (let i = 0; i < moment.length; i++) {
      for (let j = i + 1; j < moment.length; j++) {
        const a = moment[i]!;
        const b = moment[j]!;
        const ca = cutOf(a);
        const cb = cutOf(b);
        if (a.c !== b.c) {
          const [red, blue] = a.c === 0 ? [a, b] : [b, a];
          const cr = cutOf(red);
          const cBlue = cutOf(blue);
          if (cr !== null && cBlue !== null) {
            const p: [number, number] = [blue.x - red.x, blue.y - red.y];
            if (cr[0] * p[0] + cr[1] * p[1] > 0.3 && -(cBlue[0] * p[0] + cBlue[1] * p[1]) > 0.3 && cr[0] * cBlue[0] + cr[1] * cBlue[1] < -0.3) add('handclap', 'error', beat, [red.id, blue.id], 'Handclap: красная и синяя бьют навстречу друг другу');
          }
          // in the other colour's swing: where it comes from (its back side)
          for (const [note, other] of [
            [a, b],
            [b, a],
          ] as const) {
            const cut = cutOf(note);
            if (cut === null) continue;
            if (Math.round(note.x - cut[0]) === other.x && Math.round(note.y - cut[1]) === other.y) add('preSwing', 'error', beat, [note.id, other.id], `Pre-swing path: ${other.c === 0 ? 'красная' : 'синяя'} нота в замахе ${note.c === 0 ? 'красной' : 'синей'}`);
          }
        } else if (ca !== null && cb !== null) {
          if (angleBetween(ca, cb) > 45.5) add('sameSwingAngle', 'error', beat, [a.id, b.id], `Cut direction в одном swing расходится на ${String(Math.round(angleBetween(ca, cb)))}°`);
          else {
            // side by side across the cut, not along it
            const line: [number, number] = [b.x - a.x, b.y - a.y];
            const length = Math.hypot(line[0], line[1]);
            if (length > 0) {
              const along = Math.abs((line[0] * ca[0] + line[1] * ca[1]) / length);
              if (along < Math.cos((50 * Math.PI) / 180)) add('parallel', 'error', beat, [a.id, b.id], 'Parallel notes: ноты одного цвета в один swing стоят поперёк замаха');
            }
          }
        }
      }
    }
  }

  // ----- a hand's swings one after another ---------------------------------------------------
  /** Each hand's swings: notes of its colour at one moment, in the order hit (along the cut). */
  for (const colour of [0, 1]) {
    const swings: MapNote[][] = [];
    for (const moment of moments) {
      const own = moment.filter((note) => note.c === colour);
      if (own.length > 0) swings.push(own);
    }
    // sliders: three or more swings in quick succession going the same way — evenly spaced
    if (on('sliderSpacing')) {
      let run: MapNote[] = [];
      const flush = () => {
        if (run.length >= 3) {
          const gaps = run.slice(1).map((note, index) => note.b - run[index]!.b);
          if (Math.max(...gaps) - Math.min(...gaps) > 0.004) add('sliderSpacing', 'warn', run[0]!.b, run.map((note) => note.id), `Неровный slider: ${String(run.length)} нот с разными промежутками`);
        }
        run = [];
      };
      for (const swing of swings) {
        const note = swing[0]!;
        const last = run[run.length - 1];
        if (swing.length === 1 && last !== undefined && note.b - last.b <= 0.2 && sec(note.b) - sec(last.b) < 0.09) {
          const a = cutOf(last);
          const b = cutOf(note);
          if (a === null || b === null || angleBetween(a, b) <= 45.5) {
            run.push(note);
            continue;
          }
        }
        flush();
        if (swing.length === 1) run = [note];
      }
      flush();
    }
    // double directionals: two swings the same way with no bomb reset between (a bomb by the hand
    // that makes it swing back) — close (under 1.5 beats) an error, farther a warning
    if (on('doubleDirectional')) {
      for (let i = 1; i < swings.length; i++) {
        const before = swings[i - 1]!;
        const after = swings[i]!;
        const a = cutOf(before[before.length - 1]!);
        const b = cutOf(after[0]!);
        if (a === null || b === null) continue;
        const gap = after[0]!.b - before[0]!.b;
        // (a slider's notes are one swing)
        if (sec(after[0]!.b) - sec(before[0]!.b) < 0.09) continue;
        // the same way: within 45°, or both swinging down (or both up) — the hand never came back
        const sameWay = angleBetween(a, b) <= 45.5 || (a[1] < -0.3 && b[1] < -0.3) || (a[1] > 0.3 && b[1] > 0.3);
        if (!sameWay) continue;
        const xs = [...before, ...after].map((note) => note.x);
        const reset = bombs.some((bomb) => bomb.b > before[0]!.b + SAME && bomb.b < after[0]!.b - SAME && bomb.x >= Math.min(...xs) - 1 && bomb.x <= Math.max(...xs) + 1);
        if (!reset) add('doubleDirectional', gap < 1.5 ? 'error' : 'warn', after[0]!.b, [before[before.length - 1]!.id, after[0]!.id], `Double directional: ${colour === 0 ? 'красная' : 'синяя'} дважды в одну сторону через ${String(Math.round(gap * 100) / 100)} доли без bomb reset`);
      }
    }
    // too fast for one hand (SS: 350 BPM sustained; bursts to 8 beats, never over 425)
    if (on('fastStream')) {
      let start = -1;
      let peak = 0;
      const close = (end: number) => {
        if (start < 0) return;
        const swingsIn = end - start;
        if (swingsIn / 2 > 8 || peak > 425) add('fastStream', 'error', swings[start]![0]!.b, swings.slice(start, end + 1).map((swing) => swing[0]!.id).slice(0, 64), `${colour === 0 ? 'Красная' : 'Синяя'} рука: ${String(Math.round(peak))} EBPM на протяжении ${String(Math.round(swingsIn / 2))} долей`);
        start = -1;
        peak = 0;
      };
      for (let i = 1; i < swings.length; i++) {
        const gap = sec(swings[i]![0]!.b) - sec(swings[i - 1]![0]!.b);
        // (a slider's notes, going on the same way, are one swing)
        const a = cutOf(swings[i - 1]![0]!);
        const b = cutOf(swings[i]![0]!);
        const slider = a === null || b === null || angleBetween(a, b) <= 45.5;
        const ebpm = gap > 0.005 && !slider ? 30 / gap : 0;
        if (ebpm > 350) {
          if (start < 0) start = i - 1;
          peak = Math.max(peak, ebpm);
        } else close(i - 1);
      }
      close(swings.length - 1);
    }
  }

  // ----- the other colour right on a swing's way out -----------------------------------------
  if (on('postSwing')) {
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i]!;
      const cut = cutOf(note);
      if (cut === null) continue;
      const t = sec(note.b);
      const tx = Math.round(note.x + cut[0]);
      const ty = Math.round(note.y + cut[1]);
      for (let j = i + 1; j < notes.length; j++) {
        const other = notes[j]!;
        const dt = sec(other.b) - t;
        if (dt > 0.15) break;
        if (dt < 0.005 || other.c === note.c) continue;
        if (other.x === tx && other.y === ty) add('postSwing', 'warn', other.b, [note.id, other.id], `Hitbox abuse: нота через ${ms(dt)} в follow-through другого цвета`);
      }
    }
  }

  // ----- vision blocks: a face note, then notes behind it ------------------------------------
  if (on('visionBlock')) {
    for (let i = 0; i < notes.length; i++) {
      const face = notes[i]!;
      if (face.y !== 1 || (face.x !== 1 && face.x !== 2)) continue;
      const t = sec(face.b);
      // (BSMG's rule of thumb: a face note on the left of the middle hides the whole left half of the
      // grid for the half jump — the right one the right half)
      const window = Math.max(0.25, sec(face.b + (input.halfJump ?? 1)) - t);
      for (let j = i + 1; j < notes.length; j++) {
        const hidden = notes[j]!;
        const dt = sec(hidden.b) - t;
        if (dt > window) break;
        if (dt < 0.005) continue;
        if (hidden.x < 2 !== face.x < 2) continue;
        // (the same hand's slider goes on with the same swing)
        if (hidden.c === face.c && dt < 0.09) continue;
        add('visionBlock', 'warn', hidden.b, [face.id, hidden.id], `Vision block: нота в центре закрывает свою половину сетки на половину прыжка — нота через ${ms(dt)}`);
        break;
      }
    }
  }

  // ----- arrows' angle -----------------------------------------------------------------------
  if (on('angleOffset')) {
    for (const note of notes) {
      if (note.a === 0) continue;
      if (note.d !== 8) add('angleOffset', 'warn', note.b, [note.id], `Angle offset ${String(note.a)}° у arrow-ноты — SS требует 0`);
      else if (note.a % 45 !== 0) add('angleOffset', 'warn', note.b, [note.id], `Angle offset ${String(note.a)}° у dot-ноты — SS требует кратно 45°`);
    }
  }

  // ----- bombs ---------------------------------------------------------------------------------
  if (on('hammerHit')) {
    let from = 0;
    for (const note of notes) {
      const cut = cutOf(note);
      if (cut === null) continue;
      const t = sec(note.b);
      while (from < bombs.length && sec(bombs[from]!.b) < t - 0.06) from++;
      for (let k = from; k < bombs.length; k++) {
        const bomb = bombs[k]!;
        const dt = sec(bomb.b) - t;
        if (dt > 0.06) break;
        if (bomb.x === Math.round(note.x + cut[0]) && bomb.y === Math.round(note.y + cut[1]) && dt >= -0.005) add('hammerHit', 'error', note.b, [note.id, bomb.id], 'Hammer hit: arrow-нота указывает прямо на бомбу');
        else if (bomb.x === Math.round(note.x - cut[0]) && bomb.y === Math.round(note.y - cut[1]) && dt <= 0.005) add('hammerHit', 'error', note.b, [note.id, bomb.id], 'Бомба в pre-swing ноты');
      }
    }
  }
  if (on('bombSpacing')) {
    const last = new Map<string, { b: number; id: string }>();
    for (const bomb of bombs) {
      const cell = `${String(bomb.x)},${String(bomb.y)}`;
      const before = last.get(cell);
      if (before !== undefined) {
        const dt = sec(bomb.b) - sec(before.b);
        if (dt < 0.02 && ss) add('bombSpacing', 'error', bomb.b, [before.id, bomb.id], `Бомбы в одной клетке через ${ms(dt)} (SS: от 20 мс)`);
        else if (dt < 0.03 && bl) add('bombSpacing', 'error', bomb.b, [before.id, bomb.id], `Бомбы в одной клетке через ${ms(dt)} (BL: от 30 мс)`);
      }
      last.set(cell, { b: bomb.b, id: bomb.id });
    }
  }

  // ----- walls ---------------------------------------------------------------------------------
  const wallEnd = (wall: MapWall) => wall.b + Math.max(0, wall.d);
  const covers = (wall: MapWall, x: number, y: number) => x >= wall.x && x < wall.x + wall.w && y >= wall.y && y < wall.y + wall.h;
  if (on('inWall')) {
    for (const wall of walls) {
      if (wall.w <= 0 || wall.d <= 0) continue;
      const end = wallEnd(wall);
      for (const [list, what] of [
        [notes, 'Нота'],
        [bombs, 'Бомба'],
      ] as const) {
        for (const item of list) {
          if (item.b >= end) break;
          if (item.b <= wall.b + SAME || item.b >= end - SAME) continue;
          if (covers(wall, item.x, item.y)) add('inWall', 'error', item.b, [item.id, wall.id], `${what} внутри стены`);
        }
      }
    }
  }
  if (on('wallShape')) {
    for (const wall of walls) {
      const length = sec(wall.b + wall.d) - sec(wall.b);
      if (wall.w <= 0) add('wallShape', 'error', wall.b, [wall.id], 'Fake wall: ширина 0 или меньше');
      else if (length < (ss ? 0.015 : 0.0138) && (ss || (wall.x < 3 && wall.x + wall.w > 1))) add('wallShape', 'error', wall.b, [wall.id], ss ? `Стена короче 15 мс (${ms(length)})` : `Стена в средних дорожках короче 13,8 мс (${ms(length)})`);
      // (walls off the grid altogether are scenery)
      const inGrid = wall.x < 4 && wall.x + wall.w > 0;
      if (inGrid && wall.w > 0 && (wall.x < 0 || wall.x + wall.w > 4 || wall.y < 0 || wall.y + wall.h > 5)) add('wallShape', 'error', wall.b, [wall.id], 'Стена выходит за сетку 4×3');
      else if (inGrid && wall.w > 0 && wallKindOf(wall) === 'deep') add('wallShape', 'warn', wall.b, [wall.id], 'Стена не полная и не crouch — для рейтинга нужна одна из двух');
    }
  }
  /** Full walls (they make the player step aside). */
  const tall = walls.filter((wall) => wall.w > 0 && wall.d > 0 && wall.y === 0);
  if (on('dangerDash')) {
    for (const wall of tall) {
      const active = tall.filter((other) => other.b <= wall.b + SAME && wallEnd(other) > wall.b + SAME);
      const one = active.some((other) => covers(other, 1, 0));
      const two = active.some((other) => covers(other, 2, 0));
      if (one && two && sec(Math.min(...active.map(wallEnd))) - sec(wall.b) >= 0.015) add('dangerDash', 'error', wall.b, active.map((other) => other.id), 'Danger dash: полные стены закрывают обе средние дорожки');
    }
  }
  if (on('rapidDodge')) {
    // which way each face wall sends the head
    const moves: { t: number; beat: number; side: number; id: string }[] = [];
    for (const wall of tall) {
      const left = covers(wall, 1, 0);
      const right = covers(wall, 2, 0);
      if (left === right) continue;
      moves.push({ t: sec(wall.b), beat: wall.b, side: left ? 1 : -1, id: wall.id });
    }
    let side = 0;
    const changes: typeof moves = [];
    for (const move of moves) {
      if (move.side !== side) changes.push(move);
      side = move.side;
    }
    for (let i = 3; i < changes.length; i++) {
      if (changes[i]!.t - changes[i - 3]!.t < 1) add('rapidDodge', 'warn', changes[i]!.beat, changes.slice(i - 3, i + 1).map((move) => move.id), 'Rapid dodge walls: голова двигается больше 3 раз в секунду');
    }
  }

  // ----- arcs and chains -----------------------------------------------------------------------
  if (on('arcs')) {
    const at = (c: number, b: number, x: number, y: number) => notes.some((note) => note.c === c && Math.abs(note.b - b) < SAME && note.x === x && note.y === y);
    for (const arc of objects.arcs) {
      if (!at(arc.c, arc.b, arc.x, arc.y) && !at(arc.c, arc.tb, arc.tx, arc.ty)) add('arcs', 'error', arc.b, [arc.id], 'Arc не связана ни с одной нотой');
      if (arc.mu < 0.1 || arc.mu > 1.5 || ((arc.tmu < 0.1 || arc.tmu > 1.5) && arc.tc !== 8)) add('arcs', 'warn', arc.b, [arc.id], 'Arc multiplier вне 0,1–1,5 (SS)');
    }
  }
  if (on('chains') && ss && objects.chains.length > 0) add('chains', 'info', objects.chains[0]!.b, objects.chains.map((chain) => chain.id), `Chains: ${String(objects.chains.length)} — ScoreSaber не ранкает карты с chains (BeatLeader — да)`);

  // ----- BSMG's forbidden and situational patterns ---------------------------------------------
  const hand = (c: number) => (c === 0 ? 'красная' : 'синяя');
  for (const moment of moments) {
    const beat = moment[0]!.b;
    const red = moment.filter((note) => note.c === 0);
    const blue = moment.filter((note) => note.c === 1);
    for (const r of red) {
      for (const bl of blue) {
        const cr = cutOf(r);
        const cb = cutOf(bl);
        if (cr === null || cb === null) continue;
        // crossed: red right of blue
        if (r.x > bl.x) {
          if (cr[0] < -0.3 && cb[0] > 0.3 && Math.abs(r.y - bl.y) <= 1) add('cross', 'error', beat, [r.id, bl.id], 'Cross: скрещённые руки бьют навстречу друг другу');
          else if ((cr[1] > 0.3 && cb[1] < -0.3) || (cr[1] < -0.3 && cb[1] > 0.3)) add('armTangle', 'warn', beat, [r.id, bl.id], 'Arm tangle: скрещённые руки бьют в разные стороны по вертикали');
          // both crossed over and slicing sideways: red on top slicing left, blue on top slicing right
          if (r.x >= 2 && bl.x <= 1 && Math.abs(cr[1]) < 0.75 && Math.abs(cb[1]) < 0.75 && cr[0] * cb[0] > 0 && r.y !== bl.y) {
            const left = cr[0] < 0;
            if ((left && r.y < bl.y) || (!left && bl.y < r.y)) add('incorrectSide', 'warn', beat, [r.id, bl.id], `Incorrect side hits: при ударе ${left ? 'влево сверху должна быть красная' : 'вправо сверху должна быть синяя'}`);
          }
        }
        // wide inward doubles: on the edges pointing in, or both down from the top row
        if (((r.x === 0 && bl.x === 3 && cr[0] > 0.3 && cb[0] < -0.3) || (r.y === 2 && bl.y === 2 && cr[1] < -0.3 && cb[1] < -0.3)) && r.x < bl.x) add('wideInward', 'warn', beat, [r.id, bl.id], 'Wide inward double: неудобно для невысоких игроков');
        // wide precision: the double on the edges, bombs in the middle at the same time
        if (Math.min(r.x, bl.x) === 0 && Math.max(r.x, bl.x) === 3) {
          const middle = bombs.filter((bomb) => Math.abs(bomb.b - beat) < 0.26 && (bomb.x === 1 || bomb.x === 2));
          if (middle.length > 0) add('widePrecision', 'warn', beat, [r.id, bl.id, ...middle.map((bomb) => bomb.id)], 'Wide precision: удар по краям, а в середине бомбы');
        }
      }
    }
    for (const own of [red, blue]) {
      if (own.length < 2) continue;
      const arrows = own.filter((note) => note.d !== 8);
      if (arrows.length > 0 && arrows.length < own.length) add('visualClutter', 'warn', beat, own.map((note) => note.id), 'Visual clutter: стрелка и dot одного цвета в один удар');
    }
    // face punchers: a crossover into the top corner, swinging up and out
    for (const note of moment) {
      if (note.y === 2 && ((note.c === 0 && note.x === 3 && note.d === 5) || (note.c === 1 && note.x === 0 && note.d === 4))) add('facePuncher', 'warn', beat, [note.id], `Face puncher: ${hand(note.c)} в чужом верхнем углу бьёт вверх наружу`);
    }
  }
  if (on('towers')) {
    const towers = moments.flatMap((moment) => [0, 1].map((c) => moment.filter((note) => note.c === c)).filter((own) => own.length >= 3));
    for (let i = 2; i < towers.length; i++) {
      if (towers[i]![0]!.b - towers[i - 2]![0]!.b <= 4) add('towers', 'warn', towers[i]![0]!.b, towers[i]!.map((note) => note.id), 'Excessive towers: третья башня за 4 доли');
    }
  }
  if (on('skyStream')) {
    for (const c of [0, 1]) {
      let run: MapNote[] = [];
      const flush = () => {
        if (run.length >= 8) add('skyStream', 'warn', run[0]!.b, run.map((note) => note.id).slice(0, 32), `Sky stream: ${String(run.length)} нот подряд в верхнем ряду (${hand(c)})`);
        run = [];
      };
      for (const note of notes) {
        if (note.c !== c) continue;
        if (note.y === 2) run.push(note);
        else flush();
      }
      flush();
    }
  }
  if (on('rapidCrossover')) {
    for (const c of [0, 1]) {
      /** Where the hand is: on its own side (false) or crossed over (true). */
      let crossed = false;
      let since: { t: number; id: string } | null = null;
      for (const note of notes) {
        if (note.c !== c) continue;
        const over = c === 0 ? note.x === 3 : note.x === 0; // (deep into the other side: the far lane)
        if (over === crossed) continue;
        const t = sec(note.b);
        if (!over && since !== null && t - since.t < 1) add('rapidCrossover', 'warn', note.b, [since.id, note.id], `Rapid crossover: ${hand(c)} уходит в дальнюю дорожку чужой стороны и обратно за ${ms(t - since.t)}`);
        crossed = over;
        since = over ? { t, id: note.id } : null;
      }
    }
  }
  if (on('bombWall') || on('bombSpam')) {
    const byMoment = new Map<string, typeof bombs>();
    for (const bomb of bombs) {
      const k = bomb.b.toFixed(3);
      byMoment.set(k, [...(byMoment.get(k) ?? []), bomb]);
    }
    for (const group of byMoment.values()) {
      const cells = new Set(group.map((bomb) => `${String(bomb.x)},${String(bomb.y)}`));
      if (cells.size >= 9) add('bombWall', 'error', group[0]!.b, group.map((bomb) => bomb.id), `Bomb wall: бомбы закрывают ${String(cells.size)} клеток из 12`);
    }
    let from = 0;
    let last = -Infinity;
    for (let i = 0; i < bombs.length; i++) {
      while (bombs[i]!.b - bombs[from]!.b > 4) from++;
      if (i - from + 1 > 24 && bombs[i]!.b - last > 4) {
        last = bombs[i]!.b;
        add('bombSpam', 'warn', bombs[from]!.b, [], `Bomb spam: ${String(i - from + 1)} бомб за 4 доли`);
      }
    }
  }
  if (on('disembodied')) {
    for (const wall of walls) {
      if (wall.w <= 0 || wall.d <= 0) continue;
      const end = wallEnd(wall);
      for (const note of notes) {
        if (note.b <= end + SAME) continue;
        if (note.b > end + Math.min(1, input.halfJump ?? 1)) break;
        if (covers(wall, note.x, note.y)) add('disembodied', 'warn', note.b, [note.id, wall.id], 'Disembodied note: нота спрятана за стеной');
      }
    }
  }
  if (on('detachedWalls') || on('cornerCrouch') || on('extendedCrouch')) {
    for (let i = 0; i < walls.length; i++) {
      const a = walls[i]!;
      if (a.w <= 0 || a.d <= 0) continue;
      for (let j = i + 1; j < walls.length && walls[j]!.b < wallEnd(a); j++) {
        const b = walls[j]!;
        if (b.w <= 0 || b.d <= 0) continue;
        if (Math.abs(a.b - b.b) < SAME && Math.abs(a.d - b.d) < SAME && a.y === b.y && a.h === b.h && (a.x + a.w === b.x || b.x + b.w === a.x)) add('detachedWalls', 'warn', a.b, [a.id, b.id], 'Detached walls: соседние стены лучше сделать одной');
        const kinds = [wallKindOf(a), wallKindOf(b)];
        if (kinds.includes('crouch') && kinds.includes('full') && Math.abs(a.b - b.b) < 1) add('cornerCrouch', 'warn', Math.max(a.b, b.b), [a.id, b.id], 'Corner crouch: присед вместе с dodge wall');
      }
    }
    // crouching for long: crouch walls joined end to end
    const crouch = walls.filter((wall) => wall.w > 0 && wall.d > 0 && wallKindOf(wall) === 'crouch' && wall.x <= 1 && wall.x + wall.w >= 3);
    let start: MapWall | null = null;
    let until = -Infinity;
    const close = () => {
      if (start !== null && sec(until) - sec(start.b) > 3) add('extendedCrouch', 'warn', start.b, [start.id], `Extended crouch: присед ${fmt(sec(until) - sec(start.b))}`);
    };
    for (const wall of crouch) {
      if (start !== null && wall.b <= until + 0.25) until = Math.max(until, wallEnd(wall));
      else {
        close();
        start = wall;
        until = wallEnd(wall);
      }
    }
    close();
  }

  // ----- the start and the end ---------------------------------------------------------------
  /** What the player meets: notes, bombs, arcs, chains, walls in the middle lanes. */
  const starts: { b: number; end: number; id: string }[] = [
    ...notes.map((note) => ({ b: note.b, end: note.b, id: note.id })),
    ...bombs.map((bomb) => ({ b: bomb.b, end: bomb.b, id: bomb.id })),
    ...objects.arcs.map((arc) => ({ b: arc.b, end: arc.tb, id: arc.id })),
    ...objects.chains.map((chain) => ({ b: chain.b, end: chain.tb, id: chain.id })),
    ...walls.filter((wall) => wall.w > 0 && wall.x < 3 && wall.x + wall.w > 1).map((wall) => ({ b: wall.b, end: wallEnd(wall), id: wall.id })),
  ];
  if (starts.length > 0) {
    const first = starts.reduce((a, b) => (b.b < a.b ? b : a));
    const last = starts.reduce((a, b) => (b.end > a.end ? b : a));
    const begin = sec(first.b);
    const hard = ss ? 1.5 : bl ? 1.33 : 0;
    if (begin < hard) add('hotStart', 'error', first.b, [first.id], `Hot start: первый объект на ${fmt(begin)} (${ss && bl ? 'SS: от 1,5 с, BL: от 1,33 с' : ss ? 'SS: от 1,5 с' : 'BL: от 1,33 с'})`);
    else if (begin < 2 && bsmgOn) add('hotStart', 'warn', first.b, [first.id], `Hot start: первый объект на ${fmt(begin)} — BSMG советует от 2 с`);
    const tail = input.songSeconds - sec(last.end);
    if (tail < 2) add('coldEnd', 'error', last.end, [last.id], `Cold end: после последнего объекта ${fmt(Math.max(0, tail))} (нужно от 2 с)`);
    else if (tail > 15) add('longOutro', 'info', last.end, [last.id], `Долгий outro: ещё ${fmt(tail)} после последнего объекта — SS требует меньше 15 с без нот и света`);
  }
  if (on('mapLength')) {
    if (notes.length > 1) {
      const span = sec(notes[notes.length - 1]!.b) - sec(notes[0]!.b);
      if (span < 45) add('mapLength', 'warn', notes[0]!.b, [], `От первой ноты до последней ${fmt(span)} — BeatLeader ранкает от 45 с`);
    }
    if (input.songSeconds < 20) add('mapLength', 'error', 0, [], `Песня короче 20 с (${fmt(input.songSeconds)}) — SS не ранкает`);
    if (input.songSeconds > 600) add('mapLength', 'warn', 0, [], `Песня длиннее 10 минут — SS не ранкает`);
  }

  for (const [rule, count] of counts) {
    if (count > CAP) issues.push({ rule, level: 'info', beat: issues.find((issue) => issue.rule === rule)?.beat ?? 0, ids: [], text: `…и ещё ${String(count - CAP)} таких же`, key: `more:${rule}` });
  }
  // (a key made of what the issue is about, not of the ids, which are new each time the map is read)
  const described = new Map<string, string>();
  for (const kind of ['notes', 'bombs', 'walls', 'arcs', 'chains'] as const) for (const item of objects[kind] as { id: string; b: number; x: number; y: number }[]) described.set(item.id, `${kind[0]!}${item.b.toFixed(3)}:${String(item.x)}:${String(item.y)}`);
  for (const issue of issues) if (issue.key === '') issue.key = `${issue.rule}@${issue.beat.toFixed(3)}#${issue.ids.map((id) => described.get(id) ?? '').sort().join(';')}`;
  return issues.sort((a, b) => a.beat - b.beat);
}
