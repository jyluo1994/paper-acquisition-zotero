#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
plugin_dir="$repo_root/zotero-plugin"
dist_dir="$repo_root/dist"
xpi="$dist_dir/paper-acquisition-zotero.xpi"

if ! command -v zip >/dev/null 2>&1; then
  printf '[ERROR] zip is required to build the Zotero plugin.\n' >&2
  exit 1
fi

for required in manifest.json bootstrap.js prefs.js README.md preferences.xhtml preferences.js preferences.css; do
  if [ ! -f "$plugin_dir/$required" ]; then
    printf '[ERROR] Missing %s\n' "$plugin_dir/$required" >&2
    exit 1
  fi
done

mkdir -p "$dist_dir"
rm -f "$xpi"

(
  cd "$plugin_dir"
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  cp manifest.json bootstrap.js prefs.js README.md preferences.xhtml preferences.js preferences.css "$tmp_dir"/
  mkdir -p "$tmp_dir/defaults/preferences"
  cp prefs.js "$tmp_dir/defaults/preferences/defaults.js"
  (
    cd "$tmp_dir"
    zip -qr "$xpi" manifest.json bootstrap.js prefs.js README.md preferences.xhtml preferences.js preferences.css defaults/preferences/defaults.js
  )
)

zip -T "$xpi" >/dev/null
printf '[OK] Built %s\n' "$xpi"
