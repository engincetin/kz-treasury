#!/usr/bin/env bash
# Sözleşmeyi amr-app'ten kopyalar (tek kaynak amr-app/packages/contract). Kullanım: scripts/contract-sync.sh [../amr-app]
set -euo pipefail
SRC="${1:-../amr-app}/packages/contract"
DST="$(dirname "$0")/../packages/contract"
[ -d "$SRC" ] || { echo "kaynak yok: $SRC"; exit 1; }
rm -rf "$DST" && mkdir -p "$DST" && cp -r "$SRC"/. "$DST"/ && rm -rf "$DST/node_modules"
echo "sözleşme kopyalandı: $SRC → $DST"
