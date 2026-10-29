# Paper Reader

A local app for reading scientific papers fast. It works without an API key: a built-in reading guide is extracted
straight from the PDF (`static/extract.js`: abstract, author-stated findings, outline, figure captions split into
panels + statistics + the sentences that cite each figure + a cropped picture, methods subsections, abbreviations).
For the full AI breakdown, the Claude.ai round trip (copy prompt, attach PDF, paste reply back) fills every tab.
With an optional API key the same breakdown runs automatically. The AI breakdown gives:

- **Summary**: one-line gist, background, question, approach, main findings, significance, limitations
- **Figures**: each figure dissected: the question it answers, how the experiment was done, how to read it, panel by panel, key findings, takeaway (with a jump-to-page button)
- **Glossary**: every term you might need to look up. Terms are also dotted-underlined *in the paper*; hover one to see its definition.
- **Methods**: each technique explained plainly
- **Ask / Explain**: select any text and hit ✨ Explain, or type a question about the paper

You can also mark up the paper yourself: highlights (4 colors) with comments, sticky notes, and a pen. Notes use a handwriting font (Caveat, Patrick Hand, Kalam, or the Korean-capable Nanum Pen Script and Gaegu; pick one in ⚙ Settings). **Export PDF** saves a copy with your marks and adds a handwritten "My notes" page at the end.

## Reading tools (v1.3)

- **Citations**: hover a reference number ([12] or superscript) to see the reference; click for DOI / PubMed / Scholar links
  or "+ Library" to download it. A searchable reference list is at the bottom of the Summary tab.
- **Find in paper** (⌘F) with highlighted matches; **page box** (G); your place in each paper is remembered.
- **Figure viewer** (F, or ⤢ on a figure card): large figure beside its explanation, ← → to step through.
- **Export ▾**: marked-up PDF, reading notes as Markdown, or printable notes (journal club).
- **❝ Cite**: APA, BibTeX and RIS (EndNote / Zotero / Mendeley) from the paper's DOI.
- **Library**: search, reading status (to read / reading / done), sorting, and **add by DOI, arXiv ID or PDF link**
  (open-access copies via Semantic Scholar / Europe PMC / arXiv).
- Press **?** for all shortcuts.

## Learning and organising (v1.4)

- **Highlight meanings**: yellow = key point, green = method, pink = question/doubt, blue = follow up (rename them in
  ⚙ Settings). My notes filters by meaning; exported notes are labelled.
- **📚 My terms**: ☆ any glossary term (or select a word → ☆ Term) to keep a personal glossary across papers, then
  ▶ Study with spaced-repetition flashcards.
- **Impact & related papers** on the Summary tab (Semantic Scholar): citation count, a TL;DR, similar papers → + Library.
- **Reading progress** bars in the library, **🌙 night mode**, **🔊 read aloud** (macOS voices, offline).
- **⇩ Back up / ⇧ Restore** the whole library as one .zip (library footer).

## Quitting (v1.5)

Paper Reader quits completely when its window is closed (team rule for all offline tools, 2026-09-30).
`lifecycle.py`: every open page checks in every 5 s; closing a tab sends a beacon (`/api/closing`, with a per-launch
token so other websites can't close it) and the server quits ~6 s after the last page is gone; a reload checks in again
at once. With no page and no beacon (browser crashed) it quits after ~3 min. It also quits when its launcher is gone
(Dock quit / force quit), and every Claude Code run is started through `childguard.py` in its own process group, so it
is stopped with the server, even if the server is force-killed. Tests: `tests/test_lifecycle.py`.

## Safety and tests

- The server listens only on this Mac, refuses changes that don't come from the Paper Reader page (so other websites
  can't drive it), validates paper IDs, writes files atomically, and ignores unsafe paths in restored backups.
- `tests/test_server.py` covers every route, including a fake Claude Code for the analysis pipeline.
  Double-click **Run self-test.command**, or: `python -m unittest discover tests` (add `PR_TEST_NET=1` for network tests).

## Styles

11 visual styles (`static/themes.css`, listed in `static/themes.js`): Notebook, Modern Minimal, Mid-Century Modern,
Scandinavian, Swiss International, Japandi, Art Deco, Bauhaus, Dark Studio, Academic Classic, Library Card.
Compare them at `/styles`; preview one with `/?theme=<id>`.

## Setup and running

See README-FIRST.txt next to the app. In short: double-click **Paper Reader.app**, then paste your
Anthropic API key in ⚙ Settings once.

## Developing

- `source/` is the code: `server.py` (Flask + Anthropic API), `static/` (the reader UI, pdf.js, pdf-lib, fonts),
  `launch.sh` (shared launcher), `macos/` (app bundle template + `make_icon.py`).
- Run from source: `PR_HOME=/tmp/pr python3 server.py`, then open http://localhost:8769
- After editing, bump `VERSION` and run `./build_mac.sh`. It refreshes `../Paper Reader.app` and writes a zip.

## Notes

- Your papers, analyses and annotations stay on this computer in `~/Library/Application Support/PaperReader/data`. The viewer, highlighting, notes and export work offline. The AI analysis and Explain need internet and send the PDF to the Anthropic API.
- One full analysis of a typical paper costs roughly tens of cents in API usage. Explain questions reuse a cached copy of the paper, so they cost less.
- Shortcuts: V select, P pen, N note, E eraser, Esc cancel, Cmd+Z undo.
