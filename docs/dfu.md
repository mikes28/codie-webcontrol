# Codie firmware (STM32 DFU) — mentés, visszaírás, flashelés

A Codie robot központi vezérlője egy **STM32F1xx (Cortex-M3)** mikrokontroller:
**128 KB belső flash** a `0x08000000` címen, **16 KB SRAM** a `0x20000000` címen.
A BLE-t nem a MCU, hanem egy külön modul beszélget a MCU-val **USART1-en** keresztül
(`server/src/ble/protocol-norrouting.js` — a routing nélküli generáció frame-formátuma).

A MCU **USB-je kizárólag a ROM bootloaderhez (DFU) tartozik**: az alkalmazás maga
nem használ USB perifériát (a firmware-ben sehol nem szerepel az USB periféria
regisztertér `0x40005C00`, a PMA `0x40005C80` vagy az USB SRAM `0x40006000` címe).
Ezért a firmware módosítása csak két úton lehetséges:

1. **USB DFU-n** (ez a dokumentum) — a robot DFU/bootloader módban USB-n látszik,
   és a `dfu-util` kiolvassa/kiírja a flash tartalmát;
2. **BLE DFU-n** (a hivatalos API-ban) — a `docs/comApi.h` szerint
   `ComApi_Cmd_Ble_McuDfuPrepare` / `ComApi_Cmd_Ble_McuDfuWriteBin` /
   `ComApi_Cmd_Ble_McuDfuWriteBinDone` (`0x4394`+), illetve a routingos protokollban
   a `ComApi_Cmd_Mcu_SwitchToBootloader` (`0x106d`). Ezek a **routingos** generáció
   parancskészletéhez tartoznak; a projektben lévő valódi robot (routing nélküli,
   `00:07:80:66:F0:DA`) nem beszél ezeket a frame-eket, így gyakorlatban a
   **hardveres DFU módba kapcsolás** az egyetlen járható út.

---

## Miért Docker kell (nincs root)

A host Arch Linux, a felhasználónak nincs sudo jelszava:

- `pacman -S dfu-util` → sudo-t kér → **nem futtatható**;
- a `dfu-util` USB-t kezel, a device node (`/dev/bus/usb/BBB/DDD`) `root:root 0644`
  → a hoston **root kellene** a megnyitáshoz;
- a Docker **gyökérben** futtatja a `dfu-util`-t, tehát a hoszt felhasználójának
  nem kell jelszó.

Amit a `scripts/dfu/dfu-container.sh` csinál:

1. **megépíti a `dfu` Docker képet**, ha nincs meg (`FROM node:22-bookworm-slim`
   + `apt-get install dfu-util usbutils python3 xxd`);
2. **megtalálja a DFU eszközt** a sysfs-ben (`0483:df11`) — a bus/devnum párt
   a `/sys/bus/usb/devices/*/uevent`-ből olvassa, **soha nem hard-code-olt értékből**
   (a `devnum` minden újrapluggoláskor változik!);
3. **átadja az eszközt a konténernek** — ehhez *kell* az explicit
   `--device=/dev/bus/usb/BBB/DDD` grant, mert a sima
   `-v /dev/bus/usb:/dev/bus/usb` mount **önmagában nem elég**: a Docker
   alapértelmezett eszköz-cgroupja letiltja az usbfs karaktereszközöket, és
   a `dfu-util` `LIBUSB_ERROR_IO` hibát ad. A `-v` mount *plusz* a `--device`
   grant együtt adja a szükséges hozzáférést.

---

## Gyors start

