# Configuring FolderFrame

Edit `folderframe.config.json` beside `index.html`; no JavaScript edits or
build step are needed. Reload the page after saving. The app fetches this
file without using its HTTP cache on each startup.

The supplied file keeps the main gallery and embed paused in the folder grid.
The main gallery remembers preferences; the supplied embed profile does not.

## Start the embed playing automatically

Replace the `embed` section in the supplied file with:

```json
"embed": {
  "autoplay": true,
  "interval": 10,
  "shuffle": true,
  "rememberPreferences": false
}
```

This is a section of the file, not a standalone JSON document. Keep the other
sections and use valid JSON: double quotes, no comments, and no trailing commas.
Open `embed.html` to try it. It loads the same gallery inside an iframe using
`?profile=embed`; it does not maintain a second copy of the viewer code.

For your own iframe, point at the gallery's index URL with `?profile=embed`.
Loading the index directly without that parameter uses the `index` profile,
even if another page puts it inside an iframe. Both profiles use the same UI.

Set the same fields under `index` to change normal gallery startup instead.
Set `autoplay` to `false` to start paused in the grid when controls are enabled. Autoplay opens the full
viewer and starts the slideshow when the selected folder/view contains media;
it does not automatically descend into albums in folder mode. Use `album` or
`view: "all"` if the desired images are in subfolders.

Browser restrictions still apply to video autoplay, particularly with sound,
and fullscreen. Configuration does not bypass them or request fullscreen on
page load; use the Fullscreen or TV Mode button for a user-initiated request.

## Controls-free slideshow

Set `controls: false` in `defaults`, `index`, or `embed` (default: `true`).
For an unattended embed, replace its section with:

```json
"embed": {
  "controls": false,
  "autoplay": true,
  "view": "all",
  "interval": 10,
  "rememberPreferences": false
}
```

This is a section, not a complete configuration file. It hides the gallery
grid, title bar, navigation, progress bar, hints, native video controls, and
media-error cards. Keyboard shortcuts and photo zoom/pan are disabled.
Videos are muted in this mode; browser autoplay restrictions can still apply.
Errors in a running slideshow skip after 3 seconds. Empty libraries still show
a noninteractive message, and configuration warnings remain visible.

Controls-free mode opens the viewer even with autoplay off; use autoplay on
for an unattended slideshow. It does not change the selected album/view:
use `view: "all"` to include subfolders. Controls visibility is not saved in
browser preferences. Override with `?profile=embed&controls=0&autoplay=1`,
or use `controls=1` and reload to restore the controls.

## Add media sources

`sources` is an array of named web directories. For example:

```json
{
  "sources": [
    { "id": "photos", "label": "Photos", "path": "photos/" },
    { "id": "family", "label": "Family library", "path": "/family-media/" }
  ],
  "defaults": { "source": "photos", "interval": 5 },
  "index": { "rememberPreferences": true },
  "embed": {
    "source": "family",
    "view": "all",
    "autoplay": true,
    "rememberPreferences": false
  }
}
```

Replace example paths with directories actually served by your web server.
A Source selector appears in the gallery header when multiple sources exist.
Each source is browsed separately; All Pics searches the current source, not
all configured sources. Changing the selector reloads the gallery at the new
source root and retains the profile and other explicit URL options.

- `id`: unique letters, numbers, hyphens, or underscores; used in `?source=ID`.
- `label`: display name for the selector and root breadcrumb.
- `path`: an HTTP(S) web directory. Relative paths such as `photos/` resolve
  beside index.html; `/family-media/` resolves from the server root. Paths with
  spaces are supported. A trailing slash is added when omitted.
- `thumbnailPath` (optional): a parallel HTTP(S) directory containing WebP
  previews. It follows the same URL and CORS rules as `path`.

### Optional generated thumbnails

For a large library, configure a parallel preview directory:

```json
{ "id": "photos", "label": "Photos", "path": "photos/", "thumbnailPath": "thumbnails/" }
```

