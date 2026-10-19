// Beyond light: the sky in neutrinos, in dark matter and in gravitational waves (observing "bands" 7, 8 and 9).
// Nothing else is drawn in these views: planets and stars are transparent to neutrinos and gravitational waves, and
// make up a negligible share of the mass. Brightness is shown on a logarithmic scale (the Sun outshines the galactic
// plane in neutrinos by ~10 orders of magnitude), in false colour.
//
// Neutrinos (observed: the Sun by Homestake, Kamiokande, Super-Kamiokande, SNO and Borexino, which also sees the CNO
// cycle; SN 1987A's burst of 25 neutrinos; geoneutrinos from uranium and thorium inside the Earth by KamLAND and
// Borexino; IceCube's diffuse high-energy flux, the blazar TXS 0506+056 in 2017, the Seyfert galaxy NGC 1068 and the
// galactic plane in 2023). The cosmic neutrino background (1.95 K) is predicted but not yet detected.
//   Stars shine by their fusion (~2.3% of a Sun-like star's power leaves as neutrinos, more in massive CNO stars);
//   young neutron stars by their cooling; rocky planets glow faintly by geoneutrinos, as a disk whose brightness
//   follows the length of rock along each line of sight; a core-collapse supernova's burst (99% of its energy)
//   arrives hours before its light. Detectors blur a source over degrees (Super-Kamiokande's Sun is a smudge).
// Dark matter (observed only by its gravity: rotation curves, gravitational lensing, the CMB): the Milky Way's NFW
//   halo integrated along each line of sight from wherever you are (it peaks towards the galactic centre), and every
//   other galaxy's halo.
// Gravitational waves (observed: ~300 compact binary mergers by LIGO, Virgo and KAGRA since GW150914; the nanohertz
//   background found by pulsar timing arrays in 2023). Mergers arrive as chirps from random directions at the rate
//   the detectors see them (GW150914 and GW170817 at their real times and places); the background hums everywhere;
//   compact binaries in the current system ripple at twice their orbital frequency; the Galaxy's ~10^7 white dwarf
//   pairs make an unresolved foreground along the plane (predicted, for LISA).
import { V, Q, clamp } from './math.js';
import { catalog } from './assets.js';
import { galDir, MILKY_WAY } from './universe.js';
import { SCHEDULED } from './supernova.js';

export const MESSENGER_NOTE = {
  7: 'neutrinos: the Sun (seen even through the Earth at night), geoneutrinos from rocky planets, the galactic plane, supernova bursts; the rest of the sky is dark',
  8: 'dark matter, as mapped by its gravity (rotation curves, lensing): the Milky Way halo and every galaxy\'s halo',
  9: 'gravitational waves: black hole and neutron star mergers (LIGO-Virgo-KAGRA), the pulsar-timing background hum, the Galaxy\'s white dwarf pairs',
};