```bash
cd ~/Documents/kurwa/codie

# 0. a robot DFU/bootloader módban legyen (lásd lent)
# 1. ellenőrzés: a felfedezés működik-e?
bash scripts/dfu/dfu-container.sh --print-discovery
bash scripts/dfu/dfu-container.sh --print-device-args   # --device=/dev/bus/usb/001/007

# 2. száraz futtatás: mit csinálna, ha valóban futna?
bash scripts/dfu/backup.sh --dry-run

# 3. valódi mentés (csak olvas a roboton)
bash scripts/dfu/backup.sh
#    → scratchpad/firmware/backup-<UTC időbélyeg>/{stm32_flash.bin,option_bytes.bin,SHA256SUMS,MANIFEST.txt}

# 4. visszaírás (a chipre ír!) — előbb száraz futtatás
bash scripts/dfu/restore.sh scratchpad/firmware/backup-<UTC időbélyeg> --dry-run
bash scripts/dfu/restore.sh scratchpad/firmware/backup-<UTC időbélyeg> --i-know-what-im-doing

# 5. tetszőleges nyers kép kiírása (a chipre ír!)
bash scripts/dfu/flash.sh firmware.bin --dry-run
bash scripts/dfu/flash.sh firmware.bin --i-know-what-im-doing
```

A szkriptek bármely könyvtárból hívhatók (a saját útvonalukat a `BASH_SOURCE`
alapján oldják fel), és mindegyik `--help`-et és `--dry-run`-t támogat.

---

## A DFU memória térkép

A `dfu-util -l -d 0483:df11` kimenete (a bootloader két alternate settinget
kínál):

```
Found DFU: [0483:df11] ver=2200, cfg=1, intf=0, path="1-2", alt=0,
           name="@Internal Flash  /0x08000000/064*0002Kg", addr=0x08000000, len=0x20000
Found DFU: [0483:df11] ver=2200, cfg=1, intf=0, path="1-2", alt=1,
           name="@Option Bytes  /0x1FFFF800/01*016 e", addr=0x1FFFF800, len=0x10
```

| alt | terület | cím | méret | `dfu-util` jelölés | jelentősége |
|-----|---------|-----|-------|-------------------|-------------|
| 0 | belső flash | `0x08000000` | **128 KB** (131072 B) | `064*0002Kg` = 64 × 2 KB | maga a firmware |
| 1 | option bytes | `0x1FFFF800` | **16 B** | `01*016 e` | a chip konfigurációja (védelem, watchdog, boot) |

- Az **alt 0** a firmware: ide kell írni egy új buildet.
- Az **alt 1** az option byte-ok: 16 bájt, és **el nem írt** opcionális
  `restore.sh`-ben (`--with-option-bytes`). Az option byte-ok rossz beállítása
  (pl. read-out protection, vagy a `BOOT` mező értéke) **brickelheti** a chipet
  vagy elindíthatatlanná teszi a USB DFU-t.

A `dfu-util 0.11` két sajátossága, amit a szkriptek kezelnek:

- `-U` (upload = olvasás a robotról) **fájlnevet vár argumentumként**, és
  **nem ír felül létező fájlt** (exit 73) → a `backup.sh` ideiglenes néven ír,
  majd átmozgat;
- `-D` (download = írás a robotra) szintén **fájlnevet vár** (nem stdinről olvas)
  → a `flash.sh`/`restore.sh` a fájlt read-only bind mounttal adja át.

---

## Biztonsági szabályok

1. **Mindig előbb mentés.** Bármilyen írás előtt fuss `backup.sh`-t, és ellenőrizd
   az ellenőrzőösszeget: `cd <backup> && sha256sum -c SHA256SUMS`.
2. **Amit nem értesz, azt ne írd.** Az írás felülírja a firmware-et: hibás kép →
   a robot nem bootol el, és a BLE kapcsolat soha nem jön vissza.
3. **A méretet ellenőrizni kell.** A `restore.sh` a chip saját
   `len=` mezőjét olvassa ki a `dfu-util -l` kimenetéből, és **elutasítja** a
   visszaírást, ha a backup fájl mérete nem egyezik (128 KB). A `flash.sh`
   elutasítja a 128 KB-nál nagyobb képet; a **kisebb** kép csak a flash elejét
   írja felül, a többi a flash-ben marad (a DFU csak az írt szektorokat törli) —
   ezért részleges képet csak tudatosan szabad kiírni.
