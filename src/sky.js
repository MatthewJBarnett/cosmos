// Deep sky rendering: distant galaxies (ray marched impostors), the host galaxy seen from inside (cubemap),
// and point light sources (stars, unresolved planets) with photometric brightness.
import { gl, Program, texCube, fbo, drawFS, FS_VS, makeVAO } from './gl.js';
import { V, Q } from './math.js';
import { GLSL_GALAXY, GLEVELS, galaxyCell, REAL_GALAXIES, galUniforms } from './universe.js';
import { GLSL_BB } from './stars.js';
import { CUBE_FACES } from './atmosphere.js';
import { loadTexture } from './assets.js';

export const skyCfg = { cubeSize: 1024, galBoost: 22, galSteps: 72, starBoost: 1.0, galRange: 1 };
export const GAL_I0 = 2.0e-9;   // central face-on disk surface brightness in units of (solar constant / sr)
export const SUN_MAG = -26.74;

// ---------- point sources ----------
const STAR_VS = `
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aMT;
uniform mat4 uViewProj; uniform vec3 uOffset; uniform float uExposure, uPxSA, uPixScale, uBoost; uniform vec3 uHide;
out vec3 vCol; out float vSig;
${GLSL_BB}
void main(){
  vec3 p = aPos + uOffset; float d = length(p);
  float m = aMT.x + 5.*log(max(d, 1e-9))/log(10.) - 5.;
  float flux = exp(-0.9210340372*(m + 26.74));
  float I = flux/uPxSA*uExposure*uBoost;     // energy in units of one fully lit pixel
  float sig = 0.62*uPixScale;
  float peak = I/(6.2832*sig*sig);
  if (peak > 3.) { sig = min(sqrt(I/(6.2832*3.)), 5.*uPixScale); peak = I/(6.2832*sig*sig); }
  vec3 c = bbColor(aMT.y); c /= dot(c, vec3(0.2126, 0.7152, 0.0722));
  vCol = c*min(peak, 30.); vSig = sig;
  gl_Position = uViewProj*vec4(p, 1.); gl_Position.z = 0.;
  gl_PointSize = peak < 0.0012 || distance(p, uHide) < 2e-3 ? 0. : ceil(sig*6. + 1.);
  if (gl_PointSize == 0.) gl_Position = vec4(2., 2., 2., 1.);
}`;
const STAR_FS = `
in vec3 vCol; in float vSig; out vec4 o;
void main(){
  float sz = ceil(vSig*6. + 1.); vec2 d = (gl_PointCoord - 0.5)*sz; float r = length(d);
  float g = exp(-r*r/(2.*vSig*vSig));
  // faint diffraction spikes on bright sources
  float bright = smoothstep(1.2, 3.5, vSig);
  float sp = (exp(-abs(d.x)*0.9/vSig)*exp(-d.y*d.y*1.6) + exp(-abs(d.y)*0.9/vSig)*exp(-d.x*d.x*1.6))*0.09*bright;
  o = vec4(vCol*(g + sp)*smoothstep(0.5*sz, 0.3*sz, r), 1.);
}`;

const PT_VS = `
layout(location=0) in vec3 aDir; layout(location=1) in vec4 aCol;
uniform mat4 uViewProj; uniform float uExposure, uPxSA, uPixScale;
out vec3 vCol; out float vSig;
void main(){
  float I = aCol.a/uPxSA*uExposure;
  float sig = 0.62*uPixScale;
  float peak = I/(6.2832*sig*sig);
  if (peak > 3.) { sig = min(sqrt(I/(6.2832*3.)), 7.*uPixScale); peak = I/(6.2832*sig*sig); }
  vCol = aCol.rgb*min(peak, 30.); vSig = sig;
  gl_Position = uViewProj*vec4(aDir, 1.); gl_Position.z = 0.;
  gl_PointSize = peak < 0.0005 ? 0. : ceil(sig*6. + 1.);
  if (gl_PointSize == 0.) gl_Position = vec4(2., 2., 2., 1.);
}`;

