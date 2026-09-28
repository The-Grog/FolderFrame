import importlib.util
import builtins
import json
import pathlib
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from PIL import Image


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("generate_thumbnails", ROOT / "generate_thumbnails.py")
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class VideoDurationTests(unittest.TestCase):
    def test_ffprobe_output_is_narrowly_parsed_and_validated(self):
        valid = SimpleNamespace(returncode=0, stdout='{"format":{"duration":"222.4"}}')
        with mock.patch.object(GENERATOR.subprocess, "run", return_value=valid) as run:
            self.assertEqual(GENERATOR.probe_video_duration(pathlib.Path("clip.mp4"), "ffprobe"), 222.4)
        command = run.call_args.args[0]
        self.assertEqual(command[:7], ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json"])
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertEqual(run.call_args.kwargs["timeout"], GENERATOR.VIDEO_DURATION_TIMEOUT)

        cases = [
            SimpleNamespace(returncode=1, stdout=""),
            SimpleNamespace(returncode=0, stdout="not json"),
            SimpleNamespace(returncode=0, stdout='{"format":{"duration":"nan"}}'),
            SimpleNamespace(returncode=0, stdout='{"format":{"duration":0}}'),
            SimpleNamespace(returncode=0, stdout='{"format":{"duration":true}}'),
            SimpleNamespace(returncode=0, stdout='{"format":[]}'),
        ]
        for result in cases:
            with mock.patch.object(GENERATOR.subprocess, "run", return_value=result):
                self.assertIsNone(GENERATOR.probe_video_duration(pathlib.Path("clip.mov"), "ffprobe"))
        with mock.patch.object(GENERATOR.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffprobe", 1)):
            self.assertIsNone(GENERATOR.probe_video_duration(pathlib.Path("clip.webm"), "ffprobe"))
        with mock.patch.object(GENERATOR.subprocess, "run", side_effect=FileNotFoundError()):
            self.assertIsNone(GENERATOR.probe_video_duration(pathlib.Path("clip.m4v"), "ffprobe"))

    def test_manifest_only_backfills_root_and_chunk_and_reuses_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            nested = media / "album"
            nested.mkdir(parents=True)
            root_video = media / "root.MP4"
            nested_video = nested / "clip.webm"
            image = media / "photo.jpg"
            root_video.write_bytes(b"root-video")
            nested_video.write_bytes(b"nested-video")
            Image.new("RGB", (2, 2), "blue").save(image)
            manifest = root / "data" / "library.json"
            GENERATOR.write_manifest(media, None, manifest)
            original_root_mtime = media.stat().st_mtime_ns
            original_nested_mtime = nested.stat().st_mtime_ns

            durations = {"root.MP4": 59.9, "clip.webm": 3923.0}
            with mock.patch.object(GENERATOR.shutil, "which", return_value="ffprobe"), \
                    mock.patch.object(GENERATOR, "probe_video_duration",
                        side_effect=lambda path, _tool: durations[path.name]) as probe:
                first = GENERATOR.generate(media, None, 480, 80, manifest_path=manifest, thumbnails=False)
                GENERATOR.write_manifest(media, None, manifest, first["changedDirectories"], first["metadataRecords"])
                second = GENERATOR.generate(media, None, 480, 80, manifest_path=manifest, thumbnails=False)

            self.assertEqual(probe.call_count, 2)
            self.assertEqual(media.stat().st_mtime_ns, original_root_mtime)
            self.assertEqual(nested.stat().st_mtime_ns, original_nested_mtime)
            self.assertEqual(second["metadataReused"], 3)
            self.assertEqual(second["metadataWarnings"], 0)
            index = json.loads(manifest.read_text(encoding="utf-8"))
            root_record = next(item for item in index["root"]["files"] if item["path"] == "root.MP4")
            self.assertEqual(root_record["duration"], 59.9)
            image_record = next(item for item in index["root"]["files"] if item["path"] == "photo.jpg")
            self.assertNotIn("duration", image_record)
            chunk_path = manifest.parent / index["chunks"]["album"]["file"]
            chunk = json.loads(chunk_path.read_text(encoding="utf-8"))
            self.assertEqual(chunk["directories"]["album"]["files"][0]["duration"], 3923.0)

    def test_source_changes_invalidate_duration_and_missing_tool_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            media.mkdir()
            video = media / "clip.m4v"
            video.write_bytes(b"first")
            manifest = root / "data" / "library.json"

            with mock.patch.object(GENERATOR.shutil, "which", return_value=None), \
                    mock.patch.object(GENERATOR, "probe_video_duration") as probe:
                unavailable = GENERATOR.generate(media, None, 480, 80, manifest_path=manifest, thumbnails=False)
            self.assertEqual(probe.call_count, 0)
            self.assertEqual(unavailable["metadataWarnings"], 0)

            with mock.patch.object(GENERATOR.shutil, "which", return_value="ffprobe"), \
                    mock.patch.object(GENERATOR, "probe_video_duration", return_value=12.5) as probe:
                recovered = GENERATOR.generate(media, None, 480, 80, manifest_path=manifest, thumbnails=False)
                again = GENERATOR.generate(media, None, 480, 80, manifest_path=manifest, thumbnails=False)
            self.assertEqual(probe.call_count, 1, "available ffprobe backfills once, then the result is cached")
            self.assertEqual(recovered["metadataRecords"]["clip.m4v"]["duration"], 12.5)
            self.assertEqual(again["metadataRecords"]["clip.m4v"]["duration"], 12.5)

            video.write_bytes(b"changed source")
            with mock.patch.object(GENERATOR.shutil, "which", return_value="ffprobe"), \
                    mock.patch.object(GENERATOR, "probe_video_duration", return_value=25.0) as probe:
                changed = GENERATOR.generate(media, None, 480, 80, manifest_path=manifest, thumbnails=False)
            self.assertEqual(probe.call_count, 1)
            self.assertEqual(changed["metadataRecords"]["clip.m4v"]["duration"], 25.0)

            GENERATOR.write_manifest(media, None, manifest, changed["changedDirectories"], changed["metadataRecords"])
            video.write_bytes(b"changed and unreadable")
            with mock.patch.object(GENERATOR.shutil, "which", return_value="ffprobe"), \
                    mock.patch.object(GENERATOR, "probe_video_duration", return_value=None):
                unavailable_again = GENERATOR.generate(media, None, 480, 80,
                    manifest_path=manifest, thumbnails=False)
            GENERATOR.write_manifest(media, None, manifest, unavailable_again["changedDirectories"],
                unavailable_again["metadataRecords"])
            record = json.loads(manifest.read_text(encoding="utf-8"))["root"]["files"][0]
            self.assertNotIn("duration", record, "an invalidated duration is not retained by directory reuse")

    def test_unavailable_duration_is_cached_without_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            media.mkdir()
            (media / "broken.mov").write_bytes(b"broken")
            manifest = root / "data" / "library.json"
            with mock.patch.object(GENERATOR.shutil, "which", return_value="ffprobe"), \
                    mock.patch.object(GENERATOR, "probe_video_duration", return_value=None) as probe:
                first = GENERATOR.generate(media, None, 480, 80, manifest_path=manifest, thumbnails=False)
                second = GENERATOR.generate(media, None, 480, 80, manifest_path=manifest, thumbnails=False)
            self.assertEqual(probe.call_count, 1)
            self.assertEqual(first["metadataWarnings"], 0)
            self.assertEqual(second["metadataWarnings"], 0)
            self.assertNotIn("duration", second["metadataRecords"]["broken.mov"])
            self.assertEqual(GENERATOR.classify_scan_outcome([], second), "complete")

    def test_manifest_only_duration_does_not_require_pillow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            media.mkdir()
            (media / "clip.mp4").write_bytes(b"video")
            manifest = root / "data" / "library.json"
            original_import = builtins.__import__

            def without_pillow(name, *args, **kwargs):
                if name == "PIL" or name.startswith("PIL."):
                    raise ImportError("Pillow unavailable")
                return original_import(name, *args, **kwargs)

            with mock.patch("builtins.__import__", side_effect=without_pillow), \
                    mock.patch.object(GENERATOR.shutil, "which", return_value="ffprobe"), \
                    mock.patch.object(GENERATOR, "probe_video_duration", return_value=7.25):
                result = GENERATOR.generate(media, None, 480, 80, manifest_path=manifest, thumbnails=False)
            self.assertEqual(result["metadataRecords"]["clip.mp4"]["duration"], 7.25)
            self.assertEqual(result["metadataWarnings"], 0)

    def test_image_exif_backfills_after_pillow_becomes_available(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            media.mkdir()
            image_path = media / "photo.jpg"
            Image.new("RGB", (2, 2), "green").save(image_path)
            manifest = root / "data" / "library.json"
            original_import = builtins.__import__

            def without_pillow(name, *args, **kwargs):
                if name == "PIL" or name.startswith("PIL."):
                    raise ImportError("Pillow unavailable")
                return original_import(name, *args, **kwargs)

            with mock.patch("builtins.__import__", side_effect=without_pillow):
                unavailable = GENERATOR.generate(media, None, 480, 80,
                    manifest_path=manifest, thumbnails=False)
            self.assertEqual(unavailable["metadataRecords"]["photo.jpg"], {})

            summary = {"captureDate": 1789221600000, "cameraModel": "Recovered"}
            with mock.patch.object(GENERATOR, "extract_metadata", return_value=summary) as extract:
                recovered = GENERATOR.generate(media, None, 480, 80,
                    manifest_path=manifest, thumbnails=False)
            self.assertEqual(extract.call_count, 1)
            self.assertEqual(recovered["metadataRecords"]["photo.jpg"]["captureDate"], 1789221600000)
            sidecar = manifest.parent / "exif.d" / "photo.jpg.json"
            self.assertEqual(json.loads(sidecar.read_text(encoding="utf-8"))["cameraModel"], "Recovered")


if __name__ == "__main__":
    unittest.main()
