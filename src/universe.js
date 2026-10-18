// Large scale structure: procedural galaxy catalogue plus hand placed Local Group members.
import { RNG, hashCombine, makeName } from './rng.js';
import { V, Q, clamp } from './math.js';

export const GT = { E: 0, S0: 1, S: 2, SB: 3, IRR: 4 };
const GTN = ['E', 'S0', 'S', 'SB', 'Irr'];

// --- simple 3D value noise for the cosmic web ---
function h3(x, y, z) { return hashCombine(x, y, z) / 4294967296; }
function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(h3(ix, iy, iz), h3(ix + 1, iy, iz), fx), l(h3(ix, iy + 1, iz), h3(ix + 1, iy + 1, iz), fx), fy),
    l(l(h3(ix, iy, iz + 1), h3(ix + 1, iy, iz + 1), fx), l(h3(ix, iy + 1, iz + 1), h3(ix + 1, iy + 1, iz + 1), fx), fy), fz);
}
// Cosmic web density multiplier at position (Mpc). Filaments + clusters + voids. Mean roughly 1.
export function webDensity(p) {
  const s = 1 / 55;
  let x = p[0] * s, y = p[1] * s, z = p[2] * s;
  // domain warp
  const wx = vnoise(x * 1.7 + 11, y * 1.7, z * 1.7) - 0.5, wy = vnoise(x * 1.7, y * 1.7 + 23, z * 1.7) - 0.5, wz = vnoise(x * 1.7, y * 1.7, z * 1.7 + 37) - 0.5;
  x += wx * 0.6; y += wy * 0.6; z += wz * 0.6;
  let r = 0, a = 1, f = 1, tot = 0;
  for (let i = 0; i < 4; i++) { const n = 1 - Math.abs(2 * vnoise(x * f + i * 7.1, y * f + i * 3.3, z * f + i * 5.7) - 1); r += n * n * a; tot += a; a *= 0.55; f *= 2.1; }
  r /= tot; // ridged: high along sheets/filaments
  const d = Math.pow(r, 5) * 14 + 0.02;
  return d;
}
const WEB_MAX = 9;

// Level definitions: cell size (Mpc), mean number density (per Mpc^3), load radius (Mpc)
export const GLEVELS = [
  { cell: 80, dens: 6e-4, radius: 420, minR: 14000, maxR: 42000 },
  { cell: 20, dens: 5e-3, radius: 110, minR: 5000, maxR: 16000 },
  { cell: 5, dens: 4e-2, radius: 28, minR: 800, maxR: 5000 },
];

function finishGalaxy(g, rng) {
  // derive model parameters
  const t = g.type;
  g.typeName = GTN[t];
  if (g.rb === undefined) g.rb = t === GT.E ? rng.range(0.08, 0.16) : rng.range(0.035, 0.11);
  if (g.bulge === undefined) g.bulge = t === GT.E ? 1 : (t === GT.S0 ? rng.range(6, 14) : t === GT.IRR ? 0.3 : rng.range(2, 9));
  if (g.arms === undefined) g.arms = t === GT.SB ? 2 : rng.pick([2, 2, 2, 3, 4, 4, 5]);
  if (g.pitch === undefined) g.pitch = rng.range(0.18, 0.5);
  if (g.armStr === undefined) g.armStr = (t === GT.S || t === GT.SB) ? rng.range(0.55, 1) : 0;
  if (g.dust === undefined) g.dust = t === GT.E ? 0 : t === GT.S0 ? rng.range(0, 0.4) : rng.range(0.5, 1.3);
  if (g.bar === undefined) g.bar = t === GT.SB ? rng.range(0.15, 0.32) : 0;
  if (g.hz === undefined) g.hz = t === GT.IRR ? rng.range(0.08, 0.2) : rng.range(0.012, 0.026);
  if (g.flat === undefined) g.flat = t === GT.E ? rng.range(0.45, 1) : 1;
  if (g.lum === undefined) g.lum = Math.exp(rng.gauss() * 0.4) * (g.radius < 4000 ? 0.45 : 1);
  if (g.young === undefined) g.young = t === GT.E ? 0 : t === GT.S0 ? 0.1 : t === GT.IRR ? rng.range(1, 2) : rng.range(0.6, 1.4);
  if (g.nseed === undefined) g.nseed = rng.range(0, 100);
  if (!g.quat) { const ax = rng.dir(); g.quat = Q.axis(ax, rng.range(0, Math.PI * 2)); }
  g.subtype = t === GT.E ? 'E' + Math.round((1 - g.flat) * 10) : t === GT.S0 ? 'S0' : t === GT.IRR ? 'Irr' : (t === GT.SB ? 'SB' : 'S') + (g.pitch < 0.26 ? 'a' : g.pitch < 0.36 ? 'b' : 'c');
  // rough stellar mass / luminosity for info
  g.mass = 6e10 * Math.pow(g.radius / 17000, 2.2) * g.lum * (t === GT.E ? 3 : 1);
  g.nstars = g.mass * 1.6;
  return g;
}

