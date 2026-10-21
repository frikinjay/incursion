// Link precedence, strongest first: the pack's own links (unless it prefers the user's), manual links, the signed
// community file, then links learned from other packs or found automatically. Manual links rank below community ones
// when "My links come first" is off.
// A record with one side null means "not on that platform".
const fs = require('fs-extra');
const path = require('path');

const RANK = { auto: 1, pack: 2, manual: 3 };
const FILE = 'links.json';
const VERSION = 3;
// Automatic matches saved before their check existed get dropped once when an older file loads, then relearned.
// v2: page links and shared repos weren't name-checked. v3: same-slug matches weren't type-checked.
const DROPPED_SINCE = { 2: ['link', 'source'], 3: ['slug'] };
const droppedFor = (from) => new Set(Object.entries(DROPPED_SINCE).filter(([v]) => Number(v) > from).flatMap(([, kinds]) => kinds));

let dirOf = () => null;
let options = { manualFirst: true };
const community = require('./community');
let loaded = null;
let saveTimer = null;

const cfKey = (id) => (id == null ? null : Number(id) || null);
const mrKey = (id) => (id == null ? null : String(id) || null);

function init({ dir }) { dirOf = dir; loaded = null; }
function setOptions(o) { options = { ...options, ...o }; }

function fresh() { return { dir: dirOf(), byCf: new Map(), byMr: new Map(), records: new Set() }; }

function index(store, rec) {
    store.records.add(rec);
    if (rec.cf) store.byCf.set(rec.cf, rec);
    if (rec.mr) store.byMr.set(rec.mr, rec);
}
function unindex(store, rec) {
    store.records.delete(rec);
    if (rec.cf && store.byCf.get(rec.cf) === rec) store.byCf.delete(rec.cf);
    if (rec.mr && store.byMr.get(rec.mr) === rec) store.byMr.delete(rec.mr);
}

function clean(r) {
    const rec = { cf: cfKey(r.cf), mr: mrKey(r.mr), source: RANK[r.source] ? r.source : 'auto', at: Number(r.at) || Date.now() };
    if (r.how) rec.how = String(r.how).slice(0, 20);
    if (r.title) rec.title = String(r.title).slice(0, 120);
    return rec.cf || rec.mr ? rec : null;
}

function store() {
    const dir = dirOf();
    if (loaded && loaded.dir === dir) return loaded;
    loaded = fresh();
    if (!dir) return loaded;
    // A damaged file falls back to the backup the writer keeps next to it.
    for (const name of [FILE, `${FILE}.bak`]) {
        try {
            const data = fs.readJsonSync(path.join(dir, name));
            const old = (data.v || 1) < VERSION;
            const drop = droppedFor(data.v || 1);
            let dropped = 0;
            for (const r of data.links || []) {
                const rec = clean(r);
                if (!rec) continue;
                if (old && rec.source === 'auto' && drop.has(rec.how)) { dropped++; continue; }
                index(loaded, rec);
            }
            if (old) { loaded.migrated = true; if (dropped) console.log(`[links] Removed ${dropped} unverified automatic matches`); save(); }
            break;
        } catch {}
    }
    return loaded;
}

function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flush().catch(() => {}), 400);
}
async function flush() {
    clearTimeout(saveTimer);
    const s = store();
    if (!s.dir) return;
    const links = [...s.records].sort((a, b) => (a.cf || 0) - (b.cf || 0) || String(a.mr).localeCompare(String(b.mr)));
    await require('./storage').writeJsonAtomic(path.join(s.dir, FILE), { v: VERSION, links }, { pretty: false });
}

const lookup = (byCf, byMr, platform, id) => (platform === 'curseforge' ? byCf.get(cfKey(id)) : byMr.get(mrKey(id))) || null;

