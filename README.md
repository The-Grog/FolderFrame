<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/folderframe-logo.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/folderframe-logo-light.png">
    <img src="docs/images/folderframe-logo-light.png" alt="FolderFrame" width="220">
  </picture>
</h1>

FolderFrame works as a standalone, self-hosted photo and video gallery or as
an embedded gallery or slideshow within your websites. Use it on its own,
or add it to an existing page with a standard iframe—including an optional
controls-free slideshow mode. No database or PHP required.

Manage one gallery on your host and open it on multiple devices—digital photo
frames, tablets, wall displays, or desktop browsers. Each display can use its
own album and slideshow settings while sharing the same media library.

Make it your own: FolderFrame is MIT-licensed, so you can edit the site and its
files, customize the branding, and adapt it to your needs. Keep the required
copyright and license notice when distributing copies (see [LICENSE](LICENSE)).

[![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-0070ba?logo=paypal&logoColor=white)](https://paypal.me/machogrog)

See the [project roadmap](TODO.md) for planned improvements to thumbnails, performance, mobile controls, and configuration. Interested in helping? Read the [contributing guide](CONTRIBUTING.md).

## Preview

Configure media paths and separate index/embed startup defaults in
[folderframe.config.json](folderframe.config.json). See the
[configuration guide](CONFIGURATION.md) for examples, including autoplay.

### Full media viewer

![FolderFrame full media viewer with slideshow, Shuffle, Fit, Full, and TV Mode controls](docs/images/folderframe-viewer.png)

Compact controls put slideshow playback, Shuffle, Fit, fullscreen, and TV Mode within reach. Controls fade during inactivity; mouse, touch, or keyboard activity brings them back.

### Gallery and album view

![FolderFrame gallery with album cover previews, Newest sorting, and compact neutral controls](docs/images/folderframe-gallery.png)

Browse albums with cover previews and cycle between Newest, Oldest, and Filename sorting.

### Mobile viewer and gallery

<p>
  <img src="docs/images/folderframe-mobile-viewer.png" alt="FolderFrame mobile viewer with compact touch controls and a lunar photograph" width="320">
  <img src="docs/images/folderframe-mobile-gallery.png" alt="FolderFrame mobile gallery with album cover previews and a two-column photo grid" width="320">
</p>

Phone-sized controls keep playback, Shuffle, interval, Fit/Original, fullscreen,
and TV Mode organized above the media. Swipe fitted photos, pinch to zoom, and
drag to pan when zoomed. The mobile gallery pairs a two-column photo grid with
album cover previews and compact browsing controls. Fullscreen availability
varies by mobile browser.

## Overview

This is a lightweight, self-hosted photo and video gallery. It reads the
contents of configured media directories dynamically from the web server’s
directory listing, so there is no database, import process, or manually
maintained media list.

- **Folder-based albums:** thumbnail grid, image cover previews with folder badges, nested albums, breadcrumbs, and recursive All Pics view.
- **Flexible sorting:** Natural Filename order by default, plus Newest and Oldest, with separate index/embed defaults. Date sorting uses server modification dates, not photo capture dates.
- **Photos and videos:** JPEG, PNG, WebP, GIF, HEIC/HEIF conversion, and MP4/MOV playback (browser codec support applies).
- **Slideshow and TV mode:** selectable intervals, Shuffle, fullscreen, automatic rescans, and automatic skipping of failed media.
- **Responsive viewer:** compact mobile controls, pinch zoom, pan, and Fit/Original sizing.
- **Embeddable:** iframe example and an optional controls-free, muted-video slideshow.
- **Configurable startup:** named media sources, separate index/embed defaults, saved preferences, and URL overrides.
- **Clear feedback:** folder scan progress, thumbnail placeholders, media loading indicators, and recovery guidance.
- **Static-server hosting:** no database or build step; works with a web server that supplies HTML directory listings.

## Browser and mobile support

Large libraries use bounded loading, cancelled stale requests, partial-scan
recovery, and separate HEIC viewer/thumbnail caches. See [resilience and testing
notes](RESILIENCE.md) for limits, the stuck-decoder caveat, and device checks.

FolderFrame is designed for modern desktop and mobile browsers, including
Chrome/Edge/Firefox and Safari. Desktop and phone layouts have been manually
tested and approved by the project owner; this is not a certified browser/version
matrix. iOS Safari and other device/browser combinations still need separate
verification, especially video playback, fullscreen, and embedded operation.

- Touch: swipe fitted photos, pinch to zoom, and drag magnified photos to pan.
- Full/TV Mode can request fullscreen, but availability depends on the browser,
  device, user interaction, and iframe permissions. If fullscreen is unavailable,
  the gallery can still run inside the page.
- Video playback depends on codecs and autoplay policy. Sound may require a tap;
  controls-free embeds mute videos. HEIC conversion can be slow on phones.
- This is an online gallery, not an offline app. Keep the page visible for
  unattended slideshows; background or locked-device playback is not guaranteed.
- Private browsing or embedded storage restrictions may prevent preferences
  from being remembered. Explicit config and URL options remain available.

Browser-policy references: [Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API)
and [media autoplay](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay).

## Configuration quick reference

Edit `folderframe.config.json` beside `index.html`, then reload—no server
restart is needed. This complete example keeps the main gallery interactive
and starts the embed as a controls-free slideshow including subfolders:

```json
{
  "sources": [
    { "id": "photos", "label": "Photos", "path": "photos/" }
  ],
  "defaults": {
    "source": "photos",
    "album": "",
    "view": "folders",
    "sort": "filename",
    "interval": 5,
    "imageMode": "fit",
    "shuffle": false,
    "autoRefresh": true,
    "tvMode": false,
    "autoplay": false,
    "controls": true,
    "showFilenames": true,
    "rememberPreferences": true
  },
  "index": { "refreshInterval": 60 },
  "embed": {
    "refreshInterval": 300,
    "view": "all",
    "autoplay": true,
    "controls": false,
    "rememberPreferences": false
  }
}
```

This is an example, not the shipped defaults: the supplied embed starts paused
with controls visible. Each source requires a unique `id`, a display `label`,
and a served web-directory `path`. Use relative paths, server-root paths,
or HTTP(S) directories—not disk/UNC paths. Cross-origin sources require
appropriate CORS headers. This file is publicly readable: never put secrets in it.

Put settings in `defaults` for both profiles or in `index`/`embed` to override them.

| Setting | Built-in default | Allowed values / meaning |
| --- | --- | --- |
| `source` | First configured source | A source ID from `sources` |
| `album` | `""` | Path within the source, e.g. `"Friends/2026"` |
| `view` | `"folders"` | `"folders"` or `"all"` (recursive) |
| `sort` | `"filename"` | `"newest"`, `"oldest"`, or `"filename"` |
| `interval` | `5` | Seconds: 3, 5, 10, 15, 30, 60, 300, 900, 3600 |
| `imageMode` | `"fit"` | `"fit"` or `"original"` |
| `shuffle` | `false` | Boolean |
| `autoRefresh` | `true` | Boolean: enable automatic rescanning |
| `refreshInterval` | Index: `60`; embed: `300` | Integer seconds, 1–86400; config only |
| `tvMode` | `false` | Boolean: fit/shuffle/auto-refresh/autoplay preset |
| `autoplay` | `false` | Boolean: enter viewer and start slideshow |
| `controls` | `true` | Boolean: false opens viewer without controls; videos are muted |
| `showFilenames` | `true` | Boolean: show viewer filename and grid media captions |
| `rememberPreferences` | Index: `true`; embed: `false` | Boolean: read/write browser preferences |

Precedence: built-in defaults → shared defaults → selected profile → saved
preferences (when enabled) → explicit URL options. The supplied config explicitly
disables remembered preferences for embed. TV mode provides a preset; explicit
settings in the same or higher-priority layer override that preset.

Saved preferences cover album, sort, interval, sizing, view, Shuffle, and Auto Refresh;
not TV mode, autoplay, controls visibility, or filename visibility.
Use `rememberPreferences: false` or `?remember=0` to ignore old preferences
without deleting them.

Hide filenames with `showFilenames: false` in defaults/index/embed, or
`?showFilenames=0` (use `showFilenames=1` to show them). Album names,
accessible labels, and error details remain available.

An iframe uses the embed profile only when its URL includes `?profile=embed`.
For example, `?profile=embed&controls=0&autoplay=1&view=all`.
Autoplay uses the selected folder's files; choose `view: "all"` for subfolders.
To restore the controls, use `controls=1`. Browser video-autoplay and fullscreen
restrictions still apply. See [CONFIGURATION.md](CONFIGURATION.md) for source
examples, all URL aliases, validation rules, and full precedence details.

## Refresh frequency and long slideshows

`refreshInterval` sets automatic folder rescanning in **seconds**: index defaults
to 60 (one minute), embed to 300 (five minutes). Allowed values are integers
from 1 to 86400. It is a config-only setting, not a saved browser preference
or URL option. `autoRefresh: false` disables automatic rescanning.

Set it under `defaults` for both profiles or under `index`/`embed` separately:

```json
"index": { "refreshInterval": 60 },
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

## Hosting requirements

Browsers restrict directory scanning when a page is opened with the
file:// protocol. The gallery must be served over HTTP or HTTPS by a web
server that provides directory listings for photos/ and its subfolders.

### Project layout

The photos/ folder included in the GitHub repository contains test photos and
videos for checking various supported media formats. These sample files are
not required to use FolderFrame; replace them with your own media or configure
a different source folder.

Keep the files arranged like this:

    FolderFrame/
    ├── index.html
    ├── embed.html       # Optional iframe example
    ├── docs/images/
    │   └── folderframe-logo.png
    ├── styles.css
    ├── app.js
    ├── resilience.js
    ├── settings.js
    ├── folderframe.config.json
    ├── heic2any.min.js
    └── photos/
        ├── photo1.jpg
        ├── photo2.heic
        ├── video1.mp4
        ├── Family/
        │   ├── birthday.jpg
        │   └── 2026/
        │       └── vacation.jpg
        └── Vacations/
            └── OBX/
                └── beach.jpg

Subfolders under photos/ automatically appear as albums.

### Option 1: Quick local test with Python

Python’s built-in HTTP server is the easiest way to test or use the
gallery on a local machine.

1.  Open a terminal in the FolderFrame project directory.

Example:

    cd /home/grog/projects/FolderFrame

2.  Start the server:

    python3 -m http.server 8000

3.  Open a browser on the same computer and visit:

    http://localhost:8000

4.  To access it from another device on the same LAN, use the server’s
    LAN IP:

    http://SERVER-IP:8000

For example, if the server is 192.168.1.50:

    http://192.168.1.50:8000

Python’s built-in server automatically provides the directory listings
the gallery needs, including listings for nested album folders.

Stop the Python server with Ctrl+C.

NOTE: Python’s built-in server is excellent for testing and trusted
local-network use. For a permanent installation, use any static web
server that can provide directory listings.

### Option 2: Web server or Unraid

FolderFrame is not tied to a specific web server. Caddy, NGINX, lighttpd,
Apache, and similar static servers are suitable when HTML directory browsing
is enabled for the media folders. On Unraid, use any suitable
web-server container and map the FolderFrame directory into its web root.

The web root should contain:

    index.html
    styles.css
    app.js
    resilience.js
    settings.js
    folderframe.config.json
    heic2any.min.js
    docs/images/folderframe-logo.png
    photos/

Configure the server to return a browsable directory listing for photos/
and every nested folder beneath it. The exact setting may be called
directory listing, directory browsing, autoindex, or indexes depending on
the server. FolderFrame only requires normal static-file serving plus
those directory listings; it does not require PHP, a database, or a
server-side application.

On Unraid, map the FolderFrame project directory to the container’s web
root, enable directory listings for photos/, and restart the container.
Consult the selected container or web server’s documentation for its
specific configuration syntax.

Test directory listing directly by visiting:

    http://SERVER-IP:PORT/photos/

You should see a server-generated list of the files and folders in
photos/.

Then open:

    http://SERVER-IP:PORT/

to use the gallery.

## Organizing media

### Supported media

Add or remove files directly inside photos/ or any album subfolder.

The gallery recognizes:

Images: .jpg .jpeg .png .webp .gif .heic .heif

Animated and static GIF files are displayed directly by the browser and
participate in slideshows like other images.

Videos: .mp4 .mov

The browser must support the codec contained inside a video file. A .mov
or .mp4 extension alone does not guarantee browser playback.

### Albums

Create folders inside photos/ to create albums.

Example:

    photos/
    ├── Family/
    ├── Kids/
    └── Vacations/
        ├── OBX 2026/
        └── Disney/

Folders appear as album cards. Albums can contain additional subfolders.

Use the breadcrumb at the top of the gallery to move back through the
album hierarchy.

### Refreshing

Click “Refresh Folder” to scan immediately.

When Auto Refresh is enabled, the current folder is rescanned at the configured refreshInterval
(default: one minute for index, five minutes for embed). The gallery also rescans when you return to the browser tab.

This means newly added or removed media can appear without manually
rebuilding anything.

### HEIC / HEIF support

The gallery includes the local heic2any.min.js decoder.

For genuine HEIC/HEIF files, the browser can convert the image to JPEG
for display when native browser rendering is unavailable.

The gallery also performs content-aware handling for files whose
extension does not match their actual contents. For example, a file
named:

    IMG_3954.heic

that actually contains JPEG data can be recognized and displayed as JPEG
rather than incorrectly being sent through the HEIC decoder.

HEIC decoding is more CPU- and memory-intensive than displaying normal
JPEG, PNG, or WebP images. Large collections of genuine HEIC files may
therefore take longer to populate than JPEG-based galleries.

## Gallery controls

### Grid and album view

View, sorting, and Auto Refresh buttons show their current mode using neutral
styling; Refresh Folder uses the same styling. In the viewer, Shuffle means
shuffle is enabled and Shuffle Off means it is disabled.

### Sorting

The button between By Folder and Auto Refresh shows the current sorting.
Click it to cycle Newest, Oldest, Filename. Filename is the default.
Newest/Oldest use the server's file modification date (HTTP Last-Modified),
not when the photo was taken. Files with missing dates sort last by filename;
equal dates use natural filename order. Folders remain first and alphabetical.
Non-shuffled slideshows follow the selected order.

Set "sort": "newest", "oldest", or "filename" in folderframe.config.json under
defaults, index, or embed. Shared defaults apply to both; profile settings
override them. Saved preferences win when enabled; ?sort=filename explicitly
overrides them, and ?remember=0 lets you test config defaults.
Date lookups use bounded HEAD requests and cache results for 24 hours in localStorage.
The cache is capped at 2,000 entries per app/source, evicting oldest checked
entries first. It survives reloads and browser restarts when storage is available;
blocked/full storage falls back to a bounded in-memory cache. It is separate
from remembered preferences, so remember=0 does not disable this metadata cache.
Cached media URLs and dates remain on the device until replaced, evicted, or
site storage is cleared; expired entries are discarded when date sorting runs.
Refresh Folder reloads dates; Filename skips date lookups entirely.
See CONFIGURATION.md for examples and server requirements.

The compact header places the album/file count beside the directory breadcrumb.
Parent folders remain clickable; the current folder appears once as plain text,
including on phones. Hover over that label to see its full relative path.
Click or tap the FolderFrame logo to return to the current source's top-level
gallery. This works in both the standalone gallery and the embedded grid.

Album tiles preview the first image directly inside that folder, using the
natural filename order regardless of the selected sort (2.jpg before 10.jpg).
A blue folder badge and the album name distinguish covers from individual
photos. Empty, video-only, nested-folder-only, or failed previews keep the
folder icon. Covers do not recursively scan descendant albums.

Previews load near the visible grid, with up to three album-preview jobs and
two shared HEIC-processing jobs at once. HEIC previews are downscaled to a
480-pixel maximum edge; other formats still use original images. No server-side
thumbnail generation is required. Offscreen HEIC previews release their leases.
Use Refresh Folder to reselect covers after changing files inside albums;
unchanged background refreshes keep existing tiles. There is no cover.jpg
override yet.

-   The site opens in the thumbnail grid by default; configured autoplay opens the viewer.
-   Click a photo or video to open the full viewer.
-   Click an album card to enter that folder.
-   Use the breadcrumb to navigate back through albums.
-   Click “Refresh Folder” for an immediate rescan.
-   Toggle “Auto Refresh” to enable or disable the configured automatic
    rescan.
-   Toggle “By Folder” / “All Pics” to switch between album browsing and
    recursively showing media from the current folder and its subfolders.

### Viewer navigation

-   Left Arrow button: previous media
-   Right Arrow button: next media
-   Keyboard Left Arrow: previous media
-   Keyboard Right Arrow: next media
-   Gallery button: return to the thumbnail/album grid
-   Press G to return to the thumbnail/album grid

### Slideshow

-   Click Play / Pause to start or stop the slideshow.
-   Press Space to start/pause from the full viewer.
-   Available intervals are: 3 seconds 5 seconds 10 seconds 15 seconds
    30 seconds 60 seconds 5 minutes 15 minutes 60 minutes

### Shuffle

-   Click Shuffle to toggle randomized slideshow progression.
-   Press S while in the full viewer to toggle Shuffle.
-   Manual Previous/Next navigation remains available.

### Loading feedback

Folder scans show a scanning/refreshing message; recursive scans report folders
checked and files found (not a percentage). Existing tiles stay visible while
refreshing, and unchanged refreshes do not recreate them. Thumbnail placeholders
clear when previews load, or show Preview unavailable on failure.
The viewer indicates Loading image, Preparing HEIC image, or Loading/Buffering
video until ready. Empty folders and scan failures have separate messages.
Controls-free slideshows hide loading indicators. Reduced-motion preferences
are respected. These indicators do not reduce the original download/decode cost.

### Zoom, pan, and mobile layout

Swipe left/right on a fitted, unzoomed photo to browse. Once zoomed or panned,
dragging pans instead; pinch gestures, short taps, and vertical swipes do not
change photos. Swiping does not control videos or controls-free embeds.
Returning to Gallery restores the scroll position of the originally opened
tile and briefly highlights it. If refreshed content moved the tile, it is
scrolled into view; if removed, the saved scroll position is used instead.

At widths up to 560 CSS pixels (including narrow embeds), the gallery uses
a logo/count row, a separate breadcrumb, and a 2-by-2 button grid. Routine
timestamps are hidden; scan errors remain visible. The viewer uses three rows:
Gallery/name/count; Play/Shuffle/interval; Fit/Full/TV Mode. Reset Zoom is hidden
at this width. To reset a magnified photo, switch Fit/Original; switch back to
Fit if needed. Wider headers keep compact controls and wrap to use available space.
The sizing button shows an icon with Fit or Original; Full toggles fullscreen.
Long album breadcrumbs scroll sideways. Use the
arrow buttons to change media; drag on a zoomed photo to pan it.
The grid scrolls vertically, with a content-sized header and visible filenames.
Photo pinch gestures zoom the image; page zoom remains available outside the photo.
Controls suppress browser double-tap zoom so rapid taps on navigation buttons
do not magnify the page. Pinch calculations use the stationary viewport to avoid
feedback flicker. On desktop, long filenames truncate to leave room for controls;
controls still wrap when the window is too narrow to fit them.

Photos support:

- Mouse-wheel zoom and touch pinch-to-zoom.
- Mouse/finger dragging to pan.
- Reset Zoom on wider layouts.
- Escape to reset zoom/pan when the image is magnified or displaced.

### Image sizing

Use the image sizing button to switch between:

    Original Size
    Fit Screen

The selected mode is remembered by the browser. Press Enter in the full
viewer to switch between Fit Screen and Original Size.

### Fullscreen

Use the Full button (beside TV Mode), or press F
in the full viewer, to enter or leave browser fullscreen.

While viewing media, controls and the mouse cursor fade after
approximately 3 seconds of inactivity. Mouse, touch, or keyboard
activity brings them back.

### TV / photo-frame mode

TV Mode is intended for a television, wall display, tablet, or other
dedicated photo-frame screen.

Enabling TV Mode:

- Switches images to Fit.
- Enables Shuffle and Auto Refresh.
- Starts the slideshow.
- Attempts to enter browser fullscreen.

Press T in the full viewer to toggle TV Mode.

Exiting fullscreen turns TV Mode off and pauses its slideshow. TV Mode is
not saved in browser preferences; explicit tvMode config or tv=1 URL defaults
still apply on reload. Use tv=0 to override those defaults.

Browsers generally require a user gesture before true fullscreen is
allowed, so automatic URL startup can configure TV behavior but may not
be able to force fullscreen by itself.

## Saved settings

The gallery stores preferences in the browser’s localStorage.

Saved settings include the current album, sorting, slideshow interval, image
sizing, folder/All Pics view, Shuffle, and Auto Refresh.

These preferences are local to that browser/device.

Preferences are now separated by app location, source, and index/embed profile.
The supplied embed profile ignores saved preferences. Use rememberPreferences
in folderframe.config.json or the remember URL option to control persistence.
See [CONFIGURATION.md](CONFIGURATION.md) for settings and precedence.

## URL options

The gallery supports URL query parameters, which are useful for
bookmarks and dedicated displays.

Supported options:

    profile=index or profile=embed
        Select the configuration profile (index by default).

    source=ID
        Select a source defined in folderframe.config.json.

    remember=0 or remember=1
        Ignore or use saved browser preferences.

    imageMode=fit or imageMode=original
        Override the initial image sizing mode.

    album=FOLDER
        Open a specific album path.

    interval=SECONDS
        Set slideshow interval.
        Valid values: 3, 5, 10, 15, 30, 60, 300, 900, 3600

    shuffle=1 or shuffle=0
        Enable or disable Shuffle.

    autorefresh=0 or autorefresh=1
        Disable or enable Auto Refresh.

    view=all
        Show media in the selected folder and all its subfolders.

    view=folders
        Show the normal folder/album view.

    sort=newest or sort=oldest or sort=filename
        Choose media order (Filename by default).

    autoplay=1 or autoplay=0
        Enter the viewer and start slideshow playback, or start paused in the grid.

    tv=1 or tv=0
        Enable TV/photo-frame behavior:
        Fit Screen + Shuffle + Auto Refresh + slideshow playback.
        Use tv=0 to disable TV mode; explicit URL options override the preset.

Examples:

Open the Family album:

    http://SERVER-IP:PORT/?album=Family

Open a nested album:

    http://SERVER-IP:PORT/?album=Vacations/OBX%202026

Start a shuffled 10-second slideshow:

    http://SERVER-IP:PORT/?autoplay=1&shuffle=1&interval=10

Start TV/photo-frame mode:

    http://SERVER-IP:PORT/?tv=1&interval=10

Open an album directly in TV mode:

    http://SERVER-IP:PORT/?album=Family&tv=1&interval=10

Replace SERVER-IP:PORT with the actual address of the machine hosting
the gallery.

## Embedding FolderFrame

FolderFrame can be embedded in another site with a standard iframe. This
keeps its controls, styles, slideshow, and media handling isolated from the
host page. The included embed.html file is a complete responsive example.

Basic embed:

For a controls-free slideshow, set these fields in the config file's `embed`
section (keep your other sections):

```json
"embed": {
  "controls": false,
  "autoplay": true,
  "view": "all",
  "interval": 10,
  "rememberPreferences": false
}
```

`controls` defaults to `true` and also works under `defaults` or `index`.
False hides all viewer controls, the grid, progress, and media-error cards;
keyboard shortcuts and photo gestures are disabled. Videos are muted.
The viewer opens directly; `autoplay: true` starts the slideshow, and
`view: "all"` includes subfolders. Failed files skip after 3 seconds during play.
Empty-library messages and config warnings remain visible. Browser autoplay
restrictions still apply. Use `?profile=embed&controls=0&autoplay=1` to override
via URL, or `controls=1` to restore controls. See [CONFIGURATION.md](CONFIGURATION.md).

Basic iframe:

    <div class="folderframe-embed">
      <iframe
        src="https://YOUR-FOLDERFRAME-SERVER/?profile=embed"
        title="Photo and video gallery"
        loading="lazy"
        allowfullscreen>
      </iframe>
    </div>

    <style>
    .folderframe-embed {
      width: 100%;
      aspect-ratio: 16 / 9;
      min-height: 420px;
    }
    .folderframe-embed iframe {
      width: 100%;
      height: 100%;
      border: 0;
      border-radius: 12px;
    }
    </style>

The iframe URL accepts the same source, album, view, sort, interval, shuffle,
autoplay, autorefresh, tv, imageMode, controls, showFilenames, and remember options. Use
profile=embed to apply embed defaults from folderframe.config.json; otherwise
the index defaults apply, even inside an iframe. Keyboard shortcuts work after
the visitor clicks or focuses the embedded gallery.

The web server hosting FolderFrame must permit framing. Remove or adjust an
X-Frame-Options header that blocks the host page, and ensure any Content-
Security-Policy frame-ancestors directive allows the site doing the embedding.
Fullscreen and autoplay remain subject to browser policies.

## Troubleshooting

### No media files detected

1.  Verify photos/ exists beside index.html.
2.  Open /photos/ directly in the browser.
3.  Confirm that a directory listing appears.
4.  Confirm the files use supported extensions.
5.  Verify directory listing or directory browsing is enabled for
    /photos/ and its subfolders.
6.  If using Python, make sure python3 -m http.server 8000 was started
    from the FolderFrame project directory, not from inside photos/.

### Changes do not appear

-   Click Refresh Folder.
-   Verify Auto Refresh is enabled.
-   Hard-refresh the browser if JavaScript/HTML/CSS files themselves
    were changed.
-   Confirm you edited the copy of the site that the active web server
    is serving.

### HEIC image fails

The viewer shows recovery guidance for image and video failures. Retry reloads
the file, Next file moves on, Gallery returns to the grid, and Open original
opens the source in a separate tab. A running slideshow skips failed media after
3 seconds (or retries if there is only one file); Pause stops automatic skipping.
Manual browsing does not advance automatically. Browser-blocked autoplay is reported separately
from network and decoding errors. Originals are never modified.

-   Open browser Developer Tools and check the Console.

-   Check the Network tab and verify the image request returns HTTP 200.

-   On Linux, inspect the real file type with:

    file photos/filename.heic

-   A .heic filename is not proof that the file actually contains HEIC
    data.

### Video fails

A recognized filename can still contain a codec the browser cannot
decode. Check the browser console for playback errors. Converting the
video to a browser-friendly H.264/AAC MP4 is generally the most
compatible option.

### Another device cannot connect to the Python server

-   Use the server’s LAN IP instead of localhost.
-   Confirm TCP port 8000 is allowed by the host firewall.
-   Confirm both devices can reach each other on the network.

## Security notes

The gallery does not provide authentication by itself.

If the server is exposed outside your trusted LAN:

- Add authentication at the web-server/reverse-proxy layer.
- Use HTTPS.
- Do not expose private photos or their directory listings to the public Internet.

For a local-only family gallery, keeping the service accessible only
from the trusted LAN is the simplest arrangement.

## Support FolderFrame

If FolderFrame is useful to you, you can support its continued development:

    https://paypal.me/machogrog

## License

FolderFrame is available under the MIT License. See LICENSE for details.
