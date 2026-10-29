"""Paper Reader - a local app that helps you read scientific papers fast.

Upload a PDF, and Claude produces a summary, a glossary of jargon, and a
figure-by-figure breakdown. Select any text in the paper to get it explained
in context. Highlights, pen marks and handwritten-style notes are saved per paper.

Normally started by "Paper Reader.app" (see launch.sh). For development:
    PR_HOME=/tmp/pr python server.py      then open http://localhost:8769
"""

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import io
import threading
import time
import uuid
import zipfile
from pathlib import Path

import anthropic
import claude_code as cc
import lifecycle
import lookup
import pymupdf
from flask import Flask, abort, jsonify, request, send_file, send_from_directory

MODEL = "claude-opus-5"
ROOT = Path(__file__).parent
VERSION = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").exists() else "dev"
PORT = int(os.environ.get("PORT", 8769))
# Papers, notes and the API key live outside the app bundle, so updating the app never touches them.
HOME = Path(os.environ.get("PR_HOME", Path.home() / "Library/Application Support/PaperReader"))
DATA = HOME / "data"
PAPERS, ANALYSES, NOTES = DATA / "papers", DATA / "analysis", DATA / "notes"
for d in (PAPERS, ANALYSES, NOTES):
    d.mkdir(parents=True, exist_ok=True)
INDEX = DATA / "index.json"

app = Flask(__name__, static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024   # uploads / restores up to 300 MB

# ---------- local-only safety ----------
# The server only listens on 127.0.0.1, but any web page open in the browser could still *send* requests to it.
# Mutating requests must carry the X-Paper-Reader header (a cross-site page can't add custom headers without a
# CORS pre-flight, which this server never approves), and the Host must be local (blocks DNS-rebinding).
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}
ID_RE = re.compile(r"^[0-9a-f]{16}$")


@app.before_request
def _guard():
    host = (request.host or "").rsplit(":", 1)[0].lower()
    if host not in LOCAL_HOSTS:
        return jsonify(error="Paper Reader only answers requests from this computer."), 403
    # /api/closing is sent by navigator.sendBeacon, which can't add headers; it carries LIFE_TOKEN instead
    if request.path == "/api/closing":
        return None
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("X-Paper-Reader") != "1":
        return jsonify(error="Blocked: request didn't come from the Paper Reader page."), 403
    pid = (request.view_args or {}).get("paper_id")
    if pid is not None and not ID_RE.match(pid):
        return jsonify(error="Unknown paper."), 404


@app.errorhandler(413)
def _too_big(_):
    return jsonify(error="That file is too large (limit 300 MB)."), 413


_io_lock = threading.RLock()


def _write_json(path: Path, data) -> None:
    """Atomic write: never leaves a half-written file if two threads (or a crash) collide."""
    with _io_lock:
        tmp = path.with_suffix(path.suffix + f".{uuid.uuid4().hex[:6]}.tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        os.replace(tmp, path)

# Credentials: the key saved from the app's Settings (api_key.txt in HOME), else ANTHROPIC_API_KEY.
KEY_FILE = HOME / "api_key.txt"


def _make_client() -> anthropic.Anthropic:
    key = KEY_FILE.read_text().strip() if KEY_FILE.exists() else ""
    return anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()


client = _make_client()

NO_KEY_MSG = "No Anthropic API key yet. Open ⚙ Settings and paste your key."


# ---------- analysis schema ----------

def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}

STR = {"type": "string"}
STR_LIST = {"type": "array", "items": STR}

ANALYSIS_SCHEMA = _obj({
    "title": STR,
    "authors": STR,
    "journal_year": STR,
    "one_sentence": STR,
    "summary": STR,
    "background": STR,
    "research_question": STR,
    "approach": STR,
    "main_findings": STR_LIST,
    "significance": STR,
    "limitations": STR_LIST,
    "glossary": {"type": "array", "items": _obj({
        "term": STR,
        "definition": STR,
        "in_this_paper": STR,
    })},
    "figures": {"type": "array", "items": _obj({
        "label": STR,
        "page": {"type": "integer"},
        "title": STR,
        "question": STR,
        "how_it_was_done": STR,
        "how_to_read": STR,
        "panels": {"type": "array", "items": _obj({"panel": STR, "explanation": STR})},
        "key_findings": STR_LIST,
        "takeaway": STR,
    })},
    "methods": {"type": "array", "items": _obj({"technique": STR, "plain_explanation": STR, "used_for": STR})},
})