4. **Megerősítés kell.** A chipre író két parancs (`restore.sh`, `flash.sh`)
   `--i-know-what-im-doing` kapcsoló nélkül **nem ír** (exit 8), és piros
   figyelmeztető bannert nyomtat.
5. **A robotot USB-ről tápellátsd, NE a töltőről.** Töltés közben a DFU
   írás tilos (a töltő által szolgáltatott feszültség mellett a chip
   programozása nem garantált, és a töltő áramkörhöz kötve a flash írás
   kockázatos). A `restore.sh`/`flash.sh` ezt a figyelmeztetést kiírja.
6. **A option byte-ok külön, extra kapcsoló.** A `restore.sh` alapból **csak**
   a belső flash-t írja vissza; az option byte-okhoz `--with-option-bytes`
   kell.

---

## DFU módba kapcsolás (az MCU bootloaderbe ugratása)

Az STM32F1 ROM (system memory) bootloadere a **BOOT0** pin szintjénél indul el:

1. a **BOOT0** legyen **magas** (3,3 V-ra kötve — jumperrel vagy a
   `BOOT0` gombbal),
2. **resetelj** a robotot (újraindítás / tápellátás),
3. a robot USB-n **DFU eszközként** jelenik meg: `0483:df11`,
   `STMicroelectronics STM Device in DFU Mode`, a termék neve
   `STM32  BOOTLOADER`,
4. a `BOOT0`-t engedd vissza (alacsony), és lépj tovább a DFU művelettel.

Ellenőrzés:

```bash
lsusb | grep -i stm        # "STM Device in DFU Mode"
bash scripts/dfu/dfu-container.sh --print-discovery
```

Ha a `lsusb` **nem** mutatja a DFU eszközt, akkor a robot az alkalmazását
futtatja (a routing nélküli generáció USB-je ilyenkor csendben marad), és a
bootloaderbe a fenti BOOT0-s reseteléssel lehet visszajutni.

> A `restore.sh`/`flash.sh` a DFU módot **ellenőrzi** a sysfs-ből: a DFU
> interface osztálya `0xFE`, alosztálya `0x01` (application specific / DFU).
> Ha ez nem egyezik, a szkript tiszta hibával kilép (exit 4) — nem ír oda,
> ahol nem DFU eszköz van.

---

## Mi van a kimentett firmware-ben?

A 2026-10-21-i mentés (`scratchpad/firmware/stm32_flash.bin`, 131072 B):

| tulajdonság | érték | honnan |
|---|---|---|
| chip | STM32F1xx, Cortex-M3 | a vektortábla `0x08002905` reset-handlerje |
| flash | 128 KB @ `0x08000000` | a DFU alt 0 `len=0x20000` |
| SRAM | 16 KB @ `0x20000000` | a kezdő stack pointer `0x20003fff` |
| firmware id | `0.5.0hw2.1` | a dump `0xc660` cíkjén lévő string |
| build időbélyeg | `1602121419` (Unix time) = **2020-10-08 01:43:39 UTC** (2020-10-07 a build gép amerikai nyugati időzónájában) | a `date` kulcs a `0xc67c` címen |
| USB | **csak DFU** — az alkalmazás nem használ USB perifériát | nincs `0x40005C00`/`0x40005C80`/`0x40006000` hivatkozás a flash-ben |
| BLE | külön modul, **USART1**-en (`0x40013800`) | a dump `bleCom` / "BLE USART" szövegei |

Ellenőrzőösszegek (a `scratchpad/firmware/README.md` is ezeket tartalmazza):

```
md5    : 97c9bfdc69e80982bca578ebcabb0fe1
sha256 : 0c5f3583ee1a96a77a7b0313ff865db8b0689d3e1e87bdd45f459a46a93dacda
```

