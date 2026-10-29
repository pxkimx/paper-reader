"""Server tests. Run from source/:   ../path/to/venv/bin/python -m unittest discover tests -v
Uses a throwaway data folder, generated PDFs and a fake `claude` CLI, so nothing touches the real library,
the network (except the tests marked `net`, skipped unless PR_TEST_NET=1) or the Claude plan.
"""

import io
import json
import os
import stat
import sys
import tempfile
import textwrap
import time
import unittest
import warnings
import zipfile
from pathlib import Path

HOME = Path(tempfile.mkdtemp(prefix="pr-test-"))
os.environ["PR_HOME"] = str(HOME)
os.environ.pop("ANTHROPIC_API_KEY", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf  # noqa: E402

import claude_code as cc  # noqa: E402
import server  # noqa: E402

H = {"X-Paper-Reader": "1"}
NET = os.environ.get("PR_TEST_NET") == "1"


def make_pdf(text_pages, image_only=False) -> bytes:
    doc = pymupdf.open()
    for t in text_pages:
        page = doc.new_page()
        if image_only:   # a "scanned" page: a picture, no text layer
            pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 100), False)
            pix.clear_with(200)
            page.insert_image(page.rect, pixmap=pix)
        else:
            page.insert_textbox(pymupdf.Rect(50, 50, 550, 800), t, fontsize=10)
    return doc.tobytes()


PAPER = [
    "A test paper about lamins\n\nAbstract\nWe show that progerin accumulates [1, 2]. doi:10.1234/test.5678\n\n"
    "Introduction\nHutchinson-Gilford progeria syndrome (HGPS) is caused by progerin [3].",
    "Results\nFigure 1. Progerin levels. (A) Western blot. (B) Quantification, n = 4, mean ± SEM.\n\n"
    "References\n1. Smith A. First paper. J Test. 2001;1:1-2.\n2. Jones B. Second. J Test. 2002;2:3-4.\n3. Lee C. Third. 2003.",
]

FAKE_ANALYSIS = {"title": "Fake analyzed title", "summary": "A summary.", "figures": [{"label": "Figure 1", "page": "2"}],
                 "glossary": [{"term": "HGPS", "definition": "progeria"}], "main_findings": "one finding"}