ANALYZE_PROMPT = """You are helping a researcher read this paper quickly and accurately. \
They are smart but may not know every technique or term, so explain jargon in plain words.

Produce a structured breakdown:
- summary: 1-2 short paragraphs a newcomer can follow.
- background: what was known before and the gap this paper fills.
- glossary: every specialised term, abbreviation, gene/protein, reagent, assay or statistical \
method a non-specialist might need to look up (aim for 15-40). `in_this_paper` says how the paper uses it.
- figures: one entry per main figure (and main tables), in order. For each: the question the figure \
answers, exactly how the experiment was performed (model system, treatment, measurement, controls, n, \
statistics if given), how to read it (axes, colours, symbols), a per-panel explanation, the key findings \
with numbers where the paper gives them, and a one-line takeaway. `page` is the 1-based PDF page \
where the figure appears.
- methods: the main techniques, explained plainly, and what each was used for here.
- limitations: caveats the authors state plus any obvious ones.

Be faithful to the paper: do not invent numbers or results. If something is not stated, say so.
Write everything in {language}."""


def _load_index() -> dict:
    with _io_lock:
        try:
            return json.loads(INDEX.read_text()) if INDEX.exists() else {}
        except json.JSONDecodeError:   # keep going on a damaged index; the PDFs are still on disk
            app.logger.error("index.json is damaged; starting from an empty index")
            return {}


def _save_index(idx: dict) -> None:
    _write_json(INDEX, idx)


def _pdf_block(paper_id: str, cache: bool = False) -> dict:
    data = base64.standard_b64encode((PAPERS / f"{paper_id}.pdf").read_bytes()).decode()
    block = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": data}}
    if cache:
        block["cache_control"] = {"type": "ephemeral"}
    return block


def _api_error(e: Exception):
    if isinstance(e, TypeError) and "authentication" in str(e):
        return jsonify(error=NO_KEY_MSG), 401
    if isinstance(e, anthropic.AuthenticationError):
        return jsonify(error="The Anthropic API key was rejected. Check api_key.txt / ANTHROPIC_API_KEY."), 401
    if isinstance(e, anthropic.RateLimitError):
        return jsonify(error="Rate limited by the API - wait a minute and try again."), 429
    if isinstance(e, anthropic.BadRequestError):
        return jsonify(error=f"The API rejected the request: {e.message}"), 400
    if isinstance(e, anthropic.APIStatusError):
        return jsonify(error=f"API error ({e.status_code}): {e.message}"), 502
    if isinstance(e, anthropic.APIConnectionError):
        return jsonify(error="Could not reach the Anthropic API - check your internet connection."), 502
    raise e


def _refused(msg) -> bool:
    return msg.stop_reason == "refusal"


# ---------- routes ----------

@app.get("/")
def home():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/styles")
def styles_gallery():
    return send_from_directory(app.static_folder, "styles.html")


def _has_key() -> bool:
    return (KEY_FILE.exists() and bool(KEY_FILE.read_text().strip())) or bool(os.environ.get("ANTHROPIC_API_KEY"))


def _engine() -> str:
    """How AI features run: an API key, Claude Code on the person's Claude plan, or the manual Claude.ai round trip."""
    if _has_key():
        return "api"
    if os.environ.get("PR_NO_CLAUDE_CODE"):   # testing: never spend the Claude plan
        return "manual"
    return "claude-code" if cc.status()["logged_in"] else "manual"


@app.get("/api/health")
def health():
    return jsonify(app="paper-reader", version=VERSION, has_key=_has_key(), engine=_engine(), claude_code=cc.status(),
                   life=LIFE_TOKEN)


@app.get("/api/claude/status")
def claude_status():
    return jsonify(engine=_engine(), claude_code=cc.status(refresh=True))


@app.post("/api/claude/login")
def claude_login():
    """Opens Terminal for the one-time Claude Code install / sign-in. The person completes the sign-in themselves."""
    cc.open_terminal(cc.login_command())
    return jsonify(ok=True)


@app.post("/api/key")
def set_key():
    global client
    key = ((request.json or {}).get("key") or "").strip()
    if key and not key.startswith("sk-ant-"):
        return jsonify(error="That doesn't look like an Anthropic API key (it should start with sk-ant-)."), 400
    if key:
        KEY_FILE.write_text(key)
        KEY_FILE.chmod(0o600)
    else:
        KEY_FILE.unlink(missing_ok=True)
    client = _make_client()
    return jsonify(ok=True, has_key=bool(key))


