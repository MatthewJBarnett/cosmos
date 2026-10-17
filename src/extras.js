// Planetary rings, orbit lines and asteroid belts.
import { gl, Program, tex2D, makeVAO } from './gl.js';
import { V, Q, C, clamp } from './math.js';
import { RNG } from './rng.js';
import { LOGDEPTH_VS, LOGDEPTH_FS, LIGHT_UNIFORMS } from './planet.js';
import { keplerPos, skyToFrame } from './system.js';
import { planetOrbitPath } from './ephem.js';
import { loadTexture } from './assets.js';

// ---------------- rings ----------------
const RING_VS = `
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj; uniform mat3 uRot; uniform vec3 uRel; uniform float uIn, uOut;
out vec3 vWorld; out float vT; out vec2 vLocal;
${LOGDEPTH_VS}
void main(){ float r = mix(uIn, uOut, aPos.z); vec3 l = vec3(aPos.x*r, 0., aPos.y*r); vLocal = l.xz; vWorld = uRot*l + uRel; vT = aPos.z; gl_Position = uViewProj*vec4(vWorld, 1.); logDepth(); }`;
const RING_FS = `
in vec3 vWorld; in float vT; in vec2 vLocal;
uniform sampler2D uTex; uniform sampler3D uNoise3; uniform float uExposure, uPlanetR, uOblate, uFade; uniform vec3 uN;
${LIGHT_UNIFORMS}
${LOGDEPTH_FS}
out vec4 o;
void main(){
  logDepth();
  vec4 t = texture(uTex, vec2(vT, 0.5));
  float dist = length(vWorld);
  // fine radial structure and clumping when close
  float r = length(vLocal);
  float fine = texture(uNoise3, vec3(r/uPlanetR*37., 0.3, 0.7)).r*0.6 + texture(uNoise3, vec3(r/uPlanetR*311., 0.1, 0.2)).g*0.4;
  float a = clamp(t.a*(0.55 + 0.9*fine), 0., 1.);
  float grain = clamp(uPlanetR*0.004/dist, 0., 1.);
  if (grain > 0.) { float g = texture(uNoise3, vec3(vLocal/uPlanetR*900., 0.5)).r; a *= mix(1., smoothstep(0.25, 0.75, g)*1.6, grain); }
  a = clamp(a, 0., 0.995);
  float tau = -log(1. - a)*uFade;          // (optical depth falls as the rings rain onto the planet)
  vec3 Vv = normalize(-vWorld);
  float muV = max(abs(dot(Vv, uN)), 0.03);
  float aView = 1. - exp(-tau/muV);
  vec3 col = vec3(0.);
  for (int i = 0; i < uNumLights; i++) {
    vec3 L = normalize(uLightPos[i] - vWorld);
    // planet shadow
    vec3 oc = vWorld - uPlanetRel; float b = dot(oc, L); float c = dot(oc, oc) - uPlanetR*uPlanetR*(1. - uOblate);
    float sh = 1.;
    if (b < 0.) { float h = b*b - c; sh = 1. - smoothstep(-uPlanetR*uPlanetR*0.02, uPlanetR*uPlanetR*0.01, h); }
    sh *= eclipse(vWorld, i);
    float muL = max(abs(dot(L, uN)), 0.03);
    bool same = dot(L, uN)*dot(Vv, uN) > 0.;
    float cs = dot(L, -Vv);
    float fwd = 0.25*pow(max(cs, 0.), 12.) + 1.;     // forward scattering by small grains
    float back = 1. + 0.5*pow(max(-cs, 0.), 6.);      // opposition brightening
    float refl = same ? (1. - exp(-tau*(1./muL + 1./muV)))*muL/(muL + muV)*back : exp(-tau/muL)*(1. - exp(-tau/muV))*0.35*fwd + (exp(-tau/muL) - exp(-tau*(1./muL + 1./muV)))*0.25;
    col += uLightCol[i]*sh*t.rgb*refl*1.3/3.14159;
  }
  o = vec4(col*uExposure, aView);
}`;
let pRing, ringVAO, ringCount;
const ringTex = new Map();
function ringTexture(b) {
  if (b.rings.map) {
    // observed ring brightness and transparency (Cassini based strip)
    const e = loadTexture(b.rings.map, 'color');
    if (e.ready) { if (b.rings.inner !== b.rings.mapInner) { b.rings.inner = b.rings.mapInner; b.rings.outer = b.rings.mapOuter; } return e.tex; }
  }
  // (keyed by opacity too: debris rings fade over time)
  const key = b.uid + ':' + Math.round((b.rings.opacity || 0) * 10);
  let t = ringTex.get(key); if (t) return t;
  const N = 2048, d = new Uint8Array(N * 4), rg = b.rings, rng = new RNG(rg.seed * 7919 + 13);
  // layered noise
  const lay = []; for (let k = 0; k < 7; k++) { const n = 6 << k, a = new Float32Array(n + 2); for (let i = 0; i < n + 2; i++) a[i] = rng.f(); lay.push(a); }
  const nz = (x, k) => { const a = lay[k], n = a.length - 2, f = x * n, i = Math.floor(f), u = f - i, s = u * u * (3 - 2 * u); return a[i] + (a[i + 1] - a[i]) * s; };
  // random gaps
  const gaps = []; const ng = rg.kind === 'saturn' ? 5 : 3; for (let i = 0; i < ng; i++) gaps.push([rng.range(0.05, 0.95), rng.range(0.003, 0.02)]);
  const narrow = []; for (let i = 0; i < 9; i++) narrow.push([rng.range(0.1, 1), rng.range(0.004, 0.02), rng.range(0.3, 1)]);
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1); let op, tone = 1;
    if (rg.kind === 'saturn' && b.name === 'Saturn') {
      // D, C, B, Cassini division, A (with Encke gap), F
      if (x < 0.105) op = 0.02; else if (x < 0.343) op = 0.1 + 0.08 * nz(x, 3); else if (x < 0.69) op = 0.75 + 0.25 * nz(x, 4); else if (x < 0.754) op = 0.05 + 0.05 * nz(x, 5); else if (x < 0.954) op = 0.45 + 0.15 * nz(x, 3); else op = 0;
      if (Math.abs(x - 0.908) < 0.0022) op = 0.02;
      if (Math.abs(x - 0.992) < 0.003) op = 0.25;
      op *= 0.75 + 0.5 * nz(x, 6) * nz(x, 5);
      tone = x < 0.343 ? 0.62 : x < 0.69 ? 1 : x < 0.754 ? 0.6 : 0.9;
    } else if (rg.kind === 'narrow' || rg.kind === 'faint') {
      op = rg.kind === 'faint' ? 0.3 * nz(x, 1) : 0.02;
      if (rg.kind === 'narrow') for (const g of narrow) op += g[2] * Math.exp(-(((x - g[0]) / g[1]) ** 2) * 4);
    } else {
      op = (0.25 + 0.75 * nz(x, 1)) * (0.5 + 0.5 * nz(x, 3)) * (0.7 + 0.3 * nz(x, 5));
      op *= Math.min(1, x * 12) * Math.min(1, (1 - x) * 30);
      for (const g of gaps) op *= 1 - Math.exp(-(((x - g[0]) / g[1]) ** 2));
      tone = 0.7 + 0.3 * nz(x, 2);
    }
    op = clamp(op * rg.opacity, 0, 1);
    const v = 0.85 + 0.15 * nz(x, 6);
    d[i * 4] = clamp(rg.color[0] * tone * v * 255, 0, 255); d[i * 4 + 1] = clamp(rg.color[1] * tone * v * 255, 0, 255); d[i * 4 + 2] = clamp(rg.color[2] * tone * v * 255, 0, 255); d[i * 4 + 3] = op * 255;
  }
  t = tex2D(N, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, gl.CLAMP_TO_EDGE, d);
  ringTex.set(key, t);
  return t;
}
export function drawRings(b, o) {
  if (!pRing) {
    pRing = new Program('rings', RING_VS, RING_FS);
    const S = 256, v = new Float32Array((S + 1) * 2 * 3);
    for (let i = 0; i <= S; i++) { const a = i / S * Math.PI * 2; v.set([Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 1], i * 6); }
    ringVAO = makeVAO([{ data: v, size: 3, loc: 0 }]); ringCount = (S + 1) * 2;
  }
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
  pRing.use().set(o.light).set({ uViewProj: o.viewProj, uFcoef: o.fcoef, uRot: Q.mat3(o.rotQ), uRel: o.rel, uIn: b.rings.inner, uOut: b.rings.outer, uTex: ringTexture(b), uNoise3: o.noise3, uExposure: o.exposure, uPlanetR: b.radius, uOblate: b.oblate || 0, uN: Q.rot(o.rotQ, [0, 1, 0]), uFade: b.rings.fade === undefined ? 1 : b.rings.fade });
  gl.bindVertexArray(ringVAO.vao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, ringCount);
}
drawRings.texture = ringTexture;

