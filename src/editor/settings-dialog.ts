import type { Editor } from './editor';
import { checkUpdates } from './updates';
import { tr } from './i18n';
import { hotkeysDialog } from './hotkeys-dialog';
import { DEFAULT_SETTINGS, setSettings, settings, type Settings } from './settings';
import { oggQualitySlider } from './grids';
import { CHECK_RULES, CHECK_SOURCES, rulesOf, type CheckRule, type CheckSource } from './checks';

/**
 * "Settings": the language, pasting, the 3D view, the timeline, the sound, saving — and the hotkeys'
 * own window. A change applies at once (and is kept); the language and the floor's reflections after
 * the editor starts again — `restart` is asked to, when it can be done now.
 */

type Section = 'general' | 'view' | 'timeline' | 'sound' | 'checks' | 'saving' | 'about';

const SECTIONS: [Section, string][] = [
  ['general', 'Язык и вставка'],
  ['view', 'Вид и 3D'],
  ['timeline', 'Таймлайн'],
  ['sound', 'Звук'],
  ['checks', 'Проверка карты'],
  ['saving', 'Сохранение'],
  ['about', 'О редакторе'],
];

const GRIDS: [string, number][] = [
  ['1', 1],
  ['1/2', 0.5],
  ['1/4', 0.25],
  ['1/8', 0.125],
  ['1/16', 0.0625],
];

let lastSection: Section = 'general';

