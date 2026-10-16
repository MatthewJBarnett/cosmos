// Frame pipeline: HDR scene (sky, stars, system bodies, atmospheres) then bloom, exposure and tone mapping.
import { gl, Program, tex2D, fbo, drawFS, FS_VS, AsyncRead, GpuTimer } from './gl.js';
import { V, Q, M4, C, clamp } from './math.js';
import { RNG } from './rng.js';
import { bbColor } from './stars.js';
import { drawPlanet, planetHousekeeping, planetState, pendingBakes, LOGDEPTH_VS, LOGDEPTH_FS, LIGHT_UNIFORMS } from './planet.js';
import { getAtmoLUT, drawAtmosphere, cloudRotInv, getDummyCube, VolumetricTAA } from './atmosphere.js';
import { drawStars, drawPoints, drawGalaxies, GalaxySky, skyCfg, drawConstellations, drawSkyMap } from './sky.js';
import { catalog } from './assets.js';
import { MILKY_WAY, SUN_POS } from './universe.js';
import { drawRings, drawOrbits, drawBelts, drawRingParticles } from './extras.js';
import { drawBlackHole, drawNebulaeAndFx } from './exotic.js';

export const rcfg = { scale: 1, bloom: 0.04, exposureBias: 0, autoExposure: true, manualExposure: 1, clouds: true, orbits: true, maxExposure: 1.4e7, minExposure: 1e-8, fxaa: true, flare: false, volTAA: true, constellations: false, taa: true, realSky: true };
const FAR = 1e15;

const DOWN_FS = `in vec2 vUV; out vec4 o; uniform sampler2D uTex; uniform vec2 uTexel;
void main(){
  vec3 a = texture(uTex, vUV + uTexel*vec2(-1,-1)).rgb, b = texture(uTex, vUV + uTexel*vec2(1,-1)).rgb, c = texture(uTex, vUV + uTexel*vec2(-1,1)).rgb, d = texture(uTex, vUV + uTexel*vec2(1,1)).rgb;
  vec3 e = texture(uTex, vUV).rgb;
  vec3 f = texture(uTex, vUV + uTexel*vec2(-2,0)).rgb, g = texture(uTex, vUV + uTexel*vec2(2,0)).rgb, h = texture(uTex, vUV + uTexel*vec2(0,-2)).rgb, i = texture(uTex, vUV + uTexel*vec2(0,2)).rgb;
  vec3 j = texture(uTex, vUV + uTexel*vec2(-2,-2)).rgb, k = texture(uTex, vUV + uTexel*vec2(2,-2)).rgb, l = texture(uTex, vUV + uTexel*vec2(-2,2)).rgb, m = texture(uTex, vUV + uTexel*vec2(2,2)).rgb;
  vec3 s = (a + b + c + d)*0.125 + e*0.125 + (f + g + h + i)*0.0625 + (j + k + l + m)*0.03125;
  if (any(isnan(s)) || any(isinf(s))) s = vec3(0.);
  o = vec4(clamp(s, 0., 60000.), 1.);
}`;
const UP_FS = `in vec2 vUV; out vec4 o; uniform sampler2D uTex, uBase; uniform vec2 uTexel; uniform float uMix;
void main(){
  vec3 s = texture(uTex, vUV).rgb*4.;
  s += (texture(uTex, vUV + uTexel*vec2(-1,0)).rgb + texture(uTex, vUV + uTexel*vec2(1,0)).rgb + texture(uTex, vUV + uTexel*vec2(0,-1)).rgb + texture(uTex, vUV + uTexel*vec2(0,1)).rgb)*2.;
  s += texture(uTex, vUV + uTexel*vec2(-1,-1)).rgb + texture(uTex, vUV + uTexel*vec2(1,-1)).rgb + texture(uTex, vUV + uTexel*vec2(-1,1)).rgb + texture(uTex, vUV + uTexel*vec2(1,1)).rgb;
  o = vec4(mix(texture(uBase, vUV).rgb, s/16., uMix), 1.);
}`;
const TONE_FS = `in vec2 vUV; out vec4 o; uniform sampler2D uHDR, uBloom; uniform float uBloomAmt, uFrame, uGhost; uniform vec2 uRes;
vec3 aces(vec3 c){
  const mat3 A = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 B = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = A*c; vec3 a = c*(c + 0.0245786) - 0.000090537; vec3 b = c*(0.983729*c + 0.4329510) + 0.238081;
  return clamp(B*(a/b), 0., 1.);
}
float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
void main(){
  vec3 hdr = texture(uHDR, vUV).rgb, bl = texture(uBloom, vUV).rgb;
  if (any(isnan(hdr)) || any(isinf(hdr))) hdr = vec3(0.);
  if (any(isnan(bl)) || any(isinf(bl))) bl = vec3(0.);
  vec3 c = mix(hdr, bl, uBloomAmt);
  // lens ghosts from very bright sources (sun in frame)
  vec2 gv = vec2(0.5) - vUV;
  vec3 gh = vec3(0.);
  gh += max(texture(uBloom, vec2(0.5) + gv*0.6).rgb - 6., 0.)*vec3(0.9, 0.6, 0.3);
  gh += max(texture(uBloom, vec2(0.5) + gv*1.4).rgb - 6., 0.)*vec3(0.3, 0.6, 0.9)*0.7;
  gh += max(texture(uBloom, vec2(0.5) - gv*0.35).rgb - 6., 0.)*vec3(0.5, 0.9, 0.5)*0.5;
  c += gh*uGhost*smoothstep(0.75, 0.2, length(gv));
  // subtle vignette
  vec2 q = vUV - 0.5; c *= 1. - dot(q, q)*0.35;
  c = aces(c*1.25);
  c = pow(c, vec3(1./2.2));
  float n = hash(gl_FragCoord.xy + uFrame*17.) + hash(gl_FragCoord.yx*1.3 + uFrame*7.) - 1.;
  o = vec4(c + n/255., 1.);
}`;
const FXAA_FS = `in vec2 vUV; out vec4 o; uniform sampler2D uTex; uniform vec2 uTexel;
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 m = texture(uTex, vUV).rgb;
  float lM = lum(m), lN = lum(texture(uTex, vUV + vec2(0, uTexel.y)).rgb), lS = lum(texture(uTex, vUV - vec2(0, uTexel.y)).rgb), lE = lum(texture(uTex, vUV + vec2(uTexel.x, 0)).rgb), lW = lum(texture(uTex, vUV - vec2(uTexel.x, 0)).rgb);
  float mn = min(lM, min(min(lN, lS), min(lE, lW))), mx = max(lM, max(max(lN, lS), max(lE, lW)));
  float range = mx - mn;
  if (range < max(0.04, mx*0.14)) { o = vec4(m, 1.); return; }
  float lNW = lum(texture(uTex, vUV + uTexel*vec2(-1, 1)).rgb), lNE = lum(texture(uTex, vUV + uTexel*vec2(1, 1)).rgb), lSW = lum(texture(uTex, vUV + uTexel*vec2(-1, -1)).rgb), lSE = lum(texture(uTex, vUV + uTexel*vec2(1, -1)).rgb);
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float red = max((lNW + lNE + lSW + lSE)*0.03125, 1./128.);
  dir = clamp(dir/(min(abs(dir.x), abs(dir.y)) + red), -8., 8.)*uTexel;
  vec3 a = 0.5*(texture(uTex, vUV + dir*(1./3. - 0.5)).rgb + texture(uTex, vUV + dir*(2./3. - 0.5)).rgb);
  vec3 b = a*0.5 + 0.25*(texture(uTex, vUV - dir*0.5).rgb + texture(uTex, vUV + dir*0.5).rgb);
  float lB = lum(b);
  o = vec4((lB < mn || lB > mx) ? a : b, 1.);
}`;

