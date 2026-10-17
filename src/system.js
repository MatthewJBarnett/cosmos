// Star systems: the real Solar System plus procedural generation, Keplerian motion, physical parameters.
import { RNG, hashCombine, makeName } from './rng.js';
import { SUN_POS } from './universe.js';
import { V, Q, C, clamp, mix } from './math.js';
import { makeStar, bbColor, KIND } from './stars.js';
import { galDir } from './universe.js';
import { REAL_SYSTEMS } from './realsystems.js';
import { starFromCatalog } from './stars.js';
import { descPosP, galQuat0, toInertial, YEAR } from './galdyn.js';
import { SCHEDULED, fireball } from './supernova.js';
import { sunState, orbitScale, moonScale, engulfed, earthPole, earthDay, earthClimate, planetTeq, iceAge, earthMeanT, earthAir, earthLife, KPG_YR, solarActivity, geomagnetic } from './evolution.js';
import { driftMyr } from './tectonics.js';
import { PALEO_START } from './paleo.js';
import { initEvolution, stellarState, tMS, wdProgenitor, KNOWN_AGE, pulsarPeriod } from './stellarevo.js';
import { planetPos, moonPos, POLES, eqToEngine, galilean, PRIME, iauNode, earthOrbitAt, JPL } from './ephem.js';

const D2R = Math.PI / 180;
const yUp = (v) => [v[0], v[2], -v[1]]; // astronomy z-up -> engine y-up

// ---------- tropical cyclones ----------
// Storms born over warm tropical oceans in their seasons (North Atlantic and NE Pacific Jun-Nov, NW Pacific most of the
// year, the southern Indian Ocean and Australia Dec-Apr), drifting west with the trade winds and recurving poleward,
// each living about a week. Up to four at a time; a statistical model, not a forecast.
const BASINS = [
  // [genesis lat, lon (deg), westward speed (deg/day), season peak (solar longitude, deg), storms per year]
  [13, -40, 3.5, 170, 12], [14, -110, 3.0, 150, 15], [13, 140, 3.0, 160, 25], [-13, 70, 2.8, 330, 10], [-14, 140, 2.5, 330, 9],
];
function tropicalCyclones(t, solarLon, climate) {
  if (climate && (climate.dry > 0.3 || climate.magma > 0 || climate.snowball)) return null;
  const day = t / 86400, out = [];
  for (let k = 0; k < BASINS.length && out.length < 4; k++) {
    const [la0, lo0, vw, peak, rate] = BASINS[k];
    const season = Math.max(0, Math.cos((solarLon - peak) * D2R)) ** 2;
    // storms born in 3-day bins; check the bins whose storms could still be alive
    for (let n = Math.floor(day / 3) - 3; n <= Math.floor(day / 3) && out.length < 4; n++) {
      const h = Math.abs(Math.sin(n * 12.9898 + k * 78.233) * 43758.5453) % 1;
      if (h > rate * 3 / 365 * season * 1.6) continue;
      const age = day - (n + (h * 7.31) % 1) * 3; if (age < 0 || age > 9) continue;
      const hs = la0 > 0 ? 1 : -1, lat = la0 + hs * (0.8 * age + 0.25 * age * age), lon = lo0 - vw * age * Math.max(0, 1 - age / 12) + 1.5 * Math.max(0, age - 5) ** 2 * 0.5;
      const str = Math.min(1, age / 2) * Math.min(1, (9 - age) / 2.5) * (0.6 + 0.4 * ((h * 13.7) % 1));
      const la = lat * D2R, lo = lon * D2R;
      out.push([Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo), hs * Math.max(str, 0.01)]);
    }
  }
  return out.length ? out : null;
}