export function settingsDialog(restart: () => void, editorRef: Editor) {
  const shade = document.createElement('div');
  shade.className = 'ce-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog settings-dialog';
  const title = Object.assign(document.createElement('div'), { className: 'ce-dialog-title', textContent: 'Настройки' });
  const tabs = document.createElement('div');
  tabs.className = 'set-tabs';
  const body = document.createElement('div');
  body.className = 'set-body';
  const main = document.createElement('div');
  main.className = 'set-main';
  body.append(tabs, main);
  const note = Object.assign(document.createElement('div'), { className: 'nm-dim set-restart' });
  const buttons = document.createElement('div');
  buttons.className = 'ce-dialog-buttons';
  const reset = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Всё по умолчанию' });
  const gap = Object.assign(document.createElement('span'), { className: 'adjust-gap' });
  const close = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: 'Готово' });
  buttons.append(reset, gap, close);
  box.append(title, body, note, buttons);
  shade.append(box);
  document.body.append(shade);

  // what was in place when the window opened: the language and the reflections need a restart
  const started = { language: settings().language, mirror: settings().mirror };
  const needsRestart = () => settings().language !== started.language || settings().mirror !== started.mirror;
  const showRestart = () => {
    note.replaceChildren();
    if (!needsRestart()) return;
    note.append('Язык и отражения поменяются после перезапуска редактора. ');
    const now = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Перезапустить сейчас' });
    now.addEventListener('click', () => {
      done();
      restart();
    });
    note.append(now);
  };

  const change = (patch: Partial<Settings>) => {
    setSettings(patch);
    showRestart();
  };

  // ----- the pieces a section is made of
  const row = (label: string, control: HTMLElement, hint?: string) => {
    const line = document.createElement('div');
    line.className = 'set-row';
    const name = Object.assign(document.createElement('div'), { className: 'set-name', textContent: label });
    line.append(name, control);
    if (hint !== undefined) line.append(Object.assign(document.createElement('div'), { className: 'nm-dim set-hint', textContent: hint }));
    return line;
  };
  const choice = <T,>(options: [string, T, string?][], get: () => T, set: (value: T) => void) => {
    const holder = document.createElement('span');
    holder.className = 'steps-buttons';
    const draw = () =>
      holder.replaceChildren(
        ...options.map(([label, value, hint]) => {
          const item = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
          if (hint !== undefined) item.title = hint;
          item.classList.toggle('active', get() === value);
          item.addEventListener('click', () => {
            set(value);
            draw();
          });
          return item;
        }),
      );
    draw();
    return holder;
  };
  const check = (label: string, get: () => boolean, set: (on: boolean) => void) => {
    const wrap = document.createElement('label');
    wrap.className = 'adjust-check';
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: get() });
    input.addEventListener('change', () => set(input.checked));
    wrap.append(input, ` ${label}`);
    return wrap;
  };
  const slider = (min: number, max: number, step: number, get: () => number, set: (value: number) => void, shown: (value: number) => string) => {
    const wrap = document.createElement('span');
    wrap.className = 'set-slider';
    const input = Object.assign(document.createElement('input'), { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) });
    const value = Object.assign(document.createElement('span'), { className: 'ins-value', textContent: shown(get()) });
    input.addEventListener('input', () => {
      value.textContent = shown(Number(input.value));
      set(Number(input.value));
    });
    wrap.append(input, value);
    return wrap;
  };
  const number = (min: number, max: number, step: number, get: () => number, set: (value: number) => void) => {
    const input = Object.assign(document.createElement('input'), { type: 'number', min: String(min), max: String(max), step: String(step), value: String(get()) });
    input.className = 'set-number';
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (Number.isFinite(value)) set(Math.min(max, Math.max(min, value)));
      input.value = String(get());
    });
    return input;
  };
  const percent = (value: number) => `${String(Math.round(value * 100))}%`;

  const sections: Record<Section, () => HTMLElement[]> = {
    general: () => [
      row('Язык', choice<Settings['language']>([['Русский', 'ru'], ['English', 'en']], () => settings().language, (value) => change({ language: value }))),
      row(
        'Ctrl+V вставляет',
        choice<Settings['paste']>(
          [
            ['В свои строки', 'own', 'Каждое событие — в строку, откуда его скопировали'],
            ['В строку под мышью', 'row', 'В строку под мышью (несколько скопированных строк — с неё вниз); если мышь не над таймлайном — в выбранную строку'],
          ],
          () => settings().paste,
          (value) => change({ paste: value }),
        ),
      ),
      row(
        'На какую долю',
        choice<Settings['pasteAt']>(
          [
            ['У курсора песни', 'cursor'],
            ['Под мышью', 'mouse', 'Где мышь на таймлайне (если она не над ним — у курсора песни)'],
          ],
          () => settings().pasteAt,
          (value) => change({ pasteAt: value }),
        ),
        'Правый клик по пустому месту таймлайна по-прежнему даёт выбрать: в строку под мышью или как было.',
      ),
      row('Горячие клавиши', Object.assign(document.createElement('button'), { type: 'button', textContent: '⌨ Назначить…', onclick: () => void hotkeysDialog() })),
      row(
        'Обновления',
        (() => {
          const box = document.createElement('div');
          box.className = 'steps-buttons';
          const ask = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Проверить сейчас' });
          ask.addEventListener('click', () => void checkUpdates(editorRef, true));
          box.append(check(' Проверять при запуске', () => settings().checkUpdates, (on) => change({ checkUpdates: on })), ask);
          return box;
        })(),
        tr('Версия {0}. Новая версия скачивается и ставится сама, с описанием изменений.', __APP_VERSION__),
      ),
    ],
    view: () => [
      row(
        'Отражения на полу',
        choice<Settings['mirror']>(
          [
            ['Нет', 'none'],
            ['Низкие', 'low'],
            ['Средние', 'medium'],
            ['Высокие', 'high'],
          ],
          () => settings().mirror,
          (value) => change({ mirror: value }),
        ),
        'Выше — красивее, но тяжелее для видеокарты. Меняется после перезапуска.',
      ),
      check('Платформа игрока', () => settings().platform, (on) => change({ platform: on })),
      check('Искажения экрана (жар и т. п., как в игре)', () => settings().distortion, (on) => change({ distortion: on })),
      check('Счётчик кадров (FPS) в углу 3D-вида', () => settings().fps, (on) => change({ fps: on })),
      check('Ноты, бомбы и стены карты', () => settings().notes, (on) => change({ notes: on })),
      check('Красная линия видимости на дорожке нот (половина времени подлёта)', () => settings().visionLine, (on) => change({ visionLine: on })),
      row(
        'Тиков колец в секунду',
        choice<number>(
          [
            ['30.6 — как в игре', 30.6, 'Измерено в игре: волна с prop 0.05 проходит кольцо за 0,653 с'],
            ['50 — шаг Unity', 50, 'Обычный шаг физики Unity (0,02 с)'],
          ],
          () => settings().ringTicks,
          (value) => change({ ringTicks: value }),
        ),
        'Как часто игра двигает кольца: каждый тик волна событий колец проходит prop колец, а кольцо подходит к своему углу. По этому считаются и кольца в окне просмотра, и события колец, которые делает редактор (позы, пружина, ступени).',
      ),
      row('Масштаб окна', slider(0.7, 1.5, 0.05, () => settings().uiScale, (value) => change({ uiScale: value }), percent), 'Весь интерфейс крупнее или мельче (в приложении для компьютера).'),
    ],
    timeline: () => [
      row(
        'Колесо мыши',
        choice<Settings['wheel']>(
          [
            ['Листает песню', 'time'],
            ['Двигает курсор по сетке', 'cursor', 'Как в ChroMapper: шаг сетки за щелчок колеса, вверх — дальше по песне'],
          ],
          () => settings().wheel,
          (value) => change({ wheel: value }),
        ),
        'Shift+колесо — строки, Ctrl+колесо — масштаб, Alt+колесо — сетка: так при любом выборе.',
      ),
      row('Скорость колеса', slider(0.25, 3, 0.25, () => settings().wheelSpeed, (value) => change({ wheelSpeed: value }), (value) => `${String(value)}×`)),
      check('Таймлайн следует за курсором при воспроизведении', () => settings().follow, (on) => change({ follow: on })),
      row('Сетка при открытии карты', choice<number>(GRIDS, () => settings().grid, (value) => change({ grid: value }))),
    ],
    sound: () => [
      row('Громкость песни', slider(0, 1, 0.05, () => settings().volume, (value) => change({ volume: value }), percent)),
      row(
        'Задержка звука, мс',
        number(-500, 500, 5, () => settings().latency, (value) => change({ latency: value })),
        'Если свет в окне просмотра опережает музыку (наушники Bluetooth, звуковая карта), прибавьте: курсор и свет подождут звук.',
      ),
      check('Метроном при воспроизведении', () => settings().metronome, (on) => change({ metronome: on })),
      check('Щелчок на событиях выбранной строки', () => settings().eventClicks, (on) => change({ eventClicks: on })),
      check('Удар на каждой ноте (вкладка «Ноты»)', () => settings().noteHits, (on) => change({ noteHits: on })),
      row('Громкость ударов нот', slider(0, 1, 0.05, () => settings().noteHitVolume, (value) => change({ noteHitVolume: value }), percent)),
      row('Громкость щелчков', slider(0, 1, 0.05, () => settings().clickVolume, (value) => change({ clickVolume: value }), percent)),
    ],
    checks: () => {
      const groups: [CheckRule['group'], string][] = [
        ['notes', 'Ноты'],
        ['bombs', 'Бомбы'],
        ['walls', 'Стены'],
        ['arcs', 'Дуги и цепи'],
        ['timing', 'Начало, конец, скорость'],
        ['situational', 'Ситуативные паттерны BSMG (можно, но осторожно)'],
      ];
      const boxes: HTMLInputElement[] = [];
      const set = (id: string, on: boolean) => {
        const off = new Set(settings().disabledChecks);
        if (on) off.delete(id);
        else off.add(id);
        change({ disabledChecks: [...off] });
      };
      const all = (on: boolean) => {
        change({ disabledChecks: on ? [] : CHECK_RULES.map((rule) => rule.id) });
        for (const box of boxes) box.checked = on;
      };
      const out: HTMLElement[] = [
        Object.assign(document.createElement('div'), {
          className: 'nm-dim',
          textContent: 'Что проверять в нотах на вкладке «Ноты»: ошибки и предупреждения видны в панели справа и метками над дорожками таймлайна. Правила — из руководства BSMG и критериев рейтинга BeatLeader (BL) и ScoreSaber (SS).',
        }),
      ];
      // presets: whose criteria — their rules ticked, their thresholds used
      const presets: [CheckSource, string, string][] = [
        ['BSMG', 'BSMG', 'Советы руководства BSMG (bsmg.wiki)'],
        ['BL', 'BeatLeader', 'Критерии рейтинга BeatLeader'],
        ['SS', 'ScoreSaber', 'Критерии рейтинга ScoreSaber'],
      ];
      const presetRow = document.createElement('span');
      presetRow.className = 'steps-buttons';
      const drawPresets = () =>
        presetRow.replaceChildren(
          ...presets.map(([id, label, hint]) => {
            const button = Object.assign(document.createElement('button'), { type: 'button', textContent: `${settings().checkSources.includes(id) ? '☑' : '☐'} ${label}`, title: `${hint}. Можно выбрать несколько.` });
            button.classList.toggle('active', settings().checkSources.includes(id));
            button.addEventListener('click', () => {
              const now = new Set(settings().checkSources);
              if (now.has(id)) now.delete(id);
              else now.add(id);
              if (now.size === 0) return;
              const sources = CHECK_SOURCES.filter((source) => now.has(source));
              const wanted = new Set(rulesOf(sources));
              change({ checkSources: sources, disabledChecks: CHECK_RULES.filter((rule) => !wanted.has(rule.id)).map((rule) => rule.id) });
              for (const box of boxes) box.checked = wanted.has(box.dataset.rule ?? '');
              drawPresets();
            });
            return button;
          }),
        );
      drawPresets();
      out.push(row('Критерии', presetRow, 'Отметьте один или несколько сайтов: включатся их правила, а где пороги разные (hot start, бомбы, длина стен) — берётся самый строгий из выбранных. Отдельные правила можно снять ниже.'));
      const buttons = document.createElement('div');
      buttons.className = 'steps-buttons';
      const on = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Включить все' });
      const off = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Выключить все' });
      on.addEventListener('click', () => {
        all(true);
        drawPresets();
      });
      off.addEventListener('click', () => {
        all(false);
        drawPresets();
      });
      buttons.append(on, off);
      out.push(buttons);
      for (const [group, title] of groups) {
        out.push(Object.assign(document.createElement('div'), { className: 'set-checks-group', textContent: title }));
        for (const rule of CHECK_RULES.filter((item) => item.group === group)) {
          const line = document.createElement('label');
          line.className = 'set-check-rule';
          const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !settings().disabledChecks.includes(rule.id) });
          box.dataset.rule = rule.id;
          box.addEventListener('change', () => {
            set(rule.id, box.checked);
            drawPresets();
          });
          boxes.push(box);
          line.append(box, Object.assign(document.createElement('span'), { textContent: rule.name }), Object.assign(document.createElement('em'), { textContent: rule.source }), Object.assign(document.createElement('small'), { textContent: rule.about }));
          out.push(line);
        }
      }
      return out;
    },
    about: () => [aboutPage()],
    saving: () => [
      row(
        'Автосохранение',
        choice<number>(
          [
            ['Нет', 0],
            ['1 мин', 1],
            ['3 мин', 3],
            ['5 мин', 5],
            ['10 мин', 10],
          ],
          () => settings().autosave,
          (value) => change({ autosave: value }),
        ),
        'Карта сохраняется сама, если в ней есть несохранённые изменения и не открыто никакое окно.',
      ),
      row(
        'Автокопии на случай сбоя',
        Object.assign(document.createElement('span'), { className: 'nm-dim', textContent: 'каждые 2 минуты' }),
        'Несохранённые изменения раз в 2 минуты копируются в «Lumatic backups/autosave» (сама карта не меняется; хранятся 10 последних). Если Lumatic закрылся или завис, не сохранив, при следующем открытии карта предложит их вернуть.',
      ),
      ...(window.chroeditorNative?.openLogs === undefined
        ? []
        : [
            row(
              'Журнал',
              Object.assign(document.createElement('button'), {
                type: 'button',
                textContent: 'Открыть папку журнала',
                onclick: () => void window.chroeditorNative?.openLogs?.(),
              }),
              'Ошибки, зависания и падения окна записываются в журнал (по файлу на день, 14 последних) — его можно приложить к рассказу о сбое.',
            ),
          ]),
      row(
        'Резервные копии',
        choice<number>(
          [
            ['Нет', 0],
            ['3', 3],
            ['5', 5],
            ['10', 10],
            ['20', 20],
          ],
          () => settings().backups,
          (value) => change({ backups: value }),
        ),
        'Перед каждым сохранением прежний файл сложности копируется в папку «Lumatic backups» рядом с картой; хранится столько последних копий.',
      ),
      row('Качество песни (ogg)', oggQualitySlider(settings().oggQuality, (quality) => change({ oggQuality: quality })), 'Для новой карты и когда песня переделывается (тишина в начале): Ogg Vorbis, выше — лучше звук и больше файл.'),
      row(
        'Формат новых карт',
        choice<Settings['newFormat']>(
          [
            ['v3', '3', 'Современный формат (рекомендуется)'],
            ['v2', '2', 'Старый формат — для старых модов и редакторов'],
          ],
          () => settings().newFormat,
          (value) => change({ newFormat: value }),
        ),
      ),
    ],
  };

  let section = lastSection;
  const draw = () => {
    lastSection = section;
    tabs.replaceChildren(
      ...SECTIONS.map(([id, label]) => {
        const tab = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
        tab.classList.toggle('active', id === section);
        tab.addEventListener('click', () => {
          section = id;
          draw();
        });
        return tab;
      }),
    );
    main.replaceChildren(...sections[section]());
  };
  draw();
  showRestart();

  reset.addEventListener('click', () => {
    if (!window.confirm('Вернуть все настройки по умолчанию? Горячие клавиши останутся как есть.')) return;
    setSettings({ ...DEFAULT_SETTINGS, language: settings().language });
    draw();
    showRestart();
  });
  const done = () => {
    shade.remove();
    window.removeEventListener('keydown', keys, true);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && document.querySelector('.keys-dialog') === null) {
      event.stopPropagation();
      done();
    }
  };
  window.addEventListener('keydown', keys, true);
  close.addEventListener('click', done);
  shade.addEventListener('mousedown', (event) => {
    if (event.target === shade) done();
  });
}

