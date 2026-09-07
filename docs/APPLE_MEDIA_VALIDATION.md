# Apple media implementation and validation

## Architecture

Core remains a static app. Actual image load success is the native HEIC test;
failure enters the existing two-job conversion pool and its byte sniff. The
separate unmodified heic-to 1.5.2 IIFE is lazy-loaded through an adapter. Grid
and album covers retain generated-preview-or-placeholder behavior. LGPL texts,
copyright notices, and exact corresponding upstream source archives accompany
the decoder; FolderFrame's MIT LICENSE is unchanged.

Original video always starts first. Only MediaError 3/4 plus a successful
original HEAD can enter a single optional server fallback. Autoplay, network,
HTTP errors, stalls, and missing service keep normal error handling. Each media
generation permits one transition; navigation aborts the old request. The
same-origin API reports capability once per browser page session.

Docker adds a loopback Python asyncio API beside Caddy and the existing worker.
FFmpeg 8.0.1-r1 streams stdout as H.264/yuv420p, AAC stereo, fragmented MP4.
There are no output files or persistent video cache. Default concurrency is two
jobs with two decoder/encoder threads each. No hardware acceleration is added.
Arbitrary seeking is not supported on the sequential fallback stream.

Paths are decoded once, canonicalized beneath `/media`, opened without following
symlinks, and passed to FFmpeg by inherited regular-file descriptor. Container
sniffing selects only MOV or Matroska demuxers; protocols and external MOV data
references are restricted. Client disconnect, output deadlines, and container
shutdown terminate and reap children. See deployment `TRANSCODING.md` for the
exact FFmpeg invocation, API, timeouts, security, and operational settings.

## Checks performed

- 139 core configuration/resilience tests pass, including native HEIC success,
  real fallback wiring, lazy decoder loading, stale generation protection,
  QuickTime reclassification, native video bypass, one-shot transcode fallback,
  unavailable service/originals, autoplay/network errors, navigation, and profiles.
- 23 deployment tests pass on Linux inside the image, including path rejection,
  Unicode/apostrophe/nested names, busy response, launch failure, startup timeout,
  and real generated-video FFmpeg streaming and disconnect cleanup.
- Edge on Windows: real JPEG; real heic-to decoding of a synthetic HEIC after
  forcing just its native image request to fail; H.264 MOV native with no API;
  HEVC MOV native on this machine. A simulated MediaError 3 then exercised the
  real FFmpeg/Caddy response, which played successfully as H.264 in Edge.
  This distinguishes a forced fallback test from observed native codec failure.
- Viewer-to-grid cleanup removed the active video source; no page errors.
- Docker build and Caddy configuration validation pass with the pinned base
  and FFmpeg package. The test image is approximately 290 MiB uncompressed,
  approximately 129 MiB larger than the previously installed stable image.
  This compares whole images, not an isolated FFmpeg-only layer measurement.
- Actual static-demo generate/assemble/verify workflow blocks pass: 140 previews
  generated, zero failures, nine manifest directories listed, zero errors.
  Decoder, licenses, and source archives are included without an API requirement.

## Remaining device validation

Safari native HEIC/HEVC and Firefox's actual unsupported-HEVC behavior still need
device testing. So do long 4K clips, HDR/Dolby Vision color, mobile memory/load,
and sustained mixed-media TV/controls-free slideshow sessions. Automated tests
cover those UI policies but do not certify platform codec support or performance.
The decoder can still stall on malformed media; the existing bounded pool and
reload guidance remain. No release or live-gallery rollout is implied by these checks.

## Files changed

Core: `.gitattributes`, `app.js`, `settings.js`, `folderframe.config.json`, `index.html`,
`tests/configuration.test.cjs`, `.github/workflows/deploy-demo.yml`, `README.md`,
`CONFIGURATION.md`, `RESILIENCE.md`, `CONTRIBUTING.md`, `TODO.md`,
`folderframe-instructions.txt`, `THIRD_PARTY_NOTICES.md`, `docs/APPLE_MEDIA.md`,
this report, and `vendor/heic-to-1.5.2/`. The obsolete `heic2any.min.js` is removed.
`resilience.js`, `generate_thumbnails.py`, and the MIT `LICENSE` are unchanged.

Deployment: `transcode_service.py`, `service_runner.py`, `Dockerfile`,
`Caddyfile`, `docker-entrypoint.sh`, `.gitignore`, `.dockerignore`, `compose.yaml`, `.env.example`,
`scripts/test_transcode_service.py`, `scripts/test_public_metadata.py`,
`.github/workflows/publish.yml`, `README.md`, `UNRAID.md`, `MAINTAINERS.md`,
`TRANSCODING.md`, and `templates/folderframe.xml`.
The existing thumbnail worker and media/manifest routes remain in use.

The deployment recipe must be published only after a matching core release
includes the new vendor assets. It will not build against older core releases
that still provide only the obsolete decoder.
