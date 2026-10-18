// Exotic objects and effects: black holes with gravitational lensing and accretion disks, stellar coronae,
// volumetric nebulae.
import { gl, Program, drawFS, FS_VS, makeVAO } from './gl.js';
import { V, Q, C, clamp, mix } from './math.js';
import { RNG, hashCombine, makeName } from './rng.js';
import { LOGDEPTH_VS, LOGDEPTH_FS, REFRACT_VS } from './planet.js';
import { GLSL_BB, bbColor, vSurface } from './stars.js';
import { GAL_I0, skyCfg } from './sky.js';
import { galDir, SUN_POS, MILKY_WAY } from './universe.js';
import { world, mwFormation, sfrRel } from './galdyn.js';
import { globularNebulae } from './globulars.js';
import { iscoRadius } from './nbody.js';

// ---------------- black hole ----------------
const BH_FS = `
in vec2 vUV; out vec4 o;
uniform sampler2D uScene; uniform sampler3D uNoise3;
uniform mat3 uCamRot, uCamRotInv, uDiskRot; uniform vec2 uTanFov; uniform vec3 uRel;
uniform float uRs, uExposure, uTime, uDisk, uDiskT, uStrong, uSpin, uIsco;
${GLSL_BB}
uniform samplerCube uSkyCube; uniform mat3 uSkyRot; uniform float uSkyScale;
// what lies in direction d: the rendered frame where it can see that way, else the all-sky galaxy background
vec3 sampleSky(vec3 d){
  vec3 back = uSkyScale > 0. ? texture(uSkyCube, uSkyRot*d).rgb*uSkyScale : vec3(0.);
  vec3 v = uCamRotInv*d;
  if (v.z > -0.02) return back;
  vec2 uv = (v.xy/(-v.z*uTanFov))*0.5 + 0.5;
  vec2 e = smoothstep(vec2(-0.02), vec2(0.03), uv)*smoothstep(vec2(1.02), vec2(0.97), uv);
  return mix(back, texture(uScene, clamp(uv, 0., 1.)).rgb, e.x*e.y);
}
// the accretion disk where a ray crosses its plane: q (units of Rs, world axes), v the ray direction there
void diskHit(vec3 q, vec3 v, inout vec3 col, inout float alpha){
  vec3 dn = uDiskRot[1];
  float rr = length(q);
  if (rr < uIsco || rr > 16.) return;
  vec3 ql = vec3(dot(q, uDiskRot[0]), 0., dot(q, uDiskRot[2]));
  float ang = atan(ql.z, ql.x);
  float om = 0.35*pow(rr, -1.5);
  float sw = ang + uTime*om*40.;
  float n = texture(uNoise3, vec3(rr*0.21, sw*0.6366*0.5, 0.3)).r*0.6 + texture(uNoise3, vec3(rr*0.9, sw*0.6366*1.5 + 0.3, 0.7)).g*0.4;
  float dens = smoothstep(uIsco, uIsco + 0.5, rr)*smoothstep(16., 8., rr)*(0.15 + 2.2*n*n*n);
  // temperature profile (zero torque at the innermost stable orbit), Doppler beaming and gravitational redshift
  float T = uDiskT*pow(rr/3., -0.75)*pow(max(1. - sqrt(uIsco/rr), 0.02), 0.25)*1.9;
  float beta = min(sqrt(0.5/rr), 0.7);
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
// Kerr (rotating) hole in Kerr-Schild coordinates, units of M, spin a along +z.
// g^uv = eta^uv - f l^u l^v with f = 2 r^3/(r^4 + a^2 z^2) and l = ((r x + a y)/(r^2 + a^2), (r y - a x)/(r^2 + a^2), z/r).
// For a photon of unit energy H = (|p|^2 - 1 - f (1 + l.p)^2)/2 = 0.
float ksR(vec3 x, float a){ float rho2 = dot(x, x) - a*a; return sqrt(0.5*(rho2 + sqrt(rho2*rho2 + 4.*a*a*x.z*x.z))); }
void ksFL(vec3 x, float a, out float f, out vec3 l){
  float r = max(ksR(x, a), 1e-4), r2 = r*r;
  f = 2.*r2*r/(r2*r2 + a*a*x.z*x.z);
  l = vec3((r*x.x + a*x.y)/(r2 + a*a), (r*x.y - a*x.x)/(r2 + a*a), x.z/r);
}
float ksG(vec3 x, vec3 p, float a){ float f; vec3 l; ksFL(x, a, f, l); float s = 1. + dot(l, p); return f*s*s; }
void ksDeriv(vec3 x, vec3 p, float a, out vec3 dx, out vec3 dp){
  float f; vec3 l; ksFL(x, a, f, l);
  dx = p - f*(1. + dot(l, p))*l;
  // (forward differences: four metric evaluations per derivative instead of seven)
  float e = 6e-4*max(1., length(x)*0.02), s0 = 1. + dot(l, p), g0 = f*s0*s0;
  dp = 0.5*vec3(ksG(x + vec3(e, 0., 0.), p, a) - g0, ksG(x + vec3(0., e, 0.), p, a) - g0, ksG(x + vec3(0., 0., e), p, a) - g0)/e;
}
void main(){
  vec3 rd = normalize(uCamRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  vec3 ro = -uRel;                         // camera relative to hole
  float r0 = length(ro);
  float tca = -dot(ro, rd);
  vec3 pc = ro + rd*tca; float b = length(pc);
  if (tca < 0. || b > uStrong*uRs) {
    // weak field: small deflection towards the hole
    if (tca > 0.) { float a = 2.*uRs/b; rd = normalize(rd - (pc/b)*a); }
    o = vec4(sampleSky(rd), 1.); return;
  }
  vec3 col = vec3(0.); float alpha = 0.; bool captured = false;
  vec3 dn = uDiskRot[1];
  vec3 vOut = rd;
  // (spin only matters for rays that pass close: further out the Schwarzschild bending is the same to a fraction of a pixel)
  if (abs(uSpin) > 0.02 && b < 8.*uRs) {
    // rotating hole: local frame X = axis 2, Y = axis 0, Z = spin axis (right handed); positions in M (= Rs/2)
    float a = uSpin, rH = 1. + sqrt(max(1. - a*a, 0.));
    mat3 W = mat3(uDiskRot[2], uDiskRot[0], uDiskRot[1]), Wt = transpose(W);
    vec3 pw = ro/uRs; float start = max(length(pw) - 30., 0.); pw += rd*start;
    vec3 x = Wt*pw*2., n = Wt*rd;
    // initial momentum along the ray with H = 0 (the metric is nearly flat this far out)
    float f0; vec3 l0; ksFL(x, a, f0, l0); float sl = dot(l0, n);
    float qa = 1. - f0*sl*sl, qb = -2.*f0*sl, qc = -(1. + f0);
    vec3 p = n*((-qb + sqrt(max(qb*qb - 4.*qa*qc, 0.)))/(2.*qa));
    vec3 dx = n;
    for (int i = 0; i < 400; i++) {
      float r = ksR(x, a);
      if (r < rH*1.02) { captured = true; break; }
      if (r > 64. && dot(x, dx) > 0.) break;
      float h = clamp((r - rH)*0.075, 0.012, 6.)*(r < 8. ? 0.55 : 1.);
      // midpoint (RK2) step of Hamilton's equations
      vec3 dx1, dp1; ksDeriv(x, p, a, dx1, dp1);
      vec3 xm = x + dx1*(0.5*h), pm = p + dp1*(0.5*h);
      vec3 dx2, dp2; ksDeriv(xm, pm, a, dx2, dp2);
      vec3 xn = x + dx2*h; p += dp2*h; dx = dx2;
      if (uDisk > 0. && x.z*xn.z < 0.) { vec3 qL = mix(x, xn, x.z/(x.z - xn.z)); diskHit(W*qL*0.5, W*normalize(dx2), col, alpha); }
      x = xn;
    }
    vOut = normalize(W*dx);
  } else {
    // non-rotating hole: Schwarzschild null geodesic, units of Rs
    vec3 p = ro/uRs, v = rd;
    float start = max(length(p) - 70., 0.);
    p += v*start;
    vec3 hv = cross(p, v); float h2 = dot(hv, hv);
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
      if (uDisk > 0.) { float y0 = dot(p, dn), y1 = dot(pn, dn); if (y0*y1 < 0.) diskHit(mix(p, pn, y0/(y0 - y1)), v, col, alpha); }
      p = pn; v = vn;
    }
    vOut = normalize(v);
  }
  vec3 bg = captured ? vec3(0.) : sampleSky(vOut);
  o = vec4(bg*(1. - alpha) + col*uExposure, 1.);
}`;
const skyU = (sk) => sk ? { uSkyCube: sk.tex, uSkyRot: sk.rot, uSkyScale: sk.scale } : { uSkyScale: 0 };
let pBH;
export function drawBlackHole(b, o) {
  if (!pBH) pBH = new Program('blackhole', FS_VS, BH_FS);
  const rs = b.radius;
  // accretion flickers: hot spots and flares in the inner disk (Sagittarius A* flares several times a day, each about
  // an hour). Averaged out when a frame spans more than a few hours.
  let flick = 1;
  if (b.accretion && o.time !== undefined && !(Math.abs(o.dt || 0) > 4 * 3600)) {
    const t = o.time / 3600, k = Math.floor(t), seed = (b.uid || 7) * 0.618;
    for (let dj = -2; dj <= 0; dj++) { const j = k + dj, h = Math.abs(Math.sin((j + seed) * 12.9898) * 43758.5453) % 1; if (h > 0.3) continue; const a = t - j - (h * 3.3) % 1; if (a > 0) flick += 2.5 * (h / 0.3) * Math.exp(-a / 0.6) * Math.min(1, a * 6); }
  }
  const disk = (b.accretion || 0) * flick, spin = clamp(b.spin || 0, -0.998, 0.998);
  pBH.use().set({ uScene: o.scene, uNoise3: o.noise3, uCamRot: o.camRot, uCamRotInv: Q.mat3(Q.conj(o.q)), uDiskRot: Q.mat3(b.axisW || o.rotQ), uTanFov: o.tanFov, uRel: o.rel, uRs: rs, uExposure: o.exposure, uTime: o.time % 1e5, uDisk: disk * 40, uDiskT: 9000, uStrong: o.strong || 60, uSpin: spin, uIsco: iscoRadius(spin) / 2, ...skyU(o.sky) });
  drawFS();
}

