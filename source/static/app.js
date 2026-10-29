/* Paper Reader - front end.
 * PDF rendering: pdf.js 3.11. Export: pdf-lib + fontkit. No build step.
 * Annotation coordinates are stored as fractions of the page box so they survive zoom.
 */
pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);

const FONTS = [
  { name: "Caveat", file: "Caveat.ttf", scale: 1.3 },
  { name: "Patrick Hand", file: "PatrickHand.ttf", scale: 1.1 },
  { name: "Kalam", file: "Kalam.ttf", scale: 1.0 },
  { name: "Nanum Pen Script", file: "NanumPenScript.ttf", scale: 1.4, note: "supports Korean" },
  { name: "Gaegu", file: "Gaegu.ttf", scale: 1.15, note: "supports Korean" },
];
const HL_COLORS = ["#ffe066", "#a9e8a0", "#ffb8cc", "#a8d5ff"];
// what each highlight colour means (editable in Settings)
const HL_DEFAULT_LABELS = ["Key point", "Method", "Question / doubt", "Follow up"];
const hlLabels = () => { const l = store.get("hlLabels", HL_DEFAULT_LABELS); return HL_COLORS.map((_, i) => (l[i] || HL_DEFAULT_LABELS[i]).trim() || HL_DEFAULT_LABELS[i]); };
const hlLabel = (color) => hlLabels()[HL_COLORS.indexOf(color)] || "Highlight";
const PEN_COLORS = ["#2c56a6", "#d6336c", "#23303f", "#2b8a3e"];

const store = {
  get(k, d) { try { const v = localStorage.getItem("pr." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pr." + k, JSON.stringify(v)); } catch {} },
};

const state = {
  paper: null, pdf: null, pdfBytes: null, pages: [], scale: 1, renderGen: 0,
  annots: [], undo: [], analysis: null, qa: [], tab: "summary",
  mode: "select", hlColor: HL_COLORS[0], penColor: PEN_COLORS[0],
  font: store.get("font", "Caveat"), lang: store.get("lang", "English"),
  pendingSel: null, activeHl: null, glossMatcher: null,
};
const analyzing = new Map(); // paperId -> Promise, so leaving the reader doesn't cancel or duplicate a run

// ======================= API =======================
async function api(path, opts = {}) {
  // every request to our own server carries this header; the server refuses changes without it (see server.py _guard)
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), "X-Paper-Reader": "1" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const postJSON = (path, body, method = "POST") =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

// ======================= Library =======================
async function refreshHealth() {
  try {
    const h = await api("/api/health");
    state.hasKey = h.has_key;
    state.engine = h.engine;          // "api" | "claude-code" | "manual"
    state.cc = h.claude_code;
    renderEngine();
    $("#keyBanner").classList.toggle("hidden", h.engine !== "manual");
    $("#keyStatus").textContent = h.has_key ? "✓ saved" : "(not set)";
    $("#versionLabel").textContent = "v" + h.version;
    return h;
  } catch { return null; }
}

async function showLibrary() {
  refreshHealth();
  Features.loadTerms();
  state.paper = null;
  $("#reader").classList.add("hidden");
  $("#library").classList.remove("hidden");
  Features.renderLibrary(await api("/api/papers"));
}

async function uploadFile(file) {
  if (!file || !/\.pdf$/i.test(file.name)) return toast("Please choose a PDF.");
  const fd = new FormData(); fd.append("file", file);
  toast("Uploading…");
  try { openPaper(await api("/api/papers", { method: "POST", body: fd })); }
  catch (e) { toast(e.message); }
}

// ======================= Reader: open & render =======================
async function openPaper(p) {
  state.paper = p; state.annots = []; state.undo = []; state.qa = []; state.analysis = null; state.extract = null;
  state.glossMatcher = null; state.analysisError = null; state.findQ = "";
  $("#library").classList.add("hidden");
  $("#reader").classList.remove("hidden");
  $("#paperTitle").textContent = p.title;
  setMode("select");
  selectTab("summary");

  const [bytes, annots, analysis] = await Promise.all([
    fetch(`/api/papers/${p.id}/pdf`).then((r) => r.arrayBuffer()),
    api(`/api/papers/${p.id}/notes`),
    api(`/api/papers/${p.id}/analysis`),
  ]);
  if (state.paper !== p) return;
  state.pdfBytes = bytes.slice(0);
  state.annots = annots;
  setAnalysis(analysis);
  // resume a background run, or start one automatically (never from the style-gallery previews)
  const st = await api(`/api/papers/${p.id}/analysis/status`).catch(() => ({}));
  if (st.state === "running") runAnalysis();
  else if (!analysis && state.engine && state.engine !== "manual" && !PR_PREVIEW) runAnalysis();

  try {
    state.pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (e) {
    console.error(e);
    $("#viewer").innerHTML = `<div class="empty" style="margin-top:15vh"><span class="hand">can't open this PDF</span>
      The file looks damaged or password-protected (${esc(e.message || e.name)}).<br>Try downloading it again, then drop it in.</div>`;
    state.extract = { empty: true, pages: 0, figures: [], abbreviations: [], sentences: [], references: { list: [] } };
    renderTab();
    return;
  }
  if (state.paper !== p) return;
  await buildPages();
  Features.onOpen(p);
  Extract.run(state.pdf)
    .then((x) => { if (state.paper === p) { state.extract = x; refreshGlossary(); Features.onExtract(); renderTab(); } })
    .catch((e) => { console.error(e); if (state.paper === p) { state.extract = { empty: true, pages: state.pdf.numPages, figures: [], abbreviations: [], sentences: [] }; renderTab(); } });
}

async function buildPages() {
  const viewer = $("#viewer");
  viewer.innerHTML = "";
  state.pages = [];
  for (let i = 1; i <= state.pdf.numPages; i++) {
    const page = await state.pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const div = document.createElement("div");
    div.className = "page"; div.dataset.page = i;
    div.innerHTML = `<span class="num">p.${i}</span><canvas></canvas><div class="hl-layer"></div><div class="textLayer"></div>
      <svg class="ink-layer" viewBox="0 0 1 1" preserveAspectRatio="none"></svg><div class="note-layer"></div>`;
    viewer.appendChild(div);
    const pg = { i, div, w: vp.width, h: vp.height, rendered: -1 };
    state.pages.push(pg);
    attachPageHandlers(pg);
  }
  state.scale = 0;
  fitWidth();
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) renderPage(state.pages[+e.target.dataset.page - 1]);
}, { root: $("#viewer"), rootMargin: "600px 0px" });

function setScale(s) {
  const anchor = state.scale ? Features.anchor() : null;   // keep the same spot in view when zooming
  state.scale = Math.round(s * 100) / 100;
  state.renderGen++;
  $("#zoomLabel").textContent = Math.round(state.scale * 100) + "%";
  for (const pg of state.pages) {
    pg.div.style.width = pg.w * state.scale + "px";
    pg.div.style.height = pg.h * state.scale + "px";
    pg.div.style.setProperty("--scale-factor", state.scale);
    pg.div.style.setProperty("--zoom", state.scale);
    drawAnnots(pg);
    observer.unobserve(pg.div); observer.observe(pg.div);
  }
  Features.restore(anchor);
}

async function renderPage(pg) {
  const gen = state.renderGen;
  if (!pg || pg.rendered === gen) return;
  pg.rendered = gen;
  const page = await state.pdf.getPage(pg.i);
  const vp = page.getViewport({ scale: state.scale });
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
  if (gen !== state.renderGen) return;
  $("canvas", pg.div).replaceWith(canvas);

  const textDiv = $(".textLayer", pg.div);
  const fresh = document.createElement("div"); fresh.className = "textLayer";
  await pdfjsLib.renderTextLayer({ textContentSource: await page.getTextContent(), container: fresh, viewport: vp }).promise;
  if (gen !== state.renderGen) return;
  textDiv.replaceWith(fresh);
  decorateGlossary(fresh);
  Features.afterTextLayer(pg, fresh);
}

// ======================= Annotations: drawing =======================
function drawAnnots(pg) {
  const hl = $(".hl-layer", pg.div), ink = $(".ink-layer", pg.div), notes = $(".note-layer", pg.div);
  hl.innerHTML = ""; ink.innerHTML = ""; notes.innerHTML = "";
  for (const a of state.annots.filter((a) => a.page === pg.i)) {
    if (a.type === "highlight") {
      for (const r of a.rects) {
        const d = document.createElement("div");
        d.className = "hl"; d.dataset.id = a.id;
        Object.assign(d.style, { left: r.x * 100 + "%", top: r.y * 100 + "%", width: r.w * 100 + "%", height: r.h * 100 + "%", background: a.color });
        hl.appendChild(d);
      }
    } else if (a.type === "ink") {
      ink.appendChild(inkPath(a));
    } else if (a.type === "note") {
      notes.appendChild(stickyEl(a, pg));
    }
  }
}

function inkPath(a) {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M" + a.points.map((q) => q.join(" ")).join(" L"));
  p.setAttribute("stroke", a.color);
  p.setAttribute("stroke-width", a.width * state.scale);
  p.setAttribute("vector-effect", "non-scaling-stroke");
  p.style.opacity = a.opacity ?? 1;
  p.dataset.id = a.id;
  return p;
}

function stickyEl(a, pg) {
  const el = document.createElement("div");
  el.className = "sticky"; el.dataset.id = a.id;
  el.style.left = a.x * 100 + "%"; el.style.top = a.y * 100 + "%";
  el.innerHTML = `<div class="grip"></div><button class="x" title="Delete">✕</button><div class="body" contenteditable="true" spellcheck="false"></div>`;
  const body = $(".body", el);
  body.textContent = a.text;
  body.addEventListener("input", () => {
    a.text = body.innerText;
    a.w = el.offsetWidth / pg.div.clientWidth;
    saveSoon();
  });
  body.addEventListener("focus", () => pushUndo());
  $(".x", el).onclick = () => removeAnnot(a.id);
  // drag by grip
  $(".grip", el).addEventListener("pointerdown", (e) => {
    e.preventDefault(); pushUndo();
    const box = pg.div.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, ox = a.x, oy = a.y;
    const move = (ev) => {
      a.x = Math.min(0.97, Math.max(0, ox + (ev.clientX - sx) / box.width));
      a.y = Math.min(0.97, Math.max(0, oy + (ev.clientY - sy) / box.height));
      el.style.left = a.x * 100 + "%"; el.style.top = a.y * 100 + "%";
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); saveSoon(); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });
  return el;
}

function redraw(pageNums) {
  const set = pageNums ? new Set(pageNums) : null;
  for (const pg of state.pages) if (!set || set.has(pg.i)) drawAnnots(pg);
  if (state.tab === "notes") renderTab();
}

// ======================= Annotations: editing =======================
function pushUndo() {
  state.undo.push(JSON.stringify(state.annots));
  if (state.undo.length > 100) state.undo.shift();
}
function undo() {
  if (!state.undo.length) return toast("Nothing to undo");
  state.annots = JSON.parse(state.undo.pop());
  redraw(); saveSoon();
}
function addAnnot(a) { pushUndo(); state.annots.push(a); redraw([a.page]); saveSoon(); return a; }
function removeAnnot(id) {
  const a = state.annots.find((x) => x.id === id);
  if (!a) return;
  pushUndo();
  state.annots = state.annots.filter((x) => x.id !== id);
  redraw([a.page]); saveSoon();
}

let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  const id = state.paper?.id, data = state.annots;
  saveTimer = setTimeout(() => postJSON(`/api/papers/${id}/notes`, data, "PUT").catch((e) => toast("Couldn't save notes: " + e.message)), 500);
}

function pageAt(clientX, clientY) {
  return state.pages.find((pg) => {
    const r = pg.div.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  });
}
function toFrac(pg, clientX, clientY) {
  const r = pg.div.getBoundingClientRect();
  return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
}

/** Turn a DOM selection into per-page, line-merged rectangles (fractions of page size). */
function selectionToRects(range) {
  const byPage = new Map();
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const pg = pageAt(r.left + r.width / 2, r.top + r.height / 2);
    if (!pg) continue;
    const box = pg.div.getBoundingClientRect();
    if (r.height > box.height * 0.08) continue; // whole-layer boxes, not text
    const f = { x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height };
    if (!byPage.has(pg.i)) byPage.set(pg.i, []);
    byPage.get(pg.i).push(f);
  }
  for (const [p, rects] of byPage) {
    rects.sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [];
    for (const r of rects) {
      const m = merged.find((m) => {
        const overlapY = Math.min(m.y + m.h, r.y + r.h) - Math.max(m.y, r.y);
        return overlapY > Math.min(m.h, r.h) * 0.5 && r.x <= m.x + m.w + 0.012 && r.x + r.w >= m.x - 0.012;
      });
      if (m) {
        const x2 = Math.max(m.x + m.w, r.x + r.w), y2 = Math.max(m.y + m.h, r.y + r.h);
        m.x = Math.min(m.x, r.x); m.y = Math.min(m.y, r.y); m.w = x2 - m.x; m.h = y2 - m.y;
      } else merged.push({ ...r });
    }
    byPage.set(p, merged);
  }
  return byPage;
}

