// Deep time: date formatting from seconds to trillions of years, a list of future (and past) events with views,
// and automatic slow-down so that brief events are not skipped over at high time rates.
import { V, Q, C, clamp } from './math.js';
import { YEAR, SUN_ORBIT, world, KMS_PCYR, sunPos } from './galdyn.js';
import { galDir } from './universe.js';
import { EXTRA_STARS } from './realsystems.js';
import { orbitEvents, R0, V0 } from './lgorbit.js';
import { RGB_TIP, PN_START, WD_START, SUN_AGE_NOW, engulfed } from './evolution.js';

const J2000 = Date.UTC(2000, 0, 1, 12);
export const nowYr = () => (Date.now() - J2000) / 1000 / YEAR;     // years since J2000 of the real present
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtSpan(yr) {
  const a = Math.abs(yr);
  if (a < 1) return (a * 365.25).toFixed(0) + ' days';
  if (a < 1e4) return a.toFixed(a < 10 ? 1 : 0) + ' years';
  if (a < 1e6) return Math.round(a).toLocaleString('en') + ' years';
  if (a < 1e9) return (a / 1e6).toPrecision(4) + ' million years';
  if (a < 1e12) return (a / 1e9).toPrecision(4) + ' billion years';
  return (a / 1e12).toPrecision(4) + ' trillion years';
}
// simulation time (s since J2000) -> readable date
export function fmtSimDate(t) {
  const yr = t / YEAR;
  if (Math.abs(yr) < 7900) {
    const d = new Date(J2000 + t * 1000);
    if (!isNaN(d)) { const y = d.getUTCFullYear(); const s = d.toISOString(); return (y < 0 || y > 9999 ? (y < 0 ? (1 - y) + ' BCE ' : y + ' ') + s.slice(s.indexOf('-', 1) + 1, s.indexOf('T')) + ' ' + s.slice(s.indexOf('T') + 1, s.indexOf('T') + 9) : s.replace('T', ' ').slice(0, 19)) + ' UTC'; }
  }
  if (Math.abs(yr) < 2.5e5) {
    const d = new Date(J2000 + t * 1000);
    if (!isNaN(d)) { const y = d.getUTCFullYear(); return (y > 0 ? 'Year ' + y.toLocaleString('en') : (1 - y).toLocaleString('en') + ' BCE') + ', ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
  }
  const dy = yr - nowYr();
  return fmtSpan(dy) + (dy >= 0 ? ' from now' : ' ago');
}
export function fmtRate(r) {
  const a = Math.abs(r), s = r < 0 ? '−' : '';
  if (a === 1) return s + 'real time';
  if (a < 1) return s + (+a.toPrecision(3)) + '×';
  if (a < 60) return s + (+a.toPrecision(3)) + '×';
  if (a < 3600) return s + (a / 60).toPrecision(3) + ' min/s';
  if (a < 86400) return s + (a / 3600).toPrecision(3) + ' h/s';
  if (a < YEAR) return s + (a / 86400).toPrecision(3) + ' d/s';
  const y = a / YEAR;
  if (y < 1e3) return s + y.toPrecision(3) + ' yr/s';
  if (y < 1e6) return s + (y / 1e3).toPrecision(3) + ' kyr/s';
  if (y < 1e9) return s + (y / 1e6).toPrecision(3) + ' Myr/s';
  return s + (y / 1e9).toPrecision(3) + ' Gyr/s';
}
export const RATES = [0.001, 0.01, 0.1, 0.25, 0.5, 1, 10, 60, 600, 3600, 6 * 3600, 86400, 7 * 86400, 30 * 86400, YEAR / 4, YEAR, YEAR * 10, YEAR * 100, YEAR * 1e3, YEAR * 1e4, YEAR * 1e5, YEAR * 1e6, YEAR * 1e7, YEAR * 3e7, YEAR * 1e8, YEAR * 3e8, YEAR * 1e9, YEAR * 1e10];
export const MAX_T = 1e14 * YEAR;

// ---------- events ----------
// t: years since J2000 at which the event is seen from the Solar System. rate: time rate (s/s) to slow to.
// est: the date is a model estimate. go(nav, ui): set up a view.
const closest = (e) => { const p = V.mul(galDir(e[1], e[2]), e[3]), v = e[9]; const v2 = V.dot(v, v); const t = -V.dot(p, v) / v2 / KMS_PCYR; return { t, d: V.len(V.addm(p, v, KMS_PCYR * t)) }; };
const extra = (n) => EXTRA_STARS.find(e => e[0] === n);

function nextMidplane() {
  // next time the Sun crosses the galactic plane going north or south
  let t = nowYr(), z0 = sunPos(t)[1];
  for (let k = 1; k < 4000; k++) { const t1 = nowYr() + k * 1e5, z1 = sunPos(t1)[1]; if (z0 * z1 <= 0) return t1 - 1e5 * z1 / (z1 - z0); z0 = z1; }
  return nowYr() + 1e7;
}

export function buildEvents() {
  const now = nowYr(), ev = [];
  const add = (o) => ev.push(o);
  const bar = closest(extra("Barnard's Star")), g710 = closest(extra('Gliese 710'));
  add({ id: 'barnard', maxRate: 300000.0, t: bar.t, title: "Barnard's Star at its closest", text: `The fastest moving star in our sky passes ${(bar.d * 3.2616).toFixed(2)} light years from the Sun, then recedes.`, view: { star: "Barnard's Star", from: 'sun' }, rate: YEAR * 300 });
  add({ id: 'vega', maxRate: 300000.0, t: 11727, title: 'Vega is the pole star', text: 'Precession of Earth\'s axis (a 25,772 year cycle) brings the north celestial pole within 4° of Vega.', view: { pole: true }, rate: YEAR * 50 });
  add({ id: 'acen', maxRate: 300000.0, t: 27600, title: 'Alpha Centauri at its closest', text: 'Our nearest neighbours pass 2.9 light years from the Sun and shine at magnitude −1.9, rivalling Sirius.', view: { star: 'Rigil Kentaurus', from: 'sun' }, rate: YEAR * 300 });
  add({ id: 'betelgeuse', hold: 25, maxRate: 300000.0, t: 1e5, est: true, title: 'Betelgeuse explodes', text: 'The red supergiant in Orion ends as a core collapse supernova. From 168 parsecs it outshines the half Moon for months and stays visible in daylight.', view: { star: 'Betelgeuse', from: 'earth' }, rate: 86400 * 6 });
  add({ id: 'antares', hold: 25, maxRate: 3000000.0, t: 6e5, est: true, title: 'Antares explodes', text: 'The heart of the Scorpion, a red supergiant 170 parsecs away, becomes a supernova.', view: { star: 'Antares', from: 'earth' }, rate: 86400 * 6 });
  add({ id: 'g710', hold: 8, maxRate: 3000000.0, t: g710.t, title: 'Gliese 710 passes through the Oort cloud', text: `An orange dwarf passes ${Math.round(g710.d * 206265).toLocaleString('en')} AU from the Sun, shining at magnitude −2.7, and perturbs comets towards the planets.`, view: { star: 'Gliese 710', from: 'sun' }, rate: YEAR * 2000 });
  add({ id: 'midplane', maxRate: 300000000.0, t: nextMidplane(), title: 'The Sun crosses the galactic plane', text: 'The Sun bobs through the disk every ~38 million years on its orbit around the Galaxy.', view: { galaxy: 'side' }, rate: YEAR * 1e5 });
  add({ id: 'galyear', maxRate: 3000000000.0, t: now + SUN_ORBIT.periodYr, title: 'One galactic year', text: `The Sun completes an orbit around the centre of the Milky Way (${(SUN_ORBIT.periodYr / 1e6).toFixed(0)} million years).`, view: { galaxy: 'top' }, rate: YEAR * 2e6 });
  add({ id: 'phobos', t: now + 4e7, est: true, title: 'Phobos breaks up', text: 'Tides drag Mars\' inner moon inward until it is torn apart: Mars has a ring for about a hundred million years.', view: { body: 'Mars' }, rate: YEAR * 1e5 });
  add({ id: 'eclipses', t: now + 6.0e8, est: true, title: 'The last total solar eclipse', text: 'The Moon recedes about 3.8 cm a year. Once it looks smaller than the Sun, every central eclipse is annular.', view: { body: 'Moon' }, rate: YEAR * 1e6 });
  add({ id: 'oceans', t: now + 1.1e9, est: true, title: 'Earth\'s oceans boil away', text: 'The Sun brightens ~1% every 110 million years. A moist greenhouse strips Earth\'s water to space.', view: { body: 'Earth' }, rate: YEAR * 2e6 });
  add({ id: 'lmc', t: now + 2.4e9, est: true, title: 'The Large Magellanic Cloud merges with the Milky Way', text: 'Dynamical friction drags our largest satellite galaxy into the disk.', view: { galaxy: 'top' }, rate: YEAR * 5e6 });
  const lg = orbitEvents(), p1 = lg.pericentres[0], p2 = lg.pericentres[1];
  add({ id: 'm31near', t: now + 3.0e9, est: true, title: 'Andromeda fills the sky', text: 'Approaching at 250 km/s, the Andromeda Galaxy spans tens of degrees of the night sky, as bright as the Milky Way.', view: { lg: 'sun' }, rate: YEAR * 5e6 });
  if (p1) add({ id: 'm31', hold: 12, t: now + p1.t * 1e6, est: true, title: 'Andromeda\'s first passage', text: `The galaxies' centres pass ${p1.d.toFixed(0)} kpc apart at ~450 km/s. Tides tear both disks into long tails. (N-body simulation, 65,536 particles.)`, view: { lg: 'outside' }, rate: YEAR * 1e7 });
  if (p2) add({ id: 'm31b', hold: 8, t: now + p2.t * 1e6, est: true, title: 'Second passage', text: 'Dynamical friction has drained the orbit; the galaxies fall back together.', view: { lg: 'outside' }, rate: YEAR * 1e7 });
  if (lg.merged > 0) add({ id: 'merge', hold: 10, t: now + lg.merged * 1e6, est: true, title: 'Milkomeda', text: 'The two centres coalesce. Over the next billion years the debris settles into one giant elliptical galaxy.', view: { lg: 'outside' }, rate: YEAR * 1e7 });
  const ageT = (age) => (age - SUN_AGE_NOW) * 1e9;
  const engulfT = (name) => { for (let a = 12.0; a < 12.2; a += 0.0002) if (engulfed(name, ageT(a))) return ageT(a); return null; };
  add({ id: 'triton', t: now + 3.6e9, est: true, title: 'Triton is torn apart', text: 'Neptune\'s large moon orbits backwards; tides shrink its orbit until it breaks up into a ring around Neptune.', view: { body: 'Neptune' }, rate: YEAR * 2e6 });
  add({ id: 'subgiant', t: ageT(10.0), title: 'The Sun leaves the main sequence', text: 'Hydrogen in the core runs out after 10 billion years. The Sun swells and cools into a subgiant, twice as bright as today.', view: { body: 'Sun' }, rate: YEAR * 1e6 });
  const tm = engulfT('Mercury'), tv = engulfT('Venus');
  if (tm) add({ id: 'mercury', t: tm, title: 'Mercury is swallowed', text: 'The red giant Sun grows past Mercury\'s orbit.', view: { body: 'Venus', far: true }, rate: YEAR * 2e5 });
  if (tv) add({ id: 'venus', t: tv, title: 'Venus is swallowed', text: 'The Sun\'s envelope engulfs Venus; drag in the thin outer layers spirals it in.', view: { body: 'Mars', far: true }, rate: YEAR * 1e5 });
  add({ id: 'rgb', hold: 8, t: ageT(RGB_TIP), title: 'The Sun at the tip of the red giant branch', text: 'Radius 256 times today\'s (1.2 AU), 2,700 times as bright, 0.67 solar masses after losing a third of its mass. Mercury and Venus are gone; Earth is very likely dragged in too.', view: { land: 'Mars', hour: 17 }, rate: YEAR * 1e5 });
  add({ id: 'flash', hold: 6, t: ageT(RGB_TIP) + 3e5, title: 'The helium flash', text: 'Helium ignites in the degenerate core; within a million years the Sun shrinks to a 40 L☉ horizontal branch star.', view: { body: 'Sun' }, rate: YEAR * 1e4 });
  add({ id: 'pn', hold: 15, t: ageT(PN_START), title: 'Planetary nebula', text: 'Thermal pulses on the asymptotic giant branch shed the Sun\'s envelope at ~20 km/s; within ten thousand years the exposed core is hotter than 50,000 K and lights the shell.', view: { pn: true }, rate: YEAR * 2000 });
  add({ id: 'wd', t: ageT(WD_START), title: 'The Sun is a white dwarf', text: 'An Earth-sized ember of carbon and oxygen, 0.54 solar masses, cooling for trillions of years.', view: { body: 'Sun' }, rate: YEAR * 1e6 });
  add({ id: 'sunlike', t: now + 3e10, est: true, title: 'Sun-like stars are dying out', text: 'With no gas left to form new stars, every star brighter than the Sun has burned out. The sky holds orange and red dwarfs and fading white dwarfs.', view: { lg: 'sun' }, rate: YEAR * 1e9 });
  add({ id: 'laststars', t: now + 9e13, est: true, title: 'The last stars fade', text: 'The longest-lived red dwarfs exhaust their hydrogen after about 100 trillion years. The stelliferous era ends; only stellar remnants and black holes remain.', view: { lg: 'sun' }, rate: YEAR * 1e12 });
  add({ id: 'horizon', t: now + 1.5e11, est: true, title: 'The sky beyond the Local Group goes dark', text: 'Accelerating expansion carries every other galaxy beyond our event horizon; their light redshifts away.', view: { universe: true }, rate: YEAR * 1e9 });
  return ev.sort((a, b) => a.t - b.t);
}

export class Timeline {
  constructor(nav, ui) { this.nav = nav; this.ui = ui; this.events = buildEvents(); this.auto = true; this.lastTyr = nav.time / YEAR; this.fired = new Set(); }
  next(tyr = this.nav.time / YEAR) { return this.events.find(e => e.t > tyr); }
  // called every frame: slow down ahead of an event so it plays at a watchable rate, then announce it
  update(dt) {
    const nav = this.nav, tyr = nav.time / YEAR, prev = this.lastTyr; this.lastTyr = tyr;
    if (nav.paused || !nav.rate) return;
    // after an event has played, go back to the rate the user had chosen (unless they changed it meanwhile)
    const R = this.resume;
    if (R) {
      if (nav.rate !== R.set) this.resume = null;
      else if ((nav.rate > 0 ? tyr >= R.e.t : tyr <= R.e.t)) { R.hold -= dt; if (R.hold <= 0) { nav.rate = R.rate; this.resume = null; this.ui.toast('Resuming ' + fmtRate(R.rate)); } }
    }
    const fwd = nav.rate > 0;
    for (const e of this.events) {
      // announce events we just passed
      if ((prev < e.t && tyr >= e.t) || (prev > e.t && tyr <= e.t)) { if (!this.fired.has(e.id)) { this.fired.add(e.id); this.ui.toast((e.est ? 'About now: ' : '') + e.title); } }
      if (!this.auto) continue;
      const ahead = fwd ? e.t - tyr : tyr - e.t;
      const ryr = Math.abs(nav.rate) / YEAR, want = e.rate / YEAR;
      // only events on the scale of the current rate: racing through billions of years skips a supernova
      if (ryr > (e.maxRate || 3e10)) continue;
      if (ahead > 0 && ryr > want && ahead < ryr * 2.5) {
        // approach the event within ~2.5 s, never slower than its own rate
        const r = Math.max(want, ahead / 1.2);
        if (r < ryr) {
          if (!this.resume || this.resume.e !== e) this.resume = { rate: (this.resume && this.resume.rate) || nav.rate, e, hold: e.hold || 5 };
          nav.rate = Math.sign(nav.rate) * r * YEAR; this.resume.set = nav.rate;
        }
      }
    }
  }
  // jump to just before an event and set up its view
  go(e) {
    const nav = this.nav; this.resume = null;
    nav.time = (e.t - Math.min(e.rate / YEAR * 4, Math.max(1e-3, Math.abs(e.t) * 1e-9 + 0.02))) * YEAR;
    nav.rate = e.rate; nav.paused = false;
    this.fired.delete(e.id); this.lastTyr = nav.time / YEAR;
    if (this.onGo) this.onGo(e);
  }
}
