(() => {
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

let STATE = null, CUR = null, busy = false, celebrated = false, chatBusy = false;
const chat = [];

const fx = () => window.MentoraFX || null;
function scr(el, text, o) {
  const f = fx();
  if (f && f.scramble) return f.scramble(el, text, o);
  el.textContent = text;
  return Promise.resolve();
}

/* ---------- this visitor's data lives in this browser ---------- */
const STORE_KEY = "mentora-state-v1";
let LOCAL = { memory: null, run: null };
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  if (saved && saved.memory) LOCAL = saved;
} catch (e) { /* start fresh */ }

function saveLocal(s) {
  LOCAL = s;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); }
  catch (e) { toast("Your browser storage is full. Use Memory & privacy to download and delete your data."); }
}

async function post(path, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let code = "";
    try { code = localStorage.getItem("mentora-code") || ""; } catch (e) { /* ignore */ }
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Code": code },
      body: JSON.stringify(payload),
    });
    if (res.status === 401 && attempt === 0) {
      const entered = window.prompt("This demo needs an access code. You can find it on the project's Devpost page.");
      if (!entered) throw new Error("An access code is needed to use this demo.");
      try { localStorage.setItem("mentora-code", entered.trim()); } catch (e) { /* ignore */ }
      continue;
    }
    if (!res.ok) {
      let msg = "Something went wrong. Please try again.";
      try { const j = await res.json(); if (typeof j.detail === "string") msg = j.detail; } catch (e) { /* ignore */ }
      if (res.status === 401) {
        try { localStorage.removeItem("mentora-code"); } catch (e) { /* ignore */ }
        msg = "That access code didn't work.";
      }
      throw new Error(msg);
    }
    return res;
  }
  throw new Error("Could not reach the server.");
}

/* Sends this visitor's data, gets the updated data back, and returns the view to draw. */
async function call(path, params) {
  const res = await post(path, Object.assign({ state: LOCAL }, params || {}));
  const data = await res.json();
  saveLocal(data.state);
  STATE = data.app;
  renderAll();
  return data.view;
}

function slimState() {
  const m = LOCAL.memory || {};
  const rc = m.rc || {};
  return { memory: Object.assign({}, m, { rc: { ledger: rc.ledger || [] } }) };
}

/* ---------- utilities ---------- */
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function md(s) {
  let t = esc(s);
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  let out = "", list = "";
  const close = () => { if (list) { out += `</${list}>`; list = ""; } };
  for (const line of t.split("\n")) {
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const m = ul || ol;
    if (m) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) { close(); out += `<${kind}>`; list = kind; }
      out += `<li>${m[1]}</li>`;
    } else {
      close();
      if (line.trim()) out += `<p>${line}</p>`;
    }
  }
  close();
  return out;
}

function typeset(el) {
  if (!el || typeof window.renderMathInElement !== "function") return;
  try {
    window.renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
  } catch (e) { /* ignore */ }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 4500);
}

function friendly(err) {
  if (err instanceof TypeError) return "Couldn't reach the server. Check your connection and try again.";
  return (err && err.message) || "Something went wrong. Please try again.";
}

function confetti() {
  const c = $("#fx"), ctx = c.getContext("2d");
  c.width = innerWidth; c.height = innerHeight;
  const cols = ["#76B900", "#2fd4a5", "#22d3ee", "#8b7bff", "#ffb020"];
  const ps = Array.from({ length: 150 }, () => ({
    x: innerWidth / 2, y: innerHeight * .35, vx: (Math.random() - .5) * 15, vy: Math.random() * -12 - 3,
    s: Math.random() * 6 + 4, c: cols[Math.floor(Math.random() * cols.length)], r: Math.random() * 6,
  }));
  let t = 0;
  (function tick() {
    ctx.clearRect(0, 0, c.width, c.height);
    ps.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += .35; p.r += .2;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .6); ctx.restore();
    });
    if (++t < 170) requestAnimationFrame(tick); else ctx.clearRect(0, 0, c.width, c.height);
  })();
}