A firmware modul-nevei a `hwi*` (hardver interfész) / `app*` (alkalmazás) /
`bleCom` (BLE kommunikáció) konvenciót követik — ugyanez a
[`docs/comApi.h`](comApi.h) headerben is a `ComApi_Route_*` és
`ComApi_Cmd_Mcu_*` / `ComApi_Cmd_Ble_*` nevekben jelenik meg.

---

## A szkriptek

### `scripts/dfu/dfu-container.sh`

Vékony wrapper: a `dfu-util`/bármilyen parancs futtatása a `dfu` Docker képben,
a helyes eszköz-granttal.

| opció | jelentősége |
|---|---|
| `--print-device-args` | kiírja a `--device=/dev/bus/usb/BBB/DDD` argumentumot (gépileg feldolgozható) |
| `--print-device-path` | kiírja az eszköz útvonalát |
| `--print-discovery` | kiírja a felfedezés részleteit (sysfs, DFU mód) |
| `--dry-run` | kiírja a docker parancssort, nem indítja el |
| `--image KÉP` | a Docker kép neve (alap: `dfu`) |
| `--no-build` | nem buildeli a képet, ha hiányzik |
| `--mount HOST:KONT` | extra bind mount (a `backup.sh` a kimeneti könyvtárat, a `flash.sh`/`restore.sh` a bemenetet adja át) |
| `--chown HOST` | a futó userre chownolja a mountolt könyvtárat (a konténer rootként ír) |
| `--env KÉ=V` | extra környezeti változó a konténerbe |
| `-v, --verbose` | részletes diagnosztika |

### `scripts/dfu/backup.sh`

| opció | jelentősége |
|---|---|
| `--out KÖNYVTÁR` | kimenet (alap: `scratchpad/firmware/backup-<UTC időbélyeg>`) |
| `--no-option-bytes` | csak a belső flash mentése (alt 0) |
| `--dry-run` | csak kiírja a parancssorokat |

A mentés **csak olvas** a roboton (`-U` = upload a robotról), ezért bármikor
futtatható. A kimeneti könyvtárba ír: `stm32_flash.bin`, `option_bytes.bin`,
`SHA256SUMS`, `MANIFEST.txt`, `dfu-util-list.txt`.

### `scripts/dfu/restore.sh BACKUP-KÖNYVTÁR`

| opció | jelentősége |
|---|---|
| `--i-know-what-im-doing` | **kötelező** megerősítés a chipre írás előtt |
| `--with-option-bytes` | az option byte-ot (alt 1) is visszaírja (extra kockázat) |
| `--dry-run` | csak kiírja a parancssorokat |

A sorrend: `SHA256SUMS` ellenőrzés → manifest hash-ek összevetése → a chip
flash-méretének kiolvasása és összevetése a fájl méretével → megerősítés →
**csak ezután** ír.

### `scripts/dfu/flash.sh KÉP.BIN`

| opció | jelentősége |
|---|---|
| `--i-know-what-im-doing` | **kötelező** megerősítés a chipre írás előtt |
| `--dry-run` | csak kiírja a parancssorokat |

### `scripts/dfu/selftest.sh`

A felfedezés öntesztje **fabricált sysfs fán** (nem nyúl hardverhez): a
`DFU_SYSFS_ROOT` és `DFU_USB_ROOT` env-variánsokkal hamis fa építhető, és a
szkript ellenőrzi a sikeres felfedezést, az eszköz hiányát (exit 3), a
„nem DFU módban" állapotot (exit 4), a hiányzó eszköz-csomópontot (exit 3),
a decoy USB eszközök kizárását és a dry-run viselkedését.

```bash
bash scripts/dfu/selftest.sh
```

### Kilépési kódok (mind a négy szkriptnél)

