// FolderFrame
// Features: directory-backed albums, HEIC/HEIF handling, shuffle slideshow,
// auto-rescan, TV/photo-frame mode, local preferences, and recursive folder browsing.

const settingsApi = window.FolderFrameSettings;
const resilience = window.FolderFrameResilience;
let scanSession = null, gridSession = null, viewerSession = null;
let failedNavigation = null;
let warningReturnFolder = null;
let missingFolderRecovery = null;
let emptyFolderNotice = false;
const DIRECTORY_TIMEOUT = 15000, MEDIA_TIMEOUT = 30000;
const GRID_BATCH_SIZE = 100, GRID_WINDOW_SIZE = 300;
const SCAN_SIBLING_CONCURRENCY = 5; // Bounds simultaneous directory-listing requests during recursive "All Pics" scans.
const NATIVE_IMAGE_CONCURRENCY = 4;
const NATIVE_IMAGE_PRIORITY = Object.freeze({ grid: 0, album: 5, viewer: 10 });
const nativeImageQueue = resilience.createTaskQueue({ concurrency: NATIVE_IMAGE_CONCURRENCY });
let gridVirtualizer = null;
function clearMediaSource(element) {
    if (element.removeAttribute) element.removeAttribute('src');
    else element.src = '';
    element.load?.();
}

function stopViewerSession() {
    if (!viewerSession) return;
    viewerSession.controller.abort();
    clearTimeout(viewerSession.timer);
    viewerSession = null;
}
function stopGridSession() {
    stopAlbumPreviews();
    if (!gridSession) return;
    gridSession.controller.abort();
    gridSession.observer?.disconnect();
    gridSession.cleanups.forEach(cleanup => cleanup());
    gridSession = null;
    gridVirtualizer = null;
}
function startGridSession() {
    stopGridSession();
    gridSession = { controller: new AbortController(), cleanups: new Set(), observer: null };
    return gridSession;
}

let galleryConfig;
let activeSource;
let preferenceKey;
let rememberPreferences = true;
let controlsEnabled = true;
let showDownloadButton = true;
let showCopyButton = true;
let swipeStart = null;
let gridReturn = null;
let albumPreviewSession = null;

function stopAlbumPreviews() {
    if (!albumPreviewSession) return;
    albumPreviewSession.controller.abort();
    albumPreviewSession.items?.forEach((controller, item) => { controller.abort(); item.coverImage && (item.coverImage.src = ''); });
    albumPreviewSession.observer?.disconnect();
    albumPreviewSession.queue.length = 0;
    albumPreviewSession = null;
}

function startAlbumPreviews() {
    stopAlbumPreviews();
    const session = { controller: new AbortController(), observer: null, queue: [], active: 0, items: new Map(), listingCache: new Map() };
    albumPreviewSession = session;
    const pump = () => {
        if (session.controller.signal.aborted) return;
        while (session.active < 3 && session.queue.length) {
            const { item, folder, controller } = session.queue.shift();
            if (controller.signal.aborted) continue;
            session.active++;
            loadAlbumPreview(item, folder, controller.signal)
                .finally(() => { session.active--; pump(); });
        }
    };
    const enqueue = item => {
        if (session.items.has(item)) return;
        const controller = new AbortController();
        session.items.set(item, controller);
        session.queue.push({ item, folder: item.dataset.albumFolder, controller }); pump();
    };
    if ('IntersectionObserver' in window) {
        session.observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting) enqueue(entry.target);
                else {
                    session.items.get(entry.target)?.abort(); session.items.delete(entry.target);
                    if (entry.target.coverImage) entry.target.coverImage.src = '';
                    entry.target.classList.remove('has-album-cover');
                }
            }
        }, { root: gridViewContainer, rootMargin: '300px' });
    }
    return item => session.observer ? session.observer.observe(item) : enqueue(item);
}

function queueNativeImageSource(element, source, signal, { priority = 0, onStart = null } = {}) {
    const operation = nativeImageQueue.schedule(() => new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(resilience.abortError()); return; }
        const token = Symbol('native-image-load');
        const originalLoad = element.onload;
        const originalError = element.onerror;
        let settled = false;
        element.folderFrameDecodeToken = token;
        const restore = () => {
            if (element.folderFrameDecodeToken !== token) return;
            element.folderFrameDecodeToken = null;
            element.onload = originalLoad;
            element.onerror = originalError;
        };
        const finish = (handler, event) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', cancel);
            restore();
            let result;
            try { result = handler?.call(element, event); }
            catch (error) { console.error('FolderFrame: image load callback failed.', error); }
            resolve();
            return result;
        };
        const cancel = () => {
            if (settled) return;
            settled = true;
            restore();
            reject(resilience.abortError());
        };
        element.onload = event => finish(originalLoad, event);
        element.onerror = event => finish(originalError, event);
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            onStart?.();
            element.src = source;
        } catch (error) {
            signal?.removeEventListener('abort', cancel);
            restore();
            reject(error);
        }
    }), { signal, priority });
    // Most DOM callers are event-driven rather than awaiting this operation.
    // Attach a handler here so cancellation never becomes an unhandled rejection.
    operation.catch(error => {
        if (error?.name !== 'AbortError') console.warn('FolderFrame: native image load queue failed.', source, error);
    });
    return operation;
}

const ALBUM_COVER_MAX_DEPTH = 4;
const ALBUM_COVER_MAX_LISTINGS = 12;
async function findAlbumCover(folder, signal) {
    const queue = [{ folder, depth: 0 }];
    const visited = new Set();
    let listingsChecked = 0, sawMedia = false, searchIncomplete = false;
    // Captured once, from the album's own top-level listing (depth 0), which the
    // cover search already fetches as its very first candidate. This reuses that
    // existing request instead of issuing a new one just to count items.
    let directCount = null;
    while (queue.length && listingsChecked < ALBUM_COVER_MAX_LISTINGS) {
        if (signal.aborted) throw resilience.abortError();
        const candidate = queue.shift();
        if (visited.has(candidate.folder)) continue;
        visited.add(candidate.folder); listingsChecked++;
        let listing = albumPreviewSession?.listingCache.get(candidate.folder);
        if (!listing) {
            listing = await scanDirectory(candidate.folder, { signal });
            if (albumPreviewSession && !signal.aborted) albumPreviewSession.listingCache.set(candidate.folder, listing);
        }
        if (candidate.depth === 0 && directCount === null) {
            directCount = {
                files: listing.filePaths.length,
                folders: listing.folderNames.length,
                hasVideo: listing.filePaths.some(isVideoFile)
            };
        }
        const file = listing.filePaths.find(isImageFile);
        if (file) return { file, confirmedEmpty: false, directCount };
        if (listing.filePaths.some(isMediaFile)) sawMedia = true;
        if (candidate.depth < ALBUM_COVER_MAX_DEPTH) {
            listing.folderNames.forEach(name => queue.push({
                folder: candidate.folder ? `${candidate.folder}/${name}` : name,
                depth: candidate.depth + 1
            }));
        } else if (listing.folderNames.length) searchIncomplete = true;
    }
    if (queue.length) searchIncomplete = true;
    return { file: null, confirmedEmpty: !sawMedia && !searchIncomplete, directCount };
}

function albumSubtitleText(counts) {
    if (!counts) return 'Open album';
    if (counts.files > 0) {
        const noun = counts.hasVideo ? 'item' : 'photo';
        return `${counts.files} ${noun}${counts.files === 1 ? '' : 's'}`;
    }
    if (counts.folders > 0) return `${counts.folders} album${counts.folders === 1 ? '' : 's'}`;
    return 'Open album';
}

async function loadAlbumPreview(item, folder, signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    let timeout;
    let preview;
    const fallback = () => {
        if (signal.aborted) return;
        if (preview) preview.hidden = true;
        item.classList.remove('has-album-cover');
    };
    try {
        if (signal.aborted) return;
        const result = await findAlbumCover(folder, controller.signal);
        if (!result.file && result.confirmedEmpty) {
            item.hidden = true;
            item.dataset.emptyAlbum = 'true';
            return;
        }
        if (result.directCount && !signal.aborted) {
            item.dataset.directFiles = String(result.directCount.files);
            item.dataset.directFolders = String(result.directCount.folders);
            const subtitleEl = item.querySelector('.album-subtitle');
            if (subtitleEl) subtitleEl.textContent = albumSubtitleText(result.directCount);
        }
        const file = result.file;
        if (!file || signal.aborted || controller.signal.aborted) return;
        const generatedUrl = persistentThumbnailUrl(file);
        let url = generatedUrl || (isHeicFile(file) ? await getSpecialImageURL(file, signal, 'thumbnail') : file);
        if (signal.aborted || controller.signal.aborted) return;
        preview = item.coverImage || document.createElement('img');
        item.coverImage = preview;
        preview.className = 'album-cover';
        preview.alt = '';
        preview.draggable = false;
        preview.hidden = true;
        preview.decoding = 'async';
        let previewLoadController = null;
        const loadPreview = source => {
            previewLoadController?.abort();
            previewLoadController = new AbortController();
            const cancel = () => previewLoadController?.abort();
            signal.addEventListener('abort', cancel, { once: true });
            const operation = queueNativeImageSource(preview, source, previewLoadController.signal, {
                priority: NATIVE_IMAGE_PRIORITY.album,
                onStart: () => {
                    clearTimeout(timeout);
                    timeout = setTimeout(() => {
                        fallback();
                        previewLoadController?.abort();
                    }, MEDIA_TIMEOUT);
                }
            });
            operation.then(
                () => signal.removeEventListener('abort', cancel),
                () => signal.removeEventListener('abort', cancel)
            );
            return operation;
        };
        preview.onload = () => {
            if (signal.aborted) return;
            clearTimeout(timeout);
            preview.hidden = false;
            item.classList.add('has-album-cover');
        };
        preview.onerror = async () => {
            clearTimeout(timeout);
            if (generatedUrl && preview.src === generatedUrl && !signal.aborted) {
                try {
                    url = isHeicFile(file) ? await getSpecialImageURL(file, signal, 'thumbnail') : file;
                    if (!signal.aborted) loadPreview(url);
                    return;
                } catch {}
            }
            fallback();
        };
        signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
        if (!preview.parentNode) item.appendChild(preview);
        loadPreview(url);
    } catch (error) {
        // An unavailable preview never prevents opening the album.
        fallback();
    } finally {
        signal.removeEventListener('abort', cancel);
    }
}
let refreshInterval = 60; // Seconds; resolved per index/embed profile.

let mediaFiles = [];
let subfolders = [];
let currentFolder = '';
let currentIndex = 0;
let zoom = 1.0, panX = 0, panY = 0, imageRotation = 0;
let isDragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;
let isPinching = false, initialDist = 0, initialZoom = 1.0, initialMidX = 0, initialMidY = 0, initialPanX = 0, initialPanY = 0;
let slideshowPlaying = false, slideshowTimer = null, slideshowInterval = 5, slideProgress = 0;
let slideshowAnimationFrame = null, slideshowStartedAt = 0;
let uiVisible = true, idleTimer = null, imageMode = 'fit', isGridViewActive = true;
let shuffleEnabled = false, autoRefreshEnabled = true, tvModeEnabled = false;
let galleryViewMode = 'folders'; // 'folders' or 'all'
let sortMode = 'filename';
const GRID_DENSITY_PX = { compact: 130, comfortable: 180, spacious: 240 };
let gridDensity = 'comfortable';
let gridTileMinPx = GRID_DENSITY_PX.comfortable;
function applyGridDensity(density) {
    gridDensity = GRID_DENSITY_PX[density] ? density : 'comfortable';
    gridTileMinPx = GRID_DENSITY_PX[gridDensity];
    document.documentElement?.style.setProperty('--grid-tile-min', gridTileMinPx + 'px');
}
const modifiedDateCache = new Map();
const DATE_CACHE_TTL = 24 * 60 * 60 * 1000;
const DATE_CACHE_LIMIT = 2000;
let dateCacheKey = null;
let scanManifest = null, scanManifestKey = null;
const SCAN_MANIFEST_VERSION = 1;
const SCAN_MANIFEST_DIRECTORY_LIMIT = 5000;
const PERSISTENT_MANIFEST_VERSION = 1;
let persistentManifestState = null;
const persistentThumbnailUrls = new Map();
let manifestFailureNotice = false;

function isManifestOnlySource() {
    return activeSource?.discoveryMode === 'manifest';
}

function usesPublishedManifest() {
    return activeSource?.discoveryMode !== 'directory' && Boolean(activeSource?.manifestUrl);
}

function persistentManifestError(message, cause = null) {
    const error = new Error(message);
    error.name = 'PersistentManifestError';
    error.code = 'PERSISTENT_MANIFEST_INVALID';
    if (cause) error.cause = cause;
    return error;
}

function isPersistentManifestError(error) {
    return error?.name === 'PersistentManifestError' || error?.code === 'PERSISTENT_MANIFEST_INVALID';
}

function cacheBustedManifestUrl(url, token) {
    if (!token) return url;
    const requestUrl = new URL(url);
    requestUrl.searchParams.set('ff_refresh', token);
    return requestUrl.href;
}

function resetPersistentManifest({ cacheBust = false } = {}) {
    persistentManifestState = usesPublishedManifest()
        ? { key: activeSource.manifestUrl, promise: null, index: null, unavailable: false, error: null,
            cacheBustToken: cacheBust ? `${Date.now()}-${Math.random().toString(36).slice(2)}` : null, chunks: new Map() }
        : null;
    persistentThumbnailUrls.clear();
}

function safeManifestPath(value, { allowEmpty = false } = {}) {
    if (typeof value !== 'string' || /[\\\x00-\x1f]/.test(value)) return null;
    const parts = value.split('/').filter(Boolean);
    if ((!allowEmpty && !parts.length) || parts.some(part => part === '.' || part === '..')) return null;
    return parts.join('/');
}

function manifestAssetUrl(relative) {
    if (!activeSource.thumbnailUrl) return null;
    const path = safeManifestPath(relative);
    if (!path) return null;
    try {
        return new URL(path.split('/').map(encodeURIComponent).join('/'), activeSource.thumbnailUrl).href;
    } catch { return null; }
}

function persistentThumbnailUrl(file) {
    return persistentThumbnailUrls.get(file) || settingsApi.thumbnailUrl(activeSource, file);
}

function validateManifestRecord(record, expectedPath) {
    if (!record || typeof record !== 'object' || record.path !== expectedPath ||
        !Array.isArray(record.files) || !Array.isArray(record.folders)) return null;
    const folders = [];
    for (const name of record.folders) {
        if (typeof name !== 'string' || !name || /[\/\\\x00-\x1f]/.test(name) || ['.', '..'].includes(name)) return null;
        folders.push(name);
    }
    const files = [];
    for (const entry of record.files) {
        const path = safeManifestPath(entry?.path);
        if (!path || parentFolder(path) !== expectedPath || !isMediaFile(path)) return null;
        files.push({ ...entry, path });
    }
    return { files, folders };
}

