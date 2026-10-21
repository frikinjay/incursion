// No Electron imports here, so this runs in plain Node too.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const archiver = require('archiver');

const META_FILE = 'incursion.json';
const LEGACY_META_FILE = 'pack-metadata.json';
const { request } = require('./http');
const { loaderInfo } = require('./loaders');

let dirs = { userData: null };
let secrets = { encrypt: (s) => s, decrypt: (s) => s, available: false };

const p = (name) => path.join(dirs.userData, name);
const writeQueues = new Map();
const lastBackup = new Map();
const BACKUP_EVERY = 60 * 1000;

// Flush before returning so a power cut can't leave a renamed but empty file.
async function writeDurable(file, data) {
    const fh = await fs.promises.open(file, 'w');
    try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
}
// Windows briefly locks files while antivirus or indexing reads them, so retry the rename.
async function renameRetry(from, to) {
    for (let i = 0; ; i++) {
        try { return await fs.promises.rename(from, to); }
        catch (err) { if (i >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err; await new Promise(r => setTimeout(r, 40 * (i + 1))); }
    }
}

// Writes to one file never interleave. Write to a temp file, flush, then rename over the old one. About once a minute
// the last good version is kept as <file>.bak for recovery.
function writeAtomic(file, text) {
    const prev = writeQueues.get(file) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
        await fs.ensureDir(path.dirname(file));
        const tmp = `${file}.${process.pid}.tmp`;
        await writeDurable(tmp, text);
        if (Date.now() - (lastBackup.get(file) || 0) > BACKUP_EVERY) {
            try {
                // Only a version that still parses becomes the backup.
                if (!file.endsWith('.json') || JSON.parse(await fs.readFile(file, 'utf8')) !== undefined) await fs.copyFile(file, `${file}.bak`);
                lastBackup.set(file, Date.now());
            } catch {}
        }
        await renameRetry(tmp, file);
    });
    writeQueues.set(file, next);
    next.finally(() => { if (writeQueues.get(file) === next) writeQueues.delete(file); });
    return next;
}
const writeJsonAtomic = (file, data, { pretty = true } = {}) => writeAtomic(file, JSON.stringify(data, null, pretty ? 2 : 0));

