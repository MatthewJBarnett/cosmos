// GLSL for baking planet surface tiles: height, normal and albedo for terrestrial bodies, gas giants and stars.
// Noise is evaluated per octave in tile-local coordinates (integer cell + fraction supplied in double precision
// from the CPU), so detail stays exact from orbital scale down to centimetres.
export const NOCT = 28;

export const GEN_COMMON = `
#define NOCT ${NOCT}
uniform vec3 uOF[NOCT];
uniform ivec3 uOC[NOCT];
uniform int uOMax;
uniform float uFreq;
uniform vec3 uAniso;
uniform vec3 uFaceA, uFaceB, uQc;
uniform float uQcLen, uSize, uTexel, uRadius;
uniform float uTexSize;

uint hashu(ivec3 c, uint seed){
  uint h = uint(c.x)*0x8da6b343u ^ uint(c.y)*0xd8163841u ^ uint(c.z)*0xcb1ab31fu ^ (seed*0x9e3779b9u);
  h ^= h >> 15; h *= 0x2c1b3c6du; h ^= h >> 12; h *= 0x297a2d39u; h ^= h >> 15; return h;
}
vec3 hgrad(ivec3 c, uint seed){ uint h = hashu(c, seed); return vec3(float(h & 1023u), float((h>>10) & 1023u), float((h>>20) & 1023u)) * (1./511.5) - 1.; }
// Gradient noise of octave o. Returns (value, d/dx in lattice units). Value roughly in [-1,1].
vec4 gn(int o, uint seed, vec3 d){
  float f = exp2(float(o)) * uFreq;
  vec3 x = uOF[o] + (d*uAniso)*f;
  vec3 i = floor(x), w = x - i; ivec3 ic = ivec3(i) + uOC[o];
  vec3 u = w*w*w*(w*(w*6.-15.)+10.), du = 30.*w*w*(w*(w-2.)+1.);
  vec3 ga = hgrad(ic, seed), gb = hgrad(ic+ivec3(1,0,0), seed), gc = hgrad(ic+ivec3(0,1,0), seed), gd = hgrad(ic+ivec3(1,1,0), seed);
  vec3 ge = hgrad(ic+ivec3(0,0,1), seed), gf = hgrad(ic+ivec3(1,0,1), seed), gg = hgrad(ic+ivec3(0,1,1), seed), gh = hgrad(ic+ivec3(1,1,1), seed);
  float va = dot(ga, w), vb = dot(gb, w-vec3(1,0,0)), vc = dot(gc, w-vec3(0,1,0)), vd = dot(gd, w-vec3(1,1,0));
  float ve = dot(ge, w-vec3(0,0,1)), vf = dot(gf, w-vec3(1,0,1)), vg = dot(gg, w-vec3(0,1,1)), vh = dot(gh, w-vec3(1,1,1));
  float k0 = va, k1 = vb-va, k2 = vc-va, k3 = ve-va, k4 = va-vb-vc+vd, k5 = va-vc-ve+vg, k6 = va-vb-ve+vf, k7 = -va+vb+vc-vd+ve-vf-vg+vh;
  float v = k0 + u.x*k1 + u.y*k2 + u.z*k3 + u.x*u.y*k4 + u.y*u.z*k5 + u.z*u.x*k6 + u.x*u.y*u.z*k7;
  vec3 dv = ga + u.x*(gb-ga) + u.y*(gc-ga) + u.z*(ge-ga) + u.x*u.y*(ga-gb-gc+gd) + u.y*u.z*(ga-gc-ge+gg) + u.z*u.x*(ga-gb-ge+gf) + u.x*u.y*u.z*(-ga+gb+gc-gd+ge-gf-gg+gh)
          + du*(vec3(k1,k2,k3) + u.yzx*vec3(k4,k5,k6) + u.zxy*vec3(k6,k4,k5) + u.yzx*u.zxy*k7);
  return vec4(v, dv) * 1.35;
}
float fbm(int o0, int o1, uint seed, vec3 d, float gain){
  float s = 0., a = 1.; o1 = min(o1, uOMax);
  for (int o = o0; o <= o1; o++) { s += a*gn(o, seed, d).x; a *= gain; }
  return s;
}
// local offset (direction - tile centre direction) on the unit sphere for cube offset delta, computed without cancellation
vec3 localDir(vec3 delta){
  float s2 = (2.*dot(uQc, delta) + dot(delta, delta)) / (uQcLen*uQcLen);
  float sq = sqrt(1. + s2); float k = -s2/(sq*(1.+sq));
  return (uQc/uQcLen)*k + delta/(uQcLen*sq);
}
`;