// ---------------- orbits ----------------
const LINE_VS = `layout(location=0) in vec3 aPos; layout(location=1) in vec4 aCol; uniform mat4 uViewProj; out vec4 vCol; ${LOGDEPTH_VS}
void main(){ vCol = aCol; gl_Position = uViewProj*vec4(aPos, 1.); logDepth(); }`;
const LINE_FS = `in vec4 vCol; out vec4 o; ${LOGDEPTH_FS} void main(){ logDepth(); o = vec4(vCol.rgb*vCol.a, 0.); }`;
let pLine, lineVAO, lineBuf;
const ORB_N = 192;
export function drawOrbits(sys, nav, o) {
  if (!pLine) {
    pLine = new Program('lines', LINE_VS, LINE_FS);
    lineVAO = gl.createVertexArray(); gl.bindVertexArray(lineVAO); lineBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
  }
  const segs = []; const data = [];
  for (const b of sys.bodies) {
    if (!b.orbit || !b.parent) continue;
    const pp = b.parent.wpos, orb = b.orbit;
    const prel = V.sub(pp, nav.S), pd = V.len(prel);
    // skip orbits that are tiny on screen or enormous compared with the distance (camera sitting on the line)
    const apparent = orb.a / Math.max(pd, 1);
    if (apparent < 0.004) continue;
    const dBody = V.dist(b.wpos, nav.S);
    let alpha = clamp((dBody / (b.radius * 40) - 0.3), 0, 1) * 0.5;
    if (b.kind === 'moon') alpha *= clamp(apparent * 30, 0, 1);
    if (alpha <= 0.01) continue;
    const sel = o.selected && o.selected.body === b;
    // minor bodies (asteroids, dwarf planets, comets) only show their orbit when selected
    if (!sel && (b.kind === 'dwarf' || b.kind === 'comet')) continue;
    const col = sel ? [1, 0.85, 0.4] : b.kind === 'star' ? [1, 0.7, 0.3] : b.kind === 'moon' ? [0.45, 0.55, 0.7] : b.kind === 'dwarf' || b.kind === 'comet' ? [0.5, 0.5, 0.5] : [0.35, 0.6, 1.0];
    const M0 = orb.M0 + 2 * Math.PI * nav.time / orb.period;
    const start = data.length / 7;
    const fake = Object.assign({}, orb, { period: 1, argp: orb.argp + (orb.argpDot ? orb.argpDot * nav.time : 0), argpDot: 0 });
    // real planets follow their ephemeris (orbits that slowly change shape, and widen as the Sun loses mass)
    const eph = b.ephem === 'planet' ? (sys.oScale || 1) : 0, path = eph ? planetOrbitPath(b.name, nav.time, ORB_N) : null;
    for (let i = 0; i <= ORB_N; i++) {
      fake.M0 = M0 + i / ORB_N * Math.PI * 2;
      let p = path ? V.mul(path[i], eph) : keplerPos(fake, 0);
      if (orb.sky) p = skyToFrame(orb.sky, p);
      if (!path && b.parent === sys.root && sys.oScale && sys.oScale !== 1) p = V.mul(p, sys.oScale);
      if (b.equatorial && b.parent.axisQ) p = Q.rot(b.parent.axisQ, p);
      p = Q.rot(sys.worldQ, p);
      // fade the stretch right behind the body to show direction of motion
      const k = i / ORB_N; const a = alpha * (0.25 + 0.75 * k) * (sel ? 1.8 : 1);
      data.push(p[0] + prel[0], p[1] + prel[1], p[2] + prel[2], col[0], col[1], col[2], a * 0.22);
    }
    segs.push([start, ORB_N + 1]);
  }
  if (!segs.length) return;
  gl.bindVertexArray(lineVAO); gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
  pLine.use().set({ uViewProj: o.viewProj, uFcoef: o.fcoef });
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
  for (const s of segs) gl.drawArrays(gl.LINE_STRIP, s[0], s[1]);
  gl.disable(gl.DEPTH_TEST);
}

