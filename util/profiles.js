const { modKey } = require('./api');

const FULL = 'full';

function list(meta) {
    return [{ id: FULL, name: 'Full', exclude: [] }, ...(meta.profiles || [])];
}

function find(meta, id) {
    return list(meta).find(p => p.id === (id || FULL)) || list(meta)[0];
}

function apply(meta, id, { rename = false } = {}) {
    const p = find(meta, id);
    const on = meta.mods.filter(m => !m.disabled);
    if (p.id === FULL) return on.length === meta.mods.length ? meta : { ...meta, mods: on };
    const out = new Set(p.exclude.map(String));
    return { ...meta, name: rename ? `${meta.name} (${p.name})` : meta.name, mods: on.filter(m => !out.has(modKey(m))), profile: { id: p.id, name: p.name } };
}

function clean(profiles, meta) {
    const keys = new Set(meta.mods.map(m => modKey(m)));
    const seen = new Set();
    return (Array.isArray(profiles) ? profiles : []).filter(p => p && p.id && p.id !== FULL && !seen.has(p.id) && seen.add(p.id)).map(p => ({
        id: String(p.id).slice(0, 40),
        name: String(p.name || 'Profile').trim().slice(0, 40) || 'Profile',
        exclude: [...new Set((p.exclude || []).map(String))].filter(k => keys.has(k))
    }));
}

module.exports = { FULL, list, find, apply, clean };