// ---------- Kepler ----------
// an orbit whose elements are given in the plane of the sky (visual binaries, the S-stars): x north, y east, z away
export function skyToFrame(sky, r) { const x = r[0], y = -r[2], z = r[1]; return [sky[0][0] * x + sky[1][0] * y + sky[2][0] * z, sky[0][1] * x + sky[1][1] * y + sky[2][1] * z, sky[0][2] * x + sky[1][2] * y + sky[2][2] * z]; }
// hyperbolic orbits (interstellar objects): position in the orbital plane at hyperbolic anomaly H
export function hypPlane(o, H) { const a = o.q / (o.e - 1); return [a * (o.e - Math.cosh(H)), a * Math.sqrt(o.e * o.e - 1) * Math.sinh(H)]; }
// hyperbolic anomaly at time t (s): solve e sinh H - H = n (t - tp)
export function hypAnomaly(o, t) {
  const M = o.n * (t - o.tp); let H = Math.asinh(M / o.e);
  for (let i = 0; i < 50; i++) { const dH = (o.e * Math.sinh(H) - H - M) / (o.e * Math.cosh(H) - 1); H -= dH; if (Math.abs(dH) < 1e-12) break; }
  return H;
}
export function keplerPos(o, t) {
  if (o.hyp) { const [xv, yv] = hypPlane(o, o.H !== undefined ? o.H : hypAnomaly(o, t)); return orbitToFrame(o, xv, yv, t); }
  // returns position in the orbit reference frame (y-up: orbital plane is XZ when i=0)
  let M = o.M0 + 2 * Math.PI * ((t / o.period) % 1);
  M = ((M % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;       // (-pi, pi]
  // Danby's starting guess converges for any eccentricity (a fixed start at pi fails for e near 1)
  const e = o.e; let E = M + 0.85 * e * Math.sign(Math.sin(M) || 1);
  for (let i = 0; i < 40; i++) { const f = E - e * Math.sin(E) - M, f1 = 1 - e * Math.cos(E), f2 = e * Math.sin(E), dE = f / (f1 - 0.5 * f * f2 / f1); E -= dE; if (Math.abs(dE) < 1e-13) break; }
  const xv = o.a * (Math.cos(E) - e), yv = o.a * Math.sqrt(1 - e * e) * Math.sin(E);
  return orbitToFrame(o, xv, yv, t);
}
function orbitToFrame(o, xv, yv, t) {
  // (apsidal precession, e.g. general relativity's for stars close to a black hole)
  const argp = o.argp + (o.argpDot ? o.argpDot * t : 0);
  const cw = Math.cos(argp), sw = Math.sin(argp), cO = Math.cos(o.node), sO = Math.sin(o.node), ci = Math.cos(o.inc), si = Math.sin(o.inc);
  const x = (cO * cw - sO * sw * ci) * xv + (-cO * sw - sO * cw * ci) * yv;
  const y = (sO * cw + cO * sw * ci) * xv + (-sO * sw + cO * cw * ci) * yv;
  const z = (sw * si) * xv + (cw * si) * yv;
  return [x, z, -y];
}

// ---------- Atmosphere model from physical parameters ----------
// gases: fractions by volume. Rayleigh cross section scale relative to air, molar mass (g/mol)
const GAS = { N2: [1.05, 28], O2: [0.87, 32], CO2: [2.4, 44], H2: [0.23, 2], He: [0.015, 4], CH4: [2.3, 16], Ar: [0.95, 40], H2O: [0.75, 18], SO2: [5, 64], NH3: [1.6, 17] };
export function makeAtmosphere(body, P /* Pa */, comp, opt = {}) {
  const g = C.G * body.mass / (body.radius * body.radius);
  let mu = 0, ray = 0, tot = 0;
  for (const k in comp) { mu += comp[k] * GAS[k][1]; ray += comp[k] * GAS[k][0]; tot += comp[k]; }
  mu /= tot; ray /= tot;
  const T = opt.T || body.temp || 250;
  const H = C.kB * T / (mu * 1.6605e-27 * g);
  const n = P / (C.kB * T);
  const k = n / 2.55e25 * ray; // relative to Earth sea level air
  const a = {
    P, comp, mu, T, H,
    hR: opt.hR || H, hM: opt.hM || H * 0.15,
    rayleigh: [5.802e-6 * k, 13.558e-6 * k, 33.1e-6 * k],
    mieS: opt.mieS || [3.996e-6 * Math.min(k, 3), 3.996e-6 * Math.min(k, 3), 3.996e-6 * Math.min(k, 3)],
    mieA: opt.mieA || [0.44e-6 * Math.min(k, 3), 0.44e-6 * Math.min(k, 3), 0.44e-6 * Math.min(k, 3)],
    mieG: opt.mieG || [0.8, 0.8, 0.8],
    absorb: opt.absorb || [0, 0, 0], absH: opt.absH || 25000, absW: opt.absW || 15000,
    clouds: opt.clouds || null,
  };
  if (comp.O2 > 0.05 && !opt.absorb) { const o = comp.O2 / 0.21 * Math.min(k, 2); a.absorb = [0.650e-6 * o, 1.881e-6 * o, 0.085e-6 * o]; a.absH = 3.1 * a.hR; a.absW = 1.9 * a.hR; }
  // top of atmosphere where density is negligible
  a.top = opt.top || Math.max(a.hR * 12, a.hM * 14);
  return a;
}

// ---------- Surface presets (uniforms of the terrain generator) ----------
function col(r, g, b) { return [r, g, b]; }
function vary(rng, c, amt) { return [clamp(c[0] * (1 + rng.range(-amt, amt)), 0, 1), clamp(c[1] * (1 + rng.range(-amt, amt)), 0, 1), clamp(c[2] * (1 + rng.range(-amt, amt)), 0, 1)]; }
export function surfacePreset(cls, rng, b) {
  const R = b.radius;
  // relief scales down with gravity and body size
  const g = C.G * b.mass / (R * R), gs = clamp(Math.pow(9.8 / g, 0.6), 0.5, 5) * clamp(R / 6.37e6, 0.02, 1.5);
  const s = {
    gen: 'terra', seed: [rng.range(0, 1000), rng.range(0, 1000), rng.range(0, 1000)], freq: rng.range(1.0, 1.9),
    contAmp: 2600 * gs, mtnAmp: 7000 * gs, hillAmp: 500 * gs, warp: 0.25, sea: -1e9, ocean: 0,
    crater: 0, craterAmp: 1, maria: 0, cracks: 0, dunes: 0, volcano: 0, lava: 0, rough: 1,
    colA: col(0.25, 0.22, 0.2), colB: col(0.18, 0.16, 0.15), colRock: col(0.12, 0.11, 0.1), colLow: col(0.08, 0.08, 0.08), colIce: col(0.85, 0.88, 0.92),
    colVeg1: col(0.09, 0.14, 0.03), colVeg2: col(0.022, 0.05, 0.012), colSand: col(0.42, 0.34, 0.21), colCrack: col(0.3, 0.12, 0.06),
    veg: 0, iceLat: 2, snowLine: 1e9, tempEq: b.temp || 200, lunar: 1, city: 0, spec: 0, hmin: -8000 * gs, hmax: 12000 * gs,
  };
  switch (cls) {
    case 'terra':
      Object.assign(s, { ocean: 1, sea: 0, veg: 1, lunar: 0, contAmp: 2900 * gs, mtnAmp: 7500 * gs, iceLat: 0.92, snowLine: 4800, colA: col(0.24, 0.19, 0.11), colB: col(0.3, 0.24, 0.15), colRock: col(0.16, 0.14, 0.12), colLow: col(0.25, 0.21, 0.14) });
      break;
    case 'ocean':
      Object.assign(s, { ocean: 1, sea: 2500 * gs, veg: 0.6, lunar: 0, iceLat: 0.9, snowLine: 4000, colA: col(0.24, 0.19, 0.11), colB: col(0.3, 0.24, 0.15) });
      break;
    case 'desert':
      Object.assign(s, { lunar: 0.2, crater: 0.35, dunes: 1, iceLat: 0.93, colA: vary(rng, col(0.38, 0.19, 0.09), 0.25), colB: vary(rng, col(0.25, 0.13, 0.07), 0.25), colRock: col(0.14, 0.08, 0.05), colLow: vary(rng, col(0.2, 0.12, 0.08), 0.2), colSand: vary(rng, col(0.45, 0.26, 0.13), 0.2), volcano: 0.5 });
      break;
    case 'venus':
      Object.assign(s, { lunar: 0, crater: 0.05, contAmp: 1500 * gs, mtnAmp: 5000 * gs, colA: col(0.3, 0.2, 0.1), colB: col(0.22, 0.14, 0.07), colRock: col(0.12, 0.08, 0.05), colLow: col(0.2, 0.13, 0.07), volcano: 1 });
      break;
    case 'selena': {
      const tone = rng.range(0.6, 1.3), warm = rng.range(-0.1, 0.25);
      Object.assign(s, { crater: 1, maria: rng.range(0, 1), contAmp: 1800 * gs, mtnAmp: 2500 * gs, hillAmp: 300 * gs, warp: 0.1,
        colA: col(0.2 * tone * (1 + warm), 0.19 * tone, 0.18 * tone * (1 - warm)), colB: col(0.14 * tone * (1 + warm), 0.135 * tone, 0.13 * tone * (1 - warm)), colRock: col(0.11 * tone, 0.105 * tone, 0.1 * tone), colLow: col(0.055 * tone, 0.055 * tone, 0.06 * tone) });
      break;
    }
    case 'ice': {
      const tint = rng.pick([[1, 1, 1], [1, 0.95, 0.88], [0.9, 0.95, 1], [1, 0.9, 0.8]]);
      Object.assign(s, { crater: rng.range(0.1, 0.9), cracks: rng.range(0.2, 1), contAmp: 900 * gs, mtnAmp: 2600 * gs, hillAmp: 420 * gs, spec: 0.3,
        colA: col(0.75 * tint[0], 0.75 * tint[1], 0.75 * tint[2]), colB: col(0.55 * tint[0], 0.55 * tint[1], 0.55 * tint[2]), colRock: col(0.4, 0.38, 0.36), colLow: col(0.5 * tint[0], 0.48 * tint[1], 0.46 * tint[2]), colCrack: vary(rng, col(0.35, 0.18, 0.1), 0.3), iceLat: 2 });
      break;
    }
    case 'lava':
      Object.assign(s, { lava: 1, crater: 0.2, volcano: 1, colA: col(0.06, 0.05, 0.05), colB: col(0.03, 0.028, 0.03), colRock: col(0.05, 0.045, 0.04), colLow: col(0.02, 0.02, 0.02), lunar: 0.5 });
      break;
    case 'io':
      Object.assign(s, { crater: 0, volcano: 1.5, lava: 0.15, contAmp: 800 * gs, mtnAmp: 5000 * gs, colA: col(0.75, 0.62, 0.2), colB: col(0.6, 0.35, 0.1), colRock: col(0.25, 0.2, 0.1), colLow: col(0.8, 0.75, 0.55), colCrack: col(0.05, 0.04, 0.03), lunar: 0.6 });
      break;
    case 'titan':
      Object.assign(s, { lunar: 0, dunes: 1, crater: 0.05, contAmp: 500 * gs, mtnAmp: 1500 * gs, ocean: 1, sea: -500 * gs, colA: col(0.3, 0.2, 0.1), colB: col(0.2, 0.13, 0.06), colRock: col(0.35, 0.3, 0.25), colLow: col(0.1, 0.07, 0.04) });
      break;
    case 'asteroid': {
      const tone = rng.range(0.4, 1.2);
      Object.assign(s, { crater: 1, contAmp: R * 0.22, mtnAmp: R * 0.1, hillAmp: R * 0.02, freq: 1.0, warp: 0.3, hmin: -R * 0.4, hmax: R * 0.4,
        colA: col(0.12 * tone, 0.11 * tone, 0.1 * tone), colB: col(0.08 * tone, 0.075 * tone, 0.07 * tone), colRock: col(0.07 * tone, 0.065 * tone, 0.06 * tone), colLow: col(0.09 * tone, 0.085 * tone, 0.08 * tone) });
      break;
    }
  }
  return s;
}

function gasPreset(kind, rng, b) {
  // kind: 'jupiter','saturn','uranus','neptune','hot','brown'
  const pal = {
    jupiter: [col(0.62, 0.5, 0.36), col(0.8, 0.74, 0.62), col(0.45, 0.26, 0.14), col(0.88, 0.84, 0.76)],
    saturn: [col(0.78, 0.66, 0.42), col(0.86, 0.78, 0.56), col(0.66, 0.54, 0.34), col(0.9, 0.84, 0.66)],
    uranus: [col(0.52, 0.76, 0.8), col(0.56, 0.8, 0.83), col(0.5, 0.74, 0.79), col(0.6, 0.82, 0.85)],
    neptune: [col(0.14, 0.26, 0.66), col(0.2, 0.36, 0.8), col(0.1, 0.2, 0.55), col(0.3, 0.46, 0.85)],
    hot: [col(0.12, 0.1, 0.16), col(0.25, 0.16, 0.2), col(0.06, 0.06, 0.1), col(0.35, 0.22, 0.18)],
    brown: [col(0.25, 0.08, 0.05), col(0.4, 0.14, 0.07), col(0.12, 0.04, 0.03), col(0.5, 0.2, 0.1)],
    cloudy: [col(0.75, 0.74, 0.72), col(0.9, 0.9, 0.88), col(0.6, 0.6, 0.62), col(0.82, 0.8, 0.76)],
    sulfur: [col(0.7, 0.6, 0.3), col(0.85, 0.75, 0.45), col(0.5, 0.36, 0.18), col(0.9, 0.82, 0.6)],
  }[kind];
  const str = { jupiter: 1, saturn: 0.45, uranus: 0.08, neptune: 0.35, hot: 1, brown: 1, cloudy: 0.6, sulfur: 0.5 }[kind];
  return {
    gen: 'gas', seed: [rng.range(0, 1000), rng.range(0, 1000), rng.range(0, 1000)], freq: 1,
    pal: pal.map(c => vary(rng, c, b.real ? 0 : 0.12)), bands: rng.range(5, 12) * (kind === 'saturn' ? 1.3 : 1), bandStr: str, turb: rng.range(0.5, 1.2) * str, storms: kind === 'jupiter' ? 1 : rng.range(0, 0.7) * str,
    hmin: 0, hmax: 0, lunar: 0, emis: kind === 'brown' ? 1 : (kind === 'hot' ? 0.3 : 0),
  };
}

// ---------- Body construction ----------
let bodyCounter = 0;
export function body(props) {
  const b = Object.assign({ uid: ++bodyCounter, children: [], pos: [0, 0, 0], rotAngle: 0, albedo: 0.3, tilt: 0, poleLon: 0, rotPeriod: 86400, temp: 200, atmo: null, rings: null, surface: null }, props);
  return b;
}
function addChild(parent, child) { child.parent = parent; parent.children.push(child); return child; }
function orbit(aAU, e, inc, node, peri /* longitude of perihelion */, L /* mean longitude */, parentMass, childMass = 0) {
  const a = aAU * C.AU;
  return { a, e, inc: inc * D2R, node: node * D2R, argp: (peri - node) * D2R, M0: (L - peri) * D2R, period: 2 * Math.PI * Math.sqrt(a * a * a / (C.G * (parentMass + childMass))) };
}
function moonOrbit(aKm, e, inc, parentMass, rng, M0) {
  const a = aKm * 1e3;
  return { a, e, inc: inc * D2R, node: rng.range(0, 6.28), argp: rng.range(0, 6.28), M0: M0 !== undefined ? M0 : rng.range(0, 6.28), period: 2 * Math.PI * Math.sqrt(a * a * a / (C.G * parentMass)) };
}

export class StarSystem {
  constructor(desc) {
    this.desc = desc; this.seed = desc.seed; this.galaxy = desc.galaxy;
    this.posLocal = desc.pos.slice();         // pc, galaxy local (pattern) frame; moves with time
    this.quat = Q.ident();                    // system frame -> galaxy local frame
    this.bodies = []; this.stars = []; this.root = null; this.belts = [];
    if (desc.sol) buildSol(this); else buildProcedural(this);
    // system frame -> universe axes. Systems keep an inertial orientation while the spiral pattern turns.
    this.worldQ = Q.mul(galQuat0(this.galaxy), this.quat);
    this.posGu = Q.rot(galQuat0(this.galaxy), this.posLocal);     // pc, universe axes, relative to galaxy centre
    this.flatten();
    this.update(0);
  }
  flatten() {
    this.bodies = []; this.stars = [];
    const rec = (b, depth) => { b.depth = depth; b.system = this; this.bodies.push(b); if (b.kind === 'star') this.stars.push(b); b.children.sort((x, y) => (x.orbit ? x.orbit.a : 0) - (y.orbit ? y.orbit.a : 0)); for (const c of b.children) rec(c, depth + 1); };
    rec(this.root, 0);
    for (const b of this.bodies) {
      // rotation frame: pole direction in system frame
      const ob = b.tilt * D2R, lon = b.poleLon * D2R;
      let pole = [Math.sin(ob) * Math.cos(lon), Math.cos(ob), -Math.sin(ob) * Math.sin(lon)];
      if (b.orbit && b.kind !== 'star' && !b.poleAbs) {
        // tilt relative to own orbital plane normal
        const o = b.orbit; const n = [Math.sin(o.inc) * Math.sin(o.node), Math.cos(o.inc), Math.sin(o.inc) * Math.cos(o.node)];
        const qn = Q.look([n[0] === 0 && n[2] === 0 ? 1 : -n[2], 0, n[0] === 0 && n[2] === 0 ? 0 : n[0]], n);
        pole = Q.rot(qn, [Math.sin(ob) * Math.cos(lon), Math.cos(ob), -Math.sin(ob) * Math.sin(lon)]);
      }
      if (b.poleRD) pole = eqToEngine(b.poleRD[0], b.poleRD[1]);
      else if (b.poleEcl) { const lo = b.poleEcl[0] * D2R, la = b.poleEcl[1] * D2R; pole = [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)]; }
      if (b.parent && b.parent.axisQ && b.equatorial) pole = Q.rot(b.parent.axisQ, [Math.sin(ob) * Math.cos(lon), Math.cos(ob), -Math.sin(ob) * Math.sin(lon)]);
      b.pole = V.norm(pole);
      const x = Math.abs(b.pole[1]) > 0.9999 ? [1, 0, 0] : V.norm(V.cross([0, 1, 0], b.pole));
      const z = V.cross(x, b.pole);
      b.axisQ = Q.fromBasis(x, b.pole, z);
      if (b.iauW && b.poleRD) {
        // offset between our longitude-0 reference and the IAU node, so prime meridians match real maps
        const qd = iauNode(b.poleRD[0], b.poleRD[1]), px = V.cross(b.pole, x);
        b.iauPhi = Math.atan2(V.dot(px, qd), V.dot(x, qd));
      }
    }
  }
  // t: seconds since J2000
  // move this system's stars along their evolutionary tracks; returns how much the planets' orbits have widened
  // red dwarf flares: magnetic reconnection on fully convective M dwarfs (Proxima Centauri flares several times a day;
  // a few times a year one brightens the star many-fold in visible light for minutes). Brightness multiplier at t (s).
  flareBoost(s, t, dt) {
    if (!(s.temp < 3900 && s.mass < 0.6 * C.Msun) || s.blackHole || s.neutron) return 1;
    if (Math.abs(dt) > 3 * 3600) return 1;            // faster than a few hours a frame: flares average out
    const seed = (s.uid || 1) * 0.6180339, bin = 3600 * 3, k = Math.floor(t / bin);
    let boost = 1;
    for (let j = k - 1; j <= k; j++) {
      const h = Math.abs(Math.sin((j + seed) * 12.9898) * 43758.5453) % 1;
      if (h > 0.55) continue;                         // ~45% of 3-hour bins hold a flare
      const t0 = (j + ((h * 977.3) % 1)) * bin, age = t - t0; if (age < 0) continue;
      const amp = 0.08 * Math.pow((h * 31.7) % 1 + 1e-3, -1.1);   // power law: mostly small, rarely huge
      boost += Math.min(amp, 70) * (age < 60 ? age / 60 : Math.exp(-(age - 60) / 600));
    }
    return boost;
  }
  evolveStars(tyr) {
    let scale = 1, changed = false;
    // (the whole system forms together: nothing is there before its primary star)
    const p0 = (this._allStars || this.stars)[0], r0 = p0 && p0.evo ? stellarState(p0, tyr) : null, sysUn = !!(r0 && r0.unborn); this.unborn = sysUn;
    // planets condense in the first few million years, inside the star's disk of gas and dust
    const age0 = p0 && p0.evo && p0.evo.x0 !== null ? p0.evo.x0 * p0.evo.life + tyr : 1e10, young = age0 < 5e6;
    for (const s of this._allStars || this.stars) {
      const e = s.evo; if (!e) continue;
      const st = stellarState(s, tyr); if (!st) continue;
      // rewound to before the star formed: it (and its planets) are not there yet
      const un = !!st.unborn || sysUn; if (!!s.gone !== un) { s.gone = un; changed = true; }
      s.unborn = un; s.nursery = st.nursery; s.ageYr = e.x0 !== null ? e.x0 * e.life + tyr : undefined;
      if (un) continue;
      s.lum = st.L; s.radius = st.R; s.temp = st.T; s.mass = st.m * C.Msun; s.evoPhase = st.phase; s.pnAge = st.pnAge; s.snrAge = st.snrAge;
      if (s.surface) s.surface.T = st.T;
      const bh = st.kind === KIND.BH, ns = st.kind === KIND.NS;
      if (!!s.blackHole !== bh) { s.blackHole = bh; if (bh) { s.accretion = 0; s.spin = s.spin || 0.7; s.rotPeriod = 0; } else s.rotPeriod = e.rot0 || s.rotPeriod; }
      if (!!s.neutron !== ns) { s.neutron = ns; s.pulsar = ns; if (ns) { e.rot0 = e.rot0 || s.rotPeriod; s.rotPeriod = 0.033; } else if (e.rot0) s.rotPeriod = e.rot0; }
      if (ns) { s.rotPeriod = pulsarPeriod(st.snrAge); s.pulsar = st.snrAge < 1e7; }
      s.cls = st.kind === e.kind0 && Math.abs(Math.log10(Math.max(st.L, 1e-30) / e.L0)) < 0.25 ? e.cls0 : st.phase.charAt(0).toUpperCase() + st.phase.slice(1);
      if (s === this.root) scale = e.m / Math.max(st.m, 0.05);
    }
    // planets inside a swollen star are swallowed; planets near a giant are heated until they glow
    const all = this._all || this.bodies, root = this.root;
    for (const b of root.children) {
      if (!b.orbit || b.kind === 'star') continue;
      const a = b.orbit.a * scale * (1 - (b.orbit.e || 0));
      const g = !!(root.evo && a < root.radius * 1.1) || sysUn || young; if (!!b.gone !== g) changed = true; b.gone = g;
      for (const c of b.children) { if (!!c.gone !== g) changed = true; c.gone = g; }
      const T = 278.6 * Math.pow(Math.max(root.lum, 0) * (1 - (b.albedo || 0.3)) / Math.pow(b.orbit.a * scale / C.AU, 2), 0.25);
      b.heatT = T > 700 && root.evo && root.lum > 1.5 * root.evo.L0 ? T : 0;
      // living, watery worlds respond like Earth: a brightening star dries the oceans and ends the biosphere
      if (b.surface && b.surface.gen === 'terra' && (b.surface.ocean > 0.5 || b.life) && root.evo) {
        const S = (root.lum / Math.max(root.evo.L0, 1e-12)) / (scale * scale);
        b.climate = S > 1 ? { S, dry: clamp((S - 1.09) / 0.12, 0, 1), life: 1 - clamp((S - 1.05) / 0.06, 0, 1), ice: 1 - clamp((S - 1.02) / 0.05, 0, 1) } : null;
      }
    }
    if (changed || !this._all) { this._all = all; this.bodies = all.filter(b => !b.gone); this.stars = this.bodies.filter(b => b.kind === 'star'); }
    return scale;
  }
  update(t) {
    this.time = t;
    // the star's motion through the galaxy
    const tyr = t / YEAR;
    if (this._ty !== tyr) { this._ty = tyr; this.posLocal = descPosP(this.desc, tyr); this.posGu = Q.rot(galQuat0(this.galaxy), toInertial(this.posLocal, tyr)); }
    // real stars with scheduled supernovae: afterwards the system holds the neutron star left behind
    if (this.desc.catIndex !== undefined) {
      const sn = SCHEDULED.find(x => x.i === this.desc.catIndex);
      if (sn && sn.tEm !== undefined) {
        const dead = tyr > sn.tEm, st = this.stars[0];
        // in the first year the star is an expanding fireball (seen from inside its own system, no light delay)
        const fb = dead ? fireball(tyr - sn.tEm) : null;
        if (st && fb) {
          st._orig = st._orig || { radius: st.radius, lum: st.lum, temp: st.temp, cls: st.cls, mass: st.mass };
          Object.assign(st, { radius: Math.max(fb.R, st._orig.radius), lum: fb.L, temp: fb.T, cls: sn.ibc ? 'Supernova (type Ib/c)' : 'Supernova (type II-P)', _remnant: false, neutron: false, pulsar: false, blackHole: false });
          // no spots on an explosion: large clumps from Rayleigh-Taylor mixing instead
          if (st.surface) { st.surface._orig = st.surface._orig || { gran: st.surface.gran, spots: st.surface.spots }; st.surface.gran = 3; st.surface.spots = 0; }
        } else if (st && dead !== !!st._remnant) {
          if (dead) { st._orig = st._orig || { radius: st.radius, lum: st.lum, temp: st.temp, cls: st.cls, mass: st.mass };
            // stars above ~20 solar masses leave a black hole, lighter ones a neutron star
            if (st._orig.mass > 20 * C.Msun || sn.ibc) { const mb = 0.35 * st._orig.mass; Object.assign(st, { radius: 2 * C.G * mb / (C.c * C.c), lum: 0, temp: 0, cls: 'Black hole (remnant of the supernova)', mass: mb, blackHole: true, accretion: 0, spin: 0.6, rotPeriod: 0, _remnant: true }); }
            else Object.assign(st, { radius: 12e3, lum: 4 * Math.PI * 12e3 ** 2 * C.sigma * 1e6 ** 4 / C.Lsun, temp: 1e6, cls: 'Neutron star (remnant of the supernova)', mass: 1.4 * C.Msun, neutron: true, pulsar: true, rotPeriod: 0.03, _remnant: true });
            if (st.surface) { st.surface._orig = st.surface._orig || { gran: st.surface.gran, spots: st.surface.spots }; st.surface.gran = 0; st.surface.spots = 0; }
          } else if (st._orig) { Object.assign(st, st._orig, { neutron: false, pulsar: false, blackHole: false, _remnant: false }); if (st.surface && st.surface._orig) Object.assign(st.surface, st.surface._orig); }
        }
        // (the new neutron star spins down and cools)
        if (st && st._remnant && st.neutron) { const age = tyr - sn.tEm; st.rotPeriod = pulsarPeriod(age); st.pulsar = age < 1e7; st.temp = Math.max(3e4, 1e6 * Math.pow(1 + age / 1e5, -0.3)); st.lum = 4 * Math.PI * 12e3 ** 2 * C.sigma * st.temp ** 4 / C.Lsun; }
      }
    }
    // the Sun's evolution, mass loss widening the orbits, Earth's precession and the Moon's recession
    let oScale = 1, mScale = 1; this.oScale = 1;
    if (this.desc.sol) {
      const ss = sunState(tyr), sun = this.root;
      this.sunState = ss;
      // before 4.57 Gyr ago there is no Sun yet: its gas is part of a molecular cloud (see the birth cloud in render.js)
      { const un = ss.age < 0; if (!!sun.gone !== un) { sun.gone = un; this._sunChanged = true; } sun.unborn = un; }
      sun.evoPhase = ss.age < 0 ? 'not yet formed' : ss.age < 0.05 ? 'protostar, contracting towards the main sequence' : ss.phase; sun.ageYr = ss.age * 1e9;
      sun.radius = ss.R * C.Rsun; sun.lum = ss.L; sun.temp = ss.T; sun.mass = ss.M * C.Msun; sun.cls = ss.phase === 'Main sequence (G2V)' ? 'G2V' : ss.phase;
      // the ~11 year activity cycle, following the observed sunspot record since 1755 (see solarActivity): sunspots
      // and the aurora follow it. Earth's field reverses now and then; while it is weak the aurora spreads equatorward.
      // (younger, it spun faster and was far more active: rotation ~ age^0.5 (Skumanich 1972), activity ~ 1/age)
      const youth = ss.age > 0.01 && ss.age < 10 ? 4.57 / ss.age : 1;
      if (ss.age > 0.01 && ss.age < 10) sun.rotPeriod = 25.38 * 86400 / Math.sqrt(youth);
      const act = solarActivity(tyr) * Math.min(youth, 4) + (youth > 1.5 ? 0.3 * Math.min(youth - 1, 3) : 0);
      this.activity = act;
      sun.surface.gran = ss.R > 4 ? 3 : 0; sun.surface.spots = ss.R > 4 || ss.R < 0.1 ? 0 : Math.min(1.4, 0.06 + 0.88 * act); sun.whiteDwarf = ss.R < 0.05;
      const earthB = this.root.children.find(b => b.name === 'Earth');
      if (earthB) {
        const gm = geomagnetic(tyr); earthB.geomag = gm;
        if (!earthB.magPole0) earthB.magPole0 = earthB.magPole;
        if (earthB.magPole0) earthB.magPole = gm.normal ? earthB.magPole0 : earthB.magPole0.map(x => -x);
        earthB.aurora = (0.35 + 0.9 * act) * (gm.B < 0.5 ? 1.4 : 1); earthB.auroraB = gm.B;
      }
      oScale = orbitScale(tyr); mScale = moonScale(tyr); this.oScale = oScale;
      let changed = !!this._sunChanged; this._sunChanged = false;
      for (const b of this.root.children) if (b.kind !== "barycenter") { const g = engulfed(b.name, tyr); if (!!b.gone !== g) changed = true; b.gone = g; for (const c of b.children) { const gc = g || engulfed(c.name, tyr); if (!!c.gone !== gc) changed = true; c.gone = gc; } }
      // tidal decay: Phobos breaks up into a ring around Mars in ~40 Myr (Black & Mittal 2015); Triton, on a retrograde
      // orbit, is torn apart inside Neptune's Roche limit in ~3.6 Gyr. The debris rings last ~100 Myr / ~1 Gyr here.
      const all = this._all || this.bodies;
      for (const [moon, planet, t0, life, ring] of [['Phobos', 'Mars', 4e7, 1e8, [1.1, 1.65, [0.45, 0.37, 0.31]]], ['Triton', 'Neptune', 3.6e9, 1e9, [1.5, 2.4, [0.62, 0.62, 0.64]]]]) {
        const m = all.find(b => b.name === moon), p = all.find(b => b.name === planet); if (!m || !p) continue;
        const g = tyr > t0 || p.gone; if (!!m.gone !== g) { m.gone = g; changed = true; }
        const age = tyr - t0;
        if (age > 0 && age < life && !p.gone) {
          if (!p._debrisRing) p._debrisRing = { inner: ring[0] * p.radius, outer: ring[1] * p.radius, opacity: 0.6, color: ring[2], seed: 17, kind: 'debris' };
          p._debrisRing.opacity = 0.45 * (1 - age / life); if (!p.rings || p.rings === p._debrisRing) p.rings = p._debrisRing;
        } else if (p.rings && p.rings === p._debrisRing) p.rings = null;
      }
      // Saturn's rings rain onto the planet (water ice pulled in along magnetic field lines and by drag): at the
      // measured rate they are gone in ~300 Myr (O'Donoghue et al. 2018, 2019)
      // early Mars: an ocean filled the northern lowlands to about the Deuteronilus shoreline (-3,800 m) around 3.8 Gyr
      // ago, then shrank into the deepest basins and was gone by ~3 Gyr ago (an active research question)
      const mars = all.find(b => b.name === 'Mars');
      // Mars' seasonal polar caps: carbon dioxide frost spreads to ~55 degrees latitude in each winter and sublimates
      // back to the small residual cap by midsummer (the season from the Sun's direction relative to the axis)
      if (mars && mars.axisQ && this.root) {
        const sd = V.norm(V.sub(this.root.pos, mars.pos)), sz = V.dot(sd, Q.rot(mars.axisQ, [0, 1, 0])) / Math.sin((mars.tilt || 25.19) * D2R);
        const ns = clamp(sz, -1, 1);       // +1 northern summer solstice
        mars.caps = [72 + 12 * ns, -(72 - 14 * ns)];
      }
      // global dust storms: dust lifted near perihelion (southern summer) can spread around the planet in two weeks and
      // hide the surface for months (optical depth ~0.5 -> 5+). The observed ones: 1971 (Mariner 9 arrived in it), two
      // in 1977, 1982, 2001, 2007 and 2018 (which ended the Opportunity rover); elsewhere about one Mars year in three.
      if (mars) mars.dust = marsDust(2000 + tyr);
      // Halley's comet returns on its real dates (planetary perturbations make the period 74-79 years)
      { const h = all.find(b => b.name === "Halley's Comet"); if (h) halleyOrbit(h.orbit, 2000 + tyr); }
      if (mars) mars.paleoSea = tyr > -4.1e9 && tyr < -3.0e9 ? (tyr < -3.6e9 ? -3800 : -3800 - 3000 * (tyr + 3.6e9) / 0.6e9) : undefined;
      // Comet Shoemaker-Levy 9's fragments (G, K, L, H, Q1, R hit hardest) struck Jupiter at 44 S on 16-22 July 1994;
      // their dark scars, larger than Earth, spread and faded over months (System II longitudes; fresh scar w -> 0)
      if (this.longComets) for (let k = 0; k < this.longComets.length; k++) {
        const cm = this.longComets[k], n = Math.floor((tyr + k * 1.5) / 6);
        if (cm._epoch === n) continue;
        cm._epoch = n;
        let sd = (n * 7919 + k * 104729) >>> 0; const rnd = () => { sd = (Math.imul(sd, 1103515245) + 12345) >>> 0; return sd / 4294967296; };
        const q = (0.3 + 1.2 * rnd()) * C.AU, e = 0.9995, a = q / (1 - e), P = 2 * Math.PI * Math.sqrt(a ** 3 / (C.G * C.Msun));
        let tp = (n * 6 - k * 1.5 + 6 * rnd()) * C.YEAR;     // perihelion time (s from J2000)
        // (no invented comets within a century of the present: the real sky has its own)
        if (Math.abs(tp / C.YEAR - 26.8) < 100) tp = 1e9 * C.YEAR;
        Object.assign(cm.orbit, { a, e, inc: Math.acos(1 - 2 * rnd()), node: rnd() * 2 * Math.PI, argp: rnd() * 2 * Math.PI, M0: -2 * Math.PI * ((tp / P) % 1), period: P });
        const yr = Math.floor(2000 + tp / C.YEAR), L = 'ABCDEFGHJKLMNOPQRSTUVWXY'[Math.floor(rnd() * 24)];
        cm.name = 'Comet C/' + yr + ' ' + L + (1 + Math.floor(rnd() * 4));
      }
      // the Moon's history: a magma ocean for its first ~100 Myr, then bright highlands, then the maria flooding 3.9-3.1 Gyr ago
      const moonB = all.find(b => b.name === 'Moon');
      if (moonB) { moonB.mariaFill = clamp((tyr + 3.9e9) / 0.8e9, 0, 1); const mg = clamp((-4.42e9 - tyr) / 5e7, 0, 1); if (mg > 0) { moonB.heatT = 1200 + 500 * mg; moonB._mh = true; } else if (moonB._mh) { moonB.heatT = 0; moonB._mh = false; } }
      const jup = all.find(b => b.name === 'Jupiter');
      if (jup) {
        const t94 = (t / 86400) - (Date.UTC(1994, 6, 16) - Date.UTC(2000, 0, 1, 12)) / 864e5;    // days since 16 July 1994
        if (t94 > -1 && t94 < 400) {
          const hits = [[2.0, 25], [2.8, 55], [3.0, 120], [1.6, 160], [4.2, 230], [5.5, 300]];
          jup.scars = hits.filter(([d]) => t94 > d).map(([d, lon]) => { const la = -44 * D2R, lo = lon * D2R, age = t94 - d; return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo), Math.min(0.95, age / 300)]; });
          if (!jup.scars.length) jup.scars = null;
        } else jup.scars = null;
      }
      const sat = all.find(b => b.name === 'Saturn');
      // (and young: Cassini's dust-pollution clock says they formed 100-400 Myr ago, Kempf et al. 2023)
      if (sat) { if (sat._rings0 === undefined) sat._rings0 = sat.rings; const f = clamp(1 - tyr / 3e8, 0, 1) * clamp((tyr + 4e8) / 2.5e8, 0, 1); if (sat._rings0) sat._rings0.fade = f; sat.rings = f > 0.01 ? sat._rings0 : null; }
      if (changed || !this._all) { this._all = this._all || this.bodies; this.bodies = this._all.filter(b => !b.gone); this.stars = this.bodies.filter(b => b.kind === 'star'); }
      // surfaces heated by the giant Sun glow
      if (ss.L > 1.5) { for (const b of this.root.children) if (b.orbit && !b.gone) { const T = planetTeq(b.name, tyr, b.albedo || 0.3, b.orbit.a / C.AU) * (b.atmo && b.atmo.P > 5e4 ? 1.2 : 1); b.heatT = T > 700 ? T : 0; } }
      else if (this._heated !== false) { for (const b of this.root.children) b.heatT = 0; }
      this._heated = ss.L > 1.5;
    } else if (!this.sandbox && !this._snFixed) {
      // every other star ages too: main sequence, giant, then white dwarf, neutron star or black hole
      if (!this._evoInit) {
        this._evoInit = true; this._allStars = this.stars.slice();
        // the primary's age is shared by its companions (stars of one system form together)
        const p0 = this.stars[0], known = p0 && KNOWN_AGE[(p0.name || '').toLowerCase()];
        initEvolution(p0, this.seed || 1, known && p0.star && p0.star.kind === KIND.MS ? known * 1e9 : 0);
        let age0 = known ? known * 1e9 : p0 && p0.evo && p0.evo.x0 !== null ? p0.evo.x0 * p0.evo.life : 0;
        // a white dwarf companion (Sirius B, Procyon B) came from a heavier star that has already lived and died: the
        // system is at least that old
        if (age0 && !known && p0.evo.x0 < 1) for (const s of this.stars.slice(1)) if (s.star && s.star.kind === KIND.WD) {
          const need = tMS(wdProgenitor(s.mass / C.Msun)) + 3e7;
          if (age0 < need) { age0 = Math.min(need * (1.2 + 0.8 * ((this.seed || 1) % 97) / 97), 0.95 * p0.evo.life); p0.evo.x0 = age0 / p0.evo.life; }
        }
        this.stars.forEach((s, i) => { if (i) initEvolution(s, (this.seed || 1) + i * 977, age0); }); this._snFixed = this.desc.catIndex !== undefined && SCHEDULED.some(x => x.i === this.desc.catIndex); }
      const ran = !this._snFixed && this._evoT !== tyr;
      if (ran) { this._evoT = tyr; oScale = this.evolveStars(tyr); this._evoScale = oScale; }
      else oScale = this._evoScale || 1;
      this.oScale = oScale;
      for (const s of this.stars) { if (s._lumBase === undefined || ran) s._lumBase = s.lum; const f = this.flareBoost(s, t, (t - (this._lastT || t))); s.lum = s._lumBase * f; s.flaring = f > 1.05 ? f : 0; }
      this._lastT = t;
    }
    const rec = (b) => {
      if (b.ephem === 'planet' && b.parent) {
        const p = planetPos(b.name, t), pp = b.parent.pos; b.pos = [pp[0] + p[0] * oScale, pp[1] + p[1] * oScale, pp[2] + p[2] * oScale];
      } else if (b.ephem === 'moon' && b.parent) {
        // the Moon from lunar theory; Earth itself sits off the Earth-Moon barycentre
        const g = V.mul(moonPos(t), mScale), mu = b.mass / (b.mass + b.parent.mass), ep = b.parent.pos;
        b.parent.pos = [ep[0] - g[0] * mu, ep[1] - g[1] * mu, ep[2] - g[2] * mu];
        b.parent.wpos = Q.rot(this.worldQ, b.parent.pos);
        b.pos = [b.parent.pos[0] + g[0], b.parent.pos[1] + g[1], b.parent.pos[2] + g[2]];
      } else if (b.ephem === 'galilean' && b.parent) {
        // position angle from superior conjunction as seen from Earth, in Jupiter's equatorial plane
        const par = b.parent;
        if (!this._gal || this._galT !== t) { this._gal = galilean(t); this._galT = t; }
        const [u, rr] = this._gal[b.galIndex];
        const earth = this.find('Earth');
        const pole = Q.rot(par.axisQ, [0, 1, 0]);
        let sdir = V.sub(par.pos, earth ? earth.pos : [0, 0, 0]); sdir = V.norm(V.sub(sdir, V.mul(pole, V.dot(sdir, pole))));
        const tdir = V.cross(pole, sdir);
        const p = V.mul(V.add(V.mul(sdir, Math.cos(u)), V.mul(tdir, Math.sin(u))), rr * 71492e3);
        b.pos = [par.pos[0] + p[0], par.pos[1] + p[1], par.pos[2] + p[2]];
      } else if (b.orbit && b.parent) {
        let p = keplerPos(b.orbit, t);
        if (b.orbit.sky) p = skyToFrame(b.orbit.sky, p);
        if (b.parent === this.root && oScale !== 1) p = V.mul(p, oScale);
        if (b.equatorial && b.parent.axisQ) p = Q.rot(b.parent.axisQ, p);
        const pp = b.parent.pos; b.pos = [pp[0] + p[0], pp[1] + p[1], pp[2] + p[2]];
      } else if (!b.parent) b.pos = [0, 0, 0];
      b.rotAngle = b.rotPeriod ? ((b.rot0 || 0) + 2 * Math.PI * ((t / b.rotPeriod) % 1)) : 0;
      if (b.iauW) b.rotAngle = ((b.iauW[0] + b.iauW[1] * (t / 86400)) % 360) * D2R + (b.iauPhi || 0);
      // Earth: the pole precesses around the ecliptic pole (25,772 yr) and nods with the obliquity cycle; the
      // sidereal angle is measured from the equinox of date, which the body frame follows. The day lengthens as
      // tides transfer angular momentum to the Moon.
      if (b.precessRA) {
        const pole = earthPole(tyr), x = V.norm(V.cross([0, 1, 0], pole));
        b.pole = pole; b.axisQ = Q.fromBasis(x, pole, V.cross(x, pole));
        const P = earthDay(tyr); b.rotPeriod = P;
        b.rotAngle = (b.rot0 || 0) + 2 * Math.PI * (((t / P) % 1) + 1);
        b.climate = earthClimate(tyr);
        // glacial cycles paced by the orbit (Milankovitch); none once the brightening Sun has melted the ice
        // (no weather clouds over a magma ocean or once the oceans have boiled away)
        b.noClouds = b.climate.magma > 0 || b.climate.dry > 0.9;
        b.cyclones = tropicalCyclones(t, b.solarLon || 0, b.climate);
        // the Chicxulub impact, 66.043 Myr ago (Renne et al. 2013), at 21.4 N 89.5 W today; in the PALEOMAP frame the
        // globe shows then, Yucatan sat at about 24.4 N 66.5 W
        { const ageH = (t / YEAR - KPG_YR) * 8766; if (ageH > 0 && ageH < 8766 * 15) { const la = 24.4 * D2R, lo = -66.5 * D2R; b.impact = [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo), ageH]; if (ageH < 30) b.noClouds = true; } else b.impact = null; }
        b.iceAge = b.climate.snowball ? 3 : iceAge(tyr) * b.climate.ice; b.orbitE = earthOrbitAt(tyr).e;
        b.meanT = earthMeanT(tyr, b.climate, b.climate.snowball ? 0 : iceAge(tyr) * b.climate.ice); b.air = earthAir(tyr); b.lifeNow = earthLife(tyr, b.climate);
        // (the young Earth glows: a magma ocean before its crust formed)
        if (b.climate.magma > 0) { b.heatT = 1300 + 600 * b.climate.magma; b._magmaHeat = true; } else if (b._magmaHeat) { b.heatT = 0; b._magmaHeat = false; }
        b.drift = driftMyr(tyr); b.paleoMyr = tyr < -PALEO_START * 1e6 ? -tyr / 1e6 : 0;
      }
      // sea ice follows the seasons (lagging the solstices): the Arctic peaks in March and is smallest in September,
      // the Antarctic the other way round; the Sun's longitude from the equinox of date sets the phase
      if (b.precessRA && b.pole && this.stars[0]) {
        const sd = V.norm(V.sub(this.stars[0].pos, b.pos)), Ev = V.norm(V.cross(b.pole, [0, 1, 0])), Fv = V.cross([0, 1, 0], Ev);
        const lam = Math.atan2(V.dot(sd, Fv), V.dot(sd, Ev)), ar = 0.5 + 0.5 * Math.cos(lam - 350 * D2R), an = 0.5 + 0.5 * Math.cos(lam - 177 * D2R);
        b.solarLon = ((lam / D2R) + 360) % 360;
        b.seaIce = [80 - 16 * ar, -(71 - 13 * an)];
      }
      if (b.seasonal && this.stars[0]) {
        // -1 at the December solstice, +1 at the June solstice (sine of the sun's declination / sine of obliquity)
        const sd = V.norm(V.sub(this.stars[0].pos, b.pos));
        b.season = V.dot(sd, Q.rot(b.axisQ, [0, 1, 0])) / Math.sin(b.tilt * D2R);
      }
      if (b.faceParent && b.parent && b.axisQ) {
        // point longitude 0 at the parent (mean sub-planet point of a tidally locked moon)
        const toP = Q.rot(Q.conj(b.axisQ), V.sub(b.parent.pos, b.pos));
        b.rotAngle = Math.atan2(-toP[2], toP[0]);
      }
      b.rotQ = Q.mul(b.axisQ, Q.axis([0, 1, 0], b.rotAngle));
      b.wpos = Q.rot(this.worldQ, b.pos); b.wrot = Q.mul(this.worldQ, b.rotQ);
      for (const c of b.children) rec(c);
    };
    rec(this.root);
  }
  find(name) { name = name.toLowerCase(); return this.bodies.find(b => b.name.toLowerCase() === name); }
}