// ---------------- asteroid belts ----------------
const BELT_VS = `
layout(location=0) in vec4 aOrb;   // a, phase, inclination, node
layout(location=1) in vec2 aSz;    // radius (m), albedo
uniform mat4 uViewProj; uniform mat3 uRot; uniform vec3 uRel; uniform float uTime, uGM, uExposure, uPxSA, uPixScale, uLum;
out vec3 vCol; out float vSig;
${LOGDEPTH_VS}
void main(){
  float n = sqrt(uGM/(aOrb.x*aOrb.x*aOrb.x));
  float th = aOrb.y + n*uTime;
  vec3 p = vec3(cos(th), 0., -sin(th))*aOrb.x;
  float ci = cos(aOrb.z), si = sin(aOrb.z), cn = cos(aOrb.w), sn = sin(aOrb.w);
  p = vec3(p.x, p.y*ci - p.z*si, p.y*si + p.z*ci);
  p = vec3(p.x*cn + p.z*sn, p.y, -p.x*sn + p.z*cn);
  vec3 w = uRot*p + uRel;
  float d = length(w), dAU = aOrb.x/1.496e11;
  float flux = aSz.y*uLum/(dAU*dAU)*(aSz.x/d)*(aSz.x/d)*0.4;
  float I = flux/uPxSA*uExposure;
  float sig = 0.6*uPixScale; float peak = I/(6.2832*sig*sig);
  if (peak > 2.) { sig = min(sqrt(I/(6.2832*2.)), 3.*uPixScale); peak = I/(6.2832*sig*sig); }
  vCol = vec3(0.95, 0.9, 0.85)*min(peak, 1000.); vSig = sig;
  gl_Position = uViewProj*vec4(w, 1.); logDepth();
  gl_PointSize = peak < 0.002 ? 0. : ceil(sig*6. + 1.);
  if (gl_PointSize == 0.) gl_Position = vec4(2., 2., 2., 1.);
}`;
const BELT_FS = `in vec3 vCol; in float vSig; out vec4 o; ${LOGDEPTH_FS}
void main(){ logDepth(); vec2 d = (gl_PointCoord - 0.5)*ceil(vSig*6. + 1.); o = vec4(vCol*exp(-dot(d, d)/(2.*vSig*vSig)), 1.); }`;
let pBelt;
export function drawBelts(sys, nav, o) {
  if (!sys.belts.length) return;
  if (!pBelt) pBelt = new Program('belt', BELT_VS, BELT_FS);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
  const lum = o.lights.reduce((s, l) => s + l.lum, 0);
  for (const belt of sys.belts) {
    if (!belt.vao) {
      const rng = new RNG(belt.seed * 31 + 7), n = belt.count, d = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        const a = belt.inner + (belt.outer - belt.inner) * (0.5 + 0.5 * clamp(rng.gauss() * 0.42, -1, 1));
        d[i * 6] = a; d[i * 6 + 1] = rng.range(0, 6.2832); d[i * 6 + 2] = Math.abs(rng.gauss()) * belt.thick; d[i * 6 + 3] = rng.range(0, 6.2832);
        d[i * 6 + 4] = 800 * Math.pow(rng.f() + 0.002, -0.7); d[i * 6 + 5] = rng.range(0.04, 0.25);
      }
      belt.vao = makeVAO([{ data: d, stride: 24, parts: [{ loc: 0, size: 4, offset: 0 }, { loc: 1, size: 2, offset: 16 }] }]);
    }
    const par = belt.parent;
    pBelt.use().set({ uViewProj: o.viewProj, uFcoef: o.fcoef, uRot: Q.mat3(sys.worldQ), uRel: V.sub(par.wpos, nav.S), uTime: nav.time % 3e9, uGM: C.G * par.mass, uExposure: o.exposure, uPxSA: o.pxSA, uPixScale: o.pixScale, uLum: lum });
    gl.bindVertexArray(belt.vao.vao); gl.drawArrays(gl.POINTS, 0, belt.count);
  }
}

