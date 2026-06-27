window.AppState = {
    globalPacks: [],
    currentActivePack: null,
    pendingUpdates: {},
    currentSortMode: 'name-asc',
    
    // Modal
    isEditing: false,
    editingPackPath: null,
    chosenIconBase64: null,
    
    // Filter
    installedSearchQuery: "",
    installedEnvFilter: "all",
    installedPlatformFilter: "all",
    
    // Search
    search: { 
        query: "", 
        page: 1, 
        totalPages: 1,
        platform: "both"
    }
};

window.AppViews = {
    home: document.getElementById('homeView'),
    details: document.getElementById('packDetailsScreen'),
    search: document.getElementById('searchView'),
    apiKeys: document.getElementById('apiKeysView')
};