// ---------- The Solar System ----------
function buildSol(sys) {
  sys.name = 'Solar System';
  // system frame: ecliptic (y = ecliptic north, x = vernal equinox). Orient relative to the galaxy.
  const xg = galDir(96.337, -60.189), yg = galDir(96.38, 29.81);
  const zg = V.cross(xg, yg);
  sys.quat = Q.fromBasis(V.norm(xg), V.norm(yg), V.norm(zg));
  const rng = new RNG(4242);
  const sunStar = makeStar(4.83, 0.9, 0.5, false);
  const sun = body({ name: 'Sun', kind: 'star', cls: 'G2V', star: sunStar, mass: C.Msun, radius: C.Rsun, temp: 5772, lum: 1, rotPeriod: 25.38 * C.DAY, tilt: 7.25, poleLon: 75.8 - 90, poleAbs: true, real: true });
  sun.surface = { gen: 'star', seed: [1, 2, 3], freq: 1, T: 5772, spots: 0.5, hmin: 0, hmax: 0 };
  sys.root = sun;
  const P = (name, cls, aAU, e, i, node, peri, L, massE, radKm, rotH, tilt, albedo, temp, extra = {}) => {
    const b = body({ name, kind: 'planet', cls, mass: massE * C.Mearth, radius: radKm * 1e3, rotPeriod: rotH * 3600, tilt, albedo, temp, real: true, ...extra });
    b.orbit = orbit(aAU, e, i, node, peri, L, C.Msun, b.mass);
    // (the ephemeris moves the planet at its fitted mean motion: use that period, so time-lapses land on whole orbits)
    if (JPL[name]) b.orbit.period = 360 / JPL[name][1][3] * 36525 * 86400;
    return addChild(sun, b);
  };
  const Mn = (parent, name, cls, aKm, e, inc, massKg, radKm, albedo, extra = {}) => {
    const b = body({ name, kind: 'moon', cls, mass: massKg, radius: radKm * 1e3, albedo, temp: parent.temp * 0.9, equatorial: true, real: true, ...extra });
    b.orbit = moonOrbit(aKm, e, inc, parent.mass, rng); b.rotPeriod = b.orbit.period; b.faceParent = true; // tidally locked
    return addChild(parent, b);
  };
  // Mercury
  const mercury = P('Mercury', 'Selena', 0.38709927, 0.20563593, 7.00497902, 48.33076593, 77.45779628, 252.2503235, 0.0553, 2439.7, 1407.6, 0.034, 0.142, 440);
  mercury.surface = surfacePreset('selena', rng, mercury); Object.assign(mercury.surface, { maria: 0.25, colA: [0.17, 0.16, 0.15], colB: [0.12, 0.115, 0.11], colLow: [0.09, 0.088, 0.086] });
  // Venus
  const venus = P('Venus', 'Venusian', 0.72333566, 0.00677672, 3.39467605, 76.67984255, 131.60246718, 181.9790995, 0.815, 6051.8, -5832.5, 177.36, 0.76, 737);
  venus.surface = surfacePreset('venus', rng, venus);
  venus.atmo = makeAtmosphere(venus, 9.2e6, { CO2: 0.965, N2: 0.035 }, { T: 400, hR: 11200, top: 150000, mieS: [2e-5, 1.9e-5, 1.4e-5], mieA: [3e-7, 1.6e-6, 9e-6], hM: 12000,
    clouds: { base: 48000, top: 68000, cover: 1.0, density: 3.0, color: [1.0, 0.93, 0.72], kind: 'venus' } });
  // Earth
  const earth = P('Earth', 'Terra', 1.00000261, 0.01671123, -0.00001531, 0, 102.93768193, 100.46457166, 1, 6371, 23.9345, 23.4393, 0.3, 288, { poleLon: 90, poleAbs: true, life: true });
  earth.surface = surfacePreset('terra', rng, earth); earth.surface.city = 1; earth.surface.seed = [37.2, 91.7, 13.4]; earth.surface.tempEq = 300;
  earth.atmo = makeAtmosphere(earth, 101325, { N2: 0.78, O2: 0.21, Ar: 0.01 }, { T: 255, hR: 8000, hM: 1200, top: 100000, clouds: { base: 1500, top: 9000, cover: 0.44, density: 1, color: [1, 1, 1], kind: 'earth' } });
  earth.atmo.rayleigh = [5.802e-6, 13.558e-6, 33.1e-6]; earth.atmo.absorb = [0.650e-6, 1.881e-6, 0.085e-6]; earth.atmo.absH = 25000; earth.atmo.absW = 15000;
  const moon = Mn(earth, 'Moon', 'Selena', 384400, 0.0549, 5.145, 7.342e22, 1737.4, 0.12, { equatorial: false, tilt: 6.68 });
  moon.surface = surfacePreset('selena', rng, moon); Object.assign(moon.surface, { maria: 0.75, colA: [0.2, 0.195, 0.185], colB: [0.15, 0.145, 0.14], colLow: [0.062, 0.062, 0.066] });
  // Mars
  const mars = P('Mars', 'Desert', 1.52371034, 0.0933941, 1.84969142, 49.55953891, -23.94362959, -4.55343205, 0.107, 3389.5, 24.6229, 25.19, 0.17, 210, { poleEcl: [352.9, 63.3] });
  mars.surface = surfacePreset('desert', rng, mars); Object.assign(mars.surface, { colA: [0.44, 0.21, 0.09], colB: [0.2, 0.09, 0.045], colLow: [0.11, 0.06, 0.04], colSand: [0.5, 0.27, 0.13], iceLat: 0.955, mtnAmp: 9000, contAmp: 3500 });
  mars.atmo = makeAtmosphere(mars, 636, { CO2: 0.95, N2: 0.03, Ar: 0.02 }, { T: 210, hR: 11100, hM: 11000, top: 120000, mieS: [1.3e-5, 1.05e-5, 0.65e-5], mieA: [0.04e-5, 0.2e-5, 0.6e-5], mieG: [0.72, 0.76, 0.86] });
  const ph = Mn(mars, 'Phobos', 'Asteroid', 9376, 0.0151, 1.08, 1.0659e16, 11.27, 0.07); ph.surface = surfacePreset('asteroid', rng, ph); ph.shape = [1.2, 0.8, 0.98];
  const de = Mn(mars, 'Deimos', 'Asteroid', 23463, 0.00033, 0.93, 1.4762e15, 6.2, 0.07); de.surface = surfacePreset('asteroid', rng, de); de.shape = [1.21, 0.89, 0.98];
  // Ceres
  const ceres = P('Ceres', 'Dwarf planet', 2.7675, 0.0758, 10.593, 80.3, 153.9, 95.99, 0.00016, 469.7, 9.07, 4, 0.09, 168, { kind: 'dwarf' });
  ceres.surface = surfacePreset('selena', rng, ceres); Object.assign(ceres.surface, { maria: 0.1, colA: [0.1, 0.098, 0.095], colB: [0.075, 0.073, 0.07] });
  // more minor bodies (orbital elements approximate; phases not exact)
  const minor = (name, cls, aAU, e, i, node, peri, L, massKg, radKm, rotH, albedo, preset, extra = {}) => {
    const b = P(name, cls, aAU, e, i, node, peri, L, massKg / C.Mearth, radKm, rotH, rng.range(0, 40), albedo, Math.round(278 / Math.sqrt(aAU) * Math.pow(1 - albedo, 0.25)), Object.assign({ kind: 'dwarf' }, extra));
    b.surface = surfacePreset(preset, rng, b); b.approxOrbit = true; return b;
  };
  minor('Vesta', 'Asteroid', 2.3615, 0.0902, 7.14, 103.7, 255.4, 120, 2.59e20, 262.7, 5.342, 0.42, 'selena');
  minor('Pallas', 'Asteroid', 2.7709, 0.2305, 34.93, 172.9, 123.8, 40, 2.04e20, 256, 7.81, 0.16, 'selena');
  minor('Hygiea', 'Asteroid', 3.1422, 0.1125, 3.83, 283.2, 235.5, 300, 8.3e19, 217, 13.8, 0.07, 'selena');
  minor('Juno', 'Asteroid', 2.669, 0.2562, 12.99, 169.8, 57.7, 210, 2.7e19, 123, 7.21, 0.24, 'asteroid');
  minor('Eros', 'Near-Earth asteroid', 1.458, 0.2229, 10.83, 304.3, 123.2, 70, 6.69e15, 8.4, 5.27, 0.25, 'asteroid', { shape: [2.05, 0.67, 0.67] });
  minor('Bennu', 'Near-Earth asteroid', 1.1264, 0.2037, 6.03, 2.06, 68.3, 160, 7.3e10, 0.245, 4.297, 0.044, 'asteroid');
  minor('Makemake', 'Dwarf planet', 45.43, 0.161, 28.98, 79.6, 376.8, 160, 3.1e21, 715, 22.8, 0.81, 'ice');
  minor('Haumea', 'Dwarf planet', 43.12, 0.195, 28.21, 121.9, 362.7, 200, 4.0e21, 780, 3.9, 0.8, 'ice', { shape: [1.35, 0.69, 1.08] });
  minor('Sedna', 'Trans-Neptunian object', 506, 0.855, 11.93, 144.5, 455.6, 358, 1e21, 500, 10.3, 0.32, 'ice');
  sys.belts.push({ name: 'Asteroid belt', inner: 2.1 * C.AU, outer: 3.3 * C.AU, thick: 0.12, count: 9000, seed: 11, parent: sun });
  // Jupiter
  const jup = P('Jupiter', 'Gas giant', 5.202887, 0.04838624, 1.30439695, 100.47390909, 14.72847983, 34.39644051, 317.83, 69911, 9.925, 3.13, 0.52, 165, { oblate: 0.0649 });
  jup.surface = gasPreset('jupiter', rng, jup); jup.surface.bands = 9;
  jup.atmo = makeAtmosphere(jup, 0.05e5, { H2: 0.9, He: 0.1 }, { T: 165, top: 500000, hM: 20000, mieS: [1e-7, 1e-7, 1e-7], mieA: [0, 0, 0] });
  jup.rings = { inner: 92000e3, outer: 129000e3, opacity: 0.003, color: [0.5, 0.4, 0.3], seed: 5, kind: 'faint' };
  const io = Mn(jup, 'Io', 'Volcanic', 421800, 0.0041, 0.036, 8.9319e22, 1821.6, 0.63); io.surface = surfacePreset('io', rng, io);
  const eu = Mn(jup, 'Europa', 'Ice world', 671100, 0.0094, 0.466, 4.7998e22, 1560.8, 0.67); eu.surface = surfacePreset('ice', rng, eu); Object.assign(eu.surface, { crater: 0.03, cracks: 1, contAmp: 120, mtnAmp: 200, hillAmp: 60, colA: [0.78, 0.75, 0.68], colB: [0.62, 0.55, 0.45], colCrack: [0.36, 0.2, 0.11] });
  const ga = Mn(jup, 'Ganymede', 'Ice world', 1070400, 0.0013, 0.177, 1.4819e23, 2634.1, 0.43); ga.surface = surfacePreset('ice', rng, ga); Object.assign(ga.surface, { crater: 0.7, cracks: 0.5, maria: 0.6, colA: [0.5, 0.47, 0.43], colB: [0.38, 0.35, 0.32], colLow: [0.2, 0.18, 0.16], colCrack: [0.6, 0.58, 0.55] });
  const ca = Mn(jup, 'Callisto', 'Ice world', 1882700, 0.0074, 0.192, 1.0759e23, 2410.3, 0.2); ca.surface = surfacePreset('ice', rng, ca); Object.assign(ca.surface, { crater: 1, cracks: 0, colA: [0.24, 0.21, 0.18], colB: [0.16, 0.14, 0.12], colLow: [0.13, 0.115, 0.1] });
  // Saturn
  const sat = P('Saturn', 'Gas giant', 9.53667594, 0.05386179, 2.48599187, 113.66242448, 92.59887831, 49.95424423, 95.16, 58232, 10.656, 26.73, 0.47, 134, { oblate: 0.098, poleEcl: [79.5, 61.9] });
  sat.surface = gasPreset('saturn', rng, sat);
  sat.atmo = makeAtmosphere(sat, 0.05e5, { H2: 0.96, He: 0.04 }, { T: 134, top: 700000, hM: 40000, mieS: [1.5e-7, 1.4e-7, 1e-7], mieA: [0, 0, 0] });
  sat.rings = { inner: 66900e3, outer: 140220e3, opacity: 1, color: [0.82, 0.74, 0.6], seed: 1, kind: 'saturn' };
  const mkIce = (b, o) => { b.surface = surfacePreset('ice', rng, b); Object.assign(b.surface, o); };
  mkIce(Mn(sat, 'Mimas', 'Ice world', 185539, 0.0196, 1.574, 3.7493e19, 198.2, 0.96), { crater: 1, cracks: 0 });
  mkIce(Mn(sat, 'Enceladus', 'Ice world', 237948, 0.0047, 0.009, 1.08e20, 252.1, 1.0), { crater: 0.3, cracks: 0.8, colA: [0.95, 0.96, 0.97], colB: [0.88, 0.9, 0.93], colCrack: [0.6, 0.75, 0.85] });
  mkIce(Mn(sat, 'Tethys', 'Ice world', 294619, 0.0001, 1.12, 6.1745e20, 531.1, 0.8), { crater: 0.9, cracks: 0.2 });
  mkIce(Mn(sat, 'Dione', 'Ice world', 377396, 0.0022, 0.019, 1.0955e21, 561.4, 0.7), { crater: 0.8, cracks: 0.4 });
  mkIce(Mn(sat, 'Rhea', 'Ice world', 527108, 0.0013, 0.345, 2.3065e21, 763.8, 0.7), { crater: 1, cracks: 0.1 });
  const titan = Mn(sat, 'Titan', 'Titan', 1221870, 0.0288, 0.349, 1.3452e23, 2574.7, 0.22, { temp: 94 });
  titan.surface = surfacePreset('titan', rng, titan);
  titan.atmo = makeAtmosphere(titan, 146700, { N2: 0.95, CH4: 0.05 }, { T: 94, hR: 21000, hM: 55000, top: 600000, mieS: [1.9e-5, 1.5e-5, 0.8e-5], mieA: [0.1e-5, 0.5e-5, 1.5e-5], mieG: [0.7, 0.7, 0.7] });
  mkIce(Mn(sat, 'Iapetus', 'Ice world', 3560820, 0.0286, 15.47, 1.8056e21, 734.5, 0.3), { crater: 1, cracks: 0, maria: 1, colLow: [0.04, 0.035, 0.03] });
  // Uranus
  const ura = P('Uranus', 'Ice giant', 19.18916464, 0.04725744, 0.77263783, 74.01692503, 170.9542763, 313.23810451, 14.54, 25362, -17.24, 97.77, 0.51, 76, { oblate: 0.0229, poleEcl: [77.6, -7.7] });
  ura.surface = gasPreset('uranus', rng, ura);
  ura.atmo = makeAtmosphere(ura, 1e5, { H2: 0.83, He: 0.15, CH4: 0.02 }, { T: 76, top: 500000, hM: 30000, mieS: [1e-7, 1e-7, 1e-7], mieA: [0, 0, 0], absorb: [1.5e-6, 2e-7, 5e-8], absH: 0, absW: 400000 });
  ura.rings = { inner: 38000e3, outer: 51200e3, opacity: 0.5, color: [0.04, 0.04, 0.045], seed: 9, kind: 'narrow' };
  mkIce(Mn(ura, 'Miranda', 'Ice world', 129390, 0.0013, 4.232, 6.59e19, 235.8, 0.32), { crater: 0.6, cracks: 1, mtnAmp: 4000 });
  mkIce(Mn(ura, 'Ariel', 'Ice world', 191020, 0.0012, 0.26, 1.353e21, 578.9, 0.53), { crater: 0.5, cracks: 0.8 });
  mkIce(Mn(ura, 'Umbriel', 'Ice world', 266300, 0.0039, 0.205, 1.172e21, 584.7, 0.26), { crater: 1, cracks: 0, colA: [0.28, 0.28, 0.29], colB: [0.2, 0.2, 0.21] });
  mkIce(Mn(ura, 'Titania', 'Ice world', 435910, 0.0011, 0.34, 3.527e21, 788.4, 0.35), { crater: 0.8, cracks: 0.5, colA: [0.4, 0.38, 0.36], colB: [0.3, 0.29, 0.27] });
  mkIce(Mn(ura, 'Oberon', 'Ice world', 583520, 0.0014, 0.058, 3.014e21, 761.4, 0.31), { crater: 1, cracks: 0.1, colA: [0.36, 0.33, 0.31], colB: [0.27, 0.25, 0.23] });
  // Neptune
  const nep = P('Neptune', 'Ice giant', 30.06992276, 0.00859048, 1.77004347, 131.78422574, 44.96476227, -55.12002969, 17.15, 24622, 16.11, 28.32, 0.41, 72, { oblate: 0.0171, poleEcl: [319.2, 61.5] });
  nep.surface = gasPreset('neptune', rng, nep);
  nep.atmo = makeAtmosphere(nep, 1e5, { H2: 0.8, He: 0.19, CH4: 0.015 }, { T: 72, top: 500000, hM: 30000, mieS: [1e-7, 1e-7, 1e-7], mieA: [0, 0, 0], absorb: [2.5e-6, 4e-7, 3e-8], absH: 0, absW: 400000 });
  const tri = Mn(nep, 'Triton', 'Ice world', 354759, 0.000016, 156.885, 2.139e22, 1353.4, 0.76); mkIce(tri, { crater: 0.1, cracks: 0.6, colA: [0.78, 0.72, 0.68], colB: [0.65, 0.58, 0.55], colCrack: [0.5, 0.45, 0.45] });
  // Pluto & Charon, Eris
  const pluto = P('Pluto', 'Dwarf planet', 39.48211675, 0.2488273, 17.14001206, 110.30393684, 224.06891629, 238.92903833, 0.00218, 1188.3, -153.2928, 122.53, 0.52, 44, { kind: 'dwarf' });
  mkIce(pluto, { crater: 0.4, cracks: 0.3, maria: 0.5, mtnAmp: 3500, colA: [0.72, 0.6, 0.48], colB: [0.45, 0.3, 0.2], colLow: [0.85, 0.83, 0.78], colCrack: [0.3, 0.14, 0.08] });
  pluto.atmo = makeAtmosphere(pluto, 1.0, { N2: 0.99, CH4: 0.01 }, { T: 44, top: 300000, hM: 30000, mieS: [2e-7, 3e-7, 6e-7], mieA: [0, 0, 0] });
  mkIce(Mn(pluto, 'Charon', 'Ice world', 19591, 0.0002, 0.08, 1.586e21, 606, 0.35), { crater: 0.6, cracks: 0.5, colA: [0.42, 0.4, 0.38], colB: [0.33, 0.31, 0.3], colLow: [0.25, 0.14, 0.1] });
  const eris = P('Eris', 'Dwarf planet', 67.864, 0.43607, 44.04, 35.95, 187.1, 392.0, 0.0028, 1163, 378.9, 78, 0.96, 30, { kind: 'dwarf' });
  mkIce(eris, { crater: 0.3, cracks: 0.2, colA: [0.92, 0.92, 0.9], colB: [0.85, 0.85, 0.84] });
  // real ephemerides and pole directions
  for (const b of [sun, ...sun.children, ...sun.children.flatMap(x => x.children)]) if (POLES[b.name] && b.name !== 'Earth') b.poleRD = POLES[b.name];
  earth.poleRD = [0, 90]; earth.seasonal = true;
  // geomagnetic north pole (2025): 80.8 N, 72.6 W
  { const la = 80.8 * D2R, lo = -72.6 * D2R; earth.magPole = [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)]; earth.aurora = 1; }
  for (const b of [sun, ...sun.children]) if (PRIME[b.name]) b.iauW = PRIME[b.name];
  // the Moon rotates uniformly (IAU model) on an eccentric, inclined orbit: libration emerges by itself
  moon.iauW = PRIME.Moon; moon.faceParent = false;
  const gal = ['Io', 'Europa', 'Ganymede', 'Callisto'];
  jup.children.forEach(m => { const i = gal.indexOf(m.name); if (i >= 0) { m.ephem = 'galilean'; m.galIndex = i; } });
  for (const b of sun.children) if (['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'].includes(b.name)) b.ephem = 'planet';
  moon.ephem = 'moon';
  // real surface data where we have it
  const D = 'data/planets/';
  // normal albedos used to calibrate grayscale mosaics
  const ALB = { mercury: 0.14, io: 0.62, europa: 0.64, ganymede: 0.42, callisto: 0.2, titan: 0.2, enceladus: 0.95, pluto: 0.5, charon: 0.33, ceres: 0.09 };
  const setMaps = (b, maps) => { b.maps = maps; if (b.surface) b.surface.freq = 1; };
  const tintOf = (c) => { const l = 0.3 * c[0] + 0.5 * c[1] + 0.2 * c[2]; return [c[0] / l * 0.5, c[1] / l * 0.5, c[2] / l * 0.5]; };
  setMaps(earth, { curve: 'bmng', lo: { color: D + 'earth_color_lo.jpg', height: D + 'earth_height16_lo.png' }, color: D + 'earth_color.jpg', height: D + 'earth_height16.webp', hRange: [-11000, 9000], mask: D + 'earth_mask.png', plates: D + 'earth_plates.png', lights: D + 'earth_lights.jpg', clouds: D + 'earth_clouds.jpg' });
  setMaps(moon, { lo: { color: D + 'moon_color_lo.jpg', height: D + 'moon_height16_lo.png' }, color: D + 'moon_color.jpg', height: D + 'moon_height16.webp', hRange: [-9500, 11000], albedo: 0.12 });
  setMaps(mars, { lo: { color: D + 'mars_color_lo.jpg', height: D + 'mars_height16_lo.png' }, color: D + 'mars_color.jpg', height: D + 'mars_height16.webp', hRange: [-8500, 21500], albedo: 0.2 });
  for (const [b, f, tint] of [[mercury, 'mercury', [0.62, 0.6, 0.57]], [io, 'io', null], [eu, 'europa', [1.0, 0.92, 0.82]], [ga, 'ganymede', [0.9, 0.86, 0.8]], [ca, 'callisto', [0.85, 0.8, 0.74]],
    [titan, 'titan', [1.0, 0.75, 0.45]], [sys.root.children.find(x => x.name === 'Saturn').children.find(x => x.name === 'Enceladus'), 'enceladus', [1, 1, 1]], [pluto, 'pluto', [1.0, 0.82, 0.66]], [ceres, 'ceres', [0.62, 0.6, 0.58]]]) {
    if (b) setMaps(b, { color: D + f + '_color.jpg', tint: tint || [1, 1, 1], albedo: ALB[f] });
  }
  const charon = pluto.children.find(x => x.name === 'Charon'); if (charon) setMaps(charon, { color: D + 'charon_color.jpg', tint: [0.8, 0.78, 0.76], albedo: ALB.charon });
  for (const [b, f] of [[jup, 'jupiter'], [sat, 'saturn'], [ura, 'uranus'], [nep, 'neptune']]) setMaps(b, { color: D + f + '_color.jpg' });
  setMaps(venus, { color: D + 'venus_color.jpg', tint: [0.55, 0.45, 0.35], albedo: 0.15, clouds: D + 'venus_clouds.jpg' });
  sat.rings.map = D + 'saturn_rings.png'; sat.rings.mapInner = 69800e3; sat.rings.mapOuter = 140900e3;
  // Earth's prime meridian: Greenwich sidereal angle at J2000 (280.46 deg), local +X starts at the autumnal equinox
  earth.rot0 = (280.46061837 - 180) * D2R; earth.rotPeriod = 86164.0905; earth.precessRA = 1.28122 * D2R;   // exact sidereal day
  sys.belts.push({ name: 'Kuiper belt', inner: 38 * C.AU, outer: 50 * C.AU, thick: 0.2, count: 6000, seed: 12, parent: sun });
  // Halley's comet
  const halley = body({ name: "Halley's Comet", kind: 'comet', cls: 'Comet', mass: 2.2e14, radius: 5500, albedo: 0.04, temp: 150, rotPeriod: 52.8 * 3600, real: true });
  halley.orbit = { a: 17.834 * C.AU, e: 0.96714, inc: 162.26 * D2R, node: 58.42 * D2R, argp: 111.33 * D2R, M0: 66.43 * D2R, period: 75.32 * C.YEAR };
  halley.surface = surfacePreset('asteroid', rng, halley); addChild(sun, halley);
  // interstellar objects on hyperbolic orbits: 1I/'Oumuamua (2017), 2I/Borisov (2019) and 3I/ATLAS (2025)
  for (const [name, kind, q, e, inc, node, argp, tp, R] of [["1I/'Oumuamua", 'dwarf', 0.2553, 1.2011, 122.74, 24.60, 241.70, 2017.688, 80],
    ['2I/Borisov', 'comet', 2.0066, 3.357, 44.05, 308.15, 209.12, 2019.936, 500], ['3I/ATLAS', 'comet', 1.357, 6.14, 175.11, 322.16, 128.01, 2025.827, 1000]]) {
    const ob = body({ name, kind, cls: 'Interstellar object', mass: 1e3 * 4.19 * R ** 3 * 0.5, radius: R, albedo: 0.06, temp: 150, rotPeriod: 7.3 * 3600, real: true });
    const qm = q * C.AU, a = qm / (e - 1);
    ob.orbit = { hyp: true, q: qm, e, a, inc: inc * D2R, node: node * D2R, argp: argp * D2R, tp: (tp - 2000) * C.YEAR, n: Math.sqrt(C.G * C.Msun / a ** 3) };
    ob.surface = surfacePreset('asteroid', rng, ob); addChild(sun, ob);
  }
  // great comets of recent decades on their real orbits (J2000 ecliptic elements; perihelion dates as decimal years)
  for (const [name, q, e, inc, node, argp, tp, R] of [['Comet Hyakutake', 0.2302, 0.9999, 124.92, 188.06, 130.18, 1996.329, 2000],
    ['Comet Hale-Bopp', 0.9141, 0.99508, 89.43, 282.47, 130.59, 1997.248, 30000], ['Comet NEOWISE', 0.2946, 0.99918, 128.94, 61.01, 37.28, 2020.504, 2500]]) {
    const cm = body({ name, kind: 'comet', cls: 'Long-period comet', mass: 1e3 * 4.19 * R ** 3 * 0.5, radius: R, albedo: 0.04, temp: 150, rotPeriod: 11 * 3600, real: true });
    const a = q / (1 - e) * C.AU, period = 2 * Math.PI * Math.sqrt(a ** 3 / (C.G * C.Msun));
    cm.orbit = { a, e, inc: inc * D2R, node: node * D2R, argp: argp * D2R, period, M0: -2 * Math.PI * (((tp - 2000) * C.YEAR / period) % 1) };
    cm.surface = surfacePreset('asteroid', rng, cm); addChild(sun, cm);
  }
  // long-period comets from the Oort cloud: a bright one passes the Sun every few years. Four slots, each holding a
  // different comet in every six-year window (near-parabolic orbit, random orientation, perihelion 0.3-1.5 AU)
  sys.longComets = [];
  for (let k = 0; k < 4; k++) {
    const cm = body({ name: 'Comet', kind: 'comet', cls: 'Long-period comet (Oort cloud)', mass: 1e14, radius: 4000, albedo: 0.04, temp: 150, rotPeriod: 20 * 3600, real: true });
    cm.orbit = { a: 1e3 * C.AU, e: 0.999, inc: 0, node: 0, argp: 0, M0: 0, period: 1e9 * C.YEAR };
    cm.surface = surfacePreset('asteroid', rng, cm); addChild(sun, cm); sys.longComets.push(cm);
  }
}