// ---------- galaxy impostors ----------
const GAL_VS = `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aCen; layout(location=2) in vec4 aQuat; layout(location=3) in vec4 aP0; layout(location=4) in vec4 aP1; layout(location=5) in vec4 aP2; layout(location=6) in float aLum;
uniform mat4 uViewProj; uniform vec3 uOffset; uniform float uPxPerRad, uScale; uniform vec3 uSkip;
out vec3 vWorld; flat out vec3 vCen; flat out vec4 vQuat, vP0, vP1, vP2; flat out vec2 vLum; flat out float vPx;
void main(){
  vec3 c = aCen.xyz + uOffset; float d = length(c);
  float rad = aCen.w*1.08;
  float px = rad/d*uPxPerRad;
  float expand = max(1., 2.6/px);   // unresolved galaxies still cover a few pixels: seeing and the PSF smear them
  vec3 f = c/d; vec3 r = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0,1,0) : vec3(1,0,0))); vec3 u = cross(r, f);
  vec3 w = c + (r*aCorner.x + u*aCorner.y)*rad*expand;
  if (d < rad*0.92) w = c + f*0.0;   // camera inside: handled by the sky cubemap
  vWorld = w; vCen = c; vQuat = aQuat; vP0 = aP0; vP1 = aP1; vP2 = aP2; vLum = vec2(aLum, expand); vPx = px;
  gl_Position = uViewProj*vec4(w, 1.); gl_Position.z = 0.;
  float est = (aP0.x < 0.5 ? 0.45 : 0.2 + 0.02*aP0.y)/(expand*expand)*1.6*aLum*uScale;
  if (distance(aCen.xyz, uSkip) < 1e-7 || px < 0.05 || (expand > 1. && est < 0.0012)) gl_Position = vec4(2., 2., 2., 1.);
}`;
// The impostor fragment shader is assembled below with the radius passed explicitly (clearer than recovering it).
const GAL_FS2 = `
in vec3 vWorld; flat in vec3 vCen; flat in vec4 vQuat, vP0, vP1, vP2; flat in vec2 vLum; flat in float vPx; flat in float vRad;
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
    float gsn = exp(-t2*3.2)/ratio;
    float t = sqrt(t2);
    float tot = (g.type < 0.5 ? 0.45 : 0.2 + 0.02*g.bulge)/(vLum.y*vLum.y)*1.6;
    vec3 col = mix(vec3(1.0, 0.82, 0.6), vec3(0.8, 0.86, 1.0), clamp(g.young*0.5, 0., 1.)*(g.type < 0.5 ? 0. : 1.));
    o = vec4(col*tot*gsn*g.lum*uScale, 1.); return;
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
  vec3 res = L*g.lum*uScale;
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
void main(){ vec3 rd = uRot*vec3((vUV*2. - 1.)*uTanFov, -1.); vec4 c = texture(uCube, rd); if (any(isnan(c)) || any(isinf(c))) c = vec4(0., 0., 0., 1.); o = vec4(c.rgb*uScale, mix(1., clamp(c.a, 0., 1.), uFade)); }`;

