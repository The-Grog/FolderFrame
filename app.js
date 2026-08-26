// FolderFrame
// Features: directory-backed albums, HEIC/HEIF handling, shuffle slideshow,
// auto-rescan, TV/photo-frame mode, local preferences, and recursive folder browsing.

const ROOT_PATH = 'photos';
const AUTO_REFRESH_MS = 30000;

let mediaFiles = [];
let subfolders = [];
let currentFolder = '';
let currentIndex = 0;
let zoom = 1.0, panX = 0, panY = 0;
let isDragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;
let isPinching = false, initialDist = 0, initialZoom = 1.0, initialMidX = 0, initialMidY = 0, initialPanX = 0, initialPanY = 0;
let slideshowPlaying = false, slideshowTimer = null, slideshowInterval = 5, slideProgress = 0;
let slideshowAnimationFrame = null, slideshowStartedAt = 0;
let uiVisible = true, idleTimer = null, imageMode = 'fit', isGridViewActive = true;
let shuffleEnabled = false, autoRefreshEnabled = true, tvModeEnabled = false;
let galleryViewMode = 'folders'; // 'folders' or 'all'
let autoRefreshTimer = null;
let isScanning = false;

// Cache only object URLs we create ourselves. Normal HTTP URLs are never revoked.
const imageBlobCache = new Map(); // filepath -> blob URL
const cacheKind = new Map();      // filepath -> detected format

const $ = (id) => document.getElementById(id);
const viewport = $('media-viewport');
const container = $('media-container');
const img = $('gallery-image');
const video = $('gallery-video');
const mediaTitle = $('media-title');
const mediaIndex = $('media-index');
const btnResetZoom = $('btn-reset-zoom');
const btnImageMode = $('btn-image-mode');
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
const btnViewMode = $('btn-view-mode');
const btnTvMode = $('btn-tv-mode');
const scanStatus = $('scan-status');
const videoErrorOverlay = $('video-error-overlay');
const videoErrorText = $('video-error-text');
const videoErrorFfmpeg = $('video-error-ffmpeg');
const btnCloseVideoError = $('btn-close-video-error');

window.addEventListener('DOMContentLoaded', async () => {
    loadPreferences();
    applyUrlOptions();
    setupEventListeners();
    updateControlStates();
    updateFullscreenButton();
    await loadGallery({ preserveView: false });
    startAutoRefreshTimer();

    if (tvModeEnabled && mediaFiles.length > 0) {
        enterFullScreenViewer(currentIndex);
        if (!slideshowPlaying) setSlideshowPlaying(true);
    }
});

window.addEventListener('beforeunload', () => clearImageBlobCache());

function isHeicFile(path) { return /\.(heic|heif)$/i.test(path); }
function isImageFile(path) { return /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(path); }
function isVideoFile(path) { return /\.(mp4|mov)$/i.test(path); }
function isMediaFile(path) { return isImageFile(path) || isVideoFile(path); }