`photos/Trips/a.jpg` maps to `thumbnails/Trips/a.jpg.webp`. FolderFrame uses
these files only for grid tiles and album covers. If a preview is absent or
fails, the original image (or normal HEIC conversion) loads automatically. The
full viewer always uses original media.

Install Pillow and run the optional helper whenever media changes:

```bash
python -m pip install Pillow
python generate_thumbnails.py photos thumbnails
```

Install `pillow-heif` too for HEIC/HEIF input. The helper preserves nested
folders, uses the first GIF frame, skips current outputs, and never modifies
originals. The output directory must be served at the configured
`thumbnailPath`; it does not need directory listings.

A disk or network path such as `C:\Photos` or a UNC share cannot be scanned
directly by the browser. Map it to a web-server directory first. Each source
and its album folders must provide HTML directory listings with child links.
FolderFrame ignores parent links and links outside the directory being scanned.

Absolute HTTP(S) URLs are supported, but a different origin must permit CORS
for directory requests and fetched media such as HEIC files. Cross-origin
credentials are not sent by the app's fetch calls. HTTPS pages should use
HTTPS sources to avoid mixed-content blocking. A working local path does not
guarantee that a remote source's headers or authentication are compatible.

This configuration is publicly readable when the app is hosted publicly.
Do not put secrets in it. Source URLs with embedded credentials, query strings,
or fragments are rejected. Configuring a source does not grant access or
replace server authentication and filesystem permissions.

## Settings and precedence

The top-level sections are `sources`, `defaults`, `index`, and `embed`.
`defaults` supplies shared settings; `index` and `embed` override them.
Omitted settings retain the lower-priority value.

| Setting | Built-in default | Values |
| --- | --- | --- |
| `source` | First configured source | A configured source ID |
| `album` | `""` (source root) | Folder path within that source, e.g. `"Family/2026"` |
| `view` | `"folders"` | `"folders"` or `"all"` |
| `sort` | `"filename"` | `"newest"`, `"oldest"`, or `"filename"` |
| `autoplay` | `false` | Boolean: start slideshow and enter viewer |
| `controls` | `true` | Boolean: false opens a controls-free viewer; pair with autoplay for a slideshow |
| `showFilenames` | `true` | Boolean: show viewer filename and grid media captions |
| `showDownloadButton` | `true` | Boolean: show Download for the original served media |
| `showCopyButton` | `true` | Boolean: show Copy Image for displayed photos |
| `showButtonLabels` | `false` | Boolean: show text beside viewer toolbar icons |
| `interval` | `5` | Seconds: 3, 5, 10, 15, 30, 60, 300, 900, or 3600 |
| `imageMode` | `"fit"` | `"fit"` or `"original"` |
| `shuffle` | `false` | Boolean |
| `autoRefresh` | `true` | Boolean: enable automatic rescanning |
| `refreshInterval` | Index: `120`; embed: `300` | Integer seconds, 1–86400; config only |
| `tvMode` | `false` | Boolean: TV controls and photo-frame preset |
| `rememberPreferences` | `true` for index; `false` for embed | Boolean: read/write saved settings |

Precedence, from lowest to highest:

1. Built-in defaults.
2. `defaults` in the configuration file.
3. The selected `index` or `embed` section.
4. Saved browser preferences, when enabled.
5. Explicit URL options.

Saved preferences include album, sort, interval, image sizing, view mode, shuffle,
and auto-refresh. They are isolated by app location, profile, source
ID, and source URL. Slideshow play/pause itself is not saved: `autoplay`
controls startup. Source selection is represented by the URL, not saved as a
global preference. Legacy preferences are imported only for the original
Photos source in the index profile.

To ensure config changes always win over old browser preferences, set
`rememberPreferences: false` in that profile, or use `?remember=0`. This ignores
stored preferences without deleting them. Storage being unavailable in an
iframe or privacy mode does not prevent the gallery from running.

