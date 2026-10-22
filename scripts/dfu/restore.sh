#!/usr/bin/env bash
#
# restore.sh — firmware visszaírása a Codie robot STM32 DFU bootloader-ébe.
#
# A script kizárólag egy backup.sh által létrehozott könyvtárból dolgozik:
#   1. ellenőrzi a SHA256SUMS listát (sha256sum -c),
#   2. összeveti a manifestben rögzített hash-t a számoltal,
#   3. ellenőrzi, hogy a fájl mérete megegyezik a DEVICESÉG flash méretével
#      (alt 0 len= a dfu-util -l kimenetéből; a Codie-nál 128 KB),
#   4. megköveteli a --i-know-what-im-doing megerősítő kapcsolót,
#   5. csak ezután ír a chipre.
#
# A visszaírás NEM fordítható vissza: hibás kép a robottal nem bootoló
# állapotba kerül. Ezért a belső flash (alt 0) visszaírása a fő út, az
# option bytes (alt 1) írása pedig külön, extra kapcsolóval engedélyezett
# opcionális lépés — az option byte-ok elrontása akár a chipet is
# használhatatlanná teheti.
#
# Kilépési kódok:
#   0  ok
#   2  használati hiba
#   3  DFU eszköz nem található
#   4  az eszköz megvan, de nincs DFU módban
#   6  a konténerben futó dfu-util hibásan végződött
#   7  ellenőrzési hiba (méret/hash)
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
FLASH_NAME="stm32_flash.bin"
FLASH_ADDR="0x08000000"
FLASH_ALT=0
FLASH_SIZE=131072 # 128 KB — a Codie STM32 belső flash mérete
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

banner() {
	printf '%s' "$C_RED"
	cat <<'EOF'
======================================================================
  FIGYELMEZTETÉS — A ROBOT FIRMWARE-E FELÜLÍRÓDNI FOG!
  Ez a művelet nem vonható vissza. Ha hibás képet írsz be, a robot
  nem bootol el. Előtte mindig készíts új backupot!
======================================================================
EOF
	printf '%s' "$C_OFF"
}

DRY_RUN=0
CONFIRMED=0
WITH_OPTION_BYTES=0
BACKUP_DIR=""

usage() {
	cat <<EOF
${C_BLD}Codie DFU — firmware visszaírás${C_OFF}

Visszaírja egy backup.sh-val készített könyvtár tartalmát a robot STM32
DFU bootloader-ébe (belső flash, alt 0, ${FLASH_ADDR}).

${C_BLD}Használat:${C_OFF}
  $SCRIPT_NAME BACKUP-KÖNYVTÁR [OPCIÓK]

${C_BLD}Opciók:${C_OFF}
  --i-know-what-im-doing   Kötelező megerősítés a chipre írás előtt
  --with-option-bytes      Az option bytes-ot (alt 1) is visszaírja
                           (EXTRAKOCKÁZATOS — csak akkor, ha tudod, mit csinálsz)
  --dry-run               Kiírja a futtatandó parancssorokat, nem ír a chipre
  -h, --help              Ez a súgó

${C_BLD}Példák:${C_OFF}
  $SCRIPT_NAME ~/Documents/kurwa/codie/scratchpad/firmware/backup-20261021T120000Z --dry-run
  $SCRIPT_NAME ~/Documents/kurwa/codie/scratchpad/firmware/backup-20261021T120000Z --i-know-what-im-doing

${C_BLD}Előfeltételek:${C_OFF}
  * a backup könyvtár tartalmazzon SHA256SUMS-ot és ${FLASH_NAME}-t,
  * a hash-ek egyezzenek (a script ezt ellenőrzi),
  * a fájl mérete egyezzen a chip flash méretével (${FLASH_SIZE} B),
  * a robot DFU/bootloader módban legyen,
  * a robot USB-ről tápellátást kapjon, NE a töltőről.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		-h|--help) usage; exit "$EX_OK" ;;
		--i-know-what-im-doing) CONFIRMED=1 ;;
		--with-option-bytes) WITH_OPTION_BYTES=1 ;;
		--dry-run) DRY_RUN=1 ;;
		-*) die "$EX_USAGE" "ismeretlen opció: $1 (lásd --help)" ;;
		*)
			if [[ -n "$BACKUP_DIR" ]]; then
				die "$EX_USAGE" "túl sok pozicionális argumentum: $1"
			fi
			BACKUP_DIR="$1"
			;;
	esac
	shift
