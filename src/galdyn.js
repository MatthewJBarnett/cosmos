// Galactic dynamics of the Milky Way: differential rotation, the Sun's epicyclic orbit, stellar motions.
// Positions are in the galaxy's local frame (pc, x towards the centre from the Sun's epoch position, y to the NGP).
import { SUN_POS, MILKY_WAY } from './universe.js';
import { Q } from './math.js';
import { updateCosmo } from './cosmology.js';

export const YEAR = 31557600;
export const KMS_PCYR = 1.02271e-6;          // 1 km/s in pc per year
const V0 = 223, RC = 1500;                   // rotation curve v(R) = V0 R / sqrt(R^2 + Rc^2)  (km/s, pc)
export const R0 = Math.hypot(SUN_POS[0], SUN_POS[2]);
// Sun's motion relative to the local standard of rest (Schoenrich et al. 2010): U towards the centre, V with rotation, W north
export const VSUN = [11.1, 7.25, -12.24];    // in the local frame: +x = U (towards GC), +y = W, -z = V (direction of rotation)

// angular velocity at radius R (rad/yr). The galaxy rotates clockwise seen from the north galactic pole.
export function omega(R) { return V0 / Math.sqrt(R * R + RC * RC) * KMS_PCYR; }
export function rotY(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; }
// rotation angle about +y after tyr years (negative = clockwise from the north)
export function rotAngle(R, tyr) { return -omega(R) * tyr; }

// Catalogue stars: Sun-relative epoch position and heliocentric velocity (km/s). Straight-line relative motion is valid
// for a few Myr, after which the catalogue fades into the statistical field.
export const CAT_FADE0 = 1.0e6, CAT_FADE1 = 3.0e6;
export function catalogWeight(tyr) { const a = Math.abs(tyr); return a <= CAT_FADE0 ? 1 : a >= CAT_FADE1 ? 0 : 1 - (a - CAT_FADE0) / (CAT_FADE1 - CAT_FADE0); }

// Procedural stars move in straight lines inside their cell and wrap around it (a statistical stream: the density
// stays right while every star drifts with the local flow). Velocities are integer multiples of VQ so the wrapped
// position can be evaluated exactly from (t mod period) in single precision on the GPU.
export const VQ = 0.5;                                     // km/s per velocity quantum
export function wrapPhase(s, tyr) { const P = s / (VQ * KMS_PCYR); const tm = tyr - Math.floor(tyr / P) * P; return VQ * KMS_PCYR * tm; }
const wrapc = (x, s) => x - s * Math.floor(x / s);
// The Sun's galactic orbit: guiding centre on a circle plus radial and vertical epicycles (bounded for any time span).
const KAPPA = Math.SQRT2 * omega(R0) * 1.02, NU = 2 * Math.PI / 7.6e7;
const AR = VSUN[0] * KMS_PCYR / KAPPA;                       // radial amplitude from U
const AZ = Math.hypot(SUN_POS[1], VSUN[1] * KMS_PCYR / NU), PZ = Math.atan2(SUN_POS[1] * NU, VSUN[1] * KMS_PCYR);
const OMS = (V0 * R0 / Math.sqrt(R0 * R0 + RC * RC) - VSUN[2]) / R0 * KMS_PCYR;  // azimuthal rate including V
// after the Andromeda encounter begins, the Sun's position comes from the N-body tracer (set by localgroup.js)
export const sunHook = { fn: null, t0: Infinity };
export function sunPos(tyr) {
  if (!tyr) return SUN_POS.slice();
  if (sunHook.fn && tyr > sunHook.t0) { const p = sunHook.fn(tyr); if (p) return p; }
  const R = R0 - AR * Math.sin(KAPPA * tyr), z = AZ * Math.sin(NU * tyr + PZ);
  const a = -OMS * tyr;
  const p = [-R, z, 0];                                     // epoch azimuth: Sun on the -x axis
  return rotY(p, a);
}
export const SUN_ORBIT = { periodYr: 2 * Math.PI / OMS, verticalYr: 2 * Math.PI / NU, radialYr: 2 * Math.PI / KAPPA, AZ, AR };

// current position (pattern frame, pc) of anything described by a star descriptor's motion record
export function descPosP(desc, tyr = world.tyr) {
  const m = desc.motion;
  if (!m || !tyr) return desc.pos.slice();
  if (m.type === 'sol') return toPattern(sunPos(tyr), tyr);
  if (m.type === 'cat') {
    const k = KMS_PCYR * tyr, sI = sunPos(tyr);
    const lin = [sI[0] + m.prel[0] + m.vel[0] * k, sI[1] + m.prel[1] + m.vel[1] * k, sI[2] + m.prel[2] + m.vel[2] * k];
    // measured velocities hold for a few million years; over longer times every star follows its own orbit around the
    // Galaxy (differential rotation spreads the Sun's neighbours along the solar circle), so blend into circular motion
    const w = Math.min(1, Math.max(0, (Math.abs(tyr) - 5e6) / 4e7));
    if (w <= 0) return toPattern(lin, tyr);
    const s0 = sunPos(0), p0 = [s0[0] + m.prel[0], s0[1] + m.prel[1], s0[2] + m.prel[2]], R = Math.hypot(p0[0], p0[2]);
    const circ = rotY(p0, -omega(R) * tyr);
    circ[1] = p0[1] * Math.cos(2 * Math.PI * tyr / 8.5e7);      // (bobbing through the disk)
    return toPattern(lin.map((x, i) => x * (1 - w) + circ[i] * w), tyr);
  }
  if (m.type === 'wrap') { const ph = wrapPhase(m.s, tyr); return [m.o[0] + wrapc(m.x[0] + m.k[0] * ph, m.s), m.o[1] + wrapc(m.x[1] + m.k[1] * ph, m.s), m.o[2] + wrapc(m.x[2] + m.k[2] * ph, m.s)]; }
  if (m.type === 'circ') { const R = Math.hypot(desc.pos[0], desc.pos[2]); return rotY(desc.pos, -(omega(R) - OMEGA_P) * tyr); }
  return desc.pos.slice();
}