function createHighlights(sel, color, comment = "") {
  pushUndo();
  const made = [];
  for (const [page, rects] of sel.byPage) {
    const a = { id: uid(), type: "highlight", page, color, rects, text: sel.text, comment, created: Date.now() };
    state.annots.push(a); made.push(a);
  }
  redraw([...sel.byPage.keys()]); saveSoon();
  return made;
}

function hitHighlight(pg, fx, fy) {
  return state.annots.filter((a) => a.type === "highlight" && a.page === pg.i)
    .reverse().find((a) => a.rects.some((r) => fx >= r.x && fx <= r.x + r.w && fy >= r.y - 0.002 && fy <= r.y + r.h + 0.002));
}

function eraseAt(pg, clientX, clientY) {
  const [fx, fy] = toFrac(pg, clientX, clientY);
  const tol = 8 / pg.div.clientWidth;
  const aspect = pg.h / pg.w;
  const ink = state.annots.filter((a) => a.type === "ink" && a.page === pg.i).reverse()
    .find((a) => a.points.some(([x, y]) => Math.hypot(x - fx, (y - fy) * aspect) < tol + (a.width * state.scale) / 2 / pg.div.clientWidth));
  const target = ink || hitHighlight(pg, fx, fy);
  if (target) removeAnnot(target.id);
}

function attachPageHandlers(pg) {
  const div = pg.div;
  // pen
  const svg = $(".ink-layer", div);
  svg.addEventListener("pointerdown", (e) => {
    if (state.mode !== "pen") return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    const a = { id: uid(), type: "ink", page: pg.i, color: state.penColor, width: 2, points: [toFrac(pg, e.clientX, e.clientY)] };
    const path = inkPath(a); svg.appendChild(path);
    const move = (ev) => {
      a.points.push(toFrac(pg, ev.clientX, ev.clientY).map((v) => Math.round(v * 10000) / 10000));
      path.setAttribute("d", "M" + a.points.map((q) => q.join(" ")).join(" L"));
    };
    const up = () => {
      svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up);
      path.remove();
      if (a.points.length > 1) addAnnot(a);
    };
    svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up);
  });
  // eraser (click or drag)
  div.addEventListener("pointerdown", (e) => {
    if (state.mode !== "eraser") return;
    const sticky = e.target.closest(".sticky");
    if (sticky) return removeAnnot(sticky.dataset.id);
    eraseAt(pg, e.clientX, e.clientY);
    const move = (ev) => { if (ev.buttons) eraseAt(pg, ev.clientX, ev.clientY); };
    const up = () => { div.removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    div.addEventListener("pointermove", move); addEventListener("pointerup", up);
  });
  // sticky notes
  $(".note-layer", div).addEventListener("click", (e) => {
    if (state.mode !== "note" || e.target.closest(".sticky")) return;
    const [x, y] = toFrac(pg, e.clientX, e.clientY);
    const a = addAnnot({ id: uid(), type: "note", page: pg.i, x, y, w: 0.22, text: "", created: Date.now() });
    setMode("select");
    $(`.sticky[data-id="${a.id}"] .body`, div)?.focus();
  });
}

