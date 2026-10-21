(() => {
    const { h, img, icon, call, fmt, LOADERS, debounce, modKey, TYPES } = Lib;
    const PAGE = 20;
    const MIXED = new Set(['all', 'both']);

    let lastPlatform = 'all';
    let lastType = 'mod';

    const SAVED = (packPath) => `incursion.browse:${packPath}`;
    const loadSaved = (packPath) => { try { return JSON.parse(localStorage.getItem(SAVED(packPath))) || null; } catch { return null; } };
    const storeSaved = (packPath, v) => { try { localStorage.setItem(SAVED(packPath), JSON.stringify(v)); } catch {} };

    function open(snapshot) {
        const meta = snapshot.meta;
        const saved = loadSaved(meta.path);
        const st = {
            query: saved?.query || '', platform: saved?.platform || lastPlatform, type: TYPES[saved?.type] ? saved.type : lastType,
            sort: saved?.sort || 'relevance', page: 0, last: null, token: 0,
            // Start index of each page in All / On Both. Pages can come up short, so it isn't page × 20.
            starts: Array.isArray(saved?.starts) && saved.starts[0] === 0 ? saved.starts.map(n => n | 0) : [0]
        };
        const save = () => storeSaved(meta.path, { type: st.type, platform: st.platform, sort: st.sort, query: st.query, page: st.page, starts: st.starts, scroll: Math.round(body.scrollTop) });
        const startOf = (page) => (MIXED.has(st.platform) ? st.starts[Math.min(page, st.starts.length - 1)] : page * PAGE);
        const packMods = () => {
            const snap = App.state.get().snapshot;
            return snap?.meta.path === meta.path ? snap.meta.mods : meta.mods;
        };
        const entryFor = (item, mods = packMods()) => mods.find(m =>
            (item.platforms.curseforge?.id && Number(m.ids.curseforge) === Number(item.platforms.curseforge.id)) ||
            (item.platforms.modrinth?.id && m.ids.modrinth === item.platforms.modrinth.id));
        const cards = new Set();

        const input = h('input.field', { type: 'search', placeholder: 'Search Mods', spellcheck: false, autofocus: true, value: st.query });
        const results = h('div.results');
        const depsSlot = h('div.deps-slot');
        const noticeSlot = h('div.notice-slot');
        const footInfo = h('span.muted.foot-info');
        const pager = h('nav.pager.hidden', { 'aria-label': 'Result pages' });
        const body = h('div.drawer-body', results);

        const typeSeg = UI.segmented(Object.values(TYPES).map(t => ({ value: t.id, label: t.label })), st.type, (v) => {
            st.type = lastType = v;
            input.placeholder = `Search ${TYPES[v].many}`;
            reset();
        });
        input.placeholder = `Search ${TYPES[st.type].many}`;
        const platformSeg = UI.segmented([
            { value: 'all', label: 'All' },
            { value: 'both', label: 'On Both' },
            { value: 'modrinth', label: h('span.plat.mr', 'Modrinth') },
            { value: 'curseforge', label: h('span.plat.cf', 'CurseForge') }
        ], st.platform, (v) => { st.platform = lastPlatform = v; reset(); });

        const d = UI.drawer({
            onClose: () => { save(); unsub(); },
            content: [
                h('div.drawer-head',
                    h('div.drawer-title',
                        h('div', h('h2', 'Add Content'), h('p', `Compatible with Minecraft ${meta.gameVersion} on ${LOADERS[meta.loader]}`)),
                        h('button.btn.ghost.icon', { title: 'Close', on: { click: () => d.close() } }, icon('x'))),
                    typeSeg,
                    h('label.search', icon('search'), input),
                    h('div.drawer-filters',
                        platformSeg,
                        UI.picker({ label: 'Sort By', value: st.sort, onChange: v => { st.sort = v; reset(); }, options: [
                            { value: 'relevance', label: 'Relevance', short: 'Relevance' },
                            { value: 'downloads', label: 'Downloads' },
                            { value: 'popular', label: 'Popularity' },
                            { value: 'updated', label: 'Recently Updated' },
                            { value: 'newest', label: 'Newest' }] }))),
                depsSlot,
                noticeSlot,
                body,
                h('div.drawer-foot', footInfo, pager, h('button.btn', { on: { click: () => d.close() } }, 'Done'))
            ]
        });
        setTimeout(() => input.focus(), 120);

        // Hovering a tab preloads its first page. Main shares the work with the real request, so it costs nothing
        // extra.
        const warmed = new Set();
        function warm(over) {
            const q = { path: meta.path, query: st.query, gameVersion: meta.gameVersion, loader: meta.loader, platform: st.platform, sort: st.sort, offset: 0, limit: PAGE, type: st.type, warm: true, ...over };
            const k = JSON.stringify(q);
            if (warmed.has(k)) return;
            warmed.add(k);
            call('mods:search', q).catch(() => warmed.delete(k));
        }
        typeSeg.addEventListener('pointerover', (e) => { const v = e.target.closest('button[data-value]')?.dataset.value; if (v && v !== st.type) warm({ type: v }); });
        platformSeg.addEventListener('pointerover', (e) => { const v = e.target.closest('button[data-value]')?.dataset.value; if (v && v !== st.platform) warm({ platform: v }); });
        input.addEventListener('input', debounce(() => { st.query = input.value; reset(); }, 280));
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { st.query = input.value; reset(); } });
        body.addEventListener('scroll', debounce(save, 300), { passive: true });

        function skeletons(n = 6) {
            return Array.from({ length: n }, () => h('div.result-skeleton', h('div.sk', { style: { width: '44px', height: '44px', borderRadius: '8px' } }),
                h('div', h('div.sk', { style: { width: '40%', height: '13px', marginTop: '6px' } }), h('div.sk', { style: { width: '85%', height: '11px', marginTop: '10px' } }))));
        }

        function reset() { st.last = null; st.starts = [0]; goTo(0); }

        function pageCount() {
            const r = st.last;
            if (!r) return 1;
            if (MIXED.has(st.platform)) return r.exhausted && !r.hasMore ? Math.max(1, st.starts.filter(n => n < r.found).length) : null;
            return Math.max(1, Math.ceil(r.totalHint / PAGE));
        }

        function renderNotice(r) {
            if (!r?.cfUnavailable) { noticeSlot.replaceChildren(); return; }
            const verify = r.cfUnavailable === 'VERIFY_CANCELLED';
            noticeSlot.replaceChildren(h('div.inline-notice',
                icon('warn'),
                h('span.grow', verify ? 'CurseForge check not completed. Showing Modrinth only.' : 'CurseForge isn’t available. Showing Modrinth only.'),
                verify ? h('button.btn.sm', { on: { click: () => reset() } }, 'Try Again')
                    : h('button.btn.sm', { on: { click: () => { d.close(); App.go({ name: 'settings', section: 'keys' }); } } }, 'Open Settings')));
        }

        async function goTo(page, restoreScroll = 0, more = false) {
            if (MIXED.has(st.platform)) page = Math.min(page, st.starts.length - 1);
            st.page = page;
            const token = ++st.token;
            results.replaceChildren(...skeletons()); body.scrollTop = 0; renderPager(true); save();
            try {
                const offset = startOf(page);
                const r = await call('mods:search', { path: meta.path, query: st.query, gameVersion: meta.gameVersion, loader: meta.loader, platform: st.platform, sort: st.sort, offset, limit: PAGE, type: st.type, more });
                if (token !== st.token) return;   // superseded by a newer search
                st.last = { ...r, offset };
                if (MIXED.has(st.platform) && r.mods.length && st.starts[page + 1] !== r.nextOffset) { st.starts[page + 1] = r.nextOffset; st.starts.length = page + 2; save(); }
                renderNotice(r);
                cards.clear();
                results.replaceChildren(...r.mods.map(card));
                if (restoreScroll) requestAnimationFrame(() => { body.scrollTop = restoreScroll; });
                if (!r.mods.length && r.hasMore) results.replaceChildren(h('div.empty',
                    h('h3', 'No Matches Yet'),
                    h('p', `No new ${st.platform === 'both' ? 'mods on both platforms' : 'results'} in the next ${fmt.count(r.scannedNow || 0)} listings read. ${st.sort === 'newest' ? 'Most brand-new projects are on one platform only so far.' : 'Keep looking to read further.'}`),
                    h('div.row-flex', h('button.btn.primary', { on: { click: () => goTo(page, 0, true) } }, 'Keep Looking'),
                        page > 0 ? h('button.btn', { on: { click: () => goTo(0) } }, 'Back to Page 1') : null,
                        st.platform === 'both' ? h('button.btn', { on: { click: () => { platformSeg.set('all'); st.platform = lastPlatform = 'all'; reset(); } } }, 'Show All') : null)));
                else if (!r.mods.length) results.replaceChildren(page > 0
                    ? h('div.empty', h('h3', 'No More Results'), h('p', 'That is everything for this search.'), h('button.btn', { on: { click: () => goTo(0) } }, 'Back to Page 1'))
                    : h('div.empty', h('h3', `No ${TYPES[st.type].label} Found`), h('p', st.platform === 'both' ? 'Only projects published on both platforms show here. Try All.' : 'Try a different search.')));
                renderPager(false);
            } catch (err) {
                if (token !== st.token) return;
                noticeSlot.replaceChildren();
                const cfIssue = err.code === 'NO_CF_KEY' || err.code === 'VERIFY_CANCELLED';
                const modrinthOnly = h('button.btn', { on: { click: () => { platformSeg.set('modrinth'); st.platform = lastPlatform = 'modrinth'; reset(); } } }, 'Show Modrinth Only');
                results.replaceChildren(h('div.empty',
                    h('h3', err.code === 'NO_CF_KEY' ? 'CurseForge Isn’t Available' : err.code === 'VERIFY_CANCELLED' ? 'CurseForge Check Not Completed' : 'Search Failed'),
                    h('p', err.code === 'VERIFY_CANCELLED' ? 'The quick verification window was closed. Try again, or browse Modrinth only.' : err.message),
                    cfIssue
                        ? h('div.row-flex', st.platform !== 'modrinth' ? modrinthOnly : null,
                            err.code === 'VERIFY_CANCELLED' ? h('button.btn.primary', { on: { click: () => goTo(page) } }, 'Try Again')
                                : h('button.btn.primary', { on: { click: () => { d.close(); App.go({ name: 'settings', section: 'keys' }); } } }, 'Open Settings'))
                        : h('button.btn', { on: { click: () => goTo(page) } }, 'Try Again')));
                renderPager(false);
            }
        }

        function renderPager(loading) {
            const r = st.last;
            const total = pageCount();
            const p = st.page;
            const hasNext = r ? (total ? p + 1 < total : r.hasMore) : false;
            if (r && r.mods.length) {
                const from = (r.offset ?? p * PAGE) + 1, to = (r.offset ?? p * PAGE) + r.mods.length;
                const of = MIXED.has(st.platform)
                    ? (r.exhausted ? fmt.count(r.found) : `${fmt.count(r.found)}+`)
                    : fmt.count(r.totalHint);
                footInfo.textContent = `${fmt.count(from)}–${fmt.count(to)} of ${of}`;
                footInfo.title = MIXED.has(st.platform) && !r.exhausted ? `Up to ${fmt.count(r.totalHint)} listings across both platforms. Each mod is shown once, with the platforms it is on.` : '';
            } else if (!loading) footInfo.textContent = '';
            const known = total ?? (MIXED.has(st.platform) ? Math.max(p + 1, st.starts.length - 1) : Math.max(p + 1, Math.ceil((r?.found || 0) / PAGE)));
            const nums = new Set([0, p - 1, p, p + 1, known - 1].filter(n => n >= 0 && n < known));
            const btns = [];
            let prev = -1;
            for (const n of [...nums].sort((a, b) => a - b)) {
                if (n - prev > 1) btns.push(h('span.pager-gap', '…'));
                btns.push(h('button.pager-num', { class: n === p ? 'on' : '', 'aria-current': n === p ? 'page' : null, disabled: loading, on: { click: () => goTo(n) } }, fmt.count(n + 1)));
                prev = n;
            }
            if (total === null && hasNext) btns.push(h('span.pager-gap', '…'));
            pager.replaceChildren(
                h('button.btn.sm.icon', { title: 'Previous Page', 'aria-label': 'Previous Page', disabled: loading || p === 0, on: { click: () => goTo(p - 1) } }, icon('chev-left')),
                ...btns,
                h('button.btn.sm.icon', { title: 'Next Page', 'aria-label': 'Next Page', disabled: loading || !hasNext, on: { click: () => goTo(p + 1) } }, icon('chev')));
            pager.classList.toggle('hidden', !r || (known <= 1 && !hasNext));
        }

        function setBtn(btn, state, item) {
            btn.dataset.state = state;
            btn.disabled = state === 'busy';
            btn.className = `btn add-btn ${state === 'added' ? 'added' : 'tinted'}`;
            if (state === 'busy') btn.replaceChildren(h('span.spinner'));
            else if (state === 'added') btn.replaceChildren(h('span.when-idle', icon('check'), 'Added'), h('span.when-hover', icon('x'), 'Remove'));
            else btn.replaceChildren(state === 'retry' ? 'Retry' : 'Add');
            btn.setAttribute('aria-label', state === 'added' ? `Remove ${item.title} from the pack` : `Add ${item.title}`);
            btn.title = state === 'added' ? 'In this pack. Click to remove it.' : '';
        }
        function syncCards() {
            const mods = packMods();
            for (const c of cards) {
                if (!c.btn.isConnected) { cards.delete(c); continue; }
                if (c.btn.dataset.state === 'busy') continue;
                const want = entryFor(c.item, mods) ? 'added' : 'add';
                if (c.btn.dataset.state !== want && !(want === 'add' && c.btn.dataset.state === 'retry')) setBtn(c.btn, want, c.item);
            }
        }
        const unsub = App.state.sub(syncCards);

        function platformLinks(item) {
            const link = (pl, label) => {
                const p = item.platforms[pl];
                const b = h(`button.plat-link.${pl === 'modrinth' ? 'mr' : 'cf'}${p?.blocked ? '.blocked' : ''}`, {
                    title: p?.blocked ? `Open on ${label}. Its author doesn’t allow apps to download it, so you’ll download the file yourself.` : p ? `Open on ${label}` : `Not on ${label}`, 'aria-label': p ? `Open ${item.title} on ${label}` : `Not on ${label}`, disabled: !p,
                    on: { click: (e) => { e.stopPropagation(); PageViewer.open(p.url, { platform: pl, title: item.title }); } }
                }, PageViewer.brand(pl));
                return b;
            };
            const linkBtn = h('button.plat-link.relink', {
                title: 'Link Platforms: choose the same mod on the other platform', 'aria-label': `Link ${item.title} across platforms`,
                on: { click: (e) => { e.stopPropagation(); Linker.open({ item, type: st.type, pack: { path: meta.path, gameVersion: meta.gameVersion, loader: meta.loader }, onDone: () => goTo(st.page) }); } }
            }, icon('link'));
            return h('span.plat-links', link('modrinth', 'Modrinth'), link('curseforge', 'CurseForge'), linkBtn);
        }

        function card(item) {
            const btn = h('button.btn.add-btn');
            setBtn(btn, entryFor(item) ? 'added' : 'add', item);
            btn.addEventListener('click', () => (btn.dataset.state === 'added' ? remove(item, btn) : add([item], btn)));
            cards.add({ item, btn });
            return h('div.result',
                img(item.icon),
                h('div', { style: { minWidth: 0 } },
                    h('div.t', h('span.ellipsis', item.title), platformLinks(item)),
                    h('div.meta', item.author ? h('span', `by ${item.author}`) : null, h('span', icon('download'), ` ${fmt.count(item.downloads)}`), item.updated ? h('span', `updated ${fmt.ago(item.updated)}`) : null),
                    h('div.s', item.summary || '')),
                btn);
        }

        async function add(items, btn) {
            if (btn) setBtn(btn, 'busy', items[0]);
            try {
                const res = await call('packs:add', { path: meta.path, items });
                const ok = res.added.length > 0;
                if (btn) setBtn(btn, ok || !res.failed.length ? 'added' : 'retry', items[0]);
                if (res.failed.length) UI.Island.error(`${res.failed[0].title}: ${res.failed[0].error}`);
                else if (ok) UI.Island.toast(items.length === 1 ? 'Added' : `${res.added.length} added`, items.length === 1 ? items[0].title : '');
                const warn = res.added.flatMap(a => a.warnings || []);
                if (warn.length) UI.Island.toast('Added to One Platform Only', warn[0], 'error');
                if (res.dependencies?.length) showDeps(res.dependencies, items);
            } catch (err) {
                UI.Island.error(err);
                if (btn) setBtn(btn, 'retry', items[0]);
            }
        }

        // No confirmation on remove: adding it back is one click.
        async function remove(item, btn) {
            setBtn(btn, 'busy', item);
            try {
                let entry = entryFor(item);
                if (!entry) entry = entryFor(item, (await call('packs:load', { path: meta.path })).meta.mods);
                if (entry) await call('packs:remove', { path: meta.path, keys: [modKey(entry)] });
                setBtn(btn, 'add', item);
                UI.Island.toast('Removed', item.title);
            } catch (err) {
                UI.Island.error(err);
                setBtn(btn, 'added', item);
            }
        }

        function showDeps(deps, parents) {
            const cardEl = h('div.deps-card');
            const label = `${parents.length === 1 ? parents[0].title : 'These mods'} ${deps.length === 1 ? 'needs' : 'need'} ${fmt.plural(deps.length, 'dependency', 'dependencies')}`;
            DepsPicker.render(cardEl, deps, App.state.get().snapshot || snapshot, { title: label, compact: true, onDone: (r) => (r.dependencies?.length ? showDeps(r.dependencies, r.added) : cardEl.remove()) });
            depsSlot.replaceChildren(cardEl);
        }

        if (saved) goTo(Math.max(0, saved.page | 0), saved.scroll | 0); else reset();
    }

    window.Browse = { open };
})();
