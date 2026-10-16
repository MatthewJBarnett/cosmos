// Galactic dynamics of the Milky Way: differential rotation, the Sun's epicyclic orbit, stellar motions.
// Positions are in the galaxy's local frame (pc, x towards the centre from the Sun's epoch position, y to the NGP).
import { SUN_POS } from './universe.js';

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

// star at epoch position p0 rotating rigidly with the disk at its radius
export function procPos(p0, tyr, Rref) { if (!tyr) return p0.slice(); const R = Rref !== undefined ? Rref : Math.hypot(p0[0], p0[2]); return rotY(p0, rotAngle(R, tyr)); }
// inverse: current position -> epoch position (uses the current radius)
export function toEpoch(p, tyr) { if (!tyr) return p.slice(); const R = Math.hypot(p[0], p[2]); return rotY(p, -rotAngle(R, tyr)); }

// Catalogue stars: Sun-relative epoch position and heliocentric velocity (km/s). Valid for a few Myr (linear motion
// in the frame rotating with the local standard of rest), after which the catalogue fades into the statistical field.
export function catalogPos(prel, vel, tyr) {
  const k = KMS_PCYR * tyr;
  const q = [SUN_POS[0] + prel[0] + (vel[0] + VSUN[0]) * k, SUN_POS[1] + prel[1] + (vel[1] + VSUN[1]) * k, SUN_POS[2] + prel[2] + (vel[2] + VSUN[2]) * k];
  return rotY(q, rotAngle(R0, tyr));
}
export const CAT_FADE0 = 1.0e6, CAT_FADE1 = 3.0e6;
export function catalogWeight(tyr) { const a = Math.abs(tyr); return a <= CAT_FADE0 ? 1 : a >= CAT_FADE1 ? 0 : 1 - (a - CAT_FADE0) / (CAT_FADE1 - CAT_FADE0); }

// The Sun's galactic orbit: guiding centre on a circle plus radial and vertical epicycles (bounded for any time span).
const KAPPA = Math.SQRT2 * omega(R0) * 1.02, NU = 2 * Math.PI / 7.6e7;
const AR = VSUN[0] * KMS_PCYR / KAPPA;                       // radial amplitude from U
const AZ = Math.hypot(SUN_POS[1], VSUN[1] * KMS_PCYR / NU), PZ = Math.atan2(SUN_POS[1] * NU, VSUN[1] * KMS_PCYR);
const OMS = (V0 * R0 / Math.sqrt(R0 * R0 + RC * RC) - VSUN[2]) / R0 * KMS_PCYR;  // azimuthal rate including V
export function sunPos(tyr) {
  if (!tyr) return SUN_POS.slice();
  const R = R0 - AR * Math.sin(KAPPA * tyr), z = AZ * Math.sin(NU * tyr + PZ);
  const a = -OMS * tyr;
  const p = [-R, z, 0];                                     // epoch azimuth: Sun on the -x axis
  return rotY(p, a);
}
export const SUN_ORBIT = { periodYr: 2 * Math.PI / OMS, verticalYr: 2 * Math.PI / NU, radialYr: 2 * Math.PI / KAPPA, AZ, AR };

// current position of anything described by a star descriptor
export function descPos(desc, tyr) {
  if (desc.sol) return sunPos(tyr);
  if (desc.catIndex !== undefined && desc.vel) return catalogPos([desc.pos[0] - SUN_POS[0], desc.pos[1] - SUN_POS[1], desc.pos[2] - SUN_POS[2]], desc.vel, tyr);
  return procPos(desc.pos, tyr, desc.cellR);
}

// --- massive star life cycles in the procedural field (shader side uses the same classes) ---
// classes by absolute magnitude: lifetimes (yr) of the progenitors that end as core collapse supernovae
export const SN_CLASSES = [
  { mv: -6.0, tau: 4e6 }, { mv: -5.0, tau: 6e6 }, { mv: -4.0, tau: 9e6 }, { mv: -3.0, tau: 14e6 }, { mv: -2.0, tau: 22e6 }, { mv: -1.2, tau: 35e6 },
];
// cycle phases at time tyr (computed in double precision, passed to the shader)
export function snPhases(tyr) { return SN_CLASSES.map(c => { const x = tyr / c.tau; return x - Math.floor(x); }); }
