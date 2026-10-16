// Exotic objects and effects: black holes with gravitational lensing and accretion disks, stellar coronae,
// volumetric nebulae.
import { gl, Program, drawFS, FS_VS, makeVAO } from './gl.js';
import { V, Q, C, clamp } from './math.js';
import { RNG, hashCombine, makeName } from './rng.js';
import { LOGDEPTH_VS, LOGDEPTH_FS } from './planet.js';
import { GLSL_BB, bbColor } from './stars.js';
import { GAL_I0, skyCfg } from './sky.js';
import { galDir, SUN_POS, MILKY_WAY } from './universe.js';

// ---------------- black hole ----------------
const BH_FS = `
in vec2 vUV; out vec4 o;
uniform sampler2D uScene; uniform sampler3D uNoise3;
uniform mat3 uCamRot, uCamRotInv, uDiskRot; uniform vec2 uTanFov; uniform vec3 uRel;
uniform float uRs, uExposure, uTime, uDisk, uDiskT;
${GLSL_BB}
vec3 sampleSky(vec3 d){
  vec3 v = uCamRotInv*d;
  if (v.z > -0.02) return vec3(0.);
  vec2 uv = (v.xy/(-v.z*uTanFov))*0.5 + 0.5;
  vec2 e = smoothstep(vec2(-0.02), vec2(0.03), uv)*smoothstep(vec2(1.02), vec2(0.97), uv);
  return texture(uScene, clamp(uv, 0., 1.)).rgb*e.x*e.y;
}
void main(){
  vec3 rd = normalize(uCamRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  vec3 ro = -uRel;                         // camera relative to hole
  float r0 = length(ro);
  float tca = -dot(ro, rd);
  vec3 pc = ro + rd*tca; float b = length(pc);
  if (tca < 0. || b > 60.*uRs) {
    // weak field: small deflection towards the hole
    if (tca > 0.) { float a = 2.*uRs/b; rd = normalize(rd - (pc/b)*a); }
    o = vec4(sampleSky(rd), 1.); return;
  }
  // integrate the null geodesic (Schwarzschild), units of Rs
  vec3 p = ro/uRs, v = rd;
  float start = max(length(p) - 70., 0.);
  p += v*start;
  vec3 hv = cross(p, v); float h2 = dot(hv, hv);
  vec3 col = vec3(0.); float alpha = 0.; bool captured = false;
  vec3 dn = uDiskRot[1];
  for (int i = 0; i < 260; i++) {
    float r2 = dot(p, p), r = sqrt(r2);
    if (r < 1.0) { captured = true; break; }
    if (r > 75. && dot(p, v) > 0.) break;
    float dt = clamp(r*0.09, 0.02, 4.) * (r < 4. ? 0.5 : 1.);
    vec3 acc = -1.5*h2*p/(r2*r2*r);
    vec3 pn = p + v*dt + 0.5*acc*dt*dt;
    float rn2 = dot(pn, pn);
    vec3 accn = -1.5*h2*pn/(rn2*rn2*sqrt(rn2));
    vec3 vn = v + 0.5*(acc + accn)*dt;
    // accretion disk crossing
    if (uDisk > 0.) {
      float y0 = dot(p, dn), y1 = dot(pn, dn);
      if (y0*y1 < 0.) {
        vec3 q = mix(p, pn, y0/(y0 - y1)); float rr = length(q);
        if (rr > 3.0 && rr < 16.) {
          vec3 ql = vec3(dot(q, uDiskRot[0]), 0., dot(q, uDiskRot[2]));
          float ang = atan(ql.z, ql.x);
          float om = 0.35*pow(rr, -1.5);
          float sw = ang + uTime*om*40.;
          float n = texture(uNoise3, vec3(rr*0.21, sw*0.6366*0.5, 0.3)).r*0.6 + texture(uNoise3, vec3(rr*0.9, sw*0.6366*1.5 + 0.3, 0.7)).g*0.4;
          float dens = smoothstep(3.0, 3.5, rr)*smoothstep(16., 8., rr)*(0.15 + 2.2*n*n*n);
          // temperature profile, Doppler beaming and gravitational redshift
          float T = uDiskT*pow(rr/3., -0.75)*pow(max(1. - sqrt(3./rr), 0.02), 0.25)*1.9;
          float beta = sqrt(0.5/rr);
          vec3 vd = normalize(cross(dn, q))*beta;
          float gam = 1./sqrt(1. - beta*beta);
          float dop = 1./(gam*(1. - dot(vd, -normalize(v))));
          float gshift = sqrt(max(1. - 1./rr, 0.01));
          float shift = dop*gshift;
          vec3 c = bbColor(T*shift); c /= dot(c, vec3(0.2126, 0.7152, 0.0722));
          float inten = pow(shift, 3.5)*pow(T/uDiskT, 2.2)*dens;
          float a = clamp(dens*1.2, 0., 1.);
          col += (1. - alpha)*c*inten*uDisk; alpha += (1. - alpha)*a*0.9;
        }
      }
    }
    p = pn; v = vn;
  }
  vec3 bg = captured ? vec3(0.) : sampleSky(normalize(v));
  o = vec4(bg*(1. - alpha) + col*uExposure, 1.);
}`;
let pBH;
export function drawBlackHole(b, o) {
  if (!pBH) pBH = new Program('blackhole', FS_VS, BH_FS);
  const rs = b.radius;
  const disk = b.accretion || 0;
  pBH.use().set({ uScene: o.scene, uNoise3: o.noise3, uCamRot: o.camRot, uCamRotInv: Q.mat3(Q.conj(o.q)), uDiskRot: Q.mat3(b.axisW || o.rotQ), uTanFov: o.tanFov, uRel: o.rel, uRs: rs, uExposure: o.exposure, uTime: o.time % 1e5, uDisk: disk * 40, uDiskT: 9000 });
  drawFS();
}

