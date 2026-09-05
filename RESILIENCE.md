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
| Native viewer JPEG/PNG/WebP/GIF display | 2 active full-resolution loads |
| Native grid/album thumbnail display | 12 active loads; album work has priority over grid work within the thumbnail queue |
| Orphaned queued job | 250 ms grace for reattachment |
| Viewer converted-image cache | 32 entries / 64 MiB of Blob data |
| HEIC thumbnail cache | 128 entries / 16 MiB; maximum 480-pixel edge |
| Existing config / metadata deadlines | 8 seconds / 8 seconds for the metadata batch |

Directory listings receive a longer budget than config/metadata because large
listings can have substantial response bodies. Queue waiting time does not count
as decoding time. Limits are named constants/defaults in app.js and resilience.js,
not additional JSON settings.

An ignored subtree is terminated when its directory listing contains
`folderframe.ignore` (or the server-visible `.frameignore` alias). No extra probe
request is made for every live folder: album cards use their existing lazy cover
lookup and recursive scans use their normal listing request. The Python generator
can inspect the filesystem directly, so it prunes ignored children before writing
thumbnails or manifest records. Common OS/NAS junk names are filtered in both
paths, and the browser scan-cache version is bumped when these semantics change.

Ordinary browser-decoded images use a separate four-slot queue. The queue gates
native image source assignment so a newly visible grid cannot ask a phone, Pi,
or low-power display to decode hundreds of large JPEG/PNG/WebP/GIF files at
once. Viewer work has first priority, album covers second, and grid tiles third;
already-running loads finish normally. Leaving a viewer, removing a virtualized
tile, or moving an unsettled tile outside preload range cancels its queued work.
The existing 30-second media/thumbnail watchdogs release stalled slots.

### Progressive scan rebuild frequency

Progressive publishing (see below) now updates the grid incrementally rather
than always doing a full `renderGridView()` teardown-and-rebuild.
`updateGridView()` checks whether a publish only ever adds files to the tail
of `mediaFiles` — true by construction for non-`filename` sort modes, and
verified directly (by comparing old and new array contents up through the
currently-rendered window) for `filename` mode, where re-sorting can in
principle insert a new file anywhere. When that check passes, `appendTiles()`
grows the DOM/spacer in place: pure append if there's still room under the
`GRID_WINDOW_SIZE` budget, or a slide via the same `renderMediaWindow`
prepend/release logic already used for scroll-driven updates if the window is
already at capacity at the tail. Already-rendered, already-loaded thumbnails
are left completely untouched in both cases. Any publish that fails the
safety check — or arrives for a stale/mismatched grid session — falls back to
the original full rebuild. The publish threshold (400 newly discovered files)
and 2-second minimum gap between publishes are unchanged and still bound how
often a publish fires at all, independent of which path it then takes.

### Large grid rendering

Libraries above 100 media items render incrementally. FolderFrame maintains a
window of at most 300 media tiles in the DOM and uses top/bottom spacers to keep
the scrollbar representative of the complete gallery. Scrolling near either
edge moves the window forward or backward without changing `mediaFiles` or
viewer indexes. This bounds grid DOM/layout work but does not eliminate the
cost of downloading and parsing a very large HTML directory listing.

Sibling folders discovered during a recursive ("All Pics") scan are scanned by
a bounded worker pool of size `SCAN_SIBLING_CONCURRENCY` (default 5) over a
shared frontier list, instead of sequentially one at a time or via naive
recursive scheduling. A worker handles exactly one directory listing, pushes
any discovered subfolders back onto the shared frontier, and returns
immediately — it never blocks awaiting its own descendants, which is what
makes this deadlock-free: a design where a scheduled task recursively awaits
`Promise.all` of children scheduled onto the same bounded queue can deadlock
once enough parent branches occupy every slot while waiting on children that
can never be dequeued. This applies on manifest-miss/cold-scan paths — where a
live directory listing has to be fetched — and materially speeds up deep
trees such as an Immich `year/date/` export. A determinate progress bar
accompanies the scan status text once the top-level sibling folder count is
known from the initial listing, filling as each top-level subtree completes
(success, failure, or already-visited skip); it hides again once the scan
finishes or falls outside the "All Pics" recursive mode. `onBatch`, called
once per scanned directory, can fire concurrently across workers; this
remains safe only because the `publishDiscovered` closure it feeds in
`loadGallery` performs no `await` inside its own body.