// ======================= Selection & highlight popups =======================
function hidePopups() {
  $("#selPopup").classList.add("hidden");
  $("#hlPopup").classList.add("hidden");
  state.pendingSel = null; state.activeHl = null;
}

function placePopup(el, x, y) {
  el.classList.remove("hidden");
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + "px";
  el.style.top = (y + h + 12 > innerHeight ? y - h - 30 : y + 10) + "px";
}

document.addEventListener("mouseup", (e) => {
  if (state.mode !== "select" || !state.paper || e.target.closest?.(".popup, .sticky, .panel, .toolbar, dialog")) return;
  setTimeout(() => {
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim() && $("#viewer").contains(sel.anchorNode)) {
      const byPage = selectionToRects(sel.getRangeAt(0));
      if (!byPage.size) return;
      $("#hlPopup").classList.add("hidden");
      state.pendingSel = { text: sel.toString().replace(/\s+/g, " ").trim(), byPage };
      placePopup($("#selPopup"), e.clientX, e.clientY);
      return;
    }
    hidePopups();
    const pg = pageAt(e.clientX, e.clientY);
    if (!pg) return;
    const [fx, fy] = toFrac(pg, e.clientX, e.clientY);
    const a = hitHighlight(pg, fx, fy);
    if (a) openHlPopup(a, e.clientX, e.clientY);
  });
});

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest?.(".popup")) $("#hlPopup").classList.add("hidden");
});

function openHlPopup(a, x, y) {
  state.activeHl = a;
  const pop = $("#hlPopup"), ta = $("textarea", pop);
  ta.value = a.comment || "";
  ta.oninput = () => { a.comment = ta.value; saveSoon(); if (state.tab === "notes") renderTab(); };
  ta.onfocus = () => pushUndo();
  const sw = $(".swatches", pop); sw.innerHTML = "";
  for (const c of HL_COLORS) {
    const b = swatch(c, c === a.color, () => {
      pushUndo();
      for (const h of state.annots) if (h.type === "highlight" && h.text === a.text && h.created === a.created) h.color = c;
      redraw(); saveSoon(); openHlPopup(a, x, y);
    });
    sw.appendChild(b);
  }
  placePopup(pop, x, y);
  ta.focus({ preventScroll: true });
}

$("#selPopup").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  const sel = state.pendingSel;
  if (!sel || !act) return;
  if (act === "explain") {
    explain({ selection: sel.text, sel });
  } else if (act === "term") {
    const sentence = state.extract?.sentences?.find((t) => t.text.includes(sel.text))?.text || "";
    Features.saveTerm(sel.text, "", sentence);
  } else if (act === "speak") {
    Features.speak(sel.text);
  } else if (act === "note") {
    const [a] = createHighlights(sel, state.hlColor);
    const r = getSelection().getRangeAt(0).getBoundingClientRect();
    getSelection().removeAllRanges(); hidePopups();
    openHlPopup(a, r.left + r.width / 2, r.bottom);
    $("#hlPopup textarea").focus();
    return;
  }
  getSelection().removeAllRanges(); hidePopups();
});

$("#hlPopup").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act, a = state.activeHl;
  if (!a || !act) return;
  if (act === "delete") {
    pushUndo();
    state.annots = state.annots.filter((h) => !(h.type === "highlight" && h.text === a.text && h.created === a.created));
    redraw(); saveSoon();
  } else if (act === "explain") {
    explain({ selection: a.text, hl: a });
  }
  hidePopups();
});

function swatch(color, active, onclick) {
  const b = document.createElement("button");
  b.className = "swatch" + (active ? " active" : "");
  b.style.background = color; b.title = HL_COLORS.includes(color) ? hlLabel(color) : "Pen colour";
  b.onmousedown = (e) => e.preventDefault(); // keep text selection alive
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

function buildSwatches() {
  const hl = $("#hlColors"); hl.innerHTML = "";
  for (const c of HL_COLORS) hl.appendChild(swatch(c, false, () => {
    state.hlColor = c;
    if (state.pendingSel) createHighlights(state.pendingSel, c);
    getSelection().removeAllRanges(); hidePopups();
  }));
  const pen = $("#penColors"); pen.innerHTML = "";
  for (const c of PEN_COLORS) pen.appendChild(swatch(c, c === state.penColor, () => {
    state.penColor = c; buildSwatches(); if (state.mode !== "pen") setMode("pen");
  }));
}

// ======================= Modes, zoom, shortcuts =======================
function setMode(m) {
  state.mode = m;
  document.body.classList.remove("mode-select", "mode-pen", "mode-note", "mode-eraser");
  document.body.classList.add("mode-" + m);
  $$(".tool").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  hidePopups();
}
$$(".tool").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("#zoomIn").onclick = () => setScale(Math.min(4, state.scale * 1.15));
$("#zoomOut").onclick = () => setScale(Math.max(0.4, state.scale / 1.15));
$("#backBtn").onclick = () => showLibrary();

document.addEventListener("keydown", (e) => {
  if (!state.paper) return;
  const typing = e.target.closest?.("input, textarea, [contenteditable=true]");
  if ((e.metaKey || e.ctrlKey) && e.key === "z" && !typing) { e.preventDefault(); return undo(); }
  if (e.key === "Escape") { hidePopups(); setMode("select"); Features.stopSpeaking(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const m = { v: "select", p: "pen", n: "note", e: "eraser" }[e.key.toLowerCase()];
  if (m) setMode(m);
});

// ======================= Panel divider: drag to resize, pages refit to the width =======================
function fitWidth() {
  if (!state.pages.length) return;
  const maxW = Math.max(...state.pages.map((p) => p.w));
  const s = Math.min(3, Math.max(0.35, ($("#viewer").clientWidth - 90) / maxW));
  if (Math.abs(s - state.scale) > 0.01) setScale(s);
}
(() => {
  const panel = $("#panel");
  panel.style.width = store.get("panelW", 440) + "px";
  let t;
  const fitSoon = (ms) => { clearTimeout(t); t = setTimeout(fitWidth, ms); };
  $("#resizer").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const move = (ev) => {
      const w = Math.max(280, Math.min(innerWidth * 0.75, innerWidth - ev.clientX));
      panel.style.width = w + "px"; store.set("panelW", w);
      fitSoon(90);
    };
    const up = () => {
      document.body.classList.remove("resizing");
      removeEventListener("pointermove", move); removeEventListener("pointerup", up);
      fitSoon(0);
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });
  $("#resizer").addEventListener("dblclick", () => { panel.style.width = "440px"; store.set("panelW", 440); fitSoon(0); });
  addEventListener("resize", () => fitSoon(150));
})();

// ======================= Analysis: built-in guide + AI (API or Claude.ai) =======================
function glossaryItems() {
  const ai = state.analysis?.glossary || [];
  const covered = (abbr) => ai.some((g) => g.term.includes(abbr));
  const abbr = (state.extract?.abbreviations || []).filter((a) => !covered(a.abbr))
    .map((a) => ({ term: a.abbr, definition: a.long, in_this_paper: "", abbr: true, count: a.count }));
  return [...ai, ...abbr];
}

function refreshGlossary() {
  state.glossMatcher = buildGlossMatcher(glossaryItems());
  for (const pg of state.pages) {
    const t = $(".textLayer", pg.div);
    if (!t) continue;
    $$(".gloss", t).forEach((g) => g.replaceWith(g.textContent));
    $$("span", t).forEach((s) => s.normalize());
    delete t.dataset.gloss;
    decorateGlossary(t);
  }
}

function setAnalysis(a) {
  state.analysis = a;
  $("#paperTitle").textContent = a?.title || state.paper?.title || "";
  refreshGlossary();
  renderTab();
}

// Claude Code runs as a background job on the server; poll until it finishes.
async function runViaClaudeCode(p) {
  const job = await postJSON(`/api/papers/${p.id}/analysis/auto`, { language: state.lang });
  const running = analyzing.get(p.id);
  if (running) running.started = job.started * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await api(`/api/papers/${p.id}/analysis/status`);
    if (st.state === "done") return api(`/api/papers/${p.id}/analysis`);
    if (st.state === "error") throw new Error(st.error || "Claude Code failed");
    if (st.state !== "running") throw new Error("The analysis stopped unexpectedly. Try again.");
  }
}

function runAnalysis() {
  const p = state.paper;
  if (analyzing.has(p.id)) return analyzing.get(p.id);
  const started = Date.now();
  const run = state.engine === "claude-code" ? runViaClaudeCode(p) : postJSON(`/api/papers/${p.id}/analysis`, { language: state.lang });
  const job = run
    .then((a) => { if (state.paper?.id === p.id) setAnalysis(a); toast("Analysis ready ✓"); })
    .catch((e) => { if (state.paper?.id === p.id) { state.analysisError = e.message; renderTab(); } toast(e.message, 5000); })
    .finally(() => { analyzing.delete(p.id); if (state.paper?.id === p.id) renderTab(); });
  job.started = started;
  analyzing.set(p.id, job);
  state.analysisError = null;
  renderTab();
  return job;
}

function selectTab(t) {
  state.tab = t;
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  renderTab();
}
$$(".tabs button").forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));

