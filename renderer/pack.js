(() => {
    const { h, img, icon, call, fmt, LOADERS, modKey, modTitle, modIcon, rafThrottle, debounce } = Lib;
    const ROW = 56;   // matches --row-h in style.css
    const OVERSCAN = 8;

    const sideOf = (m) => {
        if (m.side === 'client') return { client: true, server: false, forced: true };
        if (m.side === 'server') return { client: false, server: true, forced: true };
        if (m.side === 'both') return { client: true, server: true, forced: true };
        const envs = [m.environments?.modrinth, m.environments?.curseforge].filter(Boolean);
        if (!envs.length) return { client: true, server: true };
        return { client: envs.some(e => e.client), server: envs.some(e => e.server) };
    };
    const versionLabel = (m) => m.meta?.mrVersionNumber || m.meta?.cfDisplayName || (m.installedFiles?.modrinth || m.installedFiles?.curseforge || '').replace(/\.jar$/i, '');
    const PL_NAME = { modrinth: 'Modrinth', curseforge: 'CurseForge' };

    // Strip the Minecraft version from version labels, so "mc1.21.1-0.8.13-fabric" and "Sodium 0.8.13 for Fabric
    // 1.21.1" both read 0.8.13.
    function coreVersion(label, gameVersion) {
        let s = String(label || '').replace(/\.(jar|zip)$/i, '');
        if (gameVersion) s = s.split(gameVersion).join(' ');
        return s.match(/\d+(?:\.\d+)+(?:[-+.]?(?:alpha|beta|pre|rc|snapshot)[.-]?\d*)?/i)?.[0].toLowerCase() || null;
    }
    function platformVersions(m, gameVersion) {
        const mr = m.ids.modrinth && m.installedFiles?.modrinth ? (m.meta?.mrVersionNumber || m.installedFiles.modrinth) : null;
        const cf = m.ids.curseforge && m.installedFiles?.curseforge ? (m.meta?.cfDisplayName || m.installedFiles.curseforge) : null;
        if (!mr || !cf) return { same: true, mr, cf };
        const h1 = m.hashes?.modrinth?.sha1, h2 = m.hashes?.curseforge?.sha1;
        const c1 = coreVersion(mr, gameVersion) || coreVersion(m.installedFiles.modrinth, gameVersion);
        const c2 = coreVersion(cf, gameVersion) || coreVersion(m.installedFiles.curseforge, gameVersion);
        const same = (h1 && h1 === h2) || m.installedFiles.modrinth === m.installedFiles.curseforge || (c1 && c1 === c2) || mr === cf;
        return { same: !!same, mr, cf, mrShort: c1 || mr, cfShort: c2 || cf };
    }
    // 'platform', 'manual' (a file added by hand), 'pending' (CurseForge blocks app downloads, no file yet) or null.
    function sideState(m, pl) {
        const r = m.manual?.[pl];
        if (r) return r.from === 'download' && !r.sha1 ? 'pending' : 'manual';
        return m.ids[pl] ? 'platform' : null;
    }
    // A copy whose original has a newer file: { from, was, now }, or null.
    function copyOutdated(m, pl) {
        const r = m.manual?.[pl];
        if (!r || !PL_NAME[r.from]) return null;
        const now = m.installedFiles?.[r.from];
        if (!now || now === r.sourceFile) return null;
        return { from: r.from, was: r.version || r.sourceFile, now: (r.from === 'modrinth' ? m.meta?.mrVersionNumber : m.meta?.cfDisplayName) || now };
    }
    const isLocal = (m) => !m.ids.curseforge && !m.ids.modrinth && !!m.ids.local;
    function sidesTitle(m) {
        return ['modrinth', 'curseforge'].map(pl => {
            const st = sideState(m, pl);
            if (st === 'platform') return PL_NAME[pl];
            if (st === 'pending') return `${PL_NAME[pl]}: download needed`;
            if (st === 'manual') return `${PL_NAME[pl]}: added by hand${PL_NAME[m.manual[pl].from] ? ` (copied from ${PL_NAME[m.manual[pl].from]})` : ''}`;
            return `Not on ${PL_NAME[pl]}`;
        }).join('\n');
    }
    function twinMarks(m, upd) {
        return h('span.twins', { title: upd ? updateSummary(m, upd) : sidesTitle(m) },
            ['modrinth', 'curseforge'].map(pl => {
                const st = sideState(m, pl);
                return h(`span.twin-slot${upd?.[pl] ? '.upd' : ''}${st === 'manual' ? '.manual' : ''}`,
                    h(`span.twin.${pl === 'modrinth' ? 'mr' : 'cf'}${st === 'platform' || st === 'manual' ? '.on' : ''}${st === 'pending' ? '.pending' : ''}`));
            }));
    }

    function updateSummary(m, upd) {
        return ['modrinth', 'curseforge'].filter(pl => m.ids[pl]).map(pl => {
            const u = upd?.[pl];
            const now = pl === 'modrinth' ? m.meta?.mrVersionNumber || m.installedFiles?.modrinth : m.meta?.cfDisplayName || m.installedFiles?.curseforge;
            return u ? `${PL_NAME[pl]}: ${now || 'installed'} → ${u.versionNumber || u.displayName || u.fileName}` : `${PL_NAME[pl]}: up to date`;
        }).join('\n');
    }

    const PackView = {
        mount(root, snapshot, initialTab = 'mods') {
            let snap = snapshot;
            let tab = initialTab;
            let tabView = null;
            const page = h('div.page');
            const inner = h('div.page-inner');
            page.append(inner);
            root.append(page);

            const heroIcon = img(snap.meta.icon, 'hero-icon squircle');
            heroIcon.style.viewTransitionName = 'pack-icon';
            setTimeout(() => { heroIcon.style.viewTransitionName = ''; }, 700);
            const titleEl = h('h1');
            const facts = h('div.facts');
            const desc = h('p.desc');
            const updatesBtn = h('button.btn.lg');
            const play = Play.button(snap.meta.path);
            const profileBtn = play.el[3];
            const hero = h('section.hero', heroIcon,
                h('div.hero-body', titleEl, facts, desc),
                h('div.hero-actions',
                    play.el[0],
                    play.el[2],
                    profileBtn,
                    h('button.btn.lg', { on: { click: () => Browse.open(snap) } }, icon('plus'), h('span.lbl', 'Add Content')),
                    updatesBtn,
                    h('div.btn-group',
                        play.el[1],
                        h('button.btn.lg.icon', { title: 'Export', 'aria-label': 'Export', on: { click: (e) => exportMenu(e.currentTarget) } }, icon('export')),
                        h('button.btn.lg.icon', { title: 'More', 'aria-label': 'More', on: { click: (e) => moreMenu(e.currentTarget) } }, icon('more')))));

            const tabs = UI.segmented([
                { value: 'mods', label: 'Content' },
                { value: 'files', label: 'Files' },
                { value: 'releases', label: 'Releases' },
                { value: 'issues', label: 'Issues' },
                { value: 'backups', label: 'Backups' },
                { value: 'settings', label: 'Settings' }
            ], tab, (v) => switchTab(v));
            const tabBody = h('div');
            inner.append(hero, h('div.tabs-bar', tabs), tabBody);

            function switchTab(v) {
                tab = v;
                tabView?.destroy?.();
                tabBody.replaceChildren();
                tabView = v === 'mods' ? ModsTab(tabBody, page, snap)
                    : v === 'files' ? FilesTab.mount(tabBody, snap)
                    : v === 'releases' ? PackTabs.releases(tabBody, snap)
                    : v === 'issues' ? PackTabs.issues(tabBody, snap)
                    : v === 'backups' ? PackTabs.backups(tabBody, snap)
                    : PackTabs.settings(tabBody, snap);
                tabBody.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(0.22,1,0.36,1)' });
            }

            function renderHero() {
                const m = snap.meta;
                if (heroIcon.getAttribute('src') !== (m.icon || 'icon.svg')) heroIcon.src = m.icon || 'icon.svg';
                titleEl.textContent = m.name;
                titleEl.title = m.name;
                const platforms = { mr: m.mods.filter(x => x.ids.modrinth).length, cf: m.mods.filter(x => x.ids.curseforge).length };
                facts.replaceChildren(
                    h('span.chip', `Minecraft ${m.gameVersion}`),
                    h('span.chip', `${LOADERS[m.loader] || m.loader}${m.loaderVersion ? ` ${m.loaderVersion}` : ''}`),
                    ...Lib.contentSummary(m.mods).map(t => h('span.chip', t)),
                    platforms.mr ? h('span.chip', h('span.plat.mr', `${platforms.mr} Modrinth`)) : null,
                    platforms.cf ? h('span.chip', h('span.plat.cf', `${platforms.cf} CurseForge`)) : null,
                    m.version ? h('span.chip', `v${m.version}`) : null);
                desc.textContent = m.description || '';
                desc.classList.toggle('hidden', !m.description);
                const updates = Object.keys(snap.updates).length;
                const checking = snap.busy.includes('check');
                const applying = snap.busy.includes('apply');
                updatesBtn.className = `btn lg${updates ? ' green' : ''}`;
                updatesBtn.disabled = checking || applying;
                updatesBtn.replaceChildren(
                    checking || applying ? h('span.spinner') : icon(updates ? 'arrow-up' : 'refresh'),
                    h('span.lbl', applying ? 'Updating…' : checking ? 'Checking…' : updates ? `Update All (${updates})` : 'Check for Updates'));
                updatesBtn.onclick = updates ? () => updateAll() : () => checkUpdates();
                updatesBtn.title = snap.checkedAt ? `Last checked ${fmt.ago(snap.checkedAt)}` : '';
                const errors = snap.issues.filter(i => i.severity === 'error').length;
                const problems = snap.issues.filter(i => i.severity !== 'info').length;
                tabs.setBadge('issues', problems || null, errors ? 'red' : 'amber');
                tabs.setBadge('mods', m.mods.length);
                tabs.setBadge('releases', (m.releases || []).length || null);
            }

            const path = () => snap.meta.path;
            const run = async (fn) => { try { return await fn(); } catch (err) { UI.Island.error(err); } };
            async function checkUpdates() {
                const r = await run(() => call('packs:check', { path: path() }));
                if (r?.count && tab === 'mods') tabView?.showUpdates?.();
            }
            async function updateAll() {
                const n = Object.keys(snap.updates).length;
                const ok = await UI.confirm({ title: `Install ${fmt.plural(n, 'Update', 'Updates')}?`, message: 'New files download and are verified before old ones are removed.', confirmLabel: 'Update All' });
                if (ok) run(() => call('packs:apply', { path: path() }));
            }
            function exportMenu(anchor) {
                const ex = (kind) => run(async () => {
                    const res = await call('packs:export', { path: path(), kind });
                    if (!res) return;
                    const failed = res.filter(r => r.error);
                    const skipped = res.flatMap(r => r.skipped || []);
                    if (failed.length) UI.Island.error(failed[0].error);
                    else UI.Island.toast(res.length > 1 ? 'Packs Exported' : 'Pack Exported', skipped.length ? `${skipped.length} skipped` : '');
                    if (res[0]?.path) call('shell:reveal', { path: res[0].path.replace(/[\\/][^\\/]+$/, '') });
                });
                const prof = (snap.meta.profiles || []).find(p => p.id === snap.meta.launch?.profile);
                UI.menu(anchor, [
                    { heading: prof ? `Export As · Profile: ${prof.name}` : 'Export As' },
                    { label: 'CurseForge and Modrinth', icon: 'export', onClick: () => ex('both') },
                    { label: 'Modrinth (.mrpack)', icon: 'modrinth', onClick: () => ex('modrinth') },
                    { label: 'CurseForge (.zip)', icon: 'curseforge', onClick: () => ex('curseforge') },
                    { label: 'Server Pack (.zip)', icon: 'server', onClick: () => ex('server') },
                    { label: 'Prism Launcher / MultiMC Instance', icon: 'layers', onClick: () => ex('prism') },
                    { label: 'packwiz Folder', icon: 'folder', onClick: () => ex('packwiz') },
                    'sep',
                    { label: 'Publish a Release…', icon: 'upload', onClick: () => switchTabExternal('releases') }
                ]);
            }
            function moreMenu(anchor) {
                const missing = Object.keys(snap.missing).length;
                UI.menu(anchor, [
                    { label: 'Edit Pack Details', icon: 'pencil', onClick: () => PackForm.open({ mode: 'edit', snapshot: snap }) },
                    { label: 'Pack Settings', icon: 'sliders', onClick: () => switchTabExternal('settings') },
                    { label: 'Refresh Mod Info', icon: 'sparkle', onClick: () => run(() => call('packs:sync', { path: path() })) },
                    missing ? { label: `Repair ${fmt.plural(missing, 'Missing File', 'Missing Files')}`, icon: 'warn', onClick: () => run(() => call('packs:redownload', { path: path(), mode: 'missing' })) } : null,
                    { label: 'Download Everything Again', icon: 'download', onClick: async () => {
                        if (await UI.confirm({ title: 'Download All Content Again?', message: `This re-downloads ${fmt.plural(snap.meta.mods.length, 'mod')} and verifies each file.`, confirmLabel: 'Download' }))
                            run(() => call('packs:redownload', { path: path() }));
                    } },
                    { label: 'Repair Game Files…', icon: 'wrench', onClick: async () => {
                        if (!(await UI.confirm({ title: 'Repair Game Files?', message: `Minecraft ${snap.meta.gameVersion} and the loader are installed again for this pack on the next Play, and damaged libraries and assets are replaced. Mods, configs, worlds and everything else in the game folder stay as they are.`, confirmLabel: 'Repair' }))) return;
                        try { await call('play:repair', { path: path() }); UI.Island.toast('Game Files Repaired', 'They download again when you press Play.'); }
                        catch (err) { UI.Island.error(err); }
                    } },
                    'sep',
                    { label: 'Show in Folder', icon: 'folder', onClick: () => call('shell:reveal', { path: path() }) },
                    { label: 'Remove from Library', icon: 'trash', danger: true, onClick: async () => {
                        if (!(await UI.confirm({ title: `Remove “${snap.meta.name}”?`, message: 'The pack’s files stay on your computer. You can add it again at any time.', confirmLabel: 'Remove', danger: true }))) return;
                        await call('packs:forget', { path: path() });
                        await App.refreshLibrary();
                        App.go({ name: 'library' });
                    } }
                ]);
            }
            const switchTabExternal = (v) => { tabs.set(v); switchTab(v); page.scrollTo({ top: 0, behavior: 'smooth' }); };

            renderHero();
            switchTab(tab);

            return {
                update(next) {
                    snap = next;
                    renderHero();
                    tabView?.update?.(snap);
                    Inspector.refresh(snap);
                },
                destroy() { play.destroy(); tabView?.destroy?.(); Inspector.close(); }
            };
        }
    };

    function ModsTab(container, page, snapshot) {
        let snap = snapshot;
        const ui = { filter: 'all', type: 'any', platform: 'any', side: 'any', sort: 'name', query: '' };
        let filtered = [];
        let rowKeys = [];   // unique even if two entries ever share a mod key
        const rowCache = new Map();
        const selected = new Set();
        let selecting = false;
        let lastClicked = null;
        let firstPaint = true;
        let knownKeys = new Set(snap.meta.mods.map(modKey));
        const flashKeys = new Set();

        const filterSeg = UI.segmented([
            { value: 'all', label: 'All' },
            { value: 'updates', label: 'Updates' },
            { value: 'missing', label: 'Missing' },
            { value: 'pinned', label: 'Pinned' }
        ], ui.filter, (v) => { ui.filter = v; refilter(true); });
        const searchInput = h('input.field', { type: 'search', placeholder: 'Filter Content', spellcheck: false });
        searchInput.addEventListener('input', debounce(() => { ui.query = searchInput.value.trim().toLowerCase(); refilter(true); }, 90));
        const compact = h('div.compact-title', img(snap.meta.icon, 'squircle'), h('span'));
        const selectBtn = h('button.btn', { title: 'Select multiple items', on: { click: () => setSelecting(!selecting) } }, icon('select'), h('span.lbl', 'Select'));
        const toolbar = h('div.toolbar', compact, filterSeg,
            h('div.btn-group', UI.picker({ label: 'Type', value: ui.type, onChange: v => { ui.type = v; refilter(true); }, options: [
                { value: 'any', label: 'All Content', short: 'Type' }, ...Object.values(Lib.TYPES).map(t => ({ value: t.id, label: t.label }))] }),
            UI.picker({ label: 'Platform', value: ui.platform, onChange: v => { ui.platform = v; refilter(true); }, options: [
                { value: 'any', label: 'Any Platform', short: 'Platform' }, { value: 'both', label: 'On Both Platforms' }, { value: 'modrinth', label: 'Modrinth Only' }, { value: 'curseforge', label: 'CurseForge Only' },
                { value: 'differ', label: 'Different Versions per Platform', short: 'Differ' }, { value: 'manual', label: 'Files Added by Hand', short: 'By Hand' }] }),
            UI.picker({ label: 'Side', value: ui.side, onChange: v => { ui.side = v; refilter(true); }, options: [
                { value: 'any', label: 'Client and Server', short: 'Side' }, { value: 'client', label: 'Client Only' }, { value: 'server', label: 'Server Only' }] }),
            UI.picker({ label: 'Sort By', value: ui.sort, onChange: v => { ui.sort = v; refilter(true); }, options: [
                { value: 'name', label: 'Name (A to Z)', short: 'Sort' }, { value: 'name-desc', label: 'Name (Z to A)', short: 'Z to A' }, { value: 'author', label: 'Author' },
                { value: 'added', label: 'Recently Added' }, { value: 'updated', label: 'Recently Updated' }] })),
            selectBtn,
            h('label.search', icon('search'), searchInput));
        const viewport = h('div.list-viewport');
        const emptyEl = h('div.empty.hidden');
        const listHead = h('div.list-head', h('span'), h('span'), h('span', 'Name'), h('span.c-version', 'Version'), h('span.c-side', 'Side'), h('span'));
        const panel = h('section.panel', toolbar, listHead, viewport, emptyEl);
        container.append(panel);

        const countEl = h('span.count');
        const bulkUpdate = h('button.btn.green.sm', icon('arrow-up'), h('span', 'Update'));
        const bulkbar = h('div.bulkbar', countEl,
            bulkUpdate,
            h('button.btn.sm', { on: { click: () => bulk('pin') } }, icon('pin'), 'Pin'),
            h('button.btn.sm', { on: { click: () => bulk('unpin') } }, 'Unpin'),
            h('button.btn.sm', { on: { click: () => bulk('off') } }, 'Turn Off'),
            h('button.btn.sm', { on: { click: () => bulk('on') } }, 'Turn On'),
            h('button.btn.sm', { on: { click: () => bulk('check') } }, icon('refresh'), 'Check for Updates'),
            h('button.btn.sm.danger', { on: { click: () => bulk('remove') } }, icon('trash'), 'Remove'),
            h('button.btn.ghost.sm.icon', { title: 'Done', on: { click: () => setSelecting(false) } }, icon('x')));
        bulkUpdate.addEventListener('click', () => bulk('update'));
        document.getElementById('layer').append(bulkbar);

        function setSelecting(v) {
            selecting = v;
            selected.clear();
            panel.classList.toggle('selecting', v);
            selectBtn.classList.toggle('tinted', v);
            syncBulk();
            paint();
        }
        function syncBulk() {
            bulkbar.classList.toggle('show', selecting && selected.size > 0);
            countEl.textContent = `${selected.size} selected`;
            const withUpdates = [...selected].filter(k => snap.updates[k]).length;
            bulkUpdate.disabled = !withUpdates;
            bulkUpdate.lastChild.textContent = withUpdates ? `Update ${withUpdates}` : 'Update';
        }
        async function bulk(action) {
            const keys = [...selected];
            if (!keys.length) return;
            const p = snap.meta.path;
            try {
                if (action === 'update') await call('packs:apply', { path: p, keys: keys.filter(k => snap.updates[k]) });
                else if (action === 'pin' || action === 'unpin') { await call('packs:mod-meta', { path: p, keys, patch: { pinned: action === 'pin' } }); UI.Island.toast(action === 'pin' ? `Pinned ${fmt.plural(keys.length, 'Item', 'Items')}` : `Unpinned ${fmt.plural(keys.length, 'Item', 'Items')}`); }
                else if (action === 'check') await call('packs:check', { path: p, keys });
                else if (action === 'off' || action === 'on') { await call('packs:disable', { path: p, keys, disabled: action === 'off' }); UI.Island.toast(`${action === 'off' ? 'Turned Off' : 'Turned On'} ${fmt.plural(keys.length, 'Item', 'Items')}`); }
                else if (action === 'remove') {
                    if (!(await UI.confirm({ title: `Remove ${fmt.plural(keys.length, 'Item', 'Items')}?`, message: 'Their files are deleted from both platform folders of this pack.', confirmLabel: 'Remove', danger: true }))) return;
                    await call('packs:remove', { path: p, keys });
                    UI.Island.toast(`Removed ${fmt.plural(keys.length, 'Item', 'Items')}`);
                    setSelecting(false);
                }
            } catch (err) { UI.Island.error(err); }
        }

        function refilter(resetScroll = false) {
            const q = ui.query;
            const list = snap.meta.mods.filter(m => {
                const k = modKey(m);
                if (ui.filter === 'updates' && !snap.updates[k]) return false;
                if (ui.filter === 'missing' && !snap.missing[k]) return false;
                if (ui.filter === 'pinned' && !m.pinned) return false;
                if (ui.type !== 'any' && Lib.typeOf(m).id !== ui.type) return false;
                const cf = !!m.ids.curseforge, mr = !!m.ids.modrinth;
                if (ui.platform === 'both' && !(cf && mr)) return false;
                if (ui.platform === 'modrinth' && !(mr && !cf)) return false;
                if (ui.platform === 'curseforge' && !(cf && !mr)) return false;
                if (ui.platform === 'differ' && platformVersions(m, snap.meta.gameVersion).same) return false;
                if (ui.platform === 'manual' && !m.manual) return false;
                if (ui.side !== 'any') {
                    const s = sideOf(m);
                    if (ui.side === 'client' && !(s.client && !s.server)) return false;
                    if (ui.side === 'server' && !(s.server && !s.client)) return false;
                }
                if (q) {
                    const hay = `${m.names?.curseforge || ''} ${m.names?.modrinth || ''} ${m.authors?.curseforge || ''} ${m.authors?.modrinth || ''} ${m.notes || ''}`.toLowerCase();
                    if (!hay.includes(q)) return false;
                }
                return true;
            });
            const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
            const byName = (a, b) => collator.compare(modTitle(a).replace(/^\W+/, ''), modTitle(b).replace(/^\W+/, ''));
            const authorOf = (m) => m.authors?.curseforge || m.authors?.modrinth || '';
            if (ui.sort === 'name') list.sort(byName);
            else if (ui.sort === 'name-desc') list.sort((a, b) => byName(b, a));
            else if (ui.sort === 'author') list.sort((a, b) => (!authorOf(a) - !authorOf(b)) || collator.compare(authorOf(a), authorOf(b)) || byName(a, b));
            else if (ui.sort === 'added') list.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
            else list.sort((a, b) => (b.updatedAt || b.dateAdded || 0) - (a.updatedAt || a.dateAdded || 0));
            filtered = list;
            const seenKeys = new Map();
            rowKeys = list.map(m => { const k = modKey(m); const n = seenKeys.get(k) || 0; seenKeys.set(k, n + 1); return n ? `${k}#${n}` : k; });
            viewport.style.height = `${list.length * ROW}px`;
            emptyEl.classList.toggle('hidden', list.length > 0);
            listHead.classList.toggle('hidden', !list.length);
            if (!list.length) emptyEl.replaceChildren(...emptyContent());
            if (resetScroll && page.scrollTop > topIn(panel)) page.scrollTop = topIn(panel) - 8;
            paint();
        }

        function emptyContent() {
            if (!snap.meta.mods.length) return [h('div.art', icon('sparkle')), h('h3', 'This Pack Is Empty'), h('p', `Add mods, resource packs, shaders and data packs for Minecraft ${snap.meta.gameVersion} on ${LOADERS[snap.meta.loader]}.`), h('button.btn.primary', { on: { click: () => Browse.open(snap) } }, icon('plus'), 'Add Content')];
            if (ui.filter === 'updates') return [h('div.art', icon('check')), h('h3', 'Everything Is Up to Date'), h('p', snap.checkedAt ? `Checked ${fmt.ago(snap.checkedAt)}.` : 'Check for updates to see what changed.')];
            if (ui.filter === 'missing') return [h('div.art', icon('check')), h('h3', 'All Files Are Present'), h('p', 'Every mod file this pack lists is in its folder.')];
            if (ui.filter === 'pinned') return [h('div.art', icon('pin')), h('h3', 'No Pinned Content'), h('p', 'Pin a mod to keep its current version when you update everything else.')];
            return [h('h3', 'No Matching Content'), h('p', 'Try a different filter or search.')];
        }

        const rowSig = (m) => {
            const k = modKey(m);
            return `${m.meta?.mrVersionId}|${m.meta?.cfFileId}|${JSON.stringify(Object.entries(snap.updates[k] || {}).map(([pl, u]) => [pl, u.versionId || u.fileId]))}|${!!snap.missing[k]}|${modTitle(m)}|${modIcon(m)}|${m.pinned}|${m.side}|${!!m.disabled}|${selecting}|${selected.has(k)}`;
        };

        function buildRow(m) {
            const k = modKey(m);
            const upd = snap.updates[k];
            const miss = snap.missing[k];
            const side = sideOf(m);
            const author = m.authors?.curseforge || m.authors?.modrinth;
            const pv = platformVersions(m, snap.meta.gameVersion);
            const actions = h('div.act');
            const sw = UI.toggle(!m.disabled, (on) => {
                call('packs:disable', { path: snap.meta.path, keys: [k], disabled: !on })
                    .then(() => UI.Island.toast(on ? 'Turned On' : 'Turned Off', modTitle(m)))
                    .catch((err) => { sw.set(!m.disabled); UI.Island.error(err); });
            }, `${m.disabled ? 'Turn on' : 'Turn off'} ${modTitle(m)}`);
            sw.classList.add('sm');
            sw.title = m.disabled ? 'Off: the game won’t load this. Click to turn it on.' : 'On. Click to turn it off without removing it.';
            sw.addEventListener('click', (e) => e.stopPropagation());
            actions.append(sw);
            if (upd) actions.append(
                h('button.btn.ghost.sm.icon', { title: 'View Changelog', 'aria-label': `View the changelog for ${modTitle(m)}`, on: { click: (e) => { e.stopPropagation(); Changelogs.open(snap, m); } } }, icon('tag')),
                h('button.btn.green.sm', { title: `Install ${Object.keys(upd).length > 1 ? 'both updates' : 'update'}\n${updateSummary(m, upd)}`, on: { click: (e) => { e.stopPropagation(); call('packs:apply', { path: snap.meta.path, keys: [k] }).catch(UI.Island.error); } } }, 'Update'));
            else if (miss) actions.append(h('button.btn.tinted.sm', { title: 'Download missing files', on: { click: (e) => { e.stopPropagation(); call('packs:redownload', { path: snap.meta.path, keys: [k], mode: 'missing' }).catch(UI.Island.error); } } }, 'Repair'));
            actions.append(h('button.btn.ghost.sm.icon.more', { title: 'More', on: { click: (e) => { e.stopPropagation(); rowMenu(e.currentTarget, m); } } }, icon('more')));
            return h(`div.row${selecting ? '.selectable' : ''}${selected.has(k) ? '.selected' : ''}${m.disabled ? '.off' : ''}`, {
                tabindex: '0',
                on: {
                    click: (e) => onRowClick(e, m),
                    keydown: (e) => { if (e.key === 'Enter') Inspector.open(m); if (e.key === ' ' && selecting) { e.preventDefault(); toggleSel(k); } },
                    contextmenu: (e) => { e.preventDefault(); rowMenu(e.currentTarget.querySelector('.more'), m); }
                }
            },
            h('span.check', icon('check')),
            img(modIcon(m)),
            h('div', { style: { minWidth: 0 } },
                h('div.name', h('span', modTitle(m)),
                    twinMarks(m, upd),
                    !pv.same ? h('span.chip.sm.amber', { title: `Modrinth: ${pv.mr}\nCurseForge: ${pv.cf}` }, 'Versions Differ') : null,
                    Lib.typeOf(m).id !== 'mod' ? h('span.chip.sm', Lib.typeOf(m).one) : null,
                    m.pinned ? h('span.chip.sm.accent', { title: 'Pinned. Updates skip this item.' }, icon('pin'), 'Pinned') : null,
                    m.disabled ? h('span.chip.sm', { title: 'Turned off: its files end in .disabled and Play leaves it out.' }, 'Off') : null,
                    isLocal(m) ? h('span.chip.sm', { title: 'Not on Modrinth or CurseForge. Exports bundle the file itself.' }, 'Local File') : null,
                    ['modrinth', 'curseforge'].some(pl => sideState(m, pl) === 'pending') ? h('span.chip.sm.amber', { title: 'CurseForge doesn’t allow apps to download this mod. Download it yourself from the mod’s details.' }, 'Download Needed') : null,
                    ['modrinth', 'curseforge'].map(pl => copyOutdated(m, pl)).filter(Boolean).map(o => h('span.chip.sm.amber', { title: `The ${PL_NAME[o.from]} file was updated (${o.was} → ${o.now}). The copy stays as it is until you update it.` }, 'Copy Outdated')),
                    miss && !upd ? h('span.chip.sm.amber', icon('warn'), 'File Missing') : null),
                h('div.sub', author ? `by ${author}` : (m.summary || ''))),
            pv.same
                ? h('div.file.mono', { title: upd ? updateSummary(m, upd) : versionLabel(m) }, versionLabel(m))
                : h('div.file.mono.split', { title: upd ? updateSummary(m, upd) : `Modrinth: ${pv.mr}\nCurseForge: ${pv.cf}` },
                    h('span.vline', h('span.twin.mr.on'), h('span.ellipsis', pv.mrShort)),
                    h('span.vline', h('span.twin.cf.on'), h('span.ellipsis', pv.cfShort))),
            h('div.env',
                h('span', { class: side.client ? 'on' : 'off', title: side.client ? 'Runs on the client' : 'Not needed on the client' }, icon('monitor')),
                h('span', { class: side.server ? 'on' : 'off', title: side.server ? 'Runs on the server' : 'Not needed on the server' }, icon('server'))),
            actions);
        }

        function toggleSel(k) {
            if (selected.has(k)) selected.delete(k); else selected.add(k);
            syncBulk();
            paint();
        }
        function onRowClick(e, m) {
            const k = modKey(m);
            if (!selecting && (e.ctrlKey || e.metaKey || e.shiftKey)) setSelecting(true);
            if (selecting) {
                if (e.shiftKey && lastClicked) {
                    const a = filtered.findIndex(x => modKey(x) === lastClicked), b = filtered.findIndex(x => modKey(x) === k);
                    const [lo, hi] = a < b ? [a, b] : [b, a];
                    for (let i = lo; i <= hi; i++) selected.add(modKey(filtered[i]));
                    syncBulk(); paint();
                } else toggleSel(k);
                lastClicked = k;
                return;
            }
            Inspector.open(m);
        }

        function rowMenu(anchor, m) {
            const k = modKey(m);
            const p = snap.meta.path;
            UI.menu(anchor, [
                { label: 'Show Details', icon: 'chev', onClick: () => Inspector.open(m) },
                snap.updates[k] ? { label: 'Install update', icon: 'arrow-up', onClick: () => call('packs:apply', { path: p, keys: [k] }).catch(UI.Island.error) }
                    : { label: 'Check for Update', icon: 'refresh', onClick: () => call('packs:check', { path: p, keys: [k] }).then(r => UI.Island.toast(r.count ? 'Update Available' : 'Up to Date', modTitle(m))).catch(UI.Island.error) },
                isLocal(m) ? null : { label: 'Change Version…', icon: 'history', onClick: () => Versions.open(snap, m) },
                snap.updates[k] ? { label: 'View Changelog…', icon: 'tag', onClick: () => Changelogs.open(snap, m) } : null,
                snap.updates[k]?.modrinth && snap.updates[k]?.curseforge ? { label: 'Update Modrinth Only', icon: 'modrinth', onClick: () => call('packs:apply', { path: p, keys: [k], platforms: ['modrinth'] }).catch(UI.Island.error) } : null,
                snap.updates[k]?.modrinth && snap.updates[k]?.curseforge ? { label: 'Update CurseForge Only', icon: 'curseforge', onClick: () => call('packs:apply', { path: p, keys: [k], platforms: ['curseforge'] }).catch(UI.Island.error) } : null,
                isLocal(m) ? null : { label: 'Link Platforms…', icon: 'link', onClick: () => linkEntry(snap, m) },
                { label: m.pinned ? 'Unpin Version' : 'Pin Version', icon: 'pin', onClick: () => call('packs:mod-meta', { path: p, keys: [k], patch: { pinned: !m.pinned } }).catch(UI.Island.error) },
                isLocal(m) ? null : { label: 'Download Again', icon: 'download', onClick: () => call('packs:redownload', { path: p, keys: [k] }).catch(UI.Island.error) },
                'sep',
                m.links?.modrinth ? { label: 'Open on Modrinth', icon: 'modrinth', onClick: () => PageViewer.open(m.links.modrinth, { platform: 'modrinth', title: modTitle(m) }) } : null,
                m.links?.curseforge ? { label: 'Open on CurseForge', icon: 'curseforge', onClick: () => PageViewer.open(m.links.curseforge, { platform: 'curseforge', title: modTitle(m) }) } : null,
                'sep',
                { label: 'Remove from Pack', icon: 'trash', danger: true, onClick: async () => {
                    if (!(await UI.confirm({ title: `Remove ${modTitle(m)}?`, message: 'Its files are deleted from both platform folders of this pack.', confirmLabel: 'Remove', danger: true }))) return;
                    await call('packs:remove', { path: p, keys: [k] }).catch(UI.Island.error);
                    UI.Island.toast('Removed', modTitle(m));
                } }
            ]);
        }

        // Virtualized: only rows near the viewport exist, and unchanged rows are reused.
        // Sum offsetTop up to the scrolling page itself, not every parent, or offsets get counted twice.
        const topIn = (el) => el.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop;

        function paint() {
            const top = topIn(viewport);
            const from = Math.max(0, Math.floor((page.scrollTop - top) / ROW) - OVERSCAN);
            const to = Math.min(filtered.length, Math.ceil((page.scrollTop - top + page.clientHeight) / ROW) + OVERSCAN);
            const keep = new Set();
            const frag = document.createDocumentFragment();
            for (let i = from; i < to; i++) {
                const m = filtered[i];
                const k = rowKeys[i];   // a shared key would stack two rows and leave a gap
                keep.add(k);
                const sig = rowSig(m);
                let r = rowCache.get(k);
                if (!r || r.sig !== sig) {
                    r?.el.remove();
                    r = { el: buildRow(m), sig };
                    if (firstPaint && i < 12) { r.el.classList.add('enter'); r.el.style.animationDelay = `${i * 22}ms`; }
                    if (flashKeys.has(k)) { r.el.classList.add('flash'); flashKeys.delete(k); }
                    rowCache.set(k, r);
                    frag.append(r.el);
                }
                if (r.i !== i) { r.el.style.transform = `translateY(${i * ROW}px)`; r.i = i; }
            }
            viewport.append(frag);
            for (const [k, r] of rowCache) if (!keep.has(k)) { r.el.remove(); rowCache.delete(k); }
            firstPaint = false;
        }
        const onScroll = rafThrottle(() => {
            toolbar.classList.toggle('stuck', page.scrollTop > topIn(panel) - 6);
            paint();
        });
        page.addEventListener('scroll', onScroll, { passive: true });
        const ro = new ResizeObserver(onScroll);
        ro.observe(page);
        const onKey = (e) => {
            if (!selecting) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !e.target.closest('input, textarea')) { e.preventDefault(); filtered.forEach(m => selected.add(modKey(m))); syncBulk(); paint(); }
            if (e.key === 'Escape' && !document.querySelector('.layer .drawer, .layer .dialog, .layer .menu')) setSelecting(false);
        };
        document.addEventListener('keydown', onKey);

        compact.querySelector('span').textContent = snap.meta.name;
        refilter();

        return {
            update(next) {
                snap = next;
                for (const m of snap.meta.mods) { const k = modKey(m); if (!knownKeys.has(k)) flashKeys.add(k); }
                knownKeys = new Set(snap.meta.mods.map(modKey));
                for (const k of [...selected]) if (!knownKeys.has(k)) selected.delete(k);
                compact.querySelector('span').textContent = snap.meta.name;
                syncBulk();
                refilter();
            },
            showUpdates() { ui.filter = 'updates'; filterSeg.set('updates'); refilter(true); },
            destroy() { ro.disconnect(); page.removeEventListener('scroll', onScroll); document.removeEventListener('keydown', onKey); bulkbar.remove(); }
        };
    }

    function linkEntry(snap, m) {
        Linker.open({
            item: { title: modTitle(m), icon: modIcon(m), platforms: { curseforge: m.ids.curseforge ? { id: m.ids.curseforge } : null, modrinth: m.ids.modrinth ? { id: m.ids.modrinth } : null } },
            type: Lib.typeOf(m).id,
            pack: { path: snap.meta.path, gameVersion: snap.meta.gameVersion, loader: snap.meta.loader }
        });
    }

    const Versions = {
        async open(snap, m) {
            const k = modKey(m);
            const platforms = ['modrinth', 'curseforge'].filter(p => m.ids[p]);
            let platform = platforms[0];
            const list = h('div.ver-list');
            const pin = UI.checkbox(!!m.pinned);
            const seg = platforms.length > 1 ? UI.segmented(platforms.map(p => ({ value: p, label: h(`span.plat.${p === 'modrinth' ? 'mr' : 'cf'}`, p === 'modrinth' ? 'Modrinth' : 'CurseForge') })), platform, (v) => { platform = v; load(); }) : null;
            const d = UI.dialog({ content: [
                h('div.dialog-body',
                    h('h2', `Versions of ${modTitle(m)}`),
                    h('p', `Builds for Minecraft ${snap.meta.gameVersion} on ${LOADERS[snap.meta.loader]}. Installing one replaces the current file.`),
                    h('div.row-flex', seg, h('span.grow'), h('label.row-flex', pin, h('span', 'Pin After Installing'))),
                    list),
                h('div.dialog-foot', h('button.btn', { on: { click: () => d.close() } }, 'Close'))
            ] });
            async function load() {
                list.replaceChildren(...Array.from({ length: 5 }, () => h('div.ver', h('div.sk', { style: { height: '14px', width: '60%' } }))));
                try {
                    const versions = await call('packs:versions', { path: snap.meta.path, key: k, platform });
                    const current = platform === 'modrinth' ? m.meta?.mrVersionId : Number(m.meta?.cfFileId);
                    list.replaceChildren(...versions.map(v => {
                        const isCur = String(v.id) === String(current);
                        const btn = h(`button.btn.sm${isCur ? '.ghost' : '.tinted'}`, { disabled: isCur || v.available === false }, isCur ? 'Installed' : v.available === false ? 'Unavailable' : 'Install');
                        btn.addEventListener('click', async () => {
                            btn.disabled = true; btn.replaceChildren(h('span.spinner'));
                            try {
                                await call('packs:set-version', { path: snap.meta.path, key: k, platform, versionId: v.id, pin: pin.get() });
                                UI.Island.toast('Version Changed', v.label);
                                d.close();
                            } catch (err) { UI.Island.error(err); btn.disabled = false; btn.replaceChildren('Install'); }
                        });
                        return h(`div.ver${isCur ? '.current' : ''}`,
                            h('div', { style: { minWidth: 0 } }, h('div.n.ellipsis', v.label), h('div.f.ellipsis', v.fileName)),
                            h('div.row-flex', v.type !== 'release' ? h(`span.chip.sm.${v.type === 'beta' ? 'amber' : 'red'}`, v.type) : null, h('span.faint', { style: { fontSize: '12px' } }, fmt.ago(v.date))),
                            btn);
                    }));
                    if (!versions.length) list.replaceChildren(h('div.empty', h('h3', 'No Compatible Versions'), h('p', 'This platform has no builds for this Minecraft version and loader.')));
                } catch (err) { list.replaceChildren(h('div.empty', h('h3', 'Couldn’t Load Versions'), h('p', err.message))); }
            }
            load();
        }
    };

    const Inspector = (() => {
        let current = null;
        function content(m, snap) {
            const k = modKey(m);
            const upd = snap.updates[k];
            const path = snap.meta.path;
            const side = sideOf(m);
            const cell = (key, value) => value ? h('div.cell', h('span.k', key), h('span.v', { title: value }, value)) : null;
            const linkCell = (label, url) => h('div.cell.link', { tabindex: '0', role: 'button', on: { click: () => PageViewer.open(url, { platform: label === 'Modrinth' ? 'modrinth' : 'curseforge', title: modTitle(m) }), keydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } } }, h('span.plat', { class: label === 'Modrinth' ? 'mr' : 'cf' }, label), h('span.v.muted', url.replace(/^https:\/\/(www\.)?/, '')), icon('external'));
            const platformGroup = (pl, label) => m.ids[pl] && !m.manual?.[pl] ? [
                h('div.group-title', label),
                h('div.group',
                    cell('File', m.installedFiles?.[pl]),
                    cell('Version', pl === 'modrinth' ? m.meta?.mrVersionNumber : m.meta?.cfDisplayName),
                    cell('Author', m.authors?.[pl]),
                    cell('Size', m.sizes?.[pl] ? fmt.bytes(m.sizes[pl]) : null),
                    snap.missing[k]?.includes(pl) ? h('div.cell', h('span.chip.amber', icon('warn'), 'File Missing on Disk')) : null)
            ] : null;
            const meta = (patch) => call('packs:mod-meta', { path, keys: [k], patch }).catch(UI.Island.error);
            const btn = (label, onClick, cls = '') => h(`button.btn.sm${cls}`, { on: { click: onClick } }, label);
            const useFile = (pl, source) => call('packs:manual-file', { path, key: k, platform: pl, source })
                .then(r => { if (r) UI.Island.toast(`${PL_NAME[pl]} File Added`, modTitle(m)); }).catch(UI.Island.error);
            const manualGroup = (pl) => {
                const label = PL_NAME[pl], o = pl === 'modrinth' ? 'curseforge' : 'modrinth';
                const st = sideState(m, pl);
                const r = m.manual?.[pl];
                if (st === 'platform' || isLocal(m)) return null;
                if (st === 'pending') return [h('div.group-title', label), h('div.group',
                    h('div.cell.col', h('div.t', 'Download Needed'), h('div.d', `The author doesn’t allow apps to download this mod. Download ${r.expectedFile} from CurseForge, then choose that file here.`)),
                    h('div.cell.btns', btn('Open Download Page', () => call('shell:open', { url: r.page }).catch(UI.Island.error)), btn('Choose Downloaded File…', () => useFile(pl, 'file'), '.primary')))];
                if (st === 'manual') {
                    const from = PL_NAME[r.from];
                    const old = copyOutdated(m, pl);
                    const update = async () => {
                        if (!(await UI.confirm({ title: `Update the ${label} Copy?`, message: `Copies ${old.now} from ${from} into the ${label} edition. Only do this once that version is fine to ship on ${label}: exports bundle the file inside the pack.`, confirmLabel: 'Update Copy' }))) return;
                        useFile(pl, 'copy');
                    };
                    const remove = async () => {
                        if (!(await UI.confirm({ title: `Remove the ${label} File?`, message: r.from === 'download' ? 'The mod goes back to waiting for its CurseForge download.' : `The ${label} edition of the pack leaves this mod out again.`, confirmLabel: 'Remove', danger: true }))) return;
                        call('packs:manual-remove', { path, key: k, platform: pl }).catch(UI.Island.error);
                    };
                    return [h('div.group-title', `${label} · Added by Hand`), h('div.group',
                        cell('File', m.installedFiles?.[pl]),
                        cell('Source', from ? `Copied from ${from}` : r.from === 'download' ? 'Downloaded from CurseForge' : 'Chosen by hand'),
                        cell('Version', r.version),
                        snap.manualMissing?.[k]?.includes(pl) ? h('div.cell', h('span.chip.amber', icon('warn'), 'File Missing on Disk')) : null,
                        r.from === 'download' && r.matches === false ? h('div.cell.col', h('div.d', 'This isn’t the exact file CurseForge lists for this pack.')) : null,
                        old ? h('div.cell.col', h('div.t', `${from} Has a Newer File`), h('div.d', `${old.was} → ${old.now}. The copy stays as it is until you update it.`)) : null,
                        h('div.cell.btns',
                            old ? btn(`Update from ${from}`, update, '.green') : null,
                            btn('Replace with a File…', () => useFile(pl, 'file')),
                            btn('Remove', remove, '.danger')))];
                }
                if (!m.installedFiles?.[o]) return null;
                return [h('div.group-title', label), h('div.group',
                    h('div.cell.col', h('div.t', `Not on ${label}`), h('div.d', `The ${label} edition of the pack leaves this mod out. Add a file by hand to include it; exports bundle it inside the pack.`)),
                    h('div.cell.btns', btn(`Use the ${PL_NAME[o]} File`, () => useFile(pl, 'copy'), '.primary'), btn('Choose a File…', () => useFile(pl, 'file'))))];
            };
            const localGroup = () => isLocal(m) ? [h('div.group-title', 'Local File'), h('div.group',
                cell('File', m.installedFiles?.modrinth || m.installedFiles?.curseforge),
                cell('Version', m.manual?.modrinth?.version || m.manual?.curseforge?.version),
                h('div.cell.col', h('div.d', 'Not on Modrinth or CurseForge. Both editions use this file, and exports bundle it inside the pack.')))] : null;
            const sideSel = h('select.field', { style: { width: '170px', height: '34px' } },
                h('option', { value: '' }, 'Automatic'), h('option', { value: 'both' }, 'Client and Server'), h('option', { value: 'client' }, 'Client Only'), h('option', { value: 'server' }, 'Server Only'));
            sideSel.value = m.side || '';
            sideSel.addEventListener('change', () => meta({ side: sideSel.value || null }));
            const notes = h('textarea.field', { placeholder: 'Why is this mod here? Config tweaks, known issues…', style: { minHeight: '70px' } });
            notes.value = m.notes || '';
            notes.addEventListener('change', () => meta({ notes: notes.value }));
            const bundled = m.contents?.bundled || [];

            return [
                h('div.drawer-body',
                    h('div.inspector-hero',
                        img(modIcon(m), 'squircle'),
                        h('h2', modTitle(m)),
                        h('p', m.summary || ''),
                        h('div.inspector-chips',
                            Lib.typeOf(m).id !== 'mod' ? h('span.chip', icon(Lib.typeOf(m).icon), Lib.typeOf(m).one) : null,
                            sideState(m, 'modrinth') ? h('span.chip', { title: sidesTitle(m) }, h('span.plat.mr', sideState(m, 'modrinth') === 'platform' ? 'Modrinth' : 'Modrinth (by Hand)')) : null,
                            sideState(m, 'curseforge') ? h('span.chip', { title: sidesTitle(m) }, h('span.plat.cf', sideState(m, 'curseforge') === 'platform' ? 'CurseForge' : 'CurseForge (by Hand)')) : null,
                            h('span.chip', icon('monitor'), side.client ? 'Client' : 'No Client'),
                            h('span.chip', icon('server'), side.server ? 'Server' : 'No Server'),
                            m.pinned ? h('span.chip.accent', icon('pin'), 'Pinned') : null)),
                    upd ? h('div.update-note.stacked',
                        ...Object.entries(upd).map(([pl, u]) => h('div.update-line',
                            h(`span.plat.${pl === 'modrinth' ? 'mr' : 'cf'}`, PL_NAME[pl]),
                            h('span.grow.mono.ellipsis', { title: `${(pl === 'modrinth' ? m.meta?.mrVersionNumber : m.meta?.cfDisplayName) || ''} → ${u.versionNumber || u.displayName || u.fileName}` }, `${coreVersion(pl === 'modrinth' ? m.meta?.mrVersionNumber : m.meta?.cfDisplayName, snap.meta.gameVersion) || 'Installed'} → ${coreVersion(u.versionNumber || u.displayName || u.fileName, snap.meta.gameVersion) || u.versionNumber || u.displayName}`),
                            Object.keys(upd).length > 1 ? h('button.btn.ghost.sm', { on: { click: () => call('packs:apply', { path, keys: [k], platforms: [pl] }).catch(UI.Island.error) } }, 'Only This') : null)),
                        h('div.update-line',
                            h('span.grow', Object.keys(upd).length === 1 ? `${PL_NAME[Object.keys(upd)[0]]} only. ${m.ids[Object.keys(upd)[0] === 'modrinth' ? 'curseforge' : 'modrinth'] ? `${PL_NAME[Object.keys(upd)[0] === 'modrinth' ? 'curseforge' : 'modrinth']} is up to date.` : ''}` : ''),
                            h('button.btn.sm', { on: { click: () => Changelogs.open(snap, m) } }, 'View Changelog'),
                            h('button.btn.green.sm', { on: { click: () => call('packs:apply', { path, keys: [k] }).catch(UI.Island.error) } }, Object.keys(upd).length > 1 ? 'Update Both' : 'Update'))) : null,
                    h('div.group-title', 'In This Pack'),
                    h('div.group',
                        h('div.cell', h('span.grow', h('div.t', 'Enabled'), h('div.d', 'Off renames its files to .disabled, so the game, Play and exports skip it.')), UI.toggle(!m.disabled, (v) => call('packs:disable', { path, keys: [k], disabled: !v }).catch(UI.Island.error))),
                        h('div.cell', h('span.grow', h('div.t', 'Pin Version'), h('div.d', 'Updates skip this mod until you unpin it.')), UI.toggle(!!m.pinned, (v) => meta({ pinned: v }))),
                        h('div.cell', h('span.grow', h('div.t', 'Optional'), h('div.d', 'Players can turn it off when installing the pack.')), UI.toggle(!!m.optional, (v) => meta({ optional: v }))),
                        h('div.cell', h('span.grow', h('div.t', 'Runs On'), h('div.d', 'Decides which exports include it.')), sideSel),
                        h('div.cell.col', h('div.t', 'Notes'), notes),
                        isLocal(m) ? null : h('div.cell.link', { tabindex: '0', on: { click: () => Versions.open(snap, m) } }, icon('history'), h('span.grow', 'Change Version…'), icon('chev')),
                        isLocal(m) ? null : h('div.cell.link', { tabindex: '0', on: { click: () => linkEntry(snap, m) } }, icon('link'), h('span.grow', 'Link Platforms…'), icon('chev'))),
                    localGroup(),
                    platformGroup('modrinth', 'Modrinth'),
                    manualGroup('modrinth'),
                    platformGroup('curseforge', 'CurseForge'),
                    manualGroup('curseforge'),
                    bundled.length ? [h('div.group-title', `Bundled Inside (${bundled.length})`),
                        h('div.group', bundled.slice(0, 30).map(b => h('div.cell', h('span.k.ellipsis', b.name || b.id), h('span.v.mono', b.version || ''))))] : null,
                    h('div.group-title', 'Links'),
                    h('div.group',
                        m.links?.modrinth ? linkCell('Modrinth', m.links.modrinth) : null,
                        m.links?.curseforge ? linkCell('CurseForge', m.links.curseforge) : null),
                    h('div.group', cell('Added', m.dateAdded ? new Date(m.dateAdded).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null), m.updatedAt ? cell('Updated', fmt.ago(m.updatedAt)) : null),
                    h('div.inspector-actions',
                        isLocal(m) ? null : h('button.btn', { on: { click: () => call('packs:redownload', { path, keys: [k] }).catch(UI.Island.error) } }, icon('download'), 'Download Again'),
                        h('button.btn.danger', { on: { click: async () => {
                            if (!(await UI.confirm({ title: `Remove ${modTitle(m)}?`, message: 'Its files are deleted from both platform folders of this pack.', confirmLabel: 'Remove', danger: true }))) return;
                            await call('packs:remove', { path, keys: [k] }).catch(UI.Island.error);
                            close();
                        } } }, icon('trash'), 'Remove')))
            ];
        }
        function open(m) {
            const snap = App.state.get().snapshot;
            if (current) { current.d.el.replaceChildren(...content(m, snap)); current.key = modKey(m); return; }
            const d = UI.drawer({ narrow: true, content: content(m, snap), onClose: () => { current = null; } });
            current = { key: modKey(m), d };
        }
        function refresh(snap) {
            if (!current) return;
            const m = snap.meta.mods.find(x => modKey(x) === current.key);
            if (!m) return close();
            // Don't rebuild while the notes field is being edited.
            if (current.d.el.contains(document.activeElement) && document.activeElement.matches('textarea, select')) return;
            const body = current.d.el.querySelector('.drawer-body');
            const st = body?.scrollTop || 0;
            current.d.el.replaceChildren(...content(m, snap));
            current.d.el.querySelector('.drawer-body').scrollTop = st;
        }
        function close() { current?.d.close(); current = null; }
        return { open, refresh, close };
    })();

    window.PackView = PackView;
    window.Inspector = Inspector;
    window.Versions = Versions;
})();
