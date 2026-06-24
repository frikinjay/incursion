require('dotenv').config();
const axios = require('axios');
const storage = require('./storage');

const CF_API = 'https://api.curseforge.com/v1';
const MR_API = 'https://api.modrinth.com/v2';

let CF_HEADERS = {};
let MR_HEADERS = {};

const normalizeName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const apiUtils = {
    updateApiHeaders: async () => {
        let settings = { curseforge: process.env.CURSEFORGE_API_KEY || '', modrinth: process.env.MODRINTH_API_KEY || '' };
        const saved = await storage.getSettings();
        settings = { ...settings, ...saved };
        
        CF_HEADERS = { 'x-api-key': settings.curseforge };
        MR_HEADERS = { 'Authorization': settings.modrinth };
        return settings;
    },

    getVersions: async () => {
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
    },

    searchMods: async ({ query, version, loader, page }) => {
        try {
            const cfLoaderId = loader === 'fabric' ? 4 : 6;
            const mrFacets = `[["versions:${version}"],["categories:${loader}"]]`;

            const [cfRes, mrRes] = await Promise.all([
                axios.get(`${CF_API}/mods/search`, {
                    headers: CF_HEADERS,
                    params: { gameId: 432, searchFilter: query, gameVersion: version, modLoaderType: cfLoaderId, sortOrder: 'desc', pageSize: 50 }
                }),
                axios.get(`${MR_API}/search`, {
                    headers: MR_HEADERS,
                    params: { query: query, facets: mrFacets, limit: 50, index: "relevance" }
                })
            ]);

            const matchedPairs = [];
            for (const cfMod of cfRes.data.data) {
                const normalizedCfName = normalizeName(cfMod.name);
                const mrMatch = mrRes.data.hits.find(mr => mr.slug === cfMod.slug || normalizeName(mr.title) === normalizedCfName);
                if (mrMatch) matchedPairs.push({ cfMod, mrMatch });
            }

            const versionPromises = matchedPairs.map(async ({ cfMod, mrMatch }) => {
                try {
                    const mrVersionsRes = await axios.get(`${MR_API}/project/${mrMatch.project_id}/version`, {
                        headers: MR_HEADERS,
                        params: { loaders: `["${loader}"]`, game_versions: `["${version}"]` }
                    });
                    
                    const mrVersionData = mrVersionsRes.data[0];
                    const targetFileIndex = cfMod.latestFilesIndexes.find(idx => idx.gameVersion === version && idx.modLoader === cfLoaderId);
                    let cfLatestFile = null;

                    if (targetFileIndex) {
                        cfLatestFile = cfMod.latestFiles.find(f => f.id === targetFileIndex.fileId);
                        if (!cfLatestFile) {
                            try {
                                const cfFileRes = await axios.get(`${CF_API}/mods/${cfMod.id}/files/${targetFileIndex.fileId}`, { headers: CF_HEADERS });
                                cfLatestFile = cfFileRes.data.data;
                            } catch (err) {}
                        }
                    }

                    if (mrVersionData && cfLatestFile && cfLatestFile.downloadUrl) {
                        return {
                            ids: { curseforge: cfMod.id, modrinth: mrMatch.project_id },
                            names: { curseforge: cfMod.name, modrinth: mrMatch.title },
                            installedFiles: { curseforge: cfLatestFile.fileName, modrinth: mrVersionData.files[0].filename },
                            links: { curseforge: cfMod.links.websiteUrl, modrinth: `https://modrinth.com/mod/${mrMatch.slug}` },
                            icons: { curseforge: cfMod.logo ? cfMod.logo.thumbnailUrl : '', modrinth: mrMatch.icon_url },
                            summary: cfMod.summary || mrMatch.description || 'No description available.',
                            fileLinks: { curseforge: cfLatestFile.downloadUrl, modrinth: mrVersionData.files[0].url }
                        };
                    }
                } catch (err) { return null; }
                return null;
            });

            const resolvedIntersections = await Promise.all(versionPromises);
            const intersections = resolvedIntersections.filter(mod => mod !== null);

            const limit = 10;
            const startIndex = (page - 1) * limit;
            const paginated = intersections.slice(startIndex, startIndex + limit);

            return { mods: paginated, totalPages: Math.ceil(intersections.length / limit) };
        } catch (error) {
            return { mods: [], totalPages: 0, error: error.message };
        }
    },

    checkModUpdates: async ({ mods, version, loader }) => {
        const updates = {};
        let cfLoaderId = 1;
        if (loader.toLowerCase() === 'fabric') cfLoaderId = 4;
        if (loader.toLowerCase() === 'neoforge') cfLoaderId = 6;

        const checkPromises = mods.map(async (mod) => {
            try {
                let cfFile = null, mrFile = null;
                let cfNeedsUpdate = false, mrNeedsUpdate = false;

                if (mod.ids.modrinth) {
                    const mrRes = await axios.get(`${MR_API}/project/${mod.ids.modrinth}/version`, {
                        headers: MR_HEADERS,
                        params: { loaders: `["${loader}"]`, game_versions: `["${version}"]` }
                    });
                    if (mrRes.data && mrRes.data.length > 0) {
                        mrFile = mrRes.data[0];
                        if (mrFile.files[0].filename !== mod.installedFiles.modrinth) mrNeedsUpdate = true;
                    }
                }

                if (mod.ids.curseforge) {
                    const cfRes = await axios.get(`${CF_API}/mods/${mod.ids.curseforge}`, { headers: CF_HEADERS });
                    const cfMod = cfRes.data.data;
                    const targetIndex = cfMod.latestFilesIndexes.find(idx => idx.gameVersion === version && idx.modLoader === cfLoaderId);

                    if (targetIndex) {
                        if (targetIndex.filename !== mod.installedFiles.curseforge) {
                            cfNeedsUpdate = true;
                            cfFile = cfMod.latestFiles.find(f => f.id === targetIndex.fileId);
                            if (!cfFile) {
                                try {
                                    const fileRes = await axios.get(`${CF_API}/mods/${mod.ids.curseforge}/files/${targetIndex.fileId}`, { headers: CF_HEADERS });
                                    cfFile = fileRes.data.data;
                                } catch (err) {}
                            }
                        } else {
                            cfFile = { fileName: mod.installedFiles.curseforge, downloadUrl: mod.fileLinks.curseforge };
                        }
                    }
                }

                if ((cfNeedsUpdate || mrNeedsUpdate) && cfFile && cfFile.downloadUrl && mrFile) {
                    updates[mod.ids.curseforge] = {
                        installedFiles: { curseforge: cfFile.fileName || cfFile.filename, modrinth: mrFile.files[0].filename },
                        fileLinks: { curseforge: cfFile.downloadUrl, modrinth: mrFile.files[0].url }
                    };
                }
            } catch (err) {}
        });

        await Promise.all(checkPromises);
        return { success: true, updates };
    }
};

module.exports = apiUtils;