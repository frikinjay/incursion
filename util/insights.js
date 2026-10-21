const { satisfies } = require('./ranges');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const core = (s) => norm(s).replace(/(api|lib|library|core|mod|forge|neoforge|fabric|quilt)+$/g, '') || norm(s);
const keyOf = (m) => String(m.ids.curseforge || m.ids.modrinth || m.ids.local);
const titleOf = (m) => m.names?.curseforge || m.names?.modrinth || 'Unknown mod';
const versionOf = (m) => m.meta?.mrVersionNumber || m.meta?.cfDisplayName || m.installedFiles?.modrinth || m.installedFiles?.curseforge || '';

function providers(meta) {
    const map = new Map();
    const add = (id, entry) => {
        for (const k of new Set([norm(id), core(id)])) {
            if (!k) continue;
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(entry);
        }
    };
    for (const m of meta.mods) {
        const c = m.contents;
        if (!c) continue;
        for (const id of c.ids || []) add(id.id, { key: keyOf(m), title: titleOf(m), id: id.id, version: id.version, bundled: false });
        for (const b of c.bundled || []) add(b.id, { key: keyOf(m), title: titleOf(m), id: b.id, version: b.version, bundled: true, name: b.name });
    }
    return map;
}

function annotateBundled(deps, meta) {
    const p = providers(meta);
    return deps.map(d => {
        const hits = new Map();
        for (const k of new Set([norm(d.slug), core(d.slug), norm(d.title), core(d.title)])) {
            for (const e of p.get(k) || []) hits.set(`${e.key}:${e.id}`, e);
        }
        const providedBy = [...hits.values()];
        return { ...d, providedBy, bundledOnly: providedBy.length > 0 && providedBy.every(e => e.bundled), requiredBy: requesters(d, providedBy, meta) };
    });
}

// Which pack mods ask for a dependency, and the version range their jar declares for it (null when it doesn't say).
// The platforms say who needs it; the jars say which versions. A jar that declares it counts even if the platform doesn't.
function requesters(d, providedBy, meta) {
    const ids = new Set([norm(d.slug), norm(d.title), ...providedBy.map(e => norm(e.id))].filter(Boolean));
    const out = (d.requiredBy || []).map(r => ({ ...r, versions: null }));
    for (const m of meta.mods) {
        const want = (m.contents?.depends || []).find(x => ids.has(norm(x.id)));
        if (!want) continue;
        const versions = want.versions && want.versions !== '*' ? want.versions : null;
        const have = out.find(r => r.key === keyOf(m));
        if (have) have.versions = versions;
        else out.push({ key: keyOf(m), title: titleOf(m), versions });
    }
    return out;
}

