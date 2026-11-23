import { isPeriodic, motionParts, sortedKeys } from './env-anim';
import { expandObjects, isLightShader, type EnvironmentMods } from './environment-mods';

/**
 * What's wrong with the scene, and how heavy it is: things the game won't find, shapes in the way of the
 * notes, lamps with the same number, too many materials, a player moved in a way that makes people
 * sick — and how many objects, materials, lamps and animation events there are (a lot for Quest at some
 * point).
 */

export type SceneIssueLevel = 'error' | 'warn' | 'info';

export interface SceneIssue {
  level: SceneIssueLevel;
  /** Russian, with {0}… filled from `args` (translated as a whole). */
  text: string;
  args: (string | number)[];
  /** What it's about (a scene target: "o:<uid>", a game object's id, "m:<name>", "fog", "player"). */
  targets: string[];
}

export type LoadLevel = 'ok' | 'many' | 'heavy';

export interface LoadItem {
  name: string;
  value: number;
  level: LoadLevel;
}

export interface SceneCheckInput {
  mods: EnvironmentMods;
  /** The ids of the environment's objects (what Chroma can find). */
  knownIds: ReadonlySet<string>;
  /** The game's own lamps by event type. */
  gameLights: ReadonlyMap<number, readonly number[]>;
  /** How many events the scene writes into the map. */
  events: number;
  /** The difficulty's original Chroma entries, before the editor's fragment. */
  environmentEntries?: readonly Record<string, unknown>[];
}

/** Where the notes fly (Chroma's metres: x to the right, y up, z ahead): the lanes, the reach of the
 *  highest row, from just in front of the player well into the distance. */
export const NOTE_ZONE = { min: [-1.6, 0, 1], max: [1.6, 2.5, 20] };

const level = (value: number, many: number, heavy: number): LoadLevel => (value > heavy ? 'heavy' : value > many ? 'many' : 'ok');

