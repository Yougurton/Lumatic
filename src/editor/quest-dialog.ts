import type { Editor } from './editor';
import { setSettings, settings } from './settings';

/**
 * "Send to Quest" (the desktop app): adb found or fetched, the headsets on the cable or Wi-Fi, and the
 * map saved and sent to SongCore's folder on the headset — so that the game shows the new version
 * without the level being deleted in it first (the game started again, or a folder of a new name and
 * "Refresh Songs"; see electron/quest.ts).
 */

interface QuestDevice {
  serial: string;
  state: string;
  model: string;
  wifi: boolean;
}

export interface QuestApi {
  findAdb(picked?: string): Promise<{ path: string; version: string } | null>;
  downloadAdb(): Promise<{ path: string; version: string } | null>;
  pickAdb(): Promise<{ path: string; version: string } | null>;
  devices(): Promise<QuestDevice[]>;
  connect(address: string): Promise<{ ok: boolean; text: string; address: string }>;
  disconnect(address: string): Promise<void>;
  enableWifi(serial: string): Promise<{ ok: boolean; text: string; address: string }>;
  discover(remembered: string[]): Promise<{ connected: string[]; tried: string[] }>;
  pair(address: string, code: string): Promise<{ ok: boolean; text: string }>;
  upload(options: { serial: string; folder: string; name: string; target: 'wip' | 'custom'; mode: 'restart' | 'fresh' }, progress: (text: string) => void): Promise<{ remote: string; name: string; files: number }>;
}

const quest = () => (window.chroeditorNative as { quest?: QuestApi } | undefined)?.quest;

export const canSendToQuest = () => quest() !== undefined;

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/u, '') : String(error));

