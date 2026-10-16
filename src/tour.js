// Guided tour: a sequence of real places and events, each with a short caption.
import { V, Q } from './math.js';
import { findByName } from './nav.js';

const iso = (s) => (Date.parse(s) - Date.UTC(2000, 0, 1, 12)) / 1000;
const body = (nav, name) => { const t = findByName(nav, name); return t && t.type === 'body' ? t.body : null; };

export const STOPS = [
  { title: 'Earth', text: 'Real colour, elevation, coastlines and clouds from NASA, lit by the Sun where it really is right now.',
    run: (nav) => { nav.paused = false; nav.rate = 1; nav.goTo(findByName(nav, 'Earth')); } },
  { title: 'Europe at night', text: 'City lights from the Black Marble survey. Exposure adapts like an eye: the stars come out.',
    run: (nav) => { nav.time = iso('2024-06-20T23:30:00Z'); nav.rate = 60; const e = body(nav, 'Earth'); e.system.update(nav.time);
      const la = 46 * Math.PI / 180, lo = 10 * Math.PI / 180, dl = [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
      nav.goTo({ type: 'body', body: e, offset: V.mul(Q.rot(e.wrot, dl), e.radius * 1.35) }, { dist: 1 }); nav.selected = { type: 'body', body: e }; } },
  { title: 'The Alps', text: 'Real elevation with procedural detail below the map resolution: snow line, rock on steep slopes, valleys.',
    run: (nav) => { nav.rate = 1; nav.landAt(body(nav, 'Earth'), 46.0, 7.6, { hour: 16.5 }); } },
  { title: 'Total solar eclipse, 8 April 2024', text: 'The Moon from lunar theory and Earth from JPL elements put the shadow where it really fell. Exposure switches to the corona.',
    run: (nav) => { nav.time = iso('2024-04-08T18:30:00Z'); nav.paused = true; const e = body(nav, 'Earth'), s = body(nav, 'Sun'), m = body(nav, 'Moon'); e.system.update(nav.time);
      const d = V.norm(V.sub(m.pos, s.pos)), o = V.sub(m.pos, e.pos), b = V.dot(o, d), h = b * b - (V.dot(o, o) - e.radius ** 2);
      const p = V.add(o, V.mul(d, -b - Math.sqrt(Math.max(h, 0)))), L = Q.rot(Q.conj(e.rotQ), V.norm(p));
      nav.landAt(e, Math.asin(L[1]) * 180 / Math.PI, Math.atan2(-L[2], L[0]) * 180 / Math.PI);
      nav.onArrive = () => { nav.lookTarget = { type: 'body', body: s }; }; } },
  { title: 'Total lunar eclipse, 14 March 2025', text: 'The Moon in Earth\'s shadow is lit only by sunlight bent through Earth\'s atmosphere, every sunrise and sunset at once, so it glows red.',
    run: (nav) => { nav.time = iso('2025-03-14T06:30:00Z'); const ui = window.cosmos && window.cosmos.ui; if (ui) ui.goNextEclipse(); } },
  { title: 'Earthrise', text: 'From the lunar surface near the limb, Earth hangs low over the horizon. Earthshine lights the night side of the Moon.',
    run: (nav) => { nav.paused = false; nav.rate = 1; nav.time = iso('2024-05-15T12:00:00Z'); const m = body(nav, 'Moon'); nav.landAt(m, 5, 84, {});
      nav.onArrive = () => { nav.lookTarget = { type: 'body', body: body(nav, 'Earth') }; nav.fov = 0.3; }; } },
  { title: 'Valles Marineris, Mars', text: 'MOLA elevation and Viking colour. Fine dust makes the sky butterscotch and the sunset blue.',
    run: (nav) => { nav.landAt(body(nav, 'Mars'), -8, -75, { hour: 16.8 }); } },
  { title: 'Jupiter', text: 'Io, Europa, Ganymede and Callisto are placed from their real orbital theory.',
    run: (nav) => { nav.time = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000; nav.goTo(findByName(nav, 'Jupiter')); } },
  { title: 'Saturn, 2017', text: 'Cassini ring transparency, ring shadow on the globe and the planet\'s shadow on the rings.',
    run: (nav) => { nav.time = iso('2017-06-01T00:00:00Z'); nav.paused = true; nav.goTo(findByName(nav, 'Saturn')); } },
  { title: 'TRAPPIST-1', text: 'Seven Earth-sized planets around an ultracool dwarf 12 parsecs away, with their measured orbits and sizes.',
    run: (nav) => { nav.paused = false; const t = findByName(nav, 'TRAPPIST-1'); nav.goTo(t);
      nav.onArrive = () => { const sys = nav.system; const p = sys && sys.find('TRAPPIST-1 e'); if (p) { nav.goTo({ type: 'body', body: p }, { dist: p.radius * 2.6 }); nav.onArrive = () => { nav.lookTarget = { type: 'body', body: p }; }; } }; } },
  { title: 'Orion Nebula', text: 'A stellar nursery 412 parsecs from the Sun, ray marched as a volume.',
    run: (nav) => { nav.goTo(findByName(nav, 'Orion Nebula')); } },
  { title: 'Sagittarius A*', text: 'The black hole at the centre of the Milky Way. Light bends around it; the disk is Doppler beamed.',
    run: (nav) => { nav.goTo(findByName(nav, 'Sagittarius A*')); nav.onArrive = () => { const t = nav.selected; if (t && t.type === 'body') nav.goTo(t, { dist: t.body.radius * 30 }); }; } },
  { title: 'The Milky Way', text: 'Our galaxy from outside: bulge, bar, spiral arms, star forming regions and dust lanes.',
    run: (nav) => { nav.goTo(findByName(nav, 'Milky Way')); } },
  { title: 'Andromeda', text: 'The nearest large spiral, 765 kiloparsecs away, at its real position and inclination.',
    run: (nav) => { nav.goTo(findByName(nav, 'Andromeda')); } },
];

export class Tour {
  constructor(nav, ui) { this.nav = nav; this.ui = ui; this.i = -1; this.active = false; this.t = 0; this.wait = 0; }
  start() { this.active = true; this.i = -1; this.defaultFov = this.nav.fov > 0.3 ? this.nav.fov : 55 * Math.PI / 180; this.next(); }
  stop() { this.active = false; this.ui.caption(null); }
  next() {
    this.i++;
    if (this.i >= STOPS.length) { this.stop(); return; }
    const s = STOPS[this.i];
    // every stop starts from a normal view (eclipse stops zoom in)
    this.nav.fov = this.defaultFov || (this.defaultFov = 55 * Math.PI / 180); this.nav.lookTarget = null; this.nav.onArrive = null; this.nav.orbit = null;
    try { s.run(this.nav); } catch (e) { console.warn('tour stop failed', s.title, e); }
    this.t = 0; this.wait = 0;
    this.ui.caption(s.title, s.text, this.i + 1, STOPS.length);
  }
  update(dt) {
    if (!this.active) return;
    this.t += dt;
    // stay a while after arriving, then move on
    if (!this.nav.goto && !this.nav.pendingLand) this.wait += dt;
    if (this.wait > 9) this.next();
  }
}
