let globalPacks = [];
let currentActivePack = null;
let currentPage = 1;
let totalPages = 1;
let currentSearch = "";
let pendingUpdates = {};
let currentSortMode = 'name-asc';

const views = {
    home: document.getElementById('homeView'),
    details: document.getElementById('packDetailsScreen'),
    search: document.getElementById('searchView'),
    apiKeys: document.getElementById('apiKeysView')
};
const versionSelect = document.getElementById('versionSelect');
const searchInput = document.getElementById('searchInput');
const loaderSelect = document.getElementById('loaderSelect');
const resultsDiv = document.getElementById('resultsDiv');

document.getElementById('minBtn').addEventListener('click', () => window.api.minimizeWindow());
document.getElementById('maxBtn').addEventListener('click', () => window.api.maximizeWindow());
document.getElementById('closeBtn').addEventListener('click', () => window.api.closeWindow());

// INITIALIZATION
document.addEventListener('DOMContentLoaded', async () => {
    const verRes = await window.api.getVersions();
    if (verRes.success && verRes.versions.length > 0) {
        versionSelect.innerHTML = '';
        const createVersionSelect = document.getElementById('createPackVersionSelect');
        createVersionSelect.innerHTML = '';

        verRes.versions.forEach(v => {
            const opt1 = document.createElement('option'); opt1.value = v; opt1.innerText = v;
            versionSelect.appendChild(opt1);
            const opt2 = document.createElement('option'); opt2.value = v; opt2.innerText = v;
            createVersionSelect.appendChild(opt2);
        });
        versionSelect.disabled = false;
        createVersionSelect.disabled = false;
    }

    globalPacks = await window.api.getGlobalPacks();
    renderPacksList();
});

// NAVIGATION LOGIC
function switchView(viewName) {
    Object.values(views).forEach(v => {
        v.classList.remove('active');
        v.classList.add('hidden');
    });
    
    views[viewName].classList.add('active');
    views[viewName].classList.remove('hidden');
}

document.getElementById('backToHomeBtn').addEventListener('click', () => {
    currentActivePack = null;
    switchView('home');
});

document.getElementById('backFromSearchBtn').addEventListener('click', () => {
    if (currentActivePack) {
        openPackDetails(currentActivePack.path);
        switchView('details');
    } else {
        switchView('home');
    }
});

// HOME VIEW LOGIC
function renderPacksList() {
    const list = document.getElementById('packsList');
    list.innerHTML = '';
    
    if (globalPacks.length === 0) {
        list.innerHTML = '<p class="empty">No packs found. Create or Add one to begin!</p>';
        return;
    }

    globalPacks.forEach(pack => {
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

        card.addEventListener('click', () => openPackDetails(pack.path));
        
        card.querySelector('.remove-pack-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            globalPacks = globalPacks.filter(p => p.path !== pack.path);
            await window.api.saveGlobalPacks(globalPacks);
            renderPacksList();
        });

        list.appendChild(card);
    });
}

document.getElementById('addModpackBtn').addEventListener('click', async () => {
    const filePath = await window.api.selectMetadataFile();
    if (filePath) {
        const dirPath = filePath.substring(0, filePath.lastIndexOf('\\') !== -1 ? filePath.lastIndexOf('\\') : filePath.lastIndexOf('/'));
        const res = await window.api.loadPackMetadata(dirPath);
        
        if (res.success) {
            const exists = globalPacks.some(p => p.path === dirPath);
            if (!exists) {
                globalPacks.push({ 
                    name: res.metadata.name, 
                    path: dirPath,
                    version: res.metadata.version || 'Unknown',
                    loader: res.metadata.loader || 'Unknown'
                });
                await window.api.saveGlobalPacks(globalPacks);
                renderPacksList();
            } else {
                showError("This pack is already in your list.");
            }
        } else {
            showError("Invalid metadata file.");
        }
    }
});

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
        showError("Please specify a name, directory, and version.");
        return;
    }

    if (globalPacks.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        showError("A pack with this name already exists in your cache.");
        return;
    }

    const newPack = { name, path: dir, version, loader, mods: [] };
    const res = await window.api.savePackMetadata({ packPath: dir, metadata: newPack });
    
    if (res.success) {
        globalPacks.push({ name, path: dir, version, loader });
        await window.api.saveGlobalPacks(globalPacks);
        
        document.getElementById('packNameInput').value = '';
        document.getElementById('packDirInput').value = '';
        document.getElementById('createPackForm').classList.add('hidden');
        
        renderPacksList();
        openPackDetails(dir);
    } else {
        showError(`Creation failed: ${res.error}`);
    }
});

