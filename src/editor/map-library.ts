import { environmentCatalog } from '../engine/renderer/environment/environment-catalog';
import { openLibraryMap, type GameInstallation, type MapFolder, type MapLibraryEntry, type MapLibraryKind } from './platform';
import { setSettings, settings } from './settings';

function environmentTitle(id: string) {
  return environmentCatalog.find((entry) => entry.id === id)?.title ?? (id === '' ? 'Не указано' : id);
}

function versionLabel(entry: MapLibraryEntry) {
  return entry.versions.length === 0 ? 'v?' : entry.versions.map((version) => `v${version}`).join(' + ');
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

export async function mapLibraryDialog(open: (folder: MapFolder | null) => Promise<void>): Promise<void> {
  const native = window.chroeditorNative?.maps;
  if (native === undefined) return;
  const maps = native;
  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'ce-shade';
    const box = document.createElement('div');
    box.className = 'ce-dialog map-dialog';
    box.innerHTML = `
      <div class="ce-dialog-title">Открыть карту</div>
      <div class="map-installation"><label>Версия игры <select data-id="installation"></select></label></div>
      <div class="map-controls">
        <div class="map-tabs"><button type="button" data-id="wip">CustomWIP</button><button type="button" data-id="levels">CustomLevels</button></div>
        <input type="text" data-id="search" placeholder="Песня, авторы, окружение, версия…">
        <select data-id="sort" title="Сортировка">
          <option value="recent">Сначала недавние</option>
          <option value="name">По названию</option>
          <option value="environment">По окружению</option>
          <option value="version">По версии</option>
          <option value="songAuthor">По автору песни</option>
          <option value="mapAuthor">По автору карты</option>
        </select>
        <button type="button" data-id="refresh" title="Перечитать карты">↻</button>
      </div>
      <div class="map-status" data-id="status">Читаю карты…</div>
      <div class="map-grid" data-id="grid"></div>
      <div class="ce-dialog-buttons"><button type="button" data-id="cancel">Отмена</button><button type="button" class="primary" data-id="open" disabled>Открыть</button></div>`;
    shade.append(box);
    document.body.append(shade);

    const installationSelect = box.querySelector<HTMLSelectElement>('[data-id="installation"]')!;
    const search = box.querySelector<HTMLInputElement>('[data-id="search"]')!;
    const sort = box.querySelector<HTMLSelectElement>('[data-id="sort"]')!;
    const status = box.querySelector<HTMLElement>('[data-id="status"]')!;
    const grid = box.querySelector<HTMLElement>('[data-id="grid"]')!;
    const openButton = box.querySelector<HTMLButtonElement>('[data-id="open"]')!;
    const refreshButton = box.querySelector<HTMLButtonElement>('[data-id="refresh"]')!;
    let tab: MapLibraryKind = 'wip';
    let libraries: Record<MapLibraryKind, MapLibraryEntry[]> = { wip: [], levels: [] };
    let installations: GameInstallation[] = [];
    let selected: MapLibraryEntry | null = null;
    let generation = 0;
    let closed = false;

    function close() {
      if (closed) return;
      closed = true;
      generation++;
      window.removeEventListener('keydown', keys, true);
      shade.remove();
      resolve();
    }

    function currentEntries() {
      const query = search.value.trim().toLocaleLowerCase();
      const entries = libraries[tab].filter((entry) => {
        if (query === '') return true;
        return [entry.songName, entry.songAuthor, entry.mapAuthor, entry.environment, environmentTitle(entry.environment), entry.infoVersion, ...entry.versions]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query);
      });
      const mode = sort.value;
      return entries.sort((a, b) => {
        if (mode === 'recent') return b.modified - a.modified || compareText(a.songName, b.songName);
        if (mode === 'environment') return compareText(environmentTitle(a.environment), environmentTitle(b.environment)) || compareText(a.songName, b.songName);
        if (mode === 'version') return compareText(a.infoVersion, b.infoVersion) || compareText(a.songName, b.songName);
        if (mode === 'songAuthor') return compareText(a.songAuthor, b.songAuthor) || compareText(a.songName, b.songName);
        if (mode === 'mapAuthor') return compareText(a.mapAuthor, b.mapAuthor) || compareText(a.songName, b.songName);
        return compareText(a.songName, b.songName);
      });
    }

    function select(entry: MapLibraryEntry | null) {
      selected = entry;
      openButton.disabled = entry === null;
      for (const card of grid.querySelectorAll<HTMLElement>('.map-card')) card.classList.toggle('selected', card.dataset.path === entry?.path);
    }

    async function loadCovers(jobs: { image: HTMLImageElement; path: string; gameFolder: string }[], token: number) {
      for (let index = 0; index < jobs.length; index += 8) {
        await Promise.all(
          jobs.slice(index, index + 8).map(async (job) => {
            const source = await maps.cover(job.path, job.gameFolder).catch(() => null);
            if (source !== null && token === generation && !closed) job.image.src = source;
          }),
        );
      }
    }

    function draw() {
      const token = generation;
      const entries = currentEntries();
      grid.replaceChildren();
      const jobs: { image: HTMLImageElement; path: string; gameFolder: string }[] = [];
      const gameFolder = installationSelect.value;
      for (const entry of entries) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'map-card';
        card.dataset.path = entry.path;
        card.title = entry.path;
        const cover = document.createElement('span');
        cover.className = 'map-cover';
        const image = document.createElement('img');
        image.alt = '';
        cover.append(image);
        const main = document.createElement('span');
        main.className = 'map-main';
        const title = document.createElement('strong');
        title.textContent = entry.songName;
        const songAuthor = document.createElement('span');
        songAuthor.textContent = entry.songAuthor === '' ? 'Автор песни не указан' : entry.songAuthor;
        const mapAuthor = document.createElement('span');
        mapAuthor.className = 'map-author';
        mapAuthor.textContent = entry.mapAuthor === '' ? 'Автор карты не указан' : `Карта: ${entry.mapAuthor}`;
        const environment = document.createElement('span');
        environment.className = 'map-environment';
        environment.textContent = environmentTitle(entry.environment);
        main.append(title, songAuthor, mapAuthor, environment);
        const version = document.createElement('span');
        version.className = 'map-version';
        version.textContent = versionLabel(entry);
        card.append(cover, main, version);
        card.addEventListener('click', () => select(entry));
        card.addEventListener('dblclick', () => void openSelected());
        grid.append(card);
        if (entry.cover !== null) jobs.push({ image, path: entry.cover, gameFolder });
      }
      status.textContent = entries.length === 0 ? 'Карт не найдено' : `Карт: ${String(entries.length)} · ${tab === 'wip' ? 'CustomWIPLevels' : 'CustomLevels (только чтение)'}`;
      select(entries.find((entry) => entry.path === selected?.path) ?? null);
      void loadCovers(jobs, token);
    }

    async function openSelected() {
      if (selected === null) return;
      const folder = await openLibraryMap(selected.path, tab);
      close();
      await open(folder);
    }

    async function load() {
      const token = ++generation;
      selected = null;
      status.textContent = 'Читаю карты…';
      grid.replaceChildren();
      libraries = { wip: [], levels: [] };
      draw();
      const gameFolder = installationSelect.value;
      const scanned = await maps.scan(gameFolder).catch(() => ({ wip: [], levels: [] }));
      if (token !== generation || closed) return;
      libraries = scanned;
      draw();
    }

    async function loadInstallations() {
      installations = await maps.installations(settings().gameFolder).catch(() => []);
      if (installations.length === 0) installations = [{ folder: settings().gameFolder, version: 'Текущая папка' }];
      installationSelect.replaceChildren(
        ...installations.map((installation) => {
          const option = document.createElement('option');
          option.value = installation.folder;
          option.textContent = installation.version === '' ? installation.folder : `${installation.version} — ${installation.folder}`;
          return option;
        }),
      );
      installationSelect.value = installations.some((item) => item.folder === settings().gameFolder) ? settings().gameFolder : (installations[0]?.folder ?? '');
      installationSelect.parentElement!.hidden = installations.length <= 1 && installationSelect.value === settings().gameFolder;
      await load();
    }

    for (const name of ['wip', 'levels'] as const) {
      box.querySelector<HTMLButtonElement>(`[data-id="${name}"]`)!.addEventListener('click', () => {
        tab = name;
        for (const button of box.querySelectorAll<HTMLButtonElement>('.map-tabs button')) button.classList.toggle('active', button.dataset.id === tab);
        draw();
      });
    }
    box.querySelector<HTMLButtonElement>('[data-id="wip"]')!.classList.add('active');
    installationSelect.addEventListener('change', () => {
      setSettings({ gameFolder: installationSelect.value });
      void load();
    });
    search.addEventListener('input', draw);
    sort.addEventListener('change', draw);
    refreshButton.addEventListener('click', () => void load());
    openButton.addEventListener('click', () => void openSelected());
    box.querySelector<HTMLButtonElement>('[data-id="cancel"]')!.addEventListener('click', close);
    shade.addEventListener('mousedown', (event) => {
      if (event.target === shade) close();
    });
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === 'Enter' && selected !== null) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void openSelected();
      }
    };
    window.addEventListener('keydown', keys, true);
    search.focus();
    void loadInstallations();
  });
}
