const fs = require('fs-extra');
const zlib = require('zlib');

class ZipSource {
    static async fromFile(file) {
        const fh = await fs.promises.open(file, 'r');
        const { size } = await fh.stat();
        return new ZipSource(size, async (pos, len) => {
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, pos);
            return buf;
        }, () => fh.close());
    }
    static fromBuffer(buf) { return new ZipSource(buf.length, async (pos, len) => buf.subarray(pos, pos + len), async () => {}); }

    constructor(size, read, close) { this.size = size; this.read = read; this.close = close; }

    async entries() {
        const tailLen = Math.min(this.size, 65557);
        const tail = await this.read(this.size - tailLen, tailLen);
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
        if (eocd < 0) throw new Error('Not a zip/jar file');
        const count = tail.readUInt16LE(eocd + 10);
        const cdSize = tail.readUInt32LE(eocd + 12);
        const cdOffset = tail.readUInt32LE(eocd + 16);
        const cd = await this.read(cdOffset, cdSize);
        const out = new Map();
        for (let i = 0, off = 0; i < count && off + 46 <= cd.length; i++) {
            const method = cd.readUInt16LE(off + 10);
            const csize = cd.readUInt32LE(off + 20);
            const nameLen = cd.readUInt16LE(off + 28), extra = cd.readUInt16LE(off + 30), comment = cd.readUInt16LE(off + 32);
            const local = cd.readUInt32LE(off + 42);
            const name = cd.toString('utf8', off + 46, off + 46 + nameLen);
            out.set(name, { method, csize, local });
            off += 46 + nameLen + extra + comment;
        }
        return out;
    }

    async readEntry(e) {
        const head = await this.read(e.local, 30);
        const start = e.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
        const data = await this.read(start, e.csize);
        return e.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    }
}