/* ---------- navigation ---------- */
const TITLES = { root: "Root-Cause", chat: "Chat coach", brain: "Your brain", privacy: "Memory & privacy" };
const SUBS = {
  root: "Find why you're really stuck.", chat: "Your everyday study coach.",
  brain: "What Mentora knows about how you learn.", privacy: "Your data, your control.",
};

function showPage(name) {
  $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + name));
  $$(".nav button").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  scr($("#page-title"), TITLES[name], { duration: 500 });
  $("#page-sub").textContent = (name === "root" && CUR && CUR.root && CUR.stage !== "idle")
    ? "Diagnosing · " + CUR.root : SUBS[name];
  $(".main").scrollTop = 0;
  if (name === "privacy") loadMemory();
}

/* ---------- small renders ---------- */
function barHtml(label, pct) {
  const color = pct < 40 ? "var(--red)" : pct < 70 ? "var(--amber)" : "var(--green)";
  return `<div class="brow"><span>${esc(label)}</span><span>${pct}%</span></div>` +
         `<div class="bar"><div class="fill" style="width:${Math.max(pct, 3)}%;background:${color}"></div></div>`;
}

function renderAll() {
  if (!STATE) return;
  renderTop(); renderBrain(); renderNotes(); renderRecent();
}

function renderTop() {
  let h = `<span class="pill">${esc(STATE.model)} · Nebius</span><span class="pill">your data stays in this browser</span>`;
  const rv = STATE.reviews;
  if (rv && rv.due > 0) {
    h += `<span class="pill hot">${rv.due} review${rv.due === 1 ? "" : "s"} due</span>`;
  } else if (rv && rv.total > 0) {
    h += `<span class="pill">${rv.total} review${rv.total === 1 ? "" : "s"} scheduled</span>`;
  }
  if (STATE.exam && STATE.exam_days !== null && STATE.exam_days >= 0) {
    h += `<span class="pill hot">${esc(STATE.exam.subject)} exam in ${STATE.exam_days} days</span>`;
  }
  $("#top-chips").innerHTML = h;
}

function renderBrain() {
  let conc = STATE.concepts.length
    ? STATE.concepts.map(c => barHtml(c.name, c.pct)).join("")
    : `<p class="muted">No concepts yet. Start a diagnosis on the Root-Cause page.</p>`;
  const rv = STATE.reviews;
  if (rv && rv.items && rv.items.length) {
    conc += `<div class="sec-title" style="margin-top:24px">Review schedule</div>` +
      rv.items.map(i => `<div class="item"><strong>${esc(i.node)}</strong> <span class="muted">· ${esc(i.target)}</span>` +
        `<small>next check ${esc(i.due)} · box ${i.stage + 1} of 4</small></div>`).join("");
  }
  $("#brain-concepts").innerHTML = conc;
  const led = STATE.ledger.slice().reverse();
  $("#brain-ledger").innerHTML = led.length
    ? led.map(e => `<div class="item">${e.fixed ? "✅" : "🔴"} <strong>${esc(e.node)}</strong>: ${esc(e.text || "gap detected")}<small>${esc(e.date)} · from ${esc(e.target)}</small></div>`).join("")
    : `<p class="muted">Nothing recorded yet.</p>`;
  if (STATE.exam) {
    $("#exam-subject").value = STATE.exam.subject;
    $("#exam-date").value = STATE.exam.date;
  }
}

function renderNotes() {
  $("#notes-list").innerHTML = STATE.notes.length
    ? STATE.notes.map(n => `<div class="item">📝 ${esc(n)}</div>`).join("")
    : `<p class="muted">No notes yet.</p>`;
}

function renderRecent() {
  const list = STATE.sessions || [];
  $("#recent").innerHTML = list.length
    ? list.map(s => `<button class="rec${s.active ? " active" : ""}" data-id="${esc(s.id)}" title="${esc(s.concept)}"><i class="dot ${esc(s.outcome || "prog")}"></i><span>${esc(s.concept)}</span></button>`).join("")
    : `<div class="muted tiny">No diagnoses yet.</div>`;
}

