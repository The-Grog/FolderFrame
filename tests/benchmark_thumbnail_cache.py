"""Opt-in synthetic JSON-cache benchmark; no media scan or production data.

Run: python tests/benchmark_thumbnail_cache.py --entries 3000000
Includes full JSON load, record-sharing retained map, no-change comparison,
and one-entry update. Does not model EXIF, filesystem traversal, or decoding.
"""
import argparse
import ctypes
import gc
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time

SPEC = importlib.util.spec_from_file_location("generator", Path(__file__).resolve().parents[1] / "generate_thumbnails.py")
G = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(G)

def peak_mib():
    if os.name == "nt":
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize",
                "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        process = ctypes.windll.kernel32.GetCurrentProcess
        process.restype = wintypes.HANDLE
        get_memory = ctypes.windll.psapi.GetProcessMemoryInfo
        get_memory.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        if not get_memory(process(), ctypes.byref(counters), counters.cb):
            raise ctypes.WinError()
        return counters.PeakWorkingSetSize / 1048576
    import resource
    import sys
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / (1048576 if sys.platform == "darwin" else 1024)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entries", type=int, default=200001)
    args = parser.parse_args()
    if args.entries < 1:
        parser.error("entries must be positive")
    with tempfile.TemporaryDirectory(prefix="folderframe-cache-benchmark-") as directory:
        path = Path(directory) / "thumbnail-cache.json"
        # Seed by streaming so the benchmark measures loading, not fixture construction.
        with path.open("w", encoding="utf-8") as handle:
            handle.write('{"version":1,"updatedAt":"fixture","entries":{')
            for i in range(args.entries):
                name = f"Library/album-{i // 1000:05d}/video-{i:08d}.mp4"
                record = {"path": name, "signature": {"size": 1024000 + i, "mtimeNs": 1700000000000000000 + i},
                    "thumbnailMtimeNs": 1800000000000000000 + i, "success": True,
                    "posterSettings": {"revision": 1, "size": 480, "quality": 80}}
                if i:
                    handle.write(",")
                handle.write(json.dumps(name) + ":" + json.dumps(record, separators=(",", ":")))
            handle.write("}}")
        print(json.dumps({"phase": "seeded", "entries": args.entries, "bytes": path.stat().st_size}), flush=True)
        started = time.perf_counter()
        previous = G.read_json(path)
        load_seconds = time.perf_counter() - started
        entries = previous["entries"]
        started = time.perf_counter()
        retained = {key: record for key, record in entries.items()}
        retain_seconds = time.perf_counter() - started
        before = path.stat().st_mtime_ns
        started = time.perf_counter()
        G.write_thumbnail_cache(path, retained, previous)
        unchanged_seconds = time.perf_counter() - started
        assert path.stat().st_mtime_ns == before
        print(json.dumps({"phase": "unchanged", "load_seconds": load_seconds,
            "retain_seconds": retain_seconds, "compare_seconds": unchanged_seconds,
            "bytes_written": 0, "peak_rss_mib": peak_mib()}), flush=True)
        key = next(iter(retained))
        retained[key] = {**retained[key], "thumbnailMtimeNs": 1900000000000000000}
        started = time.perf_counter()
        G.write_thumbnail_cache(path, retained, previous)
        print(json.dumps({"phase": "one_changed", "write_seconds": time.perf_counter() - started,
            "bytes_written": path.stat().st_size, "peak_rss_mib": peak_mib()}), flush=True)
        del retained, entries, previous
        gc.collect()

if __name__ == "__main__":
    main()
