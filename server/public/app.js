/**
 * Codie vezérlő — frontend.
 *
 * A socket.io kapcsolat a `src/realtime.js` réteggel beszél; a REST API
 * (`/api/...`) ugyanazokat a műveleteket érhető el, ha a socket nem él.
 *
 * A robotok listája **nem** a scan eredményével cserélődik: a scan csak a
 * hirdető robotokat látja, egy már csatlakoztatott robot viszont épp nem
 * hirdet — ezért a találatokat a ismert listába merge-eljük.
 */

const socket = io();

const els = {
  socketStatus: document.getElementById('socket-status'),
  scanBtn: document.getElementById('scan-btn'),
  scanHint: document.getElementById('scan-hint'),
  robotList: document.getElementById('robot-list'),
  robotsEmpty: document.getElementById('robots-empty'),
  robotCount: document.getElementById('robot-count'),
  activeName: document.getElementById('active-name'),
  statusLine: document.getElementById('status-line'),
  battery: document.getElementById('t-battery'),
  sonar: document.getElementById('t-sonar'),
  light: document.getElementById('t-light'),
  line: document.getElementById('t-line'),
  telemetry: document.getElementById('telemetry'),
  telemetryAge: document.getElementById('telemetry-age'),
  micBtn: document.getElementById('mic-btn'),
  micLevel: document.getElementById('mic-level'),
  micPeak: document.getElementById('mic-peak'),
  micHint: document.getElementById('mic-hint'),
  morseText: document.getElementById('morse-text'),
};

/** A szerver által támogatott generációk — a `/api/config` egészíti ki. */
let supportedVariants = ['routing', 'no-routing'];

/** A generációk magyar feliratai (a `title` attribútum és a badge szövege). */
const VARIANT_LABELS = {
  routing: 'routing',
  'no-routing': 'no-routing',
};

const VARIANT_TITLES = {
  routing: 'Routing generáció — a repo Python kliensének protokollja.',
  'no-routing': 'Routing nélküli generáció — a codiejs protokollja.',
};

let robots = [];
let activeAddress = null;
/** Az utolsóra kiválasztott LED-szín — a beépített animációk ezt használják. */
let lastLedColor = 'red';
/** A kiválasztott robot utolsó telemetriaadata (a frissesség jelzéséhez). */
let lastTelemetry = null;
/** A mikrofon figyelése folyamatban (a szintmérő). */
let micStreaming = false;

function setStatus(text, isError = false) {
  els.statusLine.textContent = text;
  els.statusLine.classList.toggle('error', isError);
}

/** A szerver beállításainak lekérése (a támogatott generációk listája). */
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const config = await res.json();
    if (Array.isArray(config.variants) && config.variants.length > 0) {
      supportedVariants = config.variants;
    }
  } catch {
    /* a socketos működés nem függ a config endpointtól */
  }
}

/** A robotok egységesítése — a `variant` mindig jelen van (null = ismeretlen). */
function normalizeRobot(robot) {
  return { ...robot, variant: robot.variant ?? null };
}

/**
 * A robotok listájának frissítése a kapottakkal.
 *
 * @param {object[]} incoming az érkezett robotok
 * @param {{authoritative?: boolean}} options
 *   `authoritative: true` esetén a kapcsolati adatok (kapcsolat, generáció,
 *   telemetria) is frissülnek — ezt a `robot`/`telemetry` események küldik.
 *   A scan (`authoritative: false`) csak a jelenléti adatokat frissíti: nem
 *   szabad egy már csatlakoztatott robotot Offline-ra rontani azzal, hogy egy
 *   későbbi scan nem látta.
 */
function mergeRobots(incoming, { authoritative = false } = {}) {
  for (const robot of incoming || []) {
    if (!robot || !robot.address) continue;
    const index = robots.findIndex((r) => r.address === robot.address);
    if (index === -1) {
      robots.push(normalizeRobot(robot));
      continue;
    }
    const current = robots[index];
    if (authoritative) {
      // A generáció csak csatlakozáskor derül ki, lekapcsolás után is
      // ismert — a `null` nem szabad elvetnie a már tudott értéket.
      robots[index] = {
        ...current,
        ...normalizeRobot(robot),
        variant: robot.variant ?? current.variant ?? null,
      };
      continue;
    }
    // A scan nem bizonyít semmit a kapcsolatról: egy már csatlakoztatott robot
    // offline-ra rontása itt hiba lenne, ezért a scan csak feljebb tud emelni.
    robots[index] = {
      ...current,
      ...robot,
      connected: robot.connected === true || current.connected === true,
      variant: current.variant ?? robot.variant ?? null,
      telemetry: current.telemetry ?? robot.telemetry ?? null,
    };
  }
}

