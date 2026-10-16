// Real, observed planetary systems around nearby stars. Values from the NASA Exoplanet Archive (rounded).
// Planets: [name, period (days), a (AU), e, mass (Earth masses; minimum mass where only m sin i is known), radius (Earth radii) | null]
import { galDir, SUN_POS } from './universe.js';
import { V } from './math.js';

export const REAL_SYSTEMS = {
  'Proxima Centauri': { planets: [['Proxima d', 5.122, 0.02886, 0.04, 0.26, null], ['Proxima b', 11.1868, 0.04856, 0.02, 1.07, null]] },
  'TRAPPIST-1': { planets: [['TRAPPIST-1 b', 1.51088, 0.01154, 0.006, 1.374, 1.116], ['TRAPPIST-1 c', 2.42180, 0.01580, 0.007, 1.308, 1.097], ['TRAPPIST-1 d', 4.04978, 0.02227, 0.008, 0.388, 0.788],
    ['TRAPPIST-1 e', 6.09965, 0.02925, 0.005, 0.692, 0.920], ['TRAPPIST-1 f', 9.20669, 0.03849, 0.010, 1.039, 1.045], ['TRAPPIST-1 g', 12.35294, 0.04683, 0.002, 1.321, 1.129], ['TRAPPIST-1 h', 18.7729, 0.06189, 0.006, 0.326, 0.755]] },
  "Barnard's Star": { planets: [['Barnard b', 3.1542, 0.0229, 0.03, 0.37, null]] },
  'Helvetios': { planets: [['Dimidium (51 Peg b)', 4.2308, 0.0527, 0.01, 146, 14.0]] },
  'Ran': { planets: [['AEgir (Eps Eri b)', 2692, 3.53, 0.07, 210, null]] },
  'Tau Cet': { planets: [['Tau Ceti g', 20.0, 0.133, 0.06, 1.75, null], ['Tau Ceti h', 49.41, 0.243, 0.23, 1.83, null], ['Tau Ceti e', 162.87, 0.538, 0.18, 3.93, null], ['Tau Ceti f', 636.13, 1.334, 0.16, 3.93, null]] },
  'Sirius': { companion: { name: 'Sirius B', MV: 11.18, T: 25000, spect: 'DA2', mass: 1.018, radius: 0.0084, a: 19.8, e: 0.59, period: 50.13 }, planets: [] },
};

// Nearby stars too faint for the catalogue but famous for their planets: [name, l, b, distance pc, MV, T, spectral type, mass Msun, radius Rsun,
// heliocentric space velocity in the galaxy frame (km/s: towards the centre, north, towards l=270)]
export const EXTRA_STARS = [
  ['Proxima Centauri', 313.94, -1.93, 1.3020, 15.49, 3042, 'M5.5Ve', 0.1221, 0.1542, [-29.44, 13.79, -1.84]],
  ['TRAPPIST-1', 69.71, -56.64, 12.47, 18.32, 2566, 'M8V', 0.0898, 0.1192, [-44.9, 14.49, 69.1]],
  ["Barnard's Star", 31.01, 14.06, 1.834, 13.21, 3134, 'M4V', 0.162, 0.187, [-141.43, 18.61, -5.13]],
  // Gaia DR3: will pass about 10,000 AU from the Sun in 1.3 million years, through the Oort cloud
  ['Gliese 710', 27.17737, 6.89768, 19.0, 8.2, 4100, 'K7V', 0.6, 0.62, [-12.4567, -1.6551, 6.3956]],
];
export function extraStarPos(e) { return V.addm(SUN_POS, galDir(e[1], e[2]), e[3]); }
