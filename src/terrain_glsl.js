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
// ---- real data maps (equirectangular, lon -180..180 left to right, north up) ----
uniform sampler2D uCMap, uHMap, uMMap, uLMap;
uniform float uHasC, uHasH, uHasM, uHasL, uMapOct, uMapDetail;
uniform vec2 uHRange; uniform vec3 uMapTint; uniform float uMapCurve, uSeason; uniform vec3 uClimate;
const float MPI = 3.14159265358979;
// (z is nudged away from exactly 0: some GPUs return garbage for atan(-0, x), which put a seam on the prime meridian)
vec2 mapUV(vec3 P){ vec3 n = normalize(P); float z = abs(n.z) < 1e-9 ? -1e-9 : n.z; return vec2(atan(-z, n.x)/(2.*MPI) + 0.5, 0.5 - asin(clamp(n.y, -1., 1.))/MPI); }
// ---- plate tectonics: each plate turns about its Euler pole; a point shows the crust of whichever plate has carried
// it there (continents win where plates overlap); gaps opened between diverging plates are new ocean floor ----
uniform float uDrift; uniform sampler2D uPlates; uniform mat3 uPlateInv[14];
float gFreshCrust = 0.;
vec3 plateSrc(vec3 P){
  gFreshCrust = 0.;
  if (uDrift == 0.) return P;
  ivec2 ps = textureSize(uPlates, 0);
  vec3 best = P; float bestS = -1.;
  for (int k = 1; k < 14; k++) {
    vec3 q = uPlateInv[k]*P; vec2 uv = mapUV(q);
    int id = int(texelFetch(uPlates, ivec2(clamp(uv*vec2(ps), vec2(0.), vec2(ps) - 1.)), 0).r*255. + 0.5);
    if (id != k) continue;
    float sc = uHasM > 0.5 ? 1. - textureLod(uMMap, uv, 0.).r : 0.;       // land beats sea floor
    if (sc > bestS) { bestS = sc; best = q; }
  }
  if (bestS < 0.) gFreshCrust = 1.;
  return best;
}
// ---- paleogeography (Earth before ~3 Myr ago): PALEOMAP elevation grids (Scotese & Wright 2018), 1 degree, every
// 5 Myr back to 540 Myr; two neighbouring epochs are blended. 361 x 181 nodes, 16-bit heights in R and G (-8 .. +8 km).
uniform float uPaleo, uPaleoK; uniform sampler2D uPalA, uPalB;
uniform vec2 uPaleoClim;   // x: global mean temperature minus today's (C); y: sea level rise over the map (m)
float palTexel(sampler2D s, ivec2 i){ i.x = (i.x % 360 + 360) % 360; i.y = clamp(i.y, 0, 180); vec3 c = texelFetch(s, i, 0).rgb; return (c.r*65280. + c.g*255.)/65535.*16000. - 8000.; }
float palCubic(sampler2D s, vec2 uv){
  vec2 p = uv*vec2(360., 180.); vec2 i = floor(p), f = p - i;
  vec2 w0 = (1. - f)*(1. - f)*(1. - f)/6., w1 = (3.*f*f*f - 6.*f*f + 4.)/6., w2 = (-3.*f*f*f + 3.*f*f + 3.*f + 1.)/6., w3 = f*f*f/6.;
  float r = 0.; ivec2 b = ivec2(i) - 1;
  for (int y = 0; y < 4; y++) {
    float wy = y == 0 ? w0.y : y == 1 ? w1.y : y == 2 ? w2.y : w3.y;
    r += wy*(w0.x*palTexel(s, b + ivec2(0, y)) + w1.x*palTexel(s, b + ivec2(1, y)) + w2.x*palTexel(s, b + ivec2(2, y)) + w3.x*palTexel(s, b + ivec2(3, y)));
  }
  return r;
}
float paleoHeight(vec3 P){ vec2 uv = mapUV(P); return mix(palCubic(uPalA, uv), palCubic(uPalB, uv), uPaleoK); }
float hTexel(ivec2 i, ivec2 sz){ i.x = (i.x % sz.x + sz.x) % sz.x; i.y = clamp(i.y, 0, sz.y - 1); vec3 c = texelFetch(uHMap, i, 0).rgb; return (c.r*65280. + c.g*255.)/65535.; }
// smooth (cubic B-spline) height lookup so map pixels never show as facets
float heightMap(vec2 uv){
  ivec2 sz = textureSize(uHMap, 0);
  vec2 p = uv*vec2(sz) - 0.5; vec2 i = floor(p), f = p - i;
  vec2 w0 = (1. - f)*(1. - f)*(1. - f)/6., w1 = (3.*f*f*f - 6.*f*f + 4.)/6., w2 = (-3.*f*f*f + 3.*f*f + 3.*f + 1.)/6., w3 = f*f*f/6.;
  float r = 0.; ivec2 b = ivec2(i) - 1;
  for (int y = 0; y < 4; y++) {
    float wy = y == 0 ? w0.y : y == 1 ? w1.y : y == 2 ? w2.y : w3.y;
    float row = w0.x*hTexel(b + ivec2(0, y), sz) + w1.x*hTexel(b + ivec2(1, y), sz) + w2.x*hTexel(b + ivec2(2, y), sz) + w3.x*hTexel(b + ivec2(3, y), sz);
    r += wy*row;
  }
  return mix(uHRange.x, uHRange.y, r);
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
uniform float uCraterO0;
float craters(vec3 d){
  float h = 0.; gFresh = 0.;
  int o1 = min(uOMax - 1, 19);
  for (int o = max(2, int(uCraterO0)); o <= o1; o++) {
    float f = exp2(float(o)) * uFreq;
    vec3 x = uOF[o] + d*f + 0.37;
    vec3 i = floor(x - 0.5), w = x - i; ivec3 ic = ivec3(i) + uOC[o];
    float big = smoothstep(7., 3., float(o));
    for (int c = 0; c < 8; c++) {
      ivec3 cc = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
      uint hs = hashu(ic + cc, 77u);
      // small craters are gardened away quickly: fewer survive, most are old and soft
      float small = smoothstep(9., 17., float(o));
      if (float(hs & 255u) > 255. * uCrater * mix(0.55, 0.3, small)) continue;
      vec3 rnd = vec3(float((hs>>8)&255u), float((hs>>16)&255u), float((hs>>24)&255u)) / 255.;
      float rad = 0.14 + 0.3*rnd.z*rnd.z;
      vec3 cen = vec3(cc) + 0.5 + (rnd - 0.5)*(1. - 2.*rad)*vec3(1.,1.,0.5);
      float t = length(w - cen)/rad;
      if (t < 3.) {
        float age = pow(fract(rnd.x*7.31 + rnd.y*3.7), mix(1., 0.35, small));
        // degraded craters: shallower and with the rim smoothed into the surroundings
        float tt = mix(t, t*0.85 + 0.15*smoothstep(0., 2., t), age);
        h += craterProfile(tt, big) * rad / f * mix(1.0, 0.18, age);
        gFresh += (1.-age)*(1.-age) * exp(-t*t*0.9) * smoothstep(0.7, 0.0, age);
      }
    }
  }
  return h * uRadius * uCraterAmp;
}

float terrainMapped(vec3 d, vec3 P){
  vec2 uv = mapUV(uPaleo > 0.5 ? P : plateSrc(P));
  // (new sea floor: young, hot crust sits high, ~2.6 km deep at the ridge)
  float hm = uPaleo > 0.5 ? paleoHeight(P) - uPaleoClim.y : gFreshCrust > 0.5 ? -2700. + fbm(2, 7, 77u, d, 0.6)*300. : heightMap(uv);
  float land = 1.;
  if (uPaleo > 0.5) {
    // the 1 degree grid is smooth: add relief between ~100 km and the detail octaves (ridged in mountain belts),
    // and roughen the coastlines
    int p0 = max(int(uMapOct) - 5, 1), p1 = min(uOMax, int(uMapOct) - 2);
    float mt = smoothstep(300., 2000., hm), a = 1., n = 0.;
    for (int o = p0; o <= p1; o++) { vec4 g = gn(o, 5u, d); float rn = 1. - abs(g.x); n += a*mix(g.x, rn*rn*1.8 - 0.7, mt); a *= 0.5; }
    hm += n*mix(260., 1500., mt)*(hm < -400. ? 0.4 : 1.);
    float water = smoothstep(-12., 12., -hm);
    land = 1. - water;
    hm = mix(max(hm, 1. + 6.*land), min(hm, -2. - 30.*water), water);
  } else if (uHasM > 0.5) {
    // coastline from the land/water mask, roughened below map resolution
    float wm = gFreshCrust > 0.5 ? 1. : texture(uMMap, uv).r;
    float cn = uOMax >= int(uMapOct) ? fbm(int(uMapOct), min(uOMax, int(uMapOct) + 6), 41u, d, 0.55)*0.35 : 0.;
    float water = smoothstep(0.42, 0.58, wm + cn);
    land = 1. - water;
    hm = mix(max(hm, 1. + 6.*(1. - water)), min(hm, -2. - 30.*water), water);
  }
  gCont = hm/3000.; gLand = land; gMaria = 0.; gFresh = 0.; gCrack = 0.; gDune = 0.;
  gMtn = smoothstep(250., 2200., hm)*land;
  // detail below the map's resolution, rougher in mountains
  float det = 0.;
  int o0 = int(uMapOct) - 1;
  if (uOMax >= o0) {
    float amp = 1., wgt = 1.; vec3 ds = vec3(0.);
    for (int o = o0; o <= uOMax; o++) {
      vec4 n = gn(o, 3u, d);
      float rn = 1. - abs(n.x); rn *= rn;
      ds += n.yzw*amp*0.9;
      det += amp*mix(n.x, rn*1.6 - 0.8, gMtn)*mix(1., wgt, gMtn)/(1. + dot(ds, ds)*0.4*gMtn);
      wgt = clamp(rn*1.8, 0., 1.);
      amp *= 0.52;
    }
  }
  // real mountain ranges are far rougher than the ~10 km map can show: carve them up hard
  float rough = 0.12 + 3.6*gMtn + 0.35*smoothstep(0., 800., hm);
  float coast = uHasM > 0.5 || uPaleo > 0.5 ? smoothstep(0., 150., hm) : 1.;
  gFine = det;
  float h = hm + det*uMapDetail*rough*coast;
  if (uCrater > 0.) h += craters(d);
  // sand seas: where the real map shows bright sand, add dune relief (~1.5 km dune ridges, ~350 m secondary dunes)
  if (uMapCurve > 0.5 && uHasC > 0.5 && uPaleo < 0.5) {
    int od = int(round(log2(uRadius/(uFreq*1500.))));
    if (uOMax >= od && od < NOCT - 2) {
      vec3 mc = textureLod(uCMap, uv, 2.).rgb;
      float sand = smoothstep(0.18, 0.4, mc.r - mc.b)*smoothstep(0.25, 0.45, dot(mc, vec3(0.3, 0.5, 0.2)))*(1. - gMtn)*land;
      if (sand > 0.01) {
        float field = 0.35 + 0.65*smoothstep(-0.5, 0.1, gn(max(od - 5, 0), 33u, d).x);
        float r1 = 1. - abs(gn(od, 34u, d).x); float r2 = uOMax >= od + 2 ? 1. - abs(gn(od + 2, 35u, d).x) : 0.6;
        float rip = uOMax >= od + 5 ? gn(od + 5, 36u, d).x : 0.;
        h += sand*field*(r1*r1*70. + r2*r2*14. + rip*1.5);
        gDune = max(gDune, sand*field);
      }
    }
  }
  if (uDunes > 0. && uOMax >= 12) {
    int od = int(clamp(round(log2(uRadius/(uFreq*900.))), 10., 20.));
    if (uOMax >= od) { float q = 1. - abs(gn(od, 12u, d).x); float dm = smoothstep(0.1, 0.5, gn(6, 9u, d).x)*(1. - gMtn); gDune = dm; h += dm*q*q*uRadius/(exp2(float(od))*uFreq)*0.2*uDunes; }
  }
  return h;
}

// scattered boulders, a few metres across, where the ground is barren
float boulders(vec3 d){
  int ob = int(round(log2(uRadius/(3.*uFreq))));
  if (uOMax < ob || ob >= NOCT) return 0.;
  float field = smoothstep(-0.1, 0.5, gn(max(ob - 9, 0), 71u, d).x + 0.4*gn(max(ob - 6, 0), 72u, d).x) * (1. - 0.75*uVeg) * (uOcean > 0.5 ? 0.5 : 1.);
  if (field < 0.02) return 0.;
  float h = 0.;
  for (int lv = 0; lv < 2; lv++) {
    int o = ob + lv;
    if (o > uOMax || o >= NOCT) break;
    float f = exp2(float(o))*uFreq;
    vec3 x = uOF[o] + d*f;
    vec3 i = floor(x - 0.5), w = x - i; ivec3 ic = ivec3(i) + uOC[o];
    for (int c = 0; c < 8; c++) {
      ivec3 cc = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
      uint hs = hashu(ic + cc, 73u + uint(lv));
      if (float(hs & 255u) > 255.*field*0.35) continue;
      vec3 rnd = vec3(float((hs>>8)&255u), float((hs>>16)&255u), float((hs>>24)&255u))/255.;
      float rad = 0.12 + 0.3*rnd.z*rnd.z;
      vec3 cen = vec3(cc) + 0.5 + (rnd - 0.5)*(1. - 2.*rad);
      vec3 q = (w - cen)/rad; q.y *= 1.3;
      float t2 = dot(q, q);
      if (t2 < 1.) h = max(h, sqrt(1. - t2)*rad/f*0.75);
    }
  }
  return h*uRadius*field;
}
float terrain(vec3 d, vec3 P){
  if (uHasH > 0.5) return terrainMapped(d, P) + boulders(d);
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
  // icy worlds: wind-carved ridges and pressure ridges at metre to hundred-metre scales
  if (uCracks > 0. && uOMax >= 13) {
    float rr = 0., a2 = 1.;
    for (int o = 13; o <= min(uOMax, 20); o++) { float q = 1. - abs(gn(o, 24u, d*vec3(1., 1., 1.)).x); rr += a2*q*q; a2 *= 0.5; }
    h += rr*uRadius/(exp2(13.)*uFreq)*0.008;
  }
  return h + boulders(d);
}

vec3 surfaceColorProc(vec3 d, vec3 P, float h, float slope, out float emis);
// Blue Marble is a display product: its sRGB values are close to proportional to reflectance, not to the
// linearised value. Map it back to approximate surface albedo (forest ~5%, desert ~40%, snow ~85%).
vec3 albedoFromMap(vec3 lin){
  if (uMapCurve < 0.5) return lin;
  vec3 v = pow(max(lin, 0.), vec3(1./2.2));
  return 0.45*v + 0.5*pow(v, vec3(8.));
}
// Ground cover on the paleo-continents, from a simple climate: sea-level temperature by latitude (warmer worlds
// warm the poles most), lapse rate with height; rain from the Hadley / Ferrel cells (wet tropics and mid-latitudes, dry
// subtropics and poles) reduced in continental interiors (fraction of ocean within ~800 km).
vec3 paleoAlbedo(vec3 P, float h, vec3 d){
  float sl = P.y*P.y, latD = degrees(asin(clamp(abs(P.y), 0., 1.))), an = uPaleoClim.x;
  float T = 28. - 45.*sl + an*(1. + 1.5*sl) - max(h, 0.)*0.0065;
  // moisture from the sea: upwind is east in the trade-wind belt, west under the westerlies
  vec2 uv = mapUV(P); ivec2 c = ivec2(uv*vec2(360., 180.) + 0.5); float sea = 0.;
  for (int k = 0; k < 8; k++) {
    float a = float(k)*0.7854; ivec2 o = ivec2(round(vec2(cos(a), sin(a))*7.));
    float z = mix(palTexel(uPalA, c + o), palTexel(uPalB, c + o), uPaleoK) - uPaleoClim.y, w = latD < 33. ? 1. + 0.8*cos(a) : 1. - 0.8*cos(a);
    sea += z < 0. ? w*0.125 : 0.;
  }
  float wet = 0.95*exp(-pow(latD/14., 2.)) + 0.75*exp(-pow((latD - 50.)/(17. + max(an, 0.)), 2.)) + 0.2 + 0.012*an - 0.25*exp(-pow((latD - 25.)/8., 2.));
  wet = wet*(0.5 + 0.75*sea) + fbm(3, min(uOMax, 8), 9u, d, 0.6)*0.12;
  vec3 desert = mix(vec3(0.42, 0.3, 0.19), vec3(0.36, 0.22, 0.13), smoothstep(20., 35., latD));
  vec3 col = mix(desert, vec3(0.1, 0.11, 0.05), smoothstep(0.22, 0.38, wet));
  col = mix(col, T > 20. ? vec3(0.025, 0.05, 0.02) : vec3(0.035, 0.06, 0.025), smoothstep(0.42, 0.65, wet));
  col = mix(col, wet > 0.3 ? vec3(0.03, 0.045, 0.03) : vec3(0.13, 0.12, 0.09), smoothstep(6., 1., T));   // taiga or steppe
  col = mix(col, vec3(0.13, 0.12, 0.09), smoothstep(-2., -5., T));                                      // tundra
  return mix(col, vec3(0.8, 0.84, 0.9), smoothstep(-7., -10., T));                                      // ice sheets
}
vec3 surfaceColorMapped(vec3 d, vec3 P, float h, float slope, out float emis){
  vec2 uv = mapUV(uPaleo > 0.5 ? P : plateSrc(P));
  vec3 m = uPaleo > 0.5 ? (gLand > 0.5 ? paleoAlbedo(P, h, d) : albedoFromMap(vec3(0.04, 0.07, 0.19))) : albedoFromMap(gFreshCrust > 0.5 ? vec3(0.04, 0.07, 0.19) : texture(uCMap, uv).rgb)*uMapTint;
  emis = 0.;
  int o0 = int(uMapOct);
  // how far below the map's resolution this tile is (0 = map scale, 1 = much finer)
  float fine = clamp(float(uOMax - o0)/6., 0., 1.);
  vec3 c = m;
  if (uOMax >= o0) {
    // classify the smeared map colour and synthesise matching detail
    float lum = dot(m, vec3(0.3, 0.55, 0.15));
    float green = clamp((m.g - max(m.r, m.b))*6. + 0.3, 0., 1.);
    float sandy = clamp((m.r - m.b)*4. - green, 0., 1.);
    float snowy = smoothstep(0.48, 0.7, lum)*smoothstep(0.12, 0.03, abs(m.r - m.b));
    float n1 = fbm(o0, min(uOMax, o0 + 4), 61u, d, 0.6), n2 = uOMax >= o0 + 4 ? fbm(o0 + 4, uOMax, 62u, d, 0.55) : 0.;
    float patches = smoothstep(-0.25, 0.25, n1 + 0.5*n2);
    // vegetation: forest and meadow patches
    vec3 forest = m*vec3(0.5, 0.62, 0.45), meadow = m*vec3(1.55, 1.45, 0.95);
    float fields = uOMax >= o0 + 7 ? smoothstep(0.1, 0.35, abs(gn(o0 + 7, 63u, d).x)) : 0.5;   // field mosaic at ~100s of metres
    meadow *= 0.85 + 0.3*fields;
    vec3 veg = mix(forest, meadow, patches);
    // arid ground: lighter sand, darker gravel and outcrops
    vec3 arid = m*mix(vec3(0.82, 0.8, 0.78), vec3(1.12, 1.06, 0.98), smoothstep(-0.3, 0.3, n1 - 0.4*n2));
    vec3 det = mix(m*(1. + n2*0.15), veg, green*fine);
    det = mix(det, arid, sandy*fine*0.8);
    // bare rock on steep slopes, regardless of the averaged map colour
    float rock = smoothstep(0.38, 0.7, slope + n2*0.1);
    vec3 rockC = mix(vec3(0.16, 0.15, 0.14), vec3(0.26, 0.24, 0.21), smoothstep(-0.3, 0.3, n2))*mix(1., lum*3., 0.3);
    det = mix(det, rockC, rock*fine);
    // snow: from the map, and from a temperature-based snow line at fine scales
    float lat = abs(P.y);
    float snowLine = mix(4900., -200., smoothstep(0.5, 1.0, lat));
    float snowT = smoothstep(snowLine - 300., snowLine + 400., h + n1*250.)*(1. - smoothstep(0.55, 0.8, slope));
    det = mix(det, vec3(0.82, 0.85, 0.9)*(0.92 + 0.08*n2), max(snowy, snowT)*fine*(1. - rock*0.6));
    c = mix(m, det, fine);
  }
  // seasonal snow (the base map is a July image): snow line follows the date, lower at altitude
  // (in warmer epochs the winter snow retreats poleward, ~2.5 degrees of latitude per degree of global warming)
  if (uSeason > -1.5 && gLand > 0.5 && uPaleoClim.x < 8.) {
    float latD = degrees(asin(clamp(P.y, -1., 1.)));
    // snow cover lags the solstice and mostly builds December to March: nonlinear in the season
    float wN = smoothstep(0.25, 0.95, -uSeason), wS = smoothstep(0.25, 0.95, uSeason);
    float nz = fbm(max(o0 - 3, 1), min(uOMax, o0 + 3), 64u, d, 0.6)*6.;
    // continentality: fraction of water within ~600 km pushes the winter snow line poleward (maritime climates)
    float wf = uHasM > 0.5 && uPaleo < 0.5 ? textureLod(uMMap, uv, 6.).r : 0.3;
    float above = latD > 0. ? latD - mix(72., 43. + 20.*wf, wN) : -latD - mix(62., 50. + 12.*wf, wS);
    above -= uPaleo > 0.5 ? 2.5*uPaleoClim.x : 0.;
    above += max(h, 0.)/130. + nz;
    float sn = smoothstep(-1.5, 2.5, above)*(1. - smoothstep(0.55, 0.85, slope));
    float green = clamp((m.g - max(m.r, m.b))*6. + 0.3, 0., 1.);
    // leaves turn and grass dries in the mid-latitude winter (relative to the July base map: the north browns in its
    // winter, the south greens up in its summer)
    if (uPaleo < 0.5) {
      float zone = smoothstep(28., 40., abs(latD))*(1. - smoothstep(60., 68., abs(latD)));
      float brownN = latD > 0. ? smoothstep(0.1, 0.8, -uSeason) : 0., greenS = latD < 0. ? smoothstep(0.1, 0.8, -uSeason) : 0.;
      c = mix(c, c*vec3(1.35, 1.0, 0.72), green*zone*brownN*0.7);
      c = mix(c, c*vec3(0.78, 1.12, 0.7), clamp((m.g - m.b)*5., 0., 1.)*zone*greenS*0.6);
    }
    vec3 snowC = mix(vec3(0.8, 0.83, 0.88), vec3(0.32, 0.35, 0.38), green*0.75);   // forests stick out of the snow
    c = mix(c, snowC, sn);
  }
  float rock2 = smoothstep(0.45, 0.8, slope);
  c = mix(c, c*vec3(0.85, 0.82, 0.8), rock2*0.4*(1. - fine));
  float nf = uOMax >= o0 ? fbm(o0, uOMax, 15u, d, 0.6)*0.5 : 0.;
  c *= 1. + nf*0.25*(1. - fine) + gFine*0.05;
  if (uHasL > 0.5 && uPaleo < 0.5) {
    float l = texture(uLMap, uv).r; emis = l*l*0.85*gLand;
    // below the map's ~10 km pixels, light comes from towns and streets, not an even glow
    if (uOMax >= o0 + 3) {
      float towns = smoothstep(0.45, 0.8, 0.5 + 0.5*(gn(o0 + 3, 81u, d).x + 0.5*gn(o0 + 4, 81u, d).x));
      float k = towns*3.2;
      if (uOMax >= o0 + 7) {
        // road network: thin ridge lines of noise at a few scales, plus scattered points
        float r1 = 1. - abs(gn(o0 + 7, 82u, d).x), r2 = uOMax >= o0 + 9 ? 1. - abs(gn(o0 + 9, 83u, d).x) : 0.5;
        float roads = pow(r1, 14.)*1.2 + pow(r2, 20.);
        float pts = uOMax >= o0 + 11 ? smoothstep(0.55, 0.9, gn(min(uOMax, o0 + 12), 84u, d).x) : 0.;
        k *= 0.12 + roads*4. + pts*3.;
      }
      emis *= mix(1., k, fine);
    }
  }
  if ((uHasM > 0.5 || uPaleo > 0.5) && gLand < 0.5) c = m*0.8;
  // a brighter Sun: the biosphere dies back, ice melts, and the boiling oceans expose the salt-crusted sea floor
  if (uClimate.x > 0.001 || uClimate.y < 0.999 || uClimate.z < 0.999) {
    float lum2 = dot(c, vec3(0.3, 0.55, 0.15));
    float green2 = clamp((c.g - max(c.r, c.b))*6. + 0.3, 0., 1.);
    vec3 desert = vec3(0.46, 0.35, 0.25)*(0.55 + lum2*1.3);
    c = mix(c, desert, max(green2, 0.35)*(1. - uClimate.y)*gLand);
    float white = smoothstep(0.45, 0.7, lum2)*smoothstep(0.12, 0.03, abs(c.r - c.b));
    c = mix(c, vec3(0.32, 0.28, 0.24), white*(1. - uClimate.z)*gLand);
    if (gLand < 0.5) {
      float dep = clamp(-h/5000., 0., 1.);
      vec3 bed = mix(vec3(0.72, 0.68, 0.6), vec3(0.17, 0.155, 0.15), smoothstep(0.03, 0.35, dep));
      c = mix(c, bed*(0.9 + nf*0.3), uClimate.x);
    }
    emis *= uClimate.y;
  }
  return clamp(c, 0., 1.);
}
vec3 surfaceColor(vec3 d, vec3 P, float h, float slope, out float emis){
  if (uHasC > 0.5 && uHasH > 0.5) return surfaceColorMapped(d, P, h, slope, emis);
  if (uHasC > 0.5) {
    // colour map over procedural relief (bodies without elevation data)
    vec3 base = surfaceColorProc(d, P, h, slope, emis);
    vec3 m = texture(uCMap, mapUV(P)).rgb*uMapTint;
    float lum = dot(base, vec3(0.3, 0.5, 0.2)) + 1e-3;
    float rock = smoothstep(0.45, 0.8, slope);
    return clamp(m*(0.75 + 0.5*clamp(lum/(dot(uColA, vec3(0.3, 0.5, 0.2)) + 1e-3), 0.3, 2.))*(1. - rock*0.3), 0., 1.);
  }
  return surfaceColorProc(d, P, h, slope, emis);
}
vec3 surfaceColorProc(vec3 d, vec3 P, float h, float slope, out float emis){
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
    // snow is never perfectly uniform: drifts, wind crust and blue shadows in hollows
    float sv = uOMax >= 12 ? gn(min(uOMax, 14), 17u, d).x*0.5 + gn(min(uOMax, 17), 18u, d).x*0.3 : 0.;
    vec3 snowC = uColIce*(0.9 + 0.1*sv) * mix(vec3(1.), vec3(0.86, 0.92, 1.0), clamp(slope*1.6 + max(-gFine, 0.)*0.4, 0., 1.));
    c = mix(c, snowC, snow);
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
    c = mix(c, uColCrack, clamp(gCrack*1.5, 0., 1.) * (uLava > 0.5 ? 0. : 1.) * (0.4 + 0.6*smoothstep(-0.2, 0.3, n2)));
    float cap = smoothstep(uIceLat - 0.02, uIceLat + 0.02, lat + n1*0.05 + n2*0.02);
    c = mix(c, uColIce, cap);
    // icy surfaces: fractured, layered albedo at every scale so low sun reveals structure
    if (uCracks > 0. || cap > 0.) {
      float iv = uOMax >= 10 ? fbm(10, min(uOMax, 18), 19u, d, 0.6)*0.35 : 0.;
      c *= 1. + iv*0.3;
      c = mix(c, c*vec3(0.82, 0.9, 1.0), clamp(slope*1.4, 0., 1.)*0.6);
    }
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
  if (uHasC > 0.5) {
    // real map, with fine turbulent shear added below its resolution
    vec2 uv = mapUV(P);
    int o0 = int(uMapOct) - 1;
    float px = 1./float(textureSize(uCMap, 0).x);
    float tex = 0.;
    if (uOMax >= o0) {
      // turbulent shear below the map's resolution: a few octaves of domain warping, stronger along the bands
      vec2 w = vec2(0.); float a = 1.;
      for (int o = o0; o <= min(uOMax, o0 + 7); o++) {
        vec4 n1 = gn(o, 51u, d + vec3(w.x, 0., w.y)*0.0), n2 = gn(o, 52u, d);
        w += vec2(n1.x, n2.x*0.35)*a;
        a *= 0.55;
      }
      uv += w*px*3.5;
      // small vortices and cloud texture
      tex = fbm(o0 + 1, min(uOMax, o0 + 9), 53u, d, 0.6);
    }
    vec3 c = texture(uCMap, uv).rgb;
    // local contrast: cloud texture modulates brightness, more in bright zones (thick ammonia clouds)
    float l = dot(c, vec3(0.3, 0.5, 0.2));
    c *= 1. + tex*(0.16 + 0.2*smoothstep(0.35, 0.7, l));
    return clamp(c*uMapTint, 0., 1.);
  }
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
    float th = 0.62 - 0.22*uSpots*belt;
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
