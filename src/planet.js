// Quadtree cube-sphere renderer. Tiles are baked on the GPU (height / normal / albedo) and drawn with
// camera-relative double precision placement, so one code path covers orbit to ground for planets, moons,
// gas giants and stars.
import { gl, unbindTextures, Program, tex2D, fbo, drawFS, FS_VS, makeVAO, AsyncRead } from './gl.js';
import { V, Q, clamp } from './math.js';
import { RNG, hashCombine } from './rng.js';
import { NOCT, GEN_COMMON, GEN_TERRA, GEN_GAS, GEN_STAR, GEN_MAIN } from './terrain_glsl.js';
import { ATMO_UNIFORMS, ATMO_COMMON, ATMO_LUT_SAMPLE, WEATHER_GLSL, weatherUniform } from './atmo_glsl.js';
import { GLSL_BB } from './stars.js';
import { bodyMaps, loadTexture } from './assets.js';
import { plateInverse } from './tectonics.js';
import { paleoState, paleoSeaRise } from './paleo.js';

export const cfg = { T: 193, maxChunks: 420, genPerFrame: 3, lodScale: 1.0, shadows: true, autoLod: 1, trees: true, treeRange: 1800, treeBudget: 60000 };
const FACES = [
  { N: [1, 0, 0], A: [0, 0, -1], B: [0, 1, 0] }, { N: [-1, 0, 0], A: [0, 0, 1], B: [0, 1, 0] },
  { N: [0, 1, 0], A: [1, 0, 0], B: [0, 0, -1] }, { N: [0, -1, 0], A: [1, 0, 0], B: [0, 0, 1] },
  { N: [0, 0, 1], A: [1, 0, 0], B: [0, 1, 0] }, { N: [0, 0, -1], A: [-1, 0, 0], B: [0, 1, 0] }];

// Astronomical refraction for an observer under an atmosphere: celestial objects are lifted towards the zenith
// by R(true altitude) (Saemundsson). uRefrK is 0 when not applicable, 1 for Earth at sea level.
export const REFRACT_VS = `uniform float uRefrK; uniform vec3 uRefrUp;
vec3 refractLift(vec3 p){
  if (uRefrK <= 0.) return p;
  float d = length(p); vec3 v = p/d;
  float sh = dot(v, uRefrUp); if (sh < -0.05 || sh > 0.6) return p;
  float h = degrees(asin(sh));
  float R = radians(uRefrK*1.02/tan(radians(h + 10.3/(h + 5.11)))/60.);
  vec3 t = normalize(uRefrUp - v*sh);
  return (v*cos(R) + t*sin(R))*d;
}`;
export const LOGDEPTH_VS = `uniform float uFcoef; out float vFlogz;
void logDepth(){ vFlogz = 1.0 + gl_Position.w; gl_Position.z = (log2(max(1e-6, vFlogz))*uFcoef - 1.0)*gl_Position.w; }`;
export const LOGDEPTH_FS = `uniform float uFcoef; in float vFlogz;
void logDepth(){ gl_FragDepth = log2(vFlogz)*uFcoef*0.5; }`;

// ice ages: the southern edge (deg N) of the Northern ice sheets for the current ice volume (uIceAge.x, 1 = Last
// Glacial Maximum), from LGM limits every 20 deg of longitude from 180 W (Laurentide, Cordilleran, Fennoscandian, ...)
const ICE_GLSL = `uniform vec2 uIceAge;
const float ICE_LIM[19] = float[19](72., 66., 58., 47., 45., 40., 44., 58., 62., 52., 51., 57., 62., 66., 72., 75., 74., 70., 72.);
float iceEdgeLat(vec3 dir){
  float lonD = degrees(atan(-(abs(dir.z) < 1e-9 ? -1e-9 : dir.z), dir.x));
  float fi = clamp((lonD + 180.)/20., 0., 17.999); int ii = int(fi);
  float lim = mix(ICE_LIM[ii], ICE_LIM[ii + 1], smoothstep(0., 1., fi - float(ii)));
  return mix(82., lim, pow(min(uIceAge.x, 1.15), 0.7));
}
// the ice sheets' surface: domes up to ~3.3 km thick at the Last Glacial Maximum (Vialov profile from the margin, ~2,000
// km to the centre), grounded on land and shallow shelves only (the deep Arctic Ocean had sea ice)
float iceSheetH(vec3 dir, float h){
  if (uIceAge.x <= 0.05 || uIceAge.x >= 2.5) return h;
  float d = degrees(asin(clamp(dir.y, -1., 1.))) - iceEdgeLat(dir);
  if (d <= 0.) return h;
  float x = min(d/18., 1.), T = 3300.*min(uIceAge.x, 1.)*pow(max(1. - pow(1. - x, 4./3.), 0.), 3./8.)*smoothstep(-900., -400., h);
  return max(h, max(h, -200.)*0.3 + T);
}`;
const ICE_LIM = [72, 66, 58, 47, 45, 40, 44, 58, 62, 52, 51, 57, 62, 66, 72, 75, 74, 70, 72];
// the same in JS, for the ground under the camera
export function iceSheetH(body, dir, h) {
  const ice = body.iceAge || 0; if (ice <= 0.05 || ice >= 2.5) return h;
  const lonD = Math.atan2(-(Math.abs(dir[2]) < 1e-9 ? -1e-9 : dir[2]), dir[0]) * 180 / Math.PI;
  const fi = clamp((lonD + 180) / 20, 0, 17.999), ii = Math.floor(fi), f = fi - ii, sm = f * f * (3 - 2 * f);
  const lim = ICE_LIM[ii] + (ICE_LIM[ii + 1] - ICE_LIM[ii]) * sm, edge = 82 + (lim - 82) * Math.pow(Math.min(ice, 1.15), 0.7);
  const d = Math.asin(clamp(dir[1], -1, 1)) * 180 / Math.PI - edge; if (d <= 0) return h;
  const x = Math.min(d / 18, 1), sh = clamp((h + 900) / 500, 0, 1), T = 3300 * Math.min(ice, 1) * Math.pow(Math.max(1 - Math.pow(1 - x, 4 / 3), 0), 3 / 8) * sh * sh * (3 - 2 * sh);
  return Math.max(h, Math.max(h, -200) * 0.3 + T);
}
const DRAW_VS = `
layout(location=0) in vec3 aPos;
${REFRACT_VS}
uniform sampler2D uHeightTex;
uniform mat4 uViewProj; uniform mat3 uRot;
uniform vec3 uCenterRel, uQc, uFaceA, uFaceB;
uniform float uQcLen, uSize, uRadius, uSea, uOcean, uSkirt, uGrid, uTexStep, uOblate; uniform vec3 uShape;
out vec3 vDir; out vec2 vUV; out vec3 vWorld;
${ICE_GLSL}
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
  if (uOcean > 0.5) h = iceSheetH(normalize(dir), h);
  vec3 local = uRadius*dd + dir*(h - aPos.z*uSkirt);
  local.y *= 1. - uOblate;
  local *= uShape;     // triaxial bodies (asteroids, small moons)
  vWorld = uRot*local + uCenterRel;
  vDir = dir; vUV = uv;
  gl_Position = uViewProj*vec4(refractLift(vWorld), 1.);
  logDepth();
}`;

