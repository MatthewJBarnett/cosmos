// The far future, beyond the last stars (100 trillion years): the degenerate era, the black hole era and the dark era
// (Adams & Laughlin 1997, "A dying universe"). Times are years after the Big Bang (at these scales the same as from now).
// A logarithmic clock runs here, like the early one, from 1e14 to 1e110 years.
export const LATE_START = 1e14, LATE_END = 1e110;
// the cosmological constant takes over: the scale factor grows by e every 1/H_Lambda = 17.4 Gyr
const T_LAMBDA = 17.4e9, LN10 = Math.LN10;
// Hawking evaporation time of a black hole of m solar masses (photons and gravitons; Page 1976)
export const evapYr = (m) => 2.1e67 * m ** 3;
// the black hole at the centre of the merged Milky Way and Andromeda (Sgr A* 4.3e6 + M31* 1.4e8 Msun), which swallows
// about a tenth of the galaxy's remnants as the galaxy evaporates
export const MILKOMEDA_BH = 1e10;
const bhMass = (L) => L < 18.5 ? 1.44e8 : L < 20.3 ? 1.44e8 + (MILKOMEDA_BH - 1.44e8) * (L - 18.5) / 1.8 : MILKOMEDA_BH;
// assumed proton lifetime (Super-Kamiokande: longer than 2.4e34 years; grand unified theories allow up to ~1e40)
export const PROTON_LIFE = 1e37;

// log10 of the cosmic microwave background temperature (K): it cools as 1/a, exponentially once dark energy dominates
export const cmbLog10 = (y) => Math.log10(2.725) - Math.max(0, y - 1.38e10) / (T_LAMBDA * LN10);
// the floor: the de Sitter horizon glows at T = hbar H / (2 pi k) ~ 2e-30 K (Gibbons & Hawking 1977)
export const DS_T = 2.2e-30;

