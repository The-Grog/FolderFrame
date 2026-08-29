const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../settings.js');
const base = 'https://example.test/frame/index.html';
const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '../folderframe.config.json'), 'utf8'));
const normalize = raw => api.normalizeConfig(raw, base);

test('viewer shortcuts override focused buttons without native Space/Enter clicks', async () => {
    const app = await boot();
    vm.runInContext("mediaFiles.push('https://example.test/frame/photos/b.jpg'); enterFullScreenViewer(0)", app.context);
    for (const id of ['btn-image-mode', 'nav-next', 'btn-play-pause']) {
        const button = app.get(id);
        button.closest = selector => selector.split(',').map(s => s.trim()).includes('button') ? button : null;
        let nativeClicks = 0;
        const press = key => {
            let prevented = false;
            app.windowListeners.keydown({ key, target: button, preventDefault() { prevented = true; } });
            // Browsers activate a focused button on Enter keydown or Space keyup
            // unless keydown's default action was cancelled.
            if (!prevented && (key === ' ' || key === 'Enter')) nativeClicks++;
            assert.equal(prevented, true);
        };
        vm.runInContext('currentIndex = 0; setSlideshowPlaying(false)', app.context);
        press('ArrowRight');
        assert.equal(vm.runInContext('currentIndex', app.context), 1);
        press('ArrowLeft');
        assert.equal(vm.runInContext('currentIndex', app.context), 0);
        const mode = app.state().imageMode;
        press(' ');
        assert.equal(app.state().slideshowPlaying, true);
        assert.equal(app.state().imageMode, mode);
        assert.equal(vm.runInContext('currentIndex', app.context), 0);
        press('Enter');
        assert.notEqual(app.state().imageMode, mode);
        assert.equal(nativeClicks, 0);
    }
});

test('shortcuts preserve native fields and modifiers, and ignore repeated toggles', async () => {
    const app = await boot();
    vm.runInContext('enterFullScreenViewer(0)', app.context);
    let prevented = false;
    const press = extra => app.windowListeners.keydown({ key: ' ', preventDefault() { prevented = true; }, ...extra });
    for (const tag of ['select', 'input', 'textarea', 'video', 'a']) {
        press({ target: { closest: selector => selector.split(',').map(s => s.trim()).includes(tag) ? {} : null } });
    }
    press({ target: { isContentEditable: true } });
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'isComposing', 'defaultPrevented']) press({ [modifier]: true });
    assert.equal(prevented, false);
    assert.equal(app.state().slideshowPlaying, false);
    press({ repeat: true });
    assert.equal(prevented, true);
    assert.equal(app.state().slideshowPlaying, false);
    prevented = false;
    vm.runInContext('renderGridView()', app.context);
    press({});
    assert.equal(prevented, false);
    vm.runInContext('enterFullScreenViewer(0); controlsEnabled = false', app.context);
    press({});
    assert.equal(prevented, false);
});