// Several black holes at once (a merging binary): every ray is integrated through the combined field, each hole bending
// it by the Schwarzschild photon equation a = -3/2 Rs h^2 r / r^5 (h: the ray's angular momentum about that hole).
// Near merger the two shadows stretch towards each other and fuse, which lensing the holes one after another cannot do.
const BHN_FS = `
in vec2 vUV; out vec4 o;
uniform sampler2D uScene; uniform mat3 uCamRot, uCamRotInv; uniform vec2 uTanFov;
uniform vec4 uHoles[4]; uniform int uN; uniform float uStrong;
uniform samplerCube uSkyCube; uniform mat3 uSkyRot; uniform float uSkyScale;
// what lies in direction d: the rendered frame where it can see that way, else the all-sky galaxy background
vec3 sampleSky(vec3 d){
  vec3 back = uSkyScale > 0. ? texture(uSkyCube, uSkyRot*d).rgb*uSkyScale : vec3(0.);
  vec3 v = uCamRotInv*d;
  if (v.z > -0.02) return back;
  vec2 uv = (v.xy/(-v.z*uTanFov))*0.5 + 0.5;
  vec2 e = smoothstep(vec2(-0.02), vec2(0.03), uv)*smoothstep(vec2(1.02), vec2(0.97), uv);
  return mix(back, texture(uScene, clamp(uv, 0., 1.)).rgb, e.x*e.y);
}
void main(){
  vec3 rd = normalize(uCamRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  // weak field everywhere along this ray? then just add up the small deflections
  bool strong = false; vec3 dsum = vec3(0.); float rsMin = 1e30;
  for (int i = 0; i < 4; i++) {
    if (i >= uN) break;
    vec3 c = uHoles[i].xyz; float rs = uHoles[i].w; rsMin = min(rsMin, rs);
    float tca = dot(c, rd); vec3 pc = rd*tca - c; float b = length(pc);
    if (tca > 0. && b < uStrong*rs) strong = true;
    if (tca > 0.) dsum += pc/b*(2.*rs/b);
  }
  if (!strong) { o = vec4(sampleSky(normalize(rd - dsum)), 1.); return; }
  // integrate the ray (positions in units of the smallest horizon radius)
  vec3 p = vec3(0.), v = rd; float sc = 1./rsMin; bool captured = false;
  vec3 H[4]; float R[4];
  for (int i = 0; i < 4; i++) { H[i] = i < uN ? uHoles[i].xyz*sc : vec3(1e9); R[i] = i < uN ? uHoles[i].w*sc : 0.; }
  float far = 0.; for (int i = 0; i < 4; i++) if (i < uN) far = max(far, length(H[i]));
  for (int s = 0; s < 420; s++) {
    vec3 acc = vec3(0.); float dmin = 1e30; bool past = true;
    for (int i = 0; i < 4; i++) {
      if (i >= uN) break;
      vec3 d = p - H[i]; float r = length(d);
      if (r < R[i]) { captured = true; break; }
      vec3 hv = cross(d, v); acc += -1.5*R[i]*dot(hv, hv)*d/(r*r*r*r*r);
      dmin = min(dmin, r/R[i]);
      if (dot(d, v) < 0. || r < 60.*R[i]) past = false;
    }
    if (captured) break;
    if (past && length(p) > far) break;
    float dt = clamp(dmin*0.06, 0.015, 6.)*(dmin < 4. ? 0.5 : 1.)*rsMin*sc;
    v = normalize(v + acc*dt); p += v*dt;
  }
  o = vec4(captured ? vec3(0.) : sampleSky(v), 1.);
}`;
let pBHN;
export function drawBlackHoles(list, o) {
  if (!pBHN) pBHN = new Program('blackholes', FS_VS, BHN_FS);
  const h = new Float32Array(16); const n = Math.min(list.length, 4);
  for (let i = 0; i < n; i++) h.set([list[i].rel[0], list[i].rel[1], list[i].rel[2], list[i].radius], i * 4);
  pBHN.use().set({ uScene: o.scene, uCamRot: o.camRot, uCamRotInv: Q.mat3(Q.conj(o.q)), uTanFov: o.tanFov, uHoles: h, uN: n, uStrong: 40, ...skyU(o.sky) });
  drawFS();
}

