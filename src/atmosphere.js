// Atmosphere LUT management, volumetric clouds and the screen space compositing pass.
import { gl, Program, tex2D, texCube, fbo, drawFS, FS_VS } from './gl.js';
import { Q, V, clamp } from './math.js';
import { ATMO_UNIFORMS, ATMO_COMMON, ATMO_LUT_SAMPLE, ATMO_TRANS_FS, ATMO_MULTI_FS, ATMO_IRR_FS } from './atmo_glsl.js';
import { LIGHT_UNIFORMS } from './planet.js';
import { loadTexture } from './assets.js';

let pTrans, pMulti, pIrr, pComp, pCloudMap;
const luts = new Map();
export const atmoCfg = { steps: 28, cloudSteps: 32, cloudRes: 768 };

const CLOUDMAP_FS = `
in vec2 vUV; out vec4 o;
uniform mat3 uFace; uniform float uSeed, uCover, uKind, uHasTex, uLonOff, uFlip, uCoverBias; uniform sampler2D uCloudTex;
uint h3(ivec3 c){ uint h = uint(c.x)*0x8da6b343u ^ uint(c.y)*0xd8163841u ^ uint(c.z)*0xcb1ab31fu; h ^= h >> 15; h *= 0x2c1b3c6du; h ^= h >> 12; h *= 0x297a2d39u; h ^= h >> 15; return h; }
float vn(vec3 x){
  vec3 i = floor(x), f = x - i; f = f*f*f*(f*(f*6.-15.)+10.); ivec3 c = ivec3(i);
  #define HV(o) (float(h3(c + o) & 65535u)/65535.)
  return mix(mix(mix(HV(ivec3(0,0,0)), HV(ivec3(1,0,0)), f.x), mix(HV(ivec3(0,1,0)), HV(ivec3(1,1,0)), f.x), f.y),
             mix(mix(HV(ivec3(0,0,1)), HV(ivec3(1,0,1)), f.x), mix(HV(ivec3(0,1,1)), HV(ivec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p, int n){ float s = 0., a = 0.5; for (int i = 0; i < n; i++) { s += a*vn(p); p = p*2.02 + 19.1; a *= 0.5; } return s; }
vec3 rotAxis(vec3 p, vec3 ax, float a){ return mix(dot(ax, p)*ax, p, cos(a)) + cross(ax, p)*sin(a); }
void main(){
  vec3 dir = normalize(uFace*vec3(vUV*2. - 1., 1.));
  vec3 p = dir;
  if (uHasTex > 0.5 && uKind > 0.5) {
    // Venus: total cover; the map's contrast (UV markings, stretched) becomes thickness variation
    vec2 uv = vec2(atan(-dir.z, dir.x)/6.2831853 + 0.5, 0.5 - asin(clamp(dir.y, -1., 1.))/3.14159265);
    float v = texture(uCloudTex, uv).r;
    o = vec4(1., clamp((v - 0.45)*2.5 + 0.5, 0., 1.), 0., 1.); return;
  }
  if (uHasTex > 0.5) {
    // observed cloud cover (brightness ~ optical thickness)
    vec2 uv = vec2(atan(-dir.z, dir.x)/6.2831853 + 0.5 + uLonOff, 0.5 - asin(clamp(dir.y*uFlip, -1., 1.))/3.14159265);
    float v = texture(uCloudTex, uv).r + uCoverBias;
    float v2 = texture(uCloudTex, uv + vec2(0.0012, 0.0008)).r + uCoverBias;
    o = vec4(smoothstep(0.2, 0.72, v), smoothstep(0.5, 0.92, max(v, v2)), fbm(dir*30., 3), 1.); return;
  }
  float lat = asin(clamp(dir.y, -1., 1.));
  if (uKind > 0.5) {
    // Venus like: global deck with swept streaks
    vec3 q = p*vec3(3., 9., 3.) + uSeed;
    q.x += dir.y*dir.y*6.;
    float s = fbm(q + fbm(q*2., 3)*1.5, 5);
    o = vec4(1., s, 0., 1.); return;
  }
  // cyclones: rotate the lookup around random centres to wind fronts into spirals
  float cyc = 0.;
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    vec3 c = normalize(fract(sin(vec3(fi*12.9898, fi*78.233, fi*39.425) + uSeed)*43758.5453) - 0.5);
    float clat = abs(c.y);
    if (clat < 0.25 || clat > 0.85) continue;
    float d = acos(clamp(dot(dir, c), -1., 1.));
    float rad = 0.2 + 0.14*fract(fi*0.618);
    float fall = exp(-d*d/(rad*rad));
    float sgn = c.y > 0. ? 1. : -1.;
    p = rotAxis(p, c, sgn*fall*1.7);
    cyc += fall;
  }
  vec3 w = vec3(fbm(p*3. + uSeed, 4), fbm(p*3. + uSeed + 31., 4), fbm(p*3. + uSeed + 67., 4)) - 0.5;
  vec3 q = p*4.2 + w*1.1 + uSeed;
  // stretched along latitude circles (zonal flow)
  float n = fbm(q*vec3(1., 1.6, 1.), 7);
  float n2 = fbm(q*6.1 + 11., 6);
  float ld = degrees(abs(lat));
  float clim = 0.06*exp(-pow(ld/7., 2.)) + 0.09*exp(-pow((ld - 55.)/14., 2.)) - 0.09*exp(-pow((ld - 24.)/9., 2.)) + 0.03*cyc;
  float n3 = fbm(q*17.3 + 3., 5);
  float v = n + clim + (n2 - 0.5)*0.24 + (n3 - 0.5)*0.1;
  float th = 0.62 - uCover*0.36;
  float cov = smoothstep(th, th + 0.28, v);
  // second channel: cloud top height variation / convective cells
  float tall = smoothstep(0.5, 0.75, fbm(q*2.3 + 5., 4) + cyc*0.2);
  o = vec4(cov, tall, n2, 1.);
}`;

