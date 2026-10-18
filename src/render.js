// Frame pipeline: HDR scene (sky, stars, system bodies, atmospheres) then bloom, exposure and tone mapping.
import { gl, Program, tex2D, fbo, drawFS, FS_VS, AsyncRead, GpuTimer, GLOBAL_U } from './gl.js';
import { lateEra } from './farfuture.js';
import { V, Q, M4, C, clamp } from './math.js';
import { RNG } from './rng.js';
import { bbColor } from './stars.js';
import { drawPlanet, planetHousekeeping, planetState, pendingBakes, LOGDEPTH_VS, LOGDEPTH_FS, LIGHT_UNIFORMS, heatGlow } from './planet.js';
import { cosmo } from './cosmology.js';
import { globularPoints } from './globulars.js';
import { getAtmoLUT, drawAtmosphere, cloudRotInv, getDummyCube, VolumetricTAA } from './atmosphere.js';
import { vSurface } from './stars.js';
import { world, sunHook, SUN_ORBIT, sunPos, galQuat0, mwFormation } from './galdyn.js';
import { LG, LG_START, lgWeights, updateLocalGroupPositions, M31 } from './localgroup.js';
import { centresAt } from './lgorbit.js';
import { stellarState } from './stellarevo.js';
import { popIIIPoints, popIIIRate, ionizedIGM } from './earlyuniverse.js';
import { updateSupernovae } from './supernova.js';
import { drawSandbox, sandboxPoints, drawLines, drawDebris, drawTrailsOverlay } from './sandbox.js';
import { planetaryNebula } from './evolution.js';
import { updateMeteors } from './meteors.js';
import { drawStars, drawPoints, drawGalaxies, GalaxySky, skyCfg, drawConstellations, drawSkyMap, invalidateRealGalaxies, drawZodiacal } from './sky.js';
import { catalog } from './assets.js';
import { MILKY_WAY, SUN_POS, REAL_GALAXIES } from './universe.js';
import { drawRings, drawOrbits, drawBelts, drawRingParticles } from './extras.js';
import { drawBlackHole, drawBlackHoles, drawNebulaeAndFx, drawComets } from './exotic.js';

export const rcfg = { scale: 1, bloom: 0.04, exposureBias: 0, autoExposure: true, manualExposure: 1, clouds: true, orbits: true, maxExposure: 1.4e7, minExposure: 1e-11, fxaa: true, flare: false, volTAA: true, constellations: false, taa: true, realSky: true };
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

