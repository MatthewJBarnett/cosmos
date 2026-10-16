#!/usr/bin/env bash
# Rebuild everything in data/ from the original sources.
# Usage: tools/data/build_all.sh DL_DIR [VENV_DIR]
#   DL_DIR   where raw downloads go (about 800 MB; outside the repo)
#   VENV_DIR python venv with requirements.txt installed (created if missing)
# Python runs with -I (isolated) so nothing in the download folders can be imported.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
DL=${1:?usage: build_all.sh DL_DIR [VENV_DIR]}
VENV=${2:-$DL/../venv-cosmos-data}
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$HERE/requirements.txt"
fi
bash "$HERE/fetch_sources.sh" "$DL"
mkdir -p "$ROOT/data/planets"
python3 -I "$HERE/build_stars.py" "$DL/hyg/hyg_v44.csv.gz" "$DL/stel/index.json" "$ROOT/data"
"$VENV/bin/python" -I "$HERE/build_planets.py" "$DL" "$ROOT/data"
echo "previews: $VENV/bin/python -I $HERE/preview.py $ROOT/data /some/tmp/dir"
