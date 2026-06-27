const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    searchMods: (params) => ipcRenderer.invoke('search-mods', params),
    downloadMod: (params) => ipcRenderer.invoke('download-mod', params),
    getVersions: () => ipcRenderer.invoke('get-versions'),
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    selectMetadataFile: () => ipcRenderer.invoke('select-metadata-file'),
    getGlobalPacks: () => ipcRenderer.invoke('get-global-packs'),
    saveGlobalPacks: (packs) => ipcRenderer.invoke('save-global-packs', packs),
    savePackMetadata: (data) => ipcRenderer.invoke('save-pack-metadata', data),
    loadPackMetadata: (packPath) => ipcRenderer.invoke('load-pack-metadata', packPath),
    removeModFiles: (data) => ipcRenderer.invoke('remove-mod-files', data),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
    onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, percent) => callback(percent)),
    minimizeWindow: () => ipcRenderer.send('window-min'),
    maximizeWindow: () => ipcRenderer.send('window-max'),
    closeWindow: () => ipcRenderer.send('window-close'),
    checkModUpdates: (params) => ipcRenderer.invoke('check-mod-updates', params),
    getApiKeys: () => ipcRenderer.invoke('get-api-keys'),
    saveApiKeys: (keys) => ipcRenderer.invoke('save-api-keys', keys),
    clearApiCache: () => ipcRenderer.invoke('clear-api-cache'),
    syncMetadata: (params) => ipcRenderer.invoke('sync-metadata', params)
});