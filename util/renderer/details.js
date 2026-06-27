window.DetailsManager = {
    rowHeight: 180,
    visibleCount: 10,
    bufferCount: 5,
    allMods: [],

    init: () => {
        window.api.onUpdateProgress((percent) => {
            const progressBar = document.getElementById('actionProgressBar');
            if (progressBar) progressBar.style.width = `${percent}%`;
        });

        document.getElementById('addModsToPackBtn').addEventListener('click', () => {
            AppState.search.platform = 'both';
            document.getElementById('searchTitle').innerText = 'Search Mods (Both Platforms)';
            UI.switchView('search', AppViews);
        });
        document.getElementById('addModsMrBtn').addEventListener('click', () => {
            AppState.search.platform = 'modrinth';
            document.getElementById('searchTitle').innerText = 'Search Modrinth Only';
            UI.switchView('search', AppViews);
        });
        document.getElementById('addModsCfBtn').addEventListener('click', () => {
            AppState.search.platform = 'curseforge';
            document.getElementById('searchTitle').innerText = 'Search CurseForge Only';
            UI.switchView('search', AppViews);
        });

        // Filters
        document.getElementById('installedSearchInput').addEventListener('input', (e) => { AppState.installedSearchQuery = e.target.value; DetailsManager.sortAndRefresh(); });
        document.getElementById('installedEnvSelect').addEventListener('change', (e) => { AppState.installedEnvFilter = e.target.value; DetailsManager.sortAndRefresh(); });
        document.getElementById('installedPlatformSelect').addEventListener('change', (e) => { AppState.installedPlatformFilter = e.target.value; DetailsManager.sortAndRefresh(); });
        document.getElementById('packSortSelect').addEventListener('change', (e) => { AppState.currentSortMode = e.target.value; DetailsManager.sortAndRefresh(); });

        // Virtual Scroll Listener
        document.getElementById('virtualScrollContainer').addEventListener('scroll', () => { DetailsManager.renderVirtualChunk(); });

        // Update Checking
        document.getElementById('checkUpdatesBtn').addEventListener('click', async () => {
            const btn = document.getElementById('checkUpdatesBtn');
            btn.innerText = 'Checking...'; btn.disabled = true;

            const progressContainer = document.getElementById('actionProgressContainer');
            const progressBar = document.getElementById('actionProgressBar');
            progressContainer.style.display = 'block'; progressBar.style.width = '0%';

            const res = await window.api.checkModUpdates({
                mods: AppState.currentActivePack.mods,
                version: AppState.currentActivePack.gameVersion, 
                loader: AppState.currentActivePack.loader
            });

            setTimeout(() => { progressContainer.style.display = 'none'; }, 1000);

            if (res.success) {
                AppState.pendingUpdates = res.updates;
                const updateCount = Object.keys(AppState.pendingUpdates).length;
                document.getElementById('updateAllBtn').disabled = updateCount === 0;
                UI.showError(updateCount > 0 ? `Found ${updateCount} updates!` : "All mods are up to date.");
                DetailsManager.sortAndRefresh();
            } else { UI.showError("Failed to check for updates."); }

            btn.innerText = 'Check Updates'; btn.disabled = false;
        });

        document.getElementById('updateAllBtn').addEventListener('click', async () => {
            const btn = document.getElementById('updateAllBtn');
            btn.innerText = 'Updating All...'; btn.disabled = true;
            
            const updateIds = Object.keys(AppState.pendingUpdates);
            const progressContainer = document.getElementById('actionProgressContainer');
            const progressBar = document.getElementById('actionProgressBar');
            progressContainer.style.display = 'block'; progressBar.style.width = '0%';

            let i = 0;
            for (const modId of updateIds) {
                const modToUpdate = AppState.currentActivePack.mods.find(m => m.ids.curseforge === modId || m.ids.modrinth === modId);
                if (modToUpdate) {
                    const updateData = AppState.pendingUpdates[modId];
                    await window.api.removeModFiles({ packPath: AppState.currentActivePack.path, files: modToUpdate.installedFiles });
                    modToUpdate.installedFiles = updateData.installedFiles;
                    modToUpdate.fileLinks = updateData.fileLinks;
                    modToUpdate.meta = updateData.meta;
                    await window.api.downloadMod({ mod: modToUpdate, packPath: AppState.currentActivePack.path });
                }
                i++;
                progressBar.style.width = `${Math.round((i / updateIds.length) * 100)}%`;
            }

            await window.api.savePackMetadata({ packPath: AppState.currentActivePack.path, metadata: AppState.currentActivePack });
            AppState.pendingUpdates = {};
            
            setTimeout(() => { progressContainer.style.display = 'none'; }, 1000);
            DetailsManager.sortAndRefresh();
            btn.innerText = 'Update All'; btn.disabled = true; 
            UI.showError("All mods updated successfully!");
        });

        document.getElementById('exportCFBtn').addEventListener('click', () => DetailsManager.exportPack('cf'));
        document.getElementById('exportMRBtn').addEventListener('click', () => DetailsManager.exportPack('mr'));
        document.getElementById('exportPacksBtn').addEventListener('click', () => DetailsManager.exportPack('both'));

        document.getElementById('redownloadAllBtn').addEventListener('click', async () => {
            const btn = document.getElementById('redownloadAllBtn');
            const modsToRedownload = AppState.currentActivePack.mods;
            if (!modsToRedownload || modsToRedownload.length === 0) { UI.showError("No mods to redownload."); return; }

            btn.innerText = 'Redownloading...'; btn.disabled = true;
            const progressContainer = document.getElementById('actionProgressContainer');
            const progressBar = document.getElementById('actionProgressBar');
            progressContainer.style.display = 'block'; progressBar.style.width = '0%';

            UI.showError("Syncing metadata...");
            const syncRes = await window.api.syncMetadata({ mods: modsToRedownload });
            if (syncRes.success) {
                AppState.currentActivePack.mods = syncRes.mods;
                await window.api.savePackMetadata({ packPath: AppState.currentActivePack.path, metadata: AppState.currentActivePack });
            }

            let successCount = 0, failCount = 0, total = modsToRedownload.length;
            for (let i = 0; i < total; i++) {
                const mod = modsToRedownload[i];
                try {
                    await window.api.removeModFiles({ packPath: AppState.currentActivePack.path, files: mod.installedFiles });
                    const res = await window.api.downloadMod({ mod: mod, packPath: AppState.currentActivePack.path });
                    if (res.success) successCount++; else failCount++;
                } catch (err) { failCount++; }
                progressBar.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
            }

            setTimeout(() => { progressContainer.style.display = 'none'; }, 1500);
            DetailsManager.sortAndRefresh(); 
            btn.innerText = 'Redownload All'; btn.disabled = false;

            if (failCount > 0) UI.showError(`Redownloaded ${successCount} mods. ${failCount} failed.`);
            else UI.showError(`Successfully redownloaded all ${successCount} mods!`);
        });

        document.getElementById('refreshInstalledCacheBtn').addEventListener('click', async () => {
            const btn = document.getElementById('refreshInstalledCacheBtn');
            btn.innerText = 'Clearing...'; btn.disabled = true;
            await window.api.clearApiCache();
            UI.showError("Cache Cleared! Ready for fresh updates.");
            btn.innerText = 'Refresh Cache'; btn.disabled = false;
        });
    },

    exportPack: async (type) => {
        const exportDir = await window.api.selectDirectory();
        if (!exportDir) return;

        if (type === 'cf' || type === 'both') {
            const res = await window.api.exportPackCF({ metadata: AppState.currentActivePack, exportDir });
            if (res.success) UI.showError(`CurseForge archive exported!`);
            else UI.showError(`CF Export failed: ${res.error}`);
        }
        if (type === 'mr' || type === 'both') {
            const res = await window.api.exportPackMR({ metadata: AppState.currentActivePack, exportDir });
            if (res.success) UI.showError(`Modrinth archive exported!`);
            else UI.showError(`MR Export failed: ${res.error}`);
        }
    },

    openPackDetails: async (packPath) => {
        const res = await window.api.loadPackMetadata(packPath);
        if (!res || !res.success) { UI.showError(`Could not access metadata.`); return; }
        
        AppState.currentActivePack = res.metadata;   // ← unwrap here
        document.getElementById('detailPackIcon').src = AppState.currentActivePack.icon || 'icon.svg';
        document.getElementById('detailPackName').innerText = AppState.currentActivePack.name;
        document.getElementById('detailPackMetaSub').innerText = `v${AppState.currentActivePack.version || '1.0.0'} | ${AppState.currentActivePack.loader.toUpperCase()} | ${AppState.currentActivePack.gameVersion}`;
        document.getElementById('detailPackDesc').innerText = AppState.currentActivePack.description || 'No description supplied.';
        
        UI.switchView('details', AppViews);
        DetailsManager.sortAndRefresh();
    },

    sortAndRefresh: () => {
        let filteredMods = (AppState.currentActivePack.mods || []).filter(mod => {
            const titleCF = mod.names.curseforge || "";
            const titleMR = mod.names.modrinth || "";
            const searchMatch = titleCF.toLowerCase().includes(AppState.installedSearchQuery.toLowerCase()) || 
                                titleMR.toLowerCase().includes(AppState.installedSearchQuery.toLowerCase());
            
            const env = mod.environments || { curseforge: {client: true, server: true}, modrinth: {client: true, server: true} };
            const isClient = (env.curseforge && env.curseforge.client) || (env.modrinth && env.modrinth.client);
            const isServer = (env.curseforge && env.curseforge.server) || (env.modrinth && env.modrinth.server);
            
            let envMatch = true;
            if (AppState.installedEnvFilter === 'client') envMatch = isClient && !isServer;
            if (AppState.installedEnvFilter === 'server') envMatch = !isClient && isServer;
            if (AppState.installedEnvFilter === 'both') envMatch = isClient && isServer;

            const hasCF = !!mod.ids.curseforge;
            const hasMR = !!mod.ids.modrinth;
            let platMatch = true;
            if (AppState.installedPlatformFilter === 'both') platMatch = hasCF && hasMR;
            if (AppState.installedPlatformFilter === 'modrinth') platMatch = !hasCF && hasMR;
            if (AppState.installedPlatformFilter === 'curseforge') platMatch = hasCF && !hasMR;

            return searchMatch && envMatch && platMatch;
        });

        filteredMods.sort((a, b) => {
            const nameA = (a.names.curseforge || a.names.modrinth).toLowerCase();
            const nameB = (b.names.curseforge || b.names.modrinth).toLowerCase();
            const dateA = a.dateAdded || 0, dateB = b.dateAdded || 0;
            if (AppState.currentSortMode === 'name-asc') return nameA.localeCompare(nameB);
            if (AppState.currentSortMode === 'name-desc') return nameB.localeCompare(nameA);
            if (AppState.currentSortMode === 'date-desc') return dateB - dateA;
            if (AppState.currentSortMode === 'date-asc') return dateA - dateB;
            return 0;
        });

        filteredMods.sort((a, b) => {
            const idA = a.ids.curseforge || a.ids.modrinth;
            const idB = b.ids.curseforge || b.ids.modrinth;
            const hasA = AppState.pendingUpdates[idA] ? 1 : 0;
            const hasB = AppState.pendingUpdates[idB] ? 1 : 0;
            return hasB - hasA;
        });

        DetailsManager.allMods = filteredMods;

        const totalHeight = DetailsManager.allMods.length * DetailsManager.rowHeight;
        document.getElementById('virtualScrollSpacer').style.height = `${totalHeight}px`;
        
        DetailsManager.renderVirtualChunk();
    },

    renderVirtualChunk: () => {
        const container = document.getElementById('virtualScrollContainer');
        const content = document.getElementById('virtualScrollContent');
        const scrollTop = container.scrollTop;

        let startIndex = Math.floor(scrollTop / DetailsManager.rowHeight) - DetailsManager.bufferCount;
        startIndex = Math.max(0, startIndex);

        let endIndex = startIndex + DetailsManager.visibleCount + (DetailsManager.bufferCount * 2);
        endIndex = Math.min(DetailsManager.allMods.length, endIndex);

        content.innerHTML = '';
        const offsetY = startIndex * DetailsManager.rowHeight;
        content.style.transform = `translateY(${offsetY}px)`;

        for (let i = startIndex; i < endIndex; i++) {
            const mod = DetailsManager.allMods[i];
            const item = document.createElement('div');
            item.className = 'installed-mod-item';
            item.style.height = `${DetailsManager.rowHeight - 16}px`; // Subtract margin
            
            const hasCF = !!mod.ids.curseforge;
            const hasMR = !!mod.ids.modrinth;
            const uniqueId = mod.ids.curseforge || mod.ids.modrinth; 
            const title = (hasCF ? mod.names.curseforge : mod.names.modrinth) || "Unknown Mod";

            const cfIcon = (hasCF && mod.icons.curseforge) ? `<img src="${mod.icons.curseforge}" class="mod-icon" style="width: 40px; height: 40px; border-radius: 6px;">` : '';
            const mrIcon = (hasMR && mod.icons.modrinth) ? `<img src="${mod.icons.modrinth}" class="mod-icon" style="width: 40px; height: 40px; border-radius: 6px;">` : '';
            
            const updateData = AppState.pendingUpdates[uniqueId];
            const updateAvailable = !!updateData;

            let badgesHtml = '';
            if (hasCF && hasMR) badgesHtml = '<span class="platform-badge both">Both</span>';
            else if (hasCF) badgesHtml = '<span class="platform-badge cf">CurseForge Only</span>';
            else if (hasMR) badgesHtml = '<span class="platform-badge mr">Modrinth Only</span>';

            const env = mod.environments || { curseforge: null, modrinth: null };
            let envHtml = '';
            if (hasCF && env.curseforge) {
                envHtml += `<div style="display: flex; gap: 4px; align-items: center;">
                                <span style="font-size: 0.75em; color: var(--text-muted); margin-right: 4px;">CF:</span>
                                <span class="env-badge ${env.curseforge.client ? 'supported' : 'unsupported'}">Client</span>
                                <span class="env-badge ${env.curseforge.server ? 'supported' : 'unsupported'}">Server</span>
                            </div>`;
            }
            if (hasMR && env.modrinth) {
                envHtml += `<div style="display: flex; gap: 4px; align-items: center;">
                                <span style="font-size: 0.75em; color: var(--text-muted); margin-right: 4px;">MR:</span>
                                <span class="env-badge ${env.modrinth.client ? 'supported' : 'unsupported'}">Client</span>
                                <span class="env-badge ${env.modrinth.server ? 'supported' : 'unsupported'}">Server</span>
                            </div>`;
            }

            item.innerHTML = `
                <div style="display: flex; gap: 15px; align-items: flex-start; flex: 1;">
                    <div class="mod-icons" style="display: flex; flex-direction: column; gap: 5px;">${cfIcon}${mrIcon}</div>
                    <div class="mod-info">
                        <strong style="font-size: 1.1em; color: ${updateAvailable ? 'var(--accent-success)' : 'inherit'}; display: flex; align-items: center; gap: 10px;">
                            ${title} ${badgesHtml}
                            ${updateAvailable ? `<span style="background: var(--accent-success); color: black; font-size: 0.6em; padding: 2px 6px; border-radius: 4px;">Update Available</span>` : ''}
                        </strong>
                        <p style="margin: 5px 0 0 0; font-size: 0.8em; color: var(--accent-primary);">
                            By: ${hasCF && mod.authors ? `${mod.authors.curseforge} (CF)` : ''} ${hasCF && hasMR ? '|' : ''} ${hasMR && mod.authors ? `${mod.authors.modrinth} (MR)` : ''}
                        </p>
                        <p style="margin: 5px 0 10px 0; font-size: 0.9em; color: #ccc; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${mod.summary || 'No description available.'}</p>
                        
                        <div style="display: flex; gap: 15px; align-items: center; flex-wrap: wrap;">
                            <small style="display: flex; gap: 8px; align-items: center;">
                                ${hasCF ? `
                                <span class="project-link-group">
                                    <a href="${mod.links.curseforge}" target="_blank" class="project-link">CF Project</a>
                                    <button class="copy-link-btn" data-url="${mod.links.curseforge}" title="Copy CF Link">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                    </button>
                                </span>` : ''}
                                
                                ${hasCF && hasMR ? `<span style="color: var(--border-light);">|</span>` : ''}
                                
                                ${hasMR ? `
                                <span class="project-link-group">
                                    <a href="${mod.links.modrinth}" target="_blank" class="project-link">MR Project</a>
                                    <button class="copy-link-btn" data-url="${mod.links.modrinth}" title="Copy MR Link">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                    </button>
                                </span>` : ''}
                            </small>
                            <span style="color: var(--border-light);">|</span>
                            ${envHtml}
                        </div>
                    </div>
                </div>
                <div class="mod-item-actions" style="display: flex; flex-direction: column; gap: 6px; margin-left: 15px; min-width: 110px;">
                    <button class="update-btn success-btn" data-id="${uniqueId}" ${updateAvailable ? '' : 'style="display:none;"'}>Update</button>
                    <button class="check-single-update-btn secondary-btn" data-id="${uniqueId}" ${updateAvailable ? 'style="display:none;"' : ''}>Check</button>
                    <button class="redownload-btn secondary-btn">Redownload</button>
                    <button class="remove-btn danger-btn">Remove</button>
                </div>
            `;

            item.querySelector('.check-single-update-btn').addEventListener('click', async (e) => {
                const btn = e.target;
                btn.innerText = 'Checking...'; btn.disabled = true;

                const res = await window.api.checkModUpdates({ mods: [mod], version: AppState.currentActivePack.gameVersion, loader: AppState.currentActivePack.loader });

                if (res.success && res.updates[uniqueId]) {
                    AppState.pendingUpdates[uniqueId] = res.updates[uniqueId];
                    UI.showError("Update found!");
                    document.getElementById('updateAllBtn').disabled = false;
                    DetailsManager.sortAndRefresh();
                } else {
                    UI.showError("Mod is up to date.");
                    btn.innerText = 'Check'; btn.disabled = false;
                }
            });

            item.querySelector('.redownload-btn').addEventListener('click', async (e) => {
                const btn = e.target;
                btn.innerText = 'Downloading...'; btn.disabled = true;
                await window.api.removeModFiles({ packPath: AppState.currentActivePack.path, files: mod.installedFiles });
                await window.api.downloadMod({ mod: mod, packPath: AppState.currentActivePack.path });
                btn.innerText = 'Redownloaded';
                setTimeout(() => { btn.innerText = 'Redownload'; btn.disabled = false; }, 2000);
            });

            if (updateAvailable) {
                item.querySelector('.update-btn').addEventListener('click', async (e) => {
                    const btn = e.target;
                    btn.innerText = 'Updating...'; btn.disabled = true;
                    await window.api.removeModFiles({ packPath: AppState.currentActivePack.path, files: mod.installedFiles });
                    mod.installedFiles = updateData.installedFiles;
                    mod.fileLinks = updateData.fileLinks;
                    mod.meta = updateData.meta;
                    mod.dateAdded = Date.now(); 
                    await window.api.downloadMod({ mod: mod, packPath: AppState.currentActivePack.path });
                    await window.api.savePackMetadata({ packPath: AppState.currentActivePack.path, metadata: AppState.currentActivePack });
                    delete AppState.pendingUpdates[uniqueId];
                    document.getElementById('updateAllBtn').disabled = Object.keys(AppState.pendingUpdates).length === 0;
                    DetailsManager.sortAndRefresh();
                });
            }

            item.querySelector('.remove-btn').addEventListener('click', async () => {
                await window.api.removeModFiles({ packPath: AppState.currentActivePack.path, files: mod.installedFiles });
                AppState.currentActivePack.mods = AppState.currentActivePack.mods.filter(m => (m.ids.curseforge !== mod.ids.curseforge) || (m.ids.modrinth !== mod.ids.modrinth));
                if (AppState.pendingUpdates[uniqueId]) delete AppState.pendingUpdates[uniqueId];
                await window.api.savePackMetadata({ packPath: AppState.currentActivePack.path, metadata: AppState.currentActivePack });
                DetailsManager.sortAndRefresh();
            });

            item.querySelectorAll('.copy-link-btn').forEach(copyBtn => {
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); navigator.clipboard.writeText(copyBtn.dataset.url); UI.showError("Link copied to clipboard!");
                });
            });

            content.appendChild(item);
        }
    }
};