function jumpTo(page, annotId) {
  const pg = state.pages[page - 1];
  if (!pg) return;
  pg.div.scrollIntoView({ behavior: "smooth", block: "start" });
  if (annotId) setTimeout(() => $$(`.hl[data-id="${annotId}"]`).forEach((d) => { d.classList.remove("flash"); void d.offsetWidth; d.classList.add("flash"); }), 350);
}

const figKey = (label) => String(label).toLowerCase().replace(/fig(ure)?s?\.?/, "figure").replace(/[^a-z0-9]/g, "");
const pageBtn = (p) => (p ? `<button class="jump small" data-page="${p}">p.${p} →</button>` : "");
const list = (xs) => (xs?.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
const starBtn = (term, def) => `<button class="chip star" data-saveterm="${esc(term)}" data-def="${esc(def || "")}" title="Save to My terms (for review later)">☆ Save</button>`;
const paras = (s) => String(s || "").split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join("");
const lookups = (term) => `<span class="lookups"><a class="chip" href="dict://${encodeURIComponent(term)}" title="Open in the macOS Dictionary app (offline)">📖 Dictionary</a><button class="chip" data-wiki="${esc(term)}" title="Short definition from Wikipedia (needs internet)">Wikipedia</button></span><div class="wiki-out"></div>`;

function aiCallout() {
  const job = state.paper && analyzing.get(state.paper.id);
  if (job) return `<div class="callout loading"><span class="hand">Claude is reading the paper…</span> <span class="muted small" id="elapsed"></span>
      <div class="muted small">${state.engine === "claude-code" ? "Running in the background through Claude Code. Usually 2–6 minutes; you can keep reading." : "Usually 1–3 minutes."}</div></div>`;
  const auto = state.engine && state.engine !== "manual";
  return `<div class="callout">
      <b>Built-in reading guide</b>, taken straight from the PDF with no AI.
      For plain-language explanations of every figure, method and term, get the AI breakdown.
      <div class="row wrap" style="margin-top:8px">
        ${auto ? `<button class="primary small" data-act="api">✨ Analyze with Claude</button>`
               : `<button class="primary small" data-act="setup">⚡ Set up automatic analysis</button>`}
        <button class="small" data-act="claude">${auto ? "Use Claude.ai instead" : "Do it by hand with Claude.ai"}</button>
      </div>
      ${state.analysisError ? `<p class="small" style="color:var(--danger);margin:6px 0 0">${esc(state.analysisError)}</p>` : ""}
    </div>`;
}

function aiFooter(a) {
  return `<p class="muted small" style="margin-top:20px">AI breakdown from ${esc(a._meta?.model || "Claude")}. AI summaries can be wrong. Check key claims against the paper.
    ${state.engine && state.engine !== "manual" ? `<button class="small" data-act="api">↻ Redo with Claude</button>` : ""}
    <button class="small" data-act="claude">↻ Redo with Claude.ai</button>
    <button class="small" data-act="drop">Show built-in guide instead</button></p>`;
}

let tickTimer;
function renderTab() {
  const body = $("#panelBody");
  clearInterval(tickTimer);
  const a = state.analysis, x = state.extract, t = state.tab;
  if (t === "notes") return renderNotes(body);
  if (t === "ask") return renderAsk(body);
  if (!a && !x) {
    body.innerHTML = `<div class="empty loading"><span class="hand">reading the pages…</span></div>`;
    return;
  }
  if (!a && x?.empty) {
    body.innerHTML = `${aiCallout()}<div class="empty"><span class="hand">no text layer</span>This PDF looks like a scan (no selectable text), so the built-in guide can't read it. Claude.ai can still analyze it.</div>`;
  } else if (t === "summary") {
    body.innerHTML = a ? aiSummary(a) : builtinSummary(x);
  } else if (t === "figures") {
    body.innerHTML = a ? aiFigures(a) : builtinFigures(x);
    fillFigureImages(body);
  } else if (t === "glossary") {
    renderGlossary(body);
  } else if (t === "methods") {
    body.innerHTML = a ? (a.methods || []).map((m) => `<div class="card"><b>${esc(m.technique)}</b>
      <p style="margin:6px 0 4px">${esc(m.plain_explanation)}</p><div class="muted small">Used for: ${esc(m.used_for)}</div></div>`).join("")
      : aiCallout() + (x.methods.length ? x.methods.map((m) => `<div class="card"><div class="row"><b>${esc(m.technique)}</b>${pageBtn(m.page)}</div>
          <p class="method-text" style="margin:6px 0 4px">${esc(m.text.length > 420 ? m.text.slice(0, 420) + "…" : m.text)}</p>
          ${m.text.length > 420 ? `<details><summary class="small muted">read all</summary><p>${esc(m.text)}</p></details>` : ""}
          ${lookups(m.technique)}</div>`).join("")
        : `<div class="empty"><span class="hand">no methods section found</span>Some papers put methods in the supplement.</div>`);
  }
  const job = state.paper && analyzing.get(state.paper.id);
  if (job) { const tick = () => { const el = $("#elapsed"); if (el) el.textContent = Math.round((Date.now() - job.started) / 1000) + "s"; }; tick(); tickTimer = setInterval(tick, 1000); }
}

function aiSummary(a) {
  const x = state.extract;
  return `<h2>${esc(a.title)}</h2>
    <div class="muted small">${esc(a.authors)}${a.journal_year ? " · " + esc(a.journal_year) : ""}</div>
    ${summaryActions()}
    <p class="lede">${esc(a.one_sentence)}</p>
    <h4>Summary</h4>${paras(a.summary)}
    <h4>Background</h4>${paras(a.background)}
    <h4>Research question</h4>${paras(a.research_question)}
    <h4>Approach</h4>${paras(a.approach)}
    <h4>Main findings</h4>${list(a.main_findings)}
    <h4>Why it matters</h4>${paras(a.significance)}
    <h4>Limitations</h4>${list(a.limitations)}
    ${x?.outline?.length ? `<h4>Paper outline</h4>${outlineHtml(x.outline)}` : ""}
    ${Features.relatedSection()}
    ${Features.refsSection()}
    ${aiFooter(a)}`;
}

const summaryActions = () => `<div class="row wrap summary-actions">
    <button class="small" data-act="figview">⤢ Figure viewer</button>
    <button class="small" data-act="cite">❝ Cite</button>
    <button class="small" data-act="notes-md">⇩ Notes (.md)</button>
    <button class="small" data-act="notes-print">⎙ Print notes</button>
    <button class="small" data-act="listen" title="Read the summary aloud">🔊 Listen</button></div>`;

const outlineHtml = (o) => `<div class="outline">${o.map((s) => `<button class="outline-row" data-page="${s.page}"><span>${esc(s.name)}</span><span class="muted small">p.${s.page}</span></button>`).join("")}</div>`;

function builtinSummary(x) {
  const figs = x.figures.filter((f) => f.kind === "Figure" && !f.prefix).length, tabs = x.figures.filter((f) => f.kind === "Table").length;
  return `<h2>${esc(x.title || state.paper.title)}</h2>
    <div class="muted small">${x.pages} pages · ${figs} figure${figs === 1 ? "" : "s"} · ${tabs} table${tabs === 1 ? "" : "s"} · ${x.abbreviations.length} abbreviations</div>
    ${summaryActions()}
    ${aiCallout()}
    ${x.abstract ? `<h4>Abstract</h4>${paras(x.abstract)}` : ""}
    ${x.findings.length ? `<h4>What the authors say they found</h4><ul>${x.findings.map((f) => `<li>${esc(f.text)} <button class="jump small" data-page="${f.page}">p.${f.page}</button></li>`).join("")}</ul>` : ""}
    ${x.outline.length ? `<h4>Paper outline</h4>${outlineHtml(x.outline)}` : ""}
    ${Features.relatedSection()}
    ${Features.refsSection()}`;
}

function figImg(label) {
  const f = state.extract?.figures.find((g) => figKey(g.label) === figKey(label));
  return f?.region ? `<div class="fig-img-wrap"><img class="fig-img" alt="" data-figkey="${esc(figKey(f.label))}"></div>` : "";
}

async function fillFigureImages(body) {
  const paper = state.paper;
  state.crops ??= new Map();
  for (const img of $$("img[data-figkey]", body)) {
    const f = state.extract.figures.find((g) => figKey(g.label) === img.dataset.figkey);
    const key = paper.id + f.label;
    if (!state.crops.has(key)) state.crops.set(key, Extract.crop(state.pdf, f.page, f.region).catch(() => null));
    const url = await state.crops.get(key);
    if (state.paper !== paper) return;
    if (url) { img.src = url; img.onclick = () => Features.openFigure(f.label); } else img.parentElement.remove();
  }
}

function aiFigures(a) {
  return (a.figures || []).map((f) => `<div class="card fig-card">
      <h3><span class="label">${esc(f.label)}</span><span>${esc(f.title)}</span><button class="small view-fig" data-act="figview" data-label="${esc(f.label)}" title="Open in the figure viewer">⤢</button>${pageBtn(f.page)}</h3>
      ${figImg(f.label)}
      <dl>
        <dt>Question</dt><dd>${esc(f.question)}</dd>
        <dt>How the experiment was done</dt><dd>${esc(f.how_it_was_done)}</dd>
        <dt>How to read it</dt><dd>${esc(f.how_to_read)}</dd>
        ${f.panels?.length ? `<dt>Panel by panel</dt><dd>${f.panels.map((p) => `<div class="panel-line"><b>${esc(p.panel)}</b><span>${esc(p.explanation)}</span></div>`).join("")}</dd>` : ""}
        <dt>Key findings</dt><dd>${list(f.key_findings)}</dd>
      </dl>
      <div class="takeaway">→ ${esc(f.takeaway)}</div>
    </div>`).join("") || `<p class="muted">No figures found.</p>`;
}

function builtinFigures(x) {
  if (!x.figures.length) return aiCallout() + `<div class="empty"><span class="hand">no captions found</span>Couldn't find “Figure 1…” style captions in this PDF.</div>`;
  return aiCallout() + x.figures.map((f) => `<div class="card fig-card">
      <h3><span class="label">${esc(f.label)}</span><span>${esc(f.title)}</span><button class="small view-fig" data-act="figview" data-label="${esc(f.label)}" title="Open in the figure viewer">⤢</button>${pageBtn(f.page)}</h3>
      ${figImg(f.label)}
      <dl>
        ${f.panels.length ? `<dt>Panel by panel <span class="muted">(from the caption)</span></dt><dd>${f.panels.map((p) => `<div class="panel-line"><b>${esc(p.panel)}</b><span>${esc(p.explanation)}</span></div>`).join("")}</dd>` : ""}
        ${f.stats.length ? `<dt>Samples & statistics</dt><dd>${list(f.stats)}</dd>` : ""}
        ${f.mentions.length ? `<dt>What the text says about it</dt><dd><ul>${f.mentions.map((m) => `<li>${esc(m.text)} <button class="jump small" data-page="${m.page}">p.${m.page}</button></li>`).join("")}</ul></dd>` : ""}
        <dt>Full caption</dt><dd><details><summary class="small muted">show</summary><p>${esc(f.caption)}</p></details></dd>
      </dl>
    </div>`).join("");
}

function renderGlossary(body) {
  const items = glossaryItems();
  body.innerHTML = `${state.analysis ? "" : aiCallout()}<input class="search" placeholder="Filter ${items.length} terms…" id="gq">
    <div id="gl"></div><p class="muted small">Terms are dotted-underlined in the paper. Hover one for its definition.</p>`;
  const draw = (q = "") => {
    q = q.toLowerCase();
    $("#gl").innerHTML = items.filter((g) => !q || (g.term + g.definition).toLowerCase().includes(q)).map((g) => g.abbr
      ? `<div class="gloss-item"><b>${esc(g.term)}</b> = ${esc(g.definition)} <span class="muted small">· used ${g.count}×</span>${lookups(g.definition)}${starBtn(g.term + " (" + g.definition + ")", g.definition)}</div>`
      : `<div class="gloss-item"><b>${esc(g.term)}</b>: ${esc(g.definition)}${g.in_this_paper ? `<div class="ctx">In this paper: ${esc(g.in_this_paper)}</div>` : ""}${lookups(g.term.replace(/\s*\(.*?\)/g, ""))}${starBtn(g.term, g.definition)}</div>`).join("")
      || `<p class="muted">No terms${q ? " match" : " found"}.</p>`;
  };
  draw(); $("#gq").oninput = (e) => draw(e.target.value);
}

// panel-wide clicks: page jumps, Wikipedia look-ups, AI actions
$("#panelBody").addEventListener("click", async (e) => {
  const el = e.target.closest("[data-page], [data-wiki], [data-act]");
  if (!el || el.closest(".note-item")) return;
  if (el.dataset.page) return jumpTo(+el.dataset.page);
  if (el.dataset.wiki) return wikiLookup(el.dataset.wiki, el.closest(".gloss-item, .card, .qa")?.querySelector(".wiki-out"));
  const act = el.dataset.act;
  if (act === "claude") openClaudeFlow();
  else if (act === "api") { state.analysis = null; runAnalysis(); }
  else if (act === "setup") { refreshHealth(); $("#settings").showModal(); }
  else if (act === "figview") Features.openFigure(el.dataset.label);
  else if (act === "cite") Features.openCite();
  else if (act === "notes-md") Features.exportNotes("md");
  else if (act === "notes-print") Features.exportNotes("print");
  else if (act === "drop" && confirm("Remove the AI breakdown for this paper? (You can import it again later.)")) {
    await api(`/api/papers/${state.paper.id}/analysis`, { method: "DELETE" });
    setAnalysis(null);
  }
});

async function wikiLookup(term, out) {
  if (!out) return;
  out.innerHTML = `<span class="muted small">Looking up “${esc(term)}”…</span>`;
  const lang = { Korean: "ko", Japanese: "ja", Chinese: "zh", Spanish: "es", French: "fr", German: "de" }[state.lang] || "en";
  const find = async (lg) => {
    const s = await fetch(`https://${lg}.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&srprop=&format=json&origin=*&srsearch=${encodeURIComponent(term)}`).then((r) => r.json());
    const title = s.query?.search?.[0]?.title;
    if (!title) return null;
    return fetch(`https://${lg}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`).then((r) => r.json());
  };
  try {
    const sum = (await find(lang)) || (lang !== "en" ? await find("en") : null);
    if (!sum?.extract) throw new Error();
    out.innerHTML = `<div class="wiki"><b>${esc(sum.title)}</b>: ${esc(sum.extract)} <a href="${esc(sum.content_urls?.desktop?.page || "#")}" target="_blank">Wikipedia ↗</a></div>`;
  } catch {
    out.innerHTML = `<span class="muted small">No Wikipedia article found (or no internet connection).</span>`;
  }
}

// ======================= Claude.ai round trip (no API key needed) =======================
function claudePrompt() {
  return `Please read the attached paper and write a structured reading guide for me. I'm a researcher who may not know every technique or term, so explain jargon in plain words. Stay faithful to the paper: don't invent numbers or results, and write "not stated" when the paper doesn't say.

Reply with ONE JSON code block and nothing else (no artifact, no text before or after it), in exactly this shape:

{
  "title": "",
  "authors": "",
  "journal_year": "",
  "one_sentence": "the paper's main point in one sentence",
  "summary": "1-2 short paragraphs a newcomer can follow",
  "background": "what was known before and the gap this paper fills",
  "research_question": "",
  "approach": "",
  "main_findings": ["finding, with numbers where the paper gives them"],
  "significance": "why it matters",
  "limitations": ["caveats the authors state, plus obvious ones"],
  "glossary": [{"term": "", "definition": "plain-language definition", "in_this_paper": "how this paper uses it"}],
  "figures": [{"label": "Figure 1", "page": 1, "title": "", "question": "the question this figure answers", "how_it_was_done": "model system, treatment, measurement, controls, n, statistics", "how_to_read": "axes, colours, symbols", "panels": [{"panel": "A", "explanation": ""}], "key_findings": [""], "takeaway": "one line"}],
  "methods": [{"technique": "", "plain_explanation": "", "used_for": "what it was used for in this paper"}]
}

Guidance: glossary = every specialised term, abbreviation, gene/protein, reagent, assay or statistical method a non-specialist might look up (15-40 entries). figures = one entry per main figure and main table, in order; "page" is the PDF page number where it appears. Write all text in ${state.lang}.`;
}

function openClaudeFlow() {
  const dlg = $("#claudeDlg");
  $("#claudePaste").value = "";
  $("#claudeErr").textContent = "";
  dlg.showModal();
}

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { prompt("Copy this (⌘C):", text); }
}

