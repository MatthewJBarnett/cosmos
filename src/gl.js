// Thin WebGL2 helpers.
export let gl = null;
export const caps = {};

export function initGL(canvas) {
  gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is required');
  caps.colorFloat = !!gl.getExtension('EXT_color_buffer_float');
  caps.floatLinear = !!gl.getExtension('OES_texture_float_linear');
  caps.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (!caps.colorFloat) throw new Error('EXT_color_buffer_float is required');
  return gl;
}

const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp samplerCube;\nprecision highp sampler3D;\n' +
  // Sample with an explicit level everywhere. Implicit derivatives are undefined inside loops and branches,
  // and some GPUs (Apple) return garbage there, which poisoned the HDR buffer with infinities.
  '#define texture(s, c) textureLod(s, c, 0.0)\n';

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, HEADER + src);
  gl.compileShader(s);
  return s;
}
function shaderError(s, src, name) {
  const log = gl.getShaderInfoLog(s);
  const lines = (HEADER + src).split('\n');
  const m = /ERROR: \d+:(\d+)/.exec(log);
  let ctx = '';
  if (m) { const n = +m[1]; ctx = lines.slice(Math.max(0, n - 4), n + 2).map((l, i) => (Math.max(0, n - 4) + i + 1) + ': ' + l).join('\n'); }
  console.error('Shader compile error [' + name + ']\n' + log + '\n' + ctx);
  return new Error('Shader compile error [' + name + ']: ' + log);
}

// All programs ever created, so the app can compile them up front (in parallel where supported).
export const allPrograms = [];
let parallelExt = undefined;
export class Program {
  constructor(name, vs, fs) {
    if (parallelExt === undefined) parallelExt = gl.getExtension('KHR_parallel_shader_compile');
    this.name = name; this.vsSrc = vs; this.fsSrc = fs;
    const p = this.p = gl.createProgram();
    this.vs = compileShader(gl.VERTEX_SHADER, vs); this.fs = compileShader(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, this.vs); gl.attachShader(p, this.fs);
    gl.linkProgram(p);
    this.linked = false;
    allPrograms.push(this);
  }
  // non-blocking: true once the driver has finished compiling and linking
  get done() { return this.linked || !parallelExt || gl.getProgramParameter(this.p, parallelExt.COMPLETION_STATUS_KHR); }
  finish() {
    if (this.linked) return;
    const p = this.p;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      if (!gl.getShaderParameter(this.vs, gl.COMPILE_STATUS)) throw shaderError(this.vs, this.vsSrc, this.name + '.vs');
      if (!gl.getShaderParameter(this.fs, gl.COMPILE_STATUS)) throw shaderError(this.fs, this.fsSrc, this.name + '.fs');
      console.error(gl.getProgramInfoLog(p)); throw new Error('Link error [' + this.name + ']: ' + gl.getProgramInfoLog(p));
    }
    this.u = {}; this.types = {}; this.texUnit = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    let unit = 0;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const nm = info.name.replace(/\[0\]$/, '');
      this.u[nm] = gl.getUniformLocation(p, info.name);
      this.types[nm] = info.type;
      if (info.type === gl.SAMPLER_2D || info.type === gl.SAMPLER_CUBE || info.type === gl.SAMPLER_3D) { this.texUnit[nm] = unit; unit += info.size; }
    }
    // Give every sampler its own unit up front. Samplers of different types must never share a unit,
    // even ones a draw leaves unset, or strict drivers reject the draw call.
    gl.useProgram(p);
    for (const nm in this.texUnit) gl.uniform1i(this.u[nm], this.texUnit[nm]);
    this.linked = true;
  }
  use() {
    if (!this.linked && !this.broken) { try { this.finish(); } catch (e) { console.error(e); this.broken = true; } }
    if (this.broken) { gl.useProgram(null); return this; }
    gl.useProgram(this.p);
    // (uniforms shared by every shader that declares them: the observing band)
    if (this.u.uBand) gl.uniform1i(this.u.uBand, GLOBAL_U.uBand);
    // (and the frame's sub-pixel jitter, for passes that trace view rays into the scene: see FS_VS_SCENE)
    if (this.u.uJitUV) gl.uniform2f(this.u.uJitUV, GLOBAL_U.uJitUV[0], GLOBAL_U.uJitUV[1]);
    return this;
  }
  // set uniforms from object; textures given as {tex, target}
  set(vals) {
    if (this.broken) return this;
    if (!this.linked) this.finish();
    for (const k in vals) {
      const loc = this.u[k]; if (loc === undefined || loc === null) continue;
      const v = vals[k], t = this.types[k];
      switch (t) {
        case gl.FLOAT: if (typeof v === 'number') gl.uniform1f(loc, v); else gl.uniform1fv(loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(loc, v); break;
        case gl.INT: case gl.BOOL: if (typeof v === 'number' || typeof v === 'boolean') gl.uniform1i(loc, v); else gl.uniform1iv(loc, v); break;
        case gl.INT_VEC2: gl.uniform2iv(loc, v); break;
        case gl.INT_VEC3: gl.uniform3iv(loc, v); break;
        case gl.INT_VEC4: gl.uniform4iv(loc, v); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, v); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, v); break;
        case gl.SAMPLER_2D: gl.activeTexture(gl.TEXTURE0 + this.texUnit[k]); gl.bindTexture(gl.TEXTURE_2D, v); gl.uniform1i(loc, this.texUnit[k]); break;
        case gl.SAMPLER_CUBE: gl.activeTexture(gl.TEXTURE0 + this.texUnit[k]); gl.bindTexture(gl.TEXTURE_CUBE_MAP, v); gl.uniform1i(loc, this.texUnit[k]); break;
        case gl.SAMPLER_3D: gl.activeTexture(gl.TEXTURE0 + this.texUnit[k]); gl.bindTexture(gl.TEXTURE_3D, v); gl.uniform1i(loc, this.texUnit[k]); break;
        default: console.warn('unhandled uniform type', k, t);
      }
    }
    return this;
  }
}

