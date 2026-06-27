require('dotenv').config();
const axios = require('axios');
const storage = require('./storage');

const CF_API = 'https://api.curseforge.com/v1';
const MR_API = 'https://api.modrinth.com/v2';

let CF_HEADERS = {};
let MR_HEADERS = {};
let searchSessionCache = { query: null, version: null, loader: null, platform: null, results: [] };

let apiMemoryCache = null;
let saveCacheTimeout = null;

const normalizeName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

async function fetchWithCache(cacheKey, requestFn) {
    if (!apiMemoryCache) apiMemoryCache = await storage.getApiCache();
    const oneDayInMs = 24 * 60 * 60 * 1000;
    
    if (apiMemoryCache[cacheKey] && (Date.now() - apiMemoryCache[cacheKey].timestamp < oneDayInMs)) {
        return apiMemoryCache[cacheKey].data;
    }
    
    const data = await requestFn();
    apiMemoryCache[cacheKey] = { timestamp: Date.now(), data: data };
    
    if (saveCacheTimeout) clearTimeout(saveCacheTimeout);
    saveCacheTimeout = setTimeout(async () => { await storage.saveApiCache(apiMemoryCache); }, 1500); 
    
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

    clearCache: async () => {
        apiMemoryCache = null; 
        searchSessionCache = { query: null, version: null, loader: null, platform: null, results: [] };
        return await storage.clearApiCache();
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
        } catch (error) { return { success: false, error: "Failed to parse versions from APIs." }; }
    },

    getLoaderVersions: async ({ gameVersion, loader } = {}) => {
        if (!loader || (loader !== 'fabric' && loader !== 'neoforge')) return { success: false, versions: [] };
        
        try {
            const oneHourInMs = 60 * 60 * 1000;
            const cache = await storage.getLoaderVersionsCache();

            const cacheKey = `loader_versions_${loader}_${gameVersion || 'all'}`;
            if (cache[cacheKey] && (Date.now() - cache[cacheKey].timestamp < oneHourInMs)) {
                return { success: true, versions: cache[cacheKey].data };
            }

            const fetchXml = (url) => axios.get(url, { responseType: 'text', headers: { 'Accept': 'application/xml, text/xml, */*' } });

            const parseVersionsFromXml = (xml) => {
                const str = typeof xml === 'string' ? xml : String(xml);
                const matches = str.match(/<version>([^<]+)<\/version>/g) || [];
                return matches.map(m => m.replace(/<\/?version>/g, '').trim());
            };

            let versions = [];

            if (loader === 'fabric') {
                const res = await fetchXml('https://maven.fabricmc.net/net/fabricmc/fabric-loader/maven-metadata.xml');
                const all = parseVersionsFromXml(res.data);
                versions = all.filter(v => !v.includes('+build.')).reverse();
            } else if (loader === 'neoforge') {
                const res = await fetchXml('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
                const all = parseVersionsFromXml(res.data);
                
                let nfPrefix = '';
                if (gameVersion) {
                    const mcParts = gameVersion.split('.');
                    const major = parseInt(mcParts[1] || '0');
                    if (major >= 20) {
                        const minor = mcParts[2] || '0';
                        nfPrefix = `${major}.${minor}.`;
                    }
                }
                versions = all.filter(v => (!nfPrefix || v.startsWith(nfPrefix)) && !v.includes('beta') && !v.includes('alpha')).reverse();
            }

            cache[cacheKey] = { timestamp: Date.now(), data: versions };
            await storage.saveLoaderVersionsCache(cache);

            return { success: true, versions };
        } catch (error) {
            console.error('[getLoaderVersions] error:', error.message);
            return { success: false, error: error.message, versions: [] };
        }
    },

    searchMods: async ({ query, version, loader, page, platform }) => {
        try {
            const limit = 10;
            const startIndex = (page - 1) * limit;

            if (searchSessionCache.query === query && searchSessionCache.version === version && searchSessionCache.loader === loader && searchSessionCache.platform === platform) {
                const paginated = searchSessionCache.results.slice(startIndex, startIndex + limit);
                return { mods: paginated, totalPages: Math.ceil(searchSessionCache.results.length / limit) };
            }

            const cfLoaderId = loader === 'fabric' ? 4 : 6;
            const mrFacets = `[["versions:${version}"],["categories:${loader}"],["project_type:mod"]]`;
            
            let cfData = [], mrData = [];

            if (platform === 'both' || platform === 'curseforge') {
                const cacheKeyCF = `search_cf_${query}_${version}_${cfLoaderId}_mod`;
                cfData = await fetchWithCache(cacheKeyCF, async () => {
                    const res = await axios.get(`${CF_API}/mods/search`, { 
                        headers: CF_HEADERS, 
                        params: { gameId: 432, classId: 6, searchFilter: query, gameVersion: version, modLoaderType: cfLoaderId, sortOrder: 'desc', pageSize: 50 } 
                    });
                    return res.data.data;
                });
            }

            if (platform === 'both' || platform === 'modrinth') {
                const cacheKeyMR = `search_mr_${query}_${version}_${loader}_mod`;
                mrData = await fetchWithCache(cacheKeyMR, async () => {
                    const res = await axios.get(`${MR_API}/search`, { headers: MR_HEADERS, params: { query: query, facets: mrFacets, limit: 50, index: "relevance" } });
                    return res.data.hits;
                });
            }

            const matchedPairs = [];
            if (platform === 'both') {
                for (const cfMod of cfData) {
                    const normalizedCfName = normalizeName(cfMod.name);
                    const mrMatch = mrData.find(mr => mr.slug === cfMod.slug || normalizeName(mr.title) === normalizedCfName);
                    if (mrMatch) matchedPairs.push({ cfMod, mrMatch });
                }
            } else if (platform === 'curseforge') {
                for (const cfMod of cfData) matchedPairs.push({ cfMod, mrMatch: null });
            } else if (platform === 'modrinth') {
                for (const mrMatch of mrData) matchedPairs.push({ cfMod: null, mrMatch });
            }

            const versionPromises = matchedPairs.map(async ({ cfMod, mrMatch }) => {
                try {
                    let mrVersionData = null, cfLatestFile = null;

                    if (mrMatch) {
                        const mrVerKey = `mr_ver_${mrMatch.project_id}_${version}_${loader}`;
                        const mrVersionDataArray = await fetchWithCache(mrVerKey, async () => {
                            const res = await axios.get(`${MR_API}/project/${mrMatch.project_id}/version`, { headers: MR_HEADERS, params: { loaders: `["${loader}"]`, game_versions: `["${version}"]` } });
                            return res.data;
                        });
                        mrVersionData = mrVersionDataArray[0];
                    }

                    if (cfMod) {
                        const targetFileIndex = cfMod.latestFilesIndexes.find(idx => idx.gameVersion === version && idx.modLoader === cfLoaderId);
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
                    }

                    const validBoth = platform === 'both' && mrVersionData && cfLatestFile && cfLatestFile.downloadUrl;
                    const validCF = platform === 'curseforge' && cfLatestFile && cfLatestFile.downloadUrl;
                    const validMR = platform === 'modrinth' && mrVersionData;

                    if (validBoth || validCF || validMR) {
                        const cfClient = cfLatestFile && cfLatestFile.gameVersions ? cfLatestFile.gameVersions.includes('Client') : true;
                        const cfServer = cfLatestFile && cfLatestFile.gameVersions ? cfLatestFile.gameVersions.includes('Server') : true;
                        const mrClient = mrMatch ? mrMatch.client_side !== 'unsupported' : true;
                        const mrServer = mrMatch ? mrMatch.server_side !== 'unsupported' : true;

                        return {
                            ids: { curseforge: cfMod ? cfMod.id : null, modrinth: mrMatch ? mrMatch.project_id : null },
                            names: { curseforge: cfMod ? cfMod.name : null, modrinth: mrMatch ? mrMatch.title : null },
                            authors: { 
                                curseforge: cfMod && cfMod.authors && cfMod.authors.length > 0 ? cfMod.authors[0].name : null, 
                                modrinth: mrMatch ? mrMatch.author : null 
                            },
                            environments: {
                                curseforge: cfMod ? { client: cfClient, server: cfServer } : null,
                                modrinth: mrMatch ? { client: mrClient, server: mrServer } : null
                            },
                            installedFiles: { 
                                curseforge: cfLatestFile ? cfLatestFile.fileName : null, 
                                modrinth: mrVersionData ? mrVersionData.files[0].filename : null 
                            },
                            links: { 
                                curseforge: cfMod ? cfMod.links.websiteUrl : null, 
                                modrinth: mrMatch ? `https://modrinth.com/mod/${mrMatch.slug}` : null 
                            },
                            icons: { 
                                curseforge: (cfMod && cfMod.logo) ? cfMod.logo.thumbnailUrl : null, 
                                modrinth: mrMatch ? mrMatch.icon_url : null 
                            },
                            summary: (cfMod ? cfMod.summary : null) || (mrMatch ? mrMatch.description : 'No description available.'),
                            fileLinks: { 
                                curseforge: cfLatestFile ? cfLatestFile.downloadUrl : null, 
                                modrinth: mrVersionData ? mrVersionData.files[0].url : null 
                            },
                            meta: { 
                                cfFileId: cfLatestFile ? cfLatestFile.id : null,
                                mrVersionId: mrVersionData ? mrVersionData.id : null
                            }
                        };
                    }
                } catch (err) { return null; }
                return null;
            });

            const resolvedIntersections = await Promise.all(versionPromises);
            const intersections = resolvedIntersections.filter(mod => mod !== null);

            searchSessionCache = { query, version, loader, platform, results: intersections };
            const paginated = intersections.slice(startIndex, startIndex + limit);
            return { mods: paginated, totalPages: Math.ceil(intersections.length / limit) };
        } catch (error) { return { mods: [], totalPages: 0, error: error.message }; }
    },

    checkModUpdates: async ({ mods, version, loader }, onProgress) => {
        const updates = {};
        const cfLoaderId = loader.toLowerCase() === 'fabric' ? 4 : 6;

        const cfIds = mods.map(m => m.ids.curseforge).filter(Boolean);
        let cfBulkData = [];

        try {
            if (cfIds.length > 0) {
                const chunkSize = 50;
                for (let i = 0; i < cfIds.length; i += chunkSize) {
                    const chunk = cfIds.slice(i, i + chunkSize);
                    const cacheKeyCFBulk = `update_cf_bulk_${chunk.join('_')}`;
                    const chunkData = await fetchWithCache(cacheKeyCFBulk, async () => {
                        const res = await axios.post(`${CF_API}/mods`, { modIds: chunk }, { headers: CF_HEADERS });
                        return res.data.data;
                    });
                    cfBulkData = cfBulkData.concat(chunkData);
                }
            }

            for (let i = 0; i < mods.length; i++) {
                const mod = mods[i];
                let cfFile = null, mrFile = null;
                let cfNeedsUpdate = false, mrNeedsUpdate = false;

                if (mod.ids.modrinth) {
                    try {
                        const mrVerKey = `mr_update_ver_${mod.ids.modrinth}_${version}_${loader}`;
                        const projectVersions = await fetchWithCache(mrVerKey, async () => {
                            const res = await axios.get(`${MR_API}/project/${mod.ids.modrinth}/version`, { headers: MR_HEADERS, params: { loaders: `["${loader.toLowerCase()}"]`, game_versions: `["${version}"]` } });
                            return res.data;
                        });

                        if (projectVersions && projectVersions.length > 0) {
                            mrFile = projectVersions[0];
                            if (mod.meta && mod.meta.mrVersionId) {
                                if (mrFile.id !== mod.meta.mrVersionId) mrNeedsUpdate = true;
                            } else if (mrFile.files[0].filename !== mod.installedFiles.modrinth) {
                                mrNeedsUpdate = true;
                            }
                        }
                    } catch (err) {}
                }

                if (mod.ids.curseforge) {
                    const cfMod = cfBulkData.find(m => m.id === mod.ids.curseforge);
                    if (cfMod) {
                        const targetIndex = cfMod.latestFilesIndexes.find(idx => idx.gameVersion === version && idx.modLoader === cfLoaderId);
                        if (targetIndex) {
                            if (mod.meta && mod.meta.cfFileId) {
                                if (targetIndex.fileId !== mod.meta.cfFileId) cfNeedsUpdate = true;
                            } else if (targetIndex.filename !== mod.installedFiles.curseforge) {
                                cfNeedsUpdate = true;
                            }

                            if (cfNeedsUpdate) {
                                cfFile = cfMod.latestFiles.find(f => f.id === targetIndex.fileId);
                                if (!cfFile) {
                                    const cfFileKey = `cf_file_${cfMod.id}_${targetIndex.fileId}`;
                                    cfFile = await fetchWithCache(cfFileKey, async () => {
                                        const fileRes = await axios.get(`${CF_API}/mods/${cfMod.id}/files/${targetIndex.fileId}`, { headers: CF_HEADERS });
                                        return fileRes.data.data;
                                    });
                                }
                            }
                        }
                    }
                }

                if (cfNeedsUpdate || mrNeedsUpdate) {
                    const uniqueId = mod.ids.curseforge || mod.ids.modrinth; 
                    updates[uniqueId] = {
                        installedFiles: { 
                            curseforge: cfFile ? (cfFile.fileName || cfFile.filename) : null, 
                            modrinth: mrFile ? mrFile.files[0].filename : null 
                        },
                        fileLinks: { 
                            curseforge: cfFile ? cfFile.downloadUrl : null, 
                            modrinth: mrFile ? mrFile.files[0].url : null 
                        },
                        meta: { 
                            cfFileId: cfFile ? cfFile.id : (mod.meta ? mod.meta.cfFileId : null),
                            mrVersionId: mrFile ? mrFile.id : (mod.meta ? mod.meta.mrVersionId : null)
                        }
                    };
                }

                if (onProgress) onProgress(Math.round(((i + 1) / mods.length) * 100));
            }
        } catch (err) { console.error("Update check failed:", err.message); }

        return { success: true, updates };
    },

    syncMetadata: async ({ mods }) => {
        try {
            const cfIds = mods.map(m => m.ids.curseforge).filter(Boolean);
            let cfBulkData = [];
            
            if (cfIds.length > 0) {
                const chunkSize = 50;
                for (let i = 0; i < cfIds.length; i += chunkSize) {
                    const chunk = cfIds.slice(i, i + chunkSize);
                    const cacheKeyCFBulk = `sync_cf_bulk_${chunk.join('_')}`;
                    const chunkData = await fetchWithCache(cacheKeyCFBulk, async () => {
                        const res = await axios.post(`${CF_API}/mods`, { modIds: chunk }, { headers: CF_HEADERS });
                        return res.data.data;
                    });
                    cfBulkData = cfBulkData.concat(chunkData);
                }
            }

            const updatedMods = [];
            
            for (const mod of mods) {
                if (!mod.authors) mod.authors = { curseforge: null, modrinth: null };
                if (!mod.environments) mod.environments = { curseforge: null, modrinth: null };

                if (mod.ids.curseforge) {
                    const cfMod = cfBulkData.find(m => m.id === mod.ids.curseforge);
                    if (cfMod) {
                        if (!mod.authors.curseforge && cfMod.authors && cfMod.authors.length > 0) mod.authors.curseforge = cfMod.authors[0].name;
                        if (!mod.environments.curseforge && cfMod.latestFiles && cfMod.latestFiles.length > 0) {
                            const file = cfMod.latestFiles[0];
                            mod.environments.curseforge = {
                                client: file.gameVersions ? file.gameVersions.includes('Client') : true,
                                server: file.gameVersions ? file.gameVersions.includes('Server') : true
                            }
                        }
                    }
                }

                if (mod.ids.modrinth) {
                    if (!mod.authors.modrinth || !mod.environments.modrinth) {
                        try {
                            const mrVerKey = `mr_sync_${mod.ids.modrinth}`;
                            const mrData = await fetchWithCache(mrVerKey, async () => {
                                const mrRes = await axios.get(`${MR_API}/search`, { headers: MR_HEADERS, params: { facets: `[["project_id:${mod.ids.modrinth}"]]`, limit: 1 } });
                                return mrRes.data.hits.length > 0 ? mrRes.data.hits[0] : null;
                            });
                            
                            if (mrData) {
                                if (!mod.authors.modrinth) mod.authors.modrinth = mrData.author || 'Unknown';
                                if (!mod.environments.modrinth) mod.environments.modrinth = {
                                    client: mrData.client_side !== 'unsupported',
                                    server: mrData.server_side !== 'unsupported'
                                };
                            }
                        } catch (err) {}
                    }
                }
                updatedMods.push(mod);
            }
            return { success: true, mods: updatedMods };
        } catch (error) { return { success: false, error: error.message }; }
    }
};

module.exports = apiUtils;