done

[[ -n "$BACKUP_DIR" ]] || { usage >&2; die "$EX_USAGE" "hiányzik a backup könyvtár"; }
[[ -f "$CONTAINER" ]] || die "$EX_USAGE" "hiányzó segédscript: $CONTAINER"
[[ -d "$BACKUP_DIR" ]] || die "$EX_USAGE" "nincs ilyen könyvtár: $BACKUP_DIR"
BACKUP_DIR="$(cd -- "$BACKUP_DIR" && pwd)"

FLASH_FILE="$BACKUP_DIR/$FLASH_NAME"
OPT_FILE="$BACKUP_DIR/$OPT_NAME"

info "Codie DFU firmware visszaírás: $BACKUP_DIR"

# --- 1. a backup tartalmának ellenőrzése -----------------------------------
[[ -f "$FLASH_FILE" ]] || die "$EX_USAGE" "a backup könyvtárban nincs $FLASH_NAME"
[[ -f "$BACKUP_DIR/SHA256SUMS" ]] || die "$EX_VERIFY" "a backup könyvtárban nincs SHA256SUMS"

info "ellenőrzőösszegek ellenőrzése (sha256sum -c)"
if ! (cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS); then
	die "$EX_VERIFY" "az ellenőrzőösszegek nem egyeznek — a backup sérült, NEM írom vissza"
fi
ok "SHA256SUMS egyezik"

# A manifestben rögzített hash-nek is egyeznie kell a számolttal.
if [[ -f "$BACKUP_DIR/MANIFEST.txt" ]]; then
	info "a manifest hash-einek összevetése"
	while read -r _hash name; do
		[[ -n "$name" ]] || continue
		manifest_line="$(grep -F -- "$name" "$BACKUP_DIR/MANIFEST.txt" | head -n1 || true)"
		[[ -n "$manifest_line" ]] || continue
		manifest_hash="$(awk '{print $NF}' <<<"$manifest_line")"
		[[ "$manifest_hash" == "$_hash" ]] || die "$EX_VERIFY" "a manifest hash-e nem egyezik a fájléval: $name"
	done <"$BACKUP_DIR/SHA256SUMS"
	ok "a manifest hash-ei egyeznek"
else
	warn "nincs MANIFEST.txt a backupban — csak a SHA256SUMS ellenőrzés futott"
fi

