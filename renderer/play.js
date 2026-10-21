(() => {
    const { h, img, icon, call, fmt } = Lib;

    const instances = new Map();
    let accounts = { active: null, list: [], offlineAllowed: false };
    const listeners = new Set();
    const notify = () => listeners.forEach(fn => fn());

    const activeAccount = () => accounts.list.find(a => a.uuid === accounts.active) || null;
    const liveFor = (packPath) => [...instances.values()].find(i => i.packPath === packPath && ['preparing', 'running', 'stopping'].includes(i.state));
    const isLive = (i) => ['preparing', 'running', 'stopping'].includes(i.state);

    async function refreshAccounts() { accounts = await call('play:accounts'); renderAccount(); notify(); }

    async function signIn() {
        try {
            UI.Island.toast('Opening Microsoft Sign-In', '', 'done');
            accounts = await call('play:login');
            renderAccount(); notify();
            UI.Island.toast('Signed In', activeAccount()?.name || '');
            return true;
        } catch (err) { UI.Island.error(err); return false; }
    }

    function accountMenu(anchor) {
        const items = [{ heading: 'Minecraft Accounts' }];
        for (const a of accounts.list) items.push({ label: `${a.name}${a.type === 'crack' ? ' (Offline)' : ''}`, checked: a.uuid === accounts.active, onClick: () => call('play:select', { uuid: a.uuid }).then(r => { accounts = r; renderAccount(); notify(); }) });
        items.push('sep', { label: 'Add Microsoft Account', icon: 'plus', onClick: signIn });
        if (accounts.offlineAllowed) items.push({ label: 'Add Offline Account', icon: 'key', onClick: () => call('play:login-offline', { name: 'Tester' }).then(r => { accounts = r; renderAccount(); notify(); }) });
        const cur = activeAccount();
        if (cur) items.push('sep', { label: `Sign Out ${cur.name}`, icon: 'x', danger: true, onClick: () => call('play:logout', { uuid: cur.uuid }).then(r => { accounts = r; renderAccount(); notify(); UI.Island.toast('Signed out', cur.name); }) });
        UI.menu(anchor, items, { align: 'left' });
    }

    function renderAccount() {
        const slot = document.getElementById('accountSlot');
        if (!slot) return;
        const a = activeAccount();
        if (!a) {
            slot.replaceChildren(h('button.nav-item.account', { on: { click: (e) => accounts.list.length ? accountMenu(e.currentTarget) : signIn() } },
                h('span.avatar.none', icon('key')), h('span', h('span.acc-name', 'Sign In to Play'), h('span.acc-sub', 'Microsoft Account'))));
            return;
        }
        const avatar = img(a.avatar, 'avatar');
        slot.replaceChildren(h('button.nav-item.account', { title: 'Switch Account', on: { click: (e) => accountMenu(e.currentTarget) } },
            avatar, h('span', h('span.acc-name', a.name), h('span.acc-sub', a.type === 'crack' ? 'Offline Account' : 'Microsoft Account')), icon('chev-down')));
    }

    function onInstance(sum) {
        const prev = instances.get(sum.id);
        instances.set(sum.id, sum);
        const taskId = `play-${sum.id}`;
        if (sum.state === 'preparing') UI.Island.task({ id: taskId, label: `Launching ${sum.packName}`, detail: sum.status + (sum.progress != null ? ` ${Math.round(sum.progress * 100)}%` : ''), progress: sum.progress, state: 'running' });
        else if (prev?.state === 'preparing' && sum.state === 'running') UI.Island.task({ id: taskId, label: `${sum.packName} Is Running`, detail: '', state: 'done' });
        else if (prev?.state === 'preparing' && sum.state === 'failed') {
            UI.Island.task({ id: taskId, label: 'Launch Failed', detail: sum.status, state: 'error' });
            if (sum.errorCode === 'JAVA_MISSING') offerJava(sum);
        }
        else if (sum.state === 'crashed' && prev?.state !== 'crashed') UI.Island.task({ id: taskId, label: `${sum.packName} Crashed`, detail: `exit code ${sum.exitCode}`, state: 'error' });
        const culprit = sum.crash?.analysis?.suspects?.[0];
        if (culprit && !prev?.crash?.analysis) UI.Island.toast(`Likely Cause: ${culprit.title}`, culprit.reasons[0], 'error');
        renderRunning();
        notify();
        Console.onInstance(sum);
    }

    function renderRunning() {
        const wrap = document.getElementById('runningSlot');
        if (!wrap) return;
        const list = [...instances.values()].filter(isLive);
        wrap.classList.toggle('hidden', !list.length);
        wrap.replaceChildren(
            h('div.nav-section', h('span.nav-heading', 'Running')),
            ...list.map(i => h('button.nav-item.nav-pack.run-item', { title: 'Show Console', on: { click: () => Console.open(i.id) } },
                img(i.icon, 'squircle'),
                h('span.name', i.packName),
                h(`span.run-dot.${i.state}`, { title: i.status }))));
    }

    async function launch(packPath, retried = false) {
        try {
            const sum = await call('play:launch', { path: packPath });
            onInstance(sum);
            if (!activeAccount()) refreshAccounts();
        } catch (err) {
            if (err.code !== 'NO_ACCOUNT' || retried) return UI.Island.error(err);
            await refreshAccounts();
            const ok = await UI.confirm({ title: 'Sign In to Play', message: `${err.message} Your sign-in stays on this computer, encrypted.`, confirmLabel: 'Sign In with Microsoft' });
            if (ok && (await signIn())) launch(packPath, true);
        }
    }

    const stop = (id, force = false) => call('play:stop', { id, force }).catch(UI.Island.error);
    async function forceStop(i) {
        if (i.state === 'running' || i.state === 'stopping') {
            const ok = await UI.confirm({ title: `Force Stop ${i.packName}?`, message: 'Minecraft is closed immediately without saving. Progress since the last autosave (about every 5 minutes) is lost. Use Stop to save and quit.', confirmLabel: 'Force Stop', danger: true });
            if (!ok) return;
        }
        stop(i.id, true);
    }

    async function playOptions(anchor, packPath) {
        let meta;
        try { meta = (await call('packs:load', { path: packPath })).meta; } catch (err) { return UI.Island.error(err); }
        const l = meta.launch || {};
        const set = (patch) => call('packs:info', { path: packPath, fields: { launch: { ...l, ...patch } } }).catch(UI.Island.error);
        const plat = l.platform === 'modrinth' ? 'modrinth' : 'curseforge';
        const profs = meta.profiles || [];
        const cur = l.profile || 'full';
        const mrOnly = meta.mods.filter(m => !m.installedFiles?.curseforge).length, cfOnly = meta.mods.filter(m => !m.installedFiles?.modrinth).length;
        UI.menu(anchor, [
            { heading: 'Play With' },
            { label: `CurseForge Files${mrOnly ? ` (${mrOnly} Modrinth-only excluded)` : ''}`, icon: 'curseforge', checked: plat === 'curseforge', onClick: () => set({ platform: 'curseforge' }) },
            { label: `Modrinth Files${cfOnly ? ` (${cfOnly} CurseForge-only excluded)` : ''}`, icon: 'modrinth', checked: plat === 'modrinth', onClick: () => set({ platform: 'modrinth' }) },
            ...(profs.length ? ['sep', { heading: 'Profile' }, ...[{ id: 'full', name: 'Full' }, ...profs].map(p => ({ label: p.name, checked: p.id === cur, onClick: () => set({ profile: p.id === 'full' ? undefined : p.id }) }))] : []),
            'sep', { label: profs.length ? 'Edit Profiles…' : 'Create a Profile…', icon: 'sliders', onClick: () => App.go({ name: 'pack', path: packPath, tab: 'settings' }) }
        ], { align: 'right' });
    }

    async function offerJava(sum) {
        const ok = await UI.confirm({ title: `Download Java ${sum.javaMajor}?`, message: `${sum.packName} needs Java ${sum.javaMajor}, which isn't installed on this PC. Incursion can download Temurin ${sum.javaMajor} into its own folder (about 50 MB) and launch again.`, confirmLabel: `Download Java ${sum.javaMajor}` });
        if (!ok) return;
        try { await call('java:install', { major: sum.javaMajor }); launch(sum.packPath); }
        catch (err) { UI.Island.error(err); }
    }

    function button(packPath, opts = {}) {
        const btn = h('button.btn.lg.play-btn');
        const forceBtn = h(`button.btn.lg.icon.danger.force-btn.hidden`, { title: 'Force Stop', 'aria-label': 'Force Stop' }, icon('power'));
        const optsBtn = h(`button.btn.lg.profile-btn${opts.compact ? '.icon' : ''}`, { title: 'Play options: platform files and profile', 'aria-label': 'Play options', on: { click: (e) => playOptions(e.currentTarget, packPath) } });
        let optsSig = '';
        const renderOpts = () => {
            const e = App.state.get().library.find(x => x.path === packPath) || {};
            const plat = e.platform === 'modrinth' ? 'modrinth' : 'curseforge';
            const sig = `${plat}|${e.profile || ''}`;
            if (sig === optsSig) return;
            optsSig = sig;
            optsBtn.dataset.platform = plat === 'modrinth' ? 'mr' : 'cf';
            optsBtn.title = `Plays with ${plat === 'modrinth' ? 'Modrinth' : 'CurseForge'} files${e.profile ? `, profile ${e.profile}` : ''}. Click to change.`;
            optsBtn.replaceChildren(PageViewer.brand(plat), ...(opts.compact ? [] : [h('span.lbl', `${plat === 'modrinth' ? 'Modrinth' : 'CurseForge'}${e.profile ? ` · ${e.profile}` : ''}`), icon('chev-down')]));
        };
        renderOpts();
        const unsubOpts = App.state.sub(renderOpts);
        const consoleBtn = h('button.btn.lg.icon', { title: 'Console', on: { click: () => { const i = liveFor(packPath) || latestFor(packPath); if (i) Console.open(i.id); } } }, icon('terminal'));
        const render = () => {
            const i = liveFor(packPath);
            consoleBtn.classList.toggle('hidden', !i && !latestFor(packPath));
            forceBtn.classList.toggle('hidden', !i);
            if (i) { forceBtn.title = i.state === 'preparing' ? 'Cancel Launch' : 'Force Stop'; forceBtn.onclick = () => forceStop(i); }
            if (!i) {
                btn.className = 'btn lg primary play-btn';
                btn.disabled = false;
                btn.replaceChildren(icon('play'), 'Play');
                btn.onclick = () => launch(packPath);
            } else if (i.state === 'preparing') {
                btn.className = 'btn lg play-btn preparing';
                btn.disabled = true;
                btn.style.setProperty('--p', i.progress != null ? i.progress : 0);
                btn.replaceChildren(h('span.spinner'), i.progress != null ? `${Math.round(i.progress * 100)}%` : 'Starting');
            } else {
                btn.className = 'btn lg play-btn running';
                btn.disabled = i.state === 'stopping';
                btn.replaceChildren(icon('stop'), i.state === 'stopping' ? 'Stopping' : 'Stop');
                btn.onclick = () => stop(i.id);
            }
        };
        render();
        listeners.add(render);
        return { el: [btn, consoleBtn, forceBtn, optsBtn], destroy: () => { listeners.delete(render); unsubOpts(); } };
    }
    const latestFor = (packPath) => [...instances.values()].filter(i => i.packPath === packPath).sort((a, b) => b.startedAt - a.startedAt)[0];

    const Console = (() => {
        let cur = null;
        const MAX_DOM = 5000;

        function lineEl(l) {
            return h(`div.log.${l.level}`, h('span.ts', new Date(l.t).toLocaleTimeString(undefined, { hour12: false })), h('span.tx', l.text));
        }
        const visible = (l) => (cur.filter === 'all' || (cur.filter === 'warn' ? l.level === 'warn' || l.level === 'error' : l.level === 'error')) && (!cur.query || l.text.toLowerCase().includes(cur.query));

        function rerender() {
            const frag = document.createDocumentFragment();
            for (const l of cur.lines) if (visible(l)) frag.append(lineEl(l));
            cur.body.replaceChildren(frag);
            if (cur.follow) cur.scroller.scrollTop = cur.scroller.scrollHeight;
        }

        function append(lines) {
            cur.lines.push(...lines);
            if (cur.lines.length > MAX_DOM) cur.lines.splice(0, cur.lines.length - MAX_DOM);
            const frag = document.createDocumentFragment();
            for (const l of lines) if (visible(l)) frag.append(lineEl(l));
            cur.body.append(frag);
            while (cur.body.childElementCount > MAX_DOM) cur.body.firstElementChild.remove();
            if (cur.follow) cur.scroller.scrollTop = cur.scroller.scrollHeight;
        }

        function header(sum) {
            const live = isLive(sum);
            const elapsed = (sum.endedAt || Date.now()) - sum.startedAt;
            const mins = Math.floor(elapsed / 60000), secs = Math.floor(elapsed / 1000) % 60;
            cur.status.className = `status ${sum.state === 'running' ? 'ok' : sum.state === 'crashed' || sum.state === 'failed' ? 'bad' : ''}`;
            cur.status.textContent = `${sum.status}${live || sum.endedAt ? ` · ${mins}:${String(secs).padStart(2, '0')}` : ''}`;
            cur.stopBtn.classList.toggle('hidden', sum.state !== 'running');
            cur.forceStopBtn.classList.toggle('hidden', !live);
            cur.forceStopBtn.lastChild.textContent = sum.state === 'preparing' ? 'Cancel Launch' : 'Force Stop';
            cur.relaunchBtn.classList.toggle('hidden', live);
            cur.crashBtn.classList.toggle('hidden', !sum.crash);
            cur.analyseBtn.classList.toggle('hidden', !(sum.state === 'crashed' || sum.state === 'failed') || !!sum.crash?.analysis);
            renderAnalysis(sum);
        }

        function renderAnalysis(sum) {
            const a = sum.crash?.analysis;
            const sig = a ? JSON.stringify([a.headline, a.suspects.map(s => s.key)]) : '';
            if (cur.analysisSig === sig) return;
            cur.analysisSig = sig;
            if (!a) { cur.analysis.replaceChildren(); cur.analysis.classList.add('hidden'); return; }
            const openMod = async (key) => {
                const pack = App.state.get().route;
                if (pack.name !== 'pack' || pack.path !== sum.packPath) await App.go({ name: 'pack', path: sum.packPath });
                const snap = App.state.get().snapshot;
                const m = snap?.meta.mods.find(x => Lib.modKey(x) === key);
                if (m) { cur?.d?.close(); Inspector.open(m); }
            };
            cur.analysis.classList.remove('hidden');
            cur.analysis.replaceChildren(
                h('div.crash-head', icon('bug'), h('div', h('div.t', a.headline), a.cause ? h('div.d', a.cause) : a.exception && a.exception !== a.headline ? h('div.d.mono', a.exception) : null)),
                a.suspects.length
                    ? h('div.crash-suspects', a.suspects.map(s => h('button.crash-suspect', { on: { click: () => openMod(s.key) } },
                        h(`span.chip.sm${s.confidence === 'high' ? '.red' : s.confidence === 'medium' ? '.amber' : ''}`, s.confidence === 'high' ? 'Likely' : s.confidence === 'medium' ? 'Possible' : 'Mentioned'),
                        h('span.crash-title', s.title),
                        h('span.crash-reason', { title: s.reasons.join('\n') },s.reasons.join(' · ')),
                        icon('chev'))))
                    : h('p.muted', 'No pack entry is named in the crash output. The log below has the details.'));
        }

        async function open(id) {
            if (cur?.id === id) return;
            if (cur) close();
            let data;
            try { data = await call('play:subscribe', { id }); } catch (err) { return UI.Island.error(err); }
            const sum = data.instance;
            const body = h('div.log-body');
            const scroller = h('div.drawer-body.console', body);
            const status = h('span.status');
            const search = h('input.field', { type: 'search', placeholder: 'Filter Output', spellcheck: false });
            const follow = h('button.btn.ghost', { title: 'Follow new output' }, icon('arrow-down'), 'Follow');
            const stopBtn = h('button.btn.danger', { title: 'Close Minecraft normally: worlds are saved first', on: { click: () => stop(id) } }, icon('stop'), 'Stop');
            const forceStopBtn = h('button.btn.danger.solid', { title: 'Close the game immediately, without saving', on: { click: () => { const s = instances.get(id); if (s) forceStop(s); } } }, icon('power'), 'Force Stop');
            const relaunchBtn = h('button.btn.tinted', { on: { click: () => { close(); launch(sum.packPath); } } }, icon('play'), 'Play Again');
            const crashBtn = h('button.btn', { on: { click: () => call('play:folder', { id, what: 'crash' }) } }, icon('warn'), 'Crash Reports');
            const analyseBtn = h('button.btn.hidden', { on: { click: async (e) => { e.currentTarget.disabled = true; try { await call('play:analyse', { id }); } catch (err) { UI.Island.error(err); } } } }, icon('bug'), 'Analyse');
            const analysis = h('div.crash-card.hidden');
            cur = { id, body, scroller, status, stopBtn, forceStopBtn, relaunchBtn, crashBtn, analyseBtn, analysis, lines: [], filter: 'all', query: '', follow: true };

            const filterSeg = UI.segmented([{ value: 'all', label: 'All' }, { value: 'warn', label: 'Warnings' }, { value: 'error', label: 'Errors' }], 'all', (v) => { cur.filter = v; rerender(); });
            search.addEventListener('input', Lib.debounce(() => { cur.query = search.value.trim().toLowerCase(); rerender(); }, 120));
            const setFollow = (v) => { cur.follow = v; follow.classList.toggle('on', v); if (v) scroller.scrollTop = scroller.scrollHeight; };
            follow.addEventListener('click', () => setFollow(!cur.follow));
            scroller.addEventListener('scroll', Lib.rafThrottle(() => {
                const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
                if (cur && atBottom !== cur.follow) setFollow(atBottom);
            }), { passive: true });

            const d = UI.drawer({
                onClose: () => { call('play:unsubscribe', { id }); clearInterval(tick); if (cur?.id === id) cur = null; },
                content: [
                    h('div.drawer-head',
                        h('div.drawer-title',
                            h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
                                img(sum.icon, 'squircle console-icon'),
                                h('div', h('h2', sum.packName), h('p', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, status, sum.account ? h('span.muted', `as ${sum.account.name}`) : null))),
                            h('div', { style: { display: 'flex', gap: '6px' } },
                                analyseBtn, crashBtn, relaunchBtn, stopBtn, forceStopBtn,
                                h('button.btn.ghost.icon', { title: 'More', on: { click: (e) => UI.menu(e.currentTarget, [
                                    { label: 'Copy Output', icon: 'link', onClick: () => { navigator.clipboard.writeText(cur.lines.filter(visible).map(l => l.text).join('\n')); UI.Island.toast('Output Copied'); } },
                                    { label: 'Open Game Folder', icon: 'folder', onClick: () => call('play:folder', { id }) },
                                    { label: 'Open Logs Folder', icon: 'folder', onClick: () => call('play:folder', { id, what: 'logs' }) }
                                ]) } }, icon('more')),
                                h('button.btn.ghost.icon', { title: 'Close', on: { click: () => d.close() } }, icon('x')))),
                        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, filterSeg, h('label.search', { style: { flex: 1 } }, icon('search'), search), follow)),
                    analysis,
                    scroller
                ]
            });
            cur.d = d;
            follow.classList.add('on');
            header(sum);
            append(data.lines);
            const tick = setInterval(() => { const s = instances.get(id); if (s && cur?.id === id && isLive(s)) header(s); }, 1000);
        }

        function close() { cur?.d.close(); cur = null; }

        return {
            open,
            close,
            onInstance(sum) { if (cur?.id === sum.id) header(sum); },
            onLines({ id, lines }) { if (cur?.id === id) append(lines); }
        };
    })();

    window.incursion.on(({ type, payload }) => {
        if (type === 'instance') onInstance(payload);
        else if (type === 'console') Console.onLines(payload);
    });
    (async () => {
        await refreshAccounts();
        for (const s of await call('play:list')) instances.set(s.id, s);
        renderRunning();
    })().catch(() => {});

    window.Play = { button, launch, stop, signIn, openConsole: (id) => Console.open(id), activeAccount, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
})();
