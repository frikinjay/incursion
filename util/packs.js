// Main owns pack state and the renderer only gets snapshots, so there's exactly one writer per incursion.json.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const api = require('./api');
const storage = require('./storage');
const jars = require('./jars');
const insights = require('./insights');
const untracked = require('./untracked');
const exporters = require('./exporters');
const profiles = require('./profiles');
const links = require('./links');
const configs = require('./configs');

const { modKey } = api;
const AUTO_CHECK_AFTER = 30 * 60 * 1000;
const AUTO_SYNC_AFTER = 24 * 3600 * 1000;

let emit = () => {};
let taskSeq = 0;

function task(label) {
    const id = `t${++taskSeq}`;
    const t = {
        id,
        update(progress, detail) { emit('task', { id, label, progress, detail, state: 'running' }); },
        done(detail) { emit('task', { id, label, progress: 1, detail, state: 'done' }); },
        fail(detail) { emit('task', { id, label, progress: 1, detail, state: 'error' }); }
    };
    t.update(null);
    return t;
}

async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) { const i = next++; await fn(items[i], i); }
    }));
}

const PLATFORM_FIELDS = ['ids', 'names', 'slugs', 'authors', 'environments', 'installedFiles', 'links', 'icons', 'fileLinks', 'hashes', 'sizes', 'deps', 'incompat'];
const metaFor = (meta, pl) => Object.fromEntries(Object.entries(meta || {}).filter(([k]) => (pl === 'curseforge' ? k.startsWith('cf') : k.startsWith('mr'))));