let pStar, pPt, pGal, pCube, pCubeDraw, quadBuf, ptVAO, ptBuf;
export function initSkyPrograms() { init(); if (!pCon) pCon = new Program('constellations', CON_VS, CON_FS); initSkyMapProgram(); }
function init() {
  if (pStar) return;
  pStar = new Program('stars', STAR_VS, STAR_FS);
  pPt = new Program('points', PT_VS, STAR_FS);
  pGal = new Program('galaxies', GAL_VS.replace('flat out float vPx;', 'flat out float vPx; flat out float vRad;').replace('vPx = px;', 'vPx = px; vRad = aCen.w;'), GAL_FS2);
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
  p.set({ uViewProj: viewProjLocal, uExposure: o.exposure, uPxSA: o.pxSA, uPixScale: o.pixScale, uBoost: skyCfg.starBoost });
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  let n = 0;
  const hide = o.hide;
  for (const c of field.cells.values()) {
    if (!c.vao) continue;
    const off = [c.origin[0] - camLocal[0], c.origin[1] - camLocal[1], c.origin[2] - camLocal[2]];
    p.set({ uOffset: off, uHide: hide ? [hide[0] - c.origin[0], hide[1] - c.origin[1], hide[2] - c.origin[2]].map((v, i) => v + off[i]) : [1e9, 1e9, 1e9] });
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
  pPt.use().set({ uViewProj: viewProj, uExposure: o.exposure, uPxSA: o.pxSA, uPixScale: o.pixScale });
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
export const visibleGalaxyCells = [];
let galFrame = 0;
export function drawGalaxies(camU, viewProj, o) {
  init(); galFrame++;
  const p = pGal.use();
  p.set({ uViewProj: viewProj, uPxPerRad: o.pxPerRad, uScale: GAL_I0 * skyCfg.galBoost * o.exposure, uMaxSteps: skyCfg.galSteps, uNoise3: o.noise3 });
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  visibleGalaxyCells.length = 0;
  const skip = o.skip;
  const drawCell = (cell) => {
    if (!cell.list.length) return;
    const b = galCellVAO(cell); b.last = galFrame;
    visibleGalaxyCells.push(cell);
    p.set({ uOffset: [cell.origin[0] - camU[0], cell.origin[1] - camU[1], cell.origin[2] - camU[2]], uSkip: skip ? [skip.posU[0] - cell.origin[0], skip.posU[1] - cell.origin[1], skip.posU[2] - cell.origin[2]] : [1e9, 1e9, 1e9] });
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
  if (o.realSkyNear) {
    // the photographed sky already contains the Magellanic Clouds, M31 and M33
    const keep = { key: 'real-far', list: REAL_GALAXIES.filter(g => !/Magellanic|M31|M33/.test(g.name)), origin: [0, 0, 0] };
    drawCell(keep);
  } else drawCell(REAL_CELL);
  if (galFrame % 60 === 0) for (const [k, b] of galBuffers) if (galFrame - b.last > 300) { gl.deleteVertexArray(b.vao); gl.deleteBuffer(b.buf); galBuffers.delete(k); }
}

// ----- host galaxy sky cubemap -----
export class GalaxySky {
  constructor() { init(); this.size = skyCfg.cubeSize; this.front = this.mk(); this.back = this.mk(); this.gal = null; this.pos = null; this.face = -1; this.valid = false; }
  mk() { const t = texCube(this.size, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR); const f = []; for (let i = 0; i < 6; i++) f.push(fbo([t], null, i)); return { t, f }; }
  // camN: camera position in galaxy local frame, normalised by galaxy radius
  update(gal, camN, noise3, sync) {
    if (this.gal !== gal) { this.gal = gal; this.valid = false; this.face = -1; this.pos = null; }
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
  draw(rotLocalFromView, tanFov, exposure, weight = 1) {
    if (!this.valid || weight <= 0) return;
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
    pCubeDraw.use().set({ uCube: this.front.t, uRot: rotLocalFromView, uTanFov: tanFov, uScale: GAL_I0 * skyCfg.galBoost * exposure * weight, uFade: weight });
    drawFS();
  }
}

// ----- constellation figures (3D lines between catalogue stars, so they distort as you travel) -----
const CON_VS = `layout(location=0) in vec3 aPos; uniform mat4 uViewProj; uniform vec3 uOffset; out float vD;
void main(){ vec3 p = aPos + uOffset; vD = length(p); gl_Position = uViewProj*vec4(p, 1.); gl_Position.z = 0.; }`;
const CON_FS = `in float vD; out vec4 o; uniform float uAlpha; void main(){ o = vec4(vec3(0.22, 0.42, 0.85)*uAlpha, 0.); }`;
let pCon = null, conVAO = null, conCount = 0;
export function drawConstellations(catalog, sunLocal, camLocal, viewProjLocal, alpha) {
  if (!catalog.ready || alpha <= 0) return;
  if (!pCon) {
    pCon = new Program('constellations', CON_VS, CON_FS);
    const pts = [], d = catalog.data;
    for (const c of catalog.constellations) for (const [a, b] of c.lines) pts.push(d[a * 5], d[a * 5 + 1], d[a * 5 + 2], d[b * 5], d[b * 5 + 1], d[b * 5 + 2]);
    conVAO = gl.createVertexArray(); gl.bindVertexArray(conVAO);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); conCount = pts.length / 3;
  }
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  pCon.use().set({ uViewProj: viewProjLocal, uOffset: [sunLocal[0] - camLocal[0], sunLocal[1] - camLocal[1], sunLocal[2] - camLocal[2]], uAlpha: alpha });
  gl.bindVertexArray(conVAO); gl.drawArrays(gl.LINES, 0, conCount);
}

// ----- the real Milky Way seen from near the Sun (ESO panorama in galactic coordinates, stars removed) -----
const MAP_FS = `in vec2 vUV; out vec4 o;
uniform sampler2D uMap; uniform mat3 uRot; uniform vec2 uTanFov; uniform float uScale;
void main(){
  vec3 d = normalize(uRot*vec3((vUV*2. - 1.)*uTanFov, -1.));
  float l = atan(-d.z, d.x), b = asin(clamp(d.y, -1., 1.));
  vec2 uv = vec2(0.5 - l/6.2831853, 0.5 - b/3.14159265);
  vec3 c = textureLod(uMap, uv, 0.).rgb;
  o = vec4(max(c - 0.0017, 0.)*uScale, 1.);
}`;
let pMap = null;
export function initSkyMapProgram() { if (!pMap) pMap = new Program('skymap', FS_VS, MAP_FS); }
// rotLocalFromView: view -> galaxy local (galactic) axes. weight: 0..1 blend with the procedural sky.
export function drawSkyMap(rotLocalFromView, tanFov, exposure, weight) {
  const e = loadTexture('data/milkyway.jpg', 'color');
  if (!e.ready || weight <= 0) return false;
  initSkyMapProgram();
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST);
  pMap.use().set({ uMap: e.tex, uRot: rotLocalFromView, uTanFov: tanFov, uScale: 1.6e-8 * skyCfg.galBoost * exposure * weight });
  drawFS();
  return true;
}
