const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../settings.js');
const base = 'https://example.test/frame/index.html';
const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '../folderframe.config.json'), 'utf8'));
const normalize = raw => api.normalizeConfig(raw, base);

test('shipped defaults preserve the index grid and isolate embed preferences', () => {
    const config = normalize(shipped);
    const index = api.resolveSettings(config, '');
    const embed = api.resolveSettings(config, '?profile=embed');
    assert.equal(index.settings.autoplay, false);
    assert.equal(index.settings.view, 'folders');
    assert.equal(index.settings.rememberPreferences, true);
    assert.equal(embed.settings.rememberPreferences, false);
    assert.notEqual(index.preferenceKey, embed.preferenceKey);
    assert.equal(index.source.url, 'https://example.test/frame/photos/');
});

test('profile defaults, saved preferences, and explicit URL options have predictable precedence', () => {
    const config = normalize({ defaults: { interval: 3, shuffle: true }, index: { interval: 10, album: 'Family' } });
    const key = api.resolveSettings(config, '').preferenceKey;
    const read = name => name === key ? JSON.stringify({ interval: 15, album: 'Saved' }) : null;
    const resolved = api.resolveSettings(config, '?interval=30&shuffle=0&album=URL', read);
    assert.equal(resolved.settings.interval, 30);
    assert.equal(resolved.settings.shuffle, false);
    assert.equal(resolved.settings.album, 'URL');
    assert.equal(api.resolveSettings(config, '', read).settings.interval, 15);
    assert.equal(api.resolveSettings(config, '?remember=0', read).settings.album, 'Family');
});

test('embed autoplay is independent of index preferences and supports explicit off overrides', () => {
    const config = normalize({ embed: { autoplay: true, interval: 10, shuffle: true, autoRefresh: false } });
    const embed = api.resolveSettings(config, '?profile=embed', () => { throw new Error('Must not read storage'); });
    assert.equal(embed.settings.autoplay, true);
    assert.deepEqual(embed.warnings, []);
    const override = api.resolveSettings(config, '?profile=embed&autoplay=0&shuffle=0&autorefresh=1');
    assert.equal(override.settings.autoplay, false);
    assert.equal(override.settings.shuffle, false);
    assert.equal(override.settings.autoRefresh, true);
    assert.equal(api.resolveSettings(config, '').settings.autoplay, false);
});

test('TV preset retains explicit overrides including paused startup', () => {
    const config = normalize({});
    const tv = api.resolveSettings(config, '?tv=1');
    assert.equal(tv.settings.autoplay, true);
    assert.equal(tv.settings.shuffle, true);
    const off = api.resolveSettings(config, '?tv=1&autoplay=0&shuffle=0&autorefresh=0&imageMode=original');
    assert.equal(off.settings.autoplay, false);
    assert.equal(off.settings.shuffle, false);
    assert.equal(off.settings.autoRefresh, false);
    assert.equal(off.settings.imageMode, 'original');
});

test('source roots, preference keys, and profile selection stay scoped', () => {
    const config = normalize({ sources: [
        { id: 'one', label: 'One', path: '/albums/a.b/' },
        { id: 'two', label: 'Two', path: 'https://media.test/library/' }
    ], defaults: { source: 'one' }, embed: { source: 'two' } });
    const one = api.resolveSettings(config, '');
    const two = api.resolveSettings(config, '?source=two');
    assert.notEqual(one.preferenceKey, two.preferenceKey);
    assert.equal(api.resolveSettings(config, '?profile=embed').source.id, 'two');
    assert.equal(api.resolveSettings(config, '?profile=embed&source=one').source.id, 'one');
    assert.equal(api.resolveSettings(config, '?source=missing').source.id, 'one');
    assert.equal(api.resolveSettings(config, '?source=missing').warnings.length, 1);
});

test('legacy preferences migrate only into the original index Photos source', () => {
    const read = key => key === 'gallery.preferences' ? JSON.stringify({ folder: 'Legacy', galleryViewMode: 'all', interval: 15 }) : null;
    assert.equal(api.resolveSettings(normalize({}), '', read).settings.album, 'Legacy');
    assert.equal(api.resolveSettings(normalize({}), '?profile=embed&remember=1', read).settings.album, '');
    const moved = normalize({ sources: [{ id: 'photos', label: 'Other', path: '/different/' }] });
    assert.equal(api.resolveSettings(moved, '', read).settings.album, '');
});

