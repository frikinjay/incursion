// Updates Incursion itself from its GitHub releases. A release is only installed after its file matches the SHA-256 in
// the release's SHA256SUMS.txt, and nothing about the running app changes until that point. The verified file is
// remembered in updates/ready.json, so a crash or a "later" still installs it on the next quit or restart.
//
// How it installs:
//   - Windows: the NSIS installer, silently (/S --updated), once the app has quit. --force-run starts the new version.
//   - macOS: a detached script waits for the app to exit, copies the .app out of the DMG next to the current one and
//     swaps the two, putting the old one back if anything fails.
//   - Linux AppImage: the new AppImage replaces the current file with one rename, which a running AppImage survives.
//   - Linux .deb: a detached script runs pkexec dpkg -i after the app exits, which asks for the admin password.
// Anywhere else (a dev build, a read-only install, an unknown package) it only offers the download page.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { request } = require('./http');
const downloads = require('./downloads');
const storage = require('./storage');
const log = require('./log').scope('update');

const CHECK_EVERY = 60 * 60 * 1000;
const FIRST_CHECK = 15 * 1000;

let cfg = null;
let state = { status: 'idle' };
let timer = null;
let busy = null;
let quitInstall = null;

const emit = () => cfg?.emit('update', view());
const set = (patch) => { state = { ...state, ...patch }; emit(); };
const dir = () => path.join(cfg.userData, 'updates');
const readyFile = () => path.join(dir(), 'ready.json');

function view() {
    const { status, latest, progress, error, checkedAt, method, manualReason } = state;
    return { status, manualReason: manualReason || null, current: cfg?.version, latest: latest ? { version: latest.version, title: latest.title, notes: latest.notes, url: latest.url, date: latest.date } : null, progress: progress ?? null, error: error || null, checkedAt: checkedAt || 0, method: method || null };
}

function parse(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v || '').trim());
    return m ? m.slice(1, 4).map(Number) : null;
}
function newer(a, b) {
    const x = parse(a), y = parse(b);
    if (!x || !y) return false;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
}

