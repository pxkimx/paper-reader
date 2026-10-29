/* Paper Reader — reading helpers layered on app.js:
 * citation pop-ups, find in paper (⌘F), page box + remembered position, figure viewer, reading-notes export,
 * "Cite this paper", the library (search / status / sort / add by DOI), and the shortcut sheet.
 * Uses app.js globals: state, $, $$, esc, api, postJSON, toast, store, jumpTo, figKey, glossaryItems, openPaper.
 */
window.Features = (() => {
  // ---------------- shared: wrap regex matches inside the pdf.js text layer ----------------
  function wrapText(root, re, make) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest(".cite, .find-hit") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let count = 0;
    for (const node of nodes) {
      const text = node.nodeValue;
      re.lastIndex = 0;
      let m, last = 0, frag = null;
      while ((m = re.exec(text))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const el = make(m);
        if (!el) continue;
        frag ??= document.createDocumentFragment();
        frag.append(text.slice(last, m.index));
        el.textContent = m[0];
        frag.append(el);
        last = m.index + m[0].length;
        count++;
      }
      if (frag) { frag.append(text.slice(last)); node.replaceWith(frag); }
    }
    return count;
  }
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ---------------- citations ----------------
  const refs = () => state.extract?.references?.list || [];
  function expandNums(s) {
    const out = [];
    for (const part of s.split(/\s*,\s*/)) {
      const r = part.match(/^(\d+)\s*[–\-]\s*(\d+)$/);
      if (r) { for (let n = +r[1]; n <= +r[2] && out.length < 40; n++) out.push(n); }
      else if (/^\d+$/.test(part)) out.push(+part);
    }
    return out;
  }
  const citeEl = (idxs) => {
    if (!idxs.length) return null;
    const el = document.createElement("span");
    el.className = "cite";
    el.dataset.refs = idxs.join(",");
    return el;
  };
  const pct = (v) => parseFloat(v) / 100;

  function decorateCitations(pg, layer) {
    const list = refs();
    if (!list.length || layer.dataset.cites) return;
    layer.dataset.cites = "1";
    const byN = new Map(list.map((r, i) => [r.n, i]));
    const toIdx = (nums) => nums.map((n) => byN.get(n)).filter((i) => i !== undefined);
    if (state.extract.references.style === "numbered") {
      // [12], [3, 5–8]
      wrapText(layer, /\[(\d{1,3}(?:\s*[,–\-]\s*\d{1,3})*)\]/g, (m) => citeEl(toIdx(expandNums(m[1]))));
      // superscript numbers: small digits right after a word, outside figure areas
      // (skipped when the paper cites with [n] brackets, where small digits are affiliations or footnotes)
      state.extract.bracketCites ??= state.extract.sentences.some((t) => /\[\d{1,3}(?:\s*[,–\-]\s*\d{1,3})*\]/.test(t.text));
      if (state.extract.bracketCites) return;
      const leaves = [...layer.querySelectorAll("span")].filter((s) => !s.children.length && !s.classList.contains("markedContent"));
      const size = (s) => parseFloat((s.style.fontSize.match(/\*\s*([\d.]+)px/) || [])[1] || "0");
      const sizes = leaves.map(size).filter(Boolean).sort((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)] || 0;
      const regions = (state.extract.figures || []).filter((f) => f.page === pg.i && f.region).map((f) => f.region);
      leaves.forEach((s, i) => {
        const t = s.textContent;
        if (!/^\s*\d{1,3}(?:\s*[,–\-]\s*\d{1,3})*\s*$/.test(t) || !(size(s) < median * 0.8)) return;
        const prev = leaves[i - 1]?.textContent || "";
        if (!/[\p{L})\].,;:]\s*$/u.test(prev)) return;
        const x = pct(s.style.left), y = pct(s.style.top);
        if (regions.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) return;
        const el = citeEl(toIdx(expandNums(t.trim())));
        if (el) { el.textContent = t; s.replaceChildren(el); }
      });
    } else if (state.extract.references.style === "author-year") {
      wrapText(layer, /(\p{Lu}[\p{L}'’\-]+)(?:\s+et\s+al\.?|\s+(?:and|&)\s+\p{Lu}[\p{L}'’\-]+)?,?\s+((?:19|20)\d{2}[a-z]?)/gu, (m) => {
        const i = list.findIndex((r) => r.first === m[1] && r.year && r.year === m[2]);
        return i >= 0 ? citeEl([i]) : null;
      });
    }
  }

  const refLinks = (r) => {
    const q = encodeURIComponent(r.text.replace(/\s+/g, " ").slice(0, 220));
    return `<span class="lookups">
      ${r.doi ? `<a class="chip" href="https://doi.org/${esc(r.doi)}" target="_blank">DOI ↗</a>` : ""}
      <a class="chip" href="https://pubmed.ncbi.nlm.nih.gov/?term=${q}" target="_blank">PubMed ↗</a>
      <a class="chip" href="https://scholar.google.com/scholar?q=${q}" target="_blank">Scholar ↗</a>
      ${r.doi ? `<button class="chip" data-addref="${esc(r.doi)}" title="Download the open-access PDF into your library">+ Library</button>` : ""}</span>`;
  };
  const refHtml = (r, full) => `<div class="ref-item"><b>${state.extract.references.style === "numbered" ? r.n + "." : ""}</b> ${esc(full || r.text.length < 260 ? r.text : r.text.slice(0, 260) + "…")}</div>`;

  document.addEventListener("mouseover", (e) => {
    const c = e.target.closest?.(".cite");
    if (!c || !state.extract) return;
    const tip = $("#glossTip");
    const items = c.dataset.refs.split(",").map((i) => refs()[+i]).filter(Boolean);
    tip.innerHTML = items.slice(0, 3).map((r) => refHtml(r)).join("") + (items.length > 3 ? `<div class="muted small">+ ${items.length - 3} more. Click to see all.</div>` : `<div class="small" style="opacity:.7">Click for links</div>`);
    tip.classList.remove("hidden");
    const b = c.getBoundingClientRect();
    tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, b.left)) + "px";
    tip.style.top = (b.bottom + tip.offsetHeight + 8 > innerHeight ? b.top - tip.offsetHeight - 6 : b.bottom + 6) + "px";
  });
  document.addEventListener("click", (e) => {
    const c = e.target.closest?.(".cite");
    const pop = $("#refPopup");
    if (!c) { if (!e.target.closest?.("#refPopup")) pop.classList.add("hidden"); return; }
    if (getSelection().toString()) return;
    const items = c.dataset.refs.split(",").map((i) => refs()[+i]).filter(Boolean);
    pop.innerHTML = items.map((r) => `<div class="ref-block">${refHtml(r, true)}${refLinks(r)}</div>`).join("");
    pop.classList.remove("hidden");
    $("#glossTip").classList.add("hidden");
    const b = c.getBoundingClientRect();
    pop.style.left = Math.min(innerWidth - pop.offsetWidth - 10, Math.max(10, b.left - 40)) + "px";
    pop.style.top = (b.bottom + pop.offsetHeight + 10 > innerHeight ? Math.max(10, b.top - pop.offsetHeight - 8) : b.bottom + 8) + "px";
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest?.("[data-addref]");
    if (!b) return;
    b.disabled = true; b.textContent = "Adding…";
    try { const p = await postJSON("/api/papers/fetch", { query: b.dataset.addref }); b.textContent = "✓ In library"; toast(`Added “${p.title.slice(0, 60)}” to your library`); }
    catch (err) { b.textContent = "+ Library"; b.disabled = false; toast(err.message, 6000); }
  });

  function refsSection() {
    const list = refs();
    if (!list.length) return "";
    return `<details class="refs"><summary><h4 style="display:inline">References (${list.length})</h4></summary>
      <input class="search" placeholder="Filter references…" data-reffilter>
      <div class="ref-list">${list.map((r) => `<div class="ref-block" data-reftext="${esc(r.text.toLowerCase())}">${refHtml(r, true)}${refLinks(r)}</div>`).join("")}</div></details>`;
  }
  document.addEventListener("input", (e) => {
    if (!e.target.matches?.("[data-reffilter]")) return;
    const q = e.target.value.toLowerCase();
    $$(".ref-list .ref-block").forEach((el) => (el.style.display = !q || el.dataset.reftext.includes(q) ? "" : "none"));
  });

  // ---------------- find in paper ----------------
  const find = { q: "", hits: [], i: -1, texts: new Map() };
  async function pageText(n) {
    if (!find.texts.has(n)) find.texts.set(n, state.pdf.getPage(n).then((p) => p.getTextContent()).then((tc) => tc.items.map((it) => it.str + (it.hasEOL ? " " : "")).join("")));
    return find.texts.get(n);
  }
  function openFind() {
    $("#findBar").classList.remove("hidden");
    $("#pdfFind").focus(); $("#pdfFind").select();
  }
  function closeFind() {
    findRun++;
    $("#findBar").classList.add("hidden");
    find.q = ""; find.hits = []; find.i = -1;
    $$(".textLayer .find-hit").forEach((h) => h.replaceWith(h.textContent));
    $$(".textLayer span").forEach((s) => s.normalize());
  }
  let findTimer, findRun = 0;
  async function runFind(q) {
    const run = ++findRun, pdf = state.pdf;       // a newer search, or another paper, cancels this one
    find.q = q.trim(); find.hits = []; find.i = -1;
    $$(".textLayer .find-hit").forEach((h) => h.replaceWith(h.textContent));
    $$(".textLayer span").forEach((s) => s.normalize());
    if (find.q.length < 2 || !state.pdf) { $("#findCount").textContent = ""; return; }
    const re = new RegExp(escRe(find.q), "gi");
    const hits = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const t = await pageText(n);
      if (run !== findRun || state.pdf !== pdf) return;
      const count = (t.match(re) || []).length;
      for (let k = 0; k < count; k++) hits.push({ page: n, k });
    }
    find.hits = hits;
    for (const pg of state.pages) { const l = $(".textLayer", pg.div); if (l) markLayer(pg, l); }
    if (find.hits.length) go(0); else $("#findCount").textContent = "no matches";
  }
  function markLayer(pg, layer) {
    if (!find.q) return;
    const re = new RegExp(escRe(find.q), "gi");
    let k = 0;
    wrapText(layer, re, () => { const el = document.createElement("span"); el.className = "find-hit"; el.dataset.k = k++; return el; });
    const cur = find.hits[find.i];
    if (cur && cur.page === pg.i) {
      $$(".find-hit.current", layer).forEach((h) => h.classList.remove("current"));
      const hits = $$(".find-hit", layer);
      const el = hits[Math.min(cur.k, hits.length - 1)];
      if (el) { el.classList.add("current"); el.scrollIntoView({ block: "center" }); }
    }
  }
  function go(i) {
    if (!find.hits.length) return;
    find.i = (i + find.hits.length) % find.hits.length;
    const h = find.hits[find.i];
    $("#findCount").textContent = `${find.i + 1} / ${find.hits.length}`;
    const pg = state.pages[h.page - 1];
    if (!pg) return;
    $$(".find-hit.current").forEach((x) => x.classList.remove("current"));
    const layer = $(".textLayer", pg.div);
    if (layer && $(".find-hit", layer)) markLayer(pg, layer);
    else pg.div.scrollIntoView({ block: "start" });   // not rendered yet: afterTextLayer marks it
  }
  $("#pdfFind").addEventListener("input", (e) => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind(e.target.value), 250); });
  $("#pdfFind").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (find.q !== e.target.value.trim()) runFind(e.target.value); else go(find.i + (e.shiftKey ? -1 : 1)); }
    if (e.key === "Escape") { e.stopPropagation(); closeFind(); }
  });
  $("#findPrev").onclick = () => go(find.i - 1);
  $("#findNext").onclick = () => go(find.i + 1);
  $("#findClose").onclick = closeFind;
  $("#findBtn").onclick = openFind;

  // ---------------- page box + remembered reading position ----------------
  function currentPos() {
    const v = $("#viewer"), top = v.getBoundingClientRect().top + 60;
    for (const pg of state.pages) {
      const r = pg.div.getBoundingClientRect();
      if (r.bottom > top) return { page: pg.i, frac: Math.max(0, (top - r.top) / r.height) };
    }
    return { page: 1, frac: 0 };
  }
  function scrollToPos(pos) {
    const pg = state.pages[(pos?.page || 1) - 1];
    if (!pg) return;
    const v = $("#viewer");
    v.scrollTop += pg.div.getBoundingClientRect().top - v.getBoundingClientRect().top + (pos.frac || 0) * pg.div.offsetHeight - 60;
  }
  let posTimer;
  $("#viewer").addEventListener("scroll", () => {
    if (!state.paper || !state.pages.length) return;
    const pos = currentPos();
    if (document.activeElement !== $("#pageInput")) $("#pageInput").value = pos.page;
    trackProgress(pos.page);
    clearTimeout(posTimer);
    const id = state.paper.id;
    posTimer = setTimeout(() => store.set("pos." + id, pos), 400);
  });
  $("#pageInput").addEventListener("change", (e) => { const n = Math.max(1, Math.min(state.pages.length, +e.target.value || 1)); jumpTo(n); e.target.blur(); });
  $("#pageInput").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.dispatchEvent(new Event("change")); });

  // ---------------- figure viewer ----------------
  const fv = { list: [], i: 0 };
  function figuresList() {
    const x = state.extract?.figures || [];
    if (state.analysis?.figures?.length) {
      return state.analysis.figures.map((f) => {
        const ex = x.find((g) => figKey(g.label) === figKey(f.label));
        return { ai: f, label: f.label, title: f.title, page: f.page || ex?.page, region: ex?.region, ex };
      });
    }
    return x.map((f) => ({ ex: f, label: f.label, title: f.title, page: f.page, region: f.region }));
  }
  function figText(f) {
    const list = (xs) => (xs?.length ? `<ul>${xs.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "");
    if (f.ai) {
      const a = f.ai;
      return `<dl><dt>Question</dt><dd>${esc(a.question)}</dd><dt>How the experiment was done</dt><dd>${esc(a.how_it_was_done)}</dd>
        <dt>How to read it</dt><dd>${esc(a.how_to_read)}</dd>
        ${a.panels?.length ? `<dt>Panel by panel</dt><dd>${a.panels.map((p) => `<div class="panel-line"><b>${esc(p.panel)}</b><span>${esc(p.explanation)}</span></div>`).join("")}</dd>` : ""}
        <dt>Key findings</dt><dd>${list(a.key_findings)}</dd></dl><div class="takeaway">→ ${esc(a.takeaway)}</div>`;
    }
    const e = f.ex;
    return `<dl>${e.panels.length ? `<dt>Panel by panel</dt><dd>${e.panels.map((p) => `<div class="panel-line"><b>${esc(p.panel)}</b><span>${esc(p.explanation)}</span></div>`).join("")}</dd>` : ""}
      ${e.stats.length ? `<dt>Samples & statistics</dt><dd>${list(e.stats)}</dd>` : ""}
      ${e.mentions.length ? `<dt>What the text says about it</dt><dd>${list(e.mentions.map((m) => m.text + ` (p.${m.page})`))}</dd>` : ""}
      <dt>Caption</dt><dd>${esc(e.caption)}</dd></dl>`;
  }
  let fvToken = 0;
  async function showFigure(i) {
    fv.i = (i + fv.list.length) % fv.list.length;
    const f = fv.list[fv.i], tok = ++fvToken;
    $("#fvTitle").innerHTML = `<b>${esc(f.label)}</b> ${esc(f.title || "")}`;
    $("#fvCount").textContent = `${fv.i + 1} / ${fv.list.length}`;
    $("#fvText").innerHTML = figText(f);
    $("#fvText").scrollTop = 0;
    const img = $("#fvImg");
    img.classList.remove("zoom");
    img.removeAttribute("src");
    $("#fvImgWrap").classList.add("loading");
    const url = f.page ? await Extract.crop(state.pdf, f.page, f.region || { x: 0, y: 0, w: 1, h: 1 }, 3).catch(() => null) : null;
    if (tok !== fvToken) return;
    $("#fvImgWrap").classList.remove("loading");
    if (url) img.src = url;
  }
  function openFigure(label) {
    fv.list = figuresList().filter((f) => f.page);
    if (!fv.list.length) return toast("No figures found in this paper yet.");
    const i = Math.max(0, fv.list.findIndex((f) => figKey(f.label) === figKey(label || "")));
    $("#figViewer").classList.remove("hidden");
    showFigure(i);
  }
  const closeFigure = () => $("#figViewer").classList.add("hidden");
  $("#fvPrev").onclick = () => showFigure(fv.i - 1);
  $("#fvNext").onclick = () => showFigure(fv.i + 1);
  $("#fvClose").onclick = closeFigure;
  $("#fvPage").onclick = () => { const f = fv.list[fv.i]; closeFigure(); jumpTo(f.page); };
  $("#fvImg").onclick = (e) => e.target.classList.toggle("zoom");
  $("#figViewer").addEventListener("click", (e) => { if (e.target.id === "figViewer") closeFigure(); });

  // ---------------- reading notes (Markdown / print) ----------------
  function notesModel() {
    const a = state.analysis, x = state.extract, p = state.paper;
    const S = [];
    if (a) {
      S.push({ h: "In one sentence", paras: [a.one_sentence] });
      S.push({ h: "Summary", paras: a.summary.split(/\n\s*\n/) });
      S.push({ h: "Research question", paras: [a.research_question] });
      S.push({ h: "Key findings", bullets: a.main_findings });
      S.push({ h: "Figures", figs: a.figures.map((f) => ({ label: f.label, title: f.title, takeaway: f.takeaway, bullets: f.key_findings })) });
      S.push({ h: "Why it matters", paras: [a.significance] });
      S.push({ h: "Limitations", bullets: a.limitations });
    } else if (x && !x.empty) {
      if (x.abstract) S.push({ h: "Abstract", paras: x.abstract.split(/\n\s*\n/) });
      if (x.findings.length) S.push({ h: "What the authors say they found", bullets: x.findings.map((f) => `${f.text} (p.${f.page})`) });
      if (x.figures.length) S.push({ h: "Figures", figs: x.figures.map((f) => ({ label: f.label, title: f.title, takeaway: "", bullets: [] })) });
    }
    const seen = new Set();
    const quotes = state.annots.filter((n) => n.type === "highlight").filter((n) => { const k = n.text + n.created; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((m, n) => m.page - n.page).map((n) => ({ page: n.page, quote: n.text, comment: n.comment || "", color: n.color, label: hlLabel(n.color) }));
    const stickies = state.annots.filter((n) => n.type === "note" && n.text.trim()).sort((m, n) => m.page - n.page).map((n) => ({ page: n.page, quote: "", comment: n.text }));
    if (quotes.length || stickies.length) S.push({ h: "My highlights & notes", quotes: [...quotes, ...stickies].sort((m, n) => m.page - n.page) });
    const g = glossaryItems();
    if (g.length) S.push({ h: "Glossary", defs: g.map((t) => ({ term: t.term, def: t.definition })) });
    return { title: a?.title || x?.title || p.title, meta: a ? [a.authors, a.journal_year].filter(Boolean).join(" · ") : p.filename, sections: S };
  }
  function toMarkdown(m) {
    let out = `# ${m.title}\n\n${m.meta ? `_${m.meta}_\n\n` : ""}`;
    for (const s of m.sections) {
      out += `## ${s.h}\n\n`;
      (s.paras || []).forEach((t) => (out += `${t}\n\n`));
      if (s.bullets?.length) out += s.bullets.map((b) => `- ${b}`).join("\n") + "\n\n";
      (s.figs || []).forEach((f) => { out += `### ${f.label}: ${f.title}\n\n${f.takeaway ? `**Takeaway:** ${f.takeaway}\n\n` : ""}${f.bullets.map((b) => `- ${b}`).join("\n")}${f.bullets.length ? "\n\n" : ""}`; });
      (s.quotes || []).forEach((q) => { out += `${q.quote ? `> ${q.quote.replace(/\n/g, " ")}\n> — p.${q.page}${q.label ? ` · ${q.label}` : ""}\n\n` : `**Note (p.${q.page})**\n\n`}${q.comment ? `${q.comment}\n\n` : ""}`; });
      (s.defs || []).forEach((d) => (out += `- **${d.term}**: ${d.def}\n`));
      if (s.defs) out += "\n";
    }
    return out + `---\n_Made with Paper Reader, ${new Date().toLocaleDateString()}_\n`;
  }
  function toHtml(m) {
    const hand = getComputedStyle(document.documentElement).getPropertyValue("--hand").trim() || '"Caveat"';
    const files = { '"Caveat"': "Caveat.ttf", '"Patrick Hand"': "PatrickHand.ttf", '"Kalam"': "Kalam.ttf", '"Nanum Pen Script"': "NanumPenScript.ttf", '"Gaegu"': "Gaegu.ttf" };
    const body = m.sections.map((s) => `<h2>${esc(s.h)}</h2>
      ${(s.paras || []).map((t) => `<p>${esc(t)}</p>`).join("")}
      ${s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
      ${(s.figs || []).map((f) => `<div class="fig"><h3>${esc(f.label)}: ${esc(f.title)}</h3>${f.takeaway ? `<p class="take">→ ${esc(f.takeaway)}</p>` : ""}${f.bullets.length ? `<ul>${f.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}</div>`).join("")}
      ${(s.quotes || []).map((q) => `<div class="q">${q.quote ? `<blockquote style="border-color:${q.color || "#ccc"}">${esc(q.quote)} <span class="pg">p.${q.page}${q.label ? " · " + esc(q.label) : ""}</span></blockquote>` : `<div class="pg">Note · p.${q.page}</div>`}${q.comment ? `<div class="hand">${esc(q.comment)}</div>` : ""}</div>`).join("")}
      ${s.defs ? `<dl>${s.defs.map((d) => `<dt>${esc(d.term)}</dt><dd>${esc(d.def)}</dd>`).join("")}</dl>` : ""}`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.title)}: reading notes</title><style>
      @font-face { font-family: Hand; src: url("${location.origin}/static/fonts/${files[hand] || "Caveat.ttf"}"); }
      body { font: 11pt/1.5 "Iowan Old Style", Georgia, serif; color: #1d1d1f; max-width: 720px; margin: 32px auto; padding: 0 20px; }
      h1 { font-size: 20pt; line-height: 1.25; margin: 0 0 4px; } .meta { color: #666; margin-bottom: 18px; }
      h2 { font: 600 10pt -apple-system, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: #2c56a6; border-bottom: 1px solid #ddd; padding-bottom: 3px; margin-top: 22px; }
      h3 { font-size: 11.5pt; margin: 12px 0 2px; } .take { color: #2c56a6; margin: 2px 0; }
      blockquote { margin: 10px 0 2px; padding: 2px 10px; border-left: 4px solid; color: #444; } .pg { color: #999; font-size: 9pt; }
      .hand { font-family: Hand, cursive; font-size: 15pt; color: #2c56a6; line-height: 1.15; margin: 2px 0 8px 14px; white-space: pre-wrap; }
      dt { font-weight: 700; margin-top: 4px; } dd { margin: 0 0 2px 14px; } .fig, .q { break-inside: avoid; }
      @media print { body { margin: 0 auto; } }</style></head>
      <body><h1>${esc(m.title)}</h1><div class="meta">${esc(m.meta || "")}</div>${body}</body></html>`;
  }
  const fileBase = () => (state.paper.filename || "paper").replace(/\.pdf$/i, "");
  function download(text, name, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function exportNotes(kind) {
    const m = notesModel();
    if (kind === "md") return download(toMarkdown(m), `${fileBase()} (reading notes).md`, "text/markdown");
    const w = window.open("", "_blank");
    if (!w) return toast("Allow pop-ups for this page to print the notes.");
    w.document.write(toHtml(m));
    w.document.close();
    w.document.fonts.ready.then(() => setTimeout(() => w.print(), 200));
  }
  $("#exportBtn").onclick = (e) => {
    e.stopPropagation();
    const menu = $("#exportMenu");
    menu.classList.toggle("hidden");
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.top = r.bottom + 6 + "px";
    menu.style.left = Math.min(innerWidth - menu.offsetWidth - 10, r.right - menu.offsetWidth) + "px";
  };
  document.addEventListener("click", (e) => { if (!e.target.closest?.("#exportMenu, #exportBtn")) $("#exportMenu").classList.add("hidden"); });
  $("#exportMenu").addEventListener("click", (e) => {
    const k = e.target.closest("[data-export]")?.dataset.export;
    if (!k) return;
    $("#exportMenu").classList.add("hidden");
    if (k === "pdf") exportAnnotatedPdf(); else exportNotes(k);
  });

  // ---------------- cite this paper ----------------
  async function openCite() {
    const dlg = $("#citeDlg");
    $("#citeBody").innerHTML = `<p class="muted">Looking up the citation…</p>`;
    dlg.showModal();
    try {
      const c = await api(`/api/papers/${state.paper.id}/cite`);
      const block = (label, key, text, ext) => text ? `<div class="cite-block"><div class="row"><b>${label}</b><span class="grow"></span>
          <button type="button" class="small" data-copy="${key}">Copy</button>${ext ? `<button type="button" class="small" data-dl="${key}" data-ext="${ext}">⇩ .${ext}</button>` : ""}</div>
          <pre>${esc(text)}</pre></div>` : "";
      state.cite = c;
      $("#citeBody").innerHTML = `<p class="small">DOI: <a href="https://doi.org/${esc(c.doi)}" target="_blank">${esc(c.doi)} ↗</a></p>
        ${block("APA", "apa", c.apa)}${block("BibTeX", "bibtex", c.bibtex, "bib")}${block("RIS (EndNote, Zotero, Mendeley)", "ris", c.ris, "ris")}`;
    } catch (e) { $("#citeBody").innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; }
  }
  $("#citeBody").addEventListener("click", (e) => {
    const c = e.target.closest("[data-copy]")?.dataset.copy, d = e.target.closest("[data-dl]");
    if (c) navigator.clipboard.writeText(state.cite[c]).then(() => toast("Copied"));
    if (d) download(state.cite[d.dataset.dl], `${fileBase()}.${d.dataset.ext}`, "text/plain");
  });

  // ---------------- library ----------------
  const lib = { papers: [], q: "", status: store.get("libStatus", "all"), sort: store.get("libSort", "added") };
  const STATUS = { "to-read": "To read", reading: "Reading", done: "Done" };
  function renderLibrary(papers) {
    if (papers) lib.papers = papers;
    const q = lib.q.toLowerCase();
    let ps = lib.papers.filter((p) => (lib.status === "all" || p.status === lib.status)
      && (!q || [p.title, p.filename, p.authors, p.journal_year, p.one_sentence].join(" ").toLowerCase().includes(q)));
    const key = { added: (p) => -p.added, opened: (p) => -(p.opened || 0), title: (p) => p.title.toLowerCase() }[lib.sort];
    ps = ps.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    $$("#libStatus button").forEach((b) => b.classList.toggle("on", b.dataset.s === lib.status));
    $("#libSort").value = lib.sort;
    $("#libCount").textContent = `${ps.length} of ${lib.papers.length} paper${lib.papers.length === 1 ? "" : "s"}`;
    const list = $("#paperList");
    list.innerHTML = ps.length ? "" : `<p class="muted">${lib.papers.length ? "No papers match." : "No papers yet. Drop a PDF above, or paste a DOI."}</p>`;
    for (const p of ps) {
      const card = document.createElement("div");
      card.className = "paper-card";
      const busy = analyzing.has(p.id);
      card.innerHTML = `<button class="ghost del" title="Remove">✕</button>
        <h3>${esc(p.title)}</h3>
        <div class="meta">${esc([p.authors?.split(",").slice(0, 3).join(",") + (p.authors?.split(",").length > 3 ? " et al." : ""), p.journal_year].filter((s) => s && s !== "undefined").join(" · ") || p.filename)}</div>
        ${p.one_sentence ? `<p class="gist">${esc(p.one_sentence)}</p>` : ""}
        <div class="card-foot">
          <select class="status s-${p.status}" title="Reading status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${p.status === k ? "selected" : ""}>${v}</option>`).join("")}</select>
          ${p.analyzed ? `<span class="badge">✨ analyzed</span>` : `<span class="badge pending">${busy ? "analyzing…" : "not analyzed"}</span>`}
          ${p.n_highlights ? `<span class="badge pending" title="highlights">✎ ${p.n_highlights}</span>` : ""}
          ${p.progress ? `<span class="progress" title="Read ${Math.round(p.progress * 100)}%"><i style="width:${Math.round(p.progress * 100)}%"></i></span>` : ""}
          <span class="grow"></span><span class="muted small">${new Date((p.opened || p.added) * 1000).toLocaleDateString()}</span>
        </div>`;
      card.onclick = (e) => { if (!e.target.closest("select, .del")) openPaper(p); };
      $("select", card).onchange = async (e) => { p.status = e.target.value; e.target.className = "status s-" + p.status; await api(`/api/papers/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: p.status }) }); if (lib.status !== "all") renderLibrary(); };
      $(".del", card).onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove “${p.title}” and all its notes?`)) return;
        await api(`/api/papers/${p.id}`, { method: "DELETE" });
        showLibrary();
      };
      list.appendChild(card);
    }
  }
  $("#libSearch").addEventListener("input", (e) => { lib.q = e.target.value; renderLibrary(); });
  $("#libStatus").addEventListener("click", (e) => { const s = e.target.closest("button")?.dataset.s; if (s) { lib.status = s; store.set("libStatus", s); renderLibrary(); } });
  $("#libSort").addEventListener("change", (e) => { lib.sort = e.target.value; store.set("libSort", lib.sort); renderLibrary(); });
  async function fetchPaper() {
    const q = $("#fetchInput").value.trim();
    if (!q) return;
    const btn = $("#fetchBtn");
    btn.disabled = true; btn.textContent = "Finding…";
    try { const p = await postJSON("/api/papers/fetch", { query: q }); $("#fetchInput").value = ""; openPaper(p); }
    catch (e) { toast(e.message, 7000); }
    finally { btn.disabled = false; btn.textContent = "Add"; }
  }
  $("#fetchBtn").onclick = fetchPaper;
  $("#fetchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") fetchPaper(); });

  // ---------------- keyboard ----------------
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable=true]");
    if (!$("#figViewer").classList.contains("hidden")) {
      if (e.key === "ArrowRight") { e.preventDefault(); showFigure(fv.i + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); showFigure(fv.i - 1); }
      else if (e.key === "Escape") { e.stopImmediatePropagation(); closeFigure(); }
      return;
    }
    if (!state.paper || $("#reader").classList.contains("hidden")) { if (e.key === "?" && !typing) $("#helpDlg").showModal(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); openFind(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "?") { e.preventDefault(); $("#helpDlg").showModal(); }
    else if (e.key.toLowerCase() === "f") { e.preventDefault(); openFigure(); }
    else if (e.key === "g") { e.preventDefault(); $("#pageInput").focus(); $("#pageInput").select(); }
  }, true);
  $("#helpBtn").onclick = () => $("#helpDlg").showModal();

  // ---------------- My Terms notebook + flashcards ----------------
  const terms = { list: [], study: null };
  async function loadTerms() { terms.list = await api("/api/terms").catch(() => []); updateTermsBtn(); return terms.list; }
  const dueTerms = () => terms.list.filter((t) => t.due <= Date.now() / 1000);
  function updateTermsBtn() {
    const b = $("#termsBtn");
    if (b) b.innerHTML = `📚 My terms <span class="muted small">${terms.list.length}${dueTerms().length ? ` · <b>${dueTerms().length} to review</b>` : ""}</span>`;
  }
  async function saveTerm(term, definition = "", context = "") {
    term = (term || "").replace(/\s+/g, " ").trim();
    if (!term) return;
    if (term.length > 120) return toast("That's a long selection. Select just the term (a word or short phrase).");
    const g = glossaryItems().find((x) => x.term.toLowerCase() === term.toLowerCase() || x.term.toLowerCase().replace(/\s*\(.*?\)/g, "") === term.toLowerCase());
    try {
      await postJSON("/api/terms", { term, definition: definition || g?.definition || "", context,
        paper_id: state.paper?.id, paper_title: state.analysis?.title || state.paper?.title || "" });
      await loadTerms();
      toast(`☆ Saved “${term}” to My terms`);
    } catch (e) { toast(e.message); }
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-saveterm]");
    if (b) { e.stopPropagation(); saveTerm(b.dataset.saveterm, b.dataset.def || ""); }
  });

  function renderTermsList() {
    const q = ($("#termsSearch").value || "").toLowerCase();
    const list = terms.list.filter((t) => !q || (t.term + " " + t.definition + " " + t.paper_title).toLowerCase().includes(q))
      .sort((a, b) => a.term.localeCompare(b.term));
    const boxName = (b) => ["new", "learning", "learning", "familiar", "familiar", "known"][b] || "new";
    $("#termsList").innerHTML = list.length ? list.map((t) => `<div class="term-row" data-id="${t.id}">
        <div class="row"><b>${esc(t.term)}</b><span class="badge pending">${boxName(t.box)}</span><span class="grow"></span>
          <button class="chip" data-tdel="${t.id}" title="Remove">✕</button></div>
        <div class="term-def" contenteditable="true" data-tdef="${t.id}" title="Click to edit">${esc(t.definition) || "<span class='muted'>(add a definition)</span>"}</div>
        ${t.paper_title ? `<div class="muted small">from ${t.paper_id ? `<a href="#" data-topen="${t.paper_id}">${esc(t.paper_title.slice(0, 90))}</a>` : esc(t.paper_title.slice(0, 90))}</div>` : ""}
      </div>`).join("") : `<div class="empty"><span class="hand">${terms.list.length ? "no match" : "no saved terms yet"}</span>
        Save terms with ☆ in the Glossary tab, or select a word in a paper and press ☆ Term.</div>`;
    $("#termsStudy").textContent = dueTerms().length ? `▶ Study ${dueTerms().length} due` : "▶ Study all";
    $("#termsStudy").disabled = !terms.list.length;
  }
  async function openTerms() {
    await loadTerms();
    $("#termsStudyBox").classList.add("hidden");
    $("#termsListBox").classList.remove("hidden");
    renderTermsList();
    $("#termsDlg").showModal();
  }
  $("#termsSearch").addEventListener("input", renderTermsList);
  $("#termsList").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-tdel]"), op = e.target.closest("[data-topen]");
    if (del) { await api(`/api/terms/${del.dataset.tdel}`, { method: "DELETE" }); await loadTerms(); renderTermsList(); }
    if (op) {
      e.preventDefault();
      const p = (await api("/api/papers")).find((x) => x.id === op.dataset.topen);
      if (p) { $("#termsDlg").close(); openPaper(p); } else toast("That paper is no longer in your library.");
    }
  });
  $("#termsList").addEventListener("focusout", async (e) => {
    const d = e.target.closest?.("[data-tdef]");
    if (!d) return;
    const t = terms.list.find((x) => x.id === d.dataset.tdef);
    const v = d.innerText.trim();
    if (t && v !== t.definition && v !== "(add a definition)") { await postJSON(`/api/terms/${t.id}`, { definition: v }, "PATCH"); t.definition = v; }
  });
  function showCard() {
    const s = terms.study;
    if (!s.queue.length) {
      $("#studyCard").innerHTML = `<div class="empty"><span class="hand">all done!</span>${s.right} of ${s.total} known. Cards you missed will come back sooner.</div>`;
      $("#studyBtns").innerHTML = `<button type="button" class="primary" id="studyBack">Back to list</button>`;
      $("#studyBack").onclick = () => { $("#termsStudyBox").classList.add("hidden"); $("#termsListBox").classList.remove("hidden"); renderTermsList(); };
      return;
    }
    const t = s.queue[0];
    $("#studyProgress").textContent = `${s.total - s.queue.length + 1} / ${s.total}`;
    $("#studyCard").innerHTML = `<div class="study-term">${esc(t.term)}</div><div class="study-def hidden">${esc(t.definition) || "<span class='muted'>(no definition saved)</span>"}
      ${t.paper_title ? `<div class="muted small" style="margin-top:8px">from ${esc(t.paper_title.slice(0, 90))}</div>` : ""}</div>`;
    $("#studyBtns").innerHTML = `<button type="button" class="primary" id="studyShow">Show answer (space)</button>`;
    $("#studyShow").onclick = reveal;
  }
  function reveal() {
    $(".study-def")?.classList.remove("hidden");
    $("#studyBtns").innerHTML = `<button type="button" id="studyNo">✗ Didn't know (1)</button><button type="button" class="primary" id="studyYes">✓ Knew it (2)</button>`;
    $("#studyNo").onclick = () => grade(false);
    $("#studyYes").onclick = () => grade(true);
  }
  async function grade(knew) {
    const s = terms.study, t = s.queue.shift();
    s.right += knew ? 1 : 0;
    await postJSON(`/api/terms/${t.id}`, { knew }, "PATCH").catch(() => {});
    showCard();
  }
  $("#termsStudy").onclick = () => {
    const due = dueTerms();
    const pool = (due.length ? due : [...terms.list]).sort(() => Math.random() - 0.5).slice(0, 20);
    terms.study = { queue: pool, total: pool.length, right: 0 };
    $("#termsListBox").classList.add("hidden");
    $("#termsStudyBox").classList.remove("hidden");
    showCard();
  };
  $("#termsDlg").addEventListener("keydown", (e) => {
    if ($("#termsStudyBox").classList.contains("hidden") || e.target.closest("input, [contenteditable=true]")) return;
    if (e.key === " " && $("#studyShow")) { e.preventDefault(); reveal(); }
    else if (e.key === "1" && $("#studyNo")) grade(false);
    else if (e.key === "2" && $("#studyYes")) grade(true);
  });
  $("#termsBtn").onclick = openTerms;

  // ---------------- related papers + impact ----------------
  const related = new Map();   // paper id -> data | {error} | "loading"
  function relatedSection() {
    const id = state.paper?.id, r = related.get(id);
    if (!id || PR_PREVIEW) return "";   // the gallery's 11 previews would send 11 look-ups at once (rate limit)
    if (!r) { loadRelated(id); return `<div id="relatedBox" class="related"><h4>Impact & related papers</h4><p class="muted small">Looking up…</p></div>`; }
    if (r === "loading") return `<div id="relatedBox" class="related"><h4>Impact & related papers</h4><p class="muted small">Looking up…</p></div>`;
    if (r.error) return `<div id="relatedBox" class="related"><h4>Impact & related papers</h4><p class="muted small">${esc(r.error)} <button class="chip" data-relretry>Retry</button></p></div>`;
    return `<div id="relatedBox" class="related"><h4>Impact & related papers</h4>
      ${r.tldr ? `<p class="tldr"><b>TL;DR</b> ${esc(r.tldr)}</p>` : ""}
      <p class="small">Cited by <b>${r.citations ?? "?"}</b> papers${r.influential ? ` (${r.influential} highly influenced)` : ""} ·
        <a href="${esc(r.s2)}" target="_blank">Semantic Scholar ↗</a>${r.pmid ? ` · <a href="https://pubmed.ncbi.nlm.nih.gov/${esc(r.pmid)}/" target="_blank">PubMed ↗</a>` : ""}</p>
      ${r.similar.length ? `<div class="similar">${r.similar.map((x) => `<div class="sim-row"><div><b>${esc(x.title)}</b>
          <div class="muted small">${[x.venue, x.year, x.citations != null ? x.citations + " citations" : ""].filter(Boolean).map(esc).join(" · ")}</div></div>
          <div class="lookups">${x.doi ? `<a class="chip" href="https://doi.org/${esc(x.doi)}" target="_blank">DOI ↗</a>` : ""}
          ${x.doi || x.arxiv ? `<button class="chip" data-addref="${esc(x.doi || x.arxiv)}" title="${x.oa ? "Free copy available" : "May be paywalled"}">+ Library${x.oa ? "" : "?"}</button>` : ""}</div></div>`).join("")}</div>` : ""}
    </div>`;
  }
  async function loadRelated(id, refresh) {
    related.set(id, "loading");
    try { related.set(id, await api(`/api/papers/${id}/related${refresh ? "?refresh=1" : ""}`)); }
    catch (e) { related.set(id, { error: e.message }); }
    if (state.paper?.id === id && state.tab === "summary") { const box = $("#relatedBox"); if (box) box.outerHTML = relatedSection(); }
  }
  document.addEventListener("click", (e) => { if (e.target.closest?.("[data-relretry]") && state.paper) { loadRelated(state.paper.id, true); $("#relatedBox").outerHTML = relatedSection(); } });

  // ---------------- reading progress ----------------
  let progTimer;
  function trackProgress(page) {
    if (!state.paper || PR_PREVIEW) return;
    const frac = page / Math.max(1, state.pages.length), id = state.paper.id;
    if (frac <= (state.paper.progress || 0)) return;
    state.paper.progress = frac;
    clearTimeout(progTimer);
    progTimer = setTimeout(() => postJSON(`/api/papers/${id}`, { progress: frac }, "PATCH").catch(() => {}), 3000);
  }

  // ---------------- night mode ----------------
  const setNight = (on) => { document.body.classList.toggle("night", on); store.set("night", on); $("#nightBtn").classList.toggle("on", on); };
  $("#nightBtn").onclick = () => setNight(!document.body.classList.contains("night"));
  setNight(store.get("night", false));

  // ---------------- read aloud (macOS voices, offline) ----------------
  function speak(text) {
    if (!("speechSynthesis" in window)) return toast("Read-aloud isn't available in this browser.");
    speechSynthesis.cancel();
    const chunks = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]*\s*/g) || [text];   // short chunks: long utterances stall
    const lang = { Korean: "ko-KR", Japanese: "ja-JP", Chinese: "zh-CN", Spanish: "es-ES", French: "fr-FR", German: "de-DE" }[state.lang] || "en-US";
    chunks.forEach((c, i) => {
      const u = new SpeechSynthesisUtterance(c);
      u.lang = lang; u.rate = store.get("speechRate", 1.05);
      if (i === chunks.length - 1) u.onend = () => $("#speakStop").classList.add("hidden");
      speechSynthesis.speak(u);
    });
    $("#speakStop").classList.remove("hidden");
  }
  const stopSpeaking = () => { speechSynthesis?.cancel(); $("#speakStop").classList.add("hidden"); };
  $("#speakStop").onclick = stopSpeaking;
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("[data-act=listen]")) return;
    const a = state.analysis, x = state.extract;
    speak(a ? [a.one_sentence, a.summary, "Main findings.", ...(a.main_findings || [])].join(" ") : x?.abstract || "Nothing to read yet.");
  });

  // ---------------- backup / restore ----------------
  $("#backupBtn").onclick = () => { location.href = "/api/backup"; };
  $("#restoreInput").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    try { const r = await api("/api/restore", { method: "POST", body: fd }); toast(`Restored. ${r.added} paper${r.added === 1 ? "" : "s"} added (${r.total} total).`, 5000); showLibrary(); }
    catch (err) { toast(err.message, 6000); }
    e.target.value = "";
  };

  // ---------------- hooks called from app.js ----------------
  return {
    onOpen(p) {
      find.texts = new Map();
      if (!$("#findBar").classList.contains("hidden")) closeFind();
      $("#pageCount").textContent = state.pages.length;
      $("#pageInput").value = 1;
      const pos = store.get("pos." + p.id, null);
      if (pos && pos.page > 1 || pos?.frac > 0.05) { scrollToPos(pos); toast(`Back where you left off: page ${pos.page}`); }
      if (!PR_PREVIEW) api(`/api/papers/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ opened: true }) }).catch(() => {});
    },
    onExtract() {
      for (const pg of state.pages) { const l = $(".textLayer", pg.div); if (l) decorateCitations(pg, l); }
    },
    afterTextLayer(pg, layer) {
      if (state.extract) decorateCitations(pg, layer);
      if (find.q) markLayer(pg, layer);
    },
    anchor: () => (state.pages.length ? currentPos() : null),
    restore: (pos) => pos && scrollToPos(pos),
    openFigure, refsSection, openCite, exportNotes, renderLibrary, relatedSection, saveTerm, speak, stopSpeaking, loadTerms,
  };
})();
