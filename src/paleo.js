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
export function paleoSeaRise(myr) { return myr <= PALEO_END ? 0 : Math.min(1800, 0.45 * (myr - PALEO_END) * Math.min(1, (myr - PALEO_END) / 1500)); }
