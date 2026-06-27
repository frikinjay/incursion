window.HomeManager = {
    init: () => {
        document.getElementById('showCreatePackBtn').addEventListener('click', () => {
            document.getElementById('createPackForm').classList.remove('hidden');
        });

        document.getElementById('cancelCreateBtn').addEventListener('click', () => {
            document.getElementById('createPackForm').classList.add('hidden');
        });

        document.getElementById('browseDirBtn').addEventListener('click', async () => {
            const dir = await window.api.selectDirectory();
            if (dir) document.getElementById('packDirInput').value = dir;
        });

        document.getElementById('confirmCreateBtn').addEventListener('click', async () => {
            const name = document.getElementById('packNameInput').value.trim();
            const dir = document.getElementById('packDirInput').value;
            const version = document.getElementById('createPackVersionSelect').value;
            const loader = document.getElementById('createPackLoaderSelect').value;

            if (!name || !dir || !version) {
                UI.showError("Please specify a name, directory, and version.");
                return;
            }

            if (AppState.globalPacks.some(p => p.name.toLowerCase() === name.toLowerCase())) {
                UI.showError("A pack with this name already exists in your cache.");
                return;
            }

            const newPack = { name, path: dir, version, loader, mods: [] };
            const res = await window.api.savePackMetadata({ packPath: dir, metadata: newPack });
            
            if (res.success) {
                AppState.globalPacks.push({ name, path: dir, version, loader });
                await window.api.saveGlobalPacks(AppState.globalPacks);
                
                document.getElementById('packNameInput').value = '';
                document.getElementById('packDirInput').value = '';
                document.getElementById('createPackForm').classList.add('hidden');
                
                HomeManager.renderPacksList();
                DetailsManager.openPackDetails(dir);
            } else {
                UI.showError(`Creation failed: ${res.error}`);
            }
        });

        document.getElementById('addModpackBtn').addEventListener('click', async () => {
            const filePath = await window.api.selectMetadataFile();
            if (filePath) {
                const dirPath = filePath.substring(0, filePath.lastIndexOf('\\') !== -1 ? filePath.lastIndexOf('\\') : filePath.lastIndexOf('/'));
                const res = await window.api.loadPackMetadata(dirPath);
                
                if (res.success) {
                    const exists = AppState.globalPacks.some(p => p.path === dirPath);
                    if (!exists) {
                        AppState.globalPacks.push({ 
                            name: res.metadata.name, 
                            path: dirPath,
                            version: res.metadata.version || 'Unknown',
                            loader: res.metadata.loader || 'Unknown'
                        });
                        await window.api.saveGlobalPacks(AppState.globalPacks);
                        HomeManager.renderPacksList();
                    } else {
                        UI.showError("This pack is already in your list.");
                    }
                } else {
                    UI.showError("Invalid metadata file.");
                }
            }
        });
    },

    renderPacksList: () => {
        const list = document.getElementById('packsList');
        list.innerHTML = '';
        
        if (AppState.globalPacks.length === 0) {
            list.innerHTML = '<p class="empty">No packs found. Create or Add one to begin!</p>';
            return;
        }

        AppState.globalPacks.forEach(pack => {
            const card = document.createElement('div');
            card.className = 'pack-card';
            card.innerHTML = `
                <div class="pack-info">
                    <h4 style="margin: 0 0 5px 0;">${pack.name}</h4>
                    <small style="color: var(--text-muted);">${pack.path}</small>
                    <div style="margin-top: 10px; display: flex; gap: 8px;">
                        <span style="background: var(--bg-app); font-size: 0.75em; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color);">${pack.version || '?'}</span>
                        <span style="background: var(--bg-app); font-size: 0.75em; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color); text-transform: capitalize;">${pack.loader || '?'}</span>
                    </div>
                </div>
                <button class="remove-btn remove-pack-btn">Remove</button>
            `;

            card.addEventListener('click', () => DetailsManager.openPackDetails(pack.path));
            
            card.querySelector('.remove-pack-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                AppState.globalPacks = AppState.globalPacks.filter(p => p.path !== pack.path);
                await window.api.saveGlobalPacks(AppState.globalPacks);
                HomeManager.renderPacksList();
            });

            list.appendChild(card);
        });
    }
};