test('malformed or unavailable storage never prevents startup', () => {
    const config = normalize({ index: { interval: 10 } });
    for (const read of [() => '{bad json', () => { throw new Error('Storage blocked'); }, () => '[]']) {
        const resolved = api.resolveSettings(config, '', read);
        assert.equal(resolved.settings.interval, 10);
        assert.equal(resolved.warnings.length, 1);
    }
});

test('invalid configuration fails validation and invalid URL options are ignored', () => {
    for (const raw of [null, [], { defaults: { autoplay: 'true' } }, { index: { interval: 6 } },
        { embed: { typo: true } }, { sources: [] }, { defaults: { source: 'missing' } }]) {
        assert.throws(() => normalize(raw));
    }
    for (const sourcePath of ['file:///photos/', 'javascript:alert(1)', 'C:\\Photos', 'https://user:pass@host.test/photos', '/photos/?token=secret']) {
        assert.throws(() => normalize({ sources: [{ id: 'bad', label: 'Bad', path: sourcePath }] }));
    }
    const duplicate = { id: 'same', label: 'Same', path: 'photos/' };
    assert.throws(() => normalize({ sources: [duplicate, duplicate] }));
    const resolved = api.resolveSettings(normalize({}), '?interval=6&album=../outside&autoplay=true&profile=unknown');
    assert.equal(resolved.settings.interval, 5);
    assert.equal(resolved.settings.album, '');
    assert.equal(resolved.settings.autoplay, false);
    assert.equal(resolved.warnings.length, 4);
});

test('source-relative URL construction preserves spaces, unicode, percent signs, and punctuation', () => {
    const source = normalize({ sources: [{ id: 's', label: 'S', path: '/a.b/Photo Library' }] }).sources[0];
    const url = api.mediaUrl(source, 'Family/2026 夏', '100% #1.jpg');
    assert.equal(url, 'https://example.test/a.b/Photo%20Library/Family/2026%20%E5%A4%8F/100%25%20%231.jpg');
    assert.equal(api.relativeMediaPath(source, url), 'Family/2026 夏/100% #1.jpg');
    assert.throws(() => api.directoryUrl(source, '../private'));
    assert.throws(() => api.mediaUrl(source, '', '../private.jpg'));
});

test('directory listings accept only direct child links within the requested directory', () => {
    const directory = 'https://example.test/photos/';
    assert.deepEqual(api.listingEntry('Family%20Trip/', directory), { name: 'Family Trip', directory: true });
    assert.deepEqual(api.listingEntry('/photos/test.jpg', directory), { name: 'test.jpg', directory: false });
    assert.deepEqual(api.listingEntry('photos/', directory), { name: 'photos', directory: true });
    for (const href of ['../', './', '/private/secret.jpg', 'https://evil.test/photos/a.jpg',
        'Family/nested.jpg', '?C=N;O=D', '#top', '%2E%2E/', '%2Foutside.jpg', 'bad%ZZ.jpg']) {
        assert.equal(api.listingEntry(href, directory), null, href);
    }
});

// Exercise recovery using the same minimal DOM/HTTP fixture as startup.
test('TV mode is not restored from saved preferences but explicit defaults still apply', () => {
    const saved = () => JSON.stringify({ tvMode: true, interval: 10 });
    const resolved = api.resolveSettings(normalize({}), '', saved);
    assert.equal(resolved.settings.tvMode, false);
    assert.equal(resolved.settings.autoplay, false);
    assert.equal(resolved.settings.interval, 10);
    assert.equal(api.resolveSettings(normalize({}), '?tv=1', saved).settings.tvMode, true);
    assert.equal(api.resolveSettings(normalize({ index: { tvMode: true } }), '', saved).settings.tvMode, true);
});

