// Deep sky rendering: distant galaxies (ray marched impostors), the host galaxy seen from inside (cubemap),
// and point light sources (stars, unresolved planets) with photometric brightness.
import { gl, Program, texCube, fbo, drawFS, FS_VS, makeVAO } from './gl.js';
import { V, Q } from './math.js';
import { GLSL_GALAXY, GLEVELS, galaxyCell, REAL_GALAXIES, galUniforms } from './universe.js';
import { GLSL_BB } from './stars.js';
import { REFRACT_VS } from './planet.js';
import { CUBE_FACES } from './atmosphere.js';
import { loadTexture } from './assets.js';
import { world, wrapPhase, snPhases, SN_CLASSES, SN_LIVE, popLmax, popFade, mwFormation } from './galdyn.js';
import { COSMO_GLSL, cosmoTexture, cosmo, U_NOW } from './cosmology.js';
import { variableStars } from './variables.js';

export const skyCfg = { cubeSize: 1024, galBoost: 22, extBoost: 2.5, galSteps: 72, starBoost: 1.0, galRange: 1 };
export const GAL_I0 = 2.0e-9;   // central face-on disk surface brightness in units of (solar constant / sr)
export const SUN_MAG = -26.74;

// ---------- special relativity: aberration and Doppler shift of light for a moving observer ----------
export const REL_GLSL = `
uniform vec3 uBeta;   // observer velocity / c, in the frame of the directions being transformed
// apparent direction of a source seen in (rest frame) direction n; D = Doppler factor
vec3 aberrate(vec3 n, out float D){
  float b = length(uBeta); if (b < 1e-5) { D = 1.; return n; }
  vec3 bh = uBeta/b; float g = inversesqrt(1. - b*b), c = dot(n, bh);
  float c2 = (c + b)/(1. + b*c); vec3 pp = n - c*bh; float pl = length(pp);
  D = g*(1. + b*c);
  return c2*bh + (pl > 1e-7 ? pp/pl : vec3(0.))*sqrt(max(0., 1. - c2*c2));
}
// rest frame direction of the light arriving from apparent direction np
vec3 deaberrate(vec3 np, out float D){
  float b = length(uBeta); if (b < 1e-5) { D = 1.; return np; }
  vec3 bh = uBeta/b; float g = inversesqrt(1. - b*b), c2 = dot(np, bh);
  float c = (c2 - b)/(1. - b*c2); vec3 pp = np - c2*bh; float pl = length(pp);
  D = g*(1. + b*c);
  return c*bh + (pl > 1e-7 ? pp/pl : vec3(0.))*sqrt(max(0., 1. - c*c));
}
// V band flux of a blackbody relative to another temperature (h nu / k at 550 nm = 26,160 K)
float vbandRatio(float T1, float T0){ return (exp(26160./max(T0, 1.)) - 1.)/(exp(min(26160./max(T1, 1.), 80.)) - 1.); }`;