const TAA_FS = `in vec2 vUV; out vec4 o;
uniform sampler2D uCur, uHist, uDepth;
uniform vec2 uTexel, uTanFov, uPrevTanFov, uJit;
uniform mat3 uCamRot, uPrevInvSky, uBodyInv, uPrevInvBody;
uniform vec3 uCamB, uPrevCamB;
uniform float uFcoef, uValid, uHasBody;
vec3 toY(vec3 c){ return vec3(0.25*c.r + 0.5*c.g + 0.25*c.b, 0.5*c.r - 0.5*c.b, -0.25*c.r + 0.5*c.g - 0.25*c.b); }
vec3 fromY(vec3 y){ return vec3(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z); }
vec3 tm(vec3 c){ return c/(1. + max(c.r, max(c.g, c.b))); }
vec3 itm(vec3 c){ return c/max(1. - max(c.r, max(c.g, c.b)), 1e-4); }
void main(){
  vec3 cur = tm(texture(uCur, vUV).rgb);
  vec3 mn = vec3(1e9), mx = vec3(-1e9), m1 = vec3(0.), m2 = vec3(0.);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 c = toY(tm(texture(uCur, vUV + vec2(x, y)*uTexel).rgb));
    mn = min(mn, c); mx = max(mx, c); m1 += c; m2 += c*c;
  }
  m1 /= 9.; m2 /= 9.;
  vec3 sd = sqrt(max(m2 - m1*m1, 0.));
  mn = max(mn, m1 - 1.25*sd); mx = min(mx, m1 + 1.25*sd);
  if (uValid < 0.5) { o = vec4(itm(cur), 1.); return; }
  vec2 uv = vUV - uJit;
  vec3 rdc = vec3((uv*2. - 1.)*uTanFov, -1.);
  float d = texture(uDepth, vUV).r;
  vec3 rd = uCamRot*rdc;            // not normalised: z = -1 in view space
  vec3 pv;
  if (d < 0.99999 && uHasBody > 0.5) {
    float w = exp2(d*2./uFcoef) - 1.;
    vec3 Pb = uBodyInv*(rd*w) + uCamB;          // point in the body-fixed frame
    pv = uPrevInvBody*(Pb - uPrevCamB);
  } else pv = uPrevInvSky*rd;
  if (pv.z >= 0.) { o = vec4(itm(cur), 1.); return; }
  vec2 puv = (pv.xy/(-pv.z)/uPrevTanFov)*0.5 + 0.5;
  if (any(lessThan(puv, vec2(0.))) || any(greaterThan(puv, vec2(1.)))) { o = vec4(itm(cur), 1.); return; }
  // bicubic (Catmull-Rom, 5 taps) history fetch keeps it sharp
  vec2 sz = 1./uTexel, sp = puv*sz, tp = floor(sp - 0.5) + 0.5, f = sp - tp;
  vec2 w0 = f*(-0.5 + f*(1. - 0.5*f)), w1 = 1. + f*f*(-2.5 + 1.5*f), w2 = f*(0.5 + f*(2. - 1.5*f)), w3 = f*f*(-0.5 + 0.5*f);
  vec2 w12 = w1 + w2, tc0 = (tp - 1.)*uTexel, tc3 = (tp + 2.)*uTexel, tc12 = (tp + w2/w12)*uTexel;
  vec3 h = texture(uHist, vec2(tc12.x, tc0.y)).rgb*(w12.x*w0.y) + texture(uHist, vec2(tc0.x, tc12.y)).rgb*(w0.x*w12.y)
         + texture(uHist, tc12).rgb*(w12.x*w12.y) + texture(uHist, vec2(tc3.x, tc12.y)).rgb*(w3.x*w12.y) + texture(uHist, vec2(tc12.x, tc3.y)).rgb*(w12.x*w3.y);
  float ws = w12.x*w0.y + w0.x*w12.y + w12.x*w12.y + w3.x*w12.y + w12.x*w3.y;
  h = max(h/ws, 0.);
  vec3 hy = clamp(toY(tm(h)), mn, mx);
  float motion = length((puv - vUV)/uTexel);
  float a = mix(0.08, 0.35, clamp(motion/12., 0., 1.));
  vec3 r = fromY(mix(hy, toY(cur), a));
  if (any(isnan(r))) r = cur;
  o = vec4(itm(clamp(r, 0., 0.9999)), 1.);
}`;
const COPY_FS = `in vec2 vUV; out vec4 o; uniform sampler2D uTex; void main(){ o = texture(uTex, vUV); }`;