function listingFromManifest(record, expectedPath) {
    const valid = validateManifestRecord(record, expectedPath);
    if (!valid) return null;
    loadDateCache();
    const now = Date.now();
    const filePaths = valid.files.map(entry => {
        const name = entry.path.split('/').pop();
        const folder = parentFolder(entry.path);
        const file = mediaUrlFor(name, folder);
        modifiedDateCache.set(file, {
            date: Number.isFinite(entry.mtime) ? entry.mtime : null,
            size: Number.isFinite(entry.size) ? entry.size : null,
            checked: now
        });
        const thumbnail = entry.thumbnailPath ? manifestAssetUrl(entry.thumbnailPath) : null;
        if (thumbnail) persistentThumbnailUrls.set(file, thumbnail);
        return file;
    });
    return { filePaths, folderNames: [...valid.folders] };
}

async function ensurePersistentManifest(signal) {
    if (!usesPublishedManifest()) return null;
    if (!persistentManifestState || persistentManifestState.key !== activeSource.manifestUrl) resetPersistentManifest();
    const state = persistentManifestState;
    if (state.unavailable) {
        if (isManifestOnlySource()) throw state.error || persistentManifestError('The published media index is unavailable.');
        return null;
    }
    if (state.index) return state.index;
    if (!state.promise) {
        const requestUrl = cacheBustedManifestUrl(activeSource.manifestUrl, state.cacheBustToken);
        state.promise = resilience.request(requestUrl, {
            signal, timeout: DIRECTORY_TIMEOUT, cache: 'no-store', body: 'json'
        }).then(index => {
            if (!index || index.version !== PERSISTENT_MANIFEST_VERSION ||
                !index.root || typeof index.root !== 'object' ||
                !index.chunks || typeof index.chunks !== 'object' || Array.isArray(index.chunks) ||
                !validateManifestRecord(index.root, '')) {
                throw persistentManifestError('The published media index has an unsupported or invalid root record.');
            }
            state.index = index;
            console.info(`FolderFrame: loaded persistent media index${index.generatedAt ? ` from ${index.generatedAt}` : ''}.`);
            if (Array.isArray(index.errors) && index.errors.length) {
                console.warn(`FolderFrame: persistent media index reports ${index.errors.length} unreadable paths.`);
            }
            return index;
        }).catch(error => {
            state.promise = null;
            if (signal?.aborted || error?.name === 'AbortError') throw error;
            const failure = isPersistentManifestError(error)
                ? error
                : persistentManifestError('The published media index could not be loaded.', error);
            // Remember the failure for this gallery scan so a missing index is
            // not requested again for every descendant directory.
            state.unavailable = true;
            state.error = failure;
            if (isManifestOnlySource()) {
                console.warn('FolderFrame: required published media index unavailable.', error);
                throw failure;
            }
            console.warn('FolderFrame: persistent media index unavailable; scanning directory listings directly.', error);
            return null;
        });
    }
    return state.promise;
}

async function loadPersistentChunk(topFolder, signal) {
    const index = await ensurePersistentManifest(signal);
    if (!index) return null;
    const descriptor = index.chunks[topFolder];
    if (!descriptor || typeof descriptor.file !== 'string') {
        if (isManifestOnlySource()) throw persistentManifestError(`The published media index has no chunk for “${topFolder}”.`);
        return null;
    }
    const state = persistentManifestState;
    if (state.chunks.has(topFolder)) return state.chunks.get(topFolder);
    const promise = (async () => {
        try {
            const base = new URL('.', activeSource.manifestUrl);
            const chunkUrl = new URL(descriptor.file, base);
            if (chunkUrl.origin !== base.origin || !chunkUrl.pathname.startsWith(base.pathname) ||
                chunkUrl.search || chunkUrl.hash) throw new Error('Unsafe persistent manifest chunk path');
            // Chunk ownership follows the active gallery scan, not an individual
            // album-cover observer that may scroll offscreen during the request.
            const ownerSignal = scanSession?.signal || signal;
            const requestUrl = cacheBustedManifestUrl(chunkUrl.href, state.cacheBustToken);
            const chunk = await resilience.request(requestUrl, {
                signal: ownerSignal, timeout: DIRECTORY_TIMEOUT, cache: 'no-store', body: 'json'
            });
            if (!chunk || chunk.version !== PERSISTENT_MANIFEST_VERSION || chunk.root !== topFolder ||
                !chunk.directories || typeof chunk.directories !== 'object' || Array.isArray(chunk.directories)) {
                throw new Error('Invalid persistent manifest chunk');
            }
            return chunk;
        } catch (error) {
            if (scanSession?.signal?.aborted || (!scanSession && signal?.aborted) || error?.name === 'AbortError') {
                state.chunks.delete(topFolder);
                throw error;
            }
            if (isManifestOnlySource()) {
                state.chunks.delete(topFolder);
                throw (isPersistentManifestError(error)
                    ? error
                    : persistentManifestError(`The published media index chunk for “${topFolder}” is unavailable or invalid.`, error));
            }
            // Keep the resolved null in the chunk cache for this scan so each
            // descendant falls back directly without redownloading a bad chunk.
            console.warn(`FolderFrame: media index chunk for “${topFolder}” is unavailable; scanning that subtree directly.`, error);
            return null;
        }
    })();
    state.chunks.set(topFolder, promise);
    return promise;
}

async function persistentDirectoryListing(folder, signal) {
    const normalized = safeManifestPath(folder, { allowEmpty: true });
    if (normalized === null) return null;
    const index = await ensurePersistentManifest(signal);
    if (!index) return null;
    if (!normalized) {
        const listing = listingFromManifest(index.root, '');
        if (!listing && isManifestOnlySource()) {
            throw persistentManifestError('The published media index root record is invalid.');
        }
        if (!listing) console.warn('FolderFrame: persistent media index root is invalid; scanning the source directly.');
        return listing;
    }
    const topFolder = normalized.split('/')[0];
    const chunk = await loadPersistentChunk(topFolder, signal);
    if (!chunk) return null;
    const listing = listingFromManifest(chunk.directories[normalized], normalized);
    if (!listing && isManifestOnlySource()) {
        throw persistentManifestError(`The published media index has no valid record for “${normalized}”.`);
    }
    if (!listing) console.warn(`FolderFrame: persistent media index has no valid record for “${normalized}”; scanning that directory directly.`);
    return listing;
}

function getScanManifest() {
    const key = `folderframe.scan-manifest:v${SCAN_MANIFEST_VERSION}:${galleryConfig.baseUrl}:${activeSource.id}:${activeSource.url}`;
    if (scanManifestKey === key && scanManifest) return scanManifest;
    scanManifestKey = key;
    scanManifest = { version: SCAN_MANIFEST_VERSION, directories: {} };
    try {
        const stored = JSON.parse(localStorage.getItem(key) || 'null');
        if (stored?.version === SCAN_MANIFEST_VERSION && stored.directories && typeof stored.directories === 'object') {
            scanManifest = stored;
        }
    } catch (error) {
        // Invalid or unavailable browser storage falls back to normal full scans.
    }
    return scanManifest;
}

function saveScanManifest() {
    if (!activeSource.scanCache || !scanManifestKey || !scanManifest) return;
    try {
        const entries = Object.entries(scanManifest.directories)
            .sort((a, b) => (b[1].checked || 0) - (a[1].checked || 0))
            .slice(0, SCAN_MANIFEST_DIRECTORY_LIMIT);
        scanManifest.directories = Object.fromEntries(entries);
        localStorage.setItem(scanManifestKey, JSON.stringify(scanManifest));
    } catch (error) {
        // Storage quotas are optional optimization failures, never gallery failures.
    }
}

async function directoryModifiedTime(url, signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), DIRECTORY_TIMEOUT);
    try {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
        if (!response.ok) return null;
        const value = response.headers?.get('Last-Modified');
        const parsed = value ? Date.parse(value) : NaN;
        return Number.isFinite(parsed) ? parsed : null;
    } catch (error) {
        if (signal?.aborted) throw resilience.abortError();
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
    }
}

function trimDateCache(now = Date.now()) {
    for (const [file, entry] of modifiedDateCache) {
        if (!entry || !Number.isFinite(entry.checked) || entry.checked > now ||
            now - entry.checked >= DATE_CACHE_TTL ||
            (entry.date !== null && !Number.isFinite(entry.date))) modifiedDateCache.delete(file);
    }
    const oldest = [...modifiedDateCache].sort((a, b) => a[1].checked - b[1].checked);
    for (const [file] of oldest.slice(0, Math.max(0, oldest.length - DATE_CACHE_LIMIT))) modifiedDateCache.delete(file);
}

function loadDateCache() {
    const key = `folderframe.date-cache:v1:${galleryConfig.baseUrl}:${activeSource.id}:${activeSource.url}`;
    if (dateCacheKey === key) return;
    modifiedDateCache.clear();
    dateCacheKey = key;
    try {
        const entries = JSON.parse(localStorage.getItem(key) || '[]');
        if (!Array.isArray(entries)) return;
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue;
            const [file, value] = entry;
            // Cached metadata must never introduce URLs outside the selected source.
            if (!file.startsWith(activeSource.url) || !value || typeof value !== 'object') continue;
            modifiedDateCache.set(file, { date: value.date, size: value.size ?? null, checked: value.checked });
        }
        trimDateCache();
    } catch (error) {
        // Private browsing, corrupt JSON, and denied storage must not stop sorting.
        modifiedDateCache.clear();
    }
}

function saveDateCache() {
    trimDateCache();
    try {
        localStorage.setItem(dateCacheKey, JSON.stringify([...modifiedDateCache]
            .filter(([file]) => file.startsWith(activeSource.url))));
    } catch (error) {
        // Keep the bounded in-memory cache if storage is full or unavailable.
    }
}
let autoRefreshTimer = null;
let isScanning = false;
let scannedFolders = 0, scannedFiles = 0;
let mediaLoadId = 0;
let mediaFailed = false;
let imageReady = false;
let reclassifiedVideoActive = false;

// Cache only object URLs we create ourselves. Normal HTTP URLs are never revoked.
let specialImagePool = null;

const $ = (id) => document.getElementById(id);
const viewport = $('media-viewport');
const container = $('media-container');
const img = $('gallery-image');
const video = $('gallery-video');
const mediaTitle = $('media-title');
const mediaIndex = $('media-index');
const btnRotate = $('btn-rotate');
const btnResetZoom = $('btn-reset-zoom');
const btnImageMode = $('btn-image-mode');
const btnDownload = $('btn-download');
const btnCopyLink = $('btn-copy-link');
const btnViewerOptions = $('btn-viewer-options');
const viewerOptionsMenu = $('viewer-options-menu');
const imageModeText = $('image-mode-text');
const btnPlayPause = $('btn-play-pause');
const playIcon = btnPlayPause.querySelector('.play-icon');
const pauseIcon = btnPlayPause.querySelector('.pause-icon');
const slideshowText = $('slideshow-text');
const selectInterval = $('select-interval');
const progressBar = $('progress-bar');
const progressContainer = $('progress-container');
const btnFullscreen = $('btn-fullscreen');
const navLeft = $('nav-left');
const navRight = $('nav-right');
const helpHint = $('help-hint');
const warningOverlay = $('warning-overlay');
const btnRetryWarning = $('btn-retry-warning');
const wrapper = $('gallery-wrapper');
const gridViewContainer = $('grid-view-container');
const thumbnailGrid = $('thumbnail-grid');
const btnRefreshGrid = $('btn-refresh-grid');
const btnShowGrid = $('btn-show-grid');
const gridCount = $('grid-count');
const gridPath = $('grid-path');
const breadcrumb = $('breadcrumb');
const btnShuffle = $('btn-shuffle');
const btnAutoRefresh = $('btn-auto-refresh');
const btnGridOptions = $('btn-grid-options');
const gridOptionsMenu = $('grid-options-menu');
const gridHeader = $('grid-header');
const gridHeaderMain = gridHeader?.querySelector('.grid-header-main');
const gridActions = gridHeader?.querySelector('.grid-actions');
const gridDensitySlot = $('grid-density-slot');
const gridDensityMenuSlot = $('grid-density-menu-slot');
const gridViewModeSlot = $('grid-view-mode-slot');
const gridViewModeMenuSlot = $('grid-view-mode-menu-slot');
const gridSortSlot = $('grid-sort-slot');
const gridSortMenuSlot = $('grid-sort-menu-slot');
const btnViewMode = $('btn-view-mode');
const btnTvMode = $('btn-tv-mode');
const scanStatus = $('scan-status');
const videoErrorOverlay = $('video-error-overlay');
const videoErrorText = $('video-error-text');
const videoErrorFfmpeg = $('video-error-ffmpeg');
const btnCloseVideoError = $('btn-close-video-error');

window.addEventListener('DOMContentLoaded', async () => {
    await loadConfiguration();
    setupEventListeners();
    updateControlStates();
    updateFullscreenButton();
    const loaded = await loadGallery({ preserveView: false });
    if (loaded !== false) updateFolderHistory(currentFolder, 'replace');
    updateGalleryHeaderLayout();
    startAutoRefreshTimer();

    if (slideshowPlaying && mediaFiles.length > 0 && isGridViewActive) {
        enterFullScreenViewer(currentIndex);
    } else if (!mediaFiles.length) {
        stopSlideshow();
    }
});

window.addEventListener('popstate', async () => {
    const folder = new URL(location.href).searchParams.get('album') || '';
    if (folder !== currentFolder) await navigateToFolder(folder, { historyMode: 'none' });
});

window.addEventListener('beforeunload', () => {
    scanSession?.abort(); stopViewerSession(); stopGridSession(); clearImageBlobCache();
});

function isHeicFile(path) { return /\.(heic|heif)$/i.test(path); }
function isImageFile(path) { return /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(path); }
function isVideoFile(path) { return /\.(mp4|mov)$/i.test(path); }
function isMediaFile(path) { return isImageFile(path) || isVideoFile(path); }

function currentDirectoryUrl(folder = currentFolder) {
    return settingsApi.directoryUrl(activeSource, folder);
}

function mediaUrlFor(filename, folder = currentFolder) {
    return settingsApi.mediaUrl(activeSource, folder, filename);
}

