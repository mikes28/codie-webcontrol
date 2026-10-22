# Beszéd-trigger (welcome message) — terv

**Cél:** a robot folyamatosan hallja a környezetét, és egy **előre beállított sample**
alapján felismeri, ha **bárki** (bármilyen hangú ember) **szól** — a sample maga a
trigger, nem egy szó szerinti szövegmatches.

**Nincs seed, nincs robot–robot kommunikáció, nincs „követniük egymást".** Egyetlen
robot, egyetlen beállított sample, egy igen/nem kimenet (a robot acknowledge-el).

**Ez a dokumentum terv, nem implementáció.** Minden a lentiek a *jelenlegi* projektben
(codie-webcontrol) valósul meg, **firmware-módosítás nélkül** — a jelenlegi firmware
tökéletesen elég hozzá.

---

## 1. Mit jelez a jelenlegi firmware

A firmware a mikrofonból **nem** hangot ad, hanem egy **burkoló (envelope) szintet**:

| tulajdonság | érték | forrás |
|---|---|---|
| a publikált érték | 0..2048 (`MIC_FULL_SCALE`) | `server/src/ble/registry.js` (`MIC_FULL_SCALE`) |
| a mintavétel | ~200 ms/leképezés → **~5 Hz** | `CODIE_MIC_MS=200` |
| a firmware oldali szűrés | „tracking filter" (a legközelebbi/3:1 IIR) | `fw/modules/hwi_mic.c` |
| amit a backend kiad | `mic` socket-esemény: `{address, raw, level, peak}` | `registry.js` (`startMicStream`) |

**Következmény:** a rendelkezésre álló jel a **beszéd burkolója**, nem a hanghullám.
A beszéd szótagjainak lassú modulációja (≈2–8 Hz) éppen beleesik a mintavételi sávba
(Nyquist ≈2,5 Hz) — ezért a *ritmus* látszik, a *szavak* nem.

Élő bizonyíték (a naplóban): a robot saját csipogása alatt a mikrofon szintje 456-ról
1866-ra ugrott → a mikrofon **hallja** a környezet hangját, nem csak a saját csipogóját.

### Amit ez a jel tud és nem tud

| képes | nem képes |
|---|---|
| a beszéd jelenlétének és ritmusának érzékelése (hossz, szótag-szám, energia-görbe) | szavak, szöveg értelmezése |
| „ugyanolyan ritmusú/energiájú megszólás" felismerése | „ugyanaz a mondat" felismerése más hanggal |
| a környezeti zaj szintjének tanulása (zajminta) | a beszéd tartalmának értékelése |

> **Ha valódi szövegfelismerés kell**, az firmware-módosítás (nyers ADC + 8–16 kHz +
> a roboton futó MFCC/DTW) — és a 14 400 baud-os modul-link miatt a hang **nem** streamsz,
> hanem a roboton kell feldolgozni. Ez egy **külön, nagyobb projekt**; lásd a 8. fejezetet.

---

## 2. Hol fut mi (firmware-változás nélkül)

```
┌────────────┐  BLE (a meglévő request csatorna)   ┌──────────────────┐
│   robot    │ ───────────────────────────────────▶ │  Node.js backend │
│            │      mic szint, ~5 Hz                │  (RobotRegistry) │
│ csipog     │ ◀─────────────────────────────────── │                  │
└────────────┘      beep(freq, ms)                 └────────┬─────────┘
                                                          │ 'mic' esemény
                                                          ▼
                                                ┌──────────────────┐
                                                │  mintaillesztés  │  ← itt dől el
                                                │  (DTW a burkolón)│
                                                └────────┬─────────┘
                                     ┌───────────────────┴────────────────┐
                                     ▼                                    ▼
                              ┌─────────────┐                      ┌──────────────┐
                              │ acknowledge │                      │  admin panel │
                              │ (beep+LED)  │                      │  (weboldal)  │
                              └─────────────┘                      └──────────────┘
```

- **A robot változatlan**: küldi a mikrofon szintjét, és a `beep` parancsra szól (a
  routing nélküli generációban a `beep` frame **frekvenciát is visz** → a acknowledge
  lehet egy megkülönböztető hang is).
- **A backend** végzi a mintillesztést (CPU-zsíkon, ingyen) és őrizi a mintát.
- **Az admin panel** (a weboldal) a beállítás felülete: minta rögzítése, próba, érzékenység,
  ki/be kapcsolás, a legutóbbi találatok.

---

## 3. A minta (sample) rögzítése — admin panel

**Adatfolyam:**

1. Az admin panel „**Rögzítés**" gombja:
   - a backend elindítja a robot **mikrofon-streamjét** (`POST /api/robots/:address/mic/start`),
   - a robot rövid hangjelzést ad (beep) → „most mondd el" (ez a `hello` script hangja is lehet),
   - a backend **3–5 másodpercig** gyűjti a `mic` eseményeket (≈15–25 minta),
   - a minta normalizálódik és elmentődik (JSON, lásd a 6. fejezet).