function loadMemory() {
  $("#mem-json").textContent = JSON.stringify(LOCAL.memory || {}, null, 2);
}

/* ---------- knowledge map ---------- */
let graphSig = "", nodeEls = {}, edgeEls = [];

function wrapLabel(s) {
  if (s.length <= 18) return [s];
  const mid = s.length / 2;
  let best = -1, bd = 1e9;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === " ") { const d = Math.abs(i - mid); if (d < bd) { bd = d; best = i; } }
  }
  return best < 0 ? [s] : [s.slice(0, best), s.slice(best + 1)];
}

function buildGraph(g) {
  const ids = g.nodes.map(n => n.id);
  const level = {};
  ids.forEach(i => { level[i] = 0; });
  for (let it = 0; it < ids.length; it++) {
    let changed = false;
    for (const e of g.edges) {
      const want = level[e.to] + 1;
      if (level[e.from] < want && want <= ids.length) { level[e.from] = want; changed = true; }
    }
    if (!changed) break;
  }
  const rows = {};
  ids.forEach(i => { (rows[level[i]] = rows[level[i]] || []).push(i); });
  const keys = Object.keys(rows).map(Number).sort((a, b) => a - b);
  const info = {};
  ids.forEach(i => {
    const lines = wrapLabel(i);
    const w = Math.max(88, Math.min(170, Math.max(...lines.map(l => l.length)) * 7.2 + 30));
    info[i] = { lines, w, h: lines.length > 1 ? 54 : 38 };
  });
  const gap = 24;
  let W = 460;
  keys.forEach(L => {
    const total = rows[L].reduce((s, i) => s + info[i].w, 0) + gap * (rows[L].length - 1) + 40;
    W = Math.max(W, total);
  });
  const rowH = 112, H = keys.length * rowH + 10;
  keys.forEach((L, idx) => {
    const list = rows[L];
    const total = list.reduce((s, i) => s + info[i].w, 0) + gap * (list.length - 1);
    let x = (W - total) / 2;
    list.forEach(i => { info[i].x = x + info[i].w / 2; info[i].y = 40 + idx * rowH; x += info[i].w + gap; });
  });

  let out = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6c7aa0"/></marker></defs>`;
  g.edges.forEach(e => {
    const a = info[e.from], b = info[e.to];
    if (!a || !b) return;
    const y1 = a.y - a.h / 2, y2 = b.y + b.h / 2, ym = (y1 + y2) / 2;
    const d = level[e.to] * 260 + 200;
    out += `<path class="edge" style="--d:${d}ms" data-from="${esc(e.from)}" marker-end="url(#arrow)" d="M${a.x} ${y1} C${a.x} ${ym}, ${b.x} ${ym}, ${b.x} ${y2}"/>`;
  });
  g.nodes.forEach((n, k) => {
    const o = info[n.id];
    const d = level[n.id] * 260 + k * 40;
    const tspans = o.lines.map((l, li) =>
      `<tspan x="${o.x}" dy="${li === 0 ? (o.lines.length > 1 ? -7 : 0) : 15}">${esc(l)}</tspan>`).join("");
    out += `<g class="node ${n.status}" data-id="${esc(n.id)}" style="--d:${d}ms">` +
           `<rect x="${o.x - o.w / 2}" y="${o.y - o.h / 2}" width="${o.w}" height="${o.h}" rx="2"/>` +
           `<text x="${o.x}" y="${o.y}">${tspans}</text></g>`;
  });
  const svg = $("#graph");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = out;
  nodeEls = {}; edgeEls = [];
  $$(".node", svg).forEach(el => { nodeEls[el.dataset.id] = el; });
  $$(".edge", svg).forEach(el => { edgeEls.push({ el, from: el.getAttribute("data-from") }); });
}