test('exiting fullscreen clears TV mode and pauses without stopping ordinary slideshows', async () => {
    const app = await boot({ search: '?tv=1' });
    app.context.document.fullscreenElement = {};
    vm.runInContext('handleFullscreenChange()', app.context);
    assert.equal(vm.runInContext('tvModeEnabled', app.context), true);
    app.context.document.fullscreenElement = null;
    vm.runInContext('handleFullscreenChange()', app.context);
    assert.equal(vm.runInContext('tvModeEnabled', app.context), false);
    assert.equal(app.state().slideshowPlaying, false);
    assert.equal(app.get('gallery-video').controls, true);
    for (const value of app.saved.values()) assert.equal('tvMode' in JSON.parse(value), false);
    vm.runInContext('setSlideshowPlaying(true); handleFullscreenChange()', app.context);
    assert.equal(app.state().slideshowPlaying, true);
});

test('automatic slideshow transitions preserve hidden controls until interaction', async () => {
    for (const search of ['?autoplay=1', '?tv=1']) {
        const app = await boot({ search });
        app.context.document.activeElement = { closest: () => ({}), matches: () => false };
        vm.runInContext('hideUI()', app.context);
        assert.equal(vm.runInContext('uiVisible', app.context), false);
        const idle = vm.runInContext('idleTimer', app.context);
        vm.runInContext('nextSlideshowMedia()', app.context);
        assert.equal(vm.runInContext('uiVisible', app.context), false);
        assert.equal(vm.runInContext('idleTimer', app.context), idle);
        vm.runInContext('enterFullScreenViewer(0)', app.context);
        assert.equal(vm.runInContext('uiVisible', app.context), false);
        app.get('gallery-image').onerror();
        assert.equal(vm.runInContext('uiVisible', app.context), false);
        vm.runInContext('resetIdleTimer()', app.context);
        assert.equal(vm.runInContext('uiVisible', app.context), true);
    }
});

test('viewer loading clears on image success, failure, and grid navigation', async () => {
    const app = await boot({ search: '?autoplay=1' });
    assert.equal(app.get('media-loading').hidden, false);
    assert.equal(app.get('media-loading-text').textContent, 'Loading image…');
    app.get('gallery-image').onload();
    assert.equal(app.get('media-loading').hidden, true);
    vm.runInContext('showMedia(0)', app.context);
    app.get('gallery-image').onerror();
    assert.equal(app.get('media-loading').hidden, true);
    vm.runInContext('showMedia(0); renderGridView()', app.context);
    assert.equal(app.get('media-loading').hidden, true);
});

test('video buffering is reported and controls-free loading stays invisible', async () => {
    const app = await boot({ search: '?autoplay=1' });
    vm.runInContext("mediaFiles = ['https://example.test/clip.mp4']; showMedia(0)", app.context);
    app.get('gallery-video').onwaiting();
    assert.equal(app.get('media-loading-text').textContent, 'Buffering video…');
    app.get('gallery-video').oncanplay();
    assert.equal(app.get('media-loading').hidden, true);
    const embed = await boot({ search: '?controls=0&autoplay=1' });
    assert.equal(embed.get('media-loading').hidden, true);
});

test('refresh preserves existing thumbnails while scanning and reports failure separately', async () => {
    const app = await boot();
    const fetchOriginal = app.context.fetch;
    let finish;
    app.context.fetch = () => new Promise(resolve => { finish = resolve; });
    const existing = app.get('thumbnail-grid').children[0];
    const refresh = vm.runInContext('loadGallery()', app.context);
    assert.equal(app.get('scan-loading').hidden, false);
    assert.equal(app.get('btn-refresh-grid').disabled, true);
    assert.equal(app.get('thumbnail-grid').children[0], existing);
    finish({ ok: true, text: async () => '' });
    await refresh;
    assert.equal(app.get('scan-loading').hidden, true);
    assert.equal(app.get('btn-refresh-grid').disabled, false);
    assert.equal(app.get('thumbnail-grid').children[0], existing);
    app.context.fetch = async () => { throw new Error('offline'); };
    await vm.runInContext('loadGallery()', app.context);
    assert.match(app.get('scan-status').textContent, /Scan failed/);
    assert.equal(app.get('scan-loading').hidden, true);
    assert.equal(app.get('thumbnail-grid').children[0], existing);
    app.context.fetch = fetchOriginal;
});

