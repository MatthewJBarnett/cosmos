#!/usr/bin/env bash
# Download every raw source used by the data pipeline.
# Usage: tools/data/fetch_sources.sh DL_DIR
# Each source goes in its own subdirectory of DL_DIR. Downloads are treated as
# untrusted data: they are only ever read by the python scripts in tools/data
# (run with python3 -I), never executed.
set -euo pipefail
DL=${1:?usage: fetch_sources.sh DL_DIR}
UA="Mozilla/5.0 (X11; Linux x86_64) cosmos-data-fetch"

get() { # get SUBDIR URL [OUTNAME]
  local dir="$DL/$1" url="$2" out="${3:-$(basename "${2%%\?*}")}"
  mkdir -p "$dir"
  if [ -s "$dir/$out" ]; then echo "have $1/$out"; return; fi
  echo "get  $1/$out"
  curl -fsSL --retry 4 --retry-delay 5 -A "$UA" -o "$dir/$out.part" "$url"
  mv "$dir/$out.part" "$dir/$out"
}

# Stars
get hyg   https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz
get stel  https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern/index.json

# Earth (NASA Visible Earth / NOAA NCEI)
EO=https://eoimages.gsfc.nasa.gov/images/imagerecords
get bmng      $EO/73000/73751/world.topo.bathy.200407.3x21600x10800.jpg
get blackmarble $EO/144000/144897/BlackMarble_2016_3km_gray.jpg
get clouds    $EO/57000/57747/cloud_combined_8192.tif
NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
get naturalearth $NE/ne_10m_land.geojson
get naturalearth $NE/ne_10m_lakes.geojson
get etopo     https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc

# Moon (NASA SVS CGI Moon Kit, id 4720)
SVS=https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720
get moonkit $SVS/lroc_color_poles_8k.tif
get moonkit $SVS/ldem_16.tif

# Mars MOLA MEGDR 16 px/deg (PDS Geosciences Node)
MEG=https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016
get mola $MEG/megt90n000eb.img
get mola $MEG/megt90n000eb.lbl

# Solar System Scope (CC BY 4.0)
SSS=https://www.solarsystemscope.com/textures/download
for f in 8k_jupiter.jpg 8k_saturn.jpg 8k_saturn_ring_alpha.png 2k_uranus.jpg 2k_neptune.jpg \
         4k_venus_atmosphere.jpg 8k_venus_surface.jpg; do
  get sss "$SSS/$f"
done

# USGS Astrogeology planetary WMS (public domain), simple cylindrical, lon -180..180
python3 -I "$(dirname "$0")/fetch_wms.py" "$DL/wms"
echo done
