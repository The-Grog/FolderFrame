/* Installed build details only: never inspect media, configuration, or browser storage. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FolderFrameAbout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const repository = 'https://github.com/The-Grog/FolderFrame';
    const releasePattern = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
    const revisionPattern = /^[a-f0-9]{40}$/i;
    function normalizeBuildInfo(value) {
        const data = value?.schemaVersion === 1 ? value : {};
        const valid = (input, pattern) => typeof input === 'string' && input.length <= 100 && pattern.test(input) ? input : null;
        return { version: valid(data.version, releasePattern), revision: valid(data.revision, revisionPattern),
            deploymentRevision: valid(data.deploymentRevision, revisionPattern) };
    }
    function formatVersionInfo(data) {
        const info = normalizeBuildInfo({ ...data, schemaVersion: 1 });
        return ['FolderFrame', `Version: ${info.version || 'Development / unknown version'}`,
            info.revision && `App revision: ${info.revision}`,
            info.deploymentRevision && `Deployment revision: ${info.deploymentRevision}`].filter(Boolean).join('\n');
    }
    function init({ onOpen = () => {}, onClose = () => {} } = {}) {
        const get = id => document.getElementById(id);
        const dialog = get('about-dialog');
        if (!dialog) return;
        const buttons = [get('btn-about-viewer'), get('btn-about-grid')].filter(Boolean);
        const close = get('btn-close-about');
        const copy = get('btn-copy-version');
        const status = get('about-status');
        const manual = get('about-copy-text');
        let info = normalizeBuildInfo(null), controller = null, generation = 0, opener = null;
        function render() {
            get('about-version').textContent = info.version || 'Development / unknown version';
            const revision = get('about-revision');
            revision.textContent = info.revision ? `App revision ${info.revision.slice(0, 12)}` : '';
            revision.hidden = !info.revision;
            get('about-release-notes').href = info.version
                ? `${repository}/releases/tag/${encodeURIComponent(info.version)}` : `${repository}/releases`;
            get('about-release-notes').textContent = info.version ? 'Release notes' : 'All releases';
            manual.value = formatVersionInfo(info);
        }
        async function load() {
            const ticket = ++generation;
            controller?.abort();
            const request = new AbortController();
            controller = request;
            const timeout = setTimeout(() => request.abort(), 5000);
            status.textContent = 'Loading installed version…';
            copy.disabled = true;
            try {
                const response = await fetch('build-info.json', { cache: 'no-store', signal: request.signal });
                if (!response.ok) throw new Error('Build details unavailable');
                const text = await response.text();
                if (text.length > 4096) throw new Error('Invalid build details');
                const result = normalizeBuildInfo(JSON.parse(text));
                if (ticket !== generation || !dialog.open) return;
                info = result;
                status.textContent = info.version ? '' : 'This copy has no release version attached.';
            } catch (_) {
                if (ticket !== generation || !dialog.open) return;
                info = normalizeBuildInfo(null);
                status.textContent = 'Installed version information is unavailable.';
            } finally {
                clearTimeout(timeout);
                if (ticket === generation && dialog.open) {
                    controller = null;
                    copy.disabled = false;
                    render();
                }
            }
        }
        for (const button of buttons) button.addEventListener('click', () => {
            if (dialog.open) return;
            opener = button.id === 'btn-about-grid' ? get('btn-grid-options') : get('btn-viewer-options');
            manual.hidden = true;
            info = normalizeBuildInfo(null);
            render();
            dialog.showModal();
            onOpen();
            close.focus();
            load();
        });
        close.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => {
            generation++;
            controller?.abort();
            controller = null;
            onClose();
            opener?.focus();
        });
        // Native dialog owns Escape and focus trapping; app shortcuts must not run.
        dialog.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.key !== 'Tab') return;
            const focusable = Array.from(dialog.querySelectorAll('button:not([disabled]), a[href], textarea'))
                .filter(element => !element.hidden && element.getClientRects().length);
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault(); last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault(); first?.focus();
            }
        });
        dialog.addEventListener('click', event => {
            event.stopPropagation();
            if (event.target !== dialog) return;
            const rect = dialog.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
        });
        copy.addEventListener('click', async () => {
            const ticket = generation;
            try {
                if (!window.isSecureContext || !navigator.clipboard?.writeText) throw new Error('Manual copy required');
                await navigator.clipboard.writeText(formatVersionInfo(info));
                if (ticket === generation && dialog.open) status.textContent = 'Version info copied.';
            } catch (_) {
                if (ticket !== generation || !dialog.open) return;
                manual.hidden = false;
                manual.value = formatVersionInfo(info);
                manual.focus();
                manual.select();
                status.textContent = 'Select and copy the version info below.';
            }
        });
        render();
    }
    return { normalizeBuildInfo, formatVersionInfo, init };
});