// ---------- Procedural systems ----------
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV'];
export function starName(desc) {
  if (desc.sol) return 'Sun';
  if (desc.name) return desc.name;
  const r = new RNG(desc.seed ^ 0x77);
  if (desc.star.MV < 0 && r.chance(0.5)) return makeName(desc.seed);
  return r.pick(['HD', 'HIP', 'GJ', 'TYC', 'BD', 'LHS', 'KIC']) + ' ' + (10000 + desc.seed % 890000);
}

export function makeStarBody(star, name, rng) {
  const b = body({ name, kind: 'star', cls: star.cls, star, mass: star.mass, radius: star.radius, temp: star.T, lum: star.lum, tilt: rng.range(0, 30), poleLon: rng.range(0, 360) });
  b.rotPeriod = star.kind === KIND.NS ? rng.logRange(0.002, 4) : star.kind === KIND.WD ? rng.logRange(600, 86400) : rng.logRange(0.5, 40) * C.DAY * Math.sqrt(star.radius / C.Rsun);
  if (star.kind === KIND.BH) { b.cls = star.cls || 'Black hole'; b.blackHole = true; b.spin = star.spin !== undefined ? star.spin : 0.1 + 0.85 * (((Math.floor(star.mass / 1e28) * 2654435761) >>> 0) % 1000) / 1000; b.accretion = star.accretion !== undefined ? star.accretion : (rng.chance(0.6) ? rng.range(0.3, 1) : 0); b.rotPeriod = 0; }
  else if (star.kind === KIND.NS) { b.neutron = true; b.pulsar = star.period ? true : rng.chance(0.7); if (star.period) b.rotPeriod = star.period; }
  b.surface = { gen: 'star', seed: [rng.range(0, 1000), rng.range(0, 1000), rng.range(0, 1000)], freq: 1, T: star.T, spots: star.T < 6500 && star.kind <= 2 ? rng.range(0.1, 1) : 0, hmin: 0, hmax: 0, gran: (star.kind === KIND.GIANT || star.kind === KIND.SUPERGIANT) && star.T < 6500 ? 3 : 0 };
  return b;
}

