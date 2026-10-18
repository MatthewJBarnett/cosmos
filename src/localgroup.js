// The Milky Way - Andromeda collision as a restricted N-body simulation on the GPU.
// 2 x 65,536 star particles move in the time dependent potentials of both galaxies (halo + bulge + disk each),
// whose centres follow the orbit with dynamical friction from lgorbit.js. Integration is leapfrog (kick-drift-kick,
// time reversible) in ping-pong float textures. The Sun is a tracer particle integrated identically on the CPU.
// Units: kpc, Myr, solar masses. Frame: centre of mass of the pair, axes of the Milky Way at the present epoch.
import { gl, Program, tex2D, fbo, drawFS, FS_VS, texCube } from './gl.js';
import { V, Q, C, clamp } from './math.js';
import { GAL, G, KMS, centresAt, relAt, ORBIT, orbitEvents, lmcAt, LMC_ORBIT, sgrAt, SGR_ORBIT } from './lgorbit.js';
import { REAL_GALAXIES, MILKY_WAY } from './universe.js';
import { sunPos, YEAR, sunHook, popFade } from './galdyn.js';
import { CUBE_FACES } from './atmosphere.js';
import { GAL_I0, skyCfg } from './sky.js';

export const LG_START = 2600;          // Myr from now: the N-body takes over (the galaxies are still ~400 kpc apart)
export const MW_FADE = [3350, 3650];    // Myr: the Milky Way model hands over to particles as tides start to bite
export const LG_END = 12000;            // Myr: the merger remnant has settled; later times reuse this state
const NOW_TYR = 26.8;
// particle textures: 512 x 256 (131,072 particles); 256 x 256 on low quality (set before start-up)
export const lgCfg = { w: 512, h: 256 };
let SW = 512, SH = 256, NP = SW * SH, HALF = NP / 2;
const DT = 2.0;                         // Myr per step

export const M31 = REAL_GALAXIES.find(g => /M31/.test(g.name));
const M33 = REAL_GALAXIES.find(g => /M33/.test(g.name));
const M33_OFF = M33 ? V.sub(M33.posU, M31.posU) : null;
const LMC = REAL_GALAXIES.filter(g => /Magellanic/.test(g.name));
// (the SMC rides along with the LMC; positions move from the catalogue ones by the orbit's displacement)
const MC0 = LMC.map(g => g.posU.slice());
const SGR = REAL_GALAXIES.find(g => g.sgr), SGR0 = SGR ? SGR.posU.slice() : null;
// the Sagittarius dwarf's light: brighter when it fell in (~6 Gyr ago it had ~10x its present stars), gone in ~1 Gyr
export const sgrLum = (tMyr) => tMyr < 0 ? 1 + 4 * clamp(-tMyr / 5000, 0, 1) : clamp(1 - tMyr / 1000, 0, 1);
export const LMC_MERGE = LMC_ORBIT.merged > 0 ? LMC_ORBIT.merged : 2400;