function updateFolderHistory(folder, mode = 'push') {
    if (!window.history?.pushState) return;
    const url = new URL(location.href);
    if (folder) url.searchParams.set('album', folder);
    else url.searchParams.delete('album');
    const state = { ...(window.history.state || {}), folderFrameAlbum: folder };
    window.history[mode === 'replace' ? 'replaceState' : 'pushState'](state, '', url);
}

function savePreferences() {
    if (!rememberPreferences || !preferenceKey) return;
    try {
        localStorage.setItem(preferenceKey, JSON.stringify({
            album: currentFolder, interval: slideshowInterval, imageMode,
            shuffle: shuffleEnabled, autoRefresh: autoRefreshEnabled,
            view: galleryViewMode, sort: sortMode, gridDensity
        }));
    } catch (error) {
        // Storage can be unavailable in privacy modes and embedded contexts.
        console.warn('Could not save FolderFrame preferences:', error);
    }
}

async function loadConfiguration() {
    const warnings = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch('./folderframe.config.json', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        galleryConfig = settingsApi.normalizeConfig(await response.json(), location.href);
    } catch (error) {
        galleryConfig = settingsApi.normalizeConfig({}, location.href);
        warnings.push(`Could not use folderframe.config.json (${error.message}). Using built-in defaults.`);
    } finally {
        clearTimeout(timeout);
    }
    const resolved = settingsApi.resolveSettings(galleryConfig, location.search, key => localStorage.getItem(key));
    const startupSettings = resolved.settings;
    activeSource = resolved.source;
    preferenceKey = resolved.preferenceKey;
    rememberPreferences = startupSettings.rememberPreferences;
    controlsEnabled = startupSettings.controls;
    showDownloadButton = startupSettings.showDownloadButton;
    showCopyButton = startupSettings.showCopyButton;
    btnDownload.hidden = !showDownloadButton;
    btnCopyLink.hidden = !showCopyButton;
    document.body.classList.toggle('hide-filenames', !startupSettings.showFilenames);
    document.body.classList.toggle('hide-viewer-button-labels', !startupSettings.showButtonLabels);
    document.body.classList.toggle('controls-free', !controlsEnabled);
    currentFolder = startupSettings.album;
    galleryViewMode = startupSettings.view;
    sortMode = startupSettings.sort;
    slideshowInterval = startupSettings.interval;
    imageMode = startupSettings.imageMode;
    shuffleEnabled = startupSettings.shuffle;
    autoRefreshEnabled = startupSettings.autoRefresh;
    refreshInterval = startupSettings.refreshInterval;
    tvModeEnabled = startupSettings.tvMode;
    slideshowPlaying = startupSettings.autoplay;
    applyGridDensity(startupSettings.gridDensity);

    const selector = $('select-source');
    selector.replaceChildren();
    galleryConfig.sources.forEach(source => {
        const option = document.createElement('option');
        option.value = source.id;
        option.textContent = source.label;
        selector.appendChild(option);
    });
    selector.value = activeSource.id;
    $('source-control').hidden = galleryConfig.sources.length < 2;
    document.querySelectorAll('.configured-source-path').forEach(element => { element.textContent = activeSource.path; });
    warnings.push(...resolved.warnings);
    if (warnings.length) {
        console.warn('FolderFrame settings:', warnings);
        $('config-notice').textContent = warnings.join(' ');
        $('config-notice').hidden = false;
    }
}

function updateControlStates() {
    const sortLabels = { newest: 'Newest', oldest: 'Oldest', filename: 'Filename' };
    $('sort-label').textContent = sortLabels[sortMode];
    $('btn-sort').title = `Sorting: ${sortLabels[sortMode]}. Click to cycle Newest, Oldest, Filename.`;
    $('btn-sort').setAttribute('aria-label', `Sort: ${sortLabels[sortMode]}. Change sorting`);
    const densityLabels = { compact: 'Compact', comfortable: 'Comfortable', spacious: 'Spacious' };
    const densityButton = $('btn-grid-density');
    if (densityButton) {
        $('grid-density-label').textContent = densityLabels[gridDensity];
        densityButton.title = `Thumbnail size: ${densityLabels[gridDensity]}. Click to cycle Compact, Comfortable, Spacious.`;
        densityButton.setAttribute('aria-label', `Thumbnail size: ${densityLabels[gridDensity]}. Change thumbnail size`);
    }
    selectInterval.value = String(slideshowInterval);
    imageModeText.textContent = imageMode === 'fit' ? 'Fit' : 'Original';
    btnImageMode.querySelector('.fit-mode-icon').hidden = imageMode !== 'fit';
    btnImageMode.querySelector('.original-mode-icon').hidden = imageMode === 'fit';
    btnImageMode.setAttribute('aria-pressed', String(imageMode === 'original'));
    btnImageMode.setAttribute('aria-label', `Image sizing: ${imageMode === 'fit' ? 'Fit' : 'Original'}`);
    btnImageMode.title = imageMode === 'fit' ? 'Fit image to screen. Click for original size.' : 'Show image at original size. Click to fit screen.';
    btnShuffle.classList.remove('is-active');
    btnShuffle.setAttribute('aria-pressed', String(shuffleEnabled));
    btnShuffle.querySelector('.shuffle-on-icon').hidden = !shuffleEnabled;
    btnShuffle.querySelector('.shuffle-off-icon').hidden = shuffleEnabled;
    btnShuffle.querySelector('.button-label').textContent = shuffleEnabled ? 'Shuffle' : 'Shuffle Off';
    btnAutoRefresh.title = `Automatically rescan every ${refreshInterval} seconds`;
    btnAutoRefresh.classList.remove('is-active');
    btnAutoRefresh.setAttribute('aria-pressed', String(autoRefreshEnabled));
    btnAutoRefresh.querySelector('.button-label').textContent = autoRefreshEnabled ? 'Auto Refresh On' : 'Auto Refresh Off';
    const strictManifest = isManifestOnlySource();
    $('refresh-grid-label').textContent = strictManifest ? 'Reload Library' : 'Refresh Folder';
    btnRefreshGrid.title = strictManifest
        ? 'Reload the published media index. New files appear after the index is regenerated and redeployed.'
        : 'Rescan the current album now';
    btnRefreshGrid.setAttribute('aria-label', strictManifest ? 'Reload published library index' : 'Refresh current folder');
    btnViewMode.classList.remove('is-active');
    btnViewMode.setAttribute('aria-pressed', String(galleryViewMode === 'all'));
    // Like the other toggle buttons, the label describes the CURRENT state.
    btnViewMode.querySelector('.button-label').textContent = galleryViewMode === 'all' ? 'All Pics' : 'By Folder';
    btnViewMode.title = galleryViewMode === 'all'
        ? 'Currently showing all media recursively — click to browse by folder'
        : 'Currently browsing by folder — click to show all media recursively';
    btnTvMode.classList.toggle('is-active', tvModeEnabled);
    btnTvMode.setAttribute('aria-pressed', String(tvModeEnabled));
    btnTvMode.querySelector('.button-label').textContent = tvModeEnabled ? 'TV Mode On' : 'TV Mode';
    syncPlayButton();
}

function updateMediaActions(filepath, filename, forceVideo = false) {
    btnDownload.href = filepath;
    btnDownload.download = filename;
    btnDownload.setAttribute('aria-label', `Download ${filename}`);
    const copyable = isImageFile(filepath) && !forceVideo;
    btnRotate.disabled = true;
    btnCopyLink.disabled = true;
    const clipboardAvailable = window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined';
    btnCopyLink.setAttribute('aria-label', copyable ? `Copy image ${filename}` : 'Copy Image is unavailable for video');
    btnCopyLink.title = !copyable ? 'Copy Image is unavailable for video'
        : !clipboardAvailable ? 'Copy Image requires HTTPS or a trusted local context'
        : 'Copy displayed image after it loads';
}

function updateGalleryHeaderLayout() {
    if (!gridHeader || !gridHeaderMain || !gridActions) return;
    const controls = [
        { button: $('btn-grid-density'), home: gridDensitySlot, menu: gridDensityMenuSlot },
        { button: $('btn-sort'), home: gridSortSlot, menu: gridSortMenuSlot },
        { button: $('btn-view-mode'), home: gridViewModeSlot, menu: gridViewModeMenuSlot }
    ].filter(control => control.button && control.home && control.menu);

    // Start with the full desktop toolbar. If the navigation and actions cannot
    // share one line, move controls into Options one at a time, least essential first.
    controls.forEach(({ button, home }) => {
        if (button.parentElement !== home) home.appendChild(button);
        button.setAttribute('role', 'button');
    });
    const available = gridHeader.clientWidth || 0;
    const doesNotFit = () => available > 0 &&
        (gridHeaderMain.scrollWidth || 0) + (gridActions.scrollWidth || 0) + 18 > available;
    controls.forEach(({ button, menu }) => {
        if (!doesNotFit()) return;
        menu.appendChild(button);
        button.setAttribute('role', 'menuitem');
    });
    gridHeader.classList.toggle('actions-collapsed', controls.some(({ button, menu }) => button.parentElement === menu));
}

function setViewerOptionsOpen(open) {
    const expanded = Boolean(open);
    viewerOptionsMenu.hidden = !expanded;
    btnViewerOptions.setAttribute('aria-expanded', String(expanded));
}

function setGridOptionsOpen(open) {
    const expanded = Boolean(open);
    gridOptionsMenu.hidden = !expanded;
    btnGridOptions.setAttribute('aria-expanded', String(expanded));
}

function imageClipboardBlob() {
    return new Promise((resolve, reject) => {
        if (!imageReady || !img.naturalWidth || !img.naturalHeight) return reject(new Error('Image is not ready'));
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const context = canvas.getContext?.('2d');
        if (!context) return reject(new Error('Canvas is unavailable'));
        try { context.drawImage(img, 0, 0); }
        catch (error) { return reject(error); }
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create clipboard image')), 'image/png');
    });
}

async function copyCurrentImage() {
    if (!isPhotoActive() || btnCopyLink.disabled) return;
    const label = btnCopyLink.querySelector('.button-label');
    try {
        if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
            throw new Error('Image clipboard requires a secure context');
        }
        // Start the clipboard write during the click's transient user activation.
        // Supplying the PNG as a promise prevents Firefox/Safari from losing that
        // activation while the canvas finishes encoding.
        const png = imageClipboardBlob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        label.textContent = 'Copied';
        btnCopyLink.title = 'Image copied';
    } catch (error) {
        label.textContent = 'Copy Failed';
        btnCopyLink.title = 'Could not copy image; clipboard access may require HTTPS or permission';
    }
    setTimeout(() => { label.textContent = 'Copy Image'; btnCopyLink.title = 'Copy displayed image'; }, 1800);
}

function syncPlayButton() {
    playIcon.style.display = slideshowPlaying ? 'none' : 'inline';
    pauseIcon.style.display = slideshowPlaying ? 'inline' : 'none';
    slideshowText.textContent = slideshowPlaying ? 'Pause' : 'Play';
}

function clearImageBlobCache() { specialImagePool?.invalidate(); }
function removeCacheEntry(filepath) { specialImagePool?.invalidate(filepath); }
function detectContainer(arrayBuffer) {
    const b = new Uint8Array(arrayBuffer);
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
    if (b.length >= 6) {
        const gifSignature = ascii(b, 0, 6);
        if (gifSignature === 'GIF87a' || gifSignature === 'GIF89a') return 'gif';
    }

    // ISO Base Media File Format: size(4) + "ftyp" + major brand(4) + compatible brands.
    if (b.length >= 16 && ascii(b, 4, 8) === 'ftyp') {
        const brands = [];
        brands.push(ascii(b, 8, 12));
        for (let offset = 16; offset + 4 <= Math.min(b.length, 64); offset += 4) {
            brands.push(ascii(b, offset, offset + 4));
        }
        const heifBrands = new Set(['heic','heix','hevc','hevx','heim','heis','mif1','msf1','avic']);
        if (brands.some(brand => heifBrands.has(brand))) return 'heic';
        const quickTimeBrands = new Set(['qt  ','isom','iso2','mp41','mp42','m4v ','M4V ','avc1','hvc1','hev1','dash','msdh','M4A ','3gp4','3g2a']);
        if (brands.some(brand => quickTimeBrands.has(brand))) return 'quicktime';
    }
    return 'unknown';
}

function reclassifiedContainerError(container, data) {
    return Object.assign(new Error(`Media container is ${container}, not an image`), {
        name: 'MediaReclassificationError', container, data
    });
}

function isQuickTimeReclassification(error) {
    return error?.name === 'MediaReclassificationError' && error.container === 'quicktime';
}

async function sniffContainer(filepath, signal) {
    try {
        const data = await resilience.request(filepath, {
            signal, timeout: MEDIA_TIMEOUT, body: 'arrayBuffer', cache: 'no-store',
            headers: { Range: 'bytes=0-63' }
        });
        return { container: detectContainer(data), data };
    } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        return { container: 'unknown', data: null };
    }
}

function ascii(bytes, start, end) {
    return String.fromCharCode(...bytes.slice(start, end));
}

function mimeForFormat(format) {
    return ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' })[format] || '';
}

async function makeThumbnail(blob) {
    const temporary = URL.createObjectURL(blob);
    try {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve; image.onerror = () => reject(new Error('Thumbnail decode failed'));
            image.src = temporary;
        });
        const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve, reject) => canvas.toBlob(
            result => result ? resolve(result) : reject(new Error('Thumbnail resize failed')), 'image/jpeg', 0.8));
    } finally { URL.revokeObjectURL(temporary); }
}
let heicDecoderPromise = null;
function loadHeicDecoder() {
    if (typeof globalThis.heic2any === 'function') return Promise.resolve(globalThis.heic2any);
    if (heicDecoderPromise) return heicDecoderPromise;

    heicDecoderPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'heic2any.min.js';
        script.async = true;
        script.onload = () => typeof globalThis.heic2any === 'function'
            ? resolve(globalThis.heic2any)
            : reject(new Error('HEIC decoder library did not initialize'));
        script.onerror = () => reject(new Error('HEIC decoder library did not load'));
        document.head.appendChild(script);
    }).catch(error => {
        // A transient load failure may be retried by the next HEIC request.
        heicDecoderPromise = null;
        throw error;
    });
    return heicDecoderPromise;
}
function getImagePool() {
    if (!specialImagePool) specialImagePool = resilience.createImagePool({
        download: (file, signal) => resilience.request(file, { signal, timeout: MEDIA_TIMEOUT, body: 'arrayBuffer', cache: 'no-store' }),
        decode: async data => {
            const format = detectContainer(data);
            if (['jpeg', 'png', 'webp', 'gif'].includes(format)) return new Blob([data], { type: mimeForFormat(format) });
            if (format === 'quicktime') throw reclassifiedContainerError('quicktime', data);
            if (format !== 'heic') throw new Error('Unknown or corrupt image format');
            const decodeHeic = await loadHeicDecoder();
            const result = await decodeHeic({ blob: new Blob([data], { type: 'image/heic' }), toType: 'image/jpeg', quality: 0.92 });
            return Array.isArray(result) ? result[0] : result;
        },
        thumbnail: makeThumbnail,
        createURL: blob => URL.createObjectURL(blob), revokeURL: url => URL.revokeObjectURL(url)
    });
    return specialImagePool;
}
async function getSpecialImageURL(filepath, signal, kind = 'viewer') {
    const lease = await getImagePool().acquire(filepath, kind, signal);
    if (signal?.aborted) { lease.release(); throw resilience.abortError(); }
    if (signal) signal.addEventListener('abort', lease.release, { once: true });
    else lease.release();
    return lease.url;
}

