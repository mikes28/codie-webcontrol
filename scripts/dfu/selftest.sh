#!/usr/bin/env bash
#
# selftest.sh — a DFU eszköz-felfedezés öntesztje fabricált sysfs fán.
#
# Nem nyúl semmilyen valódi hardverhez: a felfedezés a DFU_SYSFS_ROOT és a
# DFU_USB_ROOT env-variánsokon keresztül egy ideiglenes, hamis sysfs-fára
# irányítható. A teszt a következő eseteket fedi:
#
#   1. a DFU eszköz megtalálható, a --device= argumentum helyes,
#   2. nincs eszköz a fán -> tiszta hiba (exit 3),
#   3. az eszköz megvan, de nem DFU módban -> tiszta hiba (exit 4),
#   4. a sysfs bejegyzés megvan, de az eszköz csomópont hiányzik -> exit 3,
#   5. másik USB eszközt (0483:df12) nem szabad megtalálni,
#   6. a --dry-run csak kiírja a parancssort, nem indít konténert.
#
# Kilépési kód: 0 = minden teszt sikeres, 1 = valamelyik elbukott.

set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="$SCRIPT_DIR/dfu-container.sh"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
	C_RED=$'\033[1;31m'; C_GRN=$'\033[1;32m'; C_YEL=$'\033[1;33m'
	C_BLD=$'\033[1m'; C_OFF=$'\033[0m'
else
	C_RED=''; C_GRN=''; C_YEL=''; C_BLD=''; C_OFF=''
fi

PASS=0
FAIL=0

pass() { printf '%s[PASS]%s %s\n' "$C_GRN" "$C_OFF" "$*"; PASS=$((PASS + 1)); }
fail() { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SYSFS="$TMP/sysfs"
USB="$TMP/usb"

# --- a hamis sysfs fa felépítése ------------------------------------------
make_device() {
	# make_device <sysfs-root> <usb-root> <név> <vid> <pid> <bus> <devnum> <iface-class> <iface-subclass>
	local root="$1" usbroot="$2" name="$3" vid="$4" pid="$5" bus="$6" devnum="$7" cls="$8" sub="$9"
	local dir="$root/$name"
	mkdir -p "$dir" "$root/$name:1.0" "$usbroot/$bus"
	printf '%s\n' "$vid" >"$dir/idVendor"
	printf '%s\n' "$pid" >"$dir/idProduct"
	printf '%s\n' "$bus" >"$dir/busnum"
	printf '%s\n' "$devnum" >"$dir/devnum"
	cat >"$dir/uevent" <<EOF
MAJOR=189
MINOR=7
DEVNAME=bus/usb/$bus/$devnum
DEVTYPE=usb_device
DRIVER=usb
PRODUCT=$vid/$pid/2200
TYPE=0/0/0
BUSNUM=$bus
DEVNUM=$devnum
EOF
	printf '%s\n' "$cls" >"$root/$name:1.0/bInterfaceClass"
	printf '%s\n' "$sub" >"$root/$name:1.0/bInterfaceSubClass"
	# a karakteres eszközt egy üres fájl helyettesíti (a létezése kell)
	: >"$usbroot/$bus/$devnum"
}

# 1. normál eset
mkdir -p "$SYSFS" "$USB"
make_device "$SYSFS" "$USB" "1-2" "0483" "df11" "001" "007" "fe" "01"
# 5. decoy: másik STM-eszköz, más PID-del
make_device "$SYSFS" "$USB" "1-5" "0483" "df12" "001" "009" "fe" "01"

out="$(DFU_SYSFS_ROOT="$SYSFS" DFU_USB_ROOT="$USB" bash "$CONTAINER" --print-device-args 2>&1)" && rc=0 || rc=$?
expected="--device=$USB/001/007"
if [[ $rc -eq 0 && "$out" == "$expected" ]]; then
	pass "1. a DFU eszköz megtalálható: $out"
else
	fail "1. a DFU eszköz felfedezése hibás (rc=$rc, kimenet: $out, várt: $expected)"
fi

# 1b. a bus/devnum a uevent-ből, 3 karakteresen
out="$(DFU_SYSFS_ROOT="$SYSFS" DFU_USB_ROOT="$USB" bash "$CONTAINER" --print-device-path 2>&1)" && rc=0 || rc=$?
if [[ $rc -eq 0 && "$out" == "$USB/001/007" ]]; then
	pass "1b. az eszköz útvonala: $out"
else
	fail "1b. az eszköz útvonala hibás (rc=$rc, kimenet: $out)"
fi

# 2. nincs eszköz
EMPTY="$TMP/empty-sysfs"
mkdir -p "$EMPTY"
out="$(DFU_SYSFS_ROOT="$EMPTY" DFU_USB_ROOT="$USB" bash "$CONTAINER" --print-device-args 2>&1)" && rc=0 || rc=$?
if [[ $rc -eq 3 ]]; then
	pass "2. eszköz nélkül tiszta hiba (exit 3): $(head -n1 <<<"$out")"
else
	fail "2. eszköz nélkül exit 3 kellett volna, kapott: $rc ($out)"
fi

# 3. eszköz megvan, de nem DFU módban (alkalmazás mód: interface osztály 0x02)
NODFU="$TMP/nodfu-sysfs"
NOUSB="$TMP/nodfu-usb"
mkdir -p "$NODFU" "$NOUSB"
make_device "$NODFU" "$NOUSB" "1-3" "0483" "df11" "002" "004" "02" "00"
out="$(DFU_SYSFS_ROOT="$NODFU" DFU_USB_ROOT="$NOUSB" bash "$CONTAINER" --print-device-args 2>&1)" && rc=0 || rc=$?
if [[ $rc -eq 4 ]]; then
	pass "3. DFU mód nélkül tiszta hiba (exit 4): $(head -n1 <<<"$out")"
else
	fail "3. DFU mód nélkül exit 4 kellett volna, kapott: $rc ($out)"
fi

# 4. a sysfs bejegyzés megvan, de az eszköz csomópont hiányzik
NODev="$TMP/nodev-sysfs"
NODevUSB="$TMP/nodev-usb"
mkdir -p "$NODev" "$NODevUSB"
make_device "$NODev" "$NODevUSB" "1-4" "0483" "df11" "001" "011" "fe" "01"
rm -f "$NODevUSB/001/011"
out="$(DFU_SYSFS_ROOT="$NODev" DFU_USB_ROOT="$NODevUSB" bash "$CONTAINER" --print-device-args 2>&1)" && rc=0 || rc=$?
if [[ $rc -eq 3 ]]; then
	pass "4. hiányzó eszköz csomópont: tiszta hiba (exit 3)"
else
	fail "4. hiányzó eszköz csomópontnál exit 3 kellett volna, kapott: $rc ($out)"
fi

# 6. a --dry-run nem indít konténert, csak kiírja a parancssort
out="$(DFU_SYSFS_ROOT="$SYSFS" DFU_USB_ROOT="$USB" bash "$CONTAINER" --dry-run -- dfu-util -l -d 0483:df11 2>&1)" && rc=0 || rc=$?
if [[ $rc -eq 0 && "$out" == *"docker run"* && "$out" == *"--device=$USB/001/007"* && "$out" == *"dfu-util -l -d 0483:df11"* ]]; then
	pass "6. a dry-run a pontos konténer parancssort írja ki"
else
	fail "6. a dry-run kimenete hibás (rc=$rc): $out"
fi

printf '\n%s%d teszt sikeres, %d elbukott%s\n' "$C_BLD" "$PASS" "$FAIL" "$C_OFF"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
