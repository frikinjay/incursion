const fs = require('fs-extra');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const toml = require('./toml');

const ROOTS = ['config', 'defaultconfigs'];
const MAX_FILE = 2 * 1024 * 1024;   // larger files are tracked by hash only
const MAX_PARSE = 512 * 1024;
const MAX_FILES = 20000;
const MAX_VALUE = 160;
const STRUCTURED = /\.(json|json5|jsonc|toml|properties|cfg|ini|conf|yml|yaml|txt)$/i;

const dirOf = (packPath) => path.join(packPath, '.releases');
const fileFor = (packPath, version) => path.join(dirOf(packPath), `${String(version).replace(/[^\w.+-]/g, '_')}.configs.json.gz`);

const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s; };
function flatten(obj, prefix = '', out = {}) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
        if (!Object.keys(obj).length && prefix) out[prefix] = '{}';
    } else out[prefix || '(value)'] = short(obj);
    return out;
}

// Mod configs often use JSON with comments and trailing commas.
function looseJson(text) {
    try { return JSON.parse(text); } catch {}
    let out = '', i = 0, str = null;
    while (i < text.length) {
        const c = text[i];
        if (str) { out += c; if (c === '\\') { out += text[i + 1] || ''; i += 2; continue; } if (c === str) str = null; i++; continue; }
        if (c === '"' || c === "'") { str = c; out += '"'; i++; let s = ''; while (i < text.length && text[i] !== c) { if (text[i] === '\\') { s += text[i] + (text[i + 1] || ''); i += 2; continue; } s += text[i] === '"' ? '\\"' : text[i]; i++; } out += s + '"'; i++; str = null; continue; }
        if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
        if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); i = i === -1 ? text.length : i + 2; continue; }
        out += c; i++;
    }
    out = out.replace(/,(\s*[}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3');
    return JSON.parse(out);
}

function keyValues(text) {
    const out = {};
    const stack = [];
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || /^[#;!]/.test(line) || line.startsWith('//')) continue;
        let m;
        if ((m = line.match(/^\[([^\]]+)\]$/))) { section = m[1].trim(); continue; }
        if ((m = line.match(/^"?([^"{=]+?)"?\s*\{$/))) { stack.push(m[1].trim()); continue; }
        if (line === '}') { stack.pop(); continue; }
        if ((m = line.match(/^(?:[A-Z]:)?"?([^"=:<]+?)"?\s*[=:]\s*(.*)$/))) {
            const k = [section, ...stack, m[1].trim()].filter(Boolean).join('.');
            out[k] = short(m[2].trim());
        }
    }
    return Object.keys(out).length ? out : null;
}

function yamlish(text) {
    const out = {};
    const stack = [];
    for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim() || /^\s*#/.test(raw)) continue;
        const indent = raw.match(/^\s*/)[0].length;
        const line = raw.trim();
        while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
        const m = line.match(/^("?)([^":#]+)\1\s*:\s*(.*)$/);
        if (!m) { if (line.startsWith('- ') && stack.length) { const k = stack.map(s => s[1]).join('.'); out[k] = short(out[k] && out[k] !== '{}' ? `${out[k]}, ${line.slice(2)}` : line.slice(2)); } continue; }
        const key = [...stack.map(s => s[1]), m[2].trim()].join('.');
        if (m[3] && !m[3].startsWith('#')) out[key] = short(m[3].replace(/\s+#.*$/, ''));
        else stack.push([indent, m[2].trim()]);
    }
    return Object.keys(out).length ? out : null;
}

function parse(file, text) {
    const ext = path.extname(file).toLowerCase();
    try {
        if (ext === '.json' || ext === '.json5' || ext === '.jsonc') return flatten(looseJson(text));
        if (ext === '.toml') return flatten(toml.parse(text));
        if (ext === '.yml' || ext === '.yaml') return yamlish(text);
        return keyValues(text);
    } catch { return ext === '.toml' || ext === '.json' ? keyValues(text) : null; }
}

async function snapshot(packPath, previous = null) {
    const prev = previous?.files || {};
    const base = path.join(packPath, 'overrides');
    const files = {};
    let count = 0;
    async function walk(dir, rel) {
        let list;
        try { list = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of list) {
            if (count >= MAX_FILES) return;
            const abs = path.join(dir, e.name);
            const r = `${rel}/${e.name}`;
            if (e.isDirectory()) { await walk(abs, r); continue; }
            if (!e.isFile()) continue;
            const stat = await fs.stat(abs).catch(() => null);
            if (!stat || stat.size > MAX_FILE) { if (stat) files[r] = { hash: `size:${stat.size}:${stat.mtimeMs}` }; continue; }
            const old = prev[r];
            if (old && old.size === stat.size && old.mtime === stat.mtimeMs) { files[r] = old; count++; continue; }
            const buf = await fs.readFile(abs);
            const rec = { hash: crypto.createHash('sha1').update(buf).digest('hex'), size: stat.size, mtime: stat.mtimeMs };
            if (STRUCTURED.test(e.name) && buf.length <= MAX_PARSE && !buf.includes(0)) {
                const values = parse(e.name, buf.toString('utf8'));
                if (values) rec.values = values;
            }
            files[r] = rec;
            count++;
        }
    }
    for (const root of ROOTS) await walk(path.join(base, root), root);
    return { v: 1, files };
}

async function save(packPath, version, snap) {
    await require('./storage').writeAtomic(fileFor(packPath, version), zlib.gzipSync(JSON.stringify(snap)));
}
async function load(packPath, version) {
    try { return JSON.parse(zlib.gunzipSync(await fs.readFile(fileFor(packPath, version))).toString('utf8')); }
    catch { return null; }
}

function diff(before, after) {
    const a = before?.files || {}, b = after?.files || {};
    const out = { added: [], removed: [], changed: [] };
    for (const f of Object.keys(b)) if (!a[f]) out.added.push(f);
    for (const f of Object.keys(a)) if (!b[f]) out.removed.push(f);
    for (const f of Object.keys(b)) {
        if (!a[f] || a[f].hash === b[f].hash) continue;
        if (!a[f].values || !b[f].values) { out.changed.push({ file: f, values: [], opaque: true }); continue; }
        const values = [];
        const keys = new Set([...Object.keys(a[f].values), ...Object.keys(b[f].values)]);
        for (const k of keys) {
            const from = a[f].values[k], to = b[f].values[k];
            if (from !== to) values.push({ key: k, from: from ?? null, to: to ?? null });
        }
        // Same values, different bytes (comments or formatting): not worth a changelog line.
        if (values.length) out.changed.push({ file: f, values: values.slice(0, 200), more: Math.max(0, values.length - 200) });
    }
    for (const k of ['added', 'removed']) out[k].sort();
    out.changed.sort((x, y) => x.file.localeCompare(y.file));
    return out;
}

const isEmpty = (d) => !d || (!d.added.length && !d.removed.length && !d.changed.length);

function markdownLines(d, { perFile = 15 } = {}) {
    if (isEmpty(d)) return [];
    const lines = ['### Config Changes'];
    const code = (s) => `\`${String(s).replace(/`/g, 'ˋ')}\``;
    for (const c of d.changed) {
        if (c.opaque) { lines.push(`- ${code(c.file)} changed`); continue; }
        lines.push(`- ${code(c.file)}`);
        for (const v of c.values.slice(0, perFile)) {
            lines.push(v.from == null ? `  - ${code(v.key)} added: ${code(v.to)}` : v.to == null ? `  - ${code(v.key)} removed` : `  - ${code(v.key)}: ${code(v.from)} → ${code(v.to)}`);
        }
        const rest = c.values.length - perFile + (c.more || 0);
        if (rest > 0) lines.push(`  - and ${rest} more`);
    }
    if (d.added.length) lines.push(`- Added ${d.added.map(code).join(', ')}`);
    if (d.removed.length) lines.push(`- Removed ${d.removed.map(code).join(', ')}`);
    return lines;
}

const summary = (d) => (isEmpty(d) ? null : { files: d.changed.length + d.added.length + d.removed.length, values: d.changed.reduce((n, c) => n + c.values.length + (c.more || 0), 0), lines: markdownLines(d) });

module.exports = { snapshot, save, load, diff, isEmpty, markdownLines, summary, parse };
