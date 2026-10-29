"""Quit completely when Paper Reader's window is closed (team rule, 2026-09-30).

Paper Reader is a local server whose window is a browser tab. Same recipe as Cell Surveillance
(`cellsurveillance/lifecycle.py`), adapted to a plain Flask server without websockets:

* The main window keeps a connection open (`/api/window`, server-sent events). When the window goes, the
  connection drops and the server knows within a couple of seconds, even if the browser sends no beacon
  (the Claude browser pane, for one, closes tabs without `pagehide`).
* Every open page also checks in (`/api/alive`) every few seconds with its own page id. Browsers slow the
  timers of background tabs to about once a minute, so a page counts as open for `PAGE_TTL` seconds.
* When a page is closed it sends a beacon (`/api/closing`) that removes its id. About six seconds later,
  if no page is left, the server quits. A reload checks in again at once, so it does not quit.
* If no page has checked in for about three minutes and no beacon came (browser crashed), it quits too.
  Counting is in checks, not wall-clock time, so waking the Mac from sleep does not trigger it.
* If the launcher that started the server is gone (quit or force-quit from the Dock), it quits.
* Whatever the reason, the Claude Code runs it started are stopped with it (own process group).
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

CHECK_S = float(os.environ.get("PR_LIFECYCLE_CHECK_S", "2"))   # tests shorten this
AFTER_CLOSE = 3            # checks with no page after a page said it was closing (≈ 6 s)
AFTER_SILENCE = int(os.environ.get("PR_LIFECYCLE_SILENCE_CHECKS", "90"))   # no page, no message (≈ 3 min)
PAGE_TTL = float(os.environ.get("PR_LIFECYCLE_PAGE_TTL", "75"))  # seconds a page counts as open after checking in
LAUNCHER_ENV = "PR_LAUNCHER_PID"
GUARD = Path(__file__).with_name("childguard.py")

_lock = threading.Lock()
_pages: dict[str, float] = {}        # page id -> last check-in (monotonic)
_streams: dict[str, int] = {}        # page id -> open /api/window connections (the main window keeps one open)
_state = {"closing": False, "started": False, "children": [], "ever": False, "closed_at": float("-inf")}


def _log(text: str) -> None:
    print(f"[{time.strftime('%F %T')}] lifecycle: {text}", file=sys.stderr, flush=True)


def page_alive(page_id: str) -> None:
    with _lock:
        _pages[page_id[:64]] = time.monotonic()
        _state["ever"] = True          # a page was open, even if it closes before the next check


def page_closed(page_id: str) -> None:
    with _lock:
        _pages.pop(page_id[:64], None)
        _state["closing"] = True
        _state["closed_at"] = time.monotonic()
        _state["ever"] = True


def stream_opened(page_id: str) -> None:
    with _lock:
        _streams[page_id[:64]] = _streams.get(page_id[:64], 0) + 1
        _state["ever"] = True


def stream_closed(page_id: str) -> None:
    """The window's connection dropped: it was closed (or reloaded; a reload reconnects at once).
    Its check-in entry goes too, so a closed window can't look open for another minute."""
    pid = page_id[:64]
    with _lock:
        n = _streams.get(pid, 0) - 1
        if n > 0:
            _streams[pid] = n
            return
        _streams.pop(pid, None)
        _pages.pop(pid, None)
        _state["closing"] = True
        _state["closed_at"] = time.monotonic()


def connected(closing: bool = False) -> int:
    """Open pages: live window connections, plus check-ins. After a window has closed, a page that only checks in
    counts only if it checked in again *after* that close (a reload does at once; a live page within 5 s). Stale
    check-ins from before the close, such as frames that never said goodbye, can't hide it and turn a six-second
    quit into a three-minute one. A real background tab keeps its live connection, so it still counts."""
    now = time.monotonic()
    with _lock:
        for pid in [p for p, t in _pages.items() if now - t > PAGE_TTL]:
            del _pages[pid]
        since = _state["closed_at"] if closing else float("-inf")
        return len({p for p, t in _pages.items() if t > since} | set(_streams))


def should_quit(n_connected: int, seen: bool, empty: int, closing: bool) -> tuple:
    """One step of the rule. Returns (quit now?, seen, empty checks, closing)."""
    if n_connected > 0:
        return False, True, 0, False
    if not seen:                                   # nobody has opened the app yet
        return False, False, 0, closing
    empty += 1
    return (closing and empty >= AFTER_CLOSE) or empty >= AFTER_SILENCE, True, empty, closing


# ---------- child processes (Claude Code runs) ----------
def popen(cmd: list, **kw) -> subprocess.Popen:
    """Start a child that can't outlive the app: own process group, plus a guard that stops the group if
    the server dies without cleaning up (e.g. it was force-killed)."""
    proc = subprocess.Popen([sys.executable, str(GUARD), str(os.getpid()), *cmd], start_new_session=True, **kw)
    with _lock:
        _state["children"] = [p for p in _state["children"] if p.poll() is None] + [proc]
    return proc


def stop_children() -> None:
    with _lock:
        children, _state["children"] = _state["children"], []
    for proc in children:
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def quit_now(reason: str) -> None:
    _log(f"quitting: {reason}")
    stop_children()
    os._exit(0)


def _watch() -> None:
    launcher = int(os.environ.get(LAUNCHER_ENV, "0") or 0)
    seen, empty = False, 0
    while True:
        time.sleep(CHECK_S)
        if launcher and not _alive(launcher):
            quit_now("the launcher was closed")
        q, seen, empty, closing = should_quit(connected(_state["closing"]), seen or _state["ever"], empty, _state["closing"])
        _state["closing"] = closing
        if q:
            quit_now("its window was closed" if closing else "no window has been open for about three minutes")


def start() -> None:
    """Start watching (once). Only called when the server runs for real, never in tests of the routes."""
    with _lock:
        if _state["started"]:
            return
        _state["started"] = True
    threading.Thread(target=_watch, daemon=True, name="lifecycle").start()
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, lambda s, f: quit_now(f"signal {s}"))