test('gallery scrolling keys work after a tile control receives focus', async () => {
    const app = await boot();
    const container = app.get('grid-view-container');
    container.clientHeight = 1000;
    container.scrollHeight = 5000;
    container.scrollTop = 0;
    const tileControl = app.get('focused-grid-tile');
    tileControl.closest = selector => selector.split(',').map(part => part.trim()).includes('button') ? tileControl : null;
    const press = key => {
        let prevented = false;
        app.windowListeners.keydown({ key, target: tileControl, preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
    };

    press('PageDown');
    assert.equal(container.scrollTop, 850);
    press('PageUp');
    assert.equal(container.scrollTop, 0);
    press('ArrowDown');
    assert.equal(container.scrollTop, 48);
    press('ArrowUp');
    assert.equal(container.scrollTop, 0);
    press('End');
    assert.equal(container.scrollTop, 5000);
    press('Home');
    assert.equal(container.scrollTop, 0);
});

test('scan errors remain distinguishable from routine mobile timestamps', async () => {
    const app = await boot();
    const classes = new Set();
    app.get('scan-status').classList.toggle = (name, enabled) => enabled ? classes.add(name) : classes.delete(name);
    app.context.fetch = async () => { throw new Error('Network unavailable'); };
    await vm.runInContext('loadGallery()', app.context);
    assert.equal(classes.has('is-error'), true);
    assert.match(app.get('scan-status').textContent, /Scan failed/);
    vm.runInContext("setScanStatus('Updated 6:00 PM')", app.context);
    assert.equal(classes.has('is-error'), false);
});

test('empty-folder warning offers previous location, gallery root, and source escape', async () => {
    const app = await boot();
    app.context.scanDirectory = async folder => folder === 'Empty'
        ? { filePaths: [], folderNames: [] }
        : { filePaths: ['https://example.test/frame/photos/photo.jpg'], folderNames: ['Empty'] };
    await vm.runInContext("navigateToFolder('Empty')", app.context);
    assert.equal(app.get('warning-overlay').style.display, 'flex');
    assert.equal(app.get('btn-warning-previous').hidden, false);
    assert.equal(app.get('btn-warning-root').hidden, false);
    assert.equal(app.get('warning-open-source').href, 'https://example.test/frame/photos/');
    await app.get('btn-warning-previous').listeners.click();
    assert.equal(app.state().currentFolder, '');
    assert.equal(app.get('warning-overlay').style.display, 'none');

    await vm.runInContext("navigateToFolder('Empty')", app.context);
    await app.get('btn-warning-root').listeners.click();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(app.state().currentFolder, '');
});

test('empty source root hides navigation actions that cannot leave the warning', async () => {
    const app = await boot({ empty: true });
    assert.equal(app.get('warning-overlay').style.display, 'flex');
    assert.equal(app.get('btn-warning-previous').hidden, true);
    assert.equal(app.get('btn-warning-root').hidden, true);
    assert.equal(app.get('warning-open-source').href, 'https://example.test/frame/photos/');
});

test('breadcrumb links only ancestors and shows the current folder once as text', async () => {
    const app = await boot({ search: '?album=Family/2026' });
    const labels = app.get('breadcrumb').children.map(child => child.textContent);
    assert.deepEqual(labels, ['Photos', '›', 'Family']);
    assert.equal(app.get('grid-path').textContent, '2026');
    assert.equal(app.get('grid-path').title, 'Family/2026');
});

test('silent refresh preserves viewer state when files are added or reordered', async () => {
    const app = await boot({ search: '?autoplay=1' });
    vm.runInContext("zoom = 2; panX = 31; panY = 12; uiVisible = false; imageReady = true", app.context);
    const loadId = vm.runInContext('mediaLoadId', app.context);
    const controller = vm.runInContext('viewerSession.controller', app.context);
    app.context.scanDirectory = async () => ({ filePaths: [
        'https://example.test/frame/photos/aaa.jpg', 'https://example.test/frame/photos/photo.jpg'
    ], folderNames: [] });
    await vm.runInContext('loadGallery({silent:true})', app.context);
    assert.equal(vm.runInContext('mediaLoadId', app.context), loadId);
    assert.equal(vm.runInContext('viewerSession.controller', app.context), controller);
    assert.equal(vm.runInContext('zoom', app.context), 2);
    assert.equal(vm.runInContext('panX', app.context), 31);
    assert.equal(vm.runInContext('uiVisible', app.context), false);
    assert.equal(app.state().currentFolder, '');
    assert.equal(vm.runInContext('currentIndex', app.context), 1);
    assert.equal(app.state().slideshowPlaying, true);
});

test('refresh uses current identity at completion and replaces only confirmed missing media', async () => {
    const app = await boot({ search: '?autoplay=1' });
    vm.runInContext("mediaFiles.push('https://example.test/frame/photos/b.jpg')", app.context);
    let done;
    app.context.scanDirectory = () => new Promise(resolve => { done = resolve; });
    const scan = vm.runInContext('loadGallery({silent:true})', app.context);
    vm.runInContext('showMedia(1)', app.context);
    const id = vm.runInContext('mediaLoadId', app.context);
    done({ filePaths: ['https://example.test/frame/photos/b.jpg'], folderNames: [] });
    await scan;
    assert.equal(vm.runInContext('mediaLoadId', app.context), id);
    app.context.scanDirectory = async () => ({ filePaths: ['https://example.test/frame/photos/c.jpg'], folderNames: [] });
    await vm.runInContext('loadGallery({silent:true})', app.context);
    assert.ok(vm.runInContext('mediaLoadId', app.context) > id);
    assert.match(app.get('gallery-image').src, /c.jpg$/);
});

test('partial recursive scan keeps successful media and previous files below failed folders', async () => {
    const app = await boot({ search: '?autoplay=1' });
    vm.runInContext("galleryViewMode = 'all'; mediaFiles = ['https://example.test/frame/photos/Bad/old.jpg']; showMedia(0)", app.context);
    const id = vm.runInContext('mediaLoadId', app.context);
    app.context.scanDirectory = async folder => {
        if (folder === 'Bad') throw new Error('offline');
        return folder === '' ? { filePaths: [], folderNames: ['Bad', 'Good'] }
            : { filePaths: ['https://example.test/frame/photos/Good/new.jpg'], folderNames: [] };
    };
    await vm.runInContext('loadGallery({silent:true})', app.context);
    assert.equal(app.state().mediaFiles.length, 2);
    assert.equal(vm.runInContext('mediaLoadId', app.context), id);
    assert.equal(app.get('scan-failures').hidden, false);
    assert.match(app.get('scan-failure-text').textContent, /Bad/);
    assert.equal(app.get('warning-overlay').style.display, 'none');
});

test('navigation supersedes a stalled scan and late response cannot overwrite the new folder', async () => {
    const app = await boot();
    let old;
    app.context.fetch = url => url.endsWith('/Old/') ? new Promise(resolve => { old = resolve; })
        : Promise.resolve({ ok: true, text: async () => '' });
    const pending = vm.runInContext("navigateToFolder('Old')", app.context);
    await vm.runInContext("navigateToFolder('New')", app.context);
    old({ ok: true, text: async () => '' });
    await pending;
    assert.equal(app.state().currentFolder, 'New');
    assert.equal(app.get('scan-failures').hidden, true);
    assert.ok(app.state().mediaFiles[0].includes('/New/'));
});

test('root navigation failure retains previous gallery and retry targets failed destination', async () => {
    const app = await boot();
    app.context.scanDirectory = async () => { throw new Error('offline'); };
    await vm.runInContext("navigateToFolder('Bad')", app.context);
    assert.equal(app.state().currentFolder, '');
    assert.equal(app.state().mediaFiles.length, 1);
    assert.match(app.get('scan-failure-text').textContent, /Bad/);
    app.context.scanDirectory = async () => ({ filePaths: [], folderNames: [] });
    await app.get('btn-retry-scan').listeners.click();
    assert.equal(app.state().currentFolder, 'Bad');
});

test('media watchdog reports stalls, skips only while playing, and ignores superseded timers', async () => {
    for (const playing of [false, true]) {
        const app = await boot();
        const timers = [];
        app.context.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
        vm.runInContext('enterFullScreenViewer(0)', app.context);
        if (playing) vm.runInContext('setSlideshowPlaying(true)', app.context);
        const first = timers.find(t => t.delay === 30000).fn;
        first();
        assert.match(app.get('media-error-title').textContent, /too long/);
        assert.equal(timers.some(t => t.delay === 3000 && t.fn.toString().includes('nextSlideshowMedia')), playing);
        vm.runInContext('showMedia(0)', app.context);
        const newId = vm.runInContext('mediaLoadId', app.context);
        first();
        assert.equal(vm.runInContext('mediaLoadId', app.context), newId);
        assert.equal(vm.runInContext('mediaFailed', app.context), false);
    }
});

test('HEIC thumbnail observer releases its consumer offscreen and disconnects on viewer entry', async () => {
    const app = await boot();
    const observers = [];
    app.context.window.IntersectionObserver = true;
    app.context.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.items = []; observers.push(this); }
        observe(item) { this.items.push(item); }
        disconnect() { this.disconnected = true; }
    };
    const signals = [];
    app.context.getSpecialImageURL = async (_file, signal) => { signals.push(signal); return 'blob:thumb'; };
    vm.runInContext("mediaFiles = ['https://example.test/frame/photos/a.heic']; renderGridView()", app.context);
    const observer = observers.find(o => o.items.length);
    const target = observer.items[0];
    observer.callback([{ target, isIntersecting: true }]);
    await Promise.resolve(); await Promise.resolve();
    observer.callback([{ target, isIntersecting: false }]);
    assert.equal(signals[0].aborted, true);
    observer.callback([{ target, isIntersecting: true }]);
    await Promise.resolve();
    vm.runInContext('enterFullScreenViewer(0)', app.context);
    assert.equal(signals[1].aborted, true);
    assert.equal(observer.disconnected, true);
});

