(() => {
"use strict";

const body = document.body;
const canvas = document.getElementById("bh");
const $ = (s) => document.querySelector(s);
if (!canvas) return;

/* ===== LOOK: tune the black hole here, then refresh with Ctrl+F5 ===== */
const LOOK = {
  dist: 15,        // smaller number = bigger black hole on screen
  elev: 5.5,       // degrees above the disk plane (small = thin, edge-on disk)
  roll: -4,        // tilt in degrees
  offx: 0.0,       // move right (+) or left (-), in screen heights
  offy: 0.10,      // move up (+) or down (-)
  dimIntro: 1.0,   // brightness during the intro
  dimIdle: 0.6,    // brightness behind the app
  dimWork: 0.42,   // brightness while a diagnosis is running
};

const VERT = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uRes;
uniform float uTime;
uniform float uDist;
uniform float uElev;
uniform float uRoll;
uniform vec2 uOff;
uniform float uDim;
uniform float uFade;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(i);
  float b = hash13(i + vec3(1.0, 0.0, 0.0));
  float c = hash13(i + vec3(0.0, 1.0, 0.0));
  float d = hash13(i + vec3(1.0, 1.0, 0.0));
  float e = hash13(i + vec3(0.0, 0.0, 1.0));
  float g = hash13(i + vec3(1.0, 0.0, 1.0));
  float h = hash13(i + vec3(0.0, 1.0, 1.0));
  float k = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
             mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

vec3 starLayer(vec3 d, float scale, float thresh, float seed) {
  vec3 p = d * scale;
  vec3 id = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash13(id + seed);
  if (h < thresh) { return vec3(0.0); }
  vec3 off = vec3(hash13(id + seed + 1.7), hash13(id + seed + 5.3), hash13(id + seed + 9.1)) - 0.5;
  float dist = length(f - off * 0.6);
  float size = mix(0.07, 0.16, hash13(id + seed + 3.3));
  float s = smoothstep(size, 0.0, dist);
  float ph = uTime * (0.8 + 3.0 * hash13(id + seed + 7.7)) + h * 40.0;
  float tw = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(ph), 2.0);
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.88, 0.75), hash13(id + seed + 2.2));
  return tint * s * tw * (0.8 + 2.0 * (h - thresh) / (1.0 - thresh));
}

vec3 starfield(vec3 d) {
  vec3 col = vec3(0.0);
  col += starLayer(d, 80.0, 0.90, 1.0);
  col += starLayer(d, 36.0, 0.955, 7.0) * 1.3;
  return col;
}

