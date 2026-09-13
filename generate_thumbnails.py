#!/usr/bin/env python3
"""Generate optional FolderFrame WebP thumbnails and a persistent media manifest."""

import argparse
import hashlib
import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp", ".heic", ".heif"}
MEDIA_TYPES = IMAGE_TYPES | {".mp4", ".mov", ".webm", ".m4v"}
MANIFEST_VERSION = 1
FAILURE_CACHE_VERSION = 1
METADATA_CACHE_VERSION = 1
METADATA_EXTRACTION_REVISION = 1
EXIF_IFD = 34665
GPS_IFD = 34853
EXIF_TAGS = {
    "cameraMake": 271,
    "cameraModel": 272,
    "orientation": 274,
    "dateTime": 306,
    "exposureTime": 33434,
    "fNumber": 33437,
    "iso": 34855,
    "dateTimeOriginal": 36867,
    "dateTimeDigitized": 36868,
    "focalLength": 37386,
    "lensModel": 42036,
}
OFFSET_TAGS = {"DateTimeOriginal": 36881, "DateTimeDigitized": 36882, "DateTime": 36880}
SUBSECOND_TAGS = {"DateTimeOriginal": 37521, "DateTimeDigitized": 37522, "DateTime": 37520}
IGNORE_SENTINELS = {"folderframe.ignore", ".frameignore"}
IGNORED_DIRECTORY_NAMES = {
    "@eadir", "#recycle", "@recycle", "$recycle.bin", ".trash", ".trashes",
    ".appledouble", "__macosx", ".spotlight-v100", ".fseventsd", ".snapshot",
    ".snapshots", "system volume information", "lost+found",
}
IGNORED_FILE_SUFFIXES = (".tmp", ".part", ".partial", ".crdownload", ".download", ".bak", ".old")


def ignored_directory_name(name: str) -> bool:
    normalized = name.casefold()
    return normalized in IGNORED_DIRECTORY_NAMES or normalized.startswith(".trash-")


def ignored_file_name(name: str) -> bool:
    normalized = name.casefold()
    return normalized.startswith(".") or normalized.startswith("~$") or normalized.endswith(IGNORED_FILE_SUFFIXES)


def has_ignore_sentinel(directory: Path) -> bool:
    return any((directory / name).is_file() for name in IGNORE_SENTINELS)


def ignored_child_directory(directory: Path, name: str) -> bool:
    return ignored_directory_name(name) or has_ignore_sentinel(directory / name)


def natural_key(value: str):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value)]


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        handle.write("\n")
    os.replace(temporary, path)


def read_json(path: Path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError, TypeError):
        return None


def clean_exif_string(value):
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if not isinstance(value, str):
        return None
    cleaned = value.strip().rstrip("\x00").strip()
    return cleaned or None


def finite_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError, ZeroDivisionError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def exif_value(exif, sub_ifd, tag):
    try:
        value = sub_ifd.get(tag)
    except Exception:
        value = None
    if value is None:
        try:
            value = exif.get(tag)
        except Exception:
            value = None
    return value


