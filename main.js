const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, nativeImage, safeStorage, protocol, net, session } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

if (process.env.INCURSION_USER_DATA) app.setPath('userData', process.env.INCURSION_USER_DATA);
// One instance per profile. A second launch just focuses the running window.
if (!app.requestSingleInstanceLock()) app.exit(0);
// Keep Chromium painting while the window is hidden off-screen.
if (process.env.INCURSION_HIDDEN) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const storage = require('./util/storage');
const cache = require('./util/cache');
const api = require('./util/api');
const packs = require('./util/packs');
const launcher = require('./util/launcher');
const java = require('./util/java');
const datadir = require('./util/datadir');
const files = require('./util/files');
const importer = require('./util/importer');
const publisher = require('./util/publish');
const env = require('./util/env');
const webpage = require('./util/webpage');
const backups = require('./util/backups');
const profiles = require('./util/profiles');
const scheduler = require('./util/scheduler');
const cfproxy = require('./util/cfproxy');
const links = require('./util/links');
links.init({ dir: () => datadir.get() });
const community = require('./util/community');
const votes = require('./util/votes');
let linkPrefs = { shareLinks: true, manualLinksFirst: true, linksNoticeSeen: false };
function applyLinkPrefs(p = {}) {
    linkPrefs = { shareLinks: p.shareLinks !== false, manualLinksFirst: p.manualLinksFirst !== false, linksNoticeSeen: !!p.linksNoticeSeen };
    links.setOptions({ manualFirst: linkPrefs.manualLinksFirst });
}

const isMac = process.platform === 'darwin';
const TITLEBAR_HEIGHT = 52;
let win = null;

