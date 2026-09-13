import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from fractions import Fraction
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("generate_thumbnails", ROOT / "generate_thumbnails.py")
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class FakeExif(dict):
    def __init__(self, top=None, exif=None, gps=None):
        super().__init__(top or {})
        self.exif = exif or {}
        self.gps = gps or {}
        self.ifd_calls = []

    def __bool__(self):
        return bool(dict(self)) or bool(self.exif) or bool(self.gps)

    def get_ifd(self, tag):
        self.ifd_calls.append(tag)
        if tag == GENERATOR.EXIF_IFD:
            return self.exif
        if tag == GENERATOR.GPS_IFD:
            return self.gps
        return {}


class FakeImage:
    size = (4032, 3024)

    def __init__(self, exif):
        self.exif = exif

    def getexif(self):
        return self.exif

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class ExifMetadataTests(unittest.TestCase):
    def test_sub_ifd_fields_invalid_date_fallback_and_timezone(self):
        exif = FakeExif(
            top={271: " ACME\x00 ", 272: "Camera X", 274: 6},
            exif={
                36867: "invalid",
                36868: "2026:09:12 14:30:00",
                36882: "+02:30",
                33434: Fraction(1, 125),
                33437: Fraction(28, 10),
                34855: 200,
                37386: Fraction(50, 1),
                42036: "Prime 50",
            },
        )
        summary = GENERATOR.extract_metadata(FakeImage(exif))
        expected = int(datetime(2026, 9, 12, 12, 0, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(summary["captureDate"], expected)
        self.assertEqual(summary["captureDateDetails"], {
            "source": "DateTimeDigitized",
            "raw": "2026:09:12 14:30:00",
            "utcAssumed": False,
            "timezoneOffsetRaw": "+02:30",
            "timezoneOffset": "+02:30",
        })
        self.assertEqual(summary["cameraMake"], "ACME")
        self.assertAlmostEqual(summary["exposureTime"], 0.008)
        self.assertEqual(summary["imageWidth"], 4032)
        self.assertEqual(summary["imageHeight"], 3024)
        self.assertEqual(summary["orientation"], 6)

    def test_offset_free_date_is_deterministic_and_preserves_subseconds(self):
        exif = FakeExif(exif={36867: " 2026:01:02 03:04:05\x00 ", 37521: "25"})
        summary = GENERATOR.extract_metadata(FakeImage(exif))
        expected = int(datetime(2026, 1, 2, 3, 4, 5, 250000, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(summary["captureDate"], expected)
        self.assertTrue(summary["captureDateDetails"]["utcAssumed"])
        self.assertEqual(summary["captureDateDetails"]["subsecond"], "25")

    def test_gps_defaults_on_opt_out_skips_ifd_and_malformed_fields_are_isolated(self):
        class BadNumber:
            def __float__(self):
                raise ValueError("bad")

        exif = FakeExif(
            top={271: "Valid Make"},
            exif={33434: BadNumber()},
            gps={1: "N", 2: (40, 30, 0), 3: "W", 4: (73, 59, 0)},
        )
        summary = GENERATOR.extract_metadata(FakeImage(exif))
        self.assertAlmostEqual(summary["gps"]["latitude"], 40.5)
        self.assertIn(GENERATOR.GPS_IFD, exif.ifd_calls)
        exif.ifd_calls.clear()
        summary = GENERATOR.extract_metadata(FakeImage(exif), include_gps=False)
        self.assertEqual(summary["cameraMake"], "Valid Make")
        self.assertNotIn("exposureTime", summary)
        self.assertNotIn("gps", summary)
        self.assertNotIn(GENERATOR.GPS_IFD, exif.ifd_calls)
        summary = GENERATOR.extract_metadata(FakeImage(exif), include_gps=True)
        self.assertAlmostEqual(summary["gps"]["latitude"], 40.5)
        self.assertAlmostEqual(summary["gps"]["longitude"], -(73 + 59 / 60))

    def test_include_and_exclude_gps_cli_options_are_mutually_exclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = pathlib.Path(directory) / "library.json"
            argv = ["generate_thumbnails.py", directory, "--manifest-only", "--manifest", str(manifest),
                    "--include-gps", "--exclude-gps"]
            with mock.patch.object(sys, "argv", argv), self.assertRaises(SystemExit) as raised:
                GENERATOR.main()
            self.assertEqual(raised.exception.code, 2)

    def test_dimensions_alone_do_not_create_metadata(self):
        self.assertEqual(GENERATOR.extract_metadata(FakeImage(FakeExif())), {})

    def test_cache_backfill_sidecar_repair_policy_change_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            thumbs = root / "thumbs"
            manifest = root / "data" / "custom-name.json"
            media.mkdir()
            thumbs.mkdir()
            source = media / "Family photo #1%.jpg"
            source.write_bytes(b"image")
            thumbnail = thumbs / "Family photo #1%.jpg.webp"
            thumbnail.write_bytes(b"thumb")
            thumbnail.touch()
            opens = []
            exif = FakeExif(top={271: "ACME"}, exif={36867: "2026:09:12 10:00:00"},
                gps={1: "N", 2: (40, 0, 0), 3: "W", 4: (74, 0, 0)})

            class ImageModule:
                class Resampling:
                    LANCZOS = 1

                @staticmethod
                def open(path):
                    opens.append(path)
                    return FakeImage(exif)

            fake_pil = types.ModuleType("PIL")
            fake_pil.Image = ImageModule
            fake_pil.ImageOps = object()
            GENERATOR.write_manifest(media, thumbs, manifest)
            self.assertNotIn("captureDate", json.loads(manifest.read_text(encoding="utf-8"))["root"]["files"][0])
            with mock.patch.dict(sys.modules, {"PIL": fake_pil}):
                first = GENERATOR.generate(media, thumbs, 480, 80, None, manifest, True, True)
                self.assertEqual(len(opens), 1, "current thumbnail still receives metadata backfill")
                relative = source.name
                sidecar = manifest.parent / "exif.d" / f"{relative}.json"
                self.assertTrue(sidecar.is_file())
                self.assertIn("gps", json.loads(sidecar.read_text(encoding="utf-8")))
                GENERATOR.write_manifest(
                    media, thumbs, manifest, first["changedDirectories"], first["metadataRecords"]
                )
                backfilled = json.loads(manifest.read_text(encoding="utf-8"))["root"]["files"][0]
                self.assertIn("captureDate", backfilled)
                self.assertEqual(backfilled["exifPath"], f"exif.d/{relative}.json")

                second = GENERATOR.generate(media, thumbs, 480, 80, None, manifest, True, True)
                self.assertEqual(len(opens), 1, "unchanged metadata is reused")
                sidecar.unlink()
                repaired = GENERATOR.generate(media, thumbs, 480, 80, None, manifest, True, True)
                self.assertEqual(len(opens), 1, "missing sidecar repairs from cache without reopening source")
                self.assertIn("exifPath", repaired["metadataRecords"][relative])

                no_gps = GENERATOR.generate(media, thumbs, 480, 80, None, manifest, False, True)
                self.assertEqual(len(opens), 2, "GPS policy invalidates metadata cache")
                self.assertNotIn("gps", json.loads(sidecar.read_text(encoding="utf-8")))
                self.assertIn("captureDate", no_gps["metadataRecords"][relative])

                gps_backfill = GENERATOR.generate(
                    media, thumbs, 480, 80, manifest_path=manifest, thumbnails=True
                )
                self.assertEqual(len(opens), 3, "default-on GPS backfills an opt-out cache")
                self.assertIn("gps", json.loads(sidecar.read_text(encoding="utf-8")))
                self.assertIn("captureDate", gps_backfill["metadataRecords"][relative])

                source.write_bytes(b"changed image signature")
                GENERATOR.generate(media, thumbs, 480, 80, None, manifest, False, True)
                self.assertEqual(len(opens), 4, "changed source signatures are extracted again")

                source.unlink()
                GENERATOR.generate(media, thumbs, 480, 80, None, manifest, False, True)
                self.assertFalse(sidecar.exists())

    def test_no_exif_attempt_is_cached_during_manifest_only_processing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            manifest = root / "data" / "library.json"
            media.mkdir()
            (media / "plain.jpg").write_bytes(b"image")
            opens = []
            fake_pil = types.ModuleType("PIL")
            fake_pil.Image = types.SimpleNamespace(
                open=lambda path: opens.append(path) or FakeImage(FakeExif())
            )
            fake_pil.ImageOps = object()
            with mock.patch.dict(sys.modules, {"PIL": fake_pil}):
                first = GENERATOR.generate(media, None, 480, 80, None, manifest, False, False)
                second = GENERATOR.generate(media, None, 480, 80, None, manifest, False, False)
            self.assertEqual(len(opens), 1)
            self.assertEqual(first["metadataExtracted"], 1)
            self.assertEqual(second["metadataReused"], 1)
            self.assertFalse((manifest.parent / "exif.d" / "plain.jpg.json").exists())

    def test_sidecar_write_failure_keeps_capture_date_outside_exif_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            media = root / "media"
            manifest = root / "data" / "library.json"
            media.mkdir()
            (media / "photo.jpg").write_bytes(b"image")
            exif = FakeExif(exif={36867: "2026:09:12 10:00:00"})
            fake_pil = types.ModuleType("PIL")
            fake_pil.Image = types.SimpleNamespace(open=lambda _path: FakeImage(exif))
            fake_pil.ImageOps = object()
            original_atomic = GENERATOR.atomic_json

            def fail_sidecar(path, payload):
                if "exif.d" in path.parts and path.name != ".metadata-cache.json":
                    raise OSError("read only")
                return original_atomic(path, payload)

            with mock.patch.dict(sys.modules, {"PIL": fake_pil}), \
                    mock.patch.object(GENERATOR, "atomic_json", side_effect=fail_sidecar):
                result = GENERATOR.generate(media, None, 480, 80, None, manifest, False, False)
            record = result["metadataRecords"]["photo.jpg"]
            self.assertIn("captureDate", record)
            self.assertNotIn("exifPath", record)


if __name__ == "__main__":
    unittest.main()
