#!/usr/bin/env python3
"""Generate optional FolderFrame WebP thumbnails without changing originals."""

import argparse
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError as error:
    raise SystemExit("Pillow is required. Install it with: python -m pip install Pillow") from error

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pillow_heif = None

SUPPORTED = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"}


def generate(media_root: Path, thumb_root: Path, size: int, quality: int) -> tuple[int, int, int]:
    created = current = failed = 0
    for source in media_root.rglob("*"):
        if not source.is_file() or source.suffix.lower() not in SUPPORTED:
            continue
        target = thumb_root / (str(source.relative_to(media_root)) + ".webp")
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
        except Exception as error:
            failed += 1
            print(f"Skipped {source}: {error}")
    return created, current, failed


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate FolderFrame grid thumbnails.")
    parser.add_argument("media", type=Path, help="Local media directory (for example photos)")
    parser.add_argument("output", type=Path, help="Thumbnail output directory")
    parser.add_argument("--size", type=int, default=480, help="Maximum width/height (default: 480)")
    parser.add_argument("--quality", type=int, default=80, help="WebP quality 1-100 (default: 80)")
    args = parser.parse_args()
    if not args.media.is_dir():
        parser.error("media must be an existing directory")
    if args.size < 64 or args.size > 4096 or args.quality < 1 or args.quality > 100:
        parser.error("size must be 64-4096 and quality must be 1-100")
    created, current, failed = generate(args.media.resolve(), args.output.resolve(), args.size, args.quality)
    print(f"Generated {created}; already current {current}; failed {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
