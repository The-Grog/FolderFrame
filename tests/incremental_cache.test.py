"""Synthetic-only regressions for uncapped, content-aware JSON publication."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from PIL import Image

SPEC = importlib.util.spec_from_file_location("generator", Path(__file__).resolve().parents[1] / "generate_thumbnails.py")
G = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(G)

class IncrementalCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.media = self.root / "media"
        self.media.mkdir()
        self.thumbs = self.root / "thumbs"
        self.manifest = self.root / "data/library.json"
        for folder in ("one", "two"):
            (self.media / folder).mkdir()
            Image.new("RGB", (8, 8)).save(self.media / folder / "photo.jpg")
        (self.media / "one/clip.mp4").write_bytes(b"synthetic video")
        def poster(source, target, *args):
            target.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (8, 8)).save(target, "WEBP")
        for patch in (mock.patch.object(G.shutil, "which", side_effect=lambda name: name),
                      mock.patch.object(G, "probe_video_duration", return_value=2),
                      mock.patch.object(G, "generate_video_poster", side_effect=poster)):
            patch.start()
            self.addCleanup(patch.stop)

    def scan(self):
        result = G.generate(self.media, self.thumbs, 480, 80, manifest_path=self.manifest)
        G.write_manifest(self.media, self.thumbs, self.manifest,
                         result["changedDirectories"], result["metadataRecords"])
        return result

    def test_unchanged_scan_performs_no_json_writes_and_preserves_timestamps(self):
        self.scan()
        before = {p: (p.stat().st_mtime_ns, p.read_bytes()) for p in self.root.rglob("*.json")}
        with mock.patch.object(G, "atomic_json", wraps=G.atomic_json) as writes:
            result = self.scan()
        self.assertEqual(result["created"], 0)
        self.assertEqual(result["current"], 3)
        writes.assert_not_called()
        self.assertEqual(before, {p: (p.stat().st_mtime_ns, p.read_bytes()) for p in before})

    def test_one_change_only_rewrites_affected_chunk_and_caches(self):
        self.scan()
        index = G.read_json(self.manifest)
        unchanged_chunk = self.manifest.parent / index["chunks"]["two"]["file"]
        Image.new("RGB", (12, 12), "blue").save(self.media / "one/photo.jpg")
        with mock.patch.object(G, "atomic_json", wraps=G.atomic_json) as writes:
            result = self.scan()
        paths = [call.args[0] for call in writes.call_args_list]
        self.assertEqual(result["created"], 1)
        self.assertNotIn(unchanged_chunk, paths)
        self.assertNotIn(self.thumbs / ".thumbnail-failures.json", paths)
        self.assertIn(self.manifest.parent / index["chunks"]["one"]["file"], paths)
        with mock.patch.object(G, "atomic_json", wraps=G.atomic_json) as writes:
            self.scan()
        writes.assert_not_called()

    def test_manifest_upgrade_discovers_existing_videos_without_tools_or_mtime_changes(self):
        names = ("root.AVI", "one/clip.WMV", "one/clip.ASF", "one/clip.MPG",
                 "two/clip.MPEG", "two/clip.MKV", "two/clip.3GP", "two/clip.3G2")
        for name in names:
            (self.media / name).write_bytes(b"synthetic video")
        old_media_types = G.IMAGE_TYPES | {".mp4", ".mov", ".webm", ".m4v"}
        with mock.patch.object(G, "MEDIA_TYPES", old_media_types):
            old = G.write_manifest(self.media, None, self.manifest)
        self.assertEqual(old["files"], 3)
        index = G.read_json(self.manifest)
        del index["mediaDiscoveryRevision"]
        G.atomic_json(self.manifest, index)

        update = G.write_manifest(self.media, None, self.manifest)
        self.assertEqual(update["files"], 3 + len(names))
        index = G.read_json(self.manifest)
        paths = {record["path"] for record in index["root"]["files"]}
        for descriptor in index["chunks"].values():
            chunk = G.read_json(self.manifest.parent / descriptor["file"])
            for directory in chunk["directories"].values():
                paths.update(record["path"] for record in directory["files"])
        self.assertTrue(set(names) <= paths)
        with mock.patch.object(G, "atomic_json", wraps=G.atomic_json) as writes:
            stable = G.write_manifest(self.media, None, self.manifest)
        self.assertEqual(stable["listed"], 0)
        writes.assert_not_called()

    def test_cache_retains_more_than_old_limit(self):
        path = self.root / "large.json"
        entries = {f"{i}.mp4": {"success": True} for i in range(200001)}
        G.write_thumbnail_cache(path, entries)
        loaded = G.read_json(path)
        self.assertEqual(len(loaded["entries"]), 200001)
        with mock.patch.object(G, "atomic_json") as writes:
            G.write_thumbnail_cache(path, entries, loaded)
        writes.assert_not_called()

    def test_missing_corrupt_and_wrong_version_caches_are_repaired(self):
        self.scan()
        path = self.thumbs / ".thumbnail-cache.json"
        for value in (None, "not json", '{"version":999,"entries":{}}'):
            if value is None:
                path.unlink()
            else:
                path.write_text(value)
            self.scan()
            self.assertEqual(len(G.read_thumbnail_cache(path)), 3)
            with mock.patch.object(G, "atomic_json", wraps=G.atomic_json) as writes:
                self.scan()
            writes.assert_not_called()

    def test_incomplete_scan_keeps_unvisited_cache_records(self):
        self.scan()
        cache_paths = [self.thumbs / ".thumbnail-cache.json", self.manifest.parent / "exif.d/.metadata-cache.json"]
        before = {p: p.read_bytes() for p in cache_paths}
        original_walk = G.os.walk
        def incomplete(path, *args, **kwargs):
            if Path(path) == self.media:
                kwargs["onerror"](OSError("temporary discovery failure"))
                yield str(self.media), [], []
            else:
                yield from original_walk(path, *args, **kwargs)
        with mock.patch.object(G.os, "walk", side_effect=incomplete):
            result = G.generate(self.media, self.thumbs, 480, 80, manifest_path=self.manifest)
        self.assertEqual(result["thumbnailsPruned"], 0)
        self.assertEqual(before[cache_paths[0]], cache_paths[0].read_bytes())
        previous_entries = json.loads(before[cache_paths[1]])["entries"]
        retained_entries = G.read_json(cache_paths[1])["entries"]
        self.assertEqual(retained_entries, {
            key: {**entry, "manifestNeedsReconciliation": True}
            for key, entry in previous_entries.items()
        })

    def test_incomplete_publication_recovers_metadata_on_next_healthy_scan(self):
        Image.new("RGB", (8, 8)).save(self.media / "root.jpg")
        (self.media / "root.mp4").write_bytes(b"synthetic root video")
        with mock.patch.object(G, "extract_metadata", return_value={"captureDate": 1700000000000}):
            self.scan()

        def records():
            index = G.read_json(self.manifest)
            files = list(index["root"]["files"])
            for descriptor in index["chunks"].values():
                chunk = G.read_json(self.manifest.parent / descriptor["file"])
                for directory in chunk["directories"].values():
                    files.extend(directory["files"])
            return {entry["path"]: entry for entry in files}

        before = records()
        for folder in (self.media, self.media / "one"):
            stat = folder.stat()
            (folder / "notes.txt").write_text("non-media change")
            os.utime(folder, ns=(stat.st_atime_ns, stat.st_mtime_ns + 2000000000))
        original_walk = G.os.walk
        def incomplete(path, *args, **kwargs):
            if Path(path) == self.media:
                kwargs["onerror"](OSError("temporary enumeration failure"))
                yield str(self.media), [], []
            else:
                yield from original_walk(path, *args, **kwargs)
        with mock.patch.object(G.os, "walk", side_effect=incomplete):
            self.scan()  # Includes manifest publication, which can read the directories again.
        with mock.patch.object(G, "extract_metadata", side_effect=AssertionError("must reuse EXIF")), \
                mock.patch.object(G, "probe_video_duration", side_effect=AssertionError("must reuse duration")):
            self.scan()
        self.assertEqual(records(), before, "a healthy scan must repair fields lost during partial publication")
        entries = G.read_metadata_cache(self.manifest.parent / "exif.d/.metadata-cache.json", True)
        self.assertTrue(all("manifestNeedsReconciliation" not in entry for entry in entries.values()))
        for record in records().values():
            if record.get("exifPath"):
                self.assertTrue((self.manifest.parent / record["exifPath"]).is_file())
        with mock.patch.object(G, "atomic_json", wraps=G.atomic_json) as writes:
            self.scan()
        writes.assert_not_called()

    def test_complete_scan_removes_deleted_records(self):
        self.scan()
        (self.media / "one/clip.mp4").unlink()
        self.scan()
        self.assertNotIn("one/clip.mp4", G.read_thumbnail_cache(self.thumbs / ".thumbnail-cache.json"))
        self.assertNotIn("one/clip.mp4", G.read_metadata_cache(self.manifest.parent / "exif.d/.metadata-cache.json", True))

    def test_empty_invalid_cache_and_missing_chunk_are_republished(self):
        self.scan()
        index = G.read_json(self.manifest)
        chunk = self.manifest.parent / index["chunks"]["two"]["file"]
        chunk.unlink()
        self.scan()
        self.assertTrue(chunk.is_file())
        path = self.thumbs / ".thumbnail-failures.json"
        path.write_text("broken")
        self.scan()
        self.assertEqual(G.read_json(path)["failures"], {})

    def test_atomic_failure_keeps_old_file_and_can_retry(self):
        path = self.root / "cache.json"
        G.write_thumbnail_cache(path, {"photo.jpg": {"success": True}})
        before = path.read_bytes()
        previous = G.read_json(path)
        entries = {"photo.jpg": {"success": True}, "clip.mp4": {"success": True}}
        with mock.patch.object(G.os, "replace", side_effect=OSError("replacement unavailable")):
            G.write_thumbnail_cache(path, entries, previous)
        self.assertEqual(path.read_bytes(), before)
        G.write_thumbnail_cache(path, entries, previous)
        self.assertEqual(G.read_thumbnail_cache(path), entries)

    def test_scan_status_still_updates_when_library_does_not(self):
        self.scan()
        status = self.root / "status.json"
        args = ["generate_thumbnails.py", str(self.media), str(self.thumbs), "--manifest", str(self.manifest), "--status-file", str(status)]
        with mock.patch("sys.argv", args):
            self.assertEqual(G.main(), 0)
        previous = G.read_json(status)
        with mock.patch("sys.argv", args), mock.patch.object(G, "atomic_json", wraps=G.atomic_json) as writes:
            self.assertEqual(G.main(), 0)
        self.assertEqual([c.args[0] for c in writes.call_args_list], [status])
        self.assertNotEqual(previous["completedAt"], G.read_json(status)["completedAt"])

if __name__ == "__main__":
    unittest.main()