2. A rögzítés után a backend **teszt-hitelesítést** futtat: a minta saját magához
   hasonlítva meg kell haladjon a küszöbön (a „működik" gomb megmutatja a pontszámot).
3. A mintához opcionálisan **zajminta** is kerül (a beállítás előtt 1 másodperc csend) →
   ebből lesz a zajszint, ami alá nem eshet a detektálás.

**A "bárki mondja" igény itt dől el:** a minta **nem egy konkrét felvétel**, hanem egy
*profil*: a burkoló alakja (normalizált energia-görbe) + a hossz + a szótag-szám. Ebből
minden más hangú, más tempójú beszéd **hasonló osztályba** esik, ha a ritmusa egyezik.

**Felület (a weboldal, új csoport):**

| elem | működés |
|---|---|
| „Rögzítés" | a fenti folyamat (a mintavétel hangjelzéssel kezdődik) |
| „Próba" | a minta saját magával: megadja a pontszámot (a küszöb fölött = rendben) |
| „Érzékenység" | a küszöb csúsztatható (a pontszám → a szükséges hasonlóság) |
| „Be/Ki" | a trigger engedélyezése (a „toggle") |
| „Utolsó találatok" | a legutóbbi detektálások időpontja + pontszáma + nyers görbe |

---

## 4. A mintillesztés (backend, CPU-zsíkon)

**A jel:** a `mic` események `raw` értékeinek sorozata (~5 Hz).

**Normalizálás (a minta és az élő jel azonos térbe):**
1. kivonás: `x' = x - zajszint` (a zajminta átlaga, különben a csend), alsó vágás 0-nál;
2. normalizálás: osztás a csúcsértékkel (a minta így hangerőtől független);
3. szűrés: 3 pontos mozgóátlag (a 5 Hz-es lépcsők felsimítése) → a szótag-görbe.

**Illesztés:** 1-D **DTW** (dynamic time warping) a normalizált görbére, a mintához.
A DTW a mintától való *időzítés-eltolódást* is tolerálja (a lassabb vagy gyorsabb
beszéd), amit egy sima korreláció nem.

**Pontszám:** a DTW költség normalizálva → 0..1 (1 = tökéletes). A detektálás:
`pontszám ≥ küszöb` **ÉS** `időtartalom a mintáéhoz képest ±40%`-on belül
(különben egy hosszú, lassú zaj vagy egy másik beszéd is átmenne).

**Hamis riasztások ellen:**
- a zajszint alatti szakaszok kiesnek;
- a detektáláshoz kell egy **minimum energia** (a csend ne számítson);
- a találat után **újrafegyaszthatatlanság** (refractory period, pl. 3 mp) — egy hosszú
  mondat ne triggereljen ötvenszer;
- a pontszám a UI-n látszik → a felhasználó **maga állítja** a küszöböt (a túl sok hamis
  találat azonnal látszik; a túl kevés → soha nem szól).

**A talált „trigger" → acknowledge:** a backend beepet küld (a `beep` parancs a frekvenciát
is visz → pl. 880 Hz, 300 ms), felvillanthatja a LED-eket, és a UI-n/socketen eseményt ad
(`welcome:detected`). A nyugtázás hangja **megkülönböztethető** a sample-tól, hogy a
két robot (vagy egy másik eszköz) ne essen bele.

---

## 5. A "toggle" — mi hol állítható

| szint | kulcs / elem | alap |
|---|---|---|
| **környezeti változó** | `CODIE_WELCOME_TRIGGER=1` | be/ki (a szerver indulásakor) |
| | `CODIE_WELCOME_THRESHOLD=0.72` | a hasonlósági küszöb (0..1) |
| | `CODIE_WELCOME_SAMPLE=server/.data/welcome-sample.json` | a minta fájlja |
| **admin panel** | a fenti „Be/Ki" gomb | élőben állítható (a mintát nem törli) |
| | „Érzékenység" | a küszöb élőben állítható |

