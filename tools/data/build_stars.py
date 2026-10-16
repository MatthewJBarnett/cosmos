#!/usr/bin/env python3
"""Build data/stars.bin and data/stars.json from the HYG database and Stellarium's
modern sky culture.

Usage:
  python3 -I build_stars.py HYG_CSV_GZ STELLARIUM_INDEX_JSON OUT_DIR

Sources:
  HYG v4.x  https://codeberg.org/astronexus/hyg  (data/hyg/CURRENT/hyg_v44.csv.gz, CC BY-SA 4.0)
  Stellarium modern sky culture
            https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern/index.json
            (GPL-2.0-or-later, Stellarium project)

Output frame (parsecs, Sun at origin):
  X toward the galactic centre (l=0, b=0)
  Y toward the north galactic pole (b=+90)
  Z toward l=270  (Z = -y_gal)
stars.bin: little-endian float32, 5 per star: X, Y, Z, absolute V magnitude, Teff (K).
Sorted by apparent magnitude, brightest first.
"""
import csv, gzip, json, math, struct, sys

MAG_LIMIT = 9.5
DIST_MAX = 100000.0

# ICRS -> galactic rotation (Hipparcos catalogue vol. 1, sec. 1.5.3), rows = galactic axes
M = (
    (-0.0548755604162154, -0.8734370902348850, -0.4838350155487132),
    (+0.4941094278755837, -0.4448296299600112, +0.7469822444972189),
    (-0.8676661490190047, -0.1980763734312015, +0.4559837761750669),
)

GREEK = {
    'Alp': 'Alpha', 'Bet': 'Beta', 'Gam': 'Gamma', 'Del': 'Delta', 'Eps': 'Epsilon',
    'Zet': 'Zeta', 'Eta': 'Eta', 'The': 'Theta', 'Iot': 'Iota', 'Kap': 'Kappa',
    'Lam': 'Lambda', 'Mu': 'Mu', 'Nu': 'Nu', 'Xi': 'Xi', 'Omi': 'Omicron', 'Pi': 'Pi',
    'Rho': 'Rho', 'Sig': 'Sigma', 'Tau': 'Tau', 'Ups': 'Upsilon', 'Phi': 'Phi',
    'Chi': 'Chi', 'Psi': 'Psi', 'Ome': 'Omega',
}


def teff(bv):
    """Ballesteros (2012) B-V -> effective temperature."""
    return 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62))