const COMP_FS = `
in vec2 vUV;
uniform sampler2D uScene, uDepth;
uniform sampler3D uNoise3;
uniform samplerCube uCloudMap; uniform sampler2D uCloudTex2;
uniform mat3 uCamRot, uPlanetRotInv;
uniform vec2 uTanFov;
uniform float uExposure, uTime, uOblate, uFrame, uPixAngle;
uniform float cBase, cTop, cDens, cHas, cKind, cMapped; uniform vec3 cColor;
uniform float uAurora; uniform mat3 uBodyRotInv; uniform vec3 uMagPole;
uniform sampler2D uIrrLUT;
uniform int uSteps, uCloudSteps;
${LIGHT_UNIFORMS}
${ATMO_UNIFORMS}${ATMO_COMMON}${ATMO_LUT_SAMPLE}
uniform float uFcoef;
float ign(vec2 p){ return fract(52.9829189*fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec3 toWorld(vec3 p){ return uOblate > 0. ? transpose(uPlanetRotInv)*(p*vec3(1., 1. - uOblate, 1.)) : p; }
// density of cloud at point p (relative to planet centre, world axes)
// cloud cover above point p along the light (for shadowed air), cheap single lookup
float cloudShadowAt(vec3 p, vec3 L){
  float r = length(p), mid = aR0 + (cBase + cTop)*0.45;
  if (r > mid) return 0.;
  float mu = dot(p, L)/r;
  vec3 q = p + L*((mid - r)/max(mu, 0.06));
  vec3 dir = normalize(uPlanetRotInv*q);
  float cov;
  if (cMapped > 0.5) { vec2 uv = vec2(atan(-dir.z, dir.x)*0.15915494 + 0.5, 0.5 - asin(clamp(dir.y, -1., 1.))*0.31830989); cov = smoothstep(0.12, 0.6, textureLod(uCloudTex2, uv, 2.).r); }
  else cov = texture(uCloudMap, dir).r;
  return smoothstep(0.15, 0.85, cov);
}
// aurora: emission from the auroral ovals around the geomagnetic poles (night side)
vec3 auroraEmission(vec3 p, float alt, vec3 sunDir){
  if (alt < 85000. || alt > 380000.) return vec3(0.);
  vec3 n = normalize(p);
  // airglow: O(1S) 557.7 nm layer at ~95 km, everywhere; only noticeable on the night side and at the limb
  vec3 glow = vec3(0.3, 1., 0.32)*exp(-pow((alt*1e-3 - 95.)/5.5, 2.))*4e-14*(0.75 + 0.5*textureLod(uNoise3, n*3. + uTime*1e-5, 0.).r);
  if (dot(n, sunDir) > 0.05) return glow;
  vec3 nb = uBodyRotInv*n;
  float cm = dot(nb, uMagPole);
  vec3 mp = cm > 0. ? uMagPole : -uMagPole;
  float th = acos(abs(cm));
  // oval: ~20 deg from the magnetic pole, pushed equatorward on the night side
  vec3 sunB = uBodyRotInv*sunDir;
  float night = clamp(-dot(normalize(nb - mp*dot(nb, mp)), normalize(sunB - mp*dot(sunB, mp))), -1., 1.);
  float th0 = 0.33 + 0.06*night;
  vec3 e1 = normalize(cross(mp, vec3(0., 0., 1.))), e2 = cross(mp, e1);
  float phi = atan(dot(nb, e2), dot(nb, e1));
  float band = exp(-pow((th - th0)/0.045, 2.));
  if (band < 0.01) return glow;
  // folded curtains drifting slowly
  float t = uTime*0.003;
  float w = textureLod(uNoise3, vec3(phi*1.6, th*6., t*0.2), 0.).r;
  float fold = exp(-pow((th - th0 - (w - 0.5)*0.09)/0.004, 2.)) + 0.5*exp(-pow((th - th0 + 0.02 - (w - 0.5)*0.07)/0.003, 2.));
  float rays = 0.65 + 0.5*textureLod(uNoise3, vec3(phi*24., alt*1.5e-6, t), 0.).g;
  float act = 0.35 + 0.9*smoothstep(0.35, 0.75, textureLod(uNoise3, vec3(phi*0.9 + t*0.3, 0.2, 0.7), 0.).b);
  float a = alt*1e-3;
  float green = exp(-pow((a - 112.)/14., 2.)) + 0.35*exp(-pow((a - 160.)/40., 2.));
  float red = 0.07*exp(-pow((a - 240.)/55., 2.));
  float blue = 0.25*exp(-pow((a - 98.)/5., 2.));
  float k = (fold + band*0.03)*rays*act*uAurora*smoothstep(0.05, -0.12, dot(n, sunDir));
  return glow + (vec3(0.18, 1., 0.38)*green + vec3(1., 0.15, 0.12)*red + vec3(0.55, 0.25, 1.)*blue)*k*6e-11;
}
float lodDist;
float cloudDensity(vec3 p, bool cheap, float lod, out float hfrac){
  float r = length(p); float alt = r - aR0;
  hfrac = (alt - cBase)/(cTop - cBase);
  if (hfrac <= 0. || hfrac >= 1.) return 0.;
  vec3 pl = uPlanetRotInv*p; vec3 dir = pl/r;
  vec4 wm;
  if (cMapped > 0.5) {
    // observed clouds straight from the equirectangular map (smoother than the cube), plus detail
    vec2 uv = vec2(atan(-dir.z, dir.x)*0.15915494 + 0.5, 0.5 - asin(clamp(dir.y, -1., 1.))*0.31830989);
    float mlod = log2(max(lodDist*uPixAngle/(6.2832*aR0/float(textureSize(uCloudTex2, 0).x)), 1.));
    float v = textureLod(uCloudTex2, uv, mlod).r;
    wm = vec4(smoothstep(0.08, 0.55, v), smoothstep(0.4, 0.9, v), 1., 0.);
  } else wm = texture(uCloudMap, dir);
  float cov = wm.r;
  if (cov < 0.01) return 0.;
  if (cKind > 0.5) return (0.6 + 0.8*wm.g) * smoothstep(0., 0.2, hfrac) * smoothstep(1., 0.6, hfrac);
  // break the weather map up with mid-scale structure (tens to hundreds of km)
  float mid = textureLod(uNoise3, pl/1.7e6 + 0.11, max(lod - 7., 0.)).g*0.55 + textureLod(uNoise3, pl/4.3e5 + 0.37, max(lod - 5., 0.)).b*0.45;
  {
    // The map gives the fraction of sky covered within each ~10 km pixel. Turn that into cloud cells:
    // a fractal field thresholded so that the covered area matches the map. Cumulus where cover is
    // broken, stratiform where it is near total.
    float e1 = textureLod(uNoise3, pl/52000. + 0.53, max(lod - 2.5, 0.)).r, e2 = textureLod(uNoise3, pl/15000. + 0.21, max(lod - 1., 0.)).g, e3 = textureLod(uNoise3, pl/5200. + 0.7, lod).b;
    float S = e1*0.5 + e2*0.33 + e3*0.17;
    float soft = mix(0.06, 0.2, cov);
    float thr = 0.5 + (0.5 - cov)*0.75;
    float cell = smoothstep(thr - soft, thr + soft, S);
    cov = cell*smoothstep(0.02, 0.25, cov);
  }
  if (cov < 0.01) return 0.;
  float topH = mix(0.3, 1.0, wm.g)*mix(0.7, 1., cov);
  float prof = smoothstep(0., 0.07, hfrac) * smoothstep(topH, topH*0.45, hfrac);
  float d = cov*prof;
  if (!cheap) {
    vec3 q = pl/11000.;
    float big = textureLod(uNoise3, pl/170000. + 0.2, lod - 4.).a;
    float n = textureLod(uNoise3, q + vec3(uTime*0.0004, 0., 0.), lod).r*0.6 + textureLod(uNoise3, q*3.1 + 0.3, lod + 1.6).g*0.28 + textureLod(uNoise3, q*9.7, lod + 3.3).b*0.12;
    n = mix(n, big, 0.35);
    float er = (n - 0.3)*0.9; d = clamp((d - er)*1.6, 0., 1.);   // billowy edges; the coverage already matches the map
  } else d = d*0.6;
  // optical thickness spans thin veils to dense towers
  return d*(0.3 + 1.6*wm.g);
}
// Volumetric integration along the view ray through pixel uv. inscatter is not yet multiplied by exposure.
void volumetrics(vec2 uv, out vec3 inscatter, out vec3 trans, out float depth, out float repDist){
  inscatter = vec3(0.); trans = vec3(1.);
  // use exactly the full resolution pixel whose depth we read
  vec2 dsz = vec2(textureSize(uDepth, 0)); ivec2 dpx = ivec2(clamp(uv*dsz, vec2(0.), dsz - 1.)); uv = (vec2(dpx) + 0.5)/dsz;
  vec2 ndc = uv*2. - 1.;
  vec3 rdc = vec3(ndc*uTanFov, -1.);
  float cosf = 1./length(rdc);
  vec3 rd = normalize(uCamRot*rdc);
  depth = texelFetch(uDepth, dpx, 0).r;
  float sceneDist = depth >= 0.99999 ? 1e30 : (exp2(depth*2./uFcoef) - 1.)/cosf;
  vec3 ro = -uPlanetRel;
  vec3 rdW = rd;
  if (uOblate > 0.) {
    // work in the planet frame stretched so the oblate spheroid becomes a sphere
    vec3 a = uPlanetRotInv*ro, b2 = uPlanetRotInv*rd; a.y /= 1. - uOblate; b2.y /= 1. - uOblate;
    float l = length(b2); ro = a; rd = b2/l; sceneDist *= l;
  }
  float t0, t1;
  repDist = sceneDist < 1e29 ? sceneDist : 1e9;
  if (raySphere(ro, rd, aRt, t0, t1) < 0. || t1 < 0.) return;
  float tmin = max(t0, 0.), tmax = min(t1, sceneDist);
  float g0, g1; bool hitGround = false;
  if (raySphere(ro, rd, aRg, g0, g1) > 0. && g0 > 0. && g0 < tmax) { tmax = g0; hitGround = true; }
  if (tmax <= tmin) return;
  float jit = fract(ign(gl_FragCoord.xy) + uFrame*0.6180339);
  // ---- clouds ----
  vec3 cloudL = vec3(0.); float cloudT = 1., cloudDist = tmax;
  if (cHas > 0.5) {
    float Rb = aR0 + cBase, Rtp = aR0 + cTop;
    float a0, a1, b0, b1; float rcam = length(ro);
    float hitTop = raySphere(ro, rd, Rtp, a0, a1), hitBase = raySphere(ro, rd, Rb, b0, b1);
    float s0 = -1., s1 = -1.;
    if (rcam > Rtp) { if (hitTop > 0. && a0 > 0.) { s0 = a0; s1 = (hitBase > 0. && b0 > 0.) ? b0 : a1; } }
    else if (rcam < Rb) { if (hitBase > 0.) { s0 = b1; s1 = a1; } }
    else { s0 = 0.; s1 = (hitBase > 0. && b0 > 0.) ? b0 : a1; }
    s1 = min(s1, tmax);
    if (s0 >= 0. && s1 > s0) {
      s1 = min(s1, s0 + 250000.);
      // long grazing paths near the horizon get more samples (bounded), short vertical ones fewer
      int NS = int(clamp((s1 - s0)/1200., float(uCloudSteps)*0.5, float(uCloudSteps)*3.)); float dt = (s1 - s0)/float(NS);
      float wsum = 0., dsum = 0.;
      // far away every pixel can share the same sample heights; jitter is only needed up close
      float cjit = mix(jit, 0.5, clamp(log2(max(s0*uPixAngle/170., 1.))*0.3 - 0.6, 0., 1.));
      for (int i = 0; i < NS; i++) {
        float t = s0 + (float(i) + cjit)*dt;
        vec3 p = ro + rd*t; float hf;
        lodDist = t; float d = cloudDensity(p, false, log2(max(t*uPixAngle/170., 1.)), hf);
        if (d > 0.002) {
          float sig = d*cDens*0.0045;
          vec3 lsum = vec3(0.);
          float r = length(p); vec3 up = p/r;
          for (int li = 0; li < uNumLights; li++) {
            vec3 L = normalize(uLightPos[li] - (p + uPlanetRel));
            float mu = dot(up, L);
            // optical depth towards the light
            float od = 0.; float ls = (cTop - cBase)*0.22;
            for (int k = 0; k < 4; k++) { float hh; od += cloudDensity(p + L*ls*(float(k) + 0.6), true, 0., hh)*cDens*0.0045*ls; }
            vec3 sunT = atmoSunTrans(r, mu);
            float c = dot(rd, L);
            // multiple scattering approximation (octaves)
            float sc = 0.; float a = 1., b = 1., g = 1.;
            for (int m = 0; m < 3; m++) {
              float gg = 0.75*g; float ph = mix((1. - gg*gg)/(4.*PI*pow(1. + gg*gg - 2.*gg*c, 1.5)), (1. - 0.09*g*g)/(4.*PI*pow(1. + 0.09*g*g + 0.6*g*c, 1.5)), 0.35);
              sc += a*exp(-od*b)*ph; a *= 0.55; b *= 0.3; g *= 0.6;
            }
            float vis = uNumOcc > 0 ? eclipse(p + uPlanetRel, li) : 1.;
            lsum += uLightCol[li]*sunT*sc*vis*3.2;
            // ambient: sky light from above, ground bounce from below
            vec3 amb = texture(uIrrLUT, vec2(mu*0.5 + 0.5, 0.5)).rgb*uLightCol[li]*vis;
            lsum += amb*(0.25 + 0.45*hf)/PI + uLightCol[li]*sunT*max(mu, 0.)*0.03*(1. - hf)*vis;
          }
          float st = exp(-sig*dt);
          cloudL += cloudT*lsum*cColor*(1. - st);
          wsum += cloudT*(1. - st); dsum += cloudT*(1. - st)*t;
          cloudT *= st;
          if (cloudT < 0.01) { cloudT = 0.; break; }
        }
      }
      if (wsum > 0.) { cloudDist = dsum/wsum; if (sceneDist > 1e29 && cloudT < 0.7) repDist = cloudDist; }
    }
  }
  // ---- gas ----
  vec3 L = vec3(0.), T = vec3(1.), Tc = vec3(1.);
  float len = tmax - tmin, prev = 0.;
  int N = uSteps;
  bool passed = false;
  float spow = mix(2., 1., clamp((length(ro) - aR0)/(aRt - aR0), 0., 1.));
  float ajit = mix(0.25 + 0.5*jit, 0.5, clamp((length(ro) - aR0)/(aRt - aR0) - 0.6, 0., 1.));
  for (int i = 0; i < N; i++) {
    float f1 = float(i + 1)/float(N); f1 = pow(f1, spow);
    float tt1 = len*f1, dt = tt1 - prev; float t = tmin + prev + dt*ajit; prev = tt1;
    if (!passed && t > cloudDist) { passed = true; Tc = T; }
    vec3 p = ro + rd*t; float r = length(p);
    vec3 sr, sm, ex; atmoDensity(r - aR0, sr, sm, ex);
    vec3 S = vec3(0.);
    for (int li = 0; li < uNumLights; li++) {
      vec3 pw = toWorld(p);
      vec3 Ld = normalize(uLightPos[li] - (pw + uPlanetRel));
      float mu = dot(normalize(pw), Ld), c = dot(rdW, Ld);
      float vis = uNumOcc > 0 ? eclipse(pw + uPlanetRel, li) : 1.;
      float csh = li == 0 && cHas > 0.5 && cKind < 0.5 ? 1. - 0.85*cloudShadowAt(p, Ld) : 1.;
      S += uLightCol[li]*vis*((sr*phaseR(c) + sm*phaseM(c, aMieG))*atmoSunTrans(r, mu)*csh + (sr + sm)*atmoMulti(r, mu)*mix(1., csh, 0.4));
    }

    vec3 st = exp(-ex*dt);
    L += T*(S - S*st)/max(ex, vec3(1e-12)) * (passed ? cloudT : 1.);
    T *= st;
  }
  if (!passed) Tc = T;
  // aurora: its own march through the emitting shell (thin layers need dense sampling)
  if (uAurora > 0. && uNumLights > 0) {
    float o0, o1, i0, i1;
    if (raySphere(ro, rd, aR0 + 380000., o0, o1) > 0. && o1 > 0.) {
      float a0 = max(o0, 0.), a1 = o1;
      if (raySphere(ro, rd, aR0 + 85000., i0, i1) > 0. && i0 > 0.) a1 = i0;
      a1 = min(a1, tmax + 1e6);
      if (a1 > a0) {
        vec3 Ld0 = normalize(uLightPos[0] - uPlanetRel);
        const int NA = 40; float dta = (a1 - a0)/float(NA);
        vec3 Ea = vec3(0.);
        for (int i = 0; i < NA; i++) { vec3 pa = ro + rd*(a0 + (float(i) + jit)*dta); Ea += auroraEmission(pa, length(pa) - aR0, Ld0); }
        L += Ea*dta*(a0 < cloudDist ? 1. : cloudT);
      }
    }
  }
  inscatter = L + cloudL*Tc; trans = T*cloudT;
  if (any(isnan(inscatter)) || any(isinf(inscatter)) || any(isnan(trans))) { inscatter = vec3(0.); trans = vec3(1.); }
  inscatter = clamp(inscatter, 0., 60000.); trans = clamp(trans, 0., 1.);
}
#ifdef HALF_RES
layout(location=0) out vec4 oIn;
layout(location=1) out vec4 oTr;
void main(){
  vec3 L, T; float d, rep; volumetrics(vUV, L, T, d, rep);
  // store exposed values: unexposed night-sky radiance (~1e-8) would underflow half floats
  oIn = vec4(min(L*uExposure, vec3(60000.)), d); oTr = vec4(T, log2(max(rep, 1.)));
}
#else
out vec4 oColor;
void main(){
  vec4 scene = texture(uScene, vUV);
  vec3 L, T; float d, rep; volumetrics(vUV, L, T, d, rep);
  oColor = vec4(clamp(scene.rgb*T + L*uExposure, 0., 60000.), 1.);
}
#endif
`;