// GLSL acceleration from both galaxies (must match accJS below)
const ACC = `
uniform vec3 uC0, uC1; uniform mat3 uR0, uR1;   // centres, disk frames (world -> disk local)
uniform vec4 uH0, uH1;   // halo: GMh/mnorm, rs, c-clamp, -
uniform vec4 uB0, uB1;   // bulge: GMb, ab ; disk: GMd, ad, bd in uD
uniform vec4 uD0, uD1;
vec3 accGal(vec3 p, vec3 c, mat3 R, vec4 H, vec4 B, vec4 D){
  vec3 r = p - c; float d = max(length(r), 0.05);
  float x = d/H.y; float mh = H.x*min(log(1. + x) - x/(1. + x), H.z);
  vec3 a = -r*(mh/(d*d*d));
  a += -r*(B.x/(d*(d + B.y)*(d + B.y)));
  vec3 l = R*r; float R2 = l.x*l.x + l.z*l.z; float zb = sqrt(l.y*l.y + D.z*D.z); float s = D.y + zb; float D3 = pow(R2 + s*s, 1.5);
  vec3 al = vec3(-D.x*l.x/D3, -D.x*l.y*s/(D3*zb), -D.x*l.z/D3);
  a += transpose(R)*al;
  return a;
}
vec3 accAll(vec3 p){ return accGal(p, uC0, uR0, uH0, uB0, uD0) + accGal(p, uC1, uR1, uH1, uB1, uD1); }`;
const STEP_FS = `in vec2 vUV; layout(location=0) out vec4 oP; layout(location=1) out vec4 oV;
uniform sampler2D uPos, uVel; uniform float uDt; uniform vec3 uC0b, uC1b;
${ACC}
void main(){
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, ij, 0), Vv = texelFetch(uVel, ij, 0);
  vec3 p = P.xyz, v = Vv.xyz;
  v += accAll(p)*(0.5*uDt);
  p += v*uDt;
  // second half kick with the centres at the end of the step (passed as uC0b, uC1b)
  vec3 a = accGal(p, uC0b, uR0, uH0, uB0, uD0) + accGal(p, uC1b, uR1, uH1, uB1, uD1);
  v += a*(0.5*uDt);
  oP = vec4(p, P.w); oV = vec4(v, Vv.w);
}`;
// particles as soft points (outside views) and into a sky cube (inside views)
const PART_VS = `uniform sampler2D uPos; uniform int uSW, uHalf; uniform mat4 uViewProj; uniform vec3 uCam; uniform float uExposure, uPxSA, uPxPerRad, uMaxPx, uNear;
uniform vec2 uLum; uniform vec2 uW; uniform float uBurst;
out vec3 vCol; out float vSig;
vec3 bb(float t){ return t < 5000. ? vec3(1.0, 0.72, 0.46) : t < 9000. ? vec3(1.0, 0.9, 0.78) : vec3(0.7, 0.82, 1.0); }
void main(){
  int i = gl_VertexID; ivec2 ij = ivec2(i % uSW, i / uSW);
  vec4 P = texelFetch(uPos, ij, 0);
  int gal = i < uHalf ? 0 : 1; float type = floor(P.w/10.), wgt = P.w - type*10.;
  vec3 rel = P.xyz - uCam; float d = length(rel);
  // luminosity per particle (L_sun) -> flux in solar constants: 1 kpc = 2.0626e8 AU
  float L = gal == 0 ? uLum.x : uLum.y; float w = gal == 0 ? uW.x : uW.y;
  // young stars brighten in the starbursts that follow each close passage
  // (young stars carry a larger share of the disk's blue light: x2, old disk stars x0.8, same total)
  float flux = L*wgt*(type > 1.5 ? 2.*uBurst : type > 0.5 ? 0.8 : 1.)/(d*d*4.2543e16)*w*smoothstep(uNear*0.4, uNear, d);
  float h = type < 0.5 ? 0.4 : 0.8;      // smoothing length (kpc), about the particle spacing
  float sig = clamp(h/d*uPxPerRad*0.5, 0.7, uMaxPx);
  float I = flux/uPxSA*uExposure;
  vSig = sig; vCol = (type < 0.5 ? vec3(1.0, 0.74, 0.48) : type < 1.5 ? vec3(1.0, 0.88, 0.76) : vec3(0.62, 0.78, 1.0))*min(I/(6.2832*sig*sig), 50.);
  gl_Position = uViewProj*vec4(rel, 1.); gl_Position.z = 0.;
  gl_PointSize = I/(6.2832*sig*sig) < 1e-4 ? 0. : ceil(sig*5.);
  if (gl_PointSize == 0.) gl_Position = vec4(2., 2., 2., 1.);
}`;
const PART_FS = `in vec3 vCol; in float vSig; out vec4 o;
void main(){ float sz = ceil(vSig*5.); vec2 d = (gl_PointCoord - 0.5)*sz; float g = exp(-dot(d, d)/(2.*vSig*vSig)); o = vec4(vCol*g, 1.); }`;
const CUBEDRAW_FS = `in vec2 vUV; out vec4 o; uniform samplerCube uCube; uniform mat3 uRot; uniform vec2 uTanFov; uniform float uScale;
void main(){ vec3 rd = uRot*vec3((vUV*2. - 1.)*uTanFov, -1.); o = vec4(texture(uCube, rd).rgb*uScale, 1.); }`;

