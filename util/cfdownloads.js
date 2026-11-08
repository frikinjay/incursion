// CurseForge files whose authors block app downloads. Incursion opens the file's download page in its own viewer; the
// download lands in the user's Downloads folder as usual and is then moved into every pack waiting for it.
//
// Two ways a file is picked up, so a missed event doesn't leave the user stuck:
//   - the viewer's own download (will-download on its session), saved straight to Downloads, and
//   - a watch on Downloads (fs.watch plus a scan every few seconds), for files downloaded in a regular browser or
//     before Incursion was asked.
// A file only counts when its name is the expected one (a browser's " (1)" suffix is fine) and, when CurseForge
// lists it, its SHA-1 matches. Anything else in Downloads is never touched.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const downloads = require('./downloads');
const log = require('./log').scope('cf-download');

const SCAN_EVERY = 4000;
const EXPIRE = 6 * 60 * 60 * 1000;

let cfg = null;
const waiting = new Map();
const handling = new Set();
const active = new Set();
const checked = new Map();
const hooked = new WeakSet();
let watcher = null, timer = null;

const keyOf = (e) => `${e.packPath}|${e.key}`;
const norm = (n) => String(n || '').toLowerCase();
// "gouge-1.8.jar" also matches "gouge-1.8 (1).jar" and "gouge-1.8(2).jar".
function nameFits(found, expected) {
    const f = norm(found), x = norm(expected);
    if (f === x) return true;
    const ext = path.extname(x);
    const stem = x.slice(0, x.length - ext.length);
    return f.startsWith(stem) && f.endsWith(ext) && /^ ?\(\d+\)$/.test(f.slice(stem.length, f.length - ext.length));
}

async function sha1(file) {
    const hash = crypto.createHash('sha1');
    await new Promise((resolve, reject) => fs.createReadStream(file).on('data', d => hash.update(d)).on('end', resolve).on('error', reject));
    return hash.digest('hex');
}

function view() {
    return [...waiting.values()].map(({ packPath, key, title, fileName }) => ({ packPath, key, title, fileName }));
}
const changed = () => cfg?.emit('cf-downloads', { waiting: view() });

// e: { packPath, key, title, fileName, sha1, fileId }
function expect(e) {
    if (!cfg || !e?.fileName || !/\.(jar|zip)$/i.test(e.fileName)) return;
    const k = keyOf(e);
    const prev = waiting.get(k);
    waiting.set(k, { ...e, sha1: e.sha1 ? String(e.sha1).toLowerCase() : null, since: prev?.since || Date.now() });
    if (!prev) log.info(`Waiting for ${e.fileName} (${e.title || e.key})`);
    watch();
    changed();
    scan().catch(() => {});
}

function forget(packPath, key) {
    if (waiting.delete(`${packPath}|${key}`)) { changed(); if (!waiting.size) unwatch(); }
}

function matches(fileName) {
    return [...waiting.values()].filter(e => nameFits(fileName, e.fileName));
}

// Hashes the file and hands it to every pack whose expectation it fits. Removes it from Downloads only once each
// matching pack has its own copy.
async function take(file, { quiet = false } = {}) {
    const resolved = path.resolve(file);
    if (handling.has(resolved)) return false;
    const candidates = matches(path.basename(file));
    if (!candidates.length) return false;
    handling.add(resolved);
    try {
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isFile() || !stat.size) return false;
        const got = await sha1(resolved);
        const fits = candidates.filter(e => !e.sha1 || e.sha1 === got);
        if (!fits.length) {
            log.warn(`${path.basename(file)} is in Downloads but isn’t the file CurseForge lists (SHA-1 ${got.slice(0, 10)}…); leaving it there`);
            if (!quiet) cfg.emit('cf-download', { ok: false, fileName: path.basename(file), error: `${path.basename(file)} doesn’t match the file CurseForge lists, so it wasn’t added. Download it again.` });
            return false;
        }
        let placed = 0;
        for (const e of fits) {
            try {
                const ok = await cfg.place(e, resolved);
                waiting.delete(keyOf(e));
                if (ok) { placed++; cfg.emit('cf-download', { ok: true, packPath: e.packPath, key: e.key, title: e.title, fileName: e.fileName }); }
            } catch (err) {
                log.warn(`Couldn’t add ${e.fileName} to ${e.packPath}:`, err.message);
                cfg.emit('cf-download', { ok: false, packPath: e.packPath, key: e.key, title: e.title, fileName: e.fileName, error: err.message });
            }
        }
        if (placed && placed === fits.length) {
            await removeRetry(resolved);
            log.info(`Moved ${path.basename(file)} from Downloads into ${placed === 1 ? 'the pack' : `${placed} packs`}`);
        }
        changed();
        if (!waiting.size) unwatch();
        return placed > 0;
    } finally { handling.delete(resolved); }
}