const stripJsonComments = (s) => s.replace(/^\uFEFF/, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');
function parseJsonLoose(buf) {
    try { return JSON.parse(stripJsonComments(buf.toString('utf8'))); } catch { return null; }
}

// Loader and runtime ids every mod depends on: not worth listing as dependencies.
const PLATFORM_IDS = new Set(['minecraft', 'java', 'forge', 'neoforge', 'fabricloader', 'fabric-loader', 'quilt_loader']);

function parseModsToml(text, jarVersion) {
    const mods = [], incompatible = [], depSides = [], depends = [];
    let clientSideOnly = false;
    const blocks = text.split(/^\s*\[\[/m);
    for (const block of blocks) {
        const header = block.slice(0, block.indexOf(']]'));
        const val = (k) => { const m = block.match(new RegExp(`^\\s*${k}\\s*=\\s*["']([^"'\\n]*)["']`, 'm')); return m ? m[1] : null; };
        if (header.trim() === 'mods') {
            const id = val('modId');
            if (/^\s*clientSideOnly\s*=\s*true/m.test(block)) clientSideOnly = true;
            if (id) mods.push({ id, version: (val('version') || '').replace('${file.jarVersion}', jarVersion || ''), name: val('displayName') || id });
        } else if (/^dependencies\./.test(header.trim())) {
            const type = (val('type') || '').toLowerCase();
            const mandatory = val('mandatory');
            const id = val('modId');
            if (id && (type === 'incompatible' || type === 'discouraged')) incompatible.push({ id, versions: val('versionRange') || '*', type });
            else if (id) depSides.push((val('side') || 'BOTH').toUpperCase());
            // Old Forge uses mandatory=true, NeoForge uses type="required".
            const required = type ? type === 'required' : /^\s*mandatory\s*=\s*true/m.test(block);
            if (id && required && !PLATFORM_IDS.has(id)) depends.push({ id, versions: val('versionRange') || '*' });
            void mandatory;
        }
    }
    return { mods, incompatible, clientSideOnly, depSides, depends };
}

function manifestVersion(buf) {
    if (!buf) return null;
    const m = buf.toString('utf8').match(/^Implementation-Version:\s*(.+)$/m);
    return m ? m[1].trim() : null;
}

function classStrings(buf) {
    if (buf.readUInt32BE(0) !== 0xCAFEBABE) return [];
    const count = buf.readUInt16BE(8);
    const out = [];
    let off = 10;
    for (let i = 1; i < count; i++) {
        const tag = buf[off++];
        if (tag === 1) { const len = buf.readUInt16BE(off); out.push(buf.toString('utf8', off + 2, off + 2 + len)); off += 2 + len; }
        else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) off += 2;
        else if (tag === 15) off += 3;
        else if (tag === 3 || tag === 4 || tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) off += 4;
        else if (tag === 5 || tag === 6) { off += 8; i++; }
        else break;   // unknown tag: stop rather than misread
    }
    return out;
}

async function describe(src, depth = 0) {
    const entries = await src.entries();
    const get = async (n) => (entries.has(n) ? src.readEntry(entries.get(n)) : null);
    const out = { ids: [], bundled: [], incompatible: [], depends: [], loaders: [], side: { declared: null, clientDeps: false, serverCrash: null } };
    const nested = [];
    const serverEntrypoints = [];

    const fabric = await get('fabric.mod.json');
    if (fabric) {
        const j = parseJsonLoose(fabric);
        if (j?.id) {
            out.loaders.push('fabric');
            out.ids.push({ id: j.id, version: String(j.version ?? ''), name: j.name || j.id });
            for (const p of [].concat(j.provides || [])) if (typeof p === 'string') out.ids.push({ id: p, version: String(j.version ?? ''), name: j.name || p, provided: true });
            for (const [id, range] of Object.entries(j.breaks || {})) out.incompatible.push({ id, versions: [].concat(range).join(' || ') });
            for (const [id, range] of Object.entries(j.depends || {})) if (!PLATFORM_IDS.has(id)) out.depends.push({ id, versions: [].concat(range).join(' || ') || '*' });
            for (const jar of j.jars || []) if (jar?.file) nested.push(jar.file);
            if (j.environment === 'client' || j.environment === 'server') out.side.declared = j.environment;
            for (const key of ['main', 'server']) for (const e of [].concat(j.entrypoints?.[key] || [])) serverEntrypoints.push(typeof e === 'string' ? e : e?.value);
        }
    }
    const quilt = await get('quilt.mod.json');
    if (quilt) {
        const j = parseJsonLoose(quilt)?.quilt_loader;
        if (j?.id && !out.ids.some(x => x.id === j.id)) { out.loaders.push('quilt'); out.ids.push({ id: j.id, version: String(j.version ?? ''), name: j.metadata?.name || j.id }); }
        for (const d of [].concat(j?.depends || [])) {
            const id = typeof d === 'string' ? d : d?.id;
            if (id && !d?.optional && !PLATFORM_IDS.has(id) && !out.depends.some(x => x.id === id)) out.depends.push({ id, versions: [].concat(d?.versions || '*').join(' || ') });
        }
        const root = parseJsonLoose(quilt);
        const env = root?.minecraft?.environment;
        if (env === 'client' || env === 'dedicated_server') out.side.declared = env === 'client' ? 'client' : 'server';
        for (const key of ['init', 'server_init']) for (const e of [].concat(j?.entrypoints?.[key] || [])) serverEntrypoints.push(typeof e === 'string' ? e : e?.value);
    }
    const jarVersion = manifestVersion(await get('META-INF/MANIFEST.MF'));
    for (const toml of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
        const t = await get(toml);
        if (!t) continue;
        const parsed = parseModsToml(t.toString('utf8'), jarVersion);
        out.loaders.push(toml.includes('neoforge') ? 'neoforge' : 'forge');
        for (const m of parsed.mods) if (!out.ids.some(x => x.id === m.id)) out.ids.push(m);
        out.incompatible.push(...parsed.incompatible);
        for (const d of parsed.depends) if (!out.depends.some(x => x.id === d.id)) out.depends.push(d);
        if (parsed.clientSideOnly) out.side.declared = 'client';
        // Forge / NeoForge client mods mark every dependency side="CLIENT". Common mods use BOTH.
        if (parsed.depSides.length && parsed.depSides.every(x => x === 'CLIENT')) out.side.clientDeps = true;
    }
    const jarjar = await get('META-INF/jarjar/metadata.json');
    if (jarjar) {
        const j = parseJsonLoose(jarjar);
        for (const e of j?.jars || []) {
            if (e.path) nested.push(e.path);
            else if (e.identifier) out.bundled.push({ id: e.identifier.artifact, version: e.version?.artifactVersion || '', name: e.identifier.artifact });
        }
    }

    // Server startup code that touches client-only classes without a side check crashes a dedicated server.
    if (depth === 0 && !out.side.declared) {
        for (const ref of serverEntrypoints.filter(Boolean).slice(0, 8)) {
            const cls = String(ref).split('::')[0].replace(/\./g, '/');
            const e = entries.get(`${cls}.class`);
            if (!e) continue;
            let pool;
            try { pool = classStrings(await src.readEntry(e)); } catch { continue; }
            const client = pool.find(x => /(^|L)net\/minecraft\/client\//.test(x));
            const guarded = pool.some(x => /net\/fabricmc\/api\/EnvType|net\/fabricmc\/loader\/api\/FabricLoader|getEnvironmentType|org\/quiltmc\/loader\/api\/minecraft\/MinecraftQuiltLoader/.test(x));
            if (client && !guarded) { out.side.serverCrash = `Its server startup code (${cls.split('/').pop()}) uses client-only Minecraft code`; break; }
        }
    }

    for (const path of nested) {
        const e = entries.get(path);
        if (!e) continue;
        const fileName = path.split('/').pop();
        let info = null;
        if (depth < 1) {
            try { info = await describe(ZipSource.fromBuffer(await src.readEntry(e)), depth + 1); } catch {}
        }
        if (info?.ids.length) for (const id of info.ids) out.bundled.push({ ...id, file: fileName });
        else out.bundled.push({ id: fileName.replace(/[-_]?\d[\w.+-]*\.jar$/, '').replace(/\.jar$/, ''), version: (fileName.match(/[-_](\d[\w.+-]*)\.jar$/) || [])[1] || '', name: fileName, file: fileName });
    }
    return out;
}

async function inspectJar(file) {
    const src = await ZipSource.fromFile(file);
    try { return await describe(src); } finally { await src.close(); }
}

function cfFingerprint(buf) {
    const isWs = (b) => b === 9 || b === 10 || b === 13 || b === 32;
    let len = 0;
    for (let i = 0; i < buf.length; i++) if (!isWs(buf[i])) len++;
    const m = 0x5bd1e995;
    let h = (1 ^ len) >>> 0;
    let k = 0, shift = 0;
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (isWs(b)) continue;
        k |= b << shift;
        shift += 8;
        if (shift === 32) {
            k = Math.imul(k, m);
            k ^= k >>> 24;
            k = Math.imul(k, m);
            h = Math.imul(h, m) ^ k;
            k = 0; shift = 0;
        }
    }
    if (shift > 0) { h ^= k; h = Math.imul(h, m); }
    h ^= h >>> 13;
    h = Math.imul(h, m);
    h ^= h >>> 15;
    return h >>> 0;
}

const normalizeId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

module.exports = { classStrings, inspectJar, describe, ZipSource, cfFingerprint, normalizeId };