export const LIGHT_UNIFORMS = `
uniform int uNumLights; uniform vec3 uLightPos[3]; uniform vec3 uLightCol[3]; uniform float uLightRad[3];
uniform int uNumOcc; uniform vec4 uOcc[6];
uniform float uHasRings, uRingIn, uRingOut, uRingFade; uniform vec3 uRingN, uPlanetRel; uniform sampler2D uRingTex;
// fraction of light i visible from world point p (camera relative), accounting for eclipses by other bodies
// set by eclipse(): fraction of the light hidden by bodies with an atmosphere (refracted, reddened light fills their umbra)
float gEclAtm = 0., gEclEdge = 0.;
float eclipse(vec3 p, int i){
  vec3 L = uLightPos[i] - p; float dl = length(L); L /= dl;
  float as = uLightRad[i]/dl, vis = 1.;
  gEclAtm = 0.;
  for (int k = 0; k < uNumOcc; k++) {
    vec3 O = uOcc[k].xyz - p; float d = length(O);
    if (d > dl*0.999) continue;     // also skips the light's own body (planetshine sources)
    float ao = abs(uOcc[k].w)/d;
    vec3 On = O/d; float sep = atan(length(cross(On, L)), dot(On, L));   // precise for tiny angles (acos is not)
    float cover = smoothstep(as + ao, abs(ao - as), sep) * min(1., (ao*ao)/(as*as));
    if (uOcc[k].w < 0.) { gEclAtm = max(gEclAtm, cover); gEclEdge = clamp(sep/max(ao - as, 1e-6), 0., 1.); }
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
  float op = 1. - pow(1. - min(texture(uRingTex, vec2((r - uRingIn)/(uRingOut - uRingIn), 0.5)).a, 0.999), uRingFade);
  return 1. - op*clamp(0.6/max(abs(dn), 0.25), 0., 1.);
}
`;