test('thumbnail success and failure settle the placeholder without disabling the tile', async () => {
    const app = await boot();
    const classes = new Set();
    const item = { classList: { add: name => classes.add(name), remove: name => classes.delete(name) }, appendChild(child) { this.fallback = child; } };
    const element = { classList: { add() {} } };
    app.context.testTile = item; app.context.testThumb = element;
    vm.runInContext('watchThumbnail(testThumb, testTile)', app.context);
    assert.ok(classes.has('thumb-loading'));
    element.onload();
    assert.equal(classes.has('thumb-loading'), false);
    vm.runInContext('watchThumbnail(testThumb, testTile)', app.context);
    element.onerror();
    assert.equal(classes.has('thumb-loading'), false);
    assert.equal(item.fallback.textContent, 'Preview unavailable');
});

test('compact viewer labels remain correct after sizing and fullscreen changes', async () => {
    const app = await boot();
    assert.equal(app.get('image-mode-text').textContent, 'Fit');
    vm.runInContext('toggleImageMode()', app.context);
    assert.equal(app.get('image-mode-text').textContent, 'Original');
    const label = {};
    app.get('btn-fullscreen').querySelector = () => label;
    vm.runInContext('updateFullscreenButton()', app.context);
    assert.equal(label.textContent, 'Full');
    app.context.document.fullscreenElement = {};
    vm.runInContext('updateFullscreenButton()', app.context);
    assert.equal(label.textContent, 'Exit Full');
});

test('controls config is boolean, profile-scoped, and explicitly overridable', () => {
    const config = normalize({ embed: { controls: false, autoplay: true } });
    assert.equal(api.resolveSettings(config, '').settings.controls, true);
    assert.equal(api.resolveSettings(config, '?profile=embed').settings.controls, false);
    assert.equal(api.resolveSettings(config, '?profile=embed&controls=1').settings.controls, true);
    assert.equal(api.resolveSettings(config, '?controls=0').settings.controls, false);
    assert.throws(() => normalize({ defaults: { controls: 'false' } }), /controls must/);
    assert.ok(api.resolveSettings(config, '?controls=no').warnings.length);
});

test('controls-free mode opens viewer, disables photo gestures and mutes video', async () => {
    const app = await boot({ search: '?profile=embed', config: { embed: { controls: false, autoplay: true } } });
    assert.equal(vm.runInContext('controlsEnabled', app.context), false);
    assert.equal(app.state().isGridViewActive, false);
    assert.equal(app.state().slideshowPlaying, true);
    app.get('gallery-image').onload();
    assert.ok(app.animationFrames > 0);
    app.get('media-viewport').listeners.touchstart({ touches: [{ clientX: 1, clientY: 1 }, { clientX: 10, clientY: 10 }] });
    assert.equal(vm.runInContext('isPinching', app.context), false);
    vm.runInContext("mediaFiles = ['https://example.test/clip.mp4']; showMedia(0)", app.context);
    assert.equal(app.get('gallery-video').controls, false);
    assert.equal(app.get('gallery-video').muted, true);
    app.get('gallery-video').error = { code: 3 };
    app.get('gallery-video').onerror();
    assert.equal(app.state().slideshowPlaying, true);
    assert.notEqual(vm.runInContext('slideshowTimer', app.context), null);
});

test('controls-free empty startup stays safe and URL override restores normal grid', async () => {
    const config = { embed: { controls: false } };
    const empty = await boot({ search: '?profile=embed', config, empty: true });
    assert.equal(empty.state().slideshowPlaying, false);
    assert.equal(empty.get('warning-overlay').style.display, 'flex');
    const restored = await boot({ search: '?profile=embed&controls=1', config });
    assert.equal(vm.runInContext('controlsEnabled', restored.context), true);
    assert.equal(restored.state().isGridViewActive, true);
    const still = await boot({ search: '?profile=embed', config });
    assert.equal(still.state().isGridViewActive, false);
    assert.equal(still.state().slideshowPlaying, false);
});

