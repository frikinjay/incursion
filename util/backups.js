const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const datadir = require('./datadir');
const { ZipSource } = require('./jars');

const ITEMS = {
    worlds: ['saves'],
    configs: ['config', 'defaultconfigs', 'kubejs', 'options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat']
};
const MANIFEST = 'incursion-backup.json';

const dirFor = (gameDir) => path.join(datadir.get(), 'backups', path.basename(gameDir));
const stamp = (t) => new Date(t).toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');

async function sizeOf(p) {
    const st = await fs.stat(p).catch(() => null);
    if (!st) return 0;
    if (!st.isDirectory()) return st.size;
    let n = 0;
    for (const e of await fs.readdir(p)) n += await sizeOf(path.join(p, e));
    return n;
}

async function present(gameDir, include = ['worlds', 'configs']) {
    const names = include.flatMap(k => ITEMS[k] || []);
    const out = [];
    for (const n of names) if (await fs.pathExists(path.join(gameDir, n))) out.push(n);
    return out;
}

async function create(gameDir, { packName = '', reason = 'manual', include = ['worlds', 'configs'] } = {}, onProgress = () => {}) {
    const items = await present(gameDir, include);
    if (!items.length) throw Object.assign(new Error('Nothing to back up yet: this pack has no worlds or configs. Play it once first.'), { code: 'EMPTY' });
    const dir = dirFor(gameDir);
    await fs.ensureDir(dir);
    const createdAt = Date.now();
    const file = path.join(dir, `${stamp(createdAt)}_${reason}.zip`);
    const total = (await Promise.all(items.map(i => sizeOf(path.join(gameDir, i))))).reduce((a, b) => a + b, 0) || 1;
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(`${file}.part`);
        const archive = archiver('zip', { zlib: { level: 6 } });
        out.on('close', resolve);
        archive.on('error', reject);
        archive.on('progress', (p) => onProgress(Math.min(0.99, p.fs.processedBytes / total)));
        archive.pipe(out);
        archive.append(JSON.stringify({ packName, reason, createdAt, items, include }, null, 2), { name: MANIFEST });
        for (const i of items) {
            const full = path.join(gameDir, i);
            if (fs.statSync(full).isDirectory()) archive.directory(full, i); else archive.file(full, { name: i });
        }
        archive.finalize();
    });
    await fs.move(`${file}.part`, file);
    onProgress(1);
    return describe(file);
}

async function describe(file) {
    const st = await fs.stat(file);
    let manifest = null;
    try {
        const src = await ZipSource.fromFile(file);
        try { const e = (await src.entries()).get(MANIFEST); if (e) manifest = JSON.parse((await src.readEntry(e)).toString('utf8')); }
        finally { await src.close(); }
    } catch {}
    const name = path.basename(file);
    return { name, path: file, size: st.size, createdAt: manifest?.createdAt || st.mtimeMs, reason: manifest?.reason || name.replace(/^[\d-]+_/, '').replace(/\.zip$/, ''), items: manifest?.items || [] };
}

async function list(gameDir) {
    const dir = dirFor(gameDir);
    const names = (await fs.readdir(dir).catch(() => [])).filter(n => n.endsWith('.zip'));
    const out = await Promise.all(names.map(n => describe(path.join(dir, n)).catch(() => null)));
    return out.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

async function prune(gameDir, reason, keep, trash) {
    const old = (await list(gameDir)).filter(b => b.reason === reason).slice(keep);
    for (const b of old) await trash(b.path);
    return old.length;
}

async function restore(gameDir, name, { packName = '' } = {}, onProgress = () => {}) {
    const file = path.join(dirFor(gameDir), path.basename(name));
    if (!(await fs.pathExists(file))) throw new Error('That backup no longer exists.');
    const info = await describe(file);
    // Back up whatever is there before replacing anything.
    let safety = null;
    if ((await present(gameDir)).length) safety = await create(gameDir, { packName, reason: 'before-restore' });
    const src = await ZipSource.fromFile(file);
    try {
        const entries = await src.entries();
        const tops = new Set([...entries.keys()].filter(k => k !== MANIFEST).map(k => k.split('/')[0]));
        // Unpack next to the game folder first and only swap folders once it's all out, so an interrupted restore
        // changes nothing.
        const staging = path.join(gameDir, `.restore-${Date.now()}`);
        let n = 0;
        try {
            for (const [name2, e] of entries) {
                if (name2 === MANIFEST || name2.endsWith('/')) continue;
                const dest = path.resolve(staging, name2);
                if (!dest.startsWith(path.resolve(staging) + path.sep)) continue;   // zip-slip guard
                await fs.outputFile(dest, await src.readEntry(e));
                onProgress(++n / entries.size);
            }
            for (const t of tops) {
                if (!(await fs.pathExists(path.join(staging, t)))) continue;
                await fs.remove(path.join(gameDir, t));
                await fs.move(path.join(staging, t), path.join(gameDir, t));
            }
        } finally { await fs.remove(staging).catch(() => {}); }
    } finally { await src.close(); }
    return { restored: info, safety };
}

module.exports = { ITEMS, dirFor, present, create, list, prune, restore, describe };
