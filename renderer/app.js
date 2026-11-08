(() => {
    const { h, img, call, store, fmt, transition, applyAppearance } = Lib;

    const state = store({ library: [], route: { name: 'library' }, snapshot: null, info: null, prefs: {} });
    let currentView = null;
    let gameVersionsPromise = null;
    // Events can land mid-transition, so pages always mount from this map.
    // The last few packs' snapshots, newest last, so going back to one shows it at once. Kept small: each can be 1 MB.
    const snapshots = new Map();
    const SNAPSHOTS_KEPT = 4;
    const remember = (p, snap) => {
        snapshots.delete(p);
        snapshots.set(p, snap);
        while (snapshots.size > SNAPSHOTS_KEPT) snapshots.delete(snapshots.keys().next().value);
    };
    // A load started on hover or press, picked up by the click that usually follows.
    const prefetched = new Map();
    const freshPacks = new Set();

    const App = {
        state,
        freshPacks,
        gameVersions(force = false) {
            if (!gameVersionsPromise || force) gameVersionsPromise = call('versions:game', { force }).catch(err => { gameVersionsPromise = null; throw err; });
            return gameVersionsPromise;
        },

        async refreshLibrary() { state.set({ library: await call('packs:library') }); },

        prefetch(p) {
            if (!prefetched.has(p)) {
                const load = call('packs:load', { path: p });
                prefetched.set(p, load);
                load.catch(() => {}).finally(() => setTimeout(() => { if (prefetched.get(p) === load) prefetched.delete(p); }, 3000));
            }
            return prefetched.get(p);
        },

        // Prefetch when the pointer rests on a pack for a moment, is pressed, or it gets keyboard focus; passing over
        // packs on the way somewhere else loads nothing.
        prefetchOn(el, p) {
            let timer = null;
            const go = () => { clearTimeout(timer); App.prefetch(p); };
            el.addEventListener('pointerenter', () => { timer = setTimeout(go, 120); });
            el.addEventListener('pointerleave', () => clearTimeout(timer));
            el.addEventListener('pointerdown', go);
            el.addEventListener('focus', go);
            return el;
        },

        // A pack seen before opens at once with what's known and refreshes when its load returns.
        async go(route, { morphFrom } = {}) {
            if (route.name === 'pack') {
                const load = App.prefetch(route.path);
                if (snapshots.has(route.path)) {
                    load.then((fresh) => {
                        remember(route.path, fresh);
                        const now = state.get().route;
                        if (now.name === 'pack' && now.path === route.path) { state.set({ snapshot: fresh }); currentView?.update?.(fresh); }
                    }).catch(UI.Island.error);
                } else {
                    try { remember(route.path, await load); }
                    catch (err) { UI.Island.error(err); return; }
                }
            }
            if (morphFrom) morphFrom.style.viewTransitionName = 'pack-icon';
            await transition(() => {
                if (morphFrom) morphFrom.style.viewTransitionName = '';
                currentView?.destroy?.();
                const view = document.getElementById('view');
                view.replaceChildren();
                const snapshot = route.name === 'pack' ? snapshots.get(route.path) : null;
                state.set({ route, snapshot });
                currentView = route.name === 'pack' ? PackView.mount(view, snapshot, route.tab)
                    : route.name === 'settings' ? SettingsView.mount(view, route.section)
                    : LibraryView.mount(view);
                renderSidebar();
            });
        },

        newPack() { PackForm.open({ mode: 'create' }); },
        async openFolder() {
            try {
                const p = await call('packs:import');
                if (!p) return;
                freshPacks.add(p);
                await App.refreshLibrary();
                UI.Island.toast('Pack Added');
                App.go({ name: 'pack', path: p });
            } catch (err) { UI.Island.error(err); }
        },
        importMenu(anchor) {
            UI.menu(anchor, [
                { heading: 'Add an Existing Pack' },
                { label: 'Modpack File (.mrpack or .zip)…', icon: 'import', onClick: () => Importer.start('file') },
                { label: 'Prism, MultiMC or packwiz Folder…', icon: 'folder', onClick: () => Importer.start('instance') },
                { label: 'Mods Folder or Game Folder…', icon: 'folder', onClick: () => Importer.start('folder') },
                { label: 'Modpack Link…', icon: 'link', onClick: () => Importer.start('link') },
                'sep',
                { label: 'Incursion Pack Folder…', icon: 'layers', onClick: () => App.openFolder() }
            ], { align: 'right' });
        },

        async setPrefs(patch) {
            const prefs = await call('settings:prefs', patch);
            state.set({ prefs });
            applyAppearance(prefs);
            return prefs;
        }
    };
    window.App = App;

    function renderSidebar() {
        const { library, route, snapshot } = state.get();
        document.getElementById('navLibrary').classList.toggle('active', route.name === 'library');
        document.getElementById('navSettings').classList.toggle('active', route.name === 'settings');
        const list = document.getElementById('navPacks');
        list.replaceChildren(...library.map(p => {
            const active = route.name === 'pack' && route.path === p.path;
            const updates = active && snapshot ? Object.keys(snapshot.updates).length : 0;
            const item = h(`button.nav-item.nav-pack${active ? '.active' : ''}${p.available ? '' : '.unavailable'}`, {
                title: p.available ? p.name : `Folder not found: ${p.path}`,
                on: { click: (e) => { if (!active) App.go({ name: 'pack', path: p.path }, { morphFrom: e.currentTarget.querySelector('img') }); } }
            },
            img(p.icon, 'squircle'),
            h('span.label', p.name),
            updates ? h('span.dot', { title: `${updates} updates available` }) : h('span.count', p.modCount ?? ''));
            return p.available && !active ? App.prefetchOn(item, p.path) : item;
        }));
    }
    state.sub(renderSidebar);

    const SECTION_NAMES = { appearance: 'Appearance', accounts: 'Accounts', keys: 'API Keys', java: 'Java', launch: 'Launch Defaults', data: 'Data' };
    let lastCrumbs = '';
    function renderCrumbs() {
        const { route, snapshot } = state.get();
        const here = route.name === 'pack' ? (snapshot?.meta.name || '') : route.name === 'settings' ? (SECTION_NAMES[route.section] || '') : '';
        const sig = `${route.name}|${here}`;
        if (sig === lastCrumbs) return;
        lastCrumbs = sig;
        const el = document.getElementById('crumbs');
        const root = route.name === 'settings' ? 'Settings' : 'Library';
        const parts = [here ? h('button', { on: { click: () => App.go(route.name === 'settings' ? { name: 'settings' } : { name: 'library' }) } }, root) : h('span.here', root)];
        if (here) parts.push(h('span.sep', '/'), h('span.here', { title: here }, here));
        el.replaceChildren(...parts);
    }
    state.sub(renderCrumbs);
    document.getElementById('searchPill').addEventListener('click', () => Palette.open());

    document.getElementById('navLibrary').addEventListener('click', () => App.go({ name: 'library' }));
    document.getElementById('navNewPack').addEventListener('click', () => App.newPack());
    document.getElementById('navSettings').addEventListener('click', () => App.go({ name: 'settings' }));

    window.incursion.on(({ type, payload }) => {
        if (type === 'task') UI.Island.task(payload);
        else if (type === 'downloads') UI.Downloads.update(payload.items);
        else if (type === 'pack') {
            if (snapshots.has(payload.meta.path)) remember(payload.meta.path, payload);
            const { route } = state.get();
            if (route.name === 'pack' && route.path === payload.meta.path) {
                state.set({ snapshot: payload });
                currentView?.update?.(payload);
            }
            const lib = state.get().library.map(e => e.path === payload.meta.path ? { ...e, name: payload.meta.name, icon: payload.meta.icon, modCount: payload.meta.mods.length, gameVersion: payload.meta.gameVersion, loader: payload.meta.loader, version: payload.meta.version, platform: Lib.playPlatform(payload.meta), profile: (payload.meta.profiles || []).find(p => p.id === payload.meta.launch?.profile)?.name || null } : e);
            state.set({ library: lib });
        } else if (type === 'notice' && payload.kind === 'auto-updated') {
            const pack = state.get().library.find(p => p.path === payload.packPath);
            UI.Island.toast(`Updated ${fmt.plural(payload.count, 'Item', 'Items')}`, `${pack?.name || ''}${payload.failed ? ` · ${payload.failed} failed` : ''}`);
        } else if (type === 'notice' && payload.kind === 'links-sharing') {
            Sharing.notice();
        } else if (type === 'notice' && payload.kind === 'updates') {
            const pack = state.get().library.find(p => p.path === payload.packPath);
            UI.Island.toast(`${fmt.plural(payload.count, 'update')} available`, pack?.name || '');
        } else if (type === 'theme') {
            const root = document.documentElement;
            const next = payload.dark ? 'dark' : 'light';
            if (root.dataset.theme !== next) root.dataset.theme = next;
        }
    });

    document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        const k = e.key.toLowerCase();
        if (k === 'f') { const s = document.querySelector('.layer .search input') || document.querySelector('.view .search input'); if (s) { e.preventDefault(); s.focus(); s.select(); } }
        if (k === 'n') { e.preventDefault(); App.newPack(); }
        if (k === ',') { e.preventDefault(); App.go({ name: 'settings' }); }
    });

    (async () => {
        const info = await call('app:info');
        state.set({ info, prefs: info.prefs || {} });
        document.documentElement.dataset.theme = info.dark ? 'dark' : 'light';
        applyAppearance(info.prefs || {});
        document.body.classList.add(`os-${info.platform}`);
        await App.refreshLibrary();
        App.go({ name: 'library' });
        // Tell main we're drawn so it can swap out the splash.
        requestAnimationFrame(() => requestAnimationFrame(() => call('app:ready').catch(() => {})));
        setTimeout(() => document.documentElement.classList.remove('booting'), 600);
        if (info.firstRun) setTimeout(() => Setup.open(), 700);
        App.gameVersions().catch(() => {});
    })().catch(err => { call('app:ready').catch(() => {}); UI.Island.error(err); });
})();