test('HEIC thumbnail resizing caps the long edge at 480 pixels without upscaling', async () => {
    const app = await boot();
    const revoked = [];
    app.context.URL = class extends URL {
        static createObjectURL() { return 'blob:temporary'; }
        static revokeObjectURL(url) { revoked.push(url); }
    };
    for (const [width, height, expected] of [[4000, 2000, [480, 240]], [100, 200, [100, 200]]]) {
        app.context.Image = class {
            constructor() { this.naturalWidth = width; this.naturalHeight = height; }
            set src(value) { this.onload(); }
        };
        const canvas = { getContext: () => ({ drawImage() {} }), toBlob(callback) { callback({ size: 8 }); } };
        app.context.document.createElement = () => canvas;
        await vm.runInContext('makeThumbnail({})', app.context);
        assert.deepEqual([canvas.width, canvas.height], expected);
    }
    assert.equal(revoked.length, 2);
});

test('video progress refreshes watchdog and user pause cancels it', async () => {
    const app = await boot();
    const timers = new Map(); let id = 0;
    app.context.setTimeout = (fn, delay) => { timers.set(++id, { fn, delay }); return id; };
    app.context.clearTimeout = key => timers.delete(key);
    vm.runInContext("mediaFiles = ['https://example.test/v.mp4']; enterFullScreenViewer(0)", app.context);
    const video = app.get('gallery-video');
    video.paused = false;
    video.onplaying();
    video.currentTime = 1; video.ontimeupdate();
    assert.equal([...timers.values()].filter(t => t.delay === 30000).length, 1);
    video.currentTime = 2; video.ontimeupdate();
    assert.equal([...timers.values()].filter(t => t.delay === 30000).length, 1);
    video.paused = true; video.onpause();
    assert.equal([...timers.values()].filter(t => t.delay === 30000).length, 0);
});

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

