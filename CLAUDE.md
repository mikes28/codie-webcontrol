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

**Jelenlegi állapot (v0.4.0):** működő Python package (`CodieClient`), minden funkció élőben
igazolva (szenzorok, hang, mozgás, LED), hang/ritmus/Morse réteg, FFT-alapú frekvenciamérés
(a csipogó ~2483 Hz-es önrezgő buzzer), egy MCP szerver a Hermes-integrációhoz, és egy
**Express.js web-backend** (`server/`), amely **mindkét Codie-generációt** beszél
(a routingost a Python-egyben, a routing nélkülit a JS-ben), élő érzékelőadatokkal,
mikrofon-figyeléssel, beépített LED-animációval és automatikus újracsatlakozással. A verziózás
semver + git tag + GitHub release; a projekt repója: `github.com/mikes28/codie-webcontrol`
(publikus) — a történet forrása a `sanchomuzax/codie`, amit `upstream` remoteként
(fetch-only) használunk.

## Projekt struktúra

**Python package (`codie/`):**
- `protocol.py` — wire-protokoll: frame encode/decode, parancs-ID-k, szín-HSV (0-255). Függőségmentes, unit-tesztelt.
- `client.py` — `CodieClient`: aszinkron bleak kliens, notify-feliratkozás, SEQ↔REQSEQ kérés/válasz párosítás; aktuátor- és szenzormetódusok + hang (`play_rhythm`/`play_morse`/`play_tune`).
- `morse.py` — szöveg → Morse-ritmus (szabványos időzítés).
- `tunes.py` — beépített ritmusminták (fix hangmagasság → ritmus, nem dallam).
- `mcp_server.py` — FastMCP réteg a Hermes/agent integrációhoz (9 tool, reconnect-wrapper, csak véges mozgásparancsok).

**Szkriptek (`scripts/`):** `test_all.py` (teljes teszt), `led.py` / `led_sweep.py` (LED),
`battery.py` (akku trend), `mic_beep.py` (mic hallja a beepet), `play.py` (ritmus/Morse/beep CLI),
`fft_pitch.py` (FFT frekvencia), `verify_directions.py` (mozgásirány-igazolás).

**Tesztek (`tests/`):** protokoll + Morse + MCP smoke — 30 unit teszt, robot nélkül futtatható.
**Hermes skill (`hermes/skills/robotics/codie-robot/SKILL.md`):** playbook az agentnek — mikor/hogyan
használja a `mcp_codie_*` toolokat (érzékelés, véges mozgás, buktatók, biztonság).
**Docs:** `docs/comApi.h` (hivatalos header), `CHANGELOG.md`, `VERSION`.

**Web-backend (`server/`, Node.js):**
- `src/ble/protocol.js` — a `protocol.py` 1:1 JS portja (frame, parancs-ID-k, HSV 0-255).
  A `test/parity.test.js` bájtra bájtra összeveti a Python referenciával.
- `src/ble/protocol-norrouting.js` — a **routing nélküli** generáció protokollja
  (a codiejs portja): `SEQ|CMD|ARG` frame, négy karakterisztika, `decodeLine()`.
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
- `src/app.js`, `src/routes/robots.js`, `src/realtime.js` — Express REST API + socket.io.
- `src/config.js` — környezeti változók (timeoutek, újracsatlakozás, write gap, mic periódus).
- `scripts/` — `scan.js`, `control.js`, `console.js` (a backend moduljait használják).
- `public/` — a webes felület (socket.io-n át): élő érzékelőadatok, mikrofon-szintmérő.

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
| forrás | a repo `codie/protocol.py` | [zbettenbuk/codiejs](https://github.com/zbettenbuk/codiejs) |

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
kifejezőeszköz a **ritmus** (hossz + szünetek): `play_rhythm`, `play_morse`, `play_tune`.

A **routing nélküli** generáción a `CMD_BEEP` (0x0006) **hangerőt (u8) + frekvenciát
(u16) + időtartamot (u16)** is visz — ott a hangmagasság és a hangerő is állítható.

## Következő lépések / nyitott

- A **mozgásirány-előjel élő igazolva** (v0.7.0 utáni élő teszt): előre/hátra/jobbra/balra
  helyes, nincs előjel-javítás.
- A **robusztus connect** (v0.9.0) kész: retry + felébresztő BLE-scan, és a JS backend
  a megszakadt kapcsolatot **újracsatlakozza**. A mid-call (hívás közbeni) retry a
  Python kliensen még nyitott.
- A **vonal-érzékelő fizikai jelentése** a routing nélküli generáción még nincs
  bizonyítva: a 4 bájtos érték egyetlen fix-pontos szám (a codiejs 2^20-as skáláját
  használjuk, küszöb 30); a nyers érték az API-n elérhető.
- Hermes MCP-config kész (README „Hermes bekötés"): `~/.hermes/config.yaml`, `PYTHONPATH`-szal
  (nincs `cwd` mező a Hermes sémában). A szerver lustán csatlakozik. Nyitott: beírni az élő
  `~/.hermes/config.yaml`-ba (a user jóváhagyásával) + `/reload-mcp`.
- Opcionális: `LedStartAnim` (0x1066) beépített animációk; magasabb szintű skillek (vonalkövetés
  a `line()`-nal, szonár-akadálykerülés), vagy a Scratch-blokkos réteg újraélesztése.