// ---------- point sources ----------
const STAR_VS = `
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aMT; layout(location=2) in vec4 aVel;
uniform mat4 uViewProj; uniform vec3 uOffset; uniform float uExposure, uPxSA, uPixScale, uBoost; uniform vec3 uHide;
uniform float uTwinkle, uTime; uniform vec3 uUpLocal;
// motion: 0 procedural (stream and wrap in the cell), 1 catalogue (straight lines relative to the Sun), 2 fixed
uniform int uMode; uniform float uCell, uPhase, uWrapFade, uCatK, uSupp, uWeight, uLmax; uniform mat3 uRotC;
uniform float uSNph[6], uSNtau[6]; uniform int uCatDead[8]; uniform int uVarIdx[8]; uniform float uVarDm[8]; uniform float uDays, uDtDays;
${REFRACT_VS}
${REL_GLSL}
out vec3 vCol; out float vSig;
${GLSL_BB}
int snClass(float MV, float T){
  if (!(MV < -1.2 && (T > 15000. || MV < -4.5))) return -1;
  return MV < -5.5 ? 0 : MV < -4.5 ? 1 : MV < -3.5 ? 2 : MV < -2.5 ? 3 : MV < -1.6 ? 4 : 5;
}
void main(){
  vec3 lp = aPos; float w = uWeight;
  float T = abs(aMT.y);
  if (uMode == 0) {
    vec3 u = aPos + aVel.xyz*uPhase;
    lp = u - uCell*floor(u/uCell);
    // fade stars about to leave the cell (they re-enter on the opposite face)
    vec3 dExit = mix(lp, uCell - lp, step(0., aVel.xyz));
    vec3 dEnt = uCell - dExit;
    bool wrapped = any(notEqual(floor(u/uCell), vec3(0.)));
    float m = min(min(dExit.x, dExit.y), dExit.z); if (wrapped) m = min(m, min(min(dEnt.x, dEnt.y), dEnt.z));
    w *= mix(1., smoothstep(0., 0.04*uCell, m), uWrapFade);
    if (aMT.y < 0.) w *= uSupp;
  } else if (uMode == 1) {
    lp = uRotC*(aPos + aVel.xyz*uCatK);
    for (int i = 0; i < 8; i++) if (gl_VertexID == uCatDead[i]) w = 0.;
    for (int i = 0; i < 8; i++) if (gl_VertexID == uVarIdx[i]) w *= exp(-0.9210340372*uVarDm[i]);
  }
  vec3 p = lp + uOffset; float d = length(p);
  // in the far future only long-lived (faint) stars remain
  if (uMode != 2 && uLmax < 1e20) { float L = exp(-0.9210340372*(aMT.x - 4.83)); w *= smoothstep(uLmax*1.6, uLmax*0.6, L); }
  if (uMode == 0) {
    // massive stars end their lives; seen with the light travel delay
    int k = snClass(aMT.x, T);
    if (k >= 0) { float ph = fract(uSNph[k] + aVel.w - d*3.2616/uSNtau[k]); w *= step(ph, ${SN_LIVE.toFixed(4)})*smoothstep(0., 0.002, ph); }
    // pulsating variables: about one cool luminous giant in ten is a Mira (periods of 150-500 days, several magnitudes
    // in visible light), a third of yellow supergiants are Cepheids (3-50 days, about a magnitude). A frame spanning
    // more than a cycle shows the average brightness rather than a random phase.
    float hv = fract(aVel.w*7.31 + 0.13), dmv = 0.;
    if (T < 3600. && aMT.x < 0.5 && hv < 0.1) {
      float P = mix(150., 500., fract(hv*53.1)), A = mix(2.5, 6., fract(hv*91.7)), ph = fract(uDays/P + fract(hv*17.3));
      dmv = A*clamp(1. - uDtDays/P, 0., 1.)*(pow(0.5 - 0.5*cos(6.2832*ph), 0.7) - 0.55);
    } else if (T > 5000. && T < 7000. && aMT.x < -2. && hv < 0.3) {
      float P = exp(mix(log(3.), log(50.), fract(hv*41.3))), ph = fract(uDays/P + fract(hv*29.1));
      float saw = ph < 0.25 ? ph/0.25 : 1. - (ph - 0.25)/0.75;     // fast rise, slow decline
      dmv = -0.9*clamp(1. - uDtDays/P, 0., 1.)*(saw - 0.4);
    }
    w *= exp(-0.9210340372*dmv);
  }
  float m = aMT.x + 5.*log(max(d, 1e-9))/log(10.) - 5.;
  float flux = exp(-0.9210340372*(m + 26.74))*w;
  // moving observer: stars crowd towards the direction of travel, bluer and brighter ahead, redder behind
  float Dop; vec3 pn = aberrate(p/d, Dop); p = pn*d;
  if (Dop != 1.) { flux *= vbandRatio(T*Dop, T); T *= Dop; }
  if (uTwinkle > 0.) {
    // scintillation: turbulence in the air above an observer on the ground; strongest near the horizon
    float el = dot(p/d, uUpLocal);
    float am = 1./max(el + 0.05, 0.05);
    float ph = uTime*(9. + fract(T*0.137)*7.) + fract(aPos.x*13.17 + aPos.z*7.31)*628.;
    float tw = sin(ph) * 0.6 + sin(ph*2.31 + 1.7)*0.4;
    flux *= max(0., 1. + tw*uTwinkle*min(0.15*am, 0.85));
  }
  float I = flux/uPxSA*uExposure*uBoost;     // energy in units of one fully lit pixel
  float sig = 0.62*uPixScale;
  float peak = I/(6.2832*sig*sig);
  if (peak > 3.) { sig = min(sqrt(I/(6.2832*3.)), 2.6*uPixScale); peak = I/(6.2832*sig*sig); }
  vec3 c = bbColor(T); c /= dot(c, vec3(0.2126, 0.7152, 0.0722));
  vCol = c*min(peak, 4000.); vSig = sig;
  gl_Position = uViewProj*vec4(refractLift(p), 1.); gl_Position.z = 0.;
  gl_PointSize = peak < 0.0012 || distance(p, uHide) < 2e-3 ? 0. : ceil(sig*6. + 1.) * (peak > 30. ? min(1. + log(peak/30.)*0.9, 6.) : 1.);
  if (gl_PointSize == 0.) gl_Position = vec4(2., 2., 2., 1.);
}`;
const STAR_FS = `
in vec3 vCol; in float vSig; out vec4 o;
void main(){
  float pk = max(max(vCol.r, vCol.g), vCol.b);
  float grow = pk > 30. ? min(1. + log(pk/30.)*0.9, 6.) : 1.;
  float sz = ceil(vSig*6. + 1.)*grow; vec2 d = (gl_PointCoord - 0.5)*sz; float r = length(d);
  float g = exp(-r*r/(2.*vSig*vSig));
  // diffraction spikes and a soft halo on bright sources, falling off over the enlarged sprite
  float bright = smoothstep(1.2, 2.5, vSig);
  float ax = abs(d.x)/vSig, ay = abs(d.y)/vSig;
  float sp = (exp(-d.y*d.y*1.6)/((1. + ax)*(1. + ax)) + exp(-d.x*d.x*1.6)/((1. + ay)*(1. + ay)))*0.09*bright;
  float halo = grow > 1. ? 0.004/(1. + r*r/(vSig*vSig*4.)) : 0.;
  o = vec4(vCol*(g + sp + halo)*smoothstep(0.5*sz, 0.3*sz, r), 1.);
}`;

const PT_VS = `
layout(location=0) in vec3 aDir; layout(location=1) in vec4 aCol;
uniform mat4 uViewProj; uniform float uExposure, uPxSA, uPixScale;
out vec3 vCol; out float vSig;
${REFRACT_VS}
${REL_GLSL}
void main(){
  float Dop; vec3 dir = aberrate(normalize(aDir), Dop)*length(aDir);
  float I = aCol.a/uPxSA*uExposure*Dop*Dop*Dop;
  float sig = 0.62*uPixScale;
  float peak = I/(6.2832*sig*sig);
  // very bright points keep a compact core (the eye/camera PSF) and let bloom and spikes carry the glare
  if (peak > 3.) { sig = min(sqrt(I/(6.2832*3.)), 2.6*uPixScale); peak = I/(6.2832*sig*sig); }
  vCol = aCol.rgb*min(peak, 4000.); vSig = sig;
  gl_Position = uViewProj*vec4(refractLift(dir), 1.); gl_Position.z = 0.;
  gl_PointSize = peak < 0.0005 ? 0. : ceil(sig*6. + 1.) * (peak > 30. ? min(1. + log(peak/30.)*0.9, 6.) : 1.);
  if (gl_PointSize == 0.) gl_Position = vec4(2., 2., 2., 1.);
}`;

