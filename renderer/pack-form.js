(() => {
    const { h, img, icon, call, fmt, LOADERS } = Lib;

    function open({ mode, snapshot }) {
        const edit = mode === 'edit';
        const meta = edit ? snapshot.meta : {};
        // With content, a new Minecraft version or loader moves every mod to its file for the new target (packs.retarget).
        const hasContent = edit && meta.mods.length > 0;
        let iconData = meta.icon || null;
        let folder = '';

        const name = h('input.field', { value: meta.name || '', placeholder: 'My pack', spellcheck: false });
        const version = h('input.field', { value: meta.version || '1.0.0', spellcheck: false });
        const author = h('input.field', { value: meta.author || '', placeholder: 'Optional', spellcheck: false });
        const desc = h('textarea.field', { placeholder: 'What is this pack about?' });
        desc.value = meta.description || '';
        const gameSel = h('select.field', { disabled: true }, h('option', 'Loading…'));
        const loaderSel = h('select.field', Object.entries(LOADERS).map(([v, l]) => h('option', { value: v }, l)));
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
                gameSel.disabled = false;
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
        const moveNote = h('p.hint.full.hidden', { style: { marginTop: '-6px' } });
        const noteMove = () => {
            const game = gameSel.value !== meta.gameVersion, loader = loaderSel.value !== meta.loader;
            const moving = hasContent && (game || loader);
            const to = [loader ? LOADERS[loaderSel.value] : null, game ? `Minecraft ${gameSel.value}` : null].filter(Boolean).join(' and ');
            moveNote.textContent = moving ? `Every mod moves to its file for ${to}. You’ll see which ones have none before anything changes.` : '';
            moveNote.classList.toggle('hidden', !moving);
        };
        gameSel.addEventListener('change', noteMove);
        loaderSel.addEventListener('change', noteMove);
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
                if (edit && hasContent && (fields.gameVersion !== meta.gameVersion || fields.loader !== meta.loader)) return await move(fields);
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

        const listOf = (names, max = 6) => (names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', '));

        // Shows what a version or loader change would do, then saves the other fields and moves the pack in the background.
        async function move(fields) {
            const label = save.textContent;
            save.textContent = 'Checking Mods…';
            try {
                const plan = await call('packs:retarget', { path: meta.path, gameVersion: fields.gameVersion, loader: fields.loader, loaderVersion: fields.loaderVersion, dryRun: true });
                const to = plan.target;
                const parts = [`${fmt.plural(plan.moving, 'mod')} will switch to ${plan.moving === 1 ? 'its' : 'their'} files for ${to}${plan.unchanged ? ` (${plan.unchanged} already work)` : ''}, with ${LOADERS[plan.loader]} ${plan.loaderVersion}.`];
                if (plan.missing.length) parts.push(`${fmt.plural(plan.missing.length, 'mod')} ${plan.missing.length === 1 ? 'has' : 'have'} no file for ${to} and will be turned off and marked incompatible: ${listOf(plan.missing.map(m => m.title))}.`);
                if (plan.toDownload?.length) parts.push(`${fmt.plural(plan.toDownload.length, 'mod')} can’t be downloaded by apps on CurseForge, so you’ll download ${plan.toDownload.length === 1 ? 'its file' : 'their files'} yourself afterwards: ${listOf(plan.toDownload)}.`);
                if (plan.handAdded.length) parts.push(`Files added by hand stay as they are, so check them yourself: ${listOf(plan.handAdded)}.`);
                parts.push('Nothing changes if a download fails.');
                const ok = await UI.confirm({ title: `Move ${meta.name} to ${to}?`, message: parts.join(' '), confirmLabel: 'Move Pack' });
                if (!ok) { save.textContent = label; save.disabled = false; return; }
                const { gameVersion, loader, loaderVersion, ...rest } = fields;
                await call('packs:info', { path: meta.path, fields: rest });
                d.close();
                call('packs:retarget', { path: meta.path, gameVersion, loader, loaderVersion })
                    .then(r => UI.Island.toast(`Moved to ${r.target}`, r.missing.length ? `${fmt.plural(r.missing.length, 'mod')} turned off` : `${fmt.plural(r.moving, 'mod')} moved`))
                    .catch(UI.Island.error);
            } catch (e) { save.textContent = label; save.disabled = false; showErr(e.message); }
        }

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
                        moveNote,
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

    // p: { path, name }. The copy goes into a new folder named after it, next to the original unless another place is
    // chosen.
    function duplicate(p) {
        const parentOf = (x) => x.replace(/[\\/][^\\/]+[\\/]?$/, '');
        let parent = parentOf(p.path);
        const name = h('input.field', { value: `${p.name} Copy`, spellcheck: false });
        const where = h('input.field', { readonly: true, value: parent });
        const err = h('p.err-text.hidden');
        const go = h('button.btn.primary', 'Duplicate');
        const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); };
        go.addEventListener('click', async () => {
            const title = name.value.trim();
            if (!title) { name.focus(); return showErr('Give the copy a name.'); }
            go.disabled = true;
            d.close();
            try {
                const dest = await call('packs:duplicate', { path: p.path, name: title, parent });
                await App.refreshLibrary();
                App.freshPacks.add(dest);
                UI.Island.toast('Pack Duplicated', title);
            } catch (e) { UI.Island.error(e); }
        });
        name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
        const d = UI.dialog({
            content: [
                h('div.dialog-body',
                    h('h2', 'Duplicate Pack'),
                    h('p', 'Copies the pack with all its files, configs and settings. Worlds and saves in its game folder aren’t copied.'),
                    h('div.form-grid',
                        h('div.full', h('label.label', 'Name'), name),
                        h('div.full', h('label.label', 'Location'), h('div.path-pick', where,
                            h('button.btn', { on: { click: async () => {
                                const dir = await call('dialog:folder', { title: 'Choose Where the Copy Goes' });
                                if (dir) { parent = dir; where.value = dir; }
                            } } }, icon('folder'), 'Choose…')),
                            h('p.hint', 'Incursion makes a new folder for the copy here. Publishing projects aren’t copied, so a release can’t land on the original’s pages.'))),
                    err),
                h('div.dialog-foot', h('button.btn', { on: { click: () => d.close() } }, 'Cancel'), go)
            ]
        });
        setTimeout(() => { name.focus(); name.select(); }, 80);
    }

    window.PackForm = { open, duplicate };
})();
