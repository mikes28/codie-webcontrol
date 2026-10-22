#!/usr/bin/env bash
#
# dfu-container.sh — dfu-util futtatása Dockerben, hostoldali root jog nélkül.
#
# A Codie robot STM32 MCU-jának USB DFU bootloader-e a 0483:df11
# vendor:product páron látszik. A hoston (Arch Linux) nincs telepítve
# dfu-util, és a sudo jelszót kér, ezért minden dfu-util hívás egy helyi
# Docker képben fut, explicit --device= engedéllyel.
#
# Fontos: a sima `-v /dev/bus/usb:/dev/bus/usb` önmagában NEM elég — a Docker
# alapértelmezett eszköz-cgroupja letiltja az usbfs karaktereszközöket, ezért
# LIBUSB_ERROR_IO hibát ad. Az explicit `--device=/dev/bus/usb/BBB/DDD` grant
# oldja fel. A bus/devnum párt a sysfs-ből discoverszjük, sosem hard-code-olt
# értékből (a devnum újrapluggoláskor megváltozik).
#
# Kilépési kódok:
#   0  ok
#   2  használati hiba
#   3  DFU eszköz nem található
#   4  az eszköz megvan, de nincs DFU módban
#   5  Docker kép hiba (build / docker hiányzik)
#   6  a konténerben futó parancs hibásan végződött

set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

EX_OK=0
EX_USAGE=2
EX_NO_DEVICE=3
EX_NOT_DFU=4
EX_IMAGE=5
EX_CONTAINER=6

# --- színek (NO_COLOR és nem-TTY esetén kikapcsolva) -----------------------
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
# A dry-run módban a felfedezési hibák nem érdekesek (nincs eszköz-hozzáférés),
# ezért ezeket elnyeljük, és csak egy figyelmeztetést hagyunk a helyükön.
QUIET=0
derr() { if [[ $QUIET -eq 0 ]]; then err "$@"; fi; }
die()  { local code="$1"; shift; err "$*"; exit "$code"; }

# --- konfiguráció (felülírható env-vel, a selftest ezt használja) ---------
IMAGE="${DFU_IMAGE:-dfu}"
SYSFS_ROOT="${DFU_SYSFS_ROOT:-/sys/bus/usb/devices}"
USB_ROOT="${DFU_USB_ROOT:-/dev/bus/usb}"
DFU_VENDOR="${DFU_VENDOR:-0483}"
DFU_PRODUCT="${DFU_PRODUCT:-df11}"

DRY_RUN=0
PRINT_DEVICE_ARGS=0
PRINT_DEVICE_PATH=0
PRINT_DISCOVERY=0
NO_BUILD=0
VERBOSE=0
MOUNTS=()
CHOWNS=()
CONTAINER_ENVS=()
CMD=()

usage() {
	cat <<EOF
${C_BLD}Codie DFU — Docker konténer wrapper${C_OFF}

Az STM32 DFU bootloader eszközhöz (${DFU_VENDOR}:${DFU_PRODUCT}) dfu-util/lsusb
parancs futtatása egy helyi Docker képben, hostoldali root jog nélkül.

${C_BLD}Használat:${C_OFF}
  $SCRIPT_NAME [OPCIÓK] -- PARANCS [ARG...]
  $SCRIPT_NAME --print-device-args
  $SCRIPT_NAME --print-device-path
  $SCRIPT_NAME --print-discovery

${C_BLD}Opciók:${C_OFF}
  --print-device-args   Kiírja a --device=... grant argumentumot (gépileg feldolgozható)
  --print-device-path   Kiírja a /dev/bus/usb/BBB/DDD eszköz útvonalát
  --print-discovery     Kiírja a felfedezés részleteit (sysfs, DFU mód ellenőrzés)
  --dry-run             Kiírja a futtatandó docker parancssort, nem indítja el
  --image KÉP           Docker kép neve (alap: ${IMAGE})
  --no-build            Nem buildeli a képet, ha hiányzik (hiba helyett kilép)
  --mount HOST:KONT     Extra bind mount (ismételhető), pl. --mount /host/dir:/in:ro
  --chown HOST          A megadott host könyvtár tartalmát a futó userre chownolja
                        a parancs után (a konténer rootként ír, ez kell a
                        hostoldali fájlok használhatóságához)
  --env KÉ=V           Extra környezeti változó a konténerbe
  -v, --verbose        Részletes diagnosztika
  -h, --help           Ez a súgó

${C_BLD}Példák:${C_OFF}
  $SCRIPT_NAME -- dfu-util -l -d ${DFU_VENDOR}:${DFU_PRODUCT}
  $SCRIPT_NAME --mount "\$PWD:/in:ro" -- dfu-util -d ${DFU_VENDOR}:${DFU_PRODUCT} -a 0 -s 0x08000000:leave -D /in/fw.bin
  $SCRIPT_NAME --print-device-args

${C_BLD}Megjegyzés:${C_OFF}
  A sysfs gyökér felülírható a DFU_SYSFS_ROOT env-variánssal, a /dev/bus/usb
  gyökér pedig a DFU_USB_ROOT env-variánssal (selftest/teszt céljára).
EOF
}