async function scanDirectory(folder = currentFolder, options = {}) {
    const url = currentDirectoryUrl(folder);
    const normalized = folder.split('/').filter(Boolean).join('/');
    let directoryMtime = null;
    if (usesPublishedManifest()) {
        const indexed = await persistentDirectoryListing(normalized, options.signal);
        if (indexed) return indexed;
    }
    if (isManifestOnlySource()) {
        throw persistentManifestError('The published media index does not contain this folder.');
    }
    if (!options.bypassCache && activeSource.scanCache) {
        const manifest = getScanManifest();
        const cached = manifest.directories[normalized];
        directoryMtime = await directoryModifiedTime(url, options.signal);
        if (directoryMtime != null && cached?.mtime === directoryMtime &&
            Array.isArray(cached.files) && Array.isArray(cached.folders)) {
            cached.checked = Date.now();
            return { filePaths: cached.files.map(file => file.path), folderNames: [...cached.folders] };
        }
    }
    const html = await resilience.request(url, { cache: 'no-store', timeout: DIRECTORY_TIMEOUT, ...options });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const files = new Set();
    const folders = new Set();

    for (const link of doc.querySelectorAll('a')) {
        const entry = settingsApi.listingEntry(link.getAttribute('href'), url);
        if (!entry) continue;
        if (entry.directory) {
            folders.add(entry.name);
        } else if (isMediaFile(entry.name)) {
            files.add(entry.name);
        }
    }

    const filePaths = Array.from(files)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        .map(filename => mediaUrlFor(filename, folder));
    const folderNames = Array.from(folders)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    if (!options.bypassCache && activeSource.scanCache) {
        const manifest = getScanManifest();
        manifest.directories[normalized] = {
            path: normalized, mtime: directoryMtime, checked: Date.now(),
            files: filePaths.map(path => {
                const metadata = modifiedDateCache.get(path);
                return { path, mtime: metadata?.date ?? null, size: metadata?.size ?? null,
                    thumbnailPath: persistentThumbnailUrl(path) };
            }),
            folders: folderNames
        };
        saveScanManifest();
    }

    return { filePaths, folderNames };
}

async function scanDirectoryRecursive(folder = currentFolder, visited = new Set(), listing = null, signal, onBatch = null, options = {}) {
    // Bounded breadth-first worker pool over a shared frontier list. A worker
    // handles exactly one directory's listing, pushes any discovered
    // subfolders back onto the shared frontier, then returns and frees its
    // slot — it never blocks waiting on its own children. That matters:
    // recursively scheduling a task that itself awaits Promise.all(children)
    // onto the same bounded queue can deadlock — once SCAN_SIBLING_CONCURRENCY
    // parent tasks all occupy a slot while waiting on children, no child can
    // ever be dequeued to unblock them. This flat design has no such wait
    // chain, so it can't deadlock regardless of tree width or depth.
    const files = [];
    const failedFolders = [];
    const frontier = [];
    const pendingByTop = new Map();
    let inFlight = 0, settled = false;
    let resolveDone, rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

    const push = (path, depth, top) => {
        frontier.push({ path, depth, top });
        if (top != null) pendingByTop.set(top, (pendingByTop.get(top) || 0) + 1);
    };
    // A top-level (depth-1) subtree's onTopComplete fires once every item
    // pushed under it — itself plus every descendant — has finished, whether
    // that item succeeded, failed, or was skipped as already-visited.
    const settleTop = top => {
        if (top == null) return;
        const remaining = (pendingByTop.get(top) || 1) - 1;
        if (remaining <= 0) {
            pendingByTop.delete(top);
            try { options.onTopComplete?.(top); }
            catch (error) { fail(error); }
        }
        else pendingByTop.set(top, remaining);
    };
    const fail = error => { if (!settled) { settled = true; rejectDone(error); } };
    const finish = () => { if (!settled && !frontier.length && !inFlight) { settled = true; resolveDone(); } };

    frontier.push({ path: folder.split('/').filter(Boolean).join('/'), depth: 0, top: null, listing });

    async function run(item) {
        inFlight++;
        try {
            const normalized = item.path;
            if (signal?.aborted) throw resilience.abortError();
            if (visited.has(normalized)) return;
            visited.add(normalized);
            let dir;
            try {
                dir = item.listing || await scanDirectory(normalized, { signal, bypassCache: options.bypassCache });
            } catch (error) {
                if (signal?.aborted || error?.name === 'AbortError') throw error;
                failedFolders.push(normalized);
                return;
            }
            // Another worker may have failed while this request was settling.
            // Do not publish late results after the overall scan has rejected.
            if (settled) return;
            const { filePaths, folderNames } = dir;
            files.push(...filePaths);
            scannedFolders++; scannedFiles += filePaths.length;
            setScanProgress(`Scanning… ${scannedFolders} folders checked · ${scannedFiles} files found`);
            // onBatch can fire concurrently across workers (previously always
            // serial). Safe only because publishDiscovered (loadGallery) does
            // no `await` inside its own body — adding one there later would
            // introduce a race condition on the discovered/unpublished state.
            if (onBatch && filePaths.length) await onBatch(filePaths, normalized);
            for (const child of folderNames) {
                const childPath = normalized ? normalized + '/' + child : child;
                push(childPath, item.depth + 1, item.depth === 0 ? childPath : item.top);
            }
        } catch (error) {
            fail(error);
        } finally {
            settleTop(item.top);
            inFlight--;
            pump();
        }
    }

    function pump() {
        if (settled) return;
        while (inFlight < SCAN_SIBLING_CONCURRENCY && frontier.length) run(frontier.shift());
        finish();
    }

    pump();
    await done;
    return { files, failedFolders };
}

function compareFilenames(a, b) {
    const name = url => decodeURIComponent(url.split('/').pop());
    return name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: 'base' }) ||
        a.localeCompare(b);
}