/** A generáció badge-e (a név mellett). */
function variantBadge(variant) {
  const badge = document.createElement('span');
  if (!variant) {
    badge.className = 'variant-badge variant-unknown';
    badge.textContent = 'ismeretlen';
    badge.title = 'A generáció csak csatlakozás után derül ki (a GATT-elrendezésből).';
    return badge;
  }
  badge.className = `variant-badge variant-${variant}`;
  badge.textContent = VARIANT_LABELS[variant] || variant;
  const known = supportedVariants.includes(variant);
  badge.title = known
    ? VARIANT_TITLES[variant] || `Codie generáció: ${variant}`
    : `Ismeretlen generáció: ${variant}`;
  return badge;
}

function renderRobots() {
  els.robotList.innerHTML = '';
  els.robotCount.textContent = robots.length ? `(${robots.length})` : '';
  els.robotsEmpty.hidden = robots.length > 0;

  for (const robot of robots) {
    const item = document.createElement('li');
    item.className = 'robot-item' + (robot.address === activeAddress ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'robot-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'robot-name-row';
    const name = document.createElement('span');
    name.className = 'robot-name';
    name.textContent = robot.name || '(névtelen)';
    nameRow.append(name, variantBadge(robot.variant));

    const address = document.createElement('span');
    address.className = 'robot-address';
    address.textContent = robot.address;

    const rssi = document.createElement('span');
    rssi.className = 'muted small';
    // a BlueZ 0-t ad, ha a jel erőssége ismeretlen (pl. csatlakozott eszköznél)
    const hasRssi = typeof robot.rssi === 'number' && robot.rssi !== 0;
    rssi.textContent = hasRssi ? `${robot.rssi} dBm` : '';

    info.append(nameRow, address, rssi);
    info.addEventListener('click', () => selectRobot(robot.address));

    const state = document.createElement('span');
    state.className =
      'pill ' + (robot.connected ? 'pill-on' : robot.reconnecting ? 'pill-wait' : 'pill-off');
    state.textContent = robot.connected
      ? 'online'
      : robot.reconnecting
        ? 'újracsatlakozás…'
        : 'offline';

    const toggle = document.createElement('button');
    toggle.className = 'btn btn-small ' + (robot.connected ? 'btn-danger' : '');
    toggle.textContent = robot.connected
      ? 'Lecsatlakozás'
      : robot.reconnecting
        ? 'Újracsatlakozás…'
        : 'Csatlakozás';
    toggle.disabled = Boolean(robot.reconnecting);
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const eventName = robot.connected ? 'robot:disconnect' : 'robot:connect';
      setStatus(`${robot.address} — ${eventName === 'robot:connect' ? 'csatlakozás' : 'lekapcsolás'}…`);
      socket.emit(eventName, { address: robot.address });
    });

    item.append(info, state, toggle);
    els.robotList.append(item);
  }
}

function upsertRobot(robot) {
  mergeRobots([robot], { authoritative: true });
  renderRobots();
  if (robot.address === activeAddress) renderTelemetry(robot.telemetry);
}

/**
 * A vonal-érzékelő értéke a generációtól függően más alakú:
 *  - routing: két 12 bites érték (bal / jobb);
 *  - routing nélküli: egyetlen fix-pontos érték (a codiejs 2^20-zal osztja,
 *    és 30 felett „vonalt követ”-nek tekinti).
 */
function formatLine(line) {
  if (!line) return '—';
  if (typeof line.level === 'number') {
    return `${line.level} · ${line.onLine ? 'vonalt követ' : 'vonal nélkül'}`;
  }
  if (line.left !== null && line.left !== undefined) {
    return `${line.left} / ${line.right}`;
  }
  return '—';
}