// Temporal accumulation of the half resolution volumetrics: reproject last frame's result and blend.
const RESOLVE_FS = `
in vec2 vUV;
layout(location=0) out vec4 oIn;
layout(location=1) out vec4 oTr;
uniform sampler2D uCurIn, uCurTr, uHistIn, uHistTr;
uniform mat3 uCamRot, uPrevRotInv; uniform vec2 uTanFov, uPrevTanFov, uTexel; uniform vec3 uDelta; uniform float uValid;
void main(){
  vec4 cI = texture(uCurIn, vUV), cT = texture(uCurTr, vUV);
  // neighbourhood statistics for variance clipping
  vec3 m1 = vec3(0.), m2 = vec3(0.), t1 = vec3(0.), t2 = vec3(0.);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(x, y)*uTexel;
    vec3 a = texture(uCurIn, vUV + o).rgb, b = texture(uCurTr, vUV + o).rgb;
    m1 += a; m2 += a*a; t1 += b; t2 += b*b;
  }
  m1 /= 9.; m2 /= 9.; t1 /= 9.; t2 /= 9.;
  vec3 sI = sqrt(max(m2 - m1*m1, 0.)), sT = sqrt(max(t2 - t1*t1, 0.));
  float alpha = 1.;
  vec4 hI = cI, hT = cT;
  if (uValid > 0.5) {
    vec3 rd = normalize(uCamRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
    vec3 p = rd*exp2(cT.a) + uDelta;
    vec3 v = uPrevRotInv*p;
    if (v.z < 0.) {
      vec2 puv = (v.xy/(-v.z)/uPrevTanFov)*0.5 + 0.5;
      if (all(greaterThanEqual(puv, vec2(0.))) && all(lessThanEqual(puv, vec2(1.)))) {
        hI = texture(uHistIn, puv); hT = texture(uHistTr, puv);
        bool sky = cI.a > 0.99999;
        if ((sky == (hI.a > 0.99999)) && abs(hI.a - cI.a) < 0.002) alpha = 0.1;
      }
    }
  }
  float g = 1.25;
  vec3 hi = clamp(hI.rgb, m1 - g*sI, m1 + g*sI), ht = clamp(hT.rgb, t1 - g*sT, t1 + g*sT);
  vec3 rI = mix(hi, cI.rgb, alpha), rT = mix(ht, cT.rgb, alpha);
  if (any(isnan(rI)) || any(isnan(rT))) { rI = cI.rgb; rT = cT.rgb; }
  oIn = vec4(rI, cI.a); oTr = vec4(rT, cT.a);
}`;
// Full resolution composite with depth aware upsampling of the volumetrics.
const UPSAMPLE_FS = `
in vec2 vUV; out vec4 oColor;
uniform sampler2D uScene, uDepth, uIn, uTr; uniform vec2 uHalfSize; uniform float uExpRatio;
void main(){
  vec4 scene = texture(uScene, vUV);
  float d = texture(uDepth, vUV).r;
  vec2 hp = vUV*uHalfSize - 0.5; vec2 f = fract(hp); ivec2 i0 = ivec2(floor(hp));
  ivec2 mx = ivec2(uHalfSize) - 1;
  vec3 L = vec3(0.), T = vec3(0.); float ws = 0.; float best = 1e9; vec3 bL = vec3(0.), bT = vec3(1.);
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1); ivec2 ip = clamp(i0 + o, ivec2(0), mx);
    vec4 a = texelFetch(uIn, ip, 0), b = texelFetch(uTr, ip, 0);
    float bw = (o.x == 1 ? f.x : 1. - f.x)*(o.y == 1 ? f.y : 1. - f.y);
    float dd = abs(a.a - d);
    // depth is stored at half precision (~2e-4 steps), so only penalise real discontinuities
    float w = bw/(1. + dd*2000.) + 1e-6;
    L += a.rgb*w; T += b.rgb*w; ws += w;
    if (dd < best) { best = dd; bL = a.rgb; bT = b.rgb; }
  }
  if (ws > 1e-6) { L /= ws; T /= ws; } else { L = bL; T = bT; }
  vec3 col = scene.rgb*T + L*uExpRatio;
  if (any(isnan(col)) || any(isinf(col))) col = scene.rgb;
  oColor = vec4(clamp(col, 0., 60000.), 1.);
}`;

