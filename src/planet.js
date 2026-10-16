// Quadtree cube-sphere renderer. Tiles are baked on the GPU (height / normal / albedo) and drawn with
// camera-relative double precision placement, so one code path covers orbit to ground for planets, moons,
// gas giants and stars.
import { gl, Program, tex2D, fbo, drawFS, FS_VS, makeVAO, AsyncRead } from './gl.js';
import { V, Q, clamp } from './math.js';
import { RNG, hashCombine } from './rng.js';
import { NOCT, GEN_COMMON, GEN_TERRA, GEN_GAS, GEN_STAR, GEN_MAIN } from './terrain_glsl.js';
import { ATMO_UNIFORMS, ATMO_COMMON, ATMO_LUT_SAMPLE } from './atmo_glsl.js';
import { GLSL_BB } from './stars.js';
import { bodyMaps } from './assets.js';

export const cfg = { T: 193, maxChunks: 420, genPerFrame: 3, lodScale: 1.0, shadows: true, autoLod: 1 };
const FACES = [
  { N: [1, 0, 0], A: [0, 0, -1], B: [0, 1, 0] }, { N: [-1, 0, 0], A: [0, 0, 1], B: [0, 1, 0] },
  { N: [0, 1, 0], A: [1, 0, 0], B: [0, 0, -1] }, { N: [0, -1, 0], A: [1, 0, 0], B: [0, 0, 1] },
  { N: [0, 0, 1], A: [1, 0, 0], B: [0, 1, 0] }, { N: [0, 0, -1], A: [-1, 0, 0], B: [0, 1, 0] }];

export const LOGDEPTH_VS = `uniform float uFcoef; out float vFlogz;
void logDepth(){ vFlogz = 1.0 + gl_Position.w; gl_Position.z = (log2(max(1e-6, vFlogz))*uFcoef - 1.0)*gl_Position.w; }`;
export const LOGDEPTH_FS = `uniform float uFcoef; in float vFlogz;
void logDepth(){ gl_FragDepth = log2(vFlogz)*uFcoef*0.5; }`;

const DRAW_VS = `
layout(location=0) in vec3 aPos;
uniform sampler2D uHeightTex;
uniform mat4 uViewProj; uniform mat3 uRot;
uniform vec3 uCenterRel, uQc, uFaceA, uFaceB;
uniform float uQcLen, uSize, uRadius, uSea, uOcean, uSkirt, uGrid, uTexStep, uOblate;
out vec3 vDir; out vec2 vUV; out vec3 vWorld;
${LOGDEPTH_VS}
void main(){
  vec2 uv = aPos.xy / uGrid;
  float h = texelFetch(uHeightTex, ivec2(aPos.xy*uTexStep + 0.5), 0).r;
  if (uOcean > 0.5) h = max(h, uSea);
  vec3 delta = ((uv.x - 0.5)*uSize)*uFaceA + ((uv.y - 0.5)*uSize)*uFaceB;
  float s2 = (2.*dot(uQc, delta) + dot(delta, delta)) / (uQcLen*uQcLen);
  float sq = sqrt(1. + s2); float k = -s2/(sq*(1.+sq));
  vec3 cdir = uQc/uQcLen;
  vec3 dd = cdir*k + delta/(uQcLen*sq);
  vec3 dir = cdir + dd;
  vec3 local = uRadius*dd + dir*(h - aPos.z*uSkirt);
  local.y *= 1. - uOblate;
  vWorld = uRot*local + uCenterRel;
  vDir = dir; vUV = uv;
  gl_Position = uViewProj*vec4(vWorld, 1.);
  logDepth();
}`;

export const LIGHT_UNIFORMS = `
uniform int uNumLights; uniform vec3 uLightPos[3]; uniform vec3 uLightCol[3]; uniform float uLightRad[3];
uniform int uNumOcc; uniform vec4 uOcc[6];
uniform float uHasRings, uRingIn, uRingOut; uniform vec3 uRingN, uPlanetRel; uniform sampler2D uRingTex;
// fraction of light i visible from world point p (camera relative), accounting for eclipses by other bodies
float eclipse(vec3 p, int i){
  vec3 L = uLightPos[i] - p; float dl = length(L); L /= dl;
  float as = uLightRad[i]/dl, vis = 1.;
  for (int k = 0; k < uNumOcc; k++) {
    vec3 O = uOcc[k].xyz - p; float d = length(O);
    if (d > dl) continue;
    float ao = uOcc[k].w/d;
    float sep = acos(clamp(dot(O/d, L), -1., 1.));
    float cover = smoothstep(as + ao, abs(ao - as), sep) * min(1., (ao*ao)/(as*as));
    vis *= 1. - cover;
  }
  return vis;
}
float ringShadow(vec3 p, vec3 L){
  if (uHasRings < 0.5) return 1.;
  float dn = dot(L, uRingN); if (abs(dn) < 1e-5) return 1.;
  float t = -dot(p - uPlanetRel, uRingN)/dn; if (t <= 0.) return 1.;
  float r = length(p + L*t - uPlanetRel);
  if (r < uRingIn || r > uRingOut) return 1.;
  float op = texture(uRingTex, vec2((r - uRingIn)/(uRingOut - uRingIn), 0.5)).a;
  return 1. - op*clamp(0.6/max(abs(dn), 0.25), 0., 1.);
}
`;

