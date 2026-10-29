"""Paper Reader quits completely when its window is closed. Run from source/: python -m unittest tests.test_lifecycle

Unit tests check the rule; the integration tests start a real server (fast timings via environment variables) and act
out each case: tab closed, reload, two tabs, a fake beacon from another site, launcher gone, browser vanished, and a
Claude Code run being cleaned up (also after the server is force-killed).
"""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

SRC = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC))
import lifecycle  # noqa: E402


class Rule(unittest.TestCase):
    def run_rule(self, seq, closing_at=None):
        seen, empty, closing = False, 0, False
        for i, n in enumerate(seq):
            if closing_at == i:
                closing = True
            q, seen, empty, closing = lifecycle.should_quit(n, seen, empty, closing)
            if q:
                return i
        return None

    def test_never_opened_never_quits(self):
        self.assertIsNone(self.run_rule([0] * 500))

    def test_close_quits_after_three_checks(self):
        self.assertEqual(self.run_rule([1, 1, 0, 0, 0, 0], closing_at=2), 4)

    def test_reload_does_not_quit(self):
        self.assertIsNone(self.run_rule([1, 0, 1, 1, 1], closing_at=1))

    def test_silence_quits_after_about_three_minutes(self):
        self.assertEqual(self.run_rule([1] + [0] * 200), lifecycle.AFTER_SILENCE)

    def test_pages_expire(self):
        lifecycle._pages.clear()
        lifecycle.page_alive("a")
        lifecycle._pages["b"] = time.monotonic() - lifecycle.PAGE_TTL - 1
        self.assertEqual(lifecycle.connected(), 1)
        lifecycle.page_closed("a")
        self.assertEqual(lifecycle.connected(), 0)
        self.assertTrue(lifecycle._state["closing"])


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class RealServer(unittest.TestCase):
    """Each test starts its own server with checks every 0.2 s, pages valid 1.5 s, silence = 15 checks (3 s)."""

    def start(self, **env):
        self.home = Path(tempfile.mkdtemp(prefix="pr-life-"))
        self.port = free_port()
        e = dict(os.environ, PR_HOME=str(self.home), PORT=str(self.port), PR_LIFECYCLE_CHECK_S="0.2",
                 PR_LIFECYCLE_PAGE_TTL="1.5", PR_LIFECYCLE_SILENCE_CHECKS="15")
        e.pop("PR_NO_LIFECYCLE", None)
        e.pop("PR_LAUNCHER_PID", None)
        e.update(env)
        self.proc = subprocess.Popen([sys.executable, "-W", "ignore", "server.py"], cwd=SRC, env=e,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                self.token = self.get("/api/health")["life"]
                return
            except Exception:
                time.sleep(0.1)
        self.fail("server did not start")

    def tearDown(self):
        if getattr(self, "proc", None) and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def get(self, path):
        with urllib.request.urlopen(self.url(path), timeout=5) as r:
            return json.loads(r.read())

    def post(self, path, body, headers=None):
        req = urllib.request.Request(self.url(path), data=json.dumps(body).encode(), method="POST",
                                     headers=headers if headers is not None else {"Content-Type": "application/json", "X-Paper-Reader": "1"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def alive(self, page):
        self.post("/api/alive", {"page": page})

    def beacon(self, page, token=None):   # like navigator.sendBeacon: text/plain, no custom header
        return self.post("/api/closing", {"page": page, "token": token or self.token}, headers={"Content-Type": "text/plain"})

    def assertExits(self, within):
        try:
            self.proc.wait(timeout=within)
        except subprocess.TimeoutExpired:
            self.fail(f"server still running after {within}s")
        with socket.socket() as s:
            self.assertNotEqual(s.connect_ex(("127.0.0.1", self.port)), 0, "nothing may keep listening on the port")

    def assertRunning(self, secs):
        time.sleep(secs)
        self.assertIsNone(self.proc.poll(), "server quit when it should have stayed")

    def test_closing_the_tab_quits(self):
        self.start()
        self.alive("tab1")
        self.assertEqual(self.beacon("tab1"), 204)
        self.assertExits(within=4)

    def test_reload_keeps_running(self):
        self.start()
        self.alive("before")
        self.beacon("before")
        self.alive("after-reload")          # the reloaded page checks in at once
        self.assertRunning(1.2)
        for _ in range(3):
            self.alive("after-reload")
            time.sleep(0.4)
        self.assertIsNone(self.proc.poll())
        self.beacon("after-reload")
        self.assertExits(within=4)

    def test_closing_one_of_two_tabs_keeps_running(self):
        self.start()
        self.alive("a")
        self.alive("b")
        self.beacon("a")
        for _ in range(4):
            self.alive("b")
            time.sleep(0.35)
        self.assertIsNone(self.proc.poll())
        self.beacon("b")
        self.assertExits(within=4)

    def window(self, page, token=None):
        """Open /api/window like the main page's EventSource; returns the socket (close it = window closed)."""
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        sock.sendall(f"GET /api/window?page={page}&token={token or self.token} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode())
        head = sock.recv(200).decode(errors="replace")
        return sock, head.split(" ")[1] if " " in head else "?"

    def test_window_connection_dropping_quits_without_beacon(self):
        self.start()
        self.alive("main")                 # the page also checks in: its entry must not keep the app looking open
        sock, status = self.window("main")
        self.assertEqual(status, "200")
        self.assertRunning(1.0)
        sock.close()                       # the window is gone, and no beacon comes (like the Claude browser pane)
        self.assertExits(within=6)

    def test_window_reconnect_on_reload_keeps_running(self):
        self.start()
        a, _ = self.window("before")
        a.close()
        b, _ = self.window("after-reload")
        try:
            self.assertRunning(4)
        finally:
            b.close()
        self.assertExits(within=6)

    def test_frames_checked_in_then_window_closed_quits_quickly(self):
        """2026-09-30 sweep: the style gallery's 11 framed previews checked in but never said goodbye; their stale
        entries erased the 'window closed' state and the quit took 4 minutes. With the real 75 s page lifetime, the
        close must still quit in seconds."""
        self.start(PR_LIFECYCLE_PAGE_TTL="75")
        for i in range(11):
            self.alive(f"frame{i}")
        sock, _ = self.window("main")
        self.alive("main")
        self.assertRunning(0.6)
        sock.close()
        self.beacon("main")
        self.assertExits(within=10)

    def test_background_tab_with_live_connection_keeps_running_after_other_tab_closes(self):
        self.start(PR_LIFECYCLE_PAGE_TTL="75")
        bg, _ = self.window("background")     # throttled: no check-ins, but its connection stays open
        fg, _ = self.window("foreground")
        try:
            fg.close()
            self.beacon("foreground")
            self.assertRunning(9)
        finally:
            bg.close()
        self.assertExits(within=8)

    def test_forged_window_connection_is_refused(self):
        self.start()
        sock, status = self.window("x", token="guess")
        sock.close()
        self.assertEqual(status, "403")

    def test_fake_beacon_from_another_site_is_refused(self):
        self.start()
        self.alive("tab")
        self.assertEqual(self.beacon("tab", token="guess"), 403)
        self.assertEqual(self.post("/api/alive", {"page": "x"}, headers={"Content-Type": "application/json"}), 403)
        for _ in range(4):
            self.alive("tab")
            time.sleep(0.3)
        self.assertIsNone(self.proc.poll())

    def test_never_opened_stays_up(self):
        self.start()
        self.assertRunning(1.5)

    def test_browser_vanished_quits_after_silence(self):
        self.start()
        self.alive("tab")                    # then nothing: no beacon, no check-ins
        self.assertExits(within=10)

    def test_launcher_gone_quits(self):
        launcher = subprocess.Popen(["sleep", "60"])
        try:
            self.start(PR_LAUNCHER_PID=str(launcher.pid))
            self.assertRunning(0.6)
            launcher.kill()
            launcher.wait()
            self.assertExits(within=4)
        finally:
            if launcher.poll() is None:
                launcher.kill()

    def _fake_claude(self, marker):
        d = Path(tempfile.mkdtemp(prefix="pr-fakecli-"))
        cli = d / "claude"
        cli.write_text("#!/bin/sh\nif [ \"$1\" = auth ]; then echo '{\"loggedIn\": true}'; exit 0; fi\n"
                       f"exec sleep 120 {marker}\n".replace(f" {marker}", ""))
        # the long-running part carries a unique marker we can find with pgrep
        cli.write_text("#!/bin/sh\nif [ \"$1\" = auth ]; then echo '{\"loggedIn\": true}'; exit 0; fi\n"
                       f"exec /bin/sh -c 'sleep 120; : {marker}'\n")
        cli.chmod(0o755)
        return d

    def _start_job(self, marker):
        d = self._fake_claude(marker)
        self.start(PATH=f"{d}:{os.environ['PATH']}")
        # a tiny PDF to analyse
        import io, pymupdf
        doc = pymupdf.open(); doc.new_page().insert_text((72, 72), "hello"); raw = doc.tobytes()
        boundary = "X1"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"t.pdf\"\r\n"
                "Content-Type: application/pdf\r\n\r\n").encode() + raw + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(self.url("/api/papers"), data=body, method="POST",
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "X-Paper-Reader": "1"})
        pid = json.loads(urllib.request.urlopen(req, timeout=10).read())["id"]
        self.assertEqual(self.post(f"/api/papers/{pid}/analysis/auto", {}), 200)
        for _ in range(50):
            if subprocess.run(["pgrep", "-f", marker], capture_output=True).returncode == 0:
                return
            time.sleep(0.1)
        self.fail("fake Claude Code run did not start")

    def _gone(self, marker, within):
        end = time.time() + within
        while time.time() < end:
            if subprocess.run(["pgrep", "-f", marker], capture_output=True).returncode != 0:
                return True
            time.sleep(0.2)
        subprocess.run(["pkill", "-f", marker])
        return False

    def test_running_claude_code_is_stopped_on_close(self):
        marker = f"prlife-{os.getpid()}-{time.time_ns()}"
        self._start_job(marker)
        self.alive("tab")
        self.beacon("tab")
        self.assertExits(within=4)
        self.assertTrue(self._gone(marker, within=4), "the Claude Code run outlived Paper Reader")

    def test_claude_code_stops_even_if_server_is_force_killed(self):
        marker = f"prlife-kill-{os.getpid()}-{time.time_ns()}"
        self._start_job(marker)
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait()
        self.assertTrue(self._gone(marker, within=5), "the guard didn't stop the orphaned Claude Code run")


if __name__ == "__main__":
    unittest.main(verbosity=2)
