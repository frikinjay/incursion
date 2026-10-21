const fs = require('fs-extra');

const MAX_ENTRIES = 2500;
const SAVE_DELAY = 2000;

class ApiCache {
    constructor() {
        this.file = null;
        this.map = new Map();
        this.inflight = new Map();
        this.loaded = null;
        this.saveTimer = null;
        this.hits = 0;
        this.misses = 0;
    }

    init(file) {
        this.file = file;
        this.loaded = this._load();
        return this.loaded;
    }

    async _load() {
        try {
            if (!this.file || !(await fs.pathExists(this.file))) return;
            const raw = await fs.readJson(this.file);
            if (raw && raw.v === 2 && Array.isArray(raw.entries)) {
                const horizon = Date.now() - 7 * 24 * 3600 * 1000;
                for (const [k, e] of raw.entries) if (e && e.t > horizon) this.map.set(k, e);
            } else {
                await fs.remove(this.file);
            }
        } catch {
            await fs.remove(this.file).catch(() => {});
        }
    }

    _touch(key, entry) {
        this.map.delete(key);
        this.map.set(key, entry);
        while (this.map.size > MAX_ENTRIES) this.map.delete(this.map.keys().next().value);
        this._scheduleSave();
    }

    _scheduleSave() {
        if (!this.file) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY);
    }

    async flush() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        if (!this.file) return;
        const tmp = `${this.file}.tmp`;
        try {
            await fs.outputFile(tmp, JSON.stringify({ v: 2, entries: [...this.map] }));
            await fs.move(tmp, this.file, { overwrite: true });
        } catch (err) { console.error('[cache] save failed:', err.message); }
    }

    // Fresh within `ttl`. Between `ttl` and `stale`, returns the stale copy and refreshes in the background. `force`
    // skips the cache. Identical concurrent requests share one fetch.
    async wrap(key, { ttl, stale = 0, force = false }, fetcher) {
        await this.loaded;
        const entry = this.map.get(key);
        const age = entry ? Date.now() - entry.t : Infinity;

        if (!force && entry && age < ttl) {
            this.hits++;
            this._touch(key, entry);
            return entry.d;
        }
        if (!force && entry && age < ttl + stale) {
            this.hits++;
            this._revalidate(key, fetcher).catch(() => {});
            return entry.d;
        }
        this.misses++;
        return this._revalidate(key, fetcher);
    }

    _revalidate(key, fetcher) {
        if (this.inflight.has(key)) return this.inflight.get(key);
        const p = Promise.resolve().then(fetcher).then(data => {
            this._touch(key, { t: Date.now(), d: data });
            return data;
        }).finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
        return p;
    }

    peek(key) { return this.map.get(key)?.d; }

    // A cached null means "known not to exist".
    fresh(key, ttl) {
        const e = this.map.get(key);
        if (!e || Date.now() - e.t >= ttl) return undefined;
        this.hits++;
        return e.d;
    }

    set(key, data) { this._touch(key, { t: Date.now(), d: data }); }

    async clear(prefix) {
        await this.loaded;
        if (!prefix) this.map.clear();
        else for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
        await this.flush();
    }

    async stats() {
        await this.loaded;
        let bytes = 0;
        try { bytes = (await fs.stat(this.file)).size; } catch {}
        return { entries: this.map.size, bytes, hits: this.hits, misses: this.misses };
    }
}

module.exports = new ApiCache();
module.exports.ApiCache = ApiCache;
