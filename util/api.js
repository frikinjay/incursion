const { request, limiters } = require('./http');
const cache = require('./cache');
const { loaderInfo, compareVersions, neoforgePrefix } = require('./loaders');
const content = require('./content');
const links = require('./links');

const CF_API = 'https://api.curseforge.com/v1';
const MR_API = 'https://api.modrinth.com/v2';
const MC_GAME_ID = 432;
const CF_CLASS_MODS = 6;

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

let keys = { curseforge: '', modrinth: '' };

// CurseForge goes direct with a personal key, otherwise through the CF service (util/cfproxy.js) with a signed pass.
let proxy = null;
const hasCf = () => !!keys.curseforge || !!proxy?.url;
const noCf = () => Object.assign(new Error('CurseForge isn’t available: add a CurseForge API key in Settings, or use Modrinth.'), { code: 'NO_CF_KEY' });
const mrHeaders = () => (keys.modrinth ? { Authorization: keys.modrinth } : {});

async function cf(path, opts = {}) {
    if (keys.curseforge) return request(`${CF_API}${path}`, { ...opts, headers: { 'x-api-key': keys.curseforge, ...opts.headers } });
    if (!proxy?.url) throw noCf();
    for (let attempt = 0; ; attempt++) {
        const pass = await proxy.getPass(attempt > 0);
        try {
            return await request(`${proxy.url}/v1${path}`, { ...opts, headers: { Authorization: `Bearer ${pass}`, ...opts.headers } });
        } catch (err) {
            if (err.status === 401 && attempt === 0) { proxy.invalidate(); continue; }   // pass expired or rotated: renew once
            throw err;
        }
    }
}
const mr = (path, opts = {}) => request(`${MR_API}${path}`, { ...opts, headers: { ...mrHeaders(), ...opts.headers } });
const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const normalizeName = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const unique = (arr) => [...new Set(arr)];

// At most `n` in flight. The http limiter does the real throttling; this just bounds memory.
async function mapPool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    }));
    return out;
}

