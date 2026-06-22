require('dotenv').config();
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra'); // Required for outputJson/readJson
const axios = require('axios');

const CF_API = 'https://api.curseforge.com/v1';
const MR_API = 'https://api.modrinth.com/v2';

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

let CF_HEADERS = {};
let MR_HEADERS = {};

async function updateApiHeaders() {
    let settings = { curseforge: process.env.CURSEFORGE_API_KEY || '', modrinth: process.env.MODRINTH_API_KEY || '' };
    if (await fs.pathExists(settingsPath)) {
        const saved = await fs.readJson(settingsPath);
        settings = { ...settings, ...saved };
    }
    CF_HEADERS = { 'x-api-key': settings.curseforge };
    MR_HEADERS = { 'Authorization': settings.modrinth };
    return settings;
}

updateApiHeaders();

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        frame: false,
        titleBarStyle: 'hidden',
        icon: path.join(__dirname, 'icon.svg'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

const normalizeName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

// FILE SYSTEM & MODPACK HANDLERS

const globalCachePath = path.join(app.getPath('userData'), 'global-packs.json');

ipcMain.handle('get-global-packs', async () => {
    if (await fs.pathExists(globalCachePath)) return await fs.readJson(globalCachePath);
    return [];
});

ipcMain.handle('save-global-packs', async (event, packs) => {
    await fs.outputJson(globalCachePath, packs, { spaces: 4 });
    return { success: true };
});

ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled) return null;
    return result.filePaths[0];
});

ipcMain.handle('select-metadata-file', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'JSON Metadata', extensions: ['json'] }]
    });
    if (result.canceled) return null;
    return result.filePaths[0];
});

