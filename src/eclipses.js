// Eclipse finder: searches forward with the same ephemerides the renderer uses.
import { V, Q } from './math.js';

// returns { kind: 'solar'|'lunar', t, lat, lon, total, sep } for the next eclipse after time t0, or null
export function nextEclipse(sys, t0, kind = 'any', maxDays = 800) {
  const e = sys.find('Earth'), m = sys.find('Moon'), s = sys.find('Sun');
  if (!e || !m || !s) return null;
  const save = sys.time;
  const geo = (t) => {
    sys.update(t);
    const ds = V.norm(V.sub(s.pos, e.pos)), dm = V.norm(V.sub(m.pos, e.pos));
    return { c: V.dot(ds, dm) };                    // +1 at new moon, -1 at full moon
  };
  // solar: perpendicular distance of the Moon's shadow axis from Earth's centre, in Earth radii
  const solarMiss = (t) => { sys.update(t); const d = V.norm(V.sub(m.pos, s.pos)), o = V.sub(m.pos, e.pos), b = V.dot(o, d); return b > 0 ? 99 : Math.sqrt(Math.max(V.dot(o, o) - b * b, 0)) / e.radius; };
  // lunar: Moon's distance from the anti-solar axis, in units of the umbra radius at the Moon (~0.73 Earth radii)
  const lunarMiss = (t) => { sys.update(t); const d = V.norm(V.sub(e.pos, s.pos)), o = V.sub(m.pos, e.pos), b = V.dot(o, d); return b < 0 ? 99 : Math.sqrt(Math.max(V.dot(o, o) - b * b, 0)) / (e.radius * 0.73); };
  const golden = (f, a, b) => { const g = 0.618034; let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = f(x1), f2 = f(x2); for (let i = 0; i < 40; i++) { if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = f(x1); } else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = f(x2); } } return (a + b) / 2; };
  let result = null;
  const step = 6 * 3600;
  let prev = geo(t0).c;
  // (an integer step count: at far-future times t += step would stop advancing)
  for (let i = 1, N = Math.ceil(maxDays * 86400 / step); i < N && !result; i++) {
    const t = t0 + i * step;
    const cur = geo(t).c;
    // syzygy: local extremum of the Sun-Moon cosine (new or full moon) between t - 2 step and t
    const next = geo(t + step).c;
    if ((cur > prev && cur >= next && cur > 0.99 && kind !== 'lunar') || (cur < prev && cur <= next && cur < -0.99 && kind !== 'solar')) {
      const solar = cur > 0;
      const f = solar ? solarMiss : lunarMiss;
      const tm = golden(f, t - 2 * step, t + 2 * step), miss = f(tm);
      // solar: the penumbra reaches Earth out to ~1.55 Earth radii from the axis (partial eclipses)
      if ((solar && miss < 1.5) || (!solar && miss < 1.6)) {
        sys.update(tm);
        let lat, lon;
        if (solar) {
          const d = V.norm(V.sub(m.pos, s.pos)), o = V.sub(m.pos, e.pos), b = V.dot(o, d), h = b * b - (V.dot(o, o) - e.radius ** 2);
          // central: where the axis meets the ground; partial: the surface point closest to the axis
          const p = h > 0 ? V.add(o, V.mul(d, -b - Math.sqrt(h))) : V.mul(V.norm(V.add(o, V.mul(d, -b))), e.radius);
          const L = Q.rot(Q.conj(e.rotQ), V.norm(p)); lat = Math.asin(L[1]) * 180 / Math.PI; lon = Math.atan2(-L[2], L[0]) * 180 / Math.PI;
        } else {
          const L = Q.rot(Q.conj(e.rotQ), V.norm(V.sub(m.pos, e.pos))); lat = Math.asin(L[1]) * 180 / Math.PI; lon = Math.atan2(-L[2], L[0]) * 180 / Math.PI;
        }
        // solar: total if the umbra (not just penumbra) reaches the ground; lunar: total if fully inside the umbra
        let total;
        if (solar) { const dMoon = V.dist(m.pos, e.pos) - e.radius, ang = Math.atan(m.radius / dMoon) - Math.atan(s.radius / V.dist(s.pos, e.pos)); total = ang > 0 && miss < 1; }
        else total = miss < 1 - m.radius / (e.radius * 0.73);
        result = { kind: solar ? 'solar' : 'lunar', t: tm, lat, lon, total, miss, central: solar ? miss < 1 : miss < 1 + m.radius / (e.radius * 0.73) };
      }
    }
    prev = cur;
  }
  sys.update(save);
  return result;
}