function slimCfMod(m) {
    return {
        id: m.id, classId: m.classId || null, name: m.name, slug: m.slug, summary: m.summary,
        author: m.authors?.[0]?.name || null,
        icon: m.logo?.thumbnailUrl || null,
        url: m.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`,
        source: m.links?.sourceUrl || null,
        downloads: m.downloadCount || 0,
        updated: m.dateReleased || m.dateModified,
        created: m.dateCreated || null,
        distributable: m.allowModDistribution !== false,
        indexes: (m.latestFilesIndexes || []).map(i => [i.gameVersion, i.modLoader, i.fileId, i.filename, i.releaseType]),
        latestFiles: (m.latestFiles || []).map(slimCfFile)
    };
}

function slimCfFile(f) {
    const gv = f.gameVersions || [];
    const hasSide = gv.includes('Client') || gv.includes('Server');
    return {
        id: f.id, modId: f.modId, fileName: f.fileName, displayName: f.displayName,
        url: f.downloadUrl || null, size: f.fileLength, date: f.fileDate, releaseType: f.releaseType,
        sha1: f.hashes?.find(h => h.algo === 1)?.value || null,
        env: { client: hasSide ? gv.includes('Client') : true, server: hasSide ? gv.includes('Server') : true },
        deps: (f.dependencies || []).filter(d => d.relationType === 3).map(d => d.modId),
        incompat: (f.dependencies || []).filter(d => d.relationType === 5).map(d => d.modId),
        gameVersions: gv.filter(v => /^\d/.test(v))
    };
}

function slimMrHit(h) {
    return {
        id: h.project_id, slug: h.slug, title: h.title, summary: h.description, author: h.author,
        icon: h.icon_url || null, downloads: h.downloads || 0, updated: h.date_modified, created: h.date_created || null,
        env: { client: h.client_side !== 'unsupported', server: h.server_side !== 'unsupported' }
    };
}

function slimMrProject(p) {
    return {
        id: p.id, slug: p.slug, title: p.title, summary: p.description, icon: p.icon_url || null, type: p.project_type || null,
        downloads: p.downloads || 0, updated: p.updated, team: p.team,
        loaders: p.loaders || [], gameVersions: p.game_versions || [],
        env: { client: p.client_side !== 'unsupported', server: p.server_side !== 'unsupported' },
        source: p.source_url || null,
        // Descriptions also link dependencies, parent mods and other mods by the same author, so a link is only a
        // candidate (see linkedCfSlug and sameProject).
        cfLinks: cfSlugsIn([p.body, p.source_url, p.wiki_url, p.issues_url, p.discord_url, ...(p.donation_urls || []).map(d => d.url)].join(' '))
    };
}

function cfSlugsIn(text) {
    const out = [];
    for (const m of String(text || '').matchAll(/curseforge\.com\/minecraft\/(?:mc-mods|texture-packs|shaders|data-packs|customization)\/([a-z0-9][a-z0-9_-]*)/gi)) {
        const slug = m[1].toLowerCase();
        if (!out.includes(slug)) out.push(slug);
        if (out.length >= 20) break;
    }
    return out;
}

function slimMrVersion(v) {
    const file = v.files.find(f => f.primary) || v.files[0];
    return {
        id: v.id, projectId: v.project_id, number: v.version_number, type: v.version_type, date: v.date_published,
        fileName: file?.filename, url: file?.url, size: file?.size,
        sha1: file?.hashes?.sha1, sha512: file?.hashes?.sha512,
        deps: (v.dependencies || []).filter(d => d.dependency_type === 'required' && d.project_id).map(d => d.project_id),
        incompat: (v.dependencies || []).filter(d => d.dependency_type === 'incompatible' && d.project_id).map(d => d.project_id),
        gameVersions: v.game_versions || [], loaders: v.loaders || []
    };
}

// Mods match the loader too. Resource packs, shaders and data packs only match the game version.
function pickCfIndex(slimMod, gameVersion, cfLoader, type = 'mod') {
    const matches = slimMod.indexes.filter((row) => content.cfIndexFits(type, row, gameVersion, cfLoader));
    if (!matches.length) return null;
    const releases = matches.filter(i => i[4] === 1);
    const [, , fileId, filename, releaseType] = (releases.length ? releases : matches).reduce((a, b) => (b[2] > a[2] ? b : a));
    return { fileId, filename, releaseType };
}

const pickMrVersion = (versions) => versions.find(v => v.type === 'release') || versions[0] || null;

async function mrProjects(idsOrSlugs, { ttl = 6 * HOUR, force = false } = {}) {
    const ids = unique(idsOrSlugs.filter(Boolean).map(String));
    const out = new Map();
    const missing = [];
    for (const id of ids) {
        // "proj2" cache key: entries now include the project type.
        const hit = force ? undefined : cache.fresh(`mr:proj2:${id}`, ttl);
        if (hit === undefined) missing.push(id);
        else if (hit) out.set(id, hit);
    }
    await Promise.all(chunk(missing, 100).map(async part => {
        const list = await mr(`/projects?${qs({ ids: JSON.stringify(part) })}`);
        const found = new Set();
        for (const p of list.map(slimMrProject)) {
            cache.set(`mr:proj2:${p.id}`, p);
            cache.set(`mr:proj2:${p.slug}`, p);
            out.set(p.id, p); out.set(p.slug, p);
            found.add(p.id); found.add(p.slug);
        }
        // Cache misses too, so we don't keep asking for slugs that have no twin.
        for (const id of part) if (!found.has(id)) cache.set(`mr:proj2:${id}`, null);
    }));
    return out;
}

async function cfMods(ids, { force = false, ttl = 30 * MIN } = {}) {
    const list = unique(ids.filter(Boolean).map(Number));
    const out = new Map();
    const missing = [];
    for (const id of list) {
        const hit = !force && cache.fresh(`cf:mod:${id}`, ttl);
        if (hit) out.set(id, hit); else missing.push(id);
    }
    await Promise.all(chunk(missing, 100).map(async part => {
        const res = await cf('/mods', { method: 'POST', body: { modIds: part, filterPcOnly: true } });
        for (const m of res.data.map(slimCfMod)) { cache.set(`cf:mod:${m.id}`, m); out.set(m.id, m); }
    }));
    return out;
}

// CurseForge files are immutable, so cache them for a long time.
async function cfFiles(fileIds) {
    const list = unique(fileIds.filter(Boolean).map(Number));
    const out = new Map();
    const missing = [];
    for (const id of list) {
        const hit = cache.fresh(`cf:file:${id}`, 7 * DAY);
        if (hit) out.set(id, hit); else missing.push(id);
    }
    for (const part of chunk(missing, 100)) {
        const res = await cf('/mods/files', { method: 'POST', body: { fileIds: part } });
        for (const f of res.data.map(slimCfFile)) { cache.set(`cf:file:${f.id}`, f); out.set(f.id, f); }
    }
    return out;
}

async function mrVersionsFor(projectId, gameVersion, loader, { force = false, type = 'mod' } = {}) {
    const loaders = content.mrLoadersFor(type, loader);
    return cache.wrap(`mr:versions:${projectId}:${gameVersion}:${loaders.join(',')}`, { ttl: 5 * MIN, force }, async () => {
        const list = await mr(`/project/${projectId}/version?${qs({
            loaders: JSON.stringify(loaders), game_versions: JSON.stringify([gameVersion]), include_changelog: 'false'
        })}`);
        return list.map(slimMrVersion);
    });
}

const api = {
    setKeys(next) { keys = { curseforge: next.curseforge || '', modrinth: next.modrinth || '' }; },
    hasCurseForge: hasCf,
    setProxy(p) { proxy = p && p.url ? p : null; },
    usingProxy: () => !keys.curseforge && !!proxy?.url,

    // Every result is { ok, message }, plus invalid: true when the platform rejected it (not just unreachable). Only
    // keys present in `candidate` are checked.
    async testKeys(candidate = keys) {
        const result = {};
        const unreachable = (err) => ({ ok: false, message: `Couldn’t check (${err.status ? `HTTP ${err.status}` : 'no connection'})` });
        if ('curseforge' in candidate) {
            if (!candidate.curseforge) result.curseforge = { ok: false, message: 'Not set' };
            else {
                try {
                    await request(`${CF_API}/games/${MC_GAME_ID}`, { headers: { 'x-api-key': candidate.curseforge }, retries: 0 });
                    result.curseforge = { ok: true, message: 'Connected' };
                } catch (err) { result.curseforge = err.status === 401 || err.status === 403 ? { ok: false, invalid: true, message: 'Key rejected by CurseForge' } : unreachable(err); }
            }
        }
        if ('curseforgeUpload' in candidate) {
            if (!candidate.curseforgeUpload) result.curseforgeUpload = { ok: false, message: 'Not set' };
            else {
                // Read-only upload API call. It only answers for a valid token.
                try {
                    await request('https://minecraft.curseforge.com/api/game/version-types', { headers: { 'X-Api-Token': candidate.curseforgeUpload }, retries: 0 });
                    result.curseforgeUpload = { ok: true, message: 'Connected · can publish' };
                } catch (err) {
                    result.curseforgeUpload = err.status === 400 ? { ok: false, invalid: true, message: 'Not a CurseForge upload token' }
                        : err.status === 401 || err.status === 403 ? { ok: false, invalid: true, message: 'Token rejected by CurseForge' } : unreachable(err);
                }
            }
        }
        if ('modrinth' in candidate) {
            if (!candidate.modrinth) {
                try { await request(`${MR_API}/tag/loader`, { retries: 0 }); result.modrinth = { ok: true, message: 'Connected (no token)' }; }
                catch (err) { result.modrinth = unreachable(err); }
            } else result.modrinth = await testModrinthToken(candidate.modrinth, unreachable);
        }
        return result;
    },

    async getGameVersions({ force = false } = {}) {
        return cache.wrap('meta:game-versions', { ttl: 6 * HOUR, stale: 7 * DAY, force }, async () => {
            const tags = await mr('/tag/game_version');
            return tags.filter(v => v.version_type === 'release').map(v => v.version);
        });
    },

    async getLoaderVersions({ loader, gameVersion, force = false }) {
        const l = loaderInfo(loader);
        return cache.wrap(`meta:loader:${l.id}:${gameVersion}`, { ttl: 2 * HOUR, stale: 3 * DAY, force }, async () => {
            if (l.id === 'fabric') {
                const list = await request(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(gameVersion)}`);
                return list.map(e => ({ version: e.loader.version, stable: e.loader.stable !== false }));
            }
            if (l.id === 'quilt') {
                const list = await request(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(gameVersion)}`).catch(() => []);
                return list.map(e => ({ version: e.loader.version, stable: !/beta|pre|rc/i.test(e.loader.version) }));
            }
            const parse = (xml) => [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1].trim());
            if (l.id === 'neoforge') {
                const prefix = neoforgePrefix(gameVersion);
                if (!prefix) return [];
                const xml = await request('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', { as: 'text' });
                return parse(xml).filter(v => v.startsWith(prefix)).sort((a, b) => compareVersions(b, a))
                    .map(v => ({ version: v, stable: !/beta|alpha/i.test(v) }));
            }
            const xml = await request('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', { as: 'text' });
            return parse(xml).filter(v => v.startsWith(`${gameVersion}-`)).map(v => v.slice(gameVersion.length + 1))
                .sort((a, b) => compareVersions(b, a)).map(v => ({ version: v, stable: true }));
        });
    },

    search: (params) => search(params),
    clearSearches: () => searchSessions.clear(),

    async resolve({ platforms, gameVersion, loader, want = 'both', type = 'mod' }) {
        const l = loaderInfo(loader);
        const out = { curseforge: null, modrinth: null, errors: [] };

        const tasks = [];
        if (platforms.modrinth && want !== 'curseforge') tasks.push((async () => {
            const v = platforms.modrinth.versionId
                ? slimMrVersion(await mr(`/version/${platforms.modrinth.versionId}`))
                : pickMrVersion(await mrVersionsFor(platforms.modrinth.id, gameVersion, l.id, { force: true, type }));
            if (!v) return out.errors.push('No compatible Modrinth file');
            const project = (await mrProjects([platforms.modrinth.id])).get(platforms.modrinth.id);
            out.modrinth = { version: v, project };
        })());
        if (platforms.curseforge && want !== 'modrinth') tasks.push((async () => {

            const mods = await cfMods([platforms.curseforge.id], { force: true });
            const m = mods.get(Number(platforms.curseforge.id));
            const exact = Number(platforms.curseforge.exactFileId) || null;
            const idx = exact ? { fileId: exact } : m && pickCfIndex(m, gameVersion, l.cf, type);
            // The short "latest files" list can miss this version, so ask for its files directly.
            const file = idx ? (await cfFiles([idx.fileId])).get(idx.fileId) : m && await cfLatestFile(m.id, gameVersion, loader, type, { force: true });
            if (!m || !file) return out.errors.push('No compatible CurseForge file');
            out.curseforge = { mod: m, file, blocked: !file.url };
        })());
        await Promise.all(tasks.map(t => t.catch(err => out.errors.push(err.message))));
        return out;
    },

    // Stays compatible with the old pack-metadata.json schema.
    toEntry(resolved, hint = {}) {
        const c = resolved.curseforge, m = resolved.modrinth;
        const t = content.typeOf(hint.type);
        return {
            ...(t.id !== 'mod' ? { type: t.id } : {}),
            ids: { curseforge: c ? c.mod.id : null, modrinth: m ? m.version.projectId : null },
            names: { curseforge: c ? c.mod.name : null, modrinth: m ? (m.project?.title || hint.title) : null },
            slugs: { curseforge: c ? c.mod.slug : null, modrinth: m ? (m.project?.slug || null) : null },
            authors: { curseforge: c ? c.mod.author : null, modrinth: m ? (hint.mrAuthor || hint.author || null) : null },
            environments: { curseforge: c ? c.file.env : null, modrinth: m ? (m.project?.env || hint.env || null) : null },
            installedFiles: { curseforge: c ? c.file.fileName : null, modrinth: m ? m.version.fileName : null },
            links: { curseforge: c ? c.mod.url : null, modrinth: m ? `https://modrinth.com/${t.mrType}/${m.project?.slug || m.version.projectId}` : null },
            icons: { curseforge: c ? c.mod.icon : null, modrinth: m ? (m.project?.icon || null) : null },
            fileLinks: { curseforge: c ? c.file.url : null, modrinth: m ? m.version.url : null },
            hashes: { curseforge: c ? { sha1: c.file.sha1 } : null, modrinth: m ? { sha1: m.version.sha1, sha512: m.version.sha512 } : null },
            ...(c?.blocked ? { manual: { curseforge: { from: 'download', expectedFile: c.file.fileName, expectedSha1: c.file.sha1 || null, page: `${c.mod.url}/files/${c.file.id}` } } } : {}),
            sizes: { curseforge: c ? c.file.size : null, modrinth: m ? m.version.size : null },
            deps: { curseforge: c ? c.file.deps : [], modrinth: m ? m.version.deps : [] },
            incompat: { curseforge: c ? c.file.incompat : [], modrinth: m ? m.version.incompat : [] },
            meta: { cfFileId: c ? c.file.id : null, mrVersionId: m ? m.version.id : null, mrVersionNumber: m ? m.version.number : null, mrDate: m ? m.version.date : null, cfDisplayName: c ? c.file.displayName : null },
            summary: (c && c.mod.summary) || (m && m.project?.summary) || hint.summary || '',
            dateAdded: Date.now()
        };
    },

    // Always bypasses the cache: this is the one place stale data isn't acceptable. Returns only the platforms that
    // changed.
    async checkUpdates({ mods, gameVersion, loader, hashOf }, onProgress = () => {}) {
        const l = loaderInfo(loader);
        const updates = {};
        const put = (mod, platform, patch) => { (updates[modKey(mod)] ||= {})[platform] = patch; };
        const errors = [];

        const mrMods = mods.filter(m => m.ids.modrinth);
        const cfModsList = mods.filter(m => m.ids.curseforge);
        let done = 0;
        const total = (mrMods.length ? 1 : 0) + (cfModsList.length ? 1 : 0);
        const tick = () => onProgress(Math.round((++done / Math.max(total, 1)) * 100));

        if (mrMods.length) {
            try {
                const hashed = await mapPool(mrMods, 8, async m => ({ m, sha1: await hashOf(m) }));
                const withHash = hashed.filter(x => x.sha1);
                const byHash = {};
                const batches = new Map();
                for (const x of withHash) { const k = content.mrLoadersFor(x.m.type, loader).join(','); (batches.get(k) || batches.set(k, []).get(k)).push(x); }
                for (const [loaders, list] of batches) {
                    for (const part of chunk(list, 500)) {
                        Object.assign(byHash, await mr('/version_files/update', {
                            method: 'POST',
                            body: { hashes: part.map(x => x.sha1), algorithm: 'sha1', loaders: loaders.split(','), game_versions: [gameVersion] }
                        }));
                    }
                }
                const fallback = hashed.filter(x => !x.sha1 || !byHash[x.sha1]);
                const fallbackVersions = await mapPool(fallback, 6, async x => {
                    try { return pickMrVersion(await mrVersionsFor(x.m.ids.modrinth, gameVersion, l.id, { force: true, type: x.m.type })); }
                    catch { return null; }
                });
                const latestFor = new Map();
                for (const x of withHash) if (byHash[x.sha1]) latestFor.set(x.m, slimMrVersion(byHash[x.sha1]));
                fallback.forEach((x, i) => { if (fallbackVersions[i]) latestFor.set(x.m, fallbackVersions[i]); });

                for (const [m, v] of latestFor) {
                    const current = m.meta?.mrVersionId;
                    const changed = current ? v.id !== current : v.fileName !== m.installedFiles.modrinth;
                    if (!changed) continue;
                    // Ignore "updates" older than what's installed (e.g. a beta installed, newest release is older).
                    if (m.meta?.mrDate && v.date && new Date(v.date) < new Date(m.meta.mrDate)) continue;
                    put(m, 'modrinth', {
                        fileName: v.fileName, url: v.url, versionId: v.id, versionNumber: v.number, date: v.date,
                        sha1: v.sha1, sha512: v.sha512, size: v.size, deps: v.deps,
                        from: m.meta?.mrVersionNumber || m.installedFiles.modrinth
                    });
                }
            } catch (err) { errors.push(`Modrinth: ${err.message}`); }
            tick();
        }

        if (cfModsList.length && hasCf()) {
            try {
                const fresh = await cfMods(cfModsList.map(m => m.ids.curseforge), { force: true });
                const candidates = [];
                const noIndex = [];
                for (const m of cfModsList) {
                    const cm = fresh.get(Number(m.ids.curseforge));
                    const idx = cm && pickCfIndex(cm, gameVersion, l.cf, m.type);
                    if (!idx) { if (cm) noIndex.push(m); continue; }
                    const current = Number(m.meta?.cfFileId) || 0;
                    const changed = current ? idx.fileId > current : idx.filename !== m.installedFiles.curseforge;
                    if (changed) candidates.push({ m, idx });
                }
                await mapPool(noIndex, 4, async (m) => {
                    const f = await cfLatestFile(m.ids.curseforge, gameVersion, loader, m.type, { force: true }).catch(() => null);
                    const current = Number(m.meta?.cfFileId) || 0;
                    if (f && (current ? f.id > current : f.fileName !== m.installedFiles.curseforge)) candidates.push({ m, idx: { fileId: f.id, filename: f.fileName } });
                });
                const files = await cfFiles(candidates.map(c => c.idx.fileId));
                for (const { m, idx } of candidates) {
                    const f = files.get(idx.fileId);
                    if (!f || !f.url) continue;
                    put(m, 'curseforge', {
                        fileName: f.fileName, url: f.url, fileId: f.id, displayName: f.displayName, date: f.date,
                        sha1: f.sha1, size: f.size, deps: f.deps, env: f.env,
                        from: m.meta?.cfDisplayName || m.installedFiles.curseforge
                    });
                }
            } catch (err) { errors.push(`CurseForge: ${err.message}`); }
            tick();
        }

        return { updates, errors, checkedAt: Date.now() };
    },

    async syncMetadata({ mods, force = false, hashOf = null }) {
        const mrIds = mods.map(m => m.ids.modrinth).filter(Boolean);
        const cfIds = mods.map(m => m.ids.curseforge).filter(Boolean);
        const [projects, cfm] = await Promise.all([
            mrIds.length ? mrProjects(mrIds, { force }) : new Map(),
            cfIds.length && hasCf() ? cfMods(cfIds, { force }) : new Map()
        ]);

        const needTeams = unique(mods.filter(m => m.ids.modrinth && !m.authors?.modrinth).map(m => projects.get(m.ids.modrinth)?.team).filter(Boolean));
        const owners = new Map();
        await Promise.all(chunk(needTeams, 100).map(async part => {
            try {
                const teams = await mr(`/teams?${qs({ ids: JSON.stringify(part) })}`);
                for (const members of teams) {
                    const owner = members.find(x => x.role === 'Owner' || x.is_owner) || members[0];
                    if (owner) owners.set(owner.team_id, owner.user?.username);
                }
            } catch {}
        }));

        const legacyCf = mods.filter(m => m.meta?.cfFileId && (!m.meta.cfDisplayName || !m.incompat));
        const cfInstalled = legacyCf.length && hasCf() ? await cfFiles(legacyCf.map(m => m.meta.cfFileId)).catch(() => new Map()) : new Map();
        const mrInstalled = new Map();
        if (hashOf) {
            const legacyMr = mods.filter(m => m.ids.modrinth && (!m.meta?.mrVersionNumber || !m.incompat));
            const hashes = (await mapPool(legacyMr, 8, async m => [m, await hashOf(m)])).filter(([, h]) => h);
            for (const part of chunk(hashes, 500)) {
                try {
                    const res = await mr('/version_files', { method: 'POST', body: { hashes: part.map(([, h]) => h), algorithm: 'sha1' } });
                    for (const [m, h] of part) if (res[h]) mrInstalled.set(m, slimMrVersion(res[h]));
                } catch {}
            }
        }

        let changed = 0;
        for (const mod of mods) {
            const before = JSON.stringify(mod);
            mod.authors ||= { curseforge: null, modrinth: null };
            mod.environments ||= { curseforge: null, modrinth: null };
            mod.icons ||= { curseforge: null, modrinth: null };
            mod.slugs ||= { curseforge: null, modrinth: null };
            const p = mod.ids.modrinth && projects.get(mod.ids.modrinth);
            if (p) {
                mod.names.modrinth = p.title;
                mod.slugs.modrinth = p.slug;
                mod.icons.modrinth = p.icon;
                mod.environments.modrinth = p.env;
                mod.links.modrinth = `https://modrinth.com/${content.typeOf(mod).mrType}/${p.slug}`;
                if (!mod.authors.modrinth && owners.get(p.team)) mod.authors.modrinth = owners.get(p.team);
                if (!mod.ids.curseforge) mod.summary = p.summary;
            }
            const c = mod.ids.curseforge && cfm.get(Number(mod.ids.curseforge));
            if (c) {
                mod.names.curseforge = c.name;
                mod.slugs.curseforge = c.slug;
                mod.icons.curseforge = c.icon;
                mod.links.curseforge = c.url;
                mod.authors.curseforge = c.author;
                mod.summary = c.summary || mod.summary;
                const installed = c.latestFiles.find(f => f.id === Number(mod.meta?.cfFileId));
                if (installed) mod.environments.curseforge = installed.env;
                else if (!mod.environments.curseforge && c.latestFiles[0]) mod.environments.curseforge = c.latestFiles[0].env;
            }
            const cfFile = mod.meta?.cfFileId && cfInstalled.get(Number(mod.meta.cfFileId));
            if (cfFile) {
                mod.meta.cfDisplayName = cfFile.displayName;
                (mod.sizes ||= {}).curseforge = cfFile.size;
                (mod.hashes ||= {}).curseforge ||= { sha1: cfFile.sha1 };
                (mod.deps ||= {}).curseforge = cfFile.deps;
                (mod.incompat ||= {}).curseforge = cfFile.incompat;
                mod.environments.curseforge = cfFile.env;
            }
            const mrVer = mrInstalled.get(mod);
            if (mrVer) {
                mod.meta ||= {};
                Object.assign(mod.meta, { mrVersionId: mrVer.id, mrVersionNumber: mrVer.number, mrDate: mrVer.date });
                (mod.sizes ||= {}).modrinth = mrVer.size;
                (mod.hashes ||= {}).modrinth = { sha1: mrVer.sha1, sha512: mrVer.sha512 };
                (mod.deps ||= {}).modrinth = mrVer.deps;
                (mod.incompat ||= {}).modrinth = mrVer.incompat;
            }
            if (JSON.stringify(mod) !== before) changed++;
        }
        return { mods, changed };
    },

    async missingDependencies({ entries, packMods, gameVersion, loader, platform }) {
        const l = loaderInfo(loader);
        const haveMr = new Set(packMods.map(m => m.ids.modrinth).filter(Boolean));
        const haveCf = new Set(packMods.map(m => Number(m.ids.curseforge)).filter(Boolean));
        const mrDeps = unique(entries.flatMap(e => e.deps?.modrinth || [])).filter(id => !haveMr.has(id));
        const cfDeps = unique(entries.flatMap(e => e.deps?.curseforge || []).map(Number)).filter(id => !haveCf.has(id));
        if (!mrDeps.length && !cfDeps.length) return [];
        const askers = (pl, id) => entries.filter(e => (e.deps?.[pl] || []).some(d => String(d) === String(id)))
            .map(e => ({ key: String(e.ids.curseforge || e.ids.modrinth || e.ids.local), title: e.names?.curseforge || e.names?.modrinth || 'Unknown mod' }));
        const addAskers = (r, list) => { for (const a of list) if (!r.requiredBy.some(x => x.key === a.key)) r.requiredBy.push(a); };

        const [projects, cfm] = await Promise.all([
            mrDeps.length && platform !== 'curseforge' ? mrProjects(mrDeps) : new Map(),
            cfDeps.length && platform !== 'modrinth' && hasCf() ? cfMods(cfDeps) : new Map()
        ]);
        const results = new Map();
        const ctx = { t: content.typeOf('mod'), l, loader, gameVersion };
        for (const id of cfDeps) {
            const m = cfm.get(id);
            if (!m || !cfFitsVersion(m, ctx)) continue;
            results.set(`slug:${m.slug}`, { ...cfResult(m, ctx, null), requiredBy: askers('curseforge', id) });
        }
        for (const id of mrDeps) {
            const p = projects.get(id);
            if (!p || (p.type && p.type !== 'mod') || !p.loaders.includes(l.mr) || haveMr.has(p.id)) continue;
            const twin = [...results.values()].find(r => r.platforms.curseforge && (r.slug === p.slug || normalizeName(r.title) === normalizeName(p.title)));
            const mrPart = { id: p.id, slug: p.slug, url: `https://modrinth.com/mod/${p.slug}` };
            if (twin) { twin.platforms.modrinth = mrPart; twin.env ||= p.env; addAskers(twin, askers('modrinth', p.id)); continue; }
            results.set(`slug:${p.slug}`, {
                key: `mr:${p.id}`, title: p.title, slug: p.slug, summary: p.summary, author: null, icon: p.icon,
                downloads: p.downloads, updated: p.updated, env: p.env, platforms: { curseforge: null, modrinth: mrPart },
                requiredBy: askers('modrinth', p.id)
            });
        }
        if (platform === 'both') {
            const onlyCf = [...results.values()].filter(r => !r.platforms.modrinth);
            if (onlyCf.length) {
                const twins = await mrProjects(onlyCf.map(r => r.slug)).catch(() => new Map());
                for (const r of onlyCf) {
                    const p = twins.get(r.slug);
                    if (p && p.type === 'mod' && p.loaders.includes(l.mr) && p.gameVersions.includes(gameVersion)) r.platforms.modrinth = { id: p.id, slug: p.slug, url: `https://modrinth.com/mod/${p.slug}` };
                }
            }
            for (const r of [...results.values()].filter(r => !r.platforms.curseforge && hasCf())) {
                try {
                    const res = await cf(`/mods/search?${qs({ gameId: MC_GAME_ID, classId: CF_CLASS_MODS, slug: r.slug })}`);
                    const m = res.data[0] && slimCfMod(res.data[0]);
                    const idx = m && pickCfIndex(m, gameVersion, l.cf);
                    if (idx) r.platforms.curseforge = { id: m.id, slug: m.slug, fileId: idx.fileId, fileName: idx.filename, url: m.url, ...(m.distributable ? {} : { blocked: true }) };
                } catch {}
            }
        }
        return [...results.values()];
    },

    async listVersions({ platform, id, gameVersion, loader, type = 'mod' }) {
        const l = loaderInfo(loader);
        if (platform === 'modrinth') {
            const list = await mrVersionsFor(id, gameVersion, l.id, { force: true, type });
            return list.map(v => ({ id: v.id, label: v.number, type: v.type, date: v.date, fileName: v.fileName, size: v.size }));
        }
        const res = await cf(`/mods/${id}/files?${qs({ gameVersion, modLoaderType: content.typeOf(type).usesLoader ? l.cf : undefined, pageSize: 50 })}`);
        const types = { 1: 'release', 2: 'beta', 3: 'alpha' };
        return res.data.map(slimCfFile).map(f => {
            cache.set(`cf:file:${f.id}`, f);
            return { id: f.id, label: f.displayName, type: types[f.releaseType] || 'release', date: f.date, fileName: f.fileName, size: f.size, available: !!f.url };
        }).sort((a, b) => new Date(b.date) - new Date(a.date));
    },

    async changelogs({ platform, id, gameVersion, loader, type = 'mod', offset = 0, limit = 6 }) {
        const l = loaderInfo(loader);
        const t = content.typeOf(type);
        offset = Math.max(0, Number(offset) || 0);
        limit = Math.min(20, Math.max(1, Number(limit) || 6));
        if (platform === 'modrinth') {
            const loaders = content.mrLoadersFor(t.id, loader);
            const list = await cache.wrap(`mr:changelogs:${id}:${gameVersion}:${loaders.join(',')}`, { ttl: 10 * MIN }, async () => {
                const res = await mr(`/project/${encodeURIComponent(id)}/version?${qs({ loaders: JSON.stringify(loaders), game_versions: JSON.stringify([gameVersion]), include_changelog: 'true' })}`);
                return res.map(v => ({ id: v.id, label: v.version_number, name: v.name, type: v.version_type, date: v.date_published, fileName: (v.files.find(f => f.primary) || v.files[0])?.filename || '', changelog: String(v.changelog || '').slice(0, 60000) }));
            });
            return { format: 'markdown', total: list.length, versions: list.slice(offset, offset + limit) };
        }
        if (!hasCf()) throw noCf();
        const files = await cache.wrap(`cf:files:${id}:${gameVersion}:${t.usesLoader ? l.cf : ''}`, { ttl: 10 * MIN }, async () => {
            const res = await cf(`/mods/${Number(id)}/files?${qs({ gameVersion, modLoaderType: t.usesLoader ? l.cf : undefined, pageSize: 50 })}`);
            return res.data.map(slimCfFile);
        });
        const sorted = [...files].sort((a, b) => new Date(b.date) - new Date(a.date));
        const types = { 1: 'release', 2: 'beta', 3: 'alpha' };
        const slice = sorted.slice(offset, offset + limit);
        const versions = await mapPool(slice, 4, async (f) => {
            const changelog = await cache.wrap(`cf:changelog:${f.id}`, { ttl: 7 * DAY }, async () => {
                const res = await cf(`/mods/${Number(id)}/files/${f.id}/changelog`);
                return String(res.data || '').slice(0, 60000);
            }).catch(() => '');
            return { id: f.id, label: f.displayName, type: types[f.releaseType] || 'release', date: f.date, fileName: f.fileName, changelog };
        });
        return { format: 'html', total: sorted.length, versions };
    },

    async identifyModrinth(sha1s) {
        const out = {};
        for (const part of chunk(unique(sha1s.filter(Boolean)), 500)) {
            const res = await mr('/version_files', { method: 'POST', body: { hashes: part, algorithm: 'sha1' } });
            for (const [h, v] of Object.entries(res)) out[h] = slimMrVersion(v);
        }
        return out;
    },

    async identifyCurseForge(fingerprints) {
        const out = {};
        for (const part of chunk(unique(fingerprints.filter(Boolean)), 1000)) {
            const res = await cf(`/fingerprints/${MC_GAME_ID}`, { method: 'POST', body: { fingerprints: part } });
            for (const m of res.data?.exactMatches || []) {
                const f = slimCfFile(m.file);
                cache.set(`cf:file:${f.id}`, f);
                out[m.file.fileFingerprint] = { modId: m.id, file: f };
            }
        }
        return out;
    },

    async mrProjects(ids) { return mrProjects(ids); },
    async cfMods(ids) { return cfMods(ids); },
    async cfFiles(ids) { return cfFiles(ids); },
    async mrVersions(ids) {
        const out = new Map();
        for (const part of chunk(unique(ids.filter(Boolean)), 100)) {
            const list = await mr(`/versions?${qs({ ids: JSON.stringify(part) })}`);
            for (const v of list.map(slimMrVersion)) out.set(v.id, v);
        }
        return out;
    },

    async cfBySlug(slug, gameVersion, loader, type = 'mod') {
        if (!hasCf()) return null;
        const l = loaderInfo(loader);
        const res = await cf(`/mods/search?${qs({ gameId: MC_GAME_ID, classId: content.typeOf(type).cfClass, slug })}`);
        const m = res.data[0] && slimCfMod(res.data[0]);
        if (!m) return null;
        cache.set(`cf:mod:${m.id}`, m);
        const idx = pickCfIndex(m, gameVersion, l.cf, type);
        return idx && m.distributable ? { mod: m, idx } : null;
    },

    async modpackFromLink(link) {
        let u;
        try { u = new URL(String(link).trim()); } catch { throw new Error('That isn’t a link. Paste a Modrinth or CurseForge modpack page, or a link to a .mrpack / .zip file.'); }
        if (u.protocol !== 'https:') throw new Error('Only https links can be imported.');
        const host = u.hostname.toLowerCase();
        if (/\/pack\.toml$/i.test(u.pathname)) return { packwiz: u.toString(), title: decodeURIComponent(u.pathname.split('/').slice(-2, -1)[0] || 'packwiz pack') };
        if (/(^|\.)modrinth\.com$/.test(host) && !/\.mrpack$/i.test(u.pathname)) {
            const m = u.pathname.match(/^\/(?:modpack|project)\/([^/]+)(?:\/version\/([^/]+))?/);
            if (!m) throw new Error('Open the modpack’s page on Modrinth and copy that link.');
            const project = await mr(`/project/${encodeURIComponent(m[1])}`);
            if (project.project_type !== 'modpack') throw new Error(`“${project.title}” is a ${project.project_type}, not a modpack.`);
            let v;
            if (m[2]) v = await mr(`/project/${encodeURIComponent(m[1])}/version/${encodeURIComponent(m[2])}`);
            else { const list = await mr(`/project/${encodeURIComponent(m[1])}/version`); v = list.find(x => x.version_type === 'release') || list[0]; }
            const file = v && (v.files.find(f => f.primary) || v.files[0]);
            if (!file) throw new Error('That modpack has no downloadable version.');
            return { url: file.url, fileName: file.filename, title: `${project.title} ${v.version_number}`, sha1: file.hashes?.sha1 };
        }
        if (/(^|\.)curseforge\.com$/.test(host)) {
            const m = u.pathname.match(/\/minecraft\/modpacks\/([^/]+)(?:\/files?\/(\d+))?/);
            if (!m) throw new Error('Open the modpack’s page on CurseForge and copy that link.');
            if (!hasCf()) throw noCf();
            const res = await cf(`/mods/search?${qs({ gameId: MC_GAME_ID, classId: 4471, slug: m[1] })}`);
            const mod = res.data[0];
            if (!mod) throw new Error('CurseForge has no modpack at that link.');
            const fileId = Number(m[2]) || mod.mainFileId || [...(mod.latestFiles || [])].sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))[0]?.id;
            const f = fileId && (await cfFiles([fileId])).get(Number(fileId));
            if (!f) throw new Error('That modpack has no downloadable file.');
            if (!f.url) throw new Error('The author disabled downloads from outside CurseForge for this modpack.');
            return { url: f.url, fileName: f.fileName, title: f.displayName || mod.name, sha1: f.sha1 };
        }
        if (/\.(mrpack|zip)$/i.test(u.pathname)) return { url: u.toString(), fileName: decodeURIComponent(u.pathname.split('/').pop()), title: '' };
        throw new Error('Paste a Modrinth or CurseForge modpack page, a link to a .mrpack / .zip file, or a packwiz pack.toml link.');
    },

    stats() {
        return Object.fromEntries(Object.entries(limiters).map(([k, v]) => [k, { ...v.stats, queued: v.queue.length, active: v.active }]));
    }
};

