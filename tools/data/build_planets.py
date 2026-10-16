#!/usr/bin/env python3
"""Convert downloaded planetary sources into web-ready equirectangular maps and
write data/manifest.json.

Usage:
  python3 -I build_planets.py DL_DIR DATA_DIR [body ...]

DL_DIR is the directory filled by fetch_sources.sh. DATA_DIR is cosmos/data.
With no body names every product is rebuilt. The manifest is always rewritten
from the files that exist in DATA_DIR.

Convention for every planet map written here:
  equirectangular 2:1, north up, longitude -180 at the left edge, 0 at the
  horizontal centre, +180 at the right edge, east to the right
  (planetocentric, positive-east longitude). Pixel (x, y) centre is at
  lon = -180 + (x + 0.5) * 360 / W, lat = 90 - (y + 0.5) * 180 / H.
"""
import gzip, json, math, os, re, sys

import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None

DL = OUT = None
MANIFEST_EXTRA = {}  # file -> dict of extra manifest fields filled while building

CONV_STD = ('lon -180 at left edge, 0 at centre, +180 at right edge; east to the right; '
            'north up; planetocentric positive-east longitude')

PD_NASA = 'Public domain (NASA)'
PD_USGS = 'Public domain (USGS Astrogeology / NASA)'
SSS_LIC = 'CC BY 4.0'
SSS_ATTR = 'Solar System Scope (www.solarsystemscope.com), CC BY 4.0'
WMS = 'https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/{map}&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS={layer}&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH={w}&HEIGHT={h}&FORMAT=image/png'
SSS_URL = 'https://www.solarsystemscope.com/textures/download/{f}'
EO = 'https://eoimages.gsfc.nasa.gov/images/imagerecords'
SVS = 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720'


# ---------------------------------------------------------------- helpers

def src(*parts):
    p = os.path.join(DL, *parts)
    if not os.path.exists(p):
        raise FileNotFoundError(p)
    return p


def out(name):
    d = os.path.join(OUT, 'planets')
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, name)


def load_rgb(path, mode='RGB'):
    if path.lower().endswith(('.tif', '.tiff')):
        import tifffile
        a = tifffile.imread(path)
        im = Image.fromarray(a)
    else:
        im = Image.open(path)
        im.load()
    if im.mode != mode:
        if mode == 'L' and im.mode in ('RGB', 'RGBA'):
            im = im.convert('RGB').convert('L')
        else:
            im = im.convert(mode)
    return im


