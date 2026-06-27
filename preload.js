const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    searchMods: (params) => ipcRenderer.invoke('search-mods', params),
    downloadMod: (params) => ipcRenderer.invoke('download-mod', params),
    getVersions: () => ipcRenderer.invoke('get-versions'),
    getLoaderVersions: (params) => ipcRenderer.invoke('get-loader-versions', params),
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    getGlobalPacks: () => ipcRenderer.invoke('get-global-packs'),
    saveGlobalPacks: (packs) => ipcRenderer.invoke('save-global-packs', packs),
    savePackMetadata: (data) => ipcRenderer.invoke('save-pack-metadata', data),
    loadPackMetadata: (packPath) => ipcRenderer.invoke('load-pack-metadata', packPath),
    
    savePendingUpdates: (data) => ipcRenderer.invoke('save-pending-updates', data),
    loadPendingUpdates: (packPath) => ipcRenderer.invoke('load-pending-updates', packPath),
    
    removeModFiles: (data) => ipcRenderer.invoke('remove-mod-files', data),

    onDownloadProgress: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('download-progress', handler);
        return () => ipcRenderer.removeListener('download-progress', handler);
    },
    onUpdateProgress: (callback) => {
        const handler = (event, percent) => callback(percent);
        ipcRenderer.on('update-progress', handler);
        return () => ipcRenderer.removeListener('update-progress', handler);
    },
    onExportProgress: (callback) => {
        const handler = (event, percent) => callback(percent);
        ipcRenderer.on('export-progress', handler);
        return () => ipcRenderer.removeListener('export-progress', handler);
    },

    minimizeWindow: () => ipcRenderer.send('window-min'),
    maximizeWindow: () => ipcRenderer.send('window-max'),
    closeWindow: () => ipcRenderer.send('window-close'),

    checkModUpdates: (params) => ipcRenderer.invoke('check-mod-updates', params),
    getApiKeys: () => ipcRenderer.invoke('get-api-keys'),
    saveApiKeys: (keys) => ipcRenderer.invoke('save-api-keys', keys),
    clearApiCache: () => ipcRenderer.invoke('clear-api-cache'),
    syncMetadata: (params) => ipcRenderer.invoke('sync-metadata', params),
    exportPackCF: (data) => ipcRenderer.invoke('export-pack-cf', data),
    exportPackMR: (data) => ipcRenderer.invoke('export-pack-mr', data)
});