function galUniforms(g, Rm) {
  return { H: [G * g.Mh / g.mnorm, g.rs, 1.25 * g.mnorm, 0], B: [G * g.Mb, g.ab, 0, 0], D: [G * g.Md, g.ad, g.bd, 0], R: Rm };
}
// world <-> disk local rotations: the Milky Way disk is the present x-z plane; M31's from its catalogued orientation
const R_MW = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const R_M31 = (() => { const m = Q.mat3(Q.conj(M31.quat)); return Array.from(m); })();
const U = [galUniforms(GAL.mw, R_MW), galUniforms(GAL.m31, R_M31)];

// the same acceleration on the CPU (double precision) for the Sun
function mat3mul(m, v) { return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]]; }
function mat3tmul(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }
function accGalJS(p, c, u) {
  const r = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], d = Math.max(Math.hypot(...r), 0.05);
  const x = d / u.H[1], mh = u.H[0] * Math.min(Math.log(1 + x) - x / (1 + x), u.H[2]);
  const k = -mh / (d * d * d) - u.B[0] / (d * (d + u.B[1]) ** 2);
  let a = r.map(v => v * k);
  const l = mat3mul(u.R, r), R2 = l[0] * l[0] + l[2] * l[2], zb = Math.sqrt(l[1] * l[1] + u.D[2] * u.D[2]), s = u.D[1] + zb, D3 = Math.pow(R2 + s * s, 1.5);
  const al = [-u.D[0] * l[0] / D3, -u.D[0] * l[1] * s / (D3 * zb), -u.D[0] * l[2] / D3];
  const aw = mat3tmul(u.R, al);
  return [a[0] + aw[0], a[1] + aw[1], a[2] + aw[2]];
}
function accJS(p, c0, c1) { const a = accGalJS(p, c0, U[0]), b = accGalJS(p, c1, U[1]); return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
// circular speed in a galaxy's disk plane at radius R (kpc/Myr), from its own potential
function vcirc(ui, Rr) { const a = accGalJS(mat3tmul(ui.R, [Rr, 0, 0]), [0, 0, 0], ui); const al = mat3mul(ui.R, a); return Math.sqrt(Math.max(-al[0] * Rr, 0)); }

function gauss(rnd) { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }

export class LocalGroup {
  constructor() { this.ready = false; this.t = null; this.cubeT = -1e9; this.active = false; }
  initGL() {
    if (this.pStep) return;
    SW = lgCfg.w; SH = lgCfg.h; NP = SW * SH; HALF = NP / 2;
    // (programs first so they compile in parallel with the others at start-up)
    this.pStep = new Program('lgstep', FS_VS, STEP_FS);
    this.pPart = new Program('lgparts', PART_VS, PART_FS);
    this.pCube = new Program('lgcube', FS_VS, CUBEDRAW_FS);
    const mk = () => tex2D(SW, SH, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
    this.pos = [mk(), mk()]; this.vel = [mk(), mk()];
    this.fb = [fbo([this.pos[0], this.vel[0]]), fbo([this.pos[1], this.vel[1]])];
    this.cur = 0;
    this.cube = texCube(256, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    this.cubeFB = []; for (let i = 0; i < 6; i++) this.cubeFB.push(fbo([this.cube], null, i));
    this.vao = gl.createVertexArray();
  }
  // initial conditions at LG_START: exponential disks and Hernquist bulges in equilibrium, around the orbiting centres
  reset() {
    this.initGL();
    const t0 = LG_START, c = centresAt(t0);
    const P = new Float32Array(NP * 4), Vv = new Float32Array(NP * 4);
    let seed = 1234567; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    [['mw', c.mw, c.vmw, U[0]], ['m31', c.m31, c.vm31, U[1]]].forEach(([k, cen, vcen, ui], gi) => {
      const g = GAL[k];
      for (let i = 0; i < HALF; i++) {
        const idx = gi * HALF + i;
        let pl, vl, type, wgt = 1;
        if (i < HALF * 0.22) {
          // bulge: Hernquist radii, isotropic Gaussian velocities from the local circular speed
          const u = Math.min(rnd(), 0.995), r = g.ab * Math.sqrt(u) / (1 - Math.sqrt(u));
          const ct = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, st = Math.sqrt(1 - ct * ct);
          pl = [r * st * Math.cos(ph), r * ct, r * st * Math.sin(ph)];
          const sg = vcirc(ui, Math.max(r, 0.1)) * 0.55;
          vl = [gauss(rnd) * sg, gauss(rnd) * sg, gauss(rnd) * sg];
          type = 0;
        } else {
          // disk: exponential surface density, sampled from a 1.6x wider exponential and weighted back (importance
          // sampling: more particles, each fainter, in the outskirts where tidal tails form; the light profile is unchanged)
          const u = rnd(); let lo = 0, hi = 12;
          for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (1 - (1 + m) * Math.exp(-m) < u) lo = m; else hi = m; }
          const R = Math.min(lo * g.Rd * 1.6, 40), ph = rnd() * 2 * Math.PI, z = gauss(rnd) * 0.25;
          wgt = 2.56 * Math.exp(-0.375 * R / g.Rd);
          pl = [R * Math.cos(ph), z, R * Math.sin(ph)];
          const vc = vcirc(ui, Math.max(R, 0.2)), sr = 22 * KMS * Math.exp(-R / (3 * g.Rd)) + 8 * KMS;
          // clockwise seen from the disk's north (like the Milky Way)
          vl = [-pl[2] / Math.max(R, 1e-3) * vc + gauss(rnd) * sr, gauss(rnd) * sr * 0.5, pl[0] / Math.max(R, 1e-3) * vc + gauss(rnd) * sr];
          type = rnd() < 0.18 ? 2 : 1;
        }
        const pw = mat3tmul(ui.R, pl), vw = mat3tmul(ui.R, vl);
        // w: type * 10 + luminosity weight
        P.set([cen[0] + pw[0], cen[1] + pw[1], cen[2] + pw[2], type * 10 + Math.min(wgt, 9.99)], idx * 4);
        Vv.set([vcen[0] + vw[0], vcen[1] + vw[1], vcen[2] + vw[2], gi], idx * 4);
      }
    });
    for (const k of [0, 1]) {
      gl.bindTexture(gl.TEXTURE_2D, this.pos[k]); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SW, SH, gl.RGBA, gl.FLOAT, P);
      gl.bindTexture(gl.TEXTURE_2D, this.vel[k]); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SW, SH, gl.RGBA, gl.FLOAT, Vv);
    }
    // the Sun, from its analytic orbit at the start (pc -> kpc, Milky Way centred -> centre of mass frame)
    const ty = NOW_TYR + t0 * 1e6, s0 = sunPos(ty), s1 = sunPos(ty + 1e5);
    this.sun = { x: [c.mw[0] + s0[0] / 1e3, c.mw[1] + s0[1] / 1e3, c.mw[2] + s0[2] / 1e3], v: [c.vmw[0] + (s1[0] - s0[0]) / 1e3 / 0.1, c.vmw[1] + (s1[1] - s0[1]) / 1e3 / 0.1, c.vmw[2] + (s1[2] - s0[2]) / 1e3 / 0.1] };
    this.t = t0; this.ready = true; this.cubeT = -1e9;
  }
  stepGPU(dt) {
    const c0 = centresAt(this.t), c1 = centresAt(this.t + dt), src = this.cur, dst = 1 - src;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[dst]); gl.viewport(0, 0, SW, SH);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    this.pStep.use().set({ uPos: this.pos[src], uVel: this.vel[src], uDt: dt, uC0: c0.mw, uC1: c0.m31, uC0b: c1.mw, uC1b: c1.m31,
      uR0: new Float32Array(U[0].R), uR1: new Float32Array(U[1].R), uH0: U[0].H, uH1: U[1].H, uB0: U[0].B, uB1: U[1].B, uD0: U[0].D, uD1: U[1].D });
    drawFS();
    this.cur = dst;
    // the Sun with the same leapfrog in double precision
    const s = this.sun; let a = accJS(s.x, c0.mw, c0.m31);
    for (let k = 0; k < 3; k++) s.v[k] += a[k] * dt / 2;
    for (let k = 0; k < 3; k++) s.x[k] += s.v[k] * dt;
    a = accJS(s.x, c1.mw, c1.m31);
    for (let k = 0; k < 3; k++) s.v[k] += a[k] * dt / 2;
    this.t += dt;
  }
  // bring the simulation to tMyr (from now), a bounded number of steps per call. Returns true when in sync.
  advance(tMyr, maxSteps = 24) {
    if (tMyr < LG_START) { this.active = false; return true; }
    this.active = true; this.tReal = tMyr;      // (the dynamics stop at LG_END; the stars keep ageing)
    tMyr = Math.min(tMyr, LG_END);
    if (!this.ready || (tMyr < this.t - 600 && this.t - LG_START > tMyr - LG_START + 600)) this.reset();
    let n = 0;
    while (Math.abs(tMyr - this.t) > DT * 0.5 && n < maxSteps) { this.stepGPU(tMyr > this.t ? DT : -DT); n++; }
    // sub-step remainder for smooth motion at slow rates is not needed: 2 Myr is ~1 s at 2 Myr/s
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.behind = Math.abs(tMyr - this.t) > DT;
    return !this.behind;
  }
  // star formation triggered by the tidal compression of each passage (peaks ~50 Myr after pericentre)
  burst(t) {
    if (!this._peris) this._peris = orbitEvents().pericentres.map(p => p.t);
    let b = 1; for (const tp of this._peris) b += 3 * Math.exp(-(((t - tp - 50) / 140) ** 2));
    return b;
  }
  // the Sun relative to the Milky Way centre (pc, inertial Milky Way axes)
  sunRel() { const c = centresAt(this.t); return [(this.sun.x[0] - c.mw[0]) * 1e3, (this.sun.x[1] - c.mw[1]) * 1e3, (this.sun.x[2] - c.mw[2]) * 1e3]; }
  // draw particles as points; camCOM: camera in the centre of mass frame (kpc)
  drawPoints(camCOM, viewProj, o, wMW, wM31, nearKpc) {
    if (!this.ready) return;
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
    this.pPart.use().set({ uPos: this.pos[this.cur], uSW: SW, uHalf: HALF, uViewProj: viewProj, uCam: camCOM, uExposure: o.exposure * (o.boost || 1), uPxSA: o.pxSA, uPxPerRad: o.pxPerRad, uMaxPx: o.maxPx || 6,
      uLum: [GAL.mw.L / HALF * popFade(NOW_TYR + (this.tReal || this.t) * 1e6), GAL.m31.L / HALF * popFade(NOW_TYR + (this.tReal || this.t) * 1e6)], uW: [wMW, wM31], uNear: nearKpc || 0.5, uBurst: this.burst(this.t) });
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.POINTS, 0, NP);
  }
  // sky seen from inside: particles splatted into a cube map around the camera, refreshed as time moves on
  updateCube(camCOM, wMW, wM31) {
    // galaxies are drawn ~20 times brighter than life so they stand out; once the Sun sits inside the merged galaxy that
    // would turn the whole sky into a bright fog, so the boost eases off to a nearly real surface brightness
    if (this._merged === undefined) this._merged = orbitEvents().merged || Infinity;
    const boost = skyCfg.galBoost * (1 - 0.85 * Math.min(1, Math.max(0, ((this.tReal || this.t) - this._merged) / 800)));
    if (!this.ready) return;
    if (Math.abs(this.t - this.cubeT) < 1.5 && this.cubeCam && V.dist(camCOM, this.cubeCam) < 0.3 && Math.abs(wMW - this.cubeW) < 0.05) return;
    this.cubeT = this.t; this.cubeCam = camCOM.slice(); this.cubeW = wMW;
    // a guard band around each face lets sprites centred just outside it spill in (no seams between faces)
    const GB = 32, k = (256 + 2 * GB) / 256;
    for (let f = 0; f < 6; f++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.cubeFB[f]); gl.viewport(0, 0, 256, 256);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(-GB, -GB, 256 + 2 * GB, 256 + 2 * GB);
      // seen from inside, both galaxies are diffuse glow across the sky: the same visibility boost as the Milky Way band
      this.drawPoints(camCOM, cubeViewProj(CUBE_FACES[f], k), { exposure: 1e10, pxSA: 1 / (128 * 128), pxPerRad: 128, maxPx: 26 }, wMW * boost, wM31 * boost, 2.5);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  drawCube(rotWorldFromView, tanFov, exposure) {
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
    this.pCube.use().set({ uCube: this.cube, uRot: rotWorldFromView, uTanFov: tanFov, uScale: exposure / 1e10 });
    drawFS();
  }
}
// view-projection for rendering a cube face: CUBE_FACES[f] maps face (u, v, 1) to a world direction (column major mat3)
function cubeViewProj(m, k = 1) {
  // rows of the inverse (orthonormal: transpose) take world directions to face coordinates (x right, y up, z forward)
  const r = [m[0], m[1], m[2]], u = [m[3], m[4], m[5]], f = [m[6], m[7], m[8]];
  // clip: x = dot(r,p), y = dot(u,p), w = dot(f,p); z = 0 (depth unused)
  return new Float32Array([r[0] / k, u[0] / k, 0, f[0], r[1] / k, u[1] / k, 0, f[1], r[2] / k, u[2] / k, 0, f[2], 0, 0, 0, 0]);
}

