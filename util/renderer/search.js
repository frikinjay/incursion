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
        document.getElementById('refreshSearchCacheBtn').addEventListener('click', async () => {
            const btn = document.getElementById('refreshSearchCacheBtn');
            btn.innerText = 'Clearing...'; btn.disabled = true;
            await window.api.clearApiCache();
            UI.showError("Cache Cleared! Re-running search...");
            SearchManager.performSearch(); 
            btn.innerText = 'Refresh Cache'; btn.disabled = false;
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
            page: AppState.search.page,
            platform: AppState.search.platform
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
        if (!mods || mods.length === 0) { resultsDiv.innerHTML = '<p class="empty-message">No mods found.</p>'; return; }

        mods.forEach(mod => {
            const card = document.createElement('div');
            card.className = 'mod-card';
            
            const hasCF = !!mod.ids.curseforge;
            const hasMR = !!mod.ids.modrinth;
            const title = (hasCF ? mod.names.curseforge : mod.names.modrinth) || "Unknown Mod";
            
            let badgesHtml = '';
            if (hasCF && hasMR) badgesHtml = '<span class="platform-badge both">Both</span>';
            else if (hasCF) badgesHtml = '<span class="platform-badge cf">CurseForge Only</span>';
            else if (hasMR) badgesHtml = '<span class="platform-badge mr">Modrinth Only</span>';

            card.innerHTML = `
                <div class="mod-header" style="display: flex; gap: 15px; align-items: flex-start; margin-bottom: 15px;">
                    <div class="mod-icons" style="display: flex; flex-direction: column; gap: 8px;">
                        ${hasCF && mod.icons.curseforge ? `<img src="${mod.icons.curseforge}" class="mod-icon" style="width: 48px; height: 48px; border-radius: 8px;">` : ''}
                        ${hasMR && mod.icons.modrinth ? `<img src="${mod.icons.modrinth}" class="mod-icon" style="width: 48px; height: 48px; border-radius: 8px;">` : ''}
                    </div>
                    <div class="mod-info" style="flex: 1;">
                        <h3 style="margin: 0 0 5px 0; display: flex; align-items: center; gap: 10px;">
                            ${title} ${badgesHtml}
                        </h3>
                        <p style="margin: 0 0 5px 0; font-size: 0.85em; color: var(--accent-primary);">
                            By: ${hasCF ? `${mod.authors.curseforge} (CF)` : ''} ${hasCF && hasMR ? '|' : ''} ${hasMR ? `${mod.authors.modrinth} (MR)` : ''}
                        </p>
                        <p style="margin: 0 0 10px 0; font-size: 0.9em; color: #ccc; line-height: 1.4;">${mod.summary}</p>
                        
                        ${hasCF ? `<p style="margin: 0; font-size: 0.85em; color: var(--text-muted);">CF: ${mod.installedFiles.curseforge}</p>` : ''}
                        ${hasMR ? `<p style="margin: 0; font-size: 0.85em; color: var(--text-muted);">MR: ${mod.installedFiles.modrinth}</p>` : ''}
                        
                        <small style="display: flex; gap: 8px; margin-top: 10px; align-items: center;">
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
                    </div>
                </div>
                <div class="mod-actions"></div>
            `;

            const btn = document.createElement('button');
            btn.className = 'download-btn';
            btn.innerText = 'Download';

            const uniqueId = mod.ids.curseforge || mod.ids.modrinth;
            const inPack = AppState.currentActivePack && AppState.currentActivePack.mods.some(m => (m.ids.curseforge === uniqueId) || (m.ids.modrinth === uniqueId));
            
            if (inPack) { btn.classList.add('in-pack'); btn.innerText = 'Added to Pack'; }

            btn.addEventListener('click', async () => {
                btn.innerText = 'Downloading...'; btn.disabled = true;
                const result = await window.api.downloadMod({ mod: mod, packPath: AppState.currentActivePack ? AppState.currentActivePack.path : null });

                if (result.success) {
                    if (AppState.currentActivePack) {
                        if (!AppState.currentActivePack.mods.some(m => (m.ids.curseforge === uniqueId) || (m.ids.modrinth === uniqueId))) {
                            AppState.currentActivePack.mods.push({
                                ids: mod.ids, names: mod.names, authors: mod.authors, environments: mod.environments, 
                                installedFiles: mod.installedFiles, links: mod.links, icons: mod.icons, fileLinks: mod.fileLinks,
                                summary: mod.summary, dateAdded: Date.now()
                            });
                            await window.api.savePackMetadata({ packPath: AppState.currentActivePack.path, metadata: AppState.currentActivePack });
                        }
                        btn.classList.add('in-pack'); btn.innerText = 'Added to Pack';
                    } else { btn.innerText = 'Downloaded'; }
                } else { btn.innerText = 'Download Failed'; UI.showError(`Failed: ${result.error}`); }
                btn.disabled = false;
            });

            card.querySelectorAll('.copy-link-btn').forEach(copyBtn => {
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); navigator.clipboard.writeText(copyBtn.dataset.url); UI.showError("Link copied to clipboard!");
                });
            });

            card.querySelector('.mod-actions').appendChild(btn);
            resultsDiv.appendChild(card);
        });
    }
};