def fnum(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def bayer_name(row):
    b = row['bayer'].strip()
    con = row['con'].strip()
    if not b or not con:
        return None
    base, _, sup = b.partition('-')
    g = GREEK.get(base, base)
    return f"{g}{sup} {con}"


def flam_name(row):
    f = row['flam'].strip()
    con = row['con'].strip()
    if f and con:
        return f"{f} {con}"
    return None


def main(hyg_path, stel_path, out_dir):
    with open(stel_path, encoding='utf-8') as fh:
        sky = json.load(fh)
    line_hips = set()
    for c in sky['constellations']:
        for chain in c['lines']:
            for h in chain:
                if isinstance(h, int):
                    line_hips.add(h)

    stars = []
    with gzip.open(hyg_path, 'rt', encoding='utf-8', newline='') as fh:
        for row in csv.DictReader(fh):
            if row['id'] == '0' or row['proper'] == 'Sol':
                continue
            dist = fnum(row['dist'])
            mag = fnum(row['mag'])
            absmag = fnum(row['absmag'])
            ra = fnum(row['rarad'])
            dec = fnum(row['decrad'])
            if None in (dist, mag, absmag, ra, dec):
                continue
            if not (0.0 < dist < DIST_MAX):
                continue
            hip = int(row['hip']) if row['hip'].strip().isdigit() else None
            if mag > MAG_LIMIT and not (hip and hip in line_hips):
                continue
            cd = math.cos(dec)
            ex, ey, ez = dist * cd * math.cos(ra), dist * cd * math.sin(ra), dist * math.sin(dec)
            gx = M[0][0] * ex + M[0][1] * ey + M[0][2] * ez
            gy = M[1][0] * ex + M[1][1] * ey + M[1][2] * ez
            gz = M[2][0] * ex + M[2][1] * ey + M[2][2] * ez
            bv = fnum(row['ci'])
            t = teff(bv) if bv is not None else 5800.0
            if not math.isfinite(t) or t <= 0:
                t = 5800.0
            t = min(max(t, 1500.0), 60000.0)
            stars.append({
                'mag': mag, 'X': gx, 'Y': gz, 'Z': -gy, 'abs': absmag, 'T': t,
                'hip': hip, 'proper': row['proper'].strip(), 'bayer': bayer_name(row),
                'flam': flam_name(row), 'spect': row['spect'].strip(), 'hd': row['hd'].strip(),
                'id': int(row['id']),
            })

    stars.sort(key=lambda s: (s['mag'], s['id']))
    n = len(stars)
    with open(f"{out_dir}/stars.bin", 'wb') as fh:
        buf = bytearray()
        for s in stars:
            buf += struct.pack('<5f', s['X'], s['Y'], s['Z'], s['abs'], s['T'])
        fh.write(buf)

    hip_index = {}
    for i, s in enumerate(stars):
        if s['hip'] and s['hip'] not in hip_index:
            hip_index[s['hip']] = i

    named = []
    for i, s in enumerate(stars):
        if not (s['proper'] or s['bayer'] or s['mag'] < 4.0):
            continue
        desig = s['bayer'] or s['flam']
        name = s['proper'] or desig
        if not name:
            name = f"HIP {s['hip']}" if s['hip'] else (f"HD {s['hd']}" if s['hd'] else f"HYG {s['id']}")
        e = {'i': i, 'name': name, 'hip': s['hip'], 'spect': s['spect']}
        if s['proper'] and desig:
            e['desig'] = desig
        named.append(e)

    cons = []
    missing = 0
    for c in sky['constellations']:
        abbr = c['id'].split()[-1]
        cn = c.get('common_name', {})
        name = cn.get('native') or cn.get('english') or abbr
        pairs = []
        seen = set()
        for chain in c['lines']:
            for a, b in zip(chain, chain[1:]):
                if not (isinstance(a, int) and isinstance(b, int)):
                    continue
                ia, ib = hip_index.get(a), hip_index.get(b)
                if ia is None or ib is None:
                    missing += 1
                    continue
                key = (min(ia, ib), max(ia, ib))
                if key in seen or ia == ib:
                    continue
                seen.add(key)
                pairs.append([ia, ib])
        cons.append({'abbr': abbr, 'name': name, 'lines': pairs})
    cons.sort(key=lambda c: c['abbr'])

    meta = {
        'count': n,
        'stride_floats': 5,
        'fields': ['X_pc', 'Y_pc', 'Z_pc', 'absmag_V', 'teff_K'],
        'frame': 'galactic, Sun at origin; X->l=0,b=0 (galactic centre); Y->b=+90 (NGP); Z->l=270',
        'sorted': 'apparent V magnitude ascending',
        'source': 'HYG v4.4 (astronexus, CC BY-SA 4.0); constellation lines: Stellarium modern sky culture',
        'named': named,
        'constellations': cons,
    }
    with open(f"{out_dir}/stars.json", 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, separators=(',', ':'), ensure_ascii=False)

    nfaint = sum(1 for s in stars if s['mag'] > MAG_LIMIT)
    print(f"stars: {n} (of which {nfaint} fainter than {MAG_LIMIT}, kept for constellation lines)")
    print(f"named: {len(named)}  constellations: {len(cons)}  unresolved line ends: {missing}")
    for nm in ('Sirius', 'Betelgeuse', 'Rigil Kentaurus', 'Polaris', 'Vega'):
        for s in stars:
            if s['proper'] == nm:
                d = math.sqrt(s['X'] ** 2 + s['Y'] ** 2 + s['Z'] ** 2)
                l = math.degrees(math.atan2(-s['Z'], s['X'])) % 360
                b = math.degrees(math.asin(s['Y'] / d))
                print(f"  {nm}: l={l:.2f} b={b:.2f} d={d:.3f} pc absmag={s['abs']:.2f} T={s['T']:.0f} K")
                break


if __name__ == '__main__':
    main(*sys.argv[1:4])