const DRAW_FS = `
in vec3 vDir; in vec2 vUV; in vec3 vWorld;
uniform sampler2D uHeightTex, uNormTex, uAlbTex, uIrrLUT;
uniform sampler3D uNoise3;
uniform mat3 uRot;
uniform vec3 uFaceA;
uniform float uPixAngle;
uniform float uTexSize, uSea, uOcean, uExposure, uRadius, uLunar, uSpec, uTime, uChunkM, uHasAtmo, uStarT, uStarRad, uEmisScale, uLavaT, uWaterKind;
uniform vec2 uDetailO; uniform float uChunkA;
uniform int uKind;
uniform samplerCube uCloudMap; uniform mat3 uCloudRotInv; uniform float uHasClouds, uCloudAlt, uShadows;
${LIGHT_UNIFORMS}
${ATMO_UNIFORMS}${ATMO_COMMON}${ATMO_LUT_SAMPLE}
${GLSL_BB}
${LOGDEPTH_FS}
out vec4 oColor;
float heightAt(vec2 uv){
  vec2 p = uv*(uTexSize - 1.); vec2 i = floor(p), f = p - i; ivec2 ip = ivec2(i); ivec2 mx = ivec2(int(uTexSize) - 1);
  float a = texelFetch(uHeightTex, min(ip, mx), 0).r, b = texelFetch(uHeightTex, min(ip + ivec2(1,0), mx), 0).r;
  float c = texelFetch(uHeightTex, min(ip + ivec2(0,1), mx), 0).r, d = texelFetch(uHeightTex, min(ip + ivec2(1,1), mx), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float ggx(float nh, float a){ float a2 = a*a; float d = nh*nh*(a2 - 1.) + 1.; return a2/(3.14159*d*d); }
void main(){
  logDepth();
  vec2 tuv = (vUV*(uTexSize - 1.) + 0.5)/uTexSize;
  vec4 alb = texture(uAlbTex, tuv); alb.rgb *= alb.rgb;
  vec3 dir = normalize(vDir);
  vec3 up = normalize(uRot*dir);
  vec3 Vv = normalize(-vWorld);
  float dist = length(vWorld);
  if (uKind == 2) {
    // stellar photosphere with limb darkening
    float mu = max(dot(up, Vv), 0.);
    vec3 ld = 1. - vec3(0.52, 0.64, 0.82)*(1. - mu) - vec3(0.06, 0.08, 0.1)*(1. - mu)*(1. - mu);
    float tex = alb.r/0.8;
    vec3 c = bbColor(uStarT*(0.82 + 0.18*tex)) * tex * tex * ld * uStarRad;
    oColor = vec4(min(c*uExposure, vec3(60000.)), 1.);
    return;
  }
  vec3 N = up;
  float aoT = 1.;
  float water = 0., depth = 0.;
  if (uKind == 0) {
    vec3 nt = texture(uNormTex, tuv).rgb; vec2 nn = nt.rg; aoT = nt.b;
    vec3 T1 = normalize(uFaceA - dir*dot(dir, uFaceA)), T2 = cross(dir, T1);
    N = normalize(uRot*(dir*sqrt(max(0., 1. - dot(nn, nn))) + T1*nn.x + T2*nn.y));
    if (uOcean > 0.5) { float h = heightAt(vUV); depth = uSea - h; water = smoothstep(0., 0.4, depth); }
    // fine surface grain close to the camera (pebbles, soil clumps), fading with distance
    float near = clamp(1. - dist/900., 0., 1.);
    if (near > 0. && water < 1.) {
      vec2 wp = vUV*uChunkA + uDetailO;   // frequencies are whole cycles per 4096 m so tile wraps are seamless
      vec3 n1 = texture(uNoise3, vec3(wp*(450./4096.), 0.37)).rgb - 0.5, n2 = texture(uNoise3, vec3(wp*(3686./4096.), 0.71)).rgb - 0.5, n3 = texture(uNoise3, vec3(wp*(25805./4096.), 0.13)).rgb - 0.5;
      vec3 T1 = normalize(uRot*normalize(uFaceA - dir*dot(dir, uFaceA))), T2 = cross(up, T1);
      vec2 g = n1.xy*0.5 + n2.xy*0.35*clamp(1. - dist/200., 0., 1.) + n3.xy*0.3*clamp(1. - dist/30., 0., 1.);
      N = normalize(N + (T1*g.x + T2*g.y)*0.55*near);
      alb.rgb *= 1. + (n1.z*0.25 + n2.z*0.2*clamp(1. - dist/200., 0., 1.) + n3.z*0.2*clamp(1. - dist/30., 0., 1.))*near;
    }
  }
  vec3 col = vec3(0.);
  vec3 wN = up;
  float rough = 0.2;
  if (water > 0.) {
    // wave field: a small directional spectrum (wind sea) for near range, statistical roughness far away
    // continuous across tiles: face coordinates in metres, wrapped every 4096 m; all wave vectors are
    // whole numbers of cycles per 4096 m so the wrap is invisible
    vec2 wp = vUV*uChunkA + uDetailO;
    vec3 T1 = normalize(uRot*normalize(uFaceA - dir*dot(dir, uFaceA))), T2 = cross(up, T1);
    vec2 g = vec2(0.);
    float pixM = dist*uPixAngle;            // metres per pixel here
    for (int i = 0; i < 9; i++) {
      float fi = float(i);
      float lam = 70.*pow(0.62, fi);          // 70 m down to ~1.5 m
      if (lam < pixM*3.5) break;
      float ang = (0.4 + fi*2.39996)*0.35;      // spread around the wind direction
      vec2 cyc = floor(vec2(cos(ang), sin(ang))*4096./lam + 0.5);
      float k = 6.2832*length(cyc)/4096.; vec2 kd = normalize(cyc); float w = sqrt(9.81*k);
      float amp = 0.075/k*(1. - smoothstep(lam*0.3, lam*0.6, pixM*2.));
      float ph = dot(kd, wp)*k - w*uTime + fi*1.7;
      g += kd*(amp*k*cos(ph));
    }
    vec3 nz = textureLod(uNoise3, vec3(wp*(176./4096.) + uTime*0.03, uTime*0.02), 0.).rgb - 0.5;
    g += nz.xy*0.08*clamp(1. - pixM/6., 0., 1.);
    wN = normalize(up - (T1*g.x + T2*g.y));
    // unresolved waves become microfacet roughness
    rough = clamp(0.04 + pixM*0.004, 0.04, 0.22);
  }
  float emisNight = 1.;
  for (int i = 0; i < uNumLights; i++) {
    vec3 Lv = uLightPos[i] - vWorld; float dl = length(Lv); vec3 L = Lv/dl;
    float vis = i == 0 ? eclipse(vWorld, i) * ringShadow(vWorld, L) : 1.;
    vec3 lc = uLightCol[i] * vis;
    float mus = dot(up, L);
    vec3 sunT = vec3(1.), amb = vec3(0.);
    if (uHasAtmo > 0.5) {
      float r = max(length(vWorld - uPlanetRel), aRg + 1.);
      sunT = atmoSunTrans(r, mus);
      amb = texture(uIrrLUT, vec2(mus*0.5 + 0.5, 0.5)).rgb * uLightCol[i] * mix(1., vis, 0.9);
      if (i == 0 && uHasClouds > 0.5 && mus > 0.) {
        // cloud shadows: follow the sun ray up to the cloud deck and look up the weather map there
        vec3 pc = (vWorld - uPlanetRel) + L*(uCloudAlt/max(mus, 0.08));
        vec3 pl = uCloudRotInv*pc;
        float cov = texture(uCloudMap, pl).r;
        // same cloud cells as the volumetric layer, so shadows fall where the clouds are
        float S = textureLod(uNoise3, pl/52000. + 0.53, 0.).r*0.5 + textureLod(uNoise3, pl/15000. + 0.21, 0.).g*0.33 + textureLod(uNoise3, pl/5200. + 0.7, 0.).b*0.17;
        float soft = mix(0.06, 0.2, cov), thr = 0.5 + (0.5 - cov)*0.75;
        float fade = clamp(dist/2.5e6, 0., 1.);       // from far away, average coverage reads better than cells
        float sh = mix(smoothstep(thr - soft, thr + soft, S)*smoothstep(0.02, 0.25, cov), smoothstep(0.15, 0.75, cov), fade);
        sunT *= 1. - 0.8*sh; amb *= 1. - 0.35*sh;
      }
    }
    if (i == 0) emisNight *= smoothstep(0.06, -0.12, mus);
    float nl = dot(N, L);
    if (uKind == 1) {
      // gas giant cloud tops: soft terminator
      float d = max(mus, 0.); float mv = max(dot(up, Vv), 0.);
      vec3 lit = alb.rgb * lc * sunT * d * (0.7 + 0.3*pow(mv, 0.3)) / 3.14159;
      col += lit + alb.rgb*amb/3.14159;
      continue;
    }
    float shade = max(nl, 0.);
    if (uLunar > 0.) {
      // Lommel-Seeliger like regolith scattering (no limb darkening at full phase)
      float nv = max(dot(N, Vv), 0.);
      float ls = nl > 0. ? 2.*nl/(nl + nv + 1e-4) * (0.6 + 0.4*nl) : 0.;
      float opp = 1. + 0.4*pow(max(dot(L, Vv), 0.), 8.);
      shade = mix(shade, ls*0.62*opp, uLunar);
    }
    // crude self shadowing of terrain near the terminator from the macro normal
    shade *= smoothstep(-0.02, 0.06, mus);
    // terrain shadows: march the height tile towards the sun (within this tile)
    if (i == 0 && uKind == 0 && uShadows > 0.5 && shade > 0. && mus < 0.75 && water < 0.5) {
      vec3 Ll = L*uRot;                         // sun direction in the planet frame
      vec3 t1 = normalize(uFaceA - dir*dot(dir, uFaceA)), t2 = cross(dir, t1);
      vec2 sl = vec2(dot(Ll, t1), dot(Ll, t2)); float lz = dot(Ll, dir);
      float texel = uChunkM/(uTexSize - 1.);
      float h0 = texelFetch(uHeightTex, ivec2(clamp(vUV, 0., 1.)*(uTexSize - 1.) + 0.5), 0).r;
      float occ = 0.; float s = 1.2;
      for (int k = 0; k < 14; k++) {
        float dm = s*texel;
        vec2 uv2 = vUV + sl*dm/uChunkM;
        if (uv2.x < 0. || uv2.y < 0. || uv2.x > 1. || uv2.y > 1.) break;
        float hk = texelFetch(uHeightTex, ivec2(uv2*(uTexSize - 1.) + 0.5), 0).r - dm*dm/(2.*uRadius);
        float rayH = h0 + lz*dm/max(length(sl), 1e-3);
        occ = max(occ, (hk - rayH)/(dm*0.06 + texel*0.35));
        s *= 1.42;
      }
      shade *= 1. - clamp(occ, 0., 1.)*0.92;
    }
    float ao = mix(1., aoT, 1. - water);
    vec3 land = alb.rgb * (lc*sunT*shade*mix(1., ao, 0.35) + amb*ao) / 3.14159;
    if (uSpec > 0.) { vec3 H = normalize(L + Vv); land += lc*sunT*uSpec*0.04*ggx(max(dot(N, H), 0.), 0.35)*max(nl, 0.); }
    if (water > 0.) {
      vec3 H = normalize(L + Vv);
      float nv = max(dot(wN, Vv), 0.), nlw = max(dot(wN, L), 0.);
      float F = 0.02 + 0.98*pow(1. - nv, 5.);
      float spec = ggx(max(dot(wN, H), 0.), rough) * (0.02 + 0.98*pow(1. - max(dot(H, Vv), 0.), 5.)) * 0.25 / max(nv, 0.08);
      // water body colour: light scattered back from below, seabed attenuated by absorption
      vec3 absorb = uWaterKind > 0.5 ? vec3(0.3, 0.2, 0.12) : vec3(0.45, 0.065, 0.025);
      vec3 scat = uWaterKind > 0.5 ? vec3(0.03, 0.02, 0.008) : vec3(0.0035, 0.018, 0.042);
      vec3 tr = exp(-absorb*depth*1.2);
      vec3 body = (alb.rgb*tr + scat*(1. - tr)) * (lc*sunT*max(mus, 0.) + amb) / 3.14159;
      vec3 Rr = reflect(-Vv, wN); float ry = max(dot(Rr, up), 0.);
      float horiz = 1. + 2.2*pow(1. - ry, 5.);
      vec3 skyR = amb/3.14159*horiz + lc*sunT*0.012*pow(max(dot(Rr, L), 0.), 6.);
      vec3 refl = skyR*F;
      vec3 wcol = body*(1. - F) + refl + lc*sunT*spec*nlw;
      land = mix(land, wcol, water);
    }
    col += land;
  }
  // emission: city lights (night only) or lava
  if (alb.a > 0.003) {
    if (uLavaT > 0.) col += bbColor(uLavaT*(0.75 + 0.35*alb.a)) * vec3(1., 0.75, 0.6) * alb.a * alb.a * uEmisScale;
    else col += vec3(1.0, 0.72, 0.38) * alb.a * uEmisScale * emisNight * (1. - water);
  }
  oColor = vec4(min(col*uExposure, vec3(60000.)), 1.);
}`;

