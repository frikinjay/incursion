window.DetailsManager = {
    init: () => {
        document.getElementById('addModsToPackBtn').addEventListener('click', () => {
            UI.switchView('search', AppViews);
        });

        document.getElementById('packSortSelect').addEventListener('change', (e) => {
            AppState.currentSortMode = e.target.value;
            DetailsManager.renderInstalledMods();
        });

        document.getElementById('checkUpdatesBtn').addEventListener('click', async () => {
            const btn = document.getElementById('checkUpdatesBtn');
            btn.innerText = 'Checking...';
            btn.disabled = true;

            const res = await window.api.checkModUpdates({
                mods: AppState.currentActivePack.mods,
                version: AppState.currentActivePack.version || document.getElementById('versionSelect').value, 
                loader: AppState.currentActivePack.loader || document.getElementById('loaderSelect').value
            });

            if (res.success) {
                AppState.pendingUpdates = res.updates;
                const updateCount = Object.keys(AppState.pendingUpdates).length;
                
                document.getElementById('updateAllBtn').disabled = updateCount === 0;
                UI.showError(updateCount > 0 ? `Found ${updateCount} updates!` : "All mods are up to date.");
                DetailsManager.renderInstalledMods();
            } else {
                UI.showError("Failed to check for updates.");
            }

            btn.innerText = 'Check Updates';
            btn.disabled = false;
        });

        document.getElementById('updateAllBtn').addEventListener('click', async () => {
            const btn = document.getElementById('updateAllBtn');
            btn.innerText = 'Updating All...';
            btn.disabled = true;

            const updateIds = Object.keys(AppState.pendingUpdates);
            for (const modId of updateIds) {
                const updateBtn = document.querySelector(`.update-btn[data-id="${modId}"]`);
                if (updateBtn) await updateBtn.click(); 
            }

            btn.innerText = 'Update All';
            btn.disabled = true; 
        });

        document.getElementById('redownloadAllBtn').addEventListener('click', async () => {
            const btn = document.getElementById('redownloadAllBtn');
            const modsToRedownload = AppState.currentActivePack.mods;

            if (!modsToRedownload || modsToRedownload.length === 0) {
                UI.showError("No mods to redownload.");
                return;
            }

            btn.innerText = 'Redownloading...';
            btn.disabled = true;
            
            const progressContainer = document.getElementById('redownloadProgressContainer');
            const progressBar = document.getElementById('redownloadProgressBar');
            progressContainer.style.display = 'block';
            progressBar.style.width = '0%';

            const allIndividualBtns = document.querySelectorAll('.mod-item-actions button');
            allIndividualBtns.forEach(b => b.disabled = true);

            UI.showError("Syncing metadata...");
            const syncRes = await window.api.syncMetadata({ mods: modsToRedownload });
            if (syncRes.success) {
                AppState.currentActivePack.mods = syncRes.mods;
                await window.api.savePackMetadata({ packPath: AppState.currentActivePack.path, metadata: AppState.currentActivePack });
            }

            let successCount = 0;
            let failCount = 0;
            const total = modsToRedownload.length;

            for (let i = 0; i < total; i++) {
                const mod = modsToRedownload[i];
                try {
                    await window.api.removeModFiles({ packPath: AppState.currentActivePack.path, files: mod.installedFiles });
                    const res = await window.api.downloadMod({ mod: mod, packPath: AppState.currentActivePack.path });
                    
                    if (res.success) {
                        successCount++;
                    } else {
                        failCount++;
                        console.error(`Failed to redownload ${mod.names.curseforge}:`, res.error);
                    }
                } catch (err) {
                    failCount++;
                    console.error(`Error redownloading ${mod.names.curseforge}:`, err);
                }

                const percent = Math.round(((i + 1) / total) * 100);
                progressBar.style.width = `${percent}%`;
            }

            setTimeout(() => { progressContainer.style.display = 'none'; }, 1500);
            DetailsManager.renderInstalledMods(); 
            btn.innerText = 'Redownload All';
            btn.disabled = false;

            if (failCount > 0) {
                UI.showError(`Redownloaded ${successCount} mods. ${failCount} failed.`);
            } else {
                UI.showError(`Successfully redownloaded all ${successCount} mods!`);
            }
        });

        document.getElementById('refreshInstalledCacheBtn').addEventListener('click', async () => {
            const btn = document.getElementById('refreshInstalledCacheBtn');
            btn.innerText = 'Clearing...';
            btn.disabled = true;
            await window.api.clearApiCache();
            UI.showError("Cache Cleared! Ready for fresh updates.");
            btn.innerText = 'Refresh Cache';
            btn.disabled = false;
        });
    },

    openPackDetails: async (packPath) => {
        const res = await window.api.loadPackMetadata(packPath);
        if (!res.success) {
            UI.showError(`Could not access metadata: ${res.error}`);
            return;
        }

        AppState.currentActivePack = res.metadata;
        document.getElementById('detailPackName').innerText = AppState.currentActivePack.name;
        
        const vTag = AppState.currentActivePack.version || '?';
        const lTag = AppState.currentActivePack.loader || '?';
        document.getElementById('detailPackPath').innerHTML = `
            ${AppState.currentActivePack.path}
            <span style="margin-left: 15px; background: var(--bg-input); padding: 4px 8px; border-radius: 4px; font-size: 0.85em; border: 1px solid var(--border-color);">${vTag} | <span style="text-transform: capitalize;">${lTag}</span></span>
        `;
        
        DetailsManager.renderInstalledMods();
        UI.switchView('details', AppViews);
    },

    renderInstalledMods: () => {
        const list = document.getElementById('packModsList');
        list.innerHTML = '';

        if (!AppState.currentActivePack.mods || AppState.currentActivePack.mods.length === 0) {
            list.innerHTML = '<p class="empty">No mods installed.</p>';
            return;
        }

        let sortedMods = [...AppState.currentActivePack.mods].sort((a, b) => {
            const nameA = a.names.curseforge.toLowerCase();
            const nameB = b.names.curseforge.toLowerCase();
            const dateA = a.dateAdded || 0; 
            const dateB = b.dateAdded || 0;

            if (AppState.currentSortMode === 'name-asc') return nameA.localeCompare(nameB);
            if (AppState.currentSortMode === 'name-desc') return nameB.localeCompare(nameA);
            if (AppState.currentSortMode === 'date-desc') return dateB - dateA;
            if (AppState.currentSortMode === 'date-asc') return dateA - dateB;
            return 0;
        });

        sortedMods.sort((a, b) => {
            const hasA = AppState.pendingUpdates[a.ids.curseforge] ? 1 : 0;
            const hasB = AppState.pendingUpdates[b.ids.curseforge] ? 1 : 0;
            return hasB - hasA;
        });

        sortedMods.forEach(mod => {
            const item = document.createElement('div');
            item.className = 'installed-mod-item';
            
            const cfIcon = (mod.icons && mod.icons.curseforge) ? `<img src="${mod.icons.curseforge}" class="mod-icon" style="width: 40px; height: 40px; border-radius: 6px;">` : '';
            const mrIcon = (mod.icons && mod.icons.modrinth) ? `<img src="${mod.icons.modrinth}" class="mod-icon" style="width: 40px; height: 40px; border-radius: 6px;">` : '';
            
            const updateData = AppState.pendingUpdates[mod.ids.curseforge];
            const updateAvailable = !!updateData;

            item.innerHTML = `
                <div style="display: flex; gap: 15px; align-items: flex-start; flex: 1;">
                    <div class="mod-icons" style="display: flex; flex-direction: column; gap: 5px;">${cfIcon}${mrIcon}</div>
                    <div class="mod-info">
                        <strong style="font-size: 1.1em; color: ${updateAvailable ? 'var(--accent-success)' : 'inherit'};">${mod.names.curseforge}</strong>
                        ${updateAvailable ? `<span style="background: var(--accent-success); color: black; font-size: 0.7em; padding: 2px 6px; border-radius: 4px; margin-left: 8px;">Update Available</span>` : ''}
                        
                        ${mod.authors ? `<p style="margin: 5px 0 0 0; font-size: 0.8em; color: var(--accent-primary);">By: ${mod.authors.curseforge} (CF) | ${mod.authors.modrinth} (MR)</p>` : ''}
                        
                        <p style="margin: 5px 0 10px 0; font-size: 0.9em; color: #ccc; line-height: 1.4;">${mod.summary || 'No description available.'}</p>
                        <small style="display: flex; gap: 8px; margin-top: 10px; align-items: center;">
                            <span class="project-link-group">
                                <a href="${mod.links.curseforge}" target="_blank" class="project-link">CF Project</a>
                                <button class="copy-link-btn" data-url="${mod.links.curseforge}" title="Copy CF Link">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                </button>
                            </span> 
                            <span style="color: var(--border-light);">|</span> 
                            <span class="project-link-group">
                                <a href="${mod.links.modrinth}" target="_blank" class="project-link">MR Project</a>
                                <button class="copy-link-btn" data-url="${mod.links.modrinth}" title="Copy MR Link">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                </button>
                            </span>
                        </small>
                    </div>
                </div>
                <div class="mod-item-actions" style="display: flex; flex-direction: column; gap: 6px; margin-left: 15px; min-width: 110px;">
                    <button class="update-btn success-btn" data-id="${mod.ids.curseforge}" ${updateAvailable ? '' : 'disabled style="display:none;"'}>Update</button>
                    <button class="redownload-btn secondary-btn">Redownload</button>
                    <button class="remove-btn">Remove</button>
                </div>
            `;

            item.querySelector('.redownload-btn').addEventListener('click', async (e) => {
                const btn = e.target;
                btn.innerText = 'Downloading...';
                btn.disabled = true;
                
                await window.api.removeModFiles({ packPath: AppState.currentActivePack.path, files: mod.installedFiles });
                await window.api.downloadMod({ mod: mod, packPath: AppState.currentActivePack.path });
                
                btn.innerText = 'Redownloaded';
                setTimeout(() => { btn.innerText = 'Redownload'; btn.disabled = false; }, 2000);
            });

            if (updateAvailable) {
                item.querySelector('.update-btn').addEventListener('click', async (e) => {
                    const btn = e.target;
                    btn.innerText = 'Updating...';
                    btn.disabled = true;

                    await window.api.removeModFiles({ packPath: AppState.currentActivePack.path, files: mod.installedFiles });
                    
                    mod.installedFiles = updateData.installedFiles;
                    mod.fileLinks = updateData.fileLinks;
                    mod.dateAdded = Date.now(); 
                    
                    await window.api.downloadMod({ mod: mod, packPath: AppState.currentActivePack.path });
                    await window.api.savePackMetadata({ packPath: AppState.currentActivePack.path, metadata: AppState.currentActivePack });
                    
                    delete AppState.pendingUpdates[mod.ids.curseforge];
                    document.getElementById('updateAllBtn').disabled = Object.keys(AppState.pendingUpdates).length === 0;
                    DetailsManager.renderInstalledMods();
                });
            }

            item.querySelector('.remove-btn').addEventListener('click', async () => {
                await window.api.removeModFiles({ packPath: AppState.currentActivePack.path, files: mod.installedFiles });
                AppState.currentActivePack.mods = AppState.currentActivePack.mods.filter(m => m.ids.curseforge !== mod.ids.curseforge);
                if (AppState.pendingUpdates[mod.ids.curseforge]) delete AppState.pendingUpdates[mod.ids.curseforge];
                await window.api.savePackMetadata({ packPath: AppState.currentActivePack.path, metadata: AppState.currentActivePack });
                DetailsManager.renderInstalledMods();
            });

            item.querySelectorAll('.copy-link-btn').forEach(copyBtn => {
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(copyBtn.dataset.url);
                    UI.showError("Link copied to clipboard!");
                });
            });

            list.appendChild(item);
        });
    }
};