def parse_capture_date(exif, sub_ifd):
    candidates = (
        ("DateTimeOriginal", EXIF_TAGS["dateTimeOriginal"]),
        ("DateTimeDigitized", EXIF_TAGS["dateTimeDigitized"]),
        ("DateTime", EXIF_TAGS["dateTime"]),
    )
    for source, tag in candidates:
        raw = clean_exif_string(exif_value(exif, sub_ifd, tag))
        if not raw:
            continue
        try:
            wall_time = datetime.strptime(raw, "%Y:%m:%d %H:%M:%S")
        except (TypeError, ValueError, OverflowError):
            continue
        offset_raw = clean_exif_string(exif_value(exif, sub_ifd, OFFSET_TAGS[source]))
        offset = None
        if offset_raw and re.fullmatch(r"[+-]\d{2}:\d{2}", offset_raw):
            hours, minutes = int(offset_raw[1:3]), int(offset_raw[4:6])
            if hours < 24 and minutes < 60:
                delta = timedelta(hours=hours, minutes=minutes)
                offset = timezone(-delta if offset_raw[0] == "-" else delta)
        subsecond_raw = clean_exif_string(exif_value(exif, sub_ifd, SUBSECOND_TAGS[source]))
        microseconds = 0
        if subsecond_raw and re.fullmatch(r"\d+", subsecond_raw):
            microseconds = int((subsecond_raw + "000000")[:6])
        aware = wall_time.replace(microsecond=microseconds, tzinfo=offset or timezone.utc)
        details = {
            "source": source,
            "raw": raw,
            "utcAssumed": offset is None,
        }
        if offset_raw:
            details["timezoneOffsetRaw"] = offset_raw
        if offset is not None:
            details["timezoneOffset"] = offset_raw
        if subsecond_raw:
            details["subsecond"] = subsecond_raw
        return int(aware.timestamp() * 1000), details
    return None, None


def gps_coordinate(values, reference, latitude):
    if not isinstance(values, (tuple, list)) or len(values) < 3:
        return None
    degrees, minutes, seconds = (finite_number(value) for value in values[:3])
    if degrees is None or minutes is None or seconds is None:
        return None
    ref = clean_exif_string(reference)
    if ref not in (("N", "S") if latitude else ("E", "W")):
        return None
    coordinate = degrees + minutes / 60 + seconds / 3600
    if ref in ("S", "W"):
        coordinate *= -1
    limit = 90 if latitude else 180
    return coordinate if -limit <= coordinate <= limit else None


def extract_metadata(image, include_gps=True):
    """Return an allowlisted JSON-safe EXIF summary without mutating the image."""
    try:
        original_width, original_height = image.size
        exif = image.getexif()
        if not exif:
            return {}
        try:
            sub_ifd = exif.get_ifd(EXIF_IFD) or {}
        except Exception:
            sub_ifd = {}
        summary = {}
        for key in ("cameraMake", "cameraModel", "lensModel"):
            value = clean_exif_string(exif_value(exif, sub_ifd, EXIF_TAGS[key]))
            if value:
                summary[key] = value
        for key in ("exposureTime", "fNumber", "focalLength"):
            value = finite_number(exif_value(exif, sub_ifd, EXIF_TAGS[key]))
            if value is not None:
                summary[key] = value
        iso = finite_number(exif_value(exif, sub_ifd, EXIF_TAGS["iso"]))
        if iso is not None:
            summary["iso"] = int(iso) if iso.is_integer() else iso
        orientation = finite_number(exif_value(exif, sub_ifd, EXIF_TAGS["orientation"]))
        if orientation is not None:
            summary["orientation"] = int(orientation) if orientation.is_integer() else orientation
        capture_date, capture_details = parse_capture_date(exif, sub_ifd)
        if capture_date is not None:
            summary["captureDate"] = capture_date
            summary["captureDateDetails"] = capture_details
        if include_gps:
            try:
                gps_ifd = exif.get_ifd(GPS_IFD) or {}
            except Exception:
                gps_ifd = {}
            latitude = gps_coordinate(gps_ifd.get(2), gps_ifd.get(1), True)
            longitude = gps_coordinate(gps_ifd.get(4), gps_ifd.get(3), False)
            if latitude is not None and longitude is not None:
                summary["gps"] = {"latitude": latitude, "longitude": longitude}
        # Dimensions alone never qualify a sidecar.
        if summary:
            summary["imageWidth"] = int(original_width)
            summary["imageHeight"] = int(original_height)
        return summary
    except Exception as error:
        print(f"EXIF metadata unavailable: {error}")
        return {}


def read_failure_cache(path: Optional[Path]) -> dict:
    payload = read_json(path) if path else None
    if not isinstance(payload, dict) or payload.get("version") != FAILURE_CACHE_VERSION:
        return {}
    failures = payload.get("failures")
    return failures if isinstance(failures, dict) else {}


