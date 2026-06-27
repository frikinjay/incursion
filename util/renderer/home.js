window.HomeManager = {
    _loaderVersionCache: {},

    _populateLoaderVersions: async (selectedVersion) => {
        const loaderSelect = document.getElementById('createPackLoaderSelect');
        const gameVersionSelect = document.getElementById('createPackVersionSelect');
        const versionSelect = document.getElementById('packLoaderVersionSelect');
        const loader = loaderSelect.value;
        const gameVersion = gameVersionSelect.value;

        if (!gameVersion) {
            versionSelect.innerHTML = '<option value="">Select a Minecraft version first</option>';
            versionSelect.disabled = true;
            return;
        }

        versionSelect.disabled = true;
        versionSelect.innerHTML = '<option value="">Loading...</option>';

        const cacheKey = `${loader}_${gameVersion}`;
        if (!HomeManager._loaderVersionCache[cacheKey]) {
            const res = await window.api.getLoaderVersions({ gameVersion, loader });
            if (res.success) {
                HomeManager._loaderVersionCache[cacheKey] = res.versions || [];
            } else {
                versionSelect.innerHTML = '<option value="">Failed to load</option>';
                return;
            }
        }

        const versions = HomeManager._loaderVersionCache[cacheKey];
        versionSelect.innerHTML = '';
        if (versions.length === 0) {
            versionSelect.innerHTML = `<option value="">No ${loader} versions for ${gameVersion}</option>`;
            versionSelect.disabled = true;
            return;
        }

        versions.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v; opt.innerText = v;
            versionSelect.appendChild(opt);
        });

        if (selectedVersion && versions.includes(selectedVersion)) {
            versionSelect.value = selectedVersion;
        }

        versionSelect.disabled = false;
    },

    init: () => {
        document.getElementById('showCreatePackBtn').addEventListener('click', () => { HomeManager.openPackModal(false); });

        document.getElementById('browseDirBtn').addEventListener('click', async () => {
            const dir = await window.api.selectDirectory();
            if (dir) document.getElementById('packDirInput').value = dir;
        });

        document.getElementById('addModpackBtn').addEventListener('click', async () => {
            const dirPath = await window.api.selectDirectory();
            if (!dirPath) return;

            const res = await window.api.loadPackMetadata(dirPath);
            if (res?.success) {
                const meta = res.metadata;
                const exists = AppState.globalPacks.some(p => p.path === dirPath);
                if (!exists) {
                    AppState.globalPacks.push({
                        name: meta.name, path: dirPath, version: meta.version || '1.0.0',
                        loader: meta.loader || 'fabric', gameVersion: meta.gameVersion, icon: meta.icon
                    });
                    await window.api.saveGlobalPacks(AppState.globalPacks);
                    HomeManager.renderPacksList();
                    UI.showSuccess("Modpack added successfully.");
                } else { UI.showError("This pack is already in your list."); }
            } else { UI.showError("No valid pack-metadata.json found in that directory."); }
        });

        document.getElementById('createPackLoaderSelect').addEventListener('change', () => {
            HomeManager._populateLoaderVersions(null);
        });

        document.getElementById('createPackVersionSelect').addEventListener('change', () => {
            HomeManager._populateLoaderVersions(null);
        });

        document.getElementById('selectIconBtn').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = 'image/png, image/jpeg';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        AppState.chosenIconBase64 = event.target.result;
                        document.getElementById('packIconPreview').src = event.target.result;
                    };
                    reader.readAsDataURL(file);
                }
            };
            input.click();
        });

        document.getElementById('cancelCreateBtn').addEventListener('click', () => { document.getElementById('createPackForm').classList.add('hidden'); });
        document.getElementById('confirmCreateBtn').addEventListener('click', async () => { await HomeManager.handleFormSubmit(); });
    },

    openPackModal: async (isEdit, pack = null) => {
        AppState.isEditing = isEdit;
        const modal = document.getElementById('createPackForm');
        const dirRow = document.getElementById('modalDirRow');

        if (isEdit && pack) {
            AppState.editingPackPath = pack.path;
            document.getElementById('modalFormTitle').innerText = 'Edit Modpack Details';
            document.getElementById('packNameInput').value = pack.name || '';
            document.getElementById('packVersionInput').value = pack.version || '1.0.0';
            document.getElementById('packAuthorInput').value = pack.author || '';
            document.getElementById('packDescInput').value = pack.description || '';
            document.getElementById('createPackVersionSelect').value = pack.gameVersion || '';
            
            document.getElementById('createPackLoaderSelect').value = (pack.loader === 'neoforge') ? 'neoforge' : 'fabric';
            
            AppState.chosenIconBase64 = pack.icon || null;
            document.getElementById('packIconPreview').src = pack.icon || 'icon.svg';
            dirRow.style.display = 'none';
        } else {
            AppState.editingPackPath = null;
            document.getElementById('modalFormTitle').innerText = 'Create New Modpack';
            document.getElementById('packNameInput').value = '';
            document.getElementById('packVersionInput').value = '1.0.0';
            document.getElementById('packAuthorInput').value = '';
            document.getElementById('packDescInput').value = '';
            document.getElementById('createPackLoaderSelect').value = 'fabric';
            AppState.chosenIconBase64 = null;
            document.getElementById('packIconPreview').src = 'icon.svg';
            document.getElementById('packDirInput').value = '';
            dirRow.style.display = 'flex';

            const gameVersionSelect = document.getElementById('createPackVersionSelect');
            if (!gameVersionSelect.value && gameVersionSelect.options.length > 0) {
                gameVersionSelect.value = gameVersionSelect.options[0].value;
            }
        }

        modal.classList.remove('hidden');

        await HomeManager._populateLoaderVersions(pack?.loaderVersion || null);
    },

    handleFormSubmit: async () => {
        const name = document.getElementById('packNameInput').value.trim();
        const version = document.getElementById('packVersionInput').value.trim();
        const author = document.getElementById('packAuthorInput').value.trim();
        const description = document.getElementById('packDescInput').value.trim();
        const gameVersion = document.getElementById('createPackVersionSelect').value;
        const loader = document.getElementById('createPackLoaderSelect').value;
        const loaderVersion = document.getElementById('packLoaderVersionSelect').value;

        if (!name) return UI.showError("Pack name required!");

        if (AppState.isEditing) {
            const packIdx = AppState.globalPacks.findIndex(p => p.path === AppState.editingPackPath);
            if (packIdx !== -1) {
                const res = await window.api.loadPackMetadata(AppState.editingPackPath);
                const existingData = res?.success ? res.metadata : {};

                const updated = {
                    ...existingData,
                    name, version, author, description, gameVersion, loader, loaderVersion,
                    icon: AppState.chosenIconBase64
                };

                AppState.globalPacks[packIdx] = { name, path: existingData.path, version, loader, gameVersion, icon: updated.icon };
                await window.api.saveGlobalPacks(AppState.globalPacks);
                await window.api.savePackMetadata({ packPath: existingData.path, metadata: updated });
            }
        } else {
            const packDir = document.getElementById('packDirInput').value;
            if (!packDir) return UI.showError("Directory selection mandatory");

            const newPack = {
                name, version, author, description, loader, gameVersion, loaderVersion,
                path: packDir, icon: AppState.chosenIconBase64, mods: []
            };

            AppState.globalPacks.push({ name, path: packDir, version, loader, gameVersion, icon: newPack.icon });
            await window.api.saveGlobalPacks(AppState.globalPacks);
            await window.api.savePackMetadata({ packPath: packDir, metadata: newPack });
        }

        document.getElementById('createPackForm').classList.add('hidden');
        HomeManager.renderPacksList();
        UI.showSuccess(AppState.isEditing ? "Modpack updated successfully." : "Modpack created successfully.");
    },

    renderPacksList: () => {
        const grid = document.getElementById('packsList');
        grid.innerHTML = '';
        if (AppState.globalPacks.length === 0) { grid.innerHTML = '<p class="empty">No packs found. Create or Add one to begin!</p>'; return; }

        AppState.globalPacks.forEach(pack => {
            const card = document.createElement('div');
            card.className = 'pack-card';
            const displayIcon = pack.icon ? pack.icon : 'icon.svg';

            card.innerHTML = `
                <div style="display: flex; gap: 15px; align-items: flex-start;">
                    <img src="${displayIcon}" style="width: 54px; height: 54px; border-radius: 8px; object-fit: cover; border: 1px solid var(--border-color);" alt="">
                    <div style="flex: 1;">
                        <h4 style="margin: 0 0 5px 0; font-size: 1.2em;">${pack.name}</h4>
                        <p style="margin: 0 0 10px 0; color: var(--text-muted); font-size: 0.85em;">${pack.path}</p>
                        <div style="display: flex; gap: 8px;">
                            <span class="env-badge">${pack.version || '1.0.0'}</span>
                            <span class="env-badge">${pack.gameVersion || '1.21.1'}</span>
                            <span class="env-badge" style="text-transform: capitalize;">${pack.loader || 'fabric'}</span>
                        </div>
                    </div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: auto; padding-top: 15px; border-top: 1px solid var(--border-color);">
                    <button class="secondary-btn edit-pack-btn">Edit Details</button>
                    <button class="remove-btn remove-pack-btn">Remove</button>
                </div>
            `;

            card.addEventListener('click', (e) => {
                if (!e.target.closest('button')) DetailsManager.openPackDetails(pack.path);
            });

            card.querySelector('.edit-pack-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                const res = await window.api.loadPackMetadata(pack.path);
                HomeManager.openPackModal(true, (res?.success ? res.metadata : null) || pack);
            });

            card.querySelector('.remove-pack-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                AppState.globalPacks = AppState.globalPacks.filter(p => p.path !== pack.path);
                await window.api.saveGlobalPacks(AppState.globalPacks);
                HomeManager.renderPacksList();
                UI.showSuccess("Modpack removed.");
            });

            grid.appendChild(card);
        });
    }
};