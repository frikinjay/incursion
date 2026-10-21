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

module.exports = { playPlatform, TYPES, ORDER, typeOf, mrLoadersFor, cfIndexFits, typeFromCfClass, typeFromMrType, typeFromFolder };