let pVol, pResolve, pUp;
export function initAtmoPrograms() { init(); }
function init() {
  if (pTrans) return;
  pTrans = new Program('atmo-trans', FS_VS, ATMO_TRANS_FS);
  pMulti = new Program('atmo-multi', FS_VS, ATMO_MULTI_FS);
  pIrr = new Program('atmo-irr', FS_VS, ATMO_IRR_FS);
  pComp = new Program('atmo-comp', FS_VS, COMP_FS);
  pVol = new Program('atmo-vol', FS_VS, '#define HALF_RES\n' + COMP_FS);
  pResolve = new Program('atmo-resolve', FS_VS, RESOLVE_FS);
  pUp = new Program('atmo-upsample', FS_VS, UPSAMPLE_FS);
  pCloudMap = new Program('cloudmap', FS_VS, CLOUDMAP_FS);
}

export function atmoUniforms(body) {
  const a = body.atmo, s = body.surface;
  const R0 = body.radius, Rg = R0 + Math.min(0, (s.hmin || 0) * 0.5);
  return { aRg: Rg, aRt: R0 + a.top, aR0: R0, aRay: a.rayleigh, aHR: a.hR, aMieS: a.mieS, aMieA: a.mieA, aHM: a.hM, aMieG: a.mieG, aAbs: a.absorb, aAbsH: a.absH, aAbsW: a.absW };
}