let dummy = null;
// scale a map so its mean brightness equals the body's real albedo (grayscale mosaics are contrast stretched)
function mapTint(body, mp) {
  const m = body.maps; if (!m) return [1, 1, 1];
  const t = m.tint || [1, 1, 1];
  if (!m.albedo || !mp || !mp.color || !mp.color.mean) return t;
  const c = mp.color.mean, l = 0.2126 * c[0] * t[0] + 0.7152 * c[1] * t[1] + 0.0722 * c[2] * t[2];
  const k = m.albedo / Math.max(l, 1e-3);
  return [t[0] * k, t[1] * k, t[2] * k];
}
function dummyTex() { if (!dummy) dummy = tex2D(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, gl.CLAMP_TO_EDGE, new Uint8Array([128, 128, 128, 255])); return dummy; }
let progAO = null, progDraw = null, progGen = {}, gridVAO = null, gridCount = 0, genFBO = null, queryFBO = null, queryTex = null;
const texPool = [];
let frame = 0;

export function initPlanetPrograms() { init(); }
function init() {
  if (progDraw) return;
  progDraw = new Program('planet', DRAW_VS, DRAW_FS);
  const pre = 'in vec2 vUV;\n' + GEN_COMMON;
  progGen.terra = new Program('gen-terra', FS_VS, '#define HAS_RELIEF\n' + pre + GEN_TERRA + GEN_MAIN);
  progGen.gas = new Program('gen-gas', FS_VS, pre + GEN_GAS + GEN_MAIN);
  progGen.star = new Program('gen-star', FS_VS, pre + GEN_STAR + GEN_MAIN);
  progAO = new Program('tile-ao', FS_VS, `in vec2 vUV; out vec4 o; uniform sampler2D uHeightTex; uniform float uTexel, uTexSize;
    void main(){
      ivec2 p = ivec2(gl_FragCoord.xy); ivec2 mx = ivec2(int(uTexSize) - 1);
      float h0 = texelFetch(uHeightTex, p, 0).r, occ = 0.;
      for (int k = 0; k < 8; k++) {
        float a = float(k)*0.7853982 + 0.39; vec2 d = vec2(cos(a), sin(a));
        float best = 0.;
        for (int r = 1; r <= 16; r *= 2) { ivec2 q = clamp(p + ivec2(d*float(r)), ivec2(0), mx); float dh = texelFetch(uHeightTex, q, 0).r - h0; best = max(best, dh/(float(r)*uTexel)); }
        occ += best/sqrt(1. + best*best);
      }
      o = vec4(0., 0., clamp(1. - occ/8.*0.9, 0.2, 1.), 0.);
    }`);
  // shared grid with skirt ring
  const G = (cfg.T - 1) / 3; cfg.G = G;
  const n = G + 3, verts = new Float32Array(n * n * 3), idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const sk = (i === 0 || j === 0 || i === n - 1 || j === n - 1) ? 1 : 0;
    verts[k++] = clamp(i - 1, 0, G); verts[k++] = clamp(j - 1, 0, G); verts[k++] = sk;
  }
  k = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; idx[k++] = a; idx[k++] = a + 1; idx[k++] = a + n; idx[k++] = a + 1; idx[k++] = a + n + 1; idx[k++] = a + n; }
  gridVAO = makeVAO([{ data: verts, size: 3, loc: 0 }], idx); gridCount = idx.length;
  genFBO = gl.createFramebuffer();
  queryTex = tex2D(1, 1, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST);
  queryFBO = fbo([queryTex]);
}

