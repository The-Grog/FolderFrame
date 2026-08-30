## Summary

<!-- What changed, why, and what user-visible problem does it solve? -->

## Scope and design

- [ ] The change remains focused and preserves FolderFrame's folder-first, database-free static-server design.
- [ ] App changes belong in FolderFrame; Docker, Unraid, Caddy, and container changes belong in FolderFrame-Deployment.
- [ ] No private media, paths, credentials, private planning files, or unapproved public assets are included.

## Testing

<!-- List commands run and their results. -->

- [ ] node --check app.js
- [ ] node --check settings.js
- [ ] node --check resilience.js
- [ ] node --test tests/configuration.test.cjs tests/resilience.test.cjs
- [ ] git diff --check

Browsers, operating systems, devices, and scenarios checked:

<!-- Example: Firefox 000 / Windows 00 desktop; Chrome 000 / Android 00 phone -->

## Visual changes

- [ ] No visual change.
- [ ] Screenshots are attached and contain no private media, browser addresses, or sensitive information.

## Documentation and deployment assets

- [ ] README, configuration, instructions, and roadmap documents were updated where needed.
- [ ] Any changed public screenshots, sample media, logos, or deployment assets are explicitly listed below and approved for publication.

Public asset changes:

<!-- None, or list every added/replaced public asset. -->

## Limitations

<!-- Note untested browsers, codecs, device paths, or follow-up work. -->
