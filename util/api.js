require('dotenv').config();
const axios = require('axios');
const storage = require('./storage');

const CF_API = 'https://api.curseforge.com/v1';
const MR_API = 'https://api.modrinth.com/v2';

let CF_HEADERS = {};
let MR_HEADERS = {};
let searchSessionCache = { query: null, version: null, loader: null, results: [] };

let apiMemoryCache = null;
let saveCacheTimeout = null;

const normalizeName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

async function fetchWithCache(cacheKey, requestFn) {
    if (!apiMemoryCache) {
        apiMemoryCache = await storage.getApiCache();
    }

    const oneDayInMs = 24 * 60 * 60 * 1000;

    if (apiMemoryCache[cacheKey] && (Date.now() - apiMemoryCache[cacheKey].timestamp < oneDayInMs)) {
        return apiMemoryCache[cacheKey].data;
    }

    const data = await requestFn();
    apiMemoryCache[cacheKey] = { timestamp: Date.now(), data: data };
    
    if (saveCacheTimeout) clearTimeout(saveCacheTimeout);
    saveCacheTimeout = setTimeout(async () => {
        await storage.saveApiCache(apiMemoryCache);
    }, 1500); 
    
    return data;
}

const apiUtils = {
    updateApiHeaders: async () => {
        let settings = { curseforge: process.env.CURSEFORGE_API_KEY || '', modrinth: process.env.MODRINTH_API_KEY || '' };
        const saved = await storage.getSettings();
        settings = { ...settings, ...saved };
        
        CF_HEADERS = { 'x-api-key': settings.curseforge, 'Content-Type': 'application/json', 'Accept': 'application/json' };
        MR_HEADERS = { 'Authorization': settings.modrinth };
        return settings;
    },

    getVersions: async () => {
        try {
            return await fetchWithCache('minecraft_versions', async () => {
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
            });
        } catch (error) {
            return { success: false, error: "Failed to parse versions from APIs." };
        }
    },

    searchMods: async ({ query, version, loader, page }) => {
        try {
            const limit = 10;
            const startIndex = (page - 1) * limit;

            if (searchSessionCache.query === query && searchSessionCache.version === version && searchSessionCache.loader === loader) {
                const paginated = searchSessionCache.results.slice(startIndex, startIndex + limit);
                return { mods: paginated, totalPages: Math.ceil(searchSessionCache.results.length / limit) };
            }

            const cfLoaderId = loader === 'fabric' ? 4 : 6;
            const mrFacets = `[["versions:${version}"],["categories:${loader}"]]`;
            
            const cacheKeyCF = `search_cf_${query}_${version}_${cfLoaderId}`;
            const cacheKeyMR = `search_mr_${query}_${version}_${loader}`;

            const [cfData, mrData] = await Promise.all([
                fetchWithCache(cacheKeyCF, async () => {
                    const res = await axios.get(`${CF_API}/mods/search`, {
                        headers: CF_HEADERS,
                        params: { gameId: 432, searchFilter: query, gameVersion: version, modLoaderType: cfLoaderId, sortOrder: 'desc', pageSize: 50 }
                    });
                    return res.data.data;
                }),
                fetchWithCache(cacheKeyMR, async () => {
                    const res = await axios.get(`${MR_API}/search`, {
                        headers: MR_HEADERS,
                        params: { query: query, facets: mrFacets, limit: 50, index: "relevance" }
                    });
                    return res.data.hits;
                })
            ]);

            const matchedPairs = [];
            for (const cfMod of cfData) {
                const normalizedCfName = normalizeName(cfMod.name);
                const mrMatch = mrData.find(mr => mr.slug === cfMod.slug || normalizeName(mr.title) === normalizedCfName);
                if (mrMatch) matchedPairs.push({ cfMod, mrMatch });
            }

            const versionPromises = matchedPairs.map(async ({ cfMod, mrMatch }) => {
                try {
                    const mrVerKey = `mr_ver_${mrMatch.project_id}_${version}_${loader}`;
                    const mrVersionDataArray = await fetchWithCache(mrVerKey, async () => {
                        const res = await axios.get(`${MR_API}/project/${mrMatch.project_id}/version`, {
                            headers: MR_HEADERS,
                            params: { loaders: `["${loader}"]`, game_versions: `["${version}"]` }
                        });
                        return res.data;
                    });
                    
                    const mrVersionData = mrVersionDataArray[0];
                    const targetFileIndex = cfMod.latestFilesIndexes.find(idx => idx.gameVersion === version && idx.modLoader === cfLoaderId);
                    let cfLatestFile = null;

                    if (targetFileIndex) {
                        cfLatestFile = cfMod.latestFiles.find(f => f.id === targetFileIndex.fileId);
                        if (!cfLatestFile) {
                            const cfFileKey = `cf_file_${cfMod.id}_${targetFileIndex.fileId}`;
                            cfLatestFile = await fetchWithCache(cfFileKey, async () => {
                                const res = await axios.get(`${CF_API}/mods/${cfMod.id}/files/${targetFileIndex.fileId}`, { headers: CF_HEADERS });
                                return res.data.data;
                            });
                        }
                    }

                    if (mrVersionData && cfLatestFile && cfLatestFile.downloadUrl) {
                        return {
                            ids: { curseforge: cfMod.id, modrinth: mrMatch.project_id },
                            names: { curseforge: cfMod.name, modrinth: mrMatch.title },
                            authors: { 
                                curseforge: cfMod.authors && cfMod.authors.length > 0 ? cfMod.authors[0].name : 'Unknown', 
                                modrinth: mrMatch.author || 'Unknown' 
                            },
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

            searchSessionCache = { query, version, loader, results: intersections };

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

        const cfIds = mods.map(m => m.ids.curseforge).filter(Boolean);
        const mrIds = mods.map(m => m.ids.modrinth).filter(Boolean);

        let cfBulkData = [];
        let mrBulkData = [];

        try {
            if (cfIds.length > 0) {
                const cacheKeyCFBulk = `update_cf_bulk_${cfIds.join('_')}`;
                cfBulkData = await fetchWithCache(cacheKeyCFBulk, async () => {
                    const res = await axios.post(`${CF_API}/mods`, { modIds: cfIds }, { headers: CF_HEADERS });
                    return res.data.data;
                });
            }

            if (mrIds.length > 0) {
                const cacheKeyMRBulk = `update_mr_bulk_${mrIds.join('_')}_${version}_${loader}`;
                mrBulkData = await fetchWithCache(cacheKeyMRBulk, async () => {
                    const res = await axios.get(`${MR_API}/versions`, {
                        headers: MR_HEADERS,
                        params: { project_ids: JSON.stringify(mrIds), loaders: JSON.stringify([loader.toLowerCase()]), game_versions: JSON.stringify([version]) }
                    });
                    return res.data;
                });
            }

            for (const mod of mods) {
                let cfFile = null, mrFile = null;
                let cfNeedsUpdate = false, mrNeedsUpdate = false;

                if (mod.ids.modrinth) {
                    const projectVersions = mrBulkData.filter(v => v.project_id === mod.ids.modrinth);
                    if (projectVersions.length > 0) {
                        mrFile = projectVersions[0];
                        if (mrFile.files[0].filename !== mod.installedFiles.modrinth) mrNeedsUpdate = true;
                    }
                }

                if (mod.ids.curseforge) {
                    const cfMod = cfBulkData.find(m => m.id === mod.ids.curseforge);
                    if (cfMod) {
                        const targetIndex = cfMod.latestFilesIndexes.find(idx => idx.gameVersion === version && idx.modLoader === cfLoaderId);

                        if (targetIndex) {
                            if (targetIndex.filename !== mod.installedFiles.curseforge) {
                                cfNeedsUpdate = true;
                                cfFile = cfMod.latestFiles.find(f => f.id === targetIndex.fileId);
                                
                                if (!cfFile) {
                                    const cfFileKey = `cf_file_${cfMod.id}_${targetIndex.fileId}`;
                                    cfFile = await fetchWithCache(cfFileKey, async () => {
                                        const fileRes = await axios.get(`${CF_API}/mods/${mod.ids.curseforge}/files/${targetIndex.fileId}`, { headers: CF_HEADERS });
                                        return fileRes.data.data;
                                    });
                                }
                            } else {
                                cfFile = { fileName: mod.installedFiles.curseforge, downloadUrl: mod.fileLinks.curseforge };
                            }
                        }
                    }
                }

                if ((cfNeedsUpdate || mrNeedsUpdate) && cfFile && cfFile.downloadUrl && mrFile) {
                    updates[mod.ids.curseforge] = {
                        installedFiles: { curseforge: cfFile.fileName || cfFile.filename, modrinth: mrFile.files[0].filename },
                        fileLinks: { curseforge: cfFile.downloadUrl, modrinth: mrFile.files[0].url }
                    };
                }
            }
        } catch (err) {
            console.error("Bulk update check failed:", err.message);
        }

        return { success: true, updates };
    },

    syncMetadata: async ({ mods }) => {
        try {
            const cfIds = mods.map(m => m.ids.curseforge).filter(Boolean);
            let cfBulkData = [];
            
            if (cfIds.length > 0) {
                const cacheKeyCFBulk = `sync_cf_bulk_${cfIds.join('_')}`;
                cfBulkData = await fetchWithCache(cacheKeyCFBulk, async () => {
                    const res = await axios.post(`${CF_API}/mods`, { modIds: cfIds }, { headers: CF_HEADERS });
                    return res.data.data;
                });
            }

            const updatedMods = [];
            
            for (const mod of mods) {
                if (!mod.authors) mod.authors = { curseforge: 'Unknown', modrinth: 'Unknown' };

                if (mod.authors.curseforge === 'Unknown' && mod.ids.curseforge) {
                    const cfMod = cfBulkData.find(m => m.id === mod.ids.curseforge);
                    if (cfMod && cfMod.authors && cfMod.authors.length > 0) {
                        mod.authors.curseforge = cfMod.authors[0].name;
                    }
                }

                if (mod.authors.modrinth === 'Unknown' && mod.ids.modrinth) {
                    try {
                        const mrVerKey = `mr_author_${mod.ids.modrinth}`;
                        const authorName = await fetchWithCache(mrVerKey, async () => {
                            const mrRes = await axios.get(`${MR_API}/search`, {
                                headers: MR_HEADERS,
                                params: { facets: `[["project_id:${mod.ids.modrinth}"]]`, limit: 1 }
                            });
                            return mrRes.data.hits.length > 0 ? mrRes.data.hits[0].author : 'Unknown';
                        });
                        mod.authors.modrinth = authorName;
                    } catch (err) {}
                }
                
                updatedMods.push(mod);
            }

            return { success: true, mods: updatedMods };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
};

module.exports = apiUtils;