test('image errors preserve playback, survive unchanged rescans, and support retry/gallery', async () => {
    const app = await boot({ search: '?autoplay=1' });
    app.get('gallery-image').onerror();
    assert.equal(app.state().slideshowPlaying, true);
    assert.equal(app.get('video-error-overlay').style.display, 'flex');
    assert.equal(app.get('btn-next-media-error').disabled, true);
    assert.match(app.get('media-error-title').textContent, /image/);
    await vm.runInContext('loadGallery({ silent: true })', app.context);
    assert.equal(app.get('video-error-overlay').style.display, 'flex');
    app.get('btn-retry-media-error').listeners.click();
    assert.equal(app.get('video-error-overlay').style.display, 'none');
    app.get('gallery-image').onload();
    assert.equal(app.get('gallery-image').style.display, 'block');
    app.get('btn-close-video-error').listeners.click();
    assert.equal(app.state().isGridViewActive, true);
});

test('video errors distinguish network, decoding, and blocked autoplay', async () => {
    const app = await boot();
    vm.runInContext("mediaFiles = ['https://example.test/clip.mp4']; enterFullScreenViewer(0)", app.context);
    const video = app.get('gallery-video');
    video.error = { code: 2 };
    video.onerror();
    assert.match(app.get('video-error-text').textContent, /network/);
    video.error = { code: 3 };
    video.onerror();
    assert.match(app.get('video-error-text').textContent, /decode/);
    video.play = () => Promise.reject({ name: 'NotAllowedError' });
    app.get('btn-retry-media-error').listeners.click();
    await Promise.resolve();
    assert.match(app.get('video-error-text').textContent, /blocked/);
    assert.equal(app.state().slideshowPlaying, false);
});

test('HEIC guidance distinguishes decoder and download errors', async () => {
    const app = await boot();
    vm.runInContext("showMediaError('heic', 'https://example.test/a.heic', new Error('HEIC decoder library did not load'))", app.context);
    assert.match(app.get('video-error-ffmpeg').textContent, /heic2any.min.js/);
    vm.runInContext("showMediaError('heic', 'https://example.test/a.heic', new Error('HTTP 404'))", app.context);
    assert.match(app.get('video-error-text').textContent, /downloaded/);
    vm.runInContext("showMediaError('heic', 'https://example.test/a.heic', new Error('conversion failed'))", app.context);
    assert.match(app.get('video-error-ffmpeg').textContent, /JPEG or PNG/);
});

