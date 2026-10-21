# Codie projekt — napló / memória

Időrendi napló a Codie BLE-vezérlés felélesztéséről. A tartós technikai referencia a
[CLAUDE.md](CLAUDE.md)-ben van; ide a döntések, mérföldkövek és incidensek kerülnek.

---

## 2026-10-21 — A projekt átköltözött: `mikes28/codie-webcontrol`

- **A repó:** a történet eddig a `sanchomuzax/codie` repóban volt (nem a miénk) → a
  projekt mostantól a **`github.com/mikes28/codie-webcontrol`** repóban van (publikus).
  A `git remote rename origin upstream` + az új `origin` a régi repót **érintetlenül**
  hagyja (az `upstream` `main` továbbra is `f629fcc`).
- **A történet átírva, csak a saját commitokkal:** a 23 eredeti commit (sanchomuzax /
  Sancho) kiesett a repóból — a gyökércommit most a projekt importálása, a te 7
  mikes28-commitoddal a fájlok változatlanok (csak a `VERSION`, a `CHANGELOG.md` és a
  `CLAUDE.md` verziójelzői változtak). A közreműködői listán így csak a mikes28 látszik
  (8 commit). Az eredeti fejlődés megmarad az `upstream` repóban és a MEMORY/CHANGELOG
  szövegében.
- **A verzió-sorozat az elejéről indul:** v0.1.0 (importálás) → v0.2.0 (webes vezérlő)
  → v0.3.0 (második generáció) → v0.3.1 (listener-javítás) → v0.4.0 (LED-animáció).
  A régi 0.1.0–0.9.0 CHANGELOG-szakaszok az importálás szakaszába csukkolva maradtak
  (a Python oldal fejlődésének listájával), a `VERSION` és a `CLAUDE.md` állapotsora
  minden commitban az adott verziót mutatja.
- **A kiadások megvannak:** mind az öt verzióhoz annotált tag + GitHub release, a
  megszokott „v0.X.Y — cím" formában. (A backup az átírás előtti állapotról:
  `/tmp/codie-pre-rewrite.bundle`.)

## 2026-10-21 — Beépített LED-animáció (v0.4.0)