test('optional source thumbnail paths preserve nested filenames and reject unsafe URLs', () => {
    const config = normalize({ sources: [{
        id: 'photos', label: 'Photos', path: 'photos/', thumbnailPath: 'thumbnails/'
    }] });
    const source = config.sources[0];
    assert.equal(source.thumbnailUrl, 'https://example.test/frame/thumbnails/');
    assert.equal(api.thumbnailUrl(source, 'https://example.test/frame/photos/Family/My Photo.JPG'),
        'https://example.test/frame/thumbnails/Family/My%20Photo.JPG.webp');
    assert.equal(api.thumbnailUrl(normalize({}).sources[0], 'https://example.test/frame/photos/a.jpg'), null);
    for (const thumbnailPath of ['', 'file:///tmp/thumbs', 'https://user:pass@example.test/thumbs', 'thumbs/?x=1']) {
        assert.throws(() => normalize({ sources: [{ id: 'p', label: 'P', path: 'photos/', thumbnailPath }] }), /thumbnailPath/);
    }
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
test('sort defaults to filename with profile, saved preference, and URL overrides', () => {
    const config = normalize({ index: { sort: 'oldest' }, embed: { sort: 'filename' } });
    assert.equal(api.resolveSettings(normalize(shipped), '').settings.sort, 'filename');
    assert.equal(api.resolveSettings(config, '').settings.sort, 'oldest');
    assert.equal(api.resolveSettings(config, '?profile=embed').settings.sort, 'filename');
    assert.equal(api.resolveSettings(config, '', () => JSON.stringify({ sort: 'filename' })).settings.sort, 'filename');
    assert.equal(api.resolveSettings(config, '?sort=newest', () => JSON.stringify({ sort: 'filename' })).settings.sort, 'newest');
    assert.throws(() => normalize({ defaults: { sort: 'random' } }), /sort must/);
    assert.ok(api.resolveSettings(config, '?sort=invalid').warnings.length);
});

test('date sorts use Last-Modified, tie by filename, and keep missing dates last', async () => {
    const app = await boot();
    const calls = [];
    const dates = { '10.jpg': 'Wed, 01 Jan 2025 00:00:00 GMT', '2.jpg': 'Wed, 01 Jan 2025 00:00:00 GMT',
        'new.jpg': 'Thu, 01 Jan 2026 00:00:00 GMT', 'unknown.jpg': 'invalid' };
    app.context.fetch = async (url, options) => {
        calls.push(options.method);
        return { ok: true, headers: { get: () => dates[url.split('/').pop()] } };
    };
    app.context.sortFiles = Object.keys(dates).map(name => 'https://example.test/' + name);
    const names = files => Array.from(files, url => url.split('/').pop());
    const newest = await vm.runInContext("sortMediaFiles(sortFiles, 'newest')", app.context);
    assert.deepEqual(names(newest), ['new.jpg', '2.jpg', '10.jpg', 'unknown.jpg']);
    const oldest = await vm.runInContext("sortMediaFiles(sortFiles, 'oldest')", app.context);
    assert.deepEqual(names(oldest), ['2.jpg', '10.jpg', 'new.jpg', 'unknown.jpg']);
    assert.equal(calls.length, 4, 'reuses date metadata when changing sort');
    assert.ok(calls.every(method => method === 'HEAD'));
    const filenames = await vm.runInContext("sortMediaFiles(sortFiles, 'filename')", app.context);
    assert.deepEqual(names(filenames), ['2.jpg', '10.jpg', 'new.jpg', 'unknown.jpg']);
    assert.equal(calls.length, 4, 'filename sort makes no metadata requests');
});

test('sort button cycles current label and saves choice without changing source or folder', async () => {
    const app = await boot({ search: '?album=Family' });
    assert.equal(app.get('sort-label').textContent, 'Filename');
    for (const [label, value] of [['Newest', 'newest'], ['Oldest', 'oldest'], ['Filename', 'filename']]) {
        await app.get('btn-sort').listeners.click();
        assert.equal(app.get('sort-label').textContent, label);
        assert.equal(vm.runInContext('sortMode', app.context), value);
        assert.equal(app.state().currentFolder, 'Family');
        assert.equal(app.get('btn-sort').disabled, false);
        assert.equal(JSON.parse(app.saved.get(vm.runInContext('preferenceKey', app.context))).sort, value);
    }
});
test('refresh timing has profile defaults and validated config overrides', () => {
    for (const raw of [{}, shipped]) {
        const config = normalize(raw);
        assert.equal(api.resolveSettings(config, '').settings.refreshInterval, 60);
        assert.equal(api.resolveSettings(config, '?profile=embed').settings.refreshInterval, 300);
    }
    const config = normalize({ defaults: { refreshInterval: 120 }, embed: { refreshInterval: 600 } });
    assert.equal(api.resolveSettings(config, '', () => JSON.stringify({ refreshInterval: 1 })).settings.refreshInterval, 120);
    assert.equal(api.resolveSettings(config, '?profile=embed').settings.refreshInterval, 600);
    for (const value of [0, -1, 1.5, 86401, '60', null]) {
        assert.throws(() => normalize({ defaults: { refreshInterval: value } }));
    }
});

test('automatic refresh uses resolved timing and respects disabled refresh', async () => {
    for (const [search, config, seconds] of [
        ['', {}, 60], ['?profile=embed', {}, 300],
        ['', { index: { refreshInterval: 120 } }, 120]
    ]) {
        const app = await boot({ search, config });
        const delays = [];
        app.context.setInterval = (_callback, delay) => { delays.push(delay); return 1; };
        vm.runInContext('startAutoRefreshTimer()', app.context);
        assert.deepEqual(delays, [seconds * 1000]);
        vm.runInContext('autoRefreshEnabled = false; startAutoRefreshTimer()', app.context);
        assert.equal(delays.length, 1);
    }
});

test('long slideshow intervals resolve from config saved preferences and URL and reach the timer', async () => {
    for (const interval of [300, 900, 3600]) {
        assert.equal(api.resolveSettings(normalize({ embed: { interval } }), '?profile=embed').settings.interval, interval);
        assert.equal(api.resolveSettings(normalize({}), '', () => JSON.stringify({ interval })).settings.interval, interval);
        const app = await boot({ search: '?autoplay=1&interval=' + interval });
        assert.equal(app.get('select-interval').value, String(interval));
        let tick;
        app.context.requestAnimationFrame = callback => { tick = callback; return 1; };
        vm.runInContext('imageReady = true; startSlideshowTimer()', app.context);
        tick(interval * 500);
        assert.equal(app.get('progress-bar').style.width, '50%');
    }
});

test('date cache persists across reloads and manual refresh replaces stored dates', async () => {
    const app = await boot();
    app.context.sortFiles = ['https://example.test/frame/photos/a.jpg'];
    app.context.fetch = async () => ({ ok: true, headers: { get: () => 'Thu, 01 Jan 2026 00:00:00 GMT' } });
    await vm.runInContext("sortMediaFiles(sortFiles, 'newest')", app.context);
    const key = vm.runInContext('dateCacheKey', app.context);
    const stored = app.saved.get(key);
    assert.equal(JSON.parse(stored).length, 1);
    const reload = await boot();
    reload.saved.set(key, stored);
    reload.context.sortFiles = app.context.sortFiles;
    let calls = 0;
    reload.context.fetch = async () => { calls++; return { ok: true, headers: { get: () => 'Fri, 02 Jan 2026 00:00:00 GMT' } }; };
    await vm.runInContext("sortMediaFiles(sortFiles, 'oldest')", reload.context);
    assert.equal(calls, 0);
    await vm.runInContext("sortMediaFiles(sortFiles, 'oldest', true)", reload.context);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(reload.saved.get(key))[0][1].date, Date.parse('2026-01-02T00:00:00Z'));
});

test('date cache expires after 24 hours and evicts oldest checked entries', async () => {
    const app = await boot();
    vm.runInContext('loadDateCache()', app.context);
    const key = vm.runInContext('dateCacheKey', app.context);
    const now = Date.now();
    const root = 'https://example.test/frame/photos/';
    const entries = Array.from({ length: 2002 }, (_, i) => [root + i + '.jpg', { date: i, checked: now - 5000 + i }]);
    entries.push([root + 'expired.jpg', { date: 1, checked: now - 86400000 }]);
    entries.push([root + 'future.jpg', { date: 1, checked: now + 86400000 }]);
    app.saved.set(key, JSON.stringify(entries));
    vm.runInContext('dateCacheKey = null; loadDateCache(); saveDateCache()', app.context);
    const kept = JSON.parse(app.saved.get(key));
    assert.equal(kept.length, 2000);
    assert.equal(kept[0][0], root + '2.jpg');
    assert.ok(!kept.some(([url]) => /expired|future/.test(url)));
    app.context.sortFiles = [root + 'expired.jpg'];
    let calls = 0;
    app.context.fetch = async () => { calls++; return { ok: true, headers: { get: () => null } }; };
    await vm.runInContext("sortMediaFiles(sortFiles, 'newest')", app.context);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(app.saved.get(key)).length, 2000);
});

