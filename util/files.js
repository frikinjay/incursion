// Every path resolves inside the pack folder or its game folder and is rejected if it escapes. Deletes go to the trash.
const fs = require('fs-extra');
const path = require('path');

const MAX_EDIT_BYTES = 4 * 1024 * 1024;
let trash = async (p) => fs.remove(p);

function init({ trashItem }) { if (trashItem) trash = trashItem; }

function within(root, rel = '') {
    const base = path.resolve(root);
    const full = path.resolve(base, String(rel).replace(/^[\\/]+/, ''));
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error('That path is outside the pack.');
    return full;
}

const relOf = (root, full) => path.relative(path.resolve(root), full).split(path.sep).join('/');

async function list(root, rel = '') {
    const dir = within(root, rel);
    if (!(await fs.pathExists(dir))) return [];
    const items = await fs.readdir(dir, { withFileTypes: true });
    const hidden = (d) => d.name.startsWith('.import') || d.name.endsWith('.tmp') || d.name.endsWith('.part') || (!rel && (d.name === 'incursion.json' || d.name === 'pack-metadata.json' || d.name === 'pending_updates.json'));
    const out = await Promise.all(items.filter(d => !hidden(d)).map(async d => {
        const full = path.join(dir, d.name);
        let st = null;
        try { st = await fs.stat(full); } catch {}
        return { name: d.name, path: relOf(root, full), dir: d.isDirectory(), size: st?.size || 0, mtime: st?.mtimeMs || 0 };
    }));
    return out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

async function read(root, rel) {
    const file = within(root, rel);
    const st = await fs.stat(file);
    if (st.isDirectory()) throw new Error('That is a folder.');
    if (st.size > MAX_EDIT_BYTES) return { path: rel, size: st.size, tooLarge: true };
    const buf = await fs.readFile(file);
    const probe = buf.subarray(0, 8192);
    if (probe.includes(0)) return { path: rel, size: st.size, binary: true };
    const text = buf.toString('utf8');
    return { path: rel, size: st.size, mtime: st.mtimeMs, text, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

// Atomic save. Refuses if the file changed on disk since it was opened, unless forced.
async function write(root, rel, text, { mtime, force = false } = {}) {
    const file = within(root, rel);
    if (!force && mtime && (await fs.pathExists(file))) {
        const st = await fs.stat(file);
        if (Math.abs(st.mtimeMs - mtime) > 1) throw Object.assign(new Error('This file changed on disk since you opened it.'), { code: 'CONFLICT' });
    }
    await require('./storage').writeAtomic(file, text);
    const st = await fs.stat(file);
    return { path: rel, size: st.size, mtime: st.mtimeMs };
}

async function create(root, rel, { dir = false } = {}) {
    const full = within(root, rel);
    if (await fs.pathExists(full)) throw new Error('Something with that name already exists.');
    if (dir) await fs.ensureDir(full); else await fs.outputFile(full, '');
    return { path: relOf(root, full) };
}

async function rename(root, rel, newName) {
    if (!newName || /[\\/]/.test(newName)) throw new Error('Names cannot contain slashes.');
    const from = within(root, rel);
    const to = within(root, path.join(path.dirname(rel), newName));
    if (await fs.pathExists(to)) throw new Error('Something with that name already exists.');
    await fs.move(from, to);
    return { path: relOf(root, to) };
}

async function remove(root, rel) {
    const full = within(root, rel);
    if (full === path.resolve(root)) throw new Error('The root folder cannot be deleted.');
    await trash(full);
}

async function copyToOverrides(gameRoot, packRoot, rel) {
    const from = within(gameRoot, rel);
    const to = within(path.join(packRoot, 'overrides'), rel);
    await fs.copy(from, to, { overwrite: true });
    return { path: relOf(packRoot, to) };
}

module.exports = { init, within, list, read, write, create, rename, remove, copyToOverrides };
