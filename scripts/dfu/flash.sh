#!/usr/bin/env bash
#
# flash.sh — nyers firmware kép kiírása a Codie robot STM32 DFU bootloader-ébe.
#
# A kép a belső flash-be kerül (alt 0, 0x08000000). A dfu-util 0.11 -D
# kapcsolója egy FÁJLT vár argumentumként (a -U-val ellentétben, a -D
# nem stdinről olvas), ezért a kép a konténerbe egy read-only bind mounton
# keresztül jut be.
#
# Biztonsági szabályok:
#   * a kép mérete nem lehet nagyobb a chip flash méreténél (128 KB),
#   * kötelező a --i-know-what-im-doing megerősítés,
#   * előtte mindig backup (scripts/dfu/backup.sh).
#
# Kilépési kódok:
#   0  ok
#   2  használati hiba
#   3  DFU eszköz nem található
#   4  az eszköz megvan, de nincs DFU módban
#   6  a konténerben futó dfu-util hibásan végződött
#   7  ellenőrzési hiba (méret)
#   8  nincs megerősítés (a --i-know-what-im-doing hiányzik)

set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="$SCRIPT_DIR/dfu-container.sh"

EX_OK=0
EX_USAGE=2
EX_NO_DEVICE=3
EX_NOT_DFU=4
EX_CONTAINER=6
EX_VERIFY=7
EX_ABORT=8

VID="${DFU_VENDOR:-0483}"
PID="${DFU_PRODUCT:-df11}"
FLASH_ADDR="0x08000000"
FLASH_ALT=0
FLASH_SIZE=131072 # 128 KB

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

banner() {
	printf '%s' "$C_RED"
	cat <<'EOF'
======================================================================
  FIGYELMEZTETÉS — A ROBOT FIRMWARE-E FELÜLÍRÓDNI FOG!
  Hibás kép esetén a robot nem bootol el. Előtte mindig készíts
  backupot (scripts/dfu/backup.sh), és USB-ről tápelltasd a robotot.
======================================================================
EOF
	printf '%s' "$C_OFF"
}

DRY_RUN=0
CONFIRMED=0
IMAGE_FILE=""

usage() {
	cat <<EOF
${C_BLD}Codie DFU — firmware kiírás${C_OFF}

Nyers bináris képet ír a robot STM32 belső flash-ébe (alt 0, ${FLASH_ADDR}).

${C_BLD}Használat:${C_OFF}
  $SCRIPT_NAME KÉP.BIN [OPCIÓK]

${C_BLD}Opciók:${C_OFF}
  --i-know-what-im-doing   Kötelező megerősítés a chipre írás előtt
  --dry-run               Kiírja a futtatandó parancssorokat, nem ír a chipre
  -h, --help              Ez a súgó

${C_BLD}Példák:${C_OFF}
  $SCRIPT_NAME firmware.bin --dry-run
  $SCRIPT_NAME firmware.bin --i-know-what-im-doing

${C_BLD}Szabályok:${C_OFF}
  * a kép mérete legfeljebb ${FLASH_SIZE} B lehet (a chip flash mérete),
  * a teljes méretnél kisebb kép csak a kezdeti ${FLASH_SIZE} B-részét írja
    felül — a maradék a flash-ben benne marad (a DFU csak az írt szektorokat
    törli), ezért részleges kép esetén a robot viselkedése kiszámíthatatlan,
  * kötelező a --i-know-what-im-doing megerősítés.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		-h|--help) usage; exit "$EX_OK" ;;
		--i-know-what-im-doing) CONFIRMED=1 ;;
		--dry-run) DRY_RUN=1 ;;
		-*) die "$EX_USAGE" "ismeretlen opció: $1 (lásd --help)" ;;
		*)
			if [[ -n "$IMAGE_FILE" ]]; then
				die "$EX_USAGE" "túl sok pozicionális argumentum: $1"
			fi
			IMAGE_FILE="$1"
			;;
	esac
	shift
done

[[ -n "$IMAGE_FILE" ]] || { usage >&2; die "$EX_USAGE" "hiányzik a firmware kép"; }
[[ -f "$CONTAINER" ]] || die "$EX_USAGE" "hiányzó segédscript: $CONTAINER"
[[ -f "$IMAGE_FILE" ]] || die "$EX_USAGE" "nincs ilyen fájl: $IMAGE_FILE"