vec3 diskColor(vec3 p, vec3 dir, out float alpha) {
  alpha = 0.0;
  float r = length(p.xz);
  if (r < 3.0 || r > 11.0) { return vec3(0.0); }
  float tt = (r - 3.0) / 8.0;

  float T = 18.0;
  float t1 = mod(uTime, T);
  float t2 = mod(uTime + 0.5 * T, T);
  float w1 = 1.0 - abs(2.0 * t1 / T - 1.0);
  float om = 1.5 * pow(r, -1.5) * 1.6;
  float a1 = om * t1;
  float a2 = om * t2;
  vec2 q1 = mat2(cos(a1), sin(a1), -sin(a1), cos(a1)) * p.xz;
  vec2 q2 = mat2(cos(a2), sin(a2), -sin(a2), cos(a2)) * p.xz;
  float n1 = fbm(vec3(q1 * 1.35, r * 0.9));
  float n2 = fbm(vec3(q2 * 1.35, r * 0.9));
  float n = mix(n2, n1, w1);
  float bands = 0.5 + 0.5 * sin(r * 7.0 + n * 6.0);

  float v = sqrt(0.5 / r);
  vec3 vdir = normalize(vec3(p.z, 0.0, -p.x));
  float beta = dot(vdir * v, -normalize(dir));
  float dop = sqrt(1.0 - v * v) / (1.0 - beta);
  float boost = pow(clamp(dop, 0.3, 2.0), 2.4);

  vec3 inner = vec3(1.0, 0.82, 0.58);
  vec3 mid = vec3(1.0, 0.45, 0.12);
  vec3 outer = vec3(0.55, 0.10, 0.04);
  vec3 base = mix(inner, mid, smoothstep(0.0, 0.4, tt));
  base = mix(base, outer, smoothstep(0.35, 1.0, tt));
  base = mix(base * vec3(1.0, 0.72, 0.58), base, clamp(dop, 0.0, 1.0));
  base = mix(base, vec3(1.0, 0.93, 0.85), clamp((dop - 1.0) * 0.9, 0.0, 0.6));

  float gr = sqrt(max(1.0 - 1.0 / r, 0.0));
  float inten = pow(3.0 / r, 1.4) * 2.4 * (0.5 + n) * (0.75 + 0.25 * bands) * gr;

  alpha = clamp(smoothstep(2.95, 3.35, r) * (1.0 - smoothstep(7.0, 11.0, r)) * (0.45 + 0.9 * n), 0.0, 0.92);
  return base * inten * boost;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y - uOff;
  float cr = cos(uRoll);
  float sr = sin(uRoll);
  uv = mat2(cr, sr, -sr, cr) * uv;

  vec3 camPos = uDist * vec3(0.0, sin(uElev), cos(uElev));
  vec3 fw = normalize(-camPos);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw + (uv.x * rt + uv.y * up) * 0.728);

  vec3 pos = camPos;
  vec3 vel = rd;
  vec3 hv = cross(pos, vel);
  float h2 = dot(hv, hv);
  float b = sqrt(h2);

  vec3 glow = vec3(0.0);
  float trans = 1.0;
  bool hit = false;

  for (int i = 0; i < 128; i++) {
    float r2 = dot(pos, pos);
    float r = sqrt(r2);
    if (r < 1.0) { hit = true; break; }
    if (r > 45.0 && dot(pos, vel) > 0.0) { break; }
    float dt = clamp(0.05 * r, 0.025, 1.4);
    vec3 acc = -1.5 * h2 * pos / (r2 * r2 * r);
    vec3 prev = pos;
    vel += acc * dt;
    pos += vel * dt;
    if (prev.y * pos.y < 0.0) {
      float f = prev.y / (prev.y - pos.y);
      vec3 hp = mix(prev, pos, f);
      float a;
      vec3 c = diskColor(hp, vel, a);
      glow += trans * c * a;
      trans *= (1.0 - a);
    }
  }

  vec3 stars = vec3(0.0);
  if (!hit) {
    stars = trans * starfield(normalize(vel));
  }

  float ring = exp(-abs(b - 2.62) * 20.0);
  glow += vec3(1.0, 0.80, 0.58) * ring * 0.5;
  glow += vec3(1.0, 0.72, 0.50) * exp(-max(b - 2.6, 0.0) * 0.8) * 0.04;

  vec3 col = glow * uDim + stars * (0.55 + 0.45 * uDim);
  col = 1.0 - exp(-col * 1.4);

  vec2 q = gl_FragCoord.xy / uRes;
  col *= 0.7 + 0.3 * pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.25);
  float lum = max(col.r, max(col.g, col.b));
  col += (hash13(vec3(gl_FragCoord.xy, floor(uTime * 24.0))) - 0.5) * 0.02 * smoothstep(0.0, 0.1, lum);
  col *= uFade;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/* ===== text scramble (the "system decoding" effect) ===== */
const FX = window.MentoraFX = { skipping: false, introOn: false };
const POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@$%&*<>/|+=?";
const rnd = () => POOL[Math.floor(Math.random() * POOL.length)];
const sleep = (ms) => new Promise(r => setTimeout(r, FX.skipping ? 0 : ms));

FX.scramble = function (el, text, o) {
  o = o || {};
  const dur = o.duration || 1000, lead = o.lead || 0, cells = !!o.cells;
  const chars = Array.from(text), n = chars.length;
  if (cells) {
    el.innerHTML = chars.map(c => c === " " ? '<span class="ch sp">&nbsp;</span>' : '<span class="ch noise"></span>').join("");
  }
  const spans = cells ? Array.from(el.children) : null;
  const reveal = chars.map((c, i) =>
    Math.min(dur, lead + (dur - lead) * (i / Math.max(n - 1, 1)) + (Math.random() - 0.5) * 140));
  const t0 = performance.now();
  return new Promise(resolve => {
    let iv = null;
    const tick = () => {
      const ms = FX.skipping ? 1e9 : performance.now() - t0;
      let out = "", done = true;
      for (let i = 0; i < n; i++) {
        const c = chars[i];
        const ok = c === " " || ms >= reveal[i];
        if (!ok) done = false;
        const ch = ok ? c : rnd();
        if (cells) {
          if (c !== " ") { spans[i].textContent = ch; spans[i].classList.toggle("noise", !ok); }
        } else { out += ch; }
      }
      if (!cells) el.textContent = out;
      if (done) { if (iv) clearInterval(iv); resolve(); }
    };
    iv = setInterval(tick, 45);
    tick();
  });
};

