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
}

export interface CheckRule {
  id: string;
  name: string;
  /** Whose rule it is. */
  source: string;
  group: 'notes' | 'bombs' | 'walls' | 'arcs' | 'timing';
  about: string;
}

export const CHECK_RULES: CheckRule[] = [
  { id: 'stacked', name: 'Объекты друг в друге', source: 'BSMG · BL · SS', group: 'notes', about: 'Две ноты или нота и бомба в одной клетке в одно время' },
  { id: 'handclap', name: 'Хлопок руками', source: 'BSMG · BL', group: 'notes', about: 'Красная и синяя ноты в одно время направляют руки навстречу друг другу' },
  { id: 'parallel', name: 'Параллельные ноты одного цвета', source: 'BL · SS', group: 'notes', about: 'Ноты одного цвета в один удар стоят рядом поперёк замаха, а не по его линии' },
  { id: 'sameSwingAngle', name: 'Разные стрелки в один удар', source: 'BL · SS', group: 'notes', about: 'Стрелки нот одного цвета в одно время расходятся больше чем на 45°' },
  { id: 'preSwing', name: 'Нота в замахе другого цвета', source: 'BL · SS', group: 'notes', about: 'Нота стоит там, откуда замахивается сабля другого цвета' },
  { id: 'postSwing', name: 'Нота на пути удара другого цвета', source: 'BSMG · SS', group: 'notes', about: 'Сразу после удара на его продолжении стоит нота другого цвета (hitbox abuse)' },
  { id: 'doubleDirectional', name: 'Двойное направление', source: 'BSMG · SS', group: 'notes', about: 'Две ноты одного цвета подряд в одну сторону без бомбы-сброса (ближе 1,5 доли)' },
  { id: 'visionBlock', name: 'Перекрытие обзора', source: 'BSMG · BL', group: 'notes', about: 'Нота у лица (средний ряд, центр) закрывает следующие ноты позади неё' },
  { id: 'angleOffset', name: 'Поворот стрелки', source: 'SS', group: 'notes', about: 'У стрелок поворот должен быть 0, у точек — кратен 45°' },
  { id: 'sliderSpacing', name: 'Неровный слайдер', source: 'BL', group: 'notes', about: 'В слайдере из 3+ нот промежутки между нотами разные' },
  { id: 'fastStream', name: 'Слишком быстро', source: 'SS', group: 'notes', about: 'Удары одной рукой чаще 350 BPM дольше 8 долей (или чаще 425)' },
  { id: 'hammerHit', name: 'Бомба на пути удара', source: 'BSMG · BL · SS', group: 'bombs', about: 'Стрелка указывает на бомбу рядом (hammer hit) или бомба стоит в замахе' },
  { id: 'bombSpacing', name: 'Бомбы слишком часто', source: 'BL · SS', group: 'bombs', about: 'Бомбы в одной клетке ближе 20 мс (SS) или 30 мс (BL)' },
  { id: 'inWall', name: 'Нота или бомба в стене', source: 'BL · SS', group: 'walls', about: 'Нота или бомба внутри стены' },
  { id: 'wallShape', name: 'Неправильная стена', source: 'SS · BL', group: 'walls', about: 'Нулевая ширина, короче 15 мс, не полная и не присед, выходит за сетку' },
  { id: 'dangerDash', name: 'Стена на обе средние дорожки', source: 'BSMG · SS', group: 'walls', about: 'Полные стены закрывают обе средние дорожки — выгоняют игрока на край' },
  { id: 'rapidDodge', name: 'Частые уклонения', source: 'BL', group: 'walls', about: 'Стены заставляют двигать голову больше 3 раз в секунду' },
  { id: 'arcs', name: 'Дуги', source: 'SS', group: 'arcs', about: 'Дуга не связана с нотой; сила изгиба вне 0,1–1,5' },
  { id: 'chains', name: 'Цепи', source: 'SS', group: 'arcs', about: 'ScoreSaber не ранкает карты с цепями' },
  { id: 'hotStart', name: 'Горячий старт', source: 'BSMG · BL · SS', group: 'timing', about: 'Первые объекты раньше 1,5 с (ошибка) или 2 с (предупреждение)' },
  { id: 'coldEnd', name: 'Холодный конец', source: 'BL · SS', group: 'timing', about: 'После последнего объекта меньше 2 с песни' },
  { id: 'longOutro', name: 'Долгая концовка', source: 'SS', group: 'timing', about: 'После последнего объекта больше 15 с без нот (если там нет света)' },
  { id: 'mapLength', name: 'Длина карты', source: 'BL · SS', group: 'timing', about: 'Короче 45 с от первой ноты до последней; песня короче 20 с или длиннее 10 минут' },
  { id: 'jump', name: 'NJS, подлёт и плотность', source: 'BSMG', group: 'timing', about: 'Скорость нот, дальность появления, время реакции и нот в секунду по таблицам BSMG' },
];