(() => {
  $("#claudeCopy").onclick = () => copyText(claudePrompt(), "Prompt copied. Paste it in Claude with ⌘V");
  $("#claudeOpen").onclick = () => window.open("https://claude.ai/new", "_blank");
  $("#claudeReveal").onclick = () => api(`/api/papers/${state.paper.id}/reveal`, { method: "POST" }).then(() => toast("The PDF is selected in Finder. Drag it into Claude.")).catch((e) => toast(e.message));
  $("#claudeImport").onclick = async () => {
    const raw = $("#claudePaste").value.trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const txt = fenced ? fenced[1] : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    let data;
    try { data = JSON.parse(txt); } catch { $("#claudeErr").textContent = "Couldn't read that. Copy Claude's whole reply (the copy button under its answer works best) and paste again."; return; }
    try {
      data._meta = { language: state.lang };
      const saved = await postJSON(`/api/papers/${state.paper.id}/analysis`, data, "PUT");
      $("#claudeDlg").close();
      setAnalysis(saved);
      toast("AI breakdown imported ✓");
    } catch (e) { $("#claudeErr").textContent = e.message; }
  };
})();

// ======================= My notes tab =======================
function renderNotes(body) {
  const seen = new Set();
  const all = state.annots.filter((a) => a.type !== "ink")
    .filter((a) => { const k = a.type === "highlight" ? a.text + a.created : a.id; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.page - b.page || (a.rects?.[0]?.y ?? a.y) - (b.rects?.[0]?.y ?? b.y));
  const f = state.notesFilter || "all";
  const count = (c) => all.filter((a) => a.type === "highlight" && a.color === c).length;
  const rows = all.filter((a) => f === "all" || (f === "notes" ? a.type === "note" || a.comment : a.color === f));
  const ink = state.annots.filter((a) => a.type === "ink").length;
  body.innerHTML = `<div class="note-filters">
      <button class="chip ${f === "all" ? "on" : ""}" data-nf="all">All ${all.length}</button>
      ${HL_COLORS.map((c) => `<button class="chip ${f === c ? "on" : ""}" data-nf="${c}"><i class="dot" style="background:${c}"></i>${esc(hlLabel(c))} ${count(c)}</button>`).join("")}
      <button class="chip ${f === "notes" ? "on" : ""}" data-nf="notes">✐ With comments</button>
    </div>
    ${rows.length ? rows.map((a) => a.type === "highlight"
      ? `<div class="note-item" data-page="${a.page}" data-id="${a.id}"><div class="pg">p.${a.page} · ${esc(hlLabel(a.color))}</div>
          <div class="quote" style="border-color:${a.color}">${esc(a.text.length > 280 ? a.text.slice(0, 280) + "…" : a.text)}</div>
          ${a.comment ? `<div class="comment">${esc(a.comment)}</div>` : ""}</div>`
      : `<div class="note-item" data-page="${a.page}"><div class="pg">p.${a.page} · sticky note</div><div class="comment">${esc(a.text) || "<span class='muted'>(empty)</span>"}</div></div>`).join("")
    : `<div class="empty"><span class="hand">${all.length ? "nothing in this filter" : "no notes yet"}</span>Select text to highlight it (each colour has a meaning), or use ✐ Note to stick a note on the page.</div>`}
    ${ink ? `<p class="muted small">+ ${ink} pen stroke${ink > 1 ? "s" : ""}</p>` : ""}`;
  $$("[data-nf]", body).forEach((b) => (b.onclick = () => { state.notesFilter = b.dataset.nf; renderNotes(body); }));
  $$(".note-item", body).forEach((el) => (el.onclick = () => jumpTo(+el.dataset.page, el.dataset.id)));
}

// ======================= Ask / Explain / Search =======================
const canAsk = () => state.engine && state.engine !== "manual";

// Settings → AI engine
function renderEngine() {
  const el = $("#engineBox");
  if (!el) return;
  const c = state.cc || {};
  if (state.engine === "api") el.innerHTML = `<b>✓ Using your API key.</b> Analyses run automatically.`;
  else if (state.engine === "claude-code") el.innerHTML = `<b>✓ Connected to Claude Code</b>, using your Claude subscription. New papers are analyzed automatically, and ✨ Explain answers right here.`;
  else el.innerHTML = `${c.found
      ? `<b>Claude Code is on this Mac but not signed in.</b> Sign in once with your Claude account (a browser page opens), then press Check again.`
      : `<b>Automatic analysis needs Claude Code</b> (free with a Claude Pro/Max plan). The button installs it and then asks you to sign in.`}
    <div class="row wrap" style="margin-top:8px"><button type="button" class="primary small" id="ccLogin">${c.found ? "Sign in to Claude…" : "Install & sign in…"}</button>
    <button type="button" class="small" id="ccCheck">Check again</button></div>`;
  $("#ccLogin")?.addEventListener("click", async () => { await api("/api/claude/login", { method: "POST" }); toast("Finish signing in in the Terminal window and browser, then press Check again.", 6000); });
  $("#ccCheck")?.addEventListener("click", async () => {
    const r = await api("/api/claude/status");
    state.engine = r.engine; state.cc = r.claude_code; renderEngine(); renderTab();
    toast(r.engine === "claude-code" ? "Connected ✓" : "Not signed in yet");
  });
}
async function explain({ selection = "", question = "", sel = null, hl = null }) {
  const item = { selection, question, sel, hl, answer: null, error: null, offline: !state.engine || state.engine === "manual" };
  state.qa.push(item);
  selectTab("ask");
  if (item.offline) return;
  try {
    const r = await postJSON(`/api/papers/${state.paper.id}/explain`, { selection, question, language: state.lang });
    item.answer = r.answer;
  } catch (e) { item.error = e.message; }
  if (state.tab === "ask") renderTab();
}

function askClaudePrompt(q) {
  const title = state.analysis?.title || state.extract?.title || state.paper.title;
  const lang = state.lang === "English" ? "" : ` Answer in ${state.lang}.`;
  if (q.selection && !q.question) return `I'm reading the paper "${title}" (PDF attached if available). Explain this passage in plain language: define any jargon, say what it means in this paper's context, and why it matters. Be concise.${lang}\n\n"${q.selection}"`;
  if (q.selection) return `I'm reading the paper "${title}" (PDF attached if available). About this passage:\n\n"${q.selection}"\n\n${q.question}${lang}`;
  return `I'm reading the paper "${title}" (PDF attached if available). ${q.question}${lang}`;
}

function termsIn(text) {
  const m = state.glossMatcher;
  if (!m || !text) return [];
  const hits = new Map();
  m.re.lastIndex = 0;
  let r;
  while ((r = m.re.exec(text))) { const h = m.alias.get(r[1].toLowerCase()); if (h) hits.set(h.i, m.glossary[h.i]); }
  return [...hits.values()];
}

function searchPaper(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || !state.extract) return [];
  return state.extract.sentences.filter((s) => { const t = s.text.toLowerCase(); return words.every((w) => t.includes(w)); }).slice(0, 40);
}

