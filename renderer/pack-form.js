(() => {
    const { h, img, icon, call, LOADERS } = Lib;

    function open({ mode, snapshot }) {
        const edit = mode === 'edit';
        const meta = edit ? snapshot.meta : {};
        const locked = edit && meta.mods.length > 0;   // version / loader can't change under existing mods
        let iconData = meta.icon || null;
        let folder = '';

        const name = h('input.field', { value: meta.name || '', placeholder: 'My pack', spellcheck: false });
        const version = h('input.field', { value: meta.version || '1.0.0', spellcheck: false });
        const author = h('input.field', { value: meta.author || '', placeholder: 'Optional', spellcheck: false });
        const desc = h('textarea.field', { placeholder: 'What is this pack about?' });
        desc.value = meta.description || '';
        const gameSel = h('select.field', { disabled: true }, h('option', 'Loading…'));
        const loaderSel = h('select.field', { disabled: locked }, Object.entries(LOADERS).map(([v, l]) => h('option', { value: v }, l)));
        loaderSel.value = meta.loader || 'fabric';
        const loaderVerSel = h('select.field', { disabled: true }, h('option', 'Loading…'));
        const folderField = h('input.field', { readonly: true, placeholder: 'Choose where the pack is stored' });

        const preview = img(iconData, 'squircle');
        const err = h('p.err-text.hidden');
        const save = h('button.btn.primary', edit ? 'Save Changes' : 'Create Pack');

        async function loadGameVersions() {
            try {
                const versions = await App.gameVersions();
                gameSel.replaceChildren(...versions.map(v => h('option', { value: v }, v)));
                gameSel.value = meta.gameVersion && versions.includes(meta.gameVersion) ? meta.gameVersion : versions[0];
                if (meta.gameVersion && !versions.includes(meta.gameVersion)) { gameSel.prepend(h('option', { value: meta.gameVersion }, meta.gameVersion)); gameSel.value = meta.gameVersion; }
                gameSel.disabled = locked;
                loadLoaderVersions();
            } catch (e) {
                gameSel.replaceChildren(h('option', 'Couldn’t Load Versions'));
                showErr(`Couldn't load Minecraft versions: ${e.message}`);
            }
        }

        let lvToken = 0;
        async function loadLoaderVersions() {
            const token = ++lvToken;
            loaderVerSel.disabled = true;
            loaderVerSel.replaceChildren(h('option', 'Loading…'));
            try {
                const list = await call('versions:loader', { loader: loaderSel.value, gameVersion: gameSel.value });
                if (token !== lvToken) return;
                if (!list.length) {
                    loaderVerSel.replaceChildren(h('option', { value: '' }, `No ${LOADERS[loaderSel.value]} builds for ${gameSel.value}`));
                    return;
                }
                const recommended = list.find(v => v.stable) || list[0];
                loaderVerSel.replaceChildren(...list.slice(0, 200).map(v => h('option', { value: v.version }, `${v.version}${v === recommended ? '  (recommended)' : v.stable ? '' : '  (beta)'}`)));
                loaderVerSel.value = meta.loaderVersion && list.some(v => v.version === meta.loaderVersion) && loaderSel.value === meta.loader ? meta.loaderVersion : recommended.version;
                loaderVerSel.disabled = false;
            } catch (e) {
                if (token !== lvToken) return;
                loaderVerSel.replaceChildren(h('option', { value: meta.loaderVersion || '' }, meta.loaderVersion || 'Unavailable'));
                showErr(`Couldn't load loader versions: ${e.message}`);
            }
        }
        gameSel.addEventListener('change', loadLoaderVersions);
        loaderSel.addEventListener('change', loadLoaderVersions);

        const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); };

        save.addEventListener('click', async () => {
            err.classList.add('hidden');
            const fields = {
                name: name.value.trim(), version: version.value.trim() || '1.0.0', author: author.value.trim(), description: desc.value.trim(),
                gameVersion: gameSel.value, loader: loaderSel.value, loaderVersion: loaderVerSel.value, icon: iconData
            };
            if (!fields.name) { name.focus(); return showErr('Give the pack a name.'); }
            if (!edit && !folder) return showErr('Choose a folder for the pack.');
            save.disabled = true;
            try {
                if (edit) {
                    await call('packs:info', { path: meta.path, fields });
                    UI.Island.toast('Changes Saved', fields.name);
                    d.close();
                } else {
                    const p = await call('packs:create', { ...fields, path: folder });
                    await App.refreshLibrary();
                    d.close();
                    UI.Island.toast('Pack Created', fields.name);
                    App.freshPacks.add(p);
                    App.go({ name: 'pack', path: p });
                }
            } catch (e) { showErr(e.message); save.disabled = false; }
        });

        const d = UI.dialog({
            content: [
                h('div.dialog-body',
                    h('h2', edit ? 'Edit Pack' : 'New Pack'),
                    h('p', edit ? 'Changes apply to both the CurseForge and Modrinth editions.' : 'One pack, published to CurseForge and Modrinth.'),
                    h('div.form-grid',
                        h('div.full.icon-pick', preview,
                            h('div',
                                h('button.btn', { on: { click: async () => {
                                    try { const data = await call('dialog:icon'); if (data) { iconData = data; preview.src = data; } }
                                    catch (e) { showErr(e.message); }
                                } } }, 'Choose Icon…'),
                                h('p.hint', 'Square images look best. Resized to 256 px.'))),
                        h('div.full', h('label.label', 'Name'), name),
                        h('div', h('label.label', 'Pack Version'), version),
                        h('div', h('label.label', 'Author'), author),
                        h('div.full', h('label.label', 'Description'), desc),
                        h('div', h('label.label', 'Minecraft'), gameSel),
                        h('div', h('label.label', 'Loader'), loaderSel),
                        h('div.full', h('label.label', 'Loader Version'), loaderVerSel),
                        locked ? h('p.hint.full', { style: { marginTop: '-6px' } }, 'The Minecraft version and loader can’t be changed once the pack has content.') : null,
                        !edit ? h('div.full', h('label.label', 'Folder'), h('div.path-pick', folderField,
                            h('button.btn', { on: { click: async () => {
                                const dir = await call('dialog:folder', { title: 'Choose a Folder for the Pack' });
                                if (dir) { folder = dir; folderField.value = dir; }
                            } } }, icon('folder'), 'Choose…')),
                            h('p.hint', 'Incursion creates curseforge/ and modrinth/ folders inside it. Configs in overrides/ are included in every export.')) : null),
                    err),
                h('div.dialog-foot', h('button.btn', { on: { click: () => d.close() } }, 'Cancel'), save)
            ]
        });
        setTimeout(() => name.focus(), 80);
        loadGameVersions();
    }

    window.PackForm = { open };
})();
