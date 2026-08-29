# Large-library resilience

FolderFrame remains a static client-side gallery: no PHP, database, or required
server-side thumbnail service. Optional pre-generated WebP files can be served
as ordinary static assets. Deploy `resilience.js` with `app.js`, `settings.js`,
and the existing assets. No configuration migration is needed.

## Limits and behavior

| Work | Limit |
| --- | --- |
| Directory listing, including body | 15 seconds per request |
| Media/HEIC download or initial native-media load | 30 seconds |
| Video stall without progress | 30 seconds; paused video is exempt |
| HEIC decode/preview processing after download | 30 seconds before reporting failure |
| Shared HEIC processing | 2 active jobs; queued viewer work has priority |
| Orphaned queued job | 250 ms grace for reattachment |
| Viewer converted-image cache | 32 entries / 64 MiB of Blob data |
| HEIC thumbnail cache | 128 entries / 16 MiB; maximum 480-pixel edge |
| Existing config / metadata deadlines | 8 seconds / 8 seconds for the metadata batch |

Directory listings receive a longer budget than config/metadata because large
listings can have substantial response bodies. Queue waiting time does not count
as decoding time. Limits are named constants/defaults in app.js and resilience.js,
not additional JSON settings.

### Large grid rendering

Libraries above 100 media items render incrementally. FolderFrame maintains a
window of at most 300 media tiles in the DOM and uses top/bottom spacers to keep
the scrollbar representative of the complete gallery. Scrolling near either
edge moves the window forward or backward without changing `mediaFiles` or
viewer indexes. This bounds grid DOM/layout work but does not eliminate the
cost of downloading and parsing a very large HTML directory listing.

Album folders are hidden only after a successful listing confirms they contain
neither supported direct media nor child folders. Failed or timed-out listings
retain their album tile.

## Cancellation and recovery

New navigation cancels superseded scans. Grid teardown disconnects observers,
releases image leases, and clears native media sources. Leaving or changing the
viewer cancels its loading work and watchdog. Late callbacks cannot replace a
newer image. Intentional cancellation is not presented as an error.

A running slideshow skips a failed/stalled file after the existing three-second
error delay. Manual browsing stays on the error card. Retry reloads the file.
Videos have no total-duration limit: progressing playback resets the stall timer.

Background refresh updates file order and counts without resetting the active
image, zoom, pan, video position, slideshow timing, or hidden controls when that
file remains present. A successful scan confirming removal selects a replacement.

## Partial scans

A failed root scan retains the previous usable gallery. During recursive scans,
successful folders remain available and old files below failed folders are retained,
not treated as deleted. A persistent grid warning identifies failed folders and
offers Retry scan. A partial scan is not reported as an empty library.

Warnings appear in the interactive grid; controls-free embeds keep their UI hidden.

## HEIC sharing and memory

Viewer and thumbnail consumers share in-flight conversions. A cached full-resolution
image can supply a thumbnail. A cached thumbnail cannot replace a full-resolution
viewer image; opening it may require another conversion.

Thumbnails preserve aspect ratio without upscaling. Downscaling reduces retained
memory, not original download/decode cost. Normal JPEG/PNG/WebP/GIF thumbnails
continue to use the original files.

Least-recently-used unpinned entries are evicted. Active viewer/near-visible
thumbnail leases protect object URLs from premature revocation. Cache budgets
exclude browser decoded surfaces and active pinned entries; they are not hard
limits on total browser memory. This Blob cache is session-only and distinct
from the persistent modification-date cache.

Queued work loses its final consumer only after a 250 ms grace window. Orphaned
downloads are aborted immediately. Already-running decoding is governed solely
by its processing deadline and can be rejoined before timeout.

**Decoder limitation:** heic2any does not expose reliable cancellation of an active
decode. On timeout, consumers fail and a console warning is emitted, but the slot
remains occupied until the actual job settles. If both slots are stuck, pending
HEIC requests fail promptly with reload guidance. Ordinary images/videos continue.
Reload to recover permanently stuck decoders; this is not hard worker termination.

## Device testing checklist

Automated tests cover logic and simulated timing, not real decoder performance,
browser layout, or memory usage. Before declaring device validation complete:

- Open a large mixed-format album and scroll away/back through HEIC previews.
- Open a HEIC from its thumbnail, return to the grid, and repeat quickly.
- Switch folders during slow loading; the latest destination must win.
- Let a slideshow run while adding files; the current image must not reset.
- Test a missing/inaccessible subfolder in All Pics; good files should remain.
- Test a stalled/broken image and video, both paused and during a slideshow.
- Pause a video for more than 30 seconds; it should not report a stall.
- Repeat navigation on a phone and watch for flicker, stale images, or steadily
  growing memory; test an embedded/controls-free display too.