// ---- Terrestrial terrain ----
export const GEN_TERRA = `
uniform float uContAmp, uMtnAmp, uHillAmp, uWarp, uSea, uOcean, uCrater, uCraterAmp, uMaria, uCracks, uDunes, uVolcano, uLava, uVeg, uIceLat, uSnowLine, uTempEq, uCity;
uniform vec3 uColA, uColB, uColRock, uColLow, uColIce, uColVeg1, uColVeg2, uColSand, uColCrack;
float gCont, gMtn, gFresh, gMaria, gCrack, gLand, gDune, gFine;

float craterProfile(float t, float big){
  float depth = mix(0.42, 0.16, big), rimH = mix(0.09, 0.05, big);
  float bowl = t < 1. ? -depth*(1. - smoothstep(mix(0.0,0.55,big), 1.0, t)*1.0) * (1.-t*t*(1.-big)) : 0.;
  bowl = t < 1. ? mix(-depth*(1.-t*t), -depth*(1.-smoothstep(0.5,1.,t)), big) : 0.;
  float rim = rimH * (t < 1. ? exp(-pow((1.-t)/0.17, 2.)) : exp(-(t-1.)*3.2));
  float peak = big * 0.12 * exp(-t*t*40.);
  return bowl + rim + peak;
}
float craters(vec3 d){
  float h = 0.; gFresh = 0.;
  int o1 = min(uOMax - 1, 19);
  for (int o = 2; o <= o1; o++) {
    float f = exp2(float(o)) * uFreq;
    vec3 x = uOF[o] + d*f + 0.37;
    vec3 i = floor(x - 0.5), w = x - i; ivec3 ic = ivec3(i) + uOC[o];
    float big = smoothstep(7., 3., float(o));
    for (int c = 0; c < 8; c++) {
      ivec3 cc = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
      uint hs = hashu(ic + cc, 77u);
      if (float(hs & 255u) > 255. * uCrater * 0.55) continue;
      vec3 rnd = vec3(float((hs>>8)&255u), float((hs>>16)&255u), float((hs>>24)&255u)) / 255.;
      float rad = 0.14 + 0.3*rnd.z*rnd.z;
      vec3 cen = vec3(cc) + 0.5 + (rnd - 0.5)*(1. - 2.*rad)*vec3(1.,1.,0.5);
      float t = length(w - cen)/rad;
      if (t < 3.) {
        float age = fract(rnd.x*7.31 + rnd.y*3.7);
        h += craterProfile(t, big) * rad / f * mix(1.0, 0.35, age);
        gFresh += (1.-age)*(1.-age) * exp(-t*t*0.9) * smoothstep(0.7, 0.0, age);
      }
    }
  }
  return h * uRadius * uCraterAmp;
}

float terrain(vec3 d, vec3 P){
  vec3 w = vec3(gn(1,101u,d).x, gn(1,102u,d).x, gn(1,103u,d).x)*0.5;
  if (uOMax >= 3) w += vec3(gn(3,104u,d).x, gn(3,105u,d).x, gn(3,106u,d).x)*0.12;
  vec3 dw = d + w*uWarp;
  float cont = 0., a = 1.;
  for (int o = 0; o <= min(8, uOMax); o++) { cont += a*gn(o, 1u, dw).x; a *= 0.5; }
  cont *= 0.62;
  gCont = cont;
  float base = cont * uContAmp;
  float land = 1.;
  if (uOcean > 0.5) {
    float e = (base - uSea)/uContAmp;
    // continental platforms, shelves and abyssal plains
    float sh = e > 0. ? 0.035 + e*0.42 + e*e*0.8 : -smoothstep(0.0, -0.22, e)*1.25 + e*0.5 - 0.004;
    base = uSea + sh*uContAmp;
    land = smoothstep(-0.02, 0.1, e)*0.9 + 0.1;
  }
  // maria: smooth dark basins
  gMaria = 0.;
  if (uMaria > 0.) {
    float mlev = -0.25 + (1. - uMaria)*0.8;
    gMaria = smoothstep(mlev + 0.07, mlev - 0.07, cont - 0.3*gn(2, 55u, dw).x);
    base = mix(base, (mlev - 0.15)*uContAmp, gMaria*0.9);
  }
  gLand = land;
  // mountain belts
  float mm = 0.;
  if (uOMax >= 2) { mm = gn(2,2u,dw).x; if (uOMax >= 3) mm += 0.5*gn(3,2u,dw).x; if (uOMax >= 4) mm += 0.25*gn(4,2u,dw).x; }
  mm = smoothstep(-0.15, 0.7, mm + 0.3*abs(cont));
  gMtn = mm * land;
  float r = 0., amp = 1., wgt = 1.; vec3 ds = vec3(0.);
  int o1 = min(uOMax, 18);
  for (int o = 4; o <= o1; o++) {
    vec4 n = gn(o, 3u, dw);
    float rn = 1. - abs(n.x); rn *= rn;
    ds += n.yzw * amp * 0.9;
    r += amp * rn * wgt / (1. + dot(ds, ds)*0.6);
    wgt = clamp(rn*1.8, 0., 1.);
    amp *= 0.5;
  }
  float mtn = uMtnAmp * gMtn * (r*0.52 - 0.12) * (1. - gMaria);
  // hills and fine roughness down to the smallest resolvable scale
  float fine = 0.; amp = 1.;
  for (int o = 5; o <= uOMax; o++) { fine += amp*gn(o, 4u, d).x; amp *= 0.54; }
  gFine = fine;
  float rough = (0.25 + 1.3*gMtn + 0.3*abs(cont)) * (1. - 0.8*gMaria);
  float h = base + mtn + fine*uHillAmp*rough;
  // rolling hills at kilometre scales, patchy
  if (uOMax >= 8) {
    float hm = gn(4, 6u, dw).x + 0.6*gn(6, 6u, dw).x;
    hm = 0.18 + smoothstep(-0.3, 0.6, hm) * land;
    float hl = 0.; amp = 1.;
    for (int o = 8; o <= uOMax; o++) { vec4 n = gn(o, 5u, d); hl += amp*(o < 12 ? (1. - abs(n.x))*1.4 - 0.7 : n.x); amp *= 0.5; }
    h += hl * uHillAmp * 0.55 * hm * (1. - 0.85*gMaria);
  }
  // dunes
  gDune = 0.;
  if (uDunes > 0. && uOMax >= 12) {
    float dm = smoothstep(0.05, 0.4, gn(6, 9u, d).x + 0.5*gn(8, 9u, d).x) * (1.-gMtn) * land;
    if (dm > 0.) {
      int od = int(clamp(round(log2(uRadius/(uFreq*900.))), 10., 20.));
      float dn = 0.; if (uOMax >= od) { float q = 1. - abs(gn(od, 12u, d).x); dn = q*q; if (uOMax >= od+2) dn += 0.2*(1.-abs(gn(od+2, 12u, d).x)); }
      gDune = dm;
      h += dm * dn * uRadius/(exp2(float(od))*uFreq) * 0.22 * uDunes;
    }
  }
  // tectonic cracks / lineae
  gCrack = 0.;
  if (uCracks > 0.) {
    float ck = 0.;
    for (int o = 3; o <= min(uOMax, 9); o++) {
      float n = 1. - abs(gn(o, 13u, dw*1.0).x); float l = pow(n, 24.) ;
      ck = max(ck, l * (1. - float(o-3)*0.09));
    }
    gCrack = ck * uCracks;
    h += gCrack * uHillAmp * 0.6 * (uLava > 0.5 ? -2. : 1.);
  }
  if (uCrater > 0.) h += craters(d);
  return h;
}

vec3 surfaceColor(vec3 d, vec3 P, float h, float slope, out float emis){
  emis = 0.;
  float lat = abs(P.y);
  float n1 = fbm(2, 6, 7u, d, 0.6)*0.5;
  float n2 = uOMax >= 8 ? fbm(8, min(uOMax, 14), 8u, d, 0.6)*0.4 : 0.;
  float nf = uOMax >= 15 ? gn(uOMax-1, 15u, d).x*0.5 + gn(uOMax, 15u, d).x*0.5 : 0.;
  vec3 c = mix(uColA, uColB, smoothstep(-0.3, 0.3, n1 + n2*0.4));
  c = mix(c, uColLow, gMaria);
  c = mix(c, uColLow, uMaria > 0. ? 0. : smoothstep(0.1, -0.5, gCont + n1*0.6)*0.85);
  c = mix(c, uColSand, gDune*0.8);
  float rock = smoothstep(0.35, 0.75, slope);
  if (uVeg > 0. || uOcean > 0.5) {
    float alt = h - uSea;
    float tC = uTempEq - 47.*pow(lat, 2.6) - 0.0065*max(alt, 0.) + n1*4. - 273.15;
    float moist = 0.5 + n1*0.9 + n2*0.3;
    float ld = degrees(asin(lat));
    moist *= 1. - 0.6*exp(-pow((ld-24.)/11., 2.));
    moist += 0.35*exp(-pow(ld/9., 2.));
    moist -= smoothstep(0., 3000., alt)*0.3;
    float vd = smoothstep(0.2, 0.5, moist) * smoothstep(-14., 2., tC) * smoothstep(42., 30., tC + (1.-moist)*10.) * uVeg;
    vec3 veg = mix(uColVeg1, uColVeg2, smoothstep(0.5, 0.85, moist + n2*0.3));
    veg = mix(veg, vec3(0.13,0.12,0.06), smoothstep(4., -10., tC)*0.7);
    vec3 dry = mix(uColSand, c, smoothstep(0.1, 0.5, moist));
    c = mix(dry, veg, vd*(1.-rock*0.7));
    c = mix(c, uColRock, rock*0.8);
    // beaches
    if (uOcean > 0.5) c = mix(c, uColSand*1.1, smoothstep(12., 2., alt)*(1.-rock)*smoothstep(-25., -5., tC+20.));
    // seabed
    if (uOcean > 0.5 && alt < 0.) c = mix(c, uColSand*0.6, 0.6);
    // snow and ice
    float snow = smoothstep(1.5, -2.5, tC + nf*1.5 + rock*3.);
    if (uOcean > 0.5 && alt < 0.) snow = smoothstep(-7., -11., tC + n2*4.);
    c = mix(c, uColIce, snow);
    if (uCity > 0. && alt > 1.) {
      float cm = fbm(5, min(uOMax, 9), 91u, d, 0.7);
      float city = smoothstep(0.35, 0.9, cm + 0.5*n1) * smoothstep(3000., 300., alt) * smoothstep(-5., 8., tC) * smoothstep(0.15, 0.45, moist) * (1.-snow);
      float spk = uOMax >= 11 ? smoothstep(0.1, 0.7, gn(min(uOMax,11), 92u, d).x + gn(min(uOMax,13), 92u, d).x*0.7) : 0.3;
      emis = city * spk * 0.6 * uCity;
      c = mix(c, vec3(0.2,0.19,0.18), city*spk*0.25);
    }
  } else {
    c = mix(c, uColRock, rock*0.7);
    c *= 1. + gFresh*0.9;
    c = mix(c, uColCrack, clamp(gCrack*1.5, 0., 1.) * (uLava > 0.5 ? 0. : 1.));
    float cap = smoothstep(uIceLat - 0.02, uIceLat + 0.02, lat + n1*0.05 + n2*0.02);
    c = mix(c, uColIce, cap);
    if (uLava > 0.) {
      float lv = clamp(gCrack*2.5, 0., 1.) + smoothstep(-0.25, -0.55, gCont + n2*0.3)*0.9;
      float hot = smoothstep(0.3, 1.0, lv + 0.3*n2 + nf*0.2);
      emis = hot * uLava;
      c = mix(c, vec3(0.02), hot*0.5);
    }
  }
  c *= 1. + nf*0.22 + n2*0.12;
  return clamp(c, 0., 1.);
}
`;

