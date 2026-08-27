# Contributing to FolderFrame

Bug reports, documentation fixes, and focused pull requests are welcome.
Check the [roadmap](TODO.md) first. For larger features or changes to the
index/embed design, open an issue to discuss the approach before building it.

## Report a bug

Include steps to reproduce, what you expected, what happened, and your browser,
operating system, and device type. For media problems, include the file format
and video codec if known. Share relevant console errors or screenshots, but
remove private paths, credentials, personal media, and other sensitive details.
Only share sample files you have permission to publish.

## Run locally

FolderFrame uses static HTML, CSS, and JavaScript. No build step or package
installation is required for the app. It needs a web server that provides
HTML directory listings for photos/ and its subfolders.

From the project root, with Python 3 installed:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

On Windows, you can use `py -3` instead of `python3`. Open
http://localhost:8000/ for the gallery and http://localhost:8000/embed.html
for the embedding example. Do not open index.html through file://.

Use the included test albums and sample media. Most deployment media is
ignored by Git, but the public test folders and sample files are tracked;
review `git status` before submitting and never overwrite them with private media.

## Check your changes

Run checks appropriate to the change. For JavaScript edits, if Node.js is
installed, run `node --check app.js` and `node --check settings.js`. These check
syntax, not browser behavior. Run `node --test tests/configuration.test.cjs`
for settings validation, precedence, source URL handling, and app startup tests.

For UI or behavior changes, test the affected paths in a browser:

- Open albums, use breadcrumbs, and switch between By Folder and All Pics.
- Open an image and a video; test navigation and returning to Gallery.
- Verify Space plays/pauses the slideshow and Enter toggles Fit/Original.
- Check resizing, zoom/pan, and small-screen layout when relevant.
- Check the embedding example and URL options if navigation or startup changes.
- Check loading, empty, and error states when changing scans or media handling.

Inspect the browser console for new errors. State which browsers and scenarios
you tested, and call out any checks you could not run. For visual changes,
include screenshots without private content or browser address bars.

## Submit a pull request

Fork the repository, create a branch, and keep the change focused. Preserve
the static-server workflow and explain any proposed new dependencies. Update
README.md and folderframe-instructions.txt when user-facing behavior changes.
Avoid editing the bundled heic2any.min.js for unrelated changes.

Review your diff and run `git diff --check`. In the pull request, explain what
changed, why, how it was tested, and any limitations. Do not bundle unrelated
formatting changes or personal media with the fix.

FolderFrame uses the [MIT License](LICENSE).
