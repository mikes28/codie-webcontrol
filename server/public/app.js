/**
 * Codie vezérlő — frontend.
 *
 * A socket.io kapcsolat a `src/realtime.js` réteggel beszél; a REST API
 * (`/api/...`) ugyanazokat a műveleteket érhető el, ha a socket nem él.
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
  morseText: document.getElementById('morse-text'),
};

let robots = [];
let activeAddress = null;

function setStatus(text, isError = false) {
  els.statusLine.textContent = text;
  els.statusLine.classList.toggle('error', isError);
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
    info.innerHTML = `
      <span class="robot-name">${robot.name || '(névtelen)'}</span>
      <span class="robot-address">${robot.address}</span>
      <span class="muted small">${robot.rssi !== null && robot.rssi !== undefined ? robot.rssi + ' dBm' : ''}</span>
    `;
    info.addEventListener('click', () => selectRobot(robot.address));

    const state = document.createElement('span');
    state.className = 'pill ' + (robot.connected ? 'pill-on' : 'pill-off');
    state.textContent = robot.connected ? 'online' : 'offline';

    const toggle = document.createElement('button');
    toggle.className = 'btn btn-small ' + (robot.connected ? 'btn-danger' : '');
    toggle.textContent = robot.connected ? 'Lecsatlakozás' : 'Csatlakozás';
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
  const index = robots.findIndex((r) => r.address === robot.address);
  if (index === -1) robots.push(robot);
  else robots[index] = { ...robots[index], ...robot };
  renderRobots();
  if (robot.address === activeAddress) renderTelemetry(robot.telemetry);
}

function renderTelemetry(telemetry) {
  if (!telemetry) {
    els.battery.textContent = '—';
    els.sonar.textContent = '—';
    els.light.textContent = '—';
    els.line.textContent = '—';
    return;
  }
  els.battery.textContent = telemetry.batteryPct !== null && telemetry.batteryPct !== undefined ? `${telemetry.batteryPct}%` : '—';
  els.sonar.textContent = telemetry.sonarMm !== null && telemetry.sonarMm !== undefined ? `${telemetry.sonarMm} mm` : '—';
  els.light.textContent = telemetry.lightRaw !== null && telemetry.lightRaw !== undefined ? `${telemetry.lightRaw}` : '—';
  els.line.textContent =
    telemetry.line && telemetry.line.left !== null
      ? `${telemetry.line.left} / ${telemetry.line.right}`
      : '—';
}

function selectRobot(address) {
  activeAddress = address;
  const robot = robots.find((r) => r.address === address);
  els.activeName.textContent = robot ? `— ${robot.name || robot.address} —` : '— nincs kiválasztva —';
  renderRobots();
  renderTelemetry(robot?.telemetry);
}

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
    const params = {};
    if (button.dataset.cm) params.cm = Number(button.dataset.cm);
    if (button.dataset.degrees) params.degrees = Number(button.dataset.degrees);
    if (button.dataset.ms) params.ms = Number(button.dataset.ms);
    if (button.dataset.color) params.color = button.dataset.color;
    sendCommand(name, params);
  });
});

document.getElementById('led-buttons').addEventListener('click', (event) => {
  const button = event.target.closest('[data-color]');
  if (!button) return;
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
});

socket.on('robots', (payload) => {
  robots = payload.robots || [];
  renderRobots();
});

socket.on('scan', (payload) => {
  // a scan csak az aktuálisan hirdető robotokat tartalmazza — a már ismert
  // (pl. csatlakoztatott) robotokat nem szabad kivenni a listából
  for (const robot of payload.robots || []) upsertRobot(robot);
  renderRobots();
  els.scanBtn.disabled = false;
  els.scanHint.textContent = `Keresés kész: ${(payload.robots || []).length} robot.`;
  setStatus((payload.robots || []).length ? `${payload.robots.length} robot találva.` : 'Nem találtam robotot.');
});

socket.on('robot', (robot) => {
  upsertRobot(robot);
  if (robot.address === activeAddress) {
    els.activeName.textContent = `— ${robot.name || robot.address} —`;
    setStatus(`${robot.address}: ${robot.connected ? 'csatlakozva' : 'lekapcsolva'}`);
  }
});

socket.on('telemetry', (robot) => {
  upsertRobot(robot);
});

socket.on('command-result', (payload) => {
  setStatus(`OK: ${payload.action}`);
});

socket.on('error', (payload) => {
  setStatus(payload.message || 'Ismeretlen hiba.', true);
});