// DETAILS VIEW LOGIC
async function openPackDetails(packPath) {
    const res = await window.api.loadPackMetadata(packPath);
    if (!res.success) {
        showError(`Could not access metadata: ${res.error}`);
        return;
    }

    currentActivePack = res.metadata;
    document.getElementById('detailPackName').innerText = currentActivePack.name;
    
    const vTag = currentActivePack.version || '?';
    const lTag = currentActivePack.loader || '?';
    document.getElementById('detailPackPath').innerHTML = `
        ${currentActivePack.path}
        <span style="margin-left: 15px; background: var(--bg-input); padding: 4px 8px; border-radius: 4px; font-size: 0.85em; border: 1px solid var(--border-color);">${vTag} | <span style="text-transform: capitalize;">${lTag}</span></span>
    `;
    
    renderInstalledMods();
    switchView('details');
}

function renderInstalledMods() {
    const list = document.getElementById('packModsList');
    list.innerHTML = '';

    if (!currentActivePack.mods || currentActivePack.mods.length === 0) {
        list.innerHTML = '<p class="empty">No mods installed.</p>';
        return;
    }

    let sortedMods = [...currentActivePack.mods].sort((a, b) => {
        const nameA = a.names.curseforge.toLowerCase();
        const nameB = b.names.curseforge.toLowerCase();
        const dateA = a.dateAdded || 0;
        const dateB = b.dateAdded || 0;

        if (currentSortMode === 'name-asc') return nameA.localeCompare(nameB);
        if (currentSortMode === 'name-desc') return nameB.localeCompare(nameA);
        if (currentSortMode === 'date-desc') return dateB - dateA;
        if (currentSortMode === 'date-asc') return dateA - dateB;
        return 0;
    });

    sortedMods.sort((a, b) => {
        const hasA = pendingUpdates[a.ids.curseforge] ? 1 : 0;
        const hasB = pendingUpdates[b.ids.curseforge] ? 1 : 0;
        return hasB - hasA;
    });

    sortedMods.forEach(mod => {
        const item = document.createElement('div');
        item.className = 'installed-mod-item';
        
        const cfIcon = (mod.icons && mod.icons.curseforge) ? `<img src="${mod.icons.curseforge}" class="mod-icon" style="width: 40px; height: 40px; border-radius: 6px;">` : '';
        const mrIcon = (mod.icons && mod.icons.modrinth) ? `<img src="${mod.icons.modrinth}" class="mod-icon" style="width: 40px; height: 40px; border-radius: 6px;">` : '';
        
        const updateData = pendingUpdates[mod.ids.curseforge];
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
            
            await window.api.removeModFiles({ packPath: currentActivePack.path, files: mod.installedFiles });
            await window.api.downloadMod({ mod: mod, packPath: currentActivePack.path });
            
            btn.innerText = 'Redownloaded';
            setTimeout(() => { btn.innerText = 'Redownload'; btn.disabled = false; }, 2000);
        });

        if (updateAvailable) {
            item.querySelector('.update-btn').addEventListener('click', async (e) => {
                const btn = e.target;
                btn.innerText = 'Updating...';
                btn.disabled = true;

                await window.api.removeModFiles({ packPath: currentActivePack.path, files: mod.installedFiles });
                
                mod.installedFiles = updateData.installedFiles;
                mod.fileLinks = updateData.fileLinks;
                mod.dateAdded = Date.now();
                
                await window.api.downloadMod({ mod: mod, packPath: currentActivePack.path });
                await window.api.savePackMetadata({ packPath: currentActivePack.path, metadata: currentActivePack });
                
                delete pendingUpdates[mod.ids.curseforge];
                document.getElementById('updateAllBtn').disabled = Object.keys(pendingUpdates).length === 0;
                renderInstalledMods();
            });
        }

        item.querySelector('.remove-btn').addEventListener('click', async () => {
            await window.api.removeModFiles({ packPath: currentActivePack.path, files: mod.installedFiles });
            currentActivePack.mods = currentActivePack.mods.filter(m => m.ids.curseforge !== mod.ids.curseforge);
            if (pendingUpdates[mod.ids.curseforge]) delete pendingUpdates[mod.ids.curseforge];
            await window.api.savePackMetadata({ packPath: currentActivePack.path, metadata: currentActivePack });
            renderInstalledMods();
        });

        list.appendChild(item);
    });
}

