const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const storage = require('./util/storage');
const apiUtils = require('./util/api');

apiUtils.updateApiHeaders();

function createWindow() {
    const win = new BrowserWindow({
        width: 1200, height: 800, frame: false, titleBarStyle: 'hidden', icon: path.join(__dirname, 'icon.svg'),
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

ipcMain.on('window-min', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.on('window-max', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { w.isMaximized() ? w.unmaximize() : w.maximize(); }});
ipcMain.on('window-close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });

ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-metadata-file', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON Metadata', extensions: ['json'] }] });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-global-packs', async () => await storage.getGlobalPacks());
ipcMain.handle('save-global-packs', async (event, packs) => await storage.saveGlobalPacks(packs));
ipcMain.handle('save-pack-metadata', async (event, { packPath, metadata }) => await storage.savePackMetadata(packPath, metadata));
ipcMain.handle('load-pack-metadata', async (event, packPath) => await storage.loadPackMetadata(packPath));
ipcMain.handle('remove-mod-files', async (event, { packPath, files }) => await storage.removeModFiles(packPath, files));
ipcMain.handle('clear-api-cache', async () => await apiUtils.clearCache());
ipcMain.handle('download-mod', async (event, { mod, packPath }) => await storage.downloadModFiles(mod, packPath));

ipcMain.handle('get-api-keys', async () => await apiUtils.updateApiHeaders());
ipcMain.handle('save-api-keys', async (event, keys) => {
    const res = await storage.saveSettings(keys);
    if (res.success) await apiUtils.updateApiHeaders();
    return res;
});

ipcMain.handle('get-versions', async () => await apiUtils.getVersions());
ipcMain.handle('search-mods', async (event, params) => await apiUtils.searchMods(params));
ipcMain.handle('sync-metadata', async (event, params) => await apiUtils.syncMetadata(params));

ipcMain.handle('check-mod-updates', async (event, params) => {
    return await apiUtils.checkModUpdates(params, (percent) => {
        event.sender.send('update-progress', percent);
    });
});