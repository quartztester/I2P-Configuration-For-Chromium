#!/usr/bin/env bash
# Final verification gate: runs all three headless-Chromium suites plus the
# launcher self-extraction round-trip and its tamper-detection check.
# Usage: make test   (or: bash test/run-all.sh)
set -u
cd "$(dirname "$0")/.."
rc=0

run() { # name, timeout, script
  echo "== $1"
  timeout "$2" node "$3" || rc=1
}

run "mv3-extension" 170 test/mv3-extension.test.js
run "debug-panel"   170 test/debug-panel.test.js
run "icon-toggle"   170 test/icon-toggle.test.js
# live suite self-skips when no router is on 127.0.0.1:4444
run "live-i2p-e2e"  280 test/live-i2p-e2e.test.js

echo "== launcher round-trip + tamper check"
tmp=$(mktemp -d)
cp i2pchromium "$tmp/" 2>/dev/null || { echo "FAIL: i2pchromium binary missing (run make)"; rc=1; }
if [ -f "$tmp/i2pchromium" ]; then
  ( cd "$tmp" && timeout 10 ./i2pchromium --headless=new --no-sandbox --disable-gpu about:blank >/dev/null 2>&1 )
  if [ ! -f "$tmp/i2pchrome.js/rules/block_localhost.json" ]; then
    echo "FAIL: launcher did not extract the full extension tree"; rc=1
  elif ( cd "$tmp" && timeout 10 ./i2pchromium --headless=new --no-sandbox --disable-gpu about:blank 2>&1 | grep -qi "refusing" ); then
    echo "FAIL: clean tree refused to launch (hash out of date?)"; rc=1
  else
    # tamper: swap extension bytes under the launcher's nose
    printf '/* tampered */' >> "$tmp/i2pchrome.js/proxy.js"
    if ( cd "$tmp" && timeout 10 ./i2pchromium --headless=new --no-sandbox --disable-gpu about:blank 2>&1 | grep -qi "refusing" ); then
      echo "PASS: launcher round-trip + tamper refusal"
    else
      echo "FAIL: launcher did not detect tampered extension"; rc=1
    fi
  fi
fi
rm -rf "$tmp"

[ $rc -eq 0 ] && echo "ALL GATES PASSED" || echo "GATES FAILED"
exit $rc
