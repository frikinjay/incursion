const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    searchMods: (params) => ipcRenderer.invoke('search-mods', params),
    downloadMod: (params) => ipcRenderer.invoke('download-mod', params),
    getVersions: () => ipcRenderer.invoke('get-versions'),
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    getGlobalPacks: () => ipcRenderer.invoke('get-global-packs'),
    saveGlobalPacks: (packs) => ipcRenderer.invoke('save-global-packs', packs),
    savePackMetadata: (data) => ipcRenderer.invoke('save-pack-metadata', data),
    loadPackMetadata: (packPath) => ipcRenderer.invoke('load-pack-metadata', packPath),
    removeModFiles: (data) => ipcRenderer.invoke('remove-mod-files', data),
    
    // Progress Listeners
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
    onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, percent) => callback(percent)), 
    
    // Window Controls
    minimizeWindow: () => ipcRenderer.send('window-min'),
    maximizeWindow: () => ipcRenderer.send('window-max'),
    closeWindow: () => ipcRenderer.send('window-close'),
    
    // APIs & Exports
    checkModUpdates: (params) => ipcRenderer.invoke('check-mod-updates', params),
    getApiKeys: () => ipcRenderer.invoke('get-api-keys'),
    saveApiKeys: (keys) => ipcRenderer.invoke('save-api-keys', keys),
    clearApiCache: () => ipcRenderer.invoke('clear-api-cache'),
    syncMetadata: (params) => ipcRenderer.invoke('sync-metadata', params),
    exportPackCF: (data) => ipcRenderer.invoke('export-pack-cf', data),
    exportPackMR: (data) => ipcRenderer.invoke('export-pack-mr', data)
});