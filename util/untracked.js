const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const api = require('./api');
const storage = require('./storage');
const { cfFingerprint, inspectJar } = require('./jars');

const PLATFORMS = ['modrinth', 'curseforge'];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function list(packPath, mods) {
    const out = { modrinth: [], curseforge: [] };
    for (const pl of PLATFORMS) {
        const tracked = new Set(mods.map(m => m.installedFiles?.[pl]).filter(Boolean).map(f => storage.safeFileName(f).toLowerCase()));
        const dir = storage.paths.modsDir(packPath, pl);
        const names = await fs.readdir(dir).catch(() => []);
        out[pl] = names.filter(n => /\.jar$/i.test(n) && !tracked.has(n.toLowerCase())).sort();
    }
    return out;
}

async function review(packPath, meta) {
    const files = await list(packPath, meta.mods);
    const jars = [];
    for (const pl of PLATFORMS) {
        for (const name of files[pl]) {
            const full = path.join(storage.paths.modsDir(packPath, pl), name);
            const buf = await fs.readFile(full);
            jars.push({ platform: pl, name, size: buf.length, sha1: crypto.createHash('sha1').update(buf).digest('hex'), fp: cfFingerprint(buf) });
        }
    }
    if (!jars.length) return [];

    const [mr, cf] = await Promise.all([
        api.identifyModrinth(jars.map(j => j.sha1)).catch(() => ({})),
        api.hasCurseForge() ? api.identifyCurseForge(jars.map(j => j.fp)).catch(() => ({})) : {}
    ]);
    for (const j of jars) { j.mr = mr[j.sha1] || null; j.cf = cf[j.fp] || null; }

    const groups = [];
    const byMr = new Map(), byCf = new Map();
    for (const j of jars) {
        const mrId = j.mr?.projectId || null, cfId = j.cf ? Number(j.cf.modId) : null;
        let g = (mrId && byMr.get(mrId)) || (cfId && byCf.get(cfId));
        if (!g) { g = { ids: { modrinth: null, curseforge: null }, jars: [] }; groups.push(g); }
        g.jars.push(j);
        if (mrId) { g.ids.modrinth = mrId; byMr.set(mrId, g); }
        if (cfId) { g.ids.curseforge = cfId; byCf.set(cfId, g); }
    }

    const [projects, cfMods] = await Promise.all([
        api.mrProjects(groups.map(g => g.ids.modrinth).filter(Boolean)).catch(() => new Map()),
        api.hasCurseForge() ? api.cfMods(groups.map(g => g.ids.curseforge).filter(Boolean)).catch(() => new Map()) : new Map()
    ]);

    const nameOf = (g) => norm(projects.get(g.ids.modrinth)?.title || cfMods.get(g.ids.curseforge)?.name);
    const slugOf = (g) => projects.get(g.ids.modrinth)?.slug || cfMods.get(g.ids.curseforge)?.slug;
    for (const a of groups.filter(g => g.ids.modrinth && !g.ids.curseforge)) {
        const b = groups.find(g => g !== a && g.ids.curseforge && !g.ids.modrinth && !g.merged && (slugOf(g) === slugOf(a) || (nameOf(g) && nameOf(g) === nameOf(a))));
        if (!b) continue;
        a.ids.curseforge = b.ids.curseforge;
        a.jars.push(...b.jars);
        b.merged = true;
    }

    const out = [];
    for (const g of groups.filter(x => !x.merged)) {
        const project = projects.get(g.ids.modrinth), cfMod = cfMods.get(g.ids.curseforge);
        const local = {};
        for (const pl of PLATFORMS) {
            const j = g.jars.find(x => x.platform === pl);
            if (j) local[pl] = { name: j.name, size: j.size, sha1: j.sha1, version: pl === 'modrinth' ? j.mr : null, file: pl === 'curseforge' ? j.cf?.file : null };
        }
        const any = g.jars[0];
        let tracked = meta.mods.find(m =>
            (g.ids.curseforge && Number(m.ids.curseforge) === g.ids.curseforge) || (g.ids.modrinth && m.ids.modrinth === g.ids.modrinth));
        let jarIds = [];
        if (!tracked && g.jars.length === 1) {
            const d = await inspectJar(path.join(storage.paths.modsDir(packPath, any.platform), any.name)).catch(() => null);
            jarIds = (d?.ids || []).filter(i => !i.provided).map(i => i.id.toLowerCase());
            tracked = jarIds.length ? meta.mods.find(m => !m.installedFiles?.[any.platform] && (m.contents?.ids || []).some(i => !i.provided && jarIds.includes(String(i.id).toLowerCase()))) : null;
        }
        // A jar for a mod the pack has, in the folder of the platform that lacks it: a hand-added file.
        const fillsGap = tracked && g.jars.length === 1 && !tracked.installedFiles?.[any.platform];
        const item = {
            id: `${g.ids.modrinth || '-'}|${g.ids.curseforge || '-'}|${g.jars.map(j => j.sha1).join(',')}`,
            title: project?.title || cfMod?.name || any.name.replace(/\.jar$/i, ''),
            icon: project?.icon || cfMod?.icon || null,
            ids: g.ids,
            local,
            files: g.jars.map(j => ({ platform: j.platform, name: j.name })),
            trackedKey: tracked ? api.modKey(tracked) : null
        };
        if (fillsGap) { item.plan = 'manual'; item.platform = any.platform; item.title = tracked.names?.curseforge || tracked.names?.modrinth || item.title; }
        else if (tracked) item.plan = 'stray';
        else if (!g.ids.modrinth && !g.ids.curseforge) item.plan = 'unknown';
        else if (local.modrinth && local.curseforge) item.plan = 'link';
        else {
            const have = local.modrinth ? 'modrinth' : 'curseforge';
            const other = have === 'modrinth' ? 'curseforge' : 'modrinth';
            const j = g.jars[0];
            if (other === 'curseforge' && j.cf) item.plan = 'copy';
            else if (other === 'modrinth' && j.mr) item.plan = 'copy';
            else item.plan = 'single';
            item.missing = other;
            if (item.plan === 'single') {
                const slug = slugOf(g);
                if (other === 'curseforge' && slug && api.hasCurseForge()) {
                    const twin = await api.cfBySlug(slug, meta.gameVersion, meta.loader).catch(() => null);
                    if (twin) { item.plan = 'download'; item.ids.curseforge = twin.mod.id; }
                } else if (other === 'modrinth' && slug) {
                    const p = (await api.mrProjects([slug]).catch(() => new Map())).get(slug);
                    if (p && p.loaders?.includes(meta.loader) && p.gameVersions?.includes(meta.gameVersion)) { item.plan = 'download'; item.ids.modrinth = p.id; }
                }
            }
        }
        out.push(item);
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
}

async function adopt(packPath, meta, items, choices) {
    const entries = [];
    for (const item of items) {
        const mode = choices[item.id] || 'both';
        if (!['link', 'copy', 'download', 'single'].includes(item.plan)) continue;
        const parts = { modrinth: null, curseforge: null };
        const want = { modrinth: !!item.local.modrinth, curseforge: !!item.local.curseforge };
        if (mode === 'both' && item.missing) want[item.missing] = true;

        if (want.modrinth) {
            const exact = item.local.modrinth?.version || (item.plan === 'copy' && item.missing === 'modrinth' ? (await api.identifyModrinth([item.local.curseforge.sha1]))[item.local.curseforge.sha1] : null);
            if (exact) parts.modrinth = { version: exact, project: (await api.mrProjects([exact.projectId])).get(exact.projectId) };
            else if (item.ids.modrinth) parts.modrinth = (await api.resolve({ platforms: { modrinth: { id: item.ids.modrinth } }, gameVersion: meta.gameVersion, loader: meta.loader, want: 'modrinth' })).modrinth;
        }
        if (want.curseforge) {
            let file = item.local.curseforge?.file || null;
            if (!file && item.plan === 'copy' && item.missing === 'curseforge') {
                const fp = cfFingerprint(await fs.readFile(path.join(storage.paths.modsDir(packPath, 'modrinth'), item.local.modrinth.name)));
                file = (await api.identifyCurseForge([fp]))[fp]?.file || null;
            }
            if (file) parts.curseforge = { mod: (await api.cfMods([item.ids.curseforge])).get(Number(item.ids.curseforge)), file };
            else if (item.ids.curseforge) parts.curseforge = (await api.resolve({ platforms: { curseforge: { id: item.ids.curseforge } }, gameVersion: meta.gameVersion, loader: meta.loader, want: 'curseforge' })).curseforge;
            if (parts.curseforge && (!parts.curseforge.mod || parts.curseforge.blocked)) parts.curseforge = null;
        }
        if (!parts.modrinth && !parts.curseforge) continue;
        const entry = api.toEntry(parts, { title: item.title });
        entry.hashes = { modrinth: null, curseforge: null };
        entry.adopted = true;

        // Local jars go first (renamed to what the pack expects) so a copy can read from their final place.
        const placed = {};
        const order = PLATFORMS.filter(pl => parts[pl]).sort((x, y) => (item.local[y] ? 1 : 0) - (item.local[x] ? 1 : 0));
        for (const pl of order) {
            const dest = storage.paths.modFile(packPath, pl, entry.installedFiles[pl]);
            const mine = item.local[pl];
            const otherPl = pl === 'modrinth' ? 'curseforge' : 'modrinth';
            if (mine) {
                const from = path.join(storage.paths.modsDir(packPath, pl), mine.name);
                if (path.resolve(from) !== path.resolve(dest)) await fs.move(from, dest, { overwrite: false }).catch(async () => { await fs.copy(from, dest); await fs.remove(from); });
                placed[pl] = dest;
                entry.hashes[pl] = { sha1: mine.sha1 };
            } else if (item.plan === 'copy' && placed[otherPl]) {
                await fs.copy(placed[otherPl], dest);
                entry.hashes[pl] = { sha1: item.local[otherPl].sha1 };
            } else {
                const res = await storage.download(entry.fileLinks[pl], dest, { sha1: entry.hashes?.[pl]?.sha1 || (pl === 'modrinth' ? parts.modrinth.version.sha1 : parts.curseforge.file.sha1) });
                entry.hashes[pl] = { sha1: res.sha1 };
            }
        }
        if (parts.modrinth) entry.hashes.modrinth = { ...entry.hashes.modrinth, sha512: parts.modrinth.version.sha512 };
        entries.push(entry);
    }
    return entries;
}

module.exports = { list, review, adopt };
