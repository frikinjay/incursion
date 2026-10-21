(() => {
    const { h, img, icon, call, fmt, LOADERS } = Lib;

    function card(p, i) {
        const iconEl = img(p.icon, 'icon squircle');
        const open = () => p.available ? App.go({ name: 'pack', path: p.path }, { morphFrom: iconEl }) : relocate(p);
        const play = p.available ? Play.button(p.path, { compact: true }) : null;
        const el = h(`div.pack-card${p.available ? '' : '.unavailable'}`, {
            tabindex: '0', role: 'button', 'aria-label': `Open ${p.name}`,
            on: {
                click: (e) => { if (!e.target.closest('button')) open(); },
                keydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); },
                contextmenu: (e) => { e.preventDefault(); cardMenu(e.currentTarget, p); }
            }
        },
        iconEl,
        h('div.pc-main',
            h('h3.title', { title: p.name }, p.name),
            h('div.pc-meta',
                !p.available ? h('span.chip.sm.amber', icon('warn'), 'Folder Missing') : null,
                h('span', p.gameVersion ? `Minecraft ${p.gameVersion}` : 'Minecraft —'),
                h('span.sep', '/'),
                h('span', LOADERS[p.loader] || p.loader || '—'),
                p.version ? h('span.sep', '/') : null,
                p.version ? h('span', `v${p.version}`) : null)),
        h('div.pc-count', h('b', p.modCount != null ? fmt.count(p.modCount) : '—'), h('span', p.modCount === 1 ? 'mod' : 'mods')),
        h('div.actions',
            play ? play.el[0] : h('button.btn', { on: { click: () => relocate(p) } }, 'Locate…'),
            play ? play.el[2] : null,
            play ? play.el[3] : null,
            h('button.btn.icon', { title: 'More', 'aria-label': `More for ${p.name}`, on: { click: (e) => cardMenu(e.currentTarget, p) } }, icon('more'))));
        if (App.freshPacks.has(p.path)) { el.classList.add('enter'); App.freshPacks.delete(p.path); }
        else if (i < 8 && LibraryView.firstMount) { el.classList.add('enter'); el.style.animationDelay = `${i * 60}ms`; }
        el._destroy = () => play?.destroy();
        return el;
    }

    function cardMenu(anchor, p) {
        UI.menu(anchor, [
            { label: 'Open', icon: 'chev', onClick: () => App.go({ name: 'pack', path: p.path }), disabled: !p.available },
            { label: 'Show in Folder', icon: 'folder', onClick: () => call('shell:reveal', { path: p.path }), disabled: !p.available },
            'sep',
            { label: 'Remove from Library', icon: 'trash', danger: true, onClick: () => forget(p) }
        ], { align: 'right' });
    }

    async function forget(p) {
        const ok = await UI.confirm({ title: `Remove “${p.name}”?`, message: 'The pack’s files stay on your computer. You can add it again at any time.', confirmLabel: 'Remove', danger: true });
        if (!ok) return;
        await call('packs:forget', { path: p.path });
        await App.refreshLibrary();
        UI.Island.toast('Removed from Library', p.name);
    }

    async function relocate(p) {
        const ok = await UI.confirm({ title: 'Pack Folder Not Found', message: `Incursion can't find ${p.path}. Remove it from the library, then add it from its new location.`, confirmLabel: 'Remove and Locate', danger: true });
        if (ok) { await call('packs:forget', { path: p.path }); await App.refreshLibrary(); App.openFolder(); }
    }

    const LibraryView = {
        firstMount: true,
        mount(root) {
            const grid = h('div.pack-list');
            const sub = h('p.subtitle');
            const importBtn = h('button.btn', { on: { click: (e) => App.importMenu(e.currentTarget) } }, icon('import'), h('span.lbl', 'Import'));
            const page = h('div.page', h('div.page-inner',
                h('div.page-head',
                    h('div', h('h1.large-title', 'Library'), sub),
                    h('div.head-actions', importBtn, h('button.btn.primary', { on: { click: () => App.newPack() } }, icon('plus'), 'New Pack'))),
                grid));
            root.append(page);

            let cards = [];
            let lastSig = '';
            const render = () => {
                const { library } = App.state.get();
                const sig = JSON.stringify(library.map(p => [p.path, p.name, p.icon?.length, p.modCount, p.gameVersion, p.loader, p.available]));
                if (sig === lastSig) return;
                lastSig = sig;
                const total = library.reduce((n, p) => n + (p.modCount || 0), 0);
                sub.textContent = library.length ? `${fmt.plural(library.length, 'pack')} · ${fmt.plural(total, 'mod')}` : 'One pack, two platforms: CurseForge and Modrinth, kept in sync.';
                cards.forEach(c => c._destroy?.());
                if (!library.length) {
                    grid.replaceChildren(h('div.empty',
                        h('div.art', icon('cube')),
                        h('h3', 'Create Your First Pack'),
                        h('p', 'Pick a Minecraft version and loader, then add mods. Incursion keeps the CurseForge and Modrinth editions in sync for you.'),
                        h('div.head-actions',
                            h('button.btn', { on: { click: (e) => App.importMenu(e.currentTarget) } }, icon('import'), 'Import Existing Pack'),
                            h('button.btn.primary', { on: { click: () => App.newPack() } }, icon('plus'), 'New Pack'))));
                    cards = [];
                    return;
                }
                cards = library.map(card);
                grid.replaceChildren(...cards);
                LibraryView.firstMount = false;
            };
            render();
            const unsub = App.state.sub((s) => { if (s.route.name === 'library') render(); });
            return { destroy() { unsub(); cards.forEach(c => c._destroy?.()); } };
        }
    };
    window.LibraryView = LibraryView;
})();
