"""Paper Reader inside another app's frame (Toolbox Launcher, http://localhost:8773) must behave as a real window;
only its own style-gallery previews are not windows. The behaviour itself runs in the browser (checked in the Claude
browser pane: framed copy checks in and quits ~6-7 s after the frame is removed; framed gallery = 1 window, previews
send nothing). These tests guard the wiring so a later edit can't quietly bring back a bare `window.top` check."""
import re
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "static"


class FrameWiring(unittest.TestCase):
    def test_helper_treats_only_same_origin_parents_as_preview(self):
        js = (STATIC / "frame.js").read_text()
        self.assertIn("window.parent.location.origin === location.origin", js)
        self.assertRegex(js, r"catch \(e\) \{ return false; \}")          # cross-origin parent -> real window

    def test_frame_js_loads_first_on_both_pages(self):
        for page in ("index.html", "styles.html"):
            html = (STATIC / page).read_text()
            scripts = re.findall(r'<script src="/static/([^"]+)"', html)
            self.assertEqual(scripts[0], "frame.js", page)
            self.assertIn("lifecycle-client.js", scripts, page)

    def test_no_bare_top_window_checks_left(self):
        for f in STATIC.glob("*.js"):
            if f.name == "frame.js" or f.name.startswith("pdf"):
                continue
            self.assertNotRegex(f.read_text(), r"window\s*[!=]==\s*window\.top", f.name)

    def test_lifecycle_client_skips_only_previews(self):
        self.assertIn("if (window.PR_PREVIEW) return;", (STATIC / "lifecycle-client.js").read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
