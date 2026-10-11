#!/bin/bash
# s.sh name "code" [w h params]
cd ~/projects/cosmos/tools && timeout ${TMO:-900} node shot.mjs "$@" 2>&1 | grep -v "^$" | tail -${TAIL:-25}
