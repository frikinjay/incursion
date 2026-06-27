const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const archiver = require('archiver');
const crypto = require('crypto');
const { app } = require('electron');

const globalCachePath = path.join(app.getPath('userData'), 'global-packs.json');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const versionsCachePath = path.join(app.getPath('userData'), 'versions-cache.json'); 
const apiCachePath = path.join(app.getPath('userData'), 'api-cache.json');
const loaderVersionsCachePath = path.join(app.getPath('userData'), 'loader-versions-cache.json');

module.exports = {
    // --- CACHING ---
    getVersionsCache: async () => { if (await fs.pathExists(versionsCachePath)) return await fs.readJson(versionsCachePath); return null; },
    saveVersionsCache: async (versions) => { await fs.outputJson(versionsCachePath, { timestamp: Date.now(), versions }, { spaces: 4 }); },
    getLoaderVersionsCache: async () => { if (await fs.pathExists(loaderVersionsCachePath)) return await fs.readJson(loaderVersionsCachePath); return {}; },
    saveLoaderVersionsCache: async (cache) => { await fs.outputJson(loaderVersionsCachePath, cache, { spaces: 4 }); },
    getApiCache: async () => { if (await fs.pathExists(apiCachePath)) return await fs.readJson(apiCachePath); return {}; },
    saveApiCache: async (cacheData) => { await fs.outputJson(apiCachePath, cacheData, { spaces: 4 }); },
    clearApiCache: async () => { if (await fs.pathExists(apiCachePath)) await fs.remove(apiCachePath); return { success: true }; },

    getSettings: async () => { if (await fs.pathExists(settingsPath)) return await fs.readJson(settingsPath); return {}; },
    saveSettings: async (keys) => { await fs.outputJson(settingsPath, keys, { spaces: 4 }); return { success: true }; },

    // --- PACK MANAGEMENT ---
    getGlobalPacks: async () => { if (await fs.pathExists(globalCachePath)) return await fs.readJson(globalCachePath); return []; },
    saveGlobalPacks: async (packs) => { await fs.outputJson(globalCachePath, packs, { spaces: 4 }); return { success: true }; },
    
    savePackMetadata: async (packPath, metadata) => {
        try {
            const metaFilePath = path.join(packPath, 'pack-metadata.json');
            await fs.outputJson(metaFilePath, metadata, { spaces: 4 });
            return { success: true };
        } catch (error) { return { success: false, error: error.message }; }
    },
    
    loadPackMetadata: async (packPath) => {
        try {
            const metaFilePath = path.join(packPath, 'pack-metadata.json');
            if (await fs.pathExists(metaFilePath)) {
                const data = await fs.readJson(metaFilePath);
                return { success: true, metadata: data };
            }
            return { success: false, error: "Metadata file not found." };
        } catch (error) { return { success: false, error: error.message }; }
    },

    // --- UPDATE CACHE ---
    savePendingUpdates: async (packPath, updates) => {
        try {
            const cachePath = path.join(packPath, 'pending_updates.json');
            await fs.outputJson(cachePath, updates, { spaces: 4 });
            return { success: true };
        } catch (error) { return { success: false, error: error.message }; }
    },

    loadPendingUpdates: async (packPath) => {
        try {
            const cachePath = path.join(packPath, 'pending_updates.json');
            if (await fs.pathExists(cachePath)) {
                const data = await fs.readJson(cachePath);
                return { success: true, updates: data };
            }
            return { success: true, updates: {} };
        } catch (error) { return { success: false, error: error.message, updates: {} }; }
    },

    removeModFiles: async (packPath, files) => {
        try {
            if (!files) return { success: false, error: "No files specified" };
            if (files.curseforge) {
                const cfPath = path.join(packPath, 'curseforge', 'mods', files.curseforge);
                if (await fs.pathExists(cfPath)) await fs.remove(cfPath);
            }
            if (files.modrinth) {
                const mrPath = path.join(packPath, 'modrinth', 'mods', files.modrinth);
                if (await fs.pathExists(mrPath)) await fs.remove(mrPath);
            }
            return { success: true };
        } catch (error) { return { success: false, error: error.message }; }
    },

    downloadModFiles: async (mod, packPath) => {
        const cfTargetDir = packPath ? path.join(packPath, 'curseforge', 'mods') : path.join(app.getPath('userData'), 'global_mods', 'curseforge');
        const mrTargetDir = packPath ? path.join(packPath, 'modrinth', 'mods') : path.join(app.getPath('userData'), 'global_mods', 'modrinth');
        
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
            if (mod.fileLinks.curseforge) await downloadFile(mod.fileLinks.curseforge, path.join(cfTargetDir, mod.installedFiles.curseforge));
            if (mod.fileLinks.modrinth) await downloadFile(mod.fileLinks.modrinth, path.join(mrTargetDir, mod.installedFiles.modrinth));
            return { success: true };
        } catch (error) { return { success: false, error: error.message }; }
    },

    // --- PACK EXPORTERS ---
    exportCurseForgePack: async (metadata, exportDir) => {
        const safeName = metadata.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const zipName = `${safeName}-${metadata.version || '1.0.0'}.zip`;
        const finalPath = path.join(exportDir, zipName);
    
        const settings = await module.exports.getSettings();
        const cfHeaders = { 'x-api-key': settings.curseforge, 'Content-Type': 'application/json', 'Accept': 'application/json' };
        const cfMods = metadata.mods.filter(m => m.ids.curseforge);
    
        for (const m of cfMods) {
            if (!m.meta?.cfFileId && m.ids.curseforge) {
                try {
                    const gameVersion = metadata.gameVersion || '1.21.1';
                    const loaderMap = { fabric: 4, neoforge: 6 };
                    const cfLoaderId = loaderMap[metadata.loader?.toLowerCase()] || 4; 
                    
                    const res = await axios.get(`https://api.curseforge.com/v1/mods/${m.ids.curseforge}`, { headers: cfHeaders });
                    const cfMod = res.data.data;
                    const targetIndex = cfMod.latestFilesIndexes.find(idx => idx.gameVersion === gameVersion && idx.modLoader === cfLoaderId);
                    if (targetIndex) {
                        if (!m.meta) m.meta = {};
                        m.meta.cfFileId = targetIndex.fileId;
                    }
                } catch (err) { }
            }
        }
    
        const manifest = {
            minecraft: {
                version: metadata.gameVersion || "1.21.1",
                modLoaders: [{ id: `${metadata.loader}-${metadata.loaderVersion || 'latest'}`, primary: true }]
            },
            manifestType: "minecraftModpack",
            manifestVersion: 1,
            name: metadata.name,
            version: metadata.version || "1.0.0",
            author: metadata.author || "",
            overrides: "overrides",
            files: cfMods.map(m => ({
                projectID: parseInt(m.ids.curseforge),
                fileID: parseInt(m.meta?.cfFileId),
                required: true,
                isLocked: false
            }))
        };

        let htmlContent = `<ul>\n`;
        metadata.mods.filter(m => m.ids.curseforge).forEach(m => {
            htmlContent += `<li><a href="${m.links.curseforge}">${m.names.curseforge} (by ${m.authors.curseforge || 'Unknown'})</a></li>\n`;
        });
        htmlContent += `</ul>`;

        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(finalPath);
            const archive = archiver('zip', { zlib: { level: 9 } });
            
            output.on('close', () => resolve({ success: true, path: finalPath }));
            archive.on('error', err => reject(err));
            archive.pipe(output);

            archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
            archive.append(htmlContent, { name: 'modlist.html' });
            
            if (metadata.icon && metadata.icon.startsWith('data:image')) {
                const base64Data = metadata.icon.replace(/^data:image\/\w+;base64,/, "");
                archive.append(Buffer.from(base64Data, 'base64'), { name: 'overrides/pack-icon.png' });
            }
            
            archive.finalize();
        });
    },

    exportModrinthPack: async (metadata, exportDir) => {
        const safeName = metadata.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const packName = `${safeName}-${metadata.version || '1.0.0'}.mrpack`;
        const finalPath = path.join(exportDir, packName);

        const mrIndex = {
            formatVersion: 1,
            game: "minecraft",
            versionId: metadata.version || "1.0.0",
            name: metadata.name,
            summary: metadata.description || "",
            dependencies: {
                "minecraft": metadata.gameVersion || "1.21.1",
                [metadata.loader]: metadata.loaderVersion || "latest"
            },
            files: []
        };

        for (const mod of metadata.mods.filter(m => m.ids.modrinth)) {
            const modPath = path.join(metadata.path, 'modrinth', 'mods', mod.installedFiles.modrinth);
            if (await fs.pathExists(modPath)) {
                const env = mod.environments?.modrinth || { client: true, server: true };
                
                mrIndex.files.push({
                    path: `mods/${mod.installedFiles.modrinth}`,
                    hashes: await module.exports.getFileHashes(modPath),
                    env: {
                        client: env.client ? "required" : "unsupported",
                        server: env.server ? "required" : "unsupported"
                    },
                    downloads: [mod.fileLinks.modrinth],
                    fileSize: (await fs.stat(modPath)).size
                });
            }
        }

        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(finalPath);
            const archive = archiver('zip', { zlib: { level: 9 } });
            output.on('close', () => resolve({ success: true, path: finalPath }));
            archive.on('error', err => reject(err));
            archive.pipe(output);
            archive.append(JSON.stringify(mrIndex, null, 2), { name: 'modrinth.index.json' });
            archive.finalize();
        });
    },

    getFileHashes: async (filePath) => {
        const fileBuffer = await fs.readFile(filePath);
        return {
            sha1: crypto.createHash('sha1').update(fileBuffer).digest('hex'),
            sha512: crypto.createHash('sha512').update(fileBuffer).digest('hex')
        };
    }
};