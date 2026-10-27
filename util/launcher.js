const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const storage = require('./storage');
const downloads = require('./downloads');
const log = require('./log').scope('launch');
const java = require('./java');
const msauth = require('./msauth');

const ROOT = 'incursion';
const datadir = require('./datadir');
const CONSOLE_LIMIT = 5000;
const FLUSH_MS = 100;

let eml = null;
let emit = () => {};
let getWindow = () => null;
let secrets = null;
let accountsFile = null;
let allowOffline = false;

const loadEml = async () => (eml ||= (await import('eml-lib')).default);

// Launch prep touches the shared asset and library store, so it runs one pack at a time. The lock is released once the
// game process starts.
let prepareChain = Promise.resolve();
function exclusivePrepare(fn) {
    const run = prepareChain.then(fn, fn);
    prepareChain = run.catch(() => {});
    return run;
}

function splitArgs(s) {
    if (Array.isArray(s)) return s.filter(Boolean);
    return (String(s || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map(a => a.replace(/^(["'])(.*)\1$/, '$2'));
}

const slugFor = (meta) => {
    const base = String(meta.name || 'pack').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'pack';
    return `${base}-${crypto.createHash('sha1').update(path.resolve(meta.path).toLowerCase()).digest('hex').slice(0, 6)}`;
};

async function readAccounts() {
    try {
        const raw = await fs.readJson(accountsFile);
        return {
            active: raw.active || null,
            list: (raw.list || []).map(a => {
                try { return JSON.parse(secrets.available ? secrets.decrypt(a.enc) : a.enc); } catch { return null; }
            }).filter(Boolean)
        };
    } catch { return { active: null, list: [] }; }
}
async function writeAccounts({ active, list }) {
    await storage.writeJsonAtomic(accountsFile, {
        active,
        list: list.map(a => ({ uuid: a.uuid, enc: secrets.available ? secrets.encrypt(JSON.stringify(a)) : JSON.stringify(a) }))
    });
}
const publicAccount = (a) => a && ({ uuid: a.uuid, name: a.name, type: a.meta?.type || 'msa', avatar: `https://mc-heads.net/avatar/${a.uuid}/64` });

class Instance {
    constructor(meta, account) {
        this.id = crypto.randomUUID();
        this.packPath = meta.path;
        this.packName = meta.name;
        this.icon = meta.icon || null;
        this.slug = slugFor(meta);
        this.account = publicAccount(account);
        this.state = 'preparing';
        this.status = 'Getting ready';
        this.progress = null;
        this.startedAt = Date.now();
        this.endedAt = null;
        this.exitCode = null;
        this.pid = null;
        this.lines = [];
        this.pending = [];
        this.flushTimer = null;
        this.subscribers = 0;
        this.crash = null;
    }

    summary() {
        const { id, packPath, packName, icon, slug, account, state, status, progress, startedAt, endedAt, exitCode, pid, crash, errorCode, javaMajor } = this;
        return { id, packPath, packName, icon, slug, account, state, status, progress, startedAt, endedAt, exitCode, pid, crash, errorCode, javaMajor, lineCount: this.lines.length };
    }

    log(line, level = 'info') {
        let text = String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        // EML logs the full launch command (thousands of classpath characters), so keep debug lines readable.
        if (level === 'debug' && text.length > 400) text = `${text.slice(0, 400)}… (${text.length.toLocaleString()} characters)`;
        const entry = { t: Date.now(), level, text };
        this.lines.push(entry);
        if (this.lines.length > CONSOLE_LIMIT) this.lines.splice(0, this.lines.length - CONSOLE_LIMIT);
        if (!this.subscribers) return;
        this.pending.push(entry);
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }

    flush() {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        if (!this.pending.length) return;
        emit('console', { id: this.id, lines: this.pending });
        this.pending = [];
    }

    set(patch) {
        Object.assign(this, patch);
        emit('instance', this.summary());
    }
}

function levelOf(text) {
    if (/\b(ERROR|FATAL|SEVERE)\b|Exception|^\s+at /.test(text)) return 'error';
    if (/\bWARN(ING)?\b/.test(text)) return 'warn';
    if (/\bDEBUG\b/.test(text)) return 'debug';
    return 'info';
}

// EML doesn't expose the game's child process, so each JVM is tagged with -Dincursion.instance=<id> and found by
// command line for Stop.
function findPid(id) {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            const ps = `Get-CimInstance Win32_Process -Filter "Name like 'java%'" | Where-Object { $_.CommandLine -like '*incursion.instance=${id}*' } | Select-Object -First 1 -ExpandProperty ProcessId`;
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => resolve(Number(String(out).trim()) || null));
        } else {
            execFile('ps', ['-eo', 'pid=,args='], { timeout: 5000 }, (err, out) => {
                const line = String(out).split('\n').find(l => l.includes(`incursion.instance=${id}`));
                resolve(line ? Number(line.trim().split(/\s+/)[0]) : null);
            });
        }
    });
}

const instances = new Map();

function startWorker() {
    const { utilityProcess } = require('electron');
    return utilityProcess.fork(path.join(__dirname, 'game-worker.js'), [], { serviceName: 'Incursion game launcher', stdio: 'ignore' });
}

// Graceful: taskkill without /F asks the window to close so Minecraft saves first (SIGTERM elsewhere). Force kills the
// whole tree.
function killTree(pid, force) {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true }, () => {});
    else { try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
}

// Hard links cost no disk space and need no admin rights. Across drives, try a symlink, then copy.
// Mods mirror the pack exactly. For other content, only remove files we placed, so things added in game stay.
const content = require('./content');
const crashTools = require('./crash');
const backups = require('./backups');

async function analyseCrash(inst, meta) {
    const c = inst.crash || {};
    // Always the instance's own folder. EML reports paths at the shared root, where other packs' logs live.
    const texts = await crashTools.readSources({
        crashReportsDir: path.join(inst.gameDir || '', 'crash-reports'),
        logsPath: path.join(inst.gameDir || '', 'logs', 'latest.log'),
        since: inst.startedAt, consoleLines: inst.lines.map(l => l.text)
    });
    const result = crashTools.analyse(texts, meta.mods, (m) => String(m.ids.curseforge || m.ids.modrinth || m.ids.local));
    inst.crash = { ...c, analysis: result };
    if (result.suspects[0]) inst.log(`Likely cause: ${result.suspects[0].title} (${result.suspects[0].reasons[0]})`, 'error');
    inst.set({});
    inst.flush();
    return result;
}
const PLACED = '.incursion-placed.json';

async function syncMods(meta, gameDir) {
    const placedFile = path.join(gameDir, PLACED);
    const placedBefore = await fs.readJson(placedFile).catch(() => ({}));
    const placedNow = {};
    const added = {};
    const platform = require('./content').playPlatform(meta);
    let total = 0, linked = 0, removed = 0, skipped = 0;
    const how = { hard: 0, symbolic: 0, copy: 0 };
    for (const type of content.ORDER) {
        const t = content.TYPES[type];
        const dir = path.join(gameDir, t.folder);
        const wanted = new Map();
        for (const m of meta.mods.filter(x => content.typeOf(x).id === type)) {
            const f = m.installedFiles?.[platform];
            if (!f) { skipped++; continue; }
            const src = storage.paths.entryFile(meta.path, platform, m);
            if (await fs.pathExists(src)) wanted.set(storage.safeFileName(f), src);
        }
        total += wanted.size;
        if (!wanted.size && type !== 'mod' && !(placedBefore[type] || []).length) continue;
        await fs.ensureDir(dir);
        const existing = new Set(await fs.readdir(dir));
        const ours = new Set(placedBefore[type] || []);
        for (const name of existing) {
            const managed = type === 'mod' ? name.endsWith('.jar') : ours.has(name);
            if (managed && !wanted.has(name)) { await fs.remove(path.join(dir, name)); removed++; }
        }
        for (const [name, src] of wanted) {
            const dest = path.join(dir, name);
            if (existing.has(name)) {
                const [a, b] = await Promise.all([fs.stat(src), fs.stat(dest)]).catch(() => [null, null]);
                if (a && b && a.size === b.size) continue;
                await fs.remove(dest);
            } else if (!ours.has(name)) (added[type] ||= []).push(name);
            how[await placeFile(src, dest)]++;
            linked++;
        }
        if (type !== 'mod') placedNow[type] = [...wanted.keys()];
    }
    await fs.writeJson(placedFile, placedNow).catch(() => {});
    if (added.resourcepack?.length) await enableResourcePacks(gameDir, added.resourcepack).catch(() => {});
    const shaders = placedNow.shader || [];
    if (shaders.length === 1 && added.shader?.length) await selectShader(gameDir, shaders[0]).catch(() => {});
    // Overrides seed the instance without clobbering in-game edits.
    const overrides = path.join(meta.path, 'overrides');
    if (await fs.pathExists(overrides)) await fs.copy(overrides, gameDir, { overwrite: false, errorOnExist: false });
    return { total, linked, removed, platform, skipped, how, missing: meta.mods.length - total - skipped };
}

// Hard link on the same drive, else symlink (needs Developer Mode or admin on Windows), else copy.
async function placeFile(src, dest) {
    try { await fs.link(src, dest); return 'hard'; } catch {}
    try { await fs.symlink(src, dest, 'file'); return 'symbolic'; } catch {}
    await fs.copy(src, dest);
    return 'copy';
}

async function enableResourcePacks(gameDir, names) {
    const file = path.join(gameDir, 'options.txt');
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const lines = text ? text.split(/\r?\n/) : [];
    const i = lines.findIndex(l => l.startsWith('resourcePacks:'));
    let list = ['vanilla'];
    if (i >= 0) { try { list = JSON.parse(lines[i].slice('resourcePacks:'.length)); } catch {} }
    for (const n of names) if (!list.includes(`file/${n}`)) list.push(`file/${n}`);
    const line = `resourcePacks:${JSON.stringify(list)}`;
    if (i >= 0) lines[i] = line; else lines.push(line);
    await fs.writeFile(file, lines.filter((l, k) => l || k < lines.length - 1).join('\n') + '\n');
}

// Only written if the player hasn't set up shaders yet.
async function selectShader(gameDir, name) {
    const file = path.join(gameDir, 'config', 'iris.properties');
    if (await fs.pathExists(file)) return;
    await fs.outputFile(file, `#Selected by Incursion for the pack's shader\nenableShaders=true\nshaderPack=${name}\n`);
}

const launcher = {
    init({ userData, emitter, windowGetter, secretBox, offline = false }) {
        accountsFile = path.join(userData, 'accounts.json');
        emit = emitter;
        getWindow = windowGetter;
        secrets = secretBox;
        allowOffline = offline;
    },

    async accounts() {
        const { active, list } = await readAccounts();
        return { active, list: list.map(publicAccount), offlineAllowed: allowOffline };
    },

    async login() {
        const account = await msauth.signIn(getWindow(), await loadEml());
        if (!account?.uuid) throw new Error('Microsoft sign-in was cancelled.');
        const data = await readAccounts();
        data.list = [...data.list.filter(a => a.uuid !== account.uuid), account];
        data.active = account.uuid;
        await writeAccounts(data);
        return launcher.accounts();
    },

    // Offline accounts only exist in developer mode (INCURSION_DEV). They can't join online servers.
    async loginOffline(name) {
        if (!allowOffline) throw new Error('Offline accounts are disabled.');
        const { CrackAuth } = await loadEml();
        const account = new CrackAuth().auth(String(name || 'Tester').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'Tester');
        const data = await readAccounts();
        data.list = [...data.list.filter(a => a.uuid !== account.uuid), account];
        data.active = account.uuid;
        await writeAccounts(data);
        return launcher.accounts();
    },

    async selectAccount(uuid) {
        const data = await readAccounts();
        if (!data.list.some(a => a.uuid === uuid)) throw new Error('Unknown account');
        data.active = uuid;
        await writeAccounts(data);
        return launcher.accounts();
    },

    async logout(uuid, { forgetBrowser = false } = {}) {
        if (forgetBrowser) await msauth.forgetBrowserSession();
        const data = await readAccounts();
        data.list = data.list.filter(a => a.uuid !== uuid);
        if (data.active === uuid) data.active = data.list[0]?.uuid || null;
        await writeAccounts(data);
        return launcher.accounts();
    },

    async _activeAccount() {
        const data = await readAccounts();
        let account = data.list.find(a => a.uuid === data.active);
        if (!account) throw Object.assign(new Error('Sign in with a Microsoft account to play.'), { code: 'NO_ACCOUNT' });
        if (account.meta?.type === 'msa') {
            const { MicrosoftAuth } = await loadEml();
            const auth = new MicrosoftAuth(getWindow());
            const valid = await auth.validate(account).catch(() => false);
            if (!valid) {
                try { account = await auth.refresh(account); }
                catch { throw Object.assign(new Error(`Your session for ${account.name} expired. Sign in again.`), { code: 'NO_ACCOUNT' }); }
                data.list = data.list.map(a => (a.uuid === account.uuid ? account : a));
                await writeAccounts(data);
            }
        }
        return account;
    },

    list: () => [...instances.values()].map(i => i.summary()),

    async launch(meta, settings = {}) {
        const live = [...instances.values()].find(i => i.packPath === meta.path && (i.state === 'preparing' || i.state === 'running'));
        if (live) throw new Error(`${meta.name} is already running.`);
        if (!meta.loaderVersion) throw new Error('Set a loader version for this pack first (Edit pack).');

        const account = await launcher._activeAccount();
        const inst = new Instance(meta, account);
        instances.set(inst.id, inst);
        const finished = [...instances.values()].filter(i => i.endedAt).sort((a, b) => a.endedAt - b.endedAt);
        while (finished.length > 12) instances.delete(finished.shift().id);
        emit('instance', inst.summary());

        const memoryMax = Math.max(1024, Number(meta.launch?.memoryMax || settings.memoryMax || 4096));
        const jvmArgs = [...splitArgs(settings.jvmArgs), ...splitArgs(meta.launch?.jvmArgs)];
        const run = async () => {
            inst.set({ status: 'Preparing Java' });
            const pref = meta.launch?.java && meta.launch.java !== 'default' ? meta.launch.java : (settings.javaMode || 'managed');
            const resolved = await java.resolveFor(meta.gameVersion, pref, {
                allowDownload: pref !== 'system',
                onProgress: (p) => inst.set({ status: 'Downloading Java', progress: p })
            });
            if (resolved.missing) throw Object.assign(new Error(`Java ${resolved.missing} isn't installed on this PC. Download it for Incursion, or pick another Java in the pack's settings.`), { code: 'JAVA_MISSING', major: resolved.missing });
            inst.log(`Using Java ${resolved.java.version} (${resolved.java.vendor || 'unknown vendor'}) at ${resolved.java.path}`, 'debug');
            const config = {
                root: ROOT,
                storage: 'shared',
                cleaning: { enabled: false },
                profile: { slug: inst.slug },
                minecraft: { version: meta.gameVersion, loader: { loader: meta.loader, version: meta.loaderVersion } },
                account,
                memory: { min: Math.min(1024, memoryMax), max: memoryMax },
                java: { install: 'manual', absolutePath: resolved.java.path, args: [`-Dincursion.instance=${inst.id}`, ...jvmArgs] },
                window: { width: settings.windowWidth || 1280, height: settings.windowHeight || 720 }
            };
            const root = datadir.get();
            const gameDir = path.join(root, inst.slug);
            inst.gameDir = gameDir;

            if (meta.launch?.backupOnLaunch && (await backups.present(gameDir)).length) {
                inst.set({ status: 'Backing Up Worlds and Configs', progress: 0 });
                try {
                    await backups.create(gameDir, { packName: meta.name, reason: 'launch' }, (p) => inst.set({ progress: p }));
                    await backups.prune(gameDir, 'launch', Math.max(1, Number(meta.launch.backupKeep) || 5), (f) => fs.remove(f));
                } catch (err) { inst.log(`Backup before launch failed: ${err.message}`, 'warn'); }
            }
            if (inst.cancelled) throw Object.assign(new Error('Launch cancelled'), { code: 'CANCELLED' });

            let released = false;
            let releasePrepare;
            const prepared = new Promise(r => { releasePrepare = r; });
            const release = () => { if (!released) { released = true; releasePrepare(); } };

            // The game's own files come through EML's downloader, shown as one entry in the downloads list.
            let gameFiles = null;
            const gameFilesDone = (err) => { if (!gameFiles) return; if (err) gameFiles.fail(err); else gameFiles.done(); gameFiles = null; };
            inst.gameFilesDone = gameFilesDone;
            const on = {
                launch_compute_download: () => inst.set({ status: 'Checking Game Files', progress: null }),
                launch_download: ({ total }) => { if (total?.amount) inst.log(`Downloading ${total.amount} files`, 'debug'); },
                download_progress: ({ total, downloaded }) => {
                    inst.set({ status: 'Downloading Minecraft', progress: total?.size ? downloaded.size / total.size : null });
                    gameFiles ||= downloads.external(`Minecraft ${meta.gameVersion} game files`, 'https://piston-data.mojang.com/');
                    gameFiles.progress(downloaded?.size || 0, total?.size || null);
                },
                launch_install_loader: () => { gameFilesDone(); inst.set({ status: `Installing ${require('./loaders').LOADERS[meta.loader]?.label || meta.loader}`, progress: null }); },
                launch_check_java: () => { gameFilesDone(); inst.set({ status: 'Checking Java', progress: null }); },
                launch_launch: (cfg) => {
                    gameFilesDone();
                    inst.log(`Launching Minecraft ${meta.gameVersion} with Java ${cfg?.java?.version || '?'}`, 'debug');
                    inst.set({ state: 'running', status: 'Running', progress: null });
                    release();
                    setTimeout(async () => {
                        for (let i = 0; i < 6 && !inst.pid && inst.state === 'running'; i++) {
                            const pid = await findPid(inst.id);
                            if (pid) inst.set({ pid }); else await new Promise(r => setTimeout(r, 1500));
                        }
                    }, 800);
                },
                launch_debug: (m) => inst.log(m, 'debug'),
                launch_close: (code) => { inst.exitCode = code; },
                launch_data: (line) => inst.log(line, levelOf(line)),
                download_error: (e) => { inst.log(`Download failed: ${e.filename} (${e.message})`, 'error'); log.warn(`Game file download failed: ${e.filename} (${e.message})`); },
                launch_crash: (c) => { inst.crash = { code: c.code, logsPath: c.logsPath, crashReportsDir: c.crashReportsDir }; }
            };
            const worker = startWorker();
            inst.worker = worker;
            const workerDone = new Promise((resolve, reject) => {
                let settled = false;
                worker.on('message', (msg) => {
                    if (msg?.type === 'lines') { for (const l of msg.lines) inst.log(l, levelOf(l)); }
                    else if (msg?.type === 'event') { try { on[msg.name]?.(msg.data ?? {}); } catch {} }
                    else if (msg?.type === 'done') { settled = true; resolve(); }
                    else if (msg?.type === 'error') { settled = true; reject(Object.assign(new Error(msg.message), { code: msg.code })); }
                });
                worker.on('exit', (code) => {
                    inst.worker = null;
                    if (settled) return;
                    if (inst.cancelled) reject(Object.assign(new Error('Launch cancelled'), { code: 'CANCELLED' }));
                    else reject(new Error(`The launcher process stopped unexpectedly (code ${code}).`));
                });
            });
            workerDone.catch(release);

            const work = exclusivePrepare(async () => {
                inst.set({ status: 'Preparing Content' });
                const s = await syncMods(meta, gameDir);
                inst.log(`Content ready from ${s.platform === 'modrinth' ? 'Modrinth' : 'CurseForge'} files: ${s.total} files (${s.linked} placed: ${s.how.hard} hard links, ${s.how.symbolic} symbolic links, ${s.how.copy} copies; ${s.removed} removed${s.skipped ? `; ${s.skipped} not on ${s.platform === 'modrinth' ? 'Modrinth' : 'CurseForge'}, left out` : ''}${s.missing ? `; ${s.missing} missing on disk` : ''})`, s.missing ? 'warn' : 'debug');
                if (inst.cancelled) { worker.kill(); throw Object.assign(new Error('Launch cancelled'), { code: 'CANCELLED' }); }
                worker.postMessage({ type: 'launch', config, root });
                await Promise.race([prepared, workerDone]);
                return { workerDone };   // wrapped so the lock isn't held until the game exits
            });
            try { await (await work).workerDone; }
            finally { if (inst.worker) { try { inst.worker.kill(); } catch {} } }
        };

        run().then(() => {
            inst.flush();
            const code = inst.exitCode ?? 0;
            const crashed = inst.crash && inst.state !== 'stopping';
            inst.set({
                state: inst.state === 'stopping' ? 'stopped' : crashed ? 'crashed' : 'stopped',
                status: crashed ? `Crashed (Exit Code ${inst.crash.code})` : 'Stopped',
                endedAt: Date.now(),
                exitCode: inst.crash?.code ?? code
            });
            inst.log(crashed ? `Minecraft exited with code ${inst.crash.code}` : 'Minecraft closed', crashed ? 'error' : 'debug');
            log.info(`${meta.name}: ${crashed ? `game crashed (exit ${inst.crash.code})` : 'game closed'}`);
            inst.flush();
            if (crashed) analyseCrash(inst, meta).catch(() => {});
        }, (err) => {
            if (err.code === 'CANCELLED' || inst.cancelled) {
                inst.gameFilesDone?.(new Error('Cancelled'));
                inst.log('Launch cancelled', 'warn');
                inst.flush();
                inst.set({ state: 'stopped', status: 'Cancelled', endedAt: Date.now(), progress: null });
                return;
            }
            inst.gameFilesDone?.(err);
            inst.log(err.message || String(err), 'error');
            log.warn(`${meta.name}: launch failed:`, err.message || String(err));
            inst.flush();
            inst.set({ state: 'failed', status: err.message || 'Launch failed', endedAt: Date.now(), progress: null, errorCode: err.code || null, javaMajor: err.major || null });
        });
        return inst.summary();
    },

    async stop(id, { force = false } = {}) {
        const inst = instances.get(id);
        if (!inst) throw new Error('That instance has ended.');
        if (inst.state === 'preparing') {
            inst.cancelled = true;
            inst.set({ status: 'Cancelling' });
            if (inst.worker) { try { inst.worker.kill(); } catch {} }
            return inst.summary();
        }
        if (inst.state !== 'running' && inst.state !== 'stopping') return inst.summary();
        const pid = inst.pid || await findPid(id);
        if (!pid) throw new Error('Could not find the game process. Close Minecraft from its window.');
        inst.set({ state: 'stopping', status: force ? 'Force Stopping' : 'Stopping', forced: force || inst.forced });
        killTree(pid, force);
        if (!force) {
            setTimeout(() => { if (inst.state === 'stopping' && !inst.forced) inst.set({ status: 'Still closing… use Force Stop if it’s stuck' }); }, 30000);
        }
        return inst.summary();
    },

    subscribe(id) {
        const inst = instances.get(id);
        if (!inst) throw new Error('That instance is gone.');
        inst.subscribers++;
        return { instance: inst.summary(), lines: inst.lines };
    },
    unsubscribe(id) {
        const inst = instances.get(id);
        if (inst) { inst.subscribers = Math.max(0, inst.subscribers - 1); if (!inst.subscribers) inst.pending = []; }
    },
    clearFinished() {
        for (const [id, i] of instances) if (i.endedAt) instances.delete(id);
        return launcher.list();
    },
    gameDir: (id) => instances.get(id)?.gameDir || null,
    gameDirFor: (meta) => path.join(datadir.get(), slugFor(meta)),
    packBusy: (packPath) => [...instances.values()].some(i => i.packPath === packPath && (i.state === 'preparing' || i.state === 'running')),
    busy: () => [...instances.values()].some(i => i.state === 'preparing' || i.state === 'running'),
    splitArgs,
    crashInfo: (id) => instances.get(id)?.crash || null,
    async repair(meta, onProgress = () => {}) {
        if (launcher.packBusy(meta.path)) throw new Error(`Close ${meta.name} before repairing its game files.`);
        return exclusivePrepare(async () => {
            const root = datadir.get();
            const inside = (base, rel) => { const f = path.resolve(base, rel); return f.startsWith(path.resolve(base) + path.sep) ? f : null; };
            const versionsDir = path.join(root, 'versions');
            const mc = String(meta.gameVersion), lv = String(meta.loaderVersion || '');
            const names = await fs.readdir(versionsDir).catch(() => []);
            const targets = names.filter(n => n === mc || (lv && n.includes(lv) && (n.includes(mc) || meta.loader === 'neoforge')));
            const libs = new Map();
            let assetIndex = null;
            const mavenPath = (name) => {
                const [g, a, v, c] = String(name).split(':');
                return g && a && v ? `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${c ? `-${c}` : ''}.jar` : null;
            };
            for (const n of targets) {
                const j = await storage.readJsonSafe(path.join(versionsDir, n, `${n}.json`), null).catch(() => null);
                for (const lib of j?.libraries || []) {
                    const art = lib.downloads?.artifact;
                    const rel = art?.path || mavenPath(lib.name);
                    if (rel) libs.set(rel, art?.sha1 || lib.sha1 || null);
                    for (const c of Object.values(lib.downloads?.classifiers || {})) if (c.path) libs.set(c.path, c.sha1 || null);
                }
                if (j?.assetIndex?.id) assetIndex = j.assetIndex.id;
            }
            const sha1Of = async (f) => (await storage.hashFile(f)).sha1;
            let removedLibs = 0, removedAssets = 0, checked = 0;
            const total = libs.size;
            onProgress(0, 'Checking libraries');
            const libList = [...libs];
            let next = 0;
            await Promise.all(Array.from({ length: 6 }, async () => {
                while (next < libList.length) {
                    const [rel, sha1] = libList[next++];
                    const f = inside(path.join(root, 'libraries'), rel);
                    if (f && await fs.pathExists(f)) {
                        const ok = sha1 ? (await sha1Of(f).catch(() => null)) === sha1 : false;
                        if (!ok) { await fs.remove(f); removedLibs++; }
                    }
                    onProgress(0.4 * (++checked / Math.max(total, 1)), 'Checking libraries');
                }
            }));
            // Assets are named by their hash, so a mismatch means the file's damaged.
            if (assetIndex) {
                const idxFile = path.join(root, 'assets', 'indexes', `${assetIndex}.json`);
                const idx = await storage.readJsonSafe(idxFile, null).catch(() => null);
                const hashes = [...new Set(Object.values(idx?.objects || {}).map(o => o.hash).filter(h => /^[0-9a-f]{40}$/.test(h)))];
                let i = 0, done = 0;
                await Promise.all(Array.from({ length: 8 }, async () => {
                    while (i < hashes.length) {
                        const h = hashes[i++];
                        const f = path.join(root, 'assets', 'objects', h.slice(0, 2), h);
                        if (await fs.pathExists(f) && (await sha1Of(f).catch(() => null)) !== h) { await fs.remove(f); removedAssets++; }
                        if (++done % 200 === 0) onProgress(0.4 + 0.5 * (done / hashes.length), 'Checking assets');
                    }
                }));
                await fs.remove(idxFile);
            }
            onProgress(0.92, 'Removing version files');
            for (const n of targets) await fs.remove(path.join(versionsDir, n));
            for (const n of targets) await fs.remove(path.join(root, 'bin', n)).catch(() => {});
            const gameDir = path.join(root, slugFor(meta));
            for (const cacheDir of ['.fabric', '.quilt']) await fs.remove(path.join(gameDir, cacheDir)).catch(() => {});
            onProgress(1, 'Done');
            return { versions: targets, libraries: removedLibs, assets: removedAssets };
        });
    },

    async analyse(id, meta) {
        const inst = instances.get(id);
        if (!inst) throw new Error('That game session is gone.');
        inst.crash ||= {};
        return analyseCrash(inst, meta);
    },
    slugFor
};

module.exports = launcher;
