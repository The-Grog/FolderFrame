from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/write_build_info.py"
SPEC = importlib.util.spec_from_file_location("build_info", SCRIPT)
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)

class BuildInfoTests(unittest.TestCase):
    def test_unstamped_and_release_identities(self):
        self.assertEqual(BUILD.build_info(), {"schemaVersion": 1, "version": None, "revision": None, "deploymentRevision": None})
        payload = BUILD.build_info("v1.2.3-rc.1", "a" * 40, "b" * 40)
        self.assertEqual(payload["version"], "v1.2.3-rc.1")
        self.assertEqual(payload["revision"], "a" * 40)

    def test_invalid_version_or_private_text_is_rejected(self):
        for value in ("latest", "../private", "<script>", "v1.2.3\n"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                BUILD.build_info(value)
        with self.assertRaises(ValueError):
            BUILD.build_info("v1.2.3", "/private/path")

    def test_about_is_last_direct_child_of_both_options_menus(self):
        class Parser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.stack = []
                self.children = {}
                self.parents = {}
            def handle_starttag(self, tag, attrs):
                identity = dict(attrs).get("id")
                parent = self.stack[-1][1] if self.stack else None
                if identity:
                    self.parents[identity] = parent
                if parent:
                    self.children.setdefault(parent, []).append(identity)
                if tag not in {"meta", "link", "img", "input", "br", "hr", "source"}:
                    self.stack.append((tag, identity))
            def handle_endtag(self, tag):
                if self.stack and self.stack[-1][0] == tag:
                    self.stack.pop()
        parser = Parser()
        parser.feed((SCRIPT.parents[1] / "index.html").read_text(encoding="utf-8"))
        for menu, button in (("viewer-options-menu", "btn-about-viewer"), ("grid-options-menu", "btn-about-grid")):
            self.assertEqual(parser.parents[button], menu)
            self.assertEqual(parser.children[menu][-1], button)
        self.assertEqual(parser.parents["photo-info-menu-slot"], "viewer-options-menu")

    def test_cli_emits_only_expected_public_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "nested/build-info.json"
            subprocess.run([sys.executable, str(SCRIPT), "--version", "v1.2.3", "--revision", "a" * 40, "--output", str(output)], check=True)
            self.assertEqual(json.loads(output.read_text()), BUILD.build_info("v1.2.3", "a" * 40))

if __name__ == "__main__":
    unittest.main()
