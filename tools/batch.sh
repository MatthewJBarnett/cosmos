#!/bin/bash
# batch.sh: run a list of scenes sequentially. Each line of stdin: name|code
H="c.rcfg.orbits=false; c.ui.root.classList.add('hide'); c.ui.hidden=true;"
P="${P:-tex=97&cube=256&scale=1&galr=0.2&cloudres=384}"
while IFS='|' read -r name code; do
  [ -z "$name" ] && continue
  TMO=${TMO:-300} ~/projects/cosmos/tools/s.sh "$name" "$H $code" ${W:-800} ${HH:-450} "$P" | head -3 | cut -c1-300
done