- **A felfedezett üres hely:** a routing nélküli protokollban a `CMD_SET_ANIMATION` (0x0009)
  deklarálva volt, a hamis robot is kezelte — de **se kliensmetódus, se parancs nem
  használta**. A repo nyitott listáján szerepelt is („Opcionális: LedStartAnim (0x1066)
  beépített animációk").
- **A dokumentáció forrása:** a [codiejs](https://github.com/zbettenbuk/codiejs) referencia
  (`lib/codie.js`): `setAnimation(animation, hue, saturation, repeat, speed)`, a frame
  `0x09` → `animation | hue | sat | repeat | speed`, és a megjegyzés:
  *"Possible animation values: 0, 1"* → **két** beépített animáció van.
- **A szín skálája:** a `setColor`-hoz hasonló (hue 0-360 ×0,7; sat 0-100 ×2,55) — ezt a
  `setColor` élőben igazolt értékeire alapoztuk. A `repeat` és a `speed` firmware-szemantikája
  nem dokumentált → a parancsréteg változtatás nélkül átadja őket.
- **A routingos generációban nincs implementáció:** a `LedStartAnim` (0x1066) paraméterei
  a `comApi.h`-ban nem szerepelnek → ott a kliens szabályos hibát dob (501), nem találgat.
- **Hány felületen érendő el:** kliens (`ledAnimation()`), parancsréteg (`ledAnim` → REST),
  CLI (`control.js anim 1 red`), konzol (`anim <0|1> [szín]`), felület (**Anim 1 / Anim 2**
  gombok a Fény csoportban, a legutóbb kiválasztott színnel).
- **Tesztek:** +5 (kliensszint: a frame `SET_ANIMATION` + a nyugta; parancsréteg: a
  paraméterek átadása és a 0/1 vágás; routingos generáció: a hiba eldobása).

## 2026-10-21 — A szerver újraindítása + a BLE-listener szivárgás javítása

- **Kérés:** „nem fut, indítsd el”. Valójában a HTTP-szerver **futott** (20 órája, detached
  indítással, `/tmp/codie-server.log`-ba), és a `/api/health` 200-as válaszolt — de a
  **robot linkje halott** volt: a `/api/robots` `connected: false`-t adott, a telemetria
  percekkel korábbi volt, és az újracsatlakozás kimerült (3 próbálkozás). A robot közben
  hirdetett (`node scripts/scan.js` megtalálta, `00:07:80:66:F0:DA`) → a hiba nem a
  hardverben, hanem a kliensben volt.
- **A talált hiba (a logban is látszott):** `MaxListenersExceededWarning` — 11 `data`
  listener egy `Characteristic`-en és 11 `disconnect:<cím>` listener a `Noble`-on. A noble
  **cache-eli** a karakterisztikákat és a peripheral-t, a kliens pedig minden kapcsolatnál
  új listenert kötött rá, és **soha nem szedte le** → minden notify-t minden régi kliens
  feldolgozott, a `peripheral` 'disconnect' listenere pedig duplán jelezte a dropot.
- **Javítás (`server/src/ble/client.js`):** a kliens megjegyzi a saját listener-eit
  (`_listen` / `_unlistenAll` / `_unlistenCharacteristics`), és levesszük őket a kapcsolat
  megszakadásakor, a részleges takarításkor és a `_setup` újrapróbálkozásakor. A
  függőben lévő kérések nullra oldása kiemelve (`_clearPending`), hogy a explicit
  lekapcsolódás is feloldja őket. Regressziós teszt: `server/test/client.test.js`
  („az újracsatlakozás nem halmozza a BLE-listener-eket a karakterisztikán").
- **A szerver indítása mostantól tartósan:** a gitignore-olt `server/.env` beállítja a
  `CODIE_AUTO_CONNECT=00:07:80:66:F0:DA`-t → a szerver induláskor magától csatlakozik a
  robothoz (a routing nélküli generáció címe stabil). Indítás:
  `setsid nohup node src/index.js >>/tmp/codie-server.log 2>&1 &` (a `kate` is nyitva
  tartja a `src/index.js`-t — az érintetlen).
- **Élő igazolás:** 12 egymás utáni le-/újracsatlakozás mind 200-as válasz, **0**
  listener-figyelmeztetés, a telemetria folyamatosan frissül (akku 97 %, szonár 21 mm,
  fény ~4020, vonal-szint ~15), a felület (`/` és a socket.io kézfogás) 200-as.

## 2026-10-20 — A webes felület megbízhatósága (a második Codie-generációval)

- **Kérés:** „működjön a Bluetooth a weboldalon hiba nélkül". A v0.3.0 (a második
  generáció támogatása) után a felületet végigellenőrizve a valódi roboton.
- **A robot BLE-címe stabil** (a felhasználó ki/bekapcsolta, és ugyanaz a cím maradt):
  `00:07:80:66:F0:DA`. A korábbi „alvás közben rotálja a BLE-címét” állítás erre a
  generációra nem igaz → a háttérben futó **újracsatlakozás** is működik.
- **A valódi hibák, amiket a felület mutatott:**
  1. A kliens `error` eseménye listener nélkül **dobott** (Node `EventEmitter`) → egy
     hibás BLE-csomag ledobta volna az egész szervert. Javítás: beépített listener →
     `ble-error` esemény → `robot-error` a socketen → a felület kiírja.
  2. A parancsok **hamis „OK”-t** írtak, ha a robot nem nyugtázott. Javítás: a hiányzó
     nyugta (504) és a hiányzó érzékelő-válasz hiba; a részleges `status` továbbra is OK.
  3. **A firmware eldobta a parancsokat a telemetria-poll alatt** (15 parancsból 1
     elveszett): a routing nélküli firmware az üzenetet eldobja, ha egy kérés még
     folyamatban van. Javítás: a parancs megvárja a futó lekérdezéseket; a szóló
     ritmus alatt a lekérdezések várnak a ritmusra (nincs deadlock: a ritmus nem
     vár a lekérdezésekre). Utána: 20/20 beep, 10/10 LED sikeres.
  4. A megszakadt kapcsolat nem jött vissza: a registry most korlátoltan újracsatlakozik
     (`CODIE_AUTO_RECONNECT` & co.), a felület „újracsatlakozás…” állapotot mutat.
     Élőben igazolt: a BLE link megszakítása után ~10 mp alatt újra online.
  5. A **vonal-érzékelő** értéke félrevezető volt (a 32 bites fix-pontos értéket duplán
     mutatta bal/jobbként). 60 élő mintában a bájtminta mindig `0x05xx07yy` volt →
     egyetlen érték, nem két érzékelő. A codiejs referencia skálája (2^20, küszöb 30)
     szerint most `{ value, level, onLine }` → a felület „86.9 · vonalt követ”-et mutat.
  6. A LED-szín sat/val 1-gyel kisebb volt (a `100 * 2,55` float-lezárása) → `Math.round`.
  7. A `scripts/control.js` és `scripts/console.js` **el sem indult**: a `registryOptions`
     segédet használták, de nem importálták (`ReferenceError`). Javítva + smoke-teszt.
- **A felület további finomításai:** a generáció badge-je megmarad lekapcsolás után,
  a kapcsolat állapotváltozása a státuszsorban is látszik, a telemetria mellett a
  frissesség is megjelenik („frissítve: 2 mp ezelőtt”), az elavult adatok halványodnak.
- **Gyorsabb érzékelő-frissítés (a felhasználó kérése, ~250 ms):** a telemetria most
  **érzékelőnként** érkezik (minden mérés megérkezésekor esemény), és a poll önmagát
  újraütemezi → a felület **~90 ms-onként** frissül. A korlát a robot: egy lekérdezésre
  ~90–100 ms alatt válaszol, így a teljes 4 érzékelős kör ~400 ms (ez hardver-korlát,
  nem szoftver). A `CODIE_WRITE_GAP_MS` (alap 50 ms) finomíthatja: élőben mérve 30 ms
  is hibátlan volt, de a **nyugtázatlan** (Morse/ritmus) üzeneteknél 150 ms kell.
- **Mikrofon a felületen:** a robot nem hangot ad, hanem nyers erősségi értéket
  (0..2048) — a felület szintmérőt mutat. A figyelés ~5 érték/mp, és **alatta az
  érzékelő-lekérések szünetelnek** (a firmware egy kérést szolgál ki egyszerre).
  Fontos: a mikrofon-poll **nem** gyűjthet sorba kéréseket (a sor eltorlasztotta a
  telemetriát is) — egyszerre csak egy lekérdezés lehet a rádión.
- **A vonal-érték értelmezése (routing nélküli generáció) — nyitott kérdés:** a
  4 bájtos válasz **egyetlen** szám (60 élő mintában mindig `0x05xx07yy` volt a
  bájtminta, két független érzékelőt kizár). A codiejs referencia 2^20-zal osztja
  és 30 felett „vonalt követ”-nek tekinti — ezt követtük (`{value, level, onLine}`).
  Élőben: a robot mozgatásakor a nyers érték 90 millióról 13 millióra esett, és a
  `onLine` jelző helyesen váltott (true → false) — tehát a jel **nem** véletlen
  szám, hanem a robot állapotától függ. A fizikai jelentése (pontosan mi) még
  nincs bizonyítva; a nyers `value` minden esetben elérhető az API-n.
- **Tanulság:** a „működik" és a „hiba nélkül működik" két külön dolog — a hamis
  „OK"-k és a néma hibák miatt a felület sokáig nézett egészségesnek.

---

## 2026-10-20 — Webes vezérlő (Express.js backend)

- **Kérés:** a repóból weboldal legyen — Express.js backend a robothoz, több robot BT-en,
  kereső parancs, ami **nem listázza a többi BT eszközt**, plusz újrahasznosítható
  backend-scriptek és egy konzol-script, ami ezeket használja.
- **BLE réteg döntés:** az upstream `noble` Linuxon **nyers HCI-t** kér (root + natív build,
  konfliktus a BlueZ-zel), ezért a `@stoprocent/noble` fork **D-Bus/BlueZ bindingje** lett:
  root nélkül fut, együtt működik a `bluetoothctl`-lel. (`dbus-next` a host projekt kell.)
- **Robot-szűrő:** név-prefix (`Codie`, `Codie 2`) VAGY hirdetett service-UUID
  (`52af0001-…` GATT + `d46e7e53-ba2f-4044-ade9-f85ead45f458`, amit a robot hirdet) —
  plusz opcionális **MAC-allowlist** (`CODIE_MAC_ALLOWLIST`, `CODIE_MAC_ONLY`).
  Élőben igazolva: a környezetben 8+ más BLE eszköz van (fehallgatók, telefonok, karika),
  a scan **csak a robotot** adja vissza.
- **A robot viselkedése (fontos!):** **egyetlen hirdetés után visszaalvik**; 5 perc alatt
  egyszer jelent meg. Alvás közben a BlueZ `Connect()`-je nem fejeződik be
  (a `bluetoothctl` is csak "Attempting to connect"-et ír) → **a robotnak ébren kell lennie
  (gombnyomás) a csatlakozáshoz**. Ez hardver-korlát, nem szoftverbug: a Python (bleak)
  referencia pontosan ugyanígy elhasal (`BleakDeviceNotFoundError`).
  **Frissítés (2026-10-20):** a routing nélküli generáció BLE-címe **stabil** — a robot
  ki- és bekapcsolás után is ugyanaz a cím (`00:07:80:66:F0:DA`) marad, nem rotálódik.
  (Az „alvás közben rotálja a BLE-címét" állítás erre a generációra nem igaz.) Ezért
  a háttérben futó újracsatlakozás is működik: a cím alapján lehet csatlakozni.
- **Négy valódi bug, amit a munka során találtunk:**
  1. A sikertelen connect **lezárása** (`disconnectAsync`) elakadhat — a BlueZ egy félbehagyott
     connectre nem válaszol azonnal. Javítás: időtartam-biztosított takarítás.
  2. A `RobotRegistry.scan()` a **normalizálatlan** címmel tárolt a robotot, míg a
     `describe()/get()/connect()` normalizál → a robot " eltűnt" a listából. Javítás:
     a scan is normalizál (a hamis robot ezt rögtön elkapta).
  3. **Az UUID-forma eltér**: a BlueZ binding kötőjel nélküli, kisbetűs UUID-t ad vissza, a
     mi konstansaink kötőjelesek voltak → sem a write/notify karakterisztika-keresés, sem
     a UUID-alapú identitásszűrés nem működött volna (a név-szűrő elfedte). Javítás:
     kanonikus UUID (`canonicalUuid`/`sameUuid`) minden összehasonlításban.
  4. A scriptek `process.exit()`-tel szakítottak meg — **pipe-on kimenetet dobott el**;
     a konzol ráadásul nem sorban futtatta a parancsokat, és stdin-EOF-nál megszakította
     a futó scan-t. Javítás: tiszta kilépés (`finish()`), parancssor (queue).
- **Protokoll-paritás:** a JS portot a Python referenciával **bájtra bájtra** ellenőrző
  teszt (`server/test/parity.test.js` + `test/parity_probe.py`) védi az elcsúszás ellen.
- **Kód-review (19 finding, mind javítva + regressziós teszttel):** a legkomolyabb három:
  (1) a `playRhythm` a Python `asyncio.sleep` másodperc-osztását vette át → a Morse/ritmus
  1000×-s rövidebb volt; (2) a noble a scan-promise-t a binding `scanStart` eseményéből oldja
  fel, a BlueZ binding a hibát `warning`-ba teszi → **a scanner örökre beragadhatott** és minden
  későbbi scan/connect néma kérésre sem válaszolt; (3) a `status()` a feszültségre várt, ami
  ezen a firmware-en sosem jön → minden telemetria-kör 2,5 mp stall. A tanulság: a **portok**
  (Python→JS) a legveszélyesebbek — az `asyncio.sleep` másodperc, a `setTimeout` ezredmásodperc.
- **Hamis robot** (`server/test/fake-robot.js`): a teljes szoftverstack (scan → szűrés →
  connect → parancs → telemetria → REST → socket.io) futtatható hardver nélkül — 105 teszt
  (2026-10-20; a routing nélküli generációhoz külön `fake-robot-norrouting.js`).
- **A robot élő, teljes körű igazolása megtörtént** (2026-10-20, a routing nélküli
  generáción): connect, a négy érzékelő, a LED-szín, a beep, az előre/fordul/stop elfogadva;
  20/20 beep és 10/10 LED parancs hibátlan. A részletek a napló elején.

---

## 2026-07-07 — A robot feltámasztva

- A `csorbazoli/CodieController` repo átnézve. Megerősítve: 2016-os, félbehagyott Java PoC
  (Scratch 2 offline editor vezérlés), bluecove BT + jlhttp helyi HTTP szerver, robot- és
  szenzorparancsok, `resources/codie_scratch_project.sb2`.
- Az egyetlen issue (#1, 2019-03) a felhasználó (sanchomuzax) nyitotta. A szerző válasza:
  feladta, mert Windows-on nem volt BLE 4 driver, és a `CodieGateway` doksi hiányzott.
- **Kulcsfelismerés:** a protokoll nincs elveszve — a repo `DataPackage.java` +
  `CodieCommandType.java` tartalmazza a teljes visszafejtett MCU-frame formátumot. A hiányzó
  darab csak a PC→BLE út volt.
- Az RPi5 (`hci0`) BLE scan megtalálta: `DF:74:94:43:36:ED` "Codie". Connect sikeres, GATT
  feloldva → vendor service `52af0001`, write char `52af0002`, notify char `52af0003`.
- **Élő teszt:** beep-frame (`40 01 00 64 10 02 00 e8 03`) a `52af0002`-re → a Codie **sípolt**,
  ismételten. Determinisztikus, valódi vezérlés. A közvetlen APP→MCU frame-kódolás működik.
- Frame-formátum, parancs-ID-k és a csatlakozási recept rögzítve a CLAUDE.md-ben.
- Projekt inicializálva `~/codie`-ban, privát GitHub repóba mentve.

### v0.1.0 — bleak-kliens + szenzorok élőben igazolva
- Elkészült a Python package: `codie/protocol.py` (frame encode/decode, parancs-ID-k,
  szín-HSV) + `codie/client.py` (aszinkron bleak `CodieClient`, notify-feliratkozás,
  SEQ↔REQSEQ kérés/válasz párosítás). 15 unit teszt zöld (az igazolt beep-frame ellen is).
- **Szenzorok mind válaszolnak** (notify `52af0003`), a dekódolás bájtra pontos:
  akku 5%, fény 4041, vonal (3895, 3808), szonár 81 mm, mikrofon 633.
  Válaszfejléc: INFO=0x10 (MCU→APP), CMD felső bájt 0x80-nal jelölt, ARGLEN a REQSEQ-et is
  beleszámolja, a hasznos adat a 9. bájttól — pontosan a Java processResponse szerint.
- Megjegyzés: az akku a mérésnél 5% volt (töltőn) — a mozgásteszt motorjaira ez kevés lehet.

### v0.2.0 — hivatalos SDK előkerült, protokoll validálva
- A user talált egy régi SDK-t (`~/Downloads/codie.zip`): benne a **hivatalos Codie
  BLE API v1.0** HTML doksi, `comApi.h`, Qt/C++ példák (Simple + Complex), és maga a
  **CodieGateway_dotNet.exe** (a 2019-ben "hiányzó" darab!).
- A visszafejtett protokoll **teljesen igazolt** a `comApi.h` és a HTML ellen: INFO bájt
  (source<<4 | dest<<6), packet-struktúra (info/seq/cmdId/arglen/data), minden parancs-ID,
  drive-argumentumok, reply (INFO megfordul, CMD MSB=1, ARGLEN = reply-SEQ + ReARG, nSuccess u8).
  RX=52af0002 (write w/o response, max 20B), TX=52af0003 (notify).
- **Feltárt hiba:** a HSV skála 0-255 (nem 0-100, ahogy a Java repo). Javítva; a "piros" előbb
  fakó volt (0,100,100), most helyes (0,255,255).
- Új parancsok felvéve: LedStartAnim 0x1066, AppConnected 0x1067, AppDisconnected 0x1068,
  BatteryGetVoltage 0x106e, SwitchToBootloader 0x106d (veszélyes).
- **Aktuátorok élőben:** beep ✅ (hallható), kerekek pörögtek ✅ (5% akkun is);
  minden parancs `nSuccessful=0`-val nyugtázva.
- **LED vizuálisan igazolva (töltőről levéve):** a 0-255 HSV-fix után erős fény, helyes
  színkör (piros→zöld→kék→sárga→cián→narancs→fehér, a zöld valódi zöld), egyesével körbefutás
  is jó. A `led_sweep.py`-vel futtatva. → **A teljes funkció-teszt kész, minden funkció él.**

### Töltés + LED-interferencia megfigyelés
- Töltőn a firmware saját LED-animációt futtat (körbefutó fehér + töltöttséget jelző piros
  LED-ek), ami **felülírja a mi LedSetColor parancsunkat** → töltés közben a színteszt nem
  látható. LED-teszthez le kell venni a töltőről (a robot az oldalán, nem mozdul → biztonságos).
- Az akku rendben tölt: SoC 5% → 11% → 12% (emelkedik), tehát nem hibás; a piros LED-ek
  "feltöltődése" a töltöttség-szintet jelzi.
- `BatteryGetVoltage` (0x106e) ezen a firmware-en **nem ad választ** (SoC 0x1069 viszont igen).
- Eszköz: `scripts/battery.py` (SoC + voltage trend).

### v0.3.0 — teljes funkció-teszt kész (mérföldkő)
- Minden funkció élőben igazolva: szenzorok (adat), SpeakBeep (hang), mozgás (kerekek),
  LedSetColor (vizuálisan, helyes színek). Minden parancs nSuccess=0. README teszt-táblázat.

### v0.4.0 — hang: ritmus és Morse
- `codie/morse.py` (szöveg → Morse-ritmus, szabványos időzítés) + `codie/tunes.py` (beépített
  ritmusok: shave_haircut, beethoven5, heartbeat, tada, alarm, countdown).
- `CodieClient.play_rhythm` / `play_morse` / `play_tune`; `scripts/play.py` CLI. +7 unit teszt.
- Korlát: fix hangmagasság (BLE API: SpeakBeep), WAV/dallam nincs — a kifejezőeszköz a ritmus.

### Mikrofon-kísérlet: hallja-e a Codie a saját csipogását? (v0.5.0)
- **Igen — de csak burkológörbeként (hangerő), NEM frekvenciaként.**
- `MicGetRaw` ~50 ms-re átlagolt amplitúdó, BLE-n lekérdezve; a mért effektív mintavétel
  **~5 Hz** (200 ms/olvasás) → egy ~3 kHz beephez ~600× túl lassú (Nyquist). Pitch-mérésre
  alkalmatlan.
- Beep alatt a mic 456 (alapzaj) → csúcs 1866; a burkoló emelkedett ablaka ~1,4 s, egyezik a
  1500 ms beep-hosszal → duration visszamérhető.
- **Váratlan tanulság:** a mic-lekérdezés NEM szakítja meg a folyamatban lévő beepet (a
  SpeakBeep busy-interrupt nem vonatkozik a szenzorolvasásra). Eszköz: `scripts/mic_beep.py`.
- Pitch méréséhez: telefonos felvétel + FFT, vagy fizikai teardown (buzzer vs passzív piezo).

### Csipogó frekvencia mérve — valószínűleg önrezgő piezo-buzzer (v0.6.0 FFT)
- Telefonos felvétel + `scripts/fft_pitch.py`: **domináns ~2483 Hz** (~D#7), a klasszikus
  önrezgő piezo-buzzer sávban (~2–3 kHz).
- Felharmonikusok gyengék (4./5. −23…−28 dB), és **nincs erős 3. felharmonikus** — vagyis NEM
  négyszögjellel hajtott passzív elem (annak erős páratlan felharmonikusai lennének, vö. a
  2700 Hz-es négyszögjel-teszt: 3. felharmonikus −9,5 dB).
- **Következtetés:** valószínűleg önrezgő buzzer, a hangmagasság **hardveresen fix** → firmware-
  hackkel sem módosítható; a `SpeakBeep` csak ki/be (hossz+ritmus). Variálható pitch-hez fizikai
  alkatrészcsere + PWM-firmware kéne (nem éri meg, brick-kockázat).
- Fenntartás: telefonmikrofon elnyomhatja a magas felharmonikusokat; 100%-os válasz a fizikai
  teardown / szkóp a buzzer lábán. De az alaphang és a hiányzó 3. felharmonikus robusztus jel.

### v0.7.0 — MCP szerver (Hermes / agent integráció)
- Egy külső Claude-beszélgetés terve alapján (ROS-mentes "Opció 1": bleak driver → MCP → Hermes;
  a Butter-Bench elv: az LLM magas szintű akciót válasszon, ne legyen a szoros motor-loopban).
- `codie/mcp_server.py`: FastMCP réteg, 9 magas szintű tool (status, look_ahead, drive_forward,
  drive_backward, turn, stop, beep, say_morse, set_leds). Tartós BLE-kapcsolat **reconnect-
  wrapperrel** (`_ensure`); csak véges, magától megálló mozgásparancsok (nincs runaway).
- **Fix:** a beillesztett vázlat `turn()` előjel-bugja — a `drive_turn` foka u16 (előjel nélküli),
  az irányt a **speed előjele** adja (API: pozitív speed = balra). Javítva: fok = abszolútérték,
  irány a speed előjeléből (nincs u16 wraparound). +5 MCP smoke teszt (összesen 27).
- Stdio-ként a Hermes MCP-configjából hivatkozható (README-ben példa).

### Mozgásirányok igazolva (v0.7.0 utáni élő teszt)
- `scripts/verify_directions.py` lefutott, a user megerősítette: **előre/hátra/jobbra/balra mind
  helyes.** A negatív keréksebesség = hátramenet, és a `turn` konvenció (pozitív fok = jobbra,
  azaz negatív speed) is stimmel. **Nincs szükség előjel-javításra a `mcp_server.py`-ban.**
- A user adott egy feliratozott Codie-alkatrészdiagramot (bayer.hu) → `assets/codie.jpg`, README
  tetején. Megerősíti: a hangkeltő "Buzzer" (egybevág az FFT-vel), Bluetooth 4.0. A képen extra
  szenzorok is (iránytű, gyorsulásmérő/giroszkóp, enkóder), amiket a BLE API NEM tesz elérhetővé.

### v0.7.1 — Hermes MCP-config + lusta csatlakozás
- A Hermes doksi alapján (`~/.hermes/config.yaml`, `mcp_servers` kulcs): stdio szerver
  `command`/`args`/`env`. **Nincs `cwd` mező** → `PYTHONPATH`-szal adjuk meg a package elérését;
  a stdio szerver csak az explicit `env`-et kapja, ezért a `CODIE_ADDRESS`/`ADAPTER` is oda kerül.
- Tool-prefix a Hermesben: `mcp_codie_<tool>`. Config után `/reload-mcp`.
- `supports_parallel_tool_calls: false` (egy BLE-link → soros), `timeout`/`connect_timeout: 30`.
- Kódfinomítás: a lifespan **lustán csatlakozik** (azonnal indul, első tool-hívás nyit
  kapcsolatot) → a tool-felderítés nem vár a BLE connectre. Kész config-blokk a README-ben.

### v0.8.0 — Hermes skill (robot-playbook)
- A Hermes skill-rendszere: `~/.hermes/skills/<kategória>/<skill>/SKILL.md` (agentskills.io-
  kompatibilis, frontmatter + When to Use / Procedure / Pitfalls / Verification). Feltételes
  aktiválás: `requires_tools` / `requires_toolsets`. `external_dirs` a config.yaml-ban.
- Elkészült: `hermes/skills/robotics/codie-robot/SKILL.md` — `requires_tools: [mcp_codie_status,
  mcp_codie_drive_forward]`, benne a session összes gyakorlati tanulsága (érzékelj mozgás előtt,
  csak véges parancs, töltő↔LED ütközés, alacsony akku, fix csipogó, BLE-késleltetés+reconnect,
  fizikai biztonság, turn konvenció: +jobbra/−balra).
- Betöltés: `external_dirs: [~/codie/hermes/skills]` a config.yaml-ban, vagy másolás
  `~/.hermes/skills/`-be.

### v0.9.0 — robusztus connect (elalvás-tűrő)
- Élő tapasztalat: a Codie egy idő után **elalszik**, ilyenkor az első `connect` timeoutol; egy
  **BLE-scan felébreszti**, és a második próba sikerül (4× körbefordulás teszt közben derült ki).
- Beépítve a `CodieClient.connect`-be: **retry (alap 3×) + felébresztő `BleakScanner.discover`**
  a próbák között (`connect_retries`, `retry_delay` paraméterek). Így az `_ensure` reconnect és a
  Hermes-használat sem bukik el tévedésből egy elalvás miatt. +3 unit teszt (összesen 30).
- Megjegyzés: ha „connected=True", de a szenzorok `None`-t adnak, az jellemzően **gyenge/távoli
  link** (a robot messze van), nem lemerült akku — vidd közelebb.

### Giroszkóp / IMU BLE-n?
- **Nem elérhető.** A hardverben megvan (gyorsulásmérő+giroszkóp, iránytű, enkóderek — lásd a
  diagram), de a hivatalos `comApi.h` parancskészlet NEM exponálja. BLE-n olvasható szenzorok:
  sonar, light, line, mic, battery (SoC). Csak módosított MCU-firmware-rel lenne elérhető.

### Nyitott szálak
- Beírni az élő `~/.hermes/config.yaml`-ba (user jóváhagyással): a `codie` MCP-szervert **és** a
  skill `external_dirs`-t, majd `/reload-mcp` + skill-újratöltés.
- Reconnect mid-call retry finomítás (jelenleg a következő hívás csatlakozik újra).
- Opcionális: `LedStartAnim` (0x1066) animációk; magasabb szintű skillek (vonalkövetés,
  szonár-akadálykerülés); Scratch-blokkos réteg újraélesztése.

### Kapcsolódó munkák / referenciák
- **`zbettenbuk/codiejs`** (noble, AGPL) — a Codie BLE-drivere JS-ben (≈ a mi `CodieClient`-ünk).
  **`zbettenbuk/codie-server`** — HTTP-szerver fölötte, ScratchX-integrációval
  (`scratchx.org/?url=zbettenbuk.github.io/codie.js`). Valószínűleg EZ a csorbazoli által 2019-ben
  "már nem elérhető"-ként említett hivatalos Scratch-kiegészítő. (≈ a mi MCP-szerverünk rokona.)
- **Másik protokoll-generáció — routing NÉLKÜL:** eltérő service/char UUID-k (service
  `d46e7e53...`, 4 karakterisztika: request/action + reply-párjaik), a frame INFO bájt nélkül
  (rögtön seq+cmd). Parancsok: move 0x0001, motorBoth 0x0002, motorLeft/Right 0x0003/4,
  turn 0x0005, beep 0x0006, setColor 0x0008, setAnimation 0x0009. Szenzorok: distance 0x0001,
  battery 0x0002, sound 0x0003, light 0x0004, line 0x0005. HSV-skálázás is más (hue×0.7, sat/val×2.55).
- **Giroszkóp itt SINCS** — a szenzorlista csak distance/battery/sound/light/line. Egyik ismert
  BLE-protokoll sem exponálja az IMU-t (gyro/accel/compass).
- **Beep frekvenciával (!):** a `codiejs beep(volume, frequency, duration)` a régi (routing nélküli)
  változaton **u16 frekvenciát is küldött** (cmd 0x0006) → az a hardver változtatható hangmagasságú
  (passzív hangszóró) volt. A MI robotunk viszont routingos, `SpeakBeep 0x1064` CSAK duration
  (fix ~2483 Hz buzzer az FFT szerint). Külön hardver-generáció.
- **Frekvencia-kísérlet kísérletileg lezárva (2026-07-07):** a mi `SpeakBeep`-ünk extra
  frekvencia-arggal (ARGLEN=4, mindkét bájtsorrend: dur+freq és freq+dur, 300/1000/4000 Hz) —
  **mind ~2 kHz-en szólt**, a firmware a frekvencia-argot figyelmen kívül hagyja. Fix buzzer,
  nincs rejtett frekvencia-vezérlés. Mellékesen: a beepek megszólaltak `ack=None` mellett is →
  a **write-út működött, csak a notify/reply-út akadozott** a gyenge linken (ack=None ≠ nem futott le).

**Ugyanaz a generáció, modern (2025) — független megerősítés:**
- **`pipacsba/CodieController`** — a `csorbazoli/CodieController` **forkja** (az eredeti; nincs új tartalom).
- **`pipacsba/codie_bluetooth_controller`** (2025-02) — **ESPHome / Home Assistant** BLE-vezérlő.
  **UGYANAZ a protokoll-generáció, mint a mienk:** service `52AF0001`, rx `52af0002`, tx `52af0003`;
  parancs-ID-k 0x1060/0x1064/0x1065/0x1069; routingos frame (INFO 0x40). Forrás: a forkolt Java-repo +
  a hivatalos `Codie BLE API v1.0.pdf`. Szenzor: battery + sonar; **giroszkó itt SINCS** (3. független
  megerősítés). Platform: ESP32/HA (a mienk Pi5/Python/MCP) — kész referencia Home Assistant-integrációhoz.
- **KÉT Codie-generáció, most behatárolva:** routingos (comApi.h v1.0) = a **pipacsba** robot
  (52af UUID-k, fix buzzer) — ezt beszéli a Python kliens (`codie/`); routing nélküli =
  zbettenbuk/codiejs (más UUID-k, frekvenciás beep) — ezt beszéli a **JS web-backend** (`server/`),
  és **ez a robot van nálunk most** (`00:07:80:66:F0:DA`, 2026-10-20).

**Forkok átnézve (2026-07-07, Sonnet-subagentekkel) — nincs hasznos módosítás:**
- Az összes eddigi repo forkja. Csak kettőnek van saját commitja, mindkettő `GyroLand`-tól
  (= **Gyarmati Roland**, a szerző neve — NEM giroszkóp, vörös hering).
- `pipacsba/CodieController`: identical, nulla módosítás.
- `GyroLand/codie-server` (+2): személyes dev-fork (npm-maradék, route-ok törölve) — semmi hasznos.
- `GyroLand/codiejs` (+2): a régi (routing nélküli) codiejs-t átírja az ÚJ routingos protokollra
  (52af UUID-k, 0x1060–0x106c, 7 bájtos frame) → **4. független megerősítés a mi protokollunkra**,
  de NINCS új parancs/szenzor, és **giroszkóp itt sem**. Történeti nyom: README-je hivatkozik a
  `http://codie.azurewebsites.net/api/` spec-URL-re — **Web Archive-ban ELLENŐRIZVE (2026-07-07):
  üres lap, semmi hasznos. Lezárt szál, ne kutasd újra.**
- **Összegzés:** egyik fork sem hoz átemelendő módosítást, és egyik sem exponálja az IMU-t.

### Munkamódszer
- Minden érdemi változásnál frissítendő: `CLAUDE.md` (struktúra/tények), `MEMORY.md` (napló),
  `README.md` (használat) — nem csak a kód és a CHANGELOG. (User kérése, 2026-07-07.)
- **Soha ne kerüljön user home-dir út / felhasználónév / session-scratchpad út commitolt
  fájlba** — `~` vagy `/path/to/...` placeholder, kódban `tempfile`. A valódi abszolút út csak a
  gitignore-olt helyi configba (`.env`, `~/.hermes/config.yaml`). (User kérése, 2026-07-07.)