def fake_cli(result: str, is_error=False, delay=0.0) -> str:
    """A stand-in for the `claude` binary: answers `auth status` and `-p` like the real one."""
    path = HOME / f"fake-claude-{time.time_ns()}"
    payload = json.dumps({"type": "result", "is_error": is_error, "result": result})
    path.write_text(textwrap.dedent(f"""\
        #!/bin/sh
        if [ "$1" = "auth" ]; then echo '{{"loggedIn": true, "authMethod": "claude.ai"}}'; exit 0; fi
        sleep {delay}
        cat <<'JSON'
        {payload}
        JSON
        """))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        warnings.simplefilter("ignore", ResourceWarning)   # Flask test client keeps send_file handles open
        server.app.logger.disabled = True                    # the error tests log tracebacks on purpose
        server.app.testing = True
        cls.c = server.app.test_client()

    def setUp(self):
        cc._status_cache["value"] = None
        self._orig_find = cc.find_cli

    def tearDown(self):
        cc.find_cli = self._orig_find
        cc._status_cache["value"] = None

    # ---------- helpers ----------
    def upload(self, pages=PAPER, name="test paper.pdf", raw=None, **kw):
        raw = raw or make_pdf(pages, **kw)
        r = self.c.post("/api/papers", data={"file": (io.BytesIO(raw), name)}, headers=H,
                        content_type="multipart/form-data")
        self.assertEqual(r.status_code, 200, r.get_json())
        return r.get_json()

    def use_cli(self, path):
        cc.find_cli = lambda: path
        cc._status_cache["value"] = None

    # ---------- safety ----------
    def test_mutations_need_header(self):
        r = self.c.post("/api/quit")
        self.assertEqual(r.status_code, 403)
        r = self.c.delete("/api/papers/0123456789abcdef")
        self.assertEqual(r.status_code, 403)

    def test_foreign_host_blocked(self):
        r = self.c.get("/api/papers", headers={"Host": "evil.example.com"})
        self.assertEqual(r.status_code, 403)

    def test_bad_ids_rejected(self):
        for bad in ("..", "abc", "0123456789ABCDEF", "0123456789abcdef0"):
            r = self.c.get(f"/api/papers/{bad}/analysis")
            self.assertEqual(r.status_code, 404, bad)

    # ---------- library ----------
    def test_upload_list_status_delete(self):
        raw = make_pdf(PAPER)
        p = self.upload(raw=raw)
        self.assertRegex(p["id"], r"^[0-9a-f]{16}$")
        self.assertEqual(p["status"], "to-read")
        again = self.upload(raw=raw)  # same bytes -> same paper, no duplicate
        self.assertEqual(again["id"], p["id"])
        r = self.c.patch(f"/api/papers/{p['id']}", json={"opened": True, "progress": 0.4}, headers=H).get_json()
        self.assertEqual(r["status"], "reading")
        r = self.c.patch(f"/api/papers/{p['id']}", json={"progress": 0.1, "status": "done"}, headers=H).get_json()
        self.assertEqual(r["progress"], 0.4, "progress only moves forward")
        self.assertEqual(r["status"], "done")
        r = self.c.patch(f"/api/papers/{p['id']}", json={"status": "bogus"}, headers=H).get_json()
        self.assertEqual(r["status"], "done")
        ids = [x["id"] for x in self.c.get("/api/papers").get_json()]
        self.assertIn(p["id"], ids)
        self.assertEqual(self.c.delete(f"/api/papers/{p['id']}", headers=H).status_code, 200)
        self.assertEqual(self.c.get(f"/api/papers/{p['id']}/pdf").status_code, 404)

    def test_upload_rejects_non_pdf(self):
        r = self.c.post("/api/papers", data={"file": (io.BytesIO(b"hello"), "notes.txt")}, headers=H, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)
        r = self.c.post("/api/papers", headers=H, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)
        r = self.c.post("/api/papers", data={"file": (io.BytesIO(b"<html>login page</html>"), "fake.pdf")}, headers=H, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400, "HTML saved as .pdf is refused")

    def test_weird_filenames(self):
        p = self.upload(name="a/b:c\\d ünïcødé 論文.pdf", pages=["x"])
        self.assertNotIn("/", p["filename"])
        self.assertIn("論文", p["title"])

    def test_notes_validation(self):
        p = self.upload(pages=["notes test"])
        self.assertEqual(self.c.put(f"/api/papers/{p['id']}/notes", json={"not": "a list"}, headers=H).status_code, 400)
        notes = [{"id": "a", "type": "highlight", "page": 1, "text": "x", "created": 1, "comment": "c"}]
        self.assertEqual(self.c.put(f"/api/papers/{p['id']}/notes", json=notes, headers=H).status_code, 200)
        self.assertEqual(self.c.get(f"/api/papers/{p['id']}/notes").get_json(), notes)
        listed = next(x for x in self.c.get("/api/papers").get_json() if x["id"] == p["id"])
        self.assertEqual((listed["n_highlights"], listed["n_notes"]), (1, 1))
        self.assertEqual(self.c.put("/api/papers/0123456789abcdef/notes", json=[], headers=H).status_code, 404)

    def test_damaged_index_does_not_crash(self):
        backup = server.INDEX.read_text() if server.INDEX.exists() else None
        server.INDEX.write_text("{ broken")
        try:
            self.assertEqual(self.c.get("/api/papers").status_code, 200)
        finally:
            if backup is not None:
                server.INDEX.write_text(backup)

    # ---------- analysis import (Claude.ai round trip) ----------
    def test_import_analysis_coerces(self):
        p = self.upload(pages=["import test"])
        r = self.c.put(f"/api/papers/{p['id']}/analysis", json=FAKE_ANALYSIS, headers=H)
        a = r.get_json()
        self.assertEqual(r.status_code, 200, a)
        self.assertEqual(a["figures"][0]["page"], 2)            # "2" -> 2
        self.assertEqual(a["main_findings"], ["one finding"])   # string -> list
        self.assertEqual(a["figures"][0]["panels"], [])          # missing -> empty
        self.assertEqual(a["_meta"]["model"], "Claude.ai")
        self.assertEqual(self.c.put(f"/api/papers/{p['id']}/analysis", json={"x": 1}, headers=H).status_code, 400)
        self.assertEqual(self.c.put(f"/api/papers/{p['id']}/analysis", data="nope", headers=H, content_type="application/json").status_code, 400)

    # ---------- Claude Code engine ----------
    def test_engine_manual_without_cli(self):
        self.use_cli(None)
        h = self.c.get("/api/health").get_json()
        self.assertEqual(h["engine"], "manual")
        p = self.upload(pages=["engine test"])
        self.assertEqual(self.c.post(f"/api/papers/{p['id']}/analysis/auto", json={}, headers=H).status_code, 400)
        r = self.c.post(f"/api/papers/{p['id']}/explain", json={"question": "What?"}, headers=H)
        self.assertEqual(r.status_code, 401)

    def _wait_job(self, pid, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            st = self.c.get(f"/api/papers/{pid}/analysis/status").get_json()
            if st["state"] != "running":
                return st
            time.sleep(0.2)
        self.fail("job did not finish")

    def test_auto_analysis_success(self):
        self.use_cli(fake_cli("Here it is:\n```json\n" + json.dumps(FAKE_ANALYSIS) + "\n```"))
        self.assertEqual(self.c.get("/api/health").get_json()["engine"], "claude-code")
        p = self.upload(pages=PAPER)
        r = self.c.post(f"/api/papers/{p['id']}/analysis/auto", json={"language": "English"}, headers=H)
        self.assertEqual(r.get_json()["state"], "running")
        st = self._wait_job(p["id"])
        self.assertEqual(st["state"], "done", st)
        a = self.c.get(f"/api/papers/{p['id']}/analysis").get_json()
        self.assertEqual(a["title"], "Fake analyzed title")
        work = server.WORK / p["id"]
        self.assertTrue((work / "paper.txt").exists() and (work / "pages" / "page-01.png").exists())
        listed = next(x for x in self.c.get("/api/papers").get_json() if x["id"] == p["id"])
        self.assertEqual(listed["title"], "Fake analyzed title")

    def test_auto_analysis_errors_are_reported(self):
        p = self.upload(pages=["error test"])
        for cli, expect in ((fake_cli("Not logged in · Please run /login", is_error=True), "isn't signed in"),
                            (fake_cli("I can't produce JSON today."), "expected format"),
                            (fake_cli("Usage limit reached", is_error=True), "Usage limit")):
            self.use_cli(cli)
            cc._status_cache["value"] = {"found": True, "path": cli, "logged_in": True, "method": "claude.ai"}
            cc._status_cache["t"] = time.time()
            self.c.post(f"/api/papers/{p['id']}/analysis/auto", json={}, headers=H)
            st = self._wait_job(p["id"])
            self.assertEqual(st["state"], "error")
            self.assertIn(expect, st["error"])

    def test_paper_deleted_during_analysis(self):
        self.use_cli(fake_cli("```json\n" + json.dumps(FAKE_ANALYSIS) + "\n```", delay=1.5))
        p = self.upload(pages=["deleted mid-run"])
        self.c.post(f"/api/papers/{p['id']}/analysis/auto", json={}, headers=H)
        time.sleep(0.3)
        self.c.delete(f"/api/papers/{p['id']}", headers=H)
        self._wait_job(p["id"])
        self.assertFalse((server.ANALYSES / f"{p['id']}.json").exists(), "no orphan analysis for a removed paper")

    def test_explain_via_cli(self):
        self.use_cli(fake_cli("HGPS is progeria."))
        p = self.upload(pages=PAPER)
        r = self.c.post(f"/api/papers/{p['id']}/explain", json={"selection": "HGPS"}, headers=H)
        self.assertEqual(r.get_json(), {"answer": "HGPS is progeria."})
        self.assertEqual(self.c.post(f"/api/papers/{p['id']}/explain", json={}, headers=H).status_code, 400)

    def test_scanned_and_corrupt_pdfs(self):
        p = self.upload(pages=["", ""], image_only=True)
        work = cc.prepare_workdir(server.PAPERS / f"{p['id']}.pdf", server.WORK / p["id"])
        self.assertEqual(len(list((work / "pages").iterdir())), 2)
        r = self.c.post("/api/papers", data={"file": (io.BytesIO(b"%PDF-1.4 truncated junk"), "trunc.pdf")}, headers=H, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 200, "starts like a PDF: accepted; the reader shows its own error")
        bad = HOME / "corrupt.pdf"
        bad.write_bytes(b"%PDF-1.4 this is not really a pdf")
        with self.assertRaises(Exception):
            cc.prepare_workdir(bad, HOME / "corrupt-work")

    # ---------- terms ----------
    def test_terms_spaced_repetition(self):
        t = self.c.post("/api/terms", json={"term": "HGPS", "definition": "progeria", "paper_id": "../x"}, headers=H).get_json()
        self.assertIsNone(t["paper_id"], "invalid paper ids are dropped")
        dup = self.c.post("/api/terms", json={"term": "hgps", "definition": "updated"}, headers=H).get_json()
        self.assertEqual(dup["id"], t["id"])
        self.assertEqual(self.c.post("/api/terms", json={"term": "  "}, headers=H).status_code, 400)
        r = self.c.patch(f"/api/terms/{t['id']}", json={"knew": True}, headers=H).get_json()
        self.assertEqual(r["box"], 1)
        r = self.c.patch(f"/api/terms/{t['id']}", json={"knew": True}, headers=H).get_json()
        self.assertEqual(r["box"], 2)
        self.assertGreater(r["due"], time.time() + 2 * 86400)
        r = self.c.patch(f"/api/terms/{t['id']}", json={"knew": False}, headers=H).get_json()
        self.assertEqual(r["box"], 1)
        self.assertEqual(self.c.patch("/api/terms/nope", json={"knew": True}, headers=H).status_code, 404)
        self.c.delete(f"/api/terms/{t['id']}", headers=H)
        self.assertNotIn(t["id"], [x["id"] for x in self.c.get("/api/terms").get_json()])

    # ---------- backup / restore ----------
    def test_backup_restore_roundtrip_and_zip_slip(self):
        p = self.upload(pages=["backup test"])
        self.c.put(f"/api/papers/{p['id']}/notes", json=[{"type": "note", "text": "keep me", "page": 1}], headers=H)
        z = self.c.get("/api/backup")
        self.assertEqual(z.status_code, 200)
        names = zipfile.ZipFile(io.BytesIO(z.data)).namelist()
        self.assertIn(f"papers/{p['id']}.pdf", names)
        self.c.delete(f"/api/papers/{p['id']}", headers=H)
        r = self.c.post("/api/restore", data={"file": (io.BytesIO(z.data), "b.zip")}, headers=H, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(self.c.get(f"/api/papers/{p['id']}/notes").get_json()[0]["text"], "keep me")
        # malicious zip: path traversal entries are ignored
        evil = io.BytesIO()
        with zipfile.ZipFile(evil, "w") as ez:
            ez.writestr("index.json", "{}")
            ez.writestr("../../evil.txt", "pwned")
            ez.writestr("papers/../../evil2.txt", "pwned")
        evil.seek(0)
        r = self.c.post("/api/restore", data={"file": (evil, "evil.zip")}, headers=H, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 200)
        self.assertFalse((HOME / "evil.txt").exists() or (HOME.parent / "evil.txt").exists())
        r = self.c.post("/api/restore", data={"file": (io.BytesIO(b"not a zip"), "x.zip")}, headers=H, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)

    # ---------- lookups ----------
    def test_fetch_bad_query(self):
        r = self.c.post("/api/papers/fetch", json={"query": "hello world"}, headers=H)
        self.assertEqual(r.status_code, 400)
        self.assertIn("DOI", r.get_json()["error"])

    def test_cite_without_doi(self):
        p = self.upload(pages=["no identifiers here"])
        r = self.c.get(f"/api/papers/{p['id']}/cite")
        self.assertEqual(r.status_code, 404)

    @unittest.skipUnless(NET, "set PR_TEST_NET=1 to run network tests")
    def test_net_cite_related_fetch(self):
        p = self.upload(pages=["Paper with doi:10.1038/s41419-025-07853-0"])
        self.assertIn("Kim", self.c.get(f"/api/papers/{p['id']}/cite").get_json()["apa"])
        rel = self.c.get(f"/api/papers/{p['id']}/related").get_json()
        self.assertIsInstance(rel.get("similar"), list)
        r = self.c.post("/api/papers/fetch", json={"query": "10.1126/science.1127647"}, headers=H)
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