// ---------------- coronae ----------------
const COR_VS = `layout(location=0) in vec2 aPos; uniform mat4 uViewProj; uniform vec3 uRel; uniform float uSize; out vec2 vP; ${LOGDEPTH_VS}
${REFRACT_VS}
void main(){ vec3 f = normalize(uRel); vec3 r = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0,1,0) : vec3(1,0,0))); vec3 u = cross(r, f);
  vP = aPos*uSize; vec3 w = uRel + (r*aPos.x + u*aPos.y)*uSize; gl_Position = uViewProj*vec4(refractLift(w), 1.); logDepth(); }`;
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
uniform sampler3D uNoise3; uniform mat3 uCamRot; uniform vec2 uTanFov; uniform vec3 uCen; uniform float uRad, uScale, uSeed, uFrame, uDust; uniform int uType; uniform vec3 uColA, uColB;
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
      // diffuse emission nebula: irregular turbulent cloud lit by hot stars inside a blown-out cavity
      vec3 pe = p*vec3(1., 1.45, 0.8);
      float shape = 0.3 + 1.3*texture(uNoise3, pe*0.06 + uSeed*0.7).a + 0.4*texture(uNoise3, pe*0.17 + uSeed).r;
      float rr = length(pe)/shape;
      float env = exp(-rr*rr*2.6)*smoothstep(1., 0.6, r);
      float wisp = pow(1. - abs(fbm(q*1.7 + 3.1)*2. - 1.), 3.);
      d = smoothstep(0.42, 0.7, n + 0.1*env)*env;
      float cav = smoothstep(0.05, 0.28, length(p - vec3(0.1, 0.05, -0.05))/shape);
      d *= mix(0.12, 1., cav);
      // hydrogen-alpha glow inside, blue reflection haze outside, teal oxygen near the ionising stars
      col = mix(uColA, uColB, 0.35*smoothstep(0.55, 1.1, rr + (n - 0.5)*0.5));
      col += vec3(0.08, 0.5, 0.42)*(1. - cav)*2.5;
      dust = smoothstep(0.5, 0.6, fbm(q*1.6 + 7.3))*smoothstep(1., 0.5, r)*6.;
      // ionising stars near the cavity: emission falls off with distance from them
      float ion = 1. + 7./(1. + dot(p - vec3(0.1, 0.05, -0.05), p - vec3(0.1, 0.05, -0.05))*30.);
      d = (d*2.4 + wisp*env*0.55)*ion*0.5;
    } else if (uType == 1) {
      // planetary nebula: nested shells; about a third are round, a third elliptical and a third bipolar (an hourglass
      // pinched by a dense equatorial torus, like the Butterfly and the Ant)
      float morph = fract(uSeed*0.618 + 0.13), rr = length(p*vec3(1., 0.78, 1.));
      if (morph > 0.35) rr = length(p*vec3(1., 0.55, 1.));
      if (morph > 0.68) { vec3 q2 = vec3(p.x, abs(p.y) - 0.42, p.z); rr = min(length(q2*vec3(1.7, 1.05, 1.7)) + 0.22, length(p*vec3(0.75, 2.6, 0.75))); }
      float sh1 = exp(-pow((rr - 0.42)/0.07, 2.)), sh2 = exp(-pow((rr - 0.72)/0.13, 2.));
      float fil = 0.4 + 1.6*smoothstep(0.35, 0.7, n);
      d = (sh1*2.4 + sh2*0.5*fil) + smoothstep(0.42, 0., rr)*0.25;
      col = mix(uColA, uColB, smoothstep(0.35, 0.75, rr));
      d *= 2.;
    } else if (uType == 4) {
      // globular cluster: a King-like profile of old stars (core ~1/6 of the radius) that resolves into individual
      // stars towards the edge
      float rc = 0.09, kp = 1./pow(1. + r*r/(rc*rc), 1.5) - 1./pow(1. + 1./(rc*rc), 1.5);
      float grain = pow(texture(uNoise3, q*11.).r, 7.)*9. + pow(texture(uNoise3, q*29. + 0.37).g, 9.)*16. + pow(texture(uNoise3, q*61. + 0.71).b, 10.)*22.;
      d = max(kp, 0.)*(0.35 + grain*smoothstep(0.02, 0.4, r))*2.2;
      col = mix(uColA, uColB, 0.15*grain);
    } else if (uType == 3) {
      // protoplanetary disk: flared (scale height ~ r^1.25), lit by the young star at its centre, with the dust
      // gaps that forming planets carve (as ALMA sees around HL Tauri), opaque in the midplane
      float rc = length(p.xz), hgt = 0.035*pow(max(rc, 0.02), 1.25) + 0.004;
      float rho = exp(-p.y*p.y/(2.*hgt*hgt))*smoothstep(1., 0.75, rc)*smoothstep(0.004, 0.02, rc)/max(rc, 0.02);
      float gaps = 1. - 0.75*pow(abs(sin(rc*52. + n*0.6)), 18.);
      rho *= gaps*(0.75 + 0.5*n);
      d = rho*0.25/(0.02 + r*r*4.);                      // scattered starlight, falling off away from the star
      col = mix(uColA, uColB, smoothstep(0.1, 0.8, rc));
      dust = rho*2.2;
    } else {
      // supernova remnant: filamentary shell; young ones with a pulsar also have a blue-white synchrotron interior
      vec3 pr = p*vec3(1., 1.35, 1.);
      float re = length(pr);
      float sh = exp(-pow((re - 0.78 - (n - 0.5)*0.25)/0.07, 2.));
      float f1 = 1. - abs(texture(uNoise3, q*2.3).r*2. - 1.), f2 = 1. - abs(texture(uNoise3, q*5.1 + 0.4).g*2. - 1.);
      float fil = pow(f1, 6.)*1.5 + pow(f2, 8.);
      float filD = sh*fil*5. + smoothstep(0.85, 0.5, re)*pow(f1, 10.)*2.;
      vec3 filC = mix(vec3(1.0, 0.3, 0.12), vec3(1.0, 0.65, 0.3), smoothstep(0.3, 0.9, f2 + (n - 0.5)));
      float syn = uColB.b > 0.9 && uSeed < 3. ? smoothstep(0.85, 0.2, re)*(0.6 + 0.6*n) : 0.;
      if (uSeed >= 3.) filC = mix(uColA, uColB, smoothstep(0.3, 0.9, f2 + (n - 0.5)));
      d = filD + syn*1.2;
      col = (filC*filD + vec3(0.55, 0.7, 1.0)*syn*1.2)/max(d, 1e-4);
    }
    float k = dust*1.5;
    float st = exp(-k*dt*3.);
    L += T*col*d*dt;
    T *= st;
  }
  vec3 res = L*uScale;
  if (any(isnan(res)) || any(isinf(res))) res = vec3(0.);
  o = vec4(min(res, vec3(60000.)), mix(1., clamp(T, 0., 1.), uDust));
}`;
let pNeb;
const nebCache = new Map();
const NEB_CELL = 500;
const ORION = (() => { const d = galDir(209.0, -19.4); return { pos: V.addm(SUN_POS, d, 412), radius: 7, type: 0, seed: 3.7, name: 'Orion Nebula', colA: [1.0, 0.28, 0.36], colB: [0.35, 0.45, 1.0], lum: 60, life: 3e6 }; })();
export const REAL_NEBULAE = [ORION,
  (() => { const d = galDir(6.0, -1.2); return { pos: V.addm(SUN_POS, d, 1250), radius: 16, type: 0, seed: 9.1, name: 'Lagoon Nebula', colA: [1.0, 0.25, 0.35], colB: [0.9, 0.35, 0.5], lum: 40, life: 3e6 }; })(),
  (() => { const d = galDir(63.2, 13.98); return { pos: V.addm(SUN_POS, d, 790), radius: 0.4, type: 1, seed: 5.5, name: 'Ring Nebula', colA: [0.25, 0.85, 0.75], colB: [1.0, 0.3, 0.25], lum: 600, life: 2.5e4, age: 4000 }; })(),
  (() => { const d = galDir(184.56, -5.78); return { pos: V.addm(SUN_POS, d, 2000), radius: 1.7, type: 2, seed: 2.2, name: 'Crab Nebula', colA: [1.0, 0.45, 0.25], colB: [0.35, 0.7, 1.0], lum: 250, life: 4e4, age: 945.52 }; })(),
  (() => { const d = galDir(74.0, -8.6); return { pos: V.addm(SUN_POS, d, 740), radius: 18, type: 2, seed: 6.4, name: 'Veil Nebula', colA: [1.0, 0.3, 0.3], colB: [0.3, 0.75, 1.0], lum: 30, life: 6e4, age: 15000 }; })(),
  (() => { const d = galDir(287.6, -0.6); return { pos: V.addm(SUN_POS, d, 2600), radius: 35, type: 0, seed: 8.8, name: 'Carina Nebula', colA: [1.0, 0.3, 0.33], colB: [0.9, 0.5, 0.4], lum: 45, life: 3e6 }; })(),
  // remnants of the historical supernovae (age in years at J2000; they appear when they exploded)
  ...[['Cassiopeia A', 111.73, -2.13, 3400, 2.5, 320, 200], ["Tycho's supernova remnant", 120.1, 1.4, 2500, 2.9, 428, 120], ["Kepler's supernova remnant", 4.5, 6.8, 5000, 2.5, 396, 120],
    ['SN 1006 remnant', 327.6, 14.6, 2200, 9.6, 994, 40], ['RCW 86 (SN 185)', 315.4, -2.3, 2800, 16, 1815, 25]]
    .map(([name, l, b, dist, radius, age, lum], k) => ({ pos: V.addm(SUN_POS, galDir(l, b), dist), radius, type: 2, seed: 11.3 + k * 3.1, name, colA: [1.0, 0.4, 0.35], colB: [0.35, 0.7, 1.0], lum, life: 6e4, age, far: true })),
];
export function nebulaeNear(galaxy, cam, dens) {
  const out = galaxy === MILKY_WAY ? REAL_NEBULAE.concat(globularNebulae(world.tyr)) : [];
  const cx = Math.floor(cam[0] / NEB_CELL), cy = Math.floor(cam[1] / NEB_CELL), cz = Math.floor(cam[2] / NEB_CELL);
  const dd = [0, 0];
  for (let x = cx - 3; x <= cx + 3; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 3; z <= cz + 3; z++) {
    const key = galaxy.id + ':' + x + ':' + y + ':' + z;
    let list = nebCache.get(key);
    if (!list) {
      list = []; const rng = new RNG(hashCombine(galaxy.seed, 0x4eb, x, y, z));
      dens([(x + 0.5) * NEB_CELL, (y + 0.5) * NEB_CELL, (z + 0.5) * NEB_CELL], dd);
      // slots for 2.5x today's population: each slot hosts a succession of nebulae, and how many are lit at a
      // given time follows the star formation history (see nebulaRates)
      let n = rng.poisson(Math.min(dd[1] * 0.35 + dd[0] * 0.05, 3) * 2.5);
      // around the Sun the sky is the real one: only catalogued nebulae there
      if (galaxy === MILKY_WAY && Math.hypot((x + 0.5) * NEB_CELL - SUN_POS[0], (y + 0.5) * NEB_CELL - SUN_POS[1], (z + 0.5) * NEB_CELL - SUN_POS[2]) < 2200) n = 0;
      for (let i = 0; i < n; i++) {
        const u = rng.f(), type = u < 0.6 ? 0 : u < 0.8 ? 1 : 2, seed = rng.range(0, 50);
        const radius = type === 0 ? rng.logRange(4, 45) : type === 1 ? rng.logRange(0.15, 0.9) : rng.logRange(3, 30);
        const pal = type === 0 ? [[1.0, 0.27, 0.35], rng.pick([[0.35, 0.45, 1.0], [0.9, 0.4, 0.45], [0.5, 0.35, 0.9]])] : type === 1 ? [rng.pick([[0.25, 0.85, 0.75], [0.3, 0.6, 1.0], [0.5, 0.9, 0.4]]), rng.pick([[1.0, 0.3, 0.25], [1.0, 0.5, 0.2], [0.8, 0.3, 0.7]])] : [[1.0, 0.35, 0.3], [0.3, 0.75, 1.0]];
        const s = hashCombine(galaxy.seed, x, y, z, i);
        // lifetimes: H II regions until their O stars die and their winds disperse the gas (3-10 Myr); planetary
        // nebulae expand at ~20 km/s and fade in a few tens of thousands of years; remnants stay visible ~30-100 kyr
        const life = type === 0 ? rng.range(3e6, 1e7) : type === 1 ? rng.range(1.5e4, 5e4) : rng.range(3e4, 1e5);
        list.push({ proc: true, cell: [x * NEB_CELL, y * NEB_CELL, z * NEB_CELL], s, life, phase: rng.f(), seed0: seed, radius0: radius, type, seed, colA: pal[0], colB: pal[1], lum0: type === 0 ? rng.range(20, 70) : type === 1 ? rng.range(300, 900) : rng.range(25, 250), gen: null });
      }
      nebCache.set(key, list); if (nebCache.size > 3000) nebCache.delete(nebCache.keys().next().value);
    }
    for (const nb of list) out.push(nb);
  }
  return out;
}
// Relative birth rates (1 today) of each kind of nebula at t years from now. Star formation (H II regions,
// core-collapse remnants) starts with the galaxies 13 Gyr ago, peaks at "cosmic noon" ~10 Gyr ago at ~3x today's
// rate (Madau & Dickinson 2014) and dies away as the gas runs out over the next ~10 Gyr. Planetary nebulae come from
// old Sun-like stars, so they keep appearing until ~1 solar mass stars stop dying, tens of billions of years after.
export function nebulaRates(t) {
  const f = mwFormation(t), sfr = sfrRel(t);
  const pn = f * (t > 1.5e10 ? Math.exp(-(t - 1.5e10) / 1e10) : 1);
  return [sfr, pn, 0.75 * sfr + 0.25 * pn];
}
const fract = (x) => x - Math.floor(x), sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
let rateT = NaN, rates = [1, 1, 1];
// a procedural nebula slot at the current time: which generation is lit, how old it is, where, how big and bright
export function procNebulaTest(nb) { return procNebula(nb); }
function procNebula(nb) {
  const t = world.tyr, dt = Math.abs(world.dtyr || 0);
  if (t !== rateT) { rates = nebulaRates(t); rateT = t; }
  let cyc = t / nb.life + nb.phase, x;
  // faster than ~5% of a lifetime per frame the individual nebulae would just flicker: show a typical one at a
  // typical age, replaced every ~40 frames instead (what a long exposure of the time-lapse would show)
  const k = dt / nb.life;
  if (k > 0.05) { cyc = Math.floor(cyc / (k * 40)); x = 0.4; } else x = fract(cyc);
  const gen = Math.floor(cyc);
  if (hashCombine(nb.s, gen, 77) / 4294967296 * 2.5 >= rates[nb.type]) return null;
  if (!nb.cur || nb.gen !== gen) {
    const r = new RNG(hashCombine(nb.s, gen));
    nb.gen = gen;
    nb.cur = Object.assign(nb.cur || {}, { pos: [nb.cell[0] + r.f() * NEB_CELL, nb.cell[1] + r.f() * 0.4 * NEB_CELL, nb.cell[2] + r.f() * NEB_CELL], seed: (nb.seed0 + gen * 7.31) % 50, type: nb.type, colA: nb.colA, colB: nb.colB, life: nb.life,
      name: makeName(hashCombine(nb.s, gen, 5)) + [' Nebula', ' planetary nebula', ' supernova remnant'][nb.type], gen });
  }
  const c = nb.cur, R0 = nb.radius0;
  let R, L;
  if (nb.type === 0) {
    // the ionized bubble expands as t^(4/7) (Spitzer); the O stars' light is fixed, so surface brightness ~ R^-2
    R = R0 * (0.15 + 0.85 * Math.pow(x / 0.4, 4 / 7));
    L = nb.lum0 * Math.min(4, (R0 / R) ** 2) * sstep(0, 0.04, x) * (1 - sstep(0.55, 1, x));
  } else if (nb.type === 1) {
    // a shell coasting outward at constant speed, fading as it thins and the central star cools
    R = R0 * (0.08 + 2.3 * x);
    L = nb.lum0 * Math.min(4, (R0 / R) ** 2) * sstep(0, 0.03, x) * (1 - sstep(0.6, 1, x));
  } else {
    // Sedov-Taylor blast wave: R ~ t^(2/5)
    R = R0 * Math.pow(Math.max(x, 0.005) / 0.4, 0.4);
    L = nb.lum0 * Math.min(6, (R0 / R) ** 2) * (1 - sstep(0.5, 1, x));
  }
  if (L <= nb.lum0 * 0.01) return null;
  c.radius = R; c.lum = L; c.age = x * nb.life;
  return c;
}
// Real nebulae change with time: H II regions disperse in a few million years, planetary nebulae and supernova
// remnants expand (radius ~ age for free expansion, ~ age^0.4 once they have swept up their mass) and fade.
export function nebulaAt(nb) {
  if (nb.proc) return procNebula(nb);
  const t = world.tyr; if (!nb.life || !t) return nb;
  const life = nb.life, a = Math.abs(t);
  const w = Math.max(0, Math.min(1, 1 - (a - 0.3 * life) / (0.7 * life)));
  if (w <= 0) return null;
  let radius = nb.radius;
  if (nb.age) { const age = Math.max(nb.age + t, 1); radius = nb.radius * Math.pow(age / nb.age, nb.type === 2 && age > 3000 ? 0.4 : 1); if (nb.age + t < 1) return null; }
  if (w >= 1 && radius === nb.radius) return nb;
  if (!nb._t) nb._t = Object.assign({}, nb, { base: nb });
  nb._t.lum = nb.lum * w * (nb.radius / radius) ** 2; nb._t.radius = radius; if (nb.age) nb._t.age = nb.age + t;
  return nb._t;
}
export let visibleNebulae = [];
export function drawNebulaeAndFx(nav, o) {
  visibleNebulae = [];
  if (!nav.galaxy || !nav.field || !o.camLocal) return;
  if (!pNeb) pNeb = new Program('nebula', FS_VS, NEB_FS);
  const list = nebulaeNear(nav.galaxy, o.camLocal, nav.field.dens).map(nebulaAt).filter(Boolean);
  if (o.extra) for (const nb of o.extra) list.push(nb);
  const gq = nav.galaxy.quat, vis = [];
  for (const nb of list) {
    const relL = V.sub(nb.pos, o.camLocal), d = V.len(relL);
    const px = nb.radius / Math.max(d, 1e-9) * o.pxPerRad;
    if (px < 1.5 && d > nb.radius) continue;
    // distant nebulae are seen through the galaxy's dust and are hard to pick out: fade them with distance
    if (d > 300 && !nb.far && !nb.name.match(/Orion|Lagoon|Carina|Ring|Crab|Veil/)) continue;
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
    pNeb.use().set({ uNoise3: o.noise3, uCamRot: o.camRot, uTanFov: o.tanFov, uCen: v.rel, uRad: nb.radius, uScale: GAL_I0 * nb.lum * mix(1, skyCfg.galBoost, clamp((14 - v.d / nb.radius) / 10, 0, 1)) * 0.25 * o.exposure, uDust: mix(0.15, 1, clamp((14 - v.d / nb.radius) / 10, 0, 1)), uSeed: nb.seed, uFrame: o.frame % 16, uType: nb.type, uColA: nb.colA, uColB: nb.colB });
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
export function beam(o, rel, axis, len, w0, w1, col, I, fall) {
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
      const toStar = V.sub(star.wpos, b.wpos), r = V.len(toStar) / C.AU; if (r > 6) continue;
      cometVolumes.push({ b, star, r });
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
    pCor.use().set({ uViewProj: o.viewProj, uFcoef: o.fcoef, uRel: s.rel, uSize: s.radius * 8, uR: s.radius, uExposure: o.exposure, uRad: 1.47e4 * vSurface(s.temp || 5772), uCol: [c[0] / y, c[1] / y, c[2] / y], uNoise3: o.noise3, uTime: o.time % 1e7, uSeed: (s.uid * 0.37) % 1, uRefrK: o.refrK || 0, uRefrUp: o.refrUp || [0, 1, 0] });
    gl.bindVertexArray(quad()); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  gl.disable(gl.DEPTH_TEST);
};

export function initExoticPrograms() {
  initCometProgram();
  if (!pBH) pBH = new Program('blackhole', FS_VS, BH_FS);
  if (!pBHN) pBHN = new Program('blackholes', FS_VS, BHN_FS);
  if (!pNeb) pNeb = new Program('nebula', FS_VS, NEB_FS);
  if (!pBeam) pBeam = new Program('beam', BEAM_VS, BEAM_FS);
  if (!pCor) pCor = new Program('corona', COR_VS, COR_FS);
}

// ---------------- comets: ray marched coma, dust tail and ion tail ----------------
const COMET_FS = `
in vec2 vUV; out vec4 o;
uniform sampler3D uNoise3; uniform mat3 uCamRot; uniform vec2 uTanFov;
uniform vec3 uNuc, uAway, uVel; uniform float uLen, uComa, uAct, uE, uExposure, uTime, uDepthMax, uFcoef;
uniform sampler2D uDepth;
float ign(vec2 p){ return fract(52.9829189*fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  vec3 rd = normalize(uCamRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  float dpt = texture(uDepth, vUV).r;
  float sceneT = dpt >= 0.99999 ? 1e30 : (exp2(dpt*2./uFcoef) - 1.)*length(vec3((vUV*2. - 1.)*uTanFov, -1.));
  // bounding sphere around nucleus and tails
  // (large enough for the curved dust tail; both tails fade to nothing well inside it, so bright comets show no cut-off)
  vec3 cen = uNuc + uAway*uLen*0.6; float R = uLen*1.15 + uComa*3.;
  float b = dot(-cen, rd), c = dot(cen, cen) - R*R, h = b*b - c;
  if (h < 0.) { o = vec4(0.); return; }
  h = sqrt(h); float t0 = max(-b - h, 0.), t1 = min(-b + h, sceneT);
  if (t1 <= t0) { o = vec4(0.); return; }
  const int N = 64; float dt = (t1 - t0)/float(N), jit = ign(gl_FragCoord.xy);
  vec3 side = normalize(cross(uAway, uVel));
  vec3 Ld = vec3(0.), Li = vec3(0.);
  for (int i = 0; i < N; i++) {
    vec3 p = rd*(t0 + (float(i) + jit)*dt) - uNuc;
    float x = dot(p, uAway);                                   // distance down the tail
    // coma: roughly 1/r^2 around the nucleus
    float rc = length(p)/uComa;
    float coma = 1./(1. + rc*rc)*exp(-rc*0.08);
    // ion tail: straight away from the star, narrow, with streamers
    vec3 pi = p - uAway*x; float wi = uComa*0.4 + max(x, 0.)*0.03;
    float st = 0.6 + 0.8*texture(uNoise3, vec3(x/uLen*3. - uTime*0.002, dot(pi, side)/wi*0.3, 0.37)).r;
    float ion = x > 0. ? exp(-dot(pi, pi)/(wi*wi))*exp(-x/(uLen*0.6))*st : 0.;
    // dust tail: lags behind along the orbit (curved), broad, fades smoothly
    float xd = max(x, 0.);
    vec3 pd = p - uAway*x + uVel*(xd*xd/uLen*0.35);
    float wd = uComa*0.6 + xd*0.12;
    float dust = x > -uComa ? exp(-dot(pd, pd)/(wd*wd))*exp(-xd/(uLen*0.35)) : 0.;
    float win = smoothstep(1.6*uLen, 0.7*uLen, x);
    Ld += vec3(1.0, 0.93, 0.8)*(dust*win + coma*2.5)*dt;
    Li += vec3(0.32, 0.55, 1.0)*ion*win*dt;
  }
  // surface brightness scales with activity and sunlight; dust scatters sunlight, ions fluoresce
  vec3 col = (Ld*uE*5e-10 + Li*uE*3e-10)*uAct/uComa;   // calibrated to Halley 1986: coma ~18, tail ~21 mag/arcsec^2
  o = vec4(min(col*uExposure, vec3(60000.)), 0.);
}`;
let pComet = null;
const cometVolumes = [];
export function initCometProgram() { if (!pComet) pComet = new Program('comet', FS_VS, COMET_FS); }
// called by the renderer after coronae; needs the scene depth
export function drawComets(sys, nav, o) {
  initCometProgram();
  for (const cv of cometVolumes.splice(0)) {
    const { b, star, r } = cv;
    const away = V.norm(V.sub(b.wpos, star.wpos));
    // (outgassing scales with the nucleus's surface: Hale-Bopp, ~60 km across, gave off ~15x Halley's gas)
    const size = clamp((b.radius / 5500) ** 2, 0.05, 30), act0 = Math.min(6, 1 / (r * r)) * star.lum, act = act0 * size;
    const grow = Math.min(1.7, Math.pow(size, 0.2)), len = 0.22 * C.AU * Math.sqrt(act0) * grow, coma = Math.min(2.5e8, 2e7 * Math.sqrt(act0) * grow);
    // orbital velocity direction from a tiny time step
    const sysT = b.system.time; b.system.update(sysT + 3600); const p2 = b.wpos.slice(); b.system.update(sysT);
    let vel = V.norm(V.sub(p2, b.wpos)); vel = V.norm(V.sub(vel, V.mul(away, V.dot(vel, away))));
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
    pComet.use().set({ uNoise3: o.noise3, uCamRot: o.camRot, uTanFov: o.tanFov, uNuc: b.rel, uAway: away, uVel: vel, uLen: len, uComa: coma, uAct: act,
      uE: star.lum / (r * r), uExposure: o.exposure, uTime: o.time % 1e6, uDepth: o.depth, uFcoef: o.fcoef });
    drawFS();
  }
}
