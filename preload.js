const { contextBridge, ipcRenderer } = require('electron');

// Allow-listed bridge. Every call resolves to { ok, data } or { ok: false, error }.
const CHANNELS = new Set([
    'app:info', 'app:theme', 'app:ready', 'app:setup-done',
    'settings:get', 'settings:keys', 'settings:check',
    'cache:stats', 'cache:clear',
    'versions:game', 'versions:loader',
    'dialog:folder', 'dialog:icon',
    'shell:open', 'shell:reveal',
    'packs:library', 'packs:create', 'packs:import', 'packs:forget', 'packs:load', 'packs:info',
    'packs:add', 'packs:remove', 'packs:check', 'packs:apply', 'packs:redownload', 'packs:sync', 'packs:export',
    'mods:search', 'settings:prefs', 'dialog:background', 'dialog:java',
    'links:set', 'links:clear', 'links:info', 'links:settle', 'mods:changelog', 'community:status', 'community:refresh',
    'java:list', 'java:required', 'java:install', 'java:uninstall', 'java:dir',
    'data:info', 'data:inspect', 'data:set-dir',
    'web:open', 'web:bounds', 'web:nav', 'web:close',
    'cfservice:status', 'cfservice:set', 'cfservice:verify', 'cfservice:forget',
    'backups:list', 'backups:create', 'backups:restore', 'backups:delete', 'backups:reveal',
    'packs:versions', 'packs:set-version', 'packs:mod-meta', 'packs:disable', 'packs:deps', 'packs:release', 'packs:merge',
    'packs:untracked', 'packs:untracked-refresh', 'packs:adopt', 'packs:trash-jars', 'packs:manual-file', 'packs:manual-remove',
    'import:pick', 'import:link', 'import:run',
    'files:list', 'files:read', 'files:write', 'files:create', 'files:rename', 'files:delete', 'files:reveal', 'files:to-overrides',
    'publish:check', 'publish:run', 'publish:server', 'packs:server-preview',
    'play:accounts', 'play:login', 'play:login-offline', 'play:select', 'play:logout', 'play:list', 'play:launch',
    'play:stop', 'play:repair', 'play:analyse', 'play:subscribe', 'play:unsubscribe', 'play:clear', 'play:folder'
]);

const themeArg = (process.argv || []).find(a => a.startsWith('--incursion-theme='));

contextBridge.exposeInMainWorld('incursion', {
    platform: process.platform,
    initialTheme: themeArg ? themeArg.split('=')[1] : null,
    invoke: (channel, payload) => {
        if (!CHANNELS.has(channel)) return Promise.resolve({ ok: false, error: `Unknown channel ${channel}` });
        return ipcRenderer.invoke(channel, payload);
    },
    on: (callback) => {
        const handler = (_e, msg) => callback(msg);
        ipcRenderer.on('event', handler);
        return () => ipcRenderer.removeListener('event', handler);
    }
});