// ---------------- coronae ----------------
const COR_VS = `layout(location=0) in vec2 aPos; uniform mat4 uViewProj; uniform vec3 uRel; uniform float uSize; out vec2 vP; ${LOGDEPTH_VS}
void main(){ vec3 f = normalize(uRel); vec3 r = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0,1,0) : vec3(1,0,0))); vec3 u = cross(r, f);
  vP = aPos*uSize; vec3 w = uRel + (r*aPos.x + u*aPos.y)*uSize; gl_Position = uViewProj*vec4(w, 1.); logDepth(); }`;
const COR_FS = `in vec2 vP; out vec4 o; uniform float uR, uExposure, uRad, uTime, uSeed; uniform vec3 uCol; uniform sampler3D uNoise3; ${LOGDEPTH_FS}
void main(){ logDepth();
  float r = length(vP)/uR; if (r < 0.98) discard;
  float ang = atan(vP.y, vP.x);
  // streamers: angular structure that fans out with radius
  float s1 = texture(uNoise3, vec3(cos(ang)*0.35 + uSeed, sin(ang)*0.35, 0.2 + uTime*1e-6)).r;
  float s2 = texture(uNoise3, vec3(cos(ang)*1.3, sin(ang)*1.3 + uSeed, r*0.05)).g;
  float rays = 0.35 + 1.6*pow(s1, 2.5) + 0.7*pow(s2, 3.);
  // Baumbach-like radial falloff (K + F corona)
  float I = (2.565*pow(r, -17.) + 1.425*pow(r, -7.) + 0.0532*pow(r, -2.5)*0.4) * 1e-6;
  float edge = smoothstep(7.5, 5.0, r);
  // chromosphere / prominences hugging the limb
  float prom = exp(-(r - 1.)*90.)*smoothstep(0.55, 0.8, texture(uNoise3, vec3(cos(ang)*2.1, sin(ang)*2.1, uSeed)).b)*2e-5;
  vec3 c = uCol*I*rays*edge + vec3(1.0, 0.12, 0.2)*prom;
  o = vec4(c*uRad*uExposure, 0.); }`;
let pCor, quadVAO;
function quad() { if (!quadVAO) quadVAO = makeVAO([{ data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), size: 2, loc: 0 }]); return quadVAO.vao; }