protocol.registerSchemesAsPrivileged([{ scheme: 'incursion', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const secretBox = {
    get available() { return safeStorage.isEncryptionAvailable(); },
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64'))
};

async function tokens() {
    const s = await storage.getSettings();
    return env.resolveAll(s);
}
async function applyKeys() {
    const t = await tokens();
    api.setKeys({ curseforge: t.curseforge.value, modrinth: t.modrinth.value });
    return t;
}
async function prefs() { return (await storage.getSettings()).prefs || {}; }

// CF service URL: Settings, then INCURSION_CF_SERVICE, then package.json. Only used without a personal key.
const builtInCfService = () => { try { return require('./package.json').incursion?.cfService || ''; } catch { return ''; } };
async function cfServiceUrl() { return (await prefs()).cfService || process.env.INCURSION_CF_SERVICE || builtInCfService(); }
async function applyCfService() {
    cfproxy.setUrl(await cfServiceUrl());
    api.setProxy({ url: cfproxy.url(), getPass: cfproxy.getPass, invalidate: cfproxy.invalidate });
}
async function keyStatus(t) {
    const r = await api.testKeys({ curseforge: t.curseforge.value, modrinth: t.modrinth.value, curseforgeUpload: t.curseforgeUpload.value });
    if (!t.curseforge.value && cfproxy.url()) {
        const st = await cfproxy.status();
        r.curseforge = st.health?.ok && st.health.configured
            ? { ok: true, message: st.verified ? 'Using the Incursion CurseForge service' : 'Incursion CurseForge service (verifies on first use)' }
            : { ok: false, message: st.health?.error ? 'CurseForge service unreachable' : 'CurseForge service isn’t set up' };
        r.curseforge.service = true;
    }
    return r;
}

function overlayColors() {
    const dark = nativeTheme.shouldUseDarkColors;
    return { color: '#00000000', symbolColor: dark ? '#eef1f5' : '#192029', height: TITLEBAR_HEIGHT };
}

let splash = null;
function showSplash(dark) {
    const preview = !!process.env.INCURSION_SPLASH_PREVIEW;
    if (process.env.INCURSION_HIDDEN && !preview) return;
    const bg = dark ? '#10141a' : '#f8fafd';
    let svg = '';
    try { svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8'); } catch {}
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>html,body{margin:0;height:100%;background:${bg};overflow:hidden;-webkit-user-select:none;cursor:default}
body{display:grid;place-items:center}.i{width:112px;height:112px;animation:in .5s cubic-bezier(.2,.8,.2,1) both}.i svg{width:100%;height:100%;display:block}
@keyframes in{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}</style></head><body><div class="i">${svg}</div></body></html>`;
    splash = new BrowserWindow({
        width: 1320, height: 860, frame: false, resizable: false, movable: true, show: false, backgroundColor: bg,
        ...(process.platform === 'win32' ? { opacity: 0 } : {}),
        icon: path.join(__dirname, 'icon.png'), title: 'Incursion',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false }
    });
    // Windows paints a new window white for one frame regardless of backgroundColor, so start transparent and fade in.
    splash.once('ready-to-show', () => { if (!preview) return showWithoutFlash(splash); splash.setPosition(-4000, 40); splash.showInactive(); });
    splash.on('closed', () => { splash = null; });
    splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}
function showWithoutFlash(w, after = () => {}) {
    if (!w || w.isDestroyed()) return;
    if (process.platform !== 'win32') { w.show(); after(); return; }
    w.setOpacity(0);
    w.show();
    setTimeout(() => { if (!w.isDestroyed()) { w.setOpacity(1); after(); } }, 50);
}

// Swap the splash for the app window. The timeout fallback keeps a slow start from leaving only the splash up.
let revealed = false;
function revealMain() {
    if (revealed || !win || win.isDestroyed()) return;
    revealed = true;
    if (process.env.INCURSION_HIDDEN) { win.setPosition(-4000, 40); win.showInactive(); return; }
    if (splash && !splash.isDestroyed()) { const b = splash.getBounds(); win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }); }
    showWithoutFlash(win, () => { if (splash && !splash.isDestroyed()) { const s = splash; setTimeout(() => { if (!s.isDestroyed()) s.destroy(); }, 80); } });
}

function createWindow() {
    win = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 720,
        minHeight: 560,
        show: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#10141a' : '#f8fafd',
        titleBarStyle: 'hidden',
        ...(isMac ? { trafficLightPosition: { x: 18, y: 18 } } : { titleBarOverlay: overlayColors() }),
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            backgroundThrottling: !process.env.INCURSION_HIDDEN,
            additionalArguments: [`--incursion-theme=${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`]
        }
    });

    win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    // Only ever load the app itself. Any other page would get the preload bridge, so http(s) goes to the browser and
    // the rest is blocked.
    const appUrl = require('url').pathToFileURL(path.join(__dirname, 'index.html')).toString();
    win.webContents.on('will-navigate', (e, url) => { if (url.split('#')[0] !== appUrl) { e.preventDefault(); openExternal(url); } });
    win.webContents.on('will-attach-webview', (e) => e.preventDefault());

    if (process.env.INCURSION_DEV) {
        win.webContents.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools(); });
    }
    win.once('ready-to-show', () => setTimeout(revealMain, process.env.INCURSION_HIDDEN ? 0 : 15000));
    win.on('closed', () => { win = null; });
    win.loadFile('index.html');
}

function openExternal(url) {
    try {
        const u = new URL(url);
        if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.toString());
    } catch {}
}

const send = (type, payload) => { if (win && !win.isDestroyed()) win.webContents.send('event', { type, payload }); };
packs.setEmitter(send);
webpage.setEmitter(send);
nativeTheme.on('updated', () => {
    if (win && !isMac) win.setTitleBarOverlay(overlayColors());
    send('theme', { dark: nativeTheme.shouldUseDarkColors });
});

// Handlers return { ok, data } or { ok: false, error } so the renderer never gets a raw rejection.
function handle(channel, fn) {
    ipcMain.handle(channel, async (_e, payload) => {
        try { return { ok: true, data: await fn(payload || {}) }; }
        catch (err) {
            console.error(`[${channel}]`, err.message);
            return { ok: false, error: err.message, code: err.code, extra: err.major ? { major: err.major } : undefined };
        }
    });
}

let taskSeq = 0;
function task(label) {
    const id = `m${++taskSeq}`;
    const t = {
        update: (progress, detail) => send('task', { id, label, progress, detail, state: 'running' }),
        done: (detail) => send('task', { id, label, progress: 1, detail, state: 'done' }),
        fail: (detail) => send('task', { id, label, progress: 1, detail, state: 'error' })
    };
    t.update(null);
    return t;
}

handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, dark: nativeTheme.shouldUseDarkColors, encrypted: secretBox.available, dev: !!process.env.INCURSION_DEV, firstRun, prefs: await prefs() }));
handle('app:theme', async ({ theme }) => {
    nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
    await storage.saveSettings({ theme: nativeTheme.themeSource });
    return { dark: nativeTheme.shouldUseDarkColors };
});
handle('settings:prefs', async (patch) => {
    const allowed = ['accent', 'background', 'customBackgrounds', 'dim', 'blur', 'glass', 'motion', 'javaMode', 'jvmArgs', 'memoryMax', 'autoUpdate', 'autoUpdateHours', 'shareLinks', 'manualLinksFirst', 'linksNoticeSeen'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    for (const k of ['shareLinks', 'manualLinksFirst', 'linksNoticeSeen']) if (k in clean) clean[k] = !!clean[k];
    await storage.saveSettings({ prefs: clean });
    const next = await prefs();
    applyLinkPrefs(next);
    if (clean.manualLinksFirst !== undefined) api.clearSearches();
    // Turning sharing off drops unsent votes.
    if (clean.shareLinks === false) await votes.clear();
    else if (linkPrefs.shareLinks && linkPrefs.linksNoticeSeen) votes.schedule(2000);
    return next;
});
handle('dialog:background', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a background image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (r.canceled) return null;
    const img = nativeImage.createFromPath(r.filePaths[0]);
    if (img.isEmpty()) throw new Error('That image could not be read.');
    const { width } = img.getSize();
    const scaled = width > 2560 ? img.resize({ width: 2560, quality: 'best' }) : img;
    const buf = scaled.toJPEG(88);
    const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}.jpg`;
    await fs.outputFile(path.join(app.getPath('userData'), 'backgrounds', name), buf);
    return `incursion://background/${name}`;
});

handle('settings:get', async () => {
    const s = await storage.getSettings();
    const t = env.resolveAll(s);
    const mask = (k) => (k ? `${'•'.repeat(8)}${k.slice(-4)}` : '');
    const view = (k) => ({ set: !!t[k].value, masked: mask(t[k].value), source: t[k].source, saved: !!s[k] });
    return { theme: s.theme, prefs: s.prefs, curseforge: view('curseforge'), curseforgeUpload: view('curseforgeUpload'), modrinth: view('modrinth'), encrypted: secretBox.available };
});
// Validate keys before saving. If the platform is unreachable, save anyway and flag it as unchecked.
const KEY_LABELS = { curseforge: 'CurseForge API key', curseforgeUpload: 'CurseForge upload token', modrinth: 'Modrinth token' };
handle('settings:keys', async (keys) => {
    const patch = {};
    for (const k of storage.SECRET_KEYS) if (typeof keys[k] === 'string') patch[k] = keys[k].trim();
    const toTest = Object.fromEntries(Object.entries(patch).filter(([, v]) => v));
    let warning = null;
    if (Object.keys(toTest).length) {
        const checked = await api.testKeys(toTest);
        for (const [k, res] of Object.entries(checked)) {
            if (res.invalid) throw Object.assign(new Error(`${KEY_LABELS[k]} not saved: ${res.message}.`), { code: 'KEY_INVALID' });
            if (!res.ok) warning = `${KEY_LABELS[k]} saved, but it couldn’t be checked: ${res.message}.`;
        }
    }
    await storage.saveSettings(patch);
    const t = await applyKeys();
    const status = await keyStatus(t);
    if (warning) status.warning = warning;
    return status;
});
handle('settings:check', async () => keyStatus(await applyKeys()));

handle('cfservice:status', async () => ({ ...(await cfproxy.status()), url: undefined, builtIn: !!builtInCfService(), custom: (await prefs()).cfService || '', ownKey: !!(await tokens()).curseforge.value }));
handle('cfservice:set', async ({ url }) => {
    const clean = url ? cfproxy.normalize(url) : '';
    if (url && !clean) throw new Error('Use an https:// address (http:// only for a Worker running on this computer).');
    await storage.saveSettings({ prefs: { cfService: clean || null } });
    await applyCfService();
    return cfproxy.status();
});
handle('cfservice:verify', async () => { await cfproxy.getPass(true); return cfproxy.status(); });
handle('cfservice:forget', async () => { await cfproxy.forget(); return cfproxy.status(); });

handle('cache:stats', async () => ({ ...(await cache.stats()), limiters: api.stats() }));
handle('cache:clear', async () => { await cache.clear(); return cache.stats(); });

handle('versions:game', ({ force }) => api.getGameVersions({ force }));
handle('versions:loader', ({ loader, gameVersion, force }) => api.getLoaderVersions({ loader, gameVersion, force }));

handle('java:list', ({ force }) => java.detect({ force }));
handle('java:required', ({ gameVersion }) => java.requiredMajor(gameVersion));
handle('java:install', async ({ major }) => {
    const t = task(`Downloading Java ${major}`);
    try { const j = await java.install(Number(major), (p) => t.update(p)); t.done(`Temurin ${j.version}`); return j; }
    catch (err) { t.fail(err.message); throw err; }
});
handle('java:uninstall', ({ major }) => java.uninstall(Number(major)));
handle('java:dir', async () => shell.openPath(java.managedDir()));

// A fresh profile asks where game files should go before anything is written there.
let firstRun = false;
async function initDataDir() {
    const { prefs: p } = await storage.getSettings();
    let dir = p.dataDir || null;
    const legacy = datadir.legacyRoot();
    if (!dir && legacy && await datadir.hasGameFiles(legacy)) {
        dir = legacy;
        await storage.saveSettings({ prefs: { dataDir: dir } });
    }
    datadir.set(dir);
    if (p.setupDone) return;
    const fresh = !(await storage.getLibrary()).length && !(await fs.pathExists(datadir.get()));
    if (fresh) firstRun = true;
    else await storage.saveSettings({ prefs: { setupDone: true } });
}
handle('app:setup-done', async () => {
    firstRun = false;
    await storage.saveSettings({ prefs: { setupDone: true } });
    return true;
});

const dataInfo = async () => ({ path: datadir.get(), defaultPath: datadir.defaultRoot(), isDefault: datadir.isDefault() });
handle('data:info', dataInfo);
handle('data:inspect', ({ dir }) => datadir.inspect(dir));
handle('data:set-dir', async ({ dir, move }) => {
    if (launcher.busy()) throw Object.assign(new Error('Close the running game first. Its files are in use.'), { code: 'BUSY' });
    const from = datadir.get();
    const to = dir ? path.resolve(dir) : datadir.defaultRoot();
    if (!path.isAbsolute(to)) throw new Error('Pick a full folder path.');
    if (path.resolve(to) === path.resolve(from)) return dataInfo();
    const rel = path.relative(from, to);
    if (move && rel && !rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('The new folder can’t be inside the current one when moving files.');
    const relBack = path.relative(to, from);
    if (move && relBack && !relBack.startsWith('..') && !path.isAbsolute(relBack)) throw new Error('The current folder can’t be inside the new one when moving files.');
    await fs.ensureDir(to);
    let skipped = [];
    if (move) {
        const t = task('Moving Game Files');
        try { skipped = await datadir.moveContents(from, to, (p, name) => t.update(p, name)); t.done(skipped.length ? `${skipped.length} kept in the old folder` : to); }
        catch (err) { t.fail(err.message); throw err; }
    }
    datadir.set(dir ? to : null);
    await storage.saveSettings({ prefs: { dataDir: dir ? to : null } });
    java.refreshRoot();
    return { ...(await dataInfo()), skipped };
});

const gameDirOf = async (p) => launcher.gameDirFor((await packs.load(p)).meta);
handle('backups:list', async ({ path: p }) => {
    const gameDir = await gameDirOf(p);
    return { dir: backups.dirFor(gameDir), present: await backups.present(gameDir), list: await backups.list(gameDir) };
});
handle('backups:create', async ({ path: p }) => {
    const { meta } = await packs.load(p);
    const t = task(`Backing up ${meta.name}`);
    try { const b = await backups.create(launcher.gameDirFor(meta), { packName: meta.name, reason: 'manual' }, (x) => t.update(x)); t.done(b.name); return b; }
    catch (err) { t.fail(err.message); throw err; }
});
handle('backups:restore', async ({ path: p, name }) => {
    if (launcher.packBusy(p)) throw new Error('Close the game first: its worlds are in use.');
    const { meta } = await packs.load(p);
    const t = task(`Restoring ${meta.name}`);
    try { const r = await backups.restore(launcher.gameDirFor(meta), name, { packName: meta.name }, (x) => t.update(x)); t.done(r.safety ? 'Previous state kept as a backup' : ''); return r; }
    catch (err) { t.fail(err.message); throw err; }
});
handle('backups:delete', async ({ path: p, name }) => {
    const file = path.join(backups.dirFor(await gameDirOf(p)), path.basename(name));
    await shell.trashItem(file);
    return true;
});
handle('backups:reveal', async ({ path: p }) => {
    const dir = backups.dirFor(await gameDirOf(p));
    await fs.ensureDir(dir);
    return shell.openPath(dir);
});

handle('web:open', ({ url, bounds }) => webpage.open(win, url, bounds));
handle('web:bounds', ({ bounds }) => { webpage.setBounds(bounds); return true; });
handle('web:nav', ({ action }) => webpage.nav(action));
handle('web:close', () => webpage.close());

handle('dialog:folder', async ({ title }) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
});
handle('dialog:icon', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a pack icon', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (r.canceled) return null;
    const img = nativeImage.createFromPath(r.filePaths[0]);
    if (img.isEmpty()) throw new Error('That image could not be read.');
    // Crop and downscale icons so they don't bloat every JSON file as data URLs.
    const { width, height } = img.getSize();
    const side = Math.min(width, height);
    const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
    return square.resize({ width: 256, height: 256, quality: 'best' }).toDataURL();
});
handle('dialog:java', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a Java executable', properties: ['openFile'], filters: isMac || process.platform === 'linux' ? [] : [{ name: 'Java', extensions: ['exe'] }] });
    if (r.canceled) return null;
    const j = await java.probe(path.dirname(path.dirname(r.filePaths[0])));
    if (!j) throw new Error('That is not a working Java installation.');
    return j;
});
handle('shell:open', async ({ url }) => openExternal(url));
// Reveal files instead of opening them, since opening could run them.
handle('shell:reveal', async ({ path: p }) => {
    const stat = await fs.stat(String(p || '')).catch(() => null);
    if (!stat) throw new Error('That folder no longer exists.');
    if (!stat.isDirectory()) return shell.showItemInFolder(path.resolve(p));
    return shell.openPath(path.resolve(p));
});

handle('packs:library', () => packs.library());
handle('packs:create', (info) => packs.create(info));
handle('packs:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open a pack folder', properties: ['openDirectory'] });
    if (r.canceled) return null;
    return packs.import(r.filePaths[0]);
});
handle('packs:forget', ({ path: p }) => packs.forget(p));
handle('packs:load', ({ path: p }) => packs.load(p));
handle('packs:info', ({ path: p, fields }) => packs.updateInfo(p, fields));
handle('packs:add', ({ path: p, items }) => packs.addMods(p, items));
handle('packs:remove', ({ path: p, keys }) => packs.removeMods(p, keys));
handle('packs:check', ({ path: p, keys }) => packs.checkUpdates(p, { keys }));
handle('packs:apply', ({ path: p, keys, platforms }) => packs.applyUpdates(p, keys, Array.isArray(platforms) ? { platforms: platforms.filter(x => x === 'curseforge' || x === 'modrinth') } : {}));
handle('packs:redownload', ({ path: p, keys, mode }) => packs.redownload(p, { keys, mode }));
handle('packs:sync', ({ path: p }) => packs.sync(p));
handle('packs:versions', async ({ path: p, key, platform }) => {
    const { meta } = await packs.load(p);
    const mod = meta.mods.find(m => api.modKey(m) === String(key));
    if (!mod?.ids[platform]) throw new Error('That mod is not on this platform.');
    return api.listVersions({ platform, id: mod.ids[platform], gameVersion: meta.gameVersion, loader: meta.loader, type: mod.type });
});
handle('packs:set-version', ({ path: p, key, platform, versionId, pin }) => packs.setVersion(p, key, { platform, versionId, pin }));
handle('packs:mod-meta', ({ path: p, keys, patch }) => packs.modMeta(p, keys, patch));
handle('packs:disable', ({ path: p, keys, disabled }) => {
    if (launcher.packBusy(p)) throw new Error('Close the game before turning mods on or off.');
    return packs.setDisabled(p, Array.isArray(keys) ? keys : [], !!disabled);
});
handle('packs:deps', ({ path: p }) => packs.dependencies(p));
handle('packs:untracked', ({ path: p }) => packs.reviewUntracked(p));
handle('packs:untracked-refresh', ({ path: p }) => packs.refreshUntracked(p));
handle('packs:adopt', ({ path: p, ids, choices }) => packs.adoptUntracked(p, ids, choices));
handle('packs:manual-file', async ({ path: p, key, platform, source }) => {
    if (source !== 'file') return packs.setManualFile(p, key, platform, { source: 'copy' });
    const r = await dialog.showOpenDialog(win, { title: 'Choose the mod file', properties: ['openFile'], filters: [{ name: 'Mod files', extensions: ['jar', 'zip'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return packs.setManualFile(p, key, platform, { source: 'file', file: r.filePaths[0] });
});
handle('packs:manual-remove', ({ path: p, key, platform }) => packs.removeManualFile(p, key, platform));
// Leftover jars go to the trash, never a hard delete. Plain names inside a platform mods folder only.
handle('packs:trash-jars', async ({ path: p, files: list }) => {
    for (const f of list || []) {
        if (!['modrinth', 'curseforge'].includes(f.platform) || path.basename(f.name) !== f.name || !/\.jar$/i.test(f.name)) throw new Error('Not a jar in this pack.');
        await shell.trashItem(path.join(storage.paths.modsDir(p, f.platform), f.name));
    }
    return packs.refreshUntracked(p);
});
handle('packs:merge', ({ path: p, keys }) => packs.mergeMods(p, keys));
handle('packs:release', ({ path: p, version, notes, dryRun }) => packs.release(p, { version, notes, dryRun }));
handle('packs:export', async ({ path: p, kind }) => {
    const r = await dialog.showOpenDialog(win, { title: 'Export to…', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    return packs.exportPack(p, kind, r.filePaths[0]);
});

handle('import:pick', async ({ kind }) => {
    const r = kind === 'folder'
        ? await dialog.showOpenDialog(win, { title: 'Choose a mods folder or game folder', properties: ['openDirectory'] })
        : kind === 'instance'
            ? await dialog.showOpenDialog(win, { title: 'Choose a Prism Launcher, MultiMC or packwiz folder', properties: ['openDirectory'] })
            : await dialog.showOpenDialog(win, { title: 'Choose a modpack file', properties: ['openFile'], filters: [{ name: 'Modpacks', extensions: ['mrpack', 'zip'] }] });
    if (r.canceled) return null;
    return { source: r.filePaths[0], info: await importer.inspect(r.filePaths[0]) };
});
handle('import:link', async ({ url }) => {
    const r = await api.modpackFromLink(url);
    if (r.packwiz) return { source: r.packwiz, info: await importer.inspect(r.packwiz) };
    const dest = path.join(app.getPath('userData'), 'imports', storage.safeFileName(r.fileName || 'modpack.mrpack'));
    const t = task(`Downloading ${r.title || r.fileName}`);
    try { await storage.download(r.url, dest, { sha1: r.sha1, onBytes: () => {} }); t.done(r.fileName); }
    catch (err) { t.fail(err.message); throw err; }
    return { source: dest, info: await importer.inspect(dest) };
});
handle('import:run', async (opts) => {
    const t = task(`Importing ${opts.name || 'Pack'}`);
    try {
        const r = await importer.importPack(opts, (p, detail) => t.update(p, detail));
        t.done(`${r.imported} mods${r.unknown.length ? `, ${r.unknown.length} unmatched` : ''}`);
        return r;
    } catch (err) { t.fail(err.message); throw err; }
});

async function rootFor(packPath, root) {
    const { meta } = await packs.load(packPath);
    if (root === 'game') return launcher.gameDirFor(meta);
    return meta.path;
}
handle('files:list', async ({ pack, root, path: rel }) => files.list(await rootFor(pack, root), rel));
handle('files:read', async ({ pack, root, path: rel }) => files.read(await rootFor(pack, root), rel));
handle('files:write', async ({ pack, root, path: rel, text, mtime, force }) => files.write(await rootFor(pack, root), rel, text, { mtime, force }));
handle('files:create', async ({ pack, root, path: rel, dir }) => files.create(await rootFor(pack, root), rel, { dir }));
handle('files:rename', async ({ pack, root, path: rel, name }) => files.rename(await rootFor(pack, root), rel, name));
handle('files:delete', async ({ pack, root, path: rel }) => files.remove(await rootFor(pack, root), rel));
handle('files:reveal', async ({ pack, root, path: rel }) => shell.showItemInFolder(files.within(await rootFor(pack, root), rel || '.')));
handle('files:to-overrides', async ({ pack, path: rel }) => {
    const { meta } = await packs.load(pack);
    return files.copyToOverrides(launcher.gameDirFor(meta), meta.path, rel);
});

handle('publish:check', async ({ path: p }) => {
    const { meta } = await packs.load(p);
    const t = await tokens();
    return publisher.check({ meta, tokens: { modrinth: t.modrinth.value, curseforgeUpload: t.curseforgeUpload.value } });
});
handle('publish:run', async ({ path: p, targets, release, serverPack, notes, dryRun }) => {
    const { meta } = await packs.load(p);
    const t = await tokens();
    const job = task(dryRun ? 'Preparing Upload' : `Publishing ${meta.name} ${release.version}`);
    try {
        const r = await publisher.publish({ meta, tokens: { modrinth: t.modrinth.value, curseforgeUpload: t.curseforgeUpload.value }, targets, release, serverPack, dryRun }, (target, prog) => job.update(prog, target === 'modrinth' ? 'Modrinth' : 'CurseForge'));
        if (!dryRun) {
            if (!(meta.releases || []).some(x => x.version === release.version)) await packs.release(p, { version: release.version, notes: notes || '' });
            const published = {};
            if (r.modrinth?.ok) published.modrinth = { versionId: r.modrinth.id, url: r.modrinth.url };
            if (r.curseforge?.ok) published.curseforge = { fileId: r.curseforge.id, url: r.curseforge.url };
            if (serverPack) published.serverPack = { sidedness: serverPack.sidedness, modrinth: r.modrinth?.serverPack || null, curseforge: r.curseforge?.serverPack || null };
            published.versionType = release.versionType || 'release';
            await packs.recordPublished(p, release.version, published);
        }
        const spFailed = Object.values(r).map(x => x?.serverPack).filter(x => x && x.ok === false);
        if (spFailed.length) job.fail(`Published, but the server pack failed: ${spFailed[0].error}`);
        else job.done(dryRun ? 'Ready' : 'Published');
        return r;
    } catch (err) { job.fail(err.message); throw err; }
});
handle('publish:server', async ({ path: p, version, targets, sidedness, dryRun, checkOnly }) => {
    const { meta } = await packs.load(p);
    const rel = (meta.releases || []).find(x => x.version === version);
    if (!rel) throw new Error(`There is no release ${version}.`);
    const ids = { modrinth: rel.published?.modrinth?.versionId, curseforge: rel.published?.curseforge?.fileId };
    const changes = require('./util/insights').diff(rel.mods, meta);
    const changed = changes.added.length + changes.removed.length + changes.updated.length;
    if (checkOnly) return { changed, ids };
    if (dryRun) {
        const t = await tokens();
        const r = await publisher.publishServerPack({ meta, tokens: { modrinth: t.modrinth.value, curseforgeUpload: t.curseforgeUpload.value }, targets, release: { version, versionType: rel.published?.versionType, changelog: '' }, ids, sidedness, dryRun: true });
        return { ...r, changed, ids };
    }
    const missing = targets.filter(x => !ids[x]);
    if (missing.length) throw new Error(`Version ${version} wasn’t published to ${missing.map(x => (x === 'modrinth' ? 'Modrinth' : 'CurseForge')).join(' or ')} from Incursion, so there is nothing to attach the server pack to.`);
    const t = await tokens();
    const job = task(`Publishing ${meta.name} ${version} Server Pack`);
    try {
        const r = await publisher.publishServerPack({ meta, tokens: { modrinth: t.modrinth.value, curseforgeUpload: t.curseforgeUpload.value }, targets, release: { version, versionType: rel.published?.versionType, changelog: `Server pack for ${meta.name} ${version}.` }, ids, sidedness }, (target, prog) => job.update(prog, target === 'modrinth' ? 'Modrinth' : 'CurseForge'));
        await packs.recordPublished(p, version, { serverPack: { ...(rel.published?.serverPack || {}), sidedness, ...r } });
        job.done('Published');
        return r;
    } catch (err) { job.fail(err.message); throw err; }
});
handle('packs:server-preview', ({ path: p, mode }) => packs.serverPreview(p, mode));

handle('mods:search', async (params) => {
    // Warm-ups never trigger the Cloudflare check: no pass means no CurseForge here.
    if (params?.warm && api.usingProxy() && params.platform !== 'modrinth' && !(await cfproxy.hasPass())) return null;
    return api.search({ ...params, meta: params?.path ? await packs.metaOf(params.path) : null });
});
handle('mods:changelog', async ({ path: p, key, platform, offset }) => {
    const snap = await packs.load(p);
    const m = snap.meta.mods.find(x => api.modKey(x) === String(key));
    if (!m) throw new Error('That item is no longer in the pack.');
    const pl = platform === 'curseforge' && m.ids.curseforge ? 'curseforge' : m.ids.modrinth ? 'modrinth' : 'curseforge';
    const r = await api.changelogs({ platform: pl, id: m.ids[pl], gameVersion: snap.meta.gameVersion, loader: snap.meta.loader, type: m.type, offset });
    const upd = snap.updates[String(key)]?.[pl];
    return { ...r, platform: pl,
        installedId: pl === 'modrinth' ? m.meta?.mrVersionId || null : Number(m.meta?.cfFileId) || null,
        installedDate: pl === 'modrinth' ? m.meta?.mrDate || null : null,
        updateId: upd ? (pl === 'modrinth' ? upd.versionId : upd.fileId) : null };
});
// With sharing on, manual links also become anonymous votes. The first time, show what gets shared before sending.
const VOTE_TYPES = new Set(['mod', 'resourcepack', 'shader', 'datapack']);
function voteFor(type, platform, id, to, clear = false) {
    if (!VOTE_TYPES.has(type)) return null;
    const side = platform === 'curseforge' ? 'cf' : 'mr';
    const pid = side === 'cf' ? Number(id) : String(id);
    if (clear) return { type, op: 'clear', side, id: pid };
    if (to == null) return { type, op: 'none', side, id: pid };
    return side === 'cf' ? { type, op: 'link', cf: pid, mr: String(to) } : { type, op: 'link', cf: Number(to), mr: pid };
}
async function shareVote(v) {
    if (!v || !linkPrefs.shareLinks) return;
    await votes.record(v);
    if (!linkPrefs.linksNoticeSeen) send('notice', { kind: 'links-sharing' });
}
handle('links:set', async ({ path: p, platform, id, to, title, type }) => {
    const r = await packs.linkMod(p || null, { platform, id, to, title, type });
    await shareVote(voteFor(r.type || type || 'mod', platform, id, to)).catch(() => {});
    return r;
});
handle('links:clear', async ({ path: p, platform, id, type }) => {
    const r = await packs.unlinkMod(p || null, { platform, id });
    await shareVote(voteFor(type || 'mod', platform, id, null, true)).catch(() => {});
    return r;
});
handle('links:info', ({ path: p, platform, id, type }) => packs.linkInfo(p || null, { platform, id, type }));
handle('community:status', async () => ({ ...community.status(), sharing: linkPrefs.shareLinks, manualFirst: linkPrefs.manualLinksFirst, noticeSeen: linkPrefs.linksNoticeSeen, waiting: await votes.pending() }));
handle('community:refresh', async () => { await community.refresh({ force: true }); api.clearSearches(); return { ...community.status(), waiting: await votes.pending() }; });
handle('links:settle', ({ path: p, cf, mr, choice }) => packs.settleLink(p, { cf, mr, choice }));

handle('play:accounts', () => launcher.accounts());
handle('play:login', () => launcher.login());
handle('play:repair', async ({ path: p }) => {
    const meta = await packs.metaOf(p);
    const t = task(`Repairing Game Files for ${meta.name}`);
    try {
        const r = await launcher.repair(meta, (prog, detail) => t.update(prog, detail));
        t.done(`${r.versions.length ? 'Reinstalls on the next Play' : 'Nothing installed yet'}${r.libraries + r.assets ? ` · ${r.libraries + r.assets} damaged files removed` : ''}`);
        return r;
    } catch (err) { t.fail(err.message); throw err; }
});
handle('play:login-offline', ({ name }) => launcher.loginOffline(name));
handle('play:select', ({ uuid }) => launcher.selectAccount(uuid));
handle('play:logout', ({ uuid, forgetBrowser }) => launcher.logout(uuid, { forgetBrowser }));
handle('play:list', () => launcher.list());
handle('play:launch', async ({ path: p }) => {
    const { meta } = await packs.load(p);
    const pr = await prefs();
    return launcher.launch(profiles.apply(meta, meta.launch?.profile), { memoryMax: pr.memoryMax, jvmArgs: pr.jvmArgs, javaMode: pr.javaMode });
});
handle('play:analyse', async ({ id }) => {
    const sum = launcher.list().find(i => i.id === id);
    if (!sum) throw new Error('That game session is gone.');
    const { meta } = await packs.load(sum.packPath);
    return launcher.analyse(id, meta);
});
handle('play:stop', ({ id, force }) => launcher.stop(id, { force: !!force }));
handle('play:subscribe', ({ id }) => launcher.subscribe(id));
handle('play:unsubscribe', ({ id }) => launcher.unsubscribe(id));
handle('play:clear', () => launcher.clearFinished());
handle('play:folder', async ({ id, what }) => {
    const dir = launcher.gameDir(id);
    if (!dir) throw new Error('That instance is gone.');
    const target = what === 'crash' ? path.join(dir, 'crash-reports') : what === 'logs' ? path.join(dir, 'logs') : dir;
    return shell.openPath(target);
});

app.on('second-instance', () => {
    const w = win && !win.isDestroyed() && revealed ? win : splash;
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
});
handle('app:ready', () => { setTimeout(revealMain, 60); return true; });

// Incursion never needs the camera, microphone, location or notifications. Only the app window may copy to the clipboard.
app.on('session-created', (ses) => ses.setPermissionRequestHandler((_wc, permission, cb) => cb(false)));

app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
    const userData = app.getPath('userData');
    const { cacheFile } = storage.init(userData, secretBox);
    const theme = (await storage.getSettings()).theme || 'system';
    showSplash(theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors));
    await cache.init(cacheFile);
    await initDataDir();
    java.init(userData);
    files.init({ trashItem: (p) => shell.trashItem(p) });
    const bgDir = path.join(userData, 'backgrounds');
    protocol.handle('incursion', (req) => {
        const u = new URL(req.url);
        const name = path.basename(decodeURIComponent(u.pathname));
        if (u.host !== 'background' || !/^[\w.-]+$/.test(name)) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(path.join(bgDir, name)).toString());
    });
    await applyKeys();
    cfproxy.init({ userData, parent: () => win, hiddenWindows: !!process.env.INCURSION_HIDDEN });
    await applyCfService();
    applyLinkPrefs(await prefs());
    const pkg = require('./package.json').incursion || {};
    community.init({ userData, repo: pkg.linksRepo, publicKey: pkg.linksPublicKey });
    votes.init({ userData, serviceUrl: () => cfproxy.url(), account: () => launcher._activeAccount(), enabled: () => linkPrefs.shareLinks, noticeSeen: () => linkPrefs.linksNoticeSeen });
    if (!process.env.INCURSION_HIDDEN) {
        community.refresh().then(() => api.clearSearches()).catch(() => {});
        votes.schedule(30000);
    }
    const s = await storage.getSettings();
    nativeTheme.themeSource = s.theme || 'system';
    launcher.init({ userData, emitter: send, windowGetter: () => win, secretBox, offline: !!process.env.INCURSION_DEV });
    createWindow();
    if (!process.env.INCURSION_HIDDEN) scheduler.start({ packs, launcher, getPrefs: prefs, emit: send });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

let flushed = false;
app.on('before-quit', (e) => {
    if (flushed) return;
    e.preventDefault();
    Promise.all([packs.flushAll(), cache.flush(), links.flush()]).finally(() => { flushed = true; app.quit(); });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
