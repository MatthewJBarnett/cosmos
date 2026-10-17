// Plate tectonics: present-day plate motions (NNR-NUVEL-1A Euler poles, DeMets et al. 1994; plate outlines from
// Bird 2003, PB2002, with the microplates merged into their neighbours) carried forward in time. Each plate turns
// rigidly about its pole. The motions are held constant, which is a fair guess for a few tens of millions of years;
// the arrangement is frozen beyond +100 Myr (and -50 Myr), where the real future depends on how subduction evolves.
import { Q, clamp } from './math.js';

// index in the plate map: [code, pole latitude, pole longitude (deg), rotation rate (deg/Myr)]
export const PLATES = [null,
  ['AF', 50.569, -73.978, 0.2909], ['AN', 62.99, -115.76, 0.2383], ['IN', 45.51, 0.34, 0.5447], ['AU', 33.85, 33.17, 0.6470],
  ['EU', 50.62, -112.27, 0.2337], ['NA', -2.43, -85.90, 0.2068], ['SA', -25.35, -124.6, 0.1162], ['NZ', 47.80, -100.13, 0.7434],
  ['PA', -63.04, 107.33, 0.6411], ['AR', 45.23, -4.46, 0.5459], ['CA', 25.01, -93.01, 0.2140], ['CO', 24.47, -115.77, 1.5101],
  ['PS', -46.0, -31.4, 0.90]];
export const driftMyr = (tyr) => { const t = clamp(tyr / 1e6, -50, 100); return Math.abs(t) < 0.05 ? 0 : t; };
// for each plate, the rotation taking a point's position at time t back to where that crust is today
// (planet-local axes: y north, longitude 0 on +x, 90 E on -z)
const out = new Float32Array(14 * 9);
export function plateInverse(tMyr) {
  for (let k = 0; k < 14; k++) {
    let m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const p = PLATES[k];
    if (p) {
      const la = p[1] * Math.PI / 180, lo = p[2] * Math.PI / 180;
      const axis = [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
      m = Q.mat3(Q.axis(axis, -p[3] * tMyr * Math.PI / 180));
    }
    out.set(m, k * 9);
  }
  return out;
}