def write_failure_cache(path: Optional[Path], failures: dict) -> None:
    if path is None:
        return
    try:
        atomic_json(path, {
            "version": FAILURE_CACHE_VERSION,
            "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "failures": failures,
        })
    except OSError as error:
        print(f"Could not update thumbnail failure cache {path}: {error}")


def read_metadata_cache(path: Optional[Path], include_gps: bool) -> dict:
    payload = read_json(path) if path else None
    if not isinstance(payload, dict) or payload.get("version") != METADATA_CACHE_VERSION or \
            payload.get("extractionRevision") != METADATA_EXTRACTION_REVISION or \
            payload.get("includeGps") is not include_gps:
        return {}
    entries = payload.get("entries")
    return entries if isinstance(entries, dict) else {}


def write_metadata_cache(path: Optional[Path], include_gps: bool, entries: dict) -> bool:
    if path is None:
        return False
    try:
        atomic_json(path, {
            "version": METADATA_CACHE_VERSION,
            "extractionRevision": METADATA_EXTRACTION_REVISION,
            "includeGps": include_gps,
            "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "entries": entries,
        })
        return True
    except (OSError, ValueError) as error:
        print(f"Could not update EXIF metadata cache {path}: {error}")
        return False


def metadata_manifest_fields(summary: dict, sidecar_relative: Optional[str]) -> dict:
    fields = {}
    capture_date = summary.get("captureDate")
    if isinstance(capture_date, int):
        fields["captureDate"] = capture_date
    if sidecar_relative:
        fields["exifPath"] = sidecar_relative
    return fields


