# Codie projekt — napló / memória

Időrendi napló a Codie BLE-vezérlés felélesztéséről. A tartós technikai referencia a
[CLAUDE.md](CLAUDE.md)-ben van; ide a döntések, mérföldkövek és incidensek kerülnek.

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
- **KÉT Codie-generáció, most behatárolva:** routingos (comApi.h v1.0) = **a mi robotunk = pipacsba**
  (52af UUID-k, fix buzzer) vs routing nélküli = zbettenbuk/codiejs (más UUID-k, frekvenciás beep).

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
