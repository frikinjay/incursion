// Whether each installed file fits the pack's Minecraft version, loader and loader version. Two sources, per platform:
//   - what the site lists for the file (mod.targets[platform]: game versions and loaders), and
//   - what the jar's own metadata asks for (mod.contents.requires[platform]: Minecraft and loader version ranges).
// Only a definite mismatch counts: a missing list or a range that can't be read (e.g. "${mc_version}") is not a flag.
const { satisfies } = require('./ranges');
const { LOADERS } = require('./loaders');
const content = require('./content');

const PLATFORMS = ['modrinth', 'curseforge'];
const LOADER_DEP = { neoforge: 'neoforge', forge: 'forge', fabric: 'fabricloader', quilt: 'quilt_loader' };
const keyOf = (m) => String(m.ids.curseforge || m.ids.modrinth || m.ids.local);
const titleOf = (m) => m.names?.curseforge || m.names?.modrinth || m.installedFiles?.modrinth || m.installedFiles?.curseforge || 'Unknown mod';
const label = (loader) => LOADERS[loader]?.label || loader;

// Quilt runs Fabric mods, so a Fabric file is fine in a Quilt pack.
const loaderFits = (fileLoaders, packLoader) => fileLoaders.includes(packLoader) || (packLoader === 'quilt' && fileLoaders.includes('fabric'));

// Reasons one platform's file doesn't fit, e.g. [{ kind: 'minecraft', text: 'Made for Minecraft 1.21.1' }].
function reasons(meta, m, pl) {
    if (!m.installedFiles?.[pl]) return [];
    const out = [];
    const usesLoader = content.typeOf(m.type).usesLoader;
    const t = m.targets?.[pl];
    // Resource packs and shaders usually work across versions even when listed for a few, so only mods are checked.
    if (usesLoader && t?.gameVersions?.length && !t.gameVersions.includes(meta.gameVersion)) {
        out.push({ kind: 'minecraft', text: `Made for Minecraft ${shortList(t.gameVersions)}` });
    }
    const known = t?.loaders?.filter(l => LOADERS[l]) || [];
    if (usesLoader && known.length && !loaderFits(known, meta.loader)) {
        out.push({ kind: 'loader', text: `Made for ${known.map(label).join(', ')}` });
    }
    const req = m.contents?.requires?.[pl];
    if (req && usesLoader) {
        if (!out.some(r => r.kind === 'minecraft') && req.minecraft && satisfies(meta.gameVersion, req.minecraft) === false) {
            out.push({ kind: 'minecraft', text: `Needs Minecraft ${words(req.minecraft)}` });
        }
        if (req.loader && req.loader.id === LOADER_DEP[meta.loader] && meta.loaderVersion && satisfies(meta.loaderVersion, req.loader.versions) === false) {
            out.push({ kind: 'loaderVersion', text: `Needs ${label(meta.loader)} ${words(req.loader.versions)}` });
        }
    }
    return out;
}

// "[26.2.0.67,)" -> "26.2.0.67 or newer", "[1.21,1.22)" -> "1.21 or newer, below 1.22", ">=0.16" -> "0.16 or newer".
// Anything else is shown as written.
function words(range) {
    return String(range).split('||').map(r => {
        r = r.trim();
        let m = r.match(/^\[\s*([^,\]]+?)\s*,\s*\)$/);
        if (m) return `${m[1]} or newer`;
        m = r.match(/^\[\s*([^,]+?)\s*,\s*([^\]\)]+?)\s*([\])])$/);
        if (m) return m[3] === ')' ? `${m[1]} or newer, below ${m[2]}` : `${m[1]} to ${m[2]}`;
        m = r.match(/^\(\s*,\s*([^\]\)]+?)\s*([\])])$/);
        if (m) return m[2] === ')' ? `below ${m[1]}` : `${m[1]} or older`;
        m = r.match(/^\[\s*([^,\]]+?)\s*\]$/);
        if (m) return `exactly ${m[1]}`;
        m = r.match(/^>=\s*(\S+)$/);
        if (m) return `${m[1]} or newer`;
        return r;
    }).join(' or ');
}

function shortList(versions) {
    return versions.length > 3 ? `${versions.slice(0, 3).join(', ')}…` : versions.join(', ');
}

// { [modKey]: { modrinth?: reasons, curseforge?: reasons } } for every mod with at least one mismatch.
function all(meta) {
    const out = {};
    for (const m of meta.mods) {
        const per = {};
        for (const pl of PLATFORMS) { const r = reasons(meta, m, pl); if (r.length) per[pl] = r; }
        if (Object.keys(per).length) out[keyOf(m)] = per;
    }
    return out;
}

function issues(meta) {
    const found = all(meta);
    const keys = Object.keys(found);
    if (!keys.length) return [];
    const byKey = new Map(meta.mods.map(m => [keyOf(m), m]));
    const names = keys.map(k => titleOf(byKey.get(k)));
    return [{
        kind: 'incompatible', severity: 'error', keys,
        title: `${keys.length} mod${keys.length === 1 ? ' doesn’t' : 's don’t'} fit Minecraft ${meta.gameVersion} with ${label(meta.loader)} ${meta.loaderVersion || ''}`.trim(),
        detail: names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', ')
    }];
}

// A site-tracked file whose targets were never recorded (packs from before they were).
const needsTargets = (m) => PLATFORMS.some(pl => m.ids?.[pl] && m.installedFiles?.[pl] && !m.manual?.[pl] && m.targets?.[pl] === undefined);

module.exports = { reasons, all, issues, needsTargets, words };
