# Changelog

A projekt verziózása [semver](https://semver.org/lang/hu/) szerint.

## [0.2.0] — 2026-10-20

### Added — webes vezérlő (Express.js backend, `server/`)
- **`server/` — új Node.js backend**: Express REST API + socket.io + statikus webes felület.
  A BLE réteg a **BlueZ D-Bus bindinget** használja (`@stoprocent/noble`), így **root nélkül**
  fut, és együtt működik a `bluetoothctl`-lel (a `noble` upstream Linuxon nyers HCI-t kérne).
- **Több robot egy szerveren**: a `RobotRegistry` (`src/ble/registry.js`) robotonként egy-egy
  BLE-kapcsolatot tart, saját telemetria-pollal; a REST és a socket felület ugyanazt a
  `RobotRegistry`-t használja.
- **Robot-felderítés, ami csak a robotokat mutatja** (`src/ble/scanner.js`): név-alapú
  ("Codie", "Codie 2"), hirdetett service-UUID-alapú és opcionális **MAC-allowlist** szűrés
  (`CODIE_MAC_ALLOWLIST`, `CODIE_MAC_ONLY`). A környezet többi BLE eszköze (fehallgatók,
  telefonok, fitnesz-karikák) nem jelenik meg.
- **Parancsréteg újrahasznosítható** (`src/commands.js`): ugyanaz a szemantika (cm→mm,
  fordulás-előjel, 0..200 cm vágás, 1..10000 ms beep) a REST API-n, a CLI-n és a konzolon.
- **Scriptek, amik "működnek"**: `scripts/scan.js` (robotok keresése), `scripts/control.js`
  (egy parancs non-interaktívan), `scripts/console.js` (interaktív konzol) — mind a backend
  moduljait használják, tehát a frontend később ugyanazokat a rétegeket tudja használni.
- **socket.io réteg** (`src/realtime.js`): szerver→kliens `robots`/`robot`/`scan`/`telemetry`/
  `command-result`, kliens→szerver `scan:request`/`robot:connect`/`robot:disconnect`/
  `robot:command`. A REST API és a socket ugyanazokat a műveleteket éri el.
- **JS wire-protokoll** (`src/ble/protocol.js`): a Python `codie/protocol.py` 1:1 portja.
  A `server/test/parity.test.js` a Python referenciával **bájtra bájtra** összehasonlítja
  (frame-ek, szekvencia, HSV-értékek, válaszdekódolás, Morse, ritmusok) — a port nem csúszhat el.
- 40 Node unit teszt (`server/test/`): protokoll, paritás, szűrő, parancsszemantika, REST API.

### Changed
- `README.md`: új „Webes vezérlő" szakasz + a `server/` a projektstruktúrában;
  `server/README.md` a részletes dokumentáció (API, socket-események, szűrők, konfig).

### Fixed (a web-backend első verziójában talált hibák)
- **UUID-forma:** a BlueZ binding kötőjel nélküli, kisbetűs UUID-kat ad vissza, a konstansaink
  kötőjelesek voltak → a write/notify karakterisztika-keresés és az UUID-alapú identitásszűrés
  nem működött. Most kanonikus UUID-összevetés (`canonicalUuid`/`sameUuid`) mindenütt.
- **Registry:** a `scan()` a normalizálatlan címmel tárolt a robotot (a `describe()`/`get()`
  normalizál) → a robot eltűnt a listából. A scan is normalizál.
- **Connect:** a sikertelen connect lezárása (`disconnectAsync`) elakadhatott a BlueZ-en;
  a takarítás most időtartam-biztosított. A connect **egyetlen** BlueZ-kapcsolatot indít és
  arra türelmesen vár (a retry-k ugyanarra a promise-re várnak), így a robot ébredésére
  befejeződik, nem szakad meg a próbálkozások között.
- **Scriptek:** a `process.exit()` eldobta a pipe-on ki nem flush-olt kimenetet (tiszta kilépés
  `finish()` helperrel), és a konzol nem sorban futtatta a parancsokat, illetve stdin-EOF-nal
  megszakította a futó scan-t (parancssor + a futó parancs megvárása kilépéskor).

### Fixed (kód-review findings — a review 19 hibát jelzett, mind javítva)
- **Ritmus/Morse időzítés (P0):** a `playRhythm` a Python `asyncio.sleep` másodperc-osztását
  vette át, de a JS `sleep` ezredmásodpercet vár → a Morse és a beépített ritmusok 1000×-s
  rövidebbek voltak a tervezettnél (a csipogások egybeolvadtak). Javítva + regressziós teszt.
- **Scanner beragadás (P0):** a noble a `startScanning` promise-t a binding `scanStart`
  eseményéből oldja fel, a BlueZ binding pedig a hibát `warning` eseménybe teszi → hiba
  esetén a promise **soha nem teljesül**, és a scanner sora örökre megállt (minden későbbi
  scan/connect néma kérésre sem válaszolt). Most időtartam-biztosított indítás/leállítás,
  `warning`-ra azonnali hiba.
- **Telemetria 2,5 mp-es stall (P0):** a `status()` a feszültséget is lekérdezte, ami ezen a
  firmware-en **nem válaszol** → minden telemetria-kör 2,5 mp-et várt. A feszültség kikerült
  a `status()`-ból (külön metódus maradt), és a robotok telemetriája párhuzamosan fut.
- **Paraméter-validáció (P1):** a nem számértékű paraméter (`"abc"`) csendben 0-vá esett össze,
  és egy hibás `turn` kérés **balra forgatta** a robotot. Most `400`-as hibát dob.
- **HTTP státuszok (P1):** minden hiba 400 volt; most a validáció 400, a nem csatlakoztatott
  robot 409, a BLE-hiba 503, a programozási hiba 500.
- **MAC-only mód (P1):** üres allowlist mellett néma hiba volt (minden "Codie" átment); most
  üres allowlist mellett semmi nem megy át, és a szerver induláskor elbuktatja a hibás
  konfigurációt.
- **Memóriaszivárgás (P1):** a `notifications` history korlátlan volt (a telemetria 5 mp-enként
  növelte) → most a legutóbbi 100 bejegyzés marad meg.
- **`_pending` szivárgás (P1):** sikertelen BLE write után a válasz-felfedező bejegyzés bent
  maradt; most a `finally` mindig törli.
- **Párhuzamos connect (P1):** két párhuzamos `connect` két klienst hozott létre ugyanahhoz a
  címhez, és az árva kliens lekapcsolódása offline-ba tette a robotot. Most a műveletek
  cím szerinti sorba állnak, és csak az aktuális kliens nullázza az állapotot.
- **Duplázott események (P2):** egy lekapcsolódás 3 `robot` eseményt váltott ki; most egyet.
- **Socket-események (P2):** a REST-en kiadott parancs eredménye is elment a socketre
  (`command-result`), a `scan` esemény nem duplikálódik, és a frontend a scan után nem
  veszíti el a listából a már ismert robotokat.
- **Python `colorsys` paritás (P2):** a JS `%` megtartja a jelet, a Python nem → a hue-átváltás
  most pontosan a Python `colorsys` viselkedését követi.

## [0.1.0] — 2026-07-07

### Added — a Codie BLE vezérlés első importálása
- Python package (`codie/`): a visszafejtett wire-protokoll (`protocol.py`), az aszinkron
  bleak kliens (`client.py`) érzékelő-, mozgás- és hangparancsokkal, a Morse/ritmus réteg,
  és a FastMCP szerver a Hermes/agent integrációhoz.
- A protokoll forrása: a 2016-os csorbazoli/CodieController Java PoC `DataPackage.java` és
  `CodieCommandType.java` fájljaiban megmaradt frame-formátum — a hivatalos Codie BLE API v1.0
  (`docs/comApi.h`) igazolta.
- Mérőeszközök (`scripts/`): akku-trend, mikrofon-figyelés, FFT frekvenciamérés (a csipogó
  ~2483 Hz-es önrezgő buzzer), mozgásirány-igazolás.
- Dokumentáció: `CLAUDE.md` (hardver- és protokollreferencia), `MEMORY.md` (a döntések és
  mérföldkövek naplója), `CHANGELOG.md`, `README.md`.

### A Python oldal fejlődése (2026-07-07)
A Python csomag külön verziókban nőtt ki, mielőtt a projekt importálásra került:
- 0.2.0 — a hivatalos SDK-val validált protokoll + a HSV 0-255 skála javítása.
- 0.3.0 — a teljes funkció-teszt kész (érzékelők, beep, mozgás, LED).
- 0.4.0 — hang: ritmus és Morse.
- 0.5.0 — a mikrofon hallja a saját csipogását (burkoló, nem frekvencia).
- 0.6.0 — FFT: a csipogó hangmagasságának mérése (~2483 Hz, önrezgő piezo-buzzer).
- 0.7.0 — MCP szerver a Hermes/agent integrációhoz.
- 0.7.1 — konkrét Hermes MCP-config + lusta BLE-csatlakozás.
- 0.8.0 — Hermes skill (robot-playbook).
- 0.8.1 — adatvédelem: a home-dir/scratchpad út kikerült a repóból.
- 0.9.0 — robusztus connect (retry + felébresztő scan).

### Verified
- Élő BLE kapcsolat és beep-parancs 2026-07-07-én (SpeakBeep), ismételhetően.