const N = 40;
export const MESSENGER_FS = `
in vec2 vUV; out vec4 o;
uniform mat3 uRot, uToGal; uniform vec2 uTanFov; uniform int uMode; uniform sampler3D uNoise3; uniform float uTime, uHum, uPlane, uIso, uHalo, uNuBg;
uniform vec3 uCamG;          // observer in the Milky Way's frame, kpc
uniform int uNs; uniform vec3 uSD[${N}]; uniform vec4 uSP[${N}];   // direction; amplitude, size (rad), kind, phase
// Milky Way: an NFW dark halo (r_s = 20 kpc, to 250 kpc) and the gas and cosmic-ray disk (scale length 3.5 kpc,
// height 0.15 kpc), integrated along the ray from the observer
float nfw(float r){ float x = max(r/20., 0.02); return 1./(x*(1. + x)*(1. + x)); }
float disk(vec3 p){ return exp(-length(p.xz)/3.5 - abs(p.y)/0.15); }
void main(){
  vec3 d = normalize(uRot*vec3((vUV*2. - 1.)*uTanFov, -1.)), dg = normalize(uToGal*d);
  vec3 col = uMode == 7 ? vec3(0.3, 1.0, 0.75) : uMode == 8 ? vec3(0.62, 0.38, 1.0) : vec3(1.0, 0.72, 0.3);
  float L = 0.;
  // the Galaxy, when we are in or near it (log-spaced steps from 10 pc to 250 kpc)
  if (uHalo > 0. || uPlane > 0.) {
    float halo = 0., pl = 0., s0 = 0.;
    for (int i = 0; i < 48; i++) {
      float s1 = 0.01*pow(25000., float(i + 1)/48.), ds = s1 - s0, sm = 0.5*(s0 + s1); s0 = s1;
      vec3 p = uCamG + dg*sm;
      // (the halo is lumpy: thousands of subhalos, of which the dwarf galaxies are only the brightest; predicted by
      // simulations, hinted at by gaps in stellar streams)
      float lump = uMode == 8 ? 0.8 + 0.45*texture(uNoise3, p/14.).r*texture(uNoise3, p/4.3).g : 1.;
      halo += nfw(length(p))*lump*ds; pl += disk(p)*ds;
    }
    // (column through the halo: ~20 towards the anticentre from the Sun's orbit, ~80 towards the centre's cusp)
    L += uHalo*clamp(0.24*log2(max(halo, 1e-3)/8.), 0., 1.4);
    L += uPlane*clamp(log(1. + pl*2.)*0.5, 0., 1.2);
  }
  // diffuse backgrounds: isotropic, slowly shimmering
  float n = texture(uNoise3, d*1.7 + vec3(0., 0., uTime*0.013)).r*0.6 + texture(uNoise3, d*5.3 - vec3(uTime*0.007)).g*0.4;
  L += uIso*(0.7 + 0.6*n) + uHum*(0.4 + 1.2*n*n) + uNuBg;
  // sources
  for (int i = 0; i < ${N}; i++) {
    if (i >= uNs) break;
    vec4 sp = uSP[i]; float c = clamp(dot(d, uSD[i]), -1., 1.), th = acos(c);
    if (sp.z < 0.5) L += sp.x*exp(-0.5*th*th/(sp.y*sp.y));                                     // blurred blob
    else if (sp.z < 1.5) { float u = th/sp.y; if (u < 1.) L += sp.x*sqrt(1. - u*u); }          // glowing body: path length
    else if (sp.z < 2.5) {                                                                        // ripples (phase 0..1)
      float r = sp.w*0.9, rings = 0.;
      for (int k = 0; k < 3; k++) { float rk = r - float(k)*0.12; if (rk > 0.) rings += exp(-pow((th - rk)/0.018, 2.))*(1. - rk/0.9); }
      L += sp.x*(rings*0.8 + exp(-0.5*th*th/(sp.y*sp.y))*(1. - sp.w)); }
    else L += sp.x*(1. - sp.w)*exp(-0.5*th*th/(sp.y*sp.y));                                    // a brief event
  }
  o = vec4(col*L*0.9 + vec3(0.02, 0.03, 0.05)*L*L, 1.);
}`;

// --- directions: equatorial (J2000) -> galactic -> world ---
function eqToGal(raD, decD) {
  const ra = raD * Math.PI / 180, de = decD * Math.PI / 180, x = Math.cos(de) * Math.cos(ra), y = Math.cos(de) * Math.sin(ra), z = Math.sin(de);
  const T = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445], [-0.8676661490, -0.1980763734, 0.4559837762]];
  const g = T.map(r => r[0] * x + r[1] * y + r[2] * z);
  return [Math.atan2(g[1], g[0]) * 180 / Math.PI, Math.asin(g[2]) * 180 / Math.PI];
}
const worldDir = (l, b) => Q.rot(MILKY_WAY.quat, galDir(l, b));
const yrOf = (iso) => (Date.parse(iso) - Date.UTC(2000, 0, 1, 12)) / 31557600000;