function allocTex() {
  if (texPool.length) return texPool.pop();
  const T = cfg.T;
  return { h: tex2D(T, T, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST), n: tex2D(T, T, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR), a: tex2D(T, T, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR) };
}

class Chunk {
  constructor(st, face, level, ix, iy, parent) {
    this.st = st; this.face = face; this.level = level; this.ix = ix; this.iy = iy; this.parent = parent;
    this.children = null; this.tex = null; this.ready = false; this.last = 0; this.queued = false;
    const F = FACES[face], s = 2 / (1 << level);
    this.size = s; this.a0 = -1 + ix * s; this.b0 = -1 + iy * s;
    const ac = this.a0 + s / 2, bc = this.b0 + s / 2;
    this.qc = [F.N[0] + ac * F.A[0] + bc * F.B[0], F.N[1] + ac * F.A[1] + bc * F.B[1], F.N[2] + ac * F.A[2] + bc * F.B[2]];
    this.qlen = V.len(this.qc); this.c = V.mul(this.qc, 1 / this.qlen);
    // angular radius of the tile (half diagonal)
    const corner = V.norm([F.N[0] + this.a0 * F.A[0] + this.b0 * F.B[0], F.N[1] + this.a0 * F.A[1] + this.b0 * F.B[1], F.N[2] + this.a0 * F.A[2] + this.b0 * F.B[2]]);
    const corner2 = V.norm([F.N[0] + (this.a0 + s) * F.A[0] + (this.b0 + s) * F.B[0], F.N[1] + (this.a0 + s) * F.A[1] + (this.b0 + s) * F.B[1], F.N[2] + (this.a0 + s) * F.A[2] + (this.b0 + s) * F.B[2]]);
    this.angRad = Math.max(Math.acos(clamp(V.dot(corner, this.c), -1, 1)), Math.acos(clamp(V.dot(corner2, this.c), -1, 1))) * 1.05;
  }
}

