"""Run paper analyses through Claude Code (the `claude` CLI), signed in with the person's Claude subscription.

No API key is involved: the CLI uses its own login (`claude auth login`). Each run gets a scratch folder holding
only the paper's text and page images, and Claude Code may only *read* files there (no shell, no edits, no web).
"""

import glob
import json
import os
import re
import shlex
import shutil
import subprocess
import time
from pathlib import Path

import pymupdf

INSTALL_CMD = "curl -fsSL https://claude.ai/install.sh | bash"

ANALYSIS_SHAPE = """{
  "title": "", "authors": "", "journal_year": "",
  "one_sentence": "the paper's main point in one sentence",
  "summary": "1-2 short paragraphs a newcomer can follow",
  "background": "what was known before and the gap this paper fills",
  "research_question": "", "approach": "",
  "main_findings": ["finding, with numbers where the paper gives them"],
  "significance": "why it matters",
  "limitations": ["caveats the authors state, plus obvious ones"],
  "glossary": [{"term": "", "definition": "plain-language definition", "in_this_paper": "how this paper uses it"}],
  "figures": [{"label": "Figure 1", "page": 1, "title": "", "question": "the question this figure answers",
               "how_it_was_done": "model system, treatment, measurement, controls, n, statistics",
               "how_to_read": "axes, colours, symbols", "panels": [{"panel": "A", "explanation": ""}],
               "key_findings": [""], "takeaway": "one line"}],
  "methods": [{"technique": "", "plain_explanation": "", "used_for": "what it was used for in this paper"}]
}"""


def _version_key(path: str):
    m = re.search(r"/(\d+(?:\.\d+)+)/", path)
    return tuple(int(x) for x in m.group(1).split(".")) if m else (0,)


def find_cli() -> str | None:
    """The installed `claude` CLI, else the copy bundled with the Claude desktop app."""
    home = Path.home()
    for c in (shutil.which("claude"), home / ".local/bin/claude", home / ".claude/local/claude",
              "/opt/homebrew/bin/claude", "/usr/local/bin/claude"):
        if c and os.access(c, os.X_OK):
            return str(c)
    # the desktop app's own copy; its layout changes between releases (2.1.281: <version>/claude.app,
    # 2.1.286: <version>/<build id>/claude.app), so look a level or two deep
    base = home / "Library/Application Support/Claude/claude-code"
    bundled = [p for pat in ("*/claude.app", "*/*/claude.app", "*/*/*/claude.app")
               for p in glob.glob(str(base / pat / "Contents/MacOS/claude"))]
    bundled = [b for b in bundled if os.access(b, os.X_OK)]
    return max(bundled, key=_version_key) if bundled else None


def _env() -> dict:
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)   # use the subscription login, never an API key by accident
    return env


_status_cache: dict = {"t": 0.0, "value": None}


def status(refresh: bool = False) -> dict:
    """{found, path, logged_in, method}. Cheap: `claude auth status` makes no model call."""
    if not refresh and _status_cache["value"] and time.time() - _status_cache["t"] < 60:
        return _status_cache["value"]
    cli = find_cli()
    value = {"found": bool(cli), "path": cli, "logged_in": False, "method": None}
    if cli:
        try:
            out = subprocess.run([cli, "auth", "status", "--json"], capture_output=True, text=True, timeout=20,
                                 stdin=subprocess.DEVNULL, env=_env())
            info = json.loads(out.stdout or "{}")
            value["logged_in"] = bool(info.get("loggedIn"))
            value["method"] = info.get("authMethod")
        except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
            pass
    _status_cache.update(t=time.time(), value=value)
    return value


def open_terminal(command: str) -> None:
    """Run a command in a new Terminal window (for the one-time install / sign-in the person does themselves)."""
    safe = command.replace("\\", "\\\\").replace('"', '\\"')
    subprocess.run(["osascript", "-e", 'tell application "Terminal" to activate',
                    "-e", f'tell application "Terminal" to do script "{safe}"'], check=False)