def roll_half(im):
    """Swap left and right halves: converts a 0..360 map to -180..180."""
    w, h = im.size
    a = np.asarray(im)
    return Image.fromarray(np.ascontiguousarray(np.roll(a, w // 2, axis=1)))


def resize(im, w, h):
    if im.size == (w, h):
        return im
    return im.resize((w, h), Image.LANCZOS, reducing_gap=3.0)


def save_jpeg(im, path, quality=88, limit=4_000_000):
    q = quality
    while True:
        im.save(path, 'JPEG', quality=q, optimize=True, progressive=True, subsampling=0 if im.mode == 'L' else 2)
        if os.path.getsize(path) <= limit or q <= 70:
            break
        q -= 3
    MANIFEST_EXTRA.setdefault(os.path.basename(path), {})['jpeg_quality'] = q
    print(f'  wrote {path} {im.size} q={q} {os.path.getsize(path)/1e6:.2f} MB')


def fill_nodata(a, valid):
    """Replace invalid pixels with the mean of valid pixels in the same row
    (falling back to the nearest row that has data, then the global mean)."""
    a = a.astype(np.float32).copy()
    h = a.shape[0]
    chans = a.shape[2] if a.ndim == 3 else 1
    a3 = a.reshape(h, a.shape[1], chans)
    rowmean = np.full((h, chans), np.nan, np.float32)
    for y in range(h):
        v = valid[y]
        if v.mean() > 0.25:
            rowmean[y] = a3[y][v].mean(axis=0)
    good = np.where(~np.isnan(rowmean[:, 0]))[0]
    if len(good) == 0:
        return a
    for y in range(h):
        if np.isnan(rowmean[y, 0]):
            rowmean[y] = rowmean[good[np.argmin(np.abs(good - y))]]
    # smooth the row means so filled regions are not streaky
    k = max(3, h // 64) | 1
    ker = np.ones(k, np.float32) / k
    for c in range(chans):
        col = np.pad(rowmean[:, c], k // 2, mode='edge')
        rowmean[:, c] = np.convolve(col, ker, mode='valid')
    fillv = np.broadcast_to(rowmean[:, None, :], a3.shape)
    a3[~valid] = fillv[~valid]
    return a3.reshape(a.shape)


def save_height16(arr_m, path, min_m, max_m):
    """Write metres as 16-bit grayscale PNG: m = min_m + v * (max_m - min_m) / 65535."""
    v = np.clip((arr_m - min_m) / (max_m - min_m), 0, 1) * 65535.0
    v = np.round(v).astype('>u2')
    Image.fromarray(v.astype(np.uint16)).save(path, optimize=True)
    MANIFEST_EXTRA.setdefault(os.path.basename(path), {})['height'] = {
        'bits': 16, 'min_m': min_m, 'max_m': max_m,
        'decode': 'metres = min_m + value/65535 * (max_m - min_m)',
        'data_min_m': float(np.nanmin(arr_m)), 'data_max_m': float(np.nanmax(arr_m)),
    }
    print(f'  wrote {path} {arr_m.shape[::-1]} {os.path.getsize(path)/1e6:.2f} MB '
          f'data range {np.nanmin(arr_m):.0f}..{np.nanmax(arr_m):.0f} m')


def resize_float(a, w, h):
    im = Image.fromarray(a.astype(np.float32), mode='F')
    return np.asarray(im.resize((w, h), Image.LANCZOS, reducing_gap=3.0), dtype=np.float32)


def wms_png(body, layer):
    return src('wms', f'{body}__{layer}.png')


# ---------------------------------------------------------------- Earth

def earth():
    print('earth')
    im = load_rgb(src('bmng', 'world.topo.bathy.200407.3x21600x10800.jpg'))
    save_jpeg(resize(im, 4096, 2048), out('earth_color.jpg'))

    im = load_rgb(src('blackmarble', 'BlackMarble_2016_3km_gray.jpg'), 'L')
    save_jpeg(resize(im, 4096, 2048), out('earth_lights.jpg'))

    im = load_rgb(src('clouds', 'cloud_combined_8192.tif'), 'L')
    save_jpeg(resize(im, 4096, 2048), out('earth_clouds.jpg'))

    import h5py
    with h5py.File(src('etopo', 'ETOPO_2022_v1_60s_N90W180_surface.nc'), 'r') as f:
        z = np.asarray(f['z'][...], dtype=np.float32)
        lat = np.asarray(f['lat'][...])
        lon = np.asarray(f['lon'][...])
    print('  etopo', z.shape, 'lat', lat[0], lat[-1], 'lon', lon[0], lon[-1])
    if lat[0] < lat[-1]:
        z = z[::-1]
    if lon[0] > 0:
        raise RuntimeError('unexpected ETOPO longitude origin')
    zs = resize_float(z, 4096, 2048)
    save_height16(zs, out('earth_height.png'), -11000.0, 9000.0)

    earth_mask()


def _draw_geojson(draw, path, value, W, H, ss):
    with open(path, encoding='utf-8') as fh:
        gj = json.load(fh)
    n = 0
    for feat in gj['features']:
        g = feat.get('geometry') or {}
        polys = g.get('coordinates', [])
        if g.get('type') == 'Polygon':
            polys = [polys]
        elif g.get('type') != 'MultiPolygon':
            continue
        for poly in polys:
            for ri, ring in enumerate(poly):
                pts = [((lo + 180.0) / 360.0 * W * ss, (90.0 - la) / 180.0 * H * ss) for lo, la, *_ in ring]
                if len(pts) >= 3:
                    draw.polygon(pts, fill=value if ri == 0 else (255 - value))
            n += 1
    return n


def earth_mask():
    """Water mask from Natural Earth 1:10m land and lakes polygons (public domain).
    255 = water (ocean, seas, large lakes), 0 = land."""
    W, H, ss = 4096, 2048, 4
    big = Image.new('L', (W * ss, H * ss), 255)
    d = ImageDraw.Draw(big)
    n1 = _draw_geojson(d, src('naturalearth', 'ne_10m_land.geojson'), 0, W, H, ss)
    n2 = _draw_geojson(d, src('naturalearth', 'ne_10m_lakes.geojson'), 255, W, H, ss)
    print(f'  land polys {n1}, lake polys {n2}')
    m = big.resize((W, H), Image.BOX)
    m.save(out('earth_mask.png'), optimize=True)
    print(f'  wrote earth_mask.png {os.path.getsize(out("earth_mask.png"))/1e6:.2f} MB')


# ---------------------------------------------------------------- Moon

def moon():
    print('moon')
    im = load_rgb(src('moonkit', 'lroc_color_poles_8k.tif'))
    print('  lroc', im.size)
    save_jpeg(resize(im, 4096, 2048), out('moon_color.jpg'))
    import tifffile
    km = tifffile.imread(src('moonkit', 'ldem_16.tif')).astype(np.float32)
    print('  ldem', km.shape, float(km.min()), float(km.max()))
    zs = resize_float(km * 1000.0, 4096, 2048)
    save_height16(zs, out('moon_height.png'), -9500.0, 11000.0)


# ---------------------------------------------------------------- Mars

def mars():
    print('mars')
    im = load_rgb(wms_png('mars', 'MDIM21_color'))
    save_jpeg(resize(im, 4096, 2048), out('mars_color.jpg'))
    lbl = open(src('mola', 'megt90n000eb.lbl'), encoding='ascii', errors='replace').read()
    lines = int(re.search(r'\bLINES\s*=\s*(\d+)', lbl).group(1))
    samples = int(re.search(r'\bLINE_SAMPLES\s*=\s*(\d+)', lbl).group(1))
    stype = re.search(r'\bSAMPLE_TYPE\s*=\s*(\w+)', lbl).group(1)
    west = float(re.search(r'WESTERNMOST_LONGITUDE\s*=\s*([-\d.]+)', lbl).group(1))
    assert stype.startswith('MSB'), stype
    a = np.fromfile(src('mola', 'megt90n000eb.img'), dtype='>i2').reshape(lines, samples).astype(np.float32)
    print('  mola', a.shape, 'west lon', west, a.min(), a.max())
    if abs(west) < 1e-6:  # 0..360 east -> -180..180
        a = np.roll(a, samples // 2, axis=1)
    zs = resize_float(a, 4096, 2048)
    save_height16(zs, out('mars_height.png'), -8500.0, 21500.0)


# ---------------------------------------------------------------- USGS WMS bodies

def wms_body(body, layer, name=None, w=2048, gray=False, fill='black'):
    """fill: 'black' or 'white' = the server's no-data colour (exact 0 or 255 in all
    channels), which gets replaced by smoothed row means; None = leave as is."""
    im = load_rgb(wms_png(body, layer), 'RGB')
    a = np.asarray(im)
    if fill:
        nd = (a.max(axis=2) == 0) if fill == 'black' else (a.min(axis=2) == 255)
        # grow the no-data region by one pixel to swallow resampling fringes
        g = nd.copy()
        g[1:] |= nd[:-1]; g[:-1] |= nd[1:]
        g[:, 1:] |= nd[:, :-1]; g[:, :-1] |= nd[:, 1:]
        valid = ~g if nd.mean() > 0.0005 else ~nd
        frac = 1 - valid.mean()
        MANIFEST_EXTRA.setdefault(f'{name or body}_color.jpg', {})['nodata_filled_fraction'] = round(float(frac), 4)
        if frac > 0.0005:
            print(f'  filling {frac*100:.1f}% no-data pixels')
            a = np.clip(fill_nodata(a, valid), 0, 255).astype(np.uint8)
            im = Image.fromarray(a)
    a = np.asarray(im).astype(np.int16)
    if gray or (np.abs(a[..., 0] - a[..., 1]).max() <= 2 and np.abs(a[..., 1] - a[..., 2]).max() <= 2):
        im = im.convert('L')
    save_jpeg(resize(im, w, w // 2), out(f'{name or body}_color.jpg'))


def mercury():
    print('mercury')
    wms_body('mercury', 'MESSENGER', gray=True)


def venus():
    print('venus')
    wms_body('venus', 'MAGELLAN_color')
    im = load_rgb(src('sss', '4k_venus_atmosphere.jpg'))
    save_jpeg(resize(im, 2048, 1024), out('venus_clouds.jpg'))


def galilean():
    for b, layer, gray in (('io', 'SSI_VGR_color', False), ('europa', 'GALILEO_VOYAGER', True),
                           ('ganymede', 'GALILEO_VOYAGER', True), ('callisto', 'GALILEO_VOYAGER', True)):
        print(b)
        wms_body(b, layer, gray=gray)


def saturn_moons():
    print('titan')
    wms_body('titan', 'CASSINI', gray=True)
    print('enceladus')
    wms_body('enceladus', 'CASSINI', gray=True)


def pluto_charon():
    print('pluto')
    wms_body('pluto', 'NEWHORIZONS_PLUTO_MOSAIC', fill='white')
    print('charon')
    wms_body('charon', 'NEWHORIZONS_CHARON_MOSAIC', fill='white')


def ceres():
    print('ceres')
    wms_body('ceres', 'Ceres_FC_global', gray=True)


# ---------------------------------------------------------------- Solar System Scope

def giants():
    for b, f, w in (('jupiter', '8k_jupiter.jpg', 4096), ('saturn', '8k_saturn.jpg', 4096),
                    ('uranus', '2k_uranus.jpg', 2048), ('neptune', '2k_neptune.jpg', 2048)):
        print(b)
        save_jpeg(resize(load_rgb(src('sss', f)), w, w // 2), out(f'{b}_color.jpg'))
    print('saturn rings')
    im = Image.open(src('sss', '8k_saturn_ring_alpha.png'))
    im.load()
    print('  ring source', im.size, im.mode)
    im = im.convert('RGBA')
    w, h = im.size
    if h > w:  # make it a horizontal strip: inner edge left, outer edge right
        im = im.transpose(Image.Transpose.ROTATE_90)
        w, h = im.size
    # rows differ only by noise: average them into one radial profile
    a = np.asarray(im).astype(np.float32).mean(axis=0, keepdims=True)
    im = Image.fromarray(np.clip(np.round(a), 0, 255).astype(np.uint8), 'RGBA')
    im = im.resize((2048, 1), Image.LANCZOS).resize((2048, 16), Image.NEAREST)
    im.save(out('saturn_rings.png'), optimize=True)
    # Radial scale calibrated on the 8192 px source: Huygens gap / B-ring outer edge
    # (117,580 km) at x=5505, Encke gap (133,590 km) at x=7340, A-ring outer edge
    # (136,775 km) at x=7712, F ring (140,220 km) at x=8116. Linear fit residuals < 60 km.
    MANIFEST_EXTRA.setdefault('saturn_rings.png', {})['ring_radii_km'] = {
        'inner_edge_of_image': 69800, 'outer_edge_of_image': 140900,
        'note': 'radius at the left and right image edges, fitted from gap positions; '
                'Saturn equatorial radius 60268 km'}
    print(f'  wrote saturn_rings.png {im.size} {os.path.getsize(out("saturn_rings.png"))/1e6:.2f} MB')


# ---------------------------------------------------------------- manifest

def stat_entry(fname):
    p = out(fname)
    with Image.open(p) as im:
        w, h = im.size
        mode = im.mode
    fmt = 'jpeg' if fname.endswith('.jpg') else 'png'
    ch = {'L': 1, 'I;16': 1, 'I;16B': 1, 'I': 1, 'RGB': 3, 'RGBA': 4, 'LA': 2}.get(mode, mode)
    return {'file': 'planets/' + fname, 'width': w, 'height': h, 'format': fmt, 'channels': ch,
            'bytes': os.path.getsize(p)}


def wms_src(m, layer, w=2048):
    return WMS.format(map=m, layer=layer, w=w, h=w // 2)


PRODUCTS = [
    # file, body, kind, source, licence, attribution, notes
    ('earth_color.jpg', 'earth', 'color', f'{EO}/73000/73751/world.topo.bathy.200407.3x21600x10800.jpg', PD_NASA,
     'NASA Earth Observatory, Blue Marble: Next Generation (Reto Stockli), July 2004, topography and bathymetry shading',
     'Cloud-free. Contains baked-in relief shading and shaded bathymetry (world.topo.bathy product).'),
    ('earth_height.png', 'earth', 'height',
     'https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc',
     'Public domain (NOAA)', 'NOAA National Centers for Environmental Information, ETOPO 2022 15/30/60 arc-second Global Relief Model (60 arc-second ice-surface version)',
     'Land elevation and ocean bathymetry relative to EGM2008 geoid (mean sea level). Ice surface for Greenland/Antarctica. Lanczos-downsampled from 21600x10800.'),
    ('earth_mask.png', 'earth', 'mask',
     'https://github.com/nvkelso/natural-earth-vector (geojson/ne_10m_land.geojson + ne_10m_lakes.geojson)',
     'Public domain (Natural Earth)', 'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com',
     '255 = water (oceans, seas, Natural Earth 1:10m lakes), 0 = land; antialiased edges (4x4 supersampled).'),
    ('earth_lights.jpg', 'earth', 'lights', f'{EO}/144000/144897/BlackMarble_2016_3km_gray.jpg', PD_NASA,
     'NASA Earth Observatory, Black Marble 2016 (Joshua Stevens, Miguel Roman, Suomi NPP VIIRS)',
     'Grayscale night lights, 2016 composite. Values are display-stretched radiance, not physical units.'),
    ('earth_clouds.jpg', 'earth', 'clouds', f'{EO}/57000/57747/cloud_combined_8192.tif', PD_NASA,
     'NASA Goddard Space Flight Center, Blue Marble cloud composite (Reto Stockli, Robert Simmon)',
     'Grayscale cloud cover, white = cloud. Use as alpha/opacity.'),
    ('moon_color.jpg', 'moon', 'color', f'{SVS}/lroc_color_poles_8k.tif', PD_NASA,
     'NASA Scientific Visualization Studio, CGI Moon Kit (Ernie Wright); LRO LROC WAC colour mosaic with polar fill',
     None),
    ('moon_height.png', 'moon', 'height', f'{SVS}/ldem_16.tif', PD_NASA,
     'NASA Scientific Visualization Studio, CGI Moon Kit; LRO LOLA elevation (ldem_16, 16 px/deg)',
     'Metres relative to a sphere of radius 1737.4 km (source values were km).'),
    ('mars_color.jpg', 'mars', 'color', wms_src('mars/mars_simp_cyl.map', 'MDIM21_color', 4096), PD_USGS,
     'USGS Astrogeology Science Center, Mars Viking MDIM 2.1 colorized global mosaic (NASA/JPL/USGS)',
     'Viking Orbiter colour, approximately true colour.'),
    ('mars_height.png', 'mars', 'height',
     'https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.img', PD_NASA,
     'NASA PDS Geosciences Node, MGS MOLA MEGDR 16 px/deg topography (Smith et al.)',
     'Metres relative to the MOLA areoid. Source was 0..360E and was rolled by 180 degrees.'),
    ('mercury_color.jpg', 'mercury', 'color', wms_src('mercury/mercury_simp_cyl.map', 'MESSENGER'), PD_USGS,
     'USGS Astrogeology / NASA/JHUAPL/Carnegie Institution, MESSENGER MDIS global monochrome mosaic (May 2016)',
     'Grayscale (Mercury is nearly neutral grey). No-data pixels, if any, filled with smoothed row means.'),
    ('venus_color.jpg', 'venus', 'color', wms_src('venus/venus_simp_cyl.map', 'MAGELLAN_color'), PD_USGS,
     'USGS Astrogeology / NASA/JPL, Magellan colourised synthetic-aperture-radar global mosaic',
     'Radar backscatter colourised orange; not visible-light colour. Polar gaps (beyond about -80/+84 lat) filled with smoothed row means.'),
    ('venus_clouds.jpg', 'venus', 'clouds', SSS_URL.format(f='4k_venus_atmosphere.jpg'), SSS_LIC, SSS_ATTR,
     'Artistic cloud-top texture, no defined longitude reference.'),
    ('jupiter_color.jpg', 'jupiter', 'color', SSS_URL.format(f='8k_jupiter.jpg'), SSS_LIC, SSS_ATTR,
     'Based on Cassini imagery. Atmospheric features drift; longitude origin is the image centre as distributed, not tied to System III.'),
    ('saturn_color.jpg', 'saturn', 'color', SSS_URL.format(f='8k_saturn.jpg'), SSS_LIC, SSS_ATTR,
     'Longitude origin is the image centre as distributed, not tied to System III.'),
    ('saturn_rings.png', 'saturn', 'rings', SSS_URL.format(f='8k_saturn_ring_alpha.png'), SSS_LIC, SSS_ATTR, None),
    ('uranus_color.jpg', 'uranus', 'color', SSS_URL.format(f='2k_uranus.jpg'), SSS_LIC, SSS_ATTR,
     'Nearly featureless; longitude origin arbitrary.'),
    ('neptune_color.jpg', 'neptune', 'color', SSS_URL.format(f='2k_neptune.jpg'), SSS_LIC, SSS_ATTR,
     'Longitude origin arbitrary.'),
    ('io_color.jpg', 'io', 'color', wms_src('jupiter/io_simp_cyl.map', 'SSI_VGR_color'), PD_USGS,
     'USGS Astrogeology / NASA/JPL, Io Galileo SSI and Voyager merged colour global mosaic', None),
    ('europa_color.jpg', 'europa', 'color', wms_src('jupiter/europa_simp_cyl.map', 'GALILEO_VOYAGER'), PD_USGS,
     'USGS Astrogeology / NASA/JPL, Europa Galileo SSI and Voyager global mosaic', 'Grayscale.'),
    ('ganymede_color.jpg', 'ganymede', 'color', wms_src('jupiter/ganymede_simp_cyl.map', 'GALILEO_VOYAGER'), PD_USGS,
     'USGS Astrogeology / NASA/JPL, Ganymede Galileo SSI and Voyager global mosaic', 'Grayscale.'),
    ('callisto_color.jpg', 'callisto', 'color', wms_src('jupiter/callisto_simp_cyl.map', 'GALILEO_VOYAGER'), PD_USGS,
     'USGS Astrogeology / NASA/JPL, Callisto Galileo SSI and Voyager global mosaic', 'Grayscale.'),
    ('titan_color.jpg', 'titan', 'color', wms_src('saturn/titan_simp_cyl.map', 'CASSINI'), PD_USGS,
     'USGS Astrogeology / NASA/JPL/Space Science Institute, Titan Cassini ISS 938 nm global mosaic',
     'Grayscale near-infrared surface albedo seen through the haze; not visible colour.'),
    ('enceladus_color.jpg', 'enceladus', 'color', wms_src('saturn/enceladus_simp_cyl.map', 'CASSINI'), PD_USGS,
     'USGS Astrogeology / NASA/JPL/Space Science Institute, Enceladus Cassini ISS global mosaic', 'Grayscale.'),
    ('pluto_color.jpg', 'pluto', 'color', wms_src('pluto/pluto_simp_cyl.map', 'NEWHORIZONS_PLUTO_MOSAIC'), PD_USGS,
     'USGS Astrogeology / NASA/JHUAPL/SwRI, New Horizons Pluto global mosaic',
     'Grayscale (panchromatic). Southern hemisphere south of about -30 lat was in darkness during the flyby; those no-data pixels are filled with smoothed row means.'),
    ('charon_color.jpg', 'charon', 'color', wms_src('pluto/charon_simp_cyl.map', 'NEWHORIZONS_CHARON_MOSAIC'), PD_USGS,
     'USGS Astrogeology / NASA/JHUAPL/SwRI, New Horizons Charon global mosaic',
     'Grayscale (panchromatic). Unimaged southern regions filled with smoothed row means.'),
    ('ceres_color.jpg', 'ceres', 'color', wms_src('asteroid_belt/ceres_simp_cyl.map', 'Ceres_FC_global'), PD_USGS,
     'USGS Astrogeology / NASA/JPL-Caltech/UCLA/MPS/DLR/IDA, Ceres Dawn FC global mosaic', 'Grayscale.'),
]


def write_manifest():
    files = []
    for fname, body, kind, url, lic, attr, notes in PRODUCTS:
        if not os.path.exists(out(fname)):
            print('  (missing, not in manifest)', fname)
            continue
        e = {'body': body, 'kind': kind}
        e.update(stat_entry(fname))
        if kind == 'rings':
            e['longitude'] = None
            e['layout'] = ('radial strip: x runs from the inner edge (left) to the outer edge (right) of the rings, '
                           'y carries no information; RGB = colour, A = opacity')
        else:
            e['longitude'] = CONV_STD
            e['projection'] = 'equirectangular (plate carree), 2:1, full globe'
        old = MANIFEST_EXTRA_LOADED.get(fname, {})
        extra = {**old, **MANIFEST_EXTRA.get(fname, {})}
        if kind == 'height':
            e['height_encoding'] = extra.get('height')
        if kind == 'mask':
            e['mask_encoding'] = {'bits': 8, 'water': 255, 'land': 0}
        for k in ('jpeg_quality', 'nodata_filled_fraction', 'ring_radii_km'):
            if k in extra:
                e[k] = extra[k]
        e.update({'source': url, 'licence': lic, 'attribution': attr})
        if notes:
            e['notes'] = notes
        files.append(e)
    stars = []
    for f in ('stars.bin', 'stars.json'):
        p = os.path.join(OUT, f)
        if os.path.exists(p):
            stars.append({'file': f, 'bytes': os.path.getsize(p)})
    if stars:
        with open(os.path.join(OUT, 'stars.json'), encoding='utf-8') as fh:
            n = json.load(fh)['count']
        stars[0].update({
            'kind': 'star_catalogue', 'count': n, 'format': 'float32 little-endian, 5 per star',
            'fields': ['X_pc', 'Y_pc', 'Z_pc', 'absmag_V', 'teff_K'],
            'frame': 'Sun at origin. X toward galactic centre (l=0,b=0), Y toward north galactic pole, Z toward l=270 (Z = -y_gal).',
            'order': 'apparent V magnitude ascending',
            'selection': 'HYG stars with 0 < dist < 100000 pc and mag <= 9.5, Sun excluded',
            'teff': 'Ballesteros (2012) from B-V; 5800 K where B-V missing',
            'source': 'https://codeberg.org/astronexus/hyg (data/hyg/CURRENT/hyg_v44.csv.gz)',
            'licence': 'CC BY-SA 4.0', 'attribution': 'HYG database v4.4, David Nash / astronexus.com, CC BY-SA 4.0',
        })
        stars[1].update({
            'kind': 'star_names_constellations',
            'source': 'HYG v4.4 names; https://github.com/Stellarium/stellarium skycultures/modern/index.json',
            'licence': 'CC BY-SA 4.0 (HYG names); constellation lines from Stellarium (GPL-2.0-or-later)',
            'attribution': 'HYG database v4.4 (astronexus.com); constellation figures: Stellarium modern sky culture',
        })
    man = {
        'generated_by': 'tools/data/build_stars.py, tools/data/build_planets.py',
        'longitude_convention': CONV_STD + '. Pixel (x,y) centre: lon = -180 + (x+0.5)*360/W, lat = 90 - (y+0.5)*180/H.',
        'stars': stars,
        'maps': files,
    }
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(man, fh, indent=1, ensure_ascii=False)
    print('manifest:', len(files), 'maps')


STEPS = {'earth': earth, 'mask': earth_mask, 'moon': moon, 'mars': mars, 'mercury': mercury,
         'venus': venus, 'galilean': galilean, 'saturn_moons': saturn_moons,
         'pluto': pluto_charon, 'ceres': ceres, 'giants': giants}
MANIFEST_EXTRA_LOADED = {}


def main():
    global DL, OUT, MANIFEST_EXTRA_LOADED
    DL, OUT = sys.argv[1], sys.argv[2]
    which = sys.argv[3:] or list(STEPS)
    # keep build-time facts (jpeg quality, height ranges) across partial rebuilds
    side = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build_info.json')
    if os.path.exists(side):
        with open(side, encoding='utf-8') as fh:
            MANIFEST_EXTRA_LOADED = json.load(fh)
    for w in which:
        if w != 'manifest':
            STEPS[w]()
    merged = {**MANIFEST_EXTRA_LOADED}
    for k, v in MANIFEST_EXTRA.items():
        merged[k] = {**merged.get(k, {}), **v}
    MANIFEST_EXTRA_LOADED = merged
    with open(side, 'w', encoding='utf-8') as fh:
        json.dump(merged, fh, indent=1)
    write_manifest()


if __name__ == '__main__':
    main()
