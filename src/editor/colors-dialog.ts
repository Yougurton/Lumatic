import type { Editor } from './editor';
import { colorsOf, paletteOf, readMapColors, schemeOf, suggestColors, type MapColors, type PaletteColor } from './map-colors';
import type { Rgb } from './model';

/**
 * "Map colours": the lights' left, right and white and their boost (and the notes' if asked) for the
 * whole map, written into Info.dat — or the environment's own. Colours from the cover suggested;
 * any of its main colours put into a field with a click. Tried in the 3D view as they change.
 */
export async function colorsDialog(editor: Editor): Promise<void> {
  const map = editor.map;
  const infoName = map?.folder.files.find((name) => name.toLowerCase() === 'info.dat');
  if (map === null || infoName === undefined) return;
  const written = readMapColors(await map.folder.readText(infoName));
  const environment = colorsOf(editor.preview.view.environmentColors());
  let colors: MapColors = written ?? { ...structuredClone(environment) };
  let custom = written !== null;
  let palette: PaletteColor[] = [];
  let variant = 0;

  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'ce-shade adjust-shade';
    const box = document.createElement('div');
    box.className = 'ce-dialog adjust-dialog colors-dialog';
    const field = (key: keyof MapColors, label: string) => `<label class="colors-field"><input type="color" data-key="${key}"> ${label}</label>`;
    box.innerHTML = `
      <div class="ce-dialog-title">Цвета карты</div>
      <label class="adjust-check"><input type="checkbox" data-id="custom"> Свои цвета карты (Info.dat, для всех сложностей)</label>
      <div class="colors-body" data-id="body">
        <div class="adjust-head">Свет</div>
        <div class="colors-row">${field('left', 'Левый')}${field('right', 'Правый')}${field('white', 'Белый')}</div>
        <div class="adjust-head">Буст (события буста цветов)</div>
        <div class="colors-row">${field('leftBoost', 'Левый')}${field('rightBoost', 'Правый')}${field('whiteBoost', 'Белый')}</div>
        <label class="adjust-check"><input type="checkbox" data-id="notes"> Менять и ноты со стенами</label>
        <div class="colors-row" data-id="note-row">${field('leftNote', 'Левые ноты')}${field('rightNote', 'Правые ноты')}${field('obstacle', 'Стены')}</div>
        <div class="adjust-head">Из обложки <span class="nm-dim">— клик по цвету ставит его в поле, выбранное последним</span></div>
        <div class="colors-cover"><img data-id="cover" alt=""><div class="colors-palette" data-id="palette"></div></div>
        <div class="nm-row"><button type="button" data-id="suggest">✨ Предложить цвета из обложки</button><button type="button" data-id="environment">Как у окружения</button></div>
      </div>
      <div class="nm-dim" data-id="status"></div>
      <div class="ce-dialog-buttons"><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="apply">Применить</button></div>`;
    shade.append(box);
    document.body.append(shade);
    const el = <T extends HTMLElement>(id: string) => box.querySelector<T>(`[data-id="${id}"]`)!;
    const status = el<HTMLElement>('status');
    const toHex = (rgb: Rgb) => `#${rgb.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('')}`;
    const fromHex = (text: string): Rgb => [1, 3, 5].map((at) => Number.parseInt(text.slice(at, at + 2), 16) / 255) as Rgb;
    const inputs = [...box.querySelectorAll<HTMLInputElement>('input[type="color"]')];
    let focused: keyof MapColors = 'left';

    const tryOut = () => editor.previewColors(custom ? schemeOf(colors) : 'environment');
    const show = () => {
      el<HTMLInputElement>('custom').checked = custom;
      el<HTMLInputElement>('notes').checked = colors.notes;
      for (const input of inputs) {
        input.value = toHex(colors[input.dataset.key as 'left']);
        input.parentElement!.classList.toggle('focused', input.dataset.key === focused);
      }
      el('body').classList.toggle('colors-off', !custom);
      el('note-row').hidden = !colors.notes;
    };
    for (const input of inputs) {
      const key = input.dataset.key as 'left';
      input.addEventListener('focus', () => {
        focused = key;
        show();
      });
      input.addEventListener('click', () => {
        focused = key;
        show();
      });
      input.addEventListener('input', () => {
        colors = { ...colors, [key]: fromHex(input.value) };
        custom = true;
        show();
        tryOut();
      });
    }
    el<HTMLInputElement>('custom').addEventListener('change', () => {
      custom = el<HTMLInputElement>('custom').checked;
      show();
      tryOut();
    });
    el<HTMLInputElement>('notes').addEventListener('change', () => {
      colors = { ...colors, notes: el<HTMLInputElement>('notes').checked };
      if (!colors.notes) colors = { ...colors, leftNote: environment.leftNote, rightNote: environment.rightNote, obstacle: environment.obstacle };
      show();
      tryOut();
    });
    el('environment').addEventListener('click', () => {
      colors = { ...structuredClone(environment), notes: colors.notes };
      show();
      tryOut();
    });

    // ----- the cover
    const cover = editor.cover();
    let url = '';
    const palettePlace = el<HTMLElement>('palette');
    const suggest = el<HTMLButtonElement>('suggest');
    suggest.disabled = true;
    if (cover === null) status.textContent = 'У карты нет обложки — цвета из неё не предложить.';
    else {
      url = URL.createObjectURL(cover);
      el<HTMLImageElement>('cover').src = url;
      void createImageBitmap(cover)
        .then((bitmap) => {
          const canvas = document.createElement('canvas');
          canvas.width = 96;
          canvas.height = 96;
          const context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0, 96, 96);
          palette = paletteOf(context.getImageData(0, 0, 96, 96).data, 10);
          for (const item of palette) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'colors-chip';
            chip.style.background = toHex(item.rgb);
            chip.title = `${toHex(item.rgb)} — ${String(Math.round(item.weight * 100))}% обложки`;
            chip.addEventListener('click', () => {
              colors = { ...colors, [focused]: item.rgb };
              custom = true;
              show();
              tryOut();
            });
            palettePlace.append(chip);
          }
          suggest.disabled = false;
        })
        .catch(() => (status.textContent = 'Обложку не удалось прочитать.'));
    }
    suggest.addEventListener('click', () => {
      const next = suggestColors(palette, variant++, colors.notes);
      colors = colors.notes ? next : { ...next, leftNote: environment.leftNote, rightNote: environment.rightNote, obstacle: environment.obstacle };
      custom = true;
      show();
      tryOut();
      status.textContent = `Вариант ${String(variant)} — ещё клик, и будет следующий`;
    });

    let busy = false;
    const finish = () => {
      if (url !== '') URL.revokeObjectURL(url);
      window.removeEventListener('keydown', keys, true);
      shade.remove();
      resolve();
    };
    const cancel = () => {
      if (busy) return;
      editor.previewColors(null);
      finish();
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', keys, true);
    el('cancel').addEventListener('click', cancel);
    el('apply').addEventListener('click', () => {
      if (busy) return;
      busy = true;
      status.textContent = 'Записываю Info.dat…';
      void editor
        .setMapColors(custom ? colors : null)
        .then(() => {
          editor.setStatus(custom ? 'Цвета карты записаны в Info.dat' : 'Цвета карты — как у окружения');
          finish();
        })
        .catch((error: unknown) => {
          status.textContent = `Не получилось: ${error instanceof Error ? error.message : String(error)}`;
          busy = false;
        });
    });
    show();
    tryOut();
  });
}
