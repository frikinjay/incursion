const LOADERS = {
    fabric:   { id: 'fabric',   label: 'Fabric',   cf: 4, mr: 'fabric',   mrpack: 'fabric-loader', cfManifest: 'fabric' },
    quilt:    { id: 'quilt',    label: 'Quilt',    cf: 5, mr: 'quilt',    mrpack: 'quilt-loader',  cfManifest: 'quilt' },
    forge:    { id: 'forge',    label: 'Forge',    cf: 1, mr: 'forge',    mrpack: 'forge',         cfManifest: 'forge' },
    neoforge: { id: 'neoforge', label: 'NeoForge', cf: 6, mr: 'neoforge', mrpack: 'neoforge',      cfManifest: 'neoforge' }
};

function loaderInfo(loader) {
    const info = LOADERS[String(loader || '').toLowerCase()];
    if (!info) throw new Error(`Unsupported mod loader "${loader}"`);
    return info;
}

function compareVersions(a, b) {
    const pa = String(a).split(/[.+-]/), pb = String(b).split(/[.+-]/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i], y = pb[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const nx = Number(x), ny = Number(y);
        if (Number.isFinite(nx) && Number.isFinite(ny)) { if (nx !== ny) return nx - ny; }
        else if (x !== y) return Number.isFinite(nx) ? 1 : Number.isFinite(ny) ? -1 : x.localeCompare(y);
    }
    return 0;
}

// NeoForge versions encode the Minecraft version: 1.21.1 -> 21.1.x, 26.3 -> 26.3.0.x
function neoforgePrefix(gameVersion) {
    const p = String(gameVersion).split('.').map(Number);
    if (p[0] === 1) return p[1] >= 20 ? `${p[1]}.${p[2] || 0}.` : null;
    if (p[0] >= 25) return `${p[0]}.${p[1] || 0}.${p[2] || 0}.`;
    return null;
}

module.exports = { LOADERS, loaderInfo, compareVersions, neoforgePrefix };