// ---------------- nebulae ----------------
const NEB_FS = `
in vec2 vUV; out vec4 o;
uniform sampler3D uNoise3; uniform mat3 uCamRot; uniform vec2 uTanFov; uniform vec3 uCen; uniform float uRad, uScale, uSeed, uFrame; uniform int uType; uniform vec3 uColA, uColB;
float ign(vec2 p){ return fract(52.9829189*fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float fbm(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++) { s += a*texture(uNoise3, p).r; p = p*2.07 + 13.7; a *= .5; } return s; }
void main(){
  vec3 rd = normalize(uCamRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  vec3 ro = -uCen/uRad;
  float b = dot(ro, rd), c = dot(ro, ro) - 1., h = b*b - c;
  if (h < 0.) { o = vec4(0., 0., 0., 1.); return; }
  h = sqrt(h); float t0 = max(-b - h, 0.), t1 = -b + h;
  if (t1 <= t0) { o = vec4(0., 0., 0., 1.); return; }
  const int N = 44; float dt = (t1 - t0)/float(N), jit = ign(gl_FragCoord.xy + uFrame);
  vec3 L = vec3(0.); float T = 1.;
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd*(t0 + (float(i) + jit)*dt); float r = length(p);
    vec3 q = p*0.13 + uSeed;
    vec3 w = vec3(texture(uNoise3, q*0.7).g, texture(uNoise3, q*0.7 + 0.31).b, texture(uNoise3, q*0.7 + 0.67).a) - 0.5;
    float n = fbm(q + w*0.35);
    float d = 0., dust = 0.; vec3 col = uColA;
    if (uType == 0) {
      // diffuse emission nebula: irregular turbulent cloud with a blown-out cavity around the hot stars
      float shape = 0.45 + 1.1*texture(uNoise3, p*0.045 + uSeed*0.7).a;
      float rr = r/shape;
      float env = smoothstep(1., 0.25, rr)*smoothstep(1., 0.8, r);
      float wisp = pow(1. - abs(fbm(q*1.7 + 3.1)*2. - 1.), 3.);
      d = smoothstep(0.42, 0.7, n + 0.1*env)*env;
      float cav = smoothstep(0.05, 0.28, length(p - vec3(0.1, 0.05, -0.05))/shape);
      d *= mix(0.12, 1., cav);
      // hydrogen-alpha glow inside, blue reflection haze outside, teal oxygen near the ionising stars
      col = mix(uColA, uColB, smoothstep(0.45, 0.95, rr + (n - 0.5)*0.5));
      col += vec3(0.08, 0.5, 0.42)*(1. - cav)*2.5;
      dust = smoothstep(0.5, 0.6, fbm(q*1.6 + 7.3))*smoothstep(1., 0.5, r)*6.;
      d = d*2.4 + wisp*env*0.55;
    } else if (uType == 1) {
      // planetary nebula: nested shells, slightly bipolar
      float rr = length(p*vec3(1., 0.78, 1.));
      float sh1 = exp(-pow((rr - 0.42)/0.07, 2.)), sh2 = exp(-pow((rr - 0.72)/0.13, 2.));
      float fil = 0.4 + 1.6*smoothstep(0.35, 0.7, n);
      d = (sh1*2.4 + sh2*0.5*fil) + smoothstep(0.42, 0., rr)*0.25;
      col = mix(uColA, uColB, smoothstep(0.35, 0.75, rr));
      d *= 2.;
    } else {
      // supernova remnant: thin filamentary shell
      float sh = exp(-pow((r - 0.78 - (n - 0.5)*0.25)/0.06, 2.));
      float f1 = 1. - abs(texture(uNoise3, q*2.3).r*2. - 1.), f2 = 1. - abs(texture(uNoise3, q*5.1 + 0.4).g*2. - 1.);
      float fil = pow(f1, 6.)*1.5 + pow(f2, 8.);
      d = sh*fil*5.;
      col = mix(uColA, uColB, smoothstep(0.3, 0.9, f2 + (n - 0.5)));
    }
    float k = dust*1.5;
    float st = exp(-k*dt*3.);
    L += T*col*d*dt;
    T *= st;
  }
  vec3 res = L*uScale;
  if (any(isnan(res)) || any(isinf(res))) res = vec3(0.);
  o = vec4(min(res, vec3(60000.)), clamp(T, 0., 1.));
}`;
let pNeb;
const nebCache = new Map();
const NEB_CELL = 500;
const ORION = (() => { const d = galDir(209.0, -19.4); return { pos: V.addm(SUN_POS, d, 412), radius: 7, type: 0, seed: 3.7, name: 'Orion Nebula', colA: [1.0, 0.28, 0.36], colB: [0.35, 0.45, 1.0], lum: 60 }; })();
export const REAL_NEBULAE = [ORION,
  (() => { const d = galDir(6.0, -1.2); return { pos: V.addm(SUN_POS, d, 1250), radius: 16, type: 0, seed: 9.1, name: 'Lagoon Nebula', colA: [1.0, 0.25, 0.35], colB: [0.9, 0.35, 0.5], lum: 40 }; })(),
  (() => { const d = galDir(63.2, 13.98); return { pos: V.addm(SUN_POS, d, 790), radius: 0.4, type: 1, seed: 5.5, name: 'Ring Nebula', colA: [0.25, 0.85, 0.75], colB: [1.0, 0.3, 0.25], lum: 600 }; })(),
  (() => { const d = galDir(184.56, -5.78); return { pos: V.addm(SUN_POS, d, 2000), radius: 1.7, type: 2, seed: 2.2, name: 'Crab Nebula', colA: [1.0, 0.45, 0.25], colB: [0.35, 0.7, 1.0], lum: 250 }; })(),
  (() => { const d = galDir(74.0, -8.6); return { pos: V.addm(SUN_POS, d, 740), radius: 18, type: 2, seed: 6.4, name: 'Veil Nebula', colA: [1.0, 0.3, 0.3], colB: [0.3, 0.75, 1.0], lum: 30 }; })(),
  (() => { const d = galDir(287.6, -0.6); return { pos: V.addm(SUN_POS, d, 2600), radius: 35, type: 0, seed: 8.8, name: 'Carina Nebula', colA: [1.0, 0.3, 0.33], colB: [0.9, 0.5, 0.4], lum: 45 }; })(),
];
export function nebulaeNear(galaxy, cam, dens) {
  const out = galaxy === MILKY_WAY ? REAL_NEBULAE.slice() : [];
  const cx = Math.floor(cam[0] / NEB_CELL), cy = Math.floor(cam[1] / NEB_CELL), cz = Math.floor(cam[2] / NEB_CELL);
  const dd = [0, 0];
  for (let x = cx - 3; x <= cx + 3; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 3; z <= cz + 3; z++) {
    const key = galaxy.id + ':' + x + ':' + y + ':' + z;
    let list = nebCache.get(key);
    if (!list) {
      list = []; const rng = new RNG(hashCombine(galaxy.seed, 0x4eb, x, y, z));
      dens([(x + 0.5) * NEB_CELL, (y + 0.5) * NEB_CELL, (z + 0.5) * NEB_CELL], dd);
      let n = rng.poisson(Math.min(dd[1] * 0.35 + dd[0] * 0.05, 3));
      // around the Sun the sky is the real one: only catalogued nebulae there
      if (galaxy === MILKY_WAY && Math.hypot((x + 0.5) * NEB_CELL - SUN_POS[0], (y + 0.5) * NEB_CELL - SUN_POS[1], (z + 0.5) * NEB_CELL - SUN_POS[2]) < 2200) n = 0;
      for (let i = 0; i < n; i++) {
        const u = rng.f(), type = u < 0.6 ? 0 : u < 0.8 ? 1 : 2, seed = rng.range(0, 50);
        const radius = type === 0 ? rng.logRange(4, 45) : type === 1 ? rng.logRange(0.15, 0.9) : rng.logRange(3, 30);
        const pal = type === 0 ? [[1.0, 0.27, 0.35], rng.pick([[0.35, 0.45, 1.0], [0.9, 0.4, 0.45], [0.5, 0.35, 0.9]])] : type === 1 ? [rng.pick([[0.25, 0.85, 0.75], [0.3, 0.6, 1.0], [0.5, 0.9, 0.4]]), rng.pick([[1.0, 0.3, 0.25], [1.0, 0.5, 0.2], [0.8, 0.3, 0.7]])] : [[1.0, 0.35, 0.3], [0.3, 0.75, 1.0]];
        const s = hashCombine(galaxy.seed, x, y, z, i);
        list.push({ pos: [(x + rng.f()) * NEB_CELL, (y + rng.f()) * NEB_CELL * 0.4 + y * NEB_CELL * 0.6, (z + rng.f()) * NEB_CELL], radius, type, seed, colA: pal[0], colB: pal[1], lum: type === 0 ? rng.range(20, 70) : type === 1 ? rng.range(300, 900) : rng.range(25, 250), name: makeName(s) + [' Nebula', ' planetary nebula', ' supernova remnant'][type] });
      }
      nebCache.set(key, list); if (nebCache.size > 3000) nebCache.delete(nebCache.keys().next().value);
    }
    for (const nb of list) out.push(nb);
  }
  return out;
}
export let visibleNebulae = [];
export function drawNebulaeAndFx(nav, o) {
  visibleNebulae = [];
  if (!nav.galaxy || !nav.field || !o.camLocal) return;
  if (!pNeb) pNeb = new Program('nebula', FS_VS, NEB_FS);
  const list = nebulaeNear(nav.galaxy, o.camLocal, nav.field.dens);
  const gq = nav.galaxy.quat, vis = [];
  for (const nb of list) {
    const relL = V.sub(nb.pos, o.camLocal), d = V.len(relL);
    const px = nb.radius / Math.max(d, 1e-9) * o.pxPerRad;
    if (px < 1.5 && d > nb.radius) continue;
    // distant nebulae are seen through the galaxy's dust and are hard to pick out: fade them with distance
    if (d > 300 && !nb.name.match(/Orion|Lagoon|Carina|Ring|Crab|Veil/)) continue;
    vis.push({ nb, rel: Q.rot(gq, relL), d, px });
  }
  vis.sort((a, b) => b.d - a.d);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  for (const v of vis.slice(-10)) {
    const nb = v.nb; v.name = nb.name; visibleNebulae.push(v);
    // scissor to the projected sphere
    let sc = null;
    if (v.d > nb.radius * 4) {
      const vv = Q.rot(Q.conj(nav.q), v.rel); if (vv[2] > -nb.radius * 0 && vv[2] > 0) continue;
      const z = -vv[2]; if (z <= 0) continue;
      const cx = (vv[0] / (z * o.tanFov[0]) * 0.5 + 0.5) * w, cy = (vv[1] / (z * o.tanFov[1]) * 0.5 + 0.5) * h, rp = v.px * 2.2 + 6;
      const x0 = clamp(Math.floor(cx - rp), 0, w), y0 = clamp(Math.floor(cy - rp), 0, h), x1 = clamp(Math.ceil(cx + rp), 0, w), y1 = clamp(Math.ceil(cy + rp), 0, h);
      if (x1 <= x0 || y1 <= y0) continue; sc = [x0, y0, x1 - x0, y1 - y0];
    }
    if (sc) { gl.enable(gl.SCISSOR_TEST); gl.scissor(sc[0], sc[1], sc[2], sc[3]); }
    pNeb.use().set({ uNoise3: o.noise3, uCamRot: o.camRot, uTanFov: o.tanFov, uCen: v.rel, uRad: nb.radius, uScale: GAL_I0 * nb.lum * skyCfg.galBoost * 0.25 * o.exposure, uSeed: nb.seed, uFrame: o.frame % 16, uType: nb.type, uColA: nb.colA, uColB: nb.colB });
    drawFS();
    gl.disable(gl.SCISSOR_TEST);
  }
}
const BEAM_VS = `layout(location=0) in vec2 aPos; uniform mat4 uViewProj; uniform vec3 uRel, uAxis; uniform float uLen, uW0, uW1; out vec2 vP; ${LOGDEPTH_VS}
void main(){ float t = aPos.y*0.5 + 0.5; vec3 c = uRel + uAxis*(t*uLen); vec3 side = normalize(cross(uAxis, normalize(c)));
  vP = vec2(aPos.x, t); vec3 w = c + side*aPos.x*mix(uW0, uW1, t); gl_Position = uViewProj*vec4(w, 1.); logDepth(); }`;
