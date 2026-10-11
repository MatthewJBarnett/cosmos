#!/bin/bash
# Serve Cosmos on http://localhost:8642/ and (optionally) open it on the desktop session.
cd "$(dirname "$0")"
pgrep -f "http.server 8642" >/dev/null || setsid nohup python3 -m http.server 8642 --bind 127.0.0.1 >/dev/null 2>&1 &
if [ "$1" = "show" ]; then
  # this machine has no GPU, so use the low preset and a small render scale for the software renderer
  DISPLAY=${DISPLAY:-:20} setsid nohup google-chrome --no-first-run --no-default-browser-check --user-data-dir=/tmp/cosmos-chrome \
    --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist \
    --app="http://localhost:8642/?q=low&scale=0.35&tex=49&asteps=10&csteps=10&cube=128&galr=0.3" >/dev/null 2>&1 &
fi
echo "Cosmos is at http://localhost:8642/"
