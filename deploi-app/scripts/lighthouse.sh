#!/usr/bin/env bash
# Lighthouse for authenticated app pages. Usage: scripts/lighthouse.sh <base> <email> <path> <out-prefix>
# Requires `lighthouse` on PATH (npx lighthouse) and a Chromium at CHROME_PATH.
set -euo pipefail
BASE=$1; EMAIL=$2; PATH_=$3; OUT=$4
COOKIE=$(npx tsx scripts/dev-cookie.ts "$EMAIL")
CHROME=${CHROME_PATH:-$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)}
for preset in mobile desktop; do
  extra=""; [ "$preset" = desktop ] && extra="--preset=desktop"
  CHROME_PATH="$CHROME" npx lighthouse "$BASE$PATH_" $extra --only-categories=performance,accessibility \
    --extra-headers "{\"Cookie\":\"$COOKIE\"}" --chrome-flags="--headless=new --no-sandbox --disable-gpu" \
    --output=json --output-path="$OUT-$preset.json" --quiet >/dev/null
  node -e "const r=require('./$OUT-$preset.json');console.log('$PATH_ $preset perf='+Math.round(r.categories.performance.score*100)+' a11y='+Math.round(r.categories.accessibility.score*100))"
done