function renderAsk(body) {
  const qa = state.qa.map((q, i) => {
    const quote = `<div class="q">${q.selection ? "“" + esc(q.selection.length > 300 ? q.selection.slice(0, 300) + "…" : q.selection) + "”" : ""}${q.question ? (q.selection ? "\n" : "") + esc(q.question) : ""}</div>`;
    if (q.offline) {
      const terms = termsIn(q.selection);
      const short = q.selection && q.selection.split(/\s+/).length <= 6 ? q.selection : "";
      return `<div class="qa card">${quote}
        ${terms.length ? `<div class="a">${terms.map((g) => `<div><b>${esc(g.term)}</b>: ${esc(g.definition)}</div>`).join("")}</div>` : ""}
        ${short ? `<div style="margin-top:6px">${lookups(short)}</div>` : ""}
        <div class="row wrap" style="margin-top:8px"><button class="primary small" data-claude="${i}">✨ Ask Claude.ai</button>
        <span class="muted small">copies the question. Paste it in Claude (attach the PDF for best answers)</span></div></div>`;
    }
    return `<div class="qa card">${quote}
      <div class="a">${q.error ? `<span style="color:var(--danger)">${esc(q.error)}</span>` : q.answer ? esc(q.answer) : `<span class="hand loading"><span class="hand">thinking…</span></span>`}</div>
      ${q.answer && (q.sel || q.hl) ? `<div class="row end" style="margin-top:8px"><button class="small" data-save="${i}">📌 Save as comment on highlight</button></div>` : ""}
    </div>`;
  }).join("");
  body.innerHTML = `<input class="search" id="findInput" placeholder="🔍 Search this paper (works offline)…" value="${esc(state.findQ || "")}"><div id="findOut"></div>`
    + (state.qa.length ? qa : `<div class="empty"><span class="hand">ask anything</span>Select text in the paper and hit ✨ Explain, or type a question below.</div>`)
    + `<div class="ask-box"><textarea rows="2" id="askInput" placeholder="${canAsk() ? "Ask about this paper…  (Enter to send)" : "Type a question, then copy it to Claude.ai…"}"></textarea>
       <button class="primary" id="askBtn">${canAsk() ? "Ask" : "Copy for Claude.ai"}</button></div>`;
  const drawFind = () => {
    const q = $("#findInput").value.trim(); state.findQ = q;
    const hits = q ? searchPaper(q) : [];
    $("#findOut").innerHTML = q ? (hits.length ? `<div class="find-hits">${hits.map((h) => `<button class="find-hit" data-page="${h.page}"><span class="muted small">p.${h.page}</span> ${esc(h.text)}</button>`).join("")}</div>` : `<p class="muted small">No sentences contain “${esc(q)}”.</p>`) : "";
  };
  $("#findInput").oninput = drawFind; drawFind();
  const send = () => {
    const v = $("#askInput").value.trim();
    if (!v) return;
    if (canAsk()) return explain({ question: v });
    copyText(askClaudePrompt({ question: v }), "Question copied. Paste it in Claude with ⌘V");
    window.open("https://claude.ai/new", "_blank");
  };
  $("#askBtn").onclick = send;
  $("#askInput").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  $$("[data-claude]", body).forEach((b) => (b.onclick = () => {
    copyText(askClaudePrompt(state.qa[+b.dataset.claude]), "Copied. Paste it in Claude with ⌘V");
    window.open("https://claude.ai/new", "_blank");
  }));
  $$("[data-save]", body).forEach((b) => (b.onclick = () => {
    const q = state.qa[+b.dataset.save];
    if (q.hl) {
      pushUndo();
      q.hl.comment = (q.hl.comment ? q.hl.comment + "\n\n" : "") + q.answer;
      saveSoon();
    } else {
      [q.hl] = createHighlights(q.sel, state.hlColor, q.answer);
    }
    toast("Saved to My notes"); renderTab();
  }));
  if (state.qa.length) body.scrollTop = body.scrollHeight;
}