// ---------- galaxy impostors ----------
const GAL_VS = `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aCen; layout(location=2) in vec4 aQuat; layout(location=3) in vec4 aP0; layout(location=4) in vec4 aP1; layout(location=5) in vec4 aP2; layout(location=6) in float aLum;
uniform mat4 uViewProj; uniform vec3 uOffset, uOrigin, uCamU; uniform float uPxPerRad, uScale, uTmyr, uYrs, uDtYrs; uniform vec3 uSkip;
out vec3 vWorld; flat out vec3 vCen; flat out vec4 vQuat, vP0, vP1, vP2; flat out vec2 vLum; flat out float vPx; flat out vec2 vCos; flat out float vTauE; flat out vec3 vSN; flat out float vQSO;
${COSMO_GLSL}
${REL_GLSL}
void main(){
  // expanding universe: seen with the light travel delay, smaller, dimmer and redder as time goes on
  vec3 wp = aCen.xyz + uOrigin; vec3 cv = cosmoView(length(wp));
  vec3 c = wp*cv.x - uCamU; float d = length(c);
  float Dop; c = aberrate(c/max(d, 1e-12), Dop)*d;
  vCos = vec2(cv.y*Dop*Dop*Dop, cv.z/Dop);
  // the galaxy as it was when this light left it: none before ~300 Myr, then small, blue and star-bursting
  float chi = length(wp);
  vTauE = chi < 3. ? uTauObs : cosmoTau(exp(cosmoLnA(uUobs + chi)));
  // supernovae: roughly one per 60 years in a Milky Way sized galaxy (more while young and star forming); at peak one
  // can rival its whole galaxy for a few weeks. Too short to see once a frame spans more than a few months.
  vSN = vec3(0.);
  if (uDtYrs < 0.25) {
    float h = fract(sin(dot(aCen.xyz, vec3(12.9898, 78.233, 37.719)))*43758.5453);
    float rate = 0.016*clamp(aLum, 0.05, 6.)*(1. + 2.*(1. - smoothstep(1., 6., vTauE)));
    float x = uYrs*rate + h*97.;
    float age = fract(x)/rate, k = floor(x);
    float lc = age < 0.06 ? age/0.06 : exp(-(age - 0.06)/0.12);       // ~3 week rise, months of decline
    float ang = fract(sin(k*91.7 + h*13.1)*4375.85)*6.2832, rr = 0.15 + 0.5*fract(sin(k*17.3 + h*7.7)*9631.3);
    vSN = vec3(cos(ang)*rr, sin(ang)*rr, 0.25*lc*step(age, 2.));
  }
  // quasars: gas falling into the central black hole outshines the galaxy (up to ~30x) for episodes of tens of Myr.
  // The fraction of galaxies with one peaked ~10-11 Gyr ago ("cosmic noon", z ~ 2-3) and is ~30x lower today.
  {
    float hq = fract(sin(dot(aCen.xyz, vec3(39.1, 11.7, 83.3)))*24634.6345);
    float fq = (0.04*exp(-pow((vTauE - 3.3)/1.8, 2.)) + 0.0015)*smoothstep(0.6, 1.2, vTauE)*step(0.3, aLum);
    float ep = floor(vTauE*20. + hq*7.);                    // ~50 Myr episodes
    float u = fract(sin(ep*12.9898 + hq*78.233)*43758.5453);
    vQSO = u < fq ? mix(1., 30., pow(fract(u*917.3), 3.)) : 0.;
  }
  float young = 1. - smoothstep(1., 6., vTauE);
  float rad = aCen.w*1.08*mix(1., 0.45, young);
  float px = rad/d*uPxPerRad;
  float expand = max(1., 2.6/px);   // unresolved galaxies still cover a few pixels: seeing and the PSF smear them
  vec3 f = c/d; vec3 r = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0,1,0) : vec3(1,0,0))); vec3 u = cross(r, f);
  vec3 w = c + (r*aCorner.x + u*aCorner.y)*rad*expand;
  if (d < rad*0.92) w = c + f*0.0;   // camera inside: handled by the sky cubemap
  // disks turn: about 220 km/s at half the radius (a 200 Myr period for a Milky Way sized spiral)
  vec4 q = aQuat;
  if (length(wp) > 1e-3 && uTmyr != 0.) { float ang = -uTmyr*0.45/(aCen.w*1000.); vec4 r = vec4(0., sin(ang*0.5), 0., cos(ang*0.5)); q = vec4(q.w*r.xyz + r.w*q.xyz + cross(q.xyz, r.xyz), q.w*r.w - dot(q.xyz, r.xyz)); }
  vWorld = w; vCen = c; vQuat = q; vP0 = aP0; vP1 = aP1; vP2 = aP2;
  // early disks (seen in their first few Gyr) were thick, turbulent and clumpy: weak spiral arms, few bars, more young stars
  vP1.y *= smoothstep(1.5, 5., vTauE); vP2.y *= smoothstep(3., 7., vTauE); vP2.x *= mix(2.5, 1., smoothstep(2., 8., vTauE)); vP2.w *= 1. + 1.5*young; vLum = vec2(aLum, expand); vPx = px;
  gl_Position = uViewProj*vec4(w, 1.); gl_Position.z = 0.;
  float est = (aP0.x < 0.5 ? 0.45 : 0.2 + 0.02*aP0.y)/(expand*expand)*1.6*aLum*uScale*cv.y*smoothstep(0.18, 1.0, vTauE)*(1. + vQSO);
  if (distance(aCen.xyz, uSkip) < 1e-7 || px < 0.05 || (expand > 1. && est < 0.0012)) gl_Position = vec4(2., 2., 2., 1.);
}`;
// The impostor fragment shader is assembled below with the radius passed explicitly (clearer than recovering it).
const GAL_FS2 = `
in vec3 vWorld; flat in vec3 vCen; flat in vec4 vQuat, vP0, vP1, vP2; flat in vec2 vLum; flat in float vPx; flat in float vRad; flat in vec2 vCos; flat in float vTauE; flat in vec3 vSN; flat in float vQSO;
// cosmological redshift: dimming is applied as (1+z)^-4; the spectrum slides to the red (blue light leaves first).
// Young galaxies (seen as they were in the first few billion years) are forming stars fast: brighter and bluer.
vec3 zTint(){ float k = log2(max(vCos.y, 1.)); float young = 1. - smoothstep(1., 6., vTauE);
  vec3 evo = smoothstep(0.18, 1.0, vTauE)*(1. + 1.2*young)*mix(vec3(1.), vec3(0.72, 0.88, 1.3), young*0.7);
  // once star formation has run out of gas, the hot blue stars die first: galaxies yellow, then glow dull red (red dwarfs)
  float old = smoothstep(14., 60., vTauE), dwarf = smoothstep(60., 2000., vTauE);
  evo *= mix(vec3(1.), mix(vec3(1.15, 0.9, 0.68), vec3(1.35, 0.62, 0.32), dwarf), old);
  return vCos.x*exp2(-k*vec3(0.15, 0.7, 1.5))*evo; }
uniform float uScale; uniform int uMaxSteps;
out vec4 o;
${GLSL_GALAXY}
vec3 qrot(vec4 q, vec3 v){ return v + 2.*cross(q.xyz, cross(q.xyz, v) + q.w*v); }
float ign(vec2 p){ return fract(52.9829189*fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  Gal g = Gal(vP0.x, vP0.y, vP0.z, vP0.w, vP1.x, vP1.y, vP1.z, vP1.w, vP2.x, vP2.y, vP2.z, vP2.w, vLum.x);
  vec3 rdW = normalize(vWorld);
  if (vLum.y > 1.001) {
    // unresolved: an ellipse with the galaxy's projected shape (disk normal from its orientation)
    vec3 f = normalize(vCen);
    vec3 nrm = qrot(vQuat, vec3(0., 1., 0.));
    float axr = g.type < 0.5 ? g.flatn : (g.type > 3.5 ? 0.5 : 0.12);
    float ci = abs(dot(nrm, f));                       // 1 face-on, 0 edge-on
    float ratio = max(axr, ci);
    vec3 major = normalize(cross(nrm, f) + vec3(1e-6));
    vec3 off = (vWorld - vCen)/(vRad*1.08*vLum.y);
    vec3 offp = off - f*dot(off, f);
    float x = dot(offp, major), y = length(offp - major*x);
    float t2 = x*x + (y*y)/(ratio*ratio);
    float gsn = exp(-t2*3.2)/ratio*smoothstep(1., 0.7, length(offp));     // (round window: no square sprite edges)
    float t = sqrt(t2);
    float tot = (g.type < 0.5 ? 0.45 : 0.2 + 0.02*g.bulge)/(vLum.y*vLum.y)*1.6;
    vec3 col = mix(vec3(1.0, 0.82, 0.6), vec3(0.8, 0.86, 1.0), clamp(g.young*0.5, 0., 1.)*(g.type < 0.5 ? 0. : 1.));
    // a supernova in this galaxy: a point (one pixel wide) at its position in the disk
    vec3 sn = vec3(0.);
    if (vSN.z > 0.001) {
      vec2 sp = vSN.xy/(1.08*vLum.y); float sg = 0.7/max(vPx*1.08*vLum.y, 1e-3);
      vec2 dd = vec2(x, y) - vec2(sp.x, sp.y*ratio);
      sn = vec3(0.85, 0.9, 1.0)*vSN.z*tot*0.98*exp(-dot(dd, dd)/(2.*sg*sg))/(6.2832*sg*sg);
    }
    // an active nucleus: a point at the centre (blue-white, power-law continuum)
    if (vQSO > 0.) { float sg = 0.7/max(vPx*1.08*vLum.y, 1e-3); sn += vec3(0.8, 0.88, 1.0)*vQSO*tot*exp(-(x*x + y*y)/(2.*sg*sg))/(6.2832*sg*sg); }
    o = vec4((col*tot*gsn + sn)*g.lum*uScale*zTint(), 1.); return;
  }
  vec4 qi = vec4(-vQuat.xyz, vQuat.w);
  vec3 ro = qrot(qi, -vCen)/vRad, rd = qrot(qi, rdW);
  // bounding spheroid: flatten in y
  float fy = g.type < 0.5 ? 1. : (g.type > 3.5 ? 1.5 : 3.0);
  vec3 ro2 = ro*vec3(1., fy, 1.), rd2 = rd*vec3(1., fy, 1.);
  float A = dot(rd2, rd2), B = dot(ro2, rd2), Cc = dot(ro2, ro2) - 1.08*1.08;
  float h = B*B - A*Cc; if (h < 0.) { o = vec4(0., 0., 0., 1.); return; }
  h = sqrt(h); float t0 = max((-B - h)/A, 0.), t1 = (-B + h)/A;
  if (t1 <= t0) { o = vec4(0., 0., 0., 1.); return; }
  int N = int(clamp(vPx*0.6, 10., float(uMaxSteps)));
  float detail = vPx > 400. ? 2. : (vPx > 28. ? 1. : 0.);
  float dt = (t1 - t0)/float(N), jit = ign(gl_FragCoord.xy);
  vec3 L = vec3(0.); vec3 T = vec3(1.);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd*(t0 + (float(i) + jit)*dt);
    vec3 e; float k; galSample(g, p, detail, e, k);
    vec3 kk = k*vec3(0.72, 1.0, 1.4);
    vec3 st = exp(-kk*dt);
    L += T*e*(k > 1e-4 ? (1. - st)/kk : vec3(dt));
    T *= st;
    if (T.g < 0.01) break;
  }
  vec3 res = L*g.lum*uScale*zTint();
  if (vQSO > 0.) {
    // (resolved galaxy: the nucleus as a point source, ~1.5 px wide)
    float ang = length(cross(rdW, normalize(vCen))), rpx = ang*length(vCen)/(vRad*1.08)*vPx;
    res += vec3(0.8, 0.88, 1.0)*vQSO*(g.type < 0.5 ? 0.45 : 0.2 + 0.02*g.bulge)*1.6*exp(-rpx*rpx/1.1)/(3.5*vPx*vPx)*g.lum*uScale*zTint();
  }
  if (any(isnan(res)) || any(isinf(res))) res = vec3(0.);
  o = vec4(min(res, vec3(60000.)), T.g);
}`;

