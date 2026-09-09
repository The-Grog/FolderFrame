import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "generate_thumbnails", ROOT / "generate_thumbnails.py"
)
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class BrokenImage:
    @staticmethod
    def open(_source):
        raise ValueError("unsupported or corrupt image")


class ThumbnailFailureCacheTests(unittest.TestCase):
    def generate(self, media, thumbnails, failures):
        fake_pil = types.ModuleType("PIL")
        fake_pil.Image = BrokenImage
        fake_pil.ImageOps = object()
        with mock.patch.dict(sys.modules, {"PIL": fake_pil}):
            return GENERATOR.generate(media, thumbnails, 480, 80, failures)

    def test_unchanged_failure_is_skipped_and_changed_source_is_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            thumbnails = root / "thumbnails"
            failures = root / "data" / "thumbnail-failures.json"
            media.mkdir()
            broken = media / "broken-photo.jpg"
            broken.write_bytes(b"not a jpeg")

            first = self.generate(media, thumbnails, failures)
            self.assertEqual(first["failed"], 1)
            self.assertEqual(first["skippedFailures"], 0)

            second = self.generate(media, thumbnails, failures)
            self.assertEqual(second["failed"], 0)
            self.assertEqual(second["skippedFailures"], 1)

            broken.write_bytes(b"still not a jpeg, but changed")
            third = self.generate(media, thumbnails, failures)
            self.assertEqual(third["failed"], 1)
            self.assertEqual(third["skippedFailures"], 0)

    def test_preview_failure_does_not_fail_valid_manifest_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            thumbnails = root / "thumbnails"
            manifest = root / "data" / "library.json"
            status = root / "data" / "worker-status.json"
            media.mkdir()
            with mock.patch.object(GENERATOR, "generate", return_value={
                "created": 997,
                "current": 0,
                "failed": 3,
                "skippedFailures": 8,
                "changedDirectories": set(),
            }), mock.patch.object(GENERATOR, "write_manifest", return_value={
                "listed": 4,
                "reused": 20,
                "files": 10000,
                "errors": [],
            }), mock.patch.object(sys, "argv", [
                str(ROOT / "generate_thumbnails.py"), str(media), str(thumbnails),
                "--manifest", str(manifest), "--status-file", str(status),
            ]):
                self.assertEqual(GENERATOR.main(), 0)
            payload = json.loads(status.read_text(encoding="utf-8"))
            self.assertEqual(payload["outcome"], "complete_with_warnings")
            self.assertEqual(payload["previewFailures"], 3)
            self.assertEqual(payload["unchangedFailuresSkipped"], 8)

    def test_manifest_error_still_fails_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            status = root / "worker-status.json"
            media.mkdir()
            with mock.patch.object(GENERATOR, "write_manifest", return_value={
                "listed": 1,
                "reused": 0,
                "files": 0,
                "errors": ["unreadable"],
            }), mock.patch.object(sys, "argv", [
                str(ROOT / "generate_thumbnails.py"), str(media),
                "--manifest", str(root / "library.json"), "--manifest-only",
                "--status-file", str(status),
            ]):
                self.assertEqual(GENERATOR.main(), 1)
            payload = json.loads(status.read_text(encoding="utf-8"))
            self.assertEqual(payload["outcome"], "failed")
            self.assertEqual(payload["manifestErrors"], 1)


if __name__ == "__main__":
    unittest.main()