A **mintát** a panel állítja be (ez az „előre beállított sample"); a **toggle** az, hogy
működik-e a felismerés.

> Megjegyzés: a firmware-ben nincs ilyen kapcsoló, és **nem is kell** — minden a
> jelenlegi projektben van. (A firmware `appSys` opjai — `ver`/`mat`/`date`/`ttpms` —
> később kaphatnak egy `welcome` opot, ha a mintát a *robotnak* kell tárolnia; ma a
> backend tárolja.)

---

## 6. Adatmodell és a érintett fájlok

**A minta (JSON, gitignore-olt):**

```json
{
  "address": "00:07:80:66:F0:DA",
  "createdAt": 1760000000000,
  "hz": 5,
  "noise": 120,
  "curve": [0, 14, 38, 72, 55, 21, 6],
  "durationMs": 1400,
  "score": 0.94
}
```

**A jelenlegi projektben:**

| fájl | változás |
|---|---|
| `server/src/welcome.js` | **új**: a minta-tároló, a normalizálás, a DTW, a küszöb |
| `server/src/ble/registry.js` | a `mic` esemény → a welcome-figyelő (a minták és a trigger) |
| `server/src/routes/robots.js` | `GET/POST/DELETE /api/robots/:address/welcome` (minta, rögzítés, kikapcsolás) |
| `server/src/realtime.js` | `welcome:detected` esemény a böngészőnek |
| `server/public/*` | az admin panel új csoportja (rögzítés, próba, érzékenység, ki/be) |
| `server/test/welcome.test.js` | **új**: a normalizálás, a DTW pontszám, a hamis riasztás, a küszöb |
| `codie/…` | *nem kell változni* — a Python réteg nem érintett (a mintillesztés a backendben van) |

**A `mic` stream és a telemetria:** a detektálás ideje alatt a **teleméria szünetel**
(a routing nélküli firmware egy kérést szolgál ki egyszerre — a tudott, szándékos
viselkedés). A mintázás alatt ez elfogadható; a mintázás *közben* a többi érzékelő nem
frissül → az admin panel ezt kiírja.

---

## 7. A fázisok (implementációs sorrend)

| fázis | tartalom | kész, ha |
|---|---|---|
| **P0** | a `mic` esemény rögzítése egy fájlba (egy perc) | a `raw` sorozat látszik a terminálban |
| **P1** | normalizálás + 1-D DTW + küszöb, a minta betöltése JSON-ból | egy kézzel szerkesztett görbe átmegy a saját mintáján |
| **P2** | a rögzítés végpontja (a `mic` stream indítása, ~4 s gyűjtés, zajminta) | a POST rögzít egy mintát, és a saját mintáján átmegy |
| **P3** | a detektálás a `mic` eseményekre, küszöb + időtartalom + refractory | egy visszajátszott minta triggersz |
| **P4** | az admin panel (rögzítés/próba/érzékenység/ki-be) + a `welcome:detected` esemény | a böngészőből végig lehet próbálni |
| **P5** | a nyugtázás (beep + LED) és a `CODIE_WELCOME_*` env-változók | a robot szól, amikor a trigger kiválik |

**Verifikáció:** a P3/P4 tesztelhető **robot nélkül** is: a hamis robot
(`server/test/fake-robot-norrouting.js`) vagy egy rögzített `mic` sorozat visszajátszása
a backendbe → a detektálásnak tűnnie kell. A P5 az egyetlen, ami élő robotot kíván.

---

## 8. A korlátok, és a „valódi beszédfelismerés" (későbbi, nagyobb projekt)

**A mostani terv korlátai (őszintén):**
- a 5 Hz-es burkoló **nem érti a szavakat** — a „bárki mondja" a *ritmus/osztály* szintjén
  működik (hasonló hossz, szótag-szám, energia-görbe);
- egy másik, hosszú beszéd hasonló ritmussal **hamis találatot** okozhat → a küszöb és a
  panelen látható pontszám a felhasználó kezében van;
- a zajminta egy helyen (pl. egy adott szobában) tanulható → más környezetben a küszöböt
  újra kell állítani (vagy a zajszintet futás közben becsülni).

**Ha szöveget is kell felismerni**, a következő lépcső (a firmware-projektben, nem itt):
1. a robot nyers ADC-mintákat streamel a DMA-val (8–16 kHz, 12 bit) — a `hwiAdc`/
   `adc_dma_start` infrastruktúra megvan a visszafejtésben;
2. a roboton (nem a telefonon!) MFCC + DTW fut — mert a modul-link **14 400 baud**
   (≈1,4 kB/s), amin a nyers hang nem fér át;
3. a mintát a robot **maga** rögzíti (a panel csak a „rögzítés most" parancsot küldi) →
   nem kell hangot átvinni a telefonon;
4. a RAM kicsi (16 KB): a gyűjtő **streamelő** feature-kinyerést igényel (a nyers
   gyűrű helyett 50 frame/s × ~13 B feature-ömberek ≈ 650 B/s), a minta a flashben
   (egy dedikált oldal, ~2 KB) — és a flash-írás brick-kockázatot hordoz (a DFU
   visszaállítás a védelem).

Ez a terv **nem** tartalmazza a fenti lépcsőt — csak megjegyzi, hol van a fal.

---

## 9. A nyitott kérdések

1. **A `raw` skála valóban lineáris-e a hang erősségére?** A firmware tracking filtere
   nem feltétlenül lineáris (egy 3:1 IIR); a zaj- és csúcsértékek empirikus
   normalizálással kezelhetők, de egy gyors mérés (a saját csipogó hangereje vs. a
   mic-szint) sokat segít.
2. **Mekkora a mintavételi jitter?** Ha a `mic` események nem pontosan 200 ms-onként
   érkeznek, a DTW időtengelye torzul → a mintát **időbélyeggel** (timestamp) kell
   tárolni, nem csak az indexével.
3. **A panel a telefonon vagy a számítógépen?** A minta rögzítése a **robot** mikrofonjáról
   megy (nem a készülékéről) → a készülék csak a felület. A telefon használható
   (a BLE a háttérben), de a mintát a backend tárolja, nem a böngésző.
4. **Több robot, több minta?** A modell egy mintát egy címhez köt; több robot esetén
   a `address` a kulcs → a lista és a `mic` események szűrése cím alapján.
