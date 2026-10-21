const { satisfies } = require('./ranges');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const core = (s) => norm(s).replace(/(api|lib|library|core|mod|forge|neoforge|fabric|quilt)+$/g, '') || norm(s);
const keyOf = (m) => String(m.ids.curseforge || m.ids.modrinth);
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
        return { ...d, providedBy, bundledOnly: providedBy.length > 0 && providedBy.every(e => e.bundled) };
    });
}

function issues(meta, { missing = {} } = {}) {
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
