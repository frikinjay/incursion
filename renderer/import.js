(() => {
    const { h, icon, call, fmt, LOADERS } = Lib;

    async function start(kind) {
        let picked;
        try {
            if (kind === 'link') {
                const url = await UI.prompt({ title: 'Open a Modpack Link', message: 'Paste a Modrinth or CurseForge modpack page, a link to a .mrpack or .zip file, or a packwiz pack.toml link.', placeholder: 'https://modrinth.com/modpack/…', confirmLabel: 'Open' });
                if (!url?.trim()) return;
                picked = await call('import:link', { url: url.trim() });
            } else picked = await call('import:pick', { kind });
        }
        catch (err) { return UI.Island.error(err); }
        if (!picked) return;
        const { source, info } = picked;

        const name = h('input.field', { value: info.name || 'Imported Pack', spellcheck: false });
        const gameSel = h('select.field');
        const loaderSel = h('select.field', Object.entries(LOADERS).map(([v, l]) => h('option', { value: v }, l)));
        const loaderVer = h('select.field', h('option', { value: info.loaderVersion || '' }, info.loaderVersion || 'Loading…'));
        const folder = h('input.field', { readonly: true, placeholder: 'Choose where the new pack is stored' });
        const err = h('p.err-text.hidden');
        let target = '';
        loaderSel.value = info.loader || 'fabric';

        try {
            const versions = await App.gameVersions();
            gameSel.replaceChildren(...versions.map(v => h('option', { value: v }, v)));
            if (info.gameVersion && !versions.includes(info.gameVersion)) gameSel.prepend(h('option', { value: info.gameVersion }, info.gameVersion));
            gameSel.value = info.gameVersion || versions[0];
        } catch {}
        const loadLoaders = async () => {
            try {
                const list = await call('versions:loader', { loader: loaderSel.value, gameVersion: gameSel.value });
                const keep = info.loaderVersion && loaderSel.value === info.loader ? info.loaderVersion : null;
                loaderVer.replaceChildren(...list.slice(0, 200).map(v => h('option', { value: v.version }, v.version)));
                if (keep && !list.some(v => v.version === keep)) loaderVer.prepend(h('option', { value: keep }, keep));
                loaderVer.value = keep || (list.find(v => v.stable) || list[0])?.version || '';
            } catch {}
        };
        gameSel.addEventListener('change', loadLoaders);
        loaderSel.addEventListener('change', loadLoaders);
        loadLoaders();

        const kindLabel = { mrpack: 'Modrinth Modpack', curseforge: 'CurseForge Modpack', folder: 'Mods Folder', prism: 'Prism Launcher or MultiMC Instance', packwiz: 'packwiz Pack' }[info.kind] || 'Modpack';
        const go = h('button.btn.primary', icon('import'), 'Import');
        const d = UI.dialog({ content: [
            h('div.dialog-body',
                h('h2', `Import ${kindLabel}`),
                h('p', `${info.modCount == null ? 'Its files are' : `${fmt.plural(info.modCount, 'item')} found in ${source.split(/[\\/]/).pop()}. Each one is`} matched on both Modrinth and CurseForge by its exact file, so the new pack has both editions.`),
                info.incursion ? h('p.hint', `Made with Incursion: its details${info.incursion.releases ? `, ${info.incursion.releases} releases` : ''} and each mod’s pinned, optional, side and notes settings come along.`) : null,
                h('div.form-grid',
                    h('div.full', h('label.label', 'Pack Name'), name),
                    h('div', h('label.label', 'Minecraft'), gameSel),
                    h('div', h('label.label', 'Loader'), loaderSel),
                    h('div.full', h('label.label', 'Loader Version'), loaderVer),
                    h('div.full', h('label.label', 'Folder for the New Pack'), h('div.path-pick', folder,
                        h('button.btn', { on: { click: async () => {
                            const dir = await call('dialog:folder', { title: 'Choose a Folder for the Imported Pack' });
                            if (dir) { target = dir; folder.value = dir; }
                        } } }, icon('folder'), 'Choose…')),
                        h('p.hint', 'Use an empty folder. Mods available on only one platform are imported for that platform; files found on neither are kept in overrides/mods.'))),
                err),
            h('div.dialog-foot', h('button.btn', { on: { click: () => d.close() } }, 'Cancel'), go)
        ] });

        go.addEventListener('click', async () => {
            err.classList.add('hidden');
            if (!target) { err.textContent = 'Choose a folder for the new pack.'; err.classList.remove('hidden'); return; }
            go.disabled = true;
            go.replaceChildren(h('span.spinner'), 'Importing…');
            try {
                const r = await call('import:run', { source, target, name: name.value.trim(), gameVersion: gameSel.value, loader: loaderSel.value, loaderVersion: loaderVer.value });
                d.close();
                App.freshPacks.add(r.path);
                await App.refreshLibrary();
                UI.Island.toast(`Imported ${fmt.plural(r.imported, 'Mod', 'Mods')}`, r.unknown.length ? `${r.unknown.length} unmatched, kept in overrides` : `${r.both} on both platforms`);
                App.go({ name: 'pack', path: r.path });
            } catch (e) {
                err.textContent = e.message; err.classList.remove('hidden');
                go.disabled = false; go.replaceChildren(icon('import'), 'Import');
            }
        });
    }

    window.Importer = { start };
})();
