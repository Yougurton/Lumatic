/**
 * The keys: what each does, its keys by default (where ChroMapper has the same thing, its keys —
 * from its Master.inputactions), and the user's own (kept in this computer's storage). A key is its
 * place on the keyboard (`event.code`): Ctrl+Z is Ctrl+Z with a Russian layout too.
 */

export interface HotkeyAction {
  id: string;
  group: string;
  label: string;
  keys: string[];
  /** Also ChroMapper's keys. */
  chromapper?: boolean;
}

export const ACTIONS: HotkeyAction[] = [
  { id: 'play', group: 'Воспроизведение', label: 'Играть / пауза', keys: ['Space'], chromapper: true },
  { id: 'start', group: 'Воспроизведение', label: 'В начало песни', keys: ['Semicolon', 'Home'], chromapper: true },
  { id: 'back', group: 'Воспроизведение', label: 'Назад на шаг сетки', keys: ['Comma', 'ArrowLeft'], chromapper: true },
  { id: 'forward', group: 'Воспроизведение', label: 'Вперёд на шаг сетки', keys: ['Period', 'ArrowRight'], chromapper: true },
  { id: 'goto', group: 'Воспроизведение', label: 'Перейти к доле…', keys: ['KeyG'], chromapper: true },
  { id: 'faster', group: 'Воспроизведение', label: 'Скорость выше', keys: ['Equal'], chromapper: true },
  { id: 'slower', group: 'Воспроизведение', label: 'Скорость ниже', keys: ['Minus'], chromapper: true },
  { id: 'finer', group: 'Сетка и вид', label: 'Сетка мельче', keys: ['Ctrl+ArrowUp'] },
  { id: 'coarser', group: 'Сетка и вид', label: 'Сетка крупнее', keys: ['Ctrl+ArrowDown'] },
  { id: 'zoomIn', group: 'Сетка и вид', label: 'Приблизить таймлайн', keys: ['Alt+Equal'], chromapper: true },
  { id: 'zoomOut', group: 'Сетка и вид', label: 'Отдалить таймлайн', keys: ['Alt+Minus'], chromapper: true },
  { id: 'fit', group: 'Сетка и вид', label: 'Вся песня', keys: ['KeyF'] },
  { id: 'rowsUp', group: 'Сетка и вид', label: 'Строки вверх', keys: ['ArrowUp'] },
  { id: 'rowsDown', group: 'Сетка и вид', label: 'Строки вниз', keys: ['ArrowDown'] },
  { id: 'bookmark', group: 'Метки', label: 'Метка у курсора', keys: ['KeyB'], chromapper: true },
  { id: 'prevBookmark', group: 'Метки', label: 'К предыдущей метке', keys: ['BracketLeft', 'Ctrl+ArrowLeft'], chromapper: true },
  { id: 'nextBookmark', group: 'Метки', label: 'К следующей метке', keys: ['BracketRight', 'Ctrl+ArrowRight'], chromapper: true },
  { id: 'on', group: 'Кисть', label: 'Начало: включить', keys: ['KeyW'], chromapper: true },
  { id: 'flash', group: 'Кисть', label: 'Начало: вспышка', keys: ['KeyA'], chromapper: true },
  { id: 'fade', group: 'Кисть', label: 'Начало: угасание', keys: ['KeyD'], chromapper: true },
  { id: 'fadeIn', group: 'Кисть', label: 'Начало: нарастание (в ChroMapper — переход)', keys: ['KeyC'], chromapper: true },
  { id: 'left', group: 'Кисть', label: 'Цвет: левый (красный)', keys: ['Digit1'], chromapper: true },
  { id: 'right', group: 'Кисть', label: 'Цвет: правый (синий)', keys: ['Digit2'], chromapper: true },
  { id: 'white', group: 'Кисть', label: 'Цвет: белый', keys: ['Digit3'] },
  { id: 'undo', group: 'Правка', label: 'Отменить', keys: ['Ctrl+KeyZ'], chromapper: true },
  { id: 'redo', group: 'Правка', label: 'Вернуть', keys: ['Ctrl+KeyY', 'Ctrl+Shift+KeyZ'], chromapper: true },
  { id: 'copy', group: 'Правка', label: 'Копировать', keys: ['Ctrl+KeyC'], chromapper: true },
  { id: 'cut', group: 'Правка', label: 'Вырезать', keys: ['Ctrl+KeyX'], chromapper: true },
  { id: 'paste', group: 'Правка', label: 'Вставить у курсора', keys: ['Ctrl+KeyV'], chromapper: true },
  { id: 'duplicate', group: 'Правка', label: 'Дублировать', keys: ['Ctrl+KeyD'] },
  { id: 'delete', group: 'Правка', label: 'Удалить выделенное', keys: ['Delete', 'Backspace'], chromapper: true },
  { id: 'deselect', group: 'Правка', label: 'Снять выделение', keys: ['Ctrl+KeyA'], chromapper: true },
  { id: 'selectAll', group: 'Правка', label: 'Выделить всё', keys: [] },
  { id: 'mirror', group: 'Правка', label: 'Зеркально по строкам', keys: ['KeyM'], chromapper: true },
  { id: 'mirrorTime', group: 'Правка', label: 'Зеркально во времени', keys: ['Alt+KeyM'], chromapper: true },
  { id: 'adjust', group: 'Правка', label: 'Изменить свет выделенного…', keys: ['KeyH'] },
  { id: 'group', group: 'Правка', label: 'Группа из выбранных ламп', keys: ['Ctrl+KeyG'] },
  { id: 'preset', group: 'Правка', label: 'Сохранить выделенное как пресет', keys: ['Ctrl+Shift+KeyP'] },
  { id: 'save', group: 'Карта', label: 'Сохранить', keys: ['Ctrl+KeyS'], chromapper: true },
  { id: 'open', group: 'Карта', label: 'Открыть карту', keys: ['Ctrl+KeyO'] },
  { id: 'new', group: 'Карта', label: 'Новая карта', keys: ['Ctrl+KeyN'] },
];