/* ===== state ===== */
const QUALITY = [880, 640, 460];
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let qi = 0, gl = null, prog = null, running = false, t = 0, introToken = 0;
let enabled = true;
try { enabled = localStorage.getItem("mentora-fx") !== "off"; } catch (e) { /* ignore */ }
let lastDraw = 0, frames = 0, slow = 0;
let dimTarget = LOOK.dimIntro, dimCur = LOOK.dimIntro;
const loc = {};

const ease = (x) => { x = Math.min(Math.max(x, 0), 1); return x * x * (3 - 2 * x); };
const rad = (d) => d * Math.PI / 180;

function setLabel(text) {
  const b = $("#fx-toggle");
  if (b) b.textContent = text || (enabled ? "Effects: on" : "Effects: off");
}

FX.setMode = function (m) {
  if (FX.introOn && m !== "intro") return;
  dimTarget = m === "intro" ? LOOK.dimIntro : m === "work" ? LOOK.dimWork : LOOK.dimIdle;
};

/* ===== WebGL setup ===== */
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn("Black hole shader error:", gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

function setup() {
  try {
    gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });
  } catch (e) { gl = null; }
  if (!gl) return false;
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { gl = null; return false; }
  prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("Black hole link error:", gl.getProgramInfoLog(prog));
    gl = null; return false;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  ["uRes", "uTime", "uDist", "uElev", "uRoll", "uOff", "uDim", "uFade"].forEach(n => { loc[n] = gl.getUniformLocation(prog, n); });
  resize();
  window.addEventListener("resize", resize);
  return true;
}

function resize() {
  if (!gl) return;
  const w = Math.min(QUALITY[qi], innerWidth);
  const sc = w / innerWidth;
  canvas.width = Math.max(2, Math.round(innerWidth * sc));
  canvas.height = Math.max(2, Math.round(innerHeight * sc));
  gl.viewport(0, 0, canvas.width, canvas.height);
}

/* The black hole drifts gently in place. */
function camera(tt, sec) {
  return {
    dist: LOOK.dist - 0.8 * ease(tt / 3) + 0.35 * Math.sin(sec * 0.19),
    elev: rad(LOOK.elev + 0.9 * Math.sin(sec * 0.15 + 1)),
    roll: rad(LOOK.roll + 1.6 * Math.sin(sec * 0.11 + 2)),
    offx: LOOK.offx + 0.012 * Math.sin(sec * 0.13),
    offy: LOOK.offy + 0.010 * Math.sin(sec * 0.17 + 1),
    fade: ease(tt / 2.2),
  };
}