// the state of the universe at y years: { name, text, rows: [[label, value]], vis: { red, remnants, flash } }
export function lateEra(y) {
  const L = Math.log10(Math.max(y, 1));
  let name, text;
  if (L < 15) { name = 'The degenerate era begins'; text = 'The last red dwarfs have burned out. Every star is now a dark remnant: white dwarfs, neutron stars, brown dwarfs and black holes. Now and then two brown dwarfs collide and make a new red dwarf, which shines for trillions of years: a few dozen in the whole galaxy at a time.'; }
  else if (L < 19) { name = 'Degenerate era: black dwarfs'; text = 'Close passes between remnants have stripped the planets from their stars. White dwarfs have cooled to black dwarfs a few kelvin above absolute zero; if dark matter is made of weakly interacting particles, they capture and annihilate it and stay at ~60 K.'; }
  else if (L < 20.3) { name = 'The galaxy evaporates'; text = 'Over billions of close encounters, remnants trade energy: about nine in ten are flung out of the galaxy into intergalactic space, and the rest sink into the central black hole.'; }
  else if (L < Math.log10(PROTON_LIFE) - 0.5) { name = 'Degenerate era: dispersed remnants'; text = 'Ghosts of galaxies: lone black holes with nothing around them, and dead stars drifting apart in the dark. Gravitational waves slowly shrink the last bound orbits.'; }
  else if (L < 40) { name = 'Protons decay'; text = 'If protons decay (experiments show their lifetime is longer than 2.4 × 10³⁴ years; 10³⁷ is assumed here) every black dwarf and neutron star slowly turns into light, positrons and neutrinos, glowing at about 400 watts each before it vanishes.'; }
  else if (y < evapYr(1)) { name = 'The black hole era'; text = 'Black holes are all that is left of the matter. Each slowly evaporates by Hawking radiation, colder than anything around it except the background, which is colder still.'; }
  else if (y < evapYr(60)) { name = 'Stellar black holes evaporate'; text = 'A black hole of a few solar masses loses its mass as Hawking radiation, slowly at first; in its last second it releases as much energy as a billion hydrogen bombs and vanishes in a flash of gamma rays.'; }
  else if (y < evapYr(MILKOMEDA_BH)) { name = 'Black hole era: only the giants remain'; text = 'Only supermassive black holes remain, the cores of former galaxies, each at a temperature far below a trillionth of a kelvin. Their Hawking radiation is mostly photons and gravitons of wavelengths larger than planets.'; }
  else if (y < evapYr(2e11)) { name = 'The largest black holes evaporate'; text = 'The ten-billion-solar-mass black hole at the centre of our merged galaxy has evaporated, ending in a burst of radiation. The very largest, of a hundred billion solar masses in the hearts of giant clusters, last until about 10¹⁰⁰ years.'; }
  else { name = 'The dark era'; text = 'No structure remains: only photons of enormous wavelength, neutrinos, electrons and positrons, ever farther apart. Nothing is left to happen except, perhaps, quantum fluctuations.'; }
  const rows = [];
  const lc = cmbLog10(y);
  rows.push(['Background', '2 × 10⁻³⁰ K, the glow of the cosmic event horizon (the microwave background has cooled to 10' + supNum(lc) + ' K)']);
  // our galaxy (the merged Milky Way and Andromeda)
  const bound = L < 18.5 ? 1 : L < 20.3 ? 1 - 0.9 * (L - 18.5) / 1.8 : 0.1;
  const protonsLeft = Math.exp(-y / PROTON_LIFE);
  if (y < evapYr(MILKOMEDA_BH)) {
    let g;
    if (L < 20.3) g = Math.round(bound * 100) + '% of its remnants still bound, around a ' + fmtMass(bhMass(L)) + ' black hole' + (L < 15 ? '; a few dozen red dwarfs lit by brown dwarf collisions' : '');
    else if (protonsLeft > 1e-3) g = 'evaporated: a ' + fmtMass(MILKOMEDA_BH) + ' black hole, its remnants scattered across megaparsecs';
    else g = 'only its central black hole, ' + fmtMass(MILKOMEDA_BH * Math.cbrt(Math.max(0, 1 - y / evapYr(MILKOMEDA_BH)))) + ' (Hawking temperature ' + (6.17e-8 / MILKOMEDA_BH).toExponential(0) + ' K)';
    rows.push(['Our galaxy', g]);
  } else rows.push(['Our galaxy', 'gone: its central black hole evaporated ' + supYears(evapYr(MILKOMEDA_BH)) + ' after the Big Bang']);
  if (L >= 30 && L < 45) rows.push(['Protons', protonsLeft > 0.999 ? 'stable so far (lifetime assumed 10³⁷ years)' : protonsLeft > 1e-6 ? (100 * protonsLeft).toPrecision(2) + '% remain' : 'all decayed']);
  if (L >= 40) {
    // black holes: the largest that has evaporated by now, and the Hawking temperature of the galaxy's central one
    const mGone = Math.cbrt(y / 2.1e67);
    rows.push(['Black holes', mGone < 1 ? 'all still here, slowly evaporating' : y < evapYr(2e11) ? 'every black hole under ' + fmtMass(mGone) + ' has evaporated' : 'none left']);
  }
  // the visuals: newly lit red dwarfs, remnant density (seen only in the far infrared), and evaporation flashes
  const vis = { red: L < 19.5 ? 1 - Math.max(0, L - 18.5) : 0, remnants: L < 20.3 ? bound : L < 40 ? 0.1 * protonsLeft : 0, central: y < evapYr(MILKOMEDA_BH) ? 1 : 0 };
  // the central black hole's final moments (within 0.3 decades of its evaporation): a flash
  const le = Math.log10(evapYr(MILKOMEDA_BH));
  vis.flash = Math.max(0, 1 - Math.abs(L - le) / 0.3) * (L < le + 0.02 ? 1 : 0.4);
  return { name, text, rows, vis, L };
}
const SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '.': '·' };
const sup = (s) => String(s).split('').map(c => SUP[c] || c).join('');
// 10^x where x itself may be huge: 10^-2512, or 10^(-2.5 x 10^89) (HTML)
function supNum(x) {
  if (Math.abs(x) < 1e5) return '<sup>' + (x < 0 ? '−' : '') + Math.abs(Math.round(x)) + '</sup>';
  const e = Math.floor(Math.log10(Math.abs(x))), m = Math.abs(x) / 10 ** e;
  return '<sup>' + (x < 0 ? '−' : '') + m.toFixed(1) + ' × 10<sup>' + e + '</sup></sup>';
}
export const supYears = (y) => { const e = Math.floor(Math.log10(y)), m = y / 10 ** e; return (m >= 1.05 ? m.toFixed(1) + ' × ' : '') + '10' + sup(e) + ' years'; };
const fmtMass = (m) => m < 1e3 ? Math.round(m) + ' M☉' : m < 1e6 ? Math.round(m / 1e3) + ' thousand M☉' : m < 1e9 ? Math.round(m / 1e6) + ' million M☉' : (m < 1e11 ? (m / 1e9).toPrecision(2) : Math.round(m / 1e9)) + ' billion M☉';
