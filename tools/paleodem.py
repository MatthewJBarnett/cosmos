# Convert Scotese & Wright (2018) PALEOMAP PaleoDEMs (1 degree, netCDF4) to 16-bit-in-RG PNGs + an age index.
# Usage: python -I tools/paleodem.py <dir of Scotese_Wright_2018 1deg .nc files> data/paleo   (needs numpy, h5py, pillow)
import sys, os, re, json, h5py, numpy as np
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
ages = []
for fn in sorted(os.listdir(src)):
    if not fn.endswith('.nc'): continue
    m = re.search(r'_([0-9.]+)Ma\.nc$', fn); age = float(m.group(1))
    f = h5py.File(os.path.join(src, fn), 'r'); z = f['z'][:].astype(np.float64)
    assert z.shape == (181, 361) and f['lat'][0] == -90
    z = np.nan_to_num(z, nan=-4000.0)[::-1]                     # north up
    q = np.clip(np.round((z + 8000.0) / 16000.0 * 65535.0), 0, 65535).astype(np.uint32)
    rgb = np.zeros((181, 361, 3), np.uint8); rgb[..., 0] = q >> 8; rgb[..., 1] = q & 255
    name = ('%g' % age).replace('.', '_') + '.png'
    Image.fromarray(rgb).save(os.path.join(out, name), optimize=True)
    ages.append([age, name, round(float((z > 0).mean()), 3)])
ages.sort()
json.dump(ages, open(os.path.join(out, 'index.json'), 'w'))
print(len(ages), ages[0], ages[-1])