// Hand placed real galaxies. Positions from galactic (l, b, distance Mpc), relative to the Sun.
export const SUN_POS = [-8200, 20, 0]; // pc, Milky Way local frame (x to galactic centre, y to north galactic pole)
export function galDir(l, b) { l *= Math.PI / 180; b *= Math.PI / 180; return [Math.cos(b) * Math.cos(l), Math.sin(b), -Math.cos(b) * Math.sin(l)]; }
function realGal(name, l, b, d, type, radius, incl, pa, extra = {}) {
  const dir = galDir(l, b);
  const posU = V.add(V.mul(dir, d), V.mul(SUN_POS, 1e-6));
  // orientation: disk normal inclined `incl` degrees from the line of sight
  const side = V.norm(V.cross(dir, [0.3, 0.9, 0.1])); const up2 = V.cross(side, dir);
  const paR = pa * Math.PI / 180, inR = incl * Math.PI / 180;
  const perp = V.add(V.mul(side, Math.cos(paR)), V.mul(up2, Math.sin(paR)));
  const n = V.norm(V.add(V.mul(dir, Math.cos(inR)), V.mul(perp, Math.sin(inR))));
  const x = V.norm(V.cross(n, dir)), z = V.cross(x, n);
  const g = { id: 'R:' + name, seed: hashCombine(l * 100, b * 100, d * 1000), name, posU, type, radius, quat: Q.fromBasis(x, n, z), real: true, ...extra };
  return finishGalaxy(g, new RNG(g.seed));
}
export const MILKY_WAY = finishGalaxy({
  id: 'R:Milky Way', seed: 1, name: 'Milky Way', posU: [0, 0, 0], type: GT.SB, radius: 17000, quat: Q.ident(), real: true,
  rb: 0.07, bulge: 5, arms: 4, pitch: 0.23, armStr: 0.85, dust: 1.0, bar: 0.2, hz: 0.018, lum: 1, young: 1, nseed: 7.3,
}, new RNG(1));
export const REAL_GALAXIES = [
  MILKY_WAY,
  realGal('Andromeda Galaxy (M31)', 121.17, -21.57, 0.765, GT.S, 23000, 77, 35, { arms: 2, pitch: 0.2, bulge: 9, rb: 0.07, lum: 1.1, dust: 1.1 }),
  realGal('Triangulum Galaxy (M33)', 133.61, -31.33, 0.86, GT.S, 9200, 54, 20, { arms: 3, pitch: 0.45, bulge: 1.5, rb: 0.04, young: 1.6 }),
  realGal('Large Magellanic Cloud', 280.47, -32.89, 0.0499, GT.IRR, 4900, 35, 0, { bar: 0.3, lum: 0.9 }),
  realGal('Small Magellanic Cloud', 302.8, -44.3, 0.0627, GT.IRR, 2900, 60, 40, { lum: 0.6 }),
  // (a faint, elongated dwarf being torn apart on the far side of the bulge: stellar mass ~1e8 Msun)
  realGal('Sagittarius Dwarf Galaxy', 5.57, -14.17, 0.0265, GT.E, 2600, 0, 0, { flat: 0.45, lum: 0.04, rb: 0.3, sgr: true }),
  realGal('Messier 87', 283.78, 74.49, 16.4, GT.E, 40000, 0, 0, { flat: 0.92, lum: 1.6 }),
  realGal('Bode\'s Galaxy (M81)', 142.09, 40.9, 3.6, GT.S, 14000, 59, 60, { arms: 2, pitch: 0.2, bulge: 8 }),
  realGal('Whirlpool Galaxy (M51)', 104.85, 68.56, 8.6, GT.S, 12000, 22, 10, { arms: 2, pitch: 0.36, armStr: 1, young: 1.5, dust: 1.2 }),
  realGal('Sombrero Galaxy (M104)', 298.46, 51.15, 9.55, GT.S0, 15000, 84, 0, { bulge: 16, rb: 0.13, dust: 1.4, hz: 0.012 }),
  realGal('Centaurus A', 309.5, 19.4, 3.8, GT.S0, 14000, 80, 70, { bulge: 14, rb: 0.16, dust: 1.6, hz: 0.03 }),
  realGal('Pinwheel Galaxy (M101)', 102.04, 59.77, 6.4, GT.S, 26000, 18, 0, { arms: 4, pitch: 0.42, bulge: 1.5, young: 1.5 }),
  realGal('Sculptor Galaxy (NGC 253)', 97.37, -87.96, 3.5, GT.SB, 14000, 76, 30, { young: 1.5, dust: 1.3 }),
  realGal('Messier 82', 141.4, 40.57, 3.5, GT.IRR, 6000, 80, 20, { hz: 0.06, young: 2, dust: 1.5 }),
];