function packIndex(meta) {
    const list = meta?.modLinks;
    if (!Array.isArray(list) || !list.length) return null;
    if (meta._linkIndex?.list === list && meta._linkIndex.n === list.length) return meta._linkIndex;
    const ix = { list, n: list.length, byCf: new Map(), byMr: new Map() };
    for (const r of list) { const rec = clean({ ...r, source: 'pack' }); if (!rec) continue; if (rec.cf) ix.byCf.set(rec.cf, rec); if (rec.mr) ix.byMr.set(rec.mr, rec); }
    Object.defineProperty(meta, '_linkIndex', { value: ix, enumerable: false, configurable: true, writable: true });
    return ix;
}

function get(platform, id, meta = null, type = 'mod') {
    const s = store();
    const global = lookup(s.byCf, s.byMr, platform, id);
    const ix = packIndex(meta);
    const own = ix ? lookup(ix.byCf, ix.byMr, platform, id) : null;
    const manual = global?.source === 'manual' ? global : null;
    const shared = community.get(platform, id, type);
    if (own && meta.linkPolicy !== 'local') return own;
    if (manual && options.manualFirst) return manual;
    if (shared) return shared;
    if (manual) return manual;
    return own || global;
}

function twinOf(platform, id, meta = null, type = 'mod') {
    const rec = get(platform, id, meta, type);
    if (!rec) return undefined;
    return platform === 'curseforge' ? rec.mr : rec.cf;
}

// Manual links replace whatever either project was linked to. Pack and automatic links only fill gaps.
function set(r) {
    const rec = clean(r);
    if (!rec) return null;
    const s = store();
    const old = [rec.cf && s.byCf.get(rec.cf), rec.mr && s.byMr.get(rec.mr)].filter(Boolean);
    if (rec.source !== 'manual') {
        if (old.some(o => RANK[o.source] >= RANK[rec.source])) return null;
        if (old.some(o => o.cf === rec.cf && o.mr === rec.mr)) return null;
    }
    for (const o of old) unindex(s, o);
    index(s, rec);
    save();
    return rec;
}

function clear(platform, id) {
    const s = store();
    const rec = lookup(s.byCf, s.byMr, platform, id);
    if (!rec) return false;
    unindex(s, rec);
    save();
    return true;
}

function learn(list) { for (const r of list) set({ ...r, source: 'auto' }); }

function absorbPack(meta) {
    for (const r of meta?.modLinks || []) set({ ...r, source: 'pack' });
    // An entry with both editions is a known pair, so remember it for other packs and versions. Saved as automatic, so
    // anything stronger wins.
    const pairs = (meta?.mods || []).filter(m => m.ids?.curseforge && m.ids?.modrinth).map(m => ({ cf: m.ids.curseforge, mr: m.ids.modrinth, how: 'entry' }));
    if (pairs.length) learn(pairs);
}

function packWith(meta, r) {
    const rec = clean({ ...r, source: 'manual' });
    if (!rec) return meta.modLinks || [];
    const list = (meta.modLinks || []).filter(x => !((rec.cf && cfKey(x.cf) === rec.cf) || (rec.mr && mrKey(x.mr) === rec.mr)));
    list.push({ cf: rec.cf, mr: rec.mr, at: rec.at, ...(rec.title ? { title: rec.title } : {}) });
    return list;
}
function packWithout(meta, platform, id) {
    return (meta.modLinks || []).filter(x => !(platform === 'curseforge' ? cfKey(x.cf) === cfKey(id) : mrKey(x.mr) === mrKey(id)));
}

function conflicts(meta) {
    const s = store();
    const out = [];
    for (const r of meta?.modLinks || []) {
        const p = clean({ ...r, source: 'pack' });
        if (!p) continue;
        const mine = (p.cf && s.byCf.get(p.cf)) || (p.mr && s.byMr.get(p.mr));
        if (mine && mine.source === 'manual' && (mine.cf !== p.cf || mine.mr !== p.mr)) out.push({ pack: p, mine });
    }
    return out;
}

const stats = () => { const s = store(); const by = { auto: 0, pack: 0, manual: 0 }; for (const r of s.records) by[r.source]++; return { total: s.records.size, ...by }; };

module.exports = { setOptions, init, get, twinOf, set, clear, learn, absorbPack, packWith, packWithout, conflicts, flush, stats, cfKey, mrKey };
