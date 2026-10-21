const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const storage = require('./storage');
const content = require('./content');
const { loaderInfo } = require('./loaders');

const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');
const PLATFORMS = ['modrinth', 'curseforge'];

async function pickFile(meta, m) {
    for (const pl of PLATFORMS) {
        if (!m.installedFiles?.[pl]) continue;
        const file = storage.paths.entryFile(meta.path, pl, m);
        if (await fs.pathExists(file)) return { platform: pl, file, name: storage.safeFileName(m.installedFiles[pl]), folder: content.typeOf(m).folder };
    }
    return null;
}

function zip(file, fill) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file);
        const archive = archiver('zip', { zlib: { level: 9 } });
        out.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(out);
        Promise.resolve(fill(archive)).then(() => archive.finalize(), reject);
    });
}

const PRISM_LOADER = {
    fabric: (v, gv) => [{ uid: 'net.fabricmc.intermediary', version: gv }, { uid: 'net.fabricmc.fabric-loader', version: v }],
    quilt: (v, gv) => [{ uid: 'net.fabricmc.intermediary', version: gv }, { uid: 'org.quiltmc.quilt-loader', version: v }],
    forge: (v) => [{ uid: 'net.minecraftforge', version: v }],
    neoforge: (v) => [{ uid: 'net.neoforged', version: v }]
};

async function exportPrism(meta, outDir, onProgress = () => {}) {
    const l = loaderInfo(meta.loader);
    if (!meta.loaderVersion) throw new Error('Set a loader version for this pack before exporting (Edit pack).');
    const mem = Number(meta.launch?.memoryMax || 4096);
    const cfg = [
        'InstanceType=OneSix',
        `name=${meta.name}`,
        'iconKey=default',
        'OverrideMemory=true',
        `MaxMemAlloc=${mem}`,
        `MinMemAlloc=${Math.min(1024, mem)}`,
        ...(meta.launch?.jvmArgs ? ['OverrideJavaArgs=true', `JvmArgs=${meta.launch.jvmArgs}`] : []),
        `notes=Exported from Incursion. ${String(meta.description || '').replace(/\r?\n/g, ' ')}`
    ].join('\n') + '\n';
    const pack = {
        formatVersion: 1,
        components: [{ uid: 'net.minecraft', version: meta.gameVersion, important: true }, ...PRISM_LOADER[l.id](meta.loaderVersion, meta.gameVersion)]
    };
    const files = [], skipped = [];
    for (const m of meta.mods) {
        const f = await pickFile(meta, m);
        if (f) files.push(f); else skipped.push(m.names.modrinth || m.names.curseforge);
    }
    const file = path.join(outDir, `${safeName(meta.name)}-${safeName(meta.version || '1.0.0')}-prism.zip`);
    const root = safeName(meta.name);
    await zip(file, async (archive) => {
        archive.append(cfg, { name: `${root}/instance.cfg` });
        archive.append(JSON.stringify(pack, null, 2), { name: `${root}/mmc-pack.json` });
        files.forEach((f, i) => { archive.file(f.file, { name: `${root}/.minecraft/${f.folder}/${f.name}` }); onProgress(Math.round(((i + 1) / files.length) * 90)); });
        const overrides = path.join(meta.path, 'overrides');
        if (await fs.pathExists(overrides)) archive.directory(overrides, `${root}/.minecraft`);
        if (typeof meta.icon === 'string' && meta.icon.startsWith('data:image/png;base64,')) archive.append(Buffer.from(meta.icon.split(',')[1], 'base64'), { name: `${root}/icon.png` });
    });
    return { path: file, count: files.length, skipped };
}

