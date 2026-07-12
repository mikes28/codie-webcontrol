# Changelog

A projekt verziózása [semver](https://semver.org/lang/hu/) szerint.

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