/** "About": the editor's name and version, who makes it, and whose work it stands on. */
function aboutPage(): HTMLElement {
  const page = document.createElement('div');
  page.className = 'about';
  const logo = document.createElement('img');
  logo.className = 'about-logo';
  logo.src = 'lumatic-wordmark.svg';
  logo.alt = 'Lumatic';
  const version = Object.assign(document.createElement('div'), { className: 'about-version', textContent: tr('Версия {0} beta', __APP_VERSION__) });
  const author = document.createElement('div');
  author.className = 'about-line';
  author.append(Object.assign(document.createElement('span'), { className: 'nm-dim', textContent: 'Разработчик Lumatic: ' }), Object.assign(document.createElement('b'), { textContent: 'Yougurton' }));
  const heading = (text: string) => Object.assign(document.createElement('div'), { className: 'about-heading', textContent: text });
  const link = (text: string, url: string) => Object.assign(document.createElement('a'), { textContent: text, href: url, target: '_blank', rel: 'noreferrer' });
  const item = (...parts: (string | HTMLElement)[]) => {
    const line = document.createElement('li');
    line.append(...parts);
    return line;
  };
  const thanks = document.createElement('ul');
  thanks.className = 'about-list';
  thanks.append(
    item('Разработчикам ', link('ChroViewer', 'https://github.com/Umbranoxio/chroviewer'), ' за просмотр карт, на котором построен 3D-вид Lumatic, и данные окружений игры.'),
  );
  const environments = document.createElement('ul');
  environments.className = 'about-list';
  environments.append(
    item(Object.assign(document.createElement('b'), { textContent: 'MadChase' }), ' — ', link('ChaseEnvs', 'https://github.com/MadChase/ChaseEnvs'), ' (MIT)'),
    item(Object.assign(document.createElement('b'), { textContent: 'Phøenix' }), ' — ', link('BSCEL', 'https://github.com/Phoenix-BS/BSCEL'), ' (MIT)'),
    item(Object.assign(document.createElement('b'), { textContent: 'Lonely' }), ' — ', link("Lonely's Chroma Environments", 'https://github.com/LonelyCen/Chroma-Environments'), '; ', 'BTS Witch Edit — Fatalution'),
  );
  // the licence: GPL-2.0, as ChroViewer's it's built on; the source code where it's kept
  const licence = document.createElement('p');
  licence.className = 'about-note';
  licence.append(
    tr('Lumatic — свободная программа под лицензией GNU GPL версии 2 (как ChroViewer, на котором она построена): её можно запускать, изучать, менять и распространять на тех же условиях. Исходный код:'),
    ' ',
    link('github.com/Yougurton/ChroEditor', 'https://github.com/Yougurton/ChroEditor'),
    tr('. Текст лицензии — LICENSE.txt рядом с программой, сторонние компоненты и их лицензии — THIRD_PARTY_NOTICES.md.'),
  );
  page.append(logo, version, author, heading('Спасибо'), thanks, heading('Готовые окружения'), environments, heading('Лицензия'), licence);
  return page;
}