test('date cache tolerates corrupt or unavailable storage and isolates sources', async () => {
    for (const blocked of [false, true]) {
        const app = await boot({ storageBlocked: blocked });
        const key = vm.runInContext('loadDateCache(); dateCacheKey', app.context);
        app.saved.set(key, '{broken');
        vm.runInContext('dateCacheKey = null', app.context);
        app.context.sortFiles = ['https://example.test/frame/photos/a.jpg'];
        let calls = 0;
        app.context.fetch = async () => { calls++; return { ok: true, headers: { get: () => null } }; };
        if (!blocked) app.context.localStorage.setItem = () => { throw new Error('Quota exceeded'); };
        await vm.runInContext("sortMediaFiles(sortFiles, 'newest')", app.context);
        await vm.runInContext("sortMediaFiles(sortFiles, 'oldest')", app.context);
        assert.equal(calls, 1, 'memory fallback avoids repeated requests');
        vm.runInContext("activeSource = { id: 'other', url: 'https://other.test/photos/' }; loadDateCache()", app.context);
        assert.notEqual(vm.runInContext('dateCacheKey', app.context), key);
        assert.equal(vm.runInContext('modifiedDateCache.size', app.context), 0);
    }
});

test('failed date requests fall back to filenames and explicit refresh retries metadata', async () => {
    const app = await boot();
    let calls = 0;
    app.context.fetch = async () => { calls++; throw new Error('HEAD blocked'); };
    app.context.sortFiles = ['https://example.test/10.jpg', 'https://example.test/2.jpg'];
    const result = await vm.runInContext("sortMediaFiles(sortFiles, 'newest')", app.context);
    assert.equal(result[0], 'https://example.test/2.jpg');
    await vm.runInContext("sortMediaFiles(sortFiles, 'oldest', true)", app.context);
    assert.equal(calls, 4);
});

