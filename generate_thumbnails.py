#!/usr/bin/env python3
"""Generate optional FolderFrame WebP thumbnails and a persistent media manifest."""

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp", ".heic", ".heif"}
MEDIA_TYPES = IMAGE_TYPES | {".mp4", ".mov", ".webm", ".m4v"}
MANIFEST_VERSION = 1
FAILURE_CACHE_VERSION = 1
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
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    os.replace(temporary, path)


def read_json(path: Path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError, TypeError):
        return None


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


def generate(media_root: Path, thumb_root: Path, size: int, quality: int,
        failure_cache_path: Optional[Path] = None) -> dict:
    try:
        from PIL import Image, ImageOps
    except ImportError as error:
        raise SystemExit("Pillow is required. Install it with: python -m pip install Pillow") from error
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass

    created = current = failed = skipped_failures = 0
    changed_directories = set()
    cached_failures = read_failure_cache(failure_cache_path)
    retained_failures = {}
    for root, directories, filenames in os.walk(media_root):
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
            target = thumb_root / (relative + ".webp")
            try:
                source_stat = source.stat()
            except OSError as error:
                failed += 1
                print(f"Preview failed for {relative}: {error}")
                continue
            signature = {"size": source_stat.st_size, "mtimeNs": source_stat.st_mtime_ns}
            try:
                target_is_current = target.exists() and target.stat().st_mtime_ns >= source_stat.st_mtime_ns
            except OSError as error:
                failed += 1
                retained_failures[relative] = signature
                changed_directories.add(source.parent.relative_to(media_root).as_posix()
                    if source.parent != media_root else "")
                print(f"Preview failed for {relative}: {error}")
                continue
            if target_is_current:
                current += 1
                continue
            if cached_failures.get(relative) == signature:
                skipped_failures += 1
                retained_failures[relative] = signature
                continue
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                with Image.open(source) as image:
                    image.seek(0)
                    image.draft("RGB", (size, size))
                    image = ImageOps.exif_transpose(image)
                    if image.mode not in ("RGB", "RGBA"):
                        image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                    image.thumbnail((size, size), Image.Resampling.LANCZOS)
                    image.save(target, "WEBP", quality=quality, method=6)
                created += 1
                changed_directories.add(source.parent.relative_to(media_root).as_posix()
                    if source.parent != media_root else "")
            except Exception as error:
                failed += 1
                retained_failures[relative] = signature
                changed_directories.add(source.parent.relative_to(media_root).as_posix()
                    if source.parent != media_root else "")
                print(f"Preview failed for {relative}: {error}")
    write_failure_cache(failure_cache_path, retained_failures)
    return {
        "created": created,
        "current": current,
        "failed": failed,
        "skippedFailures": skipped_failures,
        "changedDirectories": changed_directories,
    }


def directory_record(media_root: Path, relative: str, old_record, thumb_root: Optional[Path], counters: dict,
        force: bool = False):
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
                    files.append({
                        "path": entry_path,
                        "mtime": int(file_stat.st_mtime * 1000),
                        "size": file_stat.st_size,
                        "thumbnailPath": thumbnail,
                    })
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
        changed_thumbnail_dirs=None) -> dict:
    old_index = read_json(manifest_path)
    if not old_index or old_index.get("version") != MANIFEST_VERSION:
        old_index = {}
        print("Persistent manifest missing or invalid; rebuilding the full index.")
    else:
        print("Loaded persistent manifest; checking directory mtimes for changes.")

    counters = {"listed": 0, "reused": 0, "files": 0, "errors": []}
    old_root = old_index.get("root") if isinstance(old_index, dict) else None
    changed_thumbnail_dirs = changed_thumbnail_dirs or set()
    root_record = directory_record(media_root, "", old_root, thumb_root, counters,
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
    }
    changed_thumbnail_dirs = set()
    if not args.manifest_only:
        failure_cache_path = args.failure_cache.resolve() if args.failure_cache else None
        thumbnail_result = generate(media_root, thumb_root, args.size, args.quality, failure_cache_path)
        changed_thumbnail_dirs = thumbnail_result["changedDirectories"]
        print(
            f"Thumbnails generated {thumbnail_result['created']}; "
            f"already current {thumbnail_result['current']}; "
            f"preview failures {thumbnail_result['failed']}; "
            f"unchanged failures skipped {thumbnail_result['skippedFailures']}"
        )
    manifest_result = {"listed": 0, "reused": 0, "files": 0, "errors": []}
    if args.manifest:
        manifest_result = write_manifest(media_root, thumb_root, args.manifest.resolve(), changed_thumbnail_dirs)
        print(
            f"Manifest updated; media files {manifest_result['files']}; "
            f"listed {manifest_result['listed']} changed directories; "
            f"reused {manifest_result['reused']}; errors {len(manifest_result['errors'])}"
        )

    outcome = "failed" if manifest_result["errors"] else (
        "complete_with_warnings"
        if thumbnail_result["failed"] or thumbnail_result["skippedFailures"]
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
    )
    return 1 if outcome == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
