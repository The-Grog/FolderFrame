# FolderFrame To-Do

Checked items are implemented. Device-confirmation notes identify remaining
manual checks; automated tests do not verify browser layout or codecs.

## Remaining work

### Album recovery

- [x] **Recover from deleted or renamed albums** — A confirmed HTTP 404/410 for the currently open album stops playback, clears stale media, replaces the saved album with its parent, and offers Parent folder/Gallery root recovery. Transient failures and recursive descendant failures still retain usable content. Automated coverage includes active slideshow recovery, repaired preferences, and descendant 404 isolation; device validation pending.

### Large-library resilience

- [x] **Large-library resilience** — Extend existing bounded metadata/album lookups across the app without requiring a database, PHP, or server-side generated thumbnails. Implemented; device validation pending (see RESILIENCE.md).
  - [x] **Timeouts and recovery** — Bound directory and media loading waits, show actionable errors, and skip stalled files during a running slideshow.
  - [x] **Cancel outdated work** — Cancel unnecessary requests when changing folders or leaving the viewer; ignore late results from superseded work.
  - [x] **Limit HEIC processing** — Queue conversions with a small concurrency limit to avoid overwhelming phone CPU and memory.
  - [x] **Manage memory** — Bound the converted-image cache, release unused object URLs safely, and clean up thumbnail observers across navigation.
  - [x] **Handle partial failures** — Keep successfully discovered media when a subfolder fails and identify which folders could not be scanned.

### Performance and deployment

- [ ] **Large Immich directory support** — Improve scanning, navigation, and rendering for very large media directories exported or mounted from Immich while preserving database-free static hosting.
  - [x] **Incremental and windowed grid** — Render 100 media tiles initially, retain at most 300 media tiles in the DOM, preserve full scroll geometry/order, support reverse and keyboard scrolling, show a Back to Top control, and hide only confirmed-empty albums. Automated with a 15,633-file regression case; Immich device validation pending.
  - [x] **Efficient virtual-window updates** — Overlapping tile nodes, image decode state, and observers now survive 100-item window shifts. Normal scrolling removes and adds only the leaving/entering edges; distant Home/End jumps still replace the bounded window while persistent spacers preserve scroll geometry. Automated reuse and cleanup bounds verified; Immich device validation pending.
  - [x] **Optional persistent media index** — Added a lean appdata-writable, chunked JSON index with directory-mtime reuse, manifest-provided metadata/thumbnail paths, cancellation, live-scan bypass, and safe directory-listing fallback. Automated and generator checks pass; Immich device validation pending.
  - [x] **Bound ordinary image decoding** — JPEG, PNG, WebP, and GIF source assignment now uses a four-slot cancellable priority queue. Viewer images outrank album covers and grid tiles; virtualized/offscreen unsettled work is cancelled. Automated coverage passes; low-power device validation pending.
  - [x] **Progressive directory discovery** — Recursive All Pics scans now use a deadlock-free five-worker pool over a shared directory frontier, with determinate top-level subtree progress. Automated coverage verifies deep/wide completion, the concurrency ceiling, cancellation, partial-failure isolation, and completion accounting; live Immich device validation remains pending.
  - [x] **Sub-folder exclusions** — `folderframe.ignore` (plus `.frameignore` when exposed) excludes a complete subtree across live listings, album-cover discovery, recursive scans, browser caches, generated thumbnails, and published manifests. Conservative OS/NAS junk rules are shared by browser and generator paths; automated coverage passes.
  - [x] **Incremental progressive-scan grid updates** — Progressive publishes now extend the current DOM and virtual-grid spacers in place when the rendered prefix remains unchanged. Filename-sort insertions, stale sessions, and other unsafe cases retain the full-rebuild fallback. Existing tile nodes and decoded thumbnails survive append-only updates; large-library device validation remains pending. See RESILIENCE.md.
- [x] **Thumbnail generation (optional)** — Added per-source `thumbnailPath`, parallel WebP preview lookup for grid/album covers, automatic original fallback, and an optional Pillow generator that preserves static-server hosting. Device validation with a large mixed-format library is pending.
- [ ] **Validate automatic Docker/Unraid thumbnails** — The main CA, Docker, and Compose implementation provides persistent appdata previews, sequential background generation, HEIC/HEIF support, safe delayed pruning, and read-only originals. Verify the released deployment documentation and complete real Unraid device testing.
- [x] **Escape returns to gallery** — Escape exits the image viewer and returns to the thumbnail/album grid without adding another on-screen control.

### Browser and device testing

- [ ] **Final device follow-up** — Confirm the latest slideshow visibility and TV-mode fixes, media failures/loading, and controls-free embeds in the target browsers.
- [ ] **Browser compatibility matrix** — Record browser/OS versions and verify Android/iOS video, fullscreen, storage restrictions, and controls-free embeds. Owner-approved layouts are not a full compatibility matrix.

## Completed

