# Rasterise PB2002 plate polygons (GeoJSON) into the plate-index map used for continental drift.
# Usage: python3 tools/plates.py PB2002_plates.json data/planets/earth_plates.png
import json, sys
from PIL import Image, ImageDraw
src, out = sys.argv[1], sys.argv[2]
W, H = 2048, 1024
MAJOR = ['', 'AF', 'AN', 'IN', 'AU', 'EU', 'NA', 'SA', 'NZ', 'PA', 'AR', 'CA', 'CO', 'PS']
MERGE = {'SO': 'AF', 'SL': 'AN', 'TI': 'AU', 'KE': 'AU', 'TO': 'AU', 'NI': 'AU', 'WL': 'AU', 'MO': 'AU', 'SB': 'AU', 'SS': 'AU', 'NB': 'AU', 'NH': 'AU', 'FT': 'AU',
         'BH': 'AU', 'MS': 'AU', 'BS': 'AU', 'MN': 'AU', 'CR': 'AU', 'BR': 'AU', 'AM': 'EU', 'YA': 'EU', 'ON': 'EU', 'AS': 'EU', 'AT': 'EU', 'BU': 'EU', 'SU': 'EU',
         'OK': 'NA', 'JF': 'NA', 'AP': 'SA', 'ND': 'SA', 'SC': 'SA', 'SW': 'SA', 'EA': 'NZ', 'JZ': 'NZ', 'CL': 'PA', 'PM': 'CA', 'RI': 'CO', 'GP': 'CO', 'MA': 'PS'}
img = Image.new('L', (W, H), 0); dr = ImageDraw.Draw(img)
d = json.load(open(src))
for f in d['features']:
    code = f['properties']['Code']; k = MAJOR.index(MERGE.get(code, code))
    g = f['geometry']; polys = g['coordinates'] if g['type'] == 'Polygon' else [p for mp in g['coordinates'] for p in mp]
    rings = [polys[0]] if g['type'] == 'Polygon' else [mp[0] for mp in g['coordinates']]
    for ring in rings:
        pts = [list(ring[0])]
        for lon, lat in ring[1:]:
            pl = pts[-1][0]
            while lon - pl > 180: lon -= 360
            while lon - pl < -180: lon += 360
            pts.append([lon, lat])
        span = pts[-1][0] - pts[0][0]
        if abs(span) > 180:    # encircles a pole: close the ring through it
            pole = -90 if code in ('AN', 'SL') or sum(p[1] for p in pts) < 0 else 90
            pts += [[pts[-1][0], pole], [pts[0][0], pole]]
        for off in (-360, 0, 360):
            dr.polygon([((x + off + 180) / 360 * W, (90 - y) / 180 * H) for x, y in pts], fill=k)
img.save(out)
import collections; c = collections.Counter(img.getdata()); print(sorted((MAJOR[i] or 'none', n * 100 // (W * H)) for i, n in c.items()))