def generate(media_root: Path, thumb_root: Optional[Path], size: int, quality: int,
        failure_cache_path: Optional[Path] = None, manifest_path: Optional[Path] = None,
        include_gps: bool = True, thumbnails: bool = True) -> dict:
    try:
        from PIL import Image, ImageOps
    except ImportError as error:
        if thumbnails:
            raise SystemExit("Pillow is required. Install it with: python -m pip install Pillow") from error
        print("EXIF extraction unavailable because Pillow is not installed; writing an mtime-only manifest.")
        return {
            "created": 0, "current": 0, "failed": 0, "skippedFailures": 0,
            "changedDirectories": set(), "metadataRecords": {}, "metadataExtracted": 0,
            "metadataReused": 0, "metadataWarnings": 1,
        }
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass

    created = current = failed = skipped_failures = 0
    metadata_extracted = metadata_reused = metadata_warnings = 0
    changed_directories = set()
    cached_failures = read_failure_cache(failure_cache_path)
    retained_failures = {}
    metadata_enabled = manifest_path is not None
    exif_root = manifest_path.parent / "exif.d" if metadata_enabled else None
    metadata_cache_path = exif_root / ".metadata-cache.json" if exif_root else None
    cached_metadata = read_metadata_cache(metadata_cache_path, include_gps)
    retained_metadata = {}
    metadata_records = {}
    expected_sidecars = set()
    enumeration_errors = []

    def walk_error(error):
        enumeration_errors.append(str(error))
        print(f"Metadata enumeration warning: {error}")

    for root, directories, filenames in os.walk(media_root, onerror=walk_error):
        directory = Path(root)
        if has_ignore_sentinel(directory):
            directories[:] = []
            continue
        directories[:] = [name for name in directories if not ignored_child_directory(directory, name)]
        for filename in filenames:
            source = directory / filename
            if ignored_file_name(filename) or source.suffix.lower() not in IMAGE_TYPES:
                continue
            relative = source.relative_to(media_root).as_posix()
            try:
                source_stat = source.stat()
            except OSError as error:
                if thumbnails:
                    failed += 1
                    print(f"Preview failed for {relative}: {error}")
                if metadata_enabled:
                    enumeration_errors.append(relative)
                    print(f"EXIF metadata unavailable for {relative}: {error}")
                continue
            signature = {"size": source_stat.st_size, "mtimeNs": source_stat.st_mtime_ns}
            directory_relative = source.parent.relative_to(media_root).as_posix() if source.parent != media_root else ""
            cached_entry = cached_metadata.get(relative) if metadata_enabled else None
            metadata_is_current = isinstance(cached_entry, dict) and cached_entry.get("signature") == signature and \
                isinstance(cached_entry.get("metadata"), dict)
            summary = cached_entry["metadata"] if metadata_is_current else None
            needs_metadata = metadata_enabled and not metadata_is_current

            target = thumb_root / (relative + ".webp") if thumbnails and thumb_root else None
            target_is_current = False
            target_check_failed = False
            thumbnail_failure_is_current = False
            if thumbnails:
                try:
                    target_is_current = target.exists() and target.stat().st_mtime_ns >= source_stat.st_mtime_ns
                except OSError as error:
                    failed += 1
                    retained_failures[relative] = signature
                    changed_directories.add(directory_relative)
                    print(f"Preview failed for {relative}: {error}")
                    target_check_failed = True
                if target_is_current:
                    current += 1
                elif cached_failures.get(relative) == signature:
                    skipped_failures += 1
                    retained_failures[relative] = signature
                    thumbnail_failure_is_current = True

            needs_thumbnail = thumbnails and not target_is_current and not target_check_failed and not thumbnail_failure_is_current
            if needs_metadata or needs_thumbnail:
                try:
                    with Image.open(source) as image:
                        if needs_metadata:
                            summary = extract_metadata(image, include_gps)
                            metadata_extracted += 1
                            changed_directories.add(directory_relative)
                        if needs_thumbnail:
                            target.parent.mkdir(parents=True, exist_ok=True)
                            image.seek(0)
                            image.draft("RGB", (size, size))
                            image = ImageOps.exif_transpose(image)
                            if image.mode not in ("RGB", "RGBA"):
                                image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                            image.thumbnail((size, size), Image.Resampling.LANCZOS)
                            image.save(target, "WEBP", quality=quality, method=6)
                            created += 1
                            changed_directories.add(directory_relative)
                except Exception as error:
                    if needs_metadata:
                        summary = {}
                        metadata_extracted += 1
                        metadata_warnings += 1
                        changed_directories.add(directory_relative)
                        print(f"EXIF metadata unavailable for {relative}: {error}")
                    if needs_thumbnail:
                        failed += 1
                        retained_failures[relative] = signature
                        changed_directories.add(directory_relative)
                        print(f"Preview failed for {relative}: {error}")
            elif metadata_is_current:
                metadata_reused += 1

            if metadata_enabled:
                summary = summary if isinstance(summary, dict) else {}
                retained_metadata[relative] = {"signature": signature, "metadata": summary}
                sidecar_relative = f"exif.d/{relative}.json"
                sidecar_path = manifest_path.parent / sidecar_relative
                sidecar_ready = False
                if summary:
                    expected_sidecars.add(sidecar_path.resolve())
                    if metadata_is_current and sidecar_path.is_file():
                        sidecar_ready = True
                    else:
                        try:
                            atomic_json(sidecar_path, summary)
                            sidecar_ready = True
                        except (OSError, ValueError) as error:
                            metadata_warnings += 1
                            print(f"Could not write EXIF sidecar {sidecar_path}: {error}")
                            try:
                                sidecar_path.unlink(missing_ok=True)
                            except OSError as cleanup_error:
                                print(f"Could not remove stale EXIF sidecar {sidecar_path}: {cleanup_error}")
                metadata_records[relative] = metadata_manifest_fields(
                    summary, sidecar_relative if sidecar_ready else None
                )
    if thumbnails:
        write_failure_cache(failure_cache_path, retained_failures)
    if metadata_enabled:
        if not write_metadata_cache(metadata_cache_path, include_gps, retained_metadata):
            metadata_warnings += 1
        if not enumeration_errors and exif_root.exists():
            for sidecar in exif_root.rglob("*.json"):
                if sidecar == metadata_cache_path or sidecar.resolve() in expected_sidecars:
                    continue
                try:
                    sidecar.unlink()
                except OSError as error:
                    metadata_warnings += 1
                    print(f"Could not remove stale EXIF sidecar {sidecar}: {error}")
    return {
        "created": created,
        "current": current,
        "failed": failed,
        "skippedFailures": skipped_failures,
        "changedDirectories": changed_directories,
        "metadataRecords": metadata_records,
        "metadataExtracted": metadata_extracted,
        "metadataReused": metadata_reused,
        "metadataWarnings": metadata_warnings + len(enumeration_errors),
    }


