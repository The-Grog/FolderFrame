# FolderFrame To-Do

Checked items are implemented. Device-confirmation notes identify remaining
manual checks; automated tests do not verify browser layout or codecs.

- [x] **Refresh README screenshots** — Replaced viewer and grid previews with user-supplied screenshots of the updated interface. Full viewer first; no browser chrome or hosting URL.
- [x] **README configuration example and settings reference** — Added complete JSON, all settings/defaults, source paths, profile overrides, recursion, autoplay, controls-free mode, and preference/URL precedence. Full details in CONFIGURATION.md.
- [x] **Highlight key features in the overview** — Added a scannable list of implemented gallery, media, slideshow, mobile, embedding, configuration, loading, and hosting features.
- [x] **3rd Party Ai review of code and design** — Completed
- [x] **README roadmap link** — Links to this worklist and the contributing guide.
- [x] **Contributing guide** — Added setup, checks, focused PR guidance, and media privacy notes.
- [x] **Configuration: media paths and startup defaults** — Named sources, index/embed profiles, preferences, and URL overrides. Settings and startup regression coverage included.
- [x] **Clearer error states** — Shared recovery UI for images, HEIC/HEIF, and video. Running slideshows skip errors after 3 seconds; manual browsing stays put.
- [x] **Loading states** — Scan counts, thumbnail placeholders, image/HEIC/video indicators, and distinct empty/failure feedback. Unchanged refreshes retain tiles; controls-free mode hides indicators.
- [x] **Mobile polish** — Compact right-aligned controls, responsive grid, safe areas, and pinch/pan handling. User completed mobile testing and approved the layout.
- [x] **Slideshow UI visibility** — Automatic transitions no longer reveal controls or restart their idle timer. Verify latest fix on device.
- [x] **TV mode state** — Exiting fullscreen clears TV mode and pauses its slideshow. Saved preferences no longer restore TV mode; explicit config/URL defaults still apply. Verify latest fix on device.
- [x] **Controls-free slideshow configuration** — controls=false plus autoplay=true enables an unattended viewer with muted video. Documented config and URL overrides.
- [ ] **Thumbnail generation (optional)** — Evaluate pre-generated thumbnails with original-image fallback for larger libraries. Preserve static-server hosting; client-side resizing still incurs original download/decode cost.
- [ ] **Final device follow-up** — Confirm the latest slideshow visibility and TV-mode fixes, media failures/loading, and controls-free embeds in the target browsers.

- [ ] **Docker packaging and Unraid templates** — Build a Docker image and an Unraid container template for easy deployment. Include configurable media/config mounts, port mapping, a web server with directory listings, and setup/update instructions. Keep ordinary static-server hosting supported.

- [x] **Swipe between photos** — Implemented horizontal swipes for fitted, unzoomed/unpanned photos. Zoomed photos still pan; short/vertical/cancelled gestures do not navigate. Local only; phone verification pending.
- [ ] **Album cover previews** — Show an image from inside each album instead of only the blue folder icon. Retain a small folder badge so albums remain recognizable, with a folder-icon fallback when no preview is available.
- [x] **Optional filename display in configuration** — Added showFilenames (default true), shared/index/embed support, and showFilenames=0/1 URL overrides. Hides viewer filenames and media captions, retaining album names, accessible labels, and error details. Documented; local only.
- [x] **Remember grid scroll position** — Restores the originally opened tile and saved scroll position, with a brief static highlight. Adjusts for moved tiles; falls back to scroll position if removed, and resets on folder navigation. Local only; device verification pending.

User tested and approved the swipe, filename visibility, and grid-return update.
Validation for this update: 36 automated settings/startup/media/gesture tests.