`tvMode: true` supplies fit sizing, shuffle, auto-refresh, and autoplay as a
preset. Explicit fields in the same or a higher-priority layer override those
values. For example, `?tv=1&autoplay=0` keeps TV mode but starts paused.
Setting `tv=0` disables TV mode; use the other URL options if you also want to
override shuffle or autoplay that was configured separately.

## URL overrides

Set `showFilenames: false` in defaults, index, or embed to hide the viewer's
filename and grid media captions. Album names, accessible media labels, and
error details remain available. This is a display preference, not a privacy
or access-control feature. It is not saved in browser preferences.
Override it with `?showFilenames=0` or `?showFilenames=1`.

Set `showDownloadButton` or `showCopyButton` to `false` under `defaults`,
`index`, or `embed` to remove either viewer action. Override them with
`?download=0/1` and `?copy=0/1`. These settings control presentation, not
access: anyone who can view a media file can still request its URL directly.
Download targets the original served file, including HEIC and video. Copy Image
places the displayed photo on the clipboard as PNG, including HEIC after browser
conversion, and is disabled for video. Browsers may open rather than save
cross-origin downloads. Image clipboard writes can require HTTPS, permission,
and CORS access when media comes from another origin.
Copy Image is disabled on ordinary `http://LAN-IP` pages because arbitrary
clipboard writes require a secure context. Serve FolderFrame through HTTPS or
use a browser-trusted localhost context.

Primary viewer toolbar buttons use icons only by default. Interval, Download,
and Copy Image stay labeled inside the right-side three-dot options menu. Set
`showButtonLabels: true` under `defaults`, `index`, or `embed` to display text
on the primary buttons. Override it with `?buttonLabels=1` or return to icons
with `?buttonLabels=0`. Tooltips and accessible names remain available.

TV mode is not restored from saved browser preferences. Exiting fullscreen
turns TV mode off and pauses its slideshow. Explicit config tvMode defaults
or tv=1 URLs still apply on reload; use tv=0 to override them.

| URL option | Meaning |
| --- | --- |
| `profile=index` or `profile=embed` | Select startup profile; default is index |
| `source=ID` | Select a configured source |
| `album=Family/2026` | Select an album within the source |
| `view=folders` or `view=all` | Album browsing or recursive media view |
| `sort=newest`, `sort=oldest`, or `sort=filename` | Media order; default filename |
| `autoplay=1` or `autoplay=0` | Start playing or paused |
| `controls=1` or `controls=0` | Show controls or use the controls-free viewer |
| `showFilenames=1` or `showFilenames=0` | Show or hide viewer filenames and media captions |
| `download=1` or `download=0` | Show or hide the original-media Download button |
| `copy=1` or `copy=0` | Show or hide the Copy Image button |
| `buttonLabels=1` or `buttonLabels=0` | Show text labels or use icon-only viewer buttons |
| `interval=10` | Slideshow interval in seconds |
| `imageMode=fit` or `imageMode=original` | Initial image sizing |
| `shuffle=1` or `shuffle=0` | Enable or disable Shuffle |
| `autorefresh=1` or `autorefresh=0` | Enable or disable rescanning |
| `tv=1` or `tv=0` | Enable or disable TV mode |
| `remember=1` or `remember=0` | Enable or disable saved preferences |

Examples: `?profile=embed&autoplay=1&view=all` or
`?source=photos&album=test1&remember=0`. URL options select only configured
sources; they cannot inject a new source URL. Encode spaces as `%20` and
literal `&` or `#` characters as `%26` or `%23` in album names.

## Sorting defaults

The gallery button between By Folder and Auto Refresh displays the active sort
and cycles Newest → Oldest → Filename. Set `sort` under `defaults` for both
profiles, or override it independently in `index` and `embed`. For example,
this complete minimal config uses oldest first in index and filenames in embed:

```json
{
  "defaults": { "sort": "newest" },
  "index": { "sort": "oldest" },
  "embed": { "sort": "filename", "rememberPreferences": false }
}
```

