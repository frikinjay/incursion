(() => {
    const { h, icon, call } = Lib;

    let st = { status: 'idle' };
    let prompted = null;
    const listeners = new Set();
    const pill = h('div.update-pill', { 'aria-live': 'polite' });

    function render() {
        const v = st.latest?.version;
        pill.classList.toggle('show', ['available', 'downloading', 'ready', 'installing'].includes(st.status));
        pill.classList.toggle('error', !!st.error && st.status === 'available');
        if (!pill.classList.contains('show')) { pill.replaceChildren(); return; }
        const notes = h('button.up-text', { title: st.error || `What’s new in ${v}`, on: { click: whatsNew } }, icon(st.error ? 'warn' : 'sparkle'), h('span', `Incursion ${v}`));
        if (st.status === 'available' && st.method === 'manual') {
            pill.replaceChildren(notes, h('button.btn.sm.primary', { title: st.manualReason || '', on: { click: () => call('shell:open', { url: st.latest.url }) } }, 'Download'));
        } else if (st.status === 'available') {
            pill.replaceChildren(notes, h('button.btn.sm.primary', { on: { click: download } }, st.error ? 'Try Again' : 'Update'));
        } else if (st.status === 'downloading') {
            const pct = st.progress != null ? Math.round(st.progress * 100) : null;
            const bar = h('span.up-bar', h('i', { style: { width: `${pct ?? 0}%` } }));
            pill.replaceChildren(h('span.up-text', icon('download'), h('span', pct != null ? `Downloading ${v} · ${pct}%` : `Downloading ${v}`)), bar);
        } else if (st.status === 'ready') {
            pill.replaceChildren(notes, h('button.btn.sm.primary', { on: { click: () => restartPrompt() } }, 'Restart to Update'));
        } else if (st.status === 'installing') {
            pill.replaceChildren(h('span.up-text', icon('download'), h('span', `Installing ${v}…`)));
        }
    }

    async function download() {
        try { await call('update:download'); }
        catch (err) { UI.Island.error(err); }
    }

    async function install() {
        try { await call('update:install'); }
        catch (err) { UI.Island.error(err); }
    }

    function restartPrompt() {
        const v = st.latest?.version;
        let restart = false;
        const now = h('button.btn.primary', { on: { click: () => { restart = true; d.close(); } } }, 'Restart Now');
        const d = UI.dialog({
            small: true,
            onClose: () => { if (restart) install(); },
            content: [
                h('div.dialog-body', h('h2', `Incursion ${v} Is Ready`),
                    h('p', 'Restart now to finish updating. Your packs are saved first. If you restart later, the update installs the next time you quit Incursion.')),
                h('div.dialog-foot', h('button.btn', { on: { click: () => d.close() } }, 'Later'), now)
            ]
        });
        setTimeout(() => now.focus(), 50);
    }

    function whatsNew() {
        const v = st.latest?.version;
        const action = st.status === 'ready' ? h('button.btn.primary', { on: { click: () => { d.close(); restartPrompt(); } } }, 'Restart to Update')
            : st.status === 'available' && st.method !== 'manual' ? h('button.btn.primary', { on: { click: () => { d.close(); download(); } } }, 'Update')
            : st.latest?.url ? h('button.btn.primary', { on: { click: () => call('shell:open', { url: st.latest.url }) } }, 'Open Release Page') : null;
        const body = h('div.update-notes', Changelogs.markdown(st.latest?.notes || 'No release notes.'));
        const d = UI.dialog({
            content: [
                h('div.dialog-body',
                    h('h2', st.latest?.title || `Incursion ${v}`),
                    h('p', `You have ${st.current}.${st.error ? ` ${st.error}` : st.method === 'manual' && st.manualReason ? ` ${st.manualReason}` : ''}`),
                    body),
                h('div.dialog-foot', h('button.btn', { on: { click: () => d.close() } }, 'Close'), action)
            ]
        });
    }

    function update(next) {
        const was = st.status;
        st = next || { status: 'idle' };
        render();
        for (const fn of listeners) fn(st);
        if (was === 'downloading' && st.status === 'available' && st.error) UI.Island.error(st.error);
        if (st.status === 'ready' && was === 'downloading' && prompted !== st.latest?.version) {
            prompted = st.latest?.version;
            restartPrompt();
        }
    }

    function mount() {
        const island = document.getElementById('island');
        island.before(pill);
        call('update:status').then(update).catch(() => {});
    }

    window.Updates = { mount, update, on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, check: () => call('update:check').then((s) => { update(s); return s; }), state: () => st, whatsNew };
})();
