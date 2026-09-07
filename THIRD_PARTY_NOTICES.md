# Third-party software

FolderFrame application code remains MIT, as stated in [LICENSE](LICENSE).
The complete distribution also includes the separately licensed decoder below.
Keep this notice, the vendor directory, and corresponding sources with copies
of the app, including static demos and container distributions.

## heic-to 1.5.2

- Author: Hopper Gee and contributors.
- Upstream: https://github.com/hoppergee/heic-to
- Exact source commit: `f37af866f9aa6212ddc84b67a279c9f2386aba4f` (tag `v1.5.2`).
- Package: https://registry.npmjs.org/heic-to/-/heic-to-1.5.2.tgz
- Vendored file: [heic-to.js](vendor/heic-to-1.5.2/heic-to.js), the **unmodified**
  `dist/iife/heic-to.js` distribution; no CDN or app build step is required.
- SHA-256: `976f23cac9d435e3c3d9d8757c3975d1f56ae995581461b3a8ace66e07e4640e`.
- Package declares LGPL-3.0; upstream license grants version 3 or later.
  [Full upstream license](vendor/heic-to-1.5.2/licenses/heic-to-LGPL-3.0.txt).
- [Corresponding source](vendor/heic-to-1.5.2/source/heic-to-1.5.2.tar.gz)
  includes the original JS wrapper, worker, generated libheif JS, package
  metadata, and upstream build scripts.

## Embedded codecs

The pinned release documents libheif **1.22.2** and a libde265 **1.0.16**
Emscripten build. These libraries carry LGPL-3.0-or-later terms; complete
copyright notices are retained in the following unchanged source archives.
The libheif library is principally copyright Struktur AG and contributors;
libde265 is copyright Dirk Farin and contributors. Individual files retain
their respective author notices and terms.

- libheif: https://github.com/strukturag/libheif/tree/v1.22.2 —
  [source](vendor/heic-to-1.5.2/source/libheif-1.22.2.tar.gz),
  [GPLv3 and LGPLv3 texts](vendor/heic-to-1.5.2/licenses/libheif-COPYING.txt).
- libde265: https://github.com/strukturag/libde265/tree/v1.0.16 —
  [source](vendor/heic-to-1.5.2/source/libde265-1.0.16.tar.gz),
  [GPLv3 and LGPLv3 texts](vendor/heic-to-1.5.2/licenses/libde265-COPYING.txt).

The decoder is loaded through `loadHeicDecoder()` and `decodeHeic()` in app.js.
The compiled runtime also contains Emscripten support code; retain its
[MIT/NCSA license](vendor/heic-to-1.5.2/licenses/emscripten-LICENSE.txt).
That notice is copied from upstream Emscripten 4.0.23, not a claim that this
was the compiler version used by heic-to's author.
It remains replaceable as a separate script; FolderFrame does not prohibit
modification or reverse engineering for debugging modifications to these
libraries. No decoder source is merged into FolderFrame application code.

For rebuilding, unpack the corresponding sources and follow the pinned
heic-to README's libheif Emscripten instructions (`LIBDE265_VERSION=1.0.16`,
`USE_WASM=0`) and `esbuild.mjs`. Those are upstream dependency-maintainer
tools, not prerequisites for hosting or using FolderFrame. The exact published
browser artifact is preserved above rather than claiming a reproducible
compiler build; upstream does not pin its original Emscripten toolchain.

This software is distributed WITHOUT ANY WARRANTY; see the included licenses.
