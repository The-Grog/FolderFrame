"""Fixture-only video poster cache/publication regressions."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest
from unittest import mock
from PIL import Image

SPEC = importlib.util.spec_from_file_location("posters_generator", Path(__file__).resolve().parents[1] / "generate_thumbnails.py")
G = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(G)


class PosterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.media = self.root / "media"
        self.media.mkdir()
        self.thumbs = self.root / "thumbs"
        self.manifest = self.root / "data" / "library.json"
        (self.media / "nested").mkdir()
        for name in ("root.MP4", "nested/clip.mov"):
            (self.media / name).write_bytes(b"synthetic-video")
        self.calls = []
        self.tools = mock.patch.object(G.shutil, "which", side_effect=lambda name: name)
        self.tools.start()
        self.addCleanup(self.tools.stop)
        self.probe = mock.patch.object(G, "probe_video_duration", return_value=0.1)
        self.probe.start()
        self.addCleanup(self.probe.stop)

    def poster(self, source, target, tool, size, quality, duration):
        self.calls.append((source, size, quality, duration))
        target.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (32, 48), "blue").save(target, "WEBP")

    def scan(self, **kwargs):
        result = G.generate(self.media, self.thumbs, kwargs.pop("size", 480), 80,
            manifest_path=self.manifest, **kwargs)
        G.write_manifest(self.media, self.thumbs, self.manifest,
            result["changedDirectories"], result["metadataRecords"])
        return result

    def records(self):
        index = G.read_json(self.manifest)
        records = index["root"]["files"][:]
        for chunk in index["chunks"].values():
            for directory in G.read_json(self.manifest.parent / chunk["file"])["directories"].values():
                records.extend(directory["files"])
        return {entry["path"]: entry for entry in records}

    def test_backfill_reuse_source_settings_missing_and_removed_poster(self):
        G.write_manifest(self.media, self.thumbs, self.manifest)
        mtimes = [path.stat().st_mtime_ns for path in (self.media, self.media / "nested")]
        with mock.patch.object(G, "generate_video_poster", side_effect=self.poster):
            first = self.scan()
            self.assertEqual(first["created"], 2)
            for name, record in self.records().items():
                self.assertEqual(record["thumbnailPath"], name + ".webp")
            second = self.scan()
            self.assertEqual(second["current"], 2)
            self.assertEqual(len(self.calls), 2)
            self.assertEqual(second["changedDirectories"], set())
            (self.thumbs / "root.MP4.webp").unlink()
            self.scan()
            self.assertEqual(len(self.calls), 3)
            self.scan(size=240)
            self.assertEqual(len(self.calls), 5)
            (self.media / "root.MP4").write_bytes(b"different-source")
            self.scan(size=240)
            self.assertEqual(len(self.calls), 6)
        self.assertEqual(mtimes, [path.stat().st_mtime_ns for path in (self.media, self.media / "nested")])
        with mock.patch.object(G, "generate_video_poster", side_effect=ValueError("corrupt")):
            (self.media / "root.MP4").write_bytes(b"broken-source")
            result = self.scan(size=240)
        self.assertEqual(result["failed"], 1)
        self.assertIsNone(self.records()["root.MP4"]["thumbnailPath"])

    def test_failure_cached_and_settings_retry_without_repeated_warning(self):
        with mock.patch.object(G, "generate_video_poster", side_effect=subprocess.TimeoutExpired("ffmpeg", 15)) as run:
            first = self.scan()
            second = self.scan()
            self.assertEqual(run.call_count, 2)
            self.assertEqual(first["failed"], 2)
            self.assertEqual(second["failed"], 0)
            self.assertEqual(second["skippedFailures"], 2)
            self.assertEqual(G.classify_scan_outcome([], second), "complete")
            self.scan(size=240)
            self.assertEqual(run.call_count, 4)

    def test_missing_tool_recovers_without_failure_entries(self):
        with mock.patch.object(G.shutil, "which", return_value=None), mock.patch.object(G, "generate_video_poster") as run:
            result = self.scan()
            self.assertEqual(result["failed"], 0)
            run.assert_not_called()
        with mock.patch.object(G, "generate_video_poster", side_effect=self.poster):
            self.assertEqual(self.scan()["created"], 2)

    def test_disable_retains_unchanged_posters_and_images_continue(self):
        with mock.patch.object(G, "generate_video_poster", side_effect=self.poster):
            self.scan()
        Image.new("RGB", (4, 4)).save(self.media / "photo.jpg")
        with mock.patch.object(G, "generate_video_poster") as run:
            result = self.scan(video_thumbnails=False)
            run.assert_not_called()
        self.assertEqual(result["created"], 1)
        self.assertEqual(result["current"], 2)
        self.assertTrue(self.records()["root.MP4"]["thumbnailPath"])
        (self.thumbs / "root.MP4.webp").unlink()
        self.scan(video_thumbnails=False)
        self.assertIsNone(self.records()["root.MP4"]["thumbnailPath"])
        with mock.patch.object(G, "generate_video_poster") as run:
            self.scan(thumbnails=False)
            run.assert_not_called()

    def test_posters_participate_in_safe_orphan_pruning(self):
        with mock.patch.object(G, "generate_video_poster", side_effect=self.poster):
            self.scan()
        (self.media / "root.MP4").unlink()
        with mock.patch.object(G, "generate_video_poster", side_effect=self.poster):
            result = self.scan()
        self.assertEqual(result["thumbnailsPruned"], 1)
        self.assertTrue((self.thumbs / "nested/clip.mov.webp").is_file())

    def test_disabled_or_missing_tool_does_not_clear_completed_failure(self):
        with mock.patch.object(G, "generate_video_poster", side_effect=ValueError("corrupt")) as run:
            self.scan()
            self.scan(video_thumbnails=False)
            with mock.patch.object(G.shutil, "which", return_value=None):
                self.scan()
            result = self.scan()
        self.assertEqual(run.call_count, 2)
        self.assertEqual(result["skippedFailures"], 2)
        self.assertEqual(result["failed"], 0)

    def test_atomic_frame_fallback_validation_and_arguments(self):
        target = self.thumbs / "poster.webp"
        attempts = []
        def run(command, **options):
            attempts.append(command)
            self.assertFalse(target.exists())
            self.assertNotIn("shell", options)
            self.assertLessEqual(options["timeout"], G.VIDEO_POSTER_TIMEOUT)
            if len(attempts) > 1:
                Image.new("RGB", (32, 48)).save(command[-1], "WEBP")
            return mock.Mock(returncode=0)
        with mock.patch.object(G.subprocess, "run", side_effect=run):
            G.generate_video_poster(self.media / "root.MP4", target, "ffmpeg", 480, 80, 0.1)
        self.assertEqual(attempts[0][attempts[0].index("-ss") + 1], "0.025")
        self.assertEqual(attempts[1][attempts[1].index("-ss") + 1], "0")
        self.assertIn("-an", attempts[0])
        with Image.open(target) as image:
            self.assertEqual(image.size, (32, 48))
        self.assertEqual(list(self.thumbs.glob(".poster-*")), [])
        before = target.read_bytes()
        with mock.patch.object(G.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffmpeg", 15)):
            with self.assertRaises(subprocess.TimeoutExpired):
                G.generate_video_poster(self.media / "root.MP4", target, "ffmpeg", 480, 80)
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(list(self.thumbs.glob(".poster-*")), [])


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "real FFmpeg/ffprobe required")
class RealPosterTests(unittest.TestCase):
    def test_real_corrupt_video_failure_is_cached_and_does_not_hide_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "media"
            media.mkdir()
            (media / "broken.mp4").write_bytes(b"not a video")
            manifest = root / "data/library.json"
            first = G.generate(media, root / "thumbs", 480, 80, manifest_path=manifest)
            self.assertEqual(first["failed"], 1)
            G.write_manifest(media, root / "thumbs", manifest, first["changedDirectories"], first["metadataRecords"])
            self.assertEqual(G.read_json(manifest)["root"]["files"][0]["path"], "broken.mp4")
            self.assertIsNone(G.read_json(manifest)["root"]["files"][0]["thumbnailPath"])
            with mock.patch.object(G, "generate_video_poster") as poster:
                again = G.generate(media, root / "thumbs", 480, 80, manifest_path=manifest)
            poster.assert_not_called()
            self.assertEqual(again["skippedFailures"], 1)
            self.assertEqual(again["failed"], 0)

    def test_real_formats_short_video_rotation_reuse_and_readonly_originals(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "media"
            media.mkdir()
            def ffmpeg(*arguments):
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *arguments],
                    check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            for suffix in ("MP4", "mov", "webm", "m4v"):
                ffmpeg("-f", "lavfi", "-i", "testsrc2=size=160x96:rate=24", "-frames:v", "1",
                    "-c:v", "libvpx-vp9" if suffix == "webm" else "libx264", "-threads", "1",
                    str(media / ("short." + suffix)))
            ffmpeg("-display_rotation", "90", "-i", str(media / "short.mov"), "-c", "copy",
                str(media / "portrait.mov"))
            originals = {path.name: path.read_bytes() for path in media.iterdir()}
            manifest = root / "data/library.json"
            thumbs = root / "thumbs"
            result = G.generate(media, thumbs, 480, 80, manifest_path=manifest)
            self.assertEqual(result["failed"], 0)
            self.assertEqual(result["created"], 5)
            G.write_manifest(media, thumbs, manifest, result["changedDirectories"], result["metadataRecords"])
            for record in G.read_json(manifest)["root"]["files"]:
                self.assertEqual(record["thumbnailPath"], record["path"] + ".webp")
                with Image.open(thumbs / record["thumbnailPath"]) as image:
                    image.load()
                    expected = (96, 160) if record["path"] == "portrait.mov" else (160, 96)
                    self.assertEqual(image.size, expected)
            with mock.patch.object(G, "generate_video_poster", wraps=G.generate_video_poster) as poster:
                again = G.generate(media, thumbs, 480, 80, manifest_path=manifest)
                poster.assert_not_called()
                self.assertEqual(again["current"], 5)
            for path in media.iterdir():
                self.assertEqual(path.read_bytes(), originals[path.name])
            self.assertFalse(list(thumbs.glob(".poster-*")))


if __name__ == "__main__":
    unittest.main()