const CF_CAP = 10000;
const SCAN = 50;
const searchSessions = new Map();

// Modrinth ignores tokens on public endpoints, so those prove nothing. Instead send a "create version" for a project
// that doesn't exist with no files: Modrinth checks the token first (401 if wrong), then rejects the request (400), so
// nothing gets created.
async function testModrinthToken(token, unreachable) {
    const form = new FormData();
    form.append('data', new Blob([JSON.stringify({
        name: 'Incursion token check', version_number: '0.0.0-check', changelog: '', dependencies: [], game_versions: ['1.21.1'],
        version_type: 'release', loaders: ['fabric'], featured: false, project_id: 'AAAAAAAA', file_parts: []
    })], { type: 'application/json' }));
    try {
        await request(`${MR_API}/version`, { method: 'POST', headers: { Authorization: token }, body: form, retries: 0 });
        return { ok: false, message: 'Unexpected answer from Modrinth' };
    } catch (err) {
        if (err.status === 401) {
            const kind = String(err.body || '').includes('invalid_auth_method') ? 'Not a Modrinth token' : 'Token rejected by Modrinth (check it’s correct, not expired, and has “Create versions”)';
            return { ok: false, invalid: true, message: kind };
        }
        if (err.status !== 400) return unreachable(err);
    }
    try {
        const u = await request(`${MR_API}/user`, { headers: { Authorization: token }, retries: 0 });
        return { ok: true, message: `Connected as ${u.username} · can publish` };
    } catch { return { ok: true, message: 'Connected · can publish' }; }
}

