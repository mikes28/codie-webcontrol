# Changelog

A projekt verziózása [semver](https://semver.org/lang/hu/) szerint.

## [0.4.0] — 2026-10-21

### Added
- **Beépített LED-animáció (`ledAnim`)** a routing nélküli generációhoz. A protokollban
  a `CMD_SET_ANIMATION` (0x0009) már deklarálva volt, de se kliensmetódus, se parancs
  nem használta. A [codiejs](https://github.com/zbettenbuk/codiejs/blob/master/lib/codie.js)
  referencia szerint a frame `animation | hue | sat | repeat | speed`, ahol az animáció
  sorszáma **0 vagy 1** (*"Possible animation values: 0, 1"*) — a szín a `setColor`
  skáláján megy ki (hue 0-360 ×0,7; sat 0-100 ×2,55).
  - Kliens: `CodieClient.ledAnimation(animation, { color, repeat, speed })`.
  - Parancsréteg: `ledAnim` a `COMMAND_NAMES`-ben → REST (`POST /api/robots/:address/command`),
    CLI (`node scripts/control.js anim 1 red`) és konzol (`anim <0|1> [szín]`).
  - Felület: **Anim 1** / **Anim 2** gombok a Fény csoportban (a legutóbb kiválasztott
    LED-színben futnak).
  - A **routingos** generációban a `LedStartAnim` (0x1066) paraméterei nem dokumentáltak
    (a `comApi.h` csak a parancsot listázza) → ott a parancs szabályos hibát ad (501),
    nem találgat paramétereket.

## [0.3.1] — 2026-10-21

### Fixed
- **A BLE-listener-ek nem halmozódnak az újracsatlakozások során.** A noble cache-eli a
  peripheral-t és a karakterisztikákat, a kliens viszont minden kapcsolatnál új
  `'data'` listenert kötött rá a notify/reply karakterisztikákra, és a
  `peripheral` `'disconnect'` listenert sem szedte le → 20 óra alatt 11 listener
  volt egy karakterisztikán (`MaxListenersExceededWarning`), és minden notify-t
  minden régi kliens feldolgozott. Javítás: a kliens megjegyzi a saját
  listener-eit, és a kapcsolat megszakadásakor (illetve a `_setup` újrapróbálkozásakor)
  leveszi őket. Regressziós teszt: `server/test/client.test.js` —
  „az újracsatlakozás nem halmozza a BLE-listener-eket a karakterisztikán”.
  Élőben igazolva: 12 egymás utáni le-/újracsatlakozás után is 0 figyelmeztetés.

## [0.3.0] — 2026-10-20

### Added — a második Codie-generáció támogatása
- **Két Codie-generáció, automatikus felismeréssel.** A BLE kliens a GATT-elrendezésből
  eldönti, melyik protokollal beszéljen a robottal:
  - **routingos** (`52af0001-978a-628d-c845-0a104ca2b8dd`): `INFO(1) | SEQ(2) | CMD(2) |
    ARGLEN(2) | ARG…` frame, write `52af0002`, notify `52af0003` — ez a repo Python
    `codie/protocol.py` kliensének protokollja;
  - **routing nélküli** (`d46e7e53-ba2f-4044-ade9-f85ead45f458`): `SEQ(2) | CMD(2) | PARAM…`
    frame, **négy** karakterisztika (request `25ad752e…` + reply `02a92ec6…`, action
    `0b08f48d…` + reply `8a7f8f01…`) — ezt a
    [zbettenbuk/codiejs](https://github.com/zbettenbuk/codiejs) dokumentálja.
- **Új modul `src/ble/protocol-norrouting.js`**: a routing nélküli generáció parancs- és
  érzékelő-ID-k, frame-kódolás/dekódolás, a válasz `SEQ(2 LE) | VALUE(változó hosszúságú LE)`
  formátuma (akku 1 bájt, távolság/fény/hang 2 bájt, vonal 4 bájt, nyugta 1 bájt) és a
  normalizálások (távolság 0,1 mm egységből mm, akku 100-ra vágva).
- **A parancsréteg generációfüggetlen**: a `src/commands.js` ugyanazt a parancskészletet
  látja mindkét generációnál, csak a frame-formátum és a skálák térnek el. A LED-szín
  átvitele routing nélkül: hue `×0,7` (0-360 → 0-252), saturation/value `×2,55`
  (0-100 → 0-255). A routing nélküli csipogás **hangerőt és frekvenciát is** visz
  (`volume` u8 + `frequency` u16 + `duration` u16) — a routingos `SpeakBeep` csak a
  hosszát küldi.
- **`variant` a robot leírásában**: a `RobotRegistry.describe()` most a felismert generációt
  is visszaadja (`'routing'` | `'no-routing'` | `null` — `null`, ha még nincs csatlakozva).
- **Az `/api/config` a támogatott generációkat is közli** (`variants: ['routing',
  'no-routing']`), így a frontend alkalmazkodhat; a `server/public/` felület pedig a robot
  neve mellett **generáció-jelvényként** mutatja ezt.

### Changed
- **A connect folyamat újraírva, a Python `codie/client.py` 1:1 portja szerint**:
  csatlakozás **cím** alapján (`noble.connectAsync(address)` — nem egy megscanelt
  peripheral-objektum), a próbálkozások között **ébresztő scan** (`_scanWake()`), a
  részleges állapot takarítása sikertelen próba után, és a retry-ciklus
  (`CODIE_CONNECT_RETRIES` × `CODIE_CONNECT_TIMEOUT_MS`).
- **A scanner kapott egy `wakeScan()` és egy `connectSession()` segédet** — a wake scan
  felfedezi a BlueZ-ben a címet (ez a Python `_scan_wake()` portja), a connect session
  pedig nyitva tartja a discovery-t, hogy a robot **friss** ébredését kapjuk el (a
  BlueZ gyorsítótárazott bejegyzése önmagában nem elég).
- **A firmware-quirkök miatt sorosított kérések**: a routing nélküli generáció eldobja a
  még folyamatban lévő kérésre érkező üzenetet → az érzékelő-kérések és az akciók is
  külön sorban (`_queryChain` / `_actionChain`) futnak, egyenként.
- **A GATT-write időtartam-biztosított** (`CODIE_WRITE_TIMEOUT_MS`, alap 3000 ms) — enélkül
  egy elalvó roboton a write végtelenül függne, és az egész szerver lefagyna.
- **Az első kérés eldobása megkerülve**: a connect után a kliens egy echo-t küld az
  action-csatornán és egy értéktelen akku-lekérdezést a request-csatornán, így az első
  **valódi** kérés mindig választ kap.
- **Új, konfigurálható timeoutek** (a korábban beégetett értékek helyett):
  `CODIE_RESPONSE_TIMEOUT_MS` (2500), `CODIE_QUERY_TIMEOUT_MS` (1200),
  `CODIE_WRITE_TIMEOUT_MS` (3000), `CODIE_STATUS_TIMEOUT_MS` (10000).
  A `config.js` új `registryOptions(ble)` segédje egy helyen szolgáltatja a registry
  opcióit a szervernek és a scripteknek.

### Fixed
- **A válasz-dekódolás a routing nélküli generáción**: a dekóder 4 bájtnál többet
  követelt, ezért a 3 bájtos (1 bájtos értéket tartalmazó) válaszokat `null`-nak
  olvasta → a mért értékek (akku 96 %, szonár ~125 mm, fény ~4000, vonal ~93 325 135)
  most helyesen jönnek.
- **A kliens nem hagyatkozott a `peripheral.state`-re**: a noble a connect promise
  feloldása **után** állítja be az állapotot, ezért a kliens saját kapcsolat-jelzőt használ
  (a kapcsolat nem számít offline-nak, ha épp beáll).
- **A sikertelen connect nem hagy félig állapotot**: a részleges kliens lezárása
  időtartam-biztosított, és a `_pending` válasz-kérések a timeout után is törlődnek.

### Fixed — a webes felület megbízhatósága (a „működjön hibátlanul" cél)
- **Egy hibás BLE-csomag megszakíthatta volna az egész szervert**: a kliens
  `error` eseménye listener nélkül **dobja** az exceptiont (Node `EventEmitter`),
  így egy rossz csomag azonnal ledobta a webes felületet. A kliens most beépített
  listenerrel továbbítja (`ble-error` esemény), és a registry a felülethez is
  eljuttatja (`robot-error`).
- **A parancsok nem hazudtak**: ha a robot nem nyugtázta a parancsot, a felület
  mégis „OK”-t írt. Most a hiányzó nyugta (504) és a hiányzó érzékelő-válasz
  **hiba**, amit a felület kiír; a részleges `status` továbbra is OK.
- **A firmware eldobta a parancsokat a telemetria-poll alatt**: élőben mérve a
  15 parancsból 1 elveszett (a lekérdezés még folyamatban volt, és a routing
  nélküli firmware az ilyen üzenetet eldobja). A parancsok most megvárják a
  futó lekérdezéseket (`_waitForIdleQueries`), a szóló ritmus (Morse / beépített
  minta) alatt pedig a lekérdezések várnak a ritmusra — így a hang sem csökken ki.
  Élőben mérve utána: 20/20 beep és 10/10 LED parancs sikeres.
- **A megszakadt kapcsolat nem jött vissza magától**: a registry most
  újracsatlakozik (korlátolt számú próbával, `CODIE_AUTO_RECONNECT`,
  `CODIE_RECONNECT_ATTEMPTS`, `CODIE_RECONNECT_DELAY_MS`), és a felület
  „újracsatlakozás…” állapotot mutat. Élőben igazolva: a BLE-kapcsolat
  megszakítása után ~10 mp alatt újra online volt a robot.
- **A vonal-érzékelő értéke félrevezető volt**: a routing nélküli generációban
  nincs két 12 bites érzékelő-érték, hanem **egyetlen** 32 bites, fix-pontos
  érték (60 élő mintában mindig `0x05xx07yy` volt a bájtminta). A kliens a
  codiejs referencia szerinti skálát használja (2^20, küszöb 30) és
  `{ value, level, onLine }` alakot ad vissza; a felület így „86.9 · vonalt
  követ”-t mutat a korábbi „90179333 / 90179333” helyett.
- **A LED-szín 1-gyel kisebb telítettséggel ment ki**: a `100 * 2,55` float-értéke
  254,99999999999997, így a `floor` 254-et küldött a helyes 255 helyett — most
  kerekítés (`Math.round`).
- **A scriptek el sem indultak**: a `scripts/control.js` és `scripts/console.js`
  a `registryOptions` segédet használta, de nem importálta → `ReferenceError`
  minden indításkor. Javítva + új smoke-teszt (`test/scripts.test.js`).
- **A felületen a kapcsolat állapotváltozása nem jelent meg**: a csatlakozás /
  lekapcsolás most a státuszsorban is látszik (a korábbi „OK: …” felülírása
  nélkül), a telemetria mellett pedig megjelenik a frissesség („frissítve: 2 mp
  ezelőtt”), és az elavult adatok halványodnak.
- **A generáció badge-je lekapcsoláskor „ismeretlen” lett**: a felismert
  generáció megmarad, így a felület továbbra is mutatja, melyik robot melyik
  protokollal beszél.
- **Kód-review (3 subagent: backend, frontend+tesztek, dokumentáció) — a
  talált hibák javítva:**
  - A **write gap nem volt atomi**: két párhuzamos írás (a lekérdezési és az
    akciósor két külön lánc) ugyanabban a milliszekundban mehetett ki, és a
    firmware eldobta az egyiket → a slot most szinkron foglalódik. A kötelező
    szünet csak a **routing nélküli** firmware-re érvényes (a routingos a
    párhuzamos kéréseket bírja).
  - A **felhasználói parancs beleszúródhatott a Morse közepébe** → a
    felhasználói parancs most a ritmus végére vár, a ritmus saját hangjai
    (internal) azonnal mennek ki.
  - A **BlueZ „In Progress” hiba** (egy korábbi connect maradványa) azonnali
    hibaként szakította meg a csatlakozást → most megvárjuk és újrapróbáljuk.
  - A **telemetria-kör megduplázódhatott**, ha egy futó lekérés közben
    leállították/újraindították → generációs számláló védi.
  - A **sikertelen első connect után** nincs újracsatlakozás → most van
    (korlátozott próbálkozásszámmal).
  - A **vonal-érték lejárt körből** is frissíthette a telemetriát → a lejárt
    kör értékeit eldobjuk.
  - A **Morse gomb kétszer kezelődött** (minden kattintás hamis hiba) → a
    generikus handler kihagyja.
  - A **„Robotok keresése” gomb hibás scan után letiltva maradt** → most
    visszakapcsol.
  - A **mikrofon-figyelés a váratlan BLE-drop után örökre befagyasztotta** a
    telemetriát → a figyelés leáll a drop-pal.
  - A **scriptek smoke-tesztje** korlátlanul futhatott (nincs timeout) → most
    SIGKILL-lel levágja a gyermek-folyamatot; a scan-teszt nem nyúl a rádióhoz.
  - A `unitMs` (Morse) paraméter validálása, a `stopMicStream` 404-es
    válasza, a `mic` esemény a leállítás után, a `status()` timeoutja után
    érkező értékek, a halott kód (`i16`) és a `_operations` térkép tisztítása.

### Added — gyorsabb érzékelő-frissítés és mikrofon-figyelés a felületen
- **Az érzékelőadatok érzékelőnként frissülnek**: a telemetria-poll minden mérés
  megérkezésekor eseményt küld (nem csak a teljes lekérés végén), és a poll
  önmagát újraütemezi → a felület **~90 ms-onként** frissül, a teljes
  4 érzékelős kör ~400 ms (a robot egy lekérdezésre ~100 ms alatt válaszol —
  ez a hardver korlátja). A `CODIE_TELEMETRY_MS` (alapértelmezetten 250 ms) a
  kívánt periódus; ha a robot nem bírja, a kör azonnal újraindul.
- **A BLE-write szünet finomítható** (`CODIE_WRITE_GAP_MS`, alapértelmezetten 50 ms):
  élőben mérve 30–150 ms között hibátlan volt (30/30 lekérdezés), a nyugtázatlan
  (ritmus) üzeneteknél külön 150 ms érvényes, hogy a firmware ne dobja el őket.
- **Mikrofon-figyelés a felületen**: a „Mikrofon" panel gombja elindítja a
  figyelést, a felület szintmérőt mutat (nagyságrendi érték + csúcsjelző).
  A robot nem hangot ad, hanem nyers erősségi értéket (0..2048) — a
  `mic` socket-esemény szállítja (`{ address, raw, level, peak }`).
  REST-en: `POST /api/robots/:address/mic/start` és `…/mic/stop`.
  A figyelés periódusa `CODIE_MIC_MS` (alap 200 ms) — élőben mérve ~5 érték/mp.
- A figyelés alatt az érzékelő-lekérések **szünetelnek** (a firmware egy
  kérést szolgál ki egyszerre) — a felület a megmaradt értékeket stale jelöléssel
  mutatja, és a panel ezt kiírja.

### Verified (élőben, a valódi roboton, 2026-10-20)
- A connect, a négy érzékelő, a LED-szín, a beep, az előre/fordul/stop parancs mind
  elfogadva a routing nélküli generációjú roboton.
- **A robot BLE-címe stabil**: ki- és bekapcsolás után is ugyanaz
  (`00:07:80:66:F0:DA`) — a korábbi „alvás közben rotálja a BLE-címét” állítás
  nem igaz a routing nélküli generációra (ezért az újracsatlakozás is működik).
- **A robot töltőn van, akku nélkül** — ezért az akku-olvasat a töltő feszültsége, a
  firmware töltő-LED-animációja felülírja a színparancsot, és a kerekek töltés közben
  nem forognak. A mozgás- és LED-eredményeket ezzel együtt kell értékelni.

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
