// Meteors seen from Earth's surface: dust from comets burning up at ~80-120 km. Annual showers peak at fixed solar
// longitudes (when Earth crosses a comet's debris stream) and seem to come from a radiant; sporadic meteors arrive
// from anywhere, more after midnight (the side of Earth facing its orbital motion).
import { V, Q, C } from './math.js';
import { eqToEngine } from './ephem.js';

// [name, solar longitude of peak (deg), RA, Dec (deg), ZHR, speed km/s, B (activity falls as 10^(-B |dL|))]
const SHOWERS = [
  ['Quadrantids', 283.15, 230, 49, 110, 41, 2.5],
  ['Lyrids', 32.32, 271, 34, 18, 49, 0.35],
  ['Eta Aquariids', 45.5, 338, -1, 50, 66, 0.08],
  ['Perseids', 140.0, 48, 58, 100, 59, 0.2],
  ['Orionids', 208, 95, 16, 20, 66, 0.12],
  ['Leonids', 235.27, 152, 22, 15, 71, 0.4],
  ['Geminids', 262.2, 112, 33, 150, 35, 0.4],
];
for (const s of SHOWERS) s.dir = eqToEngine(s[2], s[3]);
// [decimal year of the peak, peak hourly rate]: 13 Nov 1833, 14 Nov 1866, 17 Nov 1966, 18 Nov 1999, 18 Nov 2001
const LEONID_STORMS = [[1833.8689, 60000], [1866.8723, 6000], [1966.8810, 100000], [1999.8822, 3700], [2001.8822, 3000]];

let active = [], seed = 12345;
export const meteorCfg = { boost: 1 };    // (tests raise this to see many at once)
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
// solar longitude (deg) from the Earth and Sun positions in the ecliptic system frame
function solarLongitude(earth, sun) { const d = V.sub(sun.pos, earth.pos); return ((Math.atan2(-d[2], d[0]) * 180 / Math.PI) + 360) % 360; }

// Returns points for drawPoints: meteors currently burning, as seen by the camera
export function updateMeteors(nav, dtReal) {
  const sys = nav.system, an = nav.anchor, out = [];
  if (!sys || !an || an.name !== 'Earth' || nav.altitude > 40e3 || nav.paused || Math.abs(nav.rate) > 30) { active = []; return out; }
  const sun = sys.find('Sun'); if (!sun) return out;
  const dt = dtReal * nav.rate;
  const up = V.norm(V.sub(nav.S, an.wpos));
  const lam = solarLongitude(an, sun);
  // shower activity now (zenithal hourly rates), plus ~8 sporadic meteors per hour, more towards dawn
  // the apex of Earth's orbital motion (the morning sky) sweeps up more sporadic meteoroids
  const toSun = V.norm(V.sub(sun.wpos, an.wpos)), apex = V.norm(V.cross(toSun, Q.rot(sys.worldQ, [0, 1, 0])));
  const dawn = 0.5 + 0.8 * Math.max(0, V.dot(up, apex));
  const sources = [{ zhr: 8 * dawn, dir: null, v: 30 }];
  for (const s of SHOWERS) {
    let dL = Math.abs(lam - s[1]); if (dL > 180) dL = 360 - dL;
    let zhr = s[4] * Math.pow(10, -s[6] * dL);
    // meteor storms: Earth crosses a fresh dust trail of comet Tempel-Tuttle (1833 and 1966: tens of thousands an hour)
    if (s[0] === 'Leonids') { const y = 2000 + nav.time / 31557600; for (const [ys, peak] of LEONID_STORMS) if (Math.abs(y - ys) < 0.003) zhr = Math.max(zhr, peak * Math.exp(-((((y - ys) * 365.25 * 24) / 1.5) ** 2))); }
    if (zhr > 0.5) sources.push({ zhr, dir: Q.rot(sys.worldQ, s.dir), v: s[5], name: s[0] });
  }
  for (const src of sources) {
    // radiants below the horizon give (almost) no meteors; rate scales with the radiant's altitude
    let h = 1; if (src.dir) { h = V.dot(src.dir, up); if (h <= 0.02) continue; }
    const rate = src.zhr / 3600 * h * meteorCfg.boost;      // per second over the whole visible sky (limiting magnitude ~6.5)
    let n = rate * Math.abs(dt);
    while (n > 0) { if (rnd() < Math.min(n, 1)) spawn(src, up, an, nav.S); n -= 1; }
  }
  const out2 = out;
  active = active.filter(m => (m.age += Math.abs(dt)) < m.dur + 1.2);
  for (const m of active) {
    // light curve: rises, flares, ends abruptly; the glowing train lingers a moment
    const x = m.age / m.dur;
    const lc = x < 1 ? Math.sin(Math.PI * Math.min(x, 1) * 0.92) ** 0.6 : 0;
    const N = 14, base = V.add(an.wpos, m.p0);
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1), back = Math.min(m.age, m.dur) * f * 0.35;
      const p = V.sub(V.add(base, V.mul(m.v, Math.max(0, Math.min(m.age, m.dur) - back))), nav.S);
      const d = V.len(p);
      // flux of a magnitude M meteor at 100 km, at distance d
      // half the light in the head (what the eye locks on to), the rest along the fading streak
      const share = i === 0 ? 0.5 : 0.5 / (N - 1) * 2 * (1 - f);
      const flux = Math.exp(-0.9210340372 * (m.M + 5 * Math.log10(d / 1e5) + 26.74)) * (x < 1 ? lc * share : 0.04 / N * Math.exp(-(m.age - m.dur) * 3) * (1 - f));
      if (flux > 0) out2.push({ dir: p, color: m.col, flux });
    }
  }
  return out2;
}
function spawn(src, up, an, S) {
  // radiant direction (sporadic: random above the horizon)
  let dir = src.dir;
  if (!dir) { do { dir = V.norm([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]); } while (V.dot(dir, up) < 0.1); }
  // a point ~100 km up and up to ~400 km away horizontally
  const e1 = V.norm(V.cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = V.cross(up, e1);
  const r = 400e3 * Math.sqrt(rnd()), a = rnd() * 2 * Math.PI, alt = 95e3 + rnd() * 25e3;
  // (kept relative to Earth's centre so the meteor travels with the planet)
  const p0 = V.sub(V.add(V.add(S, V.mul(up, alt)), V.add(V.mul(e1, r * Math.cos(a)), V.mul(e2, r * Math.sin(a)))), an.wpos);
  const v = V.mul(dir, -src.v * 1e3);           // moving away from the radiant
  const dur = 0.25 + rnd() * 0.8 * (40 / src.v); // faster meteors burn out sooner
  // magnitude distribution: population index ~2.5, most faint, a few bright, rare fireballs
  const M = 6 - Math.log(1 / Math.max(rnd(), 1e-6)) / Math.log(2.5) * 1.8;
  const col = src.v > 55 ? [0.75, 0.95, 0.85] : src.v < 40 ? [1.0, 0.85, 0.6] : [0.9, 0.92, 1.0];   // fast: Mg/O green, slow: Na/Fe yellow
  active.push({ p0, v, dur, age: 0, M: Math.max(M, -6), col });
  if (active.length > 60) active.shift();
}
