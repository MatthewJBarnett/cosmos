// Paleogeography for Earth's deep past: PALEOMAP Paleo-Digital Elevation Models (Scotese & Wright 2018, CC BY 4.0),
// one global elevation grid every ~5 Myr from today back to 540 Myr ago (Cambrian). Earlier than PALEO_START the
// terrain shader draws these, blended between the two nearest epochs; the slices load as they are needed.
import { loadTexture } from './assets.js';

export const PALEO_START = 3;           // Myr ago: younger than this, the real maps (and plate drift) are used
export const PALEO_END = 540;
let index = null;
fetch('data/paleo/index.json').then(r => r.json()).then(j => { index = j; }).catch(() => { index = []; });
const tex = (i) => loadTexture('data/paleo/' + index[i][1], 'data');
let last = null;
// textures for an epoch (Myr ago), or the last complete pair while new slices load
export function paleoState(myr) {
  if (!index || !index.length) return last;
  const req = myr; myr = Math.min(Math.max(myr, 0), PALEO_END);
  let i = 0; while (i < index.length - 2 && index[i + 1][0] < myr) i++;
  const a = tex(i), b = tex(i + 1), k = Math.min(Math.max((myr - index[i][0]) / (index[i + 1][0] - index[i][0]), 0), 1);
  // look ahead: the next slices in either direction
  if (i > 0) tex(i - 1); if (i + 2 < index.length) tex(i + 2);
  if (a.ready && b.ready) last = { a: a.tex, b: b.tex, k, myr: req };
  return last;
}
// Before the oldest map: continents were smaller (continental crust grew through the Archean and Proterozoic), so the
// oldest map is drowned progressively, leaving a few emergent cratons ~3.5 Gyr ago (metres of relative sea level)
// Which map to show, and turned by how much about the pole, for a time tyr (years from now; null: today's map with
// plate drift). Back to 540 Myr: the real PALEOMAP epoch. Beyond the maps, and more than 100 Myr into the future, the
// continents are illustrative only: the supercontinent cycle (~500-800 Myr) is run through the maps' own Pangaea
// assembly and breakup, turned about the pole, so that Rodinia (~1,000-750 Myr ago), Columbia (~1,800-1,400 Myr ago)
// and a future supercontinent (~250 Myr from now) appear at about the right times. Their real shapes are unknown.
const smooth01 = (x) => x * x * (3 - 2 * x);
export function paleoMap(tyr) {
  const myr = -tyr / 1e6;
  if (myr > PALEO_START && myr <= PALEO_END) return { map: myr, rot: 0, stand: '' };
  if (myr > PALEO_END) {
    const P = 800, x = (myr - PALEO_END) % P, k = Math.floor((myr - PALEO_END) / P), tri = x < P / 2 ? x / (P / 2) : (P - x) / (P / 2);
    const stand = myr > 750 && myr < 1100 ? 'Rodinia' : myr > 1400 && myr < 1900 ? 'Columbia' : 'between supercontinents';
    return { map: PALEO_END - 290 * tri, rot: 2.4 * (k + smooth01(x / P)), stand };
  }
  const f = -myr;
  if (f > 100) {
    const P = 300, x = (f - 100) % P, tri = x < P / 2 ? x / (P / 2) : (P - x) / (P / 2);
    return { map: 100 + 150 * tri, rot: Math.PI + 0.6 * (f - 100) / P, stand: tri > 0.6 ? 'a future supercontinent' : 'continents drifting' };
  }
  return null;
}
export function paleoSeaRise(myr) { return myr <= PALEO_END ? 0 : Math.min(1800, 0.45 * (myr - PALEO_END) * Math.min(1, (myr - PALEO_END) / 1500)); }