# --- argumentumok ----------------------------------------------------------
while [[ $# -gt 0 ]]; do
	case "$1" in
		-h|--help) usage; exit "$EX_OK" ;;
		--print-device-args) PRINT_DEVICE_ARGS=1 ;;
		--print-device-path) PRINT_DEVICE_PATH=1 ;;
		--print-discovery) PRINT_DISCOVERY=1 ;;
		--dry-run) DRY_RUN=1 ;;
		--image) [[ $# -ge 2 ]] || die "$EX_USAGE" "--image után képneve kell"; IMAGE="$2"; shift ;;
		--no-build) NO_BUILD=1 ;;
		--mount) [[ $# -ge 2 ]] || die "$EX_USAGE" "--mount után HOST:KONT kell"; MOUNTS+=("$2"); shift ;;
		--chown) [[ $# -ge 2 ]] || die "$EX_USAGE" "--chown után útvonal kell"; CHOWNS+=("$2"); shift ;;
		--env) [[ $# -ge 2 ]] || die "$EX_USAGE" "--env után KÉ=V kell"; CONTAINER_ENVS+=("$2"); shift ;;
		-v|--verbose) VERBOSE=1 ;;
		--) shift; CMD=("$@"); break ;;
		-*) die "$EX_USAGE" "ismeretlen opció: $1 (lásd --help)" ;;
		*) CMD=("$@"); break ;;
	esac
	shift
done

# --- eszköz-felfedezés -----------------------------------------------------
DFU_BUS=""
DFU_DEVNUM=""
DFU_DEVPATH=""
DFU_SYSFS_DIR=""
DFU_IS_DFU=0