async function removeRetry(file) {
    for (let i = 0; i < 6; i++) {
        try { await fs.remove(file); return; }
        catch (err) { if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) return; await new Promise(r => setTimeout(r, 500 * (i + 1))); }
    }
    log.warn(`Couldn’t remove ${file} from Downloads; it’s in the pack anyway`);
}

// Only finished files: browsers write to .crdownload/.part first, and a size that's still changing means it isn't done.
const sizes = new Map();
async function scan() {
    if (!waiting.size) return;
    const now = Date.now();
    for (const [k, e] of waiting) if (now - e.since > EXPIRE) waiting.delete(k);
    const dir = cfg.downloadsDir();
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names) {
        if (/\.(crdownload|part|tmp|download)$/i.test(name) || !matches(name).length) continue;
        const file = path.join(dir, name);
        const st = await fs.stat(file).catch(() => null);
        if (!st?.isFile()) continue;
        if (active.has(path.resolve(file))) continue;
        const now2 = `${st.size}:${st.mtimeMs}`;
        if (sizes.get(file) !== now2) { sizes.set(file, now2); continue; }
        if (checked.get(file) === now2) continue;
        checked.set(file, now2);
        await take(file, { quiet: true }).catch((err) => log.warn('Couldn’t check a download:', err.message));
    }
}

function watch() {
    if (timer) return;
    timer = setInterval(() => scan().catch(() => {}), SCAN_EVERY);
    timer.unref?.();
    try {
        watcher = fs.watch(cfg.downloadsDir(), { persistent: false }, () => { clearTimeout(watch.soon); watch.soon = setTimeout(() => scan().catch(() => {}), 800); });
        watcher.on('error', () => { watcher?.close(); watcher = null; });
    } catch { watcher = null; }
}

function unwatch() {
    clearInterval(timer); timer = null;
    watcher?.close(); watcher = null;
    sizes.clear();
    checked.clear();
}

// The viewer's downloads. Only an expected file gets a save path; anything else keeps Electron's usual Save dialog.
function attach(ses) {
    if (hooked.has(ses)) return;
    hooked.add(ses);
    ses.on('will-download', (_e, item) => {
        const name = item.getFilename();
        if (!matches(name).length) return;
        const dir = cfg.downloadsDir();
        const dest = freeName(dir, name);
        item.setSavePath(dest);
        active.add(path.resolve(dest));
        const t = downloads.external(name, item.getURL());
        item.on('updated', () => t.progress(item.getReceivedBytes(), item.getTotalBytes()));
        item.once('done', (_ev, state) => {
            active.delete(path.resolve(dest));
            if (state !== 'completed') {
                t.fail(new Error(state === 'cancelled' ? 'Cancelled' : 'The download stopped'));
                cfg.emit('cf-download', { ok: false, fileName: name, error: state === 'cancelled' ? `The download of ${name} was cancelled.` : `${name} didn’t finish downloading. Try again.` });
                return;
            }
            t.done();
            take(dest).catch((err) => log.warn('Couldn’t add the download:', err.message));
        });
    });
}

function freeName(dir, name) {
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    for (let i = 0; ; i++) {
        const p = path.join(dir, i ? `${stem} (${i})${ext}` : name);
        if (!fs.existsSync(p)) return p;
    }
}

// opts: { downloadsDir, place(expectation, file) -> Promise<boolean>, emit }
function init(opts) { cfg = opts; }

module.exports = { init, expect, forget, attach, waiting: view, scan, _internals: { nameFits, take, waitingMap: waiting } };
