(() => {
    const { h, img, icon, call, fmt, debounce } = Lib;
    const NAME = { curseforge: 'CurseForge', modrinth: 'Modrinth' };
    const SOURCE = { manual: 'Linked by you', pack: 'Linked by this pack', auto: 'Matched automatically', community: 'Linked by the community' };

    function open({ item, pack, type = 'mod', onDone }) {
        const sides = ['curseforge', 'modrinth'].filter(pl => item.platforms[pl]?.id);
        if (!sides.length) return;
        let from = sides[0];
        const to = () => (from === 'curseforge' ? 'modrinth' : 'curseforge');
        const fromId = () => item.platforms[from].id;
        const currentTo = () => item.platforms[to()]?.id ?? null;

        const status = h('div.link-status');
        const input = h('input.field', { type: 'search', spellcheck: false, value: item.title || '' });
        const list = h('div.link-list');
        const err = h('p.err-text.hidden');
        const noneBtn = h('button.btn');
        const clearBtn = h('button.btn.ghost.hidden', 'Remove Saved Link');
        const dirSeg = sides.length > 1
            ? UI.segmented(sides.map(pl => ({ value: pl, label: `Change the ${NAME[pl === 'curseforge' ? 'modrinth' : 'curseforge']} Project` })), from, (v) => { from = v; refresh(); })
            : null;

        const d = UI.dialog({ wide: true, content: [
            h('div.dialog-body.link-body',
                h('div.link-head', img(item.icon, 'squircle'), h('div', { style: { minWidth: 0 } }, h('h2.ellipsis', `Link ${item.title}`), h('p.link-sub'))),
                dirSeg, status,
                h('label.search', icon('search'), input),
                list, err),
            h('div.dialog-foot', clearBtn, h('span.grow'), noneBtn, h('button.btn', { on: { click: () => d.close() } }, 'Close'))
        ] });
        const sub = d.el.querySelector('.link-sub');

        async function save(target) {
            err.classList.add('hidden');
            try {
                await call('links:set', { path: pack?.path, platform: from, id: fromId(), to: target, title: item.title, type });
                UI.Island.toast(target == null ? `Marked as Not on ${NAME[to()]}` : 'Platforms Linked', item.title);
                d.close();
                onDone?.();
            } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
        }
        noneBtn.addEventListener('click', () => save(null));
        clearBtn.addEventListener('click', async () => {
            try { await call('links:clear', { path: pack?.path, platform: from, id: fromId(), type }); UI.Island.toast('Saved Link Removed', 'Incursion matches this mod automatically again.'); d.close(); onDone?.(); }
            catch (e) { UI.Island.error(e); }
        });

        async function refresh() {
            sub.textContent = `Choose the ${NAME[to()]} project that is the same mod as this ${NAME[from]} project${pack ? `, with builds for Minecraft ${pack.gameVersion}` : ''}.`;
            noneBtn.textContent = `Not on ${NAME[to()]}`;
            try {
                const info = await call('links:info', { path: pack?.path, platform: from, id: fromId(), type });
                const l = info.link;
                const linkedTo = l ? (to() === 'curseforge' ? l.cf : l.mr) : undefined;
                status.replaceChildren(l
                    ? h('span', h(`span.chip.sm${l.source === 'manual' ? '.accent' : ''}`, SOURCE[l.source] || 'Linked'),
                        linkedTo == null ? ` Saved as not on ${NAME[to()]}.` : ` The linked ${NAME[to()]} project is marked Linked below.`)
                    : h('span.muted', 'No saved link. Incursion matches this mod by its files, links and name.'));
                clearBtn.classList.toggle('hidden', !l);
            } catch { status.replaceChildren(); }
            search();
        }

        let token = 0;
        async function search() {
            const mine = ++token;
            list.replaceChildren(...Array.from({ length: 4 }, () => h('div.link-row', h('div.sk', { style: { height: '14px', width: '50%' } }))));
            try {
                const r = await call('mods:search', { query: input.value.trim(), gameVersion: pack.gameVersion, loader: pack.loader, platform: to(), sort: 'relevance', offset: 0, limit: 12, type });
                if (mine !== token) return;
                const cur = currentTo();
                const rows = r.mods.map(m => {
                    const p = m.platforms[to()];
                    const isCur = cur != null && String(p.id) === String(cur);
                    const btn = h(`button.btn.sm${isCur ? '.ghost' : '.tinted'}`, { disabled: isCur, on: { click: () => save(p.id) } }, isCur ? 'Linked' : 'Link');
                    return h(`div.link-row${isCur ? '.current' : ''}`,
                        img(m.icon),
                        h('div', { style: { minWidth: 0 } },
                            h('div.t.ellipsis', m.title),
                            h('div.meta', m.author ? h('span', `by ${m.author}`) : null, h('span', icon('download'), ` ${fmt.count(m.downloads)}`), h('span.mono.faint', String(p.slug || p.id)))),
                        h('button.plat-link', { class: to() === 'modrinth' ? 'mr' : 'cf', title: `Open on ${NAME[to()]}`, on: { click: () => PageViewer.open(p.url, { platform: to(), title: m.title }) } }, PageViewer.brand(to())),
                        btn);
                });
                list.replaceChildren(...(rows.length ? rows : [h('div.empty', h('h3', 'No Projects Found'), h('p', `Try another name, or choose Not on ${NAME[to()]}.`))]));
            } catch (e) {
                if (mine !== token) return;
                list.replaceChildren(h('div.empty', h('h3', 'Search Failed'), h('p', e.message)));
            }
        }
        input.addEventListener('input', debounce(search, 300));
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
        refresh();
        setTimeout(() => input.select(), 80);
    }

    window.Linker = { open };
})();
