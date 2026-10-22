#!/usr/bin/env bash
#
# backup.sh — a Codie robot STM32 firmware-jának kimentése DFU-n keresztül.
#
# Két területet olvasunk ki a DFU bootloaderből:
#   alt 0 — belső flash, 0x08000000, 128 KB (a firmware)
#   alt 1 — option bytes, 0x1FFFF800, 16 B (a chip konfigurációja)
#
# A kimenet egy időbélyegzett könyvtár:
#   stm32_flash.bin   — 131072 B, nyers flash tartalom
#   option_bytes.bin  — 16 B, nyers option byte tartalom
#   SHA256SUMS        — sha256sum -c formátumú ellenőrzőösszeg-lista
#   MANIFEST.txt      — emberi olvasásra szánt manifest
#   dfu-util-list.txt — a dfu-util -l kimenete a mentés időpontjában
#
# A mentés "csak olvas": a DFU eszközt nem írjuk, ezért bármikor futtatható.
#
# Kilépési kódok:
#   0  ok
#   2  használati hiba
#   3  DFU eszköz nem található
#   4  az eszköz megvan, de nincs DFU módban
#   6  a konténerben futó dfu-util hibásan végződött
#   7  ellenőrzési hiba (méret/hash)

set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
CONTAINER="$SCRIPT_DIR/dfu-container.sh"

EX_OK=0
EX_USAGE=2
EX_NO_DEVICE=3
EX_NOT_DFU=4
EX_CONTAINER=6
EX_VERIFY=7

VID="${DFU_VENDOR:-0483}"
PID="${DFU_PRODUCT:-df11}"
FLASH_NAME="stm32_flash.bin"
FLASH_ADDR="0x08000000"
FLASH_ALT=0
FLASH_SIZE=131072 # 128 KB
OPT_NAME="option_bytes.bin"
OPT_ADDR="0x1FFFF800"
OPT_ALT=1
OPT_SIZE=16

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
	C_RED=$'\033[1;31m'; C_GRN=$'\033[1;32m'; C_YEL=$'\033[1;33m'
	C_BLU=$'\033[1;34m'; C_BLD=$'\033[1m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
	C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_BLD=''; C_DIM=''; C_OFF=''
fi

info() { printf '%s==>%s %s\n' "$C_BLU" "$C_OFF" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s[figyelem]%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
err()  { printf '%s[hiba]%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; }
die()  { local code="$1"; shift; err "$*"; exit "$code"; }

DRY_RUN=0
WITH_OPTION_BYTES=1
OUT_DIR=""

usage() {
	cat <<EOF
${C_BLD}Codie DFU — firmware backup${C_OFF}

Kiolvassa a robot STM32 bootloader-ének belső flash-ét (alt 0, ${FLASH_SIZE} B)
és opcionálisan az option bytes-okat (alt 1, ${OPT_SIZE} B), majd SHA256SUMS
ellenőrzőösszeg-listát és manifestet ír.

${C_BLD}Használat:${C_OFF}
  $SCRIPT_NAME [OPCIÓK]

${C_BLD}Opciók:${C_OFF}
  --out KÖNYVTÁR      A kimenet könyvtára (alap: <repo>/scratchpad/firmware/backup-<UTC időbélyeg>)
  --no-option-bytes   Csak a belső flash mentése (alt 0), option bytes nélkül
  --dry-run           Kiírja a futtatandó parancssorokat, nem nyúl az eszközhöz
  -h, --help          Ez a súgó

${C_BLD}Példák:${C_OFF}
  $SCRIPT_NAME
  $SCRIPT_NAME --out /tmp/codie-backup
  $SCRIPT_NAME --dry-run

${C_BLD}Megjegyzés:${C_OFF}
  A mentés nem ír az eszközre (csak -U upload = olvasás a robotról).
  A dfu-util 0.11 nem ír felül létező fájlt, ezért a kimeneti fájlok
  ideiglenes néven készülnek, majd átmozgatásra kerülnek.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		-h|--help) usage; exit "$EX_OK" ;;
		--out) [[ $# -ge 2 ]] || die "$EX_USAGE" "--out után könyvtárnév kell"; OUT_DIR="$2"; shift ;;
		--no-option-bytes) WITH_OPTION_BYTES=0 ;;
		--dry-run) DRY_RUN=1 ;;
		*) die "$EX_USAGE" "ismeretlen argumentum: $1 (lásd --help)" ;;
	esac
	shift
done