function renderGraph(g) {
  const svg = $("#graph"), empty = $("#graph-empty");
  if (!g) { svg.innerHTML = ""; svg.style.display = "none"; empty.style.display = "none"; graphSig = ""; return; }
  empty.style.display = "none";
  svg.style.display = "block";
  $("#map-model").textContent = g.model ? "built by " + g.model : "";
  const sig = JSON.stringify([g.key, g.nodes.map(n => n.id), g.edges]);
  if (sig !== graphSig) { buildGraph(g); graphSig = sig; }
  const byId = {};
  g.nodes.forEach(n => { byId[n.id] = n.status; });
  g.nodes.forEach(n => { const el = nodeEls[n.id]; if (el) el.setAttribute("class", "node " + n.status); });
  edgeEls.forEach(({ el, from }) => el.setAttribute("class", "edge" + (byId[from] === "mastered" ? " ok" : "")));
}

/* ---------- Root-Cause chat ---------- */
const LEVELS = ["School (grades 6-10)", "School (grades 11-12)", "College"];
const EXAMPLES = ["Solving quadratic equations", "Photosynthesis", "Newton's laws of motion", "Adding fractions"];

/* The Daily Review box is always on the home page, in the same panel as the question form. */
function reviewPanel() {
  const rv = (STATE && STATE.reviews) || { due: 0, total: 0 };
  const s = (n) => (n === 1 ? "" : "s");
  let text, buttons;
  if (rv.due > 0) {
    text = `${rv.due} fixed gap${s(rv.due)} due for review. Check that what you fixed has stuck.`;
    buttons = `<button class="btn primary" data-action="review">Start review →</button>`;
  } else if (rv.total > 0) {
    text = `${rv.total} fixed gap${s(rv.total)} scheduled. Reviews normally return after 1, 3, 7 and 14 days.`;
    buttons = `<button class="btn" data-action="ff">Demo: jump to tomorrow</button>`;
  } else {
    text = "Nothing scheduled yet. When you fix a gap, it comes back here after 1, 3, 7 and 14 days to check that it stuck.";
    buttons = `<button class="btn" data-action="sample">Load sample progress</button>`;
  }
  return `<div class="review-panel"><div class="rp-title">Daily review</div><div class="rp-text">${text}</div><div class="row">${buttons}</div></div>`;
}

function startCard() {
  return `<div class="start">
    <h1 class="hero-h" id="start-h"></h1>
    <p class="hero-p">Name a concept. Mentora checks every building block under it, then teaches you the missing ones from the bottom up.</p>
    <input id="rc-concept" class="input big" placeholder="e.g. Solving quadratic equations" autocomplete="off">
    <div class="row">
      <select id="rc-level" class="input">${LEVELS.map(l => `<option>${l}</option>`).join("")}</select>
      <button class="btn primary" data-action="start">Diagnose →</button>
    </div>
    <div class="chips">${EXAMPLES.map(x => `<button class="chip" data-example="${esc(x)}">${esc(x)}</button>`).join("")}</div>
    ${reviewPanel()}
  </div>`;
}

function msgHtml(m) {
  if (m.role === "user") return `<div class="m user"><div class="b">${esc(m.text)}</div></div>`;
  let cls = "", head = "", body = md(m.text);
  switch (m.kind) {
    case "question":
      cls = "q";
      head = m.check ? `Check · ${esc(m.node)} · try ${m.attempt} of 3` : `Question ${m.n} of ${m.total} · ${esc(m.node)}`;
      break;
    case "feedback":
      cls = m.ok ? "ok" : (m.idk ? "q" : "bad");
      head = m.ok ? "✓ Correct" : (m.idk ? "No problem · here's the answer" : "✗ Not quite · here's the answer");
      if (!m.ok && m.mis) body = `<p><strong>Misconception:</strong> ${esc(m.mis)}</p>` + body;
      break;
    case "report": cls = "report"; head = "Root-Cause Report" + (m.model ? " · " + esc(m.model) : ""); break;
    case "plan": cls = "plan"; head = "Your learning path"; break;
    case "lesson":
      cls = "lesson";
      head = "Lesson" + (m.step ? ` · step ${m.step} of ${m.total}` : "") + ` · ${esc(m.node)}` + (m.retry ? " · another way" : "");
      break;
    case "note": cls = "note"; break;
    case "result": cls = "result " + (m.tone || "ok"); head = "Result"; break;
    default: break;
  }
  return `<div class="m"><div class="b ${cls}">${head ? `<div class="btag">${head}</div>` : ""}${body}</div></div>`;
}