export const GEN_GAS = `
uniform vec3 uPal[4];
uniform float uBands, uBandStr, uTurb, uStorms, uGasSeed;
float bandProfile(float y){
  float v = 0.;
  v += sin(y*uBands*1.0 + uGasSeed*1.7)*0.5;
  v += sin(y*uBands*2.3 + uGasSeed*4.1)*0.3;
  v += sin(y*uBands*4.7 + uGasSeed*9.3)*0.2;
  v += sin(y*uBands*9.1 + uGasSeed*2.9)*0.08;
  return v;
}
float terrain(vec3 d, vec3 P){ return 0.; }
vec3 surfaceColor(vec3 d, vec3 P, float h, float slope, out float emis){
  emis = 0.;
  float y = asin(clamp(P.y, -1., 1.));
  // turbulent displacement, stronger where bands shear
  float t1 = fbm(2, 5, 21u, d, 0.6), t2 = fbm(5, min(uOMax, 11), 22u, d, 0.62), t3 = uOMax > 11 ? fbm(12, uOMax, 23u, d, 0.6) : 0.;
  float shear = abs(cos(y*uBands*2.3 + uGasSeed*4.1));
  float yw = y + (t1*0.035 + t2*0.016*(0.5+shear) + t3*0.0006) * uTurb;
  // storms: ovals from cellular lookup
  float storm = 0.; vec3 stormCol = vec3(0.);
  for (int o = 2; o <= 4; o++) {
    float f = exp2(float(o)) * uFreq;
    vec3 x = uOF[o] + (d*uAniso)*f;
    vec3 i = floor(x - 0.5), w = x - i; ivec3 ic = ivec3(i) + uOC[o];
    for (int c = 0; c < 8; c++) {
      ivec3 cc = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
      uint hs = hashu(ic + cc, 61u);
      if (float(hs & 255u) > 255.*uStorms*0.16) continue;
      vec3 rnd = vec3(float((hs>>8)&255u), float((hs>>16)&255u), float((hs>>24)&255u))/255.;
      vec3 cen = vec3(cc) + 0.3 + rnd*0.4;
      vec3 q = (w - cen) / (0.1 + 0.2*rnd.x); q.xz *= 0.55;
      float r2 = dot(q, q);
      if (r2 < 4.) { float s = exp(-r2*1.6); if (s > storm) { storm = s; stormCol = rnd.y > 0.5 ? uPal[2]*vec3(1.25,0.75,0.6) : uPal[3]*1.1; }
        // swirl
        yw += s * sin(atan(q.y, q.x)*2. + r2*4.) * 0.004; }
    }
  }
  float v = bandProfile(yw) * uBandStr + (t2*0.12 + t3*0.05)*uTurb*uBandStr + t1*0.1*uBandStr;
  float lat01 = abs(P.y);
  v *= 1. - 0.5*smoothstep(0.75, 0.98, lat01);
  vec3 c;
  float k = clamp(v*0.5 + 0.5, 0., 1.)*3.;
  c = k < 1. ? mix(uPal[2], uPal[0], k) : (k < 2. ? mix(uPal[0], uPal[1], k-1.) : mix(uPal[1], uPal[3], k-2.));
  c = mix(c, stormCol, storm*0.85);
  c = mix(c, uPal[0]*0.8, smoothstep(0.8, 0.99, lat01)*0.5);
  return clamp(c, 0., 1.);
}
`;