@app.post("/api/quit")
def quit_app():
    threading.Timer(0.3, lambda: lifecycle.quit_now("Quit was pressed")).start()
    return jsonify(ok=True)


# ---------- quit completely when the window is closed (see lifecycle.py) ----------
# A random token only this server's own pages can read (via /api/health, same-origin), so another website
# can't close Paper Reader by sending fake "closing" beacons.
LIFE_TOKEN = uuid.uuid4().hex


@app.post("/api/alive")
def page_alive():
    page = str((request.get_json(silent=True) or {}).get("page", ""))
    if page:
        lifecycle.page_alive(page)
    return jsonify(ok=True)


@app.get("/api/window")
def page_window():
    """The main window holds this open. The server pings every second; when the window is closed the next ping
    fails, the generator is closed, and the page is gone at once (see lifecycle.stream_closed)."""
    page, token = request.args.get("page", ""), request.args.get("token", "")
    if token != LIFE_TOKEN or not page:
        return ("", 403)

    def stream():
        lifecycle.stream_opened(page)
        try:
            yield "retry: 1000\n\n"
            while True:
                time.sleep(1)
                yield ": ping\n\n"
        finally:
            lifecycle.stream_closed(page)

    return app.response_class(stream(), mimetype="text/event-stream",
                              headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/closing")
def page_closing():
    try:
        b = json.loads(request.get_data(as_text=True) or "{}")
    except json.JSONDecodeError:
        b = {}
    if b.get("token") != LIFE_TOKEN or not b.get("page"):
        return ("", 403)
    lifecycle.page_closed(str(b["page"]))
    return ("", 204)


STATUSES = ("to-read", "reading", "done")


@app.get("/api/papers")
def list_papers():
    idx = _load_index()
    papers = sorted(idx.values(), key=lambda p: p["added"], reverse=True)
    for p in papers:
        a_path, n_path = ANALYSES / f"{p['id']}.json", NOTES / f"{p['id']}.json"
        p["analyzed"] = a_path.exists()
        p.setdefault("status", "to-read")
        if p["analyzed"]:
            a = json.loads(a_path.read_text())
            p["authors"], p["journal_year"], p["one_sentence"] = a.get("authors", ""), a.get("journal_year", ""), a.get("one_sentence", "")
        notes = json.loads(n_path.read_text()) if n_path.exists() else []
        p["n_highlights"] = len({(n.get("text"), n.get("created")) for n in notes if n.get("type") == "highlight"})
        p["n_notes"] = sum(1 for n in notes if n.get("type") == "note") + sum(1 for n in notes if n.get("type") == "highlight" and n.get("comment"))
    return jsonify(papers)


def _add_pdf(raw: bytes, filename: str, **extra) -> dict:
    paper_id = hashlib.sha256(raw).hexdigest()[:16]
    (PAPERS / f"{paper_id}.pdf").write_bytes(raw)
    idx = _load_index()
    if paper_id not in idx:
        filename = re.sub(r'[/:\\]+', " ", filename).strip() or "paper.pdf"
        idx[paper_id] = {"id": paper_id, "filename": filename, "title": filename[:-4], "added": time.time(), "status": "to-read", **extra}
        _save_index(idx)
    return idx[paper_id]


@app.post("/api/papers")
def upload_paper():
    f = request.files.get("file")
    if not f or not f.filename.lower().endswith(".pdf"):
        return jsonify(error="Please upload a PDF file."), 400
    raw = f.read()
    if not raw.lstrip()[:5] == b"%PDF-":
        return jsonify(error="That file isn't a real PDF (it may be damaged, or a web page saved as .pdf)."), 400
    return jsonify(_add_pdf(raw, f.filename))


@app.post("/api/papers/fetch")
def fetch_paper():
    """Add a paper from a DOI, arXiv ID or PDF link (open-access copies only)."""
    query = ((request.json or {}).get("query") or "").strip()
    try:
        raw, name = lookup.fetch_pdf(query)
    except lookup.LookupError_ as e:
        return jsonify(error=str(e)), 400
    except Exception as e:
        return jsonify(error=f"Download failed ({e}). Check your internet connection."), 502
    extra = {"doi": lookup.clean_doi(query)} if lookup.clean_doi(query) else {}
    return jsonify(_add_pdf(raw, name if name.lower().endswith(".pdf") else name + ".pdf", **extra))


@app.patch("/api/papers/<paper_id>")
def update_paper(paper_id):
    idx = _load_index()
    if paper_id not in idx:
        abort(404)
    body = request.json or {}
    if body.get("status") in STATUSES:
        idx[paper_id]["status"] = body["status"]
    if isinstance(body.get("progress"), (int, float)):
        idx[paper_id]["progress"] = max(float(idx[paper_id].get("progress", 0)), min(1.0, max(0.0, float(body["progress"]))))
    if body.get("opened"):
        idx[paper_id]["opened"] = time.time()
        if idx[paper_id].get("status", "to-read") == "to-read":
            idx[paper_id]["status"] = "reading"
    _save_index(idx)
    return jsonify(idx[paper_id])


@app.get("/api/papers/<paper_id>/cite")
def cite_paper(paper_id):
    idx = _load_index()
    if paper_id not in idx:
        abort(404)
    p = idx[paper_id]
    if not p.get("doi"):
        doc = pymupdf.open(PAPERS / f"{paper_id}.pdf")
        p["doi"] = lookup.find_doi_in_text(" ".join(doc[i].get_text() for i in range(min(2, doc.page_count)))) or ""
        _save_index(idx)
    if not p["doi"]:
        return jsonify(error="No DOI found in this PDF, so a citation can't be looked up."), 404
    if not p.get("cite"):
        try:
            p["cite"] = lookup.citations(p["doi"])
        except lookup.LookupError_ as e:
            return jsonify(error=str(e), doi=p["doi"]), 502
        _save_index(idx)
    return jsonify(p["cite"])


@app.delete("/api/papers/<paper_id>")
def delete_paper(paper_id):
    idx = _load_index()
    if paper_id not in idx:
        abort(404)
    del idx[paper_id]
    _save_index(idx)
    for folder, ext in ((PAPERS, "pdf"), (ANALYSES, "json"), (NOTES, "json")):
        (folder / f"{paper_id}.{ext}").unlink(missing_ok=True)
    shutil.rmtree(WORK / paper_id, ignore_errors=True)
    return jsonify(ok=True)


@app.get("/api/papers/<paper_id>/pdf")
def get_pdf(paper_id):
    path = PAPERS / f"{paper_id}.pdf"
    if not path.exists():
        abort(404)
    return send_file(path, mimetype="application/pdf")


@app.get("/api/papers/<paper_id>/analysis")
def get_analysis(paper_id):
    path = ANALYSES / f"{paper_id}.json"
    if not path.exists():
        return jsonify(None)
    return send_file(path, mimetype="application/json")


@app.post("/api/papers/<paper_id>/analysis")
def analyze(paper_id):
    if not (PAPERS / f"{paper_id}.pdf").exists():
        abort(404)
    language = (request.json or {}).get("language", "English")
    try:
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=64000,
            thinking={"type": "adaptive"},
            output_config={"effort": "high", "format": {"type": "json_schema", "schema": ANALYSIS_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": [
                _pdf_block(paper_id),
                {"type": "text", "text": ANALYZE_PROMPT.replace("{language}", language)},
            ]}],
        ) as stream:
            msg = stream.get_final_message()
    except (anthropic.APIError, TypeError) as e:
        return _api_error(e)

    if _refused(msg):
        return jsonify(error="Claude declined to analyze this document."), 422
    if msg.stop_reason == "max_tokens":
        return jsonify(error="The analysis was too long and got cut off. Try again."), 502
    text = next((b.text for b in msg.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return jsonify(error="The analysis came back in an unexpected format. Try again."), 502
    return jsonify(_save_analysis(paper_id, data, msg.model, language))


# ---------- automatic analysis through Claude Code (background jobs) ----------
JOBS: dict[str, dict] = {}
WORK = HOME / "work"


def _save_analysis(paper_id: str, data: dict, model: str, language: str) -> dict:
    analysis = _coerce(ANALYSIS_SCHEMA, data)
    analysis["_meta"] = {"model": model, "language": language, "created": time.time()}
    idx = _load_index()
    if paper_id not in idx:          # the paper was removed while it was being analyzed
        return analysis
    _write_json(ANALYSES / f"{paper_id}.json", analysis)
    if analysis["title"]:
        idx[paper_id]["title"] = analysis["title"]
        _save_index(idx)
    return analysis


def _auto_job(paper_id: str, language: str) -> None:
    job = JOBS[paper_id]
    try:
        work = cc.prepare_workdir(PAPERS / f"{paper_id}.pdf", WORK / paper_id)
        text = cc.run(cc.analysis_prompt(language), work, timeout=1800)
        try:
            data = cc.extract_json(text)
        except ValueError:
            raise RuntimeError("Claude Code's reply wasn't in the expected format. Try again.")
        _save_analysis(paper_id, data, "Claude Code (your Claude plan)", language)
        job.update(state="done", finished=time.time())
    except Exception as e:  # reported to the page; the log keeps the details
        app.logger.exception("analysis job failed")
        job.update(state="error", error=str(e), finished=time.time())


@app.post("/api/papers/<paper_id>/analysis/auto")
def start_auto_analysis(paper_id):
    if not (PAPERS / f"{paper_id}.pdf").exists():
        abort(404)
    if _engine() != "claude-code":
        return jsonify(error="Claude Code isn't signed in. Open ⚙ Settings to connect it."), 400
    job = JOBS.get(paper_id)
    if not job or job["state"] != "running":
        job = JOBS[paper_id] = {"state": "running", "started": time.time(), "error": None}
        threading.Thread(target=_auto_job, args=(paper_id, (request.json or {}).get("language", "English")), daemon=True).start()
    return jsonify(job)


@app.get("/api/papers/<paper_id>/analysis/status")
def auto_analysis_status(paper_id):
    return jsonify(JOBS.get(paper_id) or {"state": "idle"})


def _coerce(schema: dict, val):
    """Shape pasted JSON (e.g. a Claude.ai reply) to ANALYSIS_SCHEMA so the UI can rely on it."""
    t = schema["type"]
    if t == "object":
        val = val if isinstance(val, dict) else {}
        return {k: _coerce(sub, val.get(k)) for k, sub in schema["properties"].items()}
    if t == "array":
        items = val if isinstance(val, list) else ([] if val in (None, "") else [val])
        return [_coerce(schema["items"], v) for v in items]
    if t == "integer":
        try:
            return int(str(val).strip().split()[0].split("-")[0])
        except (ValueError, IndexError):
            return 0
    if isinstance(val, (list, dict)):
        return json.dumps(val, ensure_ascii=False)
    return "" if val is None else str(val)


@app.put("/api/papers/<paper_id>/analysis")
def import_analysis(paper_id):
    """Save an analysis produced elsewhere (the Claude.ai copy-paste flow)."""
    if paper_id not in _load_index():
        abort(404)
    data = request.json
    if not isinstance(data, dict) or not (data.get("summary") or data.get("figures") or data.get("glossary")):
        return jsonify(error="That reply doesn't contain a summary, figures or glossary. Copy Claude's whole reply and try again."), 400
    return jsonify(_save_analysis(paper_id, data, "Claude.ai", (data.get("_meta") or {}).get("language", "")))


@app.delete("/api/papers/<paper_id>/analysis")
def delete_analysis(paper_id):
    (ANALYSES / f"{paper_id}.json").unlink(missing_ok=True)
    return jsonify(ok=True)


@app.post("/api/papers/<paper_id>/reveal")
def reveal_pdf(paper_id):
    """Show the PDF in Finder under a readable name, ready to drag into Claude.ai."""
    idx = _load_index()
    if paper_id not in idx:
        abort(404)
    out = DATA / "for-claude"
    out.mkdir(exist_ok=True)
    name = re.sub(r'[/:\\]+', " ", idx[paper_id]["filename"]).strip() or f"{paper_id}.pdf"
    dest = out / name
    if not dest.exists():
        shutil.copyfile(PAPERS / f"{paper_id}.pdf", dest)
    subprocess.run(["open", "-R", str(dest)], check=False)
    return jsonify(ok=True, path=str(dest))


@app.post("/api/papers/<paper_id>/explain")
def explain(paper_id):
    """Explain a selected passage/term, or answer a free question, in the context of this paper."""
    if not (PAPERS / f"{paper_id}.pdf").exists():
        abort(404)
    body = request.json or {}
    selection = (body.get("selection") or "").strip()
    question = (body.get("question") or "").strip()
    language = body.get("language", "English")
    if not selection and not question:
        return jsonify(error="Nothing to explain."), 400

    if selection and not question:
        ask = (f'Explain this passage from the paper for a reader who may not know the terms:\n\n"{selection}"\n\n'
               "Define any jargon, say what it means in this paper's context, and why it matters. "
               "Be concise (under ~200 words). Plain text, short paragraphs or '-' bullets, no markdown headers.")
    elif selection:
        ask = f'About this passage from the paper:\n\n"{selection}"\n\n{question}\n\nBe concise and plain.'
    else:
        ask = f"{question}\n\nAnswer from the paper; say so if the paper doesn't cover it. Be concise and plain."
    ask += f"\nRespond in {language}."

    if not _has_key():
        if _engine() != "claude-code":
            return jsonify(error=NO_KEY_MSG), 401
        try:
            work = cc.prepare_workdir(PAPERS / f"{paper_id}.pdf", WORK / paper_id)
            return jsonify(answer=cc.run(cc.explain_prompt(ask), work, timeout=600))
        except RuntimeError as e:
            return jsonify(error=str(e)), 502

    try:
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=16000,
            thinking={"type": "adaptive"},
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            # The PDF block is cached, so repeated questions on the same paper are fast and cheap.
            messages=[{"role": "user", "content": [_pdf_block(paper_id, cache=True), {"type": "text", "text": ask}]}],
        ) as stream:
            msg = stream.get_final_message()
    except (anthropic.APIError, TypeError) as e:
        return _api_error(e)

    if _refused(msg):
        return jsonify(error="Claude declined to answer this."), 422
    return jsonify(answer="".join(b.text for b in msg.content if b.type == "text").strip())


@app.get("/api/papers/<paper_id>/notes")
def get_notes(paper_id):
    path = NOTES / f"{paper_id}.json"
    return send_file(path, mimetype="application/json") if path.exists() else jsonify([])


@app.put("/api/papers/<paper_id>/notes")
def save_notes(paper_id):
    if paper_id not in _load_index():
        abort(404)
    notes = request.get_json(silent=True)
    if not isinstance(notes, list) or not all(isinstance(n, dict) for n in notes):
        return jsonify(error="Notes must be a list."), 400
    _write_json(NOTES / f"{paper_id}.json", notes)
    return jsonify(ok=True)


# ---------- My Terms: a personal glossary across all papers, with spaced-repetition review ----------
TERMS = DATA / "terms.json"
BOX_DAYS = [0, 1, 3, 7, 16, 35]          # Leitner boxes: days until the next review


def _load_terms() -> list:
    with _io_lock:
        try:
            return json.loads(TERMS.read_text()) if TERMS.exists() else []
        except json.JSONDecodeError:
            return []


@app.get("/api/terms")
def list_terms():
    return jsonify(_load_terms())


@app.post("/api/terms")
def add_term():
    b = request.get_json(silent=True) or {}
    term, definition = str(b.get("term", "")).strip()[:200], str(b.get("definition", "")).strip()[:2000]
    if not term:
        return jsonify(error="A term is required."), 400
    terms = _load_terms()
    for t in terms:                         # same term again: refresh it rather than duplicating
        if t["term"].lower() == term.lower():
            t.update(definition=definition or t["definition"], context=str(b.get("context", t.get("context", "")))[:1000])
            _write_json(TERMS, terms)
            return jsonify(t)
    t = {"id": uuid.uuid4().hex[:12], "term": term, "definition": definition, "context": str(b.get("context", ""))[:1000],
         "paper_id": b.get("paper_id") if ID_RE.match(str(b.get("paper_id", ""))) else None,
         "paper_title": str(b.get("paper_title", ""))[:300], "added": time.time(), "box": 0, "due": time.time()}
    terms.append(t)
    _write_json(TERMS, terms)
    return jsonify(t)


@app.patch("/api/terms/<term_id>")
def review_term(term_id):
    """Body {knew: true|false} moves the card up a box (or back to box 1); or {definition: …} edits it."""
    b = request.get_json(silent=True) or {}
    terms = _load_terms()
    t = next((x for x in terms if x["id"] == term_id), None)
    if not t:
        abort(404)
    if "knew" in b:
        t["box"] = min(len(BOX_DAYS) - 1, t.get("box", 0) + 1) if b["knew"] else 1
        t["due"] = time.time() + BOX_DAYS[t["box"]] * 86400
        t["reviews"] = t.get("reviews", 0) + 1
    if "definition" in b:
        t["definition"] = str(b["definition"])[:2000]
    _write_json(TERMS, terms)
    return jsonify(t)


@app.delete("/api/terms/<term_id>")
def delete_term(term_id):
    terms = [t for t in _load_terms() if t["id"] != term_id]
    _write_json(TERMS, terms)
    return jsonify(ok=True)


# ---------- related papers + impact (Semantic Scholar, no key) ----------
@app.get("/api/papers/<paper_id>/related")
def related_papers(paper_id):
    idx = _load_index()
    if paper_id not in idx:
        abort(404)
    p = idx[paper_id]
    if not p.get("doi"):
        doc = pymupdf.open(PAPERS / f"{paper_id}.pdf")
        p["doi"] = lookup.find_doi_in_text(" ".join(doc[i].get_text() for i in range(min(2, doc.page_count)))) or ""
        _save_index(idx)
    if not p["doi"]:
        return jsonify(error="No DOI found in this PDF, so related papers can't be looked up."), 404
    cached = p.get("related")
    if cached and time.time() - cached.get("fetched", 0) < 7 * 86400 and request.args.get("refresh") != "1":
        return jsonify(cached)
    try:
        info = lookup.related(p["doi"])
    except lookup.LookupError_ as e:
        return jsonify(error=str(e)), 502
    info["fetched"] = time.time()
    idx = _load_index()
    if paper_id in idx:
        idx[paper_id]["related"] = info
        _save_index(idx)
    return jsonify(info)


# ---------- backup / restore ----------
@app.get("/api/backup")
def backup():
    buf = io.BytesIO()
    with _io_lock, zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path in DATA.rglob("*"):
            rel = path.relative_to(DATA)
            if path.is_file() and rel.parts[0] in ("papers", "analysis", "notes") or rel.as_posix() in ("index.json", "terms.json"):
                z.write(path, rel.as_posix())
    buf.seek(0)
    name = time.strftime("Paper Reader backup %Y-%m-%d.zip")
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=name)