IMAGE_FILE="$(cd -- "$(dirname -- "$IMAGE_FILE")" && pwd)/$(basename -- "$IMAGE_FILE")"
IMAGE_DIR="$(dirname -- "$IMAGE_FILE")"
IMAGE_BASE="$(basename -- "$IMAGE_FILE")"

# --- ellenőrzések ----------------------------------------------------------
image_size="$(stat -c %s "$IMAGE_FILE")"
if [[ "$image_size" -eq 0 ]]; then
	die "$EX_VERIFY" "a firmware kép üres: $IMAGE_FILE"
fi
if [[ "$image_size" -gt "$FLASH_SIZE" ]]; then
	err "a kép nagyobb a chip flash méreténél:"
	err "  kép:    ${image_size} B"
	err "  flash:  ${FLASH_SIZE} B"
	die "$EX_VERIFY" "a túlméretes képet NEM írom ki"
fi

info "Codie DFU firmware kiírás: $IMAGE_FILE"
ok "kép mérete: ${image_size} B (max ${FLASH_SIZE} B)"
if [[ "$image_size" -lt "$FLASH_SIZE" ]]; then
	warn "a kép RÉSZLEGES (${image_size} B < ${FLASH_SIZE} B): a flash fennmaradó része"
	warn "NEM törlődik, a benne lévő régi kód a roboton maradhat."
fi

image_hash="$(sha256sum "$IMAGE_FILE" | awk '{print $1}')"

if [[ $CONFIRMED -ne 1 && $DRY_RUN -eq 0 ]]; then
	banner
	err "nincs megerősítés — a chipre írás ELMARAD."
	err " Ha biztos vagy benne, futtasd újra ezt a parancsot a"
	err " --i-know-what-im-doing kapcsolóval."
	exit "$EX_ABORT"
fi

banner
printf '%skép              :%s %s\n' "$C_BLD" "$C_OFF" "$IMAGE_FILE"
printf '%ssha256           :%s %s\n' "$C_BLD" "$C_OFF" "$image_hash"
printf '%scél              :%s alt %s @ %s, %s B\n' "$C_BLD" "$C_OFF" "$FLASH_ALT" "$FLASH_ADDR" "$image_size"
printf '\n'

if [[ $DRY_RUN -eq 1 ]]; then
	warn "dry-run: a chipre nem írunk"
else
	warn "a robotnak USB-ről kell tápellátást kapnia (NEM a töltőről)!"
	warn "a 'leave' flag miatt a robot a művelet után újraindul az alkalmazásba."
fi
printf '\n'

# --- a kiírás --------------------------------------------------------------
# A chipre írás előtt ellenőrizzük, hogy a DFU eszköz valóban megvan.
if [[ $DRY_RUN -eq 0 ]]; then
	rc=0
	"$CONTAINER" --print-discovery >/dev/null 2>&1 || rc=$?
	case "$rc" in
		0) ;;
		3) die "$EX_NO_DEVICE" "nem található ${VID}:${PID} DFU eszköz — a robot DFU módban van?" ;;
		4) die "$EX_NOT_DFU" "az eszköz megvan, de nincs DFU módban (lásd docs/dfu.md)" ;;
		*) die "$rc" "eszköz-felfedezési hiba (exit $rc)" ;;
	esac
fi

# A -D a dfu-util 0.11-ben FÁJL argumentumot vár (nem stdinről olvas),
# ezért a kép könyvtárát read-only mountként adjuk át.
cmd=(dfu-util -d "${VID}:${PID}" -a "$FLASH_ALT" -s "${FLASH_ADDR}:leave" -D "/in/${IMAGE_BASE}")

info "alt ${FLASH_ALT} @ ${FLASH_ADDR}:leave ← ${IMAGE_BASE}"
if [[ $DRY_RUN -eq 1 ]]; then
	"$CONTAINER" --dry-run --mount "${IMAGE_DIR}:/in:ro" -- "${cmd[@]}"
	info "dry-run vége — semmi nem íródott a chipre"
	exit "$EX_OK"
fi

rc=0
"$CONTAINER" --mount "${IMAGE_DIR}:/in:ro" -- "${cmd[@]}" || rc=$?
if [[ $rc -ne 0 ]]; then
	err "a dfu-util írás sikertelen (exit $rc)"
	exit "$EX_CONTAINER"
fi

ok "a firmware kiírva — a robot mostantól az új képet indítja"
exit "$EX_OK"
