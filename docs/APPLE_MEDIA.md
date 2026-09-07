# Apple media compatibility

FolderFrame first attempts native HEIC/HEIF display using the original image
URL. It does not infer support from the browser name. A successful native load
never loads the decoder. On failure, the existing two-job image pool downloads
and sniffs the original, then lazily loads bundled heic-to 1.5.2 only for a
genuine HEIC still. JPEG/PNG/AVIF bytes and QuickTime motion never enter it.
HTTP cache reuse is permitted; a host sending `no-store` can require another
transfer after the native attempt, since browsers do not expose image-loader
bytes to JavaScript. Sniffing and conversion reuse the same fallback download.

Grid tiles and album covers still use generated thumbnails or placeholders.
They never decode full HEIC files. Conversion timeouts, stale-viewer checks,
lease cleanup, and slideshow error skipping remain in effect. See
[third-party licenses and corresponding sources](../THIRD_PARTY_NOTICES.md).

Videos always try the original URL (or already-downloaded Live Photo bytes)
in the HTML video element. Only MediaError codes 3 (decode) and 4 (unsupported
source), plus a successful HEAD check of the original, can invoke fallback.
Autoplay denial, 403/404, network failures, stalls, pauses, and visibility
changes do not trigger it. Failed or unsupported HEAD checks also leave the
normal recovery UI in place. No extension or browser-name rule forces conversion.

On the first compatibility failure, the client requests the same-origin
`/folderframe-api/capabilities` endpoint once per page session, with a 3-second
deadline. Missing/404/unreachable service means unavailable. The official
Docker service reports `{ "videoTranscode": true, "mediaPath": "/photos/" }`.
Only same-origin media below that route maps to
`/folderframe-api/transcode?path=<encoded relative filename>`.

Each viewer generation can transition from original to fallback once.
Fallback errors use existing Retry/Next/slideshow behavior; explicit Retry
starts a new viewer generation. Next, Previous, Gallery, album navigation,
and closing the page release the old video request. Download always targets
the untouched original.

The optional Docker service streams H.264/yuv420p video and AAC stereo audio
inside fragmented MP4 directly from FFmpeg stdout. It creates no output file,
sidecar, permanent appdata video cache, or converted copy in the media library.
Native-compatible media bypasses FFmpeg. Conversion uses CPU only while a job
is active; paused/stalled clients may be disconnected after the bounded output
deadline. Software encoding is the baseline; hardware acceleration is not
implemented in this version. HDR/Dolby Vision color fidelity is not guaranteed.

Transcoded playback is sequential: arbitrary seeking/resume is not supported.
The endpoint ignores Range and returns 200, never a fabricated 206. Normal
original-video seeking remains available. Generate no persistent proxies to
work around this limitation.

Set `videoTranscodeFallback` to `"auto"` (default) or `"off"` under defaults,
index, or embed; `?videoTranscodeFallback=off` is also supported. No API URL is
configured. Static nginx/Apache/Caddy/Pages installs remain usable without a
backend and simply retain normal unsupported-video messages. The embed uses
the same viewer and capability logic.

For deployment limits and process management, see the deployment repository's
`TRANSCODING.md`. Real Safari/native HEIC and Windows HEVC support depend on
the device; automated event tests do not certify platform codec availability.