const DRAW_FS = `
in vec3 vDir; in vec2 vUV; in vec3 vWorld;
uniform sampler2D uHeightTex, uNormTex, uAlbTex, uIrrLUT, uParentH, uGParentH; uniform vec3 uParentUV, uGParentUV;
uniform sampler3D uNoise3;
uniform mat3 uRot;
uniform vec3 uFaceA;
uniform float uPixAngle;
uniform float uTexSize, uSea, uOcean, uExposure, uRadius, uLunar, uSpec, uTime, uChunkM, uHasAtmo, uStarT, uStarRad, uEmisScale, uLavaT, uWaterKind, uHeatT, uHeatK;
uniform vec2 uDetailO; uniform float uChunkA;
uniform int uKind; uniform vec2 uCaps, uSeaIce; uniform vec4 uImpact; uniform float uImpactK; uniform vec4 uScars[6]; uniform int uNumScars; uniform float uMariaFill;
${ICE_GLSL}
uniform samplerCube uCloudMap; uniform mat3 uCloudRotInv; uniform float uHasClouds, uCloudAlt, uShadows, uCloudTime;
// the whole body's measured height map (Earth today, the Moon, Mars), for shadows longer than the tiles reach
uniform sampler2D uGlobH; uniform vec2 uGlobHRange; uniform float uHasGlobH;
float globH(vec3 n){ vec2 uv = vec2(atan(-n.z, n.x)*0.15915494 + 0.5, 0.5 - asin(clamp(n.y, -1., 1.))*0.31830989); ivec2 sz = textureSize(uGlobH, 0);
  vec3 c = texelFetch(uGlobH, ivec2(uv*vec2(sz)) % sz, 0).rgb; return mix(uGlobHRange.x, uGlobHRange.y, (c.r*65280. + c.g*255.)/65535.); }
${WEATHER_GLSL}
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
  // impact scars on a giant planet (Shoemaker-Levy 9 on Jupiter, 1994): dark debris clouds that spread and fade
  for (int i = 0; i < 6; i++) {
    if (i >= uNumScars) break;
    float ang = acos(clamp(dot(dir, uScars[i].xyz), -1., 1.)), w = uScars[i].w;
    if (w > 0.) { float rr = 0.07 + 0.22*w, ring = exp(-pow((ang - rr*0.9)/(rr*0.25), 2.))*0.4; alb.rgb *= 1. - 0.8*(exp(-pow(ang/(rr*0.6), 2.)) + ring)*(1. - 0.7*w); }
  }
  // (the Moon before its maria: the dark basalt plains erupted 3.9-3.1 Gyr ago; earlier it was all bright highland)
  if (uMariaFill < 1. && uKind == 0) { float lm = dot(alb.rgb, vec3(0.3, 0.55, 0.15)); alb.rgb = mix(alb.rgb, max(alb.rgb, vec3(0.16, 0.155, 0.15)*(0.85 + 0.3*texture(uNoise3, normalize(vDir)*9.).r)), (1. - uMariaFill)*smoothstep(0.14, 0.05, lm)); }
  if (uKind == 0) {
    vec3 nt = texture(uNormTex, tuv).rgb; vec2 nn = nt.rg; aoT = nt.b;
    vec3 T1 = normalize(uFaceA - dir*dot(dir, uFaceA)), T2 = cross(dir, T1);
    N = normalize(uRot*(dir*sqrt(max(0., 1. - dot(nn, nn))) + T1*nn.x + T2*nn.y));
    if (uOcean > 0.5) { float h = heightAt(vUV); depth = uSea - h; water = smoothstep(0., 0.4, depth);
      // ice ages: the sea falls as water is locked up in ice sheets, exposing the continental shelves
      if (uIceAge.y > 0. && water > 0.) {
        float ex = smoothstep(-uIceAge.y - 8., -uIceAge.y + 8., h)*water;
        float latS = abs(dir.y);
        vec3 shelf = mix(vec3(0.045, 0.07, 0.03), vec3(0.17, 0.15, 0.1), smoothstep(0.35, 0.75, latS));   // forest to steppe-tundra
        alb.rgb = mix(alb.rgb, shelf*(0.85 + 0.3*texture(uNoise3, dir*3.1).r), ex); water *= 1. - ex; depth *= 1. - ex;
      }
    }
    if (uImpact.w > 0.) {
      // after a giant asteroid impact (Chicxulub): soot from global wildfires and the impact spreads around the planet
      // within days and darkens it for years (impact winter)
      float angI = acos(clamp(dot(dir, uImpact.xyz), -1., 1.)), ageH = uImpact.w;
      float front = min(3.2, 0.25 + ageH/24.*0.35), nzs = (texture(uNoise3, dir*2.7).r - 0.5)*0.5;
      float soot = smoothstep(front + 0.2, front - 0.3, angI + nzs)*smoothstep(2., 30., ageH)*exp(-ageH/(24.*365.*4.));
      alb.rgb *= 1. - 0.8*soot; water *= 1. - 0.6*soot;
    }
    if (uSeaIce.x < 90. && water > 0.) {
      // seasonal sea ice over open water, with leads and a ragged edge
      float latI = degrees(asin(clamp(dir.y, -1., 1.))), nzi = (texture(uNoise3, dir*3.1).r - 0.5)*5. + (texture(uNoise3, dir*11.).g - 0.5)*2.;
      float ci = max(smoothstep(-1., 1., latI + nzi - uSeaIce.x), smoothstep(-1., 1., uSeaIce.y - latI - nzi))*(0.75 + 0.25*texture(uNoise3, dir*40.).b);
      alb.rgb = mix(alb.rgb, vec3(0.55, 0.6, 0.66), ci*water); water *= 1. - ci; depth *= 1. - ci;
    }
    if (uCaps.x < 90.) {
      // seasonal frost caps (Mars): bright CO2 frost poleward of the current edge, ragged at the margin
      float latC = degrees(asin(clamp(dir.y, -1., 1.))), nzc = (texture(uNoise3, dir*2.3).r - 0.5)*6.;
      float cc = max(smoothstep(-1.5, 1.5, latC + nzc - uCaps.x), smoothstep(-1.5, 1.5, uCaps.y - latC - nzc));
      alb.rgb = mix(alb.rgb, vec3(0.62, 0.62, 0.64)*(0.9 + 0.2*texture(uNoise3, dir*17.).g), cc*0.9);
    }
    if (uIceAge.x > 0.) {
      // ice sheets at their Last Glacial Maximum extent (Laurentide, Cordilleran, Fennoscandian, Barents-Kara,
      // Patagonian), growing from the high latitudes as ice volume builds
      float lonD = degrees(atan(-(abs(dir.z) < 1e-9 ? -1e-9 : dir.z), dir.x)), latD = degrees(asin(clamp(dir.y, -1., 1.)));
      float nz = (texture(uNoise3, dir*1.7).r - 0.5)*5. + (texture(uNoise3, dir*7.).g - 0.5)*2.;
      float latT = iceEdgeLat(dir) + water*6.;
      float cov = smoothstep(-0.8, 0.8, latD + nz - latT);
      // Patagonian ice cap along the southern Andes
      cov = max(cov, smoothstep(-0.8, 0.8, mix(-56., -39., min(uIceAge.x, 1.)) - latD + nz*0.5)*smoothstep(-77., -74., lonD)*smoothstep(-68., -71., lonD)*step(0.05, uIceAge.x));
      cov *= smoothstep(0., 0.05, uIceAge.x);
      // Snowball Earth: sea ice and glaciers to the equator (a little open slush water in the tropics)
      if (uIceAge.x > 2.5) cov = max(cov, smoothstep(2., 10., abs(latD) + nz*2.));
      vec3 iceC = vec3(0.72, 0.77, 0.84)*(0.92 + 0.16*texture(uNoise3, dir*23.).b);
      alb.rgb = mix(alb.rgb, iceC, cov); water *= 1. - cov; depth *= 1. - cov;
      N = normalize(mix(N, uRot*dir, cov*0.85*step(uIceAge.x, 2.5)));     // (the ice surface is smooth)
    }
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
    // light refracted through the occluder's atmosphere: deep red, ~1e-4 of direct sunlight (Danjon 2-3)
    if (i == 0) lc += uLightCol[i]*gEclAtm*mix(vec3(1.0, 0.18, 0.04)*0.6e-4, vec3(1.0, 0.35, 0.12)*3e-4, gEclEdge*gEclEdge);
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
        float cov = wxCube(uCloudMap, pl).r;
        // same cloud cells as the volumetric layer, so shadows fall where the clouds are
        float day = uCloudTime/86400.;
        float S = textureLod(uNoise3, pl/52000. + 0.53 + vec3(10., 0., 3.)*day, 0.).r*0.5 + textureLod(uNoise3, pl/15000. + 0.21 + vec3(30., 0., 11.)*day, 0.).g*0.33 + textureLod(uNoise3, pl/5200. + 0.7 + vec3(100., 0., 37.)*day, 0.).b*0.17;
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
      // march towards the sun through this tile, then its parent and grandparent (2x and 4x larger, coarser)
      // (and beyond, over the global height map: low sun throws mountain shadows tens to hundreds of km long)
      int nk = uHasGlobH > 0.5 ? 34 : 22;
      for (int k = 0; k < 34; k++) {
        if (k >= nk) break;
        float dm = s*texel;
        vec2 uv2 = vUV + sl*dm/uChunkM;
        float hk;
        if (all(greaterThanEqual(uv2, vec2(0.))) && all(lessThanEqual(uv2, vec2(1.)))) hk = texelFetch(uHeightTex, ivec2(uv2*(uTexSize - 1.) + 0.5), 0).r;
        else {
          vec2 up1 = uParentUV.xy + uv2*uParentUV.z;
          if (all(greaterThanEqual(up1, vec2(0.))) && all(lessThanEqual(up1, vec2(1.)))) hk = texelFetch(uParentH, ivec2(up1*(uTexSize - 1.) + 0.5), 0).r;
          else {
            vec2 up2 = uGParentUV.xy + uv2*uGParentUV.z;
            if (any(lessThan(up2, vec2(0.))) || any(greaterThan(up2, vec2(1.)))) {
              if (uHasGlobH < 0.5 || dm > 4e5) break;
              hk = globH(normalize(dir + (t1*sl.x + t2*sl.y)*dm/(uRadius*max(length(sl), 1e-3))));
            } else hk = texelFetch(uGParentH, ivec2(up2*(uTexSize - 1.) + 0.5), 0).r;
          }
        }
        hk -= dm*dm/(2.*uRadius);
        float rayH = h0 + lz*dm/max(length(sl), 1e-3);
        occ = max(occ, (hk - rayH)/(dm*min(0.06, 600./dm + 0.012) + texel*0.35));   // (penumbra: the Sun is 0.0093 rad across)
        s *= 1.38;
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
  // thermal glow of a surface heated by a giant Sun (dull red at ~1000 K, orange as rock melts)
  if (uHeatT > 700.) {
    // a glowing surface is patchy: cooler crust floats on hotter melt (visible light rises ~ T^11 in this range)
    float pn = texture(uNoise3, dir*1.3).r*0.6 + texture(uNoise3, dir*4.1).g*0.4;
    float tl = uHeatT*(0.9 + 0.2*pn), k = pow(tl/uHeatT, 11.);
    vec3 hc = bbColor(tl); col += hc/max(dot(hc, vec3(0.2126, 0.7152, 0.0722)), 1e-6) * uHeatK * k * 0.8;
  }
  // the impact itself: a fireball for minutes, an ejecta plume for hours, and the whole sky glowing as ejecta
  // re-enter the atmosphere around the globe an hour or so later
  if (uImpact.w > 0. && uImpact.w < 24.) {
    float angI = acos(clamp(dot(normalize(vDir), uImpact.xyz), -1., 1.)), ageH = uImpact.w;
    float f1 = exp(-ageH/0.05)*exp(-pow(angI/0.03, 2.))*300., f2 = exp(-ageH/3.)*exp(-pow(angI/(0.05 + 0.5*min(ageH, 1.)), 2.))*12.;
    float f3 = smoothstep(0.3, 1., ageH)*exp(-max(ageH - 1., 0.)/2.)*0.15;
    col += (vec3(1., 0.55, 0.25)*(f1 + f2) + vec3(0.9, 0.28, 0.08)*f3)*uImpactK;
  }
  oColor = vec4(min(col*uExposure, vec3(60000.)), 1.);
}`;