function renderSteps(v) {
  const el = $("#rc-steps"), p = v.progress;
  if (!p || v.stage === "idle") { el.innerHTML = ""; el.style.display = "none"; return; }
  el.style.display = "flex";
  if (p.phase === "scan" || p.phase === "review") {
    const pct = Math.round(100 * p.scan_done / Math.max(p.scan_total, 1));
    const label = p.phase === "review" ? "Daily review" : "Scanning basics";
    el.innerHTML = `<span class="step-label">${label}</span><div class="progress"><div style="width:${pct}%"></div></div><span class="step-label">${p.scan_done}/${p.scan_total}</span>`;
  } else {
    el.innerHTML = `<span class="step-label">Learning path</span>` +
      (p.plan.length
        ? p.plan.map((s, i) => `<span class="sp ${s.status}"><b>${i + 1}</b>${esc(s.node)}</span>`).join("")
        : `<span class="sp done"><b>✓</b>All clear</span>`);
  }
}

function renderThread(v) {
  const box = $("#rc-thread");
  if (!v.thread || !v.thread.length) {
    box.innerHTML = startCard();
    const h = $("#start-h");
    if (h) scr(h, "What are you stuck on?", { duration: 900, lead: 150 });
    return;
  }
  box.innerHTML = v.thread.map(msgHtml).join("");
  typeset(box);
  box.scrollTop = box.scrollHeight;
}

function renderComposer(v) {
  const c = $("#rc-composer");
  if (v.viewing) {
    c.innerHTML = `<div class="banner">You're viewing a past session${v.date ? " · " + esc(v.date) : ""}.</div>
      <div class="row"><button class="btn" data-action="back">← Back to current</button>
      ${v.resumable ? `<button class="btn primary" data-action="resume" data-id="${esc(v.session_id)}">Continue this session</button>` : ""}</div>`;
    return;
  }
  const s = v.stage;
  if (s === "scan" || s === "check" || s === "review") {
    c.innerHTML = `<textarea id="rc-answer" class="input" rows="2" placeholder="Type your answer... (write powers like x^2)"></textarea>
      <div class="row between"><span class="hint">Ctrl+Enter to send</span>
      <div class="row" style="margin:0"><button class="btn ghost" data-action="idk">I don't know</button><button class="btn primary" data-action="submit">Send</button></div></div>`;
    const ta = $("#rc-answer"); if (ta) ta.focus();
  } else if (s === "lesson") {
    c.innerHTML = `<div class="row" style="margin:0"><button class="btn ghost" data-action="reteach">↻ Explain differently</button>
      <button class="btn primary" data-action="ready" style="flex:1">I'm ready, test me ▶</button></div>`;
  } else if (s === "done") {
    c.innerHTML = `<div class="row" style="margin:0"><button class="btn primary" style="flex:1" data-action="again">Back to start</button></div>`;
  } else {
    c.innerHTML = "";
  }
}

function renderRC(v) {
  CUR = v;
  const hasMap = !!(v.graph && v.stage !== "idle");
  $("#rc").classList.toggle("has-map", hasMap);
  if ($("#page-root").classList.contains("active")) {
    $("#page-sub").textContent = (v.root && v.stage !== "idle") ? "Diagnosing · " + v.root : SUBS.root;
  }
  renderSteps(v); renderThread(v); renderComposer(v);
  renderGraph(hasMap ? v.graph : null);
  const f = fx();
  if (f && f.setMode) f.setMode(v.stage === "idle" || v.viewing ? "idle" : "work");
  if (v.outcome === "fixed" && !v.viewing && !celebrated) { celebrated = true; confetti(); }
}

