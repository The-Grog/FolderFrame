const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const api = require('../settings.js');
const base = 'https://example.test/frame/index.html';
const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '../folderframe.config.json'), 'utf8'));
const normalize = raw => api.normalizeConfig(raw, base);
const normalizeConfigCopy = source => {
    const config = JSON.parse(JSON.stringify(shipped));
    Object.assign(config.sources[0], source);
    return config;
};
function bmff(major, compatible = []) {
    const brands = [major, ...compatible];
    const bytes = Buffer.alloc(16 + compatible.length * 4);
    bytes.writeUInt32BE(bytes.length, 0); bytes.write('ftyp', 4, 'ascii');
    brands.forEach((brand, index) => bytes.write(brand, 8 + index * 4, 4, 'ascii'));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

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

test('Escape exits the viewer and returns to the gallery', async () => {
    const app = await boot({ search: '?autoplay=1' });
    vm.runInContext('zoom = 2; panX = 40; panY = 20', app.context);
    let prevented = false;
    app.windowListeners.keydown({ key: 'Escape', target: app.get('btn-play-pause'),
        preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(app.state().isGridViewActive, true);
    assert.equal(app.state().slideshowPlaying, true);
    assert.equal(app.get('grid-view-container').style.display, 'flex');
});

test('Escape moves up one gallery folder and does nothing at the source root', async () => {
    const app = await boot();
    vm.runInContext("currentFolder = '2024/Trip'; globalThis.escapeTarget = null; navigateToFolder = folder => { globalThis.escapeTarget = folder; return Promise.resolve(true); }", app.context);
    let prevented = false;
    app.windowListeners.keydown({ key: 'Escape', target: app.get('thumbnail-grid'),
        preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(app.context.escapeTarget, '2024');

    vm.runInContext("currentFolder = ''; globalThis.escapeTarget = null", app.context);
    prevented = false;
    app.windowListeners.keydown({ key: 'Escape', target: app.get('thumbnail-grid'),
        preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(app.context.escapeTarget, null);
});

test('viewer options menu owns secondary controls and closes before Escape exits viewer', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    const menu = html.indexOf('id="viewer-options-menu"');
    const headerEnd = html.indexOf('</header>', menu);
    for (const id of ['btn-shuffle', 'btn-reset-zoom', 'btn-fullscreen', 'btn-tv-mode',
        'select-interval', 'btn-download', 'btn-copy-link', 'btn-copy-filename']) {
        const position = html.indexOf(`id="${id}"`);
        assert.ok(position > menu && position < headerEnd);
    }
    const options = html.indexOf('id="btn-viewer-options"');
    for (const id of ['btn-play-pause', 'btn-image-mode', 'btn-rotate']) {
        const position = html.indexOf(`id="${id}"`);
        assert.ok(position > 0 && position < options);
    }

    const app = await boot();
    vm.runInContext('enterFullScreenViewer(0)', app.context);
    const panel = app.get('viewer-options-menu');
    assert.equal(panel.hidden, true);
    app.get('btn-viewer-options').listeners.click();
    assert.equal(panel.hidden, false);
    let prevented = false;
    app.windowListeners.keydown({ key: 'Escape', target: app.get('btn-viewer-options'),
        preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(panel.hidden, true);
    assert.equal(app.state().isGridViewActive, false);
    app.windowListeners.keydown({ key: 'Escape', target: app.get('btn-viewer-options'), preventDefault() {} });
    assert.equal(app.state().isGridViewActive, true);
});

test('gallery glow controls keep reload adaptive and the unified path bar owns logo and count', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    const menu = html.indexOf('id="grid-options-menu"');
    const headerEnd = html.indexOf('</header>', menu);
    for (const id of ['btn-auto-refresh']) {
        const position = html.indexOf(`id="${id}"`);
        assert.ok(position > menu && position < headerEnd);
    }
    assert.ok(html.indexOf('id="grid-refresh-slot"') < html.indexOf('id="grid-options"'));
    assert.ok(html.indexOf('id="grid-refresh-menu-slot"') > menu && html.indexOf('id="grid-refresh-menu-slot"') < headerEnd);
    assert.ok(html.indexOf('id="grid-density-slot"') < html.indexOf('id="grid-options"'));
    assert.ok(html.indexOf('id="grid-density-menu-slot"') > menu && html.indexOf('id="grid-density-menu-slot"') < headerEnd);
    for (const id of ['grid-view-mode-menu-slot', 'grid-sort-menu-slot']) {
        const position = html.indexOf(`id="${id}"`);
        assert.ok(position > menu && position < headerEnd);
    }
    const pathBar = html.indexOf('class="gallery-path-bar"');
    const sourceControl = html.indexOf('id="source-control"', pathBar);
    for (const id of ['breadcrumb', 'grid-path']) {
        const position = html.indexOf(`id="${id}"`);
        assert.ok(position > pathBar && position < sourceControl);
    }
    assert.ok(html.indexOf('id="btn-gallery-home"') < pathBar);
    const homeStart = html.indexOf('id="btn-gallery-home"');
    const homeEnd = html.indexOf('</button>', homeStart);
    assert.ok(html.indexOf('id="source-root-label"') > homeStart && html.indexOf('id="source-root-label"') < homeEnd);
    const statusStack = html.indexOf('class="grid-status-stack"');
    const headerEndPosition = html.indexOf('</header>');
    assert.ok(statusStack > headerEndPosition);
    assert.ok(html.indexOf('id="grid-count"') > statusStack);
    assert.ok(html.indexOf('id="scan-status"') > html.indexOf('id="grid-count"'));
    const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
    assert.match(css, /#grid-header\s*\{[^}]*position:sticky/s);
    assert.match(css, /#grid-header \.grid-actions\s*\{[^}]*justify-content:flex-end/s);
    assert.match(css, /#grid-header \.grid-actions\s*\{[^}]*flex-wrap:nowrap/s);
    assert.match(css, /#grid-header\s*\{[^}]*flex-wrap:nowrap/s);
    assert.match(css, /\.grid-options\s*\{[^}]*margin-left:0/s);
    assert.match(css, /--ff-glow:/);
    assert.match(css, /--ff-pill-bg:/);
    assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
    const viewerHome = html.slice(html.indexOf('id="btn-show-grid"'), html.indexOf('</button>', html.indexOf('id="btn-show-grid"')));
    assert.match(viewerHome, /ff-btn-home/);
    assert.match(viewerHome, /docs\/images\/folderframe-logo-back\.png/);
    assert.match(html, /id="overlay-header" class="overlay ff-header"/);
    assert.match(html, /class="header-left ff-header-left ff-pill"/);
    assert.match(html, /class="header-right ff-header-right ff-pill"/);
    assert.match(html, /id="grid-header" class="overlay ff-header header-nav-container"/);
    assert.match(html, /class="grid-header-main header-nav ff-header-left ff-pill"/);
    assert.match(html, /class="header-right grid-actions ff-header-right ff-pill"/);

    const app = await boot();
    assert.equal(app.get('grid-options-menu').hidden, true);
    app.get('btn-grid-options').listeners.click();
    assert.equal(app.get('grid-options-menu').hidden, false);
    let prevented = false;
    app.windowListeners.keydown({ key: 'Escape', target: app.get('btn-grid-options'),
        preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(app.get('grid-options-menu').hidden, true);
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
    vm.runInContext("setScanProgress('Scanning… 2711 folders checked · 13371 files found')", app.context);
    assert.equal(app.get('scan-status').textContent, 'Updated 6:00 PM');
    assert.match(app.get('scan-loading-text').textContent, /2711 folders checked/);
});

test('empty-folder warning offers previous location, gallery root, and source escape', async () => {
    const app = await boot();
    app.context.scanDirectory = async folder => folder === 'Empty'
        ? { filePaths: [], folderNames: [] }
        : { filePaths: ['https://example.test/frame/photos/photo.jpg'], folderNames: ['Empty'] };
    await vm.runInContext("navigateToFolder('Empty')", app.context);
    assert.equal(app.get('warning-overlay').style.display, 'flex');
    assert.equal(app.get('warning-title').textContent, 'Album Is Empty');
    assert.match(app.get('warning-message').textContent, /remain in this album/);
    assert.equal(app.get('btn-warning-previous').hidden, false);
    assert.equal(app.get('btn-warning-root').hidden, false);
    assert.equal(app.get('btn-retry-warning').hidden, false);
    assert.equal(app.get('warning-server-help').hidden, true);
    assert.equal(app.get('warning-open-source').hidden, true);
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
    assert.deepEqual(labels, ['Family']);
    assert.equal(app.get('source-root-label').textContent, 'Photos');
    assert.equal(app.get('breadcrumb-root-separator').hidden, false);
    assert.equal(app.get('current-path-separator').hidden, false);
    assert.equal(app.get('grid-path').textContent, '2026');
    assert.equal(app.get('grid-path').title, 'Family/2026');
    assert.equal(app.get('grid-count').textContent, '1 File');
});

test('album navigation uses browser history for mouse back and forward buttons', async () => {
    const app = await boot();
    assert.equal(app.historyCalls.replace.at(-1), 'https://example.test/frame/index.html');
    await vm.runInContext("navigateToFolder('Family')", app.context);
    assert.equal(app.historyCalls.push.at(-1), 'https://example.test/frame/index.html?album=Family');
    app.context.location.href = 'https://example.test/frame/';
    app.context.location.search = '';
    await app.windowListeners.popstate();
    assert.equal(app.state().currentFolder, '');
    assert.equal(app.historyCalls.push.length, 1);
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
        if (folder === 'Bad') throw Object.assign(new Error('HTTP 404'), { name: 'HTTPError', status: 404 });
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

test('missing current album stops playback, clears stale media, and repairs the saved album', async () => {
    const app = await boot({ search: '?album=Family/2026&autoplay=1' });
    app.context.scanDirectory = async () => {
        throw Object.assign(new Error('HTTP 404'), { name: 'HTTPError', status: 404 });
    };
    await vm.runInContext('loadGallery({silent:true})', app.context);
    assert.equal(app.state().slideshowPlaying, false);
    assert.equal(app.state().currentFolder, 'Family');
    assert.equal(app.state().mediaFiles.length, 0);
    assert.equal(app.get('warning-overlay').style.display, 'flex');
    assert.equal(app.get('warning-title').textContent, 'Album No Longer Available');
    assert.equal(app.get('btn-retry-warning').hidden, true);
    assert.equal(app.get('btn-warning-previous').textContent, 'Parent folder');
    assert.equal(app.get('btn-warning-previous').hidden, false);
    assert.equal(app.get('btn-warning-root').hidden, false);
    assert.equal(app.get('warning-server-help').hidden, true);
    assert.equal(app.get('warning-open-source').hidden, true);
    const saved = JSON.parse(app.saved.get(vm.runInContext('preferenceKey', app.context)));
    assert.equal(saved.album, 'Family');

    app.context.scanDirectory = async folder => ({
        filePaths: [`https://example.test/frame/photos/${folder}/parent.jpg`], folderNames: []
    });
    await app.get('btn-warning-previous').listeners.click();
    assert.equal(app.state().currentFolder, 'Family');
    assert.equal(app.get('warning-overlay').style.display, 'none');

    const reloaded = await boot({ initialStorage: app.saved });
    assert.equal(reloaded.state().currentFolder, 'Family');
    assert.ok(reloaded.requests.some(url => /\/photos\/Family\/$/.test(url)));
    assert.equal(reloaded.requests.some(url => /\/photos\/Family\/2026\/$/.test(url)), false);
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
    app.context.scanDirectory = async () => {
        throw Object.assign(new Error('HTTP 500'), { name: 'HTTPError', status: 500 });
    };
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

test('grid density supports config, saved preference, and URL precedence', () => {
    const config = normalize({
        defaults: { gridDensity: 'spacious' },
        embed: { gridDensity: 'compact' }
    });
    assert.equal(api.resolveSettings(normalize(shipped), '').settings.gridDensity, 'comfortable');
    assert.equal(api.resolveSettings(config, '').settings.gridDensity, 'spacious');
    assert.equal(api.resolveSettings(config, '?profile=embed').settings.gridDensity, 'compact');
    assert.equal(api.resolveSettings(config, '', () => JSON.stringify({ gridDensity: 'comfortable' })).settings.gridDensity, 'comfortable');
    assert.equal(api.resolveSettings(config, '?density=compact', () => JSON.stringify({ gridDensity: 'spacious' })).settings.gridDensity, 'compact');
    assert.throws(() => normalize({ defaults: { gridDensity: 'tiny' } }), /gridDensity must/);
    assert.ok(api.resolveSettings(config, '?density=invalid').warnings.length);
});

test('grid density cycles, persists, and keeps phone virtualizer math aligned', async () => {
    const app = await boot();
    const rootStyle = app.context.document.documentElement.style;
    assert.equal(rootStyle['--grid-tile-min'], '180px');
    assert.equal(app.get('grid-density-label').textContent, 'Comfortable');

    await app.get('btn-grid-density').listeners.click();
    assert.equal(vm.runInContext('gridDensity', app.context), 'spacious');
    assert.equal(rootStyle['--grid-tile-min'], '240px');
    assert.equal(JSON.parse(app.saved.get(vm.runInContext('preferenceKey', app.context))).gridDensity, 'spacious');

    vm.runInContext("applyGridDensity('compact'); mediaFiles = Array.from({ length: 1000 }, (_, i) => 'https://example.test/' + i + '.jpg')", app.context);
    app.get('thumbnail-grid').clientWidth = 500;
    app.get('grid-view-container').clientWidth = 500;
    vm.runInContext('renderGridView()', app.context);
    const grid = app.get('thumbnail-grid');
    const bottomSpacer = grid.children[grid.children.length - 1];
    const min = 130 * 0.667, gap = 12;
    const columns = Math.floor((500 + gap) / (min + gap));
    const rowHeight = Math.max(min, (500 - gap * (columns - 1)) / columns) + gap;
    const expected = (Math.ceil(1000 / columns) - Math.ceil(100 / columns)) * rowHeight;
    assert.equal(bottomSpacer.style.height, expected + 'px');
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
        assert.equal(api.resolveSettings(config, '').settings.refreshInterval, 120);
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
        ['', {}, 120], ['?profile=embed', {}, 300],
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
    const subtitle = app.get('test-album-subtitle');
    item.querySelector = selector => selector === '.album-subtitle' ? subtitle : null;
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
    assert.equal(subtitle.textContent, '3 items');
    assert.equal(item.dataset.directFiles, '3');
    assert.equal(item.dataset.directFolders, '1');
    assert.equal(app.requests.filter(url => url.endsWith('/Family/')).length, 1, 'count reuses the cover listing');
    cover.onerror();
    assert.equal(cover.hidden, true);
    assert.equal(classes.has('has-album-cover'), false);
    assert.equal(app.requests.some(url => url.endsWith('/Nested/')), false);
});

test('optional persistent manifest paths resolve safely and require JSON', () => {
    const source = normalize({ sources: [{
        id: 'photos', label: 'Photos', path: 'photos/',
        thumbnailPath: 'thumbnails/', manifestPath: 'folderframe-data/library.json'
    }] }).sources[0];
    assert.equal(source.manifestUrl, 'https://example.test/frame/folderframe-data/library.json');
    assert.equal(source.discoveryMode, 'auto');
    assert.equal(normalize({ sources: [{
        id: 'static', label: 'Static', path: 'photos/',
        manifestPath: 'folderframe-data/library.json', discoveryMode: 'manifest'
    }] }).sources[0].discoveryMode, 'manifest');
    assert.equal(normalize({ sources: [{
        id: 'live', label: 'Live', path: 'photos/', discoveryMode: 'directory'
    }] }).sources[0].discoveryMode, 'directory');
    assert.throws(() => normalize({ sources: [{
        id: 'bad', label: 'Bad', path: 'photos/', discoveryMode: 'manifest'
    }] }), /requires manifestPath/);
    assert.throws(() => normalize({ sources: [{
        id: 'bad', label: 'Bad', path: 'photos/', discoveryMode: 'clever'
    }] }), /discoveryMode/);
    for (const manifestPath of ['', 'file:///tmp/index.json', 'https://user:pass@example.test/index.json',
        'index.json?old=1', 'index.txt', '..\\index.json']) {
        assert.throws(() => normalize({ sources: [{ id: 'p', label: 'P', path: 'photos/', manifestPath }] }), /manifestPath/);
    }
});

test('folder-only albums flow a bounded descendant image up as their cover', async () => {
    const app = await boot();
    const calls = [];
    app.context.scanDirectory = async folder => {
        calls.push(folder);
        if (folder === '2025') return { filePaths: [], folderNames: ['January'] };
        if (folder === '2025/January') return { filePaths: [], folderNames: ['01'] };
        return { filePaths: ['https://example.test/frame/photos/2025/January/01/photo.jpg'], folderNames: [] };
    };
    app.context.albumItem = app.get('year-album');
    await vm.runInContext("loadAlbumPreview(albumItem, '2025', new AbortController().signal)", app.context);
    assert.deepEqual(calls, ['2025', '2025/January', '2025/January/01']);
    assert.equal(app.context.albumItem.children[0].src, 'https://example.test/frame/photos/2025/January/01/photo.jpg');
});

test('descendant album-cover lookup stops at its depth bound without hiding an unconfirmed album', async () => {
    const app = await boot();
    let calls = 0;
    app.context.scanDirectory = async folder => {
        calls++;
        return { filePaths: [], folderNames: ['Next'] };
    };
    app.context.albumItem = app.get('deep-album');
    await vm.runInContext("loadAlbumPreview(albumItem, 'Deep', new AbortController().signal)", app.context);
    assert.equal(calls, 5);
    assert.equal(app.context.albumItem.children.length, 0);
    assert.equal(app.context.albumItem.hidden, false);
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
        vm.runInContext("galleryViewMode = 'all'; updateControlStates()", app.context);
        await app.get('btn-gallery-home').listeners.click();
        assert.equal(app.state().currentFolder, '');
        assert.equal(app.state().activeSource.id, 'family');
        assert.equal(app.state().isGridViewActive, true);
        assert.equal(app.state().slideshowPlaying, false);
        assert.equal(vm.runInContext('galleryViewMode', app.context), 'folders');
        assert.equal(app.get('grid-view-container').scrollTop, 0);
        assert.ok(app.requests.includes('https://example.test/family/'));
    }
});

test('fitted-photo swipes navigate, while upward, short and cancelled gestures do not', async () => {
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
    swipe(170, 50);
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

test('optional scan manifest validates and reuses an unchanged directory listing', async () => {
    const config = JSON.parse(JSON.stringify(shipped));
    config.sources[0].scanCache = true;
    assert.equal(normalize(config).sources[0].scanCache, true);
    config.sources[0].scanCache = 'yes';
    assert.throws(() => normalize(config), /scanCache must be true or false/);
    config.sources[0].scanCache = true;

    const app = await boot({ config });
    let listings = 0, heads = 0;
    app.context.fetch = async (_url, options = {}) => {
        if (options.method === 'HEAD') {
            heads++;
            return { ok: true, headers: { get: name => name === 'Last-Modified' ? 'Sun, 31 Aug 2026 12:00:00 GMT' : null } };
        }
        listings++;
        return { ok: true, text: async () => '' };
    };
    await vm.runInContext("scanDirectory('Cached')", app.context);
    await vm.runInContext("scanDirectory('Cached')", app.context);
    assert.equal(heads, 2);
    assert.equal(listings, 1);
    const key = [...app.saved.keys()].find(item => item.includes('scan-manifest'));
    const manifest = JSON.parse(app.saved.get(key));
    assert.equal(manifest.directories.Cached.files[0].size, null);
    assert.ok('thumbnailPath' in manifest.directories.Cached.files[0]);
});

test('persistent manifest supplies listings, dates, sizes, and generated thumbnails without directory requests', async () => {
    const config = normalizeConfigCopy({
        manifestPath: 'folderframe-data/library.json', thumbnailPath: 'thumbs/'
    });
    let directoryRequests = 0;
    const index = {
        version: 1, generatedAt: '2026-08-31T12:00:00Z',
        root: { path: '', mtimeNs: 1, files: [], folders: ['2026'] },
        chunks: { '2026': { file: 'library.d/year.json', directories: 1 } }, errors: []
    };
    const chunk = {
        version: 1, root: '2026', directories: {
            '2026': { path: '2026', mtimeNs: 2, folders: [], files: [{
                path: '2026/photo.jpg', mtime: 1788177600000, size: 12345,
                thumbnailPath: '2026/photo.jpg.webp'
            }] }
        }
    };
    const app = await boot({ config, fetchHandler: async (url, options = {}) => {
        if (url.endsWith('/folderframe-data/library.json')) return { ok: true, json: async () => index };
        if (url.endsWith('/folderframe-data/library.d/year.json')) return { ok: true, json: async () => chunk };
        directoryRequests++;
        return { ok: true, text: async () => '' };
    } });
    const listing = await vm.runInContext("scanDirectory('2026')", app.context);
    assert.deepEqual(JSON.parse(JSON.stringify(listing)), {
        filePaths: ['https://example.test/frame/photos/2026/photo.jpg'], folderNames: []
    });
    assert.equal(directoryRequests, 0);
    assert.equal(vm.runInContext("modifiedDateCache.get('https://example.test/frame/photos/2026/photo.jpg').size", app.context), 12345);
    assert.equal(vm.runInContext("persistentThumbnailUrl('https://example.test/frame/photos/2026/photo.jpg')", app.context),
        'https://example.test/frame/thumbs/2026/photo.jpg.webp');
});

test('auto discovery falls back from an invalid manifest and refresh revalidates it', async () => {
    const config = normalizeConfigCopy({ manifestPath: 'folderframe-data/library.json' });
    let manifestRequests = 0, directoryRequests = 0;
    const app = await boot({ config, fetchHandler: async url => {
        if (new URL(url).pathname.endsWith('/folderframe-data/library.json')) {
            manifestRequests++;
            return { ok: true, json: async () => ({ version: 99 }) };
        }
        directoryRequests++;
        return { ok: true, text: async () => '' };
    } });
    assert.ok(manifestRequests >= 1);
    assert.ok(directoryRequests >= 1);
    assert.ok(app.warnings.some(message => message.includes('persistent media index unavailable')));
    const before = manifestRequests;
    await vm.runInContext("scanDirectory('Nested')", app.context);
    await vm.runInContext("scanDirectory('Nested/Child')", app.context);
    assert.equal(manifestRequests, before);
    await vm.runInContext("scanDirectory('Live', { bypassCache: true })", app.context);
    assert.equal(manifestRequests, before, 'one scan does not retry an already failed manifest');
    await app.get('btn-refresh-grid').listeners.click();
    assert.ok(manifestRequests > before, 'explicit refresh starts a new manifest validation');
    assert.ok(directoryRequests >= 3);
});

test('manifest discovery rejects an invalid index without attempting directory listings', async () => {
    const config = normalizeConfigCopy({
        manifestPath: 'folderframe-data/library.json', discoveryMode: 'manifest', scanCache: true
    });
    let manifestRequests = 0, directoryRequests = 0;
    const app = await boot({ config, fetchHandler: async url => {
        if (url.includes('/folderframe-data/library.json')) {
            manifestRequests++;
            return { ok: true, json: async () => ({ version: 99 }) };
        }
        directoryRequests++;
        return { ok: true, text: async () => '<a href="photo.jpg">photo</a>' };
    } });
    assert.equal(manifestRequests, 1);
    assert.equal(directoryRequests, 0);
    assert.equal(app.get('warning-title').textContent, 'Published Library Unavailable');
    assert.match(app.get('warning-message').textContent, /Regenerate and redeploy/);
    assert.equal(app.get('refresh-grid-label').textContent, 'Reload Library');
    assert.match(app.get('btn-refresh-grid').title, /New files appear after/);
    assert.equal([...app.saved.keys()].some(key => key.includes('scan-manifest')), false,
        'strict manifest mode ignores browser scanCache');
});

test('manifest discovery accepts an empty index and cache-busts explicit reloads', async () => {
    const config = normalizeConfigCopy({
        manifestPath: 'folderframe-data/library.json', discoveryMode: 'manifest', scanCache: true
    });
    const manifestUrls = [];
    const index = {
        version: 1, generatedAt: '2026-09-01T12:00:00Z',
        root: { path: '', files: [], folders: [] }, chunks: {}, errors: []
    };
    const app = await boot({ config, fetchHandler: async url => {
        if (url.includes('/folderframe-data/library.json')) {
            manifestUrls.push(url);
            return { ok: true, json: async () => index };
        }
        throw new Error(`Unexpected directory request: ${url}`);
    } });
    assert.equal(app.get('warning-title').textContent, 'No Media Detected');
    assert.match(app.get('warning-message').textContent, /published media index contains no supported media/i);
    assert.equal(manifestUrls.length, 1);
    await app.get('btn-refresh-grid').listeners.click();
    assert.equal(manifestUrls.length, 2);
    assert.match(manifestUrls[1], /[?&]ff_refresh=/);
    assert.equal([...app.saved.keys()].some(key => key.includes('scan-manifest')), false);
});

test('directory discovery never requests a configured manifest', async () => {
    const config = normalizeConfigCopy({
        manifestPath: 'folderframe-data/library.json', discoveryMode: 'directory'
    });
    let manifestRequests = 0, directoryRequests = 0;
    await boot({ config, fetchHandler: async url => {
        if (url.includes('/folderframe-data/library.json')) {
            manifestRequests++;
            return { ok: true, json: async () => ({ version: 1 }) };
        }
        directoryRequests++;
        return { ok: true, text: async () => '' };
    } });
    assert.equal(manifestRequests, 0);
    assert.ok(directoryRequests >= 1);
});

test('manifest discovery treats a missing referenced chunk as a hard index error', async () => {
    const config = normalizeConfigCopy({
        manifestPath: 'folderframe-data/library.json', discoveryMode: 'manifest'
    });
    const index = {
        version: 1,
        root: { path: '', files: [], folders: ['2026'] },
        chunks: {},
        errors: []
    };
    const app = await boot({ config, fetchHandler: async url => {
        if (url.includes('/folderframe-data/library.json')) return { ok: true, json: async () => index };
        throw new Error(`Unexpected directory request: ${url}`);
    } });
    await assert.rejects(vm.runInContext("scanDirectory('2026')", app.context), /no chunk/);
});

test('all-files discovery paints the current directory before a deeper folder finishes', async () => {
    const app = await boot();
    let releaseChild;
    let markChildStarted;
    const child = new Promise(resolve => { releaseChild = resolve; });
    const childStarted = new Promise(resolve => { markChildStarted = resolve; });
    app.context.scanDirectory = async folder => {
        if (!folder) return {
            filePaths: Array.from({ length: 120 }, (_, index) => `https://example.test/frame/photos/root-${index}.jpg`),
            folderNames: ['Deep']
        };
        markChildStarted();
        await child;
        return { filePaths: ['https://example.test/frame/photos/Deep/child.jpg'], folderNames: [] };
    };
    vm.runInContext("galleryViewMode = 'all'; sortMode = 'filename'", app.context);
    const loading = vm.runInContext('loadGallery()', app.context);
    await childStarted;
    assert.equal(app.state().mediaFiles.length, 100);
    assert.equal(app.get('grid-view-container').style.display, 'flex');
    releaseChild();
    await loading;
    assert.equal(app.state().mediaFiles.length, 121);
    assert.ok(app.state().mediaFiles.some(file => file.endsWith('/Deep/child.jpg')));
});

test('recursive scan worker pool is bounded, completes deep trees, and isolates a failed branch', async () => {
    const app = await boot();
    let active = 0, maxActive = 0;
    const completed = [];
    app.context.scanDirectory = async folder => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        if (folder === 'Year-3/Day-1') throw new Error('unreadable');
        if (/^Year-\d+$/.test(folder)) return { filePaths: [], folderNames: ['Day-1', 'Day-2', 'Day-3'] };
        return { filePaths: [`https://example.test/frame/photos/${folder}/photo.jpg`], folderNames: [] };
    };
    app.context.rootListing = {
        filePaths: [],
        folderNames: Array.from({ length: 8 }, (_, index) => 'Year-' + index)
    };
    app.context.scanController = new AbortController();
    const scan = vm.runInContext(`scanDirectoryRecursive('', new Set(), rootListing, scanController.signal, null, {
        onTopComplete: path => topCompletions.push(path)
    })`, app.context);
    app.context.topCompletions = completed;
    const result = await Promise.race([
        scan,
        new Promise((_, reject) => setTimeout(() => reject(new Error('recursive scan deadlocked')), 1000))
    ]);
    assert.equal(maxActive, 5);
    assert.equal(result.files.length, 23);
    assert.deepEqual(Array.from(result.failedFolders), ['Year-3/Day-1']);
    assert.deepEqual(completed.sort(), app.context.rootListing.folderNames.sort());
});

test('recursive scan cancellation rejects and does not start queued folders', async () => {
    const app = await boot();
    const started = [];
    app.context.scanDirectory = (folder, options) => {
        started.push(folder);
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
        }, { once: true }));
    };
    app.context.rootListing = {
        filePaths: [],
        folderNames: Array.from({ length: 12 }, (_, index) => 'Folder-' + index)
    };
    app.context.scanController = new AbortController();
    const pending = vm.runInContext("scanDirectoryRecursive('', new Set(), rootListing, scanController.signal)", app.context);
    await Promise.resolve();
    app.context.scanController.abort();
    await assert.rejects(pending, error => error?.name === 'AbortError');
    assert.equal(started.length, 5);
});

test('HEIC decoder loads only when requested and concurrent callers share one script', async () => {
    const app = await boot();
    const head = app.context.document.head;
    assert.equal(head.children.length, 0);

    const first = vm.runInContext('loadHeicDecoder()', app.context);
    const second = vm.runInContext('loadHeicDecoder()', app.context);
    assert.equal(head.children.length, 1);
    assert.equal(head.children[0].src, 'heic2any.min.js');

    const decoder = async () => new Blob();
    app.context.heic2any = decoder;
    head.children[0].onload();
    assert.equal(await first, decoder);
    assert.equal(await second, decoder);
    assert.equal(head.children.length, 1);
});

test('native viewer and thumbnail loads use independent bounded priority queues', async () => {
    const app = await boot({ empty: true });
    app.context.queueElements = Array.from({ length: 14 }, () => app.context.document.createElement('img'));
    app.context.queueControllers = Array.from({ length: 14 }, () => new AbortController());
    vm.runInContext(`gridQueueLoads = queueElements.map((element, index) =>
        queueNativeImageSource(element, 'grid-' + index + '.jpg', queueControllers[index].signal,
            { priority: NATIVE_IMAGE_PRIORITY.grid }))`, app.context);
    assert.equal(app.context.queueElements.filter(element => element.src).length, 12);

    app.context.albumElement = app.context.document.createElement('img');
    app.context.albumController = new AbortController();
    vm.runInContext(`albumQueueLoad = queueNativeImageSource(albumElement, 'album.jpg', albumController.signal,
        { priority: NATIVE_IMAGE_PRIORITY.album })`, app.context);

    app.context.viewerElements = Array.from({ length: 3 }, () => app.context.document.createElement('img'));
    app.context.viewerControllers = Array.from({ length: 3 }, () => new AbortController());
    vm.runInContext(`viewerQueueLoads = viewerElements.map((element, index) =>
        queueNativeImageSource(element, 'viewer-' + index + '.jpg', viewerControllers[index].signal,
            { priority: NATIVE_IMAGE_PRIORITY.viewer }))`, app.context);
    assert.deepEqual(app.context.viewerElements.map(element => element.src || ''),
        ['viewer-0.jpg', 'viewer-1.jpg', '']);

    app.context.queueElements[0].onload();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(app.context.albumElement.src, 'album.jpg', 'album work outranks queued grid thumbnails');
    assert.equal(app.context.queueElements[12].src || '', '');

    const cancelled = assert.rejects(app.context.gridQueueLoads[12], { name: 'AbortError' });
    app.context.queueControllers[12].abort();
    await cancelled;
    app.context.albumElement.onload();
    app.context.viewerElements[0].onload();
    for (let index = 0; index < 20 && (!app.context.queueElements[13].src || !app.context.viewerElements[2].src); index++) {
        await Promise.resolve();
    }
    assert.equal(app.context.queueElements[13].src, 'grid-13.jpg');
    assert.equal(app.context.viewerElements[2].src, 'viewer-2.jpg');
    for (const element of [...app.context.queueElements, ...app.context.viewerElements]) element.onload?.();
    await Promise.allSettled([...app.context.gridQueueLoads, app.context.albumQueueLoad, ...app.context.viewerQueueLoads]);
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(nativeViewerImageQueue.stats())', app.context)),
        { active: 0, queued: 0, concurrency: 2 });
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(nativeThumbnailImageQueue.stats())', app.context)),
        { active: 0, queued: 0, concurrency: 12 });
});

test('container detection distinguishes genuine HEIC, QuickTime, ordinary images, and garbage', async () => {
    const app = await boot();
    const cases = [
        [bmff('heic', ['mif1', 'hvc1']), 'heic'],
        [bmff('qt  ', ['hvc1']), 'quicktime'],
        [bmff('isom', ['mp42', 'avc1']), 'quicktime'],
        [Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]).buffer, 'jpeg'],
        [Uint8Array.from([1, 2, 3, 4, 5]).buffer, 'unknown']
    ];
    for (const [data, expected] of cases) {
        app.context.sampleContainer = data;
        assert.equal(vm.runInContext('detectContainer(sampleContainer)', app.context), expected);
    }
});

test('special-image decode sends genuine HEIC to heic2any and reclassifies QuickTime without decoding', async () => {
    const app = await boot();
    vm.runInContext(`window.FolderFrameResilience.createImagePool = options => {
        globalThis.capturedImagePoolOptions = options;
        return { acquire() { throw new Error('not used'); }, invalidate() {} };
    }; specialImagePool = null; getImagePool();`, app.context);
    let decoderCalls = 0;
    app.context.heic2any = async () => { decoderCalls++; return new Blob(['jpeg'], { type: 'image/jpeg' }); };
    app.context.sampleContainer = bmff('heic', ['mif1', 'hvc1']);
    const still = await vm.runInContext('capturedImagePoolOptions.decode(sampleContainer)', app.context);
    assert.equal(still.type, 'image/jpeg');
    assert.equal(decoderCalls, 1);

    app.context.sampleContainer = bmff('qt  ', ['hvc1']);
    await assert.rejects(vm.runInContext('capturedImagePoolOptions.decode(sampleContainer)', app.context), error => {
        assert.equal(error.name, 'MediaReclassificationError');
        assert.equal(error.container, 'quicktime');
        assert.equal(error.data, app.context.sampleContainer);
        return true;
    });
    assert.equal(decoderCalls, 1);
});

test('mislabeled HEIC becomes a Live Photo video without a second download and has specific HEVC guidance', async () => {
    const app = await boot();
    app.context.motionBytes = bmff('qt  ', ['hvc1']);
    vm.runInContext(`getSpecialImageURL = async () => {
        throw reclassifiedContainerError('quicktime', motionBytes);
    }; mediaFiles = ['https://example.test/IMG_1211.heic']; enterFullScreenViewer(0);`, app.context);
    await Promise.resolve(); await Promise.resolve();
    const video = app.get('gallery-video');
    assert.match(video.src, /^blob:/);
    assert.equal(vm.runInContext('reclassifiedVideoActive', app.context), true);
    assert.equal(vm.runInContext('isPhotoActive()', app.context), false);
    assert.equal(app.get('btn-copy-link').disabled, true);
    video.error = { code: 4 };
    video.onerror();
    assert.match(app.get('media-error-title').textContent, /Apple Live Photo motion clip/);
    assert.match(app.get('video-error-text').textContent, /HEVC/);
    assert.match(app.get('video-error-ffmpeg').textContent, /matching still/);
});

test('failed JPEG lazily sniffs QuickTime and retries the original URL as Live Photo video', async () => {
    const app = await boot();
    app.context.sniffContainer = async () => ({ container: 'quicktime', data: bmff('qt  ', ['avc1']) });
    vm.runInContext("mediaFiles = ['https://example.test/mislabeled.jpg']; enterFullScreenViewer(0)", app.context);
    await app.get('gallery-image').onerror();
    assert.equal(app.get('gallery-video').src, 'https://example.test/mislabeled.jpg');
    assert.equal(vm.runInContext('reclassifiedVideoActive', app.context), true);
});

test('range sniffer accepts a server that returns the whole body and preserves aborts', async () => {
    const app = await boot();
    const fullBody = bmff('qt  ', ['hvc1']);
    app.context.fetch = async (_url, options) => {
        app.context.lastSniffOptions = options;
        return { ok: true, arrayBuffer: async () => fullBody };
    };
    const result = await vm.runInContext("sniffContainer('https://example.test/fake.jpg', new AbortController().signal)", app.context);
    assert.equal(result.container, 'quicktime');
    assert.equal(app.context.lastSniffOptions.headers.Range, 'bytes=0-63');
    const controller = new AbortController(); controller.abort(); app.context.abortedSniff = controller;
    await assert.rejects(vm.runInContext("sniffContainer('https://example.test/fake.jpg', abortedSniff.signal)", app.context), { name: 'AbortError' });
});

test('HEIC grid tile reclassifies QuickTime bytes into a video preview', async () => {
    const app = await boot();
    app.context.motionBytes = bmff('qt  ', ['hvc1']);
    vm.runInContext(`getSpecialImageURL = async () => {
        throw reclassifiedContainerError('quicktime', motionBytes);
    }; mediaFiles = ['https://example.test/IMG_1211.heic']; renderGridView();`, app.context);
    await Promise.resolve(); await Promise.resolve();
    const tile = app.get('thumbnail-grid').querySelectorAll('.media-tile')[0];
    assert.equal(tile.mediaElement.tagName, 'VIDEO');
    assert.match(tile.mediaElement.src, /^blob:/);
});

test('ordinary MOV remains on the native video path and Live Photo slideshow errors keep the normal delay', async () => {
    const app = await boot({ search: '?autoplay=1' });
    vm.runInContext("mediaFiles = ['https://example.test/clip.mov']; showMedia(0)", app.context);
    assert.equal(app.get('gallery-video').src, 'https://example.test/clip.mov');
    assert.equal(vm.runInContext('reclassifiedVideoActive', app.context), false);
    const timers = new Map(); let id = 200;
    app.context.setTimeout = (fn, delay) => { timers.set(++id, { fn, delay }); return id; };
    app.context.clearTimeout = key => timers.delete(key);
    vm.runInContext("mediaFiles.push('https://example.test/next.jpg'); slideshowPlaying = true; showMediaError('live-photo', mediaFiles[0], { code: 4 })", app.context);
    const timerId = vm.runInContext('slideshowTimer', app.context);
    assert.equal(timers.get(timerId).delay, 3000);
});

test('fitted-photo swipe down previews dismissal, snaps back when short, and returns to grid past threshold', async () => {
    const app = await boot({ search: '?autoplay=1' });
    const viewport = app.get('media-viewport');
    viewport.clientHeight = 600;
    const point = (x, y) => ({ identifier: 7, clientX: x, clientY: y });
    let prevented = false;

    viewport.listeners.touchstart({ touches: [point(200, 200)] });
    viewport.listeners.touchmove({
        touches: [point(205, 260)],
        preventDefault() { prevented = true; }
    });
    assert.equal(prevented, true);
    assert.match(app.get('media-container').style.transform, /translateY\(51\.6px\)/);
    assert.ok(Number(app.get('media-container').style.opacity) < 1);
    viewport.listeners.touchend({ touches: [], changedTouches: [point(205, 260)] });
    assert.equal(app.state().isGridViewActive, false);
    assert.equal(app.get('media-container').style.opacity, '');

    viewport.listeners.touchstart({ touches: [point(200, 200)] });
    viewport.listeners.touchmove({ touches: [point(205, 350)], preventDefault() {} });
    viewport.listeners.touchend({ touches: [], changedTouches: [point(205, 350)] });
    assert.equal(app.state().isGridViewActive, true);
});

test('zoomed-photo vertical swipe remains pan and never dismisses viewer', async () => {
    const app = await boot({ search: '?autoplay=1' });
    const viewport = app.get('media-viewport');
    const point = (x, y) => ({ identifier: 8, clientX: x, clientY: y });
    vm.runInContext('zoom = 2', app.context);
    viewport.listeners.touchstart({ touches: [point(200, 200)] });
    viewport.listeners.touchmove({ touches: [point(205, 360)], preventDefault() {} });
    viewport.listeners.touchend({ touches: [], changedTouches: [point(205, 360)] });
    assert.equal(app.state().isGridViewActive, false);
    assert.equal(vm.runInContext('panY', app.context), 160);
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

test('download and copy buttons are independently configurable by profile and URL', async () => {
    const config = normalize({ embed: { showDownloadButton: false, showCopyButton: false, showButtonLabels: true } });
    assert.equal(api.resolveSettings(config, '').settings.showDownloadButton, true);
    assert.equal(api.resolveSettings(config, '?profile=embed').settings.showCopyButton, false);
    const enabled = api.resolveSettings(config, '?profile=embed&download=1&copy=1').settings;
    assert.equal(enabled.showDownloadButton, true);
    assert.equal(enabled.showCopyButton, true);
    assert.equal(api.resolveSettings(config, '?profile=embed').settings.showButtonLabels, true);
    assert.equal(api.resolveSettings(config, '?profile=embed&buttonLabels=0').settings.showButtonLabels, false);
    assert.throws(() => normalize({ defaults: { showDownloadButton: 'yes' } }), /showDownloadButton/);
    assert.throws(() => normalize({ defaults: { showButtonLabels: 'yes' } }), /showButtonLabels/);
    assert.ok(api.resolveSettings(config, '?download=yes').warnings.length);
});

test('viewer actions download the original, copy the displayed image, and show the current shuffle icon', async () => {
    const app = await boot({ search: '?autoplay=1' });
    const file = app.state().mediaFiles[0];
    assert.equal(app.get('btn-download').href, file);
    assert.equal(app.get('btn-download').download, 'photo.jpg');
    app.get('gallery-image').naturalWidth = 100;
    app.get('gallery-image').naturalHeight = 80;
    app.get('gallery-image').onload();
    const blob = { type: 'image/png' };
    app.context.imageClipboardBlob = async () => blob;
    let copied;
    app.context.navigator.clipboard.write = async value => { copied = value; };
    await app.get('btn-copy-link').listeners.click();
    assert.equal(await copied[0].items['image/png'], blob);

    const icons = { '.shuffle-on-icon': { hidden: true }, '.shuffle-off-icon': { hidden: false }, '.button-label': { textContent: '' } };
    app.get('btn-shuffle').querySelector = selector => icons[selector];
    vm.runInContext('shuffleEnabled = false; updateControlStates()', app.context);
    assert.equal(icons['.shuffle-on-icon'].hidden, true);
    assert.equal(icons['.shuffle-off-icon'].hidden, false);
    vm.runInContext('shuffleEnabled = true; updateControlStates()', app.context);
    assert.equal(icons['.shuffle-on-icon'].hidden, false);
    assert.equal(icons['.shuffle-off-icon'].hidden, true);

    app.context.window.isSecureContext = false;
    vm.runInContext('showMedia(0)', app.context);
    assert.equal(app.get('btn-copy-link').disabled, true);
    assert.equal(app.get('btn-copy-link').hidden, true);
    assert.equal(app.get('btn-copy-filename').hidden, true);
    assert.match(app.get('btn-copy-link').title, /requires HTTPS/);

    const hidden = await boot({ config: { defaults: { showDownloadButton: false, showCopyButton: false } } });
    assert.equal(hidden.get('btn-download').hidden, true);
    assert.equal(hidden.get('btn-copy-link').hidden, true);
    assert.equal(hidden.get('btn-copy-filename').hidden, true);
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

test('directory listings honor folderframe.ignore and filter conservative system junk', async () => {
    const app = await boot();
    app.context.DOMParser = class { parseFromString() {
        return { querySelectorAll: () => [
            'folderframe.ignore', 'visible.jpg', 'Nested/', '@eaDir/', '.Trash-1000/',
            '.hidden.jpg', 'partial.jpg.part', 'normal.tmp.jpg'
        ].map(href => ({ getAttribute: () => href })) };
    } };
    const ignored = await vm.runInContext("scanDirectory('Secret', { bypassCache: true })", app.context);
    assert.equal(ignored.ignored, true);
    assert.deepEqual(Array.from(ignored.filePaths), []);
    assert.deepEqual(Array.from(ignored.folderNames), []);

    app.context.DOMParser = class { parseFromString() {
        return { querySelectorAll: () => [
            'visible.jpg', 'Nested/', '@eaDir/', '.Trash-1000/', '.hidden.jpg',
            'copy.jpg.partial', '~$draft.jpg', 'normal.tmp.jpg'
        ].map(href => ({ getAttribute: () => href })) };
    } };
    const listing = await vm.runInContext("scanDirectory('Visible', { bypassCache: true })", app.context);
    assert.deepEqual(Array.from(listing.folderNames), ['Nested']);
    assert.equal(listing.filePaths.some(file => file.endsWith('/visible.jpg')), true);
    assert.equal(listing.filePaths.some(file => file.endsWith('/normal.tmp.jpg')), true);
    assert.equal(listing.filePaths.length, 2);
});

test('ignored albums disappear when their normal cover lookup sees the sentinel', async () => {
    const app = await boot();
    app.context.DOMParser = class { parseFromString() {
        return { querySelectorAll: () => ['folderframe.ignore', 'cover.jpg', 'Nested/']
            .map(href => ({ getAttribute: () => href })) };
    } };
    const item = app.get('ignored-album');
    app.context.ignoredAlbum = item;
    await vm.runInContext("loadAlbumPreview(ignoredAlbum, 'Private', new AbortController().signal)", app.context);
    assert.equal(item.hidden, true);
    assert.equal(item.dataset.ignoredAlbum, 'true');
    assert.equal(item.children.length, 0);
});

test('ignored album-cover descendants do not hide their visible parent or siblings', async () => {
    const app = await boot();
    const calls = [];
    app.context.scanDirectory = async folder => {
        calls.push(folder);
        if (folder === 'demo-photos') return { filePaths: [], folderNames: ['Architecture', 'Landscapes', 'Space'] };
        if (folder === 'demo-photos/Architecture') return { filePaths: [], folderNames: [], ignored: true };
        if (folder === 'demo-photos/Landscapes') return {
            filePaths: ['https://example.test/frame/photos/demo-photos/Landscapes/cover.jpg'], folderNames: []
        };
        return { filePaths: [], folderNames: [] };
    };
    const item = app.get('demo-album');
    app.context.demoAlbum = item;
    await vm.runInContext("loadAlbumPreview(demoAlbum, 'demo-photos', new AbortController().signal)", app.context);
    assert.equal(item.hidden, false);
    assert.equal(item.dataset.ignoredAlbum, undefined);
    assert.equal(item.children[0].src, 'https://example.test/frame/photos/demo-photos/Landscapes/cover.jpg');
    assert.deepEqual(calls, ['demo-photos', 'demo-photos/Architecture', 'demo-photos/Landscapes']);
});

test('thumbnail manifest generator prunes ignored subtrees and junk files', { timeout: 10000 }, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'folderframe-ignore-'));
    try {
        const media = path.join(temporary, 'photos');
        const manifest = path.join(temporary, 'data', 'library.json');
        fs.mkdirSync(path.join(media, 'Keep'), { recursive: true });
        fs.mkdirSync(path.join(media, 'Private', 'Nested'), { recursive: true });
        fs.mkdirSync(path.join(media, '@eaDir'), { recursive: true });
        fs.writeFileSync(path.join(media, 'Keep', 'photo.jpg'), 'x');
        fs.writeFileSync(path.join(media, 'Keep', '.hidden.jpg'), 'x');
        fs.writeFileSync(path.join(media, 'Keep', 'unfinished.jpg.part'), 'x');
        fs.writeFileSync(path.join(media, 'Private', 'Nested', 'secret.jpg'), 'x');
        fs.writeFileSync(path.join(media, '@eaDir', 'system.jpg'), 'x');
        const python = process.platform === 'win32' ? 'python' : 'python3';
        let result = spawnSync(python, [path.join(__dirname, '..', 'generate_thumbnails.py'), media,
            '--manifest', manifest, '--manifest-only'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).root.folders.includes('Private'), true);
        fs.writeFileSync(path.join(media, 'Private', 'folderframe.ignore'), '');
        result = spawnSync(python, [path.join(__dirname, '..', 'generate_thumbnails.py'), media,
            '--manifest', manifest, '--manifest-only'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const index = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        assert.deepEqual(index.root.folders, ['Keep']);
        const descriptor = index.chunks.Keep;
        const chunk = JSON.parse(fs.readFileSync(path.join(path.dirname(manifest), descriptor.file), 'utf8'));
        assert.deepEqual(chunk.directories.Keep.files.map(file => file.path), ['Keep/photo.jpg']);
        assert.equal(Object.keys(index.chunks).includes('Private'), false);
        assert.equal(Object.keys(index.chunks).includes('@eaDir'), false);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('deep breadcrumbs preserve clickable first and last ancestors with collapsible middle segments', async () => {
    const app = await boot({ search: '?album=Family/2024/Summer/Beach' });
    const children = app.get('breadcrumb').children;
    const crumbs = children.filter(child => String(child.className || '').includes('breadcrumb-segment'));
    assert.deepEqual(crumbs.map(child => child.textContent), ['Family', '2024', 'Summer']);
    assert.match(crumbs[0].className, /crumb-first/);
    assert.doesNotMatch(crumbs[0].className, /crumb-middle/);
    assert.match(crumbs[1].className, /crumb-middle/);
    assert.match(crumbs[2].className, /crumb-tail/);
    assert.equal(typeof crumbs[0].listeners.click, 'function');
    assert.equal(typeof crumbs[2].listeners.click, 'function');
    const ellipsis = children.find(child => child.className === 'crumb-ellipsis');
    assert.equal(ellipsis.textContent, '› …');
    const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
    assert.match(css, /container-name:\s*headernav/);
    assert.match(css, /@container headernav \(max-width:520px\)/);
});

test('manifest-backed sources default Auto Refresh off but preserve explicit choices', () => {
    const raw = { sources: [{ id: 'photos', label: 'Photos', path: 'photos/',
        manifestPath: 'data/library.json', discoveryMode: 'manifest' }] };
    const config = normalize(raw);
    assert.equal(api.resolveSettings(config, '').settings.autoRefresh, false);
    assert.equal(api.resolveSettings(config, '?autorefresh=1').settings.autoRefresh, true);
    assert.equal(api.resolveSettings(normalize({ ...raw, defaults: { autoRefresh: true } }), '').settings.autoRefresh, true);
    const automatic = normalize({ sources: [{ id: 'photos', label: 'Photos', path: 'photos/',
        manifestPath: 'data/library.json', discoveryMode: 'auto' }] });
    assert.equal(api.resolveSettings(automatic, '').settings.autoRefresh, false);
    assert.equal(api.resolveSettings(normalize({ sources: [{ id: 'photos', label: 'Photos', path: 'photos/' }] }), '')
        .settings.autoRefresh, true);
});

test('viewer arrow browsing does not reveal hidden controls or extend their idle timer', async () => {
    const app = await boot();
    vm.runInContext('enterFullScreenViewer(0)', app.context);
    app.context.document.activeElement = { closest: () => null, matches: () => false };
    vm.runInContext('hideUI()', app.context);
    const idle = vm.runInContext('idleTimer', app.context);
    let prevented = false;
    app.windowListeners.keydown({ key: 'ArrowRight', target: app.get('media-viewport'),
        preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(vm.runInContext('uiVisible', app.context), false);
    assert.equal(vm.runInContext('idleTimer', app.context), idle);
});

test('viewer loading clears on image success, failure, and grid navigation', async () => {
    const app = await boot({ search: '?autoplay=1' });
    assert.equal(app.get('media-loading').hidden, false);
    assert.equal(app.get('media-loading-text').textContent, 'Loading image…');
    app.get('gallery-image').onload();
    assert.equal(app.get('media-loading').hidden, true);
    vm.runInContext('showMedia(0)', app.context);
    await app.get('gallery-image').onerror();
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
    let tile = app.get('thumbnail-grid').querySelectorAll('.media-tile')[0];
    let image = tile.children[0];
    assert.equal(image.src, 'https://example.test/frame/thumbs/photo.jpg.webp');
    image.onerror();
    assert.equal(image.src, 'https://example.test/frame/photos/photo.jpg');
    image.onload();
    assert.equal(tile.failedPreview, undefined);

});

test('confirmed missing originals remove stale generated-thumbnail tiles on activation', async () => {
    const config = { sources: [{ id: 'photos', label: 'Photos', path: 'photos/', thumbnailPath: 'thumbs/' }] };
    const app = await boot({ config, fetchHandler: async (url, options) => {
        if (options.method === 'HEAD' && url.endsWith('/photo.jpg')) return { ok: false, status: 404 };
        return { ok: true, url, text: async () => '' };
    } });
    const tile = app.get('thumbnail-grid').querySelectorAll('.media-tile')[0];
    assert.ok(tile);
    await tile.listeners.click();
    assert.equal(vm.runInContext('mediaFiles.length', app.context), 0);
    assert.equal(app.state().isGridViewActive, true);
});

test('large grids render incrementally and keep a bounded media-tile DOM window', async () => {
    const app = await boot();
    app.context.largeFiles = Array.from({ length: 15633 }, (_, index) =>
        `https://example.test/frame/photos/image-${String(index).padStart(5, '0')}.jpg`);
    vm.runInContext('mediaFiles = largeFiles; renderGridView()', app.context);
    const grid = app.get('thumbnail-grid');
    const mediaCount = () => grid.querySelectorAll('.media-tile').length;
    assert.equal(mediaCount(), 100);
    assert.equal(grid.querySelectorAll('.virtual-spacer').length, 2);
    const initialSpacers = grid.querySelectorAll('.virtual-spacer');
    const virtualWindow = grid.querySelectorAll('.virtual-window')[0];
    const container = app.get('grid-view-container');
    container.clientHeight = 900;
    app.get('thumbnail-grid').clientWidth = 1200;
    container.scrollTop = 4000;
    container.scrollHeight = 1000000;
    vm.runInContext('gridVirtualizer.update()', app.context);
    assert.equal(vm.runInContext('gridVirtualizer.start', app.context), 0);
    assert.equal(mediaCount(), 300);
    const reusedTile = grid.querySelectorAll('.media-tile')
        .find(tile => tile.dataset.mediaIndex === '150');
    container.scrollTop = 9000;
    vm.runInContext('gridVirtualizer.update()', app.context);
    assert.equal(vm.runInContext('gridVirtualizer.start', app.context), 100);
    assert.equal(grid.querySelectorAll('.media-tile')
        .find(tile => tile.dataset.mediaIndex === '150'), reusedTile);
    assert.equal(grid.querySelectorAll('.media-tile')
        .some(tile => tile.dataset.mediaIndex === '0'), false);
    assert.ok(vm.runInContext('gridSession.cleanups.size', app.context) <= 600);
    container.scrollTop = 20000;
    vm.runInContext('gridVirtualizer.update()', app.context);
    assert.ok(mediaCount() <= 300);
    const forwardStart = vm.runInContext('gridVirtualizer.start', app.context);
    assert.ok(forwardStart > 0);
    container.scrollTop = 500000;
    const replaceWindow = virtualWindow.replaceChildren.bind(virtualWindow);
    virtualWindow.replaceChildren = (...nodes) => {
        // Simulate a browser attempting to clamp scrollTop during a live
        // window replacement. FolderFrame must preserve the requested offset.
        container.scrollTop = 0;
        replaceWindow(...nodes);
    };
    container.listeners.scroll();
    assert.equal(container.scrollTop, 500000);
    assert.ok(vm.runInContext('gridVirtualizer.start', app.context) > forwardStart);
    assert.ok(mediaCount() <= 300);
    assert.equal(grid.querySelectorAll('.virtual-spacer')[0], initialSpacers[0]);
    assert.equal(grid.querySelectorAll('.virtual-spacer')[1], initialSpacers[1]);
    container.scrollTop = 0;
    container.scrollHeight = 1000000;
    container.listeners.scroll();
    assert.ok(vm.runInContext('gridVirtualizer.start', app.context) < forwardStart);
    assert.ok(mediaCount() <= 300);

    let blurred = 0;
    app.context.document.activeElement = {
        closest: selector => selector === '.grid-item' ? { blur() { blurred++; } } : null
    };
    let prevented = false;
    app.windowListeners.keydown({ key: 'End', target: app.get('focused-grid-tile'),
        preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(blurred, 1);
    assert.equal(vm.runInContext('gridVirtualizer.start', app.context), 15633 - 300);
    assert.equal(vm.runInContext('gridVirtualizer.end', app.context), 15633);
    assert.equal(container.scrollTop, container.scrollHeight);
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
    const fitIcon = {};
    const originalIcon = {};
    app.get('btn-image-mode').querySelector = selector => selector === '.fit-mode-icon' ? fitIcon : originalIcon;
    vm.runInContext('updateControlStates()', app.context);
    assert.equal(app.get('image-mode-text').textContent, 'Fit');
    assert.equal(fitIcon.hidden, false);
    assert.equal(originalIcon.hidden, true);
    vm.runInContext('toggleImageMode()', app.context);
    assert.equal(app.get('image-mode-text').textContent, 'Original');
    assert.equal(fitIcon.hidden, true);
    assert.equal(originalIcon.hidden, false);
    const label = {};
    app.get('btn-fullscreen').querySelector = () => label;
    vm.runInContext('updateFullscreenButton()', app.context);
    assert.equal(label.textContent, 'Full');
    app.context.document.fullscreenElement = {};
    vm.runInContext('updateFullscreenButton()', app.context);
    assert.equal(label.textContent, 'Exit Full');
});

test('Rotate turns only the current photo clockwise and resets on media change', async () => {
    const app = await boot();
    const image = app.get('gallery-image');
    const viewport = app.get('media-viewport');
    image.clientWidth = 800; image.clientHeight = 1200;
    image.naturalWidth = 800; image.naturalHeight = 1200;
    viewport.clientWidth = 2400; viewport.clientHeight = 900;
    vm.runInContext('enterFullScreenViewer(0)', app.context);
    image.onload();
    const originalSource = image.src;
    const rotate = app.get('btn-rotate');
    assert.equal(rotate.disabled, false);
    for (const expected of [90, 180, 270, 0]) {
        rotate.listeners.click();
        assert.equal(vm.runInContext('imageRotation', app.context), expected);
        assert.match(image.style.transform, new RegExp(`rotate\\(${expected}deg\\)`));
        if (expected === 90 || expected === 270) assert.match(image.style.transform, /scale\(1\.5\)/);
        assert.equal(image.src, originalSource);
        assert.equal(vm.runInContext('zoom === 1 && panX === 0 && panY === 0', app.context), true);
    }
    app.windowListeners.keydown({ key: 'r', target: image, preventDefault() {} });
    assert.equal(vm.runInContext('imageRotation', app.context), 90);
    vm.runInContext("mediaFiles = ['https://example.test/clip.mp4']; showMedia(0)", app.context);
    assert.equal(vm.runInContext('imageRotation', app.context), 0);
    assert.equal(rotate.disabled, true);
});

test('native image context menus remain available without enabling native dragging', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
    assert.match(html, /id="gallery-image"[^>]*draggable="false"/);
    assert.ok(css.includes('#gallery-image { pointer-events:auto'));
    assert.ok(css.includes('.grid-item img { pointer-events:auto'));
    assert.ok(!css.includes('.grid-item img,.grid-item video { width:100%; height:100%; object-fit:cover; pointer-events:none'));

    const app = await boot();
    vm.runInContext("imageMode = 'original'; isDragging = false", app.context);
    vm.runInContext('handleMouseDown({ button: 2, clientX: 10, clientY: 10 })', app.context);
    assert.equal(vm.runInContext('isDragging', app.context), false);
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
    await app.get('gallery-image').onerror();
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
    await app.get('gallery-image').onerror();
    const timerId = vm.runInContext('slideshowTimer', app.context);
    assert.equal(timers.get(timerId).delay, 3000);
    timers.get(timerId).fn();
    assert.equal(app.get('gallery-image').src, 'https://example.test/second.jpg');
    assert.equal(app.state().slideshowPlaying, true);
    await app.get('gallery-image').onerror();
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

async function boot({ search = '', config = shipped, configFailure = false, storageBlocked = false,
    empty = false, initialStorage = new Map(), fetchHandler = null } = {}) {
    class Element {
        constructor() { this.style = {}; this.children = []; this.listeners = {}; this.dataset = {}; this.hidden = false; this._innerHTML = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
        addEventListener(name, fn) { this.listeners[name] = fn; }
        querySelector() { return new Element(); }
        querySelectorAll(selector) {
            const classes = selector.split(',').map(part => part.trim().replace(/^\./, ''));
            return this.children.filter(child => classes.some(name => (child.className || '').split(/\s+/).includes(name)));
        }
        setAttribute(name, value) { this.attributes ||= {}; this.attributes[name] = String(value); }
        removeAttribute(name) { if (this.attributes) delete this.attributes[name]; }
        appendChild(child) {
            if (child.isFragment) {
                [...child.children].forEach(node => this.appendChild(node));
                child.children = [];
                return child;
            }
            child.parentNode = this; this.children.push(child); return child;
        }
        insertBefore(child, reference) {
            if (!reference) return this.appendChild(child);
            if (child.isFragment) {
                [...child.children].forEach(node => this.insertBefore(node, reference));
                child.children = [];
                return child;
            }
            const index = this.children.indexOf(reference);
            child.parentNode = this;
            this.children.splice(index < 0 ? this.children.length : index, 0, child);
            return child;
        }
        get firstChild() { return this.children[0] || null; }
        replaceChildren(...nodes) {
            this.children.forEach(child => { child.parentNode = null; });
            this.children = [];
            nodes.forEach(node => this.appendChild(node));
        }
        querySelectorAll(selector) {
            const classes = selector.split(',').map(part => {
                const name = part.trim();
                return name.startsWith('.') ? name.slice(1) : name;
            });
            const matches = [];
            this.children.forEach(child => {
                const childClasses = String(child.className || '').split(' ').filter(Boolean);
                if (classes.some(name => childClasses.includes(name))) matches.push(child);
                if (child.querySelectorAll) matches.push(...child.querySelectorAll(selector));
            });
            return matches;
        }
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
    const saved = new Map(initialStorage);
    const sourceLabels = [new Element(), new Element()];
    const warnings = [];
    const historyCalls = { push: [], replace: [] };
    let animationFrames = 0;
    const documentElement = new Element();
    documentElement.style.setProperty = (name, value) => { documentElement.style[name] = value; };
    const context = vm.createContext({
        URL, URLSearchParams, AbortController, Blob,
        ClipboardItem: class { constructor(items) { this.items = items; } },
        navigator: { clipboard: { writeText: async () => {}, write: async () => {} } },
        console: { warn(...items) { warnings.push(items.map(String).join(' ')); }, info() {}, log() {}, error() {} },
        window: { FolderFrameSettings: api, isSecureContext: true, addEventListener(name, fn) { listeners[name] = fn; },
            history: { state: null, pushState(state, title, url) { this.state = state; historyCalls.push.push(String(url)); },
                replaceState(state, title, url) { this.state = state; historyCalls.replace.push(String(url)); } } },
        document: { getElementById: get, createElement: tag => Object.assign(new Element(), { tagName: String(tag).toUpperCase() }), head: new Element(),
            createDocumentFragment: () => { const fragment = new Element(); fragment.isFragment = true; return fragment; },
            querySelectorAll: () => sourceLabels,
            addEventListener() {}, body: new Element(), documentElement, hidden: false },
        location: { href: base + search, search, assign(url) { this.assigned = url; } },
        localStorage: { getItem(key) { if (storageBlocked) throw new Error('Blocked'); return saved.get(key) || null; },
            setItem(key, value) { if (storageBlocked) throw new Error('Blocked'); saved.set(key, value); } },
        fetch: async (url, options = {}) => {
            requests.push(url);
            if (url === './folderframe.config.json') return { ok: !configFailure, status: configFailure ? 404 : 200, json: async () => config };
            if (fetchHandler) return fetchHandler(String(url), options);
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
    return { context, get, state, requests, saved, sourceLabels, warnings, historyCalls, windowListeners: listeners, get animationFrames() { return animationFrames; } };
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