const CUBE_FACES = [ // columns: right, up, forward for each cube face (+X,-X,+Y,-Y,+Z,-Z)
  [0, 0, -1, 0, -1, 0, 1, 0, 0], [0, 0, 1, 0, -1, 0, -1, 0, 0], [1, 0, 0, 0, 0, 1, 0, 1, 0], [1, 0, 0, 0, 0, -1, 0, -1, 0], [1, 0, 0, 0, -1, 0, 0, 0, 1], [-1, 0, 0, 0, -1, 0, 0, 0, -1]];
export { CUBE_FACES };

function buildCloudCube(body, l) {
  const c = body.atmo.clouds, S = atmoCfg.cloudRes;
  const ms = body.maps && body.maps._state && body.maps._state.ready ? body.maps._state : null;
  let ct = ms && ms.clouds && ms.clouds.tex, lonOff = 0, flip = 1, bias = 0;
  if (!ct && c.kind === 'earth') {
    // Earth-like worlds borrow real cloud morphology: Earth's cloud map, shifted and possibly mirrored,
    // with the coverage scaled to this planet's cloudiness
    const e = loadTexture('data/planets/earth_clouds.jpg', 'gray');
    if (e.ready) { ct = e.tex; const r = (body.uid * 0.6180339) % 1; lonOff = r; flip = body.uid % 2 ? -1 : 1; bias = (c.cover - 0.5) * 0.45; }
    else if (!l.waitClouds) { l.waitClouds = true; e.promise.then(() => { l.mapsVersion = -1; }); }
  }
  l.mapsVersion = l.mapsVersion === -1 && ct ? -2 : (body.mapsVersion || 0);
  if (!l.cloud) l.cloud = texCube(S, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
  pCloudMap.use().set({ uSeed: (body.uid * 7.31) % 50 + (body.surface.seed ? body.surface.seed[0] % 13 : 0), uCover: c.cover, uKind: c.kind === 'venus' ? 1 : 0, uHasTex: ct ? 1 : 0, uCloudTex: ct || getDummy2D(), uLonOff: lonOff, uFlip: flip, uCoverBias: bias });
  for (let i = 0; i < 6; i++) {
    const fb = fbo([l.cloud], null, i); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, S, S);
    pCloudMap.set({ uFace: new Float32Array(CUBE_FACES[i]) }); drawFS(); gl.deleteFramebuffer(fb);
  }
}
let dummy2D = null;
function getDummy2D() { if (!dummy2D) dummy2D = tex2D(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, gl.CLAMP_TO_EDGE, new Uint8Array([0, 0, 0, 255])); return dummy2D; }
export function getAtmoLUT(body) {
  init();
  let l = luts.get(body.uid);
  if (l && body.atmo.clouds && (l.mapsVersion === -1 || (l.mapsVersion >= 0 && l.mapsVersion !== (body.mapsVersion || 0)))) { buildCloudCube(body, l); }
  if (l) { l.last = performance.now(); return l; }
  const u = atmoUniforms(body);
  l = { uniforms: u, last: performance.now() };
  l.trans = tex2D(256, 64, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
  l.multi = tex2D(32, 32, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
  l.irr = tex2D(64, 1, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
  let f = fbo([l.trans]); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.viewport(0, 0, 256, 64); pTrans.use().set(u); drawFS(); gl.deleteFramebuffer(f);
  f = fbo([l.multi]); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.viewport(0, 0, 32, 32); pMulti.use().set(u).set({ uTransLUT: l.trans }); drawFS(); gl.deleteFramebuffer(f);
  f = fbo([l.irr]); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.viewport(0, 0, 64, 1); pIrr.use().set(u).set({ uTransLUT: l.trans, uMultiLUT: l.multi }); drawFS(); gl.deleteFramebuffer(f);
  if (body.atmo.clouds) buildCloudCube(body, l);
  luts.set(body.uid, l);
  if (luts.size > 12) {
    let old = null; for (const [k, v] of luts) if (!old || v.last < luts.get(old).last) old = k;
    const d = luts.get(old); gl.deleteTexture(d.trans); gl.deleteTexture(d.multi); gl.deleteTexture(d.irr); if (d.cloud) gl.deleteTexture(d.cloud); luts.delete(old);
  }
  return l;
}

// planet rotation including the slow drift of the cloud layer relative to the ground
export function cloudRotInv(body, rotQ, time) {
  const c = body.atmo && body.atmo.clouds;
  const drift = c ? Q.axis([0, 1, 0], (time * 2e-6 * (c.kind === 'venus' ? 60 : 1)) % (2 * Math.PI)) : Q.ident();
  return Q.mat3(Q.conj(Q.mul(rotQ, drift)));
}
let dummyCube = null;
export function getDummyCube() { if (!dummyCube) dummyCube = texCube(1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR); return dummyCube; }
// Composite the atmosphere of `body` over the scene. o: {scene, depth, camRot(mat3), tanFov, rel, rotQ, light, exposure, fcoef, time, noise3, frame}
export function drawAtmosphere(body, o) {
  init();
  const l = getAtmoLUT(body), c = body.atmo.clouds;
  if (!dummyCube) dummyCube = texCube(1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
  // cloud layer drifts slowly relative to the ground
  const rotInv = cloudRotInv(body, o.rotQ, o.time);
  const ms = body.maps && body.maps._state && body.maps._state.ready ? body.maps._state : null;
  const cmap = ms && ms.clouds && ms.clouds.tex;
  (o.half ? pVol : pComp).use().set(l.uniforms).set(o.light).set({
    uScene: o.scene, uDepth: o.depth, uNoise3: o.noise3, uCloudMap: l.cloud || dummyCube, uCamRot: o.camRot, uPlanetRotInv: rotInv, uTanFov: o.tanFov,
    uExposure: o.exposure, uPixAngle: o.pixAngle, uTime: o.time % 86400, uFrame: o.frame % 64, uFcoef: o.fcoef, uTransLUT: l.trans, uMultiLUT: l.multi, uIrrLUT: l.irr,
    uAurora: body.aurora || 0, uBodyRotInv: Q.mat3(Q.conj(o.rotQ)), uMagPole: body.magPole || [0, 1, 0],
    cMapped: cmap ? 1 : 0, uCloudTex2: cmap || getDummy2D(), uOblate: body.oblate || 0, cHas: c && o.clouds ? 1 : 0, cBase: c ? c.base : 0, cTop: c ? c.top : 1, cDens: c ? c.density : 0, cColor: c ? c.color : [1, 1, 1], cKind: c && c.kind === 'venus' ? 1 : 0,
    uSteps: atmoCfg.steps, uCloudSteps: atmoCfg.cloudSteps,
  });
  drawFS();
}

// Half resolution, temporally accumulated volumetrics for the dominant atmosphere on screen.
export class VolumetricTAA {
  constructor() { this.w = 0; this.h = 0; this.cur = null; this.hist = [null, null]; this.idx = 0; this.valid = false; this.key = null; }
  resize(w, h) {
    const hw = Math.max(1, Math.round(w * (this.scale || 0.5))), hh = Math.max(1, Math.round(h * (this.scale || 0.5)));
    if (hw === this.w && hh === this.h) return;
    this.w = hw; this.h = hh;
    const mk = () => { const a = tex2D(hw, hh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR), b = tex2D(hw, hh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR); return { a, b, f: fbo([a, b]) }; };
    this.cur = mk(); this.hist = [mk(), mk()]; this.valid = false;
  }
  // o: same as drawAtmosphere plus { w, h, camRot, prevCam: {rotInv, tanFov, delta} | null, key, outFBO, viewport }
  draw(body, o) {
    init();
    this.resize(o.w, o.h);
    if (this.key !== o.key || !o.prev) this.valid = false;
    this.key = o.key;
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cur.f); gl.viewport(0, 0, this.w, this.h);
    drawAtmosphere(body, Object.assign({}, o, { half: true }));
    const src = this.hist[this.idx], dst = this.hist[1 - this.idx];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f); gl.viewport(0, 0, this.w, this.h);
    pResolve.use().set({ uCurIn: this.cur.a, uCurTr: this.cur.b, uHistIn: src.a, uHistTr: src.b, uCamRot: o.camRot, uPrevRotInv: o.prev ? o.prev.rotInv : o.camRot,
      uTanFov: o.tanFov, uPrevTanFov: o.prev ? o.prev.tanFov : o.tanFov, uTexel: [1 / this.w, 1 / this.h], uDelta: o.prev ? o.prev.delta : [0, 0, 0], uValid: this.valid && !o.noHist ? 1 : 0 });
    drawFS();
    this.idx = 1 - this.idx; this.valid = true;
    // composite at full resolution
    gl.bindFramebuffer(gl.FRAMEBUFFER, o.outFBO); gl.viewport(0, 0, o.w, o.h);
    if (o.scissor) { gl.enable(gl.SCISSOR_TEST); gl.scissor(...o.scissor); }
    pUp.use().set({ uScene: o.scene, uDepth: o.depth, uIn: dst.a, uTr: dst.b, uHalfSize: [this.w, this.h], uExpRatio: 1 });
    drawFS();
    gl.disable(gl.SCISSOR_TEST);
  }
}
