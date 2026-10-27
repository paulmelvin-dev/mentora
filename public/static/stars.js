(() => {
"use strict";

const body = document.body;
const MOBILE = !!window.MENTORA_MOBILE;
const c = document.createElement("canvas");
c.id = "stars";
Object.assign(c.style, {
  position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0", display: "none",
  background: "radial-gradient(120% 90% at 50% 30%, #060a14 0%, #000 70%)",
});
body.prepend(c);
const ctx = c.getContext("2d");
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const HAS_CONIC = typeof ctx.createConicGradient === "function";
let w = 0, h = 0, dpr = 1, stars = [], running = false, last = 0;

/* A tiny black hole in a random spot of the lower-right sky (desktop only). */
const bh = {
  fx: 0.64 + Math.random() * 0.28,
  fy: 0.70 + Math.random() * 0.16,
  R: 17 + Math.random() * 9,
  tilt: (-14 + Math.random() * 12) * Math.PI / 180,
  k: 0.20 + Math.random() * 0.06,
};

function build() {
  dpr = Math.min(window.devicePixelRatio || 1, MOBILE ? 1.5 : 2);
  w = innerWidth; h = innerHeight;
  c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
  const n = MOBILE ? Math.min(140, Math.round(w * h / 8000)) : Math.min(520, Math.round(w * h / 4800));
  stars = Array.from({ length: n }, () => {
    const big = Math.random() < 0.06;
    return {
      x: Math.random() * w, y: Math.random() * h,
      r: big ? 1.2 + Math.random() * 0.9 : 0.4 + Math.random() * 0.7,
      a: big ? 0.8 : 0.35 + Math.random() * 0.5,
      sp: 0.25 + Math.random() * 0.9, ph: Math.random() * Math.PI * 2,
      drift: MOBILE ? 0 : 0.8 + Math.random() * 2.2, big, warm: Math.random() < 0.25,
    };
  });
}

/* ----- tiny black hole ----- */
function ringStroke(radius, width, angle, a) {
  if (HAS_CONIC) {
    const g = ctx.createConicGradient(angle, 0, 0);
    g.addColorStop(0.00, `rgba(255,244,222,${a})`);
    g.addColorStop(0.18, `rgba(255,190,110,${a * 0.85})`);
    g.addColorStop(0.50, `rgba(190,90,30,${a * 0.45})`);
    g.addColorStop(0.82, `rgba(255,170,90,${a * 0.8})`);
    g.addColorStop(1.00, `rgba(255,244,222,${a})`);
    ctx.strokeStyle = g;
  } else {
    ctx.strokeStyle = `rgba(255,190,120,${a * 0.7})`;
  }
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function diskHalf(x, y, front, t) {
  const R = bh.R;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(bh.tilt);
  ctx.beginPath();
  ctx.rect(-6 * R, front ? 0 : -6 * R, 12 * R, 6 * R);
  ctx.clip();
  ctx.scale(1, bh.k);
  for (let i = 5; i >= 0; i--) {
    ringStroke(R * (1.45 + i * 0.26), R * 0.3, t * (0.9 / (1 + i * 0.5)) + i, 0.85 - i * 0.12);
  }
  ctx.restore();
}

function lensedArcs(x, y, t) {
  const R = bh.R;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(bh.tilt);
  [true, false].forEach((up) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-4 * R, up ? -4 * R : 0, 8 * R, 4 * R);
    ctx.clip();
    ringStroke(R * (up ? 1.2 : 1.14), R * (up ? 0.34 : 0.14), t * 0.35, up ? 0.8 : 0.35);
    ctx.restore();
  });
  ctx.restore();
}

function paintBlackHole(t) {
  const R = bh.R;
  const x = Math.min(bh.fx * w, w - 3.2 * R - 8);
  const y = bh.fy * h;
  ctx.save();

  ctx.globalAlpha = 0.85 + 0.15 * Math.sin(t * 0.6);
  const g = ctx.createRadialGradient(x, y, R * 0.9, x, y, R * 4.4);
  g.addColorStop(0, "rgba(255,160,80,0.22)");
  g.addColorStop(0.35, "rgba(255,140,60,0.08)");
  g.addColorStop(1, "rgba(255,120,40,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, R * 4.4, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;

  diskHalf(x, y, false, t);
  lensedArcs(x, y, t);

  ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  ctx.shadowColor = "rgba(255,190,110,0.9)";
  ctx.shadowBlur = R * 0.5;
  ctx.strokeStyle = "rgba(255,238,210,0.92)";
  ctx.lineWidth = Math.max(1, R * 0.055);
  ctx.beginPath(); ctx.arc(x, y, R * 1.01, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  diskHalf(x, y, true, t);
  ctx.restore();
}

/* ----- the sky ----- */
function paint(t) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (const s of stars) {
    const x = s.drift ? (s.x + t * s.drift) % w : s.x;
    const tw = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph));
    const a = s.a * tw;
    const col = s.warm ? "255,226,190" : "205,222,255";
    if (s.big) {
      const g = ctx.createRadialGradient(x, s.y, 0, x, s.y, s.r * 5);
      g.addColorStop(0, `rgba(${col},${a})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, s.y, s.r * 5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = `rgba(${col},${Math.min(1, a + 0.15)})`;
    ctx.beginPath(); ctx.arc(x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  }
  if (!MOBILE) paintBlackHole(t);
}

function loop(now) {
  if (!running) return;
  requestAnimationFrame(loop);
  if (now - last < (MOBILE ? 66 : 40)) return;
  last = now;
  paint(now / 1000);
}

function start() {
  if (running) return;
  c.style.display = "block";
  build();
  if (reduce) { paint(0); return; }
  running = true;
  requestAnimationFrame(loop);
}

function stop() {
  running = false;
  c.style.display = "none";
}

function sync() { if (body.classList.contains("bh-on")) stop(); else start(); }

new MutationObserver(sync).observe(body, { attributes: true, attributeFilter: ["class"] });
window.addEventListener("resize", () => { if (c.style.display === "block") build(); });
sync();
})();