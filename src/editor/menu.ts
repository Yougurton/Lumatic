/**
 * Small pieces of UI the editor needs and the desktop window doesn't give: a context menu and a
 * one-line question (Electron has no `prompt`).
 */

export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  /** Shown as a heading over the items after it. */
  heading?: boolean;
  hint?: string;
}

let open: HTMLElement | null = null;

export function closeMenu() {
  open?.remove();
  open = null;
}

window.addEventListener('mousedown', (event) => {
  if (open !== null && !open.contains(event.target as Node)) closeMenu();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
window.addEventListener('blur', () => closeMenu());

export function showMenu(x: number, y: number, items: (MenuItem | null)[]) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'ce-menu';
  for (const item of items) {
    if (item === null) {
      const line = document.createElement('div');
      line.className = 'ce-menu-sep';
      menu.append(line);
      continue;
    }
    const entry = document.createElement(item.heading === true ? 'div' : 'button');
    entry.className = item.heading === true ? 'ce-menu-heading' : 'ce-menu-item';
    entry.textContent = item.label;
    if (item.hint !== undefined) {
      const hint = document.createElement('span');
      hint.className = 'ce-menu-hint';
      hint.textContent = item.hint;
      entry.append(hint);
    }
    if (entry instanceof HTMLButtonElement) {
      entry.disabled = item.disabled === true;
      entry.addEventListener('click', () => {
        closeMenu();
        item.action?.();
      });
    }
    menu.append(entry);
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${String(Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)))}px`;
  menu.style.top = `${String(Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)))}px`;
  open = menu;
}

/** A small panel of controls by a point (closes like a menu: a click outside it, Esc). */
export function showPanel(x: number, y: number, content: HTMLElement) {
  closeMenu();
  const panel = document.createElement('div');
  panel.className = 'ce-menu ce-panel';
  panel.append(content);
  document.body.append(panel);
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${String(Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)))}px`;
  panel.style.top = `${String(Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)))}px`;
  open = panel;
}

/** Asks for one line of text (null: cancelled). */
export function ask(title: string, value = ''): Promise<string | null> {
  closeMenu();
  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'ce-shade';
    const box = document.createElement('form');
    box.className = 'ce-dialog';
    const label = document.createElement('div');
    label.className = 'ce-dialog-title';
    label.textContent = title;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    const buttons = document.createElement('div');
    buttons.className = 'ce-dialog-buttons';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.textContent = 'OK';
    ok.className = 'primary';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Отмена';
    buttons.append(cancel, ok);
    box.append(label, input, buttons);
    shade.append(box);
    document.body.append(shade);
    input.focus();
    input.select();
    const finish = (result: string | null) => {
      shade.remove();
      resolve(result);
    };
    box.addEventListener('submit', (event) => {
      event.preventDefault();
      finish(input.value.trim() === '' ? null : input.value.trim());
    });
    cancel.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') finish(null);
    });
  });
}
