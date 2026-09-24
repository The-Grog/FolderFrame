import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("generate_thumbnails", ROOT / "generate_thumbnails.py")
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class WritableImage:
    mode = "RGB"
    info = {}

    def __init__(self, _source):
        pass

    @classmethod
    def open(cls, source):
        return cls(source)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def seek(self, _frame):
        pass

    def draft(self, _mode, _size):
        pass

    def thumbnail(self, _size, _resample):
        pass

    def save(self, path, *_args, **_kwargs):
        pathlib.Path(path).write_bytes(b"generated thumbnail")


class BrokenImage:
    @staticmethod
    def open(_source):
        raise ValueError("broken image")


class ThumbnailPruningAndSignatureTests(unittest.TestCase):
    def fake_pillow(self, image_class=WritableImage):
        fake_pil = types.ModuleType("PIL")
        fake_pil.Image = types.SimpleNamespace(
            open=image_class.open,
            Resampling=types.SimpleNamespace(LANCZOS=object()),
        )
        fake_pil.ImageOps = types.SimpleNamespace(exif_transpose=lambda image: image)
        return fake_pil

    def generate(self, media, thumb_root, cache=None, image_class=WritableImage, **kwargs):
        with mock.patch.dict(sys.modules, {"PIL": self.fake_pillow(image_class)}):
            return GENERATOR.generate(
                media, thumb_root, 480, 80, thumbnail_cache_path=cache, **kwargs
            )

    def source(self, media, relative="photo.jpg", content=b"source"):
        path = media / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def cache_entry(self, source, target):
        signature = {"size": source.stat().st_size, "mtimeNs": source.stat().st_mtime_ns}
        return GENERATOR.thumbnail_cache_record(
            source.relative_to(source.parents[len(source.parts)] if False else source.parent), signature, target
        )

    def write_cache(self, cache, relative, source, target):
        signature = {"size": source.stat().st_size, "mtimeNs": source.stat().st_mtime_ns}
        entry = GENERATOR.thumbnail_cache_record(relative, signature, target)
        GENERATOR.write_thumbnail_cache(cache, {relative: entry})

    def test_deleted_source_prunes_orphan_webp_after_complete_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs = root / "media", root / "thumbnails"
            media.mkdir()
            orphan = thumbs / "old.jpg.webp"
            orphan.parent.mkdir(parents=True)
            orphan.write_bytes(b"old")
            result = self.generate(media, thumbs)
            self.assertFalse(orphan.exists())
            self.assertEqual(result["thumbnailsPruned"], 1)

    def test_removed_mount_subtree_prunes_nested_thumbnails_and_empty_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs = root / "media", root / "thumbnails"
            media.mkdir()
            orphan = thumbs / "Photos2" / "16" / "02.jpg.webp"
            orphan.parent.mkdir(parents=True)
            orphan.write_bytes(b"old")
            result = self.generate(media, thumbs)
            self.assertEqual(result["thumbnailsPruned"], 1)
            self.assertFalse(orphan.exists())
            self.assertFalse((thumbs / "Photos2").exists())
            self.assertTrue(thumbs.exists())

    def test_current_source_thumbnail_is_untouched_with_matching_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs, cache = root / "media", root / "thumbnails", root / "cache.json"
            media.mkdir()
            source = self.source(media, "album/current.jpg")
            target = thumbs / "album" / "current.jpg.webp"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"current")
            self.write_cache(cache, "album/current.jpg", source, target)
            result = self.generate(media, thumbs, cache)
            self.assertEqual(result["current"], 1)
            self.assertEqual(result["created"], 0)
            self.assertEqual(target.read_bytes(), b"current")

    def test_non_webp_files_are_never_pruned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs = root / "media", root / "thumbnails"
            media.mkdir()
            note = thumbs / "keep.txt"
            note.parent.mkdir(parents=True)
            note.write_text("do not remove", encoding="utf-8")
            self.generate(media, thumbs)
            self.assertTrue(note.exists())

    def test_directory_enumeration_error_suppresses_pruning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs = root / "media", root / "thumbnails"
            media.mkdir()
            orphan = thumbs / "old.jpg.webp"
            orphan.parent.mkdir(parents=True)
            orphan.write_bytes(b"old")
            original_walk = GENERATOR.os.walk

            def incomplete_walk(path, *args, **kwargs):
                if pathlib.Path(path) == media:
                    kwargs["onerror"](OSError("unavailable mount"))
                    yield str(media), [], []
                else:
                    yield from original_walk(path, *args, **kwargs)

            with mock.patch.object(GENERATOR.os, "walk", side_effect=incomplete_walk):
                result = self.generate(media, thumbs)
            self.assertEqual(result["thumbnailsPruned"], 0)
            self.assertTrue(orphan.exists())

    def test_source_stat_error_suppresses_pruning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs = root / "media", root / "thumbnails"
            media.mkdir()
            source = self.source(media, "unreadable.jpg")
            orphan = thumbs / "old.jpg.webp"
            orphan.parent.mkdir(parents=True)
            orphan.write_bytes(b"old")
            original_walk = GENERATOR.os.walk

            def stat_failure_walk(path, *args, **kwargs):
                if pathlib.Path(path) == media:
                    source.unlink()
                    yield str(media), [], [source.name]
                else:
                    yield from original_walk(path, *args, **kwargs)

            with mock.patch.object(GENERATOR.os, "walk", side_effect=stat_failure_walk):
                result = self.generate(media, thumbs)
            self.assertEqual(result["thumbnailsPruned"], 0)
            self.assertTrue(orphan.exists())

    def test_changed_mount_repoint_signature_regenerates_newer_old_thumbnail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs, cache = root / "media", root / "thumbnails", root / "cache.json"
            media.mkdir()
            source = self.source(media, "Photos2/16/02.jpg", b"old source")
            target = thumbs / "Photos2" / "16" / "02.jpg.webp"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"old preview")
            self.write_cache(cache, "Photos2/16/02.jpg", source, target)
            source.write_bytes(b"repointed source with a different size")
            os.utime(target, ns=(target.stat().st_atime_ns, source.stat().st_mtime_ns + 1_000_000_000))
            result = self.generate(media, thumbs, cache)
            self.assertEqual(result["created"], 1)
            self.assertEqual(target.read_bytes(), b"generated thumbnail")

    def test_matching_success_signature_reuses_thumbnail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs, cache = root / "media", root / "thumbnails", root / "cache.json"
            media.mkdir()
            source = self.source(media)
            target = thumbs / "photo.jpg.webp"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"unchanged")
            self.write_cache(cache, "photo.jpg", source, target)
            result = self.generate(media, thumbs, cache)
            self.assertEqual((result["created"], result["current"]), (0, 1))
            self.assertEqual(target.read_bytes(), b"unchanged")

    def test_changed_source_failure_removes_stale_thumbnail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs, cache = root / "media", root / "thumbnails", root / "cache.json"
            media.mkdir()
            source = self.source(media, content=b"old")
            target = thumbs / "photo.jpg.webp"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"stale")
            self.write_cache(cache, "photo.jpg", source, target)
            source.write_bytes(b"changed source")
            result = self.generate(media, thumbs, cache, image_class=BrokenImage)
            self.assertEqual(result["failed"], 1)
            self.assertFalse(target.exists())

    def test_missing_and_corrupt_success_cache_recovers_safely(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs, cache = root / "media", root / "thumbnails", root / "cache.json"
            media.mkdir()
            self.source(media)
            first = self.generate(media, thumbs, cache)
            self.assertEqual(first["created"], 1)
            cache.write_text("not json", encoding="utf-8")
            second = self.generate(media, thumbs, cache)
            self.assertEqual(second["created"], 1)
            self.assertEqual(json.loads(cache.read_text(encoding="utf-8"))["version"], 1)

    def test_removed_sources_are_dropped_from_success_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs, cache = root / "media", root / "thumbnails", root / "cache.json"
            media.mkdir()
            source = self.source(media)
            self.generate(media, thumbs, cache)
            source.unlink()
            self.generate(media, thumbs, cache)
            self.assertEqual(json.loads(cache.read_text(encoding="utf-8"))["entries"], {})

    def test_symlink_thumbnail_is_not_followed_or_deleted_outside_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs, outside = root / "media", root / "thumbnails", root / "outside.webp"
            media.mkdir()
            thumbs.mkdir()
            outside.write_bytes(b"outside")
            link = thumbs / "escape.webp"
            try:
                os.symlink(outside, link)
            except (NotImplementedError, OSError):
                self.skipTest("symlink creation is unavailable")
            result = self.generate(media, thumbs)
            self.assertTrue(link.is_symlink())
            self.assertEqual(outside.read_bytes(), b"outside")
            self.assertGreaterEqual(result["thumbnailPruneWarnings"], 1)

    def test_thumbnail_only_main_defaults_success_cache_inside_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs = root / "media", root / "thumbs"
            media.mkdir()
            result = {
                "created": 0, "current": 0, "failed": 0, "skippedFailures": 0,
                "thumbnailsPruned": 0, "thumbnailPruneWarnings": 0,
                "changedDirectories": set(), "metadataRecords": {},
                "metadataExtracted": 0, "metadataReused": 0, "metadataWarnings": 0,
            }
            with mock.patch.object(GENERATOR, "generate", return_value=result) as generated:
                with mock.patch.object(sys, "argv", [
                    str(ROOT / "generate_thumbnails.py"), str(media), str(thumbs),
                ]):
                    self.assertEqual(GENERATOR.main(), 0)
            self.assertEqual(
                generated.call_args.args[8],
                (thumbs / ".thumbnail-cache.json").resolve(),
            )

    def test_orphan_prune_warnings_add_to_stale_cleanup_warnings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs, failures = root / "media", root / "thumbs", root / "failures.json"
            media.mkdir()
            source = self.source(media)
            target = thumbs / "photo.jpg.webp"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"stale")
            signature = {"size": source.stat().st_size, "mtimeNs": source.stat().st_mtime_ns}
            GENERATOR.write_failure_cache(failures, {"photo.jpg": signature})
            with mock.patch.object(GENERATOR, "remove_stale_thumbnail", return_value=False), \
                    mock.patch.object(GENERATOR, "prune_orphan_thumbnails", return_value=(3, 2)):
                result = self.generate(media, thumbs, failure_cache_path=failures)
            self.assertEqual(result["thumbnailsPruned"], 3)
            self.assertEqual(result["thumbnailPruneWarnings"], 3)

    def test_status_reports_thumbnails_pruned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs, status = root / "media", root / "thumbs", root / "status.json"
            media.mkdir()
            result = {
                "created": 1, "current": 2, "failed": 0, "skippedFailures": 0,
                "thumbnailsPruned": 12, "thumbnailPruneWarnings": 0,
                "changedDirectories": set(), "metadataRecords": {},
                "metadataExtracted": 0, "metadataReused": 0, "metadataWarnings": 0,
            }
            with mock.patch.object(GENERATOR, "generate", return_value=result), mock.patch.object(sys, "argv", [
                str(ROOT / "generate_thumbnails.py"), str(media), str(thumbs), "--status-file", str(status),
            ]):
                self.assertEqual(GENERATOR.main(), 0)
            self.assertEqual(json.loads(status.read_text(encoding="utf-8"))["thumbnailsPruned"], 12)

    def test_manifest_only_mode_does_not_prune_thumbnails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs = root / "media", root / "thumbnails"
            media.mkdir()
            orphan = thumbs / "old.jpg.webp"
            orphan.parent.mkdir(parents=True)
            orphan.write_bytes(b"old")
            result = self.generate(media, None, thumbnails=False)
            self.assertEqual(result["thumbnailsPruned"], 0)
            self.assertTrue(orphan.exists())

    def test_legacy_metadata_signature_seeds_success_cache_without_regeneration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs, manifest, cache = root / "media", root / "thumbnails", root / "library.json", root / "cache.json"
            media.mkdir()
            source = self.source(media)
            target = thumbs / "photo.jpg.webp"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"legacy")
            signature = {"size": source.stat().st_size, "mtimeNs": source.stat().st_mtime_ns}
            metadata_cache = manifest.parent / "exif.d" / ".metadata-cache.json"
            GENERATOR.write_metadata_cache(metadata_cache, True, {
                "photo.jpg": {"signature": signature, "metadata": {}, "sidecarReady": False}
            })
            result = self.generate(media, thumbs, cache, manifest_path=manifest)
            self.assertEqual((result["created"], result["current"]), (0, 1))
            self.assertIn("photo.jpg", json.loads(cache.read_text(encoding="utf-8"))["entries"])

    def test_failed_decode_still_marks_thumbnail_as_expected_for_pruning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media, thumbs = root / "media", root / "thumbnails"
            media.mkdir()
            self.source(media)
            target = thumbs / "photo.jpg.webp"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"existing")
            result = self.generate(media, thumbs, image_class=BrokenImage)
            self.assertEqual(result["failed"], 1)
            self.assertFalse(target.exists(), "stale preview is removed after a changed-source failure")


if __name__ == "__main__":
    unittest.main()