@app.post("/api/restore")
def restore():
    """Merge a backup zip into the library (existing papers and notes are kept; newer copies from the zip win)."""
    f = request.files.get("file")
    if not f:
        return jsonify(error="Choose a backup .zip file."), 400
    try:
        z = zipfile.ZipFile(f.stream)
    except zipfile.BadZipFile:
        return jsonify(error="That isn't a Paper Reader backup (.zip) file."), 400
    allowed = re.compile(r"^(papers/[0-9a-f]{16}\.pdf|analysis/[0-9a-f]{16}\.json|notes/[0-9a-f]{16}\.json|index\.json|terms\.json)$")
    names = [n for n in z.namelist() if allowed.match(n)]          # ignores anything else, including ../ paths
    if "index.json" not in names:
        return jsonify(error="That zip doesn't look like a Paper Reader backup (no index.json)."), 400
    try:
        incoming = json.loads(z.read("index.json"))
        assert isinstance(incoming, dict)
    except (json.JSONDecodeError, AssertionError):
        return jsonify(error="The backup's index is damaged."), 400
    with _io_lock:
        for n in names:
            if n not in ("index.json", "terms.json"):
                (DATA / n).write_bytes(z.read(n))
        idx = _load_index()
        added = 0
        for pid, entry in incoming.items():
            if ID_RE.match(pid) and isinstance(entry, dict) and (PAPERS / f"{pid}.pdf").exists():
                added += pid not in idx
                idx[pid] = {**idx.get(pid, {}), **entry, "id": pid}
        _save_index(idx)
        if "terms.json" in names:
            try:
                have = {t["term"].lower() for t in _load_terms()}
                merged = _load_terms() + [t for t in json.loads(z.read("terms.json")) if t.get("term", "").lower() not in have]
                _write_json(TERMS, merged)
            except (json.JSONDecodeError, TypeError, KeyError):
                pass
    return jsonify(ok=True, added=added, total=len(idx))


if __name__ == "__main__":
    print(f"Paper Reader {VERSION} running at http://localhost:{PORT}  (data: {HOME})")
    if not os.environ.get("PR_NO_LIFECYCLE"):
        lifecycle.start()
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