// The S-stars: young stars orbiting Sagittarius A* within a few thousand AU, followed since the 1990s (Keck, VLT).
// Elements from Gillessen et al. 2017 and GRAVITY 2020-22 (semi-major axis in arcseconds at 8.27 kpc, angles in degrees,
// time of pericentre). The orbital planes are set relative to the line of sight to the Sun (sky north approximated by
// galactic north). S2's orbit precesses by 12 arcminutes per orbit, as general relativity predicts (GRAVITY 2020).
const S_STARS = [
  ['S2', 0.1254, 0.8847, 134.7, 228.2, 66.3, 2018.38, 13.6, 28500],
  ['S38', 0.1416, 0.8201, 171.1, 101.1, 18.0, 2003.2, 6, 25000],
  ['S55', 0.1078, 0.7209, 150.1, 325.5, 331.5, 2009.3, 3, 20000],
  ['S29', 0.3910, 0.9690, 144.4, 7.1, 205.8, 2021.4, 5, 22000],
  ['S1', 0.5950, 0.5560, 119.1, 342.0, 122.3, 2001.8, 12, 27000],
  ['S4711', 0.0420, 0.7680, 114.7, 20.1, 131.1, 2017.5, 2, 15000],
];
function addSStars(sys, bh) {
  const M = bh.mass, AUa = 8270 * C.AU, rng = new RNG(77);
  // sky frame: z towards the Sun, x east, y north (galactic north stands in for celestial north)
  const toSun = V.norm(V.mul(SUN_POS, -1)), N0 = [0, 1, 0], north = V.norm(V.sub(N0, V.mul(toSun, V.dot(N0, toSun)))), east = V.cross(toSun, north);
  for (const [name, aA, e, inc, node, w, tp, mass, T] of S_STARS) {
    const a = aA * AUa, P = 2 * Math.PI * Math.sqrt(a ** 3 / (C.G * M));
    const tpS = (tp - 2000) * C.YEAR;
    const st = makeStar(-2.5, 0.5, 0.5, true);
    const R = C.Rsun * Math.pow(mass, 0.6), L = 4 * Math.PI * R * R * C.sigma * T ** 4 / C.Lsun;
    const b = makeStarBody(Object.assign({}, st, { kind: KIND.MS, mass: mass * C.Msun, radius: R, T, lum: L, MV: 4.83 - 2.5 * Math.log10(L) }), name, rng);
    b.cls = 'B-type star orbiting Sagittarius A*';
    // orbit in the sky frame, then expressed in the system's axes
    b.orbit = { a, e, inc: inc * D2R, node: node * D2R, argp: w * D2R, M0: -2 * Math.PI * ((tpS / P) % 1), period: P,
      argpDot: 6 * Math.PI * C.G * M / (C.c ** 2 * a * (1 - e * e)) / P, sky: [north, east, V.mul(toSun, -1)] };
    b.equatorial = false; b.skyFrame = true;
    addChild(bh, b);
  }
}
function buildProcedural(sys) {
  const rng = new RNG(sys.seed), d = sys.desc, st = d.star;
  const name = starName(d);
  sys.name = name + ' system';
  sys.quat = Q.axis(rng.dir(), rng.range(0, Math.PI * 2));
  let primary = makeStarBody(st, name, rng);
  let hostMass = st.mass, lum = st.lum, planetParent = primary, maxA = 1e9, minAfac = 1;
  sys.root = primary;
  if (name === 'Sagittarius A*') { sys.quat = [0, 0, 0, 1]; addSStars(sys, primary); return; }
  const real = REAL_SYSTEMS[name];
  if (real || d.catIndex !== undefined) {
    // catalogue stars: no invented companions; known systems get their observed planets only
    if (real) buildReal(sys, rng, real, primary, st, name);
    else buildPlanetsOnly(sys, rng, primary, st, name);
    return;
  }
  // multiplicity
  const multP = st.kind === KIND.MS ? clamp(0.25 + 0.2 * Math.log10(st.mass / C.Msun + 0.3) + 0.2, 0.2, 0.75) : 0.25;
  const comp = d.companion;
  if ((rng.chance(multP) && st.kind !== KIND.BH) || comp) {
    const q = rng.range(0.15, 0.98);
    const MV2 = st.MV + (-10 * Math.log10(q)) * (st.kind === KIND.MS ? 1 : 0.4) + (st.kind === KIND.MS ? 0 : 3);
    const s2r = makeStar(clamp(MV2, -6, 24), rng.f() * 0.5 + 0.5, rng.f(), false);
    const s2 = comp ? makeStar(comp.MV, comp.u1, comp.u2, true) : s2r;
    const sepR = Math.pow(10, clamp(1.5 + 1.4 * rng.gauss(), -1.2, 4)) * Math.max(1, (st.radius + s2.radius) / C.AU * 3);
    const sepAU = comp ? comp.sep : sepR;
    const bary = body({ name: name + ' barycenter', kind: 'barycenter', cls: 'Barycenter', mass: st.mass + s2.mass, radius: 0 });
    primary.name = name + ' A';
    const B = makeStarBody(s2, name + ' B', rng);
    const e = sepAU < 0.2 ? 0 : rng.range(0, 0.6), inc = rng.range(0, 0.2), node = rng.range(0, 6.28), argp = rng.range(0, 6.28), M0 = rng.range(0, 6.28);
    const a = sepAU * C.AU, per = 2 * Math.PI * Math.sqrt(a * a * a / (C.G * (st.mass + s2.mass)));
    primary.orbit = { a: a * s2.mass / (st.mass + s2.mass), e, inc, node, argp: argp + Math.PI, M0, period: per };
    B.orbit = { a: a * st.mass / (st.mass + s2.mass), e, inc, node, argp, M0, period: per };
    addChild(bary, primary); addChild(bary, B); sys.root = bary;
    if (sepAU < 3) { planetParent = bary; hostMass = st.mass + s2.mass; lum = st.lum + s2.lum; minAfac = sepAU * 3.5; }
    else { maxA = sepAU * (1 - e) / 3.5; }
    sys.binarySep = sepAU;
  }
  if (st.kind === KIND.BH && primary.accretion) lum = 0.01;
  proceduralPlanets(sys, rng, st, name, planetParent, hostMass, lum, maxA, minAfac);
}
function buildPlanetsOnly(sys, rng, primary, st, name) {
  proceduralPlanets(sys, rng, st, name, primary, st.mass, st.lum, 1e9, 1);
}
function proceduralPlanets(sys, rng, st, name, planetParent, hostMass, lum, maxA, minAfac) {
  // planets
  const sqL = Math.sqrt(Math.max(lum, 1e-5));
  let nPl = st.kind === KIND.MS || st.kind === KIND.BD ? rng.int(0, 10) : rng.int(0, 5);
  if (st.kind === KIND.BD) nPl = Math.min(nPl, 4);
  if (st.mass > 8 * C.Msun) nPl = Math.min(nPl, 3);
  if (st.mass > 200 * C.Msun) nPl = 0;
  let a = Math.max(rng.range(0.04, 0.35) * Math.max(sqL, 0.15), st.radius / C.AU * 2.5, minAfac);
  const frost = 2.7 * sqL;
  let idx = 0, beltDone = false;
  for (let i = 0; i < nPl; i++) {
    if (a > maxA || a > 400 * Math.max(1, sqL)) break;
    const beyond = a > frost;
    if (!beltDone && beyond && rng.chance(0.4)) { sys.belts.push({ name: name + ' asteroid belt', inner: a * 0.85 * C.AU, outer: a * 1.25 * C.AU, thick: 0.1, count: 7000, seed: rng.int(1, 9999), parent: planetParent }); beltDone = true; a *= rng.range(1.6, 2.0); continue; }
    let massE, type;
    const u = rng.f();
    if (!beyond) { if (u < 0.06 && i < 2) { type = 'gas'; massE = rng.logRange(60, 2500); } else if (u < 0.2) { type = 'neptune'; massE = rng.logRange(5, 25); } else { type = 'rock'; massE = rng.logRange(0.03, 7); } }
    else { if (u < 0.4 && a < frost * 12) { type = 'gas'; massE = rng.logRange(40, 3500); } else if (u < 0.7) { type = 'neptune'; massE = rng.logRange(6, 40); } else { type = 'rock'; massE = rng.logRange(0.005, 3); } }
    if (st.kind === KIND.BD && type === 'gas') { type = 'rock'; massE = rng.logRange(0.03, 3); }
    const pname = name + ' ' + String.fromCharCode(98 + idx); idx++;
    const p = makePlanet(sys, rng, pname, type, massE, a, hostMass, lum, st, planetParent, 'planet');
    // moons
    const nM = type === 'rock' ? (massE > 0.2 ? rng.weighted([0.5, 0.35, 0.15]) : rng.weighted([0.8, 0.2])) : rng.int(1, 7);
    const hill = a * C.AU * Math.cbrt(p.mass / (3 * hostMass));
    let am = p.radius * rng.range(3, 8) * (p.rings ? 1.6 : 1);
    for (let m = 0; m < nM; m++) {
      if (am > hill * 0.4) break;
      const mm = type === 'rock' ? p.mass * rng.logRange(1e-4, 2e-2) : p.mass * rng.logRange(2e-7, 2.5e-4);
      const mo = makePlanet(sys, rng, pname + ' ' + ROMAN[m], 'rock', mm / C.Mearth, a, hostMass, lum, st, p, 'moon', am);
      am *= rng.range(1.4, 2.4);
    }
    a *= rng.range(1.4, 2.1);
  }
  if (rng.chance(0.5) && nPl > 2) sys.belts.push({ name: name + ' outer belt', inner: a * 1.2 * C.AU, outer: a * 1.8 * C.AU, thick: 0.2, count: 5000, seed: rng.int(1, 9999), parent: planetParent });
}

