import { language } from './i18n';

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

/** The environment's own names for its light groups (as its data has them), said in Russian. */
const TRACK_NAMES: Record<string, string> = {
  "Above Track X": "Крест над дорожкой",
  "Aurora 1": "Сияние 1",
  "Aurora 2": "Сияние 2",
  "Buildings": "Здания",
  "Door Light": "Свет двери",
  "Gate 1": "Ворота 1",
  "Gate 2": "Ворота 2",
  "Gate 3": "Ворота 3",
  "Gate 4": "Ворота 4",
  "Gate 5": "Ворота 5",
  "Inner Laser Left": "Внутренний лазер слева",
  "Inner Laser Right": "Внутренний лазер справа",
  "Lane Lights": "Свет дорожки",
  "Lane Lights Bottom": "Свет дорожки снизу",
  "Lane Lights Top": "Свет дорожки сверху",
  "Logo": "Логотип",
  "Perpendicular External Ring Lasers": "Лучи колец",
  "Ring Emitter Lights": "Излучатели колец",
  "Runway Left": "Полоса слева",
  "Runway Right": "Полоса справа",
  "Runway": "Взлётная полоса",
  "Sky Lasers": "Лазеры в небе",
  "Spike Tip Lights": "Свет кончиков шипов",
  "Spike Mid Lights": "Свет середины шипов",
  "Spike Left Lights": "Свет шипов слева",
  "Spike Right Lights": "Свет шипов справа",
  "Under Track": "Под дорожкой",
  "Under Track Pillars": "Столбы под дорожкой",
  "Under Track X": "Крест под дорожкой",
  "Under Track Lights": "Свет под дорожкой",
  "Water 1": "Вода 1",
  "Water 2": "Вода 2",
  "Water 3": "Вода 3",
  "Water 4": "Вода 4",
  "Wide Goal and Ceiling Lights": "Широкие ворота и потолок",
  "Wide Lights": "Широкий свет",
  "Area Lights": "Свет площадки",
  "Big Ring Lights": "Свет больших колец",
  "Ceiling Lasers": "Потолочные лазеры",
  "Ceiling Lights": "Потолочный свет",
  "Close Lights": "Ближний свет",
  "Internal Ring Lights": "Внутренние огни колец",
  "Large Woven Ring Lights": "Свет больших плетёных колец",
  "Moon": "Луна",
  "Ring Lights": "Свет колец",
  "Ring and Wide Lights": "Кольца и широкий свет",
  "Top Lanes and 1st Ring Set": "Верхние полосы и первые кольца",
  "Vertical Pillar Lights": "Свет столбов",
  "Bottom Laser and Left Tower": "Нижний лазер и левая башня",
  "Left Flags": "Флаги слева",
  "Left Lasers": "Левые лазеры",
  "Left Lasers and Galaxy": "Левые лазеры и галактика",
  "Left Lasers and Left Lane Light": "Левые лазеры и левая полоса",
  "Left Lasers and Lights": "Левые лазеры и свет",
  "Left Parallel Ring Lights": "Левые полоски колец",
  "Left Ring": "Левое кольцо",
  "Left Sun Beams": "Лучи солнца слева",
  "Outer Laser Left": "Внешний лазер слева",
  "Outer Laser Right": "Внешний лазер справа",
  "Tower 1 Lights": "Башня 1",
  "Tower 2 Lights": "Башня 2",
  "Tower 3 Lights": "Башня 3",
  "Tower 4 Lights": "Башня 4",
  "Tower 5 Lights": "Башня 5",
  "Tower 6 Lights": "Башня 6",
  "Right Flags": "Флаги справа",
  "Right Lasers": "Правые лазеры",
  "Right Lasers and Galaxy": "Правые лазеры и галактика",
  "Right Lasers and Lashers": "Правые лазеры и хлысты",
  "Right Lasers and Lights": "Правые лазеры и свет",
  "Right Lasers and Right Lane Light": "Правые лазеры и правая полоса",
  "Right Parallel Ring Lights": "Правые полоски колец",
  "Right Ring": "Правое кольцо",
  "Right Sun Beams": "Лучи солнца справа",
  "Top Laser and Right Tower": "Верхний лазер и правая башня",
  "Bottom Lanes and 2nd Ring Set": "Нижние полосы и вторые кольца",
  "Chevron": "Шеврон",
  "Distant Lasers and Spike Top Lights": "Дальние лазеры и верх шипов",
  "LP Logo": "Логотип LP",
  "Lane + Castle Interior": "Дорожка и замок внутри",
  "Lane and Above Track X Lights": "Дорожка и крест над ней",
  "Lane and Chevron Lights": "Дорожка и шеврон",
  "Lane and Field Lights": "Дорожка и поле",
  "Lane and Grenade Lights": "Дорожка и граната",
  "Lane and Small Goal Lights": "Дорожка и малые ворота",
  "Lane and Under Track X Lights": "Дорожка и крест под ней",
  "Lane and Wide Lights": "Дорожка и широкий свет",
  "Lane and Window Lights": "Дорожка и окна",
  "Player Place": "Платформа игрока",
  "Player Place & Spectrogram": "Платформа и спектрограмма",
  "PlayerPlace": "Платформа игрока",
  "Sun": "Солнце",
  "Top Square": "Верхний квадрат",
  "Ambient": "Фоновый свет",
  "Extra 1": "Доп. 1",
  "Extra 2": "Доп. 2",
  "Left Panel": "Левая панель",
  "Right Panel": "Правая панель",
  "Cherry Left": "Вишня слева",
  "Left Bottom Lasers": "Нижние лазеры слева",
  "Right Bottom Lasers": "Нижние лазеры справа",
  "Z": "Z",
};

/** The environment open now: what it calls each light group (event type). */
let environmentTracks = new Map<number, string>();

/** The environment's own names of its light groups (its data's event tracks). */
export function setEnvironmentTracks(tracks: readonly { name: string; type: number }[] | undefined) {
  environmentTracks = new Map((tracks ?? []).map((track) => [track.type, track.name]));
}

/** What a light group really is in this environment (its own name, in the editor's language), or
 *  null where it has none. */
export function environmentGroupName(type: number): string | null {
  const name = environmentTracks.get(type);
  if (name === undefined) return null;
  return language() === 'en' ? name : (TRACK_NAMES[name] ?? name);
}

/** A light group's name on the timeline: what the environment calls it, else the classic name. */
export function lightGroupName(type: number) {
  return environmentGroupName(type) ?? LIGHT_NAMES[type] ?? `Свет ${String(type)}`;
}

/** The classic name of a light group (the same in every environment). */
export function classicGroupName(type: number) {
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