// ======================= Glossary underlines in the paper =======================
function buildGlossMatcher(glossary) {
  const alias = new Map();
  glossary.forEach((g, i) => {
    const main = g.term.replace(/\s*\(.*?\)\s*/g, " ").trim();
    const inParens = [...g.term.matchAll(/\(([^)]{2,40})\)/g)].map((m) => m[1].trim());
    for (const t of [main, ...inParens]) if (t.length >= 2 && !alias.has(t.toLowerCase())) alias.set(t.toLowerCase(), { i, t });
  });
  if (!alias.size) return null;
  const terms = [...alias.values()].map((v) => v.t).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return { re, alias, glossary };
}

function decorateGlossary(textDiv) {
  const m = state.glossMatcher;
  if (!m || textDiv.dataset.gloss) return;
  textDiv.dataset.gloss = "1";
  for (const span of textDiv.querySelectorAll("span")) {
    if (span.childNodes.length !== 1 || span.firstChild.nodeType !== 3) continue;
    const text = span.textContent;
    m.re.lastIndex = 0;
    let last = 0, match, frag = null;
    while ((match = m.re.exec(text))) {
      const hit = m.alias.get(match[1].toLowerCase());
      // short all-caps abbreviations must match case exactly (e.g. "ER" but not "er")
      if (!hit || (hit.t.length <= 4 && /[A-Z]/.test(hit.t) && hit.t !== match[1])) continue;
      frag ??= document.createDocumentFragment();
      frag.append(text.slice(last, match.index));
      const g = document.createElement("span");
      g.className = "gloss"; g.dataset.g = hit.i; g.textContent = match[1];
      frag.append(g);
      last = match.index + match[1].length;
    }
    if (frag) { frag.append(text.slice(last)); span.replaceChildren(frag); }
  }
}

document.addEventListener("mouseover", (e) => {
  const g = e.target.closest?.(".gloss");
  const tip = $("#glossTip");
  if (!g || document.body.classList.contains("no-gloss") || !state.glossMatcher) return tip.classList.add("hidden");
  const item = state.glossMatcher.glossary[+g.dataset.g];
  tip.innerHTML = `<b>${esc(item.term)}</b>: ${esc(item.definition)}`;
  tip.classList.remove("hidden");
  const r = g.getBoundingClientRect();
  tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left)) + "px";
  tip.style.top = (r.bottom + tip.offsetHeight + 8 > innerHeight ? r.top - tip.offsetHeight - 6 : r.bottom + 6) + "px";
});

