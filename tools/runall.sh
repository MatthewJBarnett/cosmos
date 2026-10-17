#!/bin/bash
# Run the whole test suite in sequence (takes a long time under SwiftShader). Logs into $OUT (default /tmp/cosmos-tests).
OUT=${OUT:-/tmp/cosmos-tests}; mkdir -p "$OUT"; cd "$(dirname "$0")/.."
run() { local n=$1; shift; echo "== $n $(date +%H:%M)"; timeout ${TMO:-3600} "$@" > "$OUT/$n.log" 2>&1; echo "   exit $? : $(tail -1 "$OUT/$n.log" | cut -c1-160)"; }
run physics node tools/physicstest.mjs
run shaders node tools/shadercheck.mjs
run glcheck node tools/glcheck.mjs
run lapse node tools/lapsetest.mjs
run events node tools/eventtest.mjs
run tour node tools/tourtest.mjs
for s in 7 11 23; do run monkey$s node tools/monkey.mjs 50 $s; done
echo "== done $(date +%H:%M)"