const BEAM_FS = `in vec2 vP; out vec4 o; uniform vec3 uCol; uniform float uI, uFall, uExposure; ${LOGDEPTH_FS}
void main(){ logDepth(); float w = 1. - vP.x*vP.x; float a = exp(-vP.x*vP.x*7.)*w*w*pow(1. - vP.y, uFall)*smoothstep(0., 0.04, vP.y); o = vec4(uCol*a*uI*uExposure, 0.); }`;
let pBeam;
function beam(o, rel, axis, len, w0, w1, col, I, fall) {
  if (!pBeam) pBeam = new Program('beam', BEAM_VS, BEAM_FS);
  pBeam.use().set({ uViewProj: o.viewProj, uFcoef: o.fcoef, uRel: rel, uAxis: axis, uLen: len, uW0: w0, uW1: w1, uCol: col, uI: I, uFall: fall, uExposure: o.exposure });
  gl.bindVertexArray(quad()); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
drawNebulaeAndFx.coronae = function (sys, nav, o) {
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
  const star = sys.stars[0];
  for (const b of sys.bodies) {
    if (!b.rel) continue;
    if (b.kind === 'comet' && star) {
      // dust and ion tails grow as the comet approaches the star
      const toStar = V.sub(star.wpos, b.wpos), r = V.len(toStar) / C.AU; if (r > 6) continue;
      const act = Math.min(4, 1 / (r * r)) * star.lum, away = V.mul(V.norm(toStar), -1);
      const E = star.lum / (r * r);
      const vel = V.norm(V.cross(Q.rot(sys.worldQ, [0, 1, 0]), away));
      const dust = V.norm(V.addm(away, vel, -0.35));
      const L = 0.25 * C.AU * Math.sqrt(act);
      beam(o, b.rel, away, L * 1.6, b.radius * 30, L * 0.05, [0.35, 0.6, 1.0], 1.2e-8 * E * act, 1.4);
      beam(o, b.rel, dust, L, b.radius * 40, L * 0.22, [1.0, 0.9, 0.7], 2.5e-8 * E * act, 1.8);
      beam(o, V.addm(b.rel, away, -b.radius * 60), away, b.radius * 400, b.radius * 150, b.radius * 400, [0.6, 1.0, 0.8], 2e-7 * E * act, 3);
    }
    if (b.neutron && b.pulsar && b.pxRadius > 0.02) {
      // lighthouse beams along the (tilted) magnetic axis
      const ax = Q.rot(b.wrot, V.norm([0.6, 0.8, 0]));
      const len = b.radius * 4000;
      beam(o, b.rel, ax, len, b.radius * 2, len * 0.08, [0.55, 0.7, 1.0], 30 * b.lum, 1.2);
      beam(o, b.rel, V.mul(ax, -1), len, b.radius * 2, len * 0.08, [0.55, 0.7, 1.0], 30 * b.lum, 1.2);
    }
  }
  if (!pCor) pCor = new Program('corona', COR_VS, COR_FS);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
  for (const s of sys.stars) {
    if (s.blackHole || !s.rel || s.pxRadius < 1.5) continue;
    const c = bbColor(s.temp), y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    pCor.use().set({ uViewProj: o.viewProj, uFcoef: o.fcoef, uRel: s.rel, uSize: s.radius * 8, uR: s.radius, uExposure: o.exposure, uRad: 1.47e4 * s.lum / ((s.radius / C.Rsun) ** 2), uCol: [c[0] / y, c[1] / y, c[2] / y], uNoise3: o.noise3, uTime: o.time % 1e7, uSeed: (s.uid * 0.37) % 1 });
    gl.bindVertexArray(quad()); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  gl.disable(gl.DEPTH_TEST);
};

export function initExoticPrograms() {
  if (!pBH) pBH = new Program('blackhole', FS_VS, BH_FS);
  if (!pNeb) pNeb = new Program('nebula', FS_VS, NEB_FS);
  if (!pBeam) pBeam = new Program('beam', BEAM_VS, BEAM_FS);
  if (!pCor) pCor = new Program('corona', COR_VS, COR_FS);
}