// ======================= Settings =======================
function applyFont() {
  const f = FONTS.find((x) => x.name === state.font) || FONTS[0];
  document.documentElement.style.setProperty("--hand", `"${f.name}"`);
  document.documentElement.style.setProperty("--hand-scale", f.scale);
}
(() => {
  const fs = $("#fontSelect");
  fs.innerHTML = FONTS.map((f) => `<option ${f.name === state.font ? "selected" : ""}>${f.name}</option>`).join("");
  fs.onchange = () => { state.font = fs.value; store.set("font", fs.value); applyFont(); };
  $("#langSelect").value = state.lang;
  $("#langSelect").onchange = (e) => { state.lang = e.target.value; store.set("lang", state.lang); };
  const handAll = $("#handAll");
  handAll.checked = store.get("handAll", false);
  const glu = $("#glossUnderline");
  glu.checked = store.get("glossUnderline", true);
  const sync = () => {
    document.body.classList.toggle("hand-all", handAll.checked); store.set("handAll", handAll.checked);
    document.body.classList.toggle("no-gloss", !glu.checked); store.set("glossUnderline", glu.checked);
  };
  handAll.onchange = glu.onchange = sync; sync();
  const hlBox = $("#hlLabels");
  hlBox.innerHTML = HL_COLORS.map((c, i) => `<div class="row"><i class="dot" style="background:${c}"></i><input data-hl="${i}" value="${esc(hlLabels()[i])}" maxlength="30"></div>`).join("");
  hlBox.addEventListener("input", (e) => {
    const l = hlLabels(); l[+e.target.dataset.hl] = e.target.value; store.set("hlLabels", l);
    buildSwatches(); if (state.tab === "notes") renderTab();
  });
  const ts = $("#themeSelect");
  ts.innerHTML = PR_THEMES.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
  ts.value = document.documentElement.dataset.style;
  ts.onchange = () => {   // the style (store key "theme" for older libraries); picking a dark style also picks the dark theme
    document.documentElement.dataset.style = ts.value; store.set("theme", ts.value);
    if (/^(dark|deco)$/.test(ts.value)) ThemeSwitch.set("dark");
  };
  addEventListener("themechange", (e) => {   // the dark styles have no light version
    if (e.detail === "light" && /^(dark|deco)$/.test(document.documentElement.dataset.style)) {
      document.documentElement.dataset.style = "notebook"; store.set("theme", "notebook"); ts.value = "notebook";
    }
  });
  $("#settingsBtn").onclick = $("#libSettingsBtn").onclick = $("#keyBannerBtn").onclick = () => { refreshHealth(); $("#settings").showModal(); };
  $("#keySave").onclick = async () => {
    try {
      const r = await postJSON("/api/key", { key: $("#keyInput").value });
      $("#keyInput").value = "";
      toast(r.has_key ? "API key saved" : "API key removed");
      refreshHealth();
    } catch (e) { toast(e.message, 4000); }
  };
  $("#quitBtn").onclick = async () => {
    if (!confirm("Quit Paper Reader? Your notes are already saved.")) return;
    await api("/api/quit", { method: "POST" }).catch(() => {});
    document.body.innerHTML = `<div class="empty" style="margin-top:20vh"><span class="hand">Paper Reader has stopped.</span>Open the app again any time. You can close this tab.</div>`;
  };
  applyFont();
})();

// ======================= Export annotated PDF =======================
async function exportAnnotatedPdf() {
  const btn = $("#exportBtn");
  btn.disabled = true; btn.textContent = "Exporting…";
  try {
    const { PDFDocument, rgb, BlendMode, LineCapStyle } = PDFLib;
    const doc = await PDFDocument.load(state.pdfBytes.slice(0), { ignoreEncryption: true });
    doc.registerFontkit(fontkit);
    const f = FONTS.find((x) => x.name === state.font) || FONTS[0];
    const font = await doc.embedFont(await fetch(`/static/fonts/${f.file}`).then((r) => r.arrayBuffer()), { subset: false, features: { calt: false, liga: false, clig: false, dlig: false } });
    const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
    const wrap = (text, size, maxW) => {
      const out = [];
      for (const para of String(text).split("\n")) {
        let line = "";
        for (const word of para.split(/(\s+)/)) {
          const next = line + word;
          if (line && font.widthOfTextAtSize(next.trimEnd(), size) > maxW) { out.push(line.trimEnd()); line = word.trimStart(); }
          else line = next;
        }
        out.push(line.trimEnd());
      }
      return out;
    };

    doc.getPages().forEach((page, idx) => {
      const n = idx + 1, box = page.getCropBox(), W = box.width, H = box.height;
      const X = (fx) => box.x + fx * W, Y = (fy) => box.y + H - fy * H;
      for (const a of state.annots.filter((a) => a.page === n)) {
        if (a.type === "highlight") {
          for (const r of a.rects) page.drawRectangle({ x: X(r.x), y: Y(r.y + r.h), width: r.w * W, height: r.h * H, color: hex(a.color), opacity: 0.45, blendMode: BlendMode.Multiply });
        } else if (a.type === "ink") {
          for (let i = 1; i < a.points.length; i++) {
            const [x1, y1] = a.points[i - 1], [x2, y2] = a.points[i];
            page.drawLine({ start: { x: X(x1), y: Y(y1) }, end: { x: X(x2), y: Y(y2) }, thickness: a.width, color: hex(a.color), lineCap: LineCapStyle.Round });
          }
        } else if (a.type === "note" && a.text.trim()) {
          const size = 15 * f.scale * 0.8, pad = 5, maxW = Math.max(80, (a.w || 0.22) * W) - pad * 2;
          const lines = wrap(a.text, size, maxW), lh = size * 1.1;
          const bw = Math.min(maxW, Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)))) + pad * 2;
          const bh = lines.length * lh + pad * 2;
          page.drawRectangle({ x: X(a.x), y: Y(a.y) - bh, width: bw, height: bh, color: hex("#fff6b8"), opacity: 0.95 });
          lines.forEach((l, i) => page.drawText(l, { x: X(a.x) + pad, y: Y(a.y) - pad - (i + 1) * lh + size * 0.25, size, font, color: hex("#23303f") }));
        }
      }
    });

    // Appendix: highlights with their comments, written in your handwriting font.
    const seen = new Set();
    const hls = state.annots.filter((a) => a.type === "highlight" && a.comment?.trim())
      .filter((a) => { const k = a.text + a.created; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.page - b.page);
    if (hls.length) {
      const [pw, ph] = [612, 792], m = 54, maxW = pw - m * 2;
      let page = doc.addPage([pw, ph]), y = ph - m;
      const put = (text, size, color, gap = 1.15) => {
        for (const l of wrap(text, size, maxW)) {
          if (y - size < m) { page = doc.addPage([pw, ph]); y = ph - m; }
          y -= size * gap;
          page.drawText(l, { x: m, y, size, font, color });
        }
      };
      put("My notes: " + (state.analysis?.title || state.paper.title), 26 * f.scale * 0.75, hex("#2c56a6"));
      y -= 10;
      for (const a of hls) {
        put(`p.${a.page}  “${a.text.length > 400 ? a.text.slice(0, 400) + "…" : a.text}”`, 11 * f.scale, hex("#6b7280"));
        put(a.comment, 14 * f.scale, hex("#23303f"));
        y -= 12;
      }
    }

    const out = await doc.save();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([out], { type: "application/pdf" }));
    link.download = (state.paper.filename || "paper.pdf").replace(/\.pdf$/i, "") + " (annotated).pdf";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  } catch (e) {
    console.error(e); toast("Export failed: " + e.message, 5000);
  } finally {
    btn.disabled = false; btn.textContent = "⇩ Export ▾";
  }
}

// ======================= Boot =======================
// ======================= Quit completely when the window is closed =======================
// Check-ins, the live window connection and the closing beacon are in lifecycle-client.js.
// Closing stops a running AI analysis, so ask first.
addEventListener("beforeunload", (e) => {
  if (analyzing.size && !PR_PREVIEW) { e.preventDefault(); e.returnValue = ""; }
});

// runs after every script (features.js) has loaded
window.addEventListener("DOMContentLoaded", () => {
  const dz = $("#dropzone");
  $("#fileInput").onchange = (e) => uploadFile(e.target.files[0]);
  for (const ev of ["dragenter", "dragover"]) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); });
  dz.addEventListener("drop", (e) => uploadFile(e.dataTransfer.files[0]));
  // dropping a PDF anywhere in the reader opens it too
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => { e.preventDefault(); if (!dz.contains(e.target) && e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); });
  buildSwatches();
  setMode("select");
  const want = new URLSearchParams(location.search).get("open");
  if (want) {
    api("/api/papers").then((ps) => { const p = want === "first" ? ps[0] : ps.find((x) => x.id === want); p ? openPaper(p) : showLibrary(); });
    refreshHealth();
  } else showLibrary();
});