const tomlStr = (s) => JSON.stringify(String(s ?? ''));   // TOML basic strings use JSON-compatible escapes
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function exportPackwiz(meta, outDir, onProgress = () => {}) {
    const l = loaderInfo(meta.loader);
    if (!meta.loaderVersion) throw new Error('Set a loader version for this pack before exporting (Edit pack).');
    const dir = path.join(outDir, `${safeName(meta.name)}-packwiz`);
    if (await fs.pathExists(dir)) throw new Error(`${dir} already exists. Choose another folder or remove it first.`);
    await fs.ensureDir(dir);
    const index = [];
    const skipped = [];
    let n = 0;
    for (const m of meta.mods) {
        const t = content.typeOf(m);
        const mr = m.ids.modrinth && m.installedFiles?.modrinth && m.fileLinks?.modrinth;
        const cf = m.ids.curseforge && m.installedFiles?.curseforge && m.meta?.cfFileId;
        if (!mr && !cf) { skipped.push(m.names.modrinth || m.names.curseforge); continue; }
        const side = storage.sideOf(m);
        const lines = [
            `name = ${tomlStr(m.names.modrinth || m.names.curseforge)}`,
            `filename = ${tomlStr(mr ? m.installedFiles.modrinth : m.installedFiles.curseforge)}`,
            `side = ${tomlStr(side.client && side.server ? 'both' : side.server ? 'server' : 'client')}`,
            ...(m.optional ? ['', '[option]', 'optional = true', `description = ${tomlStr(m.notes || m.summary || '')}`] : []),
            '',
            '[download]'
        ];
        if (mr) {
            let sha512 = m.hashes?.modrinth?.sha512;
            if (!sha512) {
                const local = storage.paths.entryFile(meta.path, 'modrinth', m);
                if (await fs.pathExists(local)) sha512 = (await storage.hashFile(local, ['sha512'])).sha512;
            }
            if (!sha512) { skipped.push(m.names.modrinth); continue; }
            lines.push(`url = ${tomlStr(m.fileLinks.modrinth)}`, 'hash-format = "sha512"', `hash = ${tomlStr(sha512)}`);
        } else {
            lines.push('hash-format = "sha1"', `hash = ${tomlStr(m.hashes?.curseforge?.sha1 || '')}`, 'mode = "metadata:curseforge"');
        }
        lines.push('', '[update]');
        if (cf) lines.push('[update.curseforge]', `file-id = ${Number(m.meta.cfFileId)}`, `project-id = ${Number(m.ids.curseforge)}`);
        if (mr) lines.push('[update.modrinth]', `mod-id = ${tomlStr(m.ids.modrinth)}`, `version = ${tomlStr(m.meta?.mrVersionId || '')}`);
        const slug = m.slugs?.modrinth || m.slugs?.curseforge || storage.safeFileName(m.installedFiles.modrinth || m.installedFiles.curseforge).replace(/\.[^.]+$/, '');
        const rel = `${t.folder}/${safeName(slug)}.pw.toml`;
        const body = lines.join('\n') + '\n';
        await fs.outputFile(path.join(dir, rel), body);
        index.push({ file: rel, hash: sha256(Buffer.from(body)), metafile: true });
        onProgress(Math.round((++n / meta.mods.length) * 80));
    }
    const overrides = path.join(meta.path, 'overrides');
    if (await fs.pathExists(overrides)) {
        const walk = async (d) => {
            for (const e of await fs.readdir(d, { withFileTypes: true })) {
                const full = path.join(d, e.name);
                if (e.isDirectory()) await walk(full);
                else {
                    const rel = path.relative(overrides, full).split(path.sep).join('/');
                    const buf = await fs.readFile(full);
                    await fs.outputFile(path.join(dir, rel), buf);
                    index.push({ file: rel, hash: sha256(buf) });
                }
            }
        };
        await walk(overrides);
    }
    const indexToml = 'hash-format = "sha256"\n' + index.sort((a, b) => a.file.localeCompare(b.file)).map(f => `\n[[files]]\nfile = ${tomlStr(f.file)}\nhash = ${tomlStr(f.hash)}${f.metafile ? '\nmetafile = true' : ''}\n`).join('');
    await fs.outputFile(path.join(dir, 'index.toml'), indexToml);
    const packToml = [
        `name = ${tomlStr(meta.name)}`,
        `author = ${tomlStr(meta.author || '')}`,
        `version = ${tomlStr(meta.version || '1.0.0')}`,
        'pack-format = "packwiz:1.1.0"',
        '',
        '[index]',
        'file = "index.toml"',
        'hash-format = "sha256"',
        `hash = ${tomlStr(sha256(Buffer.from(indexToml)))}`,
        '',
        '[versions]',
        `minecraft = ${tomlStr(meta.gameVersion)}`,
        `${l.id} = ${tomlStr(meta.loaderVersion)}`
    ].join('\n') + '\n';
    await fs.outputFile(path.join(dir, 'pack.toml'), packToml);
    onProgress(100);
    return { path: path.join(dir, 'pack.toml'), count: index.filter(f => f.metafile).length, skipped };
}

module.exports = { exportPrism, exportPackwiz };
