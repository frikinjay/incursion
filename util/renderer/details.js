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
                        <p style="margin: 5px 0 10px 0; font-size: 0.9em; color: #ccc; line-height: 1.4;">${mod.summary || 'No description available.'}</p>
                        <small>
                            <a href="${mod.links.curseforge}" target="_blank" style="color: var(--accent-primary); text-decoration: none;">CF Project</a> | 
                            <a href="${mod.links.modrinth}" target="_blank" style="color: var(--accent-primary); text-decoration: none;">MR Project</a>
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

            list.appendChild(item);
        });
    }
};