export function checkScene(input: SceneCheckInput): { issues: SceneIssue[]; load: LoadItem[] } {
  const { mods, knownIds } = input;
  const issues: SceneIssue[] = [];
  const add = (issueLevel: SceneIssueLevel, text: string, targets: string[], ...args: (string | number)[]) => issues.push({ level: issueLevel, text, args, targets });
  const objects = mods.objects ?? [];
  const all = expandObjects(objects);
  const materials = mods.materials ?? {};

  // things the game won't find
  const missing = new Set<string>();
  const game = (target: string) => !target.startsWith('o:') && !target.startsWith('m:') && target !== 'fog' && target !== 'player';
  for (const edit of mods.scene ?? []) if (!knownIds.has(edit.id)) missing.add(edit.id);
  for (const anim of mods.anims ?? []) if (game(anim.target) && !knownIds.has(anim.target)) missing.add(anim.target);
  for (const motion of mods.motions ?? []) if (game(motion.target) && !knownIds.has(motion.target)) missing.add(motion.target);
  for (const link of mods.links ?? []) for (const target of [link.child, link.parent]) if (game(target) && !knownIds.has(target)) missing.add(target);
  for (const object of objects) if (object.kind === 'copy' && object.source !== undefined && !knownIds.has(object.source)) missing.add(object.source);
  for (const id of missing) add('error', 'Объекта {0} нет в этом окружении — его изменения, копии и анимация не сработают (окружение карты сменили?)', [id], id.split('.').pop() ?? id);

  for (const entry of input.environmentEntries ?? []) {
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (entry.position !== undefined && entry.localPosition !== undefined) add('warn', 'У записи {0} заданы и положение в мире, и своё: оставьте только одно из них', id === '' ? [] : [id], id);
    if (entry.rotation !== undefined && entry.localRotation !== undefined) add('warn', 'У записи {0} заданы и поворот в мире, и свой: оставьте только один из них', id === '' ? [] : [id], id);
  }

  // shapes in the way of the notes
  for (const object of all) {
    if (object.kind !== 'shape' || object.hidden === true) continue;
    const reach = 0.5 * Math.hypot(object.scale[0], object.scale[1], object.scale[2]);
    const near = [0, 1, 2].map((k) => Math.max(NOTE_ZONE.min[k]!, Math.min(NOTE_ZONE.max[k]!, object.position[k]!)));
    if (Math.hypot(object.position[0] - near[0]!, object.position[1] - near[1]!, object.position[2] - near[2]!) < reach) add('warn', '«{0}» стоит там, где летят ноты: он будет закрывать их игроку', [`o:${object.of ?? object.uid}`], object.name);
  }

  // materials
  const used = new Set(objects.flatMap((object) => (object.material === undefined ? [] : [object.material])));
  const count = Object.keys(materials).length;
  if (count > 30) add('warn', 'Материалов {0}: каждый — отдельная нагрузка, лучше использовать одни и те же', [], count);
  for (const name of Object.keys(materials)) if (!used.has(name)) add('info', 'Материал «{0}» не используется ни одним объектом (в карту он не пишется)', [`m:${name}`], name);

  // lamps
  const lamps = all.filter((object) => object.light !== undefined && object.material !== undefined && materials[object.material] !== undefined && isLightShader(materials[object.material]!.shader));
  const seen = new Map<string, string>();
  for (const lamp of lamps) {
    const key = `${String(lamp.light!.type)}:${String(lamp.light!.id)}`;
    const other = seen.get(key);
    if (other !== undefined && other !== (lamp.of ?? lamp.uid)) add('warn', 'У ламп «{0}» одинаковый номер {1} в одной группе света: события будут зажигать их вместе', [`o:${lamp.of ?? lamp.uid}`, `o:${other}`], lamp.name, lamp.light!.id);
    seen.set(key, lamp.of ?? lamp.uid);
    if ((input.gameLights.get(lamp.light!.type) ?? []).includes(lamp.light!.id)) add('warn', 'Номер лампы «{0}» ({1}) совпадает с лампой самого окружения: они будут гореть вместе', [`o:${lamp.of ?? lamp.uid}`], lamp.name, lamp.light!.id);
  }

  // the player
  const player = (mods.anims ?? []).find((anim) => anim.target === 'player');
  if (player !== undefined) {
    if ((player.keys.rotation ?? []).length > 0) add('warn', 'Игрок поворачивается: это почти всегда вызывает укачивание', ['player']);
    const moves = sortedKeys(player.keys.position);
    if (moves.some((key, at) => at > 0 && key.easing !== undefined && key.easing !== 'easeLinear')) add('warn', 'Игрок движется неравномерно (с плавностью): рывки вызывают укачивание', ['player']);
    for (let at = 1; at < moves.length; at++) {
      const [a, b] = [moves[at - 1]!, moves[at]!];
      const speed = Math.hypot(...b.value.map((value, k) => value - a.value[k]!)) / Math.max(1e-6, b.beat - a.beat);
      if (speed > 2) {
        add('warn', 'Игрок движется быстро: {0} м за долю (доли {1}–{2}). Больше 2 м за долю — тяжело переносится', ['player'], Math.round(speed * 10) / 10, a.beat, b.beat);
        break;
      }
    }
  }

  // blocks in place of keys
  for (const motion of mods.motions ?? []) {
    if (isPeriodic(motion)) continue;
    const keys = (mods.anims ?? []).find((anim) => anim.target === motion.target)?.keys;
    if (motionParts(motion).some((part) => (keys?.[part] ?? []).some((key) => key.beat > motion.start && key.beat < motion.end))) add('info', 'Внутри блока «следовать» или «зависит» есть ключи того же свойства: пока идёт блок, они не действуют', [motion.target]);
  }

  // mods
  if ((mods.links ?? []).length > 0 || (player !== undefined && sortedKeys(player.keys.position).length > 0)) add('info', 'Привязки и движение игрока работают с модом Noodle Extensions — требование в карту поставлено', []);

  const objectCount = (mods.scene ?? []).length + all.length;
  const load: LoadItem[] = [
    { name: 'объектов', value: objectCount, level: level(objectCount, 150, 400) },
    { name: 'материалов', value: count, level: level(count, 10, 30) },
    { name: 'ламп', value: lamps.length, level: level(lamps.length, 100, 300) },
    { name: 'событий', value: input.events, level: level(input.events, 400, 1500) },
  ];
  if (load.some((item) => item.level === 'heavy')) add('warn', 'Сцена тяжёлая для Quest: проверьте её на шлеме, если карта для него', []);
  return { issues, load };
}