document.getElementById('addModsToPackBtn').addEventListener('click', () => switchView('search'));

// SEARCH VIEW LOGIC
document.getElementById('searchBtn').addEventListener('click', () => {
    currentSearch = searchInput.value;
    currentPage = 1;
    performSearch();
});

document.getElementById('prevBtn').addEventListener('click', () => { if (currentPage > 1) { currentPage--; performSearch(); } });
document.getElementById('nextBtn').addEventListener('click', () => { if (currentPage < totalPages) { currentPage++; performSearch(); } });

async function performSearch() {
    resultsDiv.innerHTML = '<p class="loading">Searching across platforms...</p>';
    document.getElementById('paginationControls').classList.remove('hidden');

    const params = { query: currentSearch, version: versionSelect.value, loader: loaderSelect.value, page: currentPage };
    const response = await window.api.searchMods(params);
    
    if (response.error) {
        showError(`Search failed: ${response.error}`);
        resultsDiv.innerHTML = `<p class="empty">Search failed.</p>`;
        return;
    }

    totalPages = response.totalPages || 1;
    document.getElementById('pageInfo').innerText = `Page ${currentPage} of ${totalPages}`;
    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage === totalPages;
    
    renderResults(response.mods);
}

function renderResults(mods) {
    resultsDiv.innerHTML = '';

    if (!mods || mods.length === 0) {
        resultsDiv.innerHTML = '<p class="empty-message">No mods found.</p>';
        return;
    }

    mods.forEach(mod => {
        const card = document.createElement('div');
        card.className = 'mod-card';
        card.innerHTML = `
            <div class="mod-header" style="display: flex; gap: 15px; align-items: flex-start; margin-bottom: 15px;">
                <div class="mod-icons" style="display: flex; flex-direction: column; gap: 8px;">
                    ${mod.icons.curseforge ? `<img src="${mod.icons.curseforge}" class="mod-icon" alt="CF" title="CurseForge" style="width: 48px; height: 48px; border-radius: 8px;">` : ''}
                    ${mod.icons.modrinth ? `<img src="${mod.icons.modrinth}" class="mod-icon" alt="MR" title="Modrinth" style="width: 48px; height: 48px; border-radius: 8px;">` : ''}
                </div>
                <div class="mod-info" style="flex: 1;">
                    <h3 style="margin: 0 0 5px 0;">${mod.names.curseforge}</h3>
                    <p style="margin: 0 0 10px 0; font-size: 0.9em; color: #ccc; line-height: 1.4;">${mod.summary}</p>
                    <p style="margin: 0; font-size: 0.85em; color: var(--text-muted);">CF: ${mod.installedFiles.curseforge}</p>
                    <p style="margin: 0; font-size: 0.85em; color: var(--text-muted);">MR: ${mod.installedFiles.modrinth}</p>
                </div>
            </div>
            <div class="mod-actions"></div>
        `;

        const btn = document.createElement('button');
        btn.className = 'download-btn';
        btn.innerText = 'Download';

        const inPack = currentActivePack && currentActivePack.mods.some(m => m.ids.curseforge === mod.ids.curseforge);
        if (inPack) {
            btn.classList.add('in-pack');
            btn.innerText = 'Added to Pack';
        }

        btn.addEventListener('click', async () => {
            btn.innerText = 'Downloading...';
            btn.disabled = true;

            const result = await window.api.downloadMod({
                mod: mod,
                packPath: currentActivePack ? currentActivePack.path : null
            });

            if (result.success) {
                if (currentActivePack) {
                    if (!currentActivePack.mods.some(m => m.ids.curseforge === mod.ids.curseforge)) {
                        currentActivePack.mods.push({
                            ids: mod.ids,
                            names: mod.names,
                            installedFiles: mod.installedFiles,
                            links: mod.links,
                            icons: mod.icons,
                            fileLinks: mod.fileLinks,
                            summary: mod.summary,
                            dateAdded: Date.now()
                        });
                        await window.api.savePackMetadata({ packPath: currentActivePack.path, metadata: currentActivePack });
                    }
                    btn.classList.add('in-pack');
                    btn.innerText = 'Added to Pack';
                } else {
                    btn.innerText = 'Downloaded';
                }
            } else {
                btn.innerText = 'Download Failed';
                showError(`Failed: ${result.error}`);
            }
            btn.disabled = false;
        });

        card.querySelector('.mod-actions').appendChild(btn);
        resultsDiv.appendChild(card);
    });
}

