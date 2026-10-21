const fs = require('fs-extra');
const path = require('path');
const api = require('./api');
const storage = require('./storage');
const packs = require('./packs');
const { ZipSource, cfFingerprint } = require('./jars');
const { LOADERS } = require('./loaders');
const content = require('./content');
const toml = require('./toml');
const { request } = require('./http');

const MRPACK_LOADERS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };
const MMC_LOADERS = { 'net.fabricmc.fabric-loader': 'fabric', 'org.quiltmc.quilt-loader': 'quilt', 'net.minecraftforge': 'forge', 'net.neoforged': 'neoforge' };
const PACKWIZ_LOADERS = ['neoforge', 'forge', 'fabric', 'quilt'];
const OVERRIDE_DIRS = ['config', 'defaultconfigs', 'kubejs', 'scripts', 'global_packs', 'openloader'];

async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) { const i = next++; await fn(items[i], i); }
    }));
}

const parseCfg = (text) => Object.fromEntries(String(text).split(/\r?\n/).map(l => l.match(/^\s*([^#=][^=]*?)\s*=\s*(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
function fromMmcPack(json) {
    const comps = json?.components || [];
    const mc = comps.find(c => c.uid === 'net.minecraft');
    const ld = comps.find(c => MMC_LOADERS[c.uid]);
    return { gameVersion: mc?.version || mc?.cachedVersion || null, loader: ld ? MMC_LOADERS[ld.uid] : null, loaderVersion: ld ? (ld.version || ld.cachedVersion || null) : null };
}
async function instanceGameDir(dir) {
    for (const sub of ['minecraft', '.minecraft']) if (await fs.pathExists(path.join(dir, sub))) return path.join(dir, sub);
    return dir;
}
async function listContent(gameDir) {
    const out = [];
    for (const type of content.ORDER) {
        const dir = path.join(gameDir, content.typeOf(type).folder);
        if (!(await fs.pathExists(dir))) continue;
        for (const f of await fs.readdir(dir)) {
            const disabled = /\.disabled$/i.test(f);
            const name = f.replace(/\.disabled$/i, '');
            if (content.typeOf(type).ext.test(name) && (await fs.stat(path.join(dir, f))).isFile()) out.push({ file: path.join(dir, f), name, type, disabled });
        }
    }
    return out;
}

function packwizSource(base) {
    if (/^https:\/\//i.test(base)) {
        const root = new URL('.', base).toString();
        return { remote: true, get: (rel) => request(new URL(rel.split('/').map(encodeURIComponent).join('/'), root).toString(), { as: 'buffer' }) };
    }
    return { remote: false, get: (rel) => { const f = path.resolve(base, rel); if (!f.startsWith(path.resolve(base) + path.sep)) throw new Error(`Unsafe path in pack: ${rel}`); return fs.readFile(f); } };
}
async function readPackwiz(src) {
    const pack = toml.parse((await src.get('pack.toml')).toString('utf8'));
    const v = pack.versions || {};
    const loader = PACKWIZ_LOADERS.find(k => v[k]) || null;
    return { pack, gameVersion: v.minecraft || null, loader, loaderVersion: loader ? v[loader] : null };
}

async function extractZip(source, dir, marker) {
    const src = await ZipSource.fromFile(source);
    try {
        const entries = await src.entries();
        for (const [name, e] of entries) {
            if (name.endsWith('/')) continue;
            const dest = path.resolve(dir, name);
            if (!dest.startsWith(path.resolve(dir) + path.sep)) continue;
            await fs.outputFile(dest, await src.readEntry(e));
        }
    } finally { await src.close(); }
    const markers = [].concat(marker);
    const has = async (d) => { for (const m of markers) if (await fs.pathExists(path.join(d, m))) return true; return false; };
    if (await has(dir)) return dir;
    const subs = (await fs.readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory());
    for (const s of subs) if (await has(path.join(dir, s.name))) return path.join(dir, s.name);
    return dir;
}
function zipRoot(entries, marker) {
    if (entries.has(marker)) return '';
    for (const name of entries.keys()) { const m = name.match(/^([^/]+\/)([^/]+)$/); if (m && m[2] === marker) return m[1]; }
    return null;
}

async function readZipJson(src, entries, name) {
    const e = entries.get(name);
    return e ? JSON.parse((await src.readEntry(e)).toString('utf8')) : null;
}

async function readPortable(src, entries) {
    try {
        const m = await readZipJson(src, entries, storage.META_FILE);
        return m && Array.isArray(m.mods) ? m : null;
    } catch { return null; }
}
const summaryOf = (p) => (p ? { id: p.id || null, name: p.name, mods: p.mods.length, releases: (p.releases || []).length } : null);

async function inspect(source) {
    if (/^https:\/\//i.test(source)) {
        const pw = await readPackwiz(packwizSource(source));
        return { kind: 'packwiz', name: pw.pack.name, version: pw.pack.version, author: pw.pack.author || '', description: pw.pack.description || '', gameVersion: pw.gameVersion, loader: pw.loader, loaderVersion: pw.loaderVersion, modCount: null, incursion: null };
    }
    const stat = await fs.stat(source);
    if (stat.isDirectory() && await fs.pathExists(path.join(source, 'pack.toml'))) {
        const pw = await readPackwiz(packwizSource(source));
        const index = toml.parse(await fs.readFile(path.join(source, pw.pack.index?.file || 'index.toml'), 'utf8'));
        return { kind: 'packwiz', name: pw.pack.name, version: pw.pack.version, author: pw.pack.author || '', description: pw.pack.description || '', gameVersion: pw.gameVersion, loader: pw.loader, loaderVersion: pw.loaderVersion, modCount: (index.files || []).filter(f => f.metafile).length, incursion: null };
    }
    if (stat.isDirectory() && (await fs.pathExists(path.join(source, 'mmc-pack.json')) || await fs.pathExists(path.join(source, 'instance.cfg')))) {
        const mmc = fromMmcPack(await fs.readJson(path.join(source, 'mmc-pack.json')).catch(() => null));
        const cfg = parseCfg(await fs.readFile(path.join(source, 'instance.cfg'), 'utf8').catch(() => ''));
        const items = await listContent(await instanceGameDir(source));
        return { kind: 'prism', name: cfg.name || path.basename(source), ...mmc, modCount: items.filter(x => x.type === 'mod').length, otherCount: items.filter(x => x.type !== 'mod').length, incursion: null };
    }
    if (stat.isDirectory()) {
        const dir = (await fs.pathExists(path.join(source, 'mods'))) ? path.join(source, 'mods') : source;
        const jars = (await fs.readdir(dir)).filter(f => f.toLowerCase().endsWith('.jar'));
        const sample = jars.slice(0, 40);
        const hashes = await Promise.all(sample.map(f => storage.hashFile(path.join(dir, f)).then(h => h.sha1)));
        const found = Object.values(await api.identifyModrinth(hashes).catch(() => ({})));
        const tally = (pick) => { const c = {}; for (const v of found) for (const x of pick(v)) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || null; };
        return {
            kind: 'folder', name: path.basename(source), modCount: jars.length,
            gameVersion: tally(v => (v.gameVersions || []).filter(g => /^\d/.test(g))), loader: tally(v => (v.loaders || []).filter(l => LOADERS[l])), loaderVersion: null
        };
    }
    const src = await ZipSource.fromFile(source);
    try {
        const entries = await src.entries();
        const portable = await readPortable(src, entries);
        const fromPortable = portable ? { author: portable.author || '', description: portable.description || '', incursion: summaryOf(portable) } : { incursion: null };
        const index = await readZipJson(src, entries, 'modrinth.index.json');
        if (index) {
            const dep = index.dependencies || {};
            const loaderKey = Object.keys(dep).find(k => MRPACK_LOADERS[k]);
            return { kind: 'mrpack', name: index.name, version: index.versionId, description: index.summary || '', ...fromPortable, gameVersion: dep.minecraft, loader: MRPACK_LOADERS[loaderKey] || null, loaderVersion: dep[loaderKey] || null, modCount: index.files.filter(f => f.path.startsWith('mods/')).length, otherCount: index.files.filter(f => /^(resourcepacks|shaderpacks|datapacks)\//.test(f.path)).length };
        }
        const pwRoot = zipRoot(entries, 'pack.toml');
        if (pwRoot != null) {
            const pack = toml.parse((await src.readEntry(entries.get(`${pwRoot}pack.toml`))).toString('utf8'));
            const v = pack.versions || {};
            const loader = PACKWIZ_LOADERS.find(k => v[k]) || null;
            const metas = [...entries.keys()].filter(n => n.startsWith(pwRoot) && n.endsWith('.pw.toml')).length;
            return { kind: 'packwiz', zipRoot: pwRoot, name: pack.name, version: pack.version, author: pack.author || '', description: pack.description || '', gameVersion: v.minecraft || null, loader, loaderVersion: loader ? v[loader] : null, modCount: metas, incursion: null };
        }
        const mmcRoot = zipRoot(entries, 'mmc-pack.json') ?? zipRoot(entries, 'instance.cfg');
        if (mmcRoot != null) {
            const mmcEntry = entries.get(`${mmcRoot}mmc-pack.json`);
            const cfgEntry = entries.get(`${mmcRoot}instance.cfg`);
            const mmc = fromMmcPack(mmcEntry ? JSON.parse((await src.readEntry(mmcEntry)).toString('utf8')) : null);
            const cfg = parseCfg(cfgEntry ? (await src.readEntry(cfgEntry)).toString('utf8') : '');
            const jars = [...entries.keys()].filter(n => n.startsWith(mmcRoot) && /^(\.?minecraft\/)?mods\/[^/]+\.jar(\.disabled)?$/i.test(n.slice(mmcRoot.length))).length;
            return { kind: 'prism', zipRoot: mmcRoot, name: cfg.name || path.basename(source).replace(/\.zip$/i, ''), ...mmc, modCount: jars, incursion: null };
        }
        const manifest = await readZipJson(src, entries, 'manifest.json');
        if (manifest?.manifestType === 'minecraftModpack') {
            const ml = (manifest.minecraft.modLoaders.find(m => m.primary) || manifest.minecraft.modLoaders[0])?.id || '';
            const [loader, ...rest] = ml.split('-');
            return { kind: 'curseforge', name: manifest.name, version: manifest.version, author: manifest.author, ...fromPortable, gameVersion: manifest.minecraft.version, loader: LOADERS[loader] ? loader : null, loaderVersion: rest.join('-') || null, modCount: manifest.files.length };
        }
        throw new Error('This file isn’t a modpack Incursion can read. Use a Modrinth .mrpack, a CurseForge modpack zip, a Prism Launcher or MultiMC instance export, or a packwiz pack.');
    } finally { await src.close(); }
}

async function importPack({ source, target, name, gameVersion, loader, loaderVersion }, onProgress = () => {}) {
    const info = await inspect(source);
    const gv = gameVersion || info.gameVersion, ld = loader || info.loader;
    if (!gv || !ld) throw new Error('Choose the Minecraft version and loader for this import.');
    if (await storage.hasPack(target)) throw new Error('That folder already contains a pack.');

    await packs.create({ name: name || info.name || 'Imported pack', path: target, loader: ld, gameVersion: gv, loaderVersion: loaderVersion || info.loaderVersion || '', version: info.version || '1.0.0', author: info.author || '', description: info.description || '' });
    let portable = null;
    if (['mrpack', 'curseforge'].includes(info.kind)) {
        const src = await ZipSource.fromFile(source);
        try { portable = await readPortable(src, await src.entries()); } finally { await src.close(); }
    }
    if (portable) await restorePackDetails(target, portable);
    const overrides = path.join(target, 'overrides');
    const staging = path.join(target, '.import');
    await fs.ensureDir(staging);
    const jars = [];
    const unknown = [];

    try {
        onProgress(0.02, 'Reading pack');
        let dir = source;
        if (['prism', 'packwiz'].includes(info.kind) && !/^https:\/\//i.test(source) && !(await fs.stat(source)).isDirectory()) {
            dir = await extractZip(source, path.join(staging, 'source'), info.kind === 'packwiz' ? 'pack.toml' : ['mmc-pack.json', 'instance.cfg']);
        }
        if (info.kind === 'prism') {
            const gameDir = await instanceGameDir(dir);
            for (const item of await listContent(gameDir)) {
                const dest = path.join(staging, item.type, storage.safeFileName(item.name));
                await fs.copy(item.file, dest);
                jars.push({ file: dest, type: item.type, optional: item.disabled || undefined });
            }
            for (const sub of OVERRIDE_DIRS) if (await fs.pathExists(path.join(gameDir, sub))) await fs.copy(path.join(gameDir, sub), path.join(overrides, sub));
            if (await fs.pathExists(path.join(gameDir, 'options.txt'))) await fs.copy(path.join(gameDir, 'options.txt'), path.join(overrides, 'options.txt'));
        } else if (info.kind === 'packwiz') {
            await collectPackwiz(dir, { staging, overrides, jars, unknown }, onProgress);
        } else if (info.kind === 'folder') {
            const dir = (await fs.pathExists(path.join(source, 'mods'))) ? path.join(source, 'mods') : source;
            for (const f of (await fs.readdir(dir)).filter(x => x.toLowerCase().endsWith('.jar'))) {
                const dest = path.join(staging, 'mod', storage.safeFileName(f));
                await fs.copy(path.join(dir, f), dest);
                jars.push({ file: dest, type: 'mod' });
            }
            for (const sub of ['config', 'defaultconfigs', 'kubejs']) {
                if (await fs.pathExists(path.join(source, sub))) await fs.copy(path.join(source, sub), path.join(overrides, sub));
            }
        } else {
            const src = await ZipSource.fromFile(source);
            try {
                const entries = await src.entries();
                const overrideRoots = info.kind === 'mrpack' ? ['overrides/', 'client-overrides/'] : [`${(await readZipJson(src, entries, 'manifest.json')).overrides || 'overrides'}/`];
                for (const [entryName, e] of entries) {
                    const root = overrideRoots.find(r => entryName.startsWith(r));
                    if (!root || entryName.endsWith('/')) continue;
                    const rel = entryName.slice(root.length);
                    const dest = path.resolve(overrides, rel);
                    if (!dest.startsWith(path.resolve(overrides) + path.sep)) continue;   // zip-slip guard (the separator stops "../overrides-x")
                    await fs.outputFile(dest, await src.readEntry(e));
                }
                if (info.kind === 'mrpack') {
                    const index = await readZipJson(src, entries, 'modrinth.index.json');
                    const typed = index.files.map(f => ({ f, type: content.typeFromFolder(f.path.split('/')[0]) })).filter(x => x.type && content.typeOf(x.type).ext.test(x.f.path));
                    const found = await api.identifyModrinth(typed.map(x => x.f.hashes.sha1));
                    let n = 0;
                    await pool(typed, 6, async ({ f, type }) => {
                        const dest = path.join(staging, type, storage.safeFileName(path.basename(f.path)));
                        await storage.download(f.downloads[0], dest, { sha1: f.hashes.sha1 });
                        jars.push({ file: dest, type, mr: found[f.hashes.sha1] || null });
                        onProgress(0.05 + 0.5 * (++n / typed.length), `Downloading ${n} of ${typed.length}`);
                    });
                    for (const f of index.files.filter(x => !typed.some(t => t.f === x))) {
                        const dest = path.resolve(overrides, f.path);
                        if (dest.startsWith(path.resolve(overrides) + path.sep)) await storage.download(f.downloads[0], dest, { sha1: f.hashes.sha1 }).catch(() => {});
                    }
                } else {
                    const manifest = await readZipJson(src, entries, 'manifest.json');
                    const files = await api.cfFiles(manifest.files.map(f => f.fileID));
                    const classes = api.hasCurseForge() ? await api.cfMods(manifest.files.map(f => f.projectID)).catch(() => new Map()) : new Map();
                    let n = 0;
                    await pool(manifest.files, 6, async (f) => {
                        const file = files.get(Number(f.fileID));
                        if (!file?.url) { unknown.push(`CurseForge file ${f.fileID}`); return; }
                        const type = content.typeFromCfClass(classes.get(Number(f.projectID))?.classId) || 'mod';
                        const dest = path.join(staging, type, storage.safeFileName(file.fileName));
                        await storage.download(file.url, dest, { sha1: file.sha1 });
                        jars.push({ file: dest, type, cf: { modId: f.projectID, file }, optional: f.required === false });
                        onProgress(0.05 + 0.5 * (++n / manifest.files.length), `Downloading ${n} of ${manifest.files.length}`);
                    });
                }
            } finally { await src.close(); }
        }

        onProgress(0.6, 'Matching mods on both platforms');
        for (const j of jars) {
            const buf = await fs.readFile(j.file);
            j.sha1 = require('crypto').createHash('sha1').update(buf).digest('hex');
            j.fp = cfFingerprint(buf);
        }
        const needMr = jars.filter(j => !j.mr);
        if (needMr.length) { const r = await api.identifyModrinth(needMr.map(j => j.sha1)); for (const j of needMr) j.mr = r[j.sha1] || null; }
        const needCf = jars.filter(j => !j.cf);
        if (needCf.length && api.hasCurseForge()) {
            const r = await api.identifyCurseForge(needCf.map(j => j.fp)).catch(() => ({}));
            for (const j of needCf) j.cf = r[j.fp] || null;
        }

        onProgress(0.75, 'Building pack');
        const [projects, cfm] = await Promise.all([
            api.mrProjects(jars.map(j => j.mr?.projectId).filter(Boolean)),
            api.hasCurseForge() ? api.cfMods(jars.map(j => j.cf?.modId).filter(Boolean)) : new Map()
        ]);
        const entries = [];
        const seen = new Set();
        for (const j of jars) {
            const mrPart = j.mr ? { version: j.mr, project: projects.get(j.mr.projectId) } : null;
            const cfMod = j.cf ? cfm.get(Number(j.cf.modId)) : null;
            const cfPart = j.cf && cfMod && j.cf.file.url ? { mod: cfMod, file: j.cf.file } : null;
            if (!mrPart && !cfPart) { unknown.push(path.basename(j.file)); await fs.copy(j.file, path.join(overrides, content.typeOf(j.type).folder, path.basename(j.file))); continue; }
            const entry = api.toEntry({ modrinth: mrPart, curseforge: cfPart }, { type: j.type });
            const k = String(entry.ids.curseforge || entry.ids.modrinth);
            if (seen.has(k)) continue;
            seen.add(k);
            if (j.optional) entry.optional = true;
            if (j.side === 'client' || j.side === 'server') entry.side = j.side;
            if (portable) restoreModSettings(entry, portable);
            if (mrPart) await fs.copy(j.file, storage.paths.entryFile(target, 'modrinth', entry));
            if (cfPart) await fs.copy(j.file, storage.paths.entryFile(target, 'curseforge', entry));
            entry.hashes = { modrinth: mrPart ? { sha1: j.sha1, sha512: j.mr.sha512 } : null, curseforge: cfPart ? { sha1: j.sha1 } : null };
            entries.push(entry);
        }

        onProgress(0.9, 'Saving');
        await packs.addEntries(target, entries);
        await packs.sync(target, { quiet: true }).catch(() => {});
        return { path: target, imported: entries.length, both: entries.filter(e => e.ids.curseforge && e.ids.modrinth).length, unknown };
    } finally {
        await fs.remove(staging).catch(() => {});
    }
}

async function collectPackwiz(base, { staging, overrides, jars, unknown }, onProgress) {
    const src = packwizSource(base);
    const { pack } = await readPackwiz(src);
    const index = toml.parse((await src.get(pack.index?.file || 'index.toml')).toString('utf8'));
    const indexDir = path.posix.dirname(pack.index?.file || 'index.toml');
    const rel = (f) => (indexDir === '.' ? f : `${indexDir}/${f}`);
    const files = index.files || [];
    const metas = [];
    let n = 0;
    onProgress(0.04, 'Reading packwiz files');
    await pool(files, src.remote ? 8 : 16, async (f) => {
        if (!f.file || /(^|\/)\.\.(\/|$)/.test(f.file)) return;
        if (f.metafile || /\.pw\.toml$/i.test(f.file)) {
            try { metas.push({ path: f.file, m: toml.parse((await src.get(rel(f.file))).toString('utf8')) }); }
            catch { unknown.push(f.file); }
        } else {
            const dest = path.resolve(overrides, f.file);
            if (dest.startsWith(path.resolve(overrides) + path.sep)) await fs.outputFile(dest, await src.get(rel(f.file))).catch(() => unknown.push(f.file));
        }
        if (++n % 25 === 0) onProgress(0.04 + 0.1 * (n / files.length), `Reading ${n} of ${files.length}`);
    });

    const mrIds = metas.map(x => x.m.update?.modrinth?.version).filter(Boolean);
    const cfIds = metas.map(x => x.m.update?.curseforge?.['file-id']).filter(Boolean);
    const [mrVers, cfFilesById] = await Promise.all([
        mrIds.length ? api.mrVersions(mrIds).catch(() => new Map()) : new Map(),
        cfIds.length && api.hasCurseForge() ? api.cfFiles(cfIds).catch(() => new Map()) : new Map()
    ]);
    let done = 0;
    await pool(metas, 6, async ({ path: metaPath, m }) => {
        const folder = path.posix.dirname(metaPath).split('/')[0];
        const type = content.typeFromFolder(folder);
        const mrv = m.update?.modrinth?.version ? mrVers.get(m.update.modrinth.version) : null;
        const cff = m.update?.curseforge?.['file-id'] ? cfFilesById.get(Number(m.update.curseforge['file-id'])) : null;
        const url = m.download?.url || mrv?.url || cff?.url;
        const fileName = storage.safeFileName(m.filename || mrv?.fileName || cff?.fileName || path.posix.basename(metaPath, '.pw.toml'));
        if (!url) { unknown.push(m.name || fileName); return; }
        const sha1 = m.download?.['hash-format'] === 'sha1' ? m.download.hash : (mrv?.sha1 || cff?.sha1 || undefined);
        try {
            if (!type) {
                const dest = path.resolve(overrides, path.posix.dirname(metaPath), fileName);
                if (dest.startsWith(path.resolve(overrides) + path.sep)) await storage.download(url, dest, { sha1 });
                return;
            }
            const dest = path.join(staging, type, fileName);
            await storage.download(url, dest, { sha1 });
            jars.push({ file: dest, type, mr: mrv || null, cf: cff ? { modId: m.update.curseforge['project-id'], file: cff } : null,
                optional: m.option?.optional === true || undefined, side: ['client', 'server'].includes(m.side) ? m.side : undefined });
        } catch (err) { unknown.push(`${m.name || fileName} (${err.message})`); }
        onProgress(0.15 + 0.4 * (++done / metas.length), `Downloading ${done} of ${metas.length}`);
    });
}

// Written before the pack is opened, so nothing else is writing to it yet.
async function restorePackDetails(target, portable) {
    const meta = await storage.loadPack(target);
    for (const k of ['id', 'releases', 'links', 'license', 'tags', 'publish', 'launch', 'createdAt', 'modLinks', 'linkPolicy', 'releaseOptions']) if (portable[k] !== undefined) meta[k] = portable[k];
    if (typeof portable.icon === 'string' && portable.icon.startsWith('data:')) meta.icon = portable.icon;
    if (!meta.author && portable.author) meta.author = portable.author;
    if (!meta.description && portable.description) meta.description = portable.description;
    meta.importedFrom = { id: portable.id || null, exportedAt: portable.exportedAt || null };
    await storage.savePack(target, meta);
}

function restoreModSettings(entry, portable) {
    const old = portable.mods.find(m =>
        (entry.ids.curseforge && Number(m.ids?.curseforge) === Number(entry.ids.curseforge)) ||
        (entry.ids.modrinth && m.ids?.modrinth === entry.ids.modrinth));
    if (!old) return;
    for (const k of ['pinned', 'optional', 'side', 'notes', 'dateAdded']) if (old[k] !== undefined) entry[k] = old[k];
}

module.exports = { inspect, importPack, restoreModSettings };
