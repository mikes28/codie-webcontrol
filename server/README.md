# Codie web-backend

Express.js + socket.io backend, ami a Codie oktatórobotokat BLE-en (BlueZ) vezérli.
Több robotot is kezel egyszerre, és a keresés **csak a robotokat** mutatja — a környezet
többi BLE eszköze (fehallgatók, telefonok, fitnesz-karikák) kiszűrve.

A wire-protokoll a repo Python kliensének (`codie/protocol.py`) 1:1 JavaScript portja;
a `test/parity.test.js` bájtra bájtra összehasonlítja a kettőt.

## Telepítés

```bash
cd server
npm install
cp .env.example .env      # opcionális — a repó gyökerének .env-je is betöltődik
```

A BLE réteg a **BlueZ D-Bus bindinget** használja (`@stoprocent/noble`), ezért:

- nincs szükség rootra vagy `setcap`-re (a `bluetoothctl` mellett is fut);
- a `dbus-next` csomag a host projektben kell (a `npm install` felteszi);
- a gépen futnia kell a `bluetoothd`-nek (`bluetoothctl show` működik → rendben van).

## Futtatás

```bash
npm start          # Express + socket.io a 3000-es porton (http://localhost:3000)
```

A szerver a `public/` mappát is kiszolgálja — a csomagolt felület a `http://localhost:3000`
címen érhető el.

## A robotok keresése (csak a Codie-k)

```bash
npm run scan                       # 10 mp scan, csak a robotok
node scripts/scan.js --duration 30000
node scripts/scan.js --json
node scripts/scan.js --name Codie --mac DF:74:94:43:36:ED
```

A szűrő két "identity" jelet használ, plusz egy opcionális MAC-allowlistet:

| Szabály | Viselkedés |
|---|---|
| név | a hirdetett név a szűrővel kezdődik (`Codie`, `Codie 2` …) — a szűrő kis/nagybetű független |
| service UUID | a hirdetett UUID-k egyike a `CODIE_ROBOT_UUIDS` listában (név nélküli robotot is elkap) |
| MAC-allowlist | ha `CODIE_MAC_ALLOWLIST` nem üres, csak az abban lévő címek jöhetnek át |
| `CODIE_MAC_ONLY=1` | az allowlist önmagában is elég (a név/UUID-ellenőrzés kimarad) |

> A robot random (privát) BLE-címet használ, és idővel elalszik. A scan felébreszti,
> ezért a keresés hosszabb ablakot érdemes használni, mint gondolnád.

### A robot alvás közben

A Codie **egyetlen hirdetés után visszaalvik**, és alvás közben nem fogad BLE-kapcsolatot:
a BlueZ `Connect()`-je "Attempting to connect"-ig jut, majd nem fejeződik be. Ez
hardver-korlát, nem a backend hibája — a Python (bleak) referencia pontosan ugyanígy
elhasal (`BleakDeviceNotFoundError`).

Ezért:

- **a csatlakozáshoz a robotnak ébren kell lennie** (gombnyomás vagy a hivatalos app);
- a kliens türelmesen vár: **egyetlen** BlueZ-connectet indít, és arra vár
  (`CODIE_CONNECT_TIMEOUT_MS` × `CODIE_CONNECT_RETRIES`), közben a BlueZ a háttérben
  újrapróbálkozik — amikor a robot felébred, a kapcsolat feláll;
- a scan **mindig** találatot ad (a BlueZ gyorsítótárazott bejegyzését is), de ez még
  nem jelent élő kapcsolatot.

## Scriptek (újrahasznosítható modulokra épülnek)

| Script | Mit csinál |
|---|---|
| `node scripts/scan.js` | robotok felderítése a környezetben |
| `node scripts/control.js --robot <CÍM> led red` | egy parancs, non-interaktívan |
| `node scripts/control.js led red` | `--robot` nélkül: scan, aztán az első találat |
| `node scripts/console.js` | interaktív konzol (a backend moduljait használja) |

