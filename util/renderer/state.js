// Global Application State
window.AppState = {
    globalPacks: [],
    currentActivePack: null,
    pendingUpdates: {},
    currentSortMode: 'name-asc',
    search: { 
        query: "", 
        page: 1, 
        totalPages: 1 
    }
};

// Global DOM Views Cache
window.AppViews = {
    home: document.getElementById('homeView'),
    details: document.getElementById('packDetailsScreen'),
    search: document.getElementById('searchView'),
    apiKeys: document.getElementById('apiKeysView')
};