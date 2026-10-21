(() => {
    const { h, icon, call, fmt, rafThrottle } = Lib;
    const TEXT_EXT = /\.(json5?|jsonc|mcmeta|snbt|nbt|toml|cfg|properties|ini|txt|lang|ya?ml|js|mjs|ts|zs|md|csv|conf|options|xml|html|css|log)$/i;

    const FilesTab = {
        mount(container, snap) {
            const pack = snap.meta.path;
            let root = 'pack';
            let current = null;
            const expanded = new Set(['overrides', 'overrides/config']);
            const children = new Map();

            const rootSeg = UI.segmented([{ value: 'pack', label: 'Pack Folder' }, { value: 'game', label: 'Game Folder' }], root, async (v) => {
                if (!(await confirmDiscard())) { rootSeg.set(root); return; }
                root = v; children.clear(); expanded.clear(); if (v === 'pack') { expanded.add('overrides'); expanded.add('overrides/config'); }
                closeEditor(); load('');
                hint.textContent = v === 'pack'
                    ? 'Files in overrides/ are included in every export. The mod folders are managed by Incursion.'
                    : 'The folder Minecraft uses when you play this pack. Copy configs to overrides/ to include them in exports.';
            });
            const list = h('div.tree-list', { role: 'tree' });
            const hint = h('p.hint', { style: { margin: '2px 4px 0' } }, 'Files in overrides/ are included in every export. The mod folders are managed by Incursion.');
            const tree = h('section.tree',
                h('div.tree-head',
                    rootSeg,
                    h('div.row-flex', { style: { gap: '4px' } },
                        h('button.btn.ghost.sm', { title: 'New File', on: { click: () => newItem(false) } }, icon('plus'), 'File'),
                        h('button.btn.ghost.sm', { title: 'New Folder', on: { click: () => newItem(true) } }, icon('folder'), 'Folder'),
                        h('span.grow'),
                        h('button.btn.ghost.sm.icon', { title: 'Refresh', on: { click: () => { children.clear(); load(''); } } }, icon('refresh')),
                        h('button.btn.ghost.sm.icon', { title: 'Show in Folder', on: { click: () => call('files:reveal', { pack, root, path: current?.path || '' }) } }, icon('external'))),
                    hint),
                list);

            async function load(rel) {
                try { children.set(rel, await call('files:list', { pack, root, path: rel })); }
                catch (err) { children.set(rel, []); UI.Island.error(err); }
                for (const d of expanded) if (!children.has(d) && (d === rel || d.startsWith(rel ? `${rel}/` : ''))) {
                    try { children.set(d, await call('files:list', { pack, root, path: d })); } catch {}
                }
                renderTree();
            }

            function renderTree() {
                const rows = [];
                const walk = (rel, depth) => {
                    for (const e of children.get(rel) || []) {
                        const open = expanded.has(e.path);
                        const editable = !e.dir && TEXT_EXT.test(e.name);
                        rows.push(h(`div.node${e.dir ? '.dir' : ''}${open ? '.open' : ''}${current?.path === e.path ? '.on' : ''}`, {
                            role: 'treeitem', tabindex: '0', title: e.path, style: { '--depth': depth },
                            on: {
                                click: () => (e.dir ? toggleDir(e) : openFile(e)),
                                keydown: (ev) => { if (ev.key === 'Enter') (e.dir ? toggleDir(e) : openFile(e)); },
                                contextmenu: (ev) => { ev.preventDefault(); nodeMenu(ev.currentTarget, e); }
                            }
                        },
                        e.dir ? icon('chev', 'tw') : h('span', { style: { width: '14px', flex: 'none' } }),
                        icon(e.dir ? 'folder' : editable ? 'file-code' : 'file', 'fi'),
                        h('span.nm', e.name),
                        !e.dir ? h('span.sz', fmt.bytes(e.size)) : null));
                        if (e.dir && open) walk(e.path, depth + 1);
                    }
                };
                walk('', 0);
                if (!rows.length) rows.push(h('div.empty', { style: { padding: '30px 10px' } }, h('p', root === 'game' ? 'Nothing here yet. Play the pack once and Minecraft creates its folders.' : 'This folder is empty.')));
                list.replaceChildren(...rows);
            }

            async function toggleDir(e) {
                if (expanded.has(e.path)) expanded.delete(e.path);
                else { expanded.add(e.path); if (!children.has(e.path)) await load(e.path); }
                renderTree();
            }

            function nodeMenu(anchor, e) {
                UI.menu(anchor, [
                    !e.dir ? { label: 'Open', icon: 'file-code', onClick: () => openFile(e) } : null,
                    root === 'game' ? { label: 'Copy to Overrides', icon: 'copy', onClick: () => toOverrides(e.path) } : null,
                    { label: 'Rename…', icon: 'pencil', onClick: () => rename(e) },
                    { label: 'Show in Folder', icon: 'external', onClick: () => call('files:reveal', { pack, root, path: e.path }) },
                    'sep',
                    { label: 'Move to Recycle Bin', icon: 'trash', danger: true, onClick: () => remove(e) }
                ], { align: 'left' });
            }

            const parentOf = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
            async function refreshDir(rel) { children.delete(rel); await load(rel); }

            async function newItem(dir) {
                const base = current ? parentOf(current.path) : (root === 'pack' ? 'overrides/config' : 'config');
                const name = await UI.prompt({ title: dir ? 'New Folder' : 'New File', message: `Created in ${base || 'the root folder'}.`, placeholder: dir ? 'folder-name' : 'example.toml', confirmLabel: 'Create' });
                if (!name) return;
                try {
                    const r = await call('files:create', { pack, root, path: base ? `${base}/${name}` : name, dir });
                    for (let p = base; p; p = parentOf(p)) expanded.add(p);
                    await refreshDir(base);
                    if (!dir) openFile({ path: r.path, name });
                } catch (err) { UI.Island.error(err); }
            }
            async function rename(e) {
                const name = await UI.prompt({ title: 'Rename', value: e.name, confirmLabel: 'Rename' });
                if (!name || name === e.name) return;
                try { await call('files:rename', { pack, root, path: e.path, name }); if (current?.path === e.path) closeEditor(); await refreshDir(parentOf(e.path)); }
                catch (err) { UI.Island.error(err); }
            }
            async function remove(e) {
                if (!(await UI.confirm({ title: `Move “${e.name}” to the trash?`, message: 'You can restore it from the Recycle Bin.', confirmLabel: 'Move to Recycle Bin', danger: true }))) return;
                try { await call('files:delete', { pack, root, path: e.path }); if (current?.path === e.path) closeEditor(); await refreshDir(parentOf(e.path)); UI.Island.toast('Moved to Recycle Bin', e.name); }
                catch (err) { UI.Island.error(err); }
            }
            async function toOverrides(rel) {
                try { await call('files:to-overrides', { pack, path: rel }); UI.Island.toast('Copied to Overrides', rel); }
                catch (err) { UI.Island.error(err); }
            }

            const editor = h('section.editor');
            container.append(h('div.files', tree, editor));

            function emptyEditor() {
                editor.replaceChildren(h('div.editor-empty', h('div',
                    h('div.empty', { style: { padding: '0' } }, h('div.art', icon('file-code')), h('h3', 'Edit configs in place'),
                        h('p', 'Open a .toml, .json, .snbt, .cfg, .properties or script file from the list. Ctrl+S saves.')))));
            }

            async function confirmDiscard() {
                if (!current?.dirty) return true;
                return UI.confirm({ title: 'Discard Unsaved Changes?', message: `${current.path} has changes that haven't been saved.`, confirmLabel: 'Discard', danger: true });
            }

            async function openFile(e) {
                if (current?.path === e.path) return;
                if (!(await confirmDiscard())) return;
                let f;
                try { f = await call('files:read', { pack, root, path: e.path }); }
                catch (err) { return UI.Island.error(err); }
                if (f.binary || f.tooLarge) {
                    current = { path: e.path };
                    renderTree();
                    editor.replaceChildren(h('div.editor-empty', h('div.empty', { style: { padding: 0 } },
                        h('h3', f.binary ? 'Not a Text File' : 'Too Large to Edit Here'),
                        h('p', f.binary ? `${e.path} is a binary file (${fmt.bytes(f.size)}).` : `${e.path} is ${fmt.bytes(f.size)}. Open it in another editor.`),
                        h('button.btn', { on: { click: () => call('files:reveal', { pack, root, path: e.path }) } }, icon('external'), 'Show in Folder'))));
                    return;
                }
                const lang = Highlight.langFor(e.path);
                current = { path: e.path, text: f.text, saved: f.text, mtime: f.mtime, lang, dirty: false, eol: f.eol };
                renderTree();
                renderEditor();
            }

            function renderEditor() {
                const c = current;
                const dirtyDot = h('span.dirty.hidden', { title: 'Unsaved Changes' });
                const saveBtn = h('button.btn.primary.sm', { disabled: true, on: { click: save } }, icon('save'), 'Save');
                const revertBtn = h('button.btn.ghost.sm', { disabled: true, on: { click: () => { ta.value = c.saved; onInput(); } } }, 'Revert');
                const gutter = h('div.gutter');
                const pre = h('pre');
                const ta = h('textarea', { spellcheck: false, wrap: 'off', autocapitalize: 'off', autocomplete: 'off', 'aria-label': `Editing ${c.path}` });
                ta.value = c.text;
                const status = h('div.editor-status');
                const code = h('div.code', h('div.code-inner', gutter, h('div.code-area', pre, ta)));
                editor.replaceChildren(
                    h('div.editor-head', h('span.path.ellipsis.grow', c.path), dirtyDot, revertBtn,
                        root === 'game' ? h('button.btn.ghost.sm', { on: { click: () => toOverrides(c.path) } }, icon('copy'), 'Copy to Overrides') : null,
                        saveBtn),
                    code, status);

                let lines = 0;
                const paint = rafThrottle(() => {
                    const text = ta.value;
                    pre.innerHTML = Highlight.highlight(text, c.lang) + '\n';
                    const n = text.split('\n').length;
                    if (n !== lines) { lines = n; gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); }
                    const v = Highlight.validate(text, c.lang, c.path);
                    status.replaceChildren(
                        h('span', ({ json: 'JSON', snbt: 'SNBT', toml: 'TOML', cfg: 'Forge Config', properties: 'Properties', yaml: 'YAML', js: 'Script', plain: 'Text' })[c.lang]),
                        h('span', fmt.plural(n, 'line')),
                        v ? h(`span.${v.ok ? 'good' : 'bad'}`, v.message) : null,
                        h('span.grow'),
                        h('span', 'Ctrl+S to Save'));
                });
                function onInput() {
                    c.text = ta.value;
                    c.dirty = c.text !== c.saved;
                    dirtyDot.classList.toggle('hidden', !c.dirty);
                    saveBtn.disabled = !c.dirty;
                    revertBtn.disabled = !c.dirty;
                    paint();
                }
                async function save(force = false) {
                    if (!c.dirty && !force) return;
                    saveBtn.disabled = true;
                    try {
                        const r = await call('files:write', { pack, root, path: c.path, text: c.eol === '\r\n' ? c.text.replace(/\r?\n/g, '\r\n') : c.text, mtime: c.mtime, force: force === true });
                        c.mtime = r.mtime; c.saved = c.text; onInput();
                        UI.Island.toast('Saved', c.path.split('/').pop());
                    } catch (err) {
                        if (err.code === 'CONFLICT' && await UI.confirm({ title: 'File Changed on Disk', message: 'Another program changed this file after you opened it. Save your version anyway?', confirmLabel: 'Overwrite', danger: true })) return save(true);
                        UI.Island.error(err); saveBtn.disabled = false;
                    }
                }
                ta.addEventListener('input', onInput);
                ta.addEventListener('keydown', (e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
                    if (e.key === 'Tab' && !e.ctrlKey) {
                        e.preventDefault();
                        const { selectionStart: a, selectionEnd: b } = ta;
                        ta.setRangeText('    ', a, b, 'end');
                        onInput();
                    }
                });
                // The page blocks text selection, so turn it back on inside the overlay.
                ta.style.userSelect = 'text';
                paint();
                setTimeout(() => ta.focus({ preventScroll: true }), 50);
            }

            function closeEditor() { current = null; emptyEditor(); }

            emptyEditor();
            load('');
            return {
                update() {},
                destroy() {}
            };
        }
    };

    window.FilesTab = FilesTab;
})();