function draw(now) {
  const sec = now / 1000;
  const c = camera(t, sec);
  gl.uniform2f(loc.uRes, canvas.width, canvas.height);
  gl.uniform1f(loc.uTime, sec);
  gl.uniform1f(loc.uDist, c.dist);
  gl.uniform1f(loc.uElev, c.elev);
  gl.uniform1f(loc.uRoll, c.roll);
  gl.uniform2f(loc.uOff, c.offx, c.offy);
  gl.uniform1f(loc.uDim, dimCur * (1 + 0.035 * Math.sin(sec * 0.9)));
  gl.uniform1f(loc.uFade, c.fade);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function lowerQuality() {
  if (qi < QUALITY.length - 1) { qi++; resize(); }
  else { disable(true); }
}

function loop(now) {
  if (!running) return;
  requestAnimationFrame(loop);
  const gap = now - lastDraw;
  if (gap < 30) return;
  lastDraw = now;
  t += Math.min(gap, 100) / 1000;
  dimCur += (dimTarget - dimCur) * 0.06;
  frames++;
  if (frames > 24) {
    slow = gap > 55 ? slow + 1 : Math.max(0, slow - 1);
    if (slow > 40) { slow = 0; lowerQuality(); if (!running) return; }
  }
  draw(now);
}

function enableBH() {
  if (!gl && !setup()) return false;
  body.classList.add("bh-on");
  if (reduce) { dimCur = dimTarget; t = 3; draw(performance.now()); return true; }
  if (!running) { running = true; frames = 0; lastDraw = 0; requestAnimationFrame(loop); }
  return true;
}

/* ===== intro: the system powers on ===== */
function finishIntro() {
  if (!FX.introOn) return;
  FX.introOn = false;
  FX.skipping = false;
  FX.setMode("idle");
  body.classList.add("intro-out");
  setTimeout(() => {
    body.classList.remove("intro-active", "intro-out");
    body.classList.add("booted");
    document.dispatchEvent(new Event("mentora:boot"));
  }, 700);
  try { sessionStorage.setItem("mentora-intro", "1"); } catch (e) { /* ignore */ }
}

async function runIntro() {
  const my = ++introToken;
  const alive = () => my === introToken && FX.introOn;
  const bl = $("#boot-lines"), tt = $("#intro-title"), ts = $("#intro-sub");
  bl.innerHTML = ""; tt.innerHTML = ""; ts.textContent = "";
  const lines = [
    "> SYSTEM ONLINE",
    "> NEMOTRON CORE ......... READY",
    "> KNOWLEDGE MAP ......... LOADED",
    "> ROOT-CAUSE ENGINE ..... ARMED",
  ];
  await sleep(900); if (!alive()) return;
  for (const line of lines) {
    const d = document.createElement("div");
    bl.appendChild(d);
    await FX.scramble(d, line, { duration: 460 }); if (!alive()) return;
    await sleep(90); if (!alive()) return;
  }
  await sleep(200); if (!alive()) return;
  await FX.scramble(tt, "MENTORA", { duration: 2700, lead: 1000, cells: true }); if (!alive()) return;
  await sleep(250); if (!alive()) return;
  await FX.scramble(ts, "Find the root. Fix the gap.", { duration: 1400, lead: 250 }); if (!alive()) return;
  await sleep(1200); if (!alive()) return;
  finishIntro();
}

function startIntro() {
  FX.introOn = true;
  FX.skipping = false;
  body.classList.add("intro-active");
  body.classList.remove("intro-out", "booted");
  FX.setMode("intro");
  runIntro();
}

function skip() { if (FX.introOn) FX.skipping = true; }

function disable(auto) {
  running = false; enabled = false;
  introToken++;
  FX.introOn = false; FX.skipping = false;
  body.classList.remove("bh-on", "intro-active", "intro-out");
  body.classList.add("booted");
  if (!auto) { try { localStorage.setItem("mentora-fx", "off"); } catch (e) { /* ignore */ } }
  setLabel(auto ? "Effects: off (auto)" : null);
}

function enable() {
  enabled = true;
  try { localStorage.setItem("mentora-fx", "on"); } catch (e) { /* ignore */ }
  enableBH();
  FX.setMode("idle");
  setLabel();
}

function boot() {
  try {
    let seen = false;
    try { seen = sessionStorage.getItem("mentora-intro") === "1"; } catch (e) { /* ignore */ }
    const force = /[?&]intro=1/.test(location.search);
    setLabel();
    if (!enabled) { body.classList.add("booted"); return; }
    enableBH();
    if (reduce || (seen && !force)) {
      FX.setMode("idle"); dimCur = dimTarget;
      body.classList.add("booted");
      return;
    }
    startIntro();
  } catch (e) {
    body.classList.remove("intro-active");
  }
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") skip(); });
const introEl = $("#intro");
if (introEl) introEl.addEventListener("click", skip);
const replay = $("#fx-replay");
if (replay) replay.addEventListener("click", () => {
  if (FX.introOn) return;
  if (!enabled) enable();
  startIntro();
});
const toggle = $("#fx-toggle");
if (toggle) toggle.addEventListener("click", () => { if (enabled) disable(false); else enable(); });

boot();
})();