function showThinking(label, userText) {
  const box = $("#rc-thread");
  if (userText !== undefined) {
    box.insertAdjacentHTML("beforeend", `<div class="m user"><div class="b">${esc(userText)}</div></div>`);
  }
  box.insertAdjacentHTML("beforeend",
    `<div class="m"><div class="b note"><span class="dots"><i></i><i></i><i></i></span>${esc(label)}</div></div>`);
  box.scrollTop = box.scrollHeight;
}

async function run(label, fn, opts = {}) {
  if (busy) return;
  busy = true;
  const saved = $("#rc-answer") ? $("#rc-answer").value : "";
  const card = $(".rc-chat");
  card.classList.add("loading");
  if (opts.btn) opts.btn.innerHTML = `<span class="spin"></span>${esc(label)}`;
  $$("#page-root button, #page-root textarea, #page-root input, #page-root select").forEach(x => { x.disabled = true; });
  if (opts.thinking) showThinking(label, opts.userText);
  try {
    renderRC(await fn());
  } catch (err) {
    toast(friendly(err));
    if (CUR) {
      renderRC(CUR);
      const ta = $("#rc-answer"); if (ta && saved) ta.value = saved;
    }
  } finally {
    busy = false;
    card.classList.remove("loading");
    $$("#page-root button, #page-root textarea, #page-root input, #page-root select").forEach(x => { x.disabled = false; });
  }
}

function wireRC() {
  const root = $("#page-root");

  root.addEventListener("click", async (e) => {
    const ex = e.target.closest("[data-example]");
    if (ex) { const i = $("#rc-concept"); if (i) i.value = ex.dataset.example; return; }
    const b = e.target.closest("[data-action]");
    if (!b || busy) return;
    const a = b.dataset.action;

    if (a === "start") {
      const concept = ($("#rc-concept").value || "").trim();
      if (!concept) { toast("Please type a concept first."); return; }
      const level = $("#rc-level").value;
      celebrated = false;
      await run("Mapping...", () => call("/api/rc/start", { concept, level }), { btn: b });
    } else if (a === "submit" || a === "idk") {
      const ta = $("#rc-answer");
      const text = a === "idk" ? "I don't know" : (ta ? ta.value : "");
      if (!text.trim()) { toast("Type your answer, or press \"I don't know\"."); return; }
      await run("Mentora is checking your answer...", () => call("/api/rc/submit", { answer: text }),
        { thinking: true, userText: text });
    } else if (a === "ready") {
      await run("Writing a question...", () => call("/api/rc/next", { action: "ready" }), { thinking: true });
    } else if (a === "reteach") {
      await run("Finding another way to explain it...", () => call("/api/rc/next", { action: "reteach" }), { thinking: true });
    } else if (a === "again") {
      celebrated = false;
      await run("Resetting...", () => call("/api/rc/reset"));
    } else if (a === "review") {
      celebrated = false;
      await run("Preparing your review...", () => call("/api/rc/review/start"), { btn: b });
    } else if (a === "sample") {
      await run("Loading sample...", () => call("/api/rc/sample"), { btn: b });
    } else if (a === "ff") {
      await run("Jumping to tomorrow...", () => call("/api/rc/review/ff"), { btn: b });
    } else if (a === "back") {
      await run("Going back...", () => call("/api/boot"));
    } else if (a === "resume") {
      await run("Resuming...", () => call("/api/rc/resume", { sid: b.dataset.id }));
    }
  });

  root.addEventListener("keydown", (e) => {
    if (e.target.id === "rc-answer" && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
      const b = $('[data-action="submit"]', root); if (b) b.click();
    }
    if (e.target.id === "rc-concept" && e.key === "Enter") {
      const b = $('[data-action="start"]', root); if (b) b.click();
    }
  });

  $("#new-btn").addEventListener("click", async () => {
    if (busy) return;
    showPage("root"); celebrated = false;
    await run("Resetting...", () => call("/api/rc/reset"));
  });

  $("#recent").addEventListener("click", async (e) => {
    const b = e.target.closest(".rec");
    if (!b || busy) return;
    showPage("root");
    await run("Opening...", () => call("/api/rc/session", { sid: b.dataset.id }));
  });
}