const cellCache = new Map();
export function galaxyCell(level, cx, cy, cz) {
  const key = level + ':' + cx + ':' + cy + ':' + cz;
  let c = cellCache.get(key);
  if (c) return c;
  const L = GLEVELS[level], rng = new RNG(hashCombine(0x6a1a, level, cx, cy, cz));
  const vol = L.cell ** 3, n = rng.poisson(L.dens * vol * WEB_MAX);
  const list = [];
  for (let i = 0; i < n; i++) {
    const p = [(cx + rng.f()) * L.cell, (cy + rng.f()) * L.cell, (cz + rng.f()) * L.cell];
    const wd = webDensity(p);
    const keep = rng.f() < wd / WEB_MAX;
    const seed = rng.u32();
    if (!keep) continue;
    if (Math.hypot(p[0], p[1], p[2]) < 1.2) continue; // keep the Local Group clean
    const r2 = new RNG(seed);
    let type; const u = r2.f(), dense = clamp(wd / 4, 0, 1);
    if (level === 0) type = u < 0.2 + 0.4 * dense ? GT.E : u < 0.35 + 0.4 * dense ? GT.S0 : u < 0.72 + 0.2 * dense ? GT.S : GT.SB;
    else if (level === 1) type = u < 0.1 + 0.3 * dense ? GT.E : u < 0.2 + 0.3 * dense ? GT.S0 : u < 0.55 + 0.2 * dense ? GT.S : u < 0.85 + 0.1 * dense ? GT.SB : GT.IRR;
    else type = u < 0.4 + 0.3 * dense ? GT.E : u < 0.5 ? GT.S : GT.IRR;
    const radius = r2.logRange(L.minR, L.maxR) * (type === GT.E && level === 0 && r2.chance(0.1) ? 1.8 : 1);
    const g = { id: 'G:' + key + ':' + i, seed, posU: p, type, radius, level };
    finishGalaxy(g, r2);
    // structure growth (Zel'dovich): the galaxy's matter fell in up the density gradient, and in clusters from all
    // around; psi is its comoving displacement since the Big Bang (Mpc), scaled back by the growth factor for earlier
    // epochs. And a major merger: before g.mergeT (Gyr) it was two galaxies (more often for ellipticals and in clusters).
    { const e = 1.5, gx = webDensity([p[0] + e, p[1], p[2]]) - webDensity([p[0] - e, p[1], p[2]]), gy = webDensity([p[0], p[1] + e, p[2]]) - webDensity([p[0], p[1] - e, p[2]]), gz = webDensity([p[0], p[1], p[2] + e]) - webDensity([p[0], p[1], p[2] - e]);
      const gl = Math.hypot(gx, gy, gz) / (2 * e) / Math.max(wd, 0.05), u = gl > 1e-9 ? 1 / Math.hypot(gx, gy, gz) : 0, amp = 7 * Math.min(1, gl * 12), rd = r2.dir(), ra = 4 * dense;
      g.psi = [gx * u * amp + rd[0] * ra, gy * u * amp + rd[1] * ra, gz * u * amp + rd[2] * ra];
      g.mergeT = r2.f() < (type === GT.E ? 0.6 : 0.25) * (0.6 + 0.6 * dense) ? r2.range(1.5, 10) : 0; }
    list.push(g);
  }
  c = { key, level, cx, cy, cz, list, origin: [cx * L.cell, cy * L.cell, cz * L.cell] };
  cellCache.set(key, c);
  if (cellCache.size > 6000) { const k = cellCache.keys().next().value; cellCache.delete(k); }
  return c;
}
export function galaxyName(g) {
  if (g.name) return g.name;
  const r = new RNG(g.seed ^ 0x51);
  g.name = r.chance(0.25) ? makeName(g.seed) + ' Galaxy' : (r.pick(['NGC', 'UGC', 'IC', 'PGC', 'ESO']) + ' ' + (1000 + (g.seed % 89000)));
  return g.name;
}