// steady neutrino point sources (IceCube) and real transients
const NU_POINTS = [['NGC 1068', 40.67, -0.013, 0.18], ['TXS 0506+056', 77.36, 5.69, 0.14]].map(([n, ra, de, a]) => ({ n, gal: eqToGal(ra, de), a }));
const BURSTS = [
  { kind: 'nu', t: yrOf('1987-02-23T07:35:35Z'), gal: [279.70, -31.94], amp: 1.6, text: 'Neutrino burst from SN 1987A in the Large Magellanic Cloud: Kamiokande II, IMB and Baksan catch 25 neutrinos in 13 seconds, three hours before its light' },
  { kind: 'nu', t: yrOf('2017-09-22T20:54:30Z'), gal: eqToGal(77.43, 5.72), amp: 0.9, text: 'IceCube-170922A: a 290 TeV neutrino from the blazar TXS 0506+056, 4 billion light years away; telescopes find it flaring in gamma rays' },
  { kind: 'gw', t: yrOf('2015-09-14T09:50:45Z'), gal: eqToGal(112, -70), amp: 1.3, text: 'GW150914: the first gravitational waves ever detected. Two black holes of 36 and 29 suns merge 1.3 billion light years away; 3 suns of mass leave as waves in 0.2 s' },
  { kind: 'gw', t: yrOf('2017-08-17T12:41:04Z'), gal: eqToGal(197.4504, -23.3815), amp: 1.5, text: 'GW170817: two neutron stars merge in NGC 4993, 130 million light years away. A gamma-ray burst 1.7 s later and a kilonova forging gold and platinum: the first event seen in both gravitational waves and light' },
];
const hash = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const randDir = (k) => { const z = 2 * hash(k * 3.1 + 1) - 1, ph = 6.2832 * hash(k * 7.7 + 2), r = Math.sqrt(1 - z * z); return [r * Math.cos(ph), z, r * Math.sin(ph)]; };

const flashes = [];            // { dir, wall, amp, kind }
let lastYr = null, snDirs = null, frame = 0;
export const messengerNews = { msg: null };

// neutrino power as a fraction of a star's light: pp-chain stars ~2.3% (the Sun), CNO-cycle massive stars ~6%;
// giants and white dwarfs little; a young neutron star cools mostly by neutrinos
function nuFrac(s) {
  if (s.blackHole) return 0;
  if (s.neutron) return s.snrAge !== undefined && s.snrAge < 1e5 ? 20 : 0.5;
  if (s.temp > 40000 && s.radius < 3e7) return 0.01;           // white dwarf
  const m = s.mass / 1.989e30;
  return m > 1.3 ? 0.06 : 0.023;
}