async function sortMediaFiles(files, mode, refreshDates = false, signal) {
    if (signal?.aborted) throw resilience.abortError();
    if (mode === 'filename') return [...files].sort(compareFilenames);
    loadDateCache();
    trimDateCache();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    // Bound the entire metadata pass, rather than waiting per file indefinitely.
    const timeout = setTimeout(() => controller.abort(), 8000);
    let cursor = 0;
    const now = Date.now();
    const dates = new Map();
    try {
        const worker = async () => {
            while (cursor < files.length) {
                const file = files[cursor++];
                const cached = modifiedDateCache.get(file);
                if (!refreshDates && cached && now - cached.checked < DATE_CACHE_TTL) {
                    dates.set(file, cached.date);
                    continue;
                }
                if (controller.signal.aborted) { dates.set(file, null); continue; }
                let date = null;
                try {
                    const response = await fetch(file, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
                    const header = response.ok ? response.headers?.get('Last-Modified') : null;
                    const parsed = header ? Date.parse(header) : NaN;
                    if (Number.isFinite(parsed)) date = parsed;
                } catch (error) {
                    // No metadata (including unsupported HEAD/CORS): keep the file, sorted last.
                }
                dates.set(file, date);
                if (!controller.signal.aborted) modifiedDateCache.set(file, { date, checked: now });
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); saveDateCache(); }
    if (signal?.aborted) throw resilience.abortError();
    const missing = files.filter(file => dates.get(file) == null).length;
    $('btn-sort').title = `Sorting: ${mode === 'newest' ? 'Newest' : 'Oldest'} by file modification date. ${missing} files without dates sort last by filename. Click to change sorting.`;
    return [...files].sort((a, b) => {
        const left = dates.get(a), right = dates.get(b);
        if (left == null && right != null) return 1;
        if (left != null && right == null) return -1;
        const difference = left != null && right != null ? (left - right) * (mode === 'newest' ? -1 : 1) : 0;
        return difference || compareFilenames(a, b);
    });
}

async function cycleSort() {
    if (isScanning) return;
    const modes = ['newest', 'oldest', 'filename'];
    sortMode = modes[(modes.indexOf(sortMode) + 1) % modes.length];
    updateControlStates();
    await loadGallery();
}

function cycleGridDensity() {
    // Purely a display re-layout of already-loaded mediaFiles/subfolders — no
    // rescan, no new network requests, safe to call directly on click.
    const order = ['compact', 'comfortable', 'spacious'];
    applyGridDensity(order[(order.indexOf(gridDensity) + 1) % order.length]);
    updateControlStates();
    savePreferences();
    if (isGridViewActive) renderGridView();
}

function showScanFailures(folders) {
    const notice = $('scan-failures');
    notice.hidden = !folders.length;
    $('scan-failure-text').textContent = folders.length
        ? 'Scan incomplete. Could not read: ' + folders.join(', ') + '. Previously loaded files from these folders were retained.'
        : '';
}

function parentFolder(folder) {
    const parts = folder.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

function isMissingFolderError(error) {
    return error?.name === 'HTTPError' && (error.status === 404 || error.status === 410);
}

function handleMissingFolder(folder) {
    const parent = parentFolder(folder);
    scanSession?.abort();
    stopViewerSession(); stopGridSession(); stopSlideshow();
    mediaLoadId++;
    video.pause();
    clearMediaSource(video); clearMediaSource(img);
    mediaFiles = []; subfolders = []; currentIndex = 0;
    failedNavigation = null; warningReturnFolder = null;
    currentFolder = parent;
    missingFolderRecovery = { folder, parent };
    isGridViewActive = true;
    viewport.style.display = 'none';
    gridViewContainer.style.display = controlsEnabled ? 'flex' : 'none';
    thumbnailGrid.innerHTML = '';
    showScanFailures([]);
    $('warning-title').textContent = 'Album No Longer Available';
    $('warning-message').textContent = `The album “${folder}” was removed, renamed, or is no longer available.`;
    setScanStatus('Album no longer available', true);
    renderBreadcrumb();
    showWarning(true);
    savePreferences();
}

async function loadGallery({ preserveView = true, forceCacheClear = false, silent = false } = {}) {
    if (isScanning && silent) return;
    scanSession?.abort();
    const session = new AbortController();
    scanSession = session;
    const folder = currentFolder, mode = galleryViewMode;
    const current = () => scanSession === session && !session.signal.aborted;
    isScanning = true;
    manifestFailureNotice = false;
    scannedFolders = 0; scannedFiles = 0;
    thumbnailGrid.setAttribute('aria-busy', 'true');
    btnRefreshGrid.disabled = true; $('btn-sort').disabled = true;
    $('scan-loading').hidden = false;
    if (usesPublishedManifest()) resetPersistentManifest({ cacheBust: forceCacheClear });
    setScanStatus(usesPublishedManifest() ? 'Loading media index…' :
        (mediaFiles.length || subfolders.length ? 'Refreshing folders…' : 'Scanning folders…'));
    try {
        const listing = await scanDirectory(folder, { signal: session.signal, bypassCache: forceCacheClear });
        // Publish a bounded first batch as soon as the current directory is known.
        // Recursive discovery and final sorting continue below; viewer refreshes stay atomic.
        const progressive = mode === 'all' && isGridViewActive && !silent;
        const discovered = new Set(listing.filePaths);
        let unpublished = 0, lastPublish = 0;
        const publishDiscovered = async force => {
            // A higher batch threshold plus a minimum time gap between rebuilds
            // cuts how often renderGridView()'s full teardown-and-rebuild fires
            // during a large scan — each call currently discards and reloads
            // every already-rendered thumbnail, which is the source of visible
            // flicker on big libraries. This is a mitigation, not a fix: the
            // underlying full-rebuild-per-publish architecture is unchanged.
            // See RESILIENCE.md for the follow-up incremental-update plan.
            const now = Date.now();
            if (!progressive || !current() || (!force && (unpublished < 400 || now - lastPublish < 2000))) return;
            lastPublish = now;
            const preview = Array.from(discovered);
            mediaFiles = sortMode === 'filename' ? preview.sort(compareFilenames) : preview;
            subfolders = listing.folderNames;
            unpublished = 0;
            showWarning(false);
            renderBreadcrumb();
            renderGridView();
        };
        if (progressive && listing.filePaths.length) {
            // The virtual grid remains bounded even if the directory itself is enormous.
            mediaFiles = listing.filePaths.slice(0, 100);
            subfolders = listing.folderNames;
            showWarning(false);
            renderBreadcrumb();
            renderGridView();
        }
        // Rough determinate progress: the initial listing already tells us how
        // many top-level sibling folders exist under this album, so completion
        // of each one's subtree (success or handled failure) can drive a real
        // percentage instead of leaving the scan status text-only.
        const totalTopFolders = listing.folderNames.length;
        let completedTopFolders = 0;
        if (mode === 'all' && totalTopFolders) setScanProgressBar(0);
        else setScanProgressBar(null);
        const result = mode === 'all'
            ? await scanDirectoryRecursive(folder, new Set(), listing, session.signal, async files => {
                for (const file of files) if (!discovered.has(file)) { discovered.add(file); unpublished++; }
                await publishDiscovered(false);
            }, {
                bypassCache: forceCacheClear,
                onTopComplete: () => {
                    if (!current() || !totalTopFolders) return;
                    completedTopFolders++;
                    setScanProgressBar(Math.round((completedTopFolders / totalTopFolders) * 100));
                }
            })
            : { files: listing.filePaths, failedFolders: [] };
        if (!current()) return;
        setScanProgressBar(null);
        await publishDiscovered(true);
        // A failed descendant is unknown, not deleted. Preserve only its previous files.
        for (const file of mediaFiles) {
            if (result.failedFolders.some(path => file.startsWith(currentDirectoryUrl(path))) && !result.files.includes(file)) result.files.push(file);
        }
        const sorted = await sortMediaFiles(result.files, sortMode, forceCacheClear, session.signal);
        if (!current()) return;
        // Capture live viewer identity after awaits: the user may have advanced meanwhile.
        const viewed = mediaFiles[currentIndex];
        const wasGrid = isGridViewActive;
        const changed = JSON.stringify(sorted) !== JSON.stringify(mediaFiles) ||
            JSON.stringify(listing.folderNames) !== JSON.stringify(subfolders);
        mediaFiles = sorted; subfolders = listing.folderNames;
        const retained = viewed && mediaFiles.includes(viewed);
        currentIndex = retained ? mediaFiles.indexOf(viewed) : Math.min(currentIndex, Math.max(0, mediaFiles.length - 1));
        if (forceCacheClear) clearImageBlobCache();
        showScanFailures(result.failedFolders);
        failedNavigation = null;
        missingFolderRecovery = null;
        const empty = !result.failedFolders.length && mediaFiles.length === 0 &&
            (subfolders.length === 0 || !controlsEnabled);
        emptyFolderNotice = Boolean(empty && folder);
        $('warning-title').textContent = emptyFolderNotice ? 'Album Is Empty' : 'No Media Detected';
        $('warning-message').textContent = emptyFolderNotice
            ? 'No supported photos or videos remain in this album.'
            : (empty && isManifestOnlySource()
                ? 'The published media index contains no supported media. Regenerate and redeploy the index after adding files.'
                : 'No supported media found in the selected folder/view.');
        showWarning(empty);
        renderBreadcrumb();
        setScanStatus(result.failedFolders.length ? 'Scan incomplete — some folders unavailable' :
            `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, Boolean(result.failedFolders.length));
        if (!preserveView || (wasGrid && (changed || forceCacheClear)) || !mediaFiles.length) {
            renderGridView();
        } else if (!wasGrid && !retained) {
            enterFullScreenViewer(currentIndex);
        } else if (!wasGrid) {
            mediaIndex.textContent = `${currentIndex + 1} / ${mediaFiles.length}`;
        }
        savePreferences();
        return true;
    } catch (error) {
        if (!current() || error.name === 'AbortError') return;
        console.error('Directory scanning error:', error);
        // Recursive descendant failures are absorbed into failedFolders above.
        // Only a confirmed missing top-level/current album reaches this branch.
        if (folder && isMissingFolderError(error)) {
            handleMissingFolder(folder);
            return false;
        }
        if (isManifestOnlySource() && isPersistentManifestError(error)) {
            manifestFailureNotice = true;
            setScanStatus('Published library unavailable', true);
            showScanFailures([]);
            $('warning-title').textContent = 'Published Library Unavailable';
            $('warning-message').textContent = 'The published media index is missing, invalid, or incomplete. Regenerate and redeploy it, then choose Reload Library.';
            showWarning(true);
            return false;
        }
        setScanStatus('Scan failed — check connection and retry', true);
        showScanFailures([folder || activeSource.label]);
        $('warning-title').textContent = 'Could not scan this folder';
        $('warning-message').textContent = 'Check the connection and directory listing, then choose Scan Again.';
        if (!mediaFiles.length && !subfolders.length) showWarning(true);
        return false;
    } finally {
        if (scanSession === session) {
            isScanning = false;
            thumbnailGrid.setAttribute('aria-busy', 'false');
            btnRefreshGrid.disabled = false; $('btn-sort').disabled = false;
            $('scan-loading').hidden = true;
            setScanProgressBar(null);
        }
    }
}

function setScanStatus(text, isError = false) {
    if (scanStatus) {
        scanStatus.textContent = text;
        scanStatus.classList.toggle('is-error', isError);
    }
    $('scan-loading-text').textContent = text;
}

function setScanProgress(text) {
    $('scan-loading-text').textContent = text;
}

// Separate from setScanProgress/setScanStatus (which only ever touch text) so
// the folder/file-count text updates emitted from inside scanDirectoryRecursive
// can't accidentally clobber the bar's percentage, or vice versa.
function setScanProgressBar(percent) {
    const track = $('scan-progress-track');
    const fill = $('scan-progress-fill');
    if (!track || !fill) return;
    if (percent == null || Number.isNaN(percent)) {
        track.hidden = true;
        track.removeAttribute?.('aria-valuenow');
        return;
    }
    track.hidden = false;
    const value = Math.max(0, Math.min(100, percent));
    track.setAttribute('aria-valuenow', String(value));
    fill.style.width = value + '%';
}

function setMediaLoading(text = '') {
    $('media-loading').hidden = !text || !controlsEnabled;
    $('media-loading-text').textContent = text;
    container.setAttribute('aria-busy', String(Boolean(text)));
}

function watchThumbnail(element, item, videoThumbnail = false) {
    const session = gridSession;
    let timer;
    item.classList.add('thumb-loading');
    const finish = () => {
        clearTimeout(timer);
        if (session?.controller.signal.aborted || element.resourceActive === false) return;
        element.thumbnailSettled = true;
        item.classList.remove('thumb-loading'); element.classList.add('thumb-loaded');
    };
    element.onload = finish;
    if (videoThumbnail) element.onloadeddata = element.onloadedmetadata = finish;
    element.onerror = () => {
        if (element.generatedFallback) {
            const generatedFallback = element.generatedFallback;
            element.generatedFallback = null;
            generatedFallback().catch(() => element.onerror?.());
            return;
        }
        if (element.fallbackSrc) {
            const fallbackSrc = element.fallbackSrc;
            element.fallbackSrc = null;
            if (element.queueImageSource) element.queueImageSource(fallbackSrc);
            else { element.startDeadline(); element.src = fallbackSrc; }
            return;
        }
        finish();
        if (session?.controller.signal.aborted || element.resourceActive === false) return;
        item.classList.add('thumb-error');
        if (item.failedPreview) return;
        item.failedPreview = true;
        const fallback = document.createElement('span');
        fallback.className = 'thumbnail-unavailable'; fallback.textContent = 'Preview unavailable';
        item.appendChild(fallback);
    };
    // Native lazy images start their deadline only once in preload range.
    element.startDeadline = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { element.onerror?.(); element.src = ''; }, MEDIA_TIMEOUT);
    };
    element.cancelDeadline = () => clearTimeout(timer);
    if (videoThumbnail) element.startDeadline();
    const cleanup = () => {
        clearTimeout(timer);
        element.queueImageSource = null;
        element.thumbnailSettled = false;
        element.onload = element.onerror = element.onloadeddata = element.onloadedmetadata = null;
        element.pause?.(); clearMediaSource(element);
    };
    element.thumbnailCleanup = cleanup;
    session?.cleanups.add(cleanup);
}

function showWarning(show) {
    warningOverlay.style.display = show ? 'flex' : 'none';
    if (!show) return;
    const previous = $('btn-warning-previous');
    const root = $('btn-warning-root');
    const recovery = missingFolderRecovery;
    const manifestState = isManifestOnlySource();
    const confirmedAlbumState = Boolean(recovery || emptyFolderNotice || manifestFailureNotice || manifestState);
    previous.textContent = recovery ? 'Parent folder' : 'Previous location';
    previous.hidden = recovery ? !recovery.parent : warningReturnFolder === null || warningReturnFolder === currentFolder;
    root.hidden = recovery ? false : !currentFolder;
    btnRetryWarning.hidden = Boolean(recovery);
    btnRetryWarning.textContent = manifestState ? 'Reload Library' : 'Scan Again';
    $('warning-source-summary').hidden = confirmedAlbumState;
    $('warning-server-help').hidden = confirmedAlbumState;
    $('warning-offline-note').hidden = confirmedAlbumState;
    $('warning-open-source').hidden = confirmedAlbumState;
    $('warning-open-source').href = activeSource.url;
}
function isPhotoActive() { return mediaFiles[currentIndex] ? isImageFile(mediaFiles[currentIndex]) && !reclassifiedVideoActive : false; }

function renderBreadcrumb() {
    breadcrumb.innerHTML = '';
    $('source-root-label').textContent = activeSource.label;

    const parts = currentFolder.split('/').filter(Boolean);
    $('breadcrumb-root-separator').hidden = parts.length === 0;
    $('gallery-path-bar').hidden = parts.length === 0;
    let running = '';
    const ancestors = parts.slice(0, -1);
    $('current-path-separator').hidden = ancestors.length === 0;
    if (ancestors.length > 1) {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'crumb-ellipsis';
        ellipsis.textContent = '…';
        ellipsis.setAttribute('aria-hidden', 'true');
        breadcrumb.appendChild(ellipsis);
    }
    ancestors.forEach((part, index) => {
        const sep = document.createElement('span');
        sep.className = `crumb-separator${index < ancestors.length - 1 ? ' crumb-middle' : ''}`;
        sep.textContent = '›';
        if (index > 0) breadcrumb.appendChild(sep);
        running = running ? `${running}/${part}` : part;
        const target = running;
        const crumb = document.createElement('button');
        crumb.className = `crumb${index < ancestors.length - 1 ? ' crumb-middle' : ' crumb-tail'}`;
        crumb.textContent = part;
        crumb.addEventListener('click', () => navigateToFolder(target));
        breadcrumb.appendChild(crumb);
    });
    if (galleryViewMode === 'all') {
        gridPath.textContent = currentFolder ? parts[parts.length - 1] : 'All media';
    } else {
        gridPath.textContent = parts[parts.length - 1] || 'Sorted by folder';
    }
    gridPath.title = currentFolder || activeSource.label;
    gridPath.setAttribute('aria-current', currentFolder ? 'location' : 'false');
    updateGalleryHeaderLayout();
}

async function navigateToFolder(folder, { historyMode = 'push' } = {}) {
    scanSession?.abort();
    stopViewerSession(); stopGridSession();
    missingFolderRecovery = null;
    emptyFolderNotice = false;
    btnRetryWarning.hidden = false;
    const previousFolder = currentFolder;
    warningReturnFolder = previousFolder;
    gridReturn = null;
    currentFolder = folder;
    gridViewContainer.scrollTop = 0;
    currentIndex = 0;
    isGridViewActive = true;
    stopSlideshow();
    const succeeded = await loadGallery({ preserveView: false });
    if (succeeded === false && currentFolder === folder) {
        failedNavigation = folder;
        currentFolder = previousFolder;
        renderBreadcrumb(); renderGridView();
        if (historyMode === 'none') updateFolderHistory(previousFolder, 'replace');
        return false;
    }
    if (succeeded !== false && historyMode !== 'none' && folder !== previousFolder) {
        updateFolderHistory(folder, historyMode);
    }
    return succeeded !== false;
}

function renderGridView() {
    setViewerOptionsOpen(false);
    setGridOptionsOpen(false);
    stopViewerSession();
    const session = startGridSession();
    const returnPosition = !isGridViewActive && gridReturn &&
        gridReturn.folder === currentFolder && gridReturn.view === galleryViewMode ? gridReturn : null;
    let returnTile = null;
    setMediaLoading();
    if (!controlsEnabled) {
        gridViewContainer.style.display = 'none';
        if (mediaFiles.length) enterFullScreenViewer(currentIndex);
        else {
            mediaLoadId++;
            stopSlideshow();
            video.pause();
            viewport.style.display = 'none';
        }
        return;
    }
    mediaLoadId++;
    mediaFailed = false;
    videoErrorOverlay.style.display = 'none';
    isGridViewActive = true;
    thumbnailGrid.innerHTML = '';
    const total = mediaFiles.length;
    const albums = galleryViewMode === 'folders' ? subfolders.length : 0;
    gridCount.textContent = galleryViewMode === 'all'
        ? `${total} File${total === 1 ? '' : 's'} • All Folders`
        : `${albums ? `${albums} Album${albums === 1 ? '' : 's'} • ` : ''}${total} File${total === 1 ? '' : 's'}`;

    // Album cards first when browsing by folder.
    const observeAlbum = galleryViewMode === 'folders' ? startAlbumPreviews() : null;
    if (galleryViewMode === 'folders') subfolders.forEach(folder => {
        const item = document.createElement('button');
        item.className = 'grid-item album-card';
        item.type = 'button';
        const albumFolder = currentFolder ? `${currentFolder}/${folder}` : folder;
        item.dataset.albumFolder = albumFolder;
        item.setAttribute('aria-label', `Open album ${folder}`);
        item.innerHTML = `
            <div class="album-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="54" height="54"><path fill="currentColor" d="M10 4H2c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h20c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-10l-2-2z"/></svg>
            </div>
            <div class="album-name">${escapeHtml(folder)}</div>
            <div class="album-subtitle">Open album</div>`;
        item.addEventListener('click', () => navigateToFolder(albumFolder));
        thumbnailGrid.appendChild(item);
        observeAlbum(item);
    });

    const observed = new Map();
    const updateThumbnail = (el, visible) => {
        const state = observed.get(el);
        if (!state) return;
        if (!visible) {
            if (!state.heic && !el.thumbnailSettled && state.controller) {
                el.resourceActive = false;
                el.cancelDeadline();
                state.controller.abort(); state.controller = null;
                clearMediaSource(el);
                el.classList.remove('thumb-loaded');
            }
            if (state.heic) {
                el.resourceActive = false;
                el.cancelDeadline();
                clearMediaSource(el); state.controller?.abort(); state.controller = null;
                el.classList.remove('thumb-loaded');
                state.video?.thumbnailCleanup?.();
                if (state.video) session.cleanups.delete(state.video.thumbnailCleanup);
                state.video?.remove(); state.video = null;
                if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
                state.objectUrl = null; el.style.display = '';
            }
            return;
        }
        if (state.controller) return;
        el.resourceActive = true;
        const owner = new AbortController();
        state.controller = owner;
        el.thumbnailSettled = false;
        el.queueImageSource = source => queueNativeImageSource(el, source, owner.signal, {
            priority: NATIVE_IMAGE_PRIORITY.grid,
            onStart: el.startDeadline
        });
        if (state.heic) {
            const useSpecialImage = () => getSpecialImageURL(state.file, owner.signal, 'thumbnail').then(url => {
                if (!owner.signal.aborted) el.queueImageSource(url);
            }).catch(error => {
                if (owner.signal.aborted || error.name === 'AbortError') return;
                if (!isQuickTimeReclassification(error)) throw error;
                const objectUrl = URL.createObjectURL(new Blob([error.data], { type: 'video/quicktime' }));
                const vid = document.createElement('video');
                state.objectUrl = objectUrl; state.video = vid;
                watchThumbnail(vid, state.item, true);
                vid.preload = 'metadata'; vid.disablePictureInPicture = true;
                vid.muted = true; vid.playsInline = true;
                el.style.display = 'none';
                state.item.insertBefore(vid, el);
                state.item.mediaElement = vid;
                if (!state.item.querySelector('.video-badge')) {
                    const badge = document.createElement('div');
                    badge.className = 'video-badge';
                    badge.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
                    state.item.appendChild(badge);
                }
                vid.src = objectUrl;
            });
            const generated = persistentThumbnailUrl(state.file);
            if (generated) {
                el.generatedFallback = useSpecialImage;
                el.queueImageSource(generated);
            } else useSpecialImage().catch(() => el.onerror?.());
        } else {
            const generated = persistentThumbnailUrl(state.file);
            el.fallbackSrc = generated ? state.file : null;
            el.queueImageSource(generated || state.file);
        }
    };
    if ('IntersectionObserver' in window) session.observer = new IntersectionObserver(entries => {
        if (session.controller.signal.aborted) return;
        entries.forEach(entry => updateThumbnail(entry.target, entry.isIntersecting));
    }, { root: gridViewContainer, rootMargin: '300px' });
    const observeImage = (el, file, heic = false, item = null) => {
        const state = { file, heic, item, controller: null, video: null, objectUrl: null, cleanup: null };
        state.cleanup = () => {
            state.controller?.abort(); state.video?.thumbnailCleanup?.();
            if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
        };
        observed.set(el, state);
        session.cleanups.add(state.cleanup);
        if (session.observer) session.observer.observe(el);
        else updateThumbnail(el, true);
    };

    const createMediaTile = index => {
        const file = mediaFiles[index];
        const filename = decodeURIComponent(file.split('/').pop());
        const item = document.createElement('button');
        item.className = 'grid-item media-tile';
        item.type = 'button';
        item.dataset.mediaIndex = String(index);
        item.setAttribute('aria-label', `Open ${filename}`);
        if (returnPosition?.file === file) returnTile = item;

        if (isVideoFile(file)) {
            const vid = document.createElement('video');
            watchThumbnail(vid, item, true);
            vid.src = file;
            vid.preload = 'metadata';
            vid.disablePictureInPicture = true;
            vid.muted = true;
            vid.playsInline = true;
            item.mediaElement = vid;
            item.appendChild(vid);
            const badge = document.createElement('div');
            badge.className = 'video-badge';
            badge.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
            item.appendChild(badge);
        } else if (isHeicFile(file)) {
            const imgEl = document.createElement('img');
            watchThumbnail(imgEl, item);
            imgEl.alt = filename;
            imgEl.draggable = false;
            imgEl.decoding = 'async';
            imgEl.dataset.heicSrc = file;
            imgEl.className = 'heic-thumb';
            observeImage(imgEl, file, true, item);
            item.mediaElement = imgEl;
            item.appendChild(imgEl);
            const fallback = document.createElement('div');
            fallback.className = 'heic-fallback';
            fallback.textContent = 'HEIC';
            item.appendChild(fallback);
        } else {
            const imgEl = document.createElement('img');
            watchThumbnail(imgEl, item);
            observeImage(imgEl, file, false, item);
            imgEl.alt = filename;
            imgEl.draggable = false;
            imgEl.loading = 'lazy';
            imgEl.decoding = 'async';
            item.mediaElement = imgEl;
            item.appendChild(imgEl);
        }

        const caption = document.createElement('div');
        caption.className = 'grid-item-caption';
        if (galleryViewMode === 'all') {
            let relative = settingsApi.relativeMediaPath(activeSource, file);
            if (currentFolder) {
                const prefix = `${currentFolder}/`;
                if (relative.startsWith(prefix)) relative = relative.slice(prefix.length);
            }
            caption.textContent = relative;
        } else {
            caption.textContent = filename;
        }
        item.appendChild(caption);
        item.addEventListener('click', () => enterFullScreenViewer(index));
        return item;
    };

    const virtualized = mediaFiles.length > GRID_BATCH_SIZE;
    const virtualWindow = document.createElement('div');
    virtualWindow.className = 'virtual-window';
    let topSpacer = null, bottomSpacer = null;
    if (virtualized) {
        topSpacer = document.createElement('div');
        topSpacer.className = 'virtual-spacer';
        topSpacer.setAttribute('aria-hidden', 'true');
        bottomSpacer = document.createElement('div');
        bottomSpacer.className = 'virtual-spacer';
        bottomSpacer.setAttribute('aria-hidden', 'true');
        thumbnailGrid.appendChild(topSpacer);
    }
    thumbnailGrid.appendChild(virtualWindow);
    if (virtualized) thumbnailGrid.appendChild(bottomSpacer);
    const renderedTiles = new Map();
    let renderedStart = 0, renderedEnd = 0;
    const runCleanup = cleanup => {
        if (!cleanup) return;
        session.cleanups.delete(cleanup);
        cleanup();
    };
    const releaseTile = (index, item) => {
        const element = item.mediaElement;
        if (element) {
            const state = observed.get(element);
            session.observer?.unobserve?.(element);
            runCleanup(state?.cleanup);
            runCleanup(element.thumbnailCleanup);
            observed.delete(element);
            element.resourceActive = false;
        }
        if (document.activeElement?.closest?.('.media-tile') === item) item.blur?.();
        item.remove();
        renderedTiles.delete(index);
    };
    const createRange = (start, end) => {
        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index++) {
            const item = createMediaTile(index);
            renderedTiles.set(index, item);
            fragment.appendChild(item);
        }
        return fragment;
    };
    // These two scale factors (0.778, 0.667) are the single source of truth
    // shared with styles.css's max-width:900px / max-width:560px breakpoints —
    // change one, change the other, or the CSS grid and this virtualizer's
    // spacer/row-height math will silently disagree on column count.
    const gridMetrics = () => {
        const width = thumbnailGrid.clientWidth || gridViewContainer.clientWidth || 1200;
        const scale = width <= 560 ? 0.667 : width <= 900 ? 0.778 : 1;
        // This is the same fractional minimum used by the CSS minmax() rule,
        // keeping virtual spacer rows aligned with the rendered column count.
        const min = gridTileMinPx * scale;
        const gap = width <= 900 ? 12 : 18;
        const columns = Math.max(1, Math.floor((width + gap) / (min + gap)));
        const card = Math.max(min, (width - gap * (columns - 1)) / columns);
        return { columns, rowHeight: card + gap };
    };
    const estimateSpacerHeight = count => {
        if (!count) return 0;
        const { columns, rowHeight } = gridMetrics();
        return Math.ceil(count / columns) * rowHeight;
    };
    const renderMediaWindow = (start, end) => {
        const preservedScrollTop = gridViewContainer.scrollTop;
        if (virtualized) {
            topSpacer.hidden = !start;
            topSpacer.style.height = start ? estimateSpacerHeight(start) + 'px' : '0px';
            bottomSpacer.hidden = end >= mediaFiles.length;
            bottomSpacer.style.height = end < mediaFiles.length
                ? estimateSpacerHeight(mediaFiles.length - end) + 'px'
                : '0px';
        }
        const overlaps = renderedTiles.size && start < renderedEnd && end > renderedStart;
        if (!overlaps) {
            for (const [index, item] of [...renderedTiles]) releaseTile(index, item);
            virtualWindow.replaceChildren(createRange(start, end));
        } else {
            for (const [index, item] of [...renderedTiles]) {
                if (index < start || index >= end) releaseTile(index, item);
            }
            if (start < renderedStart) {
                const prependEnd = Math.min(renderedStart, end);
                virtualWindow.insertBefore(createRange(start, prependEnd), virtualWindow.firstChild);
            }
            if (end > renderedEnd) {
                const appendStart = Math.max(renderedEnd, start);
                virtualWindow.appendChild(createRange(appendStart, end));
            }
        }
        gridViewContainer.scrollTop = preservedScrollTop;
        renderedStart = start;
        renderedEnd = end;
        gridVirtualizer.start = start;
        gridVirtualizer.end = end;
    };
    const targetIndex = returnPosition?.file ? mediaFiles.indexOf(returnPosition.file) : -1;
    const initialStart = targetIndex >= 0
        ? Math.max(0, Math.floor(targetIndex / GRID_BATCH_SIZE) * GRID_BATCH_SIZE - GRID_BATCH_SIZE)
        : 0;
    gridVirtualizer = {
        start: initialStart,
        end: Math.min(mediaFiles.length, initialStart +
            (virtualized ? (targetIndex >= 0 ? GRID_WINDOW_SIZE : GRID_BATCH_SIZE) : mediaFiles.length)),
        jumpToStart() {
            document.activeElement?.closest?.('.grid-item')?.blur?.();
            if (virtualized) renderMediaWindow(0, Math.min(mediaFiles.length, GRID_BATCH_SIZE));
            gridViewContainer.scrollTop = 0;
        },
        jumpToEnd() {
            document.activeElement?.closest?.('.grid-item')?.blur?.();
            if (virtualized) {
                const start = Math.max(0, mediaFiles.length - GRID_WINDOW_SIZE);
                renderMediaWindow(start, mediaFiles.length);
            }
            // Read scrollHeight after replacing the window so one keypress lands
            // at the final geometry instead of relying on scroll anchoring.
            gridViewContainer.scrollTop = gridViewContainer.scrollHeight;
        },
        update() {
            if (!virtualized || !isGridViewActive || session.controller.signal.aborted) return;
            const { columns, rowHeight } = gridMetrics();
            const localTop = Math.max(0, gridViewContainer.scrollTop - (thumbnailGrid.offsetTop || 0));
            const firstVisible = Math.min(mediaFiles.length - 1,
                Math.max(0, Math.floor(localTop / rowHeight) * columns));
            const edgeBuffer = Math.floor(GRID_BATCH_SIZE / 2);
            if (firstVisible >= this.start + edgeBuffer && firstVisible < this.end - edgeBuffer) return;
            let start = Math.max(0,
                Math.floor(firstVisible / GRID_BATCH_SIZE) * GRID_BATCH_SIZE - GRID_BATCH_SIZE);
            start = Math.min(start, Math.max(0, mediaFiles.length - GRID_WINDOW_SIZE));
            const end = Math.min(mediaFiles.length, start + GRID_WINDOW_SIZE);
            if (start !== this.start || end !== this.end) renderMediaWindow(start, end);
        }
    };
    renderMediaWindow(gridVirtualizer.start, gridVirtualizer.end);

    gridViewContainer.style.display = 'flex';
    if (returnPosition) {
        gridViewContainer.scrollTop = returnPosition.scrollTop;
        if (returnTile) {
            const tileRect = returnTile.getBoundingClientRect?.();
            const gridRect = gridViewContainer.getBoundingClientRect?.();
            if (tileRect && gridRect && (tileRect.top < gridRect.top || tileRect.bottom > gridRect.bottom)) {
                returnTile.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            }
            returnTile.focus?.({ preventScroll: true });
            returnTile.classList.add('returned-tile');
            setTimeout(() => returnTile.classList.remove('returned-tile'), 1800);
        }
        gridReturn = null;
    }
    viewport.style.display = 'none';
    $('overlay-header').style.display = 'none';
    navLeft.style.display = 'none';
    navRight.style.display = 'none';
    progressContainer.style.display = 'none';
    helpHint.style.display = 'none';
    video.pause();
    cancelSlideshowTimer();
    savePreferences();
}

function enterFullScreenViewer(index) {
    if (!mediaFiles.length) return;
    const openingViewer = isGridViewActive;
    if (openingViewer) stopGridSession();
    if (openingViewer && mediaFiles[index]) gridReturn = {
        folder: currentFolder, view: galleryViewMode,
        file: mediaFiles[index], scrollTop: gridViewContainer.scrollTop || 0
    };
    isGridViewActive = false;
    gridViewContainer.style.display = 'none';
    viewport.style.display = 'flex';
    $('overlay-header').style.display = 'flex';
    navLeft.style.display = 'flex';
    navRight.style.display = 'flex';
    progressContainer.style.display = 'block';
    helpHint.style.display = 'block';
    showMedia(index);
    if (openingViewer) showUI();
}

function showMedia(index) {
    if (!mediaFiles.length) return;
    stopViewerSession();
    const session = { controller: new AbortController(), timer: null, progress: 0 };
    viewerSession = session;
    const loadId = ++mediaLoadId;
    const isCurrent = () => loadId === mediaLoadId && !isGridViewActive && !session.controller.signal.aborted;
    const clearWatchdog = () => { clearTimeout(session.timer); session.timer = null; };
    const watch = () => {
        if (session.timer) return;
        session.timer = setTimeout(() => {
            if (isCurrent() && !mediaFailed) showMediaError('timeout', mediaFiles[currentIndex], resilience.timeoutError('Media loading stalled'));
        }, MEDIA_TIMEOUT);
    };
    mediaFailed = false;
    imageReady = false;
    reclassifiedVideoActive = false;
    cancelSlideshowTimer();
    currentIndex = (index + mediaFiles.length) % mediaFiles.length;
    const filepath = mediaFiles[currentIndex];
    const filename = decodeURIComponent(filepath.split('/').pop());
    const displayName = galleryViewMode === 'all'
        ? settingsApi.relativeMediaPath(activeSource, filepath)
        : filename;

    imageRotation = 0;
    resetZoomAndPan();
    applyImageRotation();
    setMediaLoading(isHeicFile(filepath) ? 'Preparing HEIC image…' : isImageFile(filepath) ? 'Loading image…' : 'Loading video…');
    videoErrorOverlay.style.display = 'none';
    img.onload = null; img.onerror = null; img.style.display = 'none'; img.src = '';
    video.onended = null; video.ontimeupdate = null; video.onerror = null;
    video.onwaiting = null; video.onstalled = null; video.oncanplay = null; video.onplaying = null;
    video.style.display = 'none'; video.pause(); video.src = '';
    mediaTitle.textContent = displayName;
    img.alt = filename;
    mediaIndex.textContent = `${currentIndex + 1} / ${mediaFiles.length}`;
    updateMediaActions(filepath, filename);

    const playVideoSource = (source, livePhoto = false, objectUrl = null) => {
        if (!isCurrent()) { if (objectUrl) URL.revokeObjectURL(objectUrl); return; }
        clearWatchdog();
        img.onload = null; img.onerror = null; img.src = ''; img.style.display = 'none';
        container.classList.remove('grab-mode');
        reclassifiedVideoActive = livePhoto;
        if (livePhoto) {
            mediaTitle.textContent = `${displayName} (Live Photo motion)`;
            updateMediaActions(filepath, filename, true);
        }
        if (objectUrl) session.controller.signal.addEventListener('abort', () => URL.revokeObjectURL(objectUrl), { once: true });
        watch();
        video.src = source;
        video.style.display = 'block';
        video.controls = controlsEnabled && !tvModeEnabled;
        video.muted = !controlsEnabled;
        video.onwaiting = video.onstalled = () => { if (isCurrent() && !mediaFailed && !video.paused) { setMediaLoading('Buffering video…'); watch(); } };
        video.onpause = clearWatchdog;
        video.oncanplay = video.onplaying = () => { if (isCurrent() && !mediaFailed) { clearWatchdog(); setMediaLoading(); } };
        video.onerror = () => { if (isCurrent()) showMediaError(livePhoto ? 'live-photo' : 'video', filepath, video.error); };
        video.play().catch(err => {
            if (isCurrent() && !mediaFailed && err.name !== 'AbortError') showMediaError(livePhoto ? 'live-photo' : 'video', filepath, err);
        });
        video.onended = () => { if (isCurrent() && slideshowPlaying) nextSlideshowMedia(); };
        video.ontimeupdate = () => {
            if (!isCurrent()) return;
            if (video.currentTime !== session.progress) { session.progress = video.currentTime; clearWatchdog(); if (!video.paused) watch(); }
            if (slideshowPlaying && video.duration) progressBar.style.width = `${(video.currentTime / video.duration) * 100}%`;
        };
        cancelSlideshowTimer();
        progressBar.style.width = '0%';
    };

    if (isImageFile(filepath)) {
        img.classList.remove('mode-fit', 'mode-original');
        img.classList.add(imageMode === 'fit' ? 'mode-fit' : 'mode-original');
        container.classList.add('grab-mode');
        img.onload = () => {
            if (!isCurrent() || mediaFailed) return;
            clearWatchdog();
            imageReady = true;
            btnRotate.disabled = false;
            const clipboardAvailable = window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined';
            btnCopyLink.disabled = !showCopyButton || !clipboardAvailable;
            btnCopyLink.title = clipboardAvailable ? 'Copy displayed image' : 'Copy Image requires HTTPS or a trusted local context';
            setMediaLoading();
            img.style.display = 'block'; mediaTitle.textContent = displayName;
            applyImageRotation();
            if (slideshowPlaying) startSlideshowTimer();
        };
        img.onerror = async () => {
            if (!isCurrent()) return;
            const sniffed = await sniffContainer(filepath, session.controller.signal).catch(error => {
                if (error.name !== 'AbortError') console.warn('FolderFrame: media sniff failed.', filepath, error);
                return null;
            });
            if (!isCurrent()) return;
            if (sniffed?.container === 'quicktime') playVideoSource(filepath, true);
            else showMediaError('image', filepath);
        };

        if (isHeicFile(filepath)) {
            mediaTitle.textContent = `${displayName} (Preparing…)`;
            getSpecialImageURL(filepath, session.controller.signal)
                .then(url => {
                    if (isCurrent()) queueNativeImageSource(img, url, session.controller.signal, {
                        priority: NATIVE_IMAGE_PRIORITY.viewer, onStart: watch
                    });
                })
                .catch(err => {
                    if (!isCurrent() || err.name === 'AbortError') return;
                    if (isQuickTimeReclassification(err)) {
                        const objectUrl = URL.createObjectURL(new Blob([err.data], { type: 'video/quicktime' }));
                        playVideoSource(objectUrl, true, objectUrl);
                        return;
                    }
                    console.error('HEIC/HEIF image handling failed:', err);
                    if (isCurrent()) showMediaError('heic', filepath, err);
                });
        } else {
            queueNativeImageSource(img, filepath, session.controller.signal, {
                priority: NATIVE_IMAGE_PRIORITY.viewer, onStart: watch
            });
        }
    } else {
        playVideoSource(filepath);
    }
    savePreferences();
}

function showMediaError(kind, filepath, error) {
    stopViewerSession();
    img.onload = null; img.onerror = null; img.src = '';
    video.onerror = null; video.onwaiting = null; video.onstalled = null;
    video.pause(); video.src = '';
    setMediaLoading();
    mediaFailed = true;
    cancelSlideshowTimer();
    progressBar.style.width = '0%';
    img.style.display = 'none';
    video.pause();
    video.style.display = 'none';
    let title = 'This image could not be opened';
    let message = 'The file may be unavailable, damaged, or in a format this browser cannot display.';
    let guidance = 'Retry after checking your connection, or open the original file to check it. Exporting a new JPEG or PNG copy may help.';
    if (kind === 'live-photo') {
        title = 'This Apple Live Photo motion clip could not be played';
        message = 'This file is QuickTime / HEVC video even though its filename looks like an image. This browser may not support its HEVC codec.';
        guidance = 'Open the original in an Apple-compatible player, or view the matching still image if it is present. Your original file is unchanged.';
    } else if (kind === 'heic' || (isHeicFile(filepath) && kind !== 'video')) {
        title = 'This HEIC / HEIF image could not be opened';
        message = 'FolderFrame could not prepare this image for your browser. The file may use an unsupported HEIC variant or be damaged.';
        guidance = 'Try opening the original in your photo app and exporting a JPEG or PNG copy. Your original file is unchanged.';
        if (error?.message === 'HEIC decoder library did not load') {
            message = 'The HEIC decoder is unavailable.';
            guidance = 'Reload the page. If this continues, check that heic2any.min.js is hosted beside index.html and is not blocked.';
        } else if (/HTTP|fetch|network/i.test(error?.message || '')) {
            message = 'The image could not be downloaded.';
            guidance = 'Check your connection and that the file is still available, then retry.';
        }
    } else if (kind === 'video') {
        title = 'This video could not be played';
        message = 'The video format may be unsupported or the file may be unavailable.';
        guidance = 'Open the original in a video player to check it. For broader browser compatibility, export an MP4 copy using H.264 video and AAC audio.';
        if (error?.name === 'NotAllowedError') {
            title = 'Your browser paused video playback';
            message = 'Automatic playback was blocked. This does not mean the video is broken.';
            guidance = 'Choose Retry to start playback with a click. Embedded pages may also need permission to autoplay.';
        } else if (error?.code === 2) {
            message = 'The video download was interrupted by a network error.';
            guidance = 'Check your connection and that the file is still available, then retry.';
        } else if (error?.code === 1) {
            message = 'Video loading was interrupted.';
            guidance = 'Choose Retry to load the video again.';
        } else if (error?.code === 3) {
            message = 'The browser could not decode the video. Its codec may be unsupported, or the file may be damaged.';
        }
    }
    if (error?.name === 'TimeoutError') {
        title = 'Media took too long to load';
        message = error.message;
        guidance = 'Check your connection and retry. If HEIC processing remains stalled, reload the page. Other supported media can still play.';
    }
    $('media-error-title').textContent = title;
    $('media-error-filename').textContent = decodeURIComponent(filepath.split('/').pop());
    videoErrorText.textContent = message;
    videoErrorFfmpeg.textContent = guidance;
    $('media-error-original').href = filepath;
    $('btn-next-media-error').disabled = mediaFiles.length < 2;
    mediaTitle.textContent = decodeURIComponent(filepath.split('/').pop());
    videoErrorOverlay.style.display = 'flex';
    scheduleErrorAdvance();
    if (!slideshowPlaying) showUI();
}

function scheduleErrorAdvance() {
    cancelSlideshowTimer();
    $('media-error-status').textContent = slideshowPlaying
        ? (mediaFiles.length > 1 ? 'Slideshow continues: skipping this file in 3 seconds.' : 'Slideshow continues: retrying this file in 3 seconds.')
        : 'Choose Retry or another file. Press Play to continue the slideshow.';
    if (!slideshowPlaying || !mediaFailed || isGridViewActive) return;
    const loadId = mediaLoadId;
    slideshowTimer = setTimeout(() => {
        slideshowTimer = null;
        if (slideshowPlaying && mediaFailed && !isGridViewActive && loadId === mediaLoadId) nextSlideshowMedia();
    }, 3000);
}

function nextMedia() { showMedia(currentIndex + 1); }
function prevMedia() { showMedia(currentIndex - 1); }
function nextSlideshowMedia() {
    if (!shuffleEnabled || mediaFiles.length <= 1) return nextMedia();
    let next = currentIndex;
    while (next === currentIndex) next = Math.floor(Math.random() * mediaFiles.length);
    showMedia(next);
}

function applyTransform() {
    container.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    const changed = zoom !== 1.0 || panX !== 0 || panY !== 0;
    btnResetZoom.disabled = !changed;
    container.classList.toggle('grabbing-mode', changed);
}
function resetZoomAndPan() { cancelTouchGesture(); zoom = 1.0; panX = 0; panY = 0; applyTransform(); }
function applyImageRotation() {
    let fitScale = 1;
    if (imageRotation % 180 && imageMode === 'fit' && img.clientWidth && img.clientHeight && viewport.clientWidth && viewport.clientHeight) {
        fitScale = Math.min(1, viewport.clientWidth / img.clientHeight, viewport.clientHeight / img.clientWidth);
    }
    img.style.transform = `rotate(${imageRotation}deg) scale(${fitScale})`;
    img.style.transformOrigin = 'center center';
    btnRotate.setAttribute('aria-label', `Rotate photo clockwise. Current rotation: ${imageRotation} degrees`);
    btnRotate.title = `Rotate photo 90° clockwise (currently ${imageRotation}°)`;
}
function rotateImage() {
    if (!isPhotoActive() || mediaFailed) return;
    imageRotation = (imageRotation + 90) % 360;
    resetZoomAndPan();
    applyImageRotation();
}

function toggleImageMode() {
    imageMode = imageMode === 'fit' ? 'original' : 'fit';
    updateControlStates();
    if (isPhotoActive()) {
        img.classList.remove('mode-fit', 'mode-original');
        img.classList.add(imageMode === 'fit' ? 'mode-fit' : 'mode-original');
        resetZoomAndPan();
        applyImageRotation();
    }
    savePreferences();
}

function handleWheel(e) {
    if (!controlsEnabled) return;
    if (mediaFailed) return;
    if (!isPhotoActive()) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;
    const prevZoom = zoom;
    const minZoom = imageMode === 'original' ? 0.1 : 1.0;
    zoom = Math.max(minZoom, Math.min(10.0, zoom * factor));
    if (zoom === 1.0 && imageMode !== 'original') { panX = 0; panY = 0; }
    else {
        panX = mouseX - (mouseX - panX) * (zoom / prevZoom);
        panY = mouseY - (mouseY - panY) * (zoom / prevZoom);
    }
    applyTransform();
}

function setupEventListeners() {
    $('btn-sort').addEventListener('click', cycleSort);
    $('btn-grid-density')?.addEventListener('click', cycleGridDensity);
    $('btn-retry-scan').addEventListener('click', () => {
        if (failedNavigation !== null) { const target = failedNavigation; failedNavigation = null; return navigateToFolder(target); }
        return loadGallery({ forceCacheClear: true });
    });
    $('btn-gallery-home').addEventListener('click', () => navigateToFolder(''));
    $('select-source').addEventListener('change', event => {
        const url = new URL(location.href);
        url.searchParams.set('source', event.target.value);
        url.searchParams.set('album', '');
        // A new load prevents old scans, media callbacks, and timers leaking
        // into the next source. Other explicit URL options are preserved.
        location.assign(url.href);
    });
    btnShowGrid.addEventListener('click', renderGridView);
    btnRefreshGrid.addEventListener('click', () => loadGallery({ preserveView: true, forceCacheClear: true }));
    btnShuffle.addEventListener('click', () => { shuffleEnabled = !shuffleEnabled; updateControlStates(); savePreferences(); });
    btnAutoRefresh.addEventListener('click', () => { autoRefreshEnabled = !autoRefreshEnabled; updateControlStates(); startAutoRefreshTimer(); savePreferences(); });
    btnViewMode.addEventListener('click', async () => {
        scanSession?.abort();
        galleryViewMode = galleryViewMode === 'all' ? 'folders' : 'all';
        currentIndex = 0;
        stopSlideshow();
        updateControlStates();
        await loadGallery({ preserveView: false });
        savePreferences();
    });
    btnTvMode.addEventListener('click', toggleTvMode);
    navLeft.addEventListener('click', prevMedia);
    navRight.addEventListener('click', nextMedia);
    btnRotate.addEventListener('click', rotateImage);
    btnResetZoom.addEventListener('click', resetZoomAndPan);
    btnImageMode.addEventListener('click', toggleImageMode);
    btnCopyLink.addEventListener('click', copyCurrentImage);
    btnViewerOptions.addEventListener('click', () => setViewerOptionsOpen(viewerOptionsMenu.hidden));
    btnGridOptions.addEventListener('click', () => setGridOptionsOpen(gridOptionsMenu.hidden));
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    viewport.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    viewport.addEventListener('touchstart', handleTouchStart, { passive: false });
    viewport.addEventListener('touchmove', handleTouchMove, { passive: false });
    viewport.addEventListener('touchend', handleTouchEnd);
    viewport.addEventListener('touchcancel', cancelTouchGesture);
    $('overlay-header').addEventListener('focusin', showUI);
    $('overlay-header').addEventListener('focusout', resetIdleTimer);
    btnPlayPause.addEventListener('click', toggleSlideshow);
    selectInterval.addEventListener('change', e => {
        slideshowInterval = Number(e.target.value);
        if (slideshowPlaying && isPhotoActive()) startSlideshowTimer();
        savePreferences();
    });
    btnFullscreen.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    btnRetryWarning.addEventListener('click', () => loadGallery({ preserveView: false, forceCacheClear: true }));
    $('btn-warning-previous').addEventListener('click', () => {
        const target = missingFolderRecovery ? missingFolderRecovery.parent : warningReturnFolder;
        if (target !== null) return navigateToFolder(target);
    });
    $('btn-warning-root').addEventListener('click', () => navigateToFolder(''));
    btnCloseVideoError.addEventListener('click', renderGridView);
    $('btn-retry-media-error').addEventListener('click', () => {
        removeCacheEntry(mediaFiles[currentIndex]);
        showMedia(currentIndex);
    });
    $('btn-next-media-error').addEventListener('click', nextMedia);

    window.addEventListener('keydown', e => {
        if (!controlsEnabled) return;
        if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.target?.isContentEditable || e.target?.closest?.('a, select, input, textarea, video, [contenteditable]:not([contenteditable="false"])')) return;
        if (isGridViewActive) {
            if (e.key === 'Escape' && !gridOptionsMenu.hidden) {
                e.preventDefault();
                setGridOptionsOpen(false);
                return;
            }
            const direction = { ArrowUp: -48, ArrowDown: 48, PageUp: -0.85, PageDown: 0.85 };
            if (!['Home', 'End', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) return;
            e.preventDefault();
            if (e.key === 'Home') gridVirtualizer?.jumpToStart?.() ?? (gridViewContainer.scrollTop = 0);
            else if (e.key === 'End') gridVirtualizer?.jumpToEnd?.() ?? (gridViewContainer.scrollTop = gridViewContainer.scrollHeight);
            else {
                const value = direction[e.key];
                gridViewContainer.scrollTop = Math.max(0, Math.min(gridViewContainer.scrollHeight,
                    gridViewContainer.scrollTop + (Math.abs(value) < 1 ? value * gridViewContainer.clientHeight : value)));
            }
            $('btn-back-to-top').hidden = gridViewContainer.scrollTop < 320;
            gridVirtualizer?.update();
            return;
        }
        const key = e.key.toLowerCase();
        if (!['arrowleft', 'arrowright', ' ', 'enter', 's', 'f', 't', 'g', 'escape'].includes(key)) return;
        // Viewer shortcuts own these keys even after a toolbar/arrow button is
        // clicked. Prevent native Space/Enter activation of the focused button.
        e.preventDefault();
        if (e.repeat && key !== 'arrowleft' && key !== 'arrowright') return;
        if (e.key === 'ArrowLeft') prevMedia();
        if (e.key === 'ArrowRight') nextMedia();
        if (e.key === ' ') { e.preventDefault(); toggleSlideshow(); }
        if (e.key === 'Enter') { e.preventDefault(); toggleImageMode(); }
        if (e.key.toLowerCase() === 's') { shuffleEnabled = !shuffleEnabled; updateControlStates(); savePreferences(); }
        if (e.key.toLowerCase() === 'f') toggleFullscreen();
        if (e.key.toLowerCase() === 't') toggleTvMode();
        if (e.key === 'Escape' && !viewerOptionsMenu.hidden) setViewerOptionsOpen(false);
        else if (e.key.toLowerCase() === 'g' || e.key === 'Escape') renderGridView();
        resetIdleTimer();
    });

    window.addEventListener('mousemove', () => { if (!isGridViewActive) resetIdleTimer(); });
    window.addEventListener('resize', () => {
        updateGalleryHeaderLayout();
        if (!isGridViewActive && isPhotoActive()) applyImageRotation();
    });
    window.addEventListener('click', event => {
        if (!event.target?.closest?.('#viewer-options')) setViewerOptionsOpen(false);
        if (!event.target?.closest?.('#grid-options')) setGridOptionsOpen(false);
        if (!isGridViewActive) resetIdleTimer();
    });
    window.addEventListener('touchstart', () => { if (!isGridViewActive) resetIdleTimer(); });
    gridViewContainer.addEventListener('scroll', () => {
        $('btn-back-to-top').hidden = gridViewContainer.scrollTop < 320;
        gridVirtualizer?.update();
    }, { passive: true });
    $('btn-back-to-top').addEventListener('click', () => {
        if (gridViewContainer.scrollTo) gridViewContainer.scrollTo({ top: 0, behavior: 'smooth' });
        else gridViewContainer.scrollTop = 0;
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && autoRefreshEnabled) loadGallery({ preserveView: true, silent: true }); });
}

function startAutoRefreshTimer() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
    if (!autoRefreshEnabled) return;
    autoRefreshTimer = setInterval(() => {
        if (!document.hidden) loadGallery({ preserveView: true, silent: true });
    }, refreshInterval * 1000);
}

async function toggleTvMode() {
    tvModeEnabled = !tvModeEnabled;
    video.controls = controlsEnabled && !tvModeEnabled;
    if (tvModeEnabled) {
        imageMode = 'fit';
        shuffleEnabled = true;
        autoRefreshEnabled = true;
        updateControlStates();
        startAutoRefreshTimer();
        if (mediaFiles.length && isGridViewActive) enterFullScreenViewer(currentIndex);
        if (!slideshowPlaying) setSlideshowPlaying(true);
        try {
            if (!document.fullscreenElement) await wrapper.requestFullscreen();
        } catch (err) {
            console.info('Fullscreen was not allowed by the browser:', err);
        }
    } else {
        // Leaving TV mode should return the browser to a normal windowed,
        // paused viewer state.
        setSlideshowPlaying(false);
        video.pause();
        progressBar.style.width = '0%';

        try {
            if (document.fullscreenElement) await document.exitFullscreen();
        } catch (err) {
            console.info('Could not exit fullscreen:', err);
        }

        updateControlStates();
        showUI();
    }
    savePreferences();
}

function handleMouseDown(e) {
    if (!controlsEnabled) return;
    if (mediaFailed) return;
    if (!isPhotoActive()) return;
    if (e.button !== 0) return;
    if (zoom !== 1.0 || imageMode === 'original' || panX !== 0 || panY !== 0) {
        isDragging = true; startX = e.clientX; startY = e.clientY; startPanX = panX; startPanY = panY;
    }
}
function handleMouseMove(e) { if (isDragging) { panX = startPanX + e.clientX - startX; panY = startPanY + e.clientY - startY; applyTransform(); } }
function handleMouseUp() { isDragging = false; }

function handleTouchStart(e) {
    swipeStart = null;
    if (!controlsEnabled) return;
    if (mediaFailed) return;
    if (!isPhotoActive()) return;
    if (e.target?.closest?.('button, a, select, input, video')) return;
    resetIdleTimer();
    if (e.touches.length === 2) {
        isPinching = true; isDragging = false;
        const [t1, t2] = e.touches;
        initialDist = Math.max(1, Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY));
        const midX = (t1.clientX + t2.clientX) / 2, midY = (t1.clientY + t2.clientY) / 2;
        // Measure in the stationary viewport, never the already-transformed image.
        const rect = viewport.getBoundingClientRect();
        initialMidX = midX - rect.left - rect.width / 2;
        initialMidY = midY - rect.top - rect.height / 2;
        initialZoom = zoom; initialPanX = panX; initialPanY = panY;
    } else if (e.touches.length === 1 && (zoom !== 1.0 || imageMode === 'original' || panX !== 0 || panY !== 0)) {
        isDragging = true; isPinching = false;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY; startPanX = panX; startPanY = panY;
    } else if (e.touches.length === 1 && imageMode === 'fit' && zoom === 1 && !panX && !panY) {
        swipeStart = {
            x: e.touches[0].clientX, y: e.touches[0].clientY,
            id: e.touches[0].identifier, time: performance.now(), axis: null
        };
    }
}

function handleTouchMove(e) {
    if (!controlsEnabled) return;
    if (mediaFailed) return;
    if (!isPhotoActive()) return;
    if (isPinching && e.touches.length === 2) {
        e.preventDefault();
        const [t1, t2] = e.touches;
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const factor = dist / initialDist;
        const minZoom = imageMode === 'original' ? 0.1 : 1.0;
        zoom = Math.max(minZoom, Math.min(10.0, initialZoom * factor));
        if (zoom === 1.0 && imageMode !== 'original') { panX = 0; panY = 0; }
        else {
            panX = initialMidX - (initialMidX - initialPanX) * (zoom / initialZoom);
            panY = initialMidY - (initialMidY - initialPanY) * (zoom / initialZoom);
            const midX = (t1.clientX + t2.clientX) / 2, midY = (t1.clientY + t2.clientY) / 2;
            const rect = viewport.getBoundingClientRect();
            panX += (midX - rect.left - rect.width / 2) - initialMidX;
            panY += (midY - rect.top - rect.height / 2) - initialMidY;
        }
        applyTransform();
    } else if (isDragging && e.touches.length === 1) {
        e.preventDefault();
        panX = startPanX + e.touches[0].clientX - startX;
        panY = startPanY + e.touches[0].clientY - startY;
        applyTransform();
    } else if (swipeStart && e.touches.length === 1) {
        const touch = Array.from(e.touches).find(candidate => candidate.identifier === swipeStart.id);
        if (!touch) return;
        const dx = touch.clientX - swipeStart.x, dy = touch.clientY - swipeStart.y;
        if (!swipeStart.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) {
            if (dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.15) swipeStart.axis = 'vertical';
            else if (Math.abs(dx) > Math.abs(dy) * 1.15) swipeStart.axis = 'horizontal';
            else swipeStart.axis = 'undecided';
        } else if (swipeStart.axis === 'undecided') {
            if (dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.15) swipeStart.axis = 'vertical';
            else if (Math.abs(dx) > Math.abs(dy) * 1.15) swipeStart.axis = 'horizontal';
        }
        if (swipeStart.axis === 'vertical') {
            e.preventDefault();
            const offset = Math.max(0, dy);
            const visualOffset = offset * 0.86;
            container.classList.add('dismiss-drag');
            container.style.transform = `translateY(${visualOffset}px) scale(${1 - Math.min(0.04, offset / 5000)})`;
            container.style.opacity = String(Math.max(0.45, 1 - offset / 500));
        }
    }
}
function clearDismissVisual(snapBack = false) {
    container.classList.remove('dismiss-drag');
    container.classList.toggle('dismiss-snapback', snapBack);
    container.style.opacity = '';
    applyTransform();
    if (snapBack) setTimeout(() => container.classList.remove('dismiss-snapback'), 180);
}
function cancelTouchGesture(snapBack = false) {
    const hadDismissDrag = swipeStart?.axis === 'vertical';
    isDragging = false; isPinching = false; swipeStart = null;
    if (hadDismissDrag) clearDismissVisual(snapBack);
}
function handleTouchEnd(e) {
    if (e.touches.length === 0) {
        const start = swipeStart;
        const end = Array.from(e.changedTouches || []).find(touch => touch.identifier === start?.id);
        const eligible = controlsEnabled && !mediaFailed && !isGridViewActive && isPhotoActive() &&
            imageMode === 'fit' && zoom === 1 && !panX && !panY && !isPinching && !isDragging;
        if (start && end && eligible) {
            const dx = end.clientX - start.x, dy = end.clientY - start.y;
            const elapsed = Math.max(16, performance.now() - start.time);
            const viewportHeight = viewport.clientHeight || 600;
            const dismissDistance = Math.min(180, Math.max(100, viewportHeight * 0.22));
            const quickDismiss = elapsed >= 40 && dy >= 60 && dy / elapsed >= 0.75;
            if (start.axis === 'vertical' && dy > 0 && (dy >= dismissDistance || quickDismiss)) {
                cancelTouchGesture();
                renderGridView();
                return;
            }
            if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                if (dx < 0) nextMedia(); else prevMedia();
                resetIdleTimer();
            }
        }
        cancelTouchGesture(start?.axis === 'vertical');
        return;
    }
    if (e.touches.length === 1 && isPinching) {
        isPinching = false;
        isDragging = true;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        startPanX = panX; startPanY = panY;
    }
}

function toggleSlideshow() { setSlideshowPlaying(!slideshowPlaying); }
function setSlideshowPlaying(value) {
    slideshowPlaying = Boolean(value);
    syncPlayButton();
    if (mediaFailed) {
        scheduleErrorAdvance();
        return;
    }
    if (slideshowPlaying) {
        if (!isPhotoActive()) video.play().catch(() => {});
        else startSlideshowTimer();
    } else stopSlideshow(false);
}
function stopSlideshow(updateButton = true) {
    slideshowPlaying = false;
    cancelSlideshowTimer();
    if (!isPhotoActive()) video.pause();
    progressBar.style.width = '0%';
    if (updateButton) syncPlayButton();
}

function cancelSlideshowTimer() {
    if (slideshowTimer) {
        clearTimeout(slideshowTimer);
        slideshowTimer = null;
    }
    if (slideshowAnimationFrame) {
        cancelAnimationFrame(slideshowAnimationFrame);
        slideshowAnimationFrame = null;
    }
}

function startSlideshowTimer() {
    if (mediaFailed) { scheduleErrorAdvance(); return; }
    cancelSlideshowTimer();
    if (!imageReady || mediaFailed || isGridViewActive) return;
    slideProgress = 0;
    progressBar.style.width = '0%';

    const duration = slideshowInterval * 1000;
    slideshowStartedAt = performance.now();

    const tick = (now) => {
        if (!slideshowPlaying || !isPhotoActive()) {
            slideshowAnimationFrame = null;
            return;
        }

        const elapsed = now - slideshowStartedAt;
        const percent = Math.min(100, (elapsed / duration) * 100);
        slideProgress = percent;
        progressBar.style.width = `${percent}%`;

        if (elapsed >= duration) {
            slideshowAnimationFrame = null;
            nextSlideshowMedia();
        } else {
            slideshowAnimationFrame = requestAnimationFrame(tick);
        }
    };

    slideshowAnimationFrame = requestAnimationFrame(tick);
}

function handleFullscreenChange() {
    updateFullscreenButton();
    if (!document.fullscreenElement && tvModeEnabled) {
        tvModeEnabled = false;
        stopSlideshow();
        video.pause();
        video.controls = controlsEnabled;
        updateControlStates();
        showUI();
        savePreferences();
    }
}

function updateFullscreenButton() {
    const label = btnFullscreen.querySelector('.button-label');
    const isFullscreen = Boolean(document.fullscreenElement);
    if (label) label.textContent = isFullscreen ? 'Exit Full' : 'Full';
    btnFullscreen.setAttribute('aria-pressed', String(isFullscreen));
    btnFullscreen.title = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
}

async function toggleFullscreen() {
    try {
        if (!document.fullscreenElement) await wrapper.requestFullscreen();
        else await document.exitFullscreen();
    } catch (err) {
        console.log('Fullscreen blocked:', err);
    }
}

function showUI() {
    if (!controlsEnabled) return;
    if (isGridViewActive) return;
    uiVisible = true;
    $('overlay-header').classList.remove('ui-hidden');
    progressContainer.classList.remove('ui-hidden');
    navLeft.classList.remove('ui-hidden'); navRight.classList.remove('ui-hidden');
    helpHint.classList.remove('ui-hidden');
    document.body.classList.remove('cursor-hidden');
    resetIdleTimer();
}
function hideUI() {
    if (isGridViewActive || isDragging || isPinching || mediaFailed) return;
    if (document.activeElement?.matches?.(':focus-visible') &&
        document.activeElement?.closest?.('#overlay-header, .nav-arrow')) return;
    uiVisible = false;
    $('overlay-header').classList.add('ui-hidden');
    progressContainer.classList.add('ui-hidden');
    navLeft.classList.add('ui-hidden'); navRight.classList.add('ui-hidden');
    helpHint.classList.add('ui-hidden');
    document.body.classList.add('cursor-hidden');
}
function resetIdleTimer() {
    if (!controlsEnabled) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (isGridViewActive) return;
    if (!uiVisible) {
        uiVisible = true;
        $('overlay-header').classList.remove('ui-hidden');
        progressContainer.classList.remove('ui-hidden');
        navLeft.classList.remove('ui-hidden'); navRight.classList.remove('ui-hidden');
        helpHint.classList.remove('ui-hidden');
        document.body.classList.remove('cursor-hidden');
    }
    idleTimer = setTimeout(hideUI, tvModeEnabled ? 1800 : 3000);
}

function escapeHtml(value) {
    return value.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
}