export interface CheckInput {
  objects: MapObjects;
  /** Map beat → seconds of the song. */
  seconds: (beat: number) => number;
  /** The song's length (seconds, with the silence put in front). */
  songSeconds: number;
  difficulty?: string;
  /** Rules switched off. */
  disabled?: Iterable<string>;
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
  const issues: MapIssue[] = [];
  const counts = new Map<string, number>();
  const add = (rule: string, level: IssueLevel, beat: number, ids: string[], text: string) => {
    if (off.has(rule)) return;
    const count = (counts.get(rule) ?? 0) + 1;
    counts.set(rule, count);
    if (count <= CAP) issues.push({ rule, level, beat, ids, text });
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
            if (cr[0] * p[0] + cr[1] * p[1] > 0.3 && -(cBlue[0] * p[0] + cBlue[1] * p[1]) > 0.3 && cr[0] * cBlue[0] + cr[1] * cBlue[1] < -0.3) add('handclap', 'error', beat, [red.id, blue.id], 'Хлопок руками: красная и синяя бьются навстречу друг другу');
          }
          // in the other colour's swing: where it comes from (its back side)
          for (const [note, other] of [
            [a, b],
            [b, a],
          ] as const) {
            const cut = cutOf(note);
            if (cut === null) continue;
            if (Math.round(note.x - cut[0]) === other.x && Math.round(note.y - cut[1]) === other.y) add('preSwing', 'error', beat, [note.id, other.id], `${other.c === 0 ? 'Красная' : 'Синяя'} нота стоит в замахе ${note.c === 0 ? 'красной' : 'синей'}`);
          }
        } else if (ca !== null && cb !== null) {
          if (angleBetween(ca, cb) > 45.5) add('sameSwingAngle', 'error', beat, [a.id, b.id], `Ноты одного цвета в один удар: стрелки расходятся на ${String(Math.round(angleBetween(ca, cb)))}°`);
          else {
            // side by side across the cut, not along it
            const line: [number, number] = [b.x - a.x, b.y - a.y];
            const length = Math.hypot(line[0], line[1]);
            if (length > 0) {
              const along = Math.abs((line[0] * ca[0] + line[1] * ca[1]) / length);
              if (along < Math.cos((50 * Math.PI) / 180)) add('parallel', 'error', beat, [a.id, b.id], 'Ноты одного цвета в один удар стоят поперёк замаха (параллельно)');
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
          if (Math.max(...gaps) - Math.min(...gaps) > 0.004) add('sliderSpacing', 'warn', run[0]!.b, run.map((note) => note.id), `Слайдер из ${String(run.length)} нот с разными промежутками`);
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
    // double directionals: two swings the same way with no reset (a bomb) between
    if (on('doubleDirectional') && !(input.difficulty === 'Easy' || input.difficulty === 'Normal')) {
      for (let i = 1; i < swings.length; i++) {
        const before = swings[i - 1]!;
        const after = swings[i]!;
        const a = cutOf(before[before.length - 1]!);
        const b = cutOf(after[0]!);
        if (a === null || b === null) continue;
        const gap = after[0]!.b - before[0]!.b;
        // (a slider's notes are one swing)
        if (sec(after[0]!.b) - sec(before[0]!.b) < 0.09 || gap >= 1.5) continue;
        if (angleBetween(a, b) > 45.5) continue;
        const reset = bombs.some((bomb) => bomb.b > before[0]!.b + SAME && bomb.b < after[0]!.b - SAME);
        if (!reset) add('doubleDirectional', 'warn', after[0]!.b, [before[0]!.id, after[0]!.id], `Двойное направление: ${colour === 0 ? 'красная' : 'синяя'} дважды в одну сторону через ${String(Math.round(gap * 100) / 100)} доли без сброса`);
      }
    }
    // too fast for one hand (SS: 350 BPM sustained; bursts to 8 beats, never over 425)
    if (on('fastStream')) {
      let start = -1;
      let peak = 0;
      const close = (end: number) => {
        if (start < 0) return;
        const swingsIn = end - start;
        if (swingsIn / 2 > 8 || peak > 425) add('fastStream', 'error', swings[start]![0]!.b, swings.slice(start, end + 1).map((swing) => swing[0]!.id).slice(0, 64), `${colour === 0 ? 'Красная' : 'Синяя'} рука: ${String(Math.round(peak))} BPM на протяжении ${String(Math.round(swingsIn / 2))} долей`);
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
        if (other.x === tx && other.y === ty) add('postSwing', 'warn', other.b, [note.id, other.id], `Нота через ${ms(dt)} на пути удара другого цвета`);
      }
    }
  }

  // ----- vision blocks: a face note, then notes behind it ------------------------------------
  if (on('visionBlock')) {
    for (let i = 0; i < notes.length; i++) {
      const face = notes[i]!;
      if (face.y !== 1 || (face.x !== 1 && face.x !== 2)) continue;
      const t = sec(face.b);
      for (let j = i + 1; j < notes.length; j++) {
        const hidden = notes[j]!;
        const dt = sec(hidden.b) - t;
        if (dt > 0.5) break;
        if (dt < 0.005 || Math.abs(hidden.x - face.x) > 1 || hidden.x === 0 || hidden.x === 3) continue;
        // (the same hand's slider goes on with the same swing)
        if (hidden.c === face.c && dt < 0.09) continue;
        add('visionBlock', 'warn', hidden.b, [face.id, hidden.id], `Нота у лица закрывает ноту через ${ms(dt)} (BL: нужно от 250 мс, если она предсказуема, иначе от 500 мс)`);
        break;
      }
    }
  }

  // ----- arrows' angle -----------------------------------------------------------------------
  if (on('angleOffset')) {
    for (const note of notes) {
      if (note.a === 0) continue;
      if (note.d !== 8) add('angleOffset', 'warn', note.b, [note.id], `У стрелки поворот ${String(note.a)}° — для рейтинга (SS) нужен 0`);
      else if (note.a % 45 !== 0) add('angleOffset', 'warn', note.b, [note.id], `У точки поворот ${String(note.a)}° — для рейтинга (SS) нужно кратно 45°`);
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
        if (bomb.x === Math.round(note.x + cut[0]) && bomb.y === Math.round(note.y + cut[1]) && dt >= -0.005) add('hammerHit', 'error', note.b, [note.id, bomb.id], 'Стрелка указывает прямо на бомбу (hammer hit)');
        else if (bomb.x === Math.round(note.x - cut[0]) && bomb.y === Math.round(note.y - cut[1]) && dt <= 0.005) add('hammerHit', 'error', note.b, [note.id, bomb.id], 'Бомба в замахе ноты');
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
        if (dt < 0.02) add('bombSpacing', 'error', bomb.b, [before.id, bomb.id], `Бомбы в одной клетке через ${ms(dt)} (SS: от 20 мс)`);
        else if (dt < 0.03) add('bombSpacing', 'warn', bomb.b, [before.id, bomb.id], `Бомбы в одной клетке через ${ms(dt)} (BL: от 30 мс)`);
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
      if (wall.w <= 0) add('wallShape', 'error', wall.b, [wall.id], 'Стена нулевой или отрицательной ширины (ложная стена)');
      else if (length < 0.015) add('wallShape', 'error', wall.b, [wall.id], `Стена короче 15 мс (${ms(length)})`);
      // (walls off the grid altogether are scenery)
      const inGrid = wall.x < 4 && wall.x + wall.w > 0;
      if (inGrid && wall.w > 0 && (wall.x < 0 || wall.x + wall.w > 4 || wall.y < 0 || wall.y + wall.h > 5)) add('wallShape', 'error', wall.b, [wall.id], 'Стена выходит за сетку 4×3');
      else if (inGrid && wall.w > 0 && wallKindOf(wall) === 'deep') add('wallShape', 'warn', wall.b, [wall.id], 'Стена не полная и не присед — для рейтинга нужна одна из двух');
    }
  }
  /** Full walls (they make the player step aside). */
  const tall = walls.filter((wall) => wall.w > 0 && wall.d > 0 && wall.y === 0);
  if (on('dangerDash')) {
    for (const wall of tall) {
      const active = tall.filter((other) => other.b <= wall.b + SAME && wallEnd(other) > wall.b + SAME);
      const one = active.some((other) => covers(other, 1, 0));
      const two = active.some((other) => covers(other, 2, 0));
      if (one && two && sec(Math.min(...active.map(wallEnd))) - sec(wall.b) >= 0.015) add('dangerDash', 'error', wall.b, active.map((other) => other.id), 'Полные стены закрывают обе средние дорожки — игрок вынужден уйти на край');
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
      if (changes[i]!.t - changes[i - 3]!.t < 1) add('rapidDodge', 'warn', changes[i]!.beat, changes.slice(i - 3, i + 1).map((move) => move.id), 'Стены двигают голову больше 3 раз в секунду');
    }
  }

  // ----- arcs and chains -----------------------------------------------------------------------
  if (on('arcs')) {
    const at = (c: number, b: number, x: number, y: number) => notes.some((note) => note.c === c && Math.abs(note.b - b) < SAME && note.x === x && note.y === y);
    for (const arc of objects.arcs) {
      if (!at(arc.c, arc.b, arc.x, arc.y) && !at(arc.c, arc.tb, arc.tx, arc.ty)) add('arcs', 'error', arc.b, [arc.id], 'Дуга не связана ни с одной нотой');
      if (arc.mu < 0.1 || arc.mu > 1.5 || ((arc.tmu < 0.1 || arc.tmu > 1.5) && arc.tc !== 8)) add('arcs', 'warn', arc.b, [arc.id], 'Сила изгиба дуги вне 0,1–1,5 (SS)');
    }
  }
  if (on('chains') && objects.chains.length > 0) add('chains', 'info', objects.chains[0]!.b, objects.chains.map((chain) => chain.id), `Цепей: ${String(objects.chains.length)} — ScoreSaber не ранкает карты с цепями (BeatLeader — да)`);

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
    if (begin < 1.5) add('hotStart', 'error', first.b, [first.id], `Горячий старт: первый объект на ${fmt(begin)} (SS: от 1,5 с, BL: от 1,33 с)`);
    else if (begin < 2) add('hotStart', 'warn', first.b, [first.id], `Первый объект на ${fmt(begin)} — BSMG советует от 2 с`);
    const tail = input.songSeconds - sec(last.end);
    if (tail < 2) add('coldEnd', 'error', last.end, [last.id], `Холодный конец: после последнего объекта ${fmt(Math.max(0, tail))} (нужно от 2 с)`);
    else if (tail > 15) add('longOutro', 'info', last.end, [last.id], `После последнего объекта ещё ${fmt(tail)} — SS требует меньше 15 с без нот и света`);
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
    if (count > CAP) issues.push({ rule, level: 'info', beat: issues.find((issue) => issue.rule === rule)?.beat ?? 0, ids: [], text: `…и ещё ${String(count - CAP)} таких же` });
  }
  return issues.sort((a, b) => a.beat - b.beat);
}