- [x] **Manifest refresh defaults and stale-preview recovery** — Strict manifest sources now default periodic Auto Refresh off while preserving explicit config, saved, TV-mode, and URL choices. Activating a generated preview lazily verifies its original; confirmed 404/410 originals remove the stale tile, while unsupported HEAD, CORS, timeout, and offline failures retain normal viewer recovery.
- [x] **Pinned, unified gallery and viewer headers** — Gallery navigation stays visible while scrolling, grid and viewer controls share compact two-pill geometry, and the viewer uses the dedicated Back control while preserving responsive options-menu behavior.
- [x] **Rotated-image Fit correction** — Fit mode now derives the displayed content dimensions from the image's natural aspect ratio before calculating the 90°/270° rotation scale, avoiding incorrect sizing caused by the container-sized `clientWidth`/`clientHeight` box. Device validation pending.
- [x] **Large-library scanning and grid controls release** — Published `fc9be39` with the deadlock-free five-worker recursive scanner, determinate scan progress, direct album item counts, Compact/Comfortable/Spacious grid density, configuration and documentation updates, and 114 passing automated tests.
- [x] **Grid density control** — Added a cycling Compact/Comfortable/Spacious thumbnail-size button, driven by a `--grid-tile-min` CSS variable shared between the grid's `minmax()` template and the JS virtualizer's row-height math. Persists via saved preferences and a `density` URL/config override. Pure re-layout on toggle — no rescan, no new requests. Device validation pending.
- [x] **Album item counts on grid cards** — Album cards now show a direct child count ("142 photos" / "6 albums") sourced from the same top-level directory listing `findAlbumCover` already fetches for its cover search — no additional requests. Device validation pending.
- [x] **Configurable Download and Copy Image controls** — Download targets the original served media; Copy Image writes displayed photos as PNG and is disabled for video. Both can be enabled independently under defaults/index/embed or with `download=0/1` and `copy=0/1`, retaining browser clipboard and cross-origin restrictions. Interval, Download, and Copy Image are grouped in a right-side options menu; primary viewer controls remain icon-only by default with 44px touch targets.
- [x] **Persistent sorting-date cache** — 24-hour localStorage cache with 2,000 entries per app/source, oldest-first eviction, storage-failure fallback, and Refresh Folder bypass. Persistence, expiry, eviction, and source isolation tests included.
- [x] **Refresh README screenshots** — Replaced viewer and grid previews with user-supplied screenshots of the updated interface. Full viewer first; no browser chrome or hosting URL.
- [x] **README configuration example and settings reference** — Added complete JSON, all settings/defaults, source paths, profile overrides, recursion, autoplay, controls-free mode, and preference/URL precedence. Full details in CONFIGURATION.md.
- [x] **Highlight key features in the overview** — Added a scannable list of implemented gallery, media, slideshow, mobile, embedding, configuration, loading, and hosting features.
- [x] **3rd Party Ai review of code and design** — Completed
- [x] **README roadmap link** — Links to this worklist and the contributing guide.
- [x] **Contributing guide** — Added setup, checks, focused PR guidance, and media privacy notes.
- [x] **Configuration: media paths and startup defaults** — Named sources, index/embed profiles, preferences, and URL overrides. Settings and startup regression coverage included.
- [x] **Clearer error states** — Shared recovery UI for images, HEIC/HEIF, and video. Running slideshows skip errors after 3 seconds; manual browsing stays put.
- [x] **Loading states** — Scan counts, thumbnail placeholders, image/HEIC/video indicators, and distinct empty/failure feedback. Unchanged refreshes retain tiles; controls-free mode hides indicators.
- [x] **Mobile polish** — Structured phone gallery/viewer rows, wider-window wrapping, safe areas, and pinch/pan handling. Phone-width Reset Zoom and routine timestamps are hidden; scan errors remain visible. User approved desktop and phone layouts.
- [x] **Slideshow UI visibility** — Automatic transitions no longer reveal controls or restart their idle timer. Verify latest fix on device.
- [x] **TV mode state** — Exiting fullscreen clears TV mode and pauses its slideshow. Saved preferences no longer restore TV mode; explicit config/URL defaults still apply. Verify latest fix on device.
- [x] **Controls-free slideshow configuration** — controls=false plus autoplay=true enables an unattended viewer with muted video. Documented config and URL overrides.
- [x] **Swipe between photos** — Implemented horizontal swipes for fitted, unzoomed/unpanned photos. Zoomed photos still pan; short/vertical/cancelled gestures do not navigate. User tested and approved.
- [x] **Album cover previews** — Added lazy single-image covers using the first direct image in natural filename order, a blue folder badge, and album-name overlay. Empty/video-only/nested-only albums and preview failures retain the folder icon. Bounded lookups, cancellation, HEIC support, and regression tests included. User supplied updated screenshots for publication.
- [x] **Compact grid header and logo navigation** — Directory breadcrumb sits beside the matching album/file count box. Clicking the logo returns to the current source root in index and embed. Updated README previews and usage instructions.
- [x] **Optional filename display in configuration** — Added showFilenames (default true), shared/index/embed support, and showFilenames=0/1 URL overrides. Hides viewer filenames and media captions, retaining album names, accessible labels, and error details. Published and user-approved.
- [x] **Remember grid scroll position** — Restores the originally opened tile and saved scroll position, with a brief static highlight. Adjusts for moved tiles; falls back to scroll position if removed, and resets on folder navigation. Published and user-approved.
- [x] **Sorting: Newest, Oldest, Filename** — Added the cycling gallery button between By Folder and Auto Refresh; Filename is the default. Config defaults/index/embed, saved preferences, and sort URL overrides supported. Uses bounded/cached Last-Modified HEAD lookups with filename ties and missing dates last. Documented and regression-tested; user supplied updated screenshots for publication.
- [x] **Configurable refresh and long slideshows** — refreshInterval uses seconds, with two-minute index and five-minute embed defaults. Added 5m/15m/60m photo intervals. Documented and tested.

## Validation notes

- User tested and approved the swipe, filename visibility, and grid-return update.
- User tested and approved the mobile double-tap and pinch-flicker fixes.
- Current regression suite: 114 automated app/settings/cache and resilience tests. Run both tests/configuration.test.cjs and tests/resilience.test.cjs.
- User visually tested and approved the long-filename desktop layout. Node tests do not validate CSS layout.
