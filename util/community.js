// links.json is checked against the Ed25519 public key built into the app before any of it is used. A file that fails
// the check or has the wrong shape is ignored, and the last good copy stays.
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { request } = require('./http');

const TYPES = ['mod', 'resourcepack', 'shader', 'datapack'];
const MR_ID = /^[A-Za-z0-9]{8}$/;
const MAX_ENTRIES = 400000;
const MAX_BYTES = 40 * 1024 * 1024;
const REFRESH_EVERY = 12 * 3600 * 1000;

let opts = { userData: null, repo: null, publicKey: null };
let index = null;
let meta = { checkedAt: 0, error: null, generatedAt: null };
let refreshing = null;

const files = () => ({ data: path.join(opts.userData, 'community-links.json'), sig: path.join(opts.userData, 'community-links.json.sig'), meta: path.join(opts.userData, 'community-links.meta.json') });

function init({ userData, repo, publicKey }) {
    opts = { userData, repo: repo || null, publicKey: publicKey || null };
    index = null;
    if (!userData) return;
    const f = files();
    try { meta = { ...meta, ...fs.readJsonSync(f.meta) }; } catch {}
    try { load(fs.readFileSync(f.data), fs.readFileSync(f.sig, 'utf8')); } catch { index = null; }
}

function verified(bytes, signatureB64) {
    if (!opts.publicKey) return false;
    try {
        const key = crypto.createPublicKey({ key: Buffer.from(opts.publicKey, 'base64'), format: 'der', type: 'spki' });
        return crypto.verify(null, bytes, key, Buffer.from(String(signatureB64).trim(), 'base64'));
    } catch { return false; }
}

function load(bytes, signature) {
    if (!verified(bytes, signature)) throw new Error('The community links file is not signed by Incursion.');
    const data = JSON.parse(bytes.toString('utf8'));
    if (data?.v !== 1 || !data.links || typeof data.links !== 'object') throw new Error('Unknown community links format.');
    const byType = {};
    let count = 0;
    for (const type of TYPES) {
        const list = Array.isArray(data.links[type]) ? data.links[type] : [];
        const cf = new Map(), mr = new Map();
        for (const row of list) {
            if (!Array.isArray(row) || ++count > MAX_ENTRIES) continue;
            const c = Number.isInteger(row[0]) && row[0] > 0 ? row[0] : null;
            const m = typeof row[1] === 'string' && MR_ID.test(row[1]) ? row[1] : null;
            if (c == null && m == null) continue;
            const rec = { cf: c, mr: m, voters: Number(row[2]) || 0, source: 'community' };
            if (c != null) cf.set(c, rec);
            if (m != null) mr.set(m, rec);
        }
        byType[type] = { cf, mr };
    }
    index = { generatedAt: data.generatedAt || null, count, byType };
    meta.generatedAt = index.generatedAt;
}

async function refresh({ force = false } = {}) {
    if (!opts.repo || !opts.publicKey || !opts.userData) return status();
    if (!force && Date.now() - (meta.checkedAt || 0) < REFRESH_EVERY) return status();
    return (refreshing ||= (async () => {
        try {
            const base = `https://raw.githubusercontent.com/${opts.repo}/main/`;
            const [bytes, sig] = await Promise.all([
                request(`${base}links.json`, { as: 'buffer', retries: 1, timeout: 60000 }),
                request(`${base}links.json.sig`, { as: 'text', retries: 1, timeout: 20000 })
            ]);
            if (bytes.length > MAX_BYTES) throw new Error('The community links file is too large.');
            load(bytes, sig);
            const f = files();
            const storage = require('./storage');
            await storage.writeAtomic(f.data, bytes);
            await storage.writeAtomic(f.sig, String(sig));
            meta.error = null;
        } catch (err) {
            // 404 means nothing's published yet. Anything else keeps the last good copy.
            meta.error = err.status === 404 ? null : err.message;
        } finally {
            meta.checkedAt = Date.now();
            await require('./storage').writeJsonAtomic(files().meta, { checkedAt: meta.checkedAt, generatedAt: meta.generatedAt, error: meta.error }).catch(() => {});
            refreshing = null;
        }
        return status();
    })());
}

function get(platform, id, type = 'mod') {
    const t = index?.byType[type] || index?.byType.mod;
    if (!t || id == null) return null;
    return (platform === 'curseforge' ? t.cf.get(Number(id)) : t.mr.get(String(id))) || null;
}

const status = () => ({ enabled: !!(opts.repo && opts.publicKey), loaded: !!index, links: index?.count || 0, generatedAt: index?.generatedAt || null, checkedAt: meta.checkedAt || 0, error: meta.error || null });

module.exports = { init, refresh, get, status, verified, _load: load };