// Tileable 3D Worley (cellular) noise baked on the GPU, slice by slice: billowy structure for cumulus clouds.
// R: inverted Worley fbm (3 octaves), G: Perlin-Worley mix, B/A: higher frequency Worley.
export function makeWorley3D(N = 64) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const p = new Program('worley3d', FS_VS, `in vec2 vUV; out vec4 o; uniform float uZ, uN;
    vec3 h3(vec3 c){ c = mod(c, uN); return fract(sin(vec3(dot(c, vec3(127.1, 311.7, 74.7)), dot(c, vec3(269.5, 183.3, 246.1)), dot(c, vec3(113.5, 271.9, 124.6))))*43758.5453); }
    float worley(vec3 p, float cells){
      vec3 x = p*cells, i = floor(x), f = x - i; float d = 1e9;
      for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
        vec3 c = vec3(xx, y, z); vec3 q = mod(i + c, cells); vec3 r = c + h3(q + cells*7.) - f; d = min(d, dot(r, r));
      }
      return 1. - clamp(sqrt(d), 0., 1.);
    }
    void main(){
      vec3 p = vec3(vUV, (uZ + 0.5)/uN);
      float w1 = worley(p, 4.), w2 = worley(p, 8.), w3 = worley(p, 16.), w4 = worley(p, 32.);
      float fbm = w1*0.625 + w2*0.25 + w3*0.125;
      o = vec4(fbm, w2*0.6 + w3*0.4, w3*0.6 + w4*0.4, w4);
    }`);
  p.finish();
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.viewport(0, 0, N, N); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
  p.use();
  for (let z = 0; z < N; z++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, z);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    p.set({ uZ: z, uN: N }); drawFS();
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
  gl.bindTexture(gl.TEXTURE_3D, t); gl.generateMipmap(gl.TEXTURE_3D);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  return t;
}
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
// the very early universe, full screen: the Planck foam, the endless zoom of inflation (each octave of fluctuation
// freezing as it leaves the horizon), and the hot plasma glowing at its temperature with its frozen density ripples
// (real ripples are 1 part in 100,000; drawn ~1000x stronger so they can be seen)
const BANDSKY_FS = `in vec2 vUV; out vec4 o;
uniform sampler3D uNoise3; uniform mat3 uRot; uniform vec2 uTanFov; uniform int uMode; uniform float uIon, uZ;
float fbm(vec3 p){ float a = 0.5, s = 0.; for (int i = 0; i < 6; i++) { s += a*(texture(uNoise3, p).r - 0.5); p *= 2.05; a *= 0.55; } return s; }
void main(){
  vec3 d = normalize(uRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  vec3 c;
  if (uMode == 0) {
    // the CMB, +-200 microkelvin shown across the full colour scale (blue cold, red hot)
    float n = clamp(fbm(d*1.3)*3.2, -1., 1.);
    c = n < 0. ? mix(vec3(0.85, 0.88, 0.95), vec3(0.05, 0.15, 0.6), -n) : mix(vec3(0.85, 0.88, 0.95), vec3(0.75, 0.1, 0.05), n);
    c *= 0.35;
  } else {
    // 21 cm: neutral gas glows; ionized bubbles (fraction uIon of space) are dark, carved where the density is highest
    float n = fbm(d*2.4 + 0.3), b = fbm(d*0.9 + 7.1);
    float thr = mix(0.6, -0.6, uIon), bubble = smoothstep(thr - 0.05, thr + 0.05, b*2.4);
    float fl = 0.5 + 1.6*n;
    c = vec3(0.25, 0.9, 0.5)*fl*(1. - bubble)*0.3*smoothstep(200., 30., uZ);
  }
  o = vec4(c, 1.);
}`;
const EARLY_FS = `in vec2 vUV; out vec4 o;
uniform sampler3D uNoise3; uniform mat3 uRot; uniform vec2 uTanFov; uniform float uPhase, uN, uTime, uHot; uniform vec3 uCol;
float fbm(vec3 p){ float a = 0.5, s = 0.; for (int i = 0; i < 5; i++) { s += a*(texture(uNoise3, p).r - 0.5); p *= 2.03; a *= 0.5; } return s; }
void main(){
  vec3 d = normalize(uRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  vec3 c;
  if (uPhase < 0.5) {
    float n = fbm(d*3. + vec3(uTime*0.4, uTime*0.31, -uTime*0.27)) + 0.5*fbm(d*11. - uTime*0.9);
    c = vec3(0.92, 0.88, 1.0)*(0.55 + 1.1*n);
  } else if (uPhase < 1.5) {
    float z = uN*0.35, s = 0., fz = floor(z);
    for (int k = 0; k < 6; k++) {
      float lv = float(k) - fract(z), w = smoothstep(0., 1.2, lv)*smoothstep(6., 4., lv);
      vec3 q = d*exp2(lv)*0.11 + vec3((float(k) + fz)*0.137, (float(k) + fz)*0.071, 0.);
      s += w*(texture(uNoise3, q).r + 0.5*texture(uNoise3, q*2.1).r - 0.75);
    }
    c = mix(vec3(0.03, 0.02, 0.09), vec3(0.42, 0.33, 0.95), smoothstep(-0.35, 0.45, s));
  } else {
    float n = fbm(d*2.2);
    c = uCol*(0.75 + 0.25*uHot)*(1. + 0.08*n);
  }
  o = vec4(c*0.8, 1.);
}`;
// the far future (display-referred): almost nothing to see. A few red dwarfs lit by brown dwarf collisions, the
// remnants' faint warmth (only in the far infrared and microwaves: black dwarfs held at ~60 K by dark matter), and the
// flash of the galaxy's black hole as it finally evaporates
const LATE_FS = `in vec2 vUV; out vec4 o;
uniform mat3 uRot; uniform vec2 uTanFov; uniform float uRed, uRem, uFlash, uPix; uniform vec3 uCen, uFlashDir; uniform int uBand;
float h31(vec3 p){ p = fract(p*vec3(443.897, 441.423, 437.195)); p += dot(p, p.yzx + 19.19); return fract((p.x + p.y)*p.z); }
// one candidate point per cell of a cube-face grid of directions; returns the summed point brightness
float pts(vec3 d, float n, float prob, float seed){
  vec3 a = abs(d); vec2 uv; float f;
  if (a.x > a.y && a.x > a.z) { uv = d.yz/a.x; f = sign(d.x); } else if (a.y > a.z) { uv = d.xz/a.y; f = 2. + sign(d.y); } else { uv = d.xy/a.z; f = 4. + sign(d.z); }
  vec2 g = (uv*0.5 + 0.5)*n, c = floor(g); float s = 0.;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    vec2 cc = c + vec2(i, j); vec3 k = vec3(cc, f + seed);
    if (h31(k) > prob) continue;
    vec2 p = cc + vec2(h31(k + 7.1), h31(k + 3.3));
    float dd = length(g - p)*2./n/uPix;   // distance in pixels (approximately)
    s += exp(-dd*dd*0.6)*(0.4 + 0.6*h31(k + 1.7));
  }
  return s;
}
void main(){
  vec3 d = normalize(uRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  float cen = exp(-(1. - dot(d, uCen))*6.);
  vec3 c = vec3(0.);
  if (uRed > 0.) c += vec3(1., 0.32, 0.12)*pts(d, 9., 0.035*uRed*(0.3 + 2.*cen), 0.)*0.6;
  if ((uBand == 3 || uBand == 4) && uRem > 0.) c += vec3(1., 0.55, 0.3)*pts(d, 70., 0.3*min(uRem, 1.)*(0.2 + 2.*cen), 5.)*0.25*sqrt(uRem);
  if (uFlash > 0.) { float a = acos(clamp(dot(d, uFlashDir), -1., 1.))/uPix; c += vec3(0.8, 0.88, 1.)*uFlash*(exp(-a*a*0.15)*4. + 0.25*exp(-a/40.)); }
  o = vec4(c, 1.);
}`;
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.pDown = new Program('down', FS_VS, DOWN_FS); this.pUp = new Program('up', FS_VS, UP_FS); this.pTone = new Program('tone', FS_VS, TONE_FS); this.pCopy = new Program('copy', FS_VS, COPY_FS); this.pFxaa = new Program('fxaa', FS_VS, FXAA_FS); this.pTAA = new Program('taa', FS_VS, TAA_FS); this.taaIdx = 0; this.taaValid = false;
    this.noise3 = makeNoise3D(); this.worley3 = makeWorley3D();
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

  // The photographed Milky Way is only right near the Sun and near the present: fade it with distance from the Sun
  // (a few hundred parsecs) and with time (the Sun drifts through the local dust clouds over a few million years).
  realSkyWeight(camLocal) {
    const wd = clamp(1 - (V.dist(camLocal, world.sunP) - 150) / 350, 0, 1);
    const wt = clamp(1 - (Math.abs(world.tyr) - 2e5) / 1.8e6, 0, 1);
    return wd * wt;
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
    // relativistic flight: the observer's velocity as a fraction of c (world axes and the galaxy's local axes)
    const betaWorld = nav.beta || [0, 0, 0];
    const betaLocal = nav.galaxy ? Q.rot(Q.conj(nav.galaxy.quat), betaWorld) : betaWorld;
    const common = { exposure, pxSA, pixScale, pxPerRad, noise3: this.noise3, sync: this.sync, betaWorld, betaLocal };

    const prof = rcfg.prof ? [] : null; let pt = performance.now();
    this.onGround = false; this.dimAdapt = false;
    const gt = rcfg.gpuTimes ? (this.gpuTimer || (this.gpuTimer = new GpuTimer())) : null;
    if (gt) { gt.poll(); gt.begin('bake'); }
    const T = (n) => { if (gt) gt.begin(NEXT[n] || n); if (prof) { const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING); gl.bindFramebuffer(gl.FRAMEBUFFER, this.meterFBO); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4)); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); const t = performance.now(); prof.push(n + ':' + (t - pt).toFixed(0)); pt = t; } };
    planetHousekeeping(); T('bake');

    // ---- pre-pass work that needs its own framebuffers ----
    // the Local Group: Andromeda's approach, and the collision as an N-body simulation
    const lgw = lgWeights(world.tyr);
    if (updateLocalGroupPositions(world.tyr) || Math.abs(world.patAng - (this._realAng || 0)) > 0.01 || MILKY_WAY.young !== this._mwYoung) { invalidateRealGalaxies(); this._realAng = world.patAng; this._mwYoung = MILKY_WAY.young; }
    let lgCam = null;
    if (lgw.tMyr > LG_START - 1) {
      LG.advance(lgw.tMyr, this.sync ? 5000 : 24);
      if (LG.ready) {
        const cu = nav.camU(), cm = centresAt(LG.t);
        lgCam = [cm.mw[0] + cu[0] * 1e3, cm.mw[1] + cu[1] * 1e3, cm.mw[2] + cu[2] * 1e3];
        this.lgInside = Math.min(V.dist(lgCam, cm.mw), V.dist(lgCam, cm.m31)) < 70;
        if (this.lgInside) LG.updateCube(lgCam, 1 - lgw.mw, 1 - lgw.m31);
      }
    } else LG.active = false;
    const hideReal = new Set();
    if (lgw.m31 < 0.5) { hideReal.add(M31); }
    if (lgw.mw < 0.5) hideReal.add(MILKY_WAY);
    if (lgw.lmc < 0.5) for (const g of REAL_GALAXIES) if (/Magellanic/.test(g.name)) hideReal.add(g);
    if (lgw.sgr < 0.05) for (const g of REAL_GALAXIES) if (g.sgr) hideReal.add(g);
    hideReal.key = [...hideReal].map(g => g.name[0]).join('');
    const gal = nav.galaxy;
    let camLocal = null, insideGal = false, viewProjLocal = null;
    if (gal) {
      camLocal = nav.camLocal();
      const cn = V.mul(camLocal, 1 / gal.radius);
      insideGal = V.len(cn) < 1.12;
      // near the Sun the photographed sky replaces the model entirely, so the cube needs no updates
      const fullyReal = gal === MILKY_WAY && rcfg.realSky && this.realSkyWeight(camLocal) >= 1 && this.galSky.valid;
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
    // other observing bands: the sky behind everything. Microwaves: the cosmic background (2.7 K today) with its ripples,
    // contrast-stretched like a Planck map; radio in the dark ages and cosmic dawn: the 21 cm glow of neutral hydrogen,
    // with ionized bubbles growing around the first galaxies until reionization is complete
    { const band = GLOBAL_U.uBand, zc = 1 / Math.max(cosmo.a, 1e-9) - 1, q21 = band === 5 && zc > 5.5 && zc < 200 && !cosmo.early;
      if ((band === 4 && !cosmo.early) || q21) {
        if (!this.pBandSky) this.pBandSky = new Program('band-sky', FS_VS, BANDSKY_FS);
        gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
        this.pBandSky.use().set({ uRot: Q.mat3(nav.q), uTanFov: [tanX, tanY], uNoise3: this.noise3, uMode: q21 ? 1 : 0, uIon: q21 ? ionizedIGM(zc) : 0, uZ: zc });
        drawFS(); gl.depthMask(true);
      }
    }
    gl.depthMask(false);
    // galaxies
    const realSkyNear = gal === MILKY_WAY && rcfg.realSky && GLOBAL_U.uBand === 0 && camLocal && this.realSkyWeight(camLocal) > 0.3;
    // galaxies are far too faint to register unless the eye/camera is dark adapted: skip the whole pass otherwise
    // the first stars, in the dark ages: single massive stars in small halos all around (Population III)
    if (popIIIRate(cosmo.tau) > 0 && !cosmo.early) { const pp = popIIIPoints(nav.camU(), cosmo.tau, cosmo.a, world.dtyr); this.popIII = pp; if (pp.length) drawPoints(pp, viewProj, common); } else this.popIII = null;
    if (exposure > 2e4) drawGalaxies(nav.camU(), viewProj, Object.assign({ skip: insideGal && this.galSky.valid ? gal : null, realSkyNear, hideReal: hideReal.size ? hideReal : null }, common));
    // the colliding galaxies as particles
    if (lgCam && exposure > 2e3) {
      if (this.lgInside) LG.drawCube(Q.mat3(nav.q), [tanX, tanY], exposure);
      else LG.drawPoints(lgCam, viewProj, Object.assign({}, common, { maxPx: 6, boost: skyCfg.extBoost }), 1 - lgw.mw, 1 - lgw.m31, 0.5);
    }
    T('galaxies');
    // the Milky Way's glow is far below visibility at daylight exposures
    if (gal && insideGal && exposure > 3e3) {
      // view direction -> galaxy local
      const rl = Q.mat3(Q.mul(Q.conj(gal.quat), nav.q));
      // near the Sun the real (photographed) Milky Way replaces the model, fading out over a few hundred parsecs
      let wReal = 0;
      const form = mwFormation(world.tyr);
      if (gal === MILKY_WAY && rcfg.realSky && GLOBAL_U.uBand === 0) wReal = this.realSkyWeight(camLocal) * lgw.mw;   // (the photograph is visible light)
      const wModel = (gal === MILKY_WAY ? lgw.mw : gal === M31 ? lgw.m31 : 1) * form;
      const drewReal = wReal > 0 && drawSkyMap(rl, [tanX, tanY], exposure, wReal * form, betaLocal);
      this.galSky.draw(rl, [tanX, tanY], exposure, (drewReal ? 1 - wReal : 1) * wModel, betaLocal);
      this.skyFallback = this.galSky.lookup(exposure, wModel); if (this.skyFallback) this.skyFallback.rot = Q.mat3(Q.conj(gal.quat));
    }
    // zodiacal light inside the Solar System (the dust disk ends a few AU out)
    if (sys && sys.desc && sys.desc.sol && exposure > 3e3 && rcfg.realSky) {
      const sun = sys.stars[0];
      if (sun && !sun.gone) {
        const toSun = V.sub(sun.wpos, nav.S), r = V.len(toSun) / C.AU;
        if (r < 6) drawZodiacal(Q.mat3(nav.q), [tanX, tanY], exposure * Math.min(1, sun.lum), V.norm(toSun), Q.rot(sys.worldQ, [0, 1, 0]), r);
      }
    }
    T('galsky');
    let nStars = 0;
    // astronomical refraction for an observer near the surface of a body with an atmosphere
    let refrK = 0, refrUp = [0, 1, 0];
    { const an = nav.anchor;
      if (an && an.atmo && sys && nav.level === 'system') {
        const a = an.atmo, alt = Math.max(nav.altitude, 0);
        if (alt < a.hR * 2.5) {
          const kind = a.comp && a.comp.CO2 > 0.5 ? 1.5 : a.comp && a.comp.H2 > 0.5 ? 0.47 : 1;
          refrK = Math.min(20, (a.P / 101325) * (288 / (a.T || 288)) * kind) * Math.exp(-alt / a.hR);
          refrUp = V.norm(V.sub(nav.S, an.wpos));
        }
      } }
    common.refrK = refrK; common.refrUp = refrUp;
    // no catalogue star can show below this exposure (Sirius would stay under the visibility threshold): skip the pass
    const starsVisible = exposure * 7.6e-11 / pxSA / (6.2832 * 0.62 * 0.62 * pixScale * pixScale) > 0.0012;
    if (gal && nav.field && starsVisible) {
      const hide = sys ? sys.posLocal : null;
      // twinkling only for an observer under an atmosphere
      let twinkle = 0, upLocal = null;
      const an = nav.anchor;
      if (an && an.atmo && nav.altitude < an.atmo.hR * 2 && an.atmo.P > 3e4) twinkle = 1;
      if (refrK > 0) upLocal = Q.rot(Q.conj(gal.quat), refrUp);
      nStars = drawStars(nav.field, camLocal, viewProjLocal, Object.assign({ hide, twinkle, upLocal }, common));
    }
    // supernovae (point sources far brighter than their stars) and their expanding remnants
    let sne = null;
    if (gal && nav.field && camLocal && nav.level !== 'universe') {
      sne = updateSupernovae(nav.field, camLocal, gal.quat); this.supernovae = sne;
      if (sne.points.length) drawPoints(sne.points, viewProj, Object.assign({}, common, { refrUp }));
      // globular clusters too small or far to resolve, as points
      if (gal === MILKY_WAY && starsVisible) { const gp = globularPoints(camLocal, gal.quat, world.tyr, pxPerRad, []); if (gp.length) drawPoints(gp, viewProj, Object.assign({}, common, { refrUp })); }
      // a supernova brighter than about magnitude -7 lights planets and skies like a second moon
      if (sys && nav.level === 'system') for (const p of sne.points.slice(0, 2)) {
        if (p.m > -7) continue;
        const dir = V.norm(p.dir), far = 1e4 * C.AU;
        const fake = { wpos: V.add(nav.S, V.mul(dir, far)), radius: 1e3, name: 'Supernova', kind: 'star', pseudo: true };
        lights.push({ body: fake, rel: V.mul(dir, far), color: p.color, lum: p.flux * 1e8 });
      }
      // the Sun's own planetary nebula, lit by the hot core once the envelope is gone
      const pn = gal === MILKY_WAY ? planetaryNebula(world.tyr) : null;
      // the young Sun's protoplanetary disk: dust and gas out to ~100 AU for the first ~10 Myr, dispersing as the
      // planets form (gone by the time the oldest meteorites' clocks stop, ~4.56 Gyr ago)
      const ageMyr = (world.tyr + 4.57e9) / 1e6;
      if (gal === MILKY_WAY && ageMyr > 0 && ageMyr < 12) {
        sne.remnants.push(this._ppd = Object.assign(this._ppd || {}, { pos: world.sunP.slice(), radius: 120 * C.AU / C.PC, type: 3, seed: 3.3, colA: [1.0, 0.72, 0.45], colB: [0.8, 0.5, 0.35], lum: 14000 * Math.exp(-ageMyr / 4) * Math.min(1, ageMyr / 0.2), name: 'The Sun\'s protoplanetary disk' }));
      }
      // before a star is born its gas is part of a giant molecular cloud; in the last ~20 Myr the cloud collapses into
      // a star-forming region lit by its first massive stars (the Sun formed in such a cluster: short-lived 26Al and
      // 60Fe in meteorites came from a nearby massive star). Drawn around the place the star will form.
      { let k = -1, nm = '', at = null;
        if (gal === MILKY_WAY && ageMyr < 0 && ageMyr > -20) { k = -ageMyr / 20; nm = 'The Sun\'s birth cloud'; at = world.sunP; }
        else {
          // (kept after leaving the system, so the cloud stays visible from outside)
          if (sys && sys.unborn) this._unbornSys = sys;
          const us = sys && !sys.desc.sol ? sys : this._unbornSys;
          const s0 = us && us.galaxy === gal && us._allStars && us.posLocal ? stellarState(us._allStars[0], world.tyr) : null;
          if (s0 && s0.unborn && s0.nursery >= 0) { k = s0.nursery; nm = 'Star-forming cloud (' + us._allStars[0].name + ' not yet born)'; at = us.posLocal; }
        }
        if (k >= 0) sne.remnants.push(this._nurs = Object.assign(this._nurs || {}, { pos: at.slice(), radius: 2.5 + 6 * k, type: 0, seed: 12.7, colA: [1.0, 0.27, 0.35], colB: [0.45, 0.4, 0.9], lum: 12 * (1 - k * 0.8) * Math.min(1, (1 - k) * 8), name: nm }));
      }
      // other young stars have disks too (planets condense in them in the first ~5 Myr; the gas is gone by ~10 Myr)
      if (sys && !sys.desc.sol && !sys.sandbox && sys._allStars && sys.posLocal && !sys.unborn) {
        const p0 = sys._allStars[0], a = p0.ageYr / 1e6;
        if (a > 0 && a < 12) sne.remnants.push(this._ppdX = Object.assign(this._ppdX || {}, { pos: sys.posLocal.slice(), radius: 120 * Math.sqrt(p0.mass / C.Msun) * C.AU / C.PC, type: 3, seed: 5.1, colA: [1.0, 0.72, 0.45], colB: [0.8, 0.5, 0.35], lum: 14000 * Math.exp(-a / 4) * Math.min(1, a / 0.2) * Math.min(3, Math.sqrt(p0.lum)), name: p0.name + ' protoplanetary disk' }));
      }
      // any visited star that has just died: its planetary nebula (~20 km/s, lit for ~30,000 years) or its supernova
      // remnant (free expansion, then Sedov-Taylor, fading over ~100,000 years)
      if (sys && sys.posLocal && sys.root && !sys.desc.sol && !sys.sandbox) {
        const st = sys.root;
        if (st.pnAge !== undefined && st.pnAge < 3e4) { const r = Math.max(20e3 * st.pnAge * C.YEAR / C.PC, 1e-4); sne.remnants.push(this._pnX = Object.assign(this._pnX || {}, { pos: sys.posLocal.slice(), radius: r, type: 1, seed: 4.4, colA: [0.25, 0.85, 0.75], colB: [1.0, 0.32, 0.25], lum: 900 * Math.min(1, Math.pow(0.15 / Math.max(r, 1e-3), 1.5)) * Math.min(1, (3e4 - st.pnAge) / 1e4), name: st.name + ' planetary nebula' })); }
        if (st.snrAge !== undefined && st.snrAge < 1e5) { const a = Math.max(st.snrAge, 1), rf = 5.1e-3 * a, rs = 12.5 * Math.pow(a / 1e4, 0.4), R = 1 / Math.sqrt(1 / (rf * rf) + 1 / (rs * rs)); sne.remnants.push(this._snrX = Object.assign(this._snrX || {}, { pos: sys.posLocal.slice(), radius: Math.max(R, 0.002), type: 2, seed: 2.9, colA: [1.0, 0.35, 0.3], colB: [0.3, 0.75, 1.0], lum: 70 * Math.pow(Math.max(a, 100) / 1000, -0.3) * Math.exp(-a / 6e4), name: st.name + ' supernova remnant' })); }
      }
      if (pn && pn.lit > 0.01) {
        const rpc = pn.r / C.PC;
        sne.remnants.push(this._pn = Object.assign(this._pn || {}, { pos: world.sunP.slice(), radius: Math.max(rpc, 1e-4), type: 1, seed: 7.7, colA: [0.25, 0.85, 0.75], colB: [1.0, 0.32, 0.25], lum: 900 * pn.lit * Math.min(1, Math.pow(0.15 / Math.max(rpc, 1e-3), 1.5)), name: 'The Sun\'s planetary nebula' }));
      }
    }
    // the Sun's orbit around the Galaxy (seen from outside the Solar System): one orbit back, half an orbit ahead
    if (gal === MILKY_WAY && nav.level === 'galaxy' && rcfg.orbits && !LG.active && world.tyr > -4.57e9) {   // (no Sun before it formed)
      const P = SUN_ORBIT.periodYr, cg = nav.camG(), q0 = galQuat0(gal), data = [], N = 360;
      let prev = null;
      for (let k = -N; k <= N / 2; k++) {
        const p = Q.rot(q0, sunPos(world.tyr + k / N * P)), rel = [p[0] - cg[0], p[1] - cg[1], p[2] - cg[2]];
        const a = k <= 0 ? 0.7 * (1 + k / N) ** 1.5 : 0.3 * (1 - 2 * k / N);
        if (prev) data.push(...prev, ...rel, k <= 0 ? 1 : 0.6, 0.85, 0.45, a);
        prev = [...rel, k <= 0 ? 1 : 0.6, 0.85, 0.45, a];
      }
      drawLines(data, viewProj, 2 / Math.log2(FAR + 1));
    }
    T('stars');
    if (rcfg.constellations && gal === MILKY_WAY && camLocal) {
      const ds = V.dist(camLocal, world.sunP);
      drawConstellations(catalog, world.sunP, camLocal, viewProjLocal, 0.35 * clamp(1 - ds / 300, 0, 1));
    }
    drawNebulaeAndFx(nav, { viewProj, viewProjLocal, camLocal, camRot, tanFov: [tanX, tanY], exposure, noise3: this.noise3, time: nav.time, frame: this.frameNo, pxPerRad, extra: sne ? sne.remnants : null });

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
            let E = (o.albedo || 0.2) * 0.67 * ph * (sun.body.lum / (dS * dS)) * (o.radius / dOB) ** 2;
            // a source that is itself in eclipse (the Moon during a lunar eclipse) gives almost no light
            for (const q of sys.bodies) {
              if (q === o || q.kind === 'star' || q.kind === 'barycenter' || !q.radius) continue;
              const toQ = V.sub(q.wpos, o.wpos), dq = V.len(toQ); if (dq > dS * C.AU) continue;
              const toSun = V.norm(V.sub(sun.body.wpos, o.wpos)), sep = Math.atan2(V.len(V.cross(V.mul(toQ, 1 / dq), toSun)), V.dot(V.mul(toQ, 1 / dq), toSun));
              const aq = q.radius / dq, as = sun.body.radius / (dS * C.AU);
              if (sep < aq + as) E *= aq > as && sep < aq - as ? 2e-4 : clamp((sep - (aq - as)) / (2 * as), 0.05, 1);
            }
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
        // negative radius marks occluders with a substantial atmosphere (their umbra is lit by refracted red light)
        for (let i = 0; i < no; i++) { const o = occ[i].o; ou.set(V.sub(o.wpos, nav.S), i * 4); ou[i * 4 + 3] = o.atmo && o.atmo.P > 1e4 ? -o.radius : o.radius; }
        const u = { uNumLights: L.length, uLightPos: lp, uLightCol: lc, uLightRad: lr, uNumOcc: no, uOcc: ou, uPlanetRel: b.rel, uHasRings: 0, uRingN: [0, 1, 0], uRingIn: 0, uRingOut: 1, uRingFade: 1, uRingTex: this.noiseDummy() };
        if (b.rings) { const rt = drawRings.texture(b); Object.assign(u, { uHasRings: 1, uRingN: Q.rot(b.wrot, [0, 1, 0]), uRingIn: b.rings.inner, uRingOut: b.rings.outer, uRingTex: rt, uRingFade: b.rings.fade === undefined ? 1 : b.rings.fade }); }
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
          const starRad = isStar ? 1.47e4 * vSurface(b.temp || 5772) * clamp((b.pxRadius - 0.8) / 1.2, 0, 1) : 0;
          drawPlanet(b, { rel: b.rel, rotQ: b.wrot, viewProj, fcoef, pxPerRad, pxPerRadMax: h / (2 * Math.tan(3 * Math.PI / 180)), sphereVisible, exposure, time: nav.time, light: lu, starRad, noise3: this.noise3, refrK: b === nav.anchor ? 0 : refrK, refrUp, atmoLUT: b.atmo && b.pxRadius > 2 ? getAtmoLUT(b) : null, clouds: rcfg.clouds && !b.noClouds, cloudRotInv, dummyCube: getDummyCube() });
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
      for (const m of updateMeteors(nav, dt)) points.push(m);
      if (sys.sandbox) { for (const p of sandboxPoints(sys, nav)) points.push(p); drawSandbox(sys, nav, { viewProj, fcoef, exposure, maxExposure: this.maxExposure || rcfg.maxExposure }); drawDebris(sys, nav, { viewProj, exposure, pxSA, pxPerRad }); gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFBO); }
      drawPoints(points, viewProj, common);
      // star coronae / glare
      drawNebulaeAndFx.coronae(sys, nav, { viewProj, fcoef, exposure, pxPerRad, time: nav.time, noise3: this.noise3, refrK, refrUp });

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
        const ao = { worley3: this.worley3, planetRel: b.rel, camRotInv: Q.mat3(Q.conj(nav.q)), scene: this.copyTex, depth: this.depthTex, camRot, tanFov: [tanX, tanY], pixAngle: 1 / pxPerRad, rotQ: b.wrot, light: b._alu || b._lu, exposure, fcoef, time: nav.time, noise3: this.noise3, frame: this.frameNo, clouds: rcfg.clouds && !b.noClouds };
        if (b === primary) {
          this.volTAA.draw(b, Object.assign(ao, { w, h, prev, key: b.uid + ':' + w + 'x' + h, outFBO: this.hdrNoDepth, scissor: [sx, sy, sw, sh], noHist: rcfg.volNoHist }));
          continue;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrNoDepth); gl.viewport(0, 0, w, h);
        gl.enable(gl.SCISSOR_TEST); gl.scissor(sx, sy, sw, sh); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
        drawAtmosphere(b, { worley3: this.worley3, planetRel: b.rel, camRotInv: Q.mat3(Q.conj(nav.q)), scene: this.copyTex, depth: this.depthTex, camRot, tanFov: [tanX, tanY], pixAngle: 1 / pxPerRad, rotQ: b.wrot, light: b._alu || b._lu, exposure, fcoef, time: nav.time, noise3: this.noise3, frame: this.frameNo, clouds: rcfg.clouds && !b.noClouds });
        gl.disable(gl.SCISSOR_TEST);
      }
      T('atmo');
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrNoDepth); gl.viewport(0, 0, w, h);
      drawComets(sys, nav, { camRot, tanFov: [tanX, tanY], exposure, time: nav.time, noise3: this.noise3, depth: this.depthTex, fcoef });
      // orbit lines would cut across a real-looking sky: hide them when standing (or flying low) under an atmosphere
      const onGround = nav.anchor && nav.anchor.atmo && nav.altitude < 1e5; this.onGround = !!onGround;
      if (rcfg.orbits && !onGround) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFBO); drawOrbits(sys, nav, { viewProj, fcoef, selected: nav.selected }); }
      // black holes bend the finished image
      // a black hole pair (or more) without accretion disks: one ray trace through their combined gravity
      const together = blackHoles.length > 1 && blackHoles.length <= 4 && blackHoles.every(b => !b.accretion);
      if (together) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.hdrNoDepth); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copyFBO);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrNoDepth); gl.viewport(0, 0, w, h); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
        drawBlackHoles(blackHoles, { q: nav.q, scene: this.copyTex, camRot, tanFov: [tanX, tanY], sky: this.skyFallback });
      }
      for (const b of together ? [] : blackHoles) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.hdrNoDepth); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copyFBO);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrNoDepth); gl.viewport(0, 0, w, h); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
        drawBlackHole(b, { q: nav.q, scene: this.copyTex, camRot, tanFov: [tanX, tanY], rel: b.rel, exposure, time: nav.time, noise3: this.noise3, viewProj, rotQ: b.wrot, strong: blackHoles.length > 1 ? 25 : 60, sky: this.skyFallback, dt: world.dtyr * C.YEAR });
      }
    }
    gl.depthMask(true);
    // the early universe glows: before recombination (~380,000 years) everything is an opaque plasma, and for a few
    // million years afterwards the cosmic background is still hot enough to see (dull red below ~800 K)
    if (cosmo.early) {
      // the first moments (display-referred: brightness spans 30 orders of magnitude, so it is shown at a fixed level)
      if (!this.pEarly) this.pEarly = new Program('early-universe', FS_VS, EARLY_FS);
      const e = cosmo.early, c0 = bbColor(Math.min(Math.max(e.T, 1000), 40000)), y = 0.2126 * c0[0] + 0.7152 * c0[1] + 0.0722 * c0[2];
      this.dimAdapt = true;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrNoDepth); gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
      this.pEarly.use().set({ uRot: camRot, uTanFov: [tanX, tanY], uNoise3: this.noise3, uPhase: e.phase === 'planck' ? 0 : e.phase === 'inflation' ? 1 : 2, uN: e.efolds || 0,
        uCol: c0.map(v => v / y), uTime: (performance.now() / 1000) % 1000, uHot: clamp(Math.log10(Math.max(e.T, 1)) / 32, 0, 1) });
      drawFS();
    } else if (nav.late) {
      if (!this.pLate) this.pLate = new Program('far-future', FS_VS, LATE_FS);
      const v = lateEra(nav.late.y).vis;
      // (the flash appears where you are looking when it starts, then stays put)
      if (v.flash > 0 && !nav.late.fd) nav.late.fd = Q.rot(nav.q, V.norm([0.12 * tanX, 0.05 * tanY, -1])); else if (!v.flash) nav.late.fd = null;
      this.dimAdapt = true;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrNoDepth); gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
      this.pLate.use().set({ uRot: camRot, uTanFov: [tanX, tanY], uRed: v.red, uRem: v.remnants, uFlash: v.flash, uPix: 2 * tanY / h, uCen: [0.31, -0.12, -0.94], uFlashDir: nav.late.fd || [0, 0, -1] });
      drawFS();
    } else if (cosmo.T > 420) {
      // (with the frozen density ripples on it: really 1 part in 100,000, drawn ~5,000x stronger)
      if (!this.pGlow) this.pGlow = new Program('cosmic-glow', FS_VS, `in vec2 vUV; out vec4 o; uniform vec3 uCol; uniform sampler3D uNoise3; uniform mat3 uRot; uniform vec2 uTanFov;
        void main(){ vec3 d = normalize(uRot*vec3((vUV*2. - 1.)*uTanFov, -1.)); float n = 0., a = 0.5; vec3 p = d*1.6; for (int i = 0; i < 5; i++) { n += a*(texture(uNoise3, p).r - 0.5); p *= 2.1; a *= 0.5; }
          o = vec4(uCol*(1. + 0.1*n), 0.); }`);
      const T = Math.min(cosmo.T, 1e9), c0 = bbColor(Math.min(T, 40000)), k = clamp((1600 - T) / 700, 0, 1);
      // (below ~1000 K a glow is a dull deep red)
      const c = c0.map((v, i) => v * (1 - k) + [1, 0.16, 0.03][i] * k), y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      this.dimAdapt = true;
      const L = heatGlow(Math.min(T, 1e6)) * Math.max(1, T / 1e6) * exposure;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrNoDepth); gl.viewport(0, 0, w, h);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
      this.pGlow.use().set({ uCol: [Math.min(c[0] / y * L, 6e4), Math.min(c[1] / y * L, 6e4), Math.min(c[2] / y * L, 6e4)], uNoise3: this.noise3, uRot: camRot, uTanFov: [tanX, tanY] }); drawFS();
      gl.disable(gl.BLEND);
    }

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
    // sandbox trails: a display overlay on top of the finished image
    if (sys && sys.sandbox) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h); drawTrailsOverlay(sys, nav, { viewProj: M4.mul(M4.persp(fov, aspect, 0.1, 1000), view), fcoef }); }

    T('post');
    if (gt) gt.end();
    this.prevCam = { q: nav.q.slice(), tanFov: [tanX, tanY], S: nav.S.slice(), sys, level: nav.level };
    if (prof) console.log('LOG prof ' + prof.join(' '));
    // far from any galaxy there is nothing bright: allow much longer exposures so distant galaxies show up
    let deep = 0;
    if (nav.level === 'universe') deep = 1; else if (gal) deep = clamp((V.len(nav.camG()) / gal.radius - 1.3) / 2, 0, 1);
    this.maxExposure = rcfg.maxExposure * (1 + 200 * deep); this.deep = deep;
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
    // centre-weighted metering: what is in the middle of the frame matters more than slivers at the edges
    const cells = [], lum0 = new Float32Array(64 * 36);
    for (let i = 0; i < 64 * 36; i++) {
      const r = this.meter[i * 4], g = this.meter[i * 4 + 1], b = this.meter[i * 4 + 2]; let l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / ex;
      if (!isFinite(l)) l = 0;
      const x = (i % 64) / 63 * 2 - 1, y = Math.floor(i / 64) / 35 * 2 - 1, rr = x * x * 0.6 + y * y;
      cells.push([l, 0.03 + 0.97 * Math.exp(-rr / 0.12)]); lum0[i] = l;
    }
    // a small, very bright object away from the middle of the frame (the Moon in a corner of a starry sky, a supernova)
    // should not darken everything else: let it overexpose by up to ~30x. (One in the middle is what you are looking
    // at, and is exposed for.)
    { const srt = Array.from(lum0).sort((a, b) => a - b), N = srt.length, ref = srt[N - 7], top = srt[N - 1];
      // (with hysteresis: the condition must hold, or fail, for three readings in a row before it switches, so that a
      // glint flickering across the threshold can't make the exposure pump)
      const want = rcfg.compactMeter !== false && top > 30 * Math.max(ref, 1e-30);
      this._cmpN = want === !!this._cmp ? 0 : (this._cmpN || 0) + 1; if (this._cmpN >= 3) { this._cmp = want; this._cmpN = 0; }
      if (this._cmp && top > 3 * Math.max(ref, 1e-30)) {
        let central = false, cap = Math.max(ref * 3, top / 30);
        for (let i = 0; i < N; i++) if (lum0[i] > cap) { const x = (i % 64) / 63 * 2 - 1, y = Math.floor(i / 64) / 35 * 2 - 1; if (Math.abs(x) < 0.22 && Math.abs(y) < 0.3) central = true; }
        if (!central) for (let i = 0; i < N; i++) if (lum0[i] > cap) { lum0[i] = cap; cells[i][0] = cap; }
      } }
    cells.sort((a, b) => a[0] - b[0]);
    let wsum = 0; for (const c of cells) wsum += c[1];
    const q = (f) => { let acc = 0; for (const c of cells) { acc += c[1]; if (acc >= f * wsum) return c[0]; } return cells[cells.length - 1][0]; };
    const lum = cells.map(c => c[0]);
    this.lumTop = q(0.996);
    // expose for what is in the central part of the frame; very bright surroundings only cap it loosely
    const centre = []; for (let i = 0; i < 64 * 36; i++) { const x = (i % 64) / 63 * 2 - 1, y = Math.floor(i / 64) / 35 * 2 - 1; if (Math.abs(x) < 0.55 && Math.abs(y) < 0.6) centre.push(lum0[i]); }
    centre.sort((a, b) => a - b);
    const hiC = centre[Math.floor(centre.length * 0.975)], hiAll = q(0.995);
    this.lumHi = Math.max(hiC, hiAll * 2.5e-4);
    let sc = 0; for (const l of centre) sc += l; this.lumAvgC = sc / centre.length;
    this.lumMed = q(0.5);
    let s = 0; for (const l of lum) s += l; this.lumAvg = s / lum.length;
  }
  adaptExposure(dt) {
    let target;
    if (!rcfg.autoExposure) target = rcfg.manualExposure;
    else {
      // in intergalactic space the only bright things are small galaxies: meter on the very brightest cells
      const hi = Math.max((this.deep > 0.05 || this.meterTop ? this.lumTop : this.lumHi) || 0, 1e-12), avg = Math.max((this.meterTop ? this.lumAvg : this.lumAvgC) || 0, 1e-12);
      // expose for bright areas, but don't let a large dim scene go black
      target = Math.min(0.7 / hi, 0.16 / avg * 6);
      // under an atmosphere at night the eye never adapts all the way: a moonlit or twilight sky should look dim, not
      // like a grey day (mesopic vision). Daylight is untouched; a moonless night is already at the exposure limit.
      if (this.onGround || this.dimAdapt) { const lev = clamp((Math.log10(hi) + 8) / 7.5, 0, 1); target = Math.min(target, 0.7 * (0.25 + 0.75 * Math.pow(lev, 1.5)) / hi); }
      target = clamp(target, rcfg.minExposure, this.maxExposure || rcfg.maxExposure);
    }
    target *= Math.pow(2, rcfg.exposureBias);
    if (this.sync) { this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * 0.7); return; }
    // The meter is noisy from frame to frame (a percentile of a 64 x 36 image, anti-aliasing jitter, cloud noise). At low
    // frame rates (phones) following it frame by frame makes the whole image pump: smooth the target over ~0.35 s, and
    // hold the exposure while it is within ~0.1 stop of it, as a camera's auto exposure does.
    const lt = Math.log(target);
    if (this._lt === undefined || Math.abs(lt - this._lt) > 2.5) this._lt = lt; else this._lt += (lt - this._lt) * (1 - Math.exp(-dt / 0.35));
    const le = Math.log(this.exposure), diff = this._lt - le;
    if (Math.abs(diff) < 0.07 && !this._adapting) return;
    this._adapting = Math.abs(diff) > 0.02;
    const rate = diff < 0 ? 3.5 : 1.6;
    const k = 1 - Math.exp(-dt * rate);
    this.exposure = Math.exp(le + diff * k);
  }
}

export function bodyTint(b) {
  const s = b.surface; if (!s) return [1, 1, 1];
  let c = s.gen === 'gas' ? s.pal[0] : s.gen === 'terra' ? (s.ocean > 0.5 ? [0.5, 0.6, 0.8] : [(s.colA[0] + s.colB[0]) / 2, (s.colA[1] + s.colB[1]) / 2, (s.colA[2] + s.colB[2]) / 2]) : [1, 1, 1];
  const m = Math.max(c[0], c[1], c[2], 1e-6);
  return [c[0] / m, c[1] / m, c[2] / m];
}