test('late HEIC results cannot replace a newer image or reopen a closed viewer', async () => {
    const app = await boot();
    let resolve;
    app.context.pendingImage = new Promise(done => { resolve = done; });
    vm.runInContext("getSpecialImageURL = () => pendingImage; mediaFiles = ['https://example.test/a.heic', 'https://example.test/b.jpg']; enterFullScreenViewer(0); nextMedia()", app.context);
    resolve('blob:stale');
    await Promise.resolve();
    assert.equal(app.get('gallery-image').src, 'https://example.test/b.jpg');
    let reject;
    app.context.pendingImage = new Promise((_, fail) => { reject = fail; });
    vm.runInContext('showMedia(0); renderGridView()', app.context);
    reject(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(app.get('video-error-overlay').style.display, 'none');
    assert.equal(app.state().isGridViewActive, true);
});

// Run the real app startup without claiming to simulate layout or media codecs.
test('slideshow skips errors after a bounded delay and Pause cancels the skip', async () => {
    const app = await boot({ search: '?autoplay=1' });
    const timers = new Map();
    let id = 100; // Avoid IDs allocated by the startup fixture.
    app.context.setTimeout = (fn, delay) => { timers.set(++id, { fn, delay }); return id; };
    app.context.clearTimeout = key => timers.delete(key);
    vm.runInContext("mediaFiles.push('https://example.test/second.jpg')", app.context);
    app.get('gallery-image').onerror();
    const timerId = vm.runInContext('slideshowTimer', app.context);
    assert.equal(timers.get(timerId).delay, 3000);
    timers.get(timerId).fn();
    assert.equal(app.get('gallery-image').src, 'https://example.test/second.jpg');
    assert.equal(app.state().slideshowPlaying, true);
    app.get('gallery-image').onerror();
    const pending = vm.runInContext('slideshowTimer', app.context);
    app.get('btn-play-pause').listeners.click();
    assert.equal(timers.has(pending), false);
    assert.equal(app.state().slideshowPlaying, false);
    app.get('btn-play-pause').listeners.click();
    assert.equal(app.state().slideshowPlaying, true);
    assert.ok(timers.has(vm.runInContext('slideshowTimer', app.context)));
    app.get('btn-close-video-error').listeners.click();
    assert.equal(vm.runInContext('slideshowTimer', app.context), null);
});

async function boot({ search = '', config = shipped, configFailure = false, storageBlocked = false, empty = false } = {}) {
    class Element {
        constructor() { this.style = {}; this.children = []; this.listeners = {}; this.dataset = {}; this.hidden = false; this.classList = { add() {}, remove() {}, toggle() {} }; }
        addEventListener(name, fn) { this.listeners[name] = fn; }
        querySelector() { return new Element(); }
        setAttribute() {}
        appendChild(child) { this.children.push(child); }
        replaceChildren() { this.children = []; }
        pause() {}
        play() { return Promise.resolve(); }
    }
    const elements = new Map();
    const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    const listeners = {};
    const requests = [];
    const saved = new Map();
    const sourceLabels = [new Element(), new Element()];
    let animationFrames = 0;
    const context = vm.createContext({
        URL, URLSearchParams, AbortController, console: { warn() {}, log() {}, error() {} },
        window: { FolderFrameSettings: api, addEventListener(name, fn) { listeners[name] = fn; } },
        document: { getElementById: get, createElement: () => new Element(), querySelectorAll: () => sourceLabels,
            addEventListener() {}, body: new Element(), hidden: false },
        location: { href: base + search, search, assign(url) { this.assigned = url; } },
        localStorage: { getItem(key) { if (storageBlocked) throw new Error('Blocked'); return saved.get(key) || null; },
            setItem(key, value) { if (storageBlocked) throw new Error('Blocked'); saved.set(key, value); } },
        fetch: async url => {
            requests.push(url);
            if (url === './folderframe.config.json') return { ok: !configFailure, status: configFailure ? 404 : 200, json: async () => config };
            return { ok: true, url, text: async () => '' };
        },
        DOMParser: class { parseFromString() { return { querySelectorAll: () => empty ? [] : [{ getAttribute: () => 'photo.jpg' }] }; } },
        setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
        requestAnimationFrame: () => { animationFrames++; return 1; }, cancelAnimationFrame() {}, performance: { now: () => 0 }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
    await listeners.DOMContentLoaded();
    const state = () => JSON.parse(vm.runInContext('JSON.stringify({ currentFolder, galleryViewMode, imageMode, slideshowInterval, slideshowPlaying, isGridViewActive, mediaFiles, activeSource, rememberPreferences })', context));
    return { context, get, state, requests, saved, sourceLabels, get animationFrames() { return animationFrames; } };
}

test('pinch zoom transitions smoothly to one-finger pan and cancellation clears gestures', async () => {
    const app = await boot({ search: '?autoplay=1' });
    app.get('media-container').getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600 });
    const viewport = app.get('media-viewport');
    const point = (clientX, clientY) => ({ clientX, clientY });
    let prevented = false;
    viewport.listeners.touchstart({ touches: [point(150, 300), point(250, 300)] });
    viewport.listeners.touchmove({ touches: [point(100, 300), point(300, 300)], preventDefault() { prevented = true; } });
    assert.equal(vm.runInContext('zoom', app.context), 2);
    assert.equal(prevented, true);
    viewport.listeners.touchend({ touches: [point(300, 300)] });
    viewport.listeners.touchmove({ touches: [point(320, 330)], preventDefault() {} });
    assert.equal(vm.runInContext('panX', app.context), 20);
    assert.equal(vm.runInContext('panY', app.context), 30);
    viewport.listeners.touchcancel();
    assert.equal(vm.runInContext('isDragging || isPinching', app.context), false);
    vm.runInContext('resetZoomAndPan()', app.context);
    assert.equal(vm.runInContext('zoom', app.context), 1);
});

test('touch controls, video, and error cards do not start image gestures', async () => {
    const app = await boot({ search: '?autoplay=1' });
    const viewport = app.get('media-viewport');
    const touches = [{ clientX: 1, clientY: 1 }, { clientX: 10, clientY: 10 }];
    viewport.listeners.touchstart({ touches, target: { closest: () => ({}) } });
    assert.equal(vm.runInContext('isPinching', app.context), false);
    vm.runInContext("mediaFiles = ['https://example.test/clip.mp4']; enterFullScreenViewer(0)", app.context);
    viewport.listeners.touchstart({ touches });
    assert.equal(vm.runInContext('isPinching', app.context), false);
    vm.runInContext("showMediaError('video', mediaFiles[0], { code: 3 })", app.context);
    viewport.listeners.touchstart({ touches });
    assert.equal(vm.runInContext('isPinching', app.context), false);
});

test('focused viewer controls remain visible while idle', async () => {
    const app = await boot({ search: '?autoplay=1' });
    app.context.document.activeElement = { closest: () => ({}), matches: () => true };
    vm.runInContext('hideUI()', app.context);
    assert.equal(vm.runInContext('uiVisible', app.context), true);
    app.context.document.activeElement = null;
    vm.runInContext('hideUI()', app.context);
    assert.equal(vm.runInContext('uiVisible', app.context), false);
});

test('real startup opens and plays the viewer for embed autoplay, even with blocked storage', async () => {
    const app = await boot({ search: '?profile=embed', config: { embed: { autoplay: true, interval: 10 } }, storageBlocked: true });
    assert.equal(app.state().slideshowPlaying, true);
    assert.equal(app.state().isGridViewActive, false);
    assert.equal(app.state().slideshowInterval, 10);
    assert.equal(app.animationFrames, 0, 'wait for the image to decode before timing its slide');
    app.get('gallery-image').onload();
    assert.ok(app.animationFrames > 0);
    assert.equal(app.get('grid-view-container').style.display, 'none');
    assert.equal(app.state().mediaFiles[0], 'https://example.test/frame/photos/photo.jpg');
});

test('real startup respects paused overrides and avoids starting an empty slideshow', async () => {
    const paused = await boot({ search: '?profile=embed&autoplay=0', config: { embed: { autoplay: true } } });
    assert.equal(paused.state().isGridViewActive, true);
    assert.equal(paused.state().slideshowPlaying, false);
    const empty = await boot({ search: '?autoplay=1', empty: true });
    assert.equal(empty.state().slideshowPlaying, false);
    assert.equal(empty.get('warning-overlay').style.display, 'flex');
});

test('real startup falls back visibly on missing/invalid config and tolerates storage denial', async () => {
    for (const options of [{ configFailure: true }, { config: { defaults: { interval: 'oops' } } }]) {
        const app = await boot({ ...options, storageBlocked: true });
        assert.equal(app.state().activeSource.id, 'photos');
        assert.equal(app.state().isGridViewActive, true);
        assert.equal(app.get('config-notice').hidden, false);
        assert.match(app.get('config-notice').textContent, /built-in defaults/);
    }
});

test('real startup scans the selected root and source switching keeps the embed profile', async () => {
    const app = await boot({ search: '?profile=embed&source=two', config: { sources: [
        { id: 'one', label: 'One', path: 'photos/' }, { id: 'two', label: 'Two', path: '/library/' }
    ] } });
    assert.ok(app.requests.includes('https://example.test/library/'));
    assert.equal(app.get('source-control').hidden, false);
    assert.equal(app.get('select-source').children.length, 2);
    assert.equal(app.sourceLabels[0].textContent, '/library/');
    app.get('select-source').listeners.change({ target: { value: 'one' } });
    const next = new URL(app.context.location.assigned);
    assert.equal(next.searchParams.get('profile'), 'embed');
    assert.equal(next.searchParams.get('source'), 'one');
    assert.equal(next.searchParams.get('album'), '');
});
