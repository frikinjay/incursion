const path = require('path');
const os = require('os');
const fs = require('fs-extra');

let custom = null;

function defaultRoot() {
    const base = process.platform === 'win32' ? process.env.APPDATA
        : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : os.homedir();
    return path.join(base, '.incursion');
}

// Older versions used "incursion" on macOS. On case-insensitive disks that is also the app's own profile folder, so the
// game files stay where they are instead of being moved out of it.
function legacyRoot() {
    return process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'incursion') : null;
}

const GAME_FOLDERS = ['versions', 'libraries', 'assets', 'java', 'runtime'];
async function hasGameFiles(dir) {
    for (const name of GAME_FOLDERS) if (await fs.pathExists(path.join(dir, name))) return true;
    return false;
}

const get = () => custom || defaultRoot();
const set = (dir) => { custom = dir ? path.resolve(dir) : null; };
const isDefault = () => !custom || path.resolve(custom) === path.resolve(defaultRoot());

async function inspect(dir) {
    const abs = path.resolve(dir);
    if (!(await fs.pathExists(abs))) return { path: abs, exists: false, empty: true, incursion: false };
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) throw Object.assign(new Error('That is a file, not a folder.'), { code: 'NOT_A_FOLDER' });
    const names = await fs.readdir(abs);
    return { path: abs, exists: true, empty: names.length === 0, incursion: names.some(n => GAME_FOLDERS.includes(n)), entries: names.length };
}

// Never overwrites anything already in `to`. Returns the names that were skipped.
async function moveContents(from, to, onProgress) {
    await fs.ensureDir(to);
    if (!(await fs.pathExists(from))) return [];
    const names = await fs.readdir(from);
    const skipped = [];
    for (let i = 0; i < names.length; i++) {
        const src = path.join(from, names[i]);
        const dest = path.join(to, names[i]);
        onProgress?.(i / names.length, names[i]);
        if (await fs.pathExists(dest)) { skipped.push(names[i]); continue; }
        await fs.move(src, dest);   // rename on the same drive, copy then delete across drives
    }
    onProgress?.(1, '');
    if (!skipped.length) await fs.remove(from).catch(() => {});
    return skipped;
}

module.exports = { defaultRoot, legacyRoot, hasGameFiles, get, set, isDefault, inspect, moveContents };