export function questDialog(editor: Editor, save: () => Promise<void>) {
  const api = quest();
  if (api === undefined || editor.map === null) return;
  const shade = document.createElement('div');
  shade.className = 'ce-shade';
  const box = document.createElement('div');
  box.className = 'ce-dialog quest-dialog';
  box.innerHTML = `
    <div class="ce-dialog-title">Отправить на Quest</div>
    <div class="qd-section">
      <div class="qd-head">adb</div>
      <div data-id="adb" class="nm-dim">Ищу adb…</div>
      <div class="qd-row" data-id="adb-buttons" hidden>
        <button type="button" data-id="download" title="Скачать platform-tools с dl.google.com в папку Lumatic">Скачать adb (Google)</button>
        <button type="button" data-id="pick">Указать adb…</button>
      </div>
    </div>
    <div class="qd-section">
      <div class="qd-head">Шлем <button type="button" data-id="refresh" title="Обновить список">⟳</button><button type="button" data-id="discover" title="Найти шлем в локальной сети (adb по Wi‑Fi уже включён — например, SideQuest'ом) и подключиться">🔍 Найти по Wi‑Fi</button><span class="nm-dim" data-id="discovering"></span></div>
      <div data-id="devices" class="qd-devices"></div>
      <div class="qd-row">
        <button type="button" data-id="wifi" title="Шлем подключён кабелем: включить отладку по Wi‑Fi и подключиться без провода">📶 Включить Wi‑Fi</button>
        <input type="text" data-id="address" placeholder="IP шлема, напр. 192.168.1.20">
        <button type="button" data-id="connect">Подключить</button>
      </div>
      <details class="qd-pair">
        <summary>Сопряжение по коду (беспроводная отладка, без кабеля)</summary>
        <div class="nm-dim qd-hint">В шлеме: «Беспроводная отладка» → «Подключить по коду» — впишите адрес с портом и шестизначный код оттуда.</div>
        <div class="qd-row">
          <input type="text" data-id="pair-address" placeholder="192.168.1.20:37123">
          <input type="text" data-id="pair-code" placeholder="код" class="qd-code">
          <button type="button" data-id="pair">Сопрячь</button>
        </div>
      </details>
      <div class="nm-dim qd-hint">Wi‑Fi: если adb по Wi‑Fi уже включён (например, SideQuest'ом), шлем найдётся сам — «🔍 Найти по Wi‑Fi». Иначе один раз подключите кабелем и нажмите «Включить Wi‑Fi» (держится до перезагрузки шлема) или сопрягите по коду. Кабель: режим разработчика, «Разрешить» в шлеме.</div>
    </div>
    <div class="qd-section">
      <div class="qd-head">Куда и как</div>
      <label class="qd-line"><span>Папка в игре</span><select data-id="target"><option value="wip">Custom WIP Levels (черновики, без рекордов)</option><option value="custom">Custom Levels</option></select></label>
      <label class="qd-line"><span>Чтобы игра увидела новую версию</span><select data-id="mode"><option value="restart">Перезапустить Beat Saber (надёжно)</option><option value="fresh">Без перезапуска: новая папка, в игре «Refresh Songs»</option></select></label>
      <div class="nm-dim qd-hint" data-id="mode-hint"></div>
    </div>
    <div class="qd-log" data-id="log"></div>
    <div class="ce-dialog-buttons">
      <button type="button" data-id="close">Закрыть</button>
      <span class="adjust-gap"></span>
      <button type="button" class="primary" data-id="send">📤 Сохранить и отправить</button>
    </div>`;
  shade.append(box);
  document.body.append(shade);
  const el = <T extends HTMLElement>(id: string) => box.querySelector<T>(`[data-id="${id}"]`)!;
  const log = (text: string, kind: 'ok' | 'bad' | '' = '') => {
    const line = Object.assign(document.createElement('div'), { textContent: text });
    if (kind !== '') line.className = `qd-${kind}`;
    el('log').append(line);
    el('log').scrollTop = el('log').scrollHeight;
  };
  let picked = settings().questSerial;
  let list: QuestDevice[] = [];
  let busy = false;
  const target = el<HTMLSelectElement>('target');
  const mode = el<HTMLSelectElement>('mode');
  target.value = settings().questTarget;
  mode.value = settings().questMode;
  el<HTMLInputElement>('address').value = settings().questAddress;
  const modeHint = () => {
    el('mode-hint').textContent =
      mode.value === 'restart'
        ? 'Карта заменяется в той же папке, и игра запускается заново: SongCore читает уровни только при запуске. Уровень сразу новый, удалять его в игре не нужно.'
        : 'Карта кладётся в папку с новым именем (старая удаляется): «Refresh Songs» в игре загрузит её как новый уровень. Старая копия останется в списке до перезапуска игры (сыграть её нельзя).';
  };
  modeHint();
  target.addEventListener('change', () => setSettings({ questTarget: target.value as 'wip' | 'custom' }));
  mode.addEventListener('change', () => {
    setSettings({ questMode: mode.value as 'restart' | 'fresh' });
    modeHint();
  });

  const ready = () => list.find((device) => device.serial === picked && device.state === 'device');
  const sync = () => {
    el<HTMLButtonElement>('send').disabled = busy || ready() === undefined;
    const usb = list.find((device) => device.serial === picked && !device.wifi && device.state === 'device');
    el<HTMLButtonElement>('wifi').disabled = busy || usb === undefined;
  };
  const drawDevices = () => {
    const holder = el('devices');
    holder.replaceChildren();
    if (list.length === 0) {
      holder.append(Object.assign(document.createElement('div'), { className: 'nm-dim', textContent: 'Шлемов не видно. Подключите кабель или укажите IP для Wi‑Fi.' }));
    }
    if (ready() === undefined) picked = list.find((device) => device.state === 'device')?.serial ?? picked;
    for (const device of list) {
      const row = document.createElement('label');
      row.className = 'qd-device';
      const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'qd-device', checked: device.serial === picked });
      radio.addEventListener('change', () => {
        picked = device.serial;
        setSettings({ questSerial: picked });
        sync();
      });
      const state = device.state === 'device' ? '' : device.state === 'unauthorized' ? ' — разрешите отладку в шлеме' : ` — ${device.state}`;
      row.append(radio, `${device.wifi ? '📶' : '🔌'} ${device.model || 'Устройство'} `, Object.assign(document.createElement('span'), { className: 'nm-dim', textContent: `${device.serial}${state}` }));
      if (device.wifi) {
        const off = Object.assign(document.createElement('button'), { type: 'button', textContent: '✕', title: 'Отключить' });
        off.addEventListener('click', (event) => {
          event.preventDefault();
          void api.disconnect(device.serial).then(refresh);
        });
        row.append(off);
      }
      holder.append(row);
    }
    sync();
  };
  const refresh = async () => {
    try {
      list = await api.devices();
    } catch (error) {
      list = [];
      log(message(error), 'bad');
    }
    drawDevices();
  };
  const showAdb = (found: { path: string; version: string } | null) => {
    el('adb').textContent = found === null ? 'adb не найден. Скачайте его (platform-tools от Google, ~7 МБ) или укажите свой — например, из SideQuest.' : `✓ ${found.version} — ${found.path}`;
    el('adb-buttons').hidden = found !== null;
    if (found !== null) {
      void refresh().then(() => {
        // (no headset seen: looked for on the network at once, as SideQuest does)
        if (!list.some((device) => device.state === 'device')) void look();
      });
    }
  };
  /** The network searched for headsets with adb over Wi-Fi on, and connected to. */
  const look = async () => {
    el('discovering').textContent = 'ищу в сети…';
    el<HTMLButtonElement>('discover').disabled = true;
    try {
      const result = await api.discover([settings().questAddress]);
      if (result.connected.length > 0) {
        log(`Найдено и подключено: ${result.connected.join(', ')}`, 'ok');
        picked = result.connected[0]!;
      } else if (!list.some((device) => device.state === 'device')) log('В сети шлем с adb по Wi‑Fi не найден. Подключите кабелем и нажмите «Включить Wi‑Fi», сопрягите по коду или впишите IP.');
    } catch (error) {
      log(message(error), 'bad');
    } finally {
      el('discovering').textContent = '';
      el<HTMLButtonElement>('discover').disabled = false;
    }
    await refresh();
  };
  el('discover').addEventListener('click', () => void look());
  el('pair').addEventListener('click', () => {
    const address = el<HTMLInputElement>('pair-address').value.trim();
    const code = el<HTMLInputElement>('pair-code').value.trim();
    if (address === '' || code === '') return;
    log(`Сопряжение с ${address}…`);
    void api.pair(address, code).then(
      async (result) => {
        log(result.text, result.ok ? 'ok' : 'bad');
        if (result.ok) await look();
      },
      (error: unknown) => log(message(error), 'bad'),
    );
  });
  void api.findAdb(settings().adbPicked).then(showAdb, (error: unknown) => log(message(error), 'bad'));
  el('download').addEventListener('click', () => {
    el('adb').textContent = 'Скачиваю platform-tools…';
    void api.downloadAdb().then(showAdb, (error: unknown) => {
      el('adb').textContent = 'Не удалось скачать.';
      log(message(error), 'bad');
    });
  });
  el('pick').addEventListener('click', () =>
    void api.pickAdb().then((found) => {
      if (found === null) return;
      // (only an adb picked by hand is kept: otherwise SideQuest's is preferred, sharing its connections)
      setSettings({ adbPicked: found.path });
      showAdb(found);
    }),
  );
  el('refresh').addEventListener('click', () => void refresh());
  el('connect').addEventListener('click', () => {
    const address = el<HTMLInputElement>('address').value.trim();
    if (address === '') return;
    setSettings({ questAddress: address });
    log(`Подключаюсь к ${address}…`);
    void api.connect(address).then(
      async (result) => {
        log(result.text, result.ok ? 'ok' : 'bad');
        if (result.ok) picked = result.address;
        await refresh();
      },
      (error: unknown) => log(message(error), 'bad'),
    );
  });
  el('wifi').addEventListener('click', () => {
    if (picked === '') return;
    log('Включаю отладку по Wi‑Fi…');
    void api.enableWifi(picked).then(
      async (result) => {
        log(result.ok ? `Подключено по Wi‑Fi: ${result.address}. Кабель можно отключить.` : result.text, result.ok ? 'ok' : 'bad');
        if (result.ok) {
          picked = result.address;
          setSettings({ questAddress: result.address, questSerial: result.address });
          el<HTMLInputElement>('address').value = result.address;
        }
        await refresh();
      },
      (error: unknown) => log(message(error), 'bad'),
    );
  });
  el('send').addEventListener('click', () => {
    const device = ready();
    const map = editor.map;
    if (device === undefined || map === null) return;
    busy = true;
    sync();
    void (async () => {
      try {
        if (editor.dirty) {
          log('Сохраняю…');
          await save();
          if (editor.dirty) throw new Error('карта не сохранилась');
        }
        const folder = map.folder.name;
        const name = folder.split(/[\\/]/u).filter((part) => part !== '').pop() ?? 'Lumatic map';
        log(`Отправляю «${name}» на ${device.model || device.serial}…`);
        const result = await api.upload({ serial: device.serial, folder, name, target: target.value as 'wip' | 'custom', mode: mode.value as 'restart' | 'fresh' }, (text) => log(text));
        log(mode.value === 'restart' ? `✓ Готово: ${String(result.files)} файлов. Beat Saber перезапускается — уровень будет в «${target.value === 'wip' ? 'Custom WIP Levels' : 'Custom Levels'}».` : `✓ Готово: ${String(result.files)} файлов в «${result.name}». В игре нажмите «Refresh Songs».`, 'ok');
        editor.setStatus('Карта отправлена на Quest');
      } catch (error) {
        log(`Не отправлено: ${message(error)}`, 'bad');
      } finally {
        busy = false;
        sync();
      }
    })();
  });
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
  el('close').addEventListener('click', close);
  sync();
}