[[ -x "$CONTAINER" || -f "$CONTAINER" ]] || die "$EX_USAGE" "hiányzó segédscript: $CONTAINER"

if [[ -z "$OUT_DIR" ]]; then
	OUT_DIR="$REPO_ROOT/scratchpad/firmware/backup-$(date -u +%Y%m%dT%H%M%SZ)"
fi

# --- eszköz-ellenőrzés -----------------------------------------------------
# A wrapper végzi a felfedezést; mi csak a saját diagnosztikát adjuk hozzá,
# hogy a hibaüzenet a backup szempontjából is érthető legyen.
check_device() {
	local rc=0
	"$CONTAINER" --print-discovery >/dev/null 2>&1 || rc=$?
	case "$rc" in
		0) return 0 ;;
		3) die "$EX_NO_DEVICE" "nem található ${VID}:${PID} DFU eszköz — a robot DFU módban van?" ;;
		4) die "$EX_NOT_DFU" "az eszköz megvan, de nincs DFU módban (lásd docs/dfu.md)" ;;
		*) die "$rc" "eszköz-felfedezési hiba (exit $rc)" ;;
	esac
}

# --- egy terület kiolvasása ------------------------------------------------
# read_region <alt> <addr> <size> <fájl-név> <leave-flag>
read_region() {
	local alt="$1" addr="$2" size="$3" name="$4" leave="$5"
	local addr_spec="$addr"
	if [[ "$leave" == "leave" ]]; then
		addr_spec="${addr}:leave"
	fi
	local -a cmd=(dfu-util -d "${VID}:${PID}" -a "$alt" -s "$addr_spec" -Z "$size" -U "/out/.dfu-tmp/${name}")

	info "alt ${alt} @ ${addr_spec} — ${size} B → ${name}"
	if [[ $DRY_RUN -eq 1 ]]; then
		"$CONTAINER" --dry-run --mount "$OUT_DIR:/out" --chown "$OUT_DIR" -- "${cmd[@]}"
		return 0
	fi

	mkdir -p "$OUT_DIR/.dfu-tmp"
	rm -f "$OUT_DIR/.dfu-tmp/${name}" "$OUT_DIR/${name}"

	local rc=0
	"$CONTAINER" --mount "$OUT_DIR:/out" --chown "$OUT_DIR" -- "${cmd[@]}" || rc=$?
	if [[ $rc -ne 0 ]]; then
		err "a dfu-util kiolvasása sikertelen (alt ${alt}, exit $rc)"
		err " Ellenőrizd a dfu-util kimenetét; a robot maradjon DFU módban."
		exit "$EX_CONTAINER"
	fi

	local tmp="$OUT_DIR/.dfu-tmp/${name}"
	[[ -f "$tmp" ]] || die "$EX_CONTAINER" "a dfu-util nem hozott létre fájlt: $tmp"
	local actual
	actual="$(stat -c %s "$tmp")"
	if [[ "$actual" -ne "$size" ]]; then
		err "méret ellenőrzés sikertelen: ${name} = ${actual} B, elvárt ${size} B"
		rm -f "$tmp"
		exit "$EX_VERIFY"
	fi
	mv -f "$tmp" "$OUT_DIR/${name}"
	rmdir "$OUT_DIR/.dfu-tmp" 2>/dev/null || true
	ok "${name}: ${actual} B"
}

# --- DFU mód elhagyása ------------------------------------------------------
# A ':leave' flag resetet indít az MCU-n, és az alkalmazás elindul. Ezt a
# mentés végén MINDIG meg kell tenni: ha a chip a bootloaderen marad, az
# alkalmazás nem fut, és a robot BLE-en hirdet, de a kapcsolatokat azonnal
# ledobja (a hirdetést a BLE-modul viszi, a sessiont az alkalmazás).
leave_dfu() {
	local -a cmd=(dfu-util -d "${VID}:${PID}" -a "$FLASH_ALT" -s "${FLASH_ADDR}:leave")
	info "DFU mód elhagyása (${FLASH_ADDR}:leave) — a robot az alkalmazásba indul"
	if [[ $DRY_RUN -eq 1 ]]; then
		"$CONTAINER" --dry-run -- "${cmd[@]}"
		return 0
	fi
	local rc=0
	"$CONTAINER" -- "${cmd[@]}" || rc=$?
	if [[ $rc -ne 0 ]]; then
		warn "a DFU mód elhagyása sikertelen (exit $rc) — indítsd újra a robotot kézzel"
		return 0
	fi
	ok "a robot kilépett a DFU módból"
}