// ---------------- trees: instanced cylindrical billboards on a world-fixed lattice ----------------
const TREE_SP = 9;          // lattice spacing in metres (one candidate per cell)
const TREE_VS = `
layout(location=0) in vec2 aCorner;
uniform sampler2D uHeightTex, uAlbTex, uNormTex;
uniform mat4 uViewProj; uniform mat3 uRot;
uniform vec3 uCenterRel, uQc, uFaceA, uFaceB;
uniform float uQcLen, uSize, uRadius, uSea, uOcean, uTexSize;
uniform vec2 uOff, uStep; uniform ivec2 uBase; uniform int uNX; uniform float uRange;
${ICE_GLSL}
out vec2 vC; out vec3 vCol; out vec3 vUp; out vec3 vWorld; out float vKind; out vec3 vRight; out float vSeed;
${LOGDEPTH_VS}
uint th(ivec2 c, uint s){ uint h = uint(c.x)*0x8da6b343u ^ uint(c.y)*0xd8163841u ^ s*0x9e3779b9u; h ^= h >> 15; h *= 0x2c1b3c6du; h ^= h >> 12; return h; }
float tr(uint h){ return float(h & 0xffffu)/65535.; }
void main(){
  int i = gl_InstanceID; ivec2 cell = ivec2(i % uNX, i / uNX);
  ivec2 g = uBase + cell;
  uint h = th(g, 7u);
  vec2 jit = vec2(tr(h), tr(h >> 16));
  vec2 uv = uOff + (vec2(cell) + jit)*uStep;
  vec2 tuv = (uv*(uTexSize - 1.) + 0.5)/uTexSize;
  vec4 alb = texture(uAlbTex, tuv); vec3 c = alb.rgb*alb.rgb;
  float hgt = texelFetch(uHeightTex, ivec2(clamp(uv, 0., 1.)*(uTexSize - 1.) + 0.5), 0).r;
  vec2 nn = texture(uNormTex, tuv).rg;
  // forest where the ground is green and fairly dark, not too steep, above water
  float green = clamp((c.g - max(c.r, c.b))*14. + 0.2, 0., 1.) * smoothstep(0.2, 0.05, c.g + c.r);
  float steep = length(nn);
  float keep = green*smoothstep(0.55, 0.3, steep)*step(uSea + 1., hgt);
  float r2 = tr(th(g, 11u));
  // stands and clearings: smooth value noise over the lattice (~150 m patches)
  vec2 gp = vec2(g)/16.; ivec2 gi = ivec2(floor(gp)); vec2 gf = fract(gp); gf = gf*gf*(3. - 2.*gf);
  float n00 = tr(th(gi, 23u)), n10 = tr(th(gi + ivec2(1, 0), 23u)), n01 = tr(th(gi + ivec2(0, 1), 23u)), n11 = tr(th(gi + ivec2(1, 1), 23u));
  float stand = mix(mix(n00, n10, gf.x), mix(n01, n11, gf.x), gf.y);
  keep *= smoothstep(0.25, 0.55, stand);
  if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.))) || r2 > keep) { gl_Position = vec4(2., 2., 2., 1.); return; }
  // position on the sphere (same construction as the terrain)
  vec3 delta = ((uv.x - 0.5)*uSize)*uFaceA + ((uv.y - 0.5)*uSize)*uFaceB;
  float s2 = (2.*dot(uQc, delta) + dot(delta, delta))/(uQcLen*uQcLen);
  float sq = sqrt(1. + s2); float k = -s2/(sq*(1. + sq));
  vec3 cdir = uQc/uQcLen, dd = cdir*k + delta/(uQcLen*sq), dir = cdir + dd;
  // no forest on (or right at the edge of) an ice-age ice sheet
  if (uIceAge.x > 0.05 && degrees(asin(clamp(normalize(dir).y, -1., 1.))) > iceEdgeLat(normalize(dir)) - 2.5) { gl_Position = vec4(2., 2., 2., 1.); return; }
  vec3 local = uRadius*dd + dir*hgt;
  vec3 base = uRot*local + uCenterRel;
  vec3 up = normalize(uRot*dir);
  float H = mix(8., 24., tr(th(g, 13u)))*(0.6 + 0.6*green);
  // conifers in cold/high places (bluish dark greens), broadleaf elsewhere
  float conifer = step(0.55, tr(th(g, 17u)) + (c.b - c.r)*6. + 0.25);
  float W = H*(conifer > 0.5 ? 0.22 : 0.38);
  // fade out towards the end of the tree range so there is no visible edge
  if (r2 > keep*smoothstep(uRange, uRange*0.6, length(base))) { gl_Position = vec4(2., 2., 2., 1.); return; }
  vec3 toCam = normalize(-base); vec3 right = normalize(cross(up, toCam));
  vec3 w = base + right*aCorner.x*W + up*(aCorner.y*0.5 + 0.5)*H;
  vC = vec2(aCorner.x, aCorner.y*0.5 + 0.5); vUp = up; vRight = right; vWorld = w; vKind = conifer; vSeed = tr(th(g, 29u));
  vCol = mix(c*vec3(0.55, 0.7, 0.5), vec3(0.025, 0.045, 0.02), 0.5)*mix(0.75, 1.25, tr(th(g, 19u)));
  gl_Position = uViewProj*vec4(w, 1.); logDepth();
}`;
const TREE_FS = `
in vec2 vC; in vec3 vCol; in vec3 vUp; in vec3 vWorld; in float vKind; in vec3 vRight; in float vSeed;
uniform float uExposure; uniform sampler2D uIrrLUT; uniform float uHasAtmo;
${LIGHT_UNIFORMS}
${LOGDEPTH_FS}
out vec4 o;
void main(){
  // silhouette: trunk plus crown (cone for conifers, ellipsoid for broadleaf), with ragged edges
  float x = vC.x, y = vC.y;
  // leaf clusters: a cheap cellular pattern inside the crown, varied per tree
  vec2 lc = vec2(x*5., y*9.) + vSeed*17.; vec2 li = floor(lc), lf = fract(lc) - 0.5;
  float cl = 1. - clamp(length(lf + (fract(sin(dot(li, vec2(12.9898, 78.233)))*vec2(43758.5, 24634.6)) - 0.5)*0.6)*1.6, 0., 1.);
  float rag = 0.8 + 0.2*sin(y*37. + x*13. + vSeed*30.)*sin(x*29. - y*17.) + 0.12*(cl - 0.5);
  float crown, cx;
  if (vKind > 0.5) { float hw = (1. - y)*0.95*rag; crown = step(0.12, y)*step(abs(x), hw); cx = x/max(hw, 0.05); }
  else { vec2 q = vec2(x/0.95, (y - 0.58)/0.42); crown = step(dot(q, q), rag); cx = q.x; }
  float trunk = step(abs(x), 0.07)*step(y, 0.3);
  if (crown < 0.5 && trunk < 0.5) discard;
  logDepth();
  // pseudo normal of a round crown, lit by the sun with wrap and self shadow towards the bottom
  vec3 Vv = normalize(-vWorld), side = vRight;
  vec3 n = normalize(side*cx + Vv*sqrt(max(1. - cx*cx, 0.)) + vUp*(y - 0.45)*0.8);
  vec3 col = vec3(0.);
  for (int i = 0; i < uNumLights; i++) {
    vec3 L = normalize(uLightPos[i] - vWorld);
    float mus = dot(vUp, L);
    float dif = max(dot(n, L)*0.8 + 0.2, 0.)*smoothstep(-0.05, 0.1, mus)*(0.55 + 0.6*cl);
    vec3 amb = uHasAtmo > 0.5 ? texture(uIrrLUT, vec2(mus*0.5 + 0.5, 0.5)).rgb*uLightCol[i] : vec3(0.);
    float occl = mix(0.35, 1., y)*(0.7 + 0.4*cl);
    col += (crown > 0.5 ? vCol : vec3(0.05, 0.035, 0.02))*(uLightCol[i]*dif*0.8*(i == 0 ? eclipse(vWorld, 0) : 1.) + amb*occl)/3.14159;
  }
  o = vec4(min(col*uExposure, vec3(60000.)), 1.);
}`;
let progTree = null, treeVAO = null;
export function initTreeProgram() { if (!progTree) { progTree = new Program('trees', TREE_VS, TREE_FS); treeVAO = makeVAO([{ data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), size: 2, loc: 0 }]); } }
function drawTrees(body, st, draws, o, R, rot3) {
  if (!cfg.trees) return;
  initTreeProgram();
  const p = progTree.use();
  let bound = false;
  // camera position in face coordinates, to restrict each tile's lattice to the part within range
  const camL = Q.rot(Q.conj(o.rotQ), V.mul(o.rel, -1));
  const RANGE = cfg.treeRange;
  let budget = cfg.treeBudget;
  const near = draws.slice().sort((x, y) => V.len(x.cRel) - V.len(y.cRel));
  for (const d of near) {
    const ch = d.ch, sizeM = d.sizeM;
    if (sizeM > 2000 || V.len(d.cRel) > RANGE + sizeM) continue;
    const F = FACES[ch.face];
    const dn = V.dot(camL, F.N); if (dn <= 0) continue;
    const ca = V.dot(camL, F.A) / dn, cb = V.dot(camL, F.B) / dn;
    // lattice in face coordinates (a, b) with spacing ~TREE_SP metres; base indices in double precision
    const step = TREE_SP / (R / ch.qlen), rng = RANGE / (R / ch.qlen);
    const a0 = Math.max(ch.a0, ca - rng), a1 = Math.min(ch.a0 + ch.size, ca + rng), b0 = Math.max(ch.b0, cb - rng), b1 = Math.min(ch.b0 + ch.size, cb + rng);
    if (a1 <= a0 || b1 <= b0) continue;
    const ia0 = Math.floor(a0 / step), ib0 = Math.floor(b0 / step);
    const nx = Math.min(220, Math.ceil((Math.max(a1 - a0, b1 - b0)) / step) + 1);
    if (nx * nx > budget) break;
    budget -= nx * nx;
    if (!bound) {
      p.set(Object.assign({ uViewProj: o.viewProj, uFcoef: o.fcoef, uRot: rot3, uRadius: R, uSea: (st.surf.sea || 0) + (body.seaRise || 0), uOcean: st.surf.ocean || 0, uTexSize: cfg.T, uExposure: o.exposure, uHasAtmo: o.atmoLUT ? 1 : 0, uIrrLUT: o.atmoLUT ? o.atmoLUT.irr : dummyTex(), uRange: RANGE, uIceAge: body.iceAge ? [body.iceAge, 0] : [0, 0] }, o.light));
      gl.bindVertexArray(treeVAO.vao); gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true); bound = true;
    }
    p.set({ uHeightTex: ch.tex.h, uAlbTex: ch.tex.a, uNormTex: ch.tex.n, uCenterRel: d.cRel, uQc: ch.qc, uQcLen: ch.qlen, uFaceA: F.A, uFaceB: F.B, uSize: ch.size,
      uOff: [(ia0 * step - ch.a0) / ch.size, (ib0 * step - ch.b0) / ch.size], uStep: [step / ch.size, step / ch.size], uBase: [ia0 % 1000003, ib0 % 1000003], uNX: nx });
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nx * nx);
  }
}

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
      uHRange: (this.body.maps && this.body.maps.hRange) || [0, 1], uMapOct: mapOct, uMapDetail: this.body.radius / Math.pow(2, mapOct) / s.freq * 0.02, uMapTint: mapTint(this.body, mp), uSeason: this.body.seasonal && mp ? (this.season = this.body.season || 0) : -2, uMapCurve: this.body.maps && this.body.maps.curve === 'bmng' ? 1 : 0,
      uClimate: (this.climate = this.body.climate || null) ? [this.climate.dry, this.climate.life, this.climate.ice] : [0, 1, 1],
      uCraterO0: mp && mp.height ? mapOct : 2 });
    // drifting continents (Earth): the plate map loads the first time it is needed
    const drift = this.body.drift || 0, pm = mp && this.body.maps.plates ? loadTexture(this.body.maps.plates, 'data') : null, dOn = !!(drift && pm && pm.ready);
    // the deep past: whole paleogeographic maps instead
    const pal = this.body.paleoMap > 0 && mp ? paleoState(this.body.paleoMap) : null;
    // (the turn this tile set was created for: the staleness check compares against it, so it must not change here)
    const pr = pal ? (this.paleoRot !== undefined ? this.paleoRot : this.body.paleoRot || 0) : 0, pc = Math.cos(pr), ps = Math.sin(pr);
    this.paleoMyr = pal ? pal.myr : 0;
    this.drift = dOn && !pal ? drift : 0;
    prog.set({ uDrift: this.drift, uPlates: dOn && !pal ? pm.tex : dummyTex(), uPlateInv: plateInverse(this.drift),
      uPaleo: pal ? 1 : 0, uPaleoK: pal ? pal.k : 0, uPalA: pal ? pal.a : dummyTex(), uPalB: pal ? pal.b : dummyTex(), uPalRot: new Float32Array([pc, 0, ps, 0, 1, 0, -ps, 0, pc]), uPaleoClim: [pal && this.body.meanT ? this.body.meanT - 287.6 : 0, pal ? paleoSeaRise(this.body.paleoMyr) : 0] });
    prog.set({ uOF: this.OF, uOC: this.OC, uOMax: oMax, uFreq: s.freq, uAniso: this.aniso, uFaceA: F.A, uFaceB: F.B, uQc: ch.qc, uQcLen: ch.qlen, uSize: ch.size, uTexel: texel, uRadius: this.body.radius, uTexSize: texSize });
    if (s.gen === 'terra') prog.set({ uContAmp: s.contAmp, uMtnAmp: s.mtnAmp, uHillAmp: s.hillAmp, uWarp: s.warp, uSea: s.sea, uOcean: s.ocean, uCrater: s.crater, uCraterAmp: s.craterAmp, uMaria: s.maria, uCracks: s.cracks, uDunes: s.dunes, uVolcano: s.volcano, uLava: s.lava, uVeg: s.veg, uIceLat: s.iceLat, uSnowLine: s.snowLine, uTempEq: s.tempEq, uCity: s.city,
      uColA: s.colA, uColB: s.colB, uColRock: s.colRock, uColLow: s.colLow, uColIce: s.colIce, uColVeg1: s.colVeg1, uColVeg2: s.colVeg2, uColSand: s.colSand, uColCrack: s.colCrack });
    else if (s.gen === 'gas') prog.set({ uPal: new Float32Array(s.pal.flat()), uBands: s.bands, uBandStr: s.bandStr, uTurb: s.turb, uStorms: s.storms, uGasSeed: s.seed[0], uSpotWarp: this.grsK && mp && mp.color ? [0.3687, 0.6177, this.grsK] : [0, 0, 0] });
    else prog.set({ uSpots: s.spots || 0, uGranOct: s.gran ? s.gran + 1 : clamp(Math.round(Math.log2(this.body.radius / 1.4e6)), 4, 12) });
  }
  bake(ch) {
    const prog = progGen[this.surf.gen].use();
    ch.tex = allocTex();
    // a recycled tile texture may still sit on a texture unit from an earlier draw: rendering into it while it is
    // bound is a feedback loop that drops the draw
    unbindTextures();
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

// city lights belong to an era: electric lighting spread from the 1880s; today's map is not extrapolated centuries ahead
export function cityEra(t) { const y = 2000 + t / 31557600; return Math.max(0, Math.min(1, (y - 1880) / 70)) * Math.max(0, Math.min(1, 1 - (y - 2200) / 300)); }
// visible radiance of a blackbody surface at T, in units of the solar constant per steradian (luminance weighted)
export function heatGlow(T) {
  // fraction of sigma T^4 in the visible band (approximate Planck integral over 400-700 nm) and photopic weight
  let vis = 0; for (let l = 400e-9; l < 700e-9; l += 25e-9) vis += 3.7418e-16 / (l ** 5 * (Math.exp(0.014388 / (l * T)) - 1)) * 25e-9;
  return vis / Math.PI / 1361 * 0.8;
}
const states = new Map();
export function planetState(body) {
  init();
  let s = states.get(body.uid);
  const maps = bodyMaps(body);
  if (s && s.mapsVersion !== (body.mapsVersion || 0)) { if (s.prev) s.prev.dispose(); s.dispose(); states.delete(body.uid); s = null; }
  // Surfaces that change with time (seasons, the Sun's evolution, drifting continents) are rebaked. The old tiles
  // stay on screen until the new set has caught up, so a rebake never shows as a blurry flash.
  let stale = false;
  const age = s ? performance.now() - (s.born || 0) : 0;
  if (s && body.seasonal && s.maps && Math.abs((body.season || 0) - (s.season || 0)) > 0.12 && age > 4000) stale = true;
  if (s && age > 3000 && (body.climate || s.climate)) { const a = body.climate || { dry: 0, life: 1, ice: 1 }, b = s.climate || { dry: 0, life: 1, ice: 1 }; if (Math.abs(a.dry - b.dry) > 0.08 || Math.abs(a.life - b.life) > 0.1 || Math.abs(a.ice - b.ice) > 0.1) stale = true; }
  if (s && body.kind === 'star' && s.bakeR && Math.abs(Math.log(body.radius / s.bakeR)) > 0.35 && age > 1500) stale = true;
  if (s && body.kind === 'star' && body.surface && Math.abs((body.surface.spots || 0) - (s.bakeSpots || 0)) > 0.2 && age > 5000) stale = true;
  if (s && body.drift !== undefined && s.maps && Math.abs((body.paleoMap > 0 ? 0 : body.drift) - (s.drift || 0)) > 0.2 && age > 1500) stale = true;
  const palNow = body.paleoMap > 0 && maps ? (paleoState(body.paleoMap) || { myr: 0 }).myr : 0;
  if (s && s.maps && body.paleoMap !== undefined && (Math.abs(palNow - (s.paleoMyr || 0)) > 0.6 || Math.abs((body.paleoRot || 0) - (s.paleoRot || 0)) > 0.01) && age > 1500) stale = true;
  if (s && body.grsK !== undefined && Math.abs(body.grsK - (s.grsK || 1)) > 0.03 && age > 1500) stale = true;     // (Jupiter's Great Red Spot)
  if (stale && s.prev) { s.prev.dispose(); s.prev = null; }        // (still catching up from the last one: skip it)
  const prev = stale ? s : null; if (stale) s = null;
  if (!s) { s = new PlanetState(body); s.maps = maps; s.bakeR = body.radius; s.bakeSpots = body.surface ? body.surface.spots || 0 : 0; s.mapsVersion = body.mapsVersion || 0; s.born = performance.now(); s.season = body.season || 0; s.paleoMyr = palNow; s.paleoRot = body.paleoRot || 0; s.grsK = body.grsK; s.prev = prev; states.set(body.uid, s); }
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
  const shp = body.shape || [1, 1, 1];
  if (body.shape) { camLocal[0] /= shp[0]; camLocal[1] /= shp[1]; camLocal[2] /= shp[2]; }
  const camDist = V.len(camLocal), camDir = V.mul(camLocal, 1 / camDist);
  const hmax = surf.hmax || 0, hmin = surf.hmin || 0;
  const Rmin = R + hmin, alt = Math.max(camDist - (R + st.groundH), 0.5);
  const horizon = Math.acos(clamp(Rmin / Math.max(camDist, Rmin + 1), -1, 1)) + Math.acos(clamp(Rmin / (R + hmax + 1), -1, 1));
  const rot3 = Q.mat3(o.rotQ);
  // telephoto views would otherwise ask for unbounded detail: LOD saturates below a ~6 degree field of view
  const K = 1.45 * cfg.T / Math.min(o.pxPerRad, o.pxPerRadMax || o.pxPerRad) / (cfg.lodScale * cfg.autoLod);
  let draws = [], S = st, noQueue = false, incomplete = false;
  const visit = (ch) => {
    ch.last = frame;
    // horizon cull
    const ang = Math.acos(clamp(V.dot(ch.c, camDir), -1, 1));
    if (ang - ch.angRad > horizon) return;
    // frustum cull using bounding sphere
    const sizeM = ch.size * R * (1 / ch.qlen);
    const cW = Q.rot(o.rotQ, [ch.c[0] * R * shp[0], ch.c[1] * R * (1 - (body.oblate || 0)) * shp[1], ch.c[2] * R * shp[2]]);
    const cRel = [cW[0] + o.rel[0], cW[1] + o.rel[1], cW[2] + o.rel[2]];
    const brad = ch.angRad * R * Math.max(shp[0], shp[1], shp[2]) + Math.max(hmax, -hmin);
    if (ch.level > 0 && !o.sphereVisible(cRel, brad)) return;
    // distance to nearest point of tile
    const F = FACES[ch.face];
    const dn = V.dot(camDir, F.N);
    let dist;
    if (dn > 0.01) {
      const a = clamp(V.dot(camDir, F.A) / dn, ch.a0, ch.a0 + ch.size), b = clamp(V.dot(camDir, F.B) / dn, ch.b0, ch.b0 + ch.size);
      const q = V.norm([F.N[0] + a * F.A[0] + b * F.B[0], F.N[1] + a * F.A[1] + b * F.B[1], F.N[2] + a * F.A[2] + b * F.B[2]]);
      const rr = R + S.groundH;
      dist = Math.hypot(camLocal[0] - q[0] * rr, camLocal[1] - q[1] * rr, camLocal[2] - q[2] * rr);
    } else dist = Math.max(V.len(cRel) - ch.angRad * R, 1);
    dist = Math.max(dist, alt, 0.5);
    const split = ch.level < S.maxLevel && sizeM / dist > K;
    if (split) {
      if (!ch.children) { if (noQueue) { draws.push({ ch, cRel, sizeM }); return; } ch.children = []; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) ch.children.push(new Chunk(S, ch.face, ch.level + 1, ch.ix * 2 + i, ch.iy * 2 + j, ch)); }
      let all = true;
      for (const c of ch.children) { c.last = frame; if (!c.ready) { all = false; if (!noQueue && !c.queued) { c.queued = true; queue.push(c); } c.prio = sizeM / dist; } }
      if (all) { for (const c of ch.children) visit(c); return; }
      // (a coarser tile stands in while the finer ones bake; only count it if it is clearly too coarse)
      if (sizeM / dist > K * 1.6) incomplete = true;
    }
    draws.push({ ch, cRel, sizeM });
  };
  // (missing root tiles are baked right here, mid-frame: put the caller's render target back afterwards)
  if (st.roots.some(r => !r.ready)) {
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING), vp = gl.getParameter(gl.VIEWPORT), blend = gl.isEnabled(gl.BLEND), depth = gl.isEnabled(gl.DEPTH_TEST);
    for (const r of st.roots) if (!r.ready) st.bake(r);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    if (blend) gl.enable(gl.BLEND); if (depth) gl.enable(gl.DEPTH_TEST);
  }
  for (const r of st.roots) visit(r);
  // after a rebake, keep drawing the previous tiles until the new ones have caught up (or a few seconds pass)
  let dst = st;
  if (st.prev) {
    if (incomplete && performance.now() - st.born < 5000 && st.prev.roots.every(r => r.ready)) {
      const d1 = draws; draws = []; S = st.prev; noQueue = true; st.prev.last = frame;
      for (const r of st.prev.roots) visit(r);
      dst = st.prev; noQueue = false; void d1;
    } else { st.prev.dispose(); st.prev = null; }
  }
  // draw
  const p = progDraw.use();
  gl.bindVertexArray(gridVAO.vao);
  const atmo = body.atmo && o.atmoLUT;
  p.set(Object.assign({
    uViewProj: o.viewProj, uFcoef: o.fcoef, uRot: rot3, uRadius: R, uSea: body.paleoSea !== undefined ? body.paleoSea : (surf.sea || 0) - (body.climate ? body.climate.dry * 11500 : 0) + (body.seaRise || 0), uOcean: body.paleoSea !== undefined ? 1 : surf.ocean || 0, uGrid: cfg.G, uTexStep: (cfg.T - 1) / cfg.G, uTexSize: cfg.T,
    uOblate: body.oblate || 0, uShape: shp, uExposure: o.exposure, uLunar: surf.lunar === undefined ? 0 : surf.lunar, uSpec: surf.spec || 0, uTime: o.time % 3600, uKind: surf.gen === 'terra' ? 0 : surf.gen === 'gas' ? 1 : 2,
    uHasAtmo: atmo ? 1 : 0, uStarT: body.temp || 5000, uStarRad: o.starRad || 0, uEmisScale: (surf.lava ? 0.06 : 9e-5) * (body.climate ? body.climate.life : 1) * (surf.city ? cityEra(o.time) : 1),
    uIceAge: body.iceAge ? [body.iceAge, 125 * Math.min(body.iceAge, 1.1)] : [0, 0], uMariaFill: body.mariaFill === undefined ? 1 : body.mariaFill, uScars: body.scars ? body.scars.flat() : new Float32Array(24), uNumScars: body.scars ? body.scars.length : 0, uImpact: body.impact || [0, 1, 0, -1], uImpactK: body.impact ? heatGlow(2200) : 0, uCaps: body.caps || [99, -99], uSeaIce: body.seaIce && !(body.climate && body.climate.dry > 0.5) ? body.seaIce : [99, -99], uHeatT: body.heatT || 0, uHeatK: body.heatT ? heatGlow(body.heatT) : 0, uLavaT: surf.lava ? clamp(surf.tempEq || 1300, 1100, 1700) : 0, uWaterKind: body.cls === 'Titan' ? 1 : 0,
    uNoise3: o.noise3, uRefrK: o.refrK || 0, uRefrUp: o.refrUp || [0, 1, 0], uShadows: cfg.shadows ? 1 : 0, uPixAngle: 1 / o.pxPerRad,
  }, o.light));
  if (atmo) p.set(Object.assign({ uTransLUT: o.atmoLUT.trans, uMultiLUT: o.atmoLUT.multi, uIrrLUT: o.atmoLUT.irr }, o.atmoLUT.uniforms));
  const cl = atmo && o.clouds && o.atmoLUT.cloud && body.atmo.clouds.kind !== 'venus' && surf.gen === 'terra';
  // (the measured global height map, only while the surface is today's: no drifted or ancient continents)
  const gmp = st.maps && st.maps.height && st.maps.height.tex && !(body.drift && Math.abs(body.drift) > 0.05) && !(body.paleoMap > 0) && !body.iceAge ? st.maps.height : null;
  p.set({ uHasGlobH: gmp ? 1 : 0, uGlobH: gmp ? gmp.tex : dummyTex(), uGlobHRange: (body.maps && body.maps.hRange) || [0, 1] });
  p.set({ uHasClouds: cl ? 1 : 0, uCloudMap: cl ? o.atmoLUT.cloud : o.dummyCube, uCloudRotInv: cl ? o.cloudRotInv(body, o.rotQ, o.time) : new Float32Array(9), uCloudAlt: cl ? (body.atmo.clouds.base + body.atmo.clouds.top) * 0.4 : 1, uCloudTime: o.time % 86400, uWx: cl ? weatherUniform(body, o.time) : [0, 0, 0, 0] });
  for (const d of draws) {
    const ch = d.ch, F = FACES[ch.face];
    // origin of this tile in metres along the face, wrapped, for stable small scale effects
    const om = [((ch.a0 + 1) * R) % 4096, ((ch.b0 + 1) * R) % 4096];
    // ancestors for long shadows: uv offset and scale of this tile inside its parent and grandparent
    const pa = ch.parent && ch.parent.tex ? ch.parent : ch, ga = pa.parent && pa.parent.tex ? pa.parent : pa;
    const rel = (anc) => { const k = 1 << (ch.level - anc.level); return [(ch.ix - anc.ix * k) / k, (ch.iy - anc.iy * k) / k, 1 / k]; };
    p.set({ uParentH: pa.tex.h, uParentUV: rel(pa), uGParentH: ga.tex.h, uGParentUV: rel(ga) });
    p.set({ uHeightTex: ch.tex.h, uNormTex: ch.tex.n, uAlbTex: ch.tex.a, uCenterRel: d.cRel, uQc: ch.qc, uQcLen: ch.qlen, uFaceA: F.A, uFaceB: F.B, uSize: ch.size, uSkirt: d.sizeM * 0.06, uChunkM: d.sizeM, uChunkA: ch.size * R, uDetailO: om });
    gl.drawElements(gl.TRIANGLES, gridCount, gl.UNSIGNED_INT, 0);
  }
  if (surf.gen === 'terra' && (surf.veg > 0 || (body.maps && st.maps))) drawTrees(body, dst, draws, o, R, rot3);
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
      if (frame - st.last > 900) { if (st.prev) st.prev.dispose(); st.dispose(); states.delete(uid); continue; }
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