function buildReal(sys, rng, real, primary, st, name) {
  let host = primary, hostMass = st.mass, lum = st.lum;
  if (real.companion) {
    const c = real.companion, s2 = starFromCatalog(c.MV, c.T, c.spect);
    s2.mass = c.mass * C.Msun; s2.radius = c.radius * C.Rsun;
    s2.lum = 4 * Math.PI * s2.radius ** 2 * C.sigma * Math.pow(c.T, 4) / C.Lsun;
    const B = makeStarBody(s2, c.name, rng);
    const bary = body({ name: name + ' barycenter', kind: 'barycenter', cls: 'Barycenter', mass: st.mass + s2.mass, radius: 0 });
    const a = c.a * C.AU, per = c.period * C.YEAR, node = rng.range(0, 6.28), argp = rng.range(0, 6.28), M0 = rng.range(0, 6.28);
    primary.orbit = { a: a * s2.mass / (st.mass + s2.mass), e: c.e, inc: 0, node, argp: argp + Math.PI, M0, period: per };
    B.orbit = { a: a * st.mass / (st.mass + s2.mass), e: c.e, inc: 0, node, argp, M0, period: per };
    addChild(bary, primary); addChild(bary, B); sys.root = bary; sys.binarySep = c.a;
  }
  for (const [pn, P, aAU, e, massE, rE] of real.planets) {
    const type = rE ? (rE < 1.8 ? 'rock' : rE < 6 ? 'neptune' : 'gas') : (massE < 5 ? 'rock' : massE < 60 ? 'neptune' : 'gas');
    const p = makePlanet(sys, rng, pn, type, massE, aAU, hostMass, lum, st, host, 'planet');
    p.orbit.e = e; p.orbit.period = P * 86400;
    if (rE) p.radius = rE * C.Rearth;
    p.rings = null; p.real = true; p.observed = true;
  }
}
function makePlanet(sys, rng, name, type, massE, aAU, hostMass, lum, st, parent, kind, moonA) {
  const b = body({ name, kind, mass: massE * C.Mearth });
  // radius from mass
  let rE;
  if (type === 'gas') rE = massE < 130 ? 0.82 * Math.pow(massE, 0.55) : 11.2 * Math.pow(massE / 318, -0.04) * rng.range(0.92, 1.1);
  else if (type === 'neptune') rE = 0.82 * Math.pow(massE, 0.55) * rng.range(0.85, 1.1);
  else rE = Math.pow(massE, massE < 1 ? 0.3 : 0.27) * rng.range(0.94, 1.06);
  // orbit
  if (kind === 'moon') {
    const e = rng.range(0, 0.03);
    b.orbit = { a: moonA, e, inc: rng.range(0, 0.06), node: rng.range(0, 6.28), argp: rng.range(0, 6.28), M0: rng.range(0, 6.28), period: 2 * Math.PI * Math.sqrt(moonA ** 3 / (C.G * parent.mass)) };
    b.equatorial = true; b.rotPeriod = b.orbit.period; b.tilt = rng.range(0, 3);
  } else {
    const a = aAU * C.AU, e = Math.min(0.5, Math.abs(rng.gauss()) * 0.07);
    b.orbit = { a, e, inc: Math.abs(rng.gauss()) * 0.04, node: rng.range(0, 6.28), argp: rng.range(0, 6.28), M0: rng.range(0, 6.28), period: 2 * Math.PI * Math.sqrt(a ** 3 / (C.G * hostMass)) };
    const locked = aAU < 0.12 * Math.pow(hostMass / C.Msun, 1 / 3) * 2;
    b.rotPeriod = locked ? b.orbit.period : rng.logRange(6, 60) * 3600 * (type === 'rock' ? 1 : 0.6) * (rng.chance(0.07) ? -8 : 1);
    b.tilt = locked ? rng.range(0, 3) : Math.min(178, Math.abs(rng.gauss()) * 22 + (rng.chance(0.06) ? 90 : 0));
    b.poleLon = rng.range(0, 360);
  }
  // icy composition far from the star -> lower density -> bigger
  const Teq = 278.5 * Math.pow(Math.max(lum, 1e-8), 0.25) / Math.sqrt(aAU);
  const icy = type === 'rock' && Teq < 150;
  if (icy) rE *= 1.25;
  b.radius = rE * C.Rearth;
  const g = C.G * b.mass / (b.radius * b.radius), vesc = Math.sqrt(2 * g * b.radius);
  b.temp = Teq;
  if (type === 'gas' || type === 'neptune') {
    let gk;
    if (Teq > 900) gk = 'hot'; else if (Teq > 350) gk = rng.pick(['cloudy', 'sulfur', 'neptune']); else if (type === 'neptune') gk = Teq > 150 ? rng.pick(['neptune', 'cloudy', 'uranus']) : rng.pick(['uranus', 'neptune', 'neptune']);
    else gk = massE > 4000 ? 'brown' : rng.pick(['jupiter', 'jupiter', 'saturn', 'saturn', 'sulfur', 'neptune']);
    b.cls = type === 'gas' ? (Teq > 900 ? 'Hot Jupiter' : 'Gas giant') : (Teq > 350 ? 'Warm Neptune' : 'Ice giant');
    b.surface = gasPreset(gk, rng, b);
    b.albedo = gk === 'hot' ? 0.1 : 0.45; b.oblate = clamp(0.1 * Math.pow(10 * 3600 / Math.abs(b.rotPeriod), 2) * (1300 / (b.mass / (4.19 * b.radius ** 3))), 0, 0.15);
    const meth = gk === 'neptune' || gk === 'uranus';
    b.atmo = makeAtmosphere(b, meth ? 0.8e5 : 0.05e5, { H2: 0.86, He: 0.13, CH4: 0.01 }, { T: Math.max(Teq, 60), top: undefined, mieS: [1e-7, 1e-7, 1e-7], mieA: [0, 0, 0], absorb: meth ? [2e-6, 3e-7, 4e-8] : [0, 0, 0], absH: 0, absW: 4e5 });
    b.atmo.top = Math.max(b.atmo.hR * 14, b.radius * 0.006);
    if (rng.chance(type === 'gas' ? 0.45 : 0.3) && Teq < 500) {
      const big = rng.chance(0.45);
      b.rings = { inner: b.radius * rng.range(1.15, 1.5), outer: b.radius * (big ? rng.range(2.0, 2.6) : rng.range(1.6, 2.0)), opacity: big ? rng.range(0.6, 1) : rng.range(0.05, 0.4), color: vary(rng, Teq < 160 ? [0.8, 0.74, 0.64] : [0.4, 0.34, 0.28], 0.15), seed: rng.int(1, 999), kind: rng.pick(['saturn', 'saturn', 'narrow']) };
    }
  } else {
    // rocky / icy bodies
    const canHoldAir = vesc > 6 * Math.sqrt(3 * C.kB * Math.max(Teq, 30) / (28 * 1.66e-27)) * 0.42 && massE > 0.012;
    let cls, P = 0, comp = null, Ts = Teq;
    if (canHoldAir && rng.chance(massE > 0.1 ? 0.85 : 0.35)) {
      P = rng.logRange(0.002, massE > 0.4 ? 150 : 2) * 1e5 * Math.min(1, massE * 2);
      const gh = Math.min(450, 33 * Math.pow(P / 1e5, 0.45)) * (Teq > 200 ? 1 : 0.3);
      Ts = Teq * Math.pow(0.7, 0.25) + gh;
    }
    if (Ts > 1100 || (Teq > 800 && P === 0)) cls = 'lava';
    else if (P > 0) {
      if (Ts > 255 && Ts < 345 && P > 6000 && P < 3e6 && massE > 0.08) { cls = rng.chance(0.3) ? 'ocean' : (rng.chance(0.75) ? 'terra' : 'desert'); if (cls !== 'desert') P = Math.exp(Math.log(0.4e5) + (Math.log(P) - Math.log(6000)) / (Math.log(3e6) - Math.log(6000)) * (Math.log(3e5) - Math.log(0.4e5))); }
      else if (Ts < 255) cls = Ts < 130 && rng.chance(0.6) ? 'titan' : (icy ? 'ice' : 'desert');
      else if (P > 2e6) cls = 'venus'; else cls = 'desert';
    } else cls = icy ? 'ice' : (Teq > 500 && rng.chance(0.25) ? 'io' : 'selena');
    if (b.radius < 2.5e5) { cls = 'asteroid'; const e1 = rng.range(1, 1.8), e2 = rng.range(0.6, 1); b.shape = [e1 / Math.cbrt(e1 * e2), e2 / Math.cbrt(e1 * e2) * rng.range(0.85, 1), 1 / Math.cbrt(e1 * e2)]; }
    b.temp = Ts;
    b.surface = surfacePreset(cls, rng, b);
    const life = (cls === 'terra' || cls === 'ocean') && rng.chance(0.7);
    b.life = life;
    if (cls === 'terra' || cls === 'ocean') {
      b.surface.veg = life ? rng.range(0.5, 1) : 0;
      b.surface.sea = rng.range(-0.5, 0.7) * b.surface.contAmp + (cls === 'ocean' ? b.surface.contAmp * 1.2 : 0);
      b.surface.tempEq = Ts + 12;
      if (life && rng.chance(0.3)) { const h = rng.pick([[0.14, 0.05, 0.06], [0.06, 0.1, 0.12], [0.16, 0.12, 0.03], [0.1, 0.04, 0.12]]); b.surface.colVeg1 = h; b.surface.colVeg2 = V.mul(h, 0.4); }
      comp = life ? { N2: rng.range(0.6, 0.85), O2: rng.range(0.12, 0.3), Ar: 0.01 } : { N2: rng.range(0.3, 0.9), CO2: rng.range(0.05, 0.6), Ar: 0.02 };
      b.atmo = makeAtmosphere(b, P, comp, { T: Ts * 0.88, clouds: { base: rng.range(1000, 2500), top: rng.range(7000, 11000), cover: rng.range(0.3, 0.7), density: 1, color: [1, 1, 1], kind: 'earth' } });
    } else if (P > 0) {
      if (cls === 'titan') {
        comp = { N2: 0.94, CH4: 0.06 };
        const hz = rng.range(0.3, 1.2), tint = rng.pick([[0.1, 0.5, 1.5], [0.1, 0.3, 0.8], [0.5, 0.2, 0.9], [0.8, 0.5, 0.2]]);
        b.atmo = makeAtmosphere(b, P, comp, { T: Ts, mieS: [1.9e-5 * hz, 1.5e-5 * hz, 0.9e-5 * hz], mieA: V.mul(tint, 1e-5 * hz), mieG: [0.7, 0.7, 0.7] });
        b.atmo.hM = b.atmo.hR * 2; b.atmo.top = b.atmo.hR * 16;
        b.surface.sea = rng.range(-1.2, 0) * b.surface.contAmp;
      } else if (cls === 'venus') {
        comp = { CO2: 0.96, N2: 0.04 };
        const cc = vary(rng, [1.0, 0.92, 0.72], 0.1);
        b.atmo = makeAtmosphere(b, P, comp, { T: Ts * 0.6, mieS: [2e-5, 1.9e-5, 1.4e-5], mieA: [2e-7, 6e-7, 3e-6] });
        b.atmo.clouds = { base: b.atmo.hR * 3, top: b.atmo.hR * 4.3, cover: 1, density: 3, color: cc, kind: 'venus' };
        b.atmo.top = Math.max(b.atmo.top, b.atmo.hR * 9);
      } else {
        comp = { CO2: 0.95, N2: 0.03, Ar: 0.02 };
        const dust = rng.range(0.2, 1.5) * Math.min(1, P / 600);
        b.atmo = makeAtmosphere(b, P, comp, { T: Ts, mieS: [3.2e-5 * dust, 2.6e-5 * dust, 1.6e-5 * dust], mieA: [0.1e-5 * dust, 0.5e-5 * dust, 1.5e-5 * dust], mieG: [0.72, 0.76, 0.86] });
        b.atmo.hM = b.atmo.hR;
        if (cls === 'ice') b.atmo.mieS = b.atmo.mieS.map(x => x * 0.05), b.atmo.mieA = [0, 0, 0];
      }
    }
    if (b.atmo && b.atmo.top > b.radius * 0.5) b.atmo.top = b.radius * 0.5;
    b.cls = { terra: 'Terra', ocean: 'Ocean world', desert: P > 0 ? 'Desert' : 'Selena', venus: 'Venusian', selena: 'Selena', ice: 'Ice world', lava: 'Lava world', io: 'Volcanic', titan: 'Titan', asteroid: 'Asteroid' }[cls];
    b.albedo = { terra: 0.3, ocean: 0.3, desert: 0.22, venus: 0.7, selena: 0.12, ice: 0.6, lava: 0.08, io: 0.5, titan: 0.22, asteroid: 0.08 }[cls];
    if (cls === 'lava') b.surface.tempEq = Ts;
  }
  addChild(parent, b);
  return b;
}

