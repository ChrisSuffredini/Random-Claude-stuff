#!/usr/bin/env bash
# One-shot: open a browser for HLTV, let you clear Cloudflare, probe,
# scrape everything, then commit + push data/raw so the model can use it.
#
#   ./scraper/run.sh            (from cs2-major-predictor/)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-9222}"
PROFILE="${PROFILE:-/tmp/hltv-profile}"

if [ ! -d node_modules ]; then
  echo "== npm install"
  npm install
fi

if ! curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  BROWSER=""
  for b in chromium google-chrome-stable google-chrome chromium-browser brave-browser brave \
           "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if command -v "$b" >/dev/null 2>&1 || [ -x "$b" ]; then BROWSER="$b"; break; fi
  done
  if [ -z "$BROWSER" ]; then
    echo "No Chrome/Chromium found. Install one (Arch: sudo pacman -S chromium) or start it yourself with:"
    echo "  <your-chrome> --remote-debugging-port=$PORT --user-data-dir=$PROFILE"
    exit 1
  fi
  echo "== starting $BROWSER with remote debugging on port $PORT (throwaway profile $PROFILE)"
  "$BROWSER" --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" https://www.hltv.org >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
    sleep 1
  done
fi

echo
read -r -p "In that browser window, wait for hltv.org to load (click the Cloudflare checkbox if asked), then press Enter... "

export HLTV_CDP_URL="http://127.0.0.1:$PORT"
echo "== probe"
node scraper/scrape.js --probe

echo
read -r -p "Probe done. Counts look sane? Press Enter for the full scrape (~20-30 min, Ctrl-C safe, re-run resumes)... "
node scraper/scrape.js

echo "== committing and pushing data/raw"
git add data/raw
git commit -m "HLTV data for Major model" || echo "(nothing new to commit)"
git push
echo "Done. Data is pushed."