const LOADER_WORDS = /\b(fabric|forge|neoforge|neo forge|quilt|for|edition|port|mod)\b/g;
const looseName = (name) => String(name || '').toLowerCase().replace(/[([{].*?[)\]}]/g, ' ').replace(LOADER_WORDS, ' ').replace(/[^a-z0-9]/g, '');
const personKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function sourceKey(url) {
    const m = String(url || '').toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?([^/]+)\/([^/#?]+)\/([^/#?]+)/);
    if (!m || !/github|gitlab|codeberg|bitbucket|sr\.ht/.test(m[1])) return null;
    return `${m[1]}/${m[2]}/${m[3].replace(/\.git$/, '')}`;
}
const flipOrder = (o) => (o === 'asc' ? 'desc' : 'asc');

const words = (s) => String(s || '').toLowerCase().replace(/[([{].*?[)\]}]/g, ' ').replace(LOADER_WORDS, ' ').split(/[^a-z0-9]+/).filter(w => w.length > 1);
function wordOverlap(a, b) {
    const x = new Set(words(a)), y = new Set(words(b));
    if (!x.size || !y.size) return 0;
    let both = 0;
    for (const w of x) if (y.has(w)) both++;
    return both / Math.max(x.size, y.size);
}
// Only accept a link that closely matches the slug or title. Links to dependencies or parent mods read differently.
function linkedCfSlug(p) {
    let best = null, score = 0;
    for (const slug of p?.cfLinks || []) {
        const s = Math.max(slug === p.slug ? 1 : 0, normalizeName(slug) === normalizeName(p.title) ? 1 : 0, wordOverlap(slug, p.title), wordOverlap(slug, p.slug));
        if (s > score) { best = slug; score = s; }
    }
    return score >= 0.75 ? best : null;
}
// Guards every match made from a page link or shared repo, which can point at a dependency, parent mod, fork or
// another mod by the same author. Names must match (ignoring case, punctuation, loader words and bracketed notes).
// Authors often differ between sites, so a different author doesn't rule it out. With matching names, one more sign is
// enough: same author, identical slugs, or the link / repo that led here.
function sameProject(cf, mr, evidence = {}) {
    const sameAuthor = !!cf.author && !!mr.author && personKey(cf.author) === personKey(mr.author);
    const named = normalizeName(cf.name) === normalizeName(mr.title) || (looseName(cf.name) && looseName(cf.name) === looseName(mr.title));
    if (!named) return false;
    if (cf.slug && cf.slug === mr.slug) return true;
    if (sameAuthor) return true;
    return !!(evidence.link || evidence.source);
}

function cfSearch(params, index, size, order) {
    return cache.wrap(`cf:search:${JSON.stringify(params)}:${order}:${index}:${size}`, { ttl: 15 * MIN, stale: 45 * MIN }, async () => {
        const res = await cf(`/mods/search?${qs({ ...params, sortOrder: order, index, pageSize: size })}`);
        return { total: res.pagination?.totalCount || 0, mods: res.data.map(slimCfMod) };
    });
}
function mrSearch(params, offset, size) {
    return cache.wrap(`mr:search:${JSON.stringify(params)}:${offset}:${size}`, { ttl: 15 * MIN, stale: 45 * MIN }, async () => {
        const res = await mr(`/search?${qs({ ...params, offset, limit: size })}`);
        return { total: res.total_hits || 0, hits: res.hits.map(slimMrHit) };
    });
}

// CurseForge caps a search at 10,000 results. Reading the same search in reverse covers 10,000-19,999 with no repeats;
// past that it goes category by category.
async function cfPageAt(params, order, pos, size, total) {
    if (pos < CF_CAP) return cfSearch(params, pos, Math.min(size, CF_CAP - pos), order);
    if (total == null) total = (await cfSearch(params, 0, 1, order)).total;
    if (total > 2 * CF_CAP || pos >= total) return { total, mods: [] };
    const end = Math.min(pos + size, total);
    const page = await cfSearch(params, total - end, end - pos, flipOrder(order));
    return { total, mods: page.mods.slice().reverse() };
}

async function cfCategories(classId) {
    return cache.wrap(`cf:categories:${classId}`, { ttl: DAY, stale: 7 * DAY }, async () => {
        const res = await cf(`/categories?${qs({ gameId: MC_GAME_ID, classId })}`);
        return (res.data || []).filter(c => !c.isClass).map(c => c.id);
    }).catch(() => []);
}

function cfStream(params, order) {
    return {
        pos: 0, total: null, done: false, tail: null,
        async next() {
            if (this.done) return [];
            if (!this.tail && (this.pos < CF_CAP || (this.total != null && this.total <= 2 * CF_CAP))) {
                const page = await cfPageAt(params, order, this.pos, SCAN, this.total);
                this.total = page.total;
                this.pos += page.mods.length;
                if (this.pos >= this.total || !page.mods.length) {
                    if (this.total > 2 * CF_CAP && this.pos >= CF_CAP) this.tail = { cats: await cfCategories(params.classId), ci: 0, index: 0 };
                    else this.done = true;
                }
                return page.mods;
            }
            const t = this.tail ||= { cats: await cfCategories(params.classId), ci: 0, index: 0 };
            while (t.ci < t.cats.length) {
                const page = await cfSearch({ ...params, categoryId: t.cats[t.ci] }, t.index, Math.min(SCAN, CF_CAP - t.index), order);
                t.index += page.mods.length;
                if (!page.mods.length || t.index >= Math.min(page.total, CF_CAP)) { t.ci++; t.index = 0; }
                if (page.mods.length) return page.mods;
            }
            this.done = true;
            return [];
        }
    };
}
function mrStream(params) {
    return {
        pos: 0, total: null, done: false,
        async next() {
            if (this.done) return [];
            const page = await mrSearch(params, this.pos, SCAN);
            this.total = page.total;
            this.pos += page.hits.length;
            if (this.pos >= this.total || page.hits.length < SCAN) this.done = true;
            return page.hits;
        }
    };
}

async function mrProjectsByHash(sha1s) {
    const out = new Map();
    const missing = [];
    for (const h of unique(sha1s.filter(Boolean))) {
        const hit = cache.fresh(`mr:hash:${h}`, 7 * DAY);
        if (hit === undefined) missing.push(h); else if (hit) out.set(h, hit);
    }
    for (const part of chunk(missing, 500)) {
        const res = await mr('/version_files', { method: 'POST', body: { hashes: part, algorithm: 'sha1' } }).catch(() => ({}));
        for (const h of part) {
            const pid = res[h]?.project_id || null;
            cache.set(`mr:hash:${h}`, pid);
            if (pid) out.set(h, pid);
        }
    }
    return out;
}

async function cfBySlugCached(slug, classId) {
    const key = `cf:slug:${classId}:${slug}`;
    const hit = cache.fresh(key, 3 * DAY);
    if (hit !== undefined) return hit;
    const res = await cf(`/mods/search?${qs({ gameId: MC_GAME_ID, classId, slug })}`);
    const m = res.data?.[0] ? slimCfMod(res.data[0]) : null;
    cache.set(key, m);
    if (m) cache.set(`cf:mod:${m.id}`, m);
    return m;
}

// A twin must be the same kind of project (never a modpack or plugin for a mod) and have builds for this pack's
// version and loader.
const cfFitsVersion = (m, ctx) => (!m.classId || m.classId === ctx.t.cfClass)
    && (!!pickCfIndex(m, ctx.gameVersion, ctx.l.cf, ctx.t.id) || (m.latestFiles || []).some(f => f.gameVersions.includes(ctx.gameVersion)));
const mrFitsVersion = (p, ctx) => {
    if (p.type !== ctx.t.mrType) return false;
    const loaders = content.mrLoadersFor(ctx.t.id, ctx.loader);
    return (!p.loaders?.length || loaders.some(x => p.loaders.includes(x))) && (!p.gameVersions?.length || p.gameVersions.includes(ctx.gameVersion));
};

function poolAdd(pool, keys, value) { for (const k of keys) if (k && !pool.has(k)) pool.set(k, value); }
const keysOf = (slug, title, author, source) => [
    slug && `slug:${String(slug).toLowerCase()}`, title && `name:${normalizeName(title)}`,
    source && sourceKey(source) && `src:${sourceKey(source)}`,
    looseName(title) && author && `loose:${looseName(title)}|${personKey(author)}`
];

async function matchTwins(s, ctx, cfList, mrHits) {
    const cfTwin = new Map(), mrTwin = new Map();
    const learned = [];
    const wantMr = new Map();
    const wantCf = new Map();

    const mrInfo = await mrProjects([...mrHits.map(h => h.id), ...cfList.map(m => m.slug)]).catch(() => new Map());
    for (const h of mrHits) {
        const p = mrInfo.get(h.id);
        poolAdd(s.mrPool, keysOf(h.slug, h.title, h.author, p?.source), { id: h.id, slug: h.slug, title: h.title, icon: h.icon, env: h.env, author: h.author, downloads: h.downloads });
    }
    for (const m of cfList) poolAdd(s.cfPool, keysOf(m.slug, m.name, m.author, m.source), m);

    for (const m of cfList) {
        const tw = links.twinOf('curseforge', m.id, ctx.meta, ctx.t.id);
        if (tw === null) cfTwin.set(m.id, null);
        else if (tw) wantMr.set(tw, [m.id, 'saved']);
    }
    for (const h of mrHits) {
        const tw = links.twinOf('modrinth', h.id, ctx.meta, ctx.t.id);
        if (tw === null) mrTwin.set(h.id, null);
        else if (tw) wantCf.set(tw, [h.id, 'saved']);
    }
    const cfOpen = () => cfList.filter(m => !cfTwin.has(m.id) && ![...wantMr.values()].some(([c]) => c === m.id));
    const mrOpen = () => mrHits.filter(h => !mrTwin.has(h.id) && ![...wantCf.values()].some(([x]) => x === h.id));

    for (const h of mrOpen()) {
        const p = mrInfo.get(h.id);
        const slug = linkedCfSlug(p);
        const viaLink = slug && s.cfPool.get(`slug:${slug}`);
        const viaSrc = p?.source && sourceKey(p.source) && s.cfPool.get(`src:${sourceKey(p.source)}`);
        const hit = (viaLink && sameProject(viaLink, h, { link: true }) && viaLink) || (viaSrc && sameProject(viaSrc, h, { source: true }) && viaSrc) || null;
        if (hit) wantCf.set(hit.id, [h.id, hit === viaLink ? 'link' : 'source']);
    }
    for (const m of cfOpen()) {
        const src = m.source && sourceKey(m.source);
        const pick = (src && s.mrPool.get(`src:${src}`) && sameProject(m, s.mrPool.get(`src:${src}`), { source: true }) && ['source', s.mrPool.get(`src:${src}`)])
            || (s.mrPool.get(`slug:${m.slug}`) && ['slug', s.mrPool.get(`slug:${m.slug}`)])
            || (s.mrPool.get(`name:${normalizeName(m.name)}`) && ['name', s.mrPool.get(`name:${normalizeName(m.name)}`)])
            || (m.author && s.mrPool.get(`loose:${looseName(m.name)}|${personKey(m.author)}`) && ['name', s.mrPool.get(`loose:${looseName(m.name)}|${personKey(m.author)}`)]);
        if (pick) wantMr.set(pick[1].id, [m.id, pick[0]]);
    }
    for (const h of mrOpen()) {
        const pick = s.cfPool.get(`slug:${h.slug}`) || s.cfPool.get(`name:${normalizeName(h.title)}`)
            || (h.author && s.cfPool.get(`loose:${looseName(h.title)}|${personKey(h.author)}`));
        if (pick && !cfTwin.has(pick.id)) wantCf.set(pick.id, [h.id, s.cfPool.get(`slug:${h.slug}`) === pick ? 'slug' : 'name']);
    }

    for (const m of cfOpen()) { const p = mrInfo.get(m.slug); if (p && p.id && p.slug === m.slug && p.type === ctx.t.mrType) wantMr.set(p.id, [m.id, 'slug']); }
    const byHash = async () => {
        const hashOwner = new Map();
        for (const m of cfOpen()) for (const f of m.latestFiles || []) if (f.sha1) hashOwner.set(f.sha1, m.id);
        if (!hashOwner.size) return;
        const found = await mrProjectsByHash([...hashOwner.keys()]);
        for (const [h, pid] of found) { const cfId = hashOwner.get(h); if (![...wantMr.values()].some(([c]) => c === cfId)) wantMr.set(pid, [cfId, 'hash']); }
    };
    // CurseForge has no bulk lookup by slug, so only a few new pages are looked up per scan and every answer is cached
    // for days. Only the link that names the project counts.
    const byLinkedPage = async () => {
        if (!hasCf() || !mrHits.length) return;
        const linked = mrOpen().map(h => ({ h, slug: linkedCfSlug(mrInfo.get(h.id)) })).filter(x => x.slug && !s.cfPool.has(`slug:${x.slug}`));
        const cached = (slug) => cache.fresh(`cf:slug:${ctx.t.cfClass}:${slug}`, 3 * DAY) !== undefined;
        const tries = [...linked.filter(x => cached(x.slug)), ...linked.filter(x => !cached(x.slug)).slice(0, 4)];
        await mapPool(tries, 4, async ({ h, slug }) => {
            const m = await cfBySlugCached(slug, ctx.t.cfClass).catch(() => null);
            if (m && sameProject(m, h, { link: true })) wantCf.set(m.id, [h.id, 'link']);
        });
    };
    await Promise.all([byHash(), byLinkedPage()]);

    const pooledCf = new Map([...s.cfPool.values()].map(m => [m.id, m]));
    const needMr = [...wantMr.keys()].filter(id => !mrInfo.has(id));
    const needCf = [...wantCf.keys()].filter(id => !pooledCf.has(Number(id)));
    const [mrMore, cfMore] = await Promise.all([
        needMr.length ? mrProjects(needMr).catch(() => new Map()) : new Map(),
        needCf.length && hasCf() ? cfMods(needCf).catch(() => new Map()) : new Map()
    ]);
    const mrFound = new Map([...mrInfo, ...mrMore]);
    const cfFound = new Map([...pooledCf, ...cfMore]);
    const strong = new Set(['hash', 'link', 'source', 'slug']);
    for (const [mrId, [cfId, how]] of wantMr) {
        const p = mrFound.get(mrId);
        if (!p || p.type !== ctx.t.mrType) continue;   // never learn or show a link to another kind of project
        if (strong.has(how)) learned.push({ cf: cfId, mr: p.id, how });
        if (mrFitsVersion(p, ctx)) cfTwin.set(cfId, { id: p.id, slug: p.slug, title: p.title, icon: p.icon, env: p.env, author: null, downloads: p.downloads });
    }
    for (const [cfId, [mrId, how]] of wantCf) {
        const m = cfFound.get(Number(cfId));
        if (!m || (m.classId && m.classId !== ctx.t.cfClass)) continue;
        if (strong.has(how)) learned.push({ cf: m.id, mr: mrId, how });
        if (cfFitsVersion(m, ctx)) mrTwin.set(mrId, m);
    }

    if (learned.length) links.learn(learned);
    return { cfTwin, mrTwin };
}

function cfResult(m, ctx, twin) {
    const t = ctx.t;
    const idx = pickCfIndex(m, ctx.gameVersion, ctx.l.cf, t.id);
    return {
        key: `cf:${m.id}`, type: t.id, title: m.name, slug: m.slug, summary: m.summary, author: m.author || twin?.author || null,
        icon: m.icon || twin?.icon || null, downloads: m.downloads + (twin?.downloads || 0), updated: m.updated, created: m.created || twin?.created || null,
        env: twin?.env || null,
        platforms: {
            curseforge: { id: m.id, slug: m.slug, fileId: idx?.fileId || null, fileName: idx?.filename || null, url: m.url, ...(m.distributable ? {} : { blocked: true }) },
            modrinth: twin ? { id: twin.id, slug: twin.slug, url: `https://modrinth.com/${t.mrType}/${twin.slug}`, author: twin.author } : null
        }
    };
}

function mrResult(h, ctx, cfMod) {
    const r = cfMod ? cfResult(cfMod, ctx, { ...h }) : null;
    if (r) { r.key = `mr:${h.id}`; r.title = h.title; r.summary = h.summary || r.summary; r.icon = h.icon || r.icon; r.author = h.author || r.author; r.env = h.env; return r; }
    const t = ctx.t;
    return {
        key: `mr:${h.id}`, type: t.id, title: h.title, slug: h.slug, summary: h.summary, author: h.author, icon: h.icon,
        downloads: h.downloads, updated: h.updated, created: h.created || null, env: h.env,
        platforms: { curseforge: null, modrinth: { id: h.id, slug: h.slug, url: `https://modrinth.com/${t.mrType}/${h.slug}`, author: h.author } }
    };
}

function pushResult(s, r) {
    const cfId = r.platforms.curseforge?.id, mrId = r.platforms.modrinth?.id;
    const have = (cfId && s.byCf.get(Number(cfId))) || (mrId && s.byMr.get(mrId));
    if (have) {
        if (!have.platforms.curseforge && cfId && !s.byCf.has(Number(cfId))) { have.platforms.curseforge = r.platforms.curseforge; have.downloads += r.downloads; s.byCf.set(Number(cfId), have); }
        if (!have.platforms.modrinth && mrId && !s.byMr.has(mrId)) { have.platforms.modrinth = r.platforms.modrinth; have.env ||= r.env; have.downloads += r.downloads; s.byMr.set(mrId, have); }
        return;
    }
    if (cfId) s.byCf.set(Number(cfId), r);
    if (mrId) s.byMr.set(mrId, r);
    s.results.push(r);
}

const SORTS = {
    relevance: { cf: 1, mr: 'relevance' },
    downloads: { cf: 6, mr: 'downloads', key: (r) => r.downloads },
    popular: { cf: 2, mr: 'follows' },
    updated: { cf: 3, mr: 'updated', key: (r) => Date.parse(r.updated) || 0 },
    newest: { cf: 11, mr: 'newest', key: (r) => Date.parse(r.created) || 0 },
    name: { cf: 4, mr: 'relevance' }
};

function searchParams(ctx, sort) {
    const { t, l, query, gameVersion } = ctx;
    return {
        cf: { gameId: MC_GAME_ID, classId: t.cfClass, searchFilter: query, gameVersion, modLoaderType: t.usesLoader ? l.cf : undefined, sortField: SORTS[sort]?.cf || 1 },
        cfOrder: sort === 'name' ? 'asc' : 'desc',
        mr: { query, index: SORTS[sort]?.mr || 'relevance',
            facets: JSON.stringify([[`versions:${gameVersion}`], ...(t.usesLoader ? [[`categories:${l.mr}`]] : []), [`project_type:${t.mrType}`]]) }
    };
}

async function search({ query = '', gameVersion, loader, platform = 'all', sort = 'relevance', offset = 0, limit = 20, type = 'mod', meta = null, more = false }) {
    const ctx = { t: content.typeOf(type), l: loaderInfo(loader), loader, gameVersion, query: String(query).trim(), meta };
    const p = searchParams(ctx, sort);
    offset = Math.max(0, Number(offset) || 0);
    limit = Math.min(50, Math.max(1, Number(limit) || 20));

    if (platform === 'modrinth') {
        const page = await mrSearch(p.mr, offset, limit);
        return { mods: page.hits.map(h => mrResult(h, ctx, null)), totalHint: page.total, found: offset + page.hits.length, exhausted: offset + limit >= page.total, hasMore: offset + limit < page.total };
    }
    if (platform === 'curseforge') {
        if (!hasCf()) throw noCf();
        const first = await cfSearch(p.cf, 0, 1, p.cfOrder);
        const total = first.total;
        let mods;
        if (offset < CF_CAP || total <= 2 * CF_CAP) mods = (await cfPageAt(p.cf, p.cfOrder, offset, limit, total)).mods;
        else {
            const s = session(ctx, sort, 'curseforge-tail', () => ({ stream: cfStream(p.cf, p.cfOrder), list: [], seen: new Set() }));
            s.stream.pos = CF_CAP; s.stream.total = total;
            let guard = 0;
            while (s.list.length < offset - CF_CAP + limit && !s.stream.done && guard++ < 12) {
                for (const m of await s.stream.next()) if (!s.seen.has(m.id)) { s.seen.add(m.id); s.list.push(m); }
            }
            mods = s.list.slice(offset - CF_CAP, offset - CF_CAP + limit);
        }
        const shown = mods.map(m => cfResult(m, ctx, null));
        return { mods: shown, totalHint: total, found: offset + mods.length, exhausted: offset + limit >= total, hasMore: offset + limit < total };
    }

    const both = platform === 'both';
    const s = session(ctx, sort, both ? 'both' : 'all', () => ({
        cf: hasCf() ? cfStream(p.cf, p.cfOrder) : null, mr: both ? null : mrStream(p.mr),
        results: [], byCf: new Map(), byMr: new Map(), cfPool: new Map(), mrPool: new Map(), cfError: hasCf() ? null : 'NO_CF_KEY'
    }), offset === 0);
    if (both && s.cfError) throw Object.assign(noCf(), { code: s.cfError });
    const view = () => (both ? s.results.filter(r => r.platforms.curseforge && r.platforms.modrinth) : s.results);
    const done = () => (!s.cf || s.cf.done) && (!s.mr || s.mr.done);
    // One reader per search at a time. A page requested mid-load (hover, then click) waits and usually finds its
    // results ready.
    const prev = s.queue || Promise.resolve();
    let release;
    s.queue = new Promise(r => { release = r; });
    await prev;
    try {
        let guard = 0, catchUp = 0;
        const repeat = !more && s.lastRead?.offset === offset && s.lastRead.found > 0 && Date.now() - s.lastRead.at < 30000;
        const maxScans = both ? 3 : 2;
        s.scannedBefore = (s.cf?.pos || 0) + (s.mr?.pos || 0);
        while (view().length < offset + limit && !done()) {
            if (view().length < offset) { if (catchUp++ >= 25) break; }
            else if (repeat || guard++ >= maxScans) break;
            let cfBatch = [];
            const mrPromise = s.mr && !s.mr.done
                ? s.mr.next().then(async (hits) => { await mrProjects(hits.map(h => h.id)).catch(() => {}); return hits; })
                : Promise.resolve([]);
            if (s.cf && !s.cf.done) {
                try { cfBatch = await s.cf.next(); }
                catch (err) {
                    if (both || !['NO_CF_KEY', 'VERIFY_CANCELLED', 'PASS_REQUIRED'].includes(err.code)) { await mrPromise.catch(() => {}); throw err; }
                    s.cfError = err.code; s.cf.done = true;
                }
            }
            const mrHits = await mrPromise;
            const { cfTwin, mrTwin } = await matchTwins(s, ctx, cfBatch, mrHits);
            const batch = [];
            for (let i = 0; i < Math.max(cfBatch.length, mrHits.length); i++) {
                if (cfBatch[i]) batch.push(cfResult(cfBatch[i], ctx, cfTwin.get(cfBatch[i].id) || null));
                if (mrHits[i]) batch.push(mrResult(mrHits[i], ctx, mrTwin.get(mrHits[i].id) || null));
            }
            const key = SORTS[sort]?.key;
            if (key) batch.sort((a, b) => key(b) - key(a));
            for (const r of batch) pushResult(s, r);
        }
    } finally { s.lastRead = { offset, at: Date.now(), found: Math.max(0, view().length - offset) }; release(); }
    const list = view();
    const exhausted = done();
    const mods = list.slice(offset, offset + limit);
    return {
        mods,
        nextOffset: offset + mods.length,
        hasMore: list.length > offset + limit || !exhausted,
        totalHint: (s.cf?.total || 0) + (s.mr?.total || 0),
        found: list.length,
        exhausted,
        scanned: s.cf?.pos || 0,
        scannedNow: (s.cf?.pos || 0) + (s.mr?.pos || 0) - (s.scannedBefore ?? 0),
        cfUnavailable: s.cfError || null
    };
}

// Kept for 10 minutes so the next page continues where the last one stopped.
function session(ctx, sort, kind, make, restart = false) {
    const key = JSON.stringify([kind, ctx.query.toLowerCase(), ctx.gameVersion, ctx.l.id, sort, ctx.t.id, ctx.meta?.modLinks?.length ? ctx.meta.id : null]);
    let s = searchSessions.get(key);
    if (!s || Date.now() - s.created > 10 * MIN || (restart && s.cfError)) {
        s = { created: Date.now(), ...make() };
        searchSessions.set(key, s);
        if (searchSessions.size > 12) searchSessions.delete(searchSessions.keys().next().value);
    }
    return s;
}

async function cfLatestFile(modId, gameVersion, loader, type = 'mod', { force = false } = {}) {
    const l = loaderInfo(loader);
    const t = content.typeOf(type);
    const files = await cache.wrap(`cf:files:${modId}:${gameVersion}:${t.usesLoader ? l.cf : ''}`, { ttl: 10 * MIN, force }, async () => {
        const res = await cf(`/mods/${modId}/files?${qs({ gameVersion, modLoaderType: t.usesLoader ? l.cf : undefined, pageSize: 50 })}`);
        return res.data.map(slimCfFile);
    });
    for (const f of files) cache.set(`cf:file:${f.id}`, f);
    const fit = files.filter(f => f.url).sort((a, b) => new Date(b.date) - new Date(a.date));
    return fit.find(f => f.releaseType === 1) || fit[0] || null;
}

function modKey(m) { return String(m.ids.curseforge || m.ids.modrinth || m.ids.local); }

api.modKey = modKey;
api.pickCfIndex = pickCfIndex;
api.slimCfMod = slimCfMod;
api.matching = { sameProject, linkedCfSlug };
module.exports = api;