test('date lookup limits parallel requests and abort stops remaining work', async () => {
    const app = await boot();
    app.context.sortFiles = Array.from({ length: 12 }, (_, i) => 'https://example.test/' + i + '.jpg');
    let timeout;
    app.context.setTimeout = callback => { timeout = callback; return 77; };
    let calls = 0;
    app.context.fetch = (_, options) => {
        calls++;
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const pending = vm.runInContext("sortMediaFiles(sortFiles, 'newest')", app.context);
    assert.equal(calls, 4);
    timeout();
    const result = await pending;
    assert.equal(calls, 4);
    assert.equal(result.length, 12);
});

test('album preview selects the first naturally sorted image, skipping videos', async () => {
    const app = await boot();
    app.context.DOMParser = class { parseFromString() {
        return { querySelectorAll: () => ['10.jpg', '2.jpg', '1.mp4', 'Nested/'].map(href => ({ getAttribute: () => href })) };
    } };
    const item = app.get('test-album');
    const classes = new Set();
    item.classList = { add: name => classes.add(name), remove: name => classes.delete(name) };
    app.context.albumItem = item;
    await vm.runInContext("loadAlbumPreview(albumItem, 'Family', new AbortController().signal)", app.context);
    assert.equal(item.children.length, 1);
    const cover = item.children[0];
    assert.equal(cover.src, 'https://example.test/frame/photos/Family/2.jpg');
    assert.equal(cover.hidden, true);
    cover.onload();
    assert.equal(cover.hidden, false);
    assert.ok(classes.has('has-album-cover'));
    cover.onerror();
    assert.equal(cover.hidden, true);
    assert.equal(classes.has('has-album-cover'), false);
    assert.equal(app.requests.some(url => url.endsWith('/Nested/')), false);
});

test('album covers prefer generated thumbnails and fall back to originals', async () => {
    const app = await boot({ config: { sources: [{
        id: 'photos', label: 'Photos', path: 'photos/', thumbnailPath: 'thumbs/'
    }] } });
    app.context.DOMParser = class { parseFromString() {
        return { querySelectorAll: () => [{ getAttribute: () => 'cover.jpg' }] };
    } };
    const item = app.get('thumbnail-album');
    app.context.thumbnailAlbum = item;
    await vm.runInContext("loadAlbumPreview(thumbnailAlbum, 'Family', new AbortController().signal)", app.context);
    const cover = item.children[0];
    assert.equal(cover.src, 'https://example.test/frame/thumbs/Family/cover.jpg.webp');
    cover.onerror();
    await Promise.resolve();
    assert.equal(cover.src, 'https://example.test/frame/photos/Family/cover.jpg');
});

test('empty, video-only, and failed album listings retain the folder fallback', async () => {
    const app = await boot();
    app.context.albumItem = app.get('test-album');
    for (const entries of [[], ['clip.mp4', 'Nested/']]) {
        app.context.DOMParser = class { parseFromString() {
            return { querySelectorAll: () => entries.map(href => ({ getAttribute: () => href })) };
        } };
        await vm.runInContext("loadAlbumPreview(albumItem, 'Empty', new AbortController().signal)", app.context);
        assert.equal(app.context.albumItem.children.length, 0);
    }
    app.context.fetch = async () => { throw new Error('offline'); };
    await vm.runInContext("loadAlbumPreview(albumItem, 'Offline', new AbortController().signal)", app.context);
    assert.equal(app.context.albumItem.children.length, 0);
});

test('HEIC album covers reuse conversion and aborted loads cannot update old tiles', async () => {
    const app = await boot();
    app.context.albumItem = app.get('test-album');
    app.context.DOMParser = class { parseFromString() {
        return { querySelectorAll: () => [{ getAttribute: () => 'cover.heic' }] };
    } };
    vm.runInContext("getSpecialImageURL = async () => 'blob:cover'", app.context);
    await vm.runInContext("loadAlbumPreview(albumItem, 'Family', new AbortController().signal)", app.context);
    assert.equal(app.context.albumItem.children[0].src, 'blob:cover');
    let finish;
    app.context.fetch = () => new Promise(resolve => { finish = resolve; });
    const controller = new AbortController();
    app.context.coverSignal = controller.signal;
    const pending = vm.runInContext("loadAlbumPreview(albumItem, 'Other', coverSignal)", app.context);
    controller.abort();
    finish({ ok: true, text: async () => '' });
    await pending;
    assert.equal(app.context.albumItem.children.length, 1);
});

test('album cover queue limits concurrent lookups and cancels queued work', async () => {
    const app = await boot();
    const pending = [];
    let calls = 0;
    app.context.loadAlbumPreview = async () => {
        calls++;
        await new Promise(resolve => pending.push(resolve));
    };
    const observe = vm.runInContext('startAlbumPreviews()', app.context);
    for (let i = 0; i < 8; i++) observe({ dataset: { albumFolder: 'Album' + i } });
    assert.equal(calls, 3);
    pending.shift()();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls, 4);
    vm.runInContext('stopAlbumPreviews()', app.context);
    pending.forEach(resolve => resolve());
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls, 4);
});

