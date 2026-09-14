#!/usr/bin/env bash
# Ubuntu-only entry point for the dashboard's approved pkg.install operation.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [[ $EUID -ne 0 ]]; then
  printf '%s\n' 'Package installation requires root and an approved operator action.' >&2
  exit 1
fi
if [[ $# -ne 2 || $1 != install || ! $2 =~ ^[a-z0-9][a-z0-9+.-]*$ ]]; then
  printf '%s\n' 'Usage: scripts/pkg.sh install PACKAGE (plain Ubuntu binary package name only)' >&2
  exit 2
fi
# /etc/os-release is trusted OS configuration, never operator-provided input.
source /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 26.04 ]]; then
  printf '%s\n' 'This package helper supports Ubuntu 26.04 only.' >&2
  exit 1
fi
# Do not inherit APT_CONFIG, loader settings, proxies or arbitrary caller options.
/usr/bin/env -i PATH="$PATH" HOME=/root LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive \
  /usr/bin/apt-get update
exec /usr/bin/env -i PATH="$PATH" HOME=/root LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive \
  /usr/bin/apt-get install -y --no-install-recommends -- "$2"