const CUBE_FS = `
in vec2 vUV; out vec4 o;
uniform mat3 uFace; uniform vec3 uCam; uniform int uSteps;
uniform float gP[13];
${GLSL_GALAXY}
float ign(vec2 p){ return fract(52.9829189*fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  Gal g = Gal(gP[0], gP[1], gP[2], gP[3], gP[4], gP[5], gP[6], gP[7], gP[8], gP[9], gP[10], gP[11], gP[12]);
  vec3 rd = normalize(uFace*vec3(vUV*2. - 1., 1.));
  vec3 ro = uCam;
  float b = dot(ro, rd), c = dot(ro, ro) - 1.15*1.15, h = b*b - c;
  if (h < 0.) { o = vec4(0., 0., 0., 1.); return; }
  h = sqrt(h); float t0 = max(-b - h, 0.), t1 = -b + h;
  if (t1 <= t0) { o = vec4(0., 0., 0., 1.); return; }
  float len = t1 - t0; const float K = 5.5; float eK = exp(K) - 1.;
  float jit = ign(gl_FragCoord.xy);
  vec3 L = vec3(0.); vec3 T = vec3(1.); float prev = 0.;
  float ylim = g.type < 0.5 ? 2. : (g.type > 3.5 ? g.hz*30. : max(g.hz*9., g.rb*3.5));
  for (int i = 0; i < uSteps; i++) {
    float f1 = (exp(K*float(i + 1)/float(uSteps)) - 1.)/eK;
    float tt = len*f1, dt = tt - prev; float t = t0 + prev + dt*jit; prev = tt;
    vec3 p = ro + rd*t;
    if (abs(p.y) > ylim) { if (p.y*rd.y > 0.) break; continue; }
    vec3 e; float k; galSample(g, p, t < 0.25 ? 2. : 1., e, k);
    // stars within a few hundred parsecs are drawn individually by the star field: don't count their light twice
    e *= smoothstep(0.004, 0.02, t);
    vec3 kk = k*vec3(0.72, 1.0, 1.4);
    vec3 st = exp(-kk*dt);
    L += T*e*(k > 1e-4 ? (1. - st)/kk : vec3(dt));
    T *= st;
    if (T.g < 0.005) break;
  }
  vec4 res = vec4(L*g.lum, T.g);
  if (any(isnan(res)) || any(isinf(res))) res = vec4(0., 0., 0., 1.);
  o = clamp(res, 0., 30000.);
}`;
const CUBEDRAW_FS = `
in vec2 vUV; out vec4 o;
uniform samplerCube uCube; uniform mat3 uRot; uniform vec2 uTanFov; uniform float uScale, uFade;
${REL_GLSL}
void main(){ vec3 rd = normalize(uRot*vec3((vUV*2. - 1.)*uTanFov, -1.)); float Dop; rd = deaberrate(rd, Dop); vec4 c = texture(uCube, rd); c.rgb *= Dop == 1. ? 1. : vbandRatio(4500.*Dop, 4500.)*Dop; if (any(isnan(c)) || any(isinf(c))) c = vec4(0., 0., 0., 1.); o = vec4(c.rgb*uScale, mix(1., clamp(c.a, 0., 1.), uFade)); }`;