function showError(message) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 5000);
}

document.getElementById('packSortSelect').addEventListener('change', (e) => {
    currentSortMode = e.target.value;
    renderInstalledMods();
});

document.getElementById('checkUpdatesBtn').addEventListener('click', async () => {
    const btn = document.getElementById('checkUpdatesBtn');
    btn.innerText = 'Checking...';
    btn.disabled = true;

    const res = await window.api.checkModUpdates({
        mods: currentActivePack.mods,
        version: currentActivePack.version || versionSelect.value, 
        loader: currentActivePack.loader || loaderSelect.value
    });

    if (res.success) {
        pendingUpdates = res.updates;
        const updateCount = Object.keys(pendingUpdates).length;
        
        document.getElementById('updateAllBtn').disabled = updateCount === 0;
        showError(updateCount > 0 ? `Found ${updateCount} updates!` : "All mods are up to date.");
        renderInstalledMods();
    } else {
        showError("Failed to check for updates.");
    }

    btn.innerText = 'Check Updates';
    btn.disabled = false;
});

document.getElementById('updateAllBtn').addEventListener('click', async () => {
    const btn = document.getElementById('updateAllBtn');
    btn.innerText = 'Updating All...';
    btn.disabled = true;

    const updateIds = Object.keys(pendingUpdates);
    for (const modId of updateIds) {
        const updateBtn = document.querySelector(`.update-btn[data-id="${modId}"]`);
        if (updateBtn) await updateBtn.click(); 
    }

    btn.innerText = 'Update All';
    btn.disabled = true;
});

// API KEYS LOGIC
document.getElementById('showApiKeysBtn').addEventListener('click', async () => {
    const keys = await window.api.getApiKeys();
    document.getElementById('cfKeyInput').value = keys.curseforge || '';
    document.getElementById('mrKeyInput').value = keys.modrinth || '';
    switchView('apiKeys');
});

document.getElementById('backFromApiKeysBtn').addEventListener('click', () => {
    switchView('home');
});

document.getElementById('saveApiKeysBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveApiKeysBtn');
    btn.innerText = 'Saving...';
    btn.disabled = true;

    const cf = document.getElementById('cfKeyInput').value.trim();
    const mr = document.getElementById('mrKeyInput').value.trim();
    
    const res = await window.api.saveApiKeys({ curseforge: cf, modrinth: mr });
    
    if (res.success) {
        btn.innerText = 'Saved!';
        setTimeout(() => { btn.innerText = 'Save API Keys'; btn.disabled = false; }, 2000);
    } else {
        showError("Failed to save API keys.");
        btn.innerText = 'Save API Keys';
        btn.disabled = false;
    }
});