# 3 karakteres null-kitöltés (a bus/devnum decimális, nem oktális!)
pad3() {
	local s="$1"
	while [[ ${#s} -lt 3 ]]; do
		s="0$s"
	done
	printf '%s' "$s"
}

# A sysfs-ben a device és az interface bejegyzések is laknak; csak az
# USB device szintű bejegyzésnek van busnum/devnum és idVendor/idProduct.
discover_device() {
	local dir vid pid bus devnum
	local -a found=()

	[[ -d "$SYSFS_ROOT" ]] || {
		derr "a sysfs USB gyökér nem létezik: $SYSFS_ROOT"
		return "$EX_NO_DEVICE"
	}

	for dir in "$SYSFS_ROOT"/*/; do
		[[ -f "$dir/idVendor" && -f "$dir/idProduct" ]] || continue
		[[ -f "$dir/busnum" && -f "$dir/devnum" ]] || continue
		vid="$(<"$dir/idVendor")"
		pid="$(<"$dir/idProduct")"
		[[ "$vid" == "$DFU_VENDOR" && "$pid" == "$DFU_PRODUCT" ]] || continue
		bus="$(<"$dir/busnum")"
		devnum="$(<"$dir/devnum")"
		found+=("${bus}:${devnum}:${dir%/}")
	done

	if [[ ${#found[@]} -eq 0 ]]; then
		derr "nem található ${DFU_VENDOR}:${DFU_PRODUCT} USB eszköz a(z) $SYSFS_ROOT alatt"
		derr " Ellenőrizd: a robot DFU/bootloader módban van-e (a 'Codie' felirat helyett"
		derr " 'STM32  BOOTLOADER' látszik-e a lsusb kimenetében)?"
		return "$EX_NO_DEVICE"
	fi

	if [[ ${#found[@]} -gt 1 ]]; then
		derr "több ${DFU_VENDOR}:${DFU_PRODUCT} eszköz található — nem tudom, melyiket használjam:"
		for dir in "${found[@]}"; do derr "  $dir"; done
		return "$EX_NO_DEVICE"
	fi

	IFS=':' read -r DFU_BUS DFU_DEVNUM DFU_SYSFS_DIR <<<"${found[0]}"

	# A sysfs busnum/devnum fájlok nem null-kitöltöttek ("1", "7"), míg az
	# uevent és a /dev/bus/usb/BBB/DDD elnevezés 3 karakteres ("001", "007").
	# Az uevent az authority: abból olvasunk, a fájlok csak tartalék.
	local uevent="${DFU_SYSFS_DIR}/uevent" ev_bus ev_dev
	if [[ -f "$uevent" ]]; then
		ev_bus="$(sed -n 's/^BUSNUM=//p' "$uevent" 2>/dev/null | head -n1)"
		ev_dev="$(sed -n 's/^DEVNUM=//p' "$uevent" 2>/dev/null | head -n1)"
		if [[ -n "$ev_bus" && -n "$ev_dev" ]]; then
			DFU_BUS="$ev_bus"
			DFU_DEVNUM="$ev_dev"
		fi
	fi
	DFU_BUS="$(pad3 "$DFU_BUS")"
	DFU_DEVNUM="$(pad3 "$DFU_DEVNUM")"
	DFU_DEVPATH="${USB_ROOT}/${DFU_BUS}/${DFU_DEVNUM}"

	if [[ ! -e "$DFU_DEVPATH" ]]; then
		derr "a sysfs bejegyzés megvan (${DFU_SYSFS_DIR}), de az eszköz csomópont hiányzik: $DFU_DEVPATH"
		derr " Az eszközt most huzták ki? Próbáld újra (a devnum ilyenkor megváltozik)."
		return "$EX_NO_DEVICE"
	fi

	# DFU mód ellenőrzése: a DFU interface osztálya 0xFE (application specific),
	# alosztálya 0x01 (DFU). Alkalmazás módban a robot nem ezt mutatja.
	DFU_IS_DFU=0
	local iface cls sub
	for iface in "${DFU_SYSFS_DIR}":1.*; do
		[[ -d "$iface" ]] || continue
		cls="$(cat "$iface/bInterfaceClass" 2>/dev/null || true)"
		sub="$(cat "$iface/bInterfaceSubClass" 2>/dev/null || true)"
		if [[ "$cls" == "fe" && "$sub" == "01" ]]; then
			DFU_IS_DFU=1
			break
		fi
	done

	if [[ $DFU_IS_DFU -ne 1 ]]; then
		derr "a(z) ${DFU_VENDOR}:${DFU_PRODUCT} eszköz megvan, de NINCS DFU módban."
		derr " A robotot DFU/bootloader módba kell kapcsolni (lásd docs/dfu.md)."
		return "$EX_NOT_DFU"
	fi

	return "$EX_OK"
}

print_discovery() {
	printf 'sysfs gyökér      : %s\n' "$SYSFS_ROOT"
	printf 'eszköz            : %s:%s\n' "$DFU_VENDOR" "$DFU_PRODUCT"
	printf 'sysfs bejegyzés   : %s\n' "$DFU_SYSFS_DIR"
	printf 'bus / devnum      : %s / %s\n' "$DFU_BUS" "$DFU_DEVNUM"
	printf 'eszköz csomópont  : %s\n' "$DFU_DEVPATH"
	printf 'termék            : %s\n' "$(cat "${DFU_SYSFS_DIR}/product" 2>/dev/null || echo '?')"
	printf 'DFU mód           : %s\n' "$([[ $DFU_IS_DFU -eq 1 ]] && echo 'igen' || echo 'NEM')"
}

# --- Docker kép ------------------------------------------------------------
image_exists() {
	docker image inspect "$IMAGE" >/dev/null 2>&1
}

build_image() {
	local ctx
	ctx="$(mktemp -d)"
	cat >"$ctx/Dockerfile" <<'DOCKERFILE'
FROM node:22-bookworm-slim
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends dfu-util usbutils python3 xxd \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
DOCKERFILE
	info "Docker kép buildelése: $IMAGE (FROM node:22-bookworm-slim)"
	if ! docker build -t "$IMAGE" "$ctx"; then
		rm -rf "$ctx"
		die "$EX_IMAGE" "a '$IMAGE' Docker kép buildelése sikertelen"
	fi
	rm -rf "$ctx"
	ok "Docker kép kész: $IMAGE"
}

ensure_image() {
	command -v docker >/dev/null 2>&1 || die "$EX_IMAGE" "a docker nem található a PATH-ban"
	if image_exists; then
		[[ $VERBOSE -eq 1 ]] && ok "Docker kép megvan: $IMAGE"
		return 0
	fi
	if [[ $NO_BUILD -eq 1 ]]; then
		die "$EX_IMAGE" "a '$IMAGE' Docker kép hiányzik és a --no-build tiltja a buildelést"
	fi
	build_image
}

# --- konténer futtatás -----------------------------------------------------
DOCKER_ARGS=()

build_docker_args() {
	DOCKER_ARGS=(docker run --rm)
	if [[ -n "$DFU_DEVPATH" ]]; then
		DOCKER_ARGS+=("--device=$DFU_DEVPATH")
	fi
	DOCKER_ARGS+=(-v "${USB_ROOT}:${USB_ROOT}")
	local m
	for m in "${MOUNTS[@]+"${MOUNTS[@]}"}"; do
		DOCKER_ARGS+=(-v "$m")
	done
	local e
	for e in "${CONTAINER_ENVS[@]+"${CONTAINER_ENVS[@]}"}"; do
		DOCKER_ARGS+=(-e "$e")
	done
	DOCKER_ARGS+=("$IMAGE")
}

print_cmd() {
	printf '%s[dry-run]%s ' "$C_DIM" "$C_OFF"
	printf '%q ' "$@"
	printf '\n'
}

chown_mounts() {
	local path
	if [[ ${#CHOWNS[@]} -eq 0 ]]; then
		return 0
	fi
	for path in "${CHOWNS[@]}"; do
		[[ -e "$path" ]] || continue
		[[ $DRY_RUN -eq 1 ]] && { print_cmd docker run --rm -v "$path:/chown" "$IMAGE" chown -R "$(id -u):$(id -g)" /chown; continue; }
		docker run --rm -v "$path:/chown" "$IMAGE" chown -R "$(id -u):$(id -g)" /chown >/dev/null
	done
}

main() {
	# A nyomtatás módok nem igényelnek eszközt (a --print-device-args/-path
	# viszont igen — ezek a felfedezés kimenete).
	local discover_rc=0
	if [[ $DRY_RUN -eq 1 ]]; then
		QUIET=1
	fi
	discover_device || discover_rc=$?

	if [[ $PRINT_DEVICE_ARGS -eq 1 ]]; then
		if [[ $discover_rc -ne 0 ]]; then exit "$discover_rc"; fi
		printf -- '--device=%s\n' "$DFU_DEVPATH"
		exit "$EX_OK"
	fi

	if [[ $PRINT_DEVICE_PATH -eq 1 ]]; then
		if [[ $discover_rc -ne 0 ]]; then exit "$discover_rc"; fi
		printf '%s\n' "$DFU_DEVPATH"
		exit "$EX_OK"
	fi

	if [[ $PRINT_DISCOVERY -eq 1 ]]; then
		if [[ $discover_rc -ne 0 ]]; then exit "$discover_rc"; fi
		print_discovery
		exit "$EX_OK"
	fi

	if [[ ${#CMD[@]} -eq 0 ]]; then
		err "nincs megadott parancs"
		usage >&2
		exit "$EX_USAGE"
	fi

	if [[ $discover_rc -ne 0 ]]; then
		if [[ $DRY_RUN -eq 1 ]]; then
			warn "a DFU eszköz nem található — a dry-run placeholder útvonalat használ"
			DFU_DEVPATH="${USB_ROOT}/BBB/DDD"
			DFU_BUS="BBB"; DFU_DEVNUM="DDD"
		else
			exit "$discover_rc"
		fi
	fi

	if [[ $DRY_RUN -eq 1 ]]; then
		build_docker_args
		print_cmd "${DOCKER_ARGS[@]}" "${CMD[@]}"
		chown_mounts
		exit "$EX_OK"
	fi

	ensure_image
	build_docker_args
	if [[ $VERBOSE -eq 1 ]]; then
		printf '%s[parancs]%s ' "$C_DIM" "$C_OFF"
		printf '%q ' "${DOCKER_ARGS[@]}" "${CMD[@]}"
		printf '\n'
	fi
	local rc=0
	docker "${DOCKER_ARGS[@]}" "${CMD[@]}" || rc=$?
	if [[ $rc -ne 0 ]]; then
		err "a konténerben futó parancs hibásan végződött (docker exit: $rc)"
		exit "$EX_CONTAINER"
	fi
	chown_mounts
	exit "$EX_OK"
}

main "$@"