def directory_record(media_root: Path, relative: str, old_record, thumb_root: Optional[Path], counters: dict,
        metadata_records=None, force: bool = False):
    directory = media_root / relative if relative else media_root
    stat = directory.stat()
    mtime_ns = stat.st_mtime_ns
    if has_ignore_sentinel(directory):
        counters["listed"] += 1
        return {"path": relative, "mtimeNs": mtime_ns, "files": [], "folders": [], "ignored": True}
    if not force and isinstance(old_record, dict) and old_record.get("mtimeNs") == mtime_ns and \
            isinstance(old_record.get("files"), list) and isinstance(old_record.get("folders"), list):
        reusable_folders = [name for name in old_record["folders"]
            if not ignored_child_directory(directory, name)]
        reusable_files = [entry for entry in old_record["files"]
            if isinstance(entry, dict) and not ignored_file_name(Path(entry.get("path", "")).name)]
        if len(reusable_folders) == len(old_record["folders"]) and len(reusable_files) == len(old_record["files"]):
            counters["reused"] += 1
            counters["files"] += len(reusable_files)
            return old_record

    files, folders = [], []
    with os.scandir(directory) as entries:
        for entry in entries:
            entry_path = f"{relative}/{entry.name}" if relative else entry.name
            try:
                if entry.is_dir(follow_symlinks=False):
                    if not ignored_child_directory(directory, entry.name):
                        folders.append(entry.name)
                elif entry.is_file(follow_symlinks=False) and not ignored_file_name(entry.name) and Path(entry.name).suffix.lower() in MEDIA_TYPES:
                    file_stat = entry.stat(follow_symlinks=False)
                    thumbnail = None
                    if thumb_root is not None:
                        candidate = thumb_root / (entry_path + ".webp")
                        if candidate.is_file():
                            thumbnail = entry_path + ".webp"
                    file_record = {
                        "path": entry_path,
                        "mtime": int(file_stat.st_mtime * 1000),
                        "size": file_stat.st_size,
                        "thumbnailPath": thumbnail,
                    }
                    if metadata_records:
                        file_record.update(metadata_records.get(entry_path, {}))
                    files.append(file_record)
            except OSError as error:
                counters["errors"].append(entry_path)
                print(f"Manifest skipped {entry.path}: {error}")
    files.sort(key=lambda item: natural_key(item["path"]))
    folders.sort(key=natural_key)
    counters["listed"] += 1
    counters["files"] += len(files)
    return {"path": relative, "mtimeNs": mtime_ns, "files": files, "folders": folders}


def safe_old_chunk(manifest_path: Path, old_index, top_folder: str):
    descriptor = old_index.get("chunks", {}).get(top_folder) if isinstance(old_index, dict) else None
    if not isinstance(descriptor, dict) or not isinstance(descriptor.get("file"), str):
        return {}
    try:
        base = manifest_path.parent.resolve()
        candidate = (base / descriptor["file"]).resolve()
        candidate.relative_to(base)
        payload = read_json(candidate)
        if payload and payload.get("version") == MANIFEST_VERSION and isinstance(payload.get("directories"), dict):
            return payload["directories"]
    except (OSError, ValueError):
        pass
    return {}