test('logo returns index and embed to the current source root without restarting playback', async () => {
    for (const profile of ['index', 'embed']) {
        const app = await boot({ search: '?profile=' + profile + '&album=Family/2026',
            config: { sources: [{ id: 'family', label: 'Family', path: '/family/' }] } });
        app.get('grid-view-container').scrollTop = 300;
        await app.get('btn-gallery-home').listeners.click();
        assert.equal(app.state().currentFolder, '');
        assert.equal(app.state().activeSource.id, 'family');
        assert.equal(app.state().isGridViewActive, true);
        assert.equal(app.state().slideshowPlaying, false);
        assert.equal(app.get('grid-view-container').scrollTop, 0);
        assert.ok(app.requests.includes('https://example.test/family/'));
    }
});

test('fitted-photo swipes navigate, while vertical, short and cancelled gestures do not', async () => {
    const app = await boot({ search: '?autoplay=1' });
    vm.runInContext("mediaFiles.push('https://example.test/second.jpg')", app.context);
    const viewport = app.get('media-viewport');
    const point = (x, y) => ({ identifier: 1, clientX: x, clientY: y });
    const swipe = (x, y) => {
        viewport.listeners.touchstart({ touches: [point(200, 200)] });
        viewport.listeners.touchend({ touches: [], changedTouches: [point(x, y)] });
    };
    swipe(100, 205);
    assert.equal(vm.runInContext('currentIndex', app.context), 1);
    swipe(300, 205);
    assert.equal(vm.runInContext('currentIndex', app.context), 0);
    swipe(190, 200);
    swipe(170, 350);
    assert.equal(vm.runInContext('currentIndex', app.context), 0);
    viewport.listeners.touchstart({ touches: [point(200, 200)] });
    viewport.listeners.touchcancel();
    viewport.listeners.touchend({ touches: [], changedTouches: [point(100, 200)] });
    assert.equal(vm.runInContext('currentIndex', app.context), 0);
    vm.runInContext('zoom = 2', app.context);
    swipe(100, 200);
    assert.equal(vm.runInContext('currentIndex', app.context), 0);
    vm.runInContext("zoom = 1; imageMode = 'original'", app.context);
    swipe(100, 200);
    assert.equal(vm.runInContext('currentIndex', app.context), 0);
});

test('filename setting validates booleans and supports profile and URL precedence', async () => {
    const config = normalize({ embed: { showFilenames: false } });
    assert.equal(api.resolveSettings(config, '').settings.showFilenames, true);
    assert.equal(api.resolveSettings(config, '?profile=embed').settings.showFilenames, false);
    assert.equal(api.resolveSettings(config, '?profile=embed&showFilenames=1').settings.showFilenames, true);
    assert.throws(() => normalize({ defaults: { showFilenames: 'no' } }), /showFilenames/);
    const app = await boot({ search: '?showFilenames=0&autoplay=1' });
    assert.equal(app.get('gallery-image').alt, 'photo.jpg');
});

test('returning to the grid restores the original tile and scroll position after browsing', async () => {
    const app = await boot();
    app.get('grid-view-container').scrollTop = 640;
    vm.runInContext("mediaFiles.push('https://example.test/second.jpg'); enterFullScreenViewer(0); nextMedia()", app.context);
    app.get('grid-view-container').scrollTop = 0;
    const create = app.context.document.createElement;
    const marked = [];
    app.context.document.createElement = () => {
        const el = create();
        el.classList.add = name => { if (name === 'returned-tile') marked.push(el); };
        return el;
    };
    vm.runInContext('renderGridView()', app.context);
    assert.equal(app.get('grid-view-container').scrollTop, 640);
    assert.equal(marked.length, 1);
    assert.equal(marked[0].children[0].src, 'https://example.test/frame/photos/photo.jpg');
    assert.equal(vm.runInContext('gridReturn', app.context), null);
});

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

test('generated grid thumbnails fall back to originals without failing the tile', async () => {
    const config = { sources: [{ id: 'photos', label: 'Photos', path: 'photos/', thumbnailPath: 'thumbs/' }] };
    const app = await boot({ config });
    let tile = app.get('thumbnail-grid').children[0];
    let image = tile.children[0];
    assert.equal(image.src, 'https://example.test/frame/thumbs/photo.jpg.webp');
    image.onerror();
    assert.equal(image.src, 'https://example.test/frame/photos/photo.jpg');
    image.onload();
    assert.equal(tile.failedPreview, undefined);

});

