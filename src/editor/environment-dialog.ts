import type { Editor } from './editor';
import { environmentGallery } from './environment-gallery';
import { environmentParts, findPreset, fitsV2, modsFragment, ringSystemParts, type EnvironmentMods, type RingLook } from './environment-mods';
import { difficultyFile, difficultyVersion } from './map-io';
import { OTHER_ENVIRONMENTS, SHOW_ENVIRONMENTS } from './new-map';

/**
 * "Environment": a ready-made environment for the map (MadChase's, Phøenix's, Lonely's), or the environment as it is
 * with parts taken away and its rings and their lights made bigger. Applying saves the map and opens
 * it again (the 3D view and the lights as they then are). While it's open it stands off the 3D view,
 * every lamp lit white, and the parts ticked off are taken away there at once (tried, not saved).
 */
export async function environmentDialog(editor: Editor): Promise<void> {
  const map = editor.map;
  const row = editor.row;
  const project = editor.project;
  if (map === null || row === null || project === null) return;
  const file = difficultyFile(row);
  const version = difficultyVersion(await map.folder.readText(file));
  const mods: EnvironmentMods = structuredClone(project.environmentMods ?? {});
  const source = await editor.environmentSource().catch(() => null);
  const environment = row.environmentId ?? 'DefaultEnvironment';

  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'ce-shade env-shade';
    const box = document.createElement('div');
    box.className = 'ce-dialog env-dialog';
    // (off the 3D view: under it, or beside it — where there's room)
    const view = document.getElementById('preview-wrap')?.getBoundingClientRect();
    if (view !== undefined && view.width > 0) {
      const below = window.innerHeight - view.bottom;
      const right = window.innerWidth - view.right;
      const left = view.left;
      box.classList.add('env-docked');
      if (below >= 300) Object.assign(box.style, { top: `${String(view.bottom + 6)}px`, left: '8px', width: `${String(Math.min(900, window.innerWidth - 16))}px`, maxHeight: `${String(below - 14)}px` });
      else if (right >= 380 || left >= 380) Object.assign(box.style, { top: '8px', [right >= left ? 'right' : 'left']: '8px', width: `${String(Math.min(900, Math.max(right, left) - 14))}px`, maxHeight: `${String(window.innerHeight - 16)}px` });
      else box.classList.remove('env-docked');
    }
    box.innerHTML = `
      <div class="ce-dialog-title">Окружение карты</div>
      <div class="env-tabs"><button type="button" data-tab="presets">Окружения</button><button type="button" data-tab="parts">Детали и кольца</button></div>
      <div class="env-page" data-page="presets"></div>
      <div class="env-page" data-page="parts"></div>
      <div class="nm-status" data-id="status"></div>
      <div class="ce-dialog-buttons"><button type="button" data-id="close">Закрыть</button><button type="button" class="primary" data-id="apply">Применить</button></div>`;
    shade.append(box);
    document.body.append(shade);
    const el = <T extends HTMLElement>(selector: string) => box.querySelector<T>(selector)!;
    const status = el<HTMLElement>('[data-id="status"]');
    let busy = false;
    // every lamp lit white while it's open: what's taken away shows
    editor.staticLights = true;
    editor.rebuildPreview(true);
    let applied = false;
    const finish = () => {
      shade.remove();
      window.removeEventListener('keydown', escape, true);
      if (previewTimer !== null) window.clearTimeout(previewTimer);
      editor.staticLights = false;
      if (!applied) void editor.previewEnvironmentMods(null);
      editor.rebuildPreview(true);
      resolve();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      event.stopPropagation();
      finish();
    };
    window.addEventListener('keydown', escape, true);
    // the changes tried in the 3D view a moment after each one
    let previewTimer: number | null = null;
    const tryOut = () => {
      if (previewTimer !== null) window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        previewTimer = null;
        void editor.previewEnvironmentMods(currentMods()).catch((error: unknown) => console.error('[lumatic] environment preview failed', error));
      }, 120);
    };
    el('[data-id="close"]').addEventListener('click', () => {
      if (!busy) finish();
    });

    const apply = async (next: EnvironmentMods, nextEnvironment?: string) => {
      if (busy) return;
      busy = true;
      status.textContent = 'Сохраняю карту и открываю её заново…';
      try {
        applied = true;
        await editor.setEnvironmentMods(next, nextEnvironment);
        editor.setStatus('Окружение карты изменено');
        finish();
      } catch (error) {
        console.error(error);
        status.textContent = `Не получилось: ${error instanceof Error ? error.message : String(error)}`;
        applied = false;
        busy = false;
      }
    };

    // ----- ready-made environments
    const presets = el<HTMLElement>('[data-page="presets"]');
    const note = document.createElement('div');
    note.className = 'nm-dim env-note';
    note.textContent = 'Окружения игры — меняют окружение карты (Info.dat). Готовые — окружение целиком из Chroma (у некоторых — и Noodle Extensions): карта будет их требовать. Окружение карты сменится на то, на котором оно построено. Номера света (light ID) — в описании у каждого.';
    presets.append(note);
    presets.append(
      environmentGallery({
        mode: 'apply',
        current: { environment, preset: mods.preset },
        standard: [...SHOW_ENVIRONMENTS, ...OTHER_ENVIRONMENTS],
        version,
        choose: (choice) => {
          const preset = findPreset(choice.preset);
          if (preset === undefined && choice.environment !== environment) {
            // another of the game's environments: the parts taken away and the rings changed were this one's
            const current = findPreset(mods.preset);
            const off = current !== undefined ? ` Окружение «${current.name}» будет убрано.` : (mods.hidden ?? []).length > 0 || Object.keys(mods.rings ?? {}).length > 0 ? ' Убранные детали и настройки колец сбросятся.' : '';
            if (window.confirm(`Сменить окружение карты на ${choice.environment}?${off} Карта будет сохранена.`)) void apply({ ...mods, preset: undefined, hidden: [], rings: {} }, choice.environment);
            return;
          }
          if (preset === undefined) {
            const current = findPreset(mods.preset);
            if (window.confirm(`Убрать окружение «${current?.name ?? ''}»? Карта будет сохранена.`)) void apply({ ...mods, preset: undefined });
            return;
          }
          const change = preset.environment !== environment ? ` Окружение карты сменится на ${preset.environment}.` : '';
          if (window.confirm(`Поставить окружение «${preset.name}» (автор — ${preset.author})?${change} Карта будет сохранена.`)) void apply({ ...mods, preset: preset.id }, preset.environment);
        },
      }),
    );

    // ----- parts and rings
    const parts = el<HTMLElement>('[data-page="parts"]');
    const hidden = new Set(mods.hidden ?? []);
    const rings: Record<string, RingLook> = structuredClone(mods.rings ?? {});
    /** The changes as they're set now. */
    function currentMods(): EnvironmentMods {
      const cleaned: Record<string, RingLook> = {};
      for (const [ring, look] of Object.entries(rings)) {
        const kept = Object.fromEntries(Object.entries(look).filter(([, value]) => (typeof value === 'number' ? Math.abs(value - 1) > 1e-6 : value === true))) as RingLook;
        if (Object.keys(kept).length > 0) cleaned[ring] = kept;
      }
      return { ...mods, hidden: [...hidden], rings: cleaned };
    }
    if (source === null) parts.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'Не удалось загрузить данные окружения.' }));
    else {
      parts.append(Object.assign(document.createElement('div'), { className: 'nm-dim env-note', textContent: `${environment}: отмеченное убирается из окружения (Chroma). Работает у всех игроков с Chroma, не зависит от версии игры.` }));
      const list = document.createElement('div');
      list.className = 'env-parts';
      for (const part of environmentParts(source)) {
        const label = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = hidden.has(part.name);
        check.addEventListener('change', () => {
          if (check.checked) hidden.add(part.name);
          else hidden.delete(part.name);
          tryOut();
        });
        label.append(check, ` Убрать ${part.name}${part.count > 1 ? ` ×${String(part.count)}` : ''}${part.lights ? ' 💡' : ''}`);
        label.title = part.lights ? 'В этой части есть свет — убрав её, вы уберёте и его' : '';
        list.append(label);
      }
      parts.append(list);
      const systems = ringSystemParts(source);
      if (systems.length > 0) {
        parts.append(Object.assign(document.createElement('div'), { className: 'env-subtitle', textContent: 'Кольца' }));
        for (const system of systems) {
          const look = (rings[system.ring] ??= {});
          const line = document.createElement('div');
          line.className = 'env-ring';
          line.append(Object.assign(document.createElement('span'), { className: 'env-ring-name', textContent: `${system.ring.replace(/\(Clone\)$/u, '')} ×${String(system.count)}` }));
          const field = (label: string, key: 'size' | 'thickness' | 'length', title: string, enabled = true) => {
            const wrap = document.createElement('label');
            wrap.title = title;
            const input = document.createElement('input');
            input.type = 'number';
            input.step = '0.1';
            input.min = '0.1';
            input.value = String(look[key] ?? 1);
            input.disabled = !enabled;
            input.addEventListener('change', () => {
              const value = Number(input.value);
              if (Number.isFinite(value) && value > 0) look[key] = value;
              tryOut();
            });
            wrap.append(label, input);
            return wrap;
          };
          const geometry = document.createElement('label');
          geometry.title = 'Кольца строятся из кубов Chroma, у каждого кольца свой трек: позы «Каждое кольцо отдельно» работают у всех игроков и в любой версии игры. Обычные события вращения и зума их не двигают. Нужен Noodle Extensions.';
          const geometryCheck = document.createElement('input');
          geometryCheck.type = 'checkbox';
          geometryCheck.checked = look.geometry === true;
          geometryCheck.disabled = version !== '3';
          geometryCheck.addEventListener('change', () => {
            look.geometry = geometryCheck.checked || undefined;
            tryOut();
          });
          geometry.append(geometryCheck, 'Из геометрии Chroma (Noodle)');
          line.append(
            field('Размер ×', 'size', 'Во сколько раз больше сами кольца'),
            field('Свет толще ×', 'thickness', system.lights.length > 0 ? 'Во сколько раз толще светящиеся трубки колец' : 'У этих колец нет светящихся трубок', system.lights.length > 0),
            field('Свет длиннее ×', 'length', system.lights.length > 0 ? 'Во сколько раз длиннее светящиеся трубки колец' : 'У этих колец нет светящихся трубок', system.lights.length > 0),
            geometry,
          );
          parts.append(line);
        }
      }
    }

    el('[data-id="apply"]').addEventListener('click', () => {
      const next = currentMods();
      if (version === '2' && !fitsV2(modsFragment(next, source))) status.textContent = 'Часть изменений не подходит для карты v2 и не будет записана.';
      void apply(next);
    });

    // tabs
    const show = (tab: string) => {
      box.querySelectorAll<HTMLElement>('[data-page]').forEach((page) => (page.hidden = page.dataset.page !== tab));
      box.querySelectorAll<HTMLElement>('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
      el<HTMLButtonElement>('[data-id="apply"]').hidden = tab !== 'parts';
    };
    box.querySelectorAll<HTMLElement>('[data-tab]').forEach((button) => button.addEventListener('click', () => show(button.dataset.tab!)));
    show(mods.preset !== undefined || (mods.hidden ?? []).length > 0 || Object.keys(mods.rings ?? {}).length > 0 ? (mods.preset !== undefined ? 'presets' : 'parts') : 'presets');
  });
}
