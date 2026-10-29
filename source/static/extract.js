/* Built-in reading guide: everything here runs in the browser, offline, with no AI.
 * From pdf.js text (with positions) it recovers: title, abstract, section outline, author-stated findings,
 * figure/table captions (+ the page region holding each figure), sentences that discuss each figure,
 * the methods section, and an abbreviation glossary (Schwartz & Hearst, 2003).
 * All positions are fractions of the page (0-1, origin top-left), like the annotations.
 */
const Extract = (() => {
  const HEADINGS = [
    "abstract", "summary", "introduction", "background", "related work", "results", "results and discussion",
    "discussion", "conclusion", "conclusions", "concluding remarks", "methods", "materials and methods",
    "methods and materials", "material and methods", "experimental procedures", "experimental section",
    "experimental", "star methods", "star★methods", "online methods", "method details", "experiments",
    "limitations", "references", "bibliography",
    "acknowledgements", "acknowledgments", "funding", "author contributions", "competing interests",
    "declaration of interests", "data availability", "code availability", "supplementary information",
    "supplementary material", "supplementary materials", "supporting information", "key resources table",
  ];
  const METHODS_RE = /^(materials? and methods|methods( and materials)?|experimental( procedures| section)?|star.?methods|online methods|method details)$/i;
  const END_RE = /^(references|bibliography|acknowledge?ments|funding|author contributions|competing interests|declaration of interests|supplementary (information|materials?)|supporting information)$/i;
  const CAPTION_RE = /^(supplementary\s+|extended\s+data\s+)?(fig(?:ure)?s?\.?|table)\s*(S?\d+[A-Za-z]?)\s*([.:|—–\-]|\s(?=[A-Z(]))/i;
  const FINDING_RE = /\b(we (show|showed|found|find|demonstrate|demonstrated|reveal|revealed|identify|identified|report|observed|observe|establish|uncover|propose|present)|here,? we|our (results|findings|data|study|work) (show|shows|suggest|suggests|indicate|indicates|reveal|reveals|demonstrate|demonstrates|establish|provide)|these (results|findings|data|observations) (suggest|indicate|show|reveal|demonstrate|support|establish)|in (summary|conclusion)|taken together|together,? (these|our)|this (study|work) (shows|reveals|demonstrates|establishes|provides))\b/i;
  const STATS_RE = /\b(n\s*=|mean|median|s\.?e\.?m\.?|s\.?d\.?\b|±|t-?test|anova|mann|wilcoxon|kruskal|fisher|chi|p\s*[<=>≤]|p-?value|two-?(sided|tailed)|one-?(sided|tailed)|replicates?|independent experiments|error bars?|scale bars?|confidence interval|95%)/i;

  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const headingKey = (t) => norm(t).replace(/^((\d+(\.\d+)*)|[ivxlc]+)[.)]?\s+/i, "").replace(/[.:]$/, "").toLowerCase();

  function splitSentences(text) {
    // keep "Fig. 2", "et al.", "e.g.", "i.e.", "vs." and decimals intact
    const protectedText = text.replace(/\b(Figs?|et al|e\.g|i\.e|vs|approx|Eq|Ref|Refs|no|Nos|cf|ca|Dr|St|Supp|Suppl)\./gi, (m) => m.replace(".", "․"));
    return protectedText.split(/(?<=[.!?])\s+(?=[A-Z(\[])/).map((s) => s.replace(/․/g, ".").trim()).filter((s) => s.length > 20);
  }

  // ---------- 1. text items -> lines -> blocks ----------
  function pageBlocks(items, vp, bodyFont) {
    const lines = [];
    let cur = null;
    for (const it of items) {
      if (!it.str) { if (it.hasEOL && cur) cur.eol = true; continue; }
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      if (Math.abs(tx[1]) > Math.abs(tx[0]) + 0.01) continue; // rotated text (e.g. arXiv side stamp)
      const size = Math.hypot(tx[2], tx[3]);
      if (size < 1) continue;
      const x = tx[4] / vp.width, top = (tx[5] - size) / vp.height, w = (it.width * vp.scale) / vp.width, h = size / vp.height;
      const sameLine = cur && !cur.eol && Math.abs(top - cur.top) < h * 0.6 && x > cur.x1 - 0.02;
      if (sameLine) {
        cur.fonts[it.fontName] = (cur.fonts[it.fontName] || 0) + it.str.length;
        const gap = x - cur.x1;
        if (gap > h * 0.15 * (vp.height / vp.width) && !cur.text.endsWith(" ") && !it.str.startsWith(" ")) cur.text += " ";
        cur.text += it.str; cur.x1 = Math.max(cur.x1, x + w); cur.size = Math.max(cur.size, size);
        cur.bottom = Math.max(cur.bottom, top + h);
      } else {
        cur = { text: it.str, x0: x, x1: x + w, top, bottom: top + h, size, eol: false, fonts: { [it.fontName]: it.str.length } };
        lines.push(cur);
      }
      if (it.hasEOL) cur.eol = true;
    }
    const blocks = [];
    let b = null;
    for (const l of lines) {
      l.text = l.text.replace(/\s+/g, " ").trim();
      if (!l.text) continue;
      l.font = Object.entries(l.fonts).sort((a, c) => c[1] - a[1])[0][0];
      l.alt = l.font !== bodyFont;             // e.g. a bold heading set at body size
      const gap = b ? l.top - b.lastBottom : 0;
      const lineH = l.bottom - l.top;
      const cont = b && Math.abs(l.size - b.size) <= Math.max(0.8, b.size * 0.08) && gap > -lineH * 0.5 && gap < lineH * 1.1
        && l.x0 < b.x1 && l.x1 > b.x0 - 0.02 && l.alt === b.alt;
      if (cont) {
        b.text = b.text.endsWith("-") && /^[a-z]/.test(l.text) ? b.text.slice(0, -1) + l.text : b.text + " " + l.text;
        b.lines++; b.x0 = Math.min(b.x0, l.x0); b.x1 = Math.max(b.x1, l.x1); b.lastBottom = l.bottom; b.bottom = l.bottom;
      } else {
        b = { text: l.text, size: l.size, x0: l.x0, x1: l.x1, top: l.top, bottom: l.bottom, lastBottom: l.bottom, lines: 1, alt: l.alt };
        blocks.push(b);
      }
    }
    return blocks;
  }

  // ---------- 2. abbreviations (Schwartz & Hearst) ----------
  function bestLongForm(sf, lf) {
    const S = sf.toLowerCase(), L = lf.toLowerCase();
    let s = S.length - 1, l = L.length - 1;
    for (; s >= 0; s--) {
      const c = S[s];
      if (!/[a-z0-9]/.test(c)) continue;
      while ((l >= 0 && L[l] !== c) || (s === 0 && l > 0 && /[a-z0-9]/.test(L[l - 1]))) l--;
      if (l < 0) return null;
      l--;
    }
    return lf.slice(lf.lastIndexOf(" ", l) + 1);
  }

  function abbreviations(text) {
    const found = new Map();
    const re = /\(([^()]{2,14})\)/g;
    let m;
    while ((m = re.exec(text))) {
      const sf = m[1].split(/[;,]/)[0].trim();
      if (sf.length < 2 || sf.length > 10 || !/[A-Z]/.test(sf) || !/^[A-Za-z0-9]/.test(sf) || sf.split(" ").length > 2) continue;
      if (/^(fig|figs|table|ref|refs|see|eq|ext|supp|n|p|i|ii|iii|iv|v|vi)\b/i.test(sf) || /[=<>%±]/.test(sf) || /^\d+$/.test(sf)) continue;
      if (found.has(sf)) { found.get(sf).count++; continue; }
      const words = text.slice(Math.max(0, m.index - 200), m.index).trim().split(/\s+/);
      const maxWords = Math.min(sf.length + 5, sf.length * 2);
      const cand = words.slice(-maxWords).join(" ");
      let lf = bestLongForm(sf, cand);
      if (!lf) continue;
      lf = lf.replace(/^[^A-Za-z0-9]+/, "").replace(/[,;:]+$/, "").trim();
      if (lf.length <= sf.length || lf.split(" ").length > maxWords || lf.toLowerCase().includes(sf.toLowerCase() + " ")) continue;
      if (/[@()\[\]]/.test(lf) || /\.$/.test(lf) || lf[0].toLowerCase() !== sf[0].toLowerCase()) continue;
      found.set(sf, { abbr: sf, long: lf, count: 1 });
    }
    for (const a of found.values()) {
      a.count = (text.match(new RegExp(`(?<![\\w-])${a.abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g")) || []).length;
    }
    return [...found.values()].sort((a, b) => b.count - a.count || a.abbr.localeCompare(b.abbr));
  }

  // ---------- 3. caption parsing ----------
  function parseCaption(text, labelLen) {
    const body = text.slice(labelLen).replace(/^[\s.:|—–\-]+/, "");
    const sentences = splitSentences(body);
    const title = sentences[0] || body.slice(0, 160);
    let panels = [];
    for (const re of [/(?:^|[.;]\s+|\s)\(([A-Za-z](?:\s*[–\-,]\s*[A-Za-z])*)\)\s+/g, /(?:^|[.;]\s+)([a-hA-H](?:[–\-][a-hA-H])?)[,|]\s+/g, /(?:^|[.;]\s+)([A-H])\.\s+(?=[A-Z])/g]) {
      const hits = [...body.matchAll(re)];
      if (hits.length >= 2) {
        panels = hits.map((h, i) => ({
          panel: h[1].replace(/\s/g, ""),
          explanation: body.slice(h.index + h[0].length, i + 1 < hits.length ? hits[i + 1].index : undefined).trim().replace(/[.;]$/, ""),
        })).filter((p) => p.explanation.length > 3);
        if (panels.length >= 2) break;
      }
    }
    const stats = sentences.filter((s) => STATS_RE.test(s));
    return { title, panels, stats };
  }

  // ---------- 4. reference list ----------
  const DOI_RE = /\b10\.\d{4,9}\/[^\s"<>{}]+/;
  function parseReferences(text) {
    // numbered lists ("1. Smith…" or "[1] Smith…"): find 1, 2, 3… in order, so stray numbers inside entries don't count
    const marks = [];
    let pos = 0;
    for (let n = 1; n <= 999; n++) {
      const re = new RegExp(`(?:^|\\s)(?:\\[${n}\\]|${n}\\.)\\s+(?=\\p{Lu})`, "gu");
      re.lastIndex = pos;
      const m = re.exec(text);
      if (!m || (n > 1 && m.index - pos > 2500)) break;
      marks.push({ n, at: m.index, start: m.index + m[0].length });
      pos = m.index + m[0].length;
    }
    let style = null, list = [];
    if (marks.length >= 3) {
      style = "numbered";
      list = marks.map((m, i) => ({ n: m.n, text: text.slice(m.start, marks[i + 1]?.at).trim() }));
    } else {
      // author–year lists: a new entry starts with "Surname, A." right after the previous entry ends
      const parts = text.split(/(?<=[.)])\s+(?=\p{Lu}[\p{L}'’\-]+(?:\s\p{Lu}[\p{L}'’\-]+)?,\s+(?:\p{Lu}\.|\p{Lu}\p{L}+))/u)
        .filter((t) => t.length > 30 && /(19|20)\d{2}/.test(t));
      if (parts.length >= 3) { style = "author-year"; list = parts.map((t, i) => ({ n: i + 1, text: t.trim() })); }
    }
    for (const r of list) {
      r.text = r.text.slice(0, 700);
      r.doi = (r.text.match(DOI_RE) || [""])[0].replace(/[.,;)\]]+$/, "");
      r.first = (r.text.match(/^\p{Lu}[\p{L}'’\-]+/u) || [""])[0];          // first author's surname
      r.year = (r.text.match(/\b(19|20)\d{2}[a-z]?\b/) || [""])[0];
    }
    return { style, list };
  }

  // ---------- 5. whole-document pass ----------
  async function run(pdf) {
    const raw = [];
    const fontChars = {};
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      for (const it of tc.items) if (it.str) fontChars[it.fontName] = (fontChars[it.fontName] || 0) + it.str.length;
      raw.push({ n: i, vp: page.getViewport({ scale: 1 }), items: tc.items });
    }
    const bodyFont = Object.entries(fontChars).sort((a, b) => b[1] - a[1])[0]?.[0];
    const pages = raw.map((r) => ({ n: r.n, blocks: pageBlocks(r.items, r.vp, bodyFont), aspect: r.vp.height / r.vp.width }));
    let all = pages.flatMap((p) => p.blocks.map((b) => ({ ...b, page: p.n })));
    if (!all.length) return { empty: true, pages: pdf.numPages };

    // drop running headers/footers (journal name, author line, page numbers repeated at the page edges)
    const edge = (b) => b.text.length < 140 && (b.top < 0.09 || b.bottom > 0.91);
    const rkey = (t) => norm(t).replace(/\d+/g, "#").toLowerCase();
    const seenOn = new Map();
    for (const b of all) if (edge(b)) { const k = rkey(b.text); if (!seenOn.has(k)) seenOn.set(k, new Set()); seenOn.get(k).add(b.page); }
    const minPages = Math.max(2, Math.min(3, Math.ceil(pdf.numPages / 3)));
    all = all.filter((b) => !(edge(b) && seenOn.get(rkey(b.text)).size >= minPages));

    // body font size = size carrying the most characters
    const bySize = new Map();
    for (const b of all) { const k = Math.round(b.size * 2) / 2; bySize.set(k, (bySize.get(k) || 0) + b.text.length); }
    const body = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0][0];

    // headings
    for (const b of all) {
      const key = headingKey(b.text);
      const known = HEADINGS.includes(key);
      const numbered = /^((\d+(\.\d+)*)|[IVX]+)[.)]?\s+[A-Z][^.]{2,70}$/.test(norm(b.text)) && b.size >= body * 0.98
        && norm(b.text).split(" ").length <= 8 && !/[\[\]=]/.test(b.text);
      const big = b.size > body * 1.12 && b.text.length < 90 && b.lines <= 2 && /[A-Za-z]{3}/.test(b.text);
      // a short line in another font (bold) at body size that doesn't read like a sentence ending
      const styled = b.alt && b.size >= body * 0.95 && b.lines <= 3 && b.text.length < 160 && !/[.:;,]$/.test(b.text)
        && /^[\p{Lu}\d]/u.test(b.text) && !CAPTION_RE.test(norm(b.text)) && !/^[\d\s.,–\-]+$/.test(b.text) && /\s/.test(norm(b.text));
      b.heading = (b.lines <= 2 && b.text.length < 100 && (known || numbered || big)) || styled;
      b.key = key;
    }

    // title: largest text on page 1
    const p1 = all.filter((b) => b.page === 1 && b.text.length > 12 && norm(b.text).split(" ").length >= 3 && b.text !== b.text.toUpperCase()
      && !/arxiv|doi|journal|copyright|preprint|licen[cs]e|http|received|accepted|published|citation/i.test(b.text));
    const maxSize = Math.max(...p1.map((b) => b.size));
    const title = norm(p1.filter((b) => b.size >= maxSize - 0.5).map((b) => b.text).join(" ")).slice(0, 300);

    // sections in reading order
    const sections = [];
    let sec = { name: "Front matter", key: "front", page: 1, blocks: [] };
    const HEAD_BY_LEN = [...HEADINGS].sort((a, b) => b.length - a.length);
    const open = (name, key, b) => { sections.push(sec); sec = { name, key, page: b.page, top: b.top, x: b.x0, blocks: [] }; };
    for (const b of all) {
      if (!b.heading) { sec.blocks.push(b); continue; }
      const text = norm(b.text).replace(/^((\d+(\.\d+)*)|[ivxlc]+)[.)]?\s+/i, "");
      const known = HEAD_BY_LEN.find((h) => text.toLowerCase().startsWith(h + " ") && text.length > h.length + 3);
      if (known && !HEADINGS.includes(b.key)) {       // e.g. "Materials and methods Yeast strains"
        open(text.slice(0, known.length), known, b);
        open(text.slice(known.length + 1), headingKey(text.slice(known.length + 1)), b);
      } else open(norm(b.text), b.key, b);
    }
    sections.push(sec);
    const secText = (s) => s.blocks.filter((b) => !b.caption).map((b) => b.text).join(" ");

    // captions
    const figures = [];
    const seen = new Set();
    for (const b of all) {
      const m = norm(b.text).match(CAPTION_RE);
      if (!m) continue;
      const punct = /[.:|—–\-]/.test(m[4] || "");
      if (!punct && b.size > body * 0.98) continue; // "Figure 2 shows …" in running text
      const kind = /table/i.test(m[2]) ? "Table" : "Figure";
      const prefix = m[1] ? (/extended/i.test(m[1]) ? "Extended Data " : "Supplementary ") : "";
      const label = `${prefix}${kind} ${m[3]}`;
      if (seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      b.caption = true;
      const text = norm(b.text);
      figures.push({ label, kind, num: m[3], prefix, page: b.page, caption: text, ...parseCaption(text, m[0].length), box: b });
    }

    // figure regions: the empty-of-body-text band next to the caption, within its column
    for (const f of figures) {
      const pg = pages[f.page - 1], c = f.box;
      const narrow = c.x1 - c.x0 < 0.6;
      const x0 = narrow ? Math.max(0, c.x0 - 0.02) : 0.05, x1 = narrow ? Math.min(1, c.x1 + 0.02) : 0.95;
      const isBody = (b) => b !== c && !b.caption && b.lines >= 2 && b.text.length > 80 && b.size >= body * 0.95 && b.x1 > x0 && b.x0 < x1;
      const otherCaps = figures.filter((g) => g !== f && g.page === f.page).map((g) => g.box);
      const above = pg.blocks.filter((b) => (isBody(b) || otherCaps.includes(b)) && b.bottom <= c.top + 0.005).map((b) => b.bottom);
      const below = pg.blocks.filter((b) => (isBody(b) || otherCaps.includes(b)) && b.top >= c.bottom - 0.005).map((b) => b.top);
      const top = Math.max(0.03, ...above), bottom = Math.min(0.97, ...below);
      let region = null;
      if (f.kind === "Figure" && c.top - top > 0.08) region = { x: x0, y: top, w: x1 - x0, h: c.top - top };
      else if (bottom - c.bottom > 0.08) region = { x: x0, y: c.bottom, w: x1 - x0, h: bottom - c.bottom };
      else if (f.kind === "Figure" && c.top - top > 0.04) region = { x: x0, y: top, w: x1 - x0, h: c.top - top };
      f.region = region;
      delete f.box;
    }

    // outline: drop "headings" that are really labels inside a figure, and repeats
    const inFigure = (s) => figures.some((f) => f.region && f.page === s.page && s.top >= f.region.y - 0.01 && s.top <= f.region.y + f.region.h && s.x >= f.region.x - 0.01 && s.x <= f.region.x + f.region.w);
    const outline = [];
    const firstKnown = sections.findIndex((s) => HEADINGS.includes(s.key));   // skip author/affiliation lines above it
    for (const [si, s] of sections.entries()) {
      if (firstKnown > 0 && si < firstKnown) continue;
      if (s.key === "front" || s.name.length <= 2 || inFigure(s) || norm(s.name) === title) continue;
      if (s.page === 1 && s.name === s.name.toUpperCase() && !HEADINGS.includes(s.key)) continue; // journal banners
      if (outline.some((o) => o.name.toLowerCase() === s.name.toLowerCase())) continue;
      outline.push({ name: s.name.length > 70 ? s.name.slice(0, 70) + "…" : s.name, page: s.page });
    }

    // body sentences (excluding captions and back matter) for mentions + findings + search
    const bodySections = sections.filter((s) => !END_RE.test(s.key));
    const sentences = [];
    for (const s of bodySections) for (const b of s.blocks) if (!b.caption && b.lines >= 1 && b.size >= body * 0.9) {
      for (const t of splitSentences(b.text)) sentences.push({ text: t, page: b.page, section: s.key });
    }
    for (const f of figures) {
      const word = f.kind === "Table" ? "Tables?" : "(?:Fig(?:ure)?s?\\.?|FIG\\.?)";
      const pre = f.prefix ? f.prefix.trim().replace(/\s+/g, "\\s+") + "\\s+" : "";
      const re = new RegExp(`${f.prefix ? "" : "(?<!(?:Supplementary|Extended Data|Suppl\\.?|Supp\\.?)\\s)"}\\b${pre}${word}\\s*${f.num}(?![0-9])`, "i");
      f.mentions = sentences.filter((s) => re.test(s.text)).slice(0, 8);
    }

    // abstract
    let abstract = "";
    const absSec = sections.find((s) => /^(abstract|summary)$/.test(s.key));
    if (absSec) abstract = norm(absSec.blocks.slice(0, 3).filter((b) => b.text.length > 60).map((b) => b.text).join("\n\n"));
    if (!abstract) {
      const inline = all.find((b) => b.page <= 2 && /^abstract\b[\s.:—–-]*/i.test(b.text) && b.text.length > 200);
      if (inline) abstract = inline.text.replace(/^abstract\b[\s.:—–-]*/i, "");
    }
    if (!abstract) {
      const cands = all.filter((b) => b.page === 1 && b.lines >= 4 && b.text.length > 300);
      abstract = cands[0]?.text || "";
    }

    // author-stated findings: abstract first, then results / discussion / conclusion
    const findings = [];
    const addFinding = (t, page) => { if (FINDING_RE.test(t) && !findings.some((f) => f.text === t) && findings.length < 10) findings.push({ text: t, page }); };
    splitSentences(abstract).forEach((t) => addFinding(t, absSec?.page || 1));
    for (const s of sentences) if (/result|discussion|conclu|summary/.test(s.section)) addFinding(s.text, s.page);

    // methods section, split into sub-parts (run-in headings like "Cell culture. HeLa cells were …")
    const methods = [];
    const mIdx = sections.findIndex((s) => METHODS_RE.test(s.key));
    if (mIdx >= 0) {
      for (let i = mIdx; i < sections.length && !END_RE.test(sections[i].key); i++) {
        const s = sections[i];
        if (i > mIdx && HEADINGS.includes(s.key) && !METHODS_RE.test(s.key)) break;
        if (i > mIdx) methods.push({ technique: s.name, text: "", page: s.page });
        for (const b of s.blocks) {
          if (b.caption || b.size < body * 0.8) continue;   // methods are often set smaller than the body
          const m = b.text.match(/^([A-Z][^.]{2,70})\.\s+(?=[A-Z0-9])/);
          if (m && m[1].split(" ").length <= 9) methods.push({ technique: m[1], text: b.text.slice(m[0].length), page: b.page });
          else if (methods.length) methods[methods.length - 1].text += (methods[methods.length - 1].text ? " " : "") + b.text;
          else methods.push({ technique: s.name, text: b.text, page: b.page });
        }
      }
    }

    const fullText = bodySections.flatMap((s) => s.blocks).filter((b) => !b.caption).map((b) => b.text).join(" ");
    const refSecs = sections.filter((s) => /^(references|bibliography|references and notes|literature cited|works cited)$/.test(s.key));
    const references = parseReferences(norm(refSecs.flatMap((s) => s.blocks).filter((b) => !b.caption).map((b) => b.text).join(" ")));
    return {
      title, abstract, outline, findings, figures, methods: methods.filter((m) => m.text.length > 40),
      abbreviations: abbreviations(fullText), sentences, pages: pdf.numPages, references,
    };
  }

  /** Render a page region to a JPEG data URL (for figure previews). */
  async function crop(pdf, pageNum, r, scale = 2) {
    const page = await pdf.getPage(pageNum);
    const vp = page.getViewport({ scale });
    const full = document.createElement("canvas");
    full.width = Math.floor(vp.width); full.height = Math.floor(vp.height);
    await page.render({ canvasContext: full.getContext("2d"), viewport: vp }).promise;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.floor(r.w * vp.width)); c.height = Math.max(1, Math.floor(r.h * vp.height));
    c.getContext("2d").drawImage(full, r.x * vp.width, r.y * vp.height, c.width, c.height, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  }

  return { run, crop, splitSentences };
})();