function issues(meta, { missing = {}, manualMissing = {} } = {}) {
    const out = [];
    const byMr = new Map(meta.mods.filter(m => m.ids.modrinth).map(m => [m.ids.modrinth, m]));
    const byCf = new Map(meta.mods.filter(m => m.ids.curseforge).map(m => [Number(m.ids.curseforge), m]));
    const seenPairs = new Set();
    const pair = (a, b, why, severity = 'error') => {
        const k = [keyOf(a), keyOf(b)].sort().join('|');
        if (seenPairs.has(k) || a === b) return;
        seenPairs.add(k);
        out.push({ kind: 'conflict', severity, keys: [keyOf(a), keyOf(b)], title: severity === 'error' ? `${titleOf(a)} conflicts with ${titleOf(b)}` : `${titleOf(a)} advises against ${titleOf(b)}`, detail: why });
    };
    for (const m of meta.mods) {
        for (const id of m.incompat?.modrinth || []) { const o = byMr.get(id); if (o) pair(m, o, 'Marked incompatible on Modrinth'); }
        for (const id of m.incompat?.curseforge || []) { const o = byCf.get(Number(id)); if (o) pair(m, o, 'Marked incompatible on CurseForge'); }
    }
    const topIds = new Map();
    // Skip ids left as an unexpanded template (e.g. "${mod_id}").
    for (const m of meta.mods) for (const id of m.contents?.ids || []) if (!id.provided && !/\$\{/.test(id.id)) {
        const k = norm(id.id);
        if (!topIds.has(k)) topIds.set(k, []);
        topIds.get(k).push(m);
    }
    // Only flag when the installed version is in the declared range. Most declarations target old versions.
    for (const m of meta.mods) for (const inc of m.contents?.incompatible || []) {
        for (const o of topIds.get(norm(inc.id)) || []) {
            const installed = o.contents.ids.find(x => norm(x.id) === norm(inc.id))?.version;
            if (satisfies(installed, inc.versions) !== true) continue;
            const range = inc.versions && inc.versions !== '*' ? ` ${inc.versions}` : '';
            pair(m, o, `${titleOf(m)} declares ${inc.id}${range} ${inc.type === 'discouraged' ? 'discouraged' : 'incompatible'}; ${installed ? `${installed} is installed` : 'installed'}`, inc.type === 'discouraged' ? 'warn' : 'error');
        }
    }
    for (const [id, mods] of topIds) {
        const distinct = [...new Map(mods.map(m => [keyOf(m), m])).values()];
        if (distinct.length < 2) continue;
        const mergeable = distinct.length === 2 && distinct.some(m => m.ids.modrinth && !m.ids.curseforge) && distinct.some(m => m.ids.curseforge && !m.ids.modrinth);
        out.push({ kind: 'duplicate', severity: 'warn', keys: distinct.map(keyOf), mergeable,
            title: `${distinct.length} entries provide “${mods[0].contents.ids.find(x => norm(x.id) === id)?.id || id}”`,
            detail: mergeable ? `${distinct.map(titleOf).join(' and ')} are the Modrinth and CurseForge editions of the same mod.` : distinct.map(titleOf).join(', ') });
    }
    const missingCount = Object.keys(missing).length;
    if (missingCount) out.push({ kind: 'missing', severity: 'warn', keys: Object.keys(missing), title: `${missingCount} mod file${missingCount === 1 ? ' is' : 's are'} missing on disk`, detail: 'Repair downloads them again.' });
    out.push(...manualIssues(meta, manualMissing));
    return out;
}

const PL_NAME = { modrinth: 'Modrinth', curseforge: 'CurseForge' };

function manualIssues(meta, manualMissing) {
    const out = [];
    const sides = meta.mods.flatMap(m => ['modrinth', 'curseforge'].filter(pl => m.manual?.[pl]).map(pl => ({ m, pl, r: m.manual[pl], gone: manualMissing[keyOf(m)]?.includes(pl) })));
    const toDownload = sides.filter(x => x.r.from === 'download' && x.gone);
    if (toDownload.length) out.push({ kind: 'manual-download', severity: 'warn', keys: toDownload.map(x => keyOf(x.m)),
        title: `${toDownload.length === 1 ? 'A mod needs' : `${toDownload.length} mods need`} a manual download from CurseForge`,
        detail: 'Their authors don’t allow apps to download them. Download each from CurseForge, then choose the file in the mod’s details.' });
    const gone = sides.filter(x => x.r.from !== 'download' && x.gone);
    if (gone.length) out.push({ kind: 'manual-missing', severity: 'warn', keys: gone.map(x => keyOf(x.m)),
        title: `${gone.length === 1 ? 'A file' : `${gone.length} files`} added by hand ${gone.length === 1 ? 'is' : 'are'} missing on disk`,
        detail: 'They can’t be downloaded again. Add them back in each mod’s details.' });
    const stale = sides.filter(x => !x.gone && ['modrinth', 'curseforge'].includes(x.r.from) && x.m.installedFiles?.[x.r.from] && x.m.installedFiles[x.r.from] !== x.r.sourceFile);
    if (stale.length) out.push({ kind: 'manual-outdated', severity: 'info', keys: stale.map(x => keyOf(x.m)),
        title: `${stale.length === 1 ? 'A copied file is' : `${stale.length} copied files are`} older than the original`,
        detail: 'Copies aren’t updated automatically. Once a new version is fine to ship on the other platform, update the copy from the mod’s details.' });
    const bundled = sides.filter(x => x.r.from !== 'download' && !x.gone);
    if (bundled.length) out.push({ kind: 'manual', severity: 'info', keys: [...new Set(bundled.map(x => keyOf(x.m)))],
        title: `${bundled.length === 1 ? 'A file' : `${bundled.length} files`} added by hand`,
        detail: `${[...new Set(bundled.map(x => PL_NAME[x.pl]))].join(' and ')} can’t link ${bundled.length === 1 ? 'it' : 'them'}, so exports bundle ${bundled.length === 1 ? 'it' : 'them'} inside the pack. Check the licences allow that before publishing.` });
    return out;
}

const compactMods = (meta) => Object.fromEntries(meta.mods.map(m => [keyOf(m), [titleOf(m), versionOf(m)]]));

function diff(prev, meta) {
    const now = compactMods(meta);
    const before = prev || {};
    const added = [], removed = [], updated = [];
    for (const [k, [title, v]] of Object.entries(now)) {
        if (!before[k]) added.push({ title, version: v });
        else if (before[k][1] !== v) updated.push({ title, from: before[k][1], to: v });
    }
    for (const [k, [title, v]] of Object.entries(before)) if (!now[k]) removed.push({ title, version: v });
    const byTitle = (a, b) => a.title.localeCompare(b.title);
    return { added: added.sort(byTitle), removed: removed.sort(byTitle), updated: updated.sort(byTitle) };
}

function changelogMarkdown({ version, notes, changes, configLines = [] }) {
    const lines = [`## ${version}`, ''];
    if (notes?.trim()) lines.push(notes.trim(), '');
    const section = (title, items, fmt) => { if (items.length) lines.push(`### ${title}`, ...items.map(fmt), ''); };
    section('Added', changes.added, (x) => `- ${x.title} ${x.version}`.trim());
    section('Updated', changes.updated, (x) => `- ${x.title}: ${x.from} → ${x.to}`);
    section('Removed', changes.removed, (x) => `- ${x.title}`);
    if (!changes.added.length && !changes.updated.length && !changes.removed.length) lines.push('No mod changes.', '');
    if (configLines.length) lines.push(...configLines, '');
    return lines.join('\n').trim() + '\n';
}

module.exports = { providers, annotateBundled, issues, diff, compactMods, changelogMarkdown, norm, core };