export function initExtraPrograms() {
  if (!pRing) { pRing = new Program('rings', RING_VS, RING_FS); const S = 256, v = new Float32Array((S + 1) * 2 * 3); for (let i = 0; i <= S; i++) { const a = i / S * Math.PI * 2; v.set([Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 1], i * 6); } ringVAO = makeVAO([{ data: v, size: 3, loc: 0 }]); ringCount = (S + 1) * 2; }
  if (!pLine) { pLine = new Program('lines', LINE_VS, LINE_FS); lineVAO = gl.createVertexArray(); gl.bindVertexArray(lineVAO); lineBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12); gl.bindVertexArray(null); }
  if (!pBelt) pBelt = new Program('belt', BELT_VS, BELT_FS);
}

// ---------------- ring particles (when flying through a ring) ----------------
const RP_GRID = 64, RP_PER = 5;
const RP_VS = `
layout(location=0) in vec2 aCorner;
uniform mat4 uViewProj; uniform mat3 uRot;          // ring local -> world
uniform vec3 uOriginRel;                            // world offset of the grid origin from the camera
uniform vec3 uU, uW;                                // grid axes in ring local frame (radial, tangent); normal is y
uniform vec2 uCell0; uniform float uCellM, uThick, uRin, uRout, uShift, uCamR;
uniform sampler2D uTex;
out vec2 vC; out vec3 vCenter; out float vRad; out vec3 vCol;
uint hh(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float rnd(uint s){ return float(hh(s) & 0xffffffu)/16777216.; }
${LOGDEPTH_VS}
void main(){
  int id = gl_InstanceID; int cell = id / ${RP_PER}; int k = id - cell*${RP_PER};
  int ix = cell % ${RP_GRID}, iz = cell / ${RP_GRID};
  vec2 c = uCell0 + vec2(ix, iz);                     // integer cell coordinates (comoving along the tangent)
  uint seed = hh(uint(int(c.x) + 100000)*73856093u ^ uint(int(c.y) + 100000)*19349663u ^ uint(k)*83492791u);
  float a = rnd(seed), b = rnd(seed + 1u), h = rnd(seed + 2u), u = rnd(seed + 3u);
  // positions relative to the camera's cell; the absolute cell index only seeds the random numbers
  float radial = (float(ix) - float(${RP_GRID})*0.5 + a)*uCellM, tang = (float(iz) - float(${RP_GRID})*0.5 + b)*uCellM - uShift;
  float rr = uCamR + radial;
  float t = (rr - uRin)/(uRout - uRin);
  vec4 tc = textureLod(uTex, vec2(t, 0.5), 0.);
  // keep a fraction of particles matching the local optical depth
  float keep = clamp(tc.a*1.3, 0., 1.)*step(0., t)*step(t, 1.);
  float rad = min(0.25*pow(u + 0.002, -0.55), 9.);
  vec3 local = uU*radial + uW*tang + vec3(0., (h - 0.5)*uThick, 0.);
  vec3 cen = uRot*(local - uU*0.) + uOriginRel;
  vec3 f = normalize(cen); vec3 r = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0,1,0) : vec3(1,0,0))); vec3 up = cross(r, f);
  vec3 w = cen + (r*aCorner.x + up*aCorner.y)*rad;
  vC = aCorner; vCenter = cen; vRad = rad; vCol = tc.rgb;
  gl_Position = uViewProj*vec4(w, 1.); logDepth();
  if (rnd(seed + 4u) > keep || length(cen) > uCellM*float(${RP_GRID})*0.5) gl_Position = vec4(2., 2., 2., 1.);
}`;
const RP_FS = `
in vec2 vC; in vec3 vCenter; in float vRad; in vec3 vCol;
uniform float uExposure, uFcoef; uniform vec3 uSunDir, uSunCol, uPlanetRel, uShineCol, uFwd; uniform float uPlanetR;
out vec4 o;
void main(){
  // lumpy ice: perturb the silhouette and the normal with a cheap per-particle pattern
  float ang = atan(vC.y, vC.x), sd = fract(sin(dot(vCenter, vec3(12.9898, 78.233, 37.719)))*43758.5453);
  float edge = 1. - 0.22*(0.5 + 0.5*sin(ang*3. + sd*20.)) - 0.12*(0.5 + 0.5*sin(ang*5. + sd*47.));
  float d2 = dot(vC, vC); if (d2 > edge*edge) discard;
  vec3 f = normalize(vCenter); vec3 r = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0,1,0) : vec3(1,0,0))); vec3 up = cross(r, f);
  vec2 q = vC/edge;
  vec3 n = normalize(r*q.x + up*q.y - f*sqrt(max(1. - dot(q, q), 0.)));
  n = normalize(n + 0.35*vec3(sin(q.x*7. + sd*9.), sin(q.y*6. + sd*13.), sin((q.x + q.y)*5. + sd*5.)));
  vec3 p = vCenter + n*vRad;
  // planet shadow
  vec3 oc = p - uPlanetRel; float b = dot(oc, uSunDir), c = dot(oc, oc) - uPlanetR*uPlanetR;
  float sh = (b < 0. && b*b - c > 0.) ? 0. : 1.;
  float nl = max(dot(n, uSunDir), 0.);
  vec3 toP = normalize(uPlanetRel - p);
  vec3 col = vCol*0.7*(uSunCol*nl*sh + uShineCol*max(dot(n, toP), 0.))/3.14159;
  o = vec4(col*uExposure, 1.);
  gl_FragDepth = log2(1. + max(dot(p, uFwd), 1e-3))*uFcoef*0.5;
}`;
let pRP = null, rpVAO = null;
export function initRingParticles() { if (!pRP) { pRP = new Program('ringparticles', RP_VS, RP_FS); rpVAO = makeVAO([{ data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), size: 2, loc: 0 }]); } }
export function drawRingParticles(b, nav, o) {
  const rg = b.rings; if (!rg) return;
  const inv = Q.conj(b.wrot);
  const camL = Q.rot(inv, V.sub(nav.S, b.wpos));            // camera in the ring frame (double)
  const rCam = Math.hypot(camL[0], camL[2]);
  if (Math.abs(camL[1]) > 4000 || rCam < rg.inner - 3000 || rCam > rg.outer + 3000) return;
  initRingParticles();
  const tex = ringTexture(b);
  const U = [camL[0] / rCam, 0, camL[2] / rCam], W = [-U[2], 0, U[0]];   // radial and prograde tangent
  const cellM = 18, v = Math.sqrt(C.G * b.mass / rCam);
  const shift = (nav.time * v) % (cellM * 1e5);
  const c0 = [-RP_GRID / 2, Math.floor(shift / cellM) - RP_GRID / 2];
  // grid origin: camera radius on the ring plane, directly "below" the camera
  const originL = [U[0] * rCam, 0, U[2] * rCam];
  const originRel = Q.rot(b.wrot, V.sub(originL, camL));
  const sun = o.lights[0];
  const sunDir = sun ? V.norm(sun.rel.map((x, i) => x - b.rel[i])) : [0, 1, 0];
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
  pRP.use().set({ uViewProj: o.viewProj, uFcoef: o.fcoef, uRot: Q.mat3(b.wrot), uOriginRel: originRel, uU: U, uW: W, uCell0: c0, uCellM: cellM, uThick: 30, uRin: rg.inner, uRout: rg.outer,
    uShift: shift - Math.floor(shift / cellM) * cellM, uCamR: rCam, uTex: tex, uExposure: o.exposure, uSunDir: sunDir, uSunCol: sun ? sun.col : [1, 1, 1], uPlanetRel: b.rel, uPlanetR: b.radius,
    uShineCol: sun ? sun.col.map(x => x * 0.02) : [0, 0, 0], uFwd: Q.rot(nav.q, [0, 0, -1]) });
  gl.bindVertexArray(rpVAO.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, RP_GRID * RP_GRID * RP_PER);
}