# --- fő folyamat -----------------------------------------------------------
info "Codie DFU firmware backup"

if [[ $DRY_RUN -eq 1 ]]; then
	warn "dry-run: nincs eszköz-hozzáférés, nincs fájlírás"
else
	check_device
fi

if [[ $DRY_RUN -eq 0 ]]; then
	if [[ -e "$OUT_DIR" ]] && [[ -n "$(ls -A "$OUT_DIR" 2>/dev/null)" ]]; then
		die "$EX_USAGE" "a kimeneti könyvtár már létezik és nem üres: $OUT_DIR (adj más --out útvonalat)"
	fi
	mkdir -p "$OUT_DIR"
else
	printf '%s[dry-run]%s mkdir -p %q\n' "$C_DIM" "$C_OFF" "$OUT_DIR"
fi
info "kimenet: $OUT_DIR"

# A dfu-util -l kimenete a manifestbe kerül (a készüléklistája a mentéskor).
if [[ $DRY_RUN -eq 1 ]]; then
	"$CONTAINER" --dry-run -- dfu-util -l -d "${VID}:${PID}"
else
	"$CONTAINER" -- dfu-util -l -d "${VID}:${PID}" >"$OUT_DIR/dfu-util-list.txt" 2>&1 || true
fi

# A belső flash kerüljön először (ha ez elhasal, a flash mentése már megvan),
# az option bytes olvasása zárja a sorozatot: csak az utolsó művelet hagyja el
# a DFU módot (a 'leave' flag ugyanis resetet indít az MCU-n).
read_region "$FLASH_ALT" "$FLASH_ADDR" "$FLASH_SIZE" "$FLASH_NAME" ""
if [[ $WITH_OPTION_BYTES -eq 1 ]]; then
	read_region "$OPT_ALT" "$OPT_ADDR" "$OPT_SIZE" "$OPT_NAME" "leave"
else
	warn "option bytes kihagyva (--no-option-bytes)"
	# option bytes nélkül a mentés nem zárja ':leave'-rel a sort — a DFU módból
	# itt is ki kell lépni, különben a robot a bootloaderen marad.
	leave_dfu
fi

if [[ $DRY_RUN -eq 1 ]]; then
	info "dry-run vége — a manifest és a SHA256SUMS a valós futáskor készül"
	exit "$EX_OK"
fi

# --- ellenőrzőösszegek és manifest ----------------------------------------
(
	cd "$OUT_DIR"
	sha256sum "$FLASH_NAME" "$OPT_NAME" >SHA256SUMS 2>/dev/null || sha256sum "$FLASH_NAME" >SHA256SUMS
)

{
	printf 'Codie DFU firmware backup — manifest\n'
	printf '=====================================\n\n'
	printf 'időbélyeg (UTC)   : %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'robot MCU         : STM32, USB DFU bootloader (%s:%s)\n' "$VID" "$PID"
	printf 'gép               : %s\n' "$(uname -srm)"
	printf 'dfu-util          : %s (Docker kép: %s)\n' "$(docker run --rm "${DFU_IMAGE:-dfu}" dfu-util --version 2>/dev/null | head -n1 || echo '?')" "${DFU_IMAGE:-dfu}"
	printf 'kimeneti könyvtár : %s\n\n' "$OUT_DIR"
	printf 'terület           alt  cím         méret    fájl              sha256\n'
	printf '-----------------------------------------------------------------------\n'
	while read -r _hash name; do
		case "$name" in
			"$FLASH_NAME")
				printf 'belső flash        %s    %-7s  %-18s %s\n' "$FLASH_ALT" "$FLASH_ADDR" "$(stat -c %s "$OUT_DIR/$name") B" "$name" "$_hash" ;;
			"$OPT_NAME")
				printf 'option bytes       %s    %-7s  %-18s %s\n' "$OPT_ALT" "$OPT_ADDR" "$(stat -c %s "$OUT_DIR/$name") B" "$name" "$_hash" ;;
		esac
	done <"$OUT_DIR/SHA256SUMS"
	printf '\nellenőrzés: cd %s && sha256sum -c SHA256SUMS\n' "$OUT_DIR"
} >"$OUT_DIR/MANIFEST.txt"

ok "backup kész: $OUT_DIR"
printf '\n'
cat "$OUT_DIR/MANIFEST.txt"
printf '\n'
ok "ellenőrzés: (cd '$OUT_DIR' && sha256sum -c SHA256SUMS)"
exit "$EX_OK"