| kód | jelentőség |
|---|---|
| 0 | ok |
| 2 | használati hiba (rossz argumentum, hiányzó backup könyvtár) |
| 3 | a DFU eszköz nem található (nincs USB, vagy nem 0483:df11) |
| 4 | az eszköz megvan, de nincs DFU módban |
| 6 | a konténerben futó `dfu-util` hibásan végződött |
| 7 | ellenőrzési hiba (méret vagy hash nem egyezik) |
| 8 | a megerősítő kapcsoló (`--i-know-what-im-doing`) hiányzik |

---

## Hibakeresés

| tünet | ok / megoldás |
|---|---|
| `LIBUSB_ERROR_IO` | a `--device=` grant hiányzik (a sima `-v` mount nem elég) |
| `[hiba] nem található 0483:df11 USB eszköz` | a robot nem DFU módban van, vagy nincs USB-kábel / nincs tápellátás |
| `[hiba] ... az eszköz megvan, de NINCS DFU módban` | a robot az alkalmazását futtatja → BOOT0 + reset |
| `[hiba] ... az eszköz csomópont hiányzik` | épp kihúzták a kábelt → újrapróbálkozás (a devnum közben megváltozott) |
| `dfu-util: option requires an argument -- 'U'` | a `-U`-nak fájlnevet kell adni (ez a 0.11-es viselkedése) |
| `dfu-util` exit 73 | a kimeneti fájl már létezik → a `backup.sh` ideiglenes nevet használ |
| `error: skipping device, some information will be lost` | nem FATAL: az eszköz adatai (sorozatszám) hiányoznak — a DFU írásra ez nem kell |

---

## Amit ez az eszközlánc nem csinál

- **Nem ír a BLE modul firmware-jére.** Az a külön modul a `0.5.0hw2.1` alkalmazás
  mögött van; a BLE frissítés külön, a modul saját protokollja szerint történik.
- **Nem debuggol SWD-vel.** Ez a ROM bootloader USB DFU interfésze, nem az
  ST-LINK/OpenOCD útvonal.
- **Nem patchel binárist.** A `flash.sh` nyers képet ír; az "elfogytott" (read-out
  protected) chipen a DFU letiltva van, ezt a `dfu-util` `unprotect` opcióval
  lehetne kezelni — ez a tool szándékosan **nem** támogatja (a `force`/`unprotect`
  opciók nem szerepelnek egyik szkriptben sem).

### Ami 2026-10-21-én igazolt volt, és ami nem

- **Igazolt (élő hardveren):** a DFU eszköz felfedezése, a `dfu-util -l` kimenete
  (alt 0: 128 KB, alt 1: 16 B), a **belső flash kiolvasása** (a
  `scratchpad/firmware/stm32_flash.bin` ebből készült), a Docker `--device=`
  grant működése.
- **Nem futott le élő hardveren (szándékosan, biztonságból):** az író ág
  (`restore.sh` / `flash.sh` valódi futtatása) — ebben a munkamenetben **nem
  történt írás a chipre**. A parancssorok alakja a bizonyított olvasó ág
  (`-U`) mintáját követi (`-D`, `-s <cím>:leave`).

---

## Hivatkozások

- [`docs/comApi.h`](comApi.h) — a hivatalos Codie BLE API v1.0 header
  (parancs-ID-k, routing, `SwitchToBootloader`, a BLE DFU parancsok).
- [`CLAUDE.md`](../CLAUDE.md) — a projekt hardver- és protokollreferenciája
  (két generáció, BLE topológia, frame-formátum).
- [`MEMORY.md`](../MEMORY.md) — a fejlesztési napló (a BLE réteg története,
  a firmware-verzió megjelenése).
- STM32 AN3156 — *How to use USB DFU protocol in bootloader on STM32 MCUs*
  (a `dfu-util` / DfuSe protokoll és az `alt` beállítások).
- STM32 system memory bootloader — a BOOT0-s belépés szabályai.