Merge these settings into your existing file to retain any custom sources.
Saved preferences override config when enabled; use `?remember=0` to test
defaults, or `?sort=newest` for an explicit override.

Newest/Oldest use the server's HTTP Last-Modified timestamp, not EXIF capture
time or creation time. Files without valid dates sort last by filename in
both date modes; ties also use natural filename order (2 before 10).
Album folders stay first, sorted by name; album cover selection stays
filename-based. Non-shuffled slideshows follow the selected media order.

Date lookup uses HEAD requests (no media bodies), up to four concurrently,
with an eight-second budget for each metadata pass. Missing, failed, blocked,
or timed-out dates fall back to filename order. Metadata is cached in localStorage
for 24 hours, capped at 2,000 entries per app location/source. Oldest checked
entries are evicted first. Index and embed share the same source cache; other
sources use separate keys. Refresh Folder bypasses the cache when date sorting
is selected. Filename mode skips metadata loading and HEAD requests entirely.

The cache survives reloads/browser restarts, retaining dates and media URLs,
not image data. Missing dates are cached too; Refresh Folder can retry them.
Expired entries are discarded on the next date sort, not by a background timer.
Clear site storage to remove persistent metadata. This cache is independent of
rememberPreferences and remember=0. Corrupt/denied/full storage does not prevent
sorting: a bounded in-memory cache remains available. Cache misses retain the
four-request concurrency limit and eight-second total timeout.
Cross-origin servers must permit HEAD requests and expose Last-Modified to
the browser. Copying/editing files can change their modified dates.

## Mobile and embedded layouts

No separate mobile configuration is needed. The same index/embed settings apply
on phones and desktops; layout follows the gallery viewport width (the iframe's
width when embedded). At 560 CSS pixels or less, structured phone headers apply,
Reset Zoom is hidden, and the routine grid timestamp is hidden. Scan errors remain
visible. Switching Fit/Original resets zoom and pan.

Fullscreen and video autoplay depend on browser support, user interaction, and
iframe permissions; config cannot bypass those restrictions. `controls: false`
hides the entire interface and mutes video, regardless of viewport size.

## Configuration errors

Loading deadlines and HEIC cache/queue limits are internal constants, not JSON
settings. No configuration migration is required. Deploy resilience.js with the
other app assets; see [RESILIENCE.md](RESILIENCE.md) for recovery behavior and limits.

A missing, unreadable, malformed, invalid, or timed-out config (8 seconds) causes a visible notice
and a fallback to built-in defaults (`photos/`). Correct the file and reload.
Unknown settings, invalid types, unsupported intervals, and duplicate source
IDs are rejected so misspellings are not silently accepted. Invalid URL
options are ignored with a notice; valid options still apply.

There is no in-browser config editor. Editing the JSON file changes startup
defaults; the existing controls still change the current session normally.

## Refresh frequency and long slideshows

`refreshInterval` sets automatic folder rescanning in **seconds**: index defaults
to 120 (two minutes), embed to 300 (five minutes). Allowed values are integers
from 1 to 86400. It is a config-only setting, not a saved browser preference
or URL option. `autoRefresh: false` disables automatic rescanning.

Set it under `defaults` for both profiles or under `index`/`embed` separately:

```json
"index": { "refreshInterval": 120 },
"embed": { "refreshInterval": 300 }
```

This is a configuration fragment; keep your other sections and settings.
Profile entries override shared defaults, including the explicit entries in
the shipped file. Choose shorter refresh periods for frequently changing media
and longer periods for stable photo-frame displays or many devices sharing one
host. Each display scans independently. Refresh Folder still scans immediately;
returning to a visible tab also triggers a scan when Auto Refresh is enabled.

Slideshow `interval` is separate: 300, 900, and 3600 seconds appear as **5m**,
**15m**, and **60m** in the viewer. These values also work in config, saved
preferences, and the `interval` URL option. They control photo duration;
videos advance on completion during a slideshow.

Filename is now the default sort. Existing saved sort choices or explicit URL
options still take precedence; use `?remember=0` to test config defaults.
