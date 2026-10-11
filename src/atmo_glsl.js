// Physically based atmosphere (after Hillaire 2020): transmittance + multiple scattering LUTs and a ray marcher.
export const ATMO_UNIFORMS = `
uniform float aRg, aRt, aR0;       // ground radius, top radius, datum radius (metres)
uniform vec3 aRay; uniform float aHR;
uniform vec3 aMieS, aMieA; uniform float aHM; uniform vec3 aMieG;
uniform vec3 aAbs; uniform float aAbsH, aAbsW;
`;
export const ATMO_COMMON = `
const float PI = 3.14159265358979;
vec2 transUV(float r, float mu){
  float H = sqrt(aRt*aRt - aRg*aRg);
  float rho = sqrt(max((r - aRg)*(r + aRg), 0.));
  float d = max(-r*mu + sqrt(max(r*r*(mu*mu - 1.) + aRt*aRt, 0.)), 0.);
  float dmin = aRt - r, dmax = rho + H;
  return vec2(clamp((d - dmin)/max(dmax - dmin, 1e-3), 0., 1.)*(255./256.) + 0.5/256., clamp(rho/H, 0., 1.)*(63./64.) + 0.5/64.);
}
void atmoDensity(float alt, out vec3 scatR, out vec3 scatM, out vec3 ext){
  float dR = exp(-alt/aHR), dM = exp(-alt/aHM);
  float dA = aAbsW > 0. ? (aAbsH <= 0. ? exp(-alt/aAbsW) : max(0., 1. - abs(alt - aAbsH)/aAbsW)) : 0.;
  scatR = aRay*dR; scatM = aMieS*dM;
  ext = scatR + scatM + aMieA*dM + aAbs*dA;
}
float raySphere(vec3 o, vec3 d, float R, out float t0, out float t1){
  float b = dot(o, d), c = dot(o, o) - R*R, h = b*b - c;
  if (h < 0.) { t0 = t1 = -1.; return -1.; }
  h = sqrt(h); t0 = -b - h; t1 = -b + h; return 1.;
}
float phaseR(float c){ return 3./(16.*PI)*(1. + c*c); }
vec3 phaseM(float c, vec3 g){ vec3 g2 = g*g; return 3./(8.*PI)*((1.-g2)*(1.+c*c))/((2.+g2)*pow(1.+g2-2.*g*c, vec3(1.5))); }
`;
export const ATMO_LUT_SAMPLE = `
uniform sampler2D uTransLUT, uMultiLUT;
vec3 atmoTrans(float r, float mu){ return texture(uTransLUT, transUV(r, mu)).rgb; }
// transmittance towards the sun including the planet's shadow (soft edge)
vec3 atmoSunTrans(float r, float mu){
  r = max(r, aRg + 1.);
  float sinH = aRg / r, cosH = -sqrt(max(1. - sinH*sinH, 0.));
  return atmoTrans(r, max(mu, cosH)) * smoothstep(-0.006, 0.006, mu - cosH);
}
vec3 atmoMulti(float r, float mu){ return texture(uMultiLUT, vec2(mu*0.5 + 0.5, clamp((r - aRg)/(aRt - aRg), 0., 1.))*(31./32.) + 0.5/32.).rgb; }
`;
export const ATMO_TRANS_FS = ATMO_UNIFORMS + ATMO_COMMON + `
in vec2 vUV; out vec4 o;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5)/vec2(255., 63.);
  float H = sqrt(aRt*aRt - aRg*aRg), rho = H*uv.y;
  float r = sqrt(rho*rho + aRg*aRg);
  float dmin = aRt - r, dmax = rho + H, d = dmin + uv.x*(dmax - dmin);
  float mu = d == 0. ? 1. : clamp((H*H - rho*rho - d*d)/(2.*r*d), -1., 1.);
  vec3 od = vec3(0.); const int N = 48; float dt = d/float(N);
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.5)*dt;
    float rr = sqrt(r*r + t*t + 2.*r*mu*t);
    vec3 sr, sm, ex; atmoDensity(rr - aR0, sr, sm, ex); od += ex*dt;
  }
  o = vec4(exp(-od), 1.);
}`;
export const ATMO_MULTI_FS = ATMO_UNIFORMS + ATMO_COMMON + `
uniform sampler2D uTransLUT;
vec3 atmoTrans(float r, float mu){ return texture(uTransLUT, transUV(r, mu)).rgb; }
in vec2 vUV; out vec4 o;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5)/31.;
  float mus = uv.x*2. - 1.;
  float r = aRg + clamp(uv.y, 0.001, 0.999)*(aRt - aRg);
  vec3 pos = vec3(0., r, 0.), sun = vec3(sqrt(max(1. - mus*mus, 0.)), mus, 0.);
  vec3 L2 = vec3(0.), fms = vec3(0.);
  const int ND = 8; const int NS = 20;
  for (int i = 0; i < ND; i++) for (int j = 0; j < ND; j++) {
    float th = PI*(float(i) + 0.5)/float(ND), ph = 2.*PI*(float(j) + 0.5)/float(ND);
    vec3 dir = vec3(sin(th)*cos(ph), cos(th), sin(th)*sin(ph));
    float t0, t1, g0, g1; raySphere(pos, dir, aRt, t0, t1);
    float tmax = t1; bool ground = false;
    if (raySphere(pos, dir, aRg, g0, g1) > 0. && g0 > 0.) { tmax = g0; ground = true; }
    float dt = tmax/float(NS); vec3 T = vec3(1.), L = vec3(0.), F = vec3(0.);
    for (int k = 0; k < NS; k++) {
      vec3 p = pos + dir*((float(k) + 0.3)*dt); float rr = length(p);
      vec3 sr, sm, ex; atmoDensity(rr - aR0, sr, sm, ex);
      vec3 st = exp(-ex*dt);
      float mu = dot(p, sun)/rr;
      float sinH = aRg/rr; float cosH = -sqrt(max(1. - sinH*sinH, 0.));
      vec3 sunT = mu > cosH ? atmoTrans(rr, mu) : vec3(0.);
      vec3 S = (sr + sm)*sunT/(4.*PI);
      vec3 Si = (S - S*st)/max(ex, vec3(1e-12));
      L += T*Si; F += T*((sr + sm) - (sr + sm)*st)/max(ex, vec3(1e-12));
      T *= st;
    }
    if (ground) { vec3 p = pos + dir*tmax; float rr = length(p); float mu = dot(p, sun)/rr; if (mu > 0.) L += T*atmoTrans(rr, mu)*mu*0.3/PI; }
    float w = sin(th)*(PI/float(ND))*(2.*PI/float(ND));
    L2 += L*w/(4.*PI); fms += F*w/(4.*PI);
  }
  o = vec4(L2/(1. - min(fms, vec3(0.97))), 1.);
}`;
// March from camera through the atmosphere. o is the camera position relative to planet centre.
export const ATMO_MARCH = `
// returns in-scattered light (for unit sun illuminance) and transmittance
void atmoMarch(vec3 o, vec3 d, float tmin, float tmax, vec3 sunDir, vec3 sunCol, int N, float jitter, out vec3 L, out vec3 T){
  L = vec3(0.); T = vec3(1.);
  float c = dot(d, sunDir); float pr = phaseR(c); vec3 pm = phaseM(c, aMieG);
  float len = tmax - tmin; if (len <= 0.) return;
  float prev = 0.;
  for (int i = 0; i < N; i++) {
    // quadratic distribution: more samples near the camera
    float f1 = float(i + 1)/float(N); f1 = f1*f1;
    float t1 = len*f1, dt = t1 - prev; float t = tmin + prev + dt*jitter; prev = t1;
    vec3 p = o + d*t; float r = length(p);
    vec3 sr, sm, ex; atmoDensity(r - aR0, sr, sm, ex);
    float mu = dot(p, sunDir)/r;
    vec3 sunT = atmoSunTrans(r, mu);
    vec3 S = (sr*pr + sm*pm)*sunT + (sr + sm)*atmoMulti(r, mu);
    vec3 st = exp(-ex*dt);
    L += T*sunCol*(S - S*st)/max(ex, vec3(1e-12));
    T *= st;
  }
}
`;
// Sky irradiance on the ground as a function of sun zenith cosine (1D LUT)
export const ATMO_IRR_FS = ATMO_UNIFORMS + ATMO_COMMON + ATMO_LUT_SAMPLE + ATMO_MARCH + `
in vec2 vUV; out vec4 o;
void main(){
  float mus = (gl_FragCoord.x - 0.5)/63.*2. - 1.;
  vec3 sun = vec3(sqrt(max(1. - mus*mus, 0.)), mus, 0.);
  vec3 pos = vec3(0., aRg + 2., 0.);
  vec3 E = vec3(0.);
  const int NT = 6; const int NP = 12;
  for (int i = 0; i < NT; i++) for (int j = 0; j < NP; j++) {
    float th = 0.5*PI*(float(i) + 0.5)/float(NT), ph = 2.*PI*(float(j) + 0.5)/float(NP);
    vec3 dir = vec3(sin(th)*cos(ph), cos(th), sin(th)*sin(ph));
    float t0, t1; raySphere(pos, dir, aRt, t0, t1);
    vec3 L, T; atmoMarch(pos, dir, 0., t1, sun, vec3(1.), 14, 0.5, L, T);
    E += L*cos(th)*sin(th)*(0.5*PI/float(NT))*(2.*PI/float(NP));
  }
  o = vec4(E, 1.);
}`;
