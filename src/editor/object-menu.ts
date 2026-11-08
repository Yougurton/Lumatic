import type { Editor } from './editor';
import { showMenu } from './menu';
import { noteSelectDialog } from './note-select-dialog';
import { mirrorObjects } from './notes-timeline';
import type { MapObjects, MapWall, ObjectKind } from './notes';

/**
 * A right click on an object of the notes side (on the timeline, the 3D track or the grid): one of
 * several selected — a menu (mirror, recolour, copy, paste, delete); a long wall on its own — a menu
 * that makes it a strobe; anything else — deleted at once, as in ChroMapper.
 */
export function objectRightClick(editor: Editor, clientX: number, clientY: number, found: { kind: ObjectKind; item: MapObjects[ObjectKind][number] }) {
  // (after the click's own mouse events: the menu would close on its own mousedown otherwise)
  setTimeout(() => rightClickNow(editor, clientX, clientY, found));
}

function rightClickNow(editor: Editor, clientX: number, clientY: number, found: { kind: ObjectKind; item: MapObjects[ObjectKind][number] }) {
  const id = found.item.id;
  const many = editor.noteSelection.size > 1 && editor.noteSelection.has(id);
  const step = editor.wallStrobe.step;
  const fraction = (value: number) => {
    const inverse = 1 / value;
    return Math.abs(inverse - Math.round(inverse)) < 1e-3 ? `1/${String(Math.round(inverse))}` : String(Math.round(value * 1000) / 1000);
  };
  if (many) {
    const count = editor.noteSelection.size;
    const coloured = editor.selectedObjects().some(({ item }) => 'c' in item);
    showMenu(clientX, clientY, [
      { label: `Выделено: ${String(count)}`, heading: true },
      { label: '⇋ Отзеркалить', hint: 'M', action: () => mirrorObjects(editor) },
      {
        label: '◐ Сменить цвет',
        disabled: !coloured,
        action: () =>
          editor.updateObjects(editor.noteSelection, (_kind, item) => {
            if ('c' in item) item.c = 1 - item.c;
          }),
      },
      { label: 'Выделить по условиям…', hint: 'вид, цвет, направление', action: () => noteSelectDialog(editor) },
      null,
      { label: 'Копировать', hint: 'Ctrl+C', action: () => editor.copyNotes() },
      { label: 'Вырезать', hint: 'Ctrl+X', action: () => editor.cutNotes() },
      { label: 'Вставить у курсора', hint: 'Ctrl+V', disabled: editor.notesClipboardSize() === 0, action: () => editor.pasteNotes(editor.snapBeat(editor.playhead())) },
      null,
      { label: '🗑 Удалить', hint: 'Delete', action: () => editor.deleteNoteSelection() },
    ]);
    return;
  }
  const wall = found.kind === 'walls' ? (found.item as MapWall) : null;
  if (wall !== null && wall.d >= step * 2 - 1e-6) {
    const fill = editor.wallStrobe.fill;
    showMenu(clientX, clientY, [
      { label: 'Стена', heading: true },
      {
        label: `⚡ Сделать строб (${fraction(step)}, ${String(Math.round(fill * 100))}%)`,
        hint: 'по всей длине',
        action: () => {
          editor.selectNotes([wall.id]);
          editor.strobeSelectedWalls(wall.b + wall.d, step, fill);
        },
      },
      ...[0.5, 0.25, 0.125]
        .filter((other) => Math.abs(other - step) > 1e-6 && wall.d >= other * 2 - 1e-6)
        .map((other) => ({
          label: `⚡ Строб ${fraction(other)}`,
          action: () => {
            editor.wallStrobe = { ...editor.wallStrobe, step: other };
            editor.selectNotes([wall.id]);
            editor.strobeSelectedWalls(wall.b + wall.d, other, fill);
          },
        })),
      null,
      { label: 'Копировать', hint: 'Ctrl+C', action: () => {
        editor.selectNotes([wall.id]);
        editor.copyNotes();
      } },
      {
        label: '🗑 Удалить',
        hint: 'Delete',
        action: () => {
          editor.selectNotes([wall.id]);
          editor.deleteNoteSelection();
        },
      },
    ]);
    return;
  }
  if (!editor.noteSelection.has(id) || editor.noteSelection.size !== 1) editor.selectNotes([id]);
  editor.deleteNoteSelection();
}
