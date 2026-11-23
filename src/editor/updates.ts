import type { Editor } from './editor';
import { tr } from './i18n';
import type { UpdateInfo } from './platform';
import { setSettings, settings } from './settings';

/**
 * Updates: the newest release of Lumatic asked about at the start (or by hand, in the settings); a
 * newer one — a window with what's new in it: update now (downloaded, the map saved, the app started
 * again in the new version), later, or skip that version. After an update: what's new shown once.
 */

const NOTES_KEY = 'lumatic.updateNotes';

/** A release's description (Markdown) as plain blocks: headings, points, lines. */
function notesElement(markdown: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'update-notes';
  const lines = markdown.replace(/\r/gu, '').split('\n');
  let list: HTMLUListElement | null = null;
  const plain = (text: string) => text.replace(/\*\*([^*]+)\*\*/gu, '$1').replace(/`([^`]+)`/gu, '$1').replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const point = /^\s*[-*•]\s+(.*)$/u.exec(line);
    if (point !== null) {
      list ??= box.appendChild(document.createElement('ul'));
      list.append(Object.assign(document.createElement('li'), { textContent: plain(point[1]!) }));
      continue;
    }
    list = null;
    if (line.trim() === '') continue;
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    box.append(Object.assign(document.createElement(heading !== null ? 'h4' : 'p'), { textContent: plain(heading !== null ? heading[1]! : line) }));
  }
  if (box.childElementCount === 0) box.append(Object.assign(document.createElement('p'), { className: 'nm-dim', textContent: tr('Описания изменений нет') }));
  return box;
}

/** A window of its own (Esc / the shade: closed). */
function dialog(title: string, body: HTMLElement[], buttons: HTMLElement[]) {
  const shade = document.createElement('div');
  shade.className = 'ce-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog update-dialog';
  const head = Object.assign(document.createElement('div'), { className: 'ce-dialog-title', textContent: title });
  const row = document.createElement('div');
  row.className = 'ce-dialog-buttons';
  row.append(...buttons);
  box.append(head, ...body, row);
  shade.append(box);
  document.body.append(shade);
  const close = () => {
    shade.remove();
    window.removeEventListener('keydown', keys, true);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', keys, true);
  return close;
}

const button = (text: string, primary = false) => Object.assign(document.createElement('button'), { type: 'button', textContent: text, className: primary ? 'primary' : '' });

/** The window about a newer version. */
function offer(editor: Editor, info: UpdateInfo) {
  const native = window.chroeditorNative?.updates;
  const status = Object.assign(document.createElement('div'), { className: 'nm-dim update-status' });
  const bar = Object.assign(document.createElement('progress'), { max: 1, value: 0, hidden: true, className: 'update-progress' });
  const intro = Object.assign(document.createElement('p'), { textContent: tr('Вышла новая версия Lumatic {0} (у вас {1}). Что в ней нового:', info.latest ?? '', info.current) });
  const page = Object.assign(document.createElement('a'), { href: info.page, target: '_blank', rel: 'noreferrer', textContent: tr('Страница релиза') });
  const now = button(tr('Обновить сейчас'), true);
  const later = button(tr('Позже'));
  const skip = button(tr('Пропустить эту версию'));
  const gap = Object.assign(document.createElement('span'), { className: 'adjust-gap' });
  const close = dialog(tr('Обновление Lumatic'), [intro, notesElement(info.notes), page, bar, status], [skip, gap, later, now]);
  later.addEventListener('click', close);
  skip.addEventListener('click', () => {
    setSettings({ skippedVersion: info.latest ?? '' });
    close();
  });
  void (async () => {
    const can = native !== undefined && info.asset !== null && (await native.canInstall());
    if (!can) {
      now.textContent = tr('Открыть страницу релиза');
      now.addEventListener('click', () => {
        window.open(info.page, '_blank');
        close();
      });
      if (info.asset === null) status.textContent = tr('В релизе нет архива для Windows — скачайте новую версию со страницы релиза.');
      return;
    }
    now.addEventListener('click', () => {
      void (async () => {
        for (const item of [now, later, skip]) item.disabled = true;
        try {
          bar.hidden = false;
          status.textContent = tr('Скачиваю…');
          await native.download(info.asset!.url, info.asset!.size, (done) => {
            bar.value = done;
            status.textContent = tr('Скачиваю… {0}%', Math.round(done * 100));
          });
          if (editor.dirty) {
            status.textContent = tr('Сохраняю карту…');
            await editor.save();
          }
          // (what's new: shown once the new version starts)
          try {
            localStorage.setItem(NOTES_KEY, JSON.stringify({ version: info.latest, notes: info.notes }));
          } catch {
            // (only a convenience)
          }
          status.textContent = tr('Перезапускаю в новой версии…');
          await native.install();
        } catch (error) {
          status.textContent = tr('Не получилось обновить: {0}', error instanceof Error ? error.message : String(error));
          for (const item of [now, later, skip]) item.disabled = false;
        }
      })();
    });
  })();
}

/**
 * Asks whether there's a newer version. `byHand`: asked in the settings — said either way (and a
 * skipped version offered again); else quiet unless there is one.
 */
export async function checkUpdates(editor: Editor, byHand = false): Promise<void> {
  const native = window.chroeditorNative?.updates;
  if (native === undefined) {
    if (byHand) window.alert(tr('Обновления проверяет приложение для компьютера'));
    return;
  }
  try {
    const info = await native.check();
    if (info.newer && (byHand || settings().skippedVersion !== info.latest)) offer(editor, info);
    else if (byHand) window.alert(info.latest === null ? tr('Релизов пока нет') : tr('У вас последняя версия ({0})', info.current));
  } catch (error) {
    console.warn('[lumatic] update check failed', error);
    if (byHand) window.alert(tr('Не удалось проверить обновления: {0}', error instanceof Error ? error.message : String(error)));
  }
}

/** At the start: what's new after an update (once), then — a few seconds on — a newer version asked about. */
export function startUpdates(editor: Editor) {
  try {
    const saved = localStorage.getItem(NOTES_KEY);
    if (saved !== null) {
      localStorage.removeItem(NOTES_KEY);
      const { version, notes } = JSON.parse(saved) as { version: string; notes: string };
      if (version === __APP_VERSION__) {
        const ok = button(tr('Готово'), true);
        const close = dialog(tr('Lumatic обновлён до {0}', version), [Object.assign(document.createElement('p'), { textContent: tr('Что нового:') }), notesElement(notes)], [ok]);
        ok.addEventListener('click', close);
      }
    }
  } catch {
    // (only a convenience)
  }
  if (settings().checkUpdates) window.setTimeout(() => void checkUpdates(editor), 5000);
}
