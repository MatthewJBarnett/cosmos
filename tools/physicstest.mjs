// Physics checks against published values. Run: node tools/physicstest.mjs
// Each check prints the simulated value, the reference and PASS/FAIL against a tolerance.
const root = new URL('../src/', import.meta.url).href;
const imp = (m) => import(root + m);
const { NBody, makeBody, binary, separationForTime, petersTime, MSUN } = await imp('nbody.js');
const gd = await imp('galdyn.js');
const evo = await imp('evolution.js');
const cos = await imp('cosmology.js');
const lgo = await imp('lgorbit.js');
const tl = await imp('timeline.js');
const { galDir } = await imp('universe.js');
const { EXTRA_STARS } = await imp('realsystems.js');
const sysm = await imp('system.js');

let pass = 0, fail = 0;
function check(name, val, ref, tol, unit = '') {
  const refNum = parseFloat(String(ref).replace(/^[~<>]\s*/, ''));
  const ok = typeof tol === 'function' ? tol(val) : Math.abs(val - refNum) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${typeof val === 'number' ? +val.toPrecision(5) : val}${unit} (reference ${ref})`);
  ok ? pass++ : fail++;
}
const G = 6.674e-11, c = 299792458, YEAR = 31557600, AU = 1.495978707e11;

// --- gravitational waves and mergers ---
{
  const sim = new NBody(); const a = separationForTime(36 * MSUN, 29 * MSUN, 12);
  binary(sim, 'bh', 36 * MSUN, 'bh', 29 * MSUN, a);
  while (!sim.events.length && sim.t < 60) sim.advance(0.05, 1e6);
  const e = sim.events[0];
  check('GW150914-like: final mass', e.mf / MSUN, '62 (+4/-3) M☉, LIGO', 2.5, ' M☉');
  check('GW150914-like: final spin', e.chi, '0.67 (+0.05/-0.07)', 0.06);
  check('GW150914-like: energy radiated', e.Erad / MSUN, '3.0 ± 0.5 M☉c²', 0.5, ' M☉c²');
  check('GW150914-like: ringdown frequency', e.fRD, '~250 Hz (dominant QNM ~ 250-280 Hz)', 35, ' Hz');
  check('Inspiral time vs Peters (1964)', sim.events[0].t / 12, '1.0 (PN corrections make it somewhat longer)', (v) => v > 0.8 && v < 1.4);
}
{
  // aligned spins (both 0.9): numerical relativity gives a remnant spin ~0.93-0.95 and ~9-10% of the mass radiated
  const sim = new NBody(); binary(sim, 'bh', 36 * MSUN, 'bh', 29 * MSUN, separationForTime(36 * MSUN, 29 * MSUN, 12), { chi1: 0.9, chi2: 0.9 });
  while (!sim.events.length && sim.t < 90) sim.advance(0.05, 1e6);
  const e = sim.events[0];
  check('Aligned spins 0.9: remnant spin', e.chi, '~0.94 (Rezzolla et al. 2008)', 0.03);
  check('Aligned spins 0.9: energy radiated (fraction)', e.Erad / e.M, '~0.09-0.10 (NR)', (v) => v > 0.08 && v < 0.11);
  check('Aligned spins merge later (orbital hang-up)', e.t / 15.15, '> 1 (vs non-spinning)', (v) => v > 1.1);
}
{
  const sim = new NBody(); binary(sim, 'bh', 40 * MSUN, 'bh', 5 * MSUN, separationForTime(40 * MSUN, 5 * MSUN, 5));
  while (!sim.events.length && sim.t < 60) sim.advance(0.05, 1e6);
  check('q = 1/8 merger recoil', sim.events[0].kick / 1e3, '~80 km/s (Gonzalez et al. 2007 fit)', 25, ' km/s');
}
{
  // orbital decay rate vs Peters: da/dt = -(64/5) G^3 m1 m2 M / (c^5 a^3), measured over many orbits
  const sim = new NBody(); const m = 10 * MSUN, r = 2e6; binary(sim, 'bh', m, 'bh', m, r);
  const sep = () => { const [A, B] = sim.bodies; return Math.hypot(A.x[0] - B.x[0], A.x[1] - B.x[1], A.x[2] - B.x[2]); };
  const P = 2 * Math.PI * Math.sqrt(r ** 3 / (G * 2 * m));
  const avg = () => { let s = 0; for (let k = 0; k < 40; k++) { sim.advance(P / 40, 1e6); s += sep(); } return s / 40; };
  const t0 = sim.t, a0 = avg(); for (let k = 0; k < 8; k++) sim.advance(P, 1e6); const a1 = avg();
  const rate = (a1 - a0) / (sim.t - t0 - P), pred = -64 / 5 * G ** 3 * m * m * 2 * m / (c ** 5 * ((a0 + a1) / 2) ** 3);
  check('Orbital decay rate vs Peters (ratio)', rate / pred, '1.0 (1PN corrections ~10% at this separation)', (v) => v > 0.8 && v < 1.25);
}
{
  // GR periastron advance
  const sim = new NBody(); const rp = 1000e3, e = 0.6, m = 20 * MSUN; binary(sim, 'bh', m, 'bh', m, rp, { e });
  const angs = []; let r1 = 1e99, r2 = 1e99, lastAng = null;
  while (angs.length < 4 && sim.t < 10) {
    sim.advance(0.0005, 1e6); const [A, B] = sim.bodies; const r = Math.hypot(A.x[0] - B.x[0], A.x[2] - B.x[2]);
    if (r2 > r1 && r1 < r) angs.push(lastAng); r2 = r1; r1 = r; lastAng = Math.atan2(A.x[2] - B.x[2], A.x[0] - B.x[0]);
  }
  let d = (angs[3] - angs[1]) / 2; d = Math.abs(((d + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  const a = rp / (1 - e), pred = 6 * Math.PI * G * 2 * m / (c * c * a * (1 - e * e));
  check('Periastron advance per orbit (deg)', d * 57.2958, (pred * 57.2958).toFixed(1) + ' (6πGM/c²a(1−e²))', (v) => Math.abs(v / (pred * 57.2958) - 1) < 0.25);
}
{
  // Newtonian two-body energy conservation over 100 orbits (Earth around the Sun)
  const sim = new NBody(); sim.pn = false;
  sim.add(makeBody('star', MSUN, [0, 0, 0], [0, 0, 0])); sim.add(makeBody('planet', 5.97e24, [AU, 0, 0], [0, 0, -Math.sqrt(G * MSUN / AU)]));
  const E0 = sim.energy(); sim.advance(100 * YEAR, 1e7);
  check('Energy drift, 100 Earth orbits (RK4)', Math.abs(sim.energy() / E0 - 1), '< 1e-6', (v) => v < 1e-6);
}
{
  // figure-eight choreography returns to its start after one period (T = 6.3259 in G = m = L = 1 units)
  const sim = new NBody(); sim.pn = false; const L = AU, m = MSUN, Tu = Math.sqrt(L ** 3 / (G * m));
  const p = [[-0.97000436, 0.24308753], [0.97000436, -0.24308753], [0, 0]], v3 = [-0.93240737, -0.86473146];
  const vv = [[-v3[0] / 2, -v3[1] / 2], [-v3[0] / 2, -v3[1] / 2], v3];
  const B = p.map((q, i) => sim.add(makeBody('star', m, [q[0] * L, 0, q[1] * L], [vv[i][0] * L / Tu, 0, vv[i][1] * L / Tu], { R: 1 })));
  sim.advance(6.32591398 * Tu, 1e7);
  check('Figure-eight returns after one period', Math.hypot(B[0].x[0] / L - p[0][0], B[0].x[2] / L - p[0][1]), '< 0.01 L', (v) => v < 0.01);
}
{
  // tidal disruption: half the debris bound, fallback starting at t_min = 2 pi sqrt(a_min^3 / GM), a_min = r_t^2 / (2 R*)
  const sim = new NBody(); const Mb = 1e6 * MSUN, Rs = 6.957e8, rt = Rs * Math.cbrt(Mb / MSUN), rp = 0.5 * rt, r0 = 6 * rt;
  const pp = 2 * rp, f = -Math.acos(pp / r0 - 1), vk = Math.sqrt(G * Mb / pp);
  sim.add(makeBody('bh', Mb, [0, 0, 0], [0, 0, 0])); sim.add(makeBody('star', MSUN, [r0 * Math.cos(f), 0, r0 * Math.sin(f)], [-vk * Math.sin(f), 0, vk * (1 + Math.cos(f))]));
  while (!sim.particles) sim.advance(600, 1e6);
  const P = sim.particles; let bound = 0; for (let i = 0; i < P.n; i++) { const x = [P.x[i * 3], P.x[i * 3 + 1], P.x[i * 3 + 2]], v = [P.v[i * 3], P.v[i * 3 + 1], P.v[i * 3 + 2]]; if (0.5 * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) - G * Mb / Math.hypot(...x) < 0) bound++; }
  check('TDE: bound fraction of debris', bound / P.n, '0.5', 0.08);
  const tmin = 2 * Math.PI * Math.sqrt((rt * rt / (2 * Rs)) ** 3 / (G * Mb));
  let tf = null; for (let k = 0; k < 400 && tf === null; k++) { sim.advance(86400 / 2, 1e7); if (P.acc.length) tf = P.acc[0][0]; }
  check('TDE: first fallback time (days)', tf / 86400, (tmin / 86400).toFixed(0) + ' (t_min)', (v) => v > tmin / 86400 * 0.8 && v < tmin / 86400 * 1.6);
}

// --- stars in motion ---
{
  const near = (n) => { const e = EXTRA_STARS.find(x => x[0] === n), p = galDir(e[1], e[2]).map(x => x * e[3]), v = e[9], v2 = v[0] ** 2 + v[1] ** 2 + v[2] ** 2, t = -(p[0] * v[0] + p[1] * v[1] + p[2] * v[2]) / v2 / gd.KMS_PCYR; return { t, d: Math.hypot(...p.map((x, i) => x + v[i] * gd.KMS_PCYR * t)) }; };
  const b = near("Barnard's Star"); check("Barnard's Star closest approach (year CE)", 2000 + b.t, '~11800 CE', 300); check("Barnard's Star minimum distance (ly)", b.d * 3.2616, '3.75 ly', 0.15, ' ly');
  { const sc = near("Scholz's Star"); check("Scholz's Star closest approach (kyr)", sc.t / 1e3, '-70 (+15/-10) kyr (Mamajek 2015)', (v) => v > -95 && v < -55); check("Scholz's Star minimum distance (AU)", sc.d * 206265, '~52,000 AU (0.25 pc)', (v) => Math.abs(v - 52000) < 15000, ' AU'); }
  const g = near('Gliese 710'); check('Gliese 710 closest approach (Myr)', g.t / 1e6, '1.29 Myr (Gaia DR3)', 0.08); check('Gliese 710 minimum distance (AU)', g.d * 206265, '~10700 AU', 1500, ' AU');
}
{
  check("Sun's galactic period (Myr)", gd.SUN_ORBIT.periodYr / 1e6, '~220-240 Myr', (v) => v > 200 && v < 250);
  check("Sun's vertical oscillation amplitude (pc)", gd.SUN_ORBIT.AZ, '~85-100 pc', (v) => v > 70 && v < 110, ' pc');
  { const P = lgo.PAST, near = Math.min(...P.slice(-200).map(e => Math.hypot(e[0], e[1], e[2])));
    check('MW-M31 turnaround (Gyr ago)', P.turn / 1e3, '~5 Gyr (timing argument, Li & White 2008)', (v) => v > 4 && v < 7);
    check('MW-M31 separation at turnaround (kpc)', P.rTurn, '~1000 kpc', (v) => v > 900 && v < 1200, ' kpc');
    check('MW-M31 together near the Big Bang (kpc)', near, '< 100 kpc', (v) => v < 100, ' kpc'); }
  { const g = (t) => evo.geomagnetic(t);
    check('Magnetic polarity: today / Jaramillo (1.0 Myr) / Matuyama (2.0 Myr)', [g(26).normal, g(-1.0e6).normal, g(-2.0e6).normal].join(' '), 'true true false', (v) => v === 'true true false');
    check('Laschamp excursion field strength (41 kyr ago)', g(-41000).B, '~0.05-0.1 of today', (v) => v < 0.15);
    check('Solar cycle 19 (1958) vs cycle 24 (2014) strength', evo.solarActivity(-41.8) / evo.solarActivity(14.3), '~2.5 (SSN 285 vs 116)', (v) => v > 2 && v < 3);
    check('Maunder minimum activity (1680)', evo.solarActivity(-320), '~0', (v) => v < 0.05); }
  { const C_AU = 1.495978707e11, YR = 3.15576e7, o = { a: 17.834 * C_AU, e: 0.96714, inc: 0, node: 0, argp: 0, M0: 0, period: 75.32 * YR };
    const r = (y) => { sysm.halleyOrbit(o, y); const p = sysm.keplerPos(o, (y - 2000) * YR); return Math.hypot(...p) / C_AU; };
    check("Halley at perihelion, 20 March 1066 / 20 April 1910 (AU)", Math.max(r(1066.23), r(1910.30)), '0.59 (q)', (v) => v < 0.62, ' AU');
    check('Halley far from the Sun in 1948 (AU)', r(1948.1), '~35 (aphelion 1948)', (v) => v > 30, ' AU'); }
  { const AU = 1.495978707e11, YR = 3.15576e7, GM = 6.674e-11 * 1.989e30, q = 0.2553 * AU, e = 1.2011, a = q / (e - 1);
    const o = { hyp: true, q, e, a, inc: 0, node: 0, argp: 0, tp: 17.688 * YR, n: Math.sqrt(GM / a ** 3) };
    check("'Oumuamua at perihelion (AU)", Math.hypot(...sysm.keplerPos(o, 17.688 * YR)) / AU, '0.255', 0.002, ' AU');
    check("'Oumuamua speed far from the Sun (km/s)", Math.sqrt(GM * (e - 1) / q) / 1e3, '26.3 (Micheli et al. 2018)', 0.5, ' km/s'); }
  check('Star formation 10 Gyr ago vs today (cosmic noon)', gd.sfrRel(-10e9), '~2-3x (Madau & Dickinson 2014)', (v) => v > 2 && v < 4);
  check('LMC merges with the Milky Way (Gyr)', lgo.LMC_ORBIT.merged / 1e3, '2.4 +- 0.8 (Cautun et al. 2019)', (v) => v > 1.6 && v < 3.2);
  check('LMC distance 1.5 Gyr ago (kpc)', Math.hypot(...lgo.lmcAt(-1500)), '> 200 (first infall)', (v) => v > 200, ' kpc');
  check("Sun's vertical period (Myr)", gd.SUN_ORBIT.verticalYr / 1e6, '~70-90 Myr', (v) => v > 60 && v < 95);
}
// --- the Sun's life ---
{
  const at = (age) => evo.sunState((age - 4.57) * 1e9);
  check('Sun today L', at(4.57).L, '1', 0.001); check('Sun at end of main sequence (10 Gyr) L', at(10.0).L, '~1.9-2.2 (Sackmann 1993)', (v) => v > 1.7 && v < 2.3);
  const tip = at(evo.RGB_TIP); check('RGB tip luminosity', tip.L, '2730 L☉ (Schröder & Smith 2008)', 50); check('RGB tip radius', tip.R, '256 R☉ (1.19 AU)', 5); check('RGB tip mass', tip.M, '0.668 M☉', 0.01);
  check('White dwarf mass', at(13).M, '0.54 M☉', 0.01); check('Earth orbit at RGB tip (AU)', evo.orbitScale((evo.RGB_TIP - 4.57) * 1e9), '1.50 AU', 0.02, ' AU');
  check('Horizontal branch luminosity', at(12.25).L, '~40-50 L☉', (v) => v > 35 && v < 55);
}
{
  const da = (evo.moonScale(1) - 1) * 384400e3 * 100; check('Moon recession today (cm/yr)', da, '3.82 cm/yr (lunar laser ranging)', 0.05, ' cm/yr');
  const dP = (evo.earthDay(100) - evo.earthDay(0)) * 1000; check('Day lengthening (ms per century)', dP, '~2.3 ms/cy from tides (1.7 observed incl. other effects)', (v) => v > 1.2 && v < 3.0, ' ms');
  const pole = evo.earthPole(11727 - 0), vegaEcl = [285.32, 61.73].map(x => x * Math.PI / 180);
  const v = [Math.cos(vegaEcl[1]) * Math.cos(vegaEcl[0]), Math.sin(vegaEcl[1]), -Math.cos(vegaEcl[1]) * Math.sin(vegaEcl[0])];
  check('Vega from the pole in 13,700 CE (deg)', Math.acos(pole[0] * v[0] + pole[1] * v[1] + pole[2] * v[2]) * 57.2958, '~4-7°', (x) => x < 8, '°');
  check('Obliquity today (deg)', evo.obliquity(0) * 57.2958, '23.44°', 0.01, '°');
}
// --- cosmology and the Local Group ---
{
  cos.updateCosmo(0); check('Scale factor today', cos.cosmo.a, '1', 1e-6); check('CMB today (K)', cos.cosmo.T, '2.7255 K', 1e-4);
  check('Comoving event horizon (Gpc)', cos.U_NOW / 1000, '~5.1 Gpc (16.6 Gly)', 0.3);
  cos.updateCosmo(1e9); const v = cos.galaxyView(16.5); check('Virgo redshift in 1 Gyr', v.z, '~0.004 (H0 d / c)', 0.002);
  const e = lgo.orbitEvents(); check('M31 first pericentre (Gyr)', e.pericentres[0].t / 1000, '3.87 Gyr (van der Marel 2012)', 0.25); check('M31 merger (Gyr)', e.merged / 1000, '5.86 Gyr (van der Marel 2012)', 0.5);
  check('M31 first pericentre distance (kpc)', e.pericentres[0].d, '31 kpc (van der Marel 2012)', 15, ' kpc');
}
// --- supernova brightness ---
{
  check('Betelgeuse supernova peak from Earth (mag)', -17.1 + 5 * Math.log10(168 / 10), '~ -10 to -11 (estimates)', (v) => v > -12 && v < -9.5);
}
// --- secular orbital evolution and ice ages ---
{
  const eph = await imp('ephem.js'); const S = eph.secularModes(), AS = 180 / Math.PI * 3600;
  const g = S.e.g.map(x => x * AS).sort((a, b) => a - b), s = S.i.g.map(x => x * AS).sort((a, b) => a - b);
  // Laplace-Lagrange frequencies (Brouwer & van Woerkom 1950, without the Jupiter-Saturn great inequality terms)
  check('Secular g3 ("/yr)', g.find(x => x > 16 && x < 17.7), '17.33 (Brouwer & van Woerkom)', 0.3);
  check('Secular g4 ("/yr)', g.find(x => x > 17.7 && x < 19), '18.00', 0.3);
  check('Secular g7 ("/yr)', g[1], '2.72', 0.1); check('Secular g8 ("/yr)', g[0], '0.63', 0.05);
  check('Secular s3 ("/yr)', s.find(x => x < -18 && x > -19.5), '-18.74', 0.3);
  let mn = 1, mx = 0; for (let t = -3e6; t < 3e6; t += 1000) { const e = eph.earthOrbitAt(t).e; mn = Math.min(mn, e); mx = Math.max(mx, e); }
  check("Earth's eccentricity range", mx, '0 - 0.06 (Laskar et al. 2004: 0.0002 - 0.058)', (v) => v > 0.045 && v < 0.07 && mn < 0.005);
  check('Summer insolation at 65 N today (W/m²)', evo.insolation65(0), '~477 W/m² (Berger 1978)', 6);
  check('Insolation 11,000 yr ago (W/m²)', evo.insolation65(-11000), '~520-530 W/m² (early Holocene maximum)', 15);
  let tm = 0, vm = 0; for (let t = -40000; t < 0; t += 500) { const v = evo.iceAge(t); if (v > vm) { vm = v; tm = t; } }
  check('Last Glacial Maximum (kyr ago)', -tm / 1000, '19-26.5 kyr (Clark et al. 2009)', (v) => v > 16 && v < 27);
  let tEnd = 0; for (let t = tm; t < 0; t += 500) if (evo.iceAge(t) < 0.05) { tEnd = t; break; }
  check('Northern ice sheets gone (kyr ago)', -tEnd / 1000, '~7-9 kyr', (v) => v > 6 && v < 11);
  check('Eemian interglacial ice (125 kyr ago)', evo.iceAge(-125000), '~0 (sea level a few m above today)', 0.15);
}
// --- the Moon-forming impact ---
{
  const sbm = await imp('sandbox.js'); const sim = new NBody(); sbm.PRESETS.find(p => p.id === 'theia').setup(sim);
  let impact = null, moon = null; sim.onEvent = (e) => { if (e.impact) impact = e; if (/Moon has formed/.test(e.note)) moon = e; };
  while (sim.t < 20 * 86400 && !moon) sim.advance(sim.t < 86400 ? 60 : 1800, 200000);
  check('Theia impact speed (km/s)', impact ? +impact.note.match(/at ([\d.]+) km\/s/)[1] : 0, '~9-10 km/s (Canup 2004)', 1.5);
  check('Moon mass from the debris disk (lunar masses)', moon ? moon.body.m / 7.35e22 : 0, '~0.6-1.2 (Canup 2004, Ida et al. 1997)', (v) => v > 0.4 && v < 1.4);
}
// --- Type Ia supernova from colliding white dwarfs ---
{
  const sbm = await imp('sandbox.js'); const sim = new NBody(); sbm.PRESETS.find(p => p.id === 'wdia').setup(sim);
  while (sim.t < 100 && sim.bodies.length) sim.advance(0.5, 100000);
  const bl = (sim.blasts || [])[0], ni = bl ? bl.ni / MSUN : 0;
  // Arnett's rule with the 56Ni -> 56Co -> 56Fe decay energy, at peak (~18 days)
  let Lpk = 0; for (let td = 5; td < 40; td += 0.5) Lpk = Math.max(Lpk, ni * (6.41e43 * Math.exp(-td / 8.8) + 1.35e43 * Math.exp(-td / 111.3)) * (1 - Math.exp(-((td / 15) ** 2) * 2.3)));
  check('Type Ia: nickel mass (M☉)', ni, '0.3-0.8 M☉ (normal SNe Ia)', (v) => v >= 0.3 && v <= 0.8);
  check('Type Ia: peak bolometric magnitude', 4.74 - 2.5 * Math.log10(Lpk / 3.828e33), '-19.1 ± 0.3 (Phillips relation)', 0.5);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
