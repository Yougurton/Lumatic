/** What the event types are called on the timeline (the classic names; the environment decides
 *  what each group actually is, ChroMapper names them the same way). */
const LIGHT_NAMES: Record<number, string> = {
  0: 'Задние лазеры',
  1: 'Свет колец',
  2: 'Левые лазеры',
  3: 'Правые лазеры',
  4: 'Центральный свет',
  6: 'Доп. свет 6',
  7: 'Доп. свет 7',
  10: 'Доп. свет 10',
  11: 'Доп. свет 11',
};

const OTHER_NAMES: Record<number, string> = {
  5: 'Буст цветов',
  8: 'Вращение колец',
  9: 'Зум колец',
  12: 'Скорость левых лазеров',
  13: 'Скорость правых лазеров',
  14: 'Поворот (ранний)',
  15: 'Поворот (поздний)',
  16: 'Утилита 16',
  17: 'Утилита 17',
  18: 'Утилита 18',
  19: 'Утилита 19',
  40: 'Спец. 40',
  41: 'Спец. 41',
  42: 'Спец. 42',
  43: 'Спец. 43',
  100: 'BPM',
};

export function lightGroupName(type: number) {
  return LIGHT_NAMES[type] ?? `Свет ${String(type)}`;
}

export function otherEventName(type: number) {
  return OTHER_NAMES[type] ?? `События ${String(type)}`;
}

/** A colour per light group for the mini map and the headers. */
export function groupHue(type: number) {
  const hues: Record<number, number> = { 0: 200, 1: 280, 2: 340, 3: 30, 4: 120, 6: 60, 7: 170, 10: 250, 11: 90 };
  return hues[type] ?? (type * 47) % 360;
}
