/**
 * Resolve repo-root URLs so the browser app can be hosted under a subpath.
 *
 * HTML pages live under `.../html/` (any depth). The app root is the parent of
 * that `/html/` segment. Relative `fetch` / `img.src` resolve against the page,
 * not the script bundle — always build URLs with `appUrl()`.
 *
 * Override (optional): `window.__APP_ROOT__ = '/deploy/prefix/'`
 * Node / headless (no document.baseURI): returns host-root paths (`/assets/...`)
 * compatible with tests/mock_env.js.
 */

function ensureTrailingSlash(s) {
    const t = String(s || '');
    if (!t) return '/';
    return t.endsWith('/') ? t : `${t}/`;
}

/**
 * Absolute app root ending with `/` (browser) or `/` (Node mock).
 * @returns {string}
 */
function getAppRoot() {
    if (typeof window !== 'undefined' && window.__APP_ROOT__) {
        return ensureTrailingSlash(window.__APP_ROOT__);
    }
    if (typeof document !== 'undefined' && document.baseURI) {
        try {
            const url = new URL(document.baseURI);
            const match = url.pathname.match(/^(.*\/)html(?:\/|$)/i);
            if (match) {
                url.pathname = match[1];
                url.search = '';
                url.hash = '';
                return ensureTrailingSlash(url.href);
            }
            // Not under /html/ — parent of the current directory
            return ensureTrailingSlash(new URL('../', document.baseURI).href);
        } catch (_) {
            /* fall through */
        }
    }
    return '/';
}

/**
 * @param {string} relPath path from repo root, e.g. `assets/flags/x.svg` or `/presets/a.json`
 * @returns {string} URL for fetch / Image.src / audio
 */
function appUrl(relPath) {
    const clean = String(relPath || '').replace(/^\/+/, '');
    const root = getAppRoot();
    if (root === '/') {
        return `/${clean}`;
    }
    try {
        return new URL(clean, root).href;
    } catch (_) {
        return root + clean;
    }
}

module.exports = { getAppRoot, appUrl, ensureTrailingSlash };
