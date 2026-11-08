// Blocked CurseForge downloads: opens the file's download page (in the viewer, or the browser on request) and reports
// when main has moved the downloaded file into the pack.
(() => {
    const { call } = Lib;
    let viewing = null;

    async function start(packPath, key, fileName, { browser = false } = {}) {
        try {
            const r = await call('packs:manual-download', { path: packPath, key });
            if (browser) {
                await call('shell:open', { url: r.url });
                UI.Island.toast('Download in Your Browser', `${r.fileName} goes into the pack once it’s in Downloads`);
                return;
            }
            viewing = { packPath, key: String(key) };
            PageViewer.open(r.url, { platform: 'curseforge', title: `Download ${r.fileName}` });
            UI.Island.toast('Downloading from CurseForge', `${r.fileName} starts in a few seconds`);
        } catch (err) { UI.Island.error(err); }
    }

    window.incursion.on(({ type, payload }) => {
        if (type !== 'cf-download') return;
        if (payload.ok) {
            UI.Island.toast('Added to Pack', `${payload.title || payload.fileName}`);
            if (viewing && viewing.packPath === payload.packPath && viewing.key === String(payload.key)) { viewing = null; PageViewer.close(); }
        } else UI.Island.error(payload.error || `${payload.fileName} wasn’t added.`);
    });

    window.CfDownload = { start };
})();
