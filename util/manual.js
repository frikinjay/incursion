// Files added by hand for a platform that lacks the mod or blocks app downloads. The file sits in the normal
// installedFiles slot; entry.manual[platform] records where it came from:
//   { from: 'modrinth' | 'curseforge', sourceFile, version }   a copy of the other platform's file
//   { from: 'file', version }                                   a jar chosen by hand
//   { from: 'download', expectedFile, page, expectedSha1 }      CurseForge blocks app downloads
// plus sha1, size and addedAt once the file is in place. Copies are never updated automatically.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

const PLATFORMS = ['modrinth', 'curseforge'];
const NAME = { modrinth: 'Modrinth', curseforge: 'CurseForge' };
const otherOf = (pl) => (pl === 'modrinth' ? 'curseforge' : 'modrinth');

const isManual = (m, pl) => !!m.manual?.[pl];
const isLocal = (m) => !m.ids.curseforge && !m.ids.modrinth && !!m.ids.local;
const versionOf = (m, pl) => (pl === 'modrinth' ? m.meta?.mrVersionNumber : m.meta?.cfDisplayName) || m.installedFiles?.[pl] || null;

async function sha1Of(file) {
    return crypto.createHash('sha1').update(await fs.readFile(file)).digest('hex');
}

// Copies `src` into the pack as `name` for platform `pl`. Fails rather than overwrite another entry's file.
async function place(packPath, meta, m, pl, src, name, record) {
    name = storage.safeFileName(name);
    const taken = meta.mods.some(x => x !== m && x.installedFiles?.[pl]?.toLowerCase() === name.toLowerCase());
    if (taken) throw new Error(`Another mod in this pack already uses ${name} for ${NAME[pl]}.`);
    const old = m.installedFiles?.[pl] && isManual(m, pl) ? storage.paths.entryFile(packPath, pl, m) : null;
    const dest = storage.paths.modFile(packPath, pl, `${name}${m.disabled ? storage.paths.DISABLED : ''}`, m.type);
    if (path.resolve(src) !== path.resolve(dest)) {
        await fs.ensureDir(path.dirname(dest));
        await fs.copy(src, dest, { overwrite: true });
    }
    if (old && path.resolve(old) !== path.resolve(dest)) await fs.remove(old).catch(() => {});
    const stat = await fs.stat(dest);
    const sha1 = await sha1Of(dest);
    (m.installedFiles ||= {})[pl] = name;
    (m.hashes ||= {})[pl] = { sha1 };
    (m.sizes ||= {})[pl] = stat.size;
    (m.manual ||= {})[pl] = { ...record, sha1, size: stat.size, addedAt: Date.now() };
    return m.manual[pl];
}

// Takes a manual file out again. A blocked CurseForge download goes back to waiting for its file.
async function remove(packPath, m, pl) {
    const r = m.manual?.[pl];
    if (!r) return;
    if (m.installedFiles?.[pl]) await fs.remove(storage.paths.entryFile(packPath, pl, m)).catch(() => {});
    if (r.from === 'download') {
        m.installedFiles[pl] = r.expectedFile;
        m.hashes[pl] = r.expectedSha1 ? { sha1: r.expectedSha1 } : null;
        m.manual[pl] = { from: 'download', expectedFile: r.expectedFile, page: r.page, expectedSha1: r.expectedSha1 || null };
        return;
    }
    m.installedFiles[pl] = null;
    if (m.hashes) m.hashes[pl] = null;
    if (m.sizes) m.sizes[pl] = null;
    delete m.manual[pl];
    if (!Object.keys(m.manual).length) delete m.manual;
}

// Jars dropped into a platform folder that are byte-for-byte the other platform's file of an entry missing that
// platform, or the exact file a blocked CurseForge mod is waiting for. Those need no question: adopt them.
async function adoptExactCopies(packPath, meta, untracked) {
    const adopted = [];
    for (const m of meta.mods) {
        for (const pl of PLATFORMS) {
            const r = m.manual?.[pl];
            const o = otherOf(pl);
            if (r?.from !== 'download' || r.sha1) continue;
            const expected = storage.paths.entryFile(packPath, pl, m);
            if (await fs.pathExists(expected)) {
                const placed = await place(packPath, meta, m, pl, expected, r.expectedFile, { ...r });
                placed.matches = !r.expectedSha1 || r.expectedSha1 === placed.sha1;
                adopted.push(m);
                continue;
            }
            if (!r.expectedSha1 || r.expectedSha1 !== m.hashes?.[o]?.sha1) continue;
            const src = storage.paths.entryFile(packPath, o, m);
            if (!(await fs.pathExists(src))) continue;
            await place(packPath, meta, m, pl, src, r.expectedFile, { ...r, matches: true });
            adopted.push(m);
        }
    }
    for (const pl of PLATFORMS) {
        const names = untracked[pl] || [];
        if (!names.length) continue;
        const o = otherOf(pl);
        const waiting = meta.mods.filter(m => m.manual?.[pl]?.from === 'download');
        const lacking = meta.mods.filter(m => !m.installedFiles?.[pl] && m.installedFiles?.[o] && !isLocal(m));
        if (!waiting.length && !lacking.length) continue;
        const want = new Map();
        for (const m of lacking) {
            let sha1 = m.hashes?.[o]?.sha1;
            if (!sha1) sha1 = await sha1Of(storage.paths.entryFile(packPath, o, m)).catch(() => null);
            if (sha1) want.set(sha1, m);
        }
        for (const name of names) {
            const file = path.join(storage.paths.modsDir(packPath, pl), name);
            const sha1 = await sha1Of(file).catch(() => null);
            if (!sha1) continue;
            const blocked = waiting.find(m => (m.manual[pl].expectedSha1 && m.manual[pl].expectedSha1 === sha1) || m.manual[pl].expectedFile === name);
            if (blocked && !(await fs.pathExists(storage.paths.entryFile(packPath, pl, blocked)))) {
                await place(packPath, meta, blocked, pl, file, name, { ...blocked.manual[pl], matches: !blocked.manual[pl].expectedSha1 || blocked.manual[pl].expectedSha1 === sha1 });
                adopted.push(blocked);
                continue;
            }
            const m = want.get(sha1);
            if (!m || m.installedFiles?.[pl]) continue;
            await place(packPath, meta, m, pl, file, name, { from: o, sourceFile: m.installedFiles[o], version: versionOf(m, o) });
            adopted.push(m);
        }
    }
    return adopted;
}

module.exports = { PLATFORMS, NAME, otherOf, isManual, isLocal, versionOf, sha1Of, place, remove, adoptExactCopies };
