// Loading of real data: planet maps (decoded off the main thread with createImageBitmap) and the star catalogue.
import { gl, Program, FS_VS, drawFS, tex2D, fbo } from './gl.js';

const cache = new Map();
export const loading = { count: 0 };

// kind: 'color' (sRGB, mipmapped), 'data' (linear RGBA8, nearest; for packed heights), 'gray' (linear, mipmapped)
export function loadTexture(url, kind = 'color') {
  const key = url + '|' + kind;
  let e = cache.get(key);
  if (e) return e;
  e = { tex: null, ready: false, failed: false, w: 0, h: 0 };
  cache.set(key, e);
  loading.count++;
  e.promise = fetch(url).then(r => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.blob(); })
    .then(b => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
    .then(img => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      const internal = kind === 'color' ? gl.SRGB8_ALPHA8 : gl.RGBA8;
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, gl.RGBA, gl.UNSIGNED_BYTE, img);
      if (kind === 'data') {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      } else {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      e.tex = t; e.w = img.width; e.h = img.height; e.ready = true;
      if (kind === 'color') e.mean = meanColor(t, img.width, img.height);
      if (img.close) img.close();
      return e;
    })
    .catch(err => { console.warn('texture load failed', url, err.message); e.failed = true; })
    .finally(() => { loading.count--; });
  return e;
}

// Ensure all maps of a body are loaded. Returns the map set when everything requested is ready, else null.
// While loading, the body renders procedurally; body.mapsVersion changes when maps arrive so tiles get rebaked.
export function bodyMaps(body) {
  const m = body.maps;
  if (!m) return null;
  if (m._state) return m._state.ready ? m._state : null;
  const st = m._state = { ready: false };
  const jobs = [];
  for (const k of ['color', 'height', 'mask', 'lights', 'clouds']) {
    if (!m[k]) continue;
    const e = loadTexture(m[k], k === 'height' || k === 'mask' ? 'data' : k === 'color' ? 'color' : 'gray');
    st[k] = e; jobs.push(e.promise);
  }
  Promise.all(jobs).then(() => { st.ready = true; body.mapsVersion = (body.mapsVersion || 0) + 1; });
  return null;
}

// ---- star catalogue ----
export const catalog = { ready: false, data: null, count: 0, named: [], constellations: [], byIndex: new Map() };
export function loadCatalog() {
  if (catalog.promise) return catalog.promise;
  catalog.promise = Promise.all([
    fetch('data/stars.bin').then(r => r.arrayBuffer()),
    fetch('data/stars.json').then(r => r.json()),
  ]).then(([buf, js]) => {
    catalog.data = new Float32Array(buf);
    catalog.count = catalog.data.length / 5;
    catalog.named = js.named || [];
    catalog.constellations = js.constellations || [];
    for (const n of catalog.named) catalog.byIndex.set(n.i, n);
    catalog.ready = true;
    return catalog;
  }).catch(err => { console.warn('star catalogue failed to load', err.message); });
  return catalog.promise;
}

// mean linear colour of a mipmapped texture, weighted by area on the sphere (equirectangular rows shrink with cos(lat))
let pMean = null, meanFBO = null, meanTex = null;
function meanColor(t, w, h) {
  if (!pMean) {
    pMean = new Program('mean', FS_VS, `in vec2 vUV; out vec4 o; uniform sampler2D uTex; void main(){ vec3 s = vec3(0.); float ws = 0.;
      for (int j = 0; j < 32; j++) for (int i = 0; i < 64; i++) { vec2 uv = (vec2(i, j) + 0.5)/vec2(64., 32.); float wt = cos((uv.y - 0.5)*3.14159265); s += textureLod(uTex, uv, 5.).rgb*wt; ws += wt; }
      o = vec4(s/ws, 1.); }`);
    meanTex = tex2D(1, 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST); meanFBO = fbo([meanTex]);
  }
  const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING), vp = gl.getParameter(gl.VIEWPORT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, meanFBO); gl.viewport(0, 0, 1, 1); gl.disable(gl.BLEND);
  pMean.use().set({ uTex: t }); drawFS();
  const out = new Float32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB); gl.viewport(vp[0], vp[1], vp[2], vp[3]);
  return [out[0], out[1], out[2]];
}
