#!/usr/bin/env bash
set -euo pipefail

status=0

say() { printf '%s\n' "$*"; }
check_cmd() {
  local name="$1" cmd="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    say "[OK] $name: $(command -v "$cmd")"
  else
    say "[MISSING] $name: command '$cmd' not found"
    status=1
  fi
}

say "== Core commands =="
check_cmd "python3" python3
check_cmd "node" node
check_cmd "npm" npm

if command -v scansci-pdf >/dev/null 2>&1; then
  say "[OK] scansci-pdf: $(command -v scansci-pdf)"
else
  say "[MISSING] scansci-pdf not found. Install: python3 -m pip install -U scansci-pdf"
  status=1
fi

say
say "== Chrome / Chromium =="
if command -v google-chrome >/dev/null 2>&1; then
  say "[OK] google-chrome"
elif [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  say "[OK] macOS Google Chrome"
elif command -v chromium >/dev/null 2>&1; then
  say "[OK] chromium"
else
  say "[MISSING] Chrome/Chromium not found"
  status=1
fi

say
say "== Browser fallback script =="
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fb_script="$script_dir/browser-fallback.js"
if [ -f "$fb_script" ]; then
  say "[OK] browser-fallback.js"
else
  say "[WARN] $fb_script not found"
fi

say
say "== Chrome DevTools Protocol =="
if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  say "[OK] CDP reachable at http://127.0.0.1:9222"
else
  say "[WARN] CDP not reachable. Start Chrome with --remote-debugging-port=9222 when browser fallback is needed."
fi

say
[ "$status" -eq 0 ] && say "Environment: ready." || say "Environment: missing dependencies above."
exit "$status"
