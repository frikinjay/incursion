(() => {
    const { h, icon, img, call } = Lib;
    let openEl = null;

    function commands() {
        const { library, route, snapshot } = App.state.get();
        const list = [];
        const pack = route.name === 'pack' && snapshot ? snapshot : null;
        if (pack) {
            const p = pack.meta.path;
            list.push(
                { group: pack.meta.name, label: 'Add Content', icon: 'plus', keys: 'mods resource packs shaders data packs', run: () => Browse.open(App.state.get().snapshot || pack) },
                ...[['mods', 'Content', 'layers'], ['files', 'Files', 'folder'], ['releases', 'Releases', 'tag'], ['issues', 'Issues', 'warn'], ['backups', 'Backups', 'download'], ['settings', 'Pack Settings', 'sliders']]
                    .map(([tab, label, ic]) => ({ group: pack.meta.name, label, icon: ic, hint: 'Tab', run: () => App.go({ name: 'pack', path: p, tab }) })));
        }
        list.push(
            ...library.filter(p => p.available).map(p => ({ group: 'Packs', label: p.name, img: p.icon || 'icon.svg', hint: [p.gameVersion, Lib.LOADERS[p.loader] || p.loader].filter(Boolean).join(' · '), keys: `${p.gameVersion} ${p.loader}`, run: () => App.go({ name: 'pack', path: p.path }) })),
            { group: 'Go To', label: 'Library', icon: 'grid', run: () => App.go({ name: 'library' }) },
            { group: 'Go To', label: 'Settings', icon: 'gear', hint: 'Ctrl ,', run: () => App.go({ name: 'settings' }) },
            ...[['appearance', 'Appearance'], ['accounts', 'Accounts'], ['keys', 'API Keys'], ['java', 'Java'], ['launch', 'Launch Defaults'], ['updates', 'Updates'], ['data', 'Data']]
                .map(([section, label]) => ({ group: 'Go To', label: `Settings: ${label}`, icon: 'gear', run: () => App.go({ name: 'settings', section }) })),
            { group: 'Actions', label: 'New Pack', icon: 'plus', hint: 'Ctrl N', run: () => App.newPack() },
            { group: 'Actions', label: 'Import a CurseForge or Modrinth File', icon: 'import', run: () => Importer.start('file') },
            { group: 'Actions', label: 'Import a Prism, MultiMC or packwiz Pack', icon: 'folder', keys: 'prism multimc packwiz instance', run: () => Importer.start('instance') },
            { group: 'Actions', label: 'Import a Mods or Game Folder', icon: 'folder', run: () => Importer.start('folder') },
            { group: 'Actions', label: 'Open a Modpack Link', icon: 'link', keys: 'url modrinth curseforge mrpack', run: () => Importer.start('link') },
            { group: 'Actions', label: 'Add an Incursion Pack Folder', icon: 'layers', run: () => App.openFolder() },
            ...[['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'Automatic', 'palette']].map(([theme, label, ic]) => ({
                group: 'Appearance', label: `Theme: ${label}`, icon: ic, keys: 'theme mode',
                run: async () => { const r = await call('app:theme', { theme }); Lib.themeTransition(innerWidth / 2, innerHeight / 2, () => { document.documentElement.dataset.theme = r.dark ? 'dark' : 'light'; }); }
            })));
        return list;
    }

    function score(cmd, q) {
        if (!q) return 1;
        const label = cmd.label.toLowerCase();
        const hay = `${label} ${cmd.group.toLowerCase()} ${(cmd.keys || '').toLowerCase()}`;
        if (label.startsWith(q)) return 3;
        if (label.split(/[\s:]+/).some(w => w.startsWith(q))) return 2;
        return q.split(/\s+/).every(part => hay.includes(part)) ? 1 : 0;
    }

    function open() {
        if (openEl) { openEl.querySelector('input').select(); return; }
        const all = commands();
        let shown = [];
        let active = 0;
        const input = h('input', { type: 'text', placeholder: 'Search packs, pages and actions', spellcheck: false, 'aria-label': 'Command', 'aria-controls': 'cmdk-results', autocomplete: 'off' });
        const results = h('div.cmdk-results#cmdk-results', { role: 'listbox' });
        const scrim = h('div.scrim', { on: { click: close } });
        const panel = h('div.cmdk-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command Palette' },
            h('div.cmdk-field', icon('search'), input, h('kbd', 'Esc')),
            results,
            h('div.cmdk-foot', h('span', h('kbd', '↑'), h('kbd', '↓'), ' move'), h('span', h('kbd', '↵'), ' run'), h('span', h('kbd', 'Esc'), ' close')));
        const el = h('div.cmdk', scrim, panel);
        const prevFocus = document.activeElement;
        document.getElementById('layer').append(el);
        openEl = el;
        requestAnimationFrame(() => { el.classList.add('show'); scrim.classList.add('show'); });

        function render() {
            const q = input.value.trim().toLowerCase();
            shown = all.map(c => ({ c, s: score(c, q) })).filter(x => x.s > 0)
                .sort((a, b) => (q ? b.s - a.s : 0)).map(x => x.c);
            if (q) shown = shown.slice(0, 40);
            active = Math.min(active, Math.max(0, shown.length - 1));
            const out = [];
            let lastGroup = null;
            shown.forEach((c, i) => {
                if (!q && c.group !== lastGroup) { out.push(h('div.cmdk-group', c.group)); lastGroup = c.group; }
                out.push(h('button.cmdk-item', {
                    role: 'option', 'aria-selected': i === active ? 'true' : 'false', class: i === active ? 'on' : '', tabindex: '-1',
                    on: { click: () => runAt(i), pointermove: () => { if (active !== i) { active = i; paintActive(); } } }
                }, c.img ? img(c.img) : icon(c.icon || 'chev'), h('span.cmdk-label', c.label), c.hint ? h('span.cmdk-hint', c.hint) : null));
            });
            results.replaceChildren(...(out.length ? out : [h('div.cmdk-empty', 'Nothing matches. Try a pack name or “settings”.')]));
        }
        function paintActive() {
            results.querySelectorAll('.cmdk-item').forEach((b, i) => { b.classList.toggle('on', i === active); b.setAttribute('aria-selected', i === active ? 'true' : 'false'); });
            results.querySelectorAll('.cmdk-item')[active]?.scrollIntoView({ block: 'nearest' });
        }
        function runAt(i) {
            const c = shown[i];
            if (!c) return;
            close();
            Promise.resolve().then(c.run).catch(err => UI.Island.error(err));
        }
        function close() {
            if (openEl !== el) return;
            openEl = null;
            el.classList.remove('show');
            scrim.classList.remove('show');
            setTimeout(() => el.remove(), 220);
            if (prevFocus?.isConnected) prevFocus.focus?.();
        }
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); paintActive(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paintActive(); }
            else if (e.key === 'Enter') { e.preventDefault(); runAt(active); }
            else if (e.key === 'Tab') e.preventDefault();
        });
        input.addEventListener('input', () => { active = 0; render(); });
        render();
        input.focus();
    }

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
    }, true);

    window.Palette = { open };
})();
