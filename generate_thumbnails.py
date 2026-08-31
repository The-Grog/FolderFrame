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

IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"}
MEDIA_TYPES = IMAGE_TYPES | {".mp4", ".mov"}
MANIFEST_VERSION = 1


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


def generate(media_root: Path, thumb_root: Path, size: int, quality: int) -> tuple[int, int, int, set]:
    try:
        from PIL import Image, ImageOps
    except ImportError as error:
        raise SystemExit("Pillow is required. Install it with: python -m pip install Pillow") from error
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass

    created = current = failed = 0
    changed_directories = set()
    for source in media_root.rglob("*"):
        if not source.is_file() or source.suffix.lower() not in IMAGE_TYPES:
            continue
        target = thumb_root / (source.relative_to(media_root).as_posix() + ".webp")
        if target.exists() and target.stat().st_mtime >= source.stat().st_mtime:
            current += 1
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(source) as image:
                image.seek(0)
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
            print(f"Skipped {source}: {error}")
    return created, current, failed, changed_directories


def directory_record(media_root: Path, relative: str, old_record, thumb_root: Optional[Path], counters: dict,
        force: bool = False):
    directory = media_root / relative if relative else media_root
    stat = directory.stat()
    mtime_ns = stat.st_mtime_ns
    if not force and isinstance(old_record, dict) and old_record.get("mtimeNs") == mtime_ns and \
            isinstance(old_record.get("files"), list) and isinstance(old_record.get("folders"), list):
        counters["reused"] += 1
        return old_record

    files, folders = [], []
    with os.scandir(directory) as entries:
        for entry in entries:
            entry_path = f"{relative}/{entry.name}" if relative else entry.name
            try:
                if entry.is_dir(follow_symlinks=False):
                    folders.append(entry.name)
                elif entry.is_file(follow_symlinks=False) and Path(entry.name).suffix.lower() in MEDIA_TYPES:
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

    counters = {"listed": 0, "reused": 0, "errors": []}
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
    failed = 0
    changed_thumbnail_dirs = set()
    if not args.manifest_only:
        created, current, failed, changed_thumbnail_dirs = generate(media_root, thumb_root, args.size, args.quality)
        print(f"Generated {created}; already current {current}; failed {failed}")
    if args.manifest:
        counters = write_manifest(media_root, thumb_root, args.manifest.resolve(), changed_thumbnail_dirs)
        print(f"Manifest updated; listed {counters['listed']} changed directories; reused {counters['reused']}; errors {len(counters['errors'])}")
        if counters["errors"]:
            failed += len(counters["errors"])
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