// Which file this install can update itself from, and how.
function method() {
    if (!cfg.packaged) return { kind: 'manual', reason: 'This is a development build.' };
    if (process.platform === 'win32') return { kind: 'nsis', match: (n) => /\.exe$/i.test(n) && !/blockmap/i.test(n) };
    if (process.platform === 'darwin') {
        const bundle = path.resolve(process.execPath, '..', '..', '..');
        if (!bundle.endsWith('.app') || /AppTranslocation|^\/Volumes\//.test(bundle)) return { kind: 'manual', reason: 'Move Incursion to your Applications folder to get updates automatically.' };
        return { kind: 'dmg', bundle, match: (n) => /\.dmg$/i.test(n) };
    }
    if (process.platform === 'linux') {
        if (process.arch !== 'x64') return { kind: 'manual', reason: 'Releases are built for x64 only.' };
        if (process.env.APPIMAGE) return { kind: 'appimage', file: process.env.APPIMAGE, match: (n) => /\.AppImage$/i.test(n) };
        if (fs.existsSync('/var/lib/dpkg/info/incursion.list')) return { kind: 'deb', match: (n) => /amd64\.deb$|\.deb$/i.test(n) };
        return { kind: 'manual', reason: 'This install wasn’t made from an AppImage or .deb.' };
    }
    return { kind: 'manual', reason: 'This system can’t update automatically.' };
}

async function writable(p) {
    try { await fs.access(p, fs.constants.W_OK); return true; } catch { return false; }
}

async function check({ quiet = false } = {}) {
    if (busy) return view();
    if (['downloading', 'installing'].includes(state.status)) return view();
    if (!quiet || state.status === 'idle' || state.status === 'error') set({ status: state.status === 'ready' ? 'ready' : 'checking', error: null });
    try {
        const rel = await request(`${cfg.api || 'https://api.github.com'}/repos/${cfg.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, timeout: 20000, retries: 1 });
        const version = String(rel.tag_name || '').replace(/^v/, '');
        state.checkedAt = Date.now();
        if (rel.draft || rel.prerelease || !newer(version, cfg.version)) {
            if (state.status !== 'ready') set({ status: 'current', latest: null });
            else emit();
            return view();
        }
        if (state.status === 'ready' && state.latest?.version === version) { emit(); return view(); }
        const how = method();
        if (how.kind === 'dmg' && !(await writable(path.dirname(how.bundle)))) Object.assign(how, { kind: 'manual', reason: `Incursion can’t write to ${path.dirname(how.bundle)}.` });
        if (how.kind === 'appimage' && !(await writable(path.dirname(how.file)))) Object.assign(how, { kind: 'manual', reason: `Incursion can’t write to ${path.dirname(how.file)}.` });
        const assets = rel.assets || [];
        const asset = how.kind === 'manual' ? null : assets.find(a => how.match(a.name));
        const sums = assets.find(a => a.name === 'SHA256SUMS.txt');
        const latest = { version, title: rel.name || `Incursion ${version}`, notes: String(rel.body || '').slice(0, 20000), url: rel.html_url, date: rel.published_at, asset: asset && { name: asset.name, url: asset.browser_download_url, size: asset.size }, sums: sums?.browser_download_url || null };
        const kind = !asset || !sums ? 'manual' : how.kind;
        log.info(`Incursion ${version} is out (running ${cfg.version}); ${kind === 'manual' ? `manual: ${how.reason || (!asset ? 'no file for this system' : 'no checksums')}` : `installs via ${kind}`}`);
        set({ status: 'available', latest, method: kind, manualReason: kind === 'manual' ? (how.reason || 'This release has no file Incursion can install by itself.') : null, error: null });
    } catch (err) {
        log.warn('Update check failed:', err.message);
        if (state.status === 'checking') set({ status: quiet ? 'idle' : 'error', error: `Couldn’t check for updates: ${err.message}` });
    }
    return view();
}

async function sha256(file) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => fs.createReadStream(file).on('data', d => hash.update(d)).on('end', resolve).on('error', reject));
    return hash.digest('hex');
}

// SHA256SUMS.txt lists the files as built. Releases before 3.0.2 named the installer "Incursion Setup 2.9.4.exe",
// which GitHub uploads as "Incursion.Setup.2.9.4.exe", so spaces still count as dots.
function expectedSum(text, name) {
    const asUploaded = (n) => n.trim().replace(/ /g, '.');
    for (const line of String(text).split(/\r?\n/)) {
        const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
        if (m && asUploaded(m[2]) === asUploaded(name)) return m[1].toLowerCase();
    }
    return null;
}

// Downloads to <name>.part, checks size and SHA-256, then renames. Only then is ready.json written.
async function download() {
    if (busy) return busy;
    if (state.status === 'ready') return view();
    if (state.status !== 'available' || state.method === 'manual') throw new Error('There’s no update to download.');
    const { latest } = state;
    busy = (async () => {
        const folder = path.join(dir(), latest.version);
        const final = path.join(folder, latest.asset.name);
        const part = `${final}.part`;
        const t = downloads.track(`Incursion ${latest.version}`, latest.asset.url);
        set({ status: 'downloading', progress: 0, error: null });
        try {
            const sums = await request(latest.sums, { as: 'text', timeout: 30000 });
            const want = expectedSum(sums, latest.asset.name);
            if (!want) throw new Error('The release’s checksum list doesn’t include this file.');
            await fs.ensureDir(folder);
            for (const name of await fs.readdir(dir())) if (name !== latest.version && name !== 'ready.json') await fs.remove(path.join(dir(), name)).catch(() => {});
            const { size } = await downloads.fetchFile(latest.asset.url, part, {
                onProgress: (got, total) => { t.progress(got, total); set({ progress: total ? got / total : null }); },
                onRetry: (err) => t.note(`retrying: ${err.message}`)
            });
            if (latest.asset.size && size !== latest.asset.size) throw new Error(`The download is ${size} bytes, the release says ${latest.asset.size}.`);
            const got = await sha256(part);
            if (got !== want) throw new Error('The downloaded file doesn’t match the release’s checksum, so it was thrown away.');
            await fs.move(part, final, { overwrite: true });
            await storage.writeJsonAtomic(readyFile(), { version: latest.version, file: final, sha256: want, size, method: state.method, title: latest.title, notes: latest.notes, url: latest.url, date: latest.date });
            t.done();
            log.info(`Incursion ${latest.version} downloaded and verified`);
            set({ status: 'ready', progress: 1, ready: { file: final, sha256: want } });
        } catch (err) {
            t.fail(err);
            await fs.remove(part).catch(() => {});
            log.warn('Update download failed:', err.message);
            set({ status: 'available', progress: null, error: `The update didn’t download: ${err.message}` });
            throw err;
        } finally { busy = null; }
        return view();
    })();
    return busy;
}

// Run once at startup: picks up a verified download from an earlier run, and clears out old ones.
async function restore() {
    const ready = await storage.readJsonSafe(readyFile(), null).catch(() => null);
    if (!ready || !newer(ready.version, cfg.version)) {
        if (await fs.pathExists(dir())) {
            if (ready) log.info(`Updated to ${cfg.version}; removing the installer`);
            await fs.remove(dir()).catch((err) => log.warn('Couldn’t clean up old updates:', err.message));
        }
        return;
    }
    try {
        if (!(await fs.pathExists(ready.file)) || (await sha256(ready.file)) !== ready.sha256) throw new Error('missing or changed');
        if (ready.method !== method().kind) throw new Error('downloaded for another kind of install');
        state = { status: 'ready', method: ready.method, latest: { version: ready.version, title: ready.title, notes: ready.notes, url: ready.url, date: ready.date }, ready: { file: ready.file, sha256: ready.sha256 }, progress: 1 };
        log.info(`Incursion ${ready.version} is downloaded and waiting to install`);
    } catch (err) {
        log.warn(`Discarding the downloaded update (${err.message})`);
        await fs.remove(dir()).catch(() => {});
    }
}

function detached(cmd, args) {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (err) => log.error(`Couldn’t start ${path.basename(cmd)}:`, err.message));
    child.unref();
    return child;
}

const MAC_SCRIPT = `#!/bin/sh
pid="$1"; dmg="$2"; app="$3"; relaunch="$4"
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done
mnt="$(mktemp -d)" || exit 1
hdiutil attach -nobrowse -noautoopen -readonly -mountpoint "$mnt" "$dmg" >/dev/null || exit 1
src="$(find "$mnt" -maxdepth 1 -name '*.app' | head -n 1)"
rm -rf "$app.new"
if [ -z "$src" ] || ! ditto "$src" "$app.new"; then hdiutil detach "$mnt" -quiet; rm -rf "$app.new"; [ "$relaunch" = 1 ] && open "$app"; exit 1; fi
hdiutil detach "$mnt" -quiet
rm -rf "$app.old"
if mv "$app" "$app.old" && mv "$app.new" "$app"; then rm -rf "$app.old"; else [ -d "$app" ] || mv "$app.old" "$app"; rm -rf "$app.new"; fi
xattr -dr com.apple.quarantine "$app" 2>/dev/null
[ "$relaunch" = 1 ] && open "$app"
exit 0
`;

const DEB_SCRIPT = `#!/bin/sh
pid="$1"; deb="$2"; exe="$3"; relaunch="$4"
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done
pkexec dpkg -i "$deb"
[ "$relaunch" = 1 ] && nohup "$exe" >/dev/null 2>&1 &
exit 0
`;

// Checks the file once more, then hands it to whatever installs it. Windows, macOS and .deb finish after the app quits.
async function prepareInstall(relaunch) {
    if (state.status !== 'ready' || !state.ready) throw new Error('No update is ready to install.');
    if (cfg.busy()) throw new Error('Close the game first. Updating closes Incursion, and the game with it.');
    const { file, sha256: want } = state.ready;
    if (!(await fs.pathExists(file)) || (await sha256(file)) !== want) {
        await fs.remove(dir()).catch(() => {});
        set({ status: 'available', ready: null, progress: null, error: 'The downloaded update was changed or removed, so it has to be downloaded again.' });
        throw new Error(state.error);
    }
    const kind = state.method;
    if (kind === 'appimage') {
        const target = method().file;
        const tmp = path.join(path.dirname(target), `.${path.basename(target)}.new`);
        await fs.copy(file, tmp, { overwrite: true });
        await fs.chmod(tmp, 0o755);
        await fs.rename(tmp, target);
        return () => { if (relaunch) cfg.relaunch({ execPath: target }); };
    }
    if (kind === 'nsis') return () => detached(file, ['--updated', '/S', ...(relaunch ? ['--force-run'] : [])]);
    if (kind === 'dmg') {
        const script = path.join(dir(), 'install.sh');
        await fs.writeFile(script, MAC_SCRIPT, { mode: 0o755 });
        const bundle = method().bundle;
        return () => detached('/bin/sh', [script, String(process.pid), file, bundle, relaunch ? '1' : '0']);
    }
    if (kind === 'deb') {
        const script = path.join(dir(), 'install.sh');
        await fs.writeFile(script, DEB_SCRIPT, { mode: 0o755 });
        return () => detached('/bin/sh', [script, String(process.pid), file, process.execPath, relaunch ? '1' : '0']);
    }
    throw new Error('This install can’t update itself. Download the new version from the release page.');
}

// "Restart now": installs and quits. The caller's quit path flushes everything first, then calls the returned launcher.
async function installNow() {
    const run = await prepareInstall(true);
    set({ status: 'installing' });
    quitInstall = run;
    log.info(`Installing Incursion ${state.latest.version} and restarting`);
    cfg.quit();
}

// Called from the quit path once everything is saved. Installs a ready update unless a game is still running.
async function onQuit() {
    try {
        if (quitInstall) { const run = quitInstall; quitInstall = null; run(); return; }
        if (state.status !== 'ready') return;
        if (cfg.busy()) { log.info('A game is running; the update installs next time'); return; }
        const run = await prepareInstall(false);
        log.info(`Installing Incursion ${state.latest.version} on quit`);
        run();
    } catch (err) { log.warn('Update not installed on quit:', err.message); }
}

function setAuto(on) {
    clearInterval(timer);
    timer = null;
    if (on) { timer = setInterval(() => check({ quiet: true }).catch(() => {}), CHECK_EVERY); timer.unref?.(); }
}

// opts: { userData, version, repo, packaged, emit, busy, quit, relaunch, auto }
async function init(opts) {
    cfg = opts;
    state = { status: 'idle' };
    busy = null;
    quitInstall = null;
    await restore().catch((err) => log.warn('Couldn’t read the downloaded update:', err.message));
    setAuto(opts.auto !== false);
    if (opts.auto !== false) setTimeout(() => check({ quiet: true }).catch(() => {}), FIRST_CHECK).unref?.();
}

module.exports = { init, check, download, installNow, onQuit, setAuto, status: view, _internals: { newer, parse, expectedSum, method } };