export function makeNoise3D() {
  const N = 64, data = new Uint8Array(N * N * N * 4), rng = new RNG(12345);
  const lat = (P) => { const a = new Float32Array(P * P * P * 4); for (let i = 0; i < a.length; i++) a[i] = rng.f(); return a; };
  const l1 = lat(16), l2 = lat(32), l3 = lat(64);
  const samp = (l, P, x, y, z, c) => {
    const s = P / N; let fx = x * s, fy = y * s, fz = z * s; const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    fx -= ix; fy -= iy; fz -= iz; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const g = (a, b, d) => l[((((iz + d) % P) * P + ((iy + b) % P)) * P + ((ix + a) % P)) * 4 + c];
    const m = (a, b, t) => a + (b - a) * t;
    return m(m(m(g(0, 0, 0), g(1, 0, 0), fx), m(g(0, 1, 0), g(1, 1, 0), fx), fy), m(m(g(0, 0, 1), g(1, 0, 1), fx), m(g(0, 1, 1), g(1, 1, 1), fx), fy), fz);
  };
  let k = 0;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) for (let c = 0; c < 4; c++) {
    const v = samp(l1, 16, x, y, z, c) * 0.55 + samp(l2, 32, x, y, z, c) * 0.3 + l3[((z * N + y) * N + x) * 4 + c] * 0.15;
    data[k++] = clamp(Math.round((v - 0.5) * 1.5 * 255 + 127.5), 0, 255);
  }
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_3D);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  return t;
}

