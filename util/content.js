// An entry without `type` is a mod (everything from 2.2 and older).
const { loaderInfo } = require('./loaders');

const TYPES = {
    mod: {
        id: 'mod', label: 'Mods', one: 'mod', many: 'mods', folder: 'mods',
        cfClass: 6, mrType: 'mod', usesLoader: true, clientOnly: false, ext: /\.jar$/i
    },
    resourcepack: {
        id: 'resourcepack', label: 'Resource packs', one: 'resource pack', many: 'resource packs', folder: 'resourcepacks',
        cfClass: 12, mrType: 'resourcepack', usesLoader: false, mrLoaders: ['minecraft'], clientOnly: true, ext: /\.zip$/i
    },
    shader: {
        id: 'shader', label: 'Shaders', one: 'shader', many: 'shaders', folder: 'shaderpacks',
        cfClass: 6552, mrType: 'shader', usesLoader: false, mrLoaders: ['iris', 'optifine', 'canvas', 'vanilla'], clientOnly: true, ext: /\.zip$/i
    },
    datapack: {
        id: 'datapack', label: 'Data packs', one: 'data pack', many: 'data packs', folder: 'datapacks',
        cfClass: 6945, mrType: 'datapack', usesLoader: false, mrLoaders: ['datapack'], clientOnly: false, ext: /\.zip$/i
    }
};
const ORDER = ['mod', 'resourcepack', 'shader', 'datapack'];

const typeOf = (entryOrId) => TYPES[typeof entryOrId === 'string' ? entryOrId : entryOrId?.type] || TYPES.mod;

// Resource packs and data packs can go to another folder of the game directory, for a global pack loader (e.g.
// config/paxi/datapacks). The item's own folder wins over the pack's folder for its type. Files stay in the pack's
// platform folders either way; this only decides where Play and exports put them.
const MOVABLE = ['resourcepack', 'datapack'];
function folderOf(meta, m) {
    const t = typeOf(m);
    if (!MOVABLE.includes(t.id)) return t.folder;
    return m.installDir || meta?.installDirs?.[t.id] || t.folder;
}

// A folder relative to the game directory, written with forward slashes. Throws for anything that could leave it.
function cleanFolder(input) {
    const s = String(input ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!s) return null;
    if (/^([a-z]:|\/)/i.test(s) || s.split('/').some(p => !p || p === '.' || p === '..') || /[<>:"|?*\u0000-\u001f]/.test(s)) {
        throw new Error('Use a folder inside the game folder, like config/paxi/datapacks.');
    }
    return s;
}

const mrLoadersFor = (type, loader) => (typeOf(type).usesLoader ? [loaderInfo(loader).mr] : typeOf(type).mrLoaders);

const cfIndexFits = (type, row, gameVersion, cfLoader) => row[0] === gameVersion && (!typeOf(type).usesLoader || row[1] === cfLoader);

const typeFromCfClass = (classId) => ORDER.find(k => TYPES[k].cfClass === Number(classId)) || null;
const typeFromMrType = (projectType) => ORDER.find(k => TYPES[k].mrType === projectType) || null;
const typeFromFolder = (folder) => ORDER.find(k => TYPES[k].folder === folder) || null;

// CurseForge unless Modrinth has more of the pack's entries, otherwise a pack built from Modrinth would start with
// most mods missing.
function playPlatform(meta) {
    const chosen = meta.launch?.platform;
    if (chosen === 'modrinth' || chosen === 'curseforge') return chosen;
    const mods = meta.mods || [];
    const mr = mods.filter(m => m.ids?.modrinth).length, cf = mods.filter(m => m.ids?.curseforge).length;
    return mr > cf ? 'modrinth' : 'curseforge';
}

module.exports = { playPlatform, TYPES, ORDER, typeOf, folderOf, cleanFolder, MOVABLE, mrLoadersFor, cfIndexFits, typeFromCfClass, typeFromMrType, typeFromFolder };