// Per body state
class PlanetState {
  constructor(body) {
    this.body = body; this.surf = body.surface;
    const rng = new RNG(hashCombine(Math.floor(this.surf.seed[0] * 1000), Math.floor(this.surf.seed[1] * 1000), 99));
    this.off = []; for (let o = 0; o < NOCT; o++) this.off.push([rng.range(0, 4096), rng.range(0, 4096), rng.range(0, 4096)]);
    this.aniso = this.surf.gen === 'gas' ? [1, 2.6, 1] : [1, 1, 1];
    this.roots = FACES.map((f, i) => new Chunk(this, i, 0, 0, 0, null));
    this.count = 0; this.last = 0; this.groundH = 0; this.maxLevel = clamp(Math.floor(Math.log2(body.radius * 2 / (cfg.T - 1) / 0.04)), 2, 22);
    if (this.surf.gen === 'gas') this.maxLevel = Math.min(this.maxLevel, 9);
    if (this.surf.gen === 'star') this.maxLevel = Math.min(this.maxLevel, 8);
    this.OF = new Float32Array(NOCT * 3); this.OC = new Int32Array(NOCT * 3);
  }
  octaves(c) {
    const f0 = this.surf.freq, an = this.aniso;
    for (let o = 0; o < NOCT; o++) {
      const f = f0 * Math.pow(2, o);
      for (let k = 0; k < 3; k++) { const x = c[k] * an[k] * f + this.off[o][k]; const fl = Math.floor(x); this.OF[o * 3 + k] = x - fl; this.OC[o * 3 + k] = fl; }
    }
  }
  genUniforms(prog, ch, texSize) {
    const s = this.surf, F = FACES[ch.face];
    this.octaves(ch.c);
    const texel = ch.size / (cfg.T - 1);
    let oMax = Math.floor(Math.log2(1 / (2.6 * texel * s.freq)));
    oMax = clamp(oMax, 0, NOCT - 1);
    if (texSize === 1) oMax = NOCT - 1;
    const mp = this.maps;
    const sz = mp && mp.color ? mp.color.w : mp && mp.height ? mp.height.w : 4096;
    const mapOct = Math.ceil(Math.log2(sz / (4 * Math.PI * s.freq)));
    prog.set({ uHasC: mp && mp.color ? 1 : 0, uHasH: mp && mp.height ? 1 : 0, uHasM: mp && mp.mask ? 1 : 0, uHasL: mp && mp.lights ? 1 : 0,
      uCMap: mp && mp.color ? mp.color.tex : dummyTex(), uHMap: mp && mp.height ? mp.height.tex : dummyTex(), uMMap: mp && mp.mask ? mp.mask.tex : dummyTex(), uLMap: mp && mp.lights ? mp.lights.tex : dummyTex(),
      uHRange: (this.body.maps && this.body.maps.hRange) || [0, 1], uMapOct: mapOct, uMapDetail: this.body.radius / Math.pow(2, mapOct) / s.freq * 0.02, uMapTint: mapTint(this.body, mp), uMapCurve: this.body.maps && this.body.maps.curve === 'bmng' ? 1 : 0,
      uCraterO0: mp && mp.height ? mapOct : 2 });
    prog.set({ uOF: this.OF, uOC: this.OC, uOMax: oMax, uFreq: s.freq, uAniso: this.aniso, uFaceA: F.A, uFaceB: F.B, uQc: ch.qc, uQcLen: ch.qlen, uSize: ch.size, uTexel: texel, uRadius: this.body.radius, uTexSize: texSize });
    if (s.gen === 'terra') prog.set({ uContAmp: s.contAmp, uMtnAmp: s.mtnAmp, uHillAmp: s.hillAmp, uWarp: s.warp, uSea: s.sea, uOcean: s.ocean, uCrater: s.crater, uCraterAmp: s.craterAmp, uMaria: s.maria, uCracks: s.cracks, uDunes: s.dunes, uVolcano: s.volcano, uLava: s.lava, uVeg: s.veg, uIceLat: s.iceLat, uSnowLine: s.snowLine, uTempEq: s.tempEq, uCity: s.city,
      uColA: s.colA, uColB: s.colB, uColRock: s.colRock, uColLow: s.colLow, uColIce: s.colIce, uColVeg1: s.colVeg1, uColVeg2: s.colVeg2, uColSand: s.colSand, uColCrack: s.colCrack });
    else if (s.gen === 'gas') prog.set({ uPal: new Float32Array(s.pal.flat()), uBands: s.bands, uBandStr: s.bandStr, uTurb: s.turb, uStorms: s.storms, uGasSeed: s.seed[0] });
    else prog.set({ uSpots: s.spots || 0, uGranOct: s.gran ? s.gran + 1 : clamp(Math.round(Math.log2(this.body.radius / 1.4e6)), 4, 12) });
  }
  bake(ch) {
    const prog = progGen[this.surf.gen].use();
    ch.tex = allocTex();
    gl.bindFramebuffer(gl.FRAMEBUFFER, genFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ch.tex.h, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, ch.tex.n, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, ch.tex.a, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.viewport(0, 0, cfg.T, cfg.T);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    this.genUniforms(prog, ch, cfg.T);
    drawFS();
    if (this.surf.gen === 'terra') {
      // ambient occlusion from the baked heights, written into the normal texture's blue channel only
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ch.tex.n, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, null, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.colorMask(false, false, true, false);
      progAO.use().set({ uHeightTex: ch.tex.h, uTexel: ch.size / (cfg.T - 1) * this.body.radius / ch.qlen, uTexSize: cfg.T });
      drawFS();
      gl.colorMask(true, true, true, true);
    }
    ch.ready = true; ch.queued = false; this.count++;
  }
  // Non-blocking version for per-frame use: returns the most recent completed result (or null) and starts a new query.
  queryHeightAsync(dir) {
    if (this.surf.gen !== 'terra') return 0;
    if (!this.hread) { this.hread = new AsyncRead(16); this.hbuf = new Float32Array(4); this.lastH = null; }
    if (this.hread.poll(this.hbuf)) { let h = this.hbuf[0]; if (!isFinite(h)) h = 0; if (this.surf.ocean > 0.5) h = Math.max(h, this.surf.sea); this.lastH = h; }
    if (!this.hread.busy) { this.renderHeightQuery(dir); this.hread.start(0, 0, 1, 1, gl.RGBA, gl.FLOAT); }
    return this.lastH;
  }
  renderHeightQuery(dir) {
    const prog = progGen.terra.use();
    const n = V.norm(dir);
    let a = V.cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]); a = V.norm(a); const b = V.cross(n, a);
    const fake = { face: 0, c: n, qc: n, qlen: 1, size: 1e-7 };
    const F = FACES[0]; const sA = F.A, sB = F.B; F.A = a; F.B = b;
    gl.bindFramebuffer(gl.FRAMEBUFFER, queryFBO); gl.viewport(0, 0, 1, 1); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    this.genUniforms(prog, fake, 1);
    F.A = sA; F.B = sB;
    drawFS();
  }
  // terrain height (m) under a planet-local direction, full detail
  queryHeight(dir) {
    if (this.surf.gen !== 'terra') return 0;
    const prog = progGen.terra.use();
    const n = V.norm(dir);
    let a = V.cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]); a = V.norm(a); const b = V.cross(n, a);
    const fake = { face: 0, c: n, qc: n, qlen: 1, size: 1e-7 };
    const F = FACES[0]; const sA = F.A, sB = F.B; F.A = a; F.B = b;
    gl.bindFramebuffer(gl.FRAMEBUFFER, queryFBO); gl.viewport(0, 0, 1, 1); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    this.genUniforms(prog, fake, 1);
    F.A = sA; F.B = sB;
    drawFS();
    const out = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, out);
    let h = out[0];
    if (!isFinite(h)) h = 0;
    if (this.surf.ocean > 0.5) h = Math.max(h, this.surf.sea);
    return h;
  }
  free(ch) {
    if (ch.children) { for (const c of ch.children) this.free(c); ch.children = null; }
    if (ch.tex) { texPool.push(ch.tex); ch.tex = null; this.count--; }
    ch.ready = false; ch.queued = false;
  }
  dispose() { for (const r of this.roots) this.free(r); }
}