let pStar, pPt, pGal, pCube, pCubeDraw, quadBuf, ptVAO, ptBuf;
export function initSkyPrograms() { init(); if (!pCon) pCon = new Program('constellations', CON_VS, CON_FS); initSkyMapProgram(); initZodiProgram(); }
function init() {
  if (pStar) return;
  pStar = new Program('stars', STAR_VS, STAR_FS);
  pPt = new Program('points', PT_VS, STAR_FS);
  pGal = new Program('galaxies', GAL_VS.replace('flat out float vPx;', 'flat out float vPx; flat out float vRad;').replace('vPx = px;', 'vPx = px; vRad = aCen.w*mix(1., 0.45, 1. - smoothstep(1., 6., vTauE));'), GAL_FS2);
  pCube = new Program('galcube', FS_VS, CUBE_FS);
  pCubeDraw = new Program('galcubedraw', FS_VS, CUBEDRAW_FS);
  quadBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  ptVAO = gl.createVertexArray(); gl.bindVertexArray(ptVAO);
  ptBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
  gl.bindVertexArray(null);
}

// ----- stars of a StarField -----
export function drawStars(field, camLocal, viewProjLocal, o) {
  init();
  const p = pStar.use();
  const tyr = world.tyr;
  p.set({ uViewProj: viewProjLocal, uExposure: o.exposure * mwFormation(tyr), uPxSA: o.pxSA, uPixScale: o.pixScale, uBoost: skyCfg.starBoost, uTwinkle: o.twinkle || 0, uTime: (performance.now() / 1000) % 1000, uUpLocal: o.upLocal || [0, 1, 0], uRefrK: o.refrK || 0, uRefrUp: o.upLocal || [0, 1, 0],
    uBeta: o.betaLocal || [0, 0, 0], uWrapFade: Math.min(1, Math.abs(tyr) / 1000), uLmax: Math.min(popLmax(tyr), 1e21), uSupp: 1 - world.catW, uSNph: new Float32Array(snPhases(tyr)), uSNtau: new Float32Array(SN_CLASSES.map(c => c.tau)), uRotC: new Float32Array(world.rotP),
    uCatDead: new Int32Array(field.deadList || [-1, -1, -1, -1, -1, -1, -1, -1]) });
  { const v = variableStars(world.time, Math.abs(world.dtyr) * 365.25); p.set({ uVarIdx: v.idx, uVarDm: v.dm, uDays: (world.time / 86400) % 1e5, uDtDays: Math.abs(world.dtyr) * 365.25 }); }
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  let n = 0;
  const hide = o.hide;
  for (const c of field.cells.values()) {
    if (!c.vao || c.hidden) continue;
    let mode = 2, origin = c.origin, wgt = 1;
    if (c.catalog) { mode = 1; origin = world.sunP; wgt = world.catW; if (wgt <= 0) continue; }
    else if (c.vel) mode = 0;
    const off = [origin[0] - camLocal[0], origin[1] - camLocal[1], origin[2] - camLocal[2]];
    p.set({ uOffset: off, uHide: hide ? [hide[0] - camLocal[0], hide[1] - camLocal[1], hide[2] - camLocal[2]] : [1e9, 1e9, 1e9], uMode: mode, uWeight: wgt,
      uCell: c.size || 1, uPhase: mode === 0 ? wrapPhase(c.size, tyr) : 0, uCatK: world.catK });
    gl.bindVertexArray(c.vao.vao); gl.drawArrays(gl.POINTS, 0, c.n); n += c.n;
  }
  return n;
}