export const GEN_STAR = `
uniform float uSpots; uniform int uGranOct;
float terrain(vec3 d, vec3 P){ return 0.; }
vec3 surfaceColor(vec3 d, vec3 P, float h, float slope, out float emis){
  emis = 0.;
  float g = 0.5, sg = 0.;
  int go = uGranOct;
  if (uOMax >= go) {
    // granulation: bright cells with dark lanes
    vec3 wv = vec3(gn(go, 31u, d).x, gn(go, 32u, d).x, gn(go, 33u, d).x) * exp2(-float(go)) * 0.35;
    float a = 1. - abs(gn(go, 34u, d + wv).x); float b = uOMax > go ? 1. - abs(gn(go+1, 35u, d + wv).x) : 0.6;
    g = 1. - pow(max(a, 0.), 6.)*0.9 - pow(max(b,0.), 5.)*0.35;
  }
  if (uOMax >= go-3 && go >= 5) sg = fbm(go-3, go-1, 36u, d, 0.6)*0.5;
  float lowf = fbm(1, min(uOMax,4), 37u, d, 0.6);
  float bright = 0.62 + 0.3*g + 0.06*sg + 0.05*lowf;
  if (uSpots > 0.) {
    float lat = abs(P.y);
    float belt = exp(-pow((lat - 0.3)/0.2, 2.));
    float s = fbm(3, min(uOMax, 9), 38u, d, 0.55)*0.6 + gn(2, 39u, d).x*0.4;
    float th = 0.78 - 0.3*uSpots*belt;
    float umbra = smoothstep(th + 0.05, th + 0.11, s), pen = smoothstep(th, th + 0.05, s);
    float fib = uOMax >= 9 ? gn(min(uOMax, 10), 40u, d).x*0.15 : 0.;
    bright = mix(bright, 0.42 + fib, pen); bright = mix(bright, 0.1, umbra);
  }
  return vec3(clamp(bright, 0., 1.));
}
`;