// label of the pass that starts after each marker
const NEXT = { bake: 'setup', pre: 'galaxies', galaxies: 'galaxy sky', galsky: 'stars', stars: 'nebulae + planets', planets: 'rings, points', 'rings+pts': 'atmosphere', atmo: 'orbits, black holes', 'orbits+bh': 'temporal AA', taa: 'post', post: 'end' };
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.pDown = new Program('down', FS_VS, DOWN_FS); this.pUp = new Program('up', FS_VS, UP_FS); this.pTone = new Program('tone', FS_VS, TONE_FS); this.pCopy = new Program('copy', FS_VS, COPY_FS); this.pFxaa = new Program('fxaa', FS_VS, FXAA_FS); this.pTAA = new Program('taa', FS_VS, TAA_FS); this.taaIdx = 0; this.taaValid = false;
    this.noise3 = makeNoise3D();
    this.galSky = new GalaxySky();
    this.volTAA = new VolumetricTAA(); this.prevCam = null;
    this.exposure = 1; this.frameNo = 0; this.meter = new Float32Array(64 * 36 * 4);
    this.meterTex = tex2D(64, 36, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR); this.meterFBO = fbo([this.meterTex]);
    this.w = 0; this.h = 0; this.stats = {};
    this.sync = false;   // when true, wait for all generation each frame (used for screenshots)
  }
  resize() {
    const w = Math.max(16, Math.floor(this.canvas.clientWidth * rcfg.scale)), h = Math.max(16, Math.floor(this.canvas.clientHeight * rcfg.scale));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h;
    const del = (t) => t && gl.deleteTexture(t);
    del(this.hdrTex); del(this.depthTex); del(this.copyTex); del(this.ldrTex); if (this.taaTex) this.taaTex.forEach(del);
    this.taaTex = [0, 1].map(() => tex2D(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR)); this.taaFBO = this.taaTex.map(t => fbo([t])); this.taaValid = false;
    this.hdrTex = tex2D(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    this.copyTex = tex2D(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    this.depthTex = tex2D(w, h, gl.DEPTH_COMPONENT32F, gl.DEPTH_COMPONENT, gl.FLOAT, gl.NEAREST);
    this.ldrTex = tex2D(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.hdrFBO = fbo([this.hdrTex], this.depthTex); this.hdrNoDepth = fbo([this.hdrTex]); this.copyFBO = fbo([this.copyTex]); this.ldrFBO = fbo([this.ldrTex]);
    if (this.mips) this.mips.forEach(m => { gl.deleteTexture(m.t); gl.deleteTexture(m.u); });
    this.mips = [];
    let mw = w, mh = h;
    for (let i = 0; i < 8; i++) {
      mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
      const t = tex2D(mw, mh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR), u = tex2D(mw, mh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
      this.mips.push({ w: mw, h: mh, t, u, f: fbo([t]), fu: fbo([u]) });
      if (mw <= 4 || mh <= 4) break;
    }
  }

  // nav: navigation state (camera + world)
  render(nav, dt) {
    this.resize(); this.frameNo++;
    const w = this.w, h = this.h, aspect = w / h;
    const fov = nav.fov, tanY = Math.tan(fov / 2), tanX = tanY * aspect;
    const pxPerRad = h / (2 * tanY), pxSA = 1 / (pxPerRad * pxPerRad);
    const view = M4.viewFromQuat(nav.q), proj = M4.persp(fov, aspect, 0.1, 1000);
    // sub-pixel jitter (Halton 2,3) for temporal anti-aliasing
    const useTAA = rcfg.taa && !this.sync;
    const hal = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
    const jx = useTAA ? hal(this.frameNo % 8 + 1, 2) - 0.5 : 0, jy = useTAA ? hal(this.frameNo % 8 + 1, 3) - 0.5 : 0;
    proj[8] -= jx * 2 / w; proj[9] -= jy * 2 / h;
    const viewProj = M4.mul(proj, view);
    const camRot = Q.mat3(nav.q);
    const fcoef = 2 / Math.log2(FAR + 1);
    const exposure = this.exposure;
    const pixScale = Math.max(1, h / 1080);
    const invQ = Q.conj(nav.q);
    const sphereVisible = (c, r) => {
      const v = Q.rot(invQ, c); const z = -v[2];
      if (z < -r) return false;
      const sx = Math.sqrt(1 + tanX * tanX), sy = Math.sqrt(1 + tanY * tanY);
      if (Math.abs(v[0]) > z * tanX + r * sx) return false;
      if (Math.abs(v[1]) > z * tanY + r * sy) return false;
      return true;
    };
    const project = (rel) => { const v = Q.rot(invQ, rel); if (v[2] >= 0) return null; return [(v[0] / (-v[2] * tanX) * 0.5 + 0.5), (1 - (v[1] / (-v[2] * tanY) * 0.5 + 0.5)), -v[2]]; };
    this.project = project; this.pxPerRad = pxPerRad;
    const common = { exposure, pxSA, pixScale, pxPerRad, noise3: this.noise3, sync: this.sync };

    const prof = rcfg.prof ? [] : null; let pt = performance.now();
    const gt = rcfg.gpuTimes ? (this.gpuTimer || (this.gpuTimer = new GpuTimer())) : null;
    if (gt) { gt.poll(); gt.begin('bake'); }
    const T = (n) => { if (gt) gt.begin(NEXT[n] || n); if (prof) { const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING); gl.bindFramebuffer(gl.FRAMEBUFFER, this.meterFBO); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4)); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); const t = performance.now(); prof.push(n + ':' + (t - pt).toFixed(0)); pt = t; } };
    planetHousekeeping(); T('bake');

    // ---- pre-pass work that needs its own framebuffers ----
    const gal = nav.galaxy;
    let camLocal = null, insideGal = false, viewProjLocal = null;
    if (gal) {
      camLocal = nav.camLocal();
      const cn = V.mul(camLocal, 1 / gal.radius);
      insideGal = V.len(cn) < 1.12;
      // near the Sun the photographed sky replaces the model entirely, so the cube needs no updates
      const fullyReal = gal === MILKY_WAY && rcfg.realSky && V.dist(camLocal, SUN_POS) < 150 && this.galSky.valid;
      if (insideGal && !fullyReal) this.galSky.update(gal, cn, this.noise3, this.sync);
      // galaxy local -> view
      const gq = gal.quat, r3 = Q.mat3(gq), m = new Float32Array(16);
      m[0] = r3[0]; m[1] = r3[1]; m[2] = r3[2]; m[4] = r3[3]; m[5] = r3[4]; m[6] = r3[5]; m[8] = r3[6]; m[9] = r3[7]; m[10] = r3[8]; m[15] = 1;
      viewProjLocal = M4.mul(viewProj, m);
    }
    const sys = nav.system;
    const drawList = [];
    const lights = [];
    if (sys) {
      for (const s of sys.stars) {
        const rel = V.sub(s.wpos, nav.S);
        lights.push({ body: s, rel, color: s.blackHole ? [1, 0.8, 0.6] : bbColor(s.temp), lum: s.blackHole ? (s.accretion || 0) * 0.02 : s.lum });
      }
      for (const b of sys.bodies) {
        if (b.kind === 'barycenter') continue;
        const rel = V.sub(b.wpos, nav.S), dist = V.len(rel);
        b.rel = rel; b.dist = dist; b.pxRadius = b.radius / dist * pxPerRad;
        if (b.atmo && b.pxRadius > 2 && b.surface) getAtmoLUT(b);   // make sure LUTs exist before the main pass
        drawList.push(b);
      }
      drawList.sort((a, b) => b.dist - a.dist);
    }

    T('pre');
    // ---- scene ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFBO);
    gl.viewport(0, 0, w, h);
    gl.depthMask(true); gl.clearColor(0, 0, 0, 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.depthMask(false);
    // galaxies
    const realSkyNear = gal === MILKY_WAY && rcfg.realSky && camLocal && V.dist(camLocal, SUN_POS) < 300;
    // galaxies are far too faint to register unless the eye/camera is dark adapted: skip the whole pass otherwise
    if (exposure > 2e4) drawGalaxies(nav.camU(), viewProj, Object.assign({ skip: insideGal && this.galSky.valid ? gal : null, realSkyNear }, common));
    T('galaxies');
    if (gal && insideGal) {
      // view direction -> galaxy local
      const rl = Q.mat3(Q.mul(Q.conj(gal.quat), nav.q));
      // near the Sun the real (photographed) Milky Way replaces the model, fading out over a few hundred parsecs
      let wReal = 0;
      if (gal === MILKY_WAY && rcfg.realSky) wReal = clamp(1 - (V.dist(camLocal, SUN_POS) - 150) / 350, 0, 1);
      const drewReal = wReal > 0 && drawSkyMap(rl, [tanX, tanY], exposure, wReal);
      this.galSky.draw(rl, [tanX, tanY], exposure, drewReal ? 1 - wReal : 1);
    }
    T('galsky');
    let nStars = 0;
    if (gal && nav.field) {
      const hide = sys ? sys.posLocal : null;
      // twinkling only for an observer under an atmosphere
      let twinkle = 0, upLocal = null;
      const an = nav.anchor;
      if (an && an.atmo && nav.altitude < an.atmo.hR * 2 && an.atmo.P > 3e4) { twinkle = 1; upLocal = Q.rot(Q.conj(gal.quat), V.norm(V.sub(nav.S, an.wpos))); }
      nStars = drawStars(nav.field, camLocal, viewProjLocal, Object.assign({ hide, twinkle, upLocal }, common));
    }
    T('stars');
    if (rcfg.constellations && gal === MILKY_WAY && camLocal) {
      const ds = V.dist(camLocal, SUN_POS);
      drawConstellations(catalog, SUN_POS, camLocal, viewProjLocal, 0.35 * clamp(1 - ds / 300, 0, 1));
    }
    drawNebulaeAndFx(nav, { viewProj, viewProjLocal, camLocal, camRot, tanFov: [tanX, tanY], exposure, noise3: this.noise3, time: nav.time, frame: this.frameNo, pxPerRad });

    // system bodies
    const atmoPasses = [], blackHoles = [];
    if (sys) {
      const points = [];
      const lightFor = (b) => {
        // irradiance from each star at body b, in solar constants
        const L = lights.filter(l => l.body !== b && l.lum > 0).map(l => {
          const d = V.dist(l.body.wpos, b.wpos) / C.AU; const E = l.lum / (d * d);
          const c = l.color, y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          return { rel: l.rel, rad: l.body.radius, col: [c[0] / y * E, c[1] / y * E, c[2] / y * E], E, body: l.body };
        }).sort((a, c) => c.E - a.E);
        // planetshine: sunlight reflected by a nearby large body (earthshine on the Moon, moonlight on Earth)
        if (b.kind !== 'star' && L.length && !rcfg.noShine) {
          const sun = L[0];
          const cands = [];
          if (b.parent && b.parent.kind !== 'star' && b.parent.kind !== 'barycenter') cands.push(b.parent);
          for (const ch of b.children) if (ch.radius > 2e5) cands.push(ch);
          for (const o of cands) {
            const dOB = V.dist(o.wpos, b.wpos), dS = V.dist(sun.body.wpos, o.wpos) / C.AU;
            const toS = V.norm(V.sub(sun.body.wpos, o.wpos)), toB = V.norm(V.sub(b.wpos, o.wpos));
            const al = Math.acos(clamp(V.dot(toS, toB), -1, 1));
            const ph = (Math.sin(al) + (Math.PI - al) * Math.cos(al)) / Math.PI;
            const E = (o.albedo || 0.2) * 0.67 * ph * (sun.body.lum / (dS * dS)) * (o.radius / dOB) ** 2;
            if (E < 1e-7) continue;
            const tint = bodyTint(o), c = sun.col, k = E / sun.E;
            L.push({ rel: o.rel || V.sub(o.wpos, nav.S), rad: o.radius, col: [c[0] * k * tint[0], c[1] * k * tint[1], c[2] * k * tint[2]], E, body: o, shine: true });
          }
        }
        return L.slice(0, 3);
      };
      const lightUniforms = (b, L) => {
        const lp = new Float32Array(9), lc = new Float32Array(9), lr = new Float32Array(3);
        L.forEach((l, i) => { lp.set(l.rel, i * 3); lc.set(l.col, i * 3); lr[i] = l.rad; });
        // occluders: other bodies that can cast eclipses on b
        const occ = [];
        for (const o of sys.bodies) {
          if (o === b || o.kind === 'star' || o.kind === 'barycenter' || !o.radius) continue;
          const d = V.dist(o.wpos, b.wpos); const ang = o.radius / d;
          if (ang <= 2e-4) continue;
          // only keep occluders that can actually shadow some part of b from one of its lights right now
          const toO = V.mul(V.sub(o.wpos, b.wpos), 1 / d);
          let can = false;
          for (const l of L) {
            const dl = V.dist(l.body.wpos, b.wpos); if (d > dl) continue;
            const sep = Math.acos(clamp(V.dot(toO, V.mul(V.sub(l.body.wpos, b.wpos), 1 / dl)), -1, 1));
            if (sep < ang + l.body.radius / dl + 1.2 * b.radius / d) { can = true; break; }
          }
          if (can) occ.push({ o, ang });
        }
        occ.sort((x, y) => y.ang - x.ang);
        const ou = new Float32Array(24); const no = Math.min(occ.length, 6);
        for (let i = 0; i < no; i++) { const o = occ[i].o; ou.set(V.sub(o.wpos, nav.S), i * 4); ou[i * 4 + 3] = o.radius; }
        const u = { uNumLights: L.length, uLightPos: lp, uLightCol: lc, uLightRad: lr, uNumOcc: no, uOcc: ou, uPlanetRel: b.rel, uHasRings: 0, uRingN: [0, 1, 0], uRingIn: 0, uRingOut: 1, uRingTex: this.noiseDummy() };
        if (b.rings) { const rt = drawRings.texture(b); Object.assign(u, { uHasRings: 1, uRingN: Q.rot(b.wrot, [0, 1, 0]), uRingIn: b.rings.inner, uRingOut: b.rings.outer, uRingTex: rt }); }
        return u;
      };
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFBO); gl.viewport(0, 0, w, h);
      for (const b of drawList) {
        const isStar = b.kind === 'star';
        const L = isStar ? [] : lightFor(b);
        // unresolved: draw as a point source
        const fadePt = 1 - clamp((b.pxRadius - 0.8) / 1.2, 0, 1);
        if (fadePt > 0 && !b.blackHole) {
          const dir = V.mul(b.rel, 1 / b.dist);
          if (isStar) {
            const dAU = b.dist / C.AU, c = bbColor(b.temp), y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            points.push({ dir, color: [c[0] / y, c[1] / y, c[2] / y], flux: b.lum / (dAU * dAU) * fadePt });
          } else if (L.length) {
            let fr = 0, fg = 0, fb = 0;
            for (const l of L) {
              const toL = V.norm(V.sub(l.rel, b.rel)), toC = V.mul(dir, -1);
              const al = Math.acos(clamp(V.dot(toL, toC), -1, 1));
              const ph = (Math.sin(al) + (Math.PI - al) * Math.cos(al)) / Math.PI;
              const k = (b.albedo || 0.2) * ph * (b.radius / b.dist) ** 2 * 0.67;
              fr += l.col[0] * k; fg += l.col[1] * k; fb += l.col[2] * k;
            }
            const tint = bodyTint(b), f = Math.max(fr, fg, fb, 1e-30);
            points.push({ dir, color: [fr / f * tint[0], fg / f * tint[1], fb / f * tint[2]], flux: f * fadePt });
          }
        }
        if (b.blackHole) { blackHoles.push(b); continue; }
        if (b.pxRadius < 0.8 || !b.surface) continue;
        if (!sphereVisible(b.rel, b.radius * 1.2 + (b.surface.hmax || 0))) { if (b.rings && sphereVisible(b.rel, b.rings.outer)) b._ringOnly = true; else continue; }
        const lu = isStar ? { uNumLights: 0 } : lightUniforms(b, L);
        b._lu = lu; b._L = L;
        if (!b._ringOnly) {
          gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.BLEND);
          const starRad = isStar ? 1.47e4 * b.lum / ((b.radius / C.Rsun) ** 2) * clamp((b.pxRadius - 0.8) / 1.2, 0, 1) : 0;
          drawPlanet(b, { rel: b.rel, rotQ: b.wrot, viewProj, fcoef, pxPerRad, pxPerRadMax: h / (2 * Math.tan(3 * Math.PI / 180)), sphereVisible, exposure, time: nav.time, light: lu, starRad, noise3: this.noise3, atmoLUT: b.atmo && b.pxRadius > 2 ? getAtmoLUT(b) : null, clouds: rcfg.clouds, cloudRotInv, dummyCube: getDummyCube() });
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFBO); gl.viewport(0, 0, w, h);
        }
        b._ringOnly = false;
        if (b.atmo && b.pxRadius > 2 && !rcfg.noAtmo) {
          // the atmosphere only needs planetshine when the camera is on the night side (it doubles the cost)
          const sunL = L.find(l => !l.shine), up = V.norm(V.mul(b.rel, -1));
          const night = sunL && V.dot(up, V.norm(V.sub(sunL.rel, b.rel))) < -0.15;
          const AL = night ? L : L.filter(l => !l.shine);
          b._alu = AL.length === L.length ? lu : lightUniforms(b, AL);
          atmoPasses.push(b);
        }
      }
      T('planets');
      // rings, belts (blended, depth tested)
      gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
      for (const b of drawList) if (b.rings && b._L && b.dist < b.rings.outer * 1.5) drawRingParticles(b, nav, { viewProj, fcoef, exposure, lights: b._L });
      gl.depthMask(false);
      for (const b of drawList) if (b.rings && b.pxRadius > 0.5 && b._lu) drawRings(b, { viewProj, fcoef, exposure, light: b._lu, rel: b.rel, rotQ: b.wrot, noise3: this.noise3 });
      drawBelts(sys, nav, { viewProj, fcoef, exposure, pxSA, pixScale, lights });
      gl.disable(gl.DEPTH_TEST);
      // points: bodies and far stars
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFBO);
      drawPoints(points, viewProj, common);
      // star coronae / glare
      drawNebulaeAndFx.coronae(sys, nav, { viewProj, fcoef, exposure, pxPerRad, time: nav.time, noise3: this.noise3 });

      T('rings+pts');
      // atmospheres, far to near. The one covering most of the screen goes through the half resolution
      // temporally accumulated path; small ones are integrated directly at full resolution.
      let primary = null;
      // half resolution only pays off when the atmosphere fills most of the screen; smaller planets stay sharp
      for (const b of atmoPasses) if (rcfg.volTAA && b.pxRadius > h * 0.9 && (!primary || b.pxRadius > primary.pxRadius)) primary = b;
      const pc = this.prevCam;
      const prev = pc && pc.sys === sys && pc.level === nav.level ? { rotInv: Q.mat3(Q.conj(pc.q)), tanFov: pc.tanFov, delta: V.sub(nav.S, pc.S) } : null;
      for (const b of atmoPasses) {
        const ar = (b.radius + b.atmo.top) / Math.max(b.dist, 1), pr = project(b.rel);
        // scissor to the projected bounding circle
        let sx = 0, sy = 0, sw = w, sh = h;
        if (pr && b.dist > (b.radius + b.atmo.top) * 1.2) {
          const rp = Math.asin(Math.min(1, ar)) * pxPerRad * 1.3 / Math.max(0.3, Math.cos(Math.atan(Math.hypot((pr[0] * 2 - 1) * tanX, (pr[1] * 2 - 1) * tanY)))) + 4;
          const cx = pr[0] * w, cy = (1 - pr[1]) * h;
          sx = clamp(Math.floor(cx - rp), 0, w); sy = clamp(Math.floor(cy - rp), 0, h);
          sw = clamp(Math.ceil(cx + rp), 0, w) - sx; sh = clamp(Math.ceil(cy + rp), 0, h) - sy;
          if (sw <= 0 || sh <= 0) continue;
        }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.hdrNoDepth); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copyFBO);
        gl.blitFramebuffer(sx, sy, sx + sw, sy + sh, sx, sy, sx + sw, sy + sh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        const ao = { scene: this.copyTex, depth: this.depthTex, camRot, tanFov: [tanX, tanY], pixAngle: 1 / pxPerRad, rotQ: b.wrot, light: b._alu || b._lu, exposure, fcoef, time: nav.time, noise3: this.noise3, frame: this.frameNo, clouds: rcfg.clouds };
        if (b === primary) {
          this.volTAA.draw(b, Object.assign(ao, { w, h, prev, key: b.uid + ':' + w + 'x' + h, outFBO: this.hdrNoDepth, scissor: [sx, sy, sw, sh], noHist: rcfg.volNoHist }));
          continue;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrNoDepth); gl.viewport(0, 0, w, h);
        gl.enable(gl.SCISSOR_TEST); gl.scissor(sx, sy, sw, sh); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
        drawAtmosphere(b, { scene: this.copyTex, depth: this.depthTex, camRot, tanFov: [tanX, tanY], pixAngle: 1 / pxPerRad, rotQ: b.wrot, light: b._alu || b._lu, exposure, fcoef, time: nav.time, noise3: this.noise3, frame: this.frameNo, clouds: rcfg.clouds });
        gl.disable(gl.SCISSOR_TEST);
      }
      T('atmo');
      if (rcfg.orbits) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFBO); drawOrbits(sys, nav, { viewProj, fcoef, selected: nav.selected }); }
      // black holes bend the finished image
      for (const b of blackHoles) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.hdrNoDepth); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copyFBO);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrNoDepth); gl.viewport(0, 0, w, h); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
        drawBlackHole(b, { q: nav.q, scene: this.copyTex, camRot, tanFov: [tanX, tanY], rel: b.rel, exposure, time: nav.time, noise3: this.noise3, viewProj, rotQ: b.wrot });
      }
    }
    gl.depthMask(true);

    T('orbits+bh');
    // ---- temporal anti-aliasing ----
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    let sceneTex = this.hdrTex;
    {
      const an = nav.anchor && nav.level === 'system' ? nav.anchor : null;
      const bInv = an ? Q.conj(an.wrot) : null;
      const cur = { q: nav.q.slice(), tanFov: [tanX, tanY], body: an, camB: an ? Q.rot(bInv, V.sub(nav.S, an.wpos)) : null, qB: an ? Q.mul(bInv, nav.q) : null, level: nav.level, sys };
      if (useTAA) {
        const pv = this.taaPrev;
        const valid = this.taaValid && pv && pv.level === cur.level && pv.sys === cur.sys && pv.body === cur.body;
        const dst = this.taaIdx, srcH = 1 - dst;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.taaFBO[dst]); gl.viewport(0, 0, w, h);
        this.pTAA.use().set({ uCur: this.hdrTex, uHist: this.taaTex[srcH], uDepth: this.depthTex, uTexel: [1 / w, 1 / h], uTanFov: [tanX, tanY], uPrevTanFov: valid ? pv.tanFov : [tanX, tanY], uJit: [jx / w, jy / h],
          uCamRot: camRot, uPrevInvSky: Q.mat3(Q.conj(valid ? pv.q : nav.q)), uBodyInv: Q.mat3(bInv || Q.ident()), uPrevInvBody: Q.mat3(Q.conj(valid && pv.qB ? pv.qB : Q.ident())),
          uCamB: cur.camB || [0, 0, 0], uPrevCamB: valid && pv.camB ? pv.camB : [0, 0, 0], uFcoef: fcoef, uValid: valid ? 1 : 0, uHasBody: an ? 1 : 0 });
        drawFS();
        sceneTex = this.taaTex[dst]; this.taaIdx = srcH; this.taaValid = true;
      } else this.taaValid = false;
      this.taaPrev = cur;
    }
    T('taa');
    // ---- post ----
    let src = sceneTex, sw2 = w, sh2 = h;
    for (const m of this.mips) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, m.f); gl.viewport(0, 0, m.w, m.h);
      this.pDown.use().set({ uTex: src, uTexel: [1 / sw2, 1 / sh2] }); drawFS();
      src = m.t; sw2 = m.w; sh2 = m.h;
    }
    // exposure metering from a small mip (before bloom is mixed in)
    this.measure();
    let acc = this.mips[this.mips.length - 1].t;
    for (let i = this.mips.length - 2; i >= 0; i--) {
      const m = this.mips[i], n = this.mips[i + 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, m.fu); gl.viewport(0, 0, m.w, m.h);
      this.pUp.use().set({ uTex: acc, uBase: m.t, uTexel: [1 / n.w, 1 / n.h], uMix: 0.55 }); drawFS();
      acc = m.u;
    }
    const useFxaa = rcfg.fxaa && !useTAA;
    gl.bindFramebuffer(gl.FRAMEBUFFER, useFxaa ? this.ldrFBO : null); gl.viewport(0, 0, w, h);
    this.pTone.use().set({ uHDR: sceneTex, uBloom: acc, uBloomAmt: rcfg.bloom, uGhost: rcfg.flare ? 0.0012 : 0, uFrame: this.frameNo % 97, uRes: [w, h] }); drawFS();
    if (useFxaa) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h); this.pFxaa.use().set({ uTex: this.ldrTex, uTexel: [1 / w, 1 / h] }); drawFS(); }

    T('post');
    if (gt) gt.end();
    this.prevCam = { q: nav.q.slice(), tanFov: [tanX, tanY], S: nav.S.slice(), sys, level: nav.level };
    if (prof) console.log('LOG prof ' + prof.join(' '));
    // far from any galaxy there is nothing bright: allow much longer exposures so distant galaxies show up
    let deep = 0;
    if (nav.level === 'universe') deep = 1; else if (gal) deep = clamp((V.len(nav.camG()) / gal.radius - 1.3) / 2, 0, 1);
    this.maxExposure = rcfg.maxExposure * (1 + 25 * deep); this.deep = deep;
    // an accretion disk is small and extremely bright: meter on it rather than on the dark sky around it
    this.meterTop = !!(sys && blackHoles.length && blackHoles.some(b => b.accretion && b.dist < b.radius * 400));
    // total solar eclipse in view: expose for the corona, not the darkened sky
    if (sys && sys.stars[0] && !sys.stars[0].blackHole) {
      const st = sys.stars[0], sd = V.len(st.rel), sr = st.radius / sd;
      if (sphereVisible(st.rel, st.radius * 4)) for (const o of sys.bodies) {
        if (o === st || o.kind === 'star' || !o.rel || !o.radius) continue;
        const od = V.len(o.rel); if (od > sd) continue;
        const sep = Math.acos(clamp(V.dot(o.rel, st.rel) / (od * sd), -1, 1));
        if (o.radius / od > sr && sep < o.radius / od - sr * 0.98) { this.meterTop = true; this.eclipseView = true; break; }
      }
    }
    this.adaptExposure(dt);
    this.stats = { stars: nStars, drawn: drawList.length, pending: pendingBakes + (nav.field ? nav.field.busy || 0 : 0), exposure: this.exposure };
  }

  noiseDummy() { if (!this._dummy) this._dummy = tex2D(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, gl.CLAMP_TO_EDGE, new Uint8Array([0, 0, 0, 0])); return this._dummy; }

  measure() {
    // pick the mip closest to 64x36
    let m = this.mips[0]; for (const q of this.mips) if (q.w >= 64) m = q;
    if (!this.meterRead) this.meterRead = new AsyncRead(64 * 36 * 16);
    let ready = false;
    if (this.sync) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.meterFBO); gl.viewport(0, 0, 64, 36);
      this.pCopy.use().set({ uTex: m.t }); drawFS();
      gl.readPixels(0, 0, 64, 36, gl.RGBA, gl.FLOAT, this.meter); ready = true; this.meterExp = this.exposure;
    } else {
      // asynchronous: use the result of an earlier frame, never stall the GPU
      if (this.meterRead.poll(this.meter)) { ready = true; this.meterExp = this.readExp; }
      if (!this.meterRead.busy) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.meterFBO); gl.viewport(0, 0, 64, 36);
        this.pCopy.use().set({ uTex: m.t }); drawFS();
        this.meterRead.start(0, 0, 64, 36, gl.RGBA, gl.FLOAT); this.readExp = this.exposure;
      }
    }
    if (!ready) return;
    const ex = this.meterExp || this.exposure;
    const lum = [];
    for (let i = 0; i < 64 * 36; i++) { const r = this.meter[i * 4], g = this.meter[i * 4 + 1], b = this.meter[i * 4 + 2]; const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / ex; lum.push(isFinite(l) ? l : 0); }
    lum.sort((a, b) => a - b);
    this.lumHi = lum[Math.floor(lum.length * 0.97)]; this.lumTop = lum[Math.floor(lum.length * 0.996)];
    this.lumMed = lum[Math.floor(lum.length * 0.5)];
    let s = 0; for (const l of lum) s += l; this.lumAvg = s / lum.length;
  }
  adaptExposure(dt) {
    let target;
    if (!rcfg.autoExposure) target = rcfg.manualExposure;
    else {
      // in intergalactic space the only bright things are small galaxies: meter on the very brightest cells
      const hi = Math.max((this.deep > 0.05 || this.meterTop ? this.lumTop : this.lumHi) || 0, 1e-12), avg = Math.max(this.lumAvg || 0, 1e-12);
      // expose for bright areas, but don't let a large dim scene go black
      target = Math.min(0.7 / hi, 0.16 / avg * 6);
      target = clamp(target, rcfg.minExposure, this.maxExposure || rcfg.maxExposure);
    }
    target *= Math.pow(2, rcfg.exposureBias);
    if (this.sync) { this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * 0.7); return; }
    const rate = target < this.exposure ? 3.5 : 1.6;
    const k = 1 - Math.exp(-dt * rate);
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * k);
  }
}

export function bodyTint(b) {
  const s = b.surface; if (!s) return [1, 1, 1];
  let c = s.gen === 'gas' ? s.pal[0] : s.gen === 'terra' ? (s.ocean > 0.5 ? [0.5, 0.6, 0.8] : [(s.colA[0] + s.colB[0]) / 2, (s.colA[1] + s.colB[1]) / 2, (s.colA[2] + s.colB[2]) / 2]) : [1, 1, 1];
  const m = Math.max(c[0], c[1], c[2], 1e-6);
  return [c[0] / m, c[1] / m, c[2] / m];
}