// A file that won't parse is set aside as <file>.corrupt-<time> and the .bak is restored. Callers that can't lose data
// pass `strict` to get an error instead of `fallback`.
async function readJsonSafe(file, fallback, { strict = false } = {}) {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        text = null;
    }
    if (text != null) { try { return JSON.parse(text.replace(/^﻿/, '')); } catch {} }
    try {
        const data = JSON.parse((await fs.readFile(`${file}.bak`, 'utf8')).replace(/^﻿/, ''));
        if (text != null) await fs.copyFile(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
        await writeJsonAtomic(file, data).catch(() => {});
        console.warn(`[storage] ${path.basename(file)} ${text == null ? 'was missing' : 'was damaged'}; restored the backup.`);
        return data;
    } catch {}
    if (text != null) {
        await fs.copyFile(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
        if (strict) throw Object.assign(new Error(`${path.basename(file)} is damaged and has no usable backup. A copy was kept next to it.`), { code: 'CORRUPT' });
    }
    return fallback;
}
const readJson = (file, fallback) => readJsonSafe(file, fallback);

// Strip directories from API file names so a malicious name can't escape the mods folder.
function safeFileName(name) {
    const base = path.basename(String(name || '')).replace(/[<>:"|?*\x00-\x1f]/g, '_');
    if (!base || base === '.' || base === '..') throw new Error(`Invalid file name "${name}"`);
    return base;
}

const content = require('./content');
const modsDir = (packPath, platform, type) => path.join(packPath, platform, content.typeOf(type).folder);
const modFile = (packPath, platform, fileName, type) => path.join(modsDir(packPath, platform, type), safeFileName(fileName));
const DISABLED = '.disabled';
const entryFile = (packPath, platform, m) => modFile(packPath, platform, `${m.installedFiles[platform]}${m.disabled ? DISABLED : ''}`, m.type);

async function hashFile(file, algos = ['sha1']) {
    const hashes = algos.map(a => crypto.createHash(a));
    await pipeline(fs.createReadStream(file), async function* (src) {
        for await (const chunk of src) for (const h of hashes) h.update(chunk);
    });
    return Object.fromEntries(algos.map((a, i) => [a, hashes[i].digest('hex')]));
}

const storage = {
    init(userDataDir, secretBox) {
        dirs.userData = userDataDir;
        if (secretBox) secrets = secretBox;
        for (const legacy of ['api-cache.json', 'versions-cache.json', 'loader-versions-cache.json']) fs.remove(p(legacy)).catch(() => {});
        return { cacheFile: p('api-cache-v2.json') };
    },

    paths: { modsDir, modFile, entryFile, DISABLED },
    safeFileName,
    hashFile,
    writeJsonAtomic,
    writeAtomic,
    readJsonSafe,

    // Tokens are encrypted with the OS keychain (safeStorage). Everything else is plain preferences.
    SECRET_KEYS: ['curseforge', 'curseforgeUpload', 'modrinth'],

    async getSettings() {
        const raw = await readJson(p('settings.json'), {});
        const out = { theme: raw.theme || 'system', prefs: raw.prefs || {} };
        let legacy = false;
        for (const k of storage.SECRET_KEYS) {
            out[k] = '';
            if (raw[`${k}Enc`]) { try { out[k] = secrets.decrypt(raw[`${k}Enc`]); } catch { out[k] = ''; } }
            else if (raw[k]) { out[k] = raw[k]; legacy = true; }   // old plaintext value, re-saved encrypted below
        }
        if (legacy && secrets.available) await storage.saveSettings(out);
        return out;
    },

    async saveSettings(next) {
        const current = await readJson(p('settings.json'), {});
        const out = { theme: next.theme ?? current.theme ?? 'system', prefs: { ...(current.prefs || {}), ...(next.prefs || {}) } };
        for (const k of storage.SECRET_KEYS) {
            let value;
            if (typeof next[k] === 'string') value = next[k];
            else if (current[`${k}Enc`]) { try { value = secrets.decrypt(current[`${k}Enc`]); } catch { value = ''; } }
            else value = current[k] || '';
            if (!value) continue;
            if (secrets.available) out[`${k}Enc`] = secrets.encrypt(value); else out[k] = value;
        }
        await writeJsonAtomic(p('settings.json'), out);
        return { success: true };
    },

    getLibrary: () => readJson(p('global-packs.json'), []),
    saveLibrary: (packs) => writeJsonAtomic(p('global-packs.json'), packs),

    META_FILE,
    hasPack: async (packPath) => (await fs.pathExists(path.join(packPath, META_FILE))) || fs.pathExists(path.join(packPath, LEGACY_META_FILE)),

    async loadPack(packPath) {
        const file = path.join(packPath, META_FILE);
        const legacy = path.join(packPath, LEGACY_META_FILE);
        const useLegacy = !(await fs.pathExists(file)) && !(await fs.pathExists(`${file}.bak`));
        if (useLegacy && !(await fs.pathExists(legacy))) throw new Error(`No ${META_FILE} in that folder.`);
        // Recover a damaged incursion.json from its backup, never replace it with an empty pack.
        const meta = await readJsonSafe(useLegacy ? legacy : file, null, { strict: true });
        if (!meta || !Array.isArray(meta.mods)) throw new Error(`${useLegacy ? LEGACY_META_FILE : META_FILE} is malformed.`);
        delete meta.pendingUpdates;
        meta.path = packPath;
        if (useLegacy) {
            await writeJsonAtomic(file, meta);
            await fs.remove(legacy).catch(() => {});
        }
        return meta;
    },
    savePack: (packPath, meta) => writeJsonAtomic(path.join(packPath, META_FILE), meta),

    // Metadata as it travels inside an .mrpack / CurseForge zip: nothing tied to this computer.
    portableMeta(meta) {
        const out = JSON.parse(JSON.stringify(meta));
        delete out.path;
        delete out.syncedAt;
        if (out.launch?.java && out.launch.java !== 'default' && /[\\/]/.test(out.launch.java)) out.launch.java = 'default';
        if (typeof out.icon === 'string' && !out.icon.startsWith('data:')) delete out.icon;
        for (const m of out.mods || []) delete m.contents?.path;
        out.exportedAt = Date.now();
        return out;
    },
    loadPending: (packPath) => readJson(path.join(packPath, 'pending_updates.json'), {}),
    savePending: (packPath, updates) => writeJsonAtomic(path.join(packPath, 'pending_updates.json'), updates),

    async removeModFiles(packPath, files, type) {
        for (const platform of ['curseforge', 'modrinth']) {
            if (!files?.[platform]) continue;
            await fs.remove(modFile(packPath, platform, files[platform], type)).catch(() => {});
            await fs.remove(modFile(packPath, platform, `${files[platform]}${DISABLED}`, type)).catch(() => {});
        }
    },

    async findMissing(packPath, mods, keyOf) {
        const missing = {};
        await Promise.all(mods.flatMap(m => ['curseforge', 'modrinth'].filter(pl => m.installedFiles?.[pl]).map(async pl => {
            if (!(await fs.pathExists(entryFile(packPath, pl, m)))) (missing[keyOf(m)] ||= []).push(pl);
        })));
        return missing;
    },

    async download(url, dest, { sha1, onBytes } = {}) {
        if (!/^https:\/\//.test(url || '')) throw new Error('Missing or insecure download URL');
        await fs.ensureDir(path.dirname(dest));
        const part = `${dest}.part`;
        const res = await request(url, { as: 'response', timeout: 120000, headers: { Accept: '*/*' } });
        const hash = crypto.createHash('sha1');
        try {
            await pipeline(
                Readable.fromWeb(res.body),
                async function* (src) { for await (const c of src) { hash.update(c); onBytes?.(c.length); yield c; } },
                fs.createWriteStream(part)
            );
            // Flush before the rename so a sudden shutdown can't leave a truncated file under the final name.
            const fh = await fs.promises.open(part, 'r+');
            try { await fh.sync(); } finally { await fh.close(); }
            const got = hash.digest('hex');
            if (sha1 && got !== sha1) throw new Error(`Checksum mismatch for ${path.basename(dest)}`);
            await fs.move(part, dest, { overwrite: true });
            return { sha1: got };
        } catch (err) {
            await fs.remove(part).catch(() => {});
            throw err;
        }
    },

    // Jobs with the same sha1 are the same file (most mods are byte-identical on both platforms), so download once and
    // copy.
    async downloadAll(jobs, { onBytes } = {}) {
        const groups = new Map();
        jobs.forEach((j, i) => {
            const k = j.sha1 ? `sha1:${j.sha1}` : `job:${i}`;
            (groups.get(k) || groups.set(k, []).get(k)).push(i);
        });
        const out = new Array(jobs.length);
        await Promise.all([...groups.values()].map(async (idx) => {
            const first = jobs[idx[0]];
            out[idx[0]] = await storage.download(first.url, first.dest, { sha1: first.sha1, onBytes });
            for (const i of idx.slice(1)) {
                await fs.ensureDir(path.dirname(jobs[i].dest));
                if (path.resolve(jobs[i].dest) !== path.resolve(first.dest)) await fs.copyFile(first.dest, jobs[i].dest);
                out[i] = out[idx[0]];
            }
        }));
        return out;
    },

    async exportCurseForge(meta, outDir, onProgress = () => {}) {
        const l = loaderInfo(meta.loader);
        if (!meta.loaderVersion) throw new Error('Set a loader version for this pack before exporting (Edit pack).');
        const mods = meta.mods.filter(m => m.ids.curseforge);
        const skipped = mods.filter(m => !Number(m.meta?.cfFileId)).map(m => m.names.curseforge);
        const included = mods.filter(m => Number(m.meta?.cfFileId));
        const manifest = {
            minecraft: { version: meta.gameVersion, modLoaders: [{ id: `${l.cfManifest}-${meta.loaderVersion}`, primary: true }] },
            manifestType: 'minecraftModpack',
            manifestVersion: 1,
            name: meta.name,
            version: meta.version || '1.0.0',
            author: meta.author || '',
            files: included.map(m => ({ projectID: Number(m.ids.curseforge), fileID: Number(m.meta.cfFileId), required: !m.optional })),
            overrides: 'overrides'
        };
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const modlist = `<ul>\n${included.map(m => `<li><a href="${esc(m.links.curseforge)}">${esc(m.names.curseforge)} (by ${esc(m.authors?.curseforge || 'Unknown')})</a></li>`).join('\n')}\n</ul>\n`;
        const file = path.join(outDir, `${safeName(meta.name)}-${safeName(meta.version || '1.0.0')}.zip`);
        const bundled = [];
        await zip(file, async (archive) => {
            archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
            archive.append(modlist, { name: 'modlist.html' });
            archive.append(JSON.stringify(storage.portableMeta(meta), null, 2), { name: META_FILE });
            await appendOverrides(archive, meta.path, 'overrides');
            await appendManualFiles(archive, meta, 'curseforge', bundled);
        }, onProgress);
        return { path: file, count: included.length + bundled.length, skipped, bundled };
    },

    async exportModrinth(meta, outDir, onProgress = () => {}) {
        const l = loaderInfo(meta.loader);
        if (!meta.loaderVersion) throw new Error('Set a loader version for this pack before exporting (Edit pack).');
        const mods = meta.mods.filter(m => m.ids.modrinth && m.installedFiles?.modrinth);
        const files = [], skipped = [];
        let i = 0;
        for (const mod of mods) {
            const local = entryFile(meta.path, 'modrinth', mod);
            if (!(await fs.pathExists(local))) { skipped.push(mod.names.modrinth); continue; }
            const side = sideOf(mod);
            const want = mod.optional ? 'optional' : 'required';
            files.push({
                path: `${content.typeOf(mod).folder}/${safeFileName(mod.installedFiles.modrinth)}`,
                hashes: await hashFile(local, ['sha1', 'sha512']),
                env: { client: side.client ? want : 'unsupported', server: side.server ? want : 'unsupported' },
                downloads: [mod.fileLinks.modrinth],
                fileSize: (await fs.stat(local)).size
            });
            onProgress(Math.round((++i / mods.length) * 80));
        }
        const index = {
            formatVersion: 1, game: 'minecraft',
            versionId: meta.version || '1.0.0', name: meta.name, summary: meta.description || '',
            files,
            dependencies: { minecraft: meta.gameVersion, [l.mrpack]: meta.loaderVersion }
        };
        const file = path.join(outDir, `${safeName(meta.name)}-${safeName(meta.version || '1.0.0')}.mrpack`);
        const bundled = [];
        await zip(file, async (archive) => {
            archive.append(JSON.stringify(index, null, 2), { name: 'modrinth.index.json' });
            archive.append(JSON.stringify(storage.portableMeta(meta), null, 2), { name: META_FILE });
            await appendOverrides(archive, meta.path, 'overrides');
            await appendManualFiles(archive, meta, 'modrinth', bundled);
        }, (pct) => onProgress(80 + Math.round(pct / 5)));
        return { path: file, count: files.length + bundled.length, skipped, bundled };
    }
};

const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');

function sideOf(m) {
    if (content.typeOf(m).clientOnly) return { client: true, server: false };
    if (m.side === 'client') return { client: true, server: false };
    if (m.side === 'server') return { client: false, server: true };
    if (m.side === 'both') return { client: true, server: true };
    const envs = [m.environments?.modrinth, m.environments?.curseforge].filter(Boolean);
    if (!envs.length) return { client: true, server: true };
    return { client: envs.some(e => e.client), server: envs.some(e => e.server) };
}
storage.sideOf = sideOf;

const SIDEDNESS_LABEL = { scan: 'Incursion scan', modrinth: 'Modrinth side information', curseforge: 'CurseForge side information' };

const CLIENT_ONLY = new Set(['resourcepacks', 'shaderpacks', 'screenshots', 'saves', 'options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat', 'emotes', 'schematics']);

// The EULA is left for the server owner to accept.
storage.exportServer = async function exportServer(meta, outDir, onProgress = () => {}, { sidedness = meta.publish?.serverSidedness || 'scan' } = {}) {
    const l = loaderInfo(meta.loader);
    if (!meta.loaderVersion) throw new Error('Set a loader version for this pack before exporting (Edit pack).');
    const mem = Math.max(2048, Number(meta.launch?.memoryMax || 4096));
    const tmp = path.join(require('os').tmpdir(), `incursion-server-${Date.now()}`);
    await fs.ensureDir(tmp);
    try {
        const jars = [], skipped = [];
        const { included, excluded } = require('./sidedness').split(meta.mods, sidedness);
        for (const { m } of included) {
            let picked = null;
            for (const pl of ['modrinth', 'curseforge']) {
                const f = m.installedFiles?.[pl];
                if (f && (await fs.pathExists(entryFile(meta.path, pl, m)))) { picked = { file: entryFile(meta.path, pl, m), name: safeFileName(f), folder: content.typeOf(m).folder }; break; }
            }
            if (picked) jars.push(picked); else skipped.push(m.names.modrinth || m.names.curseforge);
        }
        onProgress(10);

        let launchLine, installNote = '';
        const loaderFiles = [];
        if (l.id === 'fabric') {
            const installers = await request('https://meta.fabricmc.net/v2/versions/installer');
            const inst = (installers.find(i => i.stable) || installers[0]).version;
            const dest = path.join(tmp, 'fabric-server-launch.jar');
            await storage.download(`https://meta.fabricmc.net/v2/versions/loader/${meta.gameVersion}/${meta.loaderVersion}/${inst}/server/jar`, dest);
            loaderFiles.push({ file: dest, name: 'fabric-server-launch.jar' });
            launchLine = `java -Xms1G -Xmx${mem}M -jar fabric-server-launch.jar nogui`;
        } else if (l.id === 'neoforge' || l.id === 'forge') {
            const url = l.id === 'neoforge'
                ? `https://maven.neoforged.net/releases/net/neoforged/neoforge/${meta.loaderVersion}/neoforge-${meta.loaderVersion}-installer.jar`
                : `https://maven.minecraftforge.net/net/minecraftforge/forge/${meta.gameVersion}-${meta.loaderVersion}/forge-${meta.gameVersion}-${meta.loaderVersion}-installer.jar`;
            const name = `${l.id}-installer.jar`;
            await storage.download(url, path.join(tmp, name));
            loaderFiles.push({ file: path.join(tmp, name), name });
            installNote = `Run install.bat (Windows) or install.sh once to install ${l.label} ${meta.loaderVersion}. It creates run.bat / run.sh.`;
            launchLine = null;
        } else {
            installNote = `Install the Quilt server for Minecraft ${meta.gameVersion} (loader ${meta.loaderVersion}) with the Quilt installer: https://quiltmc.org/install/server/`;
        }
        onProgress(30);

        const scripts = {};
        if (launchLine) {
            scripts['start.bat'] = `@echo off\r\n${launchLine}\r\npause\r\n`;
            scripts['start.sh'] = `#!/usr/bin/env sh\n${launchLine}\n`;
        } else if (loaderFiles.length) {
            const n = loaderFiles[0].name;
            scripts['install.bat'] = `@echo off\r\njava -jar ${n} --installServer\r\necho Edit user_jvm_args.txt to set memory (-Xmx${mem}M), then use run.bat.\r\npause\r\n`;
            scripts['install.sh'] = `#!/usr/bin/env sh\njava -jar ${n} --installServer\necho "Edit user_jvm_args.txt to set memory (-Xmx${mem}M), then use ./run.sh"\n`;
            scripts['user_jvm_args.txt'] = `-Xms1G\n-Xmx${mem}M\n`;
        }
        const leftOut = excluded.filter(x => content.typeOf(x.m).id === 'mod');
        const readme = [
            `${meta.name} ${meta.version || ''} server`.trim(),
            '',
            `Minecraft ${meta.gameVersion}, ${l.label} ${meta.loaderVersion}, ${jars.filter(j => j.folder === 'mods').length} server-side mods${jars.some(j => j.folder === 'datapacks') ? ` and ${jars.filter(j => j.folder === 'datapacks').length} data packs (in datapacks/, for a global data pack loader such as Paxi or Open Loader)` : ''}.`,
            installNote,
            launchLine ? 'Start the server with start.bat (Windows) or start.sh.' : '',
            '',
            'Before the first start, read and accept the Minecraft EULA (https://aka.ms/MinecraftEULA) by setting eula=true in eula.txt.',
            skipped.length ? `\nNot included (file missing in the pack folder): ${skipped.join(', ')}` : '',
            leftOut.length ? `\nLeft out as client-side (${SIDEDNESS_LABEL[sidedness]}):\n${leftOut.map(x => `  - ${x.m.names.modrinth || x.m.names.curseforge}: ${x.reason}`).join('\n')}` : ''
        ].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');

        const file = path.join(outDir, `${safeName(meta.name)}-${safeName(meta.version || '1.0.0')}-server.zip`);
        await zip(file, async (archive) => {
            for (const j of jars) archive.file(j.file, { name: `${j.folder}/${j.name}` });
            for (const f of loaderFiles) archive.file(f.file, { name: f.name });
            for (const [name, body] of Object.entries(scripts)) archive.append(body, { name, mode: name.endsWith('.sh') ? 0o755 : 0o644 });
            archive.append(readme + '\n', { name: 'README.txt' });
            const overrides = path.join(meta.path, 'overrides');
            if (await fs.pathExists(overrides)) {
                archive.glob('**/*', { cwd: overrides, dot: true, nodir: true, ignore: [...CLIENT_ONLY].flatMap(x => [x, `${x}/**`]) });
            }
        }, (pct) => onProgress(30 + Math.round(pct * 0.7)));
        return { path: file, count: jars.length, skipped, excluded: excluded.map(x => ({ title: x.m.names.modrinth || x.m.names.curseforge, reason: x.reason })), sidedness };
    } finally {
        await fs.remove(tmp).catch(() => {});
    }
};

async function appendOverrides(archive, packPath, prefix) {
    const dir = path.join(packPath, 'overrides');
    if (await fs.pathExists(dir)) archive.directory(dir, prefix);
}

// Files added by hand can't be linked from the platform's manifest, so they ship inside the pack.
async function appendManualFiles(archive, meta, pl, out) {
    for (const m of meta.mods) {
        const r = m.manual?.[pl];
        if (!r || r.from === 'download' || !m.installedFiles?.[pl]) continue;
        const src = entryFile(meta.path, pl, m);
        if (!(await fs.pathExists(src))) continue;
        archive.file(src, { name: `overrides/${content.typeOf(m).folder}/${safeFileName(m.installedFiles[pl])}` });
        out.push(m.names?.[pl] || m.names?.curseforge || m.names?.modrinth || m.installedFiles[pl]);
    }
}

function zip(file, fill, onProgress) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(file);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => { onProgress(100); resolve(); });
        output.on('error', reject);
        archive.on('error', reject);
        archive.on('progress', (pr) => { if (pr.entries.total) onProgress(Math.round((pr.entries.processed / pr.entries.total) * 100)); });
        archive.pipe(output);
        Promise.resolve(fill(archive)).then(() => archive.finalize(), reject);
    });
}

module.exports = storage;