// ---------- Galaxy light model shared by impostors and the in-galaxy sky (GLSL) ----------
// Coordinates are normalised by the galaxy radius; disk lies in the XZ plane.
export const GLSL_GALAXY = `
uniform sampler3D uNoise3;
struct Gal { float type; float bulge; float rb; float arms; float pitch; float armStr; float dust; float seed; float hz; float bar; float flatn; float young; float lum; };
float gsech2(float x){ float e = exp(-abs(x)); float s = 2.*e/(1.+e*e); return s*s; }
float gnoise(vec3 p){ return texture(uNoise3, p).r; }
float gfbm(vec3 p, int oct){ float a=.5, s=0.; for(int i=0;i<oct;i++){ s += a*texture(uNoise3, p).r; p = p*2.03 + 17.3; a*=.5; } return s; }
const float G_RD = 0.2;
// Emission (rgb, per unit normalised length, in units of central disk face-on surface brightness) and extinction.
// observing bands: how much old stars, young stars and glowing gas give off in each (false colours), how much the dust
// absorbs, and what glows there that does not in visible light (warm dust, neutral hydrogen, hot gas)
uniform int uBand;
void bandCols(out vec3 cO, out vec3 cY, out vec3 cH){
  cO = vec3(1.0, 0.78, 0.5); cY = vec3(0.42, 0.62, 1.0); cH = vec3(1.0, 0.22, 0.34);
  if (uBand == 1) { cO = vec3(0.07, 0.05, 0.14); cY = vec3(1.2, 1.1, 2.2); cH = vec3(0.25, 0.2, 0.5); }            // UV: young hot stars
  else if (uBand == 2) { cO = vec3(1.7, 1.2, 0.85); cY = vec3(0.3, 0.26, 0.24); cH = vec3(0.1); }                   // near-IR: old giants
  else if (uBand == 3) { cO = vec3(0.01); cY = vec3(0.04, 0.02, 0.01); cH = vec3(0.35, 0.14, 0.05); }              // far-IR: stars faint
  else if (uBand == 4) { cO = vec3(0.); cY = vec3(0.); cH = vec3(0.04, 0.03, 0.02); }                               // microwave
  else if (uBand == 5) { cO = vec3(0.); cY = vec3(0.12, 0.45, 0.25); cH = vec3(0.3, 0.9, 0.5); }                    // radio: synchrotron, H II
  else if (uBand == 6) { cO = vec3(0.01, 0.02, 0.03); cY = vec3(0.15, 0.3, 0.5); cH = vec3(0.); }                   // X-ray: binaries
}
void galSample0(Gal g, vec3 p, float detail, out vec3 emis, out float ext);
void galSample(Gal g, vec3 p, float detail, out vec3 emis, out float ext){
  galSample0(g, p, detail, emis, ext);
  if (uBand == 0) return;
  float R = length(p.xz), r = length(p);
  // warm dust glows in the far infrared (and faintly in microwaves) where it blocks visible light; dust is transparent
  // in the near infrared and radio, and absorbs ultraviolet even more strongly
  if (uBand == 3) emis += vec3(1.0, 0.42, 0.16)*ext*0.35;
  if (uBand == 4) emis += vec3(0.8, 0.5, 0.3)*ext*0.05;
  // neutral hydrogen (21 cm): a clumpy, flaring disk of near-constant surface density with a hole in the middle, reaching
  // beyond the stars
  if (uBand == 5 && g.type > 0.5) { float hzH = g.hz*(0.7 + 1.5*R*R);
    emis += vec3(0.25, 0.85, 0.5)*smoothstep(0.04, 0.22, R)*smoothstep(1.05, 0.65, R)*exp(-abs(p.y)/hzH)*(0.1 + 3.*max(gfbm(p*9. + g.type*3., 3) - 0.32, 0.))*0.06/hzH; }
  // radio galaxies: jets from the central black hole and the lobes where they stop (giant ellipticals, like M87 and
  // Centaurus A), along the galaxy's axis
  if (uBand == 5 && g.type < 0.5 && g.lum > 0.6) { float rr = length(p.xz), z = abs(p.y);
    emis += vec3(0.4, 1.0, 0.6)*(exp(-pow(rr/(0.015 + 0.04*z), 2.))*exp(-z/0.9)*0.8 + exp(-(pow(rr/0.35, 2.) + pow((z - 1.25)/0.35, 2.)))*0.5); }
  // hot gas: a diffuse X-ray halo (bright in ellipticals, which hold their gas) and the nucleus
  if (uBand == 6) emis += vec3(0.5, 0.75, 1.0)*(exp(-r*4.)*(g.type < 0.5 ? 1.2 : 0.25)*smoothstep(1., 0.55, r) + exp(-r*r*900.)*0.6);
  ext *= uBand == 1 ? 2.5 : uBand == 2 ? 0.12 : uBand == 6 ? 0.5 : 0.;
}
void galSample0(Gal g, vec3 p, float detail, out vec3 emis, out float ext){
  emis = vec3(0.); ext = 0.;
  float R = length(p.xz);
  vec3 colOld, colYoung, colH2; bandCols(colOld, colYoung, colH2);
  if (g.type < 0.5) {
    float r = length(p * vec3(1., 1./g.flatn, 1./mix(g.flatn,1.,.5)));
    float d = pow(1. + (r*r)/(g.rb*g.rb), -1.5) * smoothstep(1.0, 0.5, r);
    emis = colOld * vec3(1.,0.95,0.9) * d * 2.2 / g.rb * 0.25;
    return;
  }
  if (g.type > 3.5) {
    // irregular: lumpy flattened blob with star forming knots
    vec3 q = p * vec3(1., 1./(g.hz*4.), 1.3);
    float r = length(q);
    float base = exp(-r*4.5) * smoothstep(1.0,0.6,r);
    float n = gfbm(p*2.2 + g.seed, 4);
    float lump = smoothstep(0.25, 0.75, n);
    float n2 = gnoise(p*7. + g.seed*1.3);
    float bar = g.bar > 0. ? exp(-pow(abs(p.x)/g.bar,2.) - pow(length(p.yz)/(g.bar*.3),2.))*1.5 : 0.;
    emis = colOld * (base*(0.4+lump) + bar*base*2.) * 6.;
    emis += colYoung * base * lump * lump * 12. * g.young;
    emis += colH2 * base * smoothstep(0.62,0.8,n2) * lump * 30. * g.young;
    ext = g.dust * base * smoothstep(0.4,0.8, gnoise(p*4.+g.seed+5.)) * 25.;
    return;
  }
  float y = p.y;
  float trunc = smoothstep(1.02, 0.75, R);
  float disk = exp(-R/G_RD) * trunc;
  float vOld = gsech2(y/g.hz), vYoung = gsech2(y/(g.hz*0.45)), vDust = gsech2(y/(g.hz*0.3));
  // bulge (flattened Plummer like)
  float rbq = length(p*vec3(1.,1.5,1.));
  float bulge = g.bulge * pow(1. + rbq*rbq/(g.rb*g.rb), -2.2);
  // bar
  float th = atan(p.z, p.x);
  float barD = 0.;
  if (g.bar > 0.) { float bx = abs(p.x)/g.bar, bz = length(p.yz)/(g.bar*0.28); barD = exp(-bx*bx*bx - bz*bz) * g.bulge * 0.35; }
  // spiral arms: logarithmic spiral with noise perturbation
  float armOld = 1., armYoung = 0.3, armDust = 0.4, clump = 1., h2 = 0., knots = 0.;
  if (g.armStr > 0.) {
    float Rs = max(R, 0.03);
    float wob = 0., frag = 1., c2 = 0.; vec3 np = vec3(p.x, 0., p.z);
    if (detail > 0.) {
      wob = (gfbm(np*2.3 + g.seed, 3) - 0.47)*3.2 + (gnoise(np*0.8 + g.seed*0.37) - 0.5)*3.0;
      frag = 0.35 + 0.95*smoothstep(0.3, 0.62, gnoise(np*1.9 + g.seed*1.9));
    }
    float ph = g.arms * (th - log(Rs/max(g.bar,0.06))/g.pitch) + wob;
    float c = 0.5 + 0.5*cos(ph);
    float cd = 0.5 + 0.5*cos(ph + 0.75);
    if (detail > 0.) c2 = pow(0.5 + 0.5*cos(ph*2.3 + 1.7 + wob*0.8), 4.) * (1.3 - frag);
    float inner = smoothstep(max(g.bar*0.8,0.04), max(g.bar*1.3,0.14), R);
    float s = g.armStr * inner * frag;
    armOld = mix(1., 0.6 + 1.1*c*c, min(s, 1.)*0.7);
    armYoung = mix(0.25, 3.6*pow(c, 2.6) + 1.4*c2, min(s, 1.));
    armDust = mix(0.4, 3.4*pow(cd, 2.5) + 1.2*c2, min(s, 1.));
    if (detail > 0.) {
      float n = gfbm(p*vec3(9.,9.,9.) + g.seed*2., 4);
      clump = 0.15 + 3.2*smoothstep(0.32, 0.72, n);
      float n2 = gnoise(p*vec3(26.,26.,26.) + g.seed*3.);
      h2 = smoothstep(0.64, 0.8, n2) * pow(c, 3.) * s * 16.;
      float n3 = gnoise(p*vec3(47.,47.,47.) + g.seed*4.1);
      knots = smoothstep(0.66, 0.84, n3) * (pow(c, 2.5) + c2) * s * 9.;
    }
  }
  float e0 = 0.5 / g.hz;  // normalises face-on central column to ~1
  emis = colOld * (disk*vOld*armOld*0.75 + bulge*g.hz*2.0 + barD*g.hz*2.0) * e0;
  emis += colYoung * disk * vYoung * (armYoung * clump + knots) * g.young * e0 * 1.25;
  emis += colH2 * disk * vYoung * h2 * g.young * e0 * 0.6;
  float dn = 1.;
  if (detail > 0.) { float f = gfbm(p*vec3(14.,30.,14.) + g.seed*5., 4); dn = 0.1 + 3.4*smoothstep(0.34,0.7,f); if (detail > 1.) { float f2 = gfbm(p*vec3(70.,160.,70.) + g.seed, 3); dn *= 0.35 + 1.6*f2; } }
  ext = g.dust * exp(-R/(G_RD*1.6)) * smoothstep(1.0,0.8,R) * vDust * armDust * dn * (0.6/(g.hz*0.6)) * smoothstep(0.0, g.rb*1.2, R + 0.02);
}
`;