const states = new Map();
export function planetState(body) {
  init();
  let s = states.get(body.uid);
  const maps = bodyMaps(body);
  if (s && s.mapsVersion !== (body.mapsVersion || 0)) { s.dispose(); states.delete(body.uid); s = null; }
  if (!s) { s = new PlanetState(body); s.maps = maps; s.mapsVersion = body.mapsVersion || 0; states.set(body.uid, s); }
  return s;
}
export function totalChunks() { let n = 0; for (const s of states.values()) n += s.count; return n; }
export let pendingBakes = 0;
const queue = [];

// Select and draw tiles for a body.
// o: { rel: planet centre relative to camera (m, world axes), rotQ, view (camera params), uniforms: lighting etc. }
export function drawPlanet(body, o) {
  init();
  const st = planetState(body); st.last = frame;
  if (body.maps && !st.maps && !body.maps._state.failed) { /* maps still loading: procedural for now */ }
  const R = body.radius, surf = st.surf;
  const rotInv = Q.conj(o.rotQ);
  const camLocal = Q.rot(rotInv, V.mul(o.rel, -1));       // camera in planet frame
  if (body.oblate) camLocal[1] /= (1 - body.oblate);
  const camDist = V.len(camLocal), camDir = V.mul(camLocal, 1 / camDist);
  const hmax = surf.hmax || 0, hmin = surf.hmin || 0;
  const Rmin = R + hmin, alt = Math.max(camDist - (R + st.groundH), 0.5);
  const horizon = Math.acos(clamp(Rmin / Math.max(camDist, Rmin + 1), -1, 1)) + Math.acos(clamp(Rmin / (R + hmax + 1), -1, 1));
  const rot3 = Q.mat3(o.rotQ);
  // telephoto views would otherwise ask for unbounded detail: LOD saturates below a ~6 degree field of view
  const K = 1.45 * cfg.T / Math.min(o.pxPerRad, o.pxPerRadMax || o.pxPerRad) / (cfg.lodScale * cfg.autoLod);
  const draws = [];
  const visit = (ch) => {
    ch.last = frame;
    // horizon cull
    const ang = Math.acos(clamp(V.dot(ch.c, camDir), -1, 1));
    if (ang - ch.angRad > horizon) return;
    // frustum cull using bounding sphere
    const sizeM = ch.size * R * (1 / ch.qlen);
    const cW = Q.rot(o.rotQ, body.oblate ? [ch.c[0] * R, ch.c[1] * R * (1 - body.oblate), ch.c[2] * R] : V.mul(ch.c, R));
    const cRel = [cW[0] + o.rel[0], cW[1] + o.rel[1], cW[2] + o.rel[2]];
    const brad = ch.angRad * R + Math.max(hmax, -hmin);
    if (ch.level > 0 && !o.sphereVisible(cRel, brad)) return;
    // distance to nearest point of tile
    const F = FACES[ch.face];
    const dn = V.dot(camDir, F.N);
    let dist;
    if (dn > 0.01) {
      const a = clamp(V.dot(camDir, F.A) / dn, ch.a0, ch.a0 + ch.size), b = clamp(V.dot(camDir, F.B) / dn, ch.b0, ch.b0 + ch.size);
      const q = V.norm([F.N[0] + a * F.A[0] + b * F.B[0], F.N[1] + a * F.A[1] + b * F.B[1], F.N[2] + a * F.A[2] + b * F.B[2]]);
      const rr = R + st.groundH;
      dist = Math.hypot(camLocal[0] - q[0] * rr, camLocal[1] - q[1] * rr, camLocal[2] - q[2] * rr);
    } else dist = Math.max(V.len(cRel) - ch.angRad * R, 1);
    dist = Math.max(dist, alt, 0.5);
    const split = ch.level < st.maxLevel && sizeM / dist > K;
    if (split) {
      if (!ch.children) { ch.children = []; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) ch.children.push(new Chunk(st, ch.face, ch.level + 1, ch.ix * 2 + i, ch.iy * 2 + j, ch)); }
      let all = true;
      for (const c of ch.children) { c.last = frame; if (!c.ready) { all = false; if (!c.queued) { c.queued = true; queue.push(c); } c.prio = sizeM / dist; } }
      if (all) { for (const c of ch.children) visit(c); return; }
    }
    draws.push({ ch, cRel, sizeM });
  };
  for (const r of st.roots) { if (!r.ready) st.bake(r); visit(r); }
  // draw
  const p = progDraw.use();
  gl.bindVertexArray(gridVAO.vao);
  const atmo = body.atmo && o.atmoLUT;
  p.set(Object.assign({
    uViewProj: o.viewProj, uFcoef: o.fcoef, uRot: rot3, uRadius: R, uSea: surf.sea || 0, uOcean: surf.ocean || 0, uGrid: cfg.G, uTexStep: (cfg.T - 1) / cfg.G, uTexSize: cfg.T,
    uOblate: body.oblate || 0, uExposure: o.exposure, uLunar: surf.lunar === undefined ? 0 : surf.lunar, uSpec: surf.spec || 0, uTime: o.time % 3600, uKind: surf.gen === 'terra' ? 0 : surf.gen === 'gas' ? 1 : 2,
    uHasAtmo: atmo ? 1 : 0, uStarT: body.temp || 5000, uStarRad: o.starRad || 0, uEmisScale: surf.lava ? 0.06 : 9e-5, uLavaT: surf.lava ? clamp(surf.tempEq || 1300, 1100, 1700) : 0, uWaterKind: body.cls === 'Titan' ? 1 : 0,
    uNoise3: o.noise3, uShadows: cfg.shadows ? 1 : 0, uPixAngle: 1 / o.pxPerRad,
  }, o.light));
  if (atmo) p.set(Object.assign({ uTransLUT: o.atmoLUT.trans, uMultiLUT: o.atmoLUT.multi, uIrrLUT: o.atmoLUT.irr }, o.atmoLUT.uniforms));
  const cl = atmo && o.clouds && o.atmoLUT.cloud && body.atmo.clouds.kind !== 'venus' && surf.gen === 'terra';
  p.set({ uHasClouds: cl ? 1 : 0, uCloudMap: cl ? o.atmoLUT.cloud : o.dummyCube, uCloudRotInv: cl ? o.cloudRotInv(body, o.rotQ, o.time) : new Float32Array(9), uCloudAlt: cl ? (body.atmo.clouds.base + body.atmo.clouds.top) * 0.4 : 1 });
  for (const d of draws) {
    const ch = d.ch, F = FACES[ch.face];
    // origin of this tile in metres along the face, wrapped, for stable small scale effects
    const om = [((ch.a0 + 1) * R) % 4096, ((ch.b0 + 1) * R) % 4096];
    p.set({ uHeightTex: ch.tex.h, uNormTex: ch.tex.n, uAlbTex: ch.tex.a, uCenterRel: d.cRel, uQc: ch.qc, uQcLen: ch.qlen, uFaceA: F.A, uFaceB: F.B, uSize: ch.size, uSkirt: d.sizeM * 0.06, uChunkM: d.sizeM, uChunkA: ch.size * R, uDetailO: om });
    gl.drawElements(gl.TRIANGLES, gridCount, gl.UNSIGNED_INT, 0);
  }
  st.drawn = draws.length;
  return st;
}

