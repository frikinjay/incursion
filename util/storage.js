const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { app } = require('electron');

const globalCachePath = path.join(app.getPath('userData'), 'global-packs.json');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

module.exports = {
    getGlobalPacks: async () => {
        if (await fs.pathExists(globalCachePath)) return await fs.readJson(globalCachePath);
        return [];
    },

    saveGlobalPacks: async (packs) => {
        await fs.outputJson(globalCachePath, packs, { spaces: 4 });
        return { success: true };
    },

    savePackMetadata: async (packPath, metadata) => {
        try {
            const metaFilePath = path.join(packPath, 'pack-metadata.json');
            await fs.outputJson(metaFilePath, metadata, { spaces: 4 });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    loadPackMetadata: async (packPath) => {
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
    },

    removeModFiles: async (packPath, files) => {
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
    },

    downloadModFiles: async (mod, packPath) => {
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
    },

    getSettings: async () => {
        if (await fs.pathExists(settingsPath)) return await fs.readJson(settingsPath);
        return {};
    },

    saveSettings: async (keys) => {
        await fs.outputJson(settingsPath, keys, { spaces: 4 });
        return { success: true };
    }
};