// ---- time-dependent positions of Local Group galaxies (universe frame, Mpc, Milky Way centre at the origin) ----
let lastLmcT = 0;
export function updateLocalGroupPositions(tyr) {
  const tMyr = (tyr - NOW_TYR) / 1e6;
  // (before the present relAt runs the timing-argument orbit backwards: apart, turnaround, back to the Big Bang)
  const r = relAt(tMyr).r;
  const p = r.map(x => x * 1e-3);
  const moved = V.dist(p, M31.posU) > 1e-5;
  M31.posU = p;
  if (M33 && M33_OFF) M33.posU = V.add(p, M33_OFF);
  // the Magellanic Clouds on their orbit
  const lm = lmcAt(tMyr), l0 = LMC_ORBIT.r0, dl = [(lm[0] - l0[0]) * 1e-3, (lm[1] - l0[1]) * 1e-3, (lm[2] - l0[2]) * 1e-3];
  const sink = clamp(1 - (tMyr - LMC_MERGE + 300) / 300, 0, 1);      // (the SMC is torn apart and falls in with it)
  LMC.forEach((g, i) => { const q = V.add(MC0[i], dl); g.posU = i ? V.add(LMC[0].posU, V.mul(V.sub(MC0[i], MC0[0]), sink)) : q; });
  if (SGR) { const sg = sgrAt(tMyr), s0 = SGR_ORBIT.r0; SGR.posU = V.add(SGR0, [(sg[0] - s0[0]) * 1e-3, (sg[1] - s0[1]) * 1e-3, (sg[2] - s0[2]) * 1e-3]); SGR.lum = 0.04 * sgrLum(tMyr); }
  const lmcMoved = Math.abs(tMyr - lastLmcT) > 0.5; if (lmcMoved) lastLmcT = tMyr;
  return moved || lmcMoved;
}
export const LG = new LocalGroup();
// after the N-body takes over, the Sun's galactic position comes from its tracer particle
sunHook.t0 = NOW_TYR + LG_START * 1e6;
sunHook.fn = (ty) => LG.ready && LG.active && Math.abs(Math.min(ty, NOW_TYR + LG_END * 1e6) - (NOW_TYR + LG.t * 1e6)) < 5e6 ? LG.sunRel() : null;
// weights: how much of each galaxy is drawn by the regular renderer (1) vs by particles (0)
export function lgWeights(tyr) {
  const t = (tyr - NOW_TYR) / 1e6;
  const m31 = clamp(1 - (t - LG_START) / 250, 0, 1);
  const mw = clamp(1 - (t - MW_FADE[0]) / (MW_FADE[1] - MW_FADE[0]), 0, 1);
  const lmc = clamp(1 - (t - LMC_MERGE + 100) / 200, 0, 1);
  return { m31, mw, lmc, sgr: sgrLum(t), tMyr: t };
}
export function initLocalGroupPrograms() { LG.initGL(); }