// ----- generic points: list of {dir:[3], color:[3], flux} -----
export function drawPoints(list, viewProj, o) {
  init(); if (!list.length) return;
  const data = new Float32Array(list.length * 7);
  list.forEach((q, i) => { data.set(q.dir, i * 7); data.set(q.color, i * 7 + 3); data[i * 7 + 6] = q.flux; });
  gl.bindVertexArray(ptVAO); gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  pPt.use().set({ uViewProj: viewProj, uExposure: o.exposure, uPxSA: o.pxSA, uPixScale: o.pixScale, uRefrK: o.refrK || 0, uRefrUp: o.refrUp || [0, 1, 0], uBeta: o.betaWorld || [0, 0, 0] });
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  gl.drawArrays(gl.POINTS, 0, list.length);
}

// ----- galaxies -----
const galBuffers = new Map();
function galCellVAO(cell) {
  let b = galBuffers.get(cell.key);
  if (b) return b;
  const n = cell.list.length, data = new Float32Array(n * 21);
  cell.list.forEach((g, i) => {
    const o = i * 21, u = galUniforms(g);
    data.set([g.posU[0] - cell.origin[0], g.posU[1] - cell.origin[1], g.posU[2] - cell.origin[2], g.radius * 1e-6], o);
    data.set(g.quat, o + 4);
    data.set([u.type, u.bulge, u.rb, u.arms, u.pitch, u.armStr, u.dust, u.seed, u.hz, u.bar, u.flatn, u.young, u.lum], o + 8);
  });
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const st = 84;
  [[1, 4, 0], [2, 4, 16], [3, 4, 32], [4, 4, 48], [5, 4, 64], [6, 1, 80]].forEach(([loc, size, off]) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, st, off); gl.vertexAttribDivisor(loc, 1); });
  gl.bindVertexArray(null);
  b = { vao, buf, n, last: 0 }; galBuffers.set(cell.key, b);
  return b;
}
const REAL_CELL = { key: 'real', list: REAL_GALAXIES, origin: [0, 0, 0] };
// the real galaxies move (Andromeda approaching) and turn (the Milky Way's pattern): rebuild their buffer now and then
export function invalidateRealGalaxies() { for (const k of [...galBuffers.keys()]) if (k.startsWith('real')) { const b = galBuffers.get(k); gl.deleteVertexArray(b.vao); gl.deleteBuffer(b.buf); galBuffers.delete(k); } }
export const visibleGalaxyCells = [];
let galFrame = 0;
export function drawGalaxies(camU, viewProj, o) {
  init(); galFrame++;
  const p = pGal.use();
  // other galaxies get only a small visibility boost: exposure adapts in deep space, and near bright subjects they should vanish
  p.set({ uViewProj: viewProj, uPxPerRad: o.pxPerRad, uBeta: o.betaWorld || [0, 0, 0], uMaxSteps: skyCfg.galSteps, uNoise3: o.noise3, uCosmo: cosmoTexture(), uUnow: U_NOW, uUobs: cosmo.u, uAobs: cosmo.a, uTauObs: cosmo.tau, uYrs: world.tyr % 1e4, uDtYrs: Math.abs(world.dtyr), uTmyr: (world.tyr % 1e12) / 1e6, uScale: GAL_I0 * skyCfg.extBoost * o.exposure * popFade(world.tyr) });
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  visibleGalaxyCells.length = 0;
  const skip = o.skip;
  const drawCell = (cell) => {
    if (!cell.list.length) return;
    const b = galCellVAO(cell); b.last = galFrame;
    visibleGalaxyCells.push(cell);
    p.set({ uOffset: [cell.origin[0] - camU[0], cell.origin[1] - camU[1], cell.origin[2] - camU[2]], uOrigin: cell.origin, uCamU: camU, uSkip: skip ? [skip.posU[0] - cell.origin[0], skip.posU[1] - cell.origin[1], skip.posU[2] - cell.origin[2]] : [1e9, 1e9, 1e9] });
    gl.bindVertexArray(b.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
  };
  let budget = 3;
  for (let lv = 0; lv < GLEVELS.length; lv++) {
    const L = GLEVELS[lv], r = L.radius * skyCfg.galRange, s = L.cell;
    const x0 = Math.floor((camU[0] - r) / s), x1 = Math.floor((camU[0] + r) / s), y0 = Math.floor((camU[1] - r) / s), y1 = Math.floor((camU[1] + r) / s), z0 = Math.floor((camU[2] - r) / s), z1 = Math.floor((camU[2] + r) / s);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const nx = Math.max(x * s, Math.min(camU[0], (x + 1) * s)) - camU[0], ny = Math.max(y * s, Math.min(camU[1], (y + 1) * s)) - camU[1], nz = Math.max(z * s, Math.min(camU[2], (z + 1) * s)) - camU[2];
      if (nx * nx + ny * ny + nz * nz > r * r) continue;
      const key = lv + ':' + x + ':' + y + ':' + z;
      if (!galBuffers.has(key)) { if (budget <= 0 && !o.sync) continue; budget--; }
      drawCell(galaxyCell(lv, x, y, z));
    }
  }
  const hidden = o.hideReal;   // galaxies drawn as N-body particles instead
  if (o.realSkyNear) {
    // the photographed sky already contains the Magellanic Clouds, M31 and M33
    const keep = { key: 'real-far' + (hidden ? hidden.key : ''), list: REAL_GALAXIES.filter(g => !/Magellanic|M31|M33/.test(g.name) && !(hidden && hidden.has(g))), origin: [0, 0, 0] };
    drawCell(keep);
  } else if (hidden && hidden.size) drawCell({ key: 'real-h' + hidden.key, list: REAL_GALAXIES.filter(g => !hidden.has(g)), origin: [0, 0, 0] });
  else drawCell(REAL_CELL);
  if (galFrame % 60 === 0) for (const [k, b] of galBuffers) if (galFrame - b.last > 300) { gl.deleteVertexArray(b.vao); gl.deleteBuffer(b.buf); galBuffers.delete(k); }
}

