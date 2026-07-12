---
name: codie-robot
description: A Codie oktatórobot vezérlése BLE-n a mcp_codie_* toolokkal — érzékelés, biztonságos véges mozgás, hang és LED. Használd, ha a Codie-t kell mozgatni, "megnézetni" vele a környezetet, vagy megszólaltatni.
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [robot, ble, codie, hardware, embodied]
    category: robotics
    requires_tools: [mcp_codie_status, mcp_codie_drive_forward]
---
# Codie robot vezérlés

A Codie egy kerekes/lánctalpas oktatórobot, BLE-n (Bluetooth 4.0) vezérelve a `codie` MCP-szerveren
át. A toolok magas szintűek és biztonságosak: a mozgásparancsok végesek és maguktól megállnak.

## Mikor használd

Amikor a felhasználó a Codie robotot akarja mozgatni, a környezetét „megnézetni" (szonár/fény/vonal),
vagy hangot/LED-et kérni tőle. A `codie` MCP-szerver toolokat `mcp_codie_*` néven éred el.

## Elérhető toolok

- **Érzékelés:** `mcp_codie_status` (akku %, szonár mm, fény, vonal bal/jobb), `mcp_codie_look_ahead` (szonár mm).
- **Mozgás (véges, magától megáll):** `mcp_codie_drive_forward(cm)`, `mcp_codie_drive_backward(cm)`,
  `mcp_codie_turn(degrees)` — **pozitív fok = jobbra, negatív = balra**, `mcp_codie_stop`.
- **Kimenet:** `mcp_codie_beep(ms)`, `mcp_codie_say_morse(text)`, `mcp_codie_set_leds(color)`.

## Eljárás (magas szintű akciók — Butter-Bench elv)

1. **Érzékelj mozgás ELŐTT.** Hívj `look_ahead`-et vagy `status`-t: mekkora a szabad út a szonár
   szerint (mm), és él-e az akku. Ne mozgass vakon.
2. **Csak véges parancsot adj** (forward/backward cm-ben, turn fokban). Ezek maguktól megállnak —
   ne próbálj folytonos sebességet vezérelni.
3. **Egy akció, majd újraérzékelés.** Ne fűzz össze sok vak mozgást; a robot lassú és a BLE késleltet.
   Lépésenként haladj, a szonár visszajelzése alapján korrigálj.
4. **Akadály közel** (szonár < ~150 mm): állj meg vagy fordulj, ne menj neki.
5. **Bizonytalanságnál** hívj `stop`-ot.

## Buktatók (a gyakorlatból)

- **Töltőn a LED nem állítható:** a firmware töltésanimációja (körbefutó fehér + töltöttséget
  jelző piros LED-ek) felülírja a `set_leds`-t. Látható LED-hez a robotot le kell venni a töltőről.
- **Alacsony akku** (~15% alatt): a motorok gyengék lehetnek; előbb `status`. Ha a mozgás nem indul,
  valószínűleg az akku, nem a parancs.
- **A csipogó fix hangmagasságú** (~2483 Hz-es buzzer): nincs dallam. A `say_morse` és a `beep` csak
  ritmus/időzítés — ne ígérj zenét.
- **BLE-késleltetés:** az első tool-hívás ~10-15 mp (kapcsolatépítés). Ha egy hívás BLE-hibát dob
  (a robot elaludt / kiment a hatótávból), a következő hívás automatikusan újracsatlakozik —
  próbáld meg még egyszer, mielőtt hibát jelentesz.
- **Fizikai biztonság:** padlón mozgatás előtt győződj meg, hogy a robot nincs asztalszélen.
  Teszthez a biztonságos póz: a robot az oldalán, töltőn (a kerekek pörögnek, de nem szalad el).

## Színek

`set_leds` elfogadott értékei: `white`, `green`, `red`, `blue`, `cyan`, `yellow`, `orange`.

## Ellenőrzés

- `status` értelmes értékeket ad (akku %, szonár mm), a mozgásparancs után a robot a várt helyzetben
  van, a `beep` hallható. Ha minden tool BLE-hibát dob, a `codie` MCP-szerver vagy a robot nem elérhető
  — ellenőrizd, hogy a Codie be van-e kapcsolva és hatótávon belül.
