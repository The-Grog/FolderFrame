# Thumbnail cache benchmark

Run `python tests/benchmark_thumbnail_cache.py --entries 3000000` for an opt-in,
synthetic-only benchmark. It uses temporary local files and removes them on exit.
Allow several GiB of RAM and at least 2 GiB of free temporary storage at this size.

## Local result, 2026-11-19

Windows host, bundled Python 3.12.14, local temporary storage, 3,000,000 synthetic
video-poster validation records with source signatures and generation settings:

| Measurement | Result |
| --- | --- |
| Initial JSON size | 780,000,047 bytes |
| Load JSON | 5.18 seconds |
| Build retained map sharing existing records | 0.48 seconds |
| Compare unchanged contents | 0.33 seconds |
| Unchanged cache bytes written | 0 |
| One-record-change replacement | 18.45 seconds; 780,000,068 bytes |
| Peak process working set | 3,577.79 MiB |

This is a cache-component benchmark, not a three-million-media scan or Unraid/ARM
performance validation. It excludes EXIF caches, manifest structures, directory
traversal, decoding and network storage. A full scan can require substantially
more memory. Measurements are host-specific; there is no claim of a universal
supported library size or low-RAM compatibility at this scale.

The regression suite separately covers more than the old 200,000-entry limit,
zero JSON writes on unchanged fixture scans, a one-image change preserving other
manifest chunks, cache repair, record removal, incomplete discovery, and status
publication despite unchanged manifests. Existing old cache records remain usable;
entries already discarded by the former cap may require one final regeneration.
