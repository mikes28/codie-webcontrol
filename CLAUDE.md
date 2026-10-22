# Codie — BLE vezérlés Raspberry Pi 5-ről

Ez a projekt a **Codie oktatórobot** felélesztése: közvetlen Bluetooth Low Energy (BLE)
vezérlés Raspberry Pi 5-ről, BlueZ-n keresztül.

## Háttér

A Codie egy 2015–2016 körüli magyar oktatórobot. A hozzá tartozó
[csorbazoli/CodieController](https://github.com/csorbazoli/CodieController) egy 2016-os,
**félbehagyott** Java proof-of-concept volt, amely a robotot a Scratch 2 offline editorból
akarta vezérelni (helyi HTTP szerver + Scratch-blokkok). A szerző 2019-ben feladta: Windows
alatt nem talált BLE 4-es drivert, és úgy hitte, a `CodieGateway` protokoll dokumentálatlanul
elveszett.

Valójában a protokoll **nem veszett el** — a repo `DataPackage.java` és `CodieCommandType.java`
fájljai tartalmazzák a teljes, visszafejtett MCU-frame formátumot. A hiányzó láncszem csak a
PC→BLE fizikai út volt, ami BlueZ-vel (Linux) triviális.

**2026-07-07:** az RPi5-ről, BlueZ GATT-tal, a szerző saját frame-formátumával a robot élőben
fogadott és végrehajtott parancsot (SpeakBeep) — ismételhetően igazolva. Később előkerült a
**hivatalos Codie BLE API v1.0** dokumentáció + `comApi.h` (lásd `docs/comApi.h`), amely a
visszafejtett protokollt teljesen igazolta (egy hibát is feltárt: a HSV 0-255, nem 0-100).

**Jelenlegi állapot (v0.7.0):** a Python package (`codie/`) **nem** szól BLE-t
közvetlenül — a valódi hardver (routing nélküli generáció, `00:07:80:66:F0:DA`) a
**Node.js web-backend** (`server/`) kezeli. A Python oldal a backend **REST API-jára**
épül: `codie/api.py` (szinkron, standard-library kliens) + `codie/robot.py` (a magas
szintű robot-API transzport fölött) + `codie/tools.py` (9 async agent-tool) + vékony
`codie/mcp_server.py` (FastMCP burkolat). A firmware **visszafejtett** parancsnyelve
(`codie/console.py`: a 16 interfész, az opok, a hexadecimális számkiírás és a
válaszformák) a Python referenciája; a `codie/wire.py`, `codie/wire_norrouting.py`,
`codie/morse.py`, `codie/tunes.py` **paritás-referenciaként** élnek — a JS portok
(`server/src/ble/protocol.js`, `protocol-norrouting.js`) bájtra bájtra ezt követik, és a
`server/test/parity.test.js` ellenőrzi. A **weboldalnak van Python kommunikációs
scriptje** (`server/python/codie_comm.py`): a backend a robot-scripteket (`server/python/
scripts/`) ez indítja, a scriptek a `codie` API-ját használják, és a felületen lépésenként
látszik minden, amit a robot csinál. A FFT-s frekvenciamérés offline
(`scripts/fft_pitch.py`, a csipogó ~2483 Hz-es önrezgő buzzer). A verziózás semver +
git tag + GitHub release; a projekt repója: `github.com/mikes28/codie-webcontrol`
(publikus) — a történek forrása a `sanchomuzax/codie`, amit `upstream` remoteként
(fetch-only) használunk.

## Projekt struktúra

**Python package (`codie/`):**
- `console.py` — a **visszafejtett firmware parancsnyelve**: kérés `<get|set|call> <interface> <op> [args]`, a három válaszforma (érték / `:proxy message` / `:proxy greeting`), a hexadecimális számkiírás (a firmware a szenzorértékeket 16-on írja ki!) és a 16 interfész regisztere az opokkal, egységekkel és quirkekkel (a `drvBattery` válaszai `set` szóval jönnek, a motor-opok nem válaszolnak). A C referencia (`fw/modules/proxy.c`) byte-exakt portja.
- `wire.py` — a routingos generáció BLE frame-formátuma (INFO|SEQ|CMD|ARGLEN); **paritás-referencia** a JS port (`server/src/ble/protocol.js`) számára.
- `wire_norrouting.py` — a routing nélküli generáció frame-formátuma (SEQ|CMD|ARG); **paritás-referencia** a `server/src/ble/protocol-norrouting.js` számára.
- `robot.py` — a robot magas szintű API-ja bármilyen transzport fölött (a parancsszótár megegyezik a backend `src/commands.js` rétegével); a `stop` a hiányzó nyugtát nem tekinti hibának.
- `api.py` — `CodieApi`: szinkron REST kliens a Node.js backendhez (standard library, urllib). A BLE réteg a backendben van; ez a kapu. `CodieApiError` a 4xx/5xx/összeköttetési hibákat kezeli státusszámmal.
- `tools.py` — a kilenc async agent-tool (`mcp_codie_*` néven): érzékelés, véges mozgás, hang/LED. **Nincs `mcp` import**; a `CodieApi`-n keresztül szól a backendnek, így unit-tesztelhető.
- `mcp_server.py` — vékony FastMCP burkolat: csak a `tools.py`-t regisztrálja (stdio). A lényeg (lusta csatlakozás, reconnect, véges mozgás) a `tools.py`-ben.
- `morse.py` — szöveg → Morse-ritmus (szabványos időzítés).
- `tunes.py` — beépített ritmusminták (fix hangmagasság → ritmus, nem dallam).

**Szkriptek (`scripts/`):** `fft_pitch.py` (a csipogó domináns frekvenciája — offline FFT, nem BLE).

**Tesztek (`tests/`):** `test_console.py` (a firmware parancsnyelve), `test_wire.py` (a két
generáció BLE frame-formátuma), `test_api.py`, `test_tools.py`, `test_morse.py`,
`test_script_engine.py` (a weboldal Python script-futtatója) — unit teszt, robot nélkül futtatható.
**Hermes skill (`hermes/skills/robotics/codie-robot/SKILL.md`):** playbook az agentnek — mikor/hogyan
használja a `mcp_codie_*` toolokat (érzékelés, véges mozgás, buktatók, biztonság).
**Docs:** `docs/comApi.h` (hivatalos header), `CHANGELOG.md`, `VERSION`.

**Web-backend (`server/`, Node.js):**
- `src/ble/protocol.js` — a `wire.py` 1:1 JS portja (frame, parancs-ID-k, HSV 0-255).
  A `test/parity.test.js` bájtra bájtra összeveti a Python referenciával.
- `src/ble/protocol-norrouting.js` — a **routing nélküli** generáció protokollja
  (a `wire_norrouting.py` portja): `SEQ|CMD|ARG` frame, négy karakterisztika, `decodeLine()`.
- `src/ble/client.js` — `CodieClient` (noble/BlueZ D-Bus): connect retry + scanablak,
  notify-feliratkozás, SEQ↔REQSEQ párosítás, aktuátor- és szenzormetódusok,
  **generáció-felismerés** a GATT-elrendezésből, hibás csomag → `ble-error`
  (nem öli meg a szervert), a firmware-quirk miatt sorosított kérések.
- `src/ble/scanner.js` — robot-felderítés **szűréssel** (név / hirdetett UUID / MAC-allowlist);
  a környezet többi BLE eszköze nem jelenik meg.
- `src/ble/registry.js` — `RobotRegistry`: több robot, kapcsolatok, érzékelőnkénti
  telemetria-poll, **automatikus újracsatlakozás**, mikrofon-stream, események.
- `src/commands.js` — magas szintű parancsszemantika (a REST/CLI/konzol közös rétege);
  a hiányzó nyugta/érzékelő-válasz **hibát** dob (504), nem hamis „OK”-t.
- `src/scripts.js` — a Python robot-scriptek indítása és eseményeinek továbbítása.
- `src/app.js`, `src/routes/robots.js`, `src/realtime.js` — Express REST API + socket.io.
- `src/config.js` — környezeti változók (timeoutek, újracsatlakozás, write gap, mic periódus).
- `python/codie_comm.py` — **a weboldal Python kommunikációs scriptje**: a robot-scriptek
  futtatója (JSON-soros események a stdout-on, időhatár, a robot megállítása hiba esetén).
- `python/scripts/` — a robot-scriptek (`run(ctx)` függvény: négyzetes kör, őrjárat, vonalkereső, üdvözölés).
- `scripts/` — `scan.js`, `control.js`, `console.js` (a backend moduljait használják).
- `public/` — a webes felület (socket.io-n át): élő érzékelőadatok, mikrofon-szintmérő, script panel.

## Hardver / BLE topológia

| Elem | Érték |
|------|-------|
| Robot BLE cím (routingos gen.) | `DF:74:94:43:36:ED` (random address), Name: `Codie` |
| Robot BLE cím (routing nélküli gen.) | `00:07:80:66:F0:DA` — **stabil** (ki/bekapcsolás után is ugyanaz), Name: `Codie` |
| RPi5 adapter | `hci0` (a beépített BLE adapter) |
| Vendor service | `52af0001-978a-628d-c845-0a104ca2b8dd` |
| Write (parancs) char | `52af0002-978a-628d-c845-0a104ca2b8dd` — flags: `write`, `write-without-response` |
| Notify (válasz/szenzor) char | `52af0003-978a-628d-c845-0a104ca2b8dd` — flags: `notify` |
| Routing nélküli service | `d46e7e53-ba2f-4044-ade9-f85ead45f458` |
| Routing nélküli request char | `25ad752e-7a42-4c90-8526-90e85fb3741d` (érzékelő-kérés) |
| Routing nélküli request reply | `02a92ec6-0e7e-415c-a311-828a802c61d5` (indicate) |
| Routing nélküli action char | `0b08f48d-a33f-4a93-ad25-84928e2ef792` (beep/LED/motor) |
| Routing nélküli action reply | `8a7f8f01-8679-400c-b32b-464c71f5d06b` (indicate) |

A `52af0002` write-without-response → nincs ATT-szintű nyugta. A robot válaszai / szenzoradatai
a `52af0003` notify-csatornán jönnek vissza.

**Két generáció, eltérő protokollal** (a JS backend mindkettőt kezeli, a GATT-elrendezésből
automatikusan felismerve):

| | routingos | routing nélküli |
|---|---|---|
| service | `52af0001-978a-628d-c845-0a104ca2b8dd` | `d46e7e53-ba2f-4044-ade9-f85ead45f458` |
| frame | `INFO(1) \| SEQ(2) \| CMD(2) \| ARGLEN(2) \| ARG…` | `SEQ(2) \| CMD(2) \| ARG…` |
| karakterisztikák | 1 write + 1 notify | request + action (+ a két reply) |
| forrás | a repo `codie/wire.py` | a repo `codie/wire_norrouting.py` (a [codiejs](https://github.com/zbettenbuk/codiejs) protokollja) |

A routing nélküli firmware **eldobja az üzenetet, ha egy kérés még folyamatban van** — ezért
a JS kliens a parancsok előtt megvárja a futó érzékelő-lekérdezéseket, és a szóló ritmus
(Morse) alatt a lekérdezések megvárják a ritmus végét.

## Frame formátum

20 byte-os buffer, csak a kitöltött rész megy ki. Minden többbájtos mező **little-endian**.

```
INFO(1) | SEQ(2) | CMD(2) | ARGLEN(2) | ARGDAT...
```

- **INFO** = `(from.ordinal() << 4) | (to.ordinal() << 6) | prio`
  - Role ordinal: `APP=0, MCU=1, BLE=2, Broadcast=3`
  - prio: NORMAL=`0x00`, HIGH=`0x08`
  - Tipikus APP→MCU, normal prio: **`0x40`**
- **SEQ** — növekvő sorszám (tetszőleges, wrap 0xFFFF-nél)
- **CMD** — 2 byte parancs-ID (lásd lent)
- **ARGLEN** — az argumentumok hossza byte-ban
- **ARGDAT** — argumentumok; U8/I8 = 1 byte, U16 = 2 byte LE

### Parancs-ID-k (hivatalos `comApi.h`, az enum 0x1060-tól auto-inkrementál)

| Parancs | ID | Argumentumok | ReARG (válasz) |
|---------|-----|-------------|----------------|
| DriveSpeed | `0x1060` | speedLeft i8, speedRight i8 (%, előjeles) | nSuccessful u8 |
| DriveDistance | `0x1061` | distance u16 (mm), speedLeft i8, speedRight i8 | nSuccessful u8 |
| DriveTurn | `0x1062` | degree u16 (°), speed i8 (+ balra, - jobbra) | nSuccessful u8 |
| SonarGetRange | `0x1063` | — | range u16 (mm) |
| SpeakBeep | `0x1064` | duration u16 (ms, max 10000) | nSuccessful u8 |
| LedSetColor | `0x1065` | ledMask u16 (12 bit, **0x0FFF = mind**), hue u8, sat u8, val u8 (**HSV 0-255**) | nSuccessful u8 |
| LedStartAnim | `0x1066` | (beépített animáció) | — |
| AppConnected | `0x1067` | — (app csatlakozás jelzése) | — |
| AppDisconnected | `0x1068` | — | — |
| BatteryGetSoc | `0x1069` | — | soc u8 (%) |
| LightSenseGetRaw | `0x106a` | — | u16 (12 bit) |
| LineGetRaw | `0x106b` | — | left u16, right u16 (12 bit) |
| MicGetRaw | `0x106c` | — | u16 (0..~2048) |
| SwitchToBootloader | `0x106d` | ⚠️ **VESZÉLYES** — bootloaderbe vált | — |
| BatteryGetVoltage | `0x106e` | — | u16 (nyers feszültség) |

- Args: U8/I8 = 1 byte, U16 = 2 byte LE. **HSV skála 0-255** (a Java repo tévesen 0-100-at használt).

### Válasz (reply) formátum

A válasz a notify `52af0003`-on: az INFO route megfordul (MCU→APP), a CMD felső bájtja `0x80`-nal
jelölt (reply-flag). Az ARGLEN a **reply-SEQ (2 byte) + tényleges ReARG** hosszát adja; a hasznos
adat a 9. bájttól. Példa DriveDistance-válasz:
`10 | 28 00 | 61 90 | 03 00 | 12 00 , 00` → reply-SEQ=0x0012, nSuccess=0 (siker).

## A firmware saját parancsnyelve (visszafejtve)

Az STM32 nem bináris frame-eket beszél a BLE modullal: a modult AT parancsokkal
(`BLE-boot`, `PPRT`/`PPRET`) indítja, és a robot egy **szöveges** konzol-protokollon
válaszol. A firmware forrása (`fw/modules/proxy.c`) a repo Python portja: `codie/console.py`.

```
kérés     : "<get|set|call> <interface> <op> [args...]"     (max 40 byte, szóközökből hasítva)
válasz    : "<get|set|call> <interface> <op> [value]"
üzenet    : "call :proxy message <level> <text>[extra]"       (level: ???/inf/dbg/wrn/err)
köszöntő  : "call :proxy greeting "ver":"0.5.0hw2.1" … "msg:<text>""
```

A 16 interfész a firmware saját táblázatának sorrendjében: `hwiAdc`, `hwiLed`, `hwiDrive`,
`drvBattery`, `hwiSonar`, `bleCom`, `hwiBuzz`, `hwiMic`, `hwiEnc`, `hwiLine`, `hwiPower`,
`hwiLightSense`, `appLights`, `appDrive`, `appSys`, `appLightSense`.

**Amit ez a visszafejtés adott a projektnek (a korábbi „találgatás" helyett):**

- **A firmware minden érzékelőértéket hexadecimálisan ír ki** (`fmt_num(v, 16)`) — csak a
  `hwiAdc buf` ADC-kimutatás decimális. A `codie/console.py` `radix` mezője ezt tartalmazza.
- **A válasz szava nem mindig a kérés szava**: a `drvBattery` és a `hwiDrive` válaszai a C
  forrásban `OP_SET`-tel vannak beégetve (`get drvBattery voltage` → `set drvBattery voltage 7b0`).
- **Több op nem válaszol** (`hwiDrive dutyA/dutyB`, `hwiPower pwrOff`, `appSys hwInit`) — ezek
  fire-and-forget műveletek.
- **A `hwiDrive` duty hexadecimális argumentum**, −1000..+1000-re vágva (a `parse_hex16`).
- A `hwiLed` 4 státusz-LED-je van (0..3), a `hwiBuzz` 5 hangmintája (0..4), a `hwiLine`
  2 szenzora (0..1); a 12 címezhető LED és a mozgás a periodikus feladatban fut.
- A `hwiMic level` 0..~2048, a `hwiLightSense read` 0..255, a `hwiPower` GET a tápellátás
  „good" vonalát adja.
- A `bleCom` a BLE modul RX-gyűrűjének méretét adja vissza — ebből látszik, hogy a modul
  a firmware **proxy**-ja (`:proxy` = „a BLE modulon keresztül proxied").

## Igazolt parancs — beep (~1 mp)

Írás a `52af0002` karakterisztikára:

```
40 01 00 64 10 02 00 e8 03
│  │  │  │  │  │  │  └──┴─ duration u16 = 1000 ms (0x03E8)
│  │  │  │  │  └──┴─ ARGLEN = 2
│  │  │  └──┴─ CMD = 0x1064 (SpeakBeep), LE
│  └──┴─ SEQ = 1
└─ INFO = 0x40 (APP→MCU, normal)
```

A közvetlen APP→MCU kódolás működik; **nem** kellett a CMD felső bájtját `0x80`-nal jelölő,
REQSEQ-et beszúró alternatív BLE-forward variáns.

## Csatlakozás bluetoothctl-lel

A connect ~10 mp; a sessiont életben kell tartani (a heredoc azonnal lezárja a stdin-t, ezért
`sleep`-ekkel adagolt parancsokkal megy). Vázlat:

```bash
{
  echo "connect DF:74:94:43:36:ED"; sleep 11
  echo "menu gatt"; sleep 1
  echo "select-attribute /org/bluez/hci0/dev_DF_74_94_43_36_ED/service000c/char000d"; sleep 1
  echo "notify on"; sleep 2        # 52af0003 — válasz/szenzor stream
  echo "select-attribute /org/bluez/hci0/dev_DF_74_94_43_36_ED/service000c/char0010"; sleep 1
  echo 'write "0x40 0x01 0x00 0x64 0x10 0x02 0x00 0xe8 0x03"'; sleep 4   # 52af0002 — beep
  echo "exit"
} | bluetoothctl
```

(A `service000c/char0010` = `52af0002`, `service000c/char000d` = `52af0003` — a handle-alias
a konkrét BlueZ felderítéskor rögzült; connect után `menu gatt` → `list-attributes` ellenőrzi.)

## Biztonság

- **Mozgásparancsot (DriveDistance / DriveTurn / DriveSpeed) csak a töltőről levéve** és az
  asztal szélétől távol küldeni. Töltés közben tilos.
- Sípolás és LED biztonságos, mozgásmentes — életjel-próbához ezek valók.
- Minden fizikai actuálás (kiváltképp mozgás) előtt rákérdezni a felhasználónál.

## Hang / csipogó

A routingos generáción a `SpeakBeep` (0x1064) az egyetlen hang-parancs, csak `duration`
(a frekvencia fix). FFT-mérés szerint a hangkeltő valószínűleg **önrezgő piezo-buzzer
~2483 Hz-en** — a hangmagasság hardveresen fix, firmware-hackkel sem módosítható. A
kifejezőeszköz a **ritmus** (hossz + szünetek): a Python `morse.py` és `tunes.py` tartalmazza
a kódolást (a JS port `server/test/parity.test.js` ellenőrzi), a `beep`/`morse`/`tune` parancsok
a JS backend REST API-n keresztül kerülnek kiküldve.

A **routing nélküli** generáción a `CMD_BEEP` (0x0006) **hangerőt (u8) + frekvenciát
(u16) + időtartamot (u16)** is visz — ott a hangmagasság és a hangerő is állítható.

## Ismert hiba: a robot DFU/bootloaderben marad → a BLE-kapcsolat leesik

- **Tünet:** a backend connectje `le-connection-abort-by-local` hibát dob (a noble
  `disconnected: remote`-ot lát), a nyers `bluetoothctl connect` viszont "Connection
  successful"-t ír, és 1–2 mp múlva a link leesik (`Connected: no`). A robot **hirdet**
  (név "Codie", service `d46e7e53-…`) → a BLE-modul él, tehát nem BLE-hiba.
- **Ok:** a robot STM32-je a **ROM DFU bootloaderben** fut, nem az alkalmazásban → a
  `BLE-boot` kézfogás (USART1) nem történik meg, a BLE-modul stale marad: elfogadja a
  linket, majd ledobja. A flash tartalma ilyenkor **jó** (a hash egyezik) — a hiba a
  *boot mód*, nem a firmware. A kernel naplója mondja ki: `0483:df11 STM32 BOOTLOADER`.
- **Javítás (az alkalmazásba indítás):**
  ```bash
  cd ~/Documents/kurwa/codie
  bash scripts/dfu/dfu-container.sh -- dfu-util -d 0483:df11 -a 0 -s 0x08000000:leave
  ```
  Alternative: áramellátás-váltás (USB kihúzás + akkumulátor lekapcsolás ~10 mp, majd
  bekapcsolás) → a chip resetel és a flashből bootol. A `:leave` a determinisztikus út.
- **Szabály:** minden DFU-művelet után, a legutolsó olvasás után is `:leave` kell, különben
  a chip a bootloaderen marad. A `scripts/dfu/backup.sh` (a `--no-option-bytes` esetben is),
  a `scripts/dfu/flash.sh` és a `scripts/dfu/restore.sh` már kilép a DFU módból — a
  RE-projekt saját `fw/flash.sh`-e (`~/Documents/codie-firmware-dump/`) is.
- **Árhullámok:** a BlueZ a távoli eszköz saját bontását is `le-connection-abort-by-local`-nak
  nevezi (HCI 0x16, de a robot küldi); illetve ha a futó backend és egy kézi kliens ugyanahhoz
  a robothoz csatlakozik, a kernel megszakítja a korábbi kapcsolatkérést → ugyanaz a hiba.
  **Egy BLE kliens legyen egyszerre a rádión.**

## Következő lépések / nyitott

- A **mozgásirány-előjel élű igazolva** (a JS backenden keresztül): előre/hátra/jobbra/balra
  helyes, nincs előjel-javítás. A `turn` konvenciója (pozitív fok = jobbra) a `CodieApi.turn()`-ben
  és a `tools.py` `turn()`-ban is ez.
- A **robusztus connect** kész: retry + felébresztő BLE-scan, és a JS backend
  a megszakadt kapcsolatot **újracsatlakozza**. A mid-call retry is a JS backend kezeli
  (a Python oldalon már csak egy szinkron REST hívás maradt — nincs értelme újraverik).
- A **vonal-érzékelő fizikai jelentése** a routing nélküli generáción még nincs
  bizonyítva: a 4 bájtos érték egyetlen fix-pontos szám (a codiejs 2^20-as skáláját
  használjuk, küszöb 30); a nyers érték az API-n elérhető.
- **Hermes MCP-config:** a `~/.hermes/config.yaml` `mcp_servers` részében a `codie` MCP-szerver a
  `CODIE_API_URL`-t és a `CODIE_ADDRESS`-t használja (a BLE réteg a backendben van, a szerver lustán
  csatlakozik). `PYTHONPATH` még szükséges (nincs `cwd` a Hermes sémában). Nyitott: beírni az élő
  `~/.hermes/config.yaml`-ba (user jóváhagyásával) + `/reload-mcp`.
- Opcionális: `LedStartAnim` (0x1066) beépített animációk; magasabb szintű skillek (vonalkövetés
  a `line()`-nal, szonár-akadálykerülés), vagy a Scratch-blokkos réteg újraélesztése.