def write_manifest(media_root: Path, thumb_root: Optional[Path], manifest_path: Path,
        changed_thumbnail_dirs=None, metadata_records=None) -> dict:
    old_index = read_json(manifest_path)
    if not old_index or old_index.get("version") != MANIFEST_VERSION:
        old_index = {}
        print("Persistent manifest missing or invalid; rebuilding the full index.")
    else:
        print("Loaded persistent manifest; checking directory mtimes for changes.")

    counters = {"listed": 0, "reused": 0, "files": 0, "errors": []}
    old_root = old_index.get("root") if isinstance(old_index, dict) else None
    changed_thumbnail_dirs = changed_thumbnail_dirs or set()
    root_record = directory_record(media_root, "", old_root, thumb_root, counters, metadata_records,
        force="" in changed_thumbnail_dirs)
    chunk_directory = manifest_path.with_name(manifest_path.stem + ".d")
    chunk_directory.mkdir(parents=True, exist_ok=True)
    chunks, live_chunk_files = {}, set()

    for top_folder in root_record["folders"]:
        old_directories = safe_old_chunk(manifest_path, old_index, top_folder)
        directories, stack = {}, [top_folder]
        while stack:
            relative = stack.pop()
            try:
                record = directory_record(media_root, relative, old_directories.get(relative), thumb_root, counters,
                    metadata_records,
                    force=relative in changed_thumbnail_dirs)
            except OSError as error:
                counters["errors"].append(relative)
                print(f"Manifest could not read {relative}: {error}")
                continue
            directories[relative] = record
            children = [f"{relative}/{name}" for name in record["folders"]]
            stack.extend(reversed(children))

        digest = hashlib.sha256(top_folder.encode("utf-8")).hexdigest()[:16]
        chunk_name = f"{digest}.json"
        chunk_path = chunk_directory / chunk_name
        atomic_json(chunk_path, {
            "version": MANIFEST_VERSION,
            "root": top_folder,
            "directories": directories,
        })
        relative_chunk = f"{chunk_directory.name}/{chunk_name}"
        live_chunk_files.add(chunk_path.resolve())
        chunks[top_folder] = {"file": relative_chunk, "directories": len(directories)}

    for old_chunk in chunk_directory.glob("*.json"):
        if old_chunk.resolve() not in live_chunk_files:
            try:
                old_chunk.unlink()
            except OSError as error:
                print(f"Could not remove stale manifest chunk {old_chunk}: {error}")

    payload = {
        "version": MANIFEST_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "root": root_record,
        "chunks": chunks,
        "errors": counters["errors"],
    }
    atomic_json(manifest_path, payload)
    return counters


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate FolderFrame grid thumbnails and an optional persistent manifest.")
    parser.add_argument("media", type=Path, help="Local media directory (for example photos)")
    parser.add_argument("output", type=Path, nargs="?", help="Thumbnail output directory")
    parser.add_argument("--size", type=int, default=480, help="Maximum width/height (default: 480)")
    parser.add_argument("--quality", type=int, default=80, help="WebP quality 1-100 (default: 80)")
    parser.add_argument("--manifest", type=Path, help="Write a persistent manifest index to this JSON file")
    parser.add_argument("--manifest-only", action="store_true", help="Skip thumbnail generation and update only the manifest")
    parser.add_argument("--failure-cache", type=Path,
        help="Cache unchanged thumbnail failures in this JSON file")
    parser.add_argument("--status-file", type=Path,
        help="Write structured scan results to this JSON file")
    gps = parser.add_mutually_exclusive_group()
    gps.add_argument("--include-gps", dest="include_gps", action="store_true",
        help="Include GPS coordinates in generated EXIF sidecars (default)")
    gps.add_argument("--exclude-gps", dest="include_gps", action="store_false",
        help="Exclude GPS coordinates and remove previously generated GPS metadata")
    parser.set_defaults(include_gps=True)
    args = parser.parse_args()
    if not args.media.is_dir():
        parser.error("media must be an existing directory")
    if not args.manifest_only and args.output is None:
        parser.error("output is required unless --manifest-only is used")
    if args.manifest_only and args.manifest is None:
        parser.error("--manifest is required with --manifest-only")
    if args.size < 64 or args.size > 4096 or args.quality < 1 or args.quality > 100:
        parser.error("size must be 64-4096 and quality must be 1-100")

    media_root = args.media.resolve()
    thumb_root = args.output.resolve() if args.output else None
    thumbnail_result = {
        "created": 0,
        "current": 0,
        "failed": 0,
        "skippedFailures": 0,
        "changedDirectories": set(),
        "metadataRecords": {},
        "metadataExtracted": 0,
        "metadataReused": 0,
        "metadataWarnings": 0,
    }
    changed_thumbnail_dirs = set()
    if not args.manifest_only:
        failure_cache_path = args.failure_cache.resolve() if args.failure_cache else None
        thumbnail_result = generate(
            media_root, thumb_root, args.size, args.quality, failure_cache_path,
            args.manifest.resolve() if args.manifest else None, args.include_gps, True
        )
        changed_thumbnail_dirs = thumbnail_result["changedDirectories"]
        print(
            f"Thumbnails generated {thumbnail_result['created']}; "
            f"already current {thumbnail_result['current']}; "
            f"preview failures {thumbnail_result['failed']}; "
            f"unchanged failures skipped {thumbnail_result['skippedFailures']}"
        )
    elif args.manifest:
        thumbnail_result = generate(
            media_root, None, args.size, args.quality, None,
            args.manifest.resolve(), args.include_gps, False
        )
        changed_thumbnail_dirs = thumbnail_result["changedDirectories"]
    if args.manifest:
        print(
            f"EXIF metadata extracted {thumbnail_result.get('metadataExtracted', 0)}; "
            f"reused {thumbnail_result.get('metadataReused', 0)}; "
            f"warnings {thumbnail_result.get('metadataWarnings', 0)}"
        )
    manifest_result = {"listed": 0, "reused": 0, "files": 0, "errors": []}
    if args.manifest:
        manifest_result = write_manifest(
            media_root, thumb_root, args.manifest.resolve(), changed_thumbnail_dirs,
            thumbnail_result.get("metadataRecords", {})
        )
        print(
            f"Manifest updated; media files {manifest_result['files']}; "
            f"listed {manifest_result['listed']} changed directories; "
            f"reused {manifest_result['reused']}; errors {len(manifest_result['errors'])}"
        )

    outcome = "failed" if manifest_result["errors"] else (
        "complete_with_warnings"
        if thumbnail_result["failed"] or thumbnail_result["skippedFailures"] or
            thumbnail_result.get("metadataWarnings", 0)
        else "complete"
    )
    status = {
        "version": 1,
        "completedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "outcome": outcome,
        "mediaFiles": manifest_result["files"] if args.manifest else None,
        "thumbnailsGenerated": thumbnail_result["created"],
        "thumbnailsCurrent": thumbnail_result["current"],
        "previewFailures": thumbnail_result["failed"],
        "unchangedFailuresSkipped": thumbnail_result["skippedFailures"],
        "manifestDirectoriesListed": manifest_result["listed"],
        "manifestDirectoriesReused": manifest_result["reused"],
        "manifestErrors": len(manifest_result["errors"]),
        "metadataExtracted": thumbnail_result.get("metadataExtracted", 0),
        "metadataReused": thumbnail_result.get("metadataReused", 0),
        "metadataWarnings": thumbnail_result.get("metadataWarnings", 0),
    }
    if args.status_file:
        try:
            atomic_json(args.status_file.resolve(), status)
        except OSError as error:
            print(f"Could not update scan status {args.status_file}: {error}")
    summary_prefix = "Scan failed" if outcome == "failed" else "Scan complete"
    print(
        f"{summary_prefix} — {status['mediaFiles'] if status['mediaFiles'] is not None else 'manifest disabled'} media files"
        f" · {status['thumbnailsGenerated']} thumbnails generated"
        f" · {status['previewFailures']} preview failures"
        f" · {status['unchangedFailuresSkipped']} unchanged failures skipped"
        f" · {status['metadataWarnings']} metadata warnings"
    )
    return 1 if outcome == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