// JS mirror of the smooth stellar density (relative to the solar neighbourhood value), for star generation.
export function makeDensityFn(g) {
  const sech2 = (x) => { const e = Math.exp(-Math.abs(x)); const s = 2 * e / (1 + e * e); return s * s; };
  const RD = 0.2, norm = 1 / Math.exp(-0.482 / RD);
  const k = g.lum;
  return function (p /* local pc */, out) {
    const x = p[0] / g.radius, y = p[1] / g.radius, z = p[2] / g.radius;
    const R = Math.hypot(x, z);
    let old = 0, young = 0;
    if (g.type === GT.E) {
      const r = Math.hypot(x, y / g.flat, z / (0.5 * g.flat + 0.5));
      old = Math.pow(1 + r * r / (g.rb * g.rb), -1.5) * smoothstep01(1.0, 0.5, r) * 2.2 / g.rb * 0.25 * 2 * 0.018 * norm;
    } else if (g.type === GT.IRR) {
      const r = Math.hypot(x, y / (g.hz * 4), z * 1.3);
      const base = Math.exp(-r * 4.5) * smoothstep01(1.0, 0.6, r);
      old = base * 6 * 2 * 0.018 * norm; young = base * 8 * g.young * 2 * 0.018 * norm;
    } else {
      const trunc = smoothstep01(1.02, 0.75, R), disk = Math.exp(-R / RD) * trunc;
      const rbq = Math.hypot(x, y * 1.5, z);
      const bulge = g.bulge * Math.pow(1 + rbq * rbq / (g.rb * g.rb), -2.2);
      let barD = 0;
      if (g.bar > 0) { const bx = Math.abs(x) / g.bar, bz = Math.hypot(y, z) / (g.bar * 0.28); barD = Math.exp(-bx * bx * bx - bz * bz) * g.bulge * 0.35; }
      let armOld = 1, armYoung = 0.3;
      if (g.armStr > 0) {
        const Rs = Math.max(R, 0.03), th = Math.atan2(z, x);
        const ph = g.arms * (th - Math.log(Rs / Math.max(g.bar, 0.06)) / g.pitch);
        const c = 0.5 + 0.5 * Math.cos(ph);
        const inner = smoothstep01(Math.max(g.bar * 0.8, 0.04), Math.max(g.bar * 1.3, 0.14), R);
        const s = g.armStr * inner;
        armOld = 1 + (0.55 + 1.3 * c * c - 1) * s * 0.7; armYoung = 0.3 + (3.5 * c * c * c - 0.3) * s;
      }
      old = (disk * sech2(y / g.hz) * armOld + (bulge + barD) * g.hz * 2) * norm;
      young = disk * sech2(y / (g.hz * 0.45)) * armYoung * g.young * norm * 1.2;
    }
    out[0] = old * k; out[1] = young * k;
  };
}
function smoothstep01(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

export function galUniforms(g) {
  return { type: g.type, bulge: g.bulge, rb: g.rb, arms: g.arms, pitch: g.pitch, armStr: g.armStr, dust: g.dust, seed: g.nseed, hz: g.hz, bar: g.bar, flatn: g.flat, young: g.young, lum: g.lum };
}