Automated app-level coverage exercises a deep/wide synthetic tree under a
deadlock timeout, enforces the five-request ceiling, verifies top-level
completion accounting, isolates a failed branch, and confirms cancellation
does not start queued folders. Device validation against a large live Immich
tree remains recommended because browser, server, disk, and network timing are
outside the Node harness.

Album folders are hidden only after a successful listing confirms they contain
neither supported direct media nor child folders. Failed or timed-out listings
retain their album tile.

### Optional scan manifest

Sources configured with `"scanCache": true` retain a lean browser-local manifest.
Each visited directory is validated with the same 15-second request budget using
HTTP `Last-Modified`; unchanged parsed listings can be reused while changed or
unverifiable directories take the full-scan path. Invalid, unavailable, or full
localStorage never prevents scanning. New navigation still aborts validation and
listing requests, so cached work cannot supersede the active folder.

### Optional persistent media index

A source with `manifestPath` first requests a companion-generated, chunked JSON
index. Valid entries supply paths, mtimes, sizes, folder relationships, and
optional generated-preview locations without downloading directory-listing HTML
or issuing per-file metadata HEAD requests. The small root index is refreshed
for each gallery scan; top-level chunks load only when their subtree is needed.
Navigation cancellation applies to both index and chunk requests.

Missing, invalid, timed-out, or unreadable index data is a visible console
diagnostic, never an empty gallery: FolderFrame falls back to its normal
directory scan. A bad chunk falls back only for that subtree. Refresh Folder
explicitly bypasses persistent and browser-local manifests. The Python helper
uses atomic writes and reuses records for unchanged directory mtimes; if the
appdata index is deleted, its next run logs a full rebuild and recreates it.

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

Exception: when the currently open album itself returns HTTP 404 or 410, it is
confirmed removed or renamed rather than treated as a transient/descendant failure.
FolderFrame stops playback, clears the stale view, replaces the saved album with
its parent, and offers navigation to the parent or gallery root. Timeouts, network
errors, server errors, and recursive descendant failures retain usable content.

Warnings appear in the interactive grid; controls-free embeds keep their UI hidden.
A successfully scanned album with no remaining supported media is reported as an
empty album with Previous location and Gallery root actions; it does not show
web-server troubleshooting intended for an unavailable source.

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

FolderFrame sniffs downloaded ISO-BMFF data before HEIC conversion. A QuickTime
container mislabeled `.heic` is reclassified as an Apple Live Photo motion clip
and reuses the downloaded bytes in the video viewer, so `heic2any` is never called
and the viewer does not download the file twice. Browser codec support still
applies: HEVC may play in Safari but fail in Chrome, Firefox, or Windows setups.
For an ordinary image extension that fails native decoding, one best-effort
64-byte Range request performs the same sniff. A server that ignores Range is
accepted; CORS, timeout, or network failure falls back to the normal image error.

## Device testing checklist

Automated tests cover logic and simulated timing, not real decoder performance,
browser layout, or memory usage. Before declaring device validation complete:

- Open a large mixed-format album and scroll away/back through HEIC previews.
- Open a HEIC from its thumbnail, return to the grid, and repeat quickly.
- Open a genuine HEIC still and a `.heic`-named QuickTime/HEVC Live Photo motion
  component; verify only the motion file uses video and codec-specific guidance.
- Switch folders during slow loading; the latest destination must win.
- Let a slideshow run while adding files; the current image must not reset.
- Test a missing/inaccessible subfolder in All Pics; good files should remain.
- Delete or rename the currently open album; confirm Parent folder and Gallery
  root recoveries work and reloading the base URL does not retry the dead path.
- Repeat removal during an active slideshow; playback must stop without advancing
  through repeated missing-media errors.
- Test a stalled/broken image and video, both paused and during a slideshow.
- Pause a video for more than 30 seconds; it should not report a stall.
- Repeat navigation on a phone and watch for flicker, stale images, or steadily
  growing memory; test an embedded/controls-free display too.