function encodePath(path) {
    return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function currentDirectoryUrl() {
    const suffix = currentFolder ? `${encodePath(currentFolder)}/` : '';
    return `./${ROOT_PATH}/${suffix}`;
}

function mediaUrlFor(filename, folder = currentFolder) {
    const folderPrefix = folder ? `${encodePath(folder)}/` : '';
    return `${ROOT_PATH}/${folderPrefix}${encodeURIComponent(filename)}`;
}

function savePreferences() {
    localStorage.setItem('gallery.preferences', JSON.stringify({
        folder: currentFolder,
        currentFile: mediaFiles[currentIndex] || '',
        interval: slideshowInterval,
        imageMode,
        shuffle: shuffleEnabled,
        autoRefresh: autoRefreshEnabled,
        tvMode: tvModeEnabled,
        galleryViewMode
    }));
}

function loadPreferences() {
    try {
        const raw = localStorage.getItem('gallery.preferences');
        if (!raw) return;
        const p = JSON.parse(raw);
        currentFolder = typeof p.folder === 'string' ? p.folder : '';
        slideshowInterval = [3,5,10,15,30,60].includes(Number(p.interval)) ? Number(p.interval) : 5;
        imageMode = p.imageMode === 'original' ? 'original' : 'fit';
        shuffleEnabled = Boolean(p.shuffle);
        autoRefreshEnabled = p.autoRefresh !== false;
        tvModeEnabled = Boolean(p.tvMode);
        galleryViewMode = p.galleryViewMode === 'all' ? 'all' : 'folders';
    } catch (err) {
        console.warn('Could not load gallery preferences:', err);
    }
}

function applyUrlOptions() {
    const params = new URLSearchParams(location.search);
    if (params.has('album')) currentFolder = params.get('album').replace(/^\/+|\/+$/g, '');
    if (params.has('interval')) {
        const n = Number(params.get('interval'));
        if ([3,5,10,15,30,60].includes(n)) slideshowInterval = n;
    }
    if (params.get('shuffle') === '1') shuffleEnabled = true;
    if (params.get('autorefresh') === '0') autoRefreshEnabled = false;
    if (params.get('tv') === '1') {
        tvModeEnabled = true;
        imageMode = 'fit';
        shuffleEnabled = true;
        slideshowPlaying = true;
        autoRefreshEnabled = true;
    }
    if (params.get('autoplay') === '1') slideshowPlaying = true;
    if (params.get('view') === 'all') galleryViewMode = 'all';
    if (params.get('view') === 'folders') galleryViewMode = 'folders';
}

function updateControlStates() {
    selectInterval.value = String(slideshowInterval);
    imageModeText.textContent = imageMode === 'fit' ? 'Fit Screen' : 'Original Size';
    btnShuffle.classList.toggle('is-active', shuffleEnabled);
    btnShuffle.setAttribute('aria-pressed', String(shuffleEnabled));
    btnShuffle.querySelector('.button-label').textContent = shuffleEnabled ? 'Shuffle On' : 'Shuffle';
    btnAutoRefresh.classList.toggle('is-active', autoRefreshEnabled);
    btnAutoRefresh.setAttribute('aria-pressed', String(autoRefreshEnabled));
    btnAutoRefresh.querySelector('.button-label').textContent = autoRefreshEnabled ? 'Auto Refresh On' : 'Auto Refresh Off';
    btnViewMode.classList.toggle('is-active', galleryViewMode === 'all');
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

function syncPlayButton() {
    playIcon.style.display = slideshowPlaying ? 'none' : 'inline';
    pauseIcon.style.display = slideshowPlaying ? 'inline' : 'none';
    slideshowText.textContent = slideshowPlaying ? 'Pause' : 'Play';
}

function clearImageBlobCache() {
    imageBlobCache.forEach(url => URL.revokeObjectURL(url));
    imageBlobCache.clear();
    cacheKind.clear();
}

function removeCacheEntry(filepath) {
    const url = imageBlobCache.get(filepath);
    if (url) URL.revokeObjectURL(url);
    imageBlobCache.delete(filepath);
    cacheKind.delete(filepath);
}

function pruneCache(validFiles) {
    const valid = new Set(validFiles);
    for (const path of imageBlobCache.keys()) {
        if (!valid.has(path)) removeCacheEntry(path);
    }
}

function detectImageFormat(arrayBuffer) {
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
        const heifBrands = new Set(['heic','heix','hevc','hevx','heim','heis','mif1','msf1']);
        if (brands.some(brand => heifBrands.has(brand))) return 'heic';
    }
    return 'unknown';
}

function ascii(bytes, start, end) {
    return String.fromCharCode(...bytes.slice(start, end));
}

function mimeForFormat(format) {
    return ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' })[format] || '';
}

async function getSpecialImageURL(filepath) {
    if (imageBlobCache.has(filepath)) return imageBlobCache.get(filepath);

    const response = await fetch(filepath, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const actualFormat = detectImageFormat(arrayBuffer);
    cacheKind.set(filepath, actualFormat);

    if (['jpeg', 'png', 'webp', 'gif'].includes(actualFormat)) {
        const mime = mimeForFormat(actualFormat);
        const objectURL = URL.createObjectURL(new Blob([arrayBuffer], { type: mime }));
        imageBlobCache.set(filepath, objectURL);
        console.info(`${filepath}: extension suggests HEIC/HEIF but content is ${actualFormat.toUpperCase()}; using ${mime} Blob.`);
        return objectURL;
    }

    if (actualFormat === 'heic') {
        if (typeof heic2any !== 'function') throw new Error('HEIC decoder library did not load');
        console.info(`${filepath}: genuine HEIC/HEIF detected; converting with heic2any.`);
        const sourceBlob = new Blob([arrayBuffer], { type: 'image/heic' });
        const converted = await heic2any({ blob: sourceBlob, toType: 'image/jpeg', quality: 0.92 });
        const convertedBlob = Array.isArray(converted) ? converted[0] : converted;
        const objectURL = URL.createObjectURL(convertedBlob);
        imageBlobCache.set(filepath, objectURL);
        return objectURL;
    }

    throw new Error('Unknown or corrupt image format');
}

async function scanDirectory(folder = currentFolder) {
    const suffix = folder ? `${encodePath(folder)}/` : '';
    const url = `./${ROOT_PATH}/${suffix}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not fetch directory (${response.status})`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const files = new Set();
    const folders = new Set();

    for (const link of doc.querySelectorAll('a')) {
        const rawHref = link.getAttribute('href');
        if (!rawHref || rawHref.startsWith('?') || rawHref.startsWith('#') || rawHref === '../' || rawHref.startsWith('../')) continue;
        let pathname;
        try {
            pathname = new URL(rawHref, response.url).pathname;
        } catch {
            continue;
        }
        let name = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
        if (!name || name === '..') continue;

        const isDirectory = pathname.endsWith('/') || rawHref.endsWith('/');
        if (isDirectory) {
            // Ignore the current folder itself and obvious parent links.
            if (name && name !== ROOT_PATH) folders.add(name);
        } else if (isMediaFile(name)) {
            files.add(name);
        }
    }

    const filePaths = Array.from(files)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        .map(filename => mediaUrlFor(filename, folder));
    const folderNames = Array.from(folders)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    return { filePaths, folderNames };
}

async function scanDirectoryRecursive(folder = currentFolder, visited = new Set()) {
    const normalized = folder.replace(/^\/+|\/+$/g, '');
    if (visited.has(normalized)) return [];
    visited.add(normalized);

    const { filePaths, folderNames } = await scanDirectory(normalized);
    let allFiles = [...filePaths];

    for (const child of folderNames) {
        const childFolder = normalized ? `${normalized}/${child}` : child;
        const childFiles = await scanDirectoryRecursive(childFolder, visited);
        allFiles.push(...childFiles);
    }

    return allFiles.sort((a, b) =>
        decodeURIComponent(a).localeCompare(decodeURIComponent(b), undefined, {
            numeric: true,
            sensitivity: 'base'
        })
    );
}

async function loadGallery({ preserveView = true, forceCacheClear = false, silent = false } = {}) {
    if (isScanning) return;
    isScanning = true;
    const oldFile = mediaFiles[currentIndex];
    const oldViewWasGrid = isGridViewActive;
    if (!silent) setScanStatus('Scanning…');

    try {
        if (forceCacheClear) clearImageBlobCache();

        const currentListing = await scanDirectory(currentFolder);
        const folderNames = currentListing.folderNames;
        const filePaths = galleryViewMode === 'all'
            ? await scanDirectoryRecursive(currentFolder)
            : currentListing.filePaths;

        const changed = JSON.stringify(filePaths) !== JSON.stringify(mediaFiles) || JSON.stringify(folderNames) !== JSON.stringify(subfolders);
        mediaFiles = filePaths;
        subfolders = folderNames;
        pruneCache(mediaFiles);

        if (oldFile) {
            const existingIndex = mediaFiles.indexOf(oldFile);
            currentIndex = existingIndex >= 0 ? existingIndex : Math.min(currentIndex, Math.max(0, mediaFiles.length - 1));
        } else {
            currentIndex = Math.min(currentIndex, Math.max(0, mediaFiles.length - 1));
        }

        showWarning(mediaFiles.length === 0 && subfolders.length === 0);
        renderBreadcrumb();
        setScanStatus(`Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);

        if (!preserveView || oldViewWasGrid || mediaFiles.length === 0) {
            renderGridView();
        } else if (mediaFiles.length > 0 && (changed || !isGridViewActive)) {
            enterFullScreenViewer(currentIndex);
        }
        savePreferences();
    } catch (err) {
        console.error('Directory scanning error:', err);
        setScanStatus('Scan failed');
        if (mediaFiles.length === 0 && subfolders.length === 0) showWarning(true);
    } finally {
        isScanning = false;
    }
}

function setScanStatus(text) {
    if (scanStatus) scanStatus.textContent = text;
}

function showWarning(show) { warningOverlay.style.display = show ? 'flex' : 'none'; }
function isPhotoActive() { return mediaFiles[currentIndex] ? isImageFile(mediaFiles[currentIndex]) : false; }

function renderBreadcrumb() {
    breadcrumb.innerHTML = '';
    const root = document.createElement('button');
    root.className = 'crumb';
    root.textContent = 'Photos';
    root.addEventListener('click', () => navigateToFolder(''));
    breadcrumb.appendChild(root);

    const parts = currentFolder.split('/').filter(Boolean);
    let running = '';
    parts.forEach((part) => {
        const sep = document.createElement('span');
        sep.className = 'crumb-separator';
        sep.textContent = '›';
        breadcrumb.appendChild(sep);
        running = running ? `${running}/${part}` : part;
        const target = running;
        const crumb = document.createElement('button');
        crumb.className = 'crumb';
        crumb.textContent = part;
        crumb.addEventListener('click', () => navigateToFolder(target));
        breadcrumb.appendChild(crumb);
    });
    if (galleryViewMode === 'all') {
        gridPath.textContent = currentFolder
            ? `${currentFolder} • including subfolders`
            : 'All media • including subfolders';
    } else {
        gridPath.textContent = currentFolder || 'Sorted by folder';
    }
}

async function navigateToFolder(folder) {
    currentFolder = folder;
    currentIndex = 0;
    isGridViewActive = true;
    stopSlideshow();
    clearImageBlobCache();
    await loadGallery({ preserveView: false });
}

function renderGridView() {
    isGridViewActive = true;
    thumbnailGrid.innerHTML = '';
    const total = mediaFiles.length;
    const albums = galleryViewMode === 'folders' ? subfolders.length : 0;
    gridCount.textContent = galleryViewMode === 'all'
        ? `${total} file${total === 1 ? '' : 's'} • all folders`
        : `${albums ? `${albums} album${albums === 1 ? '' : 's'} • ` : ''}${total} file${total === 1 ? '' : 's'}`;

    // Album cards first when browsing by folder.
    if (galleryViewMode === 'folders') subfolders.forEach(folder => {
        const item = document.createElement('button');
        item.className = 'grid-item album-card';
        item.type = 'button';
        item.innerHTML = `
            <div class="album-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="54" height="54"><path fill="currentColor" d="M10 4H2c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h20c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-10l-2-2z"/></svg>
            </div>
            <div class="album-name">${escapeHtml(folder)}</div>
            <div class="album-subtitle">Open album</div>`;
        item.addEventListener('click', () => navigateToFolder(currentFolder ? `${currentFolder}/${folder}` : folder));
        thumbnailGrid.appendChild(item);
    });

    const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const el = entry.target;
            observer.unobserve(el);
            const file = el.dataset.heicSrc;
            if (!file) return;
            getSpecialImageURL(file)
                .then(url => { el.src = url; el.classList.add('thumb-loaded'); })
                .catch(err => {
                    console.error(`HEIC/HEIF thumbnail generation failed for ${file}:`, err);
                    el.closest('.grid-item')?.classList.add('thumb-error');
                });
        });
    }, { root: gridViewContainer, rootMargin: '300px' }) : null;

    mediaFiles.forEach((file, index) => {
        const filename = decodeURIComponent(file.split('/').pop());
        const item = document.createElement('button');
        item.className = 'grid-item';
        item.type = 'button';
        item.setAttribute('aria-label', `Open ${filename}`);

        if (isVideoFile(file)) {
            const vid = document.createElement('video');
            vid.src = file;
            vid.preload = 'metadata';
            vid.disablePictureInPicture = true;
            vid.muted = true;
            vid.playsInline = true;
            item.appendChild(vid);
            const badge = document.createElement('div');
            badge.className = 'video-badge';
            badge.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
            item.appendChild(badge);
        } else if (isHeicFile(file)) {
            const imgEl = document.createElement('img');
            imgEl.alt = filename;
            imgEl.decoding = 'async';
            imgEl.dataset.heicSrc = file;
            imgEl.className = 'heic-thumb';
            if (observer) observer.observe(imgEl);
            else getSpecialImageURL(file).then(url => { imgEl.src = url; imgEl.classList.add('thumb-loaded'); }).catch(console.error);
            item.appendChild(imgEl);
            const fallback = document.createElement('div');
            fallback.className = 'heic-fallback';
            fallback.textContent = 'HEIC';
            item.appendChild(fallback);
        } else {
            const imgEl = document.createElement('img');
            imgEl.src = file;
            imgEl.alt = filename;
            imgEl.loading = 'lazy';
            imgEl.decoding = 'async';
            item.appendChild(imgEl);
        }

        const caption = document.createElement('div');
        caption.className = 'grid-item-caption';
        if (galleryViewMode === 'all') {
            let relative = decodeURIComponent(file.replace(new RegExp(`^${ROOT_PATH}/`), ''));
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
        thumbnailGrid.appendChild(item);
    });

    gridViewContainer.style.display = 'flex';
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
    isGridViewActive = false;
    gridViewContainer.style.display = 'none';
    viewport.style.display = 'flex';
    $('overlay-header').style.display = 'flex';
    navLeft.style.display = 'flex';
    navRight.style.display = 'flex';
    progressContainer.style.display = 'block';
    helpHint.style.display = 'block';
    showMedia(index);
}

function showMedia(index) {
    if (!mediaFiles.length) return;
    currentIndex = (index + mediaFiles.length) % mediaFiles.length;
    const filepath = mediaFiles[currentIndex];
    const filename = decodeURIComponent(filepath.split('/').pop());
    const displayName = galleryViewMode === 'all'
        ? decodeURIComponent(filepath.replace(new RegExp(`^${ROOT_PATH}/`), ''))
        : filename;

    resetZoomAndPan();
    videoErrorOverlay.style.display = 'none';
    img.style.display = 'none'; img.src = ''; img.onload = null; img.onerror = null;
    video.style.display = 'none'; video.pause(); video.src = ''; video.onended = null; video.ontimeupdate = null; video.onerror = null;
    mediaTitle.textContent = displayName;
    mediaIndex.textContent = `${currentIndex + 1} / ${mediaFiles.length}`;

    if (isImageFile(filepath)) {
        img.classList.remove('mode-fit', 'mode-original');
        img.classList.add(imageMode === 'fit' ? 'mode-fit' : 'mode-original');
        container.classList.add('grab-mode');
        img.onload = () => { img.style.display = 'block'; mediaTitle.textContent = displayName; };
        img.onerror = () => { console.error('Image loading failed:', filepath); mediaTitle.textContent = `${displayName} (Loading Failed)`; };

        if (isHeicFile(filepath)) {
            mediaTitle.textContent = `${displayName} (Preparing…)`;
            getSpecialImageURL(filepath)
                .then(url => { img.src = url; })
                .catch(err => {
                    console.error('HEIC/HEIF image handling failed:', err);
                    mediaTitle.textContent = `${displayName} (Image Error: ${err.message || err})`;
                });
        } else {
            img.src = filepath;
        }
        if (slideshowPlaying) startSlideshowTimer();
    } else {
        container.classList.remove('grab-mode');
        video.src = filepath;
        video.style.display = 'block';
        video.controls = !tvModeEnabled;
        video.onerror = () => {
            const name = decodeURIComponent(filepath.split('/').pop());
            let msg = 'The format or codec is not supported by your browser.';
            if (video.error?.code === 3) msg = 'Video decoding failed. This file likely uses an unsupported codec such as H.265/HEVC.';
            videoErrorText.textContent = msg;
            videoErrorFfmpeg.textContent = `ffmpeg -i "${filepath}" -c:v libx264 -pix_fmt yuv420p -c:a aac "fixed_${name}"`;
            videoErrorOverlay.style.display = 'flex';
            if (slideshowPlaying) slideshowTimer = setTimeout(nextSlideshowMedia, 5000);
        };
        video.play().catch(err => console.log('Video autoplay blocked or failed:', err));
        video.onended = () => { if (slideshowPlaying) nextSlideshowMedia(); };
        video.ontimeupdate = () => {
            if (slideshowPlaying && video.duration) progressBar.style.width = `${(video.currentTime / video.duration) * 100}%`;
        };
        cancelSlideshowTimer();
        progressBar.style.width = '0%';
    }
    showUI();
    savePreferences();
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
function resetZoomAndPan() { zoom = 1.0; panX = 0; panY = 0; applyTransform(); }

function toggleImageMode() {
    imageMode = imageMode === 'fit' ? 'original' : 'fit';
    updateControlStates();
    if (isPhotoActive()) {
        img.classList.remove('mode-fit', 'mode-original');
        img.classList.add(imageMode === 'fit' ? 'mode-fit' : 'mode-original');
        resetZoomAndPan();
    }
    savePreferences();
}

function handleWheel(e) {
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
    btnShowGrid.addEventListener('click', renderGridView);
    btnRefreshGrid.addEventListener('click', () => loadGallery({ preserveView: true, forceCacheClear: true }));
    btnShuffle.addEventListener('click', () => { shuffleEnabled = !shuffleEnabled; updateControlStates(); savePreferences(); });
    btnAutoRefresh.addEventListener('click', () => { autoRefreshEnabled = !autoRefreshEnabled; updateControlStates(); startAutoRefreshTimer(); savePreferences(); });
    btnViewMode.addEventListener('click', async () => {
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
    btnResetZoom.addEventListener('click', resetZoomAndPan);
    btnImageMode.addEventListener('click', toggleImageMode);
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    viewport.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    viewport.addEventListener('touchstart', handleTouchStart, { passive: false });
    viewport.addEventListener('touchmove', handleTouchMove, { passive: false });
    viewport.addEventListener('touchend', handleTouchEnd);
    btnPlayPause.addEventListener('click', toggleSlideshow);
    selectInterval.addEventListener('change', e => {
        slideshowInterval = Number(e.target.value);
        if (slideshowPlaying && isPhotoActive()) startSlideshowTimer();
        savePreferences();
    });
    btnFullscreen.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    btnRetryWarning.addEventListener('click', () => loadGallery({ preserveView: false, forceCacheClear: true }));
    btnCloseVideoError.addEventListener('click', () => { videoErrorOverlay.style.display = 'none'; if (slideshowPlaying) nextSlideshowMedia(); });

    window.addEventListener('keydown', e => {
        if (isGridViewActive) return;
        if (e.key === 'ArrowLeft') prevMedia();
        if (e.key === 'ArrowRight') nextMedia();
        if (e.key === ' ') { e.preventDefault(); toggleSlideshow(); }
        if (e.key === 'Enter') { e.preventDefault(); toggleImageMode(); }
        if (e.key.toLowerCase() === 's') { shuffleEnabled = !shuffleEnabled; updateControlStates(); savePreferences(); }
        if (e.key.toLowerCase() === 'f') toggleFullscreen();
        if (e.key.toLowerCase() === 't') toggleTvMode();
        if (e.key.toLowerCase() === 'g') renderGridView();
        if (e.key === 'Escape' && (zoom !== 1.0 || panX || panY)) resetZoomAndPan();
        resetIdleTimer();
    });

    window.addEventListener('mousemove', () => { if (!isGridViewActive) resetIdleTimer(); });
    window.addEventListener('click', () => { if (!isGridViewActive) resetIdleTimer(); });
    window.addEventListener('touchstart', () => { if (!isGridViewActive) resetIdleTimer(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && autoRefreshEnabled) loadGallery({ preserveView: true, silent: true }); });
}

function startAutoRefreshTimer() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
    if (!autoRefreshEnabled) return;
    autoRefreshTimer = setInterval(() => {
        if (!document.hidden) loadGallery({ preserveView: true, silent: true });
    }, AUTO_REFRESH_MS);
}

async function toggleTvMode() {
    tvModeEnabled = !tvModeEnabled;
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
    if (!isPhotoActive()) return;
    if (zoom !== 1.0 || imageMode === 'original' || panX !== 0 || panY !== 0) {
        isDragging = true; startX = e.clientX; startY = e.clientY; startPanX = panX; startPanY = panY;
    }
}
function handleMouseMove(e) { if (isDragging) { panX = startPanX + e.clientX - startX; panY = startPanY + e.clientY - startY; applyTransform(); } }
function handleMouseUp() { isDragging = false; }

function handleTouchStart(e) {
    if (!isPhotoActive()) return;
    resetIdleTimer();
    if (e.touches.length === 2) {
        isPinching = true; isDragging = false;
        const [t1, t2] = e.touches;
        initialDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const midX = (t1.clientX + t2.clientX) / 2, midY = (t1.clientY + t2.clientY) / 2;
        const rect = container.getBoundingClientRect();
        initialMidX = midX - rect.left - rect.width / 2;
        initialMidY = midY - rect.top - rect.height / 2;
        initialZoom = zoom; initialPanX = panX; initialPanY = panY;
    } else if (e.touches.length === 1 && (zoom !== 1.0 || imageMode === 'original' || panX !== 0 || panY !== 0)) {
        isDragging = true; isPinching = false;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY; startPanX = panX; startPanY = panY;
    }
}

function handleTouchMove(e) {
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
            const rect = container.getBoundingClientRect();
            panX += (midX - rect.left - rect.width / 2) - initialMidX;
            panY += (midY - rect.top - rect.height / 2) - initialMidY;
        }
        applyTransform();
    } else if (isDragging && e.touches.length === 1) {
        e.preventDefault();
        panX = startPanX + e.touches[0].clientX - startX;
        panY = startPanY + e.touches[0].clientY - startY;
        applyTransform();
    }
}
function handleTouchEnd(e) { if (e.touches.length < 2) isPinching = false; if (e.touches.length === 0) isDragging = false; }

function toggleSlideshow() { setSlideshowPlaying(!slideshowPlaying); }
function setSlideshowPlaying(value) {
    slideshowPlaying = Boolean(value);
    syncPlayButton();
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
    cancelSlideshowTimer();
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

function updateFullscreenButton() {
    const label = btnFullscreen.querySelector('.button-label');
    const isFullscreen = Boolean(document.fullscreenElement);
    if (label) label.textContent = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
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
    if (isGridViewActive || isDragging || isPinching) return;
    uiVisible = false;
    $('overlay-header').classList.add('ui-hidden');
    progressContainer.classList.add('ui-hidden');
    navLeft.classList.add('ui-hidden'); navRight.classList.add('ui-hidden');
    helpHint.classList.add('ui-hidden');
    document.body.classList.add('cursor-hidden');
}
function resetIdleTimer() {
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
