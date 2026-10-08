#!/usr/bin/env bash
# Additive App Hub publish: build each app at its manifest version, create the GitHub release
# <group>.<name>-<version>, register it with SaaS, verify. Never unregisters or deletes history;
# refuses a version whose release already exists with different bytes.
#
#   SAAS_BASE_URL=https://www.tangram-os.ai TANGRAM_SAAS_TOKEN=... \
#     scripts/publish-apps.sh [--dry-run] <app-dir>...
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GITHUB_RELEASE_REPO="${GITHUB_RELEASE_REPO:-tangram-data/tangram-os-doc}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && { DRY_RUN=true; shift; }
[[ $# -gt 0 ]] || { echo "usage: $0 [--dry-run] <app-dir>..." >&2; exit 2; }
if [[ "$DRY_RUN" != true ]]; then
  : "${SAAS_BASE_URL:?set SAAS_BASE_URL}" "${TANGRAM_SAAS_TOKEN:?set TANGRAM_SAAS_TOKEN}"
fi
SAAS_API="${SAAS_BASE_URL:-}/api/tangram-app-hub/v1"
WORK_DIR="$(mktemp -d -t tangram-app-publish.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { printf '[publish] %s\n' "$*"; }
die() { printf '[publish] ERROR: %s\n' "$*" >&2; exit 1; }
field() { sed -n -E "s/^$1[[:space:]]*=[[:space:]]*\"([^\"]+)\".*/\1/p" "$2" | head -1; }

# Build everything first so a broken package stops the run before anything is published.
plan=()
for dir in "$@"; do
  root="$REPO_ROOT/${dir%/}"
  manifest="$root/manifests/app.pkl"
  [[ -f "$manifest" ]] || die "$dir: no manifests/app.pkl"
  group="$(field group "$manifest")"; name="$(field name "$manifest")"; version="$(field version "$manifest")"
  [[ -n "$group" && -n "$name" && -n "$version" ]] || die "$dir: cannot read group/name/version"
  (cd "$root/manifests" && pkl project resolve >/dev/null && pkl eval app.pkl >/dev/null)
  archive="$WORK_DIR/${group}.${name}/${name}.tar.gz"
  mkdir -p "$(dirname "$archive")"
  python3 "$SCRIPT_DIR/build-app-archive.py" "$root" "$archive"
  tar -tzf "$archive" | grep -qE '^(\./)?manifests/app\.pkl$' || die "$dir: archive lacks manifests/app.pkl"
  tag="${group}.${name}-${version}"
  sum="$(shasum -a 256 "$archive" | awk '{print $1}')"
  log "built $tag ($sum)"
  plan+=("$group|$name|$version|$tag|$archive|$sum")
done
[[ "$DRY_RUN" == true ]] && { log "dry run: ${#plan[@]} apps built, nothing published"; exit 0; }

for entry in "${plan[@]}"; do
  IFS='|' read -r group name version tag archive sum <<<"$entry"
  if gh release view "$tag" --repo "$GITHUB_RELEASE_REPO" >/dev/null 2>&1; then
    existing="$(gh release view "$tag" --repo "$GITHUB_RELEASE_REPO" --json assets \
      --jq ".assets[] | select(.name==\"${name}.tar.gz\") | .digest" 2>/dev/null || true)"
    [[ "$existing" == "sha256:$sum" ]] || die "$tag already exists with different content; bump the version"
    log "$tag release already present with identical bytes"
  else
    gh release create "$tag" "$archive" --repo "$GITHUB_RELEASE_REPO" \
      --title "$name $version" --notes "Release $version using tangram-app-manifest@1.0.0." >/dev/null
    log "$tag release created"
  fi
  url="https://github.com/${GITHUB_RELEASE_REPO}/releases/download/${tag}/${name}.tar.gz"
  for _ in $(seq 1 60); do
    curl -sfL -o "$WORK_DIR/check.tgz" "$url" && [[ "$(shasum -a 256 "$WORK_DIR/check.tgz" | awk '{print $1}')" == "$sum" ]] && break
    sleep 10
  done
  [[ "$(shasum -a 256 "$WORK_DIR/check.tgz" 2>/dev/null | awk '{print $1}')" == "$sum" ]] || die "$tag asset not visible at $url"
  status="$(curl -sS -o "$WORK_DIR/reg.json" -w '%{http_code}' -H "Authorization: Bearer $TANGRAM_SAAS_TOKEN" -X POST \
    -F provider=GitRelease -F "gitRepo=$GITHUB_RELEASE_REPO" -F "releaseTag=$tag" -F "assetName=${name}.tar.gz" \
    "$SAAS_API/applications")"
  [[ "$status" == 2?? ]] || die "$tag registration HTTP $status: $(cat "$WORK_DIR/reg.json")"
  curl -sSf -H "Authorization: Bearer $TANGRAM_SAAS_TOKEN" \
    "$SAAS_API/namespaces/$group/applications/$name/versions/$version" >/dev/null || die "$tag not listed after registration"
  log "$tag published and verified"
done
log "done: ${#plan[@]} apps"
