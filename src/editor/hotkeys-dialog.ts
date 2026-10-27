import { ACTIONS, bindings, comboOf, keyLabel, setBindings } from './hotkeys';

/**
 * "Keys": every action with its keys; a key clicked waits for the new one, "+" adds one more, "×"
 * takes it off. A key another action had moves over to this one (that one is told).
 */
export function hotkeysDialog(): Promise<void> {
  const keys = bindings();
  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'ce-shade';
    const box = document.createElement('div');
    box.className = 'ce-dialog keys-dialog';
    box.innerHTML = `
      <div class="ce-dialog-title">Горячие клавиши</div>
      <div class="nm-dim">Клик по клавише — нажмите новую (Esc — отмена). Отмеченные ◆ — как в ChroMapper. Клавиши — по месту на клавиатуре, раскладка не важна.</div>
      <div class="keys-list" data-id="list"></div>
      <div class="nm-dim" data-id="status"></div>
      <div class="ce-dialog-buttons"><button type="button" data-id="reset">Как было по умолчанию</button><span class="adjust-gap"></span><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="save">Сохранить</button></div>`;
    shade.append(box);
    document.body.append(shade);
    const el = <T extends HTMLElement>(id: string) => box.querySelector<T>(`[data-id="${id}"]`)!;
    const status = el<HTMLElement>('status');
    /** Waiting for a key: for which action, in place of which key (null: an added one). */
    let waiting: { id: string; old: string | null } | null = null;

    const render = () => {
      const list = el<HTMLElement>('list');
      list.replaceChildren();
      let group = '';
      for (const action of ACTIONS) {
        if (action.group !== group) {
          group = action.group;
          list.append(Object.assign(document.createElement('div'), { className: 'keys-group', textContent: group }));
        }
        const row = document.createElement('div');
        row.className = 'keys-row';
        row.append(Object.assign(document.createElement('span'), { className: 'keys-name', textContent: `${action.label}${action.chromapper === true ? ' ◆' : ''}` }));
        const chips = document.createElement('span');
        chips.className = 'keys-chips';
        for (const combo of keys[action.id] ?? []) {
          const chip = document.createElement('span');
          chip.className = 'keys-chip';
          const name = document.createElement('button');
          name.type = 'button';
          const listening = waiting?.id === action.id && waiting.old === combo;
          name.textContent = listening ? 'Нажмите клавишу…' : keyLabel(combo);
          name.classList.toggle('active', listening);
          name.addEventListener('click', () => {
            waiting = { id: action.id, old: combo };
            render();
          });
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'keys-remove';
          remove.textContent = '×';
          remove.title = 'Убрать эту клавишу';
          remove.addEventListener('click', () => {
            keys[action.id] = (keys[action.id] ?? []).filter((item) => item !== combo);
            render();
          });
          chip.append(name, remove);
          chips.append(chip);
        }
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'keys-add';
        const adding = waiting?.id === action.id && waiting.old === null;
        add.textContent = adding ? 'Нажмите клавишу…' : '+';
        add.classList.toggle('active', adding);
        add.title = 'Добавить клавишу';
        add.addEventListener('click', () => {
          waiting = { id: action.id, old: null };
          render();
        });
        chips.append(add);
        row.append(chips);
        list.append(row);
      }
    };

    const listen = (event: KeyboardEvent) => {
      if (waiting === null) {
        if (event.key === 'Escape') {
          event.stopPropagation();
          finish();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape') {
        waiting = null;
        render();
        return;
      }
      const combo = comboOf(event);
      if (combo === null) return;
      const { id, old } = waiting;
      // (a key some other action had: it is this one's now)
      for (const action of ACTIONS) {
        if (action.id === id || !(keys[action.id] ?? []).includes(combo)) continue;
        keys[action.id] = keys[action.id]!.filter((item) => item !== combo);
        status.textContent = `${keyLabel(combo)} больше не «${action.label}»`;
      }
      const own = (keys[id] ?? []).filter((item) => item !== combo);
      if (old === null) own.push(combo);
      else own.splice(Math.max(0, (keys[id] ?? []).indexOf(old)), 0, combo);
      keys[id] = own.filter((item) => item !== old || old === combo);
      waiting = null;
      render();
    };
    window.addEventListener('keydown', listen, true);
    const finish = () => {
      window.removeEventListener('keydown', listen, true);
      shade.remove();
      resolve();
    };
    el('cancel').addEventListener('click', finish);
    el('save').addEventListener('click', () => {
      setBindings(keys);
      finish();
    });
    el('reset').addEventListener('click', () => {
      for (const action of ACTIONS) keys[action.id] = [...action.keys];
      status.textContent = 'Все клавиши — как по умолчанию (сохраните, чтобы оставить)';
      render();
    });
    render();
  });
}