// --- massive star life cycles in the procedural field ---
// Stars massive enough to end as core collapse supernovae live through repeated cycles: alive for SN_LIVE of the cycle,
// then a supernova, then nothing until star formation replaces them. Lifetimes by absolute magnitude class.
export const SN_CLASSES = [{ mv: -6.0, tau: 4e6 }, { mv: -5.0, tau: 6e6 }, { mv: -4.0, tau: 9e6 }, { mv: -3.0, tau: 14e6 }, { mv: -2.0, tau: 22e6 }, { mv: -1.2, tau: 35e6 }];
export const SN_LIVE = 0.92;
// class index, or -1 for stars that will not explode (hot main sequence stars brighter than about B2, or any supergiant)
export function snClass(MV, T) {
  if (!(MV < -1.2 && (T > 15000 || MV < -4.5))) return -1;
  return MV < -5.5 ? 0 : MV < -4.5 ? 1 : MV < -3.5 ? 2 : MV < -2.5 ? 3 : MV < -1.6 ? 4 : 5;
}
// cycle phases at time tyr (double precision on the CPU, passed to the shader)
export function snPhases(tyr) { return SN_CLASSES.map(c => { const x = tyr / c.tau; return x - Math.floor(x); }); }

// --- the rotating frame of the spiral pattern ---
// The galaxy's "local frame" (density model, arms, dust, sky cube) is the frame of the spiral density wave, which turns
// rigidly at the pattern speed. Stars stream through it at Omega(R) - OMEGA_P. Star systems keep inertial orientations.
export const OMEGA_P = 25e-3 * KMS_PCYR;     // 25 km/s/kpc (rad/yr)
export const toPattern = (pI, tyr) => tyr ? rotY(pI, OMEGA_P * tyr) : pI.slice();
export const toInertial = (pP, tyr) => tyr ? rotY(pP, -OMEGA_P * tyr) : pP.slice();
// streaming velocity (km/s) in the pattern frame of a star on a circular orbit at pattern-frame position p
export function streamVel(p) { const R = Math.hypot(p[0], p[2]); const w = (omega(R) - OMEGA_P) / KMS_PCYR; return [-p[2] * w, 0, p[0] * w]; }

// Global time state, refreshed once per frame from the simulation clock (seconds since J2000).
export const world = { time: 0, tyr: 0, sunI: SUN_POS.slice(), sunP: SUN_POS.slice(), catW: 1, catK: 0, patAng: 0, rotP: [1, 0, 0, 0, 1, 0, 0, 0, 1], dtyr: 0 };
const MW_Q0 = MILKY_WAY.quat.slice();
export function galQuat0(g) { return g === MILKY_WAY ? MW_Q0 : g.quat; }
export function updateWorld(time, dtyr = 0) {
  const tyr = time / YEAR;
  world.time = time; world.tyr = tyr; world.dtyr = dtyr;
  world.sunI = sunPos(tyr); world.sunP = toPattern(world.sunI, tyr);
  world.catW = catalogWeight(tyr); world.catK = KMS_PCYR * tyr;
  const a = OMEGA_P * tyr, c = Math.cos(a), s = Math.sin(a);
  world.patAng = -a;
  // inertial-local -> pattern-local, column major mat3 (rotY by +a)
  world.rotP = [c, 0, -s, 0, 1, 0, s, 0, c];
  MILKY_WAY.quat = Q.mul(MW_Q0, Q.axis([0, 1, 0], -a));
  updateCosmo(tyr);
}

// The end of the stelliferous era: once star formation has run out of gas (~10 Gyr from now, after the merger with
// Andromeda), no new stars replace the old ones. A star of luminosity L lives about 10 Gyr * L^-0.7, so the
// brightest survivors fade: blue stars first, then Sun-like stars, leaving red dwarfs and white dwarfs.
export function popLmax(tyr) { const t = tyr / 1e9; return t < 15 ? Infinity : Math.pow(10 / (t - 5), 1 / 0.7); }
// galaxies assemble in the first billion years: the Milky Way's halo and thick disk formed 12-13 billion years ago
// (the oldest stars are ~13.2 Gyr old); before that there is nothing here to see
export function mwFormation(tyr) { const t = (tyr / 1e9 + 13.79 - 0.35) / 1.1; return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }
export function popFade(tyr) {
  const L = popLmax(tyr); if (L === Infinity) return 1;
  // beyond ~10 trillion years even the smallest red dwarfs are gone: only cooling white dwarfs remain
  return Math.min(1, Math.pow(L, 0.4)) * (tyr > 1e13 ? Math.exp(-(tyr - 1e13) / 1.5e13) : 1);
}
