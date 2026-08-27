FOLDERFRAME — SETUP & USER GUIDE

[![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-0070ba?logo=paypal&logoColor=white)](https://paypal.me/machogrog)

OVERVIEW

This is a lightweight, self-hosted photo and video gallery. It reads the
contents of the photos/ directory dynamically from the web server’s
directory listing, so there is no database, import process, or manually
maintained media list.

The gallery supports: - Thumbnail grid view - Subfolders as albums,
including nested albums - Breadcrumb navigation - JPG, JPEG, PNG, WebP, GIF,
HEIC/HEIF images - MP4 and MOV video detection/playback (browser codec
support still applies) - Content-aware handling of mislabeled HEIC
files - Slideshow playback with selectable intervals - Shuffle mode -
Automatic folder rescanning every 30 seconds - TV / photo-frame mode -
Zoom, pan, pinch zoom, Original Size and Fit Screen - Fullscreen /
theater mode - Saved preferences using browser localStorage - URL
options for dedicated slideshow/TV bookmarks

IMPORTANT: DO NOT OPEN index.html DIRECTLY

Browsers restrict directory scanning when a page is opened with the
file:// protocol. The gallery must be served over HTTP or HTTPS by a web
server that provides directory listings for photos/ and its subfolders.

PROJECT LAYOUT

Keep the files arranged like this:

    FolderFrame/
    ├── index.html
    ├── styles.css
    ├── app.js
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

OPTION 1 — QUICK LOCAL TEST WITH PYTHON

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

OPTION 2 — HOSTING ON A WEB SERVER OR UNRAID

FolderFrame is not tied to a specific web server. Apache, Nginx, Caddy,
lighttpd, and similar servers can all work. On Unraid, use any suitable
web-server container and map the FolderFrame directory into its web root.

The web root should contain:

    index.html
    styles.css
    app.js
    heic2any.min.js
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

ADDING, REMOVING, AND ORGANIZING MEDIA

MEDIA

Add or remove files directly inside photos/ or any album subfolder.

The gallery recognizes:

Images: .jpg .jpeg .png .webp .gif .heic .heif

Animated and static GIF files are displayed directly by the browser and
participate in slideshows like other images.

Videos: .mp4 .mov

The browser must support the codec contained inside a video file. A .mov
or .mp4 extension alone does not guarantee browser playback.

ALBUMS

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

REFRESHING

Click “Refresh Folder” to scan immediately.

When Auto Refresh is enabled, the current folder is rescanned every 30
seconds. The gallery also rescans when you return to the browser tab.

This means newly added or removed media can appear without manually
rebuilding anything.

HEIC / HEIF SUPPORT

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

GALLERY CONTROLS

GRID / ALBUM VIEW

-   The site opens in the thumbnail grid.
-   Click a photo or video to open the full viewer.
-   Click an album card to enter that folder.
-   Use the breadcrumb to navigate back through albums.
-   Click “Refresh Folder” for an immediate rescan.
-   Toggle “Auto Refresh” to enable or disable the 30-second automatic
    rescan.
-   Toggle “By Folder” / “All Pics” to switch between album browsing and
    recursively showing media from the current folder and its subfolders.

VIEWER NAVIGATION

-   Left Arrow button: previous media
-   Right Arrow button: next media
-   Keyboard Left Arrow: previous media
-   Keyboard Right Arrow: next media
-   Gallery button: return to the thumbnail/album grid
-   Press G to return to the thumbnail/album grid

SLIDESHOW

-   Click Play / Pause to start or stop the slideshow.
-   Press Space to start/pause from the full viewer.
-   Available intervals are: 3 seconds 5 seconds 10 seconds 15 seconds
    30 seconds 60 seconds

SHUFFLE

-   Click Shuffle to toggle randomized slideshow progression.
-   Press S while in the full viewer to toggle Shuffle.
-   Manual Previous/Next navigation remains available.

ZOOM AND PAN

Photos support: - Mouse wheel zoom - Touch pinch-to-zoom - Mouse/finger
drag to pan - Reset Zoom button - Escape to reset zoom/pan when the
image is magnified or displaced

IMAGE SIZING

Use the image sizing button to switch between:

    Original Size
    Fit Screen

The selected mode is remembered by the browser. Press Enter in the full
viewer to switch between Fit Screen and Original Size.

FULLSCREEN / THEATER MODE

Use the labeled Fullscreen button (immediately left of TV Mode), or press F
in the full viewer, to enter or leave browser fullscreen.

While viewing media, controls and the mouse cursor fade after
approximately 3 seconds of inactivity. Mouse, touch, or keyboard
activity brings them back.

TV / PHOTO-FRAME MODE

TV Mode is intended for a television, wall display, tablet, or other
dedicated photo-frame screen.

Enabling TV Mode: - switches images to Fit Screen - enables Shuffle -
enables Auto Refresh - starts the slideshow - attempts to enter browser
fullscreen

Press T in the full viewer to toggle TV Mode.

Browsers generally require a user gesture before true fullscreen is
allowed, so automatic URL startup can configure TV behavior but may not
be able to force fullscreen by itself.

SAVED SETTINGS

The gallery stores preferences in the browser’s localStorage.

Settings such as the following can persist between visits: - current
album - slideshow interval - image sizing mode - folder/all-pics view -
Shuffle - Auto Refresh - TV Mode

These preferences are local to that browser/device.

URL OPTIONS

The gallery supports URL query parameters, which are useful for
bookmarks and dedicated displays.

Supported options:

    album=FOLDER
        Open a specific album path.

    interval=SECONDS
        Set slideshow interval.
        Valid values: 3, 5, 10, 15, 30, 60

    shuffle=1
        Enable Shuffle.

    autorefresh=0
        Disable Auto Refresh.

    view=all
        Show media in the selected folder and all its subfolders.

    view=folders
        Show the normal folder/album view.

    autoplay=1
        Start slideshow playback automatically.

    tv=1
        Enable TV/photo-frame behavior:
        Fit Screen + Shuffle + Auto Refresh + slideshow playback.

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

TROUBLESHOOTING

NO MEDIA FILES DETECTED

1.  Verify photos/ exists beside index.html.
2.  Open /photos/ directly in the browser.
3.  Confirm that a directory listing appears.
4.  Confirm the files use supported extensions.
5.  Verify directory listing or directory browsing is enabled for
    /photos/ and its subfolders.
6.  If using Python, make sure python3 -m http.server 8000 was started
    from the FolderFrame project directory, not from inside photos/.

CHANGES DO NOT APPEAR

-   Click Refresh Folder.
-   Verify Auto Refresh is enabled.
-   Hard-refresh the browser if JavaScript/HTML/CSS files themselves
    were changed.
-   Confirm you edited the copy of the site that the active web server
    is serving.

HEIC IMAGE FAILS

-   Open browser Developer Tools and check the Console.

-   Check the Network tab and verify the image request returns HTTP 200.

-   On Linux, inspect the real file type with:

    file photos/filename.heic

-   A .heic filename is not proof that the file actually contains HEIC
    data.

VIDEO FAILS

A recognized filename can still contain a codec the browser cannot
decode. Check the browser console for playback errors. Converting the
video to a browser-friendly H.264/AAC MP4 is generally the most
compatible option.

PYTHON SERVER IS RUNNING BUT ANOTHER DEVICE CANNOT CONNECT

-   Use the server’s LAN IP instead of localhost.
-   Confirm TCP port 8000 is allowed by the host firewall.
-   Confirm both devices can reach each other on the network.

SECURITY NOTES

The gallery does not provide authentication by itself.

If the server is exposed outside your trusted LAN: - add authentication
at the web-server/reverse-proxy layer - use HTTPS - do not expose a raw
directory listing of private photos to the public Internet

For a local-only family gallery, keeping the service accessible only
from the trusted LAN is the simplest arrangement.

SUPPORT FOLDERFRAME

If FolderFrame is useful to you, you can support its continued development:

    https://paypal.me/machogrog

LICENSE

FolderFrame is available under the MIT License. See LICENSE for details.