const STORAGE = 'chroeditor.hotkeys';
let own: Record<string, string[]> = {};
try {
  own = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Record<string, string[]>;
} catch {
  own = {};
}

/** Each action's keys now (the user's where set). */
export function bindings(): Record<string, string[]> {
  return Object.fromEntries(ACTIONS.map((action) => [action.id, own[action.id] ?? action.keys]));
}

/** The user's keys (only the ones that differ from the defaults are kept). */
export function setBindings(next: Record<string, string[]>) {
  own = Object.fromEntries(Object.entries(next).filter(([id, keys]) => JSON.stringify(keys) !== JSON.stringify(ACTIONS.find((action) => action.id === id)?.keys)));
  try {
    localStorage.setItem(STORAGE, JSON.stringify(own));
  } catch {
    // (kept for this time only)
  }
}

const MODIFIERS = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

/** A key press as a key string ('Ctrl+Shift+KeyZ'); null for a modifier alone. */
export function comboOf(event: KeyboardEvent): string | null {
  if (MODIFIERS.has(event.code) || event.code === '') return null;
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.shiftKey ? 'Shift' : '', event.altKey ? 'Alt' : '', event.code].filter(Boolean).join('+');
}

/** The action a key string does (null: none). */
export function actionFor(combo: string): string | null {
  for (const [id, keys] of Object.entries(bindings())) if (keys.includes(combo)) return id;
  return null;
}

const NAMES: Record<string, string> = {
  Space: 'Пробел',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Semicolon: ';',
  Comma: ',',
  Period: '.',
  Equal: '=',
  Minus: '−',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Quote: "'",
  Slash: '/',
  Backslash: '\\',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Enter: 'Enter',
  Tab: 'Tab',
};

/** A key string as people read it ('Ctrl+Shift+Z'). */
export function keyLabel(combo: string) {
  return combo
    .split('+')
    .map((part) => NAMES[part] ?? part.replace(/^Key/u, '').replace(/^Digit/u, '').replace(/^Numpad/u, 'Num '))
    .join('+');
}
