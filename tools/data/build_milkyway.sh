#!/bin/bash
# Build data/milkyway.jpg from the ESO Milky Way panorama (eso0932a, CC BY 4.0, ESO/S. Brunier).
# Point stars are removed with a median filter so they are not counted twice against the star catalogue.
set -e
SRC=${1:?usage: build_milkyway.sh path/to/eso0932a.jpg}
OUT=$(dirname "$0")/../../data/milkyway.jpg
convert "$SRC" -resize 4096x2048 -statistic Median 7x7 -statistic Median 5x5 -blur 0x1.2 -quality 90 "$OUT"
identify "$OUT"
