// Saved settings win, then env vars. On Windows the registry is read too, so variables set after launch are still
// found.
const { execFileSync } = require('child_process');

const registryCache = new Map();
function fromRegistry(name) {
    if (process.platform !== 'win32') return '';
    if (registryCache.has(name)) return registryCache.get(name);
    let value = '';
    for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
        try {
            const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            const m = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)`));
            if (m) { value = m[1].trim(); break; }
        } catch {}
    }
    registryCache.set(name, value);
    return value;
}

const readVar = (name) => (process.env[name] || fromRegistry(name) || '').trim();

// CurseForge has two unrelated credentials: the Core API key ($2a$10$...) for search and downloads, and an account
// token (a UUID) for uploads. CURSEFORGE_TOKEN can hold either, so sort by shape.
const looksLikeCoreKey = (v) => /^\$2[aby]\$\d{2}\$/.test(v);
const looksLikeUploadToken = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const SOURCES = {
    curseforge: [['CURSEFORGE_API_KEY'], ['CF_API_KEY'], ['CURSEFORGE_TOKEN', looksLikeCoreKey]],
    curseforgeUpload: [['CURSEFORGE_UPLOAD_TOKEN'], ['CURSEFORGE_TOKEN', looksLikeUploadToken]],
    modrinth: [['MODRINTH_TOKEN'], ['MODRINTH_API_KEY'], ['MODRINTH_PAT']]
};

function resolveToken(kind, saved) {
    if (saved) return { value: saved, source: 'settings' };
    for (const [name, accept] of SOURCES[kind] || []) {
        const v = readVar(name);
        if (v && (!accept || accept(v))) return { value: v, source: name };
    }
    return { value: '', source: null };
}

function resolveAll(settings) {
    return Object.fromEntries(Object.keys(SOURCES).map(k => [k, resolveToken(k, settings[k])]));
}

module.exports = { resolveToken, resolveAll, readVar, looksLikeCoreKey, looksLikeUploadToken, SOURCES };