// the observing band: 0 visible, 1 ultraviolet, 2 near-infrared, 3 far-infrared, 4 microwave, 5 radio, 6 X-ray
export const GLOBAL_U = { uBand: 0, uJitUV: [0, 0] };
// (7-9 are not light: other messengers, see messengers.js)
export const BANDS = ['Visible', 'Ultraviolet', 'Near-infrared', 'Far-infrared', 'Microwave', 'Radio', 'X-ray', 'Neutrinos', 'Dark matter', 'Gravitational waves'];

export function unbindTextures(n = 16) {
  for (let u = 0; u < n; u++) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); }
  gl.activeTexture(gl.TEXTURE0);
}
export function tex2D(w, h, internal, format, type, filter, wrap, data = null) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap || gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap || gl.CLAMP_TO_EDGE);
  return t;
}

export function texCube(size, internal, format, type, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
  for (let i = 0; i < 6; i++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, internal, size, size, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// Framebuffer with given color textures (array) and optional depth texture
export function fbo(colors, depth = null, cubeFace = -1) {
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  const bufs = [];
  colors.forEach((c, i) => {
    if (cubeFace >= 0) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_CUBE_MAP_POSITIVE_X + cubeFace, c, 0);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, c, 0);
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  });
  if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  gl.drawBuffers(bufs);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) console.error('FBO incomplete', st.toString(16));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return f;
}

let fsVAO = null;
export function drawFS() {
  if (!fsVAO) {
    fsVAO = gl.createVertexArray(); gl.bindVertexArray(fsVAO);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(fsVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
export const FS_VS = `layout(location=0) in vec2 aPos; out vec2 vUV; void main(){ vUV = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;
// Full-screen passes that trace view rays into the scene (sky, nebulae, black holes...): their rays follow the same
// sub-pixel jitter as the rasterized geometry, so temporal anti-aliasing reprojects everything consistently (without
// it, everything not rasterized shimmers by up to half a pixel and the atmosphere disagrees with the planet's depth)
export const FS_VS_SCENE = `layout(location=0) in vec2 aPos; out vec2 vUV; uniform vec2 uJitUV; void main(){ vUV = aPos*0.5+0.5 - uJitUV; gl_Position = vec4(aPos,0.,1.); }`;

export function makeVAO(attribs, index = null) {
  // attribs: [{data, size, loc, divisor, type}]
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const bufs = [];
  for (const a of attribs) {
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, a.data, a.usage || gl.STATIC_DRAW);
    const stride = a.stride || 0;
    if (a.parts) { for (const p of a.parts) { gl.enableVertexAttribArray(p.loc); gl.vertexAttribPointer(p.loc, p.size, gl.FLOAT, false, stride, p.offset); if (a.divisor) gl.vertexAttribDivisor(p.loc, a.divisor); } }
    else { gl.enableVertexAttribArray(a.loc); gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0); if (a.divisor) gl.vertexAttribDivisor(a.loc, a.divisor); }
    bufs.push(b);
  }
  let ib = null;
  if (index) { ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW); }
  gl.bindVertexArray(null);
  return { vao, bufs, ib, free() { gl.deleteVertexArray(vao); bufs.forEach(b => gl.deleteBuffer(b)); if (ib) gl.deleteBuffer(ib); } };
}

// Non-blocking readback: readPixels into a pixel pack buffer, fetch the data a frame or two later once the GPU is done.
export class AsyncRead {
  constructor(bytes) { this.bytes = bytes; this.buf = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf); gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); this.sync = null; }
  get busy() { return !!this.sync; }
  // read from the currently bound read framebuffer
  start(x, y, w, h, format, type) {
    if (this.sync) return false;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf); gl.readPixels(x, y, w, h, format, type, 0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
    return true;
  }
  poll(dst) {
    if (!this.sync) return false;
    const st = gl.clientWaitSync(this.sync, 0, 0);
    if (st === gl.TIMEOUT_EXPIRED || st === gl.WAIT_FAILED) return false;
    gl.deleteSync(this.sync); this.sync = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dst); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return true;
  }
}

// GPU pass timing with EXT_disjoint_timer_query_webgl2 (where the browser exposes it).
export class GpuTimer {
  constructor() { this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); this.pending = []; this.cur = null; this.results = {}; this.free = []; }
  get ok() { return !!this.ext; }
  begin(name) {
    if (!this.ext) return;
    this.end();
    const q = this.free.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q); this.cur = { q, name };
  }
  end() { if (!this.ext || !this.cur) return; gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.pending.push(this.cur); this.cur = null; }
  poll() {
    if (!this.ext) return;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT);
      if (!disjoint) { const old = this.results[p.name]; this.results[p.name] = old === undefined ? ns / 1e6 : old * 0.9 + ns / 1e6 * 0.1; }
      this.pending.shift(); this.free.push(p.q);
    }
    if (this.pending.length > 64) { this.pending.length = 0; }
  }
}