// Bake queued tiles (called once per frame), evict stale ones.
export function planetHousekeeping() {
  init();
  frame++;
  queue.sort((a, b) => (a.prio || 0) - (b.prio || 0));
  let n = 0;
  while (queue.length && n < cfg.genPerFrame) {
    const c = queue.pop();
    if (c.ready || frame - c.last > 3) { c.queued = false; continue; }
    c.st.bake(c); n++;
  }
  for (const c of queue) if (frame - c.last > 3) c.queued = false;
  for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].queued) queue.splice(i, 1);
  pendingBakes = queue.length;
  // if the view needs more tiles than the cache can hold (or than we can bake soon), coarsen the LOD until it fits
  const demand = totalChunks() + queue.length;
  if (demand > cfg.maxChunks * 0.9 || queue.length > 400) cfg.autoLod = Math.max(0.15, cfg.autoLod * 0.94);
  else if (queue.length < 30 && demand < cfg.maxChunks * 0.6) cfg.autoLod = Math.min(1, cfg.autoLod * 1.01);
  if (frame % 20 === 0) {
    const total = totalChunks();
    const maxAge = total > cfg.maxChunks ? 30 : 600;
    for (const [uid, st] of states) {
      if (frame - st.last > 900) { st.dispose(); states.delete(uid); continue; }
      const prune = (ch) => {
        if (!ch.children) return;
        let stale = true;
        for (const c of ch.children) { prune(c); if (frame - c.last <= maxAge || c.children) stale = false; }
        if (stale) { for (const c of ch.children) st.free(c); ch.children = null; }
      };
      for (const r of st.roots) prune(r);
    }
  }
}