/** A telemetria frissessége — az elavult adatot halványítjuk. */
function renderTelemetryAge() {
  if (!els.telemetryAge) return;
  if (!lastTelemetry || !lastTelemetry.updatedAt) {
    els.telemetryAge.textContent = '';
    els.telemetry.classList.remove('stale');
    return;
  }
  const ageSec = Math.max(0, Math.round((Date.now() - lastTelemetry.updatedAt) / 1000));
  els.telemetryAge.textContent = `frissítve: ${ageSec} mp ezelőtt`;
  els.telemetry.classList.toggle('stale', ageSec > 15);
}

function renderTelemetry(telemetry) {
  lastTelemetry = telemetry || null;
  if (!telemetry) {
    els.battery.textContent = '—';
    els.sonar.textContent = '—';
    els.light.textContent = '—';
    els.line.textContent = '—';
    renderTelemetryAge();
    return;
  }
  els.battery.textContent = telemetry.batteryPct !== null && telemetry.batteryPct !== undefined ? `${telemetry.batteryPct}%` : '—';
  els.sonar.textContent = telemetry.sonarMm !== null && telemetry.sonarMm !== undefined ? `${telemetry.sonarMm} mm` : '—';
  els.light.textContent = telemetry.lightRaw !== null && telemetry.lightRaw !== undefined ? `${telemetry.lightRaw}` : '—';
  els.line.textContent = formatLine(telemetry.line);
  renderTelemetryAge();
}

function selectRobot(address) {
  // a mikrofon figyelése az adott robothoz tartozik — robotváltáskor leáll
  if (micStreaming && activeAddress && activeAddress !== address) {
    socket.emit('mic:stop', { address: activeAddress });
    setMicState(false);
  }
  activeAddress = address;
  const robot = robots.find((r) => r.address === address);
  els.activeName.textContent = robot ? `— ${robot.name || robot.address} —` : '— nincs kiválasztva —';
  renderRobots();
  renderTelemetry(robot?.telemetry);
}

/** A mikrofon szintmérő állapota. */
function setMicState(active) {
  micStreaming = active;
  els.micBtn.textContent = active ? 'Hallgatás leállítása' : 'Hallgatás indítása';
  els.micBtn.classList.toggle('btn-danger', active);
  if (!active) {
    els.micLevel.style.width = '0%';
    els.micPeak.style.left = '0%';
    els.micHint.textContent = '—';
  }
}

els.micBtn.addEventListener('click', () => {
  if (!activeAddress) {
    setStatus('Válassz ki egy robotot előbb.', true);
    return;
  }
  if (micStreaming) {
    socket.emit('mic:stop', { address: activeAddress });
    setMicState(false);
    setStatus('Mikrofon figyelése leállítva.');
    return;
  }
  socket.emit('mic:start', { address: activeAddress });
  setMicState(true);
  setStatus('Mikrofon figyelése indítva…');
});

socket.on('mic', (payload) => {
  if (!payload || payload.address !== activeAddress) return;
  const level = Math.max(0, Math.min(100, payload.level ?? 0));
  const peak = Math.max(0, Math.min(100, payload.peak ?? level));
  els.micLevel.style.width = `${level}%`;
  els.micPeak.style.left = `${peak}%`;
  els.micHint.textContent = `szint: ${level}% (nyers: ${payload.raw})`;
});

function sendCommand(name, params = {}) {
  if (!activeAddress) {
    setStatus('Válassz ki egy robotot előbb.', true);
    return;
  }
  setStatus(`${name} → ${activeAddress} …`);
  socket.emit('robot:command', { address: activeAddress, name, params });
}

els.scanBtn.addEventListener('click', () => {
  els.scanBtn.disabled = true;
  els.scanHint.textContent = 'Scannelek… (a robotnak ébren kell lennie)';
  setStatus('Robotok keresése…');
  socket.emit('scan:request', { durationMs: 10000 });
});