/* ---------- chat page ---------- */
function addBubble(role, text) {
  const log = $("#chat-log");
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  wrap.innerHTML = `<div class="bubble"><div class="body"></div><div class="meta"></div></div>`;
  $(".body", wrap).innerHTML = role === "user" ? `<p>${esc(text)}</p>` : md(text);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}

async function sendChat(text) {
  text = text.trim();
  if (chatBusy || !text) return;
  chatBusy = true;
  $("#chat-chips").style.display = "none";
  $("#chat-input").value = "";
  $("#chat-input").style.height = "auto";
  chat.push({ role: "user", content: text });
  addBubble("user", text);
  const bubble = addBubble("assistant", "");
  bubble.classList.add("typing");
  const t0 = performance.now();
  let full = "";
  try {
    const res = await post("/api/chat", { state: slimState(), messages: chat });
    if (!res.body) throw new Error("The AI is unavailable right now.");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += dec.decode(value, { stream: true });
      $(".body", bubble).innerHTML = md(full);
      $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
    }
    typeset($(".body", bubble));
    chat.push({ role: "assistant", content: full });
    $(".meta", bubble).textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s · ${STATE ? STATE.model : "Nemotron"} on Nebius`;
  } catch (err) {
    $(".body", bubble).innerHTML = `<p class="err">${esc(friendly(err))}</p>`;
    chat.pop();
  } finally {
    bubble.classList.remove("typing");
    chatBusy = false;
  }
}

function wireChat() {
  const chips = ["What should I revise today?", "Explain photosynthesis simply", "Give me a tip to remember formulas", "Explain my open misconceptions"];
  $("#chat-chips").innerHTML = chips.map(c => `<button class="chip">${esc(c)}</button>`).join("");
  $("#chat-chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (b) sendChat(b.textContent);
  });
  const input = $("#chat-input");
  $("#chat-send").addEventListener("click", () => sendChat(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(input.value); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
}

/* ---------- brain + privacy actions ---------- */
function wireSettings() {
  $("#exam-save").addEventListener("click", async () => {
    const subject = $("#exam-subject").value.trim(), when = $("#exam-date").value;
    if (!subject || !when) { toast("Add a subject and a date."); return; }
    try { await call("/api/exam", { subject, when }); toast("Exam saved."); }
    catch (e) { toast(friendly(e)); }
  });

  $("#note-add").addEventListener("click", async () => {
    const note = $("#note-input").value.trim();
    if (!note) return;
    try {
      await call("/api/note", { note });
      $("#note-input").value = "";
      loadMemory();
    } catch (e) { toast(friendly(e)); }
  });

  $("#export-btn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(LOCAL, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "mentora_data.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $("#del-confirm").addEventListener("change", (e) => { $("#del-btn").disabled = !e.target.checked; });
  $("#del-btn").addEventListener("click", async () => {
    try {
      const v = await call("/api/delete");
      chat.length = 0;
      $("#chat-log").innerHTML = "";
      $("#chat-chips").style.display = "flex";
      celebrated = false;
      renderRC(v);
      loadMemory();
      $("#del-confirm").checked = false;
      $("#del-btn").disabled = true;
      toast("All data erased.");
    } catch (e) { toast(friendly(e)); }
  });
}

/* ---------- start ---------- */
async function init() {
  $$(".nav button").forEach(b => b.addEventListener("click", () => showPage(b.dataset.page)));
  wireRC(); wireChat(); wireSettings();
  window.addEventListener("load", () => { typeset($("#rc-thread")); });
  try {
    renderRC(await call("/api/boot"));
  } catch (e) {
    toast(friendly(e));
    renderRC({ stage: "idle", thread: [], graph: null, progress: null, viewing: false });
  }
}
init();
})();