def login_command() -> str:
    cli = find_cli()
    if cli:
        return f"{shlex.quote(cli)} auth login --claudeai"
    return f"{INSTALL_CMD} && ~/.local/bin/claude auth login --claudeai"


def prepare_workdir(pdf_path: Path, work: Path) -> Path:
    """paper.txt (text with page markers) + pages/page-NN.png, so Claude can read the text and look at figures."""
    marker = work / ".ready"
    if marker.exists() and marker.stat().st_mtime >= pdf_path.stat().st_mtime:
        return work
    shutil.rmtree(work, ignore_errors=True)
    (work / "pages").mkdir(parents=True)
    doc = pymupdf.open(pdf_path)
    with open(work / "paper.txt", "w") as f:
        for i, page in enumerate(doc, 1):
            f.write(f"\n\n===== PAGE {i} =====\n{page.get_text()}")
    for i, page in enumerate(doc, 1):
        if i > 60:
            break
        page.get_pixmap(dpi=110).save(work / "pages" / f"page-{i:02d}.png")
    marker.touch()
    return work


def run(prompt: str, work: Path, timeout: int) -> str:
    """Run Claude Code headless in `work`, read-only. Returns the final text, or raises RuntimeError."""
    cli = find_cli()
    if not cli:
        raise RuntimeError("Claude Code isn't installed. Open ⚙ Settings to set it up.")
    cmd = [cli, "-p", prompt, "--output-format", "json",
           "--allowedTools", "Read", "Glob", "--permission-mode", "dontAsk",
           "--strict-mcp-config", "--setting-sources", "project", "--no-session-persistence"]
    import lifecycle   # Claude Code runs in its own process group and never outlives Paper Reader
    proc = lifecycle.popen(cmd, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                           stdin=subprocess.DEVNULL, env=_env())
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, 15)
        proc.communicate()
        raise RuntimeError(f"Claude Code took longer than {timeout // 60} minutes and was stopped.")
    out = subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    try:
        res = json.loads(out.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        raise RuntimeError("Claude Code didn't return a result. " + (out.stderr.strip()[-300:] or ""))
    text = (res.get("result") or "").strip()
    if res.get("is_error"):
        if "login" in text.lower() or "logged in" in text.lower():
            _status_cache["value"] = None
            raise RuntimeError("Claude Code isn't signed in. Open ⚙ Settings → Sign in to Claude.")
        raise RuntimeError(f"Claude Code: {text or 'unknown error'}")
    return text


def analysis_prompt(language: str) -> str:
    return f"""This folder contains a scientific paper: paper.txt is its full text (with ===== PAGE n ===== markers) \
and pages/page-NN.png are images of each page.

1. Read paper.txt in full.
2. For every main figure and main table, look at the image of the page it is on, so your description of \
panels, axes, colours and symbols matches what is actually drawn.
3. Write a structured reading guide for a researcher who may not know every technique or term: explain jargon in plain \
words. Stay faithful to the paper: don't invent numbers or results, and write "not stated" when the paper doesn't say.

Reply with ONE JSON code block and nothing else, in exactly this shape:

{ANALYSIS_SHAPE}

Guidance: glossary = every specialised term, abbreviation, gene/protein, reagent, assay or statistical method a \
non-specialist might look up (15-40 entries). figures = one entry per main figure and main table, in order; "page" is \
the PDF page number. Write all text in {language}."""


def explain_prompt(ask: str) -> str:
    return f"""paper.txt in this folder is the full text of a scientific paper (with ===== PAGE n ===== markers); \
pages/ holds page images if you need to look at a figure. Read what you need, then answer.

{ask}

Reply in plain text only (short paragraphs or '-' bullets, no markdown headers)."""


def extract_json(text: str) -> dict:
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    raw = m.group(1) if m else text[text.find("{"): text.rfind("}") + 1]
    return json.loads(raw)
