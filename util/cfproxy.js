// The CurseForge key stays on Cloudflare and the app holds a signed pass. Passes last 7 days and renew quietly. After
// 30 days (or a failed renewal) a small Turnstile window shows once.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { request, aliasCurseForge } = require('./http');

const RENEW_BEFORE = 24 * 3600 * 1000;

let base = null, file = null, state = null, getParent = () => null, verifying = null, hidden = false;

// https only, except a local Worker during development.
function normalize(url) {
    if (!url) return null;
    try {
        const u = new URL(String(url).trim());
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
        if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
        return u.origin;
    } catch { return null; }
}

async function load() {
    if (state) return state;
    state = await require('./storage').readJsonSafe(file, {}).catch(() => ({}));
    if (!/^[\w-]{8,64}$/.test(state.installId || '')) { state.installId = crypto.randomUUID(); await save(); }
    return state;
}
const save = () => require('./storage').writeJsonAtomic(file, state);

function init({ userData, url, parent, hiddenWindows = false }) {
    file = path.join(userData, 'cf-service.json');
    getParent = parent || getParent;
    hidden = hiddenWindows;
    setUrl(url);
}

function setUrl(url) {
    const next = normalize(url);
    if (next !== base) { base = next; if (state) { state.pass = null; state.expiresAt = 0; } }
    if (base) aliasCurseForge(base);
    return base;
}

function showCheck() {
    const { BrowserWindow, session } = require('electron');
    return new Promise((resolve, reject) => {
        const parent = getParent();
        const win = new BrowserWindow({
            parent: parent || undefined, modal: !!parent && !hidden, width: 420, height: 380, resizable: false, minimizable: false, maximizable: false,
            title: 'Verifying Incursion', autoHideMenuBar: true, show: false, backgroundColor: '#10141a',
            webPreferences: { session: session.fromPartition('persist:cf-verify'), sandbox: true, contextIsolation: true, nodeIntegration: false }
        });
        win.setMenu(null);
        let done = false;
        const finish = (fn, v) => { if (done) return; done = true; fn(v); if (!win.isDestroyed()) win.close(); };
        const check = (url) => {
            if (!url.startsWith(`${base}/verified`)) return;
            const token = new URLSearchParams(new URL(url).hash.slice(1)).get('t');
            if (token) finish(resolve, token);
        };
        win.webContents.on('did-navigate', (_e, url) => check(url));
        win.webContents.on('did-navigate-in-page', (_e, url) => check(url));
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(base)) e.preventDefault(); });
        win.once('ready-to-show', () => {
            if (!hidden) return win.show();
            win.setPosition(-4000, 40);
            win.showInactive();
        });
        win.on('closed', () => { if (!done) { done = true; reject(Object.assign(new Error('CurseForge verification was cancelled.'), { code: 'VERIFY_CANCELLED' })); } });
        win.loadURL(`${base}/verify`).catch((err) => finish(reject, new Error(`The CurseForge service can’t be reached (${err.message}).`)));
    });
}

async function verify() {
    const s = await load();
    const token = await showCheck();
    const r = await request(`${base}/pass`, { method: 'POST', body: { token, installId: s.installId }, retries: 1 });
    Object.assign(s, { pass: r.pass, expiresAt: r.expiresAt, renewUntil: r.renewUntil });
    await save();
    return s.pass;
}

async function renew() {
    const s = await load();
    const r = await request(`${base}/renew`, { method: 'POST', headers: { Authorization: `Bearer ${s.pass}` }, retries: 1 });
    Object.assign(s, { pass: r.pass, expiresAt: r.expiresAt, renewUntil: r.renewUntil });
    await save();
    return s.pass;
}

async function getPass(fresh = false) {
    if (!base) throw Object.assign(new Error('The CurseForge service isn’t set up.'), { code: 'NO_CF_KEY' });
    const s = await load();
    const left = (s.expiresAt || 0) - Date.now();
    if (!fresh && s.pass && left > RENEW_BEFORE) return s.pass;
    verifying ||= (async () => {
        try {
            if (s.pass && left > 0) {
                try { return await renew(); } catch (err) { if (err.status !== 401) throw err; }
            }
            return await verify();
        } finally { verifying = null; }
    })();
    return verifying;
}

function invalidate() { if (state) { state.expiresAt = 0; } }

async function status() {
    if (!base) return { url: null, enabled: false };
    const s = await load();
    let health = null;
    try { health = await request(`${base}/health`, { retries: 0, timeout: 8000 }); } catch (err) { health = { ok: false, error: err.message }; }
    return { url: base, enabled: true, verified: !!s.pass && s.expiresAt > Date.now(), expiresAt: s.expiresAt || 0, renewUntil: s.renewUntil || 0, health };
}

async function forget() { const s = await load(); Object.assign(s, { pass: null, expiresAt: 0, renewUntil: 0 }); await save(); }

async function hasPass() { if (!base) return false; const s = await load(); return !!s.pass && s.expiresAt > Date.now(); }

module.exports = { hasPass, init, setUrl, getPass, invalidate, status, verify: () => verify(), forget, url: () => base, normalize };