A `console.js` parancsai: `help`, `scan`, `robots`, `connect <cím>`, `disconnect`,
`use <cím>`, `status`, `battery`, `sonar`, `light`, `line`, `mic`, `led <szín> [index]`,
`leds off`, `beep [ms]`, `morse <szöveg>`, `tune <név>`, `forward [cm]`,
`backward [cm]`, `turn <fok>`, `stop`, `quit`.

## Több robot

A `RobotRegistry` (`src/ble/registry.js`) robotonként egy-egy `CodieClient`-et tart
(saját BLE-kapcsolat), így több robot is fut egyszerre. Minden robot kap:

- saját kapcsolat (`connect` / `disconnect`);
- saját telemetria-poll (alapértelmezetten 5 mp, `CODIE_TELEMETRY_MS`);
- a `scan` találatok automatikusan bekerülnek a registry-be, connect nélkül is.

## REST API

| Végpont | Metódus | Leírás |
|---|---|---|
| `/api/health` | GET | él-e a szerver |
| `/api/config` | GET | a szűrő és a parancsnevek |
| `/api/robots` | GET | az ismert robotok + telemetria |
| `/api/robots/:address` | GET | egy robot |
| `/api/scan` | POST | `{ durationMs? }` → robotok keresése |
| `/api/robots/:address/connect` | POST | csatlakozás |
| `/api/robots/:address/disconnect` | POST | lekapcsolás |
| `/api/robots/:address/command` | POST | `{ name, params }` → parancs |
| `/api/robots/:address/telemetry` | GET | az utolsó telemetria |

A `name` a `src/commands.js` parancsneve: `beep`, `morse`, `tune`, `led`, `ledSingle`,
`ledsOff`, `forward`, `backward`, `turn`, `stop`, `status`, `battery`, `sonar`, `light`,
`line`, `mic`.

Példa:

```bash
curl -X POST localhost:3000/api/robots/00:07:80:66:F0:DB/command \
  -H 'content-type: application/json' \
  -d '{"name":"led","params":{"color":"red"}}'
```

## socket.io

A szerver a registry eseményeit minden kliensnek továbbítja:

| Irány | Esemény | Adat |
|---|---|---|
| szerver → kliens | `robots` | `{ robots: [...] }` — a teljes lista |
| szerver → kliens | `robot` | egy robot (frissült állapot) |
| szerver → kliens | `scan` | `{ robots: [...] }` — keresési eredmény |
| szerver → kliens | `telemetry` | egy robot + az utolsó szenzorértékek |
| szerver → kliens | `command-result` | `{ action, ... }` |
| szerver → kliens | `error` | `{ message }` |
| kliens → szerver | `scan:request` | `{ durationMs? }` |
| kliens → szerver | `robot:connect` | `{ address }` |
| kliens → szerver | `robot:disconnect` | `{ address }` |
| kliens → szerver | `robot:command` | `{ address, name, params }` |

## Felépítés

```
src/
  index.js          szerver indítása (Express + socket.io)
  app.js            Express alkalmazás (injektálható registry-vel)
  config.js         környezeti változók + .env betöltés
  commands.js       magas szintű parancsok (a REST/CLI/konzol közös rétege)
  morse.js, tunes.js, cli.js
  ble/
    protocol.js     wire-protokoll (a Python protocol.py portja)
    client.js       CodieClient — egy robot BLE-kapcsolata
    scanner.js      robot-szűrő + scan (a nem-robot eszközöket kiszűri)
    registry.js     több robot kezelése
    noble.js        BlueZ D-Bus binding példány + cím-formázás
  routes/robots.js  REST API
  realtime.js       socket.io események
public/             a csomagolt webes felület
scripts/            scan.js / control.js / console.js
test/               unit tesztek + Python paritás + API teszt
```

## Tesztek

```bash
npm test
```

- `protocol.test.js` — a wire-protokoll unit tesztje
- `parity.test.js` — a JS port és a Python referencia byte-paritása (python3 kell hozzá)
- `scanner.test.js` — a robot-szűrő (a nem-robot eszközök kiszűrése)
- `commands.test.js` — a parancsszemantika (irányjelek, vágások)
- `api.test.js` — a REST API hamis registry-vel