test('large grids render incrementally and keep a bounded media-tile DOM window', async () => {
    const app = await boot();
    app.context.largeFiles = Array.from({ length: 15633 }, (_, index) =>
        `https://example.test/frame/photos/image-${String(index).padStart(5, '0')}.jpg`);
    vm.runInContext('mediaFiles = largeFiles; renderGridView()', app.context);
    const grid = app.get('thumbnail-grid');
    const mediaCount = () => grid.querySelectorAll('.media-tile').length;
    assert.equal(mediaCount(), 100);
    assert.equal(grid.querySelectorAll('.virtual-spacer').length, 1);
    const container = app.get('grid-view-container');
    container.clientHeight = 900;
    app.get('thumbnail-grid').clientWidth = 1200;
    container.scrollTop = 20000;
    container.scrollHeight = 1000000;
    vm.runInContext('gridVirtualizer.update()', app.context);
    assert.ok(mediaCount() <= 300);
    const forwardStart = vm.runInContext('gridVirtualizer.start', app.context);
    assert.ok(forwardStart > 0);
    container.scrollTop = 500000;
    container.listeners.scroll();
    assert.ok(vm.runInContext('gridVirtualizer.start', app.context) > forwardStart);
    assert.ok(mediaCount() <= 300);
    container.scrollTop = 0;
    container.scrollHeight = 1000000;
    container.listeners.scroll();
    assert.ok(vm.runInContext('gridVirtualizer.start', app.context) < forwardStart);
    assert.ok(mediaCount() <= 300);
});

test('confirmed empty albums disappear and scrolling reveals Back to Top', async () => {
    const app = await boot();
    const item = app.get('empty-album-item');
    app.context.emptyAlbumItem = item;
    app.context.DOMParser = class { parseFromString() { return { querySelectorAll: () => [] }; } };
    await vm.runInContext("loadAlbumPreview(emptyAlbumItem, 'Empty', new AbortController().signal)", app.context);
    assert.equal(item.hidden, true);
    assert.equal(item.dataset.emptyAlbum, 'true');
    const container = app.get('grid-view-container');
    container.scrollTop = 500;
    container.listeners.scroll();
    assert.equal(app.get('btn-back-to-top').hidden, false);
    app.get('btn-back-to-top').listeners.click();
    assert.equal(container.scrollTop, 0);
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
    app.get('btn-retry-media-error').listeners.click();
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
        constructor() { this.style = {}; this.children = []; this.listeners = {}; this.dataset = {}; this.hidden = false; this._innerHTML = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
        addEventListener(name, fn) { this.listeners[name] = fn; }
        querySelector() { return new Element(); }
        querySelectorAll(selector) {
            const classes = selector.split(',').map(part => part.trim().replace(/^\./, ''));
            return this.children.filter(child => classes.some(name => (child.className || '').split(/\s+/).includes(name)));
        }
        setAttribute() {}
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
        replaceChildren() { this.children = []; }
        remove() {
            if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
        }
        set innerHTML(value) { this._innerHTML = value; if (value === '') this.children = []; }
        get innerHTML() { return this._innerHTML; }
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
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../resilience.js'), 'utf8'), context);
    context.window.FolderFrameResilience = context.FolderFrameResilience;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
    await listeners.DOMContentLoaded();
    const state = () => JSON.parse(vm.runInContext('JSON.stringify({ currentFolder, galleryViewMode, imageMode, slideshowInterval, slideshowPlaying, isGridViewActive, mediaFiles, activeSource, rememberPreferences })', context));
    return { context, get, state, requests, saved, sourceLabels, windowListeners: listeners, get animationFrames() { return animationFrames; } };
}

test('pinch zoom transitions smoothly to one-finger pan and cancellation clears gestures', async () => {
    const app = await boot({ search: '?autoplay=1' });
    app.get('media-viewport').getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600 });
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

test('off-center pinch is stable across repeated moves, zoom out, and midpoint movement', async () => {
    const app = await boot({ search: '?autoplay=1' });
    const viewport = app.get('media-viewport');
    viewport.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 600 });
    app.get('media-container').getBoundingClientRect = () => { throw new Error('Do not measure transformed bounds'); };
    const touches = (distance, x = 310, y = 420) => [
        { clientX: x - distance / 2, clientY: y },
        { clientX: x + distance / 2, clientY: y }
    ];
    viewport.listeners.touchstart({ touches: touches(100) });
    const move = (distance, x, y) => viewport.listeners.touchmove({ touches: touches(distance, x, y), preventDefault() {} });
    move(200);
    assert.equal(vm.runInContext('panX', app.context), -100);
    assert.equal(vm.runInContext('panY', app.context), -100);
    move(200);
    assert.equal(vm.runInContext('panX', app.context), -100);
    move(150);
    assert.equal(vm.runInContext('panX', app.context), -50);
    move(200, 330, 450);
    assert.equal(vm.runInContext('panX', app.context), -80);
    assert.equal(vm.runInContext('panY', app.context), -70);
    move(100);
    assert.equal(vm.runInContext('zoom', app.context), 1);
    assert.equal(vm.runInContext('panX', app.context), 0);
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
