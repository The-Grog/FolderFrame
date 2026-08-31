const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
function fixture(options = {}) {
    const timers = new Map(); let id = 0, serial = 0;
    const revoked = [], warnings = [];
    const context = vm.createContext({
        AbortController, console, module: { exports: {} },
        setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }, fetch: async () => ({ ok: true, text: async () => 'ok' })
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../resilience.js'), 'utf8'), context);
    const api = context.module.exports;
    const pool = api.createImagePool({
        download: async file => file,
        decode: async file => ({ size: 8, file }),
        thumbnail: async full => ({ size: 2, file: full.file, small: true }),
        createURL: blob => 'blob:' + (++serial) + ':' + (blob.small ? 'small' : 'full'),
        revokeURL: url => revoked.push(url), warn: (...args) => warnings.push(args),
        ...options
    });
    const fire = delay => {
        for (const [key, timer] of [...timers]) if (timer.delay === delay) {
            timers.delete(key); timer.fn();
        }
    };
    return { api, pool, context, timers, fire, revoked, warnings };
}
test('request deadline covers a stalled body and cancellation rejects without server cooperation', async () => {
    const f = fixture();
    f.context.fetch = async () => ({ ok: true, text: () => new Promise(() => {}) });
    const timed = assert.rejects(f.api.request('/slow'), { name: 'TimeoutError' });
    await flush(); f.fire(15000); await timed;
    const controller = new AbortController();
    const cancelled = assert.rejects(f.api.request('/old', { signal: controller.signal }), { name: 'AbortError' });
    controller.abort(); await cancelled;
    assert.equal(f.timers.size, 0);
});
test('request exposes structured HTTP status and request URL', async () => {
    const f = fixture();
    f.context.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(f.api.request('/gone'), error => {
        assert.equal(error.name, 'HTTPError');
        assert.equal(error.status, 404);
        assert.equal(error.url, '/gone');
        return true;
    });
});
test('bounded task queue limits concurrency, prioritizes waiting work, and cancels queued tasks', async () => {
    const f = fixture();
    const queue = f.api.createTaskQueue({ concurrency: 2 });
    const work = [], started = [];
    const task = name => queue.schedule(() => {
        started.push(name);
        const pending = deferred();
        work.push(pending);
        return pending.promise;
    }, { priority: name === 'viewer' ? 10 : name === 'album' ? 5 : 0 });
    const first = task('grid-1');
    const second = task('grid-2');
    const grid = task('grid-3');
    const album = task('album');
    const viewer = task('viewer');
    assert.deepEqual(started, ['grid-1', 'grid-2']);
    assert.deepEqual(JSON.parse(JSON.stringify(queue.stats())), { active: 2, queued: 3, concurrency: 2 });
    work[0].resolve('one'); await flush();
    assert.equal(started[2], 'viewer');
    work[1].resolve('two'); await flush();
    assert.equal(started[3], 'album');

    const controller = new AbortController();
    const cancelled = assert.rejects(queue.schedule(() => 'never', { signal: controller.signal }), { name: 'AbortError' });
    controller.abort();
    await cancelled;
    assert.equal(queue.stats().queued, 1);

    work[2].resolve('viewer'); work[3].resolve('album'); await flush();
    assert.equal(started[4], 'grid-3');
    work[4].resolve('three');
    assert.deepEqual(await Promise.all([first, second, grid, album, viewer]), ['one', 'two', 'three', 'album', 'viewer']);
});
test('shared in-flight decode serves thumbnail then viewer and viewer then thumbnail', async () => {
    for (const first of ['thumbnail', 'viewer']) {
        const work = deferred(); let decodes = 0;
        const f = fixture({ decode: () => { decodes++; return work.promise; } });
        const a = f.pool.acquire('same', first);
        await flush();
        const b = f.pool.acquire('same', first === 'viewer' ? 'thumbnail' : 'viewer');
        work.resolve({ size: 8 });
        const [left, right] = await Promise.all([a, b]);
        assert.equal(decodes, 1);
        assert.notEqual(left.url, right.url);
        assert.match(first === 'viewer' ? left.url : right.url, /full/);
        left.release(); right.release();
    }
});
test('cached viewer produces thumbnail without re-decoding; thumbnail never substitutes for full image', async () => {
    let decodes = 0;
    const f = fixture({ decode: async () => { decodes++; return { size: 8 }; } });
    const full = await f.pool.acquire('a');
    const small = await f.pool.acquire('a', 'thumbnail');
    assert.equal(decodes, 1);
    assert.match(small.url, /small/);
    full.release(); small.release();
    const thumbnailFirst = await f.pool.acquire('b', 'thumbnail');
    thumbnailFirst.release();
    const viewerLater = await f.pool.acquire('b');
    assert.equal(decodes, 3, 'a thumbnail-only cache cannot supply full resolution');
    assert.match(viewerLater.url, /full/); viewerLater.release();
});
test('two active jobs maximum and queued viewer takes priority over thumbnails', async () => {
    const work = [], started = [];
    const f = fixture({ decode: file => { started.push(file); const d = deferred(); work.push(d); return d.promise; } });
    const requests = [f.pool.acquire('one'), f.pool.acquire('two')];
    await flush();
    requests.push(f.pool.acquire('thumb', 'thumbnail'), f.pool.acquire('viewer'));
    assert.equal(started.length, 2);
    work[0].resolve({ size: 8 }); await flush();
    assert.equal(started[2], 'viewer');
    work[1].resolve({ size: 8 }); await flush();
    assert.equal(started[3], 'thumb');
    work[2].resolve({ size: 8 }); work[3].resolve({ size: 8 });
    (await Promise.all(requests)).forEach(lease => lease.release());
});
test('queued orphan grace permits reattachment and running decode survives consumer detachment', async () => {
    const d = deferred();
    const f = fixture({ concurrency: 1, decode: async file => file === 'busy' ? d.promise : { size: 8 } });
    const busy = f.pool.acquire('busy'); await flush();
    const controller = new AbortController();
    const orphan = assert.rejects(f.pool.acquire('next', 'viewer', controller.signal), { name: 'AbortError' });
    controller.abort(); await orphan;
    const returned = f.pool.acquire('next');
    f.fire(250);
    assert.equal(f.pool.stats().jobs, 2);
    d.resolve({ size: 8 });
    (await busy).release(); (await returned).release();

    const decode = deferred(); let calls = 0;
    const g = fixture({ decode: () => { calls++; return decode.promise; } });
    const owner = new AbortController();
    const pending = assert.rejects(g.pool.acquire('same', 'viewer', owner.signal), { name: 'AbortError' });
    await flush(); owner.abort(); await pending; g.fire(250);
    const again = g.pool.acquire('same');
    decode.resolve({ size: 8 }); (await again).release();
    assert.equal(calls, 1);
});
test('download is aborted when last consumer detaches', async () => {
    let signal;
    const f = fixture({ download: (_, s) => { signal = s; return new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('abort')))); } });
    const controller = new AbortController();
    const pending = assert.rejects(f.pool.acquire('a', 'viewer', controller.signal));
    controller.abort(); await pending; await flush();
    assert.equal(signal.aborted, true);
    assert.equal(f.pool.stats().active, 0);
});
test('timed-out decodes keep slots occupied, warn, and fail waiting HEIC jobs promptly', async () => {
    const jobs = [deferred(), deferred()]; let i = 0;
    const f = fixture({ decode: () => jobs[i++].promise });
    const first = assert.rejects(f.pool.acquire('a'), { name: 'TimeoutError' });
    const second = assert.rejects(f.pool.acquire('b'), { name: 'TimeoutError' });
    await flush();
    const queued = assert.rejects(f.pool.acquire('c'), { name: 'TimeoutError' });
    f.fire(30000); await Promise.all([first, second, queued]);
    assert.equal(f.pool.stats().active, 2);
    assert.equal(f.warnings.length, 2);
    await assert.rejects(f.pool.acquire('d'), { name: 'TimeoutError' });
    jobs[0].resolve({ size: 8 }); jobs[1].resolve({ size: 8 }); await flush();
    assert.equal(f.pool.stats().active, 0);
});
test('cache evicts unpinned LRU entries and invalidation never revokes an active lease', async () => {
    const f = fixture({ limits: { viewer: [1, 8], thumbnail: [1, 2] } });
    const a = await f.pool.acquire('a'), b = await f.pool.acquire('b');
    assert.equal(f.revoked.length, 0, 'active consumers may exceed cache budget');
    a.release();
    assert.ok(f.revoked.includes(a.url));
    f.pool.invalidate('b');
    assert.ok(!f.revoked.includes(b.url));
    const replacement = await f.pool.acquire('b');
    assert.notEqual(replacement.url, b.url);
    b.release();
    assert.equal(f.revoked.filter(url => url === b.url).length, 1);
    replacement.release(); f.pool.invalidate();
    assert.ok(f.revoked.includes(replacement.url));
});