// ----- host galaxy sky cubemap -----
export class GalaxySky {
  constructor() { init(); this.size = skyCfg.cubeSize; this.front = this.mk(); this.back = this.mk(); this.gal = null; this.pos = null; this.face = -1; this.valid = false; }
  mk() { const t = texCube(this.size, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR); const f = []; for (let i = 0; i < 6; i++) f.push(fbo([t], null, i)); return { t, f }; }
  // camN: camera position in galaxy local frame, normalised by galaxy radius
  update(gal, camN, noise3, sync) {
    if (this.gal !== gal) { this.gal = gal; this.valid = false; this.face = -1; this.pos = null; }
    // (rebuilt when the galaxy's young population changes with time)
    if (this.face < 0 && this.young !== undefined && this.young !== gal.young) this.pos = null;
    this.young = gal.young;
    if (this.face < 0) {
      const moved = this.pos ? V.dist(camN, this.pos) : 1e9;
      const scale = Math.max(0.0012, 0.02 * Math.min(1, Math.abs(camN[1]) * 8 + 0.03));
      if (moved > scale) { this.face = 0; this.newPos = camN.slice(); } else return;
    }
    const u = galUniforms(gal);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    // The cube is rebuilt in 24 strips (4 per face), one per frame, so updating it never costs a whole face at once.
    const STRIPS = 4, q = this.size / STRIPS;
    pCube.use().set({ uCam: this.newPos, uSteps: 150, uNoise3: noise3, gP: new Float32Array([u.type, u.bulge, u.rb, u.arms, u.pitch, u.armStr, u.dust, u.seed, u.hz, u.bar, u.flatn, u.young, u.lum]) });
    gl.enable(gl.SCISSOR_TEST);
    do {
      const f = Math.floor(this.face), strip = Math.round((this.face - f) * STRIPS);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.back.f[f]); gl.viewport(0, 0, this.size, this.size);
      gl.scissor(0, strip * q, this.size, q);
      pCube.set({ uFace: new Float32Array(CUBE_FACES[f]) });
      drawFS();
      this.face = strip + 1 >= STRIPS ? f + 1 : f + (strip + 1) / STRIPS;
    } while (sync && this.face < 6);
    gl.disable(gl.SCISSOR_TEST);
    if (this.face >= 6) { const t = this.front; this.front = this.back; this.back = t; this.face = -1; this.pos = this.newPos; this.valid = true; }
  }
  // the background cube for shaders that need the sky in any direction (light bent by black holes)
  lookup(exposure, weight = 1) { return this.valid && weight > 0 ? { tex: this.front.t, scale: GAL_I0 * skyCfg.galBoost * exposure * weight * popFade(world.tyr) } : null; }
  draw(rotLocalFromView, tanFov, exposure, weight = 1, betaLocal = null) {
    if (!this.valid || weight <= 0) return;
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
    pCubeDraw.use().set({ uCube: this.front.t, uRot: rotLocalFromView, uTanFov: tanFov, uScale: GAL_I0 * skyCfg.galBoost * exposure * weight * popFade(world.tyr), uFade: weight, uBeta: betaLocal || [0, 0, 0] });
    drawFS();
  }
}

