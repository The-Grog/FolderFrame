const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeBuildInfo, formatVersionInfo } = require('../about.js');
const identity = { schemaVersion: 1, version: 'v1.2.3', revision: 'a'.repeat(40), deploymentRevision: 'b'.repeat(40) };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(fetcher, secure = false, clipboardFailure = false) {
    const nodes = new Map();
    let focused = null, opened = 0, closed = 0, copied = null;
    const get = id => {
        if (!nodes.has(id)) nodes.set(id, { id, hidden: false, open: false, events: {},
            addEventListener(name, callback) { this.events[name] = callback; },
            showModal() { this.open = true; },
            close() { this.open = false; this.events.close(); },
            focus() { focused = this.id; }, select() { this.selected = true; } });
        return nodes.get(id);
    };
    const context = vm.createContext({ document: { getElementById: get },
        window: { isSecureContext: secure }, navigator: { clipboard: { writeText: async text => { if (clipboardFailure) throw new Error("Denied"); copied = text; } } },
        fetch: fetcher, AbortController, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../about.js'), 'utf8'), context);
    context.FolderFrameAbout.init({ onOpen() { opened++; }, onClose() { closed++; } });
    return { get, open: () => get('btn-about-grid').events.click(),
        state: () => ({ focused, opened, closed, copied }) };
}
test('build identity validates versions and revisions and excludes private fields', () => {
    assert.deepEqual(normalizeBuildInfo(identity), { version: 'v1.2.3', revision: 'a'.repeat(40), deploymentRevision: 'b'.repeat(40) });
    const text = formatVersionInfo({ ...identity, filename: 'private.jpg', gps: '1,2', path: '/private' });
    assert.ok(text.includes('Version: v1.2.3'));
    assert.ok(!text.includes('private') && !text.includes('1,2'));
    for (const bad of ['latest', '../elsewhere', '<script>', 'https://example.test', 'v1.2.3\n']) {
        assert.equal(normalizeBuildInfo({ ...identity, version: bad }).version, null);
    }
    assert.equal(normalizeBuildInfo({ ...identity, schemaVersion: 999 }).version, null);
    assert.equal(normalizeBuildInfo({ ...identity, revision: '/private/path' }).revision, null);
});
test('About loads installed version lazily and copies only build identity', async () => {
    const calls = [];
    const app = harness(async (url, options) => { calls.push({ url, options }); return { ok: true, text: async () => JSON.stringify(identity) }; }, true);
    assert.equal(calls.length, 0);
    app.open(); await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'build-info.json');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(app.get('about-version').textContent, 'v1.2.3');
    assert.equal(app.get('about-release-notes').href, 'https://github.com/The-Grog/FolderFrame/releases/tag/v1.2.3');
    await app.get('btn-copy-version').events.click();
    assert.equal(app.state().copied, formatVersionInfo(identity));
    app.get('btn-close-about').events.click();
    assert.deepEqual({ focused: app.state().focused, closed: app.state().closed }, { focused: 'btn-grid-options', closed: 1 });
});
test('HTTP and denied clipboard have a selectable manual-copy fallback', async () => {
    for (const secure of [false, true]) {
    const app = harness(async () => ({ ok: true, text: async () => JSON.stringify(identity) }), secure, true);
    app.open(); await tick(); await app.get('btn-copy-version').events.click();
    assert.equal(app.get('about-copy-text').hidden, false);
    assert.equal(app.get('about-copy-text').selected, true);
    assert.equal(app.get('about-copy-text').value, formatVersionInfo(identity));
    app.get('about-dialog').close();
    }
});
test('missing, malformed, and oversized metadata remain usable without an invented release', async () => {
    for (const response of [{ ok: false }, { ok: true, text: async () => 'invalid' }, { ok: true, text: async () => 'x'.repeat(4097) }]) {
        const app = harness(async () => response);
        app.open(); await tick();
        assert.equal(app.get('about-version').textContent, 'Development / unknown version');
        assert.equal(app.get('about-release-notes').href, 'https://github.com/The-Grog/FolderFrame/releases');
        assert.equal(app.get('btn-copy-version').disabled, false);
        app.get('about-dialog').close();
    }
});
test('closing aborts metadata and a stale response cannot overwrite a reopened panel', async () => {
    const pending = [];
    const app = harness((url, options) => new Promise(resolve => pending.push({ resolve, signal: options.signal })));
    app.open(); app.get('about-dialog').close();
    assert.equal(pending[0].signal.aborted, true);
    app.open();
    pending[1].resolve({ ok: true, text: async () => JSON.stringify(identity) }); await tick();
    pending[0].resolve({ ok: true, text: async () => JSON.stringify({ ...identity, version: 'v0.1.0' }) }); await tick();
    assert.equal(app.get('about-version').textContent, 'v1.2.3');
    app.get('about-dialog').close();
});