document.querySelectorAll('[data-cmd]').forEach((button) => {
  button.addEventListener('click', () => {
    const name = button.dataset.cmd;
    // a Morse-nak szöveg is kell → külön handler foglalkozik vele
    if (name === 'morse') return;
    const params = {};
    if (button.dataset.cm) params.cm = Number(button.dataset.cm);
    if (button.dataset.degrees) params.degrees = Number(button.dataset.degrees);
    if (button.dataset.ms) params.ms = Number(button.dataset.ms);
    if (button.dataset.color) params.color = button.dataset.color;
    if (button.dataset.animation !== undefined) {
      params.animation = Number(button.dataset.animation);
    }
    // a beépített animáció a legutóbb kiválasztott színben fut
    if (name === 'ledAnim' && !params.color) params.color = lastLedColor;
    sendCommand(name, params);
  });
});

document.getElementById('led-buttons').addEventListener('click', (event) => {
  const button = event.target.closest('[data-color]');
  if (!button) return;
  lastLedColor = button.dataset.color;
  sendCommand('led', { color: button.dataset.color });
});

document.querySelector('[data-cmd="morse"]').addEventListener('click', () => {
  const text = els.morseText.value.trim();
  if (!text) {
    setStatus('Írj be Morse szöveget.', true);
    return;
  }
  sendCommand('morse', { text });
});

socket.on('connect', () => {
  els.socketStatus.textContent = 'socket: online';
  els.socketStatus.className = 'badge badge-on';
});

socket.on('disconnect', () => {
  els.socketStatus.textContent = 'socket: offline';
  els.socketStatus.className = 'badge badge-off';
  // a keresés gombja ne maradjon letiltva (a scan nem futott le)
  els.scanBtn.disabled = false;
});

socket.on('robots', (payload) => {
  // a szerver teljes listája (új kapcsolatnál) — ez felülírja a lokális állapotot
  robots = (payload.robots || []).map(normalizeRobot);
  renderRobots();
});

socket.on('scan', (payload) => {
  // a scan csak az aktuálisan hirdető robotokat tartalmazza — a már ismert
  // (pl. csatlakoztatott) robotokat nem szabad kivenni a listából
  const found = payload.robots || [];
  mergeRobots(found);
  renderRobots();
  els.scanBtn.disabled = false;
  els.scanHint.textContent = `Keresés kész: ${found.length} robot.`;
  setStatus(found.length ? `${found.length} robot találva.` : 'Nem találtam robotot.');
});

socket.on('robot', (robot) => {
  upsertRobot(robot);
  if (robot.address === activeAddress) {
    els.activeName.textContent = `— ${robot.name || robot.address} —`;
    // a szerver a hiteles forrás: a mikrofon figyelése ott fut-e
    if (typeof robot.micStreaming === 'boolean') setMicState(robot.micStreaming);
  }
  // a kapcsolat állapotváltozását csak az aktív robot írja a státuszsorba
  // (a háttérrobotoké ne csípja el a „OK: …" üzenetet)
  if (robot.address === activeAddress) {
    if (robot.reconnecting) {
      setStatus(`${robot.address}: újracsatlakozás…`);
    } else {
      setStatus(`${robot.address}: ${robot.connected ? 'csatlakozva' : 'lekapcsolva'}`);
    }
  }
});

socket.on('telemetry', (robot) => {
  // a telemetria 4 érzékelőnként, 100 ms-onként érkezik — nem rajzoljuk újra
  // emiatt a teljes robot-listát, csak az értékeket frissítjük
  mergeRobots([robot], { authoritative: true });
  if (robot.address === activeAddress) renderTelemetry(robot.telemetry);
});

socket.on('command-result', (payload) => {
  setStatus(`OK: ${payload.action}`);
});

socket.on('error', (payload) => {
  // egy hibás keresés után a gomb ne maradjon letiltva
  els.scanBtn.disabled = false;
  setStatus(payload.message || 'Ismeretlen hiba.', true);
});

// A BLE réteg hibái (hibás csomag, megszakadt kapcsolat) — ezek a parancsok
// hibái nélkül is érkeznek, ezért külön esemény.
socket.on('robot-error', (payload) => {
  const message = payload?.message || 'Robot-hiba.';
  const prefix = payload?.address && payload.address !== activeAddress ? `${payload.address}: ` : '';
  setStatus(prefix + message, true);
});

// a telemetria korának kijelzése (a stale jelöléshez)
setInterval(renderTelemetryAge, 1000);

loadConfig();