# --- 2. a chip flash mérete (a dfu-util -l alt=0 len= mezőjéből) ----------
# Elsődlegesen a len=0x... mezőt olvassuk; tartalék a name mező
# "064*0002Kg" alakja (64 darab 2 KB-os lap = 128 KB).
device_flash_size() {
	local out len
	out="$("$CONTAINER" -- dfu-util -l -d "${VID}:${PID}" 2>/dev/null)" || return 1
	len="$(sed -n 's/.*alt=0.*len=\(0x[0-9A-Fa-f]\{1,\}\).*/\1/p' <<<"$out" | head -n1)"
	if [[ -n "$len" ]]; then
		printf '%d' "$len"
		return 0
	fi
	local count kb
	count="$(sed -n 's/.*alt=0.*name="[^"]*\([0-9]\{1,\}\)\*\([0-9]\{1,\}\)Kg".*/\1/p' <<<"$out" | head -n1)"
	kb="$(sed -n 's/.*alt=0.*name="[^"]*\([0-9]\{1,\}\)\*\([0-9]\{1,\}\)Kg".*/\2/p' <<<"$out" | head -n1)"
	if [[ -n "$count" && -n "$kb" ]]; then
		printf '%d' "$((count * kb * 1024))"
		return 0
	fi
	return 1
}

# A chipre írás előtt meg kell győződni róla, hogy a DFU eszköz valóban ott van.
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

EXPECTED_SIZE="$FLASH_SIZE"
if [[ $DRY_RUN -eq 0 ]]; then
	device_size=0
	device_size="$(device_flash_size || true)"
	if [[ -n "$device_size" && "$device_size" -gt 0 ]]; then
		EXPECTED_SIZE="$device_size"
		ok "a chip flash mérete (dfu-util -l): ${EXPECTED_SIZE} B"
	else
		warn "a chip flash méretét nem sikerült kiolvasni — a gyári értéket használom: ${EXPECTED_SIZE} B"
	fi
else
	warn "dry-run: a chip tényleges flash mérete nem olvasható ki — feltételezem: ${EXPECTED_SIZE} B"
fi

actual_size="$(stat -c %s "$FLASH_FILE")"
if [[ "$actual_size" -ne "$EXPECTED_SIZE" ]]; then
	err "méret ellenőrzés sikertelen:"
	err "  $FLASH_NAME: ${actual_size} B"
	err "  a chip flash mérete:  ${EXPECTED_SIZE} B"
	die "$EX_VERIFY" "a backup mérete nem egyezik a chip flash méretével — NEM írom vissza"
fi
ok "méret egyezik: ${actual_size} B"

if [[ $WITH_OPTION_BYTES -eq 1 ]]; then
	[[ -f "$OPT_FILE" ]] || die "$EX_USAGE" "--with-option-bytes, de nincs $OPT_NAME a backupban"
	opt_size="$(stat -c %s "$OPT_FILE")"
	[[ "$opt_size" -eq "$OPT_SIZE" ]] || die "$EX_VERIFY" "az option bytes mérete ${opt_size} B, elvárt ${OPT_SIZE} B"
	ok "option bytes méret egyezik: ${opt_size} B"
fi

# --- 3. megerősítés --------------------------------------------------------
if [[ $CONFIRMED -ne 1 && $DRY_RUN -eq 0 ]]; then
	banner
	err "nincs megerősítés — a chipre írás ELMARAD."
	err " Ha biztos vagy benne, futtasd újra ezt a parancsot a"
	err " --i-know-what-im-doing kapcsolóval."
	exit "$EX_ABORT"
fi

flash_hash="$(sha256sum "$FLASH_FILE" | awk '{print $1}')"

banner
printf '%sforrás (backup)   :%s %s\n' "$C_BLD" "$C_OFF" "$FLASH_FILE"
printf '%ssha256           :%s %s\n' "$C_BLD" "$C_OFF" "$flash_hash"
printf '%scél              :%s alt %s @ %s, %s B\n' "$C_BLD" "$C_OFF" "$FLASH_ALT" "$FLASH_ADDR" "$actual_size"
if [[ $WITH_OPTION_BYTES -eq 1 ]]; then
	printf '%scél              :%s alt %s @ %s, %s B (option bytes)\n' "$C_BLD" "$C_OFF" "$OPT_ALT" "$OPT_ADDR" "$OPT_SIZE"
fi
printf '\n'

if [[ $DRY_RUN -eq 1 ]]; then
	warn "dry-run: a chipre nem írunk"
else
	warn "a robotnak USB-ről kell tápellátást kapnia (NEM a töltőről)!"
	warn "a 'leave' flag miatt a robot a művelet után újraindul az alkalmazásba."
fi
printf '\n'

# --- 4. a visszaírás -------------------------------------------------------
if [[ $DRY_RUN -eq 0 ]]; then
	check_device
fi

run_download() {
	local alt="$1" addr="$2" name="$3" addr_spec="$4"
	local -a cmd=(dfu-util -d "${VID}:${PID}" -a "$alt" -s "$addr_spec" -D "/in/${name}")
	info "alt ${alt} @ ${addr_spec} ← ${name}"
	if [[ $DRY_RUN -eq 1 ]]; then
		"$CONTAINER" --dry-run --mount "$BACKUP_DIR:/in:ro" -- "${cmd[@]}"
		return 0
	fi
	local rc=0
	"$CONTAINER" --mount "$BACKUP_DIR:/in:ro" -- "${cmd[@]}" || rc=$?
	if [[ $rc -ne 0 ]]; then
		err "a dfu-util írás sikertelen (alt ${alt}, exit $rc)"
		exit "$EX_CONTAINER"
	fi
	ok "alt ${alt} kiírva"
}

# A belső flash a fő cél; a 'leave' a művelet végén kilépteti a DFU módból.
run_download "$FLASH_ALT" "$FLASH_ADDR" "$FLASH_NAME" "${FLASH_ADDR}:leave"
if [[ $WITH_OPTION_BYTES -eq 1 ]]; then
	run_download "$OPT_ALT" "$OPT_ADDR" "$OPT_NAME" "${OPT_ADDR}:will-reset:leave"
fi

if [[ $DRY_RUN -eq 1 ]]; then
	info "dry-run vége — semmi nem íródott a chipre"
	exit "$EX_OK"
fi

ok "a visszaírás kész — a robot mostantól az új firmware-et indítja"
exit "$EX_OK"