// ---------- Info helpers ----------
export function surfaceGravity(b) { return b.radius > 0 ? C.G * b.mass / (b.radius * b.radius) : 0; }
// perihelion passages of Halley's comet (Yeomans & Kiang 1981; astronomical years, so 240 BC is -238.6): 1066 is
// the one on the Bayeux Tapestry, 1301 the star of Giotto's Adoration, 1759 the return Halley predicted
const HALLEY_TP = [-238.6, -162.14, -85.4, -10.23, 66.07, 141.22, 218.37, 295.3, 374.12, 451.49, 530.71, 607.21, 684.78, 760.39, 837.16,
  912.53, 989.7, 1066.23, 1145.3, 1222.7, 1301.82, 1378.86, 1456.44, 1531.65, 1607.82, 1682.7, 1759.2, 1835.88, 1910.3, 1986.11, 2061.56, 2134.24];
export function halleyOrbit(o, y) {
  let i = HALLEY_TP.findIndex((tp, k) => k < HALLEY_TP.length - 1 && y >= tp && y < HALLEY_TP[k + 1]);
  if (i < 0) i = y < HALLEY_TP[0] ? 0 : HALLEY_TP.length - 2;   // (outside the record: the nearest orbit, repeated)
  if (o._hi === i) return; o._hi = i;
  const P = HALLEY_TP[i + 1] - HALLEY_TP[i];
  o.period = P * C.YEAR; o.a = 17.834 * C.AU * Math.pow(P / 75.32, 2 / 3);
  o.M0 = -2 * Math.PI * ((((HALLEY_TP[i] - 2000) / P) % 1) );
}
const MARS_STORMS = [1971.72, 1977.13, 1977.40, 1982.80, 2001.47, 2007.47, 2018.41];
export function marsDust(y) {
  const level = (t0) => { const d = (y - t0) * 365.25; return d < 0 || d > 220 ? 0 : d < 15 ? d / 15 : Math.exp(-(d - 15) / 55); };
  if (y > 1960 && y < 2030) { let L = 0; for (const t0 of MARS_STORMS) L = Math.max(L, level(t0)); return L; }
  const n = Math.floor((y - 2020.59 + 0.3) / 1.8808), h = Math.abs(Math.sin(n * 12.9898) * 43758.5453) % 1;
  return h < 0.33 ? level(2020.59 + n * 1.8808 - 0.12 + 0.25 * ((h * 7.3) % 1)) : 0;
}
export function describeBody(b) {
  const rows = [];
  const fmt = (x, d = 3) => x === 0 ? '0' : (Math.abs(x) >= 1e5 || Math.abs(x) < 1e-3 ? x.toExponential(d - 1) : (+x.toPrecision(d)).toString());
  rows.push(['Class', b.cls]);
  if (b.kind === 'star') {
    rows.push(['Mass', fmt(b.mass / C.Msun) + ' M<sub>Sun</sub>']);
    rows.push(['Radius', b.radius > 1e7 ? fmt(b.radius / C.Rsun) + ' R<sub>Sun</sub>' : fmt(b.radius / 1e3) + ' km']);
    if (b.temp) rows.push(['Temperature', Math.round(b.temp) + ' K']);
    rows.push(['Luminosity', fmt(b.lum) + ' L<sub>Sun</sub>']);
    if (b.star && !b.evoPhase) rows.push(['Abs. magnitude', b.star.MV.toFixed(2)]);
    if (b.evoPhase) rows.push(['Stage', b.evoPhase]);
    if (b.ageYr > 0 && !b.unborn) rows.push(['Age', b.ageYr >= 1e9 ? (b.ageYr / 1e9).toFixed(2) + ' billion years' : b.ageYr >= 1e6 ? (b.ageYr / 1e6).toFixed(1) + ' million years' : Math.round(b.ageYr).toLocaleString('en') + ' years']);
    if (b.blackHole) {
      // Hawking radiation: T = hbar c^3 / (8 pi G M k), evaporation in ~2.1e67 yr (M/Msun)^3 (photons and gravitons)
      const m = b.mass / C.Msun;
      const a = b.spin || 0;
      rows.push(['Spin', a ? a.toFixed(2) + ' (Kerr)' : '0 (Schwarzschild)']);
      rows.push(['Horizon radius', fmt(C.G * b.mass / (C.c * C.c) * (1 + Math.sqrt(1 - a * a)) / 1e3) + ' km']);
      rows.push(['Hawking temperature', fmt(6.17e-8 / m) + ' K']);
      rows.push(['Evaporates in', fmt(2.1e67 * m ** 3) + ' yr']);
    }
  } else if (b.kind !== 'barycenter') {
    rows.push(['Mass', b.mass > 0.01 * C.Mearth ? (b.mass > 50 * C.Mearth ? fmt(b.mass / C.Mjup) + ' M<sub>Jup</sub>' : fmt(b.mass / C.Mearth) + ' M<sub>Earth</sub>') : fmt(b.mass) + ' kg']);
    rows.push(['Radius', fmt(b.radius / 1e3, 5) + ' km']);
    rows.push(['Gravity', fmt(surfaceGravity(b) / 9.80665) + ' g']);
    rows.push(['Density', fmt(b.mass / (4.18879 * b.radius ** 3) / 1000) + ' g/cm³']);
    const Tm = b.meanT || (b.heatT > b.temp ? b.heatT : b.temp);
    rows.push(['Mean temperature', Math.round(Tm) + ' K (' + Math.round(Tm - 273.15) + ' °C)']);
    if (b.air) {
      // Earth's air of the epoch (see earthAir)
      const ppm = Math.round(b.air.co2 * 1e6), f = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%';
      rows.push(['Pressure', b.climate && b.climate.dry > 0.5 ? 'rising (steam atmosphere)' : '1 atm']);
      rows.push(['Atmosphere', 'N2 ' + f(Math.max(0, 0.99 - b.air.o2 - b.air.co2)) + ', O2 ' + (b.air.o2 > 0 ? f(b.air.o2) : 'none') + ', CO2 ' + (ppm < 10000 ? ppm.toLocaleString('en') + ' ppm' : f(b.air.co2))]);
    } else if (b.atmo) { rows.push(['Pressure', fmt(b.atmo.P / 101325) + ' atm']); rows.push(['Atmosphere', Object.entries(b.atmo.comp).sort((a, c) => c[1] - a[1]).map(([k, v]) => k + ' ' + (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%').join(', ')]); }
    else rows.push(['Atmosphere', 'none']);
    if (b.dust > 0.1) rows.push(['Weather', 'global dust storm (dust optical depth ~' + (0.5 + 5 * b.dust).toFixed(1) + ')']);
    if (b.lifeNow) rows.push(['Life', b.lifeNow]);
    else if (b.life) rows.push(['Life', b.climate && b.climate.life < 0.5 ? (b.climate.life > 0.02 ? 'dying out as the star brightens' : 'none (sterilized)') : 'organic, multicellular']);
  }
  if (b.rotPeriod) rows.push(['Rotation', Math.abs(b.rotPeriod) < 1 ? fmt(Math.abs(b.rotPeriod) * 1000) + ' ms' : Math.abs(b.rotPeriod) < 86400 * 3 ? fmt(Math.abs(b.rotPeriod) / 3600) + ' h' : fmt(Math.abs(b.rotPeriod) / 86400) + ' d']);
  if (b.kind !== 'star' && b.kind !== 'barycenter') rows.push(['Axial tilt', fmt(b.tilt) + '°']);
  if (b.approxOrbit) rows.push(['Orbit', 'approximate elements']);
  if (b.observed) rows.push(['Data', 'observed exoplanet']);
  if (b.orbit && b.orbit.hyp) {
    const o = b.orbit, vinf = Math.sqrt(C.G * C.Msun * (o.e - 1) / o.q) / 1e3;
    rows.push(['Orbit', 'hyperbolic: passing through once, from interstellar space']);
    rows.push(['Perihelion', fmt(o.q / C.AU, 4) + ' AU']); rows.push(['Eccentricity', fmt(o.e)]); rows.push(['Speed far from the Sun', fmt(vinf) + ' km/s']);
    rows.push(['Inclination', (o.inc / D2R).toFixed(2) + '°']);
  } else if (b.orbit) {
    const o = b.orbit;
    rows.push(['Semi-major axis', o.a > 0.01 * C.AU ? fmt(o.a / C.AU, 4) + ' AU' : Math.round(o.a / 1e3).toLocaleString('en') + ' km']);
    rows.push(['Orbital period', o.period > C.YEAR ? fmt(o.period / C.YEAR, 4) + ' yr' : o.period > 86400 ? fmt(o.period / 86400, 4) + ' d' : fmt(o.period / 3600) + ' h']);
    rows.push(['Eccentricity', fmt(b.orbitE !== undefined ? b.orbitE : o.e)]);
    rows.push(['Inclination', (o.inc / D2R).toFixed(2) + '°']);
  }
  return rows;
}
