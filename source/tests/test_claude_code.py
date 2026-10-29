"""Finding Claude Code. The Claude desktop app keeps its own copy and changed the folder layout between releases
(2.1.281: <version>/claude.app; 2.1.286: <version>/<build id>/claude.app). Paper Reader must find either, and pick
the newest version."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import claude_code as cc  # noqa: E402


def fake_cli(home: Path, rel: str) -> str:
    p = home / "Library/Application Support/Claude/claude-code" / rel / "claude.app/Contents/MacOS/claude"
    p.parent.mkdir(parents=True)
    p.write_text("#!/bin/sh\n")
    p.chmod(0o755)
    return str(p)


class FindCli(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="pr-home-"))
        self.patches = [mock.patch("pathlib.Path.home", return_value=self.home), mock.patch("shutil.which", return_value=None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_old_layout(self):
        self.assertEqual(cc.find_cli(), None)
        path = fake_cli(self.home, "2.1.281")
        self.assertEqual(cc.find_cli(), path)

    def test_new_layout_with_build_id(self):
        path = fake_cli(self.home, "2.1.286/f2326db61802")
        self.assertEqual(cc.find_cli(), path)

    def test_newest_version_wins_across_layouts(self):
        fake_cli(self.home, "2.1.281")
        fake_cli(self.home, "2.1.284/4819fdb9b264")
        newest = fake_cli(self.home, "2.1.286/f2326db61802")
        self.assertEqual(cc.find_cli(), newest)


if __name__ == "__main__":
    unittest.main(verbosity=2)