// sources for band 7-9 at the current frame. ctx: { nav, sys, tyr, dtyr, mode, wall }
export function messengerSources(ctx) {
  const { nav, sys, tyr, mode } = ctx, out = [];
  frame++;
  const camW = nav.S;
  const push = (dir, amp, size, kind, phase = 0) => { if (amp > 0.01 && out.length < N) out.push({ dir: V.norm(dir), amp, size, kind, phase }); };
  // transients crossed since the last frame (forwards in time), and random ones at the observed rates
  if (lastYr !== null && tyr > lastYr && tyr - lastYr < 50) {
    for (const b of BURSTS) if (b.t > lastYr && b.t <= tyr && ((b.kind === 'nu') === (mode === 7)) && mode !== 8) { flashes.push({ dir: worldDir(b.gal[0], b.gal[1]), wall: ctx.wall, frame, amp: b.amp, kind: b.kind }); messengerNews.msg = b.text; }
    if (mode === 7 || mode === 9) {
      // LIGO-Virgo-KAGRA: ~110 detections a year in O4; IceCube: ~30 high-energy alerts a year
      const rate = mode === 9 ? 110 : 30, k0 = Math.floor(lastYr * rate), k1 = Math.floor(tyr * rate);
      for (let k = Math.max(k0 + 1, k1 - 5); k <= k1; k++) flashes.push({ dir: randDir(k + mode * 1e7), wall: ctx.wall - 300 * hash(k), frame: frame - Math.round(12 * hash(k)), amp: 0.35 + 0.6 * hash(k * 1.7) ** 2, kind: mode === 9 ? 'gw' : 'nu' });
    }
    // supernovae in the catalogue: their neutrinos arrive just before the light
    if (mode === 7) {
      if (!snDirs && catalog.ready) snDirs = SCHEDULED.map(sn => { const x = catalog.named.find(q => q.name === sn.name); if (!x) return null; const d = catalog.data; return { t: sn.tObs, dir: Q.rot(MILKY_WAY.quat, [d[x.i * 5], d[x.i * 5 + 1], d[x.i * 5 + 2]]), name: sn.name }; }).filter(Boolean);
      for (const s of snDirs || []) if (s.t > lastYr && s.t <= tyr) { flashes.push({ dir: s.dir, wall: ctx.wall, frame, amp: 1.8, kind: 'nu' }); messengerNews.msg = s.name + ' collapses: ~10^58 neutrinos carry off 99% of the explosion\'s energy in ten seconds, hours before the light'; }
    }
  }
  lastYr = tyr;
  while (flashes.length > 24) flashes.shift();
  for (let i = flashes.length - 1; i >= 0; i--) {
    // (a couple of seconds, but at least ~100 frames however slow the device)
    const f = flashes[i], age = Math.min((ctx.wall - f.wall) / (f.kind === 'gw' ? 2600 : 1800), (frame - f.frame) / (f.kind === 'gw' ? 130 : 90));
    if (age > 1 || age < 0) { if (age > 1) flashes.splice(i, 1); continue; }
    if ((f.kind === 'gw') !== (mode === 9)) continue;
    push(f.dir, f.amp, f.kind === 'gw' ? 0.012 : 0.03, f.kind === 'gw' ? 2 : 3, age);
  }
  if (mode === 7) {
    for (const p of NU_POINTS) push(worldDir(p.gal[0], p.gal[1]), p.a, 0.03, 0);
    if (sys) for (const b of sys.bodies) {
      if (!b.wpos || b.gone) continue;
      const rel = V.sub(b.wpos, camW), d = Math.max(V.len(rel), 1);
      if (b.kind === 'star') {
        // log flux relative to the Sun's at 1 AU; blurred over ~4 degrees as a detector would
        const F = (b.lum || 0) * nuFrac(b) / 0.023 / Math.pow(d / 1.496e11, 2);
        if (F > 0) push(rel, clamp(1.05 + Math.log10(F) / 8, 0, 2.2), Math.max(Math.asin(Math.min(1, b.radius * 0.25 / d)), 0.07), 0);
      } else if (b.radius > 1.5e6 && b.surface && b.surface.gen === 'terra') {
        // geoneutrinos: radiogenic heat in the rock (brightness ~ path length, so a disk brighter at its centre)
        const ang = Math.asin(Math.min(1, b.radius / d));
        push(rel, 0.11 + 0.04 * Math.log10(b.radius / 6.371e6), ang, 1);
      }
    }
  }
  if (mode === 9 && sys) {
    // compact binaries here: strain ~ chirp mass^(5/3) f^(2/3) / distance (log scale)
    const cs = sys.bodies.filter(b => !b.gone && (b.blackHole || b.neutron || (b.kind === 'star' && b.temp > 40000 && b.radius < 3e7)) && b.wpos);
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i], b = cs[j], sep = V.dist(a.wpos, b.wpos); if (sep > 1e13) continue;
      const M = a.mass + b.mass, Mc = Math.pow(a.mass * b.mass, 0.6) / Math.pow(M, 0.2), f = Math.sqrt(6.674e-11 * M / sep ** 3) / Math.PI;
      const mid = V.mul(V.add(a.wpos, b.wpos), 0.5), d = Math.max(V.dist(mid, camW), sep);
      const h = 4 * Math.pow(6.674e-11 * Mc, 5 / 3) * Math.pow(Math.PI * f, 2 / 3) / (8.08e33 * d);      // (c^4 = 8.08e33)
      push(V.sub(mid, camW), clamp(2.2 + Math.log10(Math.max(h, 1e-40)) / 10, 0.1, 2), 0.02, 2, ((ctx.simSec || 0) * 2 * f) % 1);
    }
  }
  return out;
}
