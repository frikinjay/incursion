window.SearchManager = {
    init: () => {
        document.getElementById('searchBtn').addEventListener('click', () => {
            AppState.search.query = document.getElementById('searchInput').value;
            AppState.search.page = 1;
            SearchManager.performSearch();
        });

        document.getElementById('prevBtn').addEventListener('click', () => { 
            if (AppState.search.page > 1) { AppState.search.page--; SearchManager.performSearch(); } 
        });
        
        document.getElementById('nextBtn').addEventListener('click', () => { 
            if (AppState.search.page < AppState.search.totalPages) { AppState.search.page++; SearchManager.performSearch(); } 
        });
    },

    performSearch: async () => {
        const resultsDiv = document.getElementById('resultsDiv');
        resultsDiv.innerHTML = '<p class="loading">Searching across platforms...</p>';
        document.getElementById('paginationControls').classList.remove('hidden');

        const params = { 
            query: AppState.search.query, 
            version: document.getElementById('versionSelect').value, 
            loader: document.getElementById('loaderSelect').value, 
            page: AppState.search.page 
        };
        
        const response = await window.api.searchMods(params);
        
        if (response.error) {
            UI.showError(`Search failed: ${response.error}`);
            resultsDiv.innerHTML = `<p class="empty">Search failed.</p>`;
            return;
        }

        AppState.search.totalPages = response.totalPages || 1;
        document.getElementById('pageInfo').innerText = `Page ${AppState.search.page} of ${AppState.search.totalPages}`;
        document.getElementById('prevBtn').disabled = AppState.search.page === 1;
        document.getElementById('nextBtn').disabled = AppState.search.page === AppState.search.totalPages;
        
        SearchManager.renderResults(response.mods);
    },

    renderResults: (mods) => {
        const resultsDiv = document.getElementById('resultsDiv');
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
                        ${mod.icons.curseforge ? `<img src="${mod.icons.curseforge}" class="mod-icon" style="width: 48px; height: 48px; border-radius: 8px;">` : ''}
                        ${mod.icons.modrinth ? `<img src="${mod.icons.modrinth}" class="mod-icon" style="width: 48px; height: 48px; border-radius: 8px;">` : ''}
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

            const inPack = AppState.currentActivePack && AppState.currentActivePack.mods.some(m => m.ids.curseforge === mod.ids.curseforge);
            if (inPack) {
                btn.classList.add('in-pack');
                btn.innerText = 'Added to Pack';
            }

            btn.addEventListener('click', async () => {
                btn.innerText = 'Downloading...';
                btn.disabled = true;

                const result = await window.api.downloadMod({
                    mod: mod,
                    packPath: AppState.currentActivePack ? AppState.currentActivePack.path : null
                });

                if (result.success) {
                    if (AppState.currentActivePack) {
                        if (!AppState.currentActivePack.mods.some(m => m.ids.curseforge === mod.ids.curseforge)) {
                            AppState.currentActivePack.mods.push({
                                ids: mod.ids,
                                names: mod.names,
                                installedFiles: mod.installedFiles,
                                links: mod.links,
                                icons: mod.icons,
                                fileLinks: mod.fileLinks,
                                summary: mod.summary,
                                dateAdded: Date.now()
                            });
                            await window.api.savePackMetadata({ packPath: AppState.currentActivePack.path, metadata: AppState.currentActivePack });
                        }
                        btn.classList.add('in-pack');
                        btn.innerText = 'Added to Pack';
                    } else {
                        btn.innerText = 'Downloaded';
                    }
                } else {
                    btn.innerText = 'Download Failed';
                    UI.showError(`Failed: ${result.error}`);
                }
                btn.disabled = false;
            });

            card.querySelector('.mod-actions').appendChild(btn);
            resultsDiv.appendChild(card);
        });
    }
};