#!/usr/bin/env bash
# Copy shared UI kits (design/kits) into each connector's manifests/ui/shared/.
set -euo pipefail
cd "$(dirname "$0")/.."
sync() { local kit=$1; shift; for app in "$@"; do mkdir -p "$app/manifests/ui/shared"; cp "design/kits/$kit" "$app/manifests/ui/shared/$kit"; done; }
GOOGLE=(google/gmail google/calendar google/drive google/docs)
MICROSOFT=(microsoft/outlook microsoft/onedrive)
NOTION=(notion)
sync google.css "${GOOGLE[@]}"
sync microsoft.css "${MICROSOFT[@]}"
sync notion.css "${NOTION[@]}"
sync tangram-buttons.css "${GOOGLE[@]}" "${MICROSOFT[@]}" "${NOTION[@]}"
echo "synced ui kits"
