// Only Modrinth and CurseForge load in the viewer. Any other link opens in the default browser.
const { WebContentsView, session, shell } = require('electron');

const ALLOWED = [/(^|\.)modrinth\.com$/i, /(^|\.)curseforge\.com$/i, /(^|\.)forgecdn\.net$/i];
const allowed = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && ALLOWED.some(r => r.test(u.hostname)); } catch { return false; } };

let view = null;
let host = null;
let emit = () => {};

function pageSession() {
    const ses = session.fromPartition('persist:platform-pages');
    // Look like plain Chrome so both sites serve their normal pages.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|incursion)\/\S+/gi, ''));
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    return ses;
}

function state() {
    if (!view) return { open: false };
    const wc = view.webContents;
    return { open: true, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() };
}
const push = () => emit('webpage', state());

function open(win, url, bounds) {
    if (!allowed(url)) throw new Error('Only Modrinth and CurseForge pages open inside Incursion.');
    host = win;
    if (!view) {
        view = new WebContentsView({ webPreferences: { session: pageSession(), sandbox: true, contextIsolation: true, nodeIntegration: false } });
        view.setBorderRadius?.(8);
        const wc = view.webContents;
        // Only links that were actually clicked open in the browser. Ads run background frames and scripted pop-ups
        // through tracking domains, and those must never reach the default browser.
        let lastInput = 0, lastExternal = 0;
        wc.on('input-event', (_e, input) => { if (input.type === 'mouseDown' || input.type === 'keyDown') lastInput = Date.now(); });
        const openOutside = (u) => {
            const now = Date.now();
            if (now - lastInput > 1500 || now - lastExternal < 1000) return;
            lastExternal = now;
            shell.openExternal(u);
        };
        wc.setWindowOpenHandler(({ url: u }) => {
            if (allowed(u)) { if (Date.now() - lastInput < 1500) wc.loadURL(u); } else openOutside(u);
            return { action: 'deny' };
        });
        // Main frame only. Ad iframes can navigate inside the viewer but never open anything.
        wc.on('will-navigate', (e, u) => { if (e.isMainFrame !== false && !allowed(u)) { e.preventDefault(); openOutside(u); } });
        wc.on('will-redirect', (e, u, _inPlace, isMainFrame) => { if ((e.isMainFrame ?? isMainFrame) && !allowed(u)) e.preventDefault(); });
        for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(ev, push);
        wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); emit('webpage', { ...state(), closeRequested: true }); } });
        win.contentView.addChildView(view);
    }
    setBounds(bounds);
    view.webContents.loadURL(url);
    view.webContents.focus();
    return state();
}

function setBounds(b) {
    if (!view || !b) return;
    view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) });
}

function nav(action) {
    if (!view) return state();
    const wc = view.webContents;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'external') shell.openExternal(wc.getURL());
    return state();
}

function close() {
    if (!view) return state();
    try { host?.contentView.removeChildView(view); } catch {}
    view.webContents.close();
    view = null;
    push();
    return state();
}

module.exports = { open, setBounds, nav, close, state, allowed, setEmitter: (fn) => { emit = fn; } };