export const GEN_MAIN = `
layout(location=0) out vec4 oH;
layout(location=1) out vec4 oN;
layout(location=2) out vec4 oA;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5) / (uTexSize - 1.);
  if (uTexSize < 1.5) uv = vec2(0.5);
  vec3 delta = ((uv.x - 0.5)*uSize)*uFaceA + ((uv.y - 0.5)*uSize)*uFaceB;
  vec3 cdir = uQc/uQcLen;
  vec3 d0 = localDir(delta);
  vec3 P0 = cdir + d0;
  float h0 = terrain(d0, P0);
  oH = vec4(h0, 0., 0., 1.);
#ifdef HAS_RELIEF
  if (uTexSize > 1.5) {
  float gc = gCont, gm = gMtn, gf = gFresh, gma = gMaria, gck = gCrack, gl = gLand, gd = gDune, gfi = gFine;
  vec3 d1 = localDir(delta + uFaceA*uTexel), d2 = localDir(delta + uFaceB*uTexel);
  float h1 = terrain(d1, cdir + d1), h2 = terrain(d2, cdir + d2);
  gCont = gc; gMtn = gm; gFresh = gf; gMaria = gma; gCrack = gck; gLand = gl; gDune = gd; gFine = gfi;
  float sea = uOcean > 0.5 ? uSea : -1e9;
  vec3 e1 = (d1 - d0) + ((cdir + d1)*h1 - P0*h0)/uRadius;
  vec3 e2 = (d2 - d0) + ((cdir + d2)*h2 - P0*h0)/uRadius;
  vec3 n = normalize(cross(e1, e2));
  if (dot(n, P0) < 0.) n = -n;
  vec3 dir = normalize(P0);
  vec3 T1 = normalize(uFaceA - dir*dot(dir, uFaceA)), T2 = cross(dir, T1);
  oN = vec4(dot(n, T1), dot(n, T2), 0., 1.);
  float slope = 1. - dot(n, dir);
  float emis;
  vec3 c = surfaceColor(d0, P0, h0, sqrt(max(slope,0.)*2.), emis);
  oA = vec4(sqrt(c), emis);
  }
#else
  oN = vec4(0.,0.,0.,1.);
  float emis; vec3 c = surfaceColor(d0, P0, h0, 0., emis);
  oA = vec4(sqrt(c), emis);
#endif
}
`;
