#!/usr/bin/env python3
"""Fetch global simple-cylindrical mosaics from the USGS Astrogeology planetary WMS.

Usage: python3 -I fetch_wms.py OUT_DIR

Every request uses BBOX=-180,-90,180,90 in the body's own planetocentric,
positive-east coordinate system, so the returned image already has longitude
-180 at the left edge, 0 in the centre and +180 at the right edge, north up.
Output: OUT_DIR/<body>__<layer>.png (lossless PNG straight from the server).
"""
import os, sys, time, urllib.request, urllib.parse

BASE = 'https://planetarymaps.usgs.gov/cgi-bin/mapserv'

# (body, mapfile, layer, width)
REQUESTS = [
    ('mars', 'mars/mars_simp_cyl.map', 'MDIM21_color', 4096),
    ('mercury', 'mercury/mercury_simp_cyl.map', 'MESSENGER', 2048),
    ('mercury', 'mercury/mercury_simp_cyl.map', 'MESSENGER_Color', 2048),
    ('venus', 'venus/venus_simp_cyl.map', 'MAGELLAN_color', 2048),
    ('venus', 'venus/venus_simp_cyl.map', 'MAGELLAN', 2048),
    ('io', 'jupiter/io_simp_cyl.map', 'SSI_VGR_color', 2048),
    ('europa', 'jupiter/europa_simp_cyl.map', 'GALILEO_VOYAGER', 2048),
    ('ganymede', 'jupiter/ganymede_simp_cyl.map', 'GALILEO_VOYAGER', 2048),
    ('callisto', 'jupiter/callisto_simp_cyl.map', 'GALILEO_VOYAGER', 2048),
    ('titan', 'saturn/titan_simp_cyl.map', 'CASSINI', 2048),
    ('titan', 'saturn/titan_simp_cyl.map', 'Titan_ISS_Controlled_Mosaic', 2048),
    ('enceladus', 'saturn/enceladus_simp_cyl.map', 'CASSINI', 2048),
    ('pluto', 'pluto/pluto_simp_cyl.map', 'NEWHORIZONS_PLUTO_MOSAIC', 2048),
    ('pluto', 'pluto/pluto_simp_cyl.map', 'NEWHORIZONS_PLUTO_ClrSHADE', 2048),
    ('charon', 'pluto/charon_simp_cyl.map', 'NEWHORIZONS_CHARON_MOSAIC', 2048),
    ('charon', 'pluto/charon_simp_cyl.map', 'NEWHORIZONS_CHARON_ClrSHADE', 2048),
    ('ceres', 'asteroid_belt/ceres_simp_cyl.map', 'Ceres_FC_global', 2048),
    ('moon', 'earth/moon_simp_cyl.map', 'LROC_WAC', 2048),
]


def url_for(mapfile, layer, w):
    q = {
        'map': '/maps/' + mapfile, 'SERVICE': 'WMS', 'VERSION': '1.1.1', 'REQUEST': 'GetMap',
        'LAYERS': layer, 'STYLES': '', 'SRS': 'EPSG:4326', 'BBOX': '-180,-90,180,90',
        'WIDTH': str(w), 'HEIGHT': str(w // 2), 'FORMAT': 'image/png',
    }
    return BASE + '?' + urllib.parse.urlencode(q)


def main(out):
    os.makedirs(out, exist_ok=True)
    for body, mapfile, layer, w in REQUESTS:
        dst = os.path.join(out, f'{body}__{layer}.png')
        if os.path.exists(dst) and os.path.getsize(dst) > 0:
            print('have', dst)
            continue
        u = url_for(mapfile, layer, w)
        for attempt in range(4):
            try:
                req = urllib.request.Request(u, headers={'User-Agent': 'cosmos-data-fetch'})
                with urllib.request.urlopen(req, timeout=600) as r:
                    data = r.read()
                    ctype = r.headers.get('Content-Type', '')
                if not data.startswith(b'\x89PNG') or 'image/png' not in ctype:
                    raise RuntimeError(f'not a PNG ({ctype}): {data[:200]!r}')
                with open(dst + '.part', 'wb') as fh:
                    fh.write(data)
                os.replace(dst + '.part', dst)
                print('got', dst, len(data))
                break
            except Exception as e:  # noqa: BLE001
                print('retry', body, layer, e)
                time.sleep(5 * (attempt + 1))
        else:
            print('FAILED', body, layer)


if __name__ == '__main__':
    main(sys.argv[1])