// ----- constellation figures (3D lines between catalogue stars, so they distort as you travel) -----
const CON_VS = `layout(location=0) in vec3 aPos; layout(location=1) in vec3 aVel; uniform mat4 uViewProj; uniform vec3 uOffset; uniform mat3 uRotC; uniform float uCatK; out float vD;
void main(){ vec3 p = uRotC*(aPos + aVel*uCatK) + uOffset; vD = length(p); gl_Position = uViewProj*vec4(p, 1.); gl_Position.z = 0.; }`;
const CON_FS = `in float vD; out vec4 o; uniform float uAlpha; void main(){ o = vec4(vec3(0.22, 0.42, 0.85)*uAlpha, 0.); }`;
let pCon = null, conVAO = null, conCount = 0;
// constellation figures follow the stars' own motions, so they distort over tens of thousands of years
export function drawConstellations(catalog, sunLocal, camLocal, viewProjLocal, alpha) {
  if (!catalog.ready || alpha <= 0) return;
  if (!pCon) pCon = new Program('constellations', CON_VS, CON_FS);
  if (!conVAO) {
    const pts = [], d = catalog.data, v = catalog.vel;
    const add = (a) => pts.push(d[a * 5], d[a * 5 + 1], d[a * 5 + 2], v[a * 4], v[a * 4 + 1], v[a * 4 + 2]);
    for (const c of catalog.constellations) for (const [a, b] of c.lines) { add(a); add(b); }
    conVAO = gl.createVertexArray(); gl.bindVertexArray(conVAO);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12); conCount = pts.length / 6;
    gl.bindVertexArray(null);
  }
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  pCon.use().set({ uViewProj: viewProjLocal, uOffset: [sunLocal[0] - camLocal[0], sunLocal[1] - camLocal[1], sunLocal[2] - camLocal[2]], uAlpha: alpha * world.catW * Math.max(0, Math.min(1, 1 - (Math.abs(world.tyr) - 1e5) / 2e5)), uRotC: new Float32Array(world.rotP), uCatK: world.catK });
  gl.bindVertexArray(conVAO); gl.drawArrays(gl.LINES, 0, conCount);
}

// ----- the real Milky Way seen from near the Sun (ESO panorama in galactic coordinates, stars removed) -----
const MAP_FS = `in vec2 vUV; out vec4 o;
uniform sampler2D uMap; uniform mat3 uRot; uniform vec2 uTanFov; uniform float uScale;
${REL_GLSL}
void main(){
  vec3 d = normalize(uRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  float Dop; d = deaberrate(d, Dop);
  float l = atan(-d.z, d.x), b = asin(clamp(d.y, -1., 1.));
  vec2 uv = vec2(0.5 - l/6.2831853, 0.5 - b/3.14159265);
  vec3 c = textureLod(uMap, uv, 0.).rgb;
  // keep the band of the Milky Way and the Local Group galaxies; far from the plane the photo only holds
  // artefacts of its own (airglow gradients, zodiacal light, planets) which would not move with the real sky
  float bd = degrees(abs(b));
  float keep = smoothstep(52., 38., bd);
  vec3 lmc = vec3(cos(radians(-32.89))*cos(radians(280.47)), sin(radians(-32.89)), -cos(radians(-32.89))*sin(radians(280.47)));
  vec3 smc = vec3(cos(radians(-44.3))*cos(radians(302.8)), sin(radians(-44.3)), -cos(radians(-44.3))*sin(radians(302.8)));
  keep = max(keep, smoothstep(cos(radians(9.)), cos(radians(5.)), dot(d, lmc)));
  keep = max(keep, smoothstep(cos(radians(5.)), cos(radians(3.)), dot(d, smc)));
  o = vec4(max(c - 0.0017, 0.)*uScale*keep*(Dop == 1. ? 1. : vbandRatio(4500.*Dop, 4500.)*Dop), 1.);
}`;
let pMap = null;
export function initSkyMapProgram() { if (!pMap) pMap = new Program('skymap', FS_VS, MAP_FS); }
// rotLocalFromView: view -> galaxy local (galactic) axes. weight: 0..1 blend with the procedural sky.
export function drawSkyMap(rotLocalFromView, tanFov, exposure, weight, betaLocal = null) {
  const e = loadTexture('data/milkyway.jpg', 'color');
  if (!e.ready || weight <= 0) return false;
  initSkyMapProgram();
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  pMap.use().set({ uMap: e.tex, uRot: rotLocalFromView, uTanFov: tanFov, uScale: 1.6e-8 * skyCfg.galBoost * exposure * weight, uBeta: betaLocal || [0, 0, 0] });
  drawFS();
  return true;
}

// ----- zodiacal light: sunlight scattered by interplanetary dust (Leinert et al. 1998, simplified) -----
// Brightness in S10 units (10th magnitude stars per square degree) as a function of elongation from the Sun and
// ecliptic latitude, scaled as r^-2.3 with the observer's distance from the Sun; the gegenschein opposite the Sun.
const ZODI_FS = `in vec2 vUV; out vec4 o;
uniform mat3 uRot; uniform vec2 uTanFov; uniform vec3 uSun, uEclN; uniform float uScale;
void main(){
  vec3 d = normalize(uRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  float ce = clamp(dot(d, uSun), -1., 1.), eps = degrees(acos(ce));
  float beta = abs(degrees(asin(clamp(dot(d, uEclN), -1., 1.))));
  if (eps < 12.) { o = vec4(0.); return; }
  float zPlane = 260.*pow(1./max(sin(radians(eps)), 0.15), 1.6) + 70.*exp(-pow((180. - eps)/9., 2.));
  float b0 = 12. + 25.*eps/180.;
  float z = 60. + (zPlane - 60.)*exp(-beta/b0);
  // S10 -> solar constants per steradian: 10^(-0.4 (10 + 26.74)) per square degree
  o = vec4(vec3(1.0, 0.93, 0.82)*z*6.9e-12*uScale*smoothstep(12., 20., eps), 1.);
}`;
let pZodi = null;
export function initZodiProgram() { if (!pZodi) pZodi = new Program('zodiacal', FS_VS, ZODI_FS); }
export function drawZodiacal(rotWorldFromView, tanFov, exposure, sunDir, eclN, rAU) {
  initZodiProgram();
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  pZodi.use().set({ uRot: rotWorldFromView, uTanFov: tanFov, uSun: sunDir, uEclN: eclN, uScale: exposure * skyCfg.galBoost * Math.pow(Math.max(rAU, 0.05), -2.3) });
  drawFS();
}
