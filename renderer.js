// --- WINDOW CONTROLS ---
document.getElementById('minBtn').addEventListener('click', () => window.api.minimizeWindow());
document.getElementById('maxBtn').addEventListener('click', () => window.api.maximizeWindow());
document.getElementById('closeBtn').addEventListener('click', () => window.api.closeWindow());

// --- GLOBAL NAVIGATION ---
document.getElementById('backToHomeBtn').addEventListener('click', () => {
    AppState.currentActivePack = null;
    UI.switchView('home', AppViews);
});

document.getElementById('backFromSearchBtn').addEventListener('click', () => {
    if (AppState.currentActivePack) {
        DetailsManager.openPackDetails(AppState.currentActivePack.path);
        UI.switchView('details', AppViews);
    } else {
        UI.switchView('home', AppViews);
    }
});

document.getElementById('backFromApiKeysBtn').addEventListener('click', () => {
    UI.switchView('home', AppViews);
});

// --- APP INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Initialize Sub-Managers
    HomeManager.init();
    DetailsManager.init();
    SearchManager.init();
    SettingsManager.init();

    // 2. Fetch Supported Versions from APIs
    const verRes = await window.api.getVersions();
    if (verRes.success && verRes.versions.length > 0) {
        const versionSelect = document.getElementById('versionSelect');
        const createVersionSelect = document.getElementById('createPackVersionSelect');
        versionSelect.innerHTML = '';
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

    // 3. Load Saved Packs
    AppState.globalPacks = await window.api.getGlobalPacks();
    HomeManager.renderPacksList();
});