ipcMain.handle('save-pack-metadata', async (event, { packPath, metadata }) => {
    try {
        const metaFilePath = path.join(packPath, 'pack-metadata.json');
        await fs.outputJson(metaFilePath, metadata, { spaces: 4 });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('load-pack-metadata', async (event, packPath) => {
    try {
        const metaFilePath = path.join(packPath, 'pack-metadata.json');
        if (await fs.pathExists(metaFilePath)) {
            const data = await fs.readJson(metaFilePath);
            return { success: true, metadata: data };
        }
        return { success: false, error: "Metadata file not found." };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('remove-mod-files', async (event, { packPath, files }) => {
    try {
        if (!files) return { success: false, error: "No files specified" };

        const cfPath = path.join(packPath, 'curseforge', 'mods', files.curseforge);
        const mrPath = path.join(packPath, 'modrinth', 'mods', files.modrinth);

        if (await fs.pathExists(cfPath)) await fs.remove(cfPath);
        if (await fs.pathExists(mrPath)) await fs.remove(mrPath);
        
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// FETCH & DOWNLOAD HANDLERS

ipcMain.handle('search-mods', async (event, { query, version, loader, page }) => {
    try {
        const cfLoaderId = loader === 'fabric' ? 4 : 6;
        const mrFacets = `[["versions:${version}"],["categories:${loader}"]]`;

        const [cfRes, mrRes] = await Promise.all([
            axios.get(`${CF_API}/mods/search`, {
                headers: CF_HEADERS,
                params: { 
                    gameId: 432, 
                    searchFilter: query, 
                    gameVersion: version, 
                    modLoaderType: cfLoaderId,
                    sortField: 2,
                    sortOrder: 'desc',
                    pageSize: 50 
                }
            }),
            axios.get(`${MR_API}/search`, {
                headers: MR_HEADERS,
                params: { 
                    query: query, 
                    facets: mrFacets, 
                    limit: 50,
                    index: "downloads" 
                }
            })
        ]);

        const cfMods = cfRes.data.data;
        const mrMods = mrRes.data.hits;

        const matchedPairs = [];
        for (const cfMod of cfMods) {
            const normalizedCfName = normalizeName(cfMod.name);
            const cfSlug = cfMod.slug;

            const mrMatch = mrMods.find(mr => 
                mr.slug === cfSlug || 
                normalizeName(mr.title) === normalizedCfName
            );

            if (mrMatch) {
                matchedPairs.push({ cfMod, mrMatch });
            }
        }

        const versionPromises = matchedPairs.map(async ({ cfMod, mrMatch }) => {
            try {
                const mrVersionsRes = await axios.get(`${MR_API}/project/${mrMatch.project_id}/version`, {
                    headers: MR_HEADERS,
                    params: { loaders: `["${loader}"]`, game_versions: `["${version}"]` }
                });
                
                const mrVersionData = mrVersionsRes.data[0];
                
                const cfLoaderName = loader.toLowerCase() === 'neoforge' ? 'NeoForge' : 'Fabric';
                
                const cfLatestFile = cfMod.latestFiles.find(f => 
                    f.gameVersions.includes(version) && 
                    f.gameVersions.some(v => v.toLowerCase() === cfLoaderName.toLowerCase())
                );

                if (mrVersionData && cfLatestFile && cfLatestFile.downloadUrl) {
                    return {
                        ids: { curseforge: cfMod.id, modrinth: mrMatch.project_id },
                        names: { curseforge: cfMod.name, modrinth: mrMatch.title },
                        installedFiles: { curseforge: cfLatestFile.fileName, modrinth: mrVersionData.files[0].filename },
                        links: {
                            curseforge: cfMod.links.websiteUrl,
                            modrinth: `https://modrinth.com/mod/${mrMatch.slug}`
                        },
                        icons: {
                            curseforge: cfMod.logo ? cfMod.logo.thumbnailUrl : '',
                            modrinth: mrMatch.icon_url
                        },
                        summary: cfMod.summary || mrMatch.description || 'No description available.',
                        fileLinks: {
                            curseforge: cfLatestFile.downloadUrl,
                            modrinth: mrVersionData.files[0].url
                        }
                    };
                }
            } catch (err) {
                console.error(`Failed fetching version data for ${mrMatch.title}`, err.message);
                return null;
            }
            return null;
        });

        const resolvedIntersections = await Promise.all(versionPromises);
        
        const intersections = resolvedIntersections.filter(mod => mod !== null);

        const limit = 10;
        const startIndex = (page - 1) * limit;
        const paginated = intersections.slice(startIndex, startIndex + limit);

        return { mods: paginated, totalPages: Math.ceil(intersections.length / limit) };
    } catch (error) {
        console.error("API Error:", error.message);
        const errorMsg = error.response ? `API Error: Status ${error.response.status}` : error.message;
        return { mods: [], totalPages: 0, error: errorMsg };
    }
});

ipcMain.handle('download-mod', async (event, { mod, packPath }) => {
    const cfTargetDir = packPath 
        ? path.join(packPath, 'curseforge', 'mods') 
        : path.join(app.getPath('userData'), 'global_mods', 'curseforge');
        
    const mrTargetDir = packPath 
        ? path.join(packPath, 'modrinth', 'mods') 
        : path.join(app.getPath('userData'), 'global_mods', 'modrinth');
    
    await fs.ensureDir(cfTargetDir);
    await fs.ensureDir(mrTargetDir);

    const downloadFile = async (url, dest) => {
        const response = await axios({ url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(dest);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    };

    try {
        await downloadFile(mod.fileLinks.curseforge, path.join(cfTargetDir, mod.installedFiles.curseforge));
        await downloadFile(mod.fileLinks.modrinth, path.join(mrTargetDir, mod.installedFiles.modrinth));
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-versions', async () => {
    try {
        const mrRes = await axios.get(`${MR_API}/tag/game_version`);
        const mrVersions = mrRes.data.filter(v => v.version_type === 'release').map(v => v.version);

        const cfRes = await axios.get(`${CF_API}/minecraft/version`, { headers: CF_HEADERS });
        const cfVersions = cfRes.data.data.map(v => v.versionString);

        let finalVersions = mrVersions.filter(v => cfVersions.includes(v));
        if (finalVersions.length === 0) finalVersions = mrVersions;

        finalVersions.sort((a, b) => {
            const partsA = a.split('.').map(Number);
            const partsB = b.split('.').map(Number);
            for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
                const numA = partsA[i] || 0;
                const numB = partsB[i] || 0;
                if (numA !== numB) return numB - numA;
            }
            return 0;
        });
        return { success: true, versions: finalVersions };
    } catch (error) {
        return { success: false, error: "Failed to parse versions from APIs." };
    }
});

ipcMain.handle('check-mod-updates', async (event, { mods, version, loader }) => {
    const updates = {};
    
    const cfLoaderName = loader.toLowerCase() === 'neoforge' ? 'NeoForge' : 'Fabric';

    const checkPromises = mods.map(async (mod) => {
        try {
            let cfFile = null, mrFile = null;
            let hasUpdate = false;

            if (mod.ids.modrinth) {
                const mrRes = await axios.get(`${MR_API}/project/${mod.ids.modrinth}/version`, {
                    headers: MR_HEADERS,
                    params: { loaders: `["${loader}"]`, game_versions: `["${version}"]` }
                });
                if (mrRes.data && mrRes.data.length > 0) {
                    mrFile = mrRes.data[0];
                    if (mrFile.files[0].filename !== mod.installedFiles.modrinth) hasUpdate = true;
                }
            }

            if (mod.ids.curseforge) {
                const cfRes = await axios.get(`${CF_API}/mods/${mod.ids.curseforge}`, { headers: CF_HEADERS });
                const latestFiles = cfRes.data.data.latestFiles;
                
                const validFile = latestFiles.find(f => 
                    f.gameVersions.includes(version) && 
                    (f.gameVersions.includes(cfLoaderName) || f.gameVersions.includes(cfLoaderName.toLowerCase()))
                );
                if (validFile) {
                    cfFile = validFile;
                    if (cfFile.fileName !== mod.installedFiles.curseforge) hasUpdate = true;
                }
            }

            if (hasUpdate && cfFile && mrFile) {
                updates[mod.ids.curseforge] = {
                    installedFiles: { curseforge: cfFile.fileName, modrinth: mrFile.files[0].filename },
                    fileLinks: { curseforge: cfFile.downloadUrl, modrinth: mrFile.files[0].url }
                };
            }
        } catch (err) {
            console.error(`Update check failed for ${mod.names.curseforge}`, err.message);
        }
    });

    await Promise.all(checkPromises);
    return { success: true, updates };
});

ipcMain.on('window-min', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
});

ipcMain.on('window-max', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
    }
});

ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
});

ipcMain.handle('get-api-keys', async () => {
    return await updateApiHeaders();
});

ipcMain.handle('save-api-keys', async (event, keys) => {
    try {
        await fs.outputJson(settingsPath, keys, { spaces: 4 });
        await updateApiHeaders();
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});