function dropDuplicates(meta) {
    const seen = new Set();
    const before = meta.mods.length;
    meta.mods = meta.mods.filter(m => {
        const k = `${m.type || 'mod'}|${m.ids?.curseforge || ''}|${m.ids?.modrinth || ''}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    return before - meta.mods.length;
}

function untrackedIssue(u) {
    const n = (u?.modrinth?.length || 0) + (u?.curseforge?.length || 0);
    if (!n) return [];
    const where = [u.modrinth.length ? `${u.modrinth.length} in modrinth/mods` : null, u.curseforge.length ? `${u.curseforge.length} in curseforge/mods` : null].filter(Boolean).join(', ');
    return [{ kind: 'untracked', severity: 'warn', title: `${n === 1 ? 'A jar' : `${n} jars`} added outside Incursion`, detail: `${where}. Review to add ${n === 1 ? 'it' : 'them'} to the pack and fetch the other platform’s file.`, keys: [] }];
}

function migrate(meta) {
    if (meta.formatVersion >= 2) return false;
    meta.formatVersion = 2;
    meta.id ||= crypto.randomUUID();
    meta.createdAt ||= Date.now();
    meta.releases ||= [];
    return true;
}

// Bump when scanEntry learns something new. Older scans are redone in the background when the pack opens.
const SCAN_VERSION = 2;

async function scanEntry(packPath, m) {
    if (m.type && m.type !== 'mod') return undefined;
    for (const pl of ['modrinth', 'curseforge']) {
        const f = m.installedFiles?.[pl];
        if (!f) continue;
        const file = storage.paths.entryFile(packPath, pl, m);
        if (!(await fs.pathExists(file))) continue;
        try {
            const d = await jars.inspectJar(file);
            return { v: SCAN_VERSION, file: f, ids: d.ids, bundled: d.bundled, incompatible: d.incompatible, loaders: d.loaders, side: d.side };
        } catch { return { file: f, ids: [], bundled: [], incompatible: [], error: true }; }
    }
    return m.contents || null;
}

class PackService {
    constructor() {
        this.open = new Map();
        this.busy = new Map();
    }

    setEmitter(fn) { emit = fn; }

    async library() {
        const entries = await storage.getLibrary();
        let dirty = false;
        const out = await Promise.all(entries.map(async e => {
            const live = this.open.get(e.path)?.meta;
            const available = !!live || await storage.hasPack(e.path);
            let modCount = live ? live.mods.length : e.modCount;
            if (modCount == null && available) {
                try { modCount = (await storage.loadPack(e.path)).mods.length; e.modCount = modCount; dirty = true; } catch {}
            }
            return { ...e, modCount: modCount ?? null, available };
        }));
        if (dirty) await storage.saveLibrary(entries);
        return out;
    }

    async _syncLibraryEntry(meta) {
        const lib = await storage.getLibrary();
        const prof = (meta.profiles || []).find(p => p.id === meta.launch?.profile);
        const entry = { name: meta.name, path: meta.path, version: meta.version, loader: meta.loader, gameVersion: meta.gameVersion, icon: meta.icon || null, modCount: meta.mods.length, platform: require('./content').playPlatform(meta), profile: prof?.name || null, updatedAt: Date.now() };
        const i = lib.findIndex(e => e.path === meta.path);
        if (i === -1) lib.push(entry); else lib[i] = { ...lib[i], ...entry };
        await storage.saveLibrary(lib);
    }

    async create(info) {
        if (!info.name?.trim()) throw new Error('Give the pack a name.');
        if (!info.path) throw new Error('Choose a folder for the pack.');
        if (await storage.hasPack(info.path)) throw new Error('That folder already contains a pack. Use Import instead.');
        const meta = {
            formatVersion: 2, id: crypto.randomUUID(), releases: [],
            name: info.name.trim(), version: info.version || '1.0.0', author: info.author || '', description: info.description || '',
            loader: info.loader, gameVersion: info.gameVersion, loaderVersion: info.loaderVersion || '',
            path: info.path, icon: info.icon || null, mods: [], createdAt: Date.now(),
            launch: info.launch || { memoryMax: 4096 }
        };
        await fs.ensureDir(path.join(info.path, 'curseforge', 'mods'));
        await fs.ensureDir(path.join(info.path, 'modrinth', 'mods'));
        await storage.savePack(info.path, meta);
        await this._syncLibraryEntry(meta);
        return meta.path;
    }

    async import(dir) {
        const meta = await storage.loadPack(dir);
        const lib = await storage.getLibrary();
        if (lib.some(e => e.path === dir)) throw new Error('That pack is already in your library.');
        await this._syncLibraryEntry(meta);
        return dir;
    }

    async forget(packPath) {
        // Save first: saving updates the library entry, which would otherwise put it straight back.
        await this._flush(packPath);
        const s = this.open.get(packPath);
        if (s) clearTimeout(s.saveTimer);
        this.open.delete(packPath);
        const lib = await storage.getLibrary();
        await storage.saveLibrary(lib.filter(e => e.path !== packPath));
    }

    async _get(packPath) {
        let s = this.open.get(packPath);
        if (!s) {
            const meta = await storage.loadPack(packPath);
            const stored = await storage.loadPending(packPath);
            const pending = stored && stored.v === 2 ? stored : { v: 2, updates: {}, checkedAt: 0 };
            s = { meta, pending, missing: {}, untracked: { modrinth: [], curseforge: [] }, saveTimer: null };
            this.open.set(packPath, s);
            if (migrate(meta)) this._changed(s);
            if (dropDuplicates(meta)) this._changed(s);
            links.absorbPack(meta);
            await fs.ensureDir(path.join(packPath, 'overrides', 'config')).catch(() => {});
            s.missing = await storage.findMissing(packPath, meta.mods, modKey);
            s.untracked = await untracked.list(packPath, meta.mods);
            this._scanContents(packPath).catch(() => {});
        }
        return s;
    }

    snapshot(s) {
        return {
            meta: s.meta,
            updates: s.pending.updates,
            checkedAt: s.pending.checkedAt || 0,
            missing: s.missing,
            issues: [...insights.issues(s.meta, { missing: s.missing }), ...untrackedIssue(s.untracked)],
            untracked: s.untracked,
            busy: [...(this.busy.get(s.meta.path) || [])]
        };
    }

    _changed(s, { save = true } = {}) {
        if (save) {
            clearTimeout(s.saveTimer);
            s.saveTimer = setTimeout(() => this._flush(s.meta.path), 250);
        }
        this._emitSoon(s);
    }

    // Coalesce bursts: the first change goes out right away, then the latest state at most every 120 ms.
    _emitSoon(s) {
        if (s.emitTimer) { s.emitPending = true; return; }
        emit('pack', this.snapshot(s));
        s.emitTimer = setTimeout(() => {
            s.emitTimer = null;
            if (s.emitPending) { s.emitPending = false; this._emitSoon(s); }
        }, 120);
    }

    async _flush(packPath) {
        const s = this.open.get(packPath);
        if (!s) return;
        clearTimeout(s.saveTimer);
        s.saveTimer = null;
        await storage.savePack(packPath, s.meta);
        await storage.savePending(packPath, s.pending);
        await this._syncLibraryEntry(s.meta);
    }

    async flushAll() { await Promise.all([...this.open.keys()].map(p => this._flush(p))); }

    // One run of each operation per pack. A second check or sync joins the one in flight; anything else waits.
    async _exclusive(packPath, op, fn, { join = false } = {}) {
        const k = `${packPath}|${op}`;
        this.running ||= new Map();
        if (this.running.has(k)) {
            const current = this.running.get(k);
            if (join) return current;
            await current.catch(() => {});
            return this._exclusive(packPath, op, fn, { join });
        }
        const set = this.busy.get(packPath) || new Set();
        set.add(op); this.busy.set(packPath, set);
        const s = this.open.get(packPath);
        if (s) this._emitSoon(s);
        const p = (async () => {
            try { return await fn(); }
            finally {
                set.delete(op);
                this.running.delete(k);
                const s2 = this.open.get(packPath);
                if (s2) this._emitSoon(s2);
            }
        })();
        this.running.set(k, p);
        return p;
    }

    async metaOf(packPath) { return (await this._get(packPath)).meta; }

    async load(packPath) {
        const s = await this._get(packPath);
        s.untracked = await untracked.list(packPath, s.meta.mods).catch(() => s.untracked);
        const now = Date.now();
        if (s.meta.mods.length && now - (s.pending.checkedAt || 0) > AUTO_CHECK_AFTER) {
            this.checkUpdates(packPath, { quiet: true }).catch(() => {});
        }
        if (s.meta.mods.length && now - (s.meta.syncedAt || 0) > AUTO_SYNC_AFTER) {
            this.sync(packPath, { quiet: true }).catch(() => {});
        }
        return this.snapshot(s);
    }

    async updateInfo(packPath, fields) {
        const s = await this._get(packPath);
        const allowed = ['name', 'version', 'author', 'description', 'loaderVersion', 'icon', 'gameVersion', 'loader', 'launch', 'links', 'license', 'tags', 'publish', 'profiles', 'linkPolicy', 'releaseOptions'];
        if (fields.linkPolicy !== undefined) { fields = { ...fields, linkPolicy: fields.linkPolicy === 'local' ? 'local' : 'pack' }; api.clearSearches(); }
        if (fields.releaseOptions !== undefined) fields = { ...fields, releaseOptions: { trackConfigs: fields.releaseOptions?.trackConfigs !== false } };
        if (fields.profiles !== undefined) fields = { ...fields, profiles: profiles.clean(fields.profiles, s.meta) };
        const changesTarget = (fields.gameVersion && fields.gameVersion !== s.meta.gameVersion) || (fields.loader && fields.loader !== s.meta.loader);
        if (changesTarget && s.meta.mods.length) throw new Error('Minecraft version and loader can only be changed while the pack is empty.');
        for (const k of allowed) if (fields[k] !== undefined) s.meta[k] = fields[k];
        this._changed(s);
        return this.snapshot(s);
    }

    async addMods(packPath, items) {
        const s = await this._get(packPath);
        const { meta } = s;
        const t = task(items.length === 1 ? `Adding ${items[0].title}` : `Adding ${items.length} Items`);
        const added = [], failed = [];
        let n = 0;
        await pool(items, 3, async (item) => {
            try {
                const type = item.type || 'mod';
                const platforms = { ...item.platforms };
                for (const [pl, other] of [['curseforge', 'modrinth'], ['modrinth', 'curseforge']]) {
                    if (platforms[pl]?.id && !platforms[other]?.id) {
                        const twin = links.twinOf(pl, platforms[pl].id, meta, type);
                        if (twin) platforms[other] = { id: twin };
                    }
                }
                const same = (m, pl) => platforms[pl]?.id && (pl === 'curseforge' ? Number(m.ids.curseforge) === Number(platforms[pl].id) : m.ids.modrinth === platforms[pl].id);
                const already = meta.mods.find(m => same(m, 'curseforge') || same(m, 'modrinth'));
                if (already) {
                    const missing = ['curseforge', 'modrinth'].filter(pl => platforms[pl]?.id && !already.ids[pl]);
                    if (!missing.length) return;
                    await this._addPlatform(packPath, s, already, missing[0], platforms[missing[0]].id);
                    already.updatedAt = Date.now();
                    added.push({ entry: already, warnings: [], merged: true });
                    this._changed(s);
                    return;
                }
                item = { ...item, platforms };
                const resolved = await api.resolve({ platforms: item.platforms, gameVersion: meta.gameVersion, loader: meta.loader, type: item.type });
                if (!resolved.curseforge && !resolved.modrinth) throw new Error(resolved.errors.join('; ') || 'No compatible files');
                const entry = api.toEntry(resolved, { title: item.title, author: item.author, mrAuthor: item.platforms.modrinth?.author, env: item.env, summary: item.summary, type: item.type });
                await this._downloadEntry(packPath, entry);
                // Several items download at once, so another one may have already added this mod (e.g. a dependency
                // listed once per platform). Then only fill in what's missing.
                const sameIds = (m) => (entry.ids.curseforge && Number(m.ids.curseforge) === Number(entry.ids.curseforge)) || (entry.ids.modrinth && m.ids.modrinth === entry.ids.modrinth);
                const meanwhile = meta.mods.find(sameIds);
                if (meanwhile) {
                    const missing = ['curseforge', 'modrinth'].filter(pl => entry.ids[pl] && !meanwhile.ids[pl]);
                    if (missing.length) { this._foldInto(s, meanwhile, entry, missing[0]); meanwhile.updatedAt = Date.now(); this._changed(s); }
                    added.push({ entry: meanwhile, warnings: [], merged: true });
                    return;
                }
                const twin = this._sameModFromOtherPlatform(meta, entry);
                if (twin) {
                    const pl = entry.ids.curseforge ? 'curseforge' : 'modrinth';
                    this._foldInto(s, twin, entry, pl);
                    twin.updatedAt = Date.now();
                    links.learn([{ cf: twin.ids.curseforge, mr: twin.ids.modrinth, how: 'entry' }]);
                    added.push({ entry: twin, warnings: [], merged: true });
                    this._changed(s);
                    return;
                }
                meta.mods.push(entry);
                added.push({ entry, warnings: resolved.errors });
                this._changed(s);
            } catch (err) {
                failed.push({ title: item.title, error: err.message });
            } finally {
                t.update(++n / items.length, `${n} of ${items.length}`);
            }
        });
        if (failed.length && !added.length) t.fail(failed[0].error); else t.done(failed.length ? `${failed.length} failed` : `${added.length} added`);

        let dependencies = [];
        try {
            const platform = items[0]?.platforms.curseforge && items[0]?.platforms.modrinth ? 'both' : items[0]?.platforms.modrinth ? 'modrinth' : 'curseforge';
            dependencies = insights.annotateBundled(await api.missingDependencies({ entries: added.map(a => a.entry), packMods: meta.mods, gameVersion: meta.gameVersion, loader: meta.loader, platform }), meta);
        } catch {}
        return { added: added.map(a => ({ key: modKey(a.entry), title: a.entry.names.curseforge || a.entry.names.modrinth, warnings: a.warnings, merged: !!a.merged })), failed, dependencies, snapshot: this.snapshot(s) };
    }

    async addEntries(packPath, entries) {
        const s = await this._get(packPath);
        const have = new Set(s.meta.mods.map(modKey));
        for (const e of entries) {
            if (have.has(modKey(e))) continue;
            e.contents = await scanEntry(packPath, e);
            s.meta.mods.push(e);
            have.add(modKey(e));
        }
        s.missing = await storage.findMissing(packPath, s.meta.mods, modKey);
        s.untracked = await untracked.list(packPath, s.meta.mods);
        this._changed(s);
        await this._flush(packPath);
        return this.snapshot(s);
    }

    async reviewUntracked(packPath) {
        const s = await this._get(packPath);
        s.untracked = await untracked.list(packPath, s.meta.mods);
        this._emitSoon(s);
        return untracked.review(packPath, s.meta);
    }

    async adoptUntracked(packPath, ids, choices = {}) {
        return this._exclusive(packPath, 'adopt', async () => {
            const s = await this._get(packPath);
            const t = task(ids.length === 1 ? 'Adding a Mod File' : `Adding ${ids.length} Mod Files`);
            try {
                const items = (await untracked.review(packPath, s.meta)).filter(i => ids.includes(i.id));
                const entries = await untracked.adopt(packPath, s.meta, items, choices);
                await this.addEntries(packPath, entries);
                t.done(`${entries.length} added`);
                return { added: entries.length, skipped: items.length - entries.length };
            } catch (err) { t.fail(err.message); throw err; }
        });
    }

    async refreshUntracked(packPath) {
        const s = await this._get(packPath);
        s.untracked = await untracked.list(packPath, s.meta.mods);
        this._emitSoon(s);
        return this.snapshot(s);
    }

    async _downloadEntry(packPath, entry, platforms = ['curseforge', 'modrinth']) {
        const pls = platforms.filter(pl => entry.fileLinks?.[pl] && entry.installedFiles?.[pl]);
        const res = await storage.downloadAll(pls.map(pl => ({ url: entry.fileLinks[pl], dest: storage.paths.entryFile(packPath, pl, entry), sha1: entry.hashes?.[pl]?.sha1 })));
        entry.hashes ||= { curseforge: null, modrinth: null };
        pls.forEach((pl, i) => { entry.hashes[pl] = { ...(entry.hashes[pl] || {}), sha1: res[i].sha1 }; });
        entry.contents = await scanEntry(packPath, entry);
    }

    async _scanContents(packPath) {
        const s = this.open.get(packPath);
        if (!s) return;
        const todo = s.meta.mods.filter(m => (!m.type || m.type === 'mod') && (!m.contents || m.contents.v !== SCAN_VERSION || m.contents.file !== (m.installedFiles?.modrinth || m.installedFiles?.curseforge)));
        if (!todo.length) return;
        await pool(todo, 4, async (m) => { m.contents = await scanEntry(packPath, m); });
        this._changed(s);
    }

    async removeMods(packPath, keys) {
        const s = await this._get(packPath);
        const set = new Set(keys.map(String));
        const removing = s.meta.mods.filter(m => set.has(modKey(m)));
        // Never delete a file another entry still references.
        const keep = s.meta.mods.filter(m => !set.has(modKey(m)));
        for (const m of removing) {
            const files = {};
            for (const pl of ['curseforge', 'modrinth']) {
                const f = m.installedFiles?.[pl];
                if (f && !keep.some(k => k.installedFiles?.[pl] === f)) files[pl] = f;
            }
            await storage.removeModFiles(packPath, files, m.type);
        }
        s.meta.mods = keep;
        for (const k of set) { delete s.pending.updates[k]; delete s.missing[k]; }
        this._changed(s);
        return this.snapshot(s);
    }

    _hashOf(packPath) {
        return async (m) => {
            if (m.hashes?.modrinth?.sha1) return m.hashes.modrinth.sha1;
            if (!m.installedFiles?.modrinth) return null;
            const file = storage.paths.entryFile(packPath, 'modrinth', m);
            if (!(await fs.pathExists(file))) return null;
            const { sha1 } = await storage.hashFile(file);
            (m.hashes ||= { curseforge: null, modrinth: null }).modrinth = { sha1 };
            return sha1;
        };
    }

    async checkUpdates(packPath, { keys, quiet = false } = {}) {
        return this._exclusive(packPath, keys ? 'check-some' : 'check', async () => {
            const s = await this._get(packPath);
            const mods = keys ? s.meta.mods.filter(m => keys.includes(modKey(m))) : s.meta.mods.filter(m => !m.pinned);
            const t = quiet ? null : task('Checking for Updates');
            const hashOf = this._hashOf(packPath);
            try {
                const res = await api.checkUpdates({ mods, gameVersion: s.meta.gameVersion, loader: s.meta.loader, hashOf }, (pct) => t?.update(pct / 100));
                if (keys) { for (const k of keys) delete s.pending.updates[k]; Object.assign(s.pending.updates, res.updates); }
                else s.pending.updates = res.updates;
                s.pending.checkedAt = res.checkedAt;
                this._changed(s);
                const count = Object.keys(keys ? res.updates : s.pending.updates).length;
                if (res.errors.length) t?.fail(res.errors.join(' · ')); else t?.done(count ? `${count} update${count === 1 ? '' : 's'} available` : 'Everything is up to date');
                if (quiet && count) emit('notice', { kind: 'updates', packPath, count });
                return { count, errors: res.errors, snapshot: this.snapshot(s) };
            } catch (err) { t?.fail(err.message); throw err; }
        }, { join: !keys });
    }

    async applyUpdates(packPath, keys, { platforms = ['curseforge', 'modrinth'] } = {}) {
        return this._exclusive(packPath, 'apply', async () => {
            const s = await this._get(packPath);
            const want = (k) => platforms.some(pl => s.pending.updates[k]?.[pl]);
            const todo = (keys || Object.keys(s.pending.updates)).filter(want);
            const t = task(todo.length === 1 ? 'Updating 1 Item' : `Updating ${todo.length} Items`);
            const failed = [];
            let n = 0;
            await pool(todo, 6, async (key) => {
                const mod = s.meta.mods.find(m => modKey(m) === key);
                const all = s.pending.updates[key];
                const patch = Object.fromEntries(Object.entries(all).filter(([pl]) => platforms.includes(pl)));
                try {
                    if (!mod) return;
                    const before = modKey(mod);
                    await this._applyPatch(packPath, mod, patch);
                    const rest = Object.fromEntries(Object.entries(all).filter(([pl]) => !platforms.includes(pl)));
                    delete s.pending.updates[key];
                    if (Object.keys(rest).length) s.pending.updates[modKey(mod) || before] = rest;
                    if (s.missing[key]) delete s.missing[key];
                    this._changed(s);
                } catch (err) {
                    failed.push({ title: mod?.names.curseforge || mod?.names.modrinth || key, error: err.message });
                } finally { t.update(++n / todo.length, `${n} of ${todo.length}`); }
            });
            if (failed.length) t.fail(`${failed.length} failed: ${failed[0].error}`); else t.done('All updates installed');
            return { updated: todo.length - failed.length, failed, snapshot: this.snapshot(s) };
        });
    }

    // Download new files first, then swap metadata and delete old files, platform by platform.
    async _applyPatch(packPath, mod, patch) {
        const pls = ['curseforge', 'modrinth'].filter(pl => patch[pl]);
        const got = await storage.downloadAll(pls.map(pl => ({ url: patch[pl].url, dest: storage.paths.modFile(packPath, pl, `${patch[pl].fileName}${mod.disabled ? storage.paths.DISABLED : ''}`, mod.type), sha1: patch[pl].sha1 })));
        for (const [i, pl] of pls.entries()) {
            const u = patch[pl];
            const res = got[i];
            const old = mod.installedFiles[pl];
            if (old && old !== u.fileName) await storage.removeModFiles(packPath, { [pl]: old }, mod.type);
            mod.installedFiles[pl] = u.fileName;
            mod.fileLinks[pl] = u.url;
            (mod.hashes ||= {})[pl] = pl === 'modrinth' ? { sha1: res.sha1, sha512: u.sha512 } : { sha1: res.sha1 };
            (mod.sizes ||= {})[pl] = u.size;
            (mod.deps ||= {})[pl] = u.deps;
            (mod.incompat ||= {})[pl] = u.incompat || [];
            mod.meta ||= {};
            if (pl === 'curseforge') { mod.meta.cfFileId = u.fileId; mod.meta.cfDisplayName = u.displayName; if (u.env) (mod.environments ||= {}).curseforge = u.env; }
            else { mod.meta.mrVersionId = u.versionId; mod.meta.mrVersionNumber = u.versionNumber; mod.meta.mrDate = u.date; }
        }
        mod.updatedAt = Date.now();
        mod.contents = await scanEntry(packPath, mod);
    }

    async setVersion(packPath, key, { platform, versionId, pin = false }) {
        const s = await this._get(packPath);
        const mod = s.meta.mods.find(m => modKey(m) === String(key));
        if (!mod) throw new Error('That mod is no longer in the pack.');
        const t = task(`Switching ${mod.names.curseforge || mod.names.modrinth}`);
        try {
            const platforms = platform === 'modrinth'
                ? { modrinth: { id: mod.ids.modrinth, versionId } }
                : { curseforge: { id: mod.ids.curseforge, exactFileId: versionId } };
            const r = await api.resolve({ platforms, gameVersion: s.meta.gameVersion, loader: s.meta.loader, want: platform, type: mod.type });
            if (!r[platform]) throw new Error(r.errors[0] || 'That version is not available.');
            const patch = platform === 'modrinth'
                ? { modrinth: { fileName: r.modrinth.version.fileName, url: r.modrinth.version.url, versionId: r.modrinth.version.id, versionNumber: r.modrinth.version.number, date: r.modrinth.version.date, sha1: r.modrinth.version.sha1, sha512: r.modrinth.version.sha512, size: r.modrinth.version.size, deps: r.modrinth.version.deps, incompat: r.modrinth.version.incompat } }
                : { curseforge: { fileName: r.curseforge.file.fileName, url: r.curseforge.file.url, fileId: r.curseforge.file.id, displayName: r.curseforge.file.displayName, date: r.curseforge.file.date, sha1: r.curseforge.file.sha1, size: r.curseforge.file.size, deps: r.curseforge.file.deps, incompat: r.curseforge.file.incompat, env: r.curseforge.file.env } };
            await this._applyPatch(packPath, mod, patch);
            if (pin) mod.pinned = true;
            if (s.pending.updates[key]) delete s.pending.updates[key][platform];
            if (s.pending.updates[key] && !Object.keys(s.pending.updates[key]).length) delete s.pending.updates[key];
            this._changed(s);
            t.done(platform === 'modrinth' ? patch.modrinth.versionNumber : patch.curseforge.displayName);
            return this.snapshot(s);
        } catch (err) { t.fail(err.message); throw err; }
    }

    // Off renames files to "<name>.disabled" so the game, Play and exports skip them. Files are renamed before the
    // flag is saved.
    async setDisabled(packPath, keys, disabled) {
        const s = await this._get(packPath);
        const set = new Set(keys.map(String));
        const failed = [];
        for (const m of s.meta.mods) {
            if (!set.has(modKey(m)) || !!m.disabled === !!disabled) continue;
            try {
                for (const pl of ['curseforge', 'modrinth']) {
                    const name = m.installedFiles?.[pl];
                    if (!name) continue;
                    const on = storage.paths.modFile(packPath, pl, name, m.type);
                    const off = storage.paths.modFile(packPath, pl, `${name}${storage.paths.DISABLED}`, m.type);
                    const [from, to] = disabled ? [on, off] : [off, on];
                    if (await fs.pathExists(from)) await fs.move(from, to, { overwrite: true });
                }
                m.disabled = disabled ? true : undefined;
            } catch (err) { failed.push({ key: modKey(m), error: err.message }); }
        }
        s.missing = await storage.findMissing(packPath, s.meta.mods, modKey);
        this._changed(s);
        await this._flush(packPath);
        if (failed.length) throw new Error(`Couldn’t rename ${failed.length === 1 ? 'a file' : `${failed.length} files`}: ${failed[0].error} Close the game if it is running and try again.`);
        return this.snapshot(s);
    }

    async modMeta(packPath, keys, patch) {
        const s = await this._get(packPath);
        const set = new Set(keys.map(String));
        for (const m of s.meta.mods) {
            if (!set.has(modKey(m))) continue;
            if ('pinned' in patch) m.pinned = !!patch.pinned || undefined;
            if ('optional' in patch) m.optional = !!patch.optional || undefined;
            if ('side' in patch) m.side = ['client', 'server', 'both'].includes(patch.side) ? patch.side : undefined;
            if ('notes' in patch) m.notes = String(patch.notes || '').slice(0, 2000) || undefined;
        }
        if (patch.pinned) for (const k of set) delete s.pending.updates[k];
        this._changed(s);
        return this.snapshot(s);
    }

    async mergeMods(packPath, keys) {
        const s = await this._get(packPath);
        const [a, b] = keys.map(k => s.meta.mods.find(m => modKey(m) === String(k)));
        const mr = [a, b].find(m => m?.ids.modrinth && !m.ids.curseforge);
        const cf = [a, b].find(m => m?.ids.curseforge && !m.ids.modrinth);
        if (!mr || !cf) throw new Error('Only a Modrinth-only and a CurseForge-only entry can be merged.');
        for (const field of ['names', 'slugs', 'authors', 'environments', 'installedFiles', 'links', 'icons', 'fileLinks', 'hashes', 'sizes', 'deps', 'incompat']) {
            mr[field] = { ...(mr[field] || {}), curseforge: cf[field]?.curseforge ?? null };
        }
        mr.ids.curseforge = cf.ids.curseforge;
        mr.meta = { ...(mr.meta || {}), cfFileId: cf.meta?.cfFileId ?? null, cfDisplayName: cf.meta?.cfDisplayName ?? null };
        mr.summary ||= cf.summary;
        mr.dateAdded = Math.min(mr.dateAdded || Date.now(), cf.dateAdded || Date.now());
        s.meta.mods = s.meta.mods.filter(m => m !== cf);
        for (const k of keys) delete s.pending.updates[String(k)];
        s.missing = await storage.findMissing(packPath, s.meta.mods, modKey);
        this._changed(s);
        return this.snapshot(s);
    }

    async linkMod(packPath, { platform, id, to = null, title, type = 'mod' }) {
        if (!['curseforge', 'modrinth'].includes(platform) || !id) throw new Error('Choose a project to link.');
        if (to != null && !String(to).trim()) throw new Error('Choose a project to link.');
        const other = platform === 'curseforge' ? 'modrinth' : 'curseforge';
        const rec = { cf: platform === 'curseforge' ? id : to, mr: platform === 'modrinth' ? id : to, source: 'manual', title };
        links.set(rec);
        api.clearSearches();
        if (!packPath) return { linked: true, type };
        const s = await this._get(packPath);
        s.meta.modLinks = links.packWith(s.meta, rec);
        const same = (m, pl, v) => (pl === 'curseforge' ? Number(m.ids.curseforge) === Number(v) : m.ids.modrinth === v);
        const mod = s.meta.mods.find(m => same(m, platform, id));
        let changed = false;
        if (mod) {
            const t = task(`Linking ${mod.names[platform] || title || 'Mod'}`);
            try {
                if (to == null) {
                    if (mod.ids[other]) { await this._dropPlatform(packPath, s, mod, other); changed = true; }
                } else if (!same(mod, other, to)) {
                    const twin = s.meta.mods.find(m => m !== mod && same(m, other, to) && !m.ids[platform]);
                    if (twin) { if (mod.ids[other]) await this._dropPlatform(packPath, s, mod, other); this._foldInto(s, mod, twin, other); }
                    else await this._addPlatform(packPath, s, mod, other, to);
                    changed = true;
                }
                t.done(changed ? 'Pack updated' : 'Linked');
            } catch (err) { t.fail(err.message); this._changed(s); throw err; }
        }
        s.missing = await storage.findMissing(packPath, s.meta.mods, modKey);
        this._changed(s);
        return { linked: true, updatedEntry: changed, type: mod?.type || type, snapshot: this.snapshot(s) };
    }

    async unlinkMod(packPath, { platform, id }) {
        links.clear(platform, id);
        api.clearSearches();
        if (!packPath) return { unlinked: true };
        const s = await this._get(packPath);
        s.meta.modLinks = links.packWithout(s.meta, platform, id);
        this._changed(s);
        return { unlinked: true, snapshot: this.snapshot(s) };
    }

    async linkInfo(packPath, { platform, id, type = 'mod' } = {}) {
        const meta = packPath ? (await this._get(packPath)).meta : null;
        return {
            link: platform && id ? links.get(platform, id, meta, type) : null,
            policy: meta?.linkPolicy === 'local' ? 'local' : 'pack',
            packLinks: (meta?.modLinks || []).length,
            conflicts: meta ? links.conflicts(meta) : [],
            stats: links.stats()
        };
    }

    async settleLink(packPath, { cf, mr, choice }) {
        const s = await this._get(packPath);
        const c = links.conflicts(s.meta).find(x => (cf && x.pack.cf === Number(cf)) || (mr && x.pack.mr === mr));
        if (c) {
            if (choice === 'mine') {
                s.meta.modLinks = (s.meta.modLinks || []).filter(x => !((c.pack.cf && Number(x.cf) === c.pack.cf) || (c.pack.mr && x.mr === c.pack.mr)));
                s.meta.modLinks = links.packWith(s.meta, { cf: c.mine.cf, mr: c.mine.mr, title: c.mine.title });
            } else links.set({ cf: c.pack.cf, mr: c.pack.mr, source: 'manual', title: c.pack.title });
            api.clearSearches();
            this._changed(s);
        }
        return this.snapshot(s);
    }

    async _dropPlatform(packPath, s, mod, pl) {
        const oldKey = modKey(mod);
        const file = mod.installedFiles?.[pl];
        if (file && !s.meta.mods.some(m => m !== mod && m.installedFiles?.[pl] === file)) await storage.removeModFiles(packPath, { [pl]: file }, mod.type);
        for (const f of ['names', 'slugs', 'authors', 'environments', 'installedFiles', 'links', 'icons', 'fileLinks', 'hashes', 'sizes']) if (mod[f]) mod[f][pl] = null;
        for (const f of ['deps', 'incompat']) if (mod[f]) mod[f][pl] = [];
        mod.ids[pl] = null;
        mod.meta ||= {};
        if (pl === 'curseforge') { mod.meta.cfFileId = null; mod.meta.cfDisplayName = null; }
        else { mod.meta.mrVersionId = null; mod.meta.mrVersionNumber = null; mod.meta.mrDate = null; }
        delete s.pending.updates[oldKey];
    }

    async _addPlatform(packPath, s, mod, pl, id) {
        const oldKey = modKey(mod);
        const r = await api.resolve({ platforms: { [pl]: { id } }, gameVersion: s.meta.gameVersion, loader: s.meta.loader, want: pl, type: mod.type });
        if (!r[pl]) throw new Error(r.errors[0] || `No compatible ${pl === 'modrinth' ? 'Modrinth' : 'CurseForge'} file for this pack.`);
        const part = api.toEntry(r, { type: mod.type });
        for (const f of PLATFORM_FIELDS) (mod[f] ||= {})[pl] = part[f][pl];
        mod.meta = { ...(mod.meta || {}), ...metaFor(part.meta, pl) };
        await this._downloadEntry(packPath, mod, [pl]);
        if (oldKey !== modKey(mod)) delete s.pending.updates[oldKey];
    }

    _sameModFromOtherPlatform(meta, entry) {
        const pl = entry.ids.curseforge && !entry.ids.modrinth ? 'curseforge' : entry.ids.modrinth && !entry.ids.curseforge ? 'modrinth' : null;
        if (!pl) return null;
        const other = pl === 'curseforge' ? 'modrinth' : 'curseforge';
        const type = entry.type || 'mod';
        const ids = new Set((entry.contents?.ids || []).filter(i => !i.provided && !/\$\{/.test(i.id)).map(i => i.id.toLowerCase()));
        const side = (m, p) => (p === 'curseforge' ? { name: m.names?.curseforge, slug: m.slugs?.curseforge, author: m.authors?.curseforge } : { title: m.names?.modrinth, slug: m.slugs?.modrinth, author: m.authors?.modrinth });
        return meta.mods.find(m => {
            if (m === entry || m.ids[pl] || !m.ids[other] || (m.type || 'mod') !== type) return false;
            if (ids.size && (m.contents?.ids || []).some(i => !i.provided && ids.has(String(i.id).toLowerCase()))) return true;
            const cf = pl === 'curseforge' ? side(entry, 'curseforge') : side(m, 'curseforge');
            const mr = pl === 'curseforge' ? side(m, 'modrinth') : side(entry, 'modrinth');
            return cf.name && mr.title && api.matching.sameProject(cf, mr);
        }) || null;
    }

    _foldInto(s, mod, twin, pl) {
        for (const f of PLATFORM_FIELDS) (mod[f] ||= {})[pl] = twin[f]?.[pl] ?? (f === 'deps' || f === 'incompat' ? [] : null);
        mod.meta = { ...(mod.meta || {}), ...metaFor(twin.meta || {}, pl) };
        delete s.pending.updates[modKey(twin)];
        s.meta.mods = s.meta.mods.filter(m => m !== twin);
    }

    async dependencies(packPath) {
        const s = await this._get(packPath);
        const both = s.meta.mods.filter(m => m.ids.curseforge && m.ids.modrinth).length;
        const platform = both >= s.meta.mods.length / 2 ? 'both' : s.meta.mods.filter(m => m.ids.modrinth).length >= s.meta.mods.length / 2 ? 'modrinth' : 'curseforge';
        const deps = await api.missingDependencies({ entries: s.meta.mods, packMods: s.meta.mods, gameVersion: s.meta.gameVersion, loader: s.meta.loader, platform });
        return insights.annotateBundled(deps, s.meta);
    }

    async release(packPath, { version, notes = '', dryRun = false }) {
        const s = await this._get(packPath);
        const releases = s.meta.releases || [];
        const prev = releases[releases.length - 1];
        const changes = insights.diff(prev?.mods, s.meta);
        const v = String(version || s.meta.version || '1.0.0').trim();
        const track = s.meta.releaseOptions?.trackConfigs !== false;
        let configDiff = null, configNote = null, current = null;
        if (track) {
            s.cfgSnap = await configs.snapshot(packPath, s.cfgSnap);
            current = s.cfgSnap;
            if (prev) {
                s.cfgPrev = s.cfgPrev?.version === prev.version ? s.cfgPrev : { version: prev.version, snap: await configs.load(packPath, prev.version) };
                if (s.cfgPrev.snap) configDiff = configs.diff(s.cfgPrev.snap, current);
                else configNote = `Config tracking starts with this release: ${prev.version} has no config snapshot.`;
            }
        }
        const markdown = insights.changelogMarkdown({ version: v, notes, changes, configLines: configs.markdownLines(configDiff) });
        if (dryRun) return { version: v, previous: prev?.version || null, changes, markdown, tracking: track, configs: configs.summary(configDiff), configNote };
        if (releases.some(r => r.version === v)) throw new Error(`Version ${v} has already been released. Pick a new version number.`);
        if (track) await configs.save(packPath, v, current);
        s.meta.releases = [...releases, { version: v, date: Date.now(), notes, changes, mods: insights.compactMods(s.meta), ...(configDiff && !configs.isEmpty(configDiff) ? { configs: configs.summary(configDiff) } : {}) }];
        s.meta.version = v;
        this._changed(s);
        return { version: v, changes, markdown, snapshot: this.snapshot(s) };
    }

    async recordPublished(packPath, version, patch) {
        const s = await this._get(packPath);
        const r = (s.meta.releases || []).find(x => x.version === version);
        if (!r) throw new Error(`There is no release ${version}.`);
        r.published = { ...(r.published || {}), ...patch, at: Date.now() };
        this._changed(s);
        await this._flush(packPath);
        return this.snapshot(s);
    }

    async serverPreview(packPath, mode) {
        const s = await this._get(packPath);
        const { included, excluded } = require('./sidedness').split(s.meta.mods, mode);
        const row = (x) => ({ key: modKey(x.m), title: x.m.names.modrinth || x.m.names.curseforge, type: x.m.type || 'mod', reason: x.reason });
        return { mode, included: included.map(row), excluded: excluded.map(row) };
    }

    async redownload(packPath, { keys, mode = 'all' } = {}) {
        return this._exclusive(packPath, 'download', async () => {
            const s = await this._get(packPath);
            let mods = keys ? s.meta.mods.filter(m => keys.includes(modKey(m))) : s.meta.mods;
            if (mode === 'missing') mods = mods.filter(m => s.missing[modKey(m)]);
            const t = task(mode === 'missing' ? `Repairing ${mods.length} mods` : mods.length === 1 ? `Re-downloading ${mods[0].names.curseforge || mods[0].names.modrinth}` : `Re-downloading ${mods.length} mods`);
            const failed = [];
            let n = 0;
            await pool(mods, 6, async (m) => {
                try {
                    const platforms = mode === 'missing' ? s.missing[modKey(m)] : ['curseforge', 'modrinth'];
                    await this._downloadEntry(packPath, m, platforms);
                    delete s.missing[modKey(m)];
                } catch (err) { failed.push({ title: m.names.curseforge || m.names.modrinth, error: err.message }); }
                finally { t.update(++n / Math.max(mods.length, 1), `${n} of ${mods.length}`); }
            });
            this._changed(s);
            if (failed.length) t.fail(`${failed.length} failed`); else t.done(`${mods.length} downloaded`);
            return { count: mods.length - failed.length, failed, snapshot: this.snapshot(s) };
        });
    }

    async sync(packPath, { quiet = false } = {}) {
        return this._exclusive(packPath, 'sync', async () => {
            const s = await this._get(packPath);
            const t = quiet ? null : task('Refreshing Mod Info');
            try {
                const { changed } = await api.syncMetadata({ mods: s.meta.mods, force: !quiet, hashOf: this._hashOf(packPath) });
                s.meta.syncedAt = Date.now();
                this._changed(s);
                t?.done(changed ? `${changed} mods refreshed` : 'Already current');
                return this.snapshot(s);
            } catch (err) { t?.fail(err.message); throw err; }
        }, { join: true });
    }

    async exportPack(packPath, kind, outDir, { profile } = {}) {
        const s = await this._get(packPath);
        await this._flush(packPath);
        const meta = profiles.apply(s.meta, profile ?? s.meta.launch?.profile, { rename: true });
        const results = [];
        const kinds = kind === 'both' ? ['curseforge', 'modrinth'] : kind === 'all' ? ['curseforge', 'modrinth', 'server'] : [kind];
        const labels = { curseforge: 'CurseForge Pack', modrinth: 'Modrinth Pack', server: 'Server Pack', prism: 'Prism Launcher Instance', packwiz: 'packwiz Pack' };
        for (const k of kinds) {
            const t = task(`Exporting ${labels[k]}`);
            try {
                const fn = { curseforge: storage.exportCurseForge, modrinth: storage.exportModrinth, server: storage.exportServer, prism: exporters.exportPrism, packwiz: exporters.exportPackwiz }[k];
                if (!fn) throw new Error(`Unknown export format ${k}`);
                const r = await fn(meta, outDir, (pct) => t.update(pct / 100));
                t.done(r.skipped.length ? `${r.count} mods · ${r.skipped.length} skipped` : `${r.count} mods`);
                results.push({ kind: k, ...r });
            } catch (err) { t.fail(err.message); results.push({ kind: k, error: err.message }); }
        }
        return results;
    }
}

module.exports = new PackService();
