(() => {
    const { h, img, icon, call, fmt, debounce, themeTransition, PRESETS } = Lib;

    const ACCENTS = [['Cobalt', '', '#0076ed'], ['Indigo', '#615ed6'], ['Violet', '#9751d7'], ['Magenta', '#d0399c'], ['Red', '#de3b3d'], ['Orange', '#e8721c'], ['Amber', '#e2a520'], ['Green', '#20a04e'], ['Teal', '#009b95'], ['Cyan', '#01a2c5'], ['Graphite', '#4e5661']];
    const PRESET_NAMES = { plain: 'Plain' };
    const SECTIONS = [['appearance', 'Appearance', 'palette'], ['accounts', 'Accounts', 'user'], ['keys', 'API Keys', 'key'], ['java', 'Java', 'cpu'], ['launch', 'Launch Defaults', 'sliders'], ['updates', 'Updates', 'refresh'], ['community', 'Community Links', 'globe'], ['data', 'Data', 'database']];
    const link = (label, url) => h('a', { on: { click: () => call('shell:open', { url }) } }, label);

    const SettingsView = {
        mount(root, focus) {
            const body = h('div.settings-body');
            const nav = h('nav.settings-nav', SECTIONS.map(([id, label, ic]) => h('button.nav-item', { on: { click: () => body.querySelector(`#set-${id}`)?.scrollIntoView({ behavior: 'smooth' }) } }, icon(ic), h('span.label', label))));
            const page = h('div.page', h('div.page-inner',
                h('div.page-head', h('div', h('h1.large-title', 'Settings'), h('p.subtitle', 'Changes save as you go.'))),
                h('div.settings', nav, body)));
            root.append(page);

            const section = (id, title, ...content) => h(`section.settings-section#set-${id}`, h('h2', title), ...content);
            let prefs = { ...App.state.get().prefs };
            const setPrefs = async (patch) => { prefs = await App.setPrefs(patch); return prefs; };

            const themeSeg = UI.segmented([{ value: 'system', label: 'Automatic' }, { value: 'light', label: h('span.row-flex', { style: { gap: '6px' } }, icon('sun'), 'Light') }, { value: 'dark', label: h('span.row-flex', { style: { gap: '6px' } }, icon('moon'), 'Dark') }], 'system', async (v) => {
                const r = await call('app:theme', { theme: v });
                const btn = themeSeg.querySelector(`[data-value="${v}"]`).getBoundingClientRect();
                const next = r.dark ? 'dark' : 'light';
                if (document.documentElement.dataset.theme !== next) themeTransition(btn.left + btn.width / 2, btn.top + btn.height / 2, () => { document.documentElement.dataset.theme = next; });
            });
            call('settings:get').then(s => themeSeg.set(s.theme || 'system')).catch(() => {});

            const swatches = h('div.swatches');
            const renderSwatches = () => {
                const cur = Lib.accentOf(prefs);
                const custom = h('input', { type: 'color', value: cur || '#0076ed', title: 'Custom Colour' });
                custom.addEventListener('input', debounce(() => { setPrefs({ accent: custom.value }).then(renderSwatches); }, 120));
                swatches.replaceChildren(...ACCENTS.map(([name, c, shown]) => h('button.swatch', { title: name, 'aria-label': `${name} accent`, class: cur === c ? 'on' : '', style: { '--c': shown || c }, on: { click: () => setPrefs({ accent: c }).then(renderSwatches) } })),
                    h('label.swatch.custom', { title: 'Custom Colour', class: ACCENTS.some(([, c]) => c === cur) ? '' : 'on', style: { '--c': cur || '#0076ed' } }, custom));
            };
            renderSwatches();

            const bgGrid = h('div.bg-grid');
            const renderBackgrounds = () => {
                const cur = !prefs.background || Lib.LEGACY_PRESETS.includes(prefs.background) ? 'plain' : prefs.background;
                const custom = (prefs.customBackgrounds || []).filter(Boolean);
                const tile = (value, label, preset) => {
                    const preview = h('div.backdrop', { dataset: { preset: preset ? value : 'image' } }, h('div.layer-img', preset ? {} : { style: { backgroundImage: `url("${value}")`, inset: '0' } }));
                    return h('button.bg-tile', { class: cur === value ? 'on' : '', title: label, on: { click: () => setPrefs({ background: value }).then(renderBackgrounds) } }, preview, h('span', label));
                };
                bgGrid.replaceChildren(
                    ...PRESETS.map(p => tile(p, PRESET_NAMES[p], true)),
                    ...custom.map((u, i) => tile(u, `Image ${i + 1}`, false)),
                    h('button.bg-tile.add', { title: 'Choose an Image', on: { click: async () => {
                        try {
                            const url = await call('dialog:background');
                            if (!url) return;
                            await setPrefs({ background: url, customBackgrounds: [...new Set([url, ...custom])].slice(0, 6), dim: 0.35 });
                            renderBackgrounds(); syncSliders();
                        } catch (err) { UI.Island.error(err); }
                    } } }, h('div.stack', { style: { alignItems: 'center', gap: '4px' } }, icon('image'), h('span', { style: { position: 'static', color: 'inherit', background: 'none', padding: 0 } }, 'Choose Image'))));
            };
            renderBackgrounds();
            const dim = h('input.range', { type: 'range', min: 0, max: 0.8, step: 0.05 });
            const blur = h('input.range', { type: 'range', min: 0, max: 40, step: 2 });
            const syncSliders = () => { dim.value = prefs.dim ?? 0; blur.value = prefs.blur ?? 0; };
            syncSliders();
            const livePreview = () => Lib.applyAppearance({ ...prefs, dim: Number(dim.value), blur: Number(blur.value) });
            dim.addEventListener('input', livePreview);
            blur.addEventListener('input', livePreview);
            dim.addEventListener('change', () => setPrefs({ dim: Number(dim.value) }));
            blur.addEventListener('change', () => setPrefs({ blur: Number(blur.value) }));

            body.append(section('appearance', 'Appearance',
                h('div.group',
                    h('div.cell', h('span.grow', h('div.t', 'Theme'), h('div.d', 'Automatic follows your system.')), themeSeg),
                    h('div.cell.col', h('div', h('div.t', 'Accent Colour'), h('div.d', 'Used for buttons, selection and highlights.')), swatches)),
                h('div.group-title', 'Wallpaper'),
                h('div.group', bgGrid,
                    h('div.cell', h('span.k', 'Dim'), dim),
                    h('div.cell', h('span.k', 'Blur'), blur)),
                h('div.group',
                    h('div.cell', h('span.grow', h('div.t', 'Animations'), h('div.d', 'Page fades, sheets sliding in and the theme crossfade. Off keeps everything instant.')), UI.toggle(prefs.motion !== false, (v) => setPrefs({ motion: v }))))));

            const accGroup = h('div.group');
            async function renderAccounts() {
                const acc = await call('play:accounts').catch(() => ({ list: [], active: null }));
                accGroup.replaceChildren(
                    ...acc.list.map(a => h('div.cell',
                        img(a.avatar, 'avatar'),
                        h('span.grow', h('div.t', a.name), h('div.d', a.type === 'crack' ? 'Offline Account' : 'Microsoft Account')),
                        a.uuid === acc.active ? h('span.chip.sm.accent', icon('check'), 'Playing As') : h('button.btn.sm', { on: { click: () => call('play:select', { uuid: a.uuid }).then(renderAccounts) } }, 'Use'),
                        h('button.btn.ghost.sm', { on: { click: () => call('play:logout', { uuid: a.uuid }).then(renderAccounts) } }, 'Sign Out'))),
                    h('div.cell', h('span.grow', h('div.t', acc.list.length ? 'Add Another Account' : 'Sign In to Play'), h('div.d', 'Opens Microsoft’s sign-in. After the first time, pick your account in one click or use a passkey / Windows Hello.')),
                        h('button.btn.primary.sm', { on: { click: async () => { if (await Play.signIn()) renderAccounts(); } } }, icon('user'), 'Sign In with Microsoft')));
            }
            renderAccounts();
            body.append(section('accounts', 'Accounts',
                accGroup,
                h('p.hint', { style: { margin: '-4px 6px 14px' } }, 'Windows doesn’t share its Microsoft account with other apps, so Incursion remembers its own sign-in. Passkeys and Windows Hello work in the sign-in window.'),
                h('div.group', h('div.cell', h('span.grow', h('div.t', 'Forget Remembered Microsoft Sign-In'), h('div.d', 'The next sign-in asks for your email and password or passkey again.')),
                    h('button.btn.sm.danger', { on: { click: async () => {
                        if (!(await UI.confirm({ title: 'Forget Microsoft Sign-In?', message: 'Your Minecraft accounts stay signed in. Only the remembered browser session is cleared.', confirmLabel: 'Forget', danger: true }))) return;
                        await call('play:logout', { uuid: '__none__', forgetBrowser: true }).catch(() => {});
                        UI.Island.toast('Microsoft Sign-In Forgotten');
                    } } }, 'Forget')))));

            const status = { curseforge: h('span.status', 'Not Checked'), curseforgeUpload: h('span.status', 'Not Checked'), modrinth: h('span.status', 'Not Checked') };
            const keyGroup = h('div');
            const KEY_INFO = {
                curseforge: { title: 'CurseForge API Key', what: 'Optional. Without one, CurseForge goes through the Incursion CurseForge service below.', help: [h('span', 'Sign in at '), link('console.curseforge.com', 'https://console.curseforge.com/?#/api-keys'), h('span', ', open API keys and copy your key (it starts with $2a$10$). Or set CURSEFORGE_API_KEY.')] },
                curseforgeUpload: { title: 'CurseForge Upload Token', what: 'Only for publishing. A different credential from the API key.', help: [h('span', 'Create one at '), link('curseforge.com/account/api-tokens', 'https://legacy.curseforge.com/account/api-tokens'), h('span', '. CURSEFORGE_TOKEN and CURSEFORGE_UPLOAD_TOKEN are read automatically.')] },
                modrinth: { title: 'Modrinth Token', what: 'Optional for browsing; needed for publishing.', help: [h('span', 'Create a personal access token at '), link('modrinth.com/settings/pats', 'https://modrinth.com/settings/pats'), h('span', ' with “Read projects” and “Create versions”. MODRINTH_TOKEN is read automatically.')] }
            };
            async function renderKeys() {
                const s = await call('settings:get');
                keyGroup.replaceChildren(...['curseforge', 'curseforgeUpload', 'modrinth'].map(k => {
                    const info = KEY_INFO[k];
                    const v = s[k];
                    const input = h('input.field', { type: 'password', placeholder: v.set ? v.masked : 'Paste to save', spellcheck: false, autocomplete: 'off' });
                    const saveBtn = h('button.btn.sm', { disabled: true }, 'Save');
                    input.addEventListener('input', () => { saveBtn.disabled = !input.value.trim(); });
                    saveBtn.addEventListener('click', async () => {
                        const value = input.value.trim();
                        if (!value) return;
                        saveBtn.disabled = true;
                        try {
                            const res = await call('settings:keys', { [k]: value });
                            setStatus(res);
                            input.value = '';
                            if (res.warning) UI.Island.toast(`${info.title} Saved`, res.warning, 'error'); else UI.Island.toast(`${info.title} Saved`, res[k]?.message || '');
                            renderKeys();
                        }
                        catch (err) { UI.Island.error(err); }
                        saveBtn.disabled = false;
                    });
                    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
                    const source = v.source && v.source !== 'settings' ? h('span.chip.sm.green', `From ${v.source}`) : v.saved ? h('span.chip.sm.accent', 'Saved in Incursion') : h('span.chip.sm', 'Not Set');
                    return [h('div.group-title', info.title), h('div.group',
                        h('div.cell', h('span.grow', h('div.t.label-with-logo', icon(k === 'modrinth' ? 'modrinth' : 'curseforge'), info.title), h('div.d', info.what)), source, status[k]),
                        h('div.key-row', input, saveBtn, v.saved ? h('button.btn.ghost.sm', { title: 'Remove the saved value and fall back to environment variables', on: { click: async () => { setStatus(await call('settings:keys', { [k]: '' })); renderKeys(); } } }, 'Clear') : null),
                        h('p.hint', { style: { margin: '-6px 16px 14px' } }, info.help))];
                }).flat());
            }
            const setStatus = (res) => { for (const k of ['curseforge', 'curseforgeUpload', 'modrinth']) { const r = res[k]; if (!r) continue; status[k].className = `status ${r.ok ? 'ok' : r.message === 'Not set' ? '' : 'bad'}`; status[k].textContent = r.message; } };
            renderKeys();
            call('settings:check').then(setStatus).catch(() => {});
            const svcGroup = h('div.group');
            const svcField = h('input.field', { spellcheck: false, placeholder: 'Custom service address (optional)' });
            async function renderService(st) {
                try { st ||= await call('cfservice:status'); }
                catch (err) { svcGroup.replaceChildren(h('div.cell', h('span.status.bad', err.message))); return; }
                svcField.value = st.custom || '';
                const state = !st.enabled ? h('span.status', 'Not set up')
                    : st.health?.ok && st.health.configured ? h(`span.status${st.verified ? '.ok' : ''}`, st.verified ? `Verified until ${new Date(st.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : 'Ready, verifies on first use')
                    : h('span.status.bad', st.health?.error ? 'Unreachable' : 'Not configured on the server');
                svcGroup.replaceChildren(...[
                    h('div.cell', h('span.grow', h('div.t.label-with-logo', icon('curseforge'), 'Incursion CurseForge Service'),
                        h('div.d', st.ownKey ? 'Not in use: your own CurseForge API key is used instead.' : 'Lets everyone use CurseForge without a key. A quick Cloudflare check runs once, then about once a month.')), state),
                    h('div.cell.col', h('div.key-row', { style: { padding: 0 } }, svcField,
                        h('button.btn', { on: { click: async () => { try { renderService(await call('cfservice:set', { url: svcField.value.trim() })); UI.Island.toast('Service Address Saved'); } catch (err) { UI.Island.error(err); } } } }, 'Save'),
                        st.custom ? h('button.btn.ghost', { on: { click: async () => { renderService(await call('cfservice:set', { url: '' })); } } }, 'Use Default') : null)),
                    st.enabled && !st.ownKey ? h('div.cell', h('span.grow.muted', 'Verification is stored for this install only.'),
                        h('button.btn.sm', { on: { click: async () => { try { renderService(await call('cfservice:verify')); UI.Island.toast('Verified'); } catch (err) { UI.Island.error(err); } } } }, 'Verify Now'),
                        st.verified ? h('button.btn.sm.ghost', { on: { click: async () => renderService(await call('cfservice:forget')) } }, 'Forget Verification') : null) : null].filter(Boolean));
            }
            renderService();

            body.append(section('keys', 'API Keys', keyGroup,
                h('div.group-title', 'CurseForge Without a Key'), svcGroup,
                h('p.hint', 'Keys are encrypted with your system keychain. Environment variables are read from your user and system environment, so tokens you already use for other tools work here too.')));

            const javaGroup = h('div.group');
            const javaMode = h('select.field', { style: { width: '260px' } }, h('option', { value: 'managed' }, 'Incursion’s Java'), h('option', { value: 'system' }, 'Java Installed on This PC'));
            javaMode.value = prefs.javaMode || 'managed';
            javaMode.addEventListener('change', () => setPrefs({ javaMode: javaMode.value }));
            async function renderJava(force = false) {
                javaGroup.replaceChildren(h('div.cell', h('span.spinner'), h('span.muted', 'Looking for Java…')));
                const list = await call('java:list', { force }).catch(() => []);
                const majors = new Set(list.filter(j => j.managed).map(j => j.major));
                javaGroup.replaceChildren(
                    ...list.map(j => h('div.cell', h('div.java-row', { style: { width: '100%' } },
                        h('div.java-badge', { class: j.managed ? 'managed' : '' }, j.major),
                        h('div', { style: { minWidth: 0 } }, h('div.t', `Java ${j.version}`), h('div.d.ellipsis', { title: j.path }, `${j.vendor || 'Unknown vendor'} · ${j.managed ? 'Downloaded by Incursion' : j.home}`)),
                        j.managed ? h('button.btn.ghost.sm', { on: { click: async () => { await call('java:uninstall', { major: j.major }); renderJava(true); } } }, 'Remove') : h('span')))),
                    h('div.cell.col', h('div', h('div.t', 'Download Java for Incursion'), h('div.d', 'Temurin builds go into Incursion’s own folder and never touch system Java. Minecraft 1.20.5+ needs 21, 26.x needs 25, 1.18–1.20.4 needs 17, older versions need 8.')),
                        h('div.row-flex', { style: { flexWrap: 'wrap' } }, [8, 17, 21, 25].map(mj => h(`button.btn.sm${majors.has(mj) ? '.green' : ''}`, {
                            disabled: majors.has(mj),
                            on: { click: async (e) => { const b = e.currentTarget; b.disabled = true; b.replaceChildren(h('span.spinner'), `Java ${mj}`); try { await call('java:install', { major: mj }); } catch (err) { UI.Island.error(err); } renderJava(true); } }
                        }, majors.has(mj) ? icon('check') : icon('download'), `Java ${mj}`)), h('span.grow'), h('button.btn.ghost.sm', { on: { click: () => call('java:dir') } }, icon('folder'), 'Open Folder'))));
            }
            renderJava();
            body.append(section('java', 'Java',
                h('div.group', h('div.cell', h('span.grow', h('div.t', 'Default Java'), h('div.d', 'Each pack can override this in its Settings tab.')), javaMode)),
                h('div.group-title', 'Installed'), javaGroup));

            const mem = h('input.range', { type: 'range', min: 1024, max: 16384, step: 512 });
            mem.value = prefs.memoryMax || 4096;
            const memLabel = h('b', { style: { minWidth: '64px', textAlign: 'right' } });
            const showMem = () => { memLabel.textContent = `${(mem.value / 1024).toFixed(mem.value % 1024 ? 1 : 0)} GB`; };
            mem.addEventListener('input', showMem);
            mem.addEventListener('change', () => setPrefs({ memoryMax: Number(mem.value) }));
            showMem();
            const jvm = h('textarea.field', { placeholder: 'Added to every pack before its own arguments', style: { fontFamily: 'var(--mono)', fontSize: '12px', minHeight: '64px' } });
            jvm.value = prefs.jvmArgs || '';
            jvm.addEventListener('change', () => setPrefs({ jvmArgs: jvm.value.trim() }));
            body.append(section('launch', 'Launch Defaults',
                h('div.group',
                    h('div.cell', h('span.k', 'Memory'), mem, memLabel),
                    h('div.cell.col', h('div', h('div.t', 'JVM arguments'), h('div.d', 'Used by every pack. Packs add their own on top.')), jvm))));

            const cacheInfo = h('span.v.muted', '…');
            const refreshCache = async () => { const s = await call('cache:stats'); cacheInfo.textContent = `${fmt.plural(s.entries, 'entry', 'entries')}, ${fmt.bytes(s.bytes)}`; };
            refreshCache().catch(() => {});
            const info = App.state.get().info || {};
            const modeSel = h('select.field', h('option', { value: 'off' }, 'Off'), h('option', { value: 'check' }, 'Check and Notify Me'), h('option', { value: 'install' }, 'Check and Install'));
            modeSel.value = prefs.autoUpdate || 'check';
            const everySel = h('select.field', h('option', { value: '6' }, 'Every 6 Hours'), h('option', { value: '24' }, 'Every Day'), h('option', { value: '168' }, 'Every Week'));
            everySel.value = String(prefs.autoUpdateHours || 24);
            everySel.disabled = modeSel.value === 'off';
            modeSel.addEventListener('change', () => { everySel.disabled = modeSel.value === 'off'; setPrefs({ autoUpdate: modeSel.value }); });
            everySel.addEventListener('change', () => setPrefs({ autoUpdateHours: Number(everySel.value) }));
            body.append(section('updates', 'Updates',
                h('div.group',
                    h('div.cell', h('span.grow', h('div.t', 'Automatic Update Checks'), h('div.d', 'Runs in the background for every pack in your library. Pinned mods are skipped; a pack whose game is running is never changed.')), h('div', { style: { width: '220px' } }, modeSel)),
                    h('div.cell', h('span.k', 'Frequency'), h('div', { style: { width: '220px', marginLeft: 'auto' } }, everySel))),
                h('p.hint', 'Opening a pack also checks it when its last check is more than 30 minutes old.')));

            const commStatus = h('span.status');
            const commInfo = h('div.d');
            const shareToggle = UI.toggle(prefs.shareLinks !== false, async (v) => {
                await setPrefs({ shareLinks: v, linksNoticeSeen: true });
                UI.Island.toast(v ? 'Sharing Your Links' : 'Link Sharing Turned Off', v ? '' : 'Votes not yet sent were deleted.');
                renderCommunity();
            }, 'Share the links I make');
            const firstToggle = UI.toggle(prefs.manualLinksFirst !== false, (v) => setPrefs({ manualLinksFirst: v }).then(() => UI.Island.toast('Saved')).catch(UI.Island.error), 'My links come first');
            async function renderCommunity() {
                try {
                    const st = await call('community:status');
                    commStatus.className = `status${st.error ? '.bad' : st.loaded ? '.ok' : ''}`.replace('status.', 'status ');
                    commStatus.textContent = st.error ? 'Couldn’t Update' : st.loaded ? `${fmt.count(st.links)} Links` : 'Nothing Published Yet';
                    commInfo.textContent = st.error ? st.error
                        : st.loaded ? `Published ${st.generatedAt || 'recently'}${st.checkedAt ? `, checked ${fmt.ago(st.checkedAt)}` : ''}.${st.waiting ? ` ${fmt.plural(st.waiting, 'vote')} waiting to be sent.` : ''}`
                            : `Links appear once enough players agree and the update is reviewed.${st.waiting ? ` ${fmt.plural(st.waiting, 'vote')} waiting to be sent.` : ''}`;
                } catch (err) { commStatus.className = 'status bad'; commStatus.textContent = err.message; }
            }
            renderCommunity();
            body.append(section('community', 'Community Links',
                h('div.group',
                    h('div.cell', h('span.grow', h('div.t', 'Community Links'), commInfo), commStatus,
                        h('button.btn.sm', { on: { click: async (e) => { e.currentTarget.disabled = true; try { await call('community:refresh'); } catch (err) { UI.Island.error(err); } e.currentTarget.disabled = false; renderCommunity(); } } }, 'Check Now')),
                    h('div.cell', h('span.grow', h('div.t', 'My Links Come First'), h('div.d', 'Links you make yourself win over community links. Turn off to follow the community when it disagrees with you. Links that come with a pack always win inside that pack.')), firstToggle),
                    h('div.cell', h('span.grow', h('div.t', 'Share the Links I Make'), h('div.d', 'Adds links you make by hand as anonymous votes. Only Microsoft accounts can vote.')), shareToggle),
                    h('div.cell.col', Sharing.details())),
                h('p.hint', 'Community links come from a public repository, are reviewed before publishing and are signed: Incursion ignores any file without a valid signature.')));

            const dataPath = h('span.v.ellipsis');
            const dataReset = h('button.btn.sm.ghost', { on: { click: () => changeDataDir(null) } }, 'Use Default');
            async function renderData() {
                const d = await call('data:info');
                dataPath.textContent = d.path;
                dataPath.title = d.path;
                dataReset.classList.toggle('hidden', d.isDefault);
                return d;
            }
            async function changeDataDir(dir) {
                try {
                    const cur = await call('data:info');
                    const target = dir === null ? cur.defaultPath : dir;
                    const info = await call('data:inspect', { dir: target });
                    if (info.exists && !info.empty && !info.incursion) {
                        const ok = await UI.confirm({ title: 'Use a Folder That Already Contains Files?', message: `${target} has ${fmt.plural(info.entries, 'item')} in it. Incursion adds its own folders (versions, libraries, assets, java and one per pack) next to them and never touches the rest.`, confirmLabel: 'Use This Folder' });
                        if (!ok) return;
                    }
                    const how = await UI.choose({
                        title: 'Move Your Game Files?',
                        message: `Minecraft versions, libraries, assets, each pack's game folder (worlds, configs) and downloaded Java are in ${cur.path}. Moving them avoids downloading everything again.`,
                        choices: [{ value: 'move', label: 'Move Files to the New Folder' }, { value: 'switch', label: 'Start Fresh in the New Folder' }]
                    });
                    if (!how) return;
                    const r = await call('data:set-dir', { dir, move: how === 'move' });
                    await renderData();
                    renderJava?.();
                    if (r.skipped?.length) UI.Island.toast('Some Folders Weren’t Moved', `${r.skipped.join(', ')} already existed in the new folder`, 'error');
                    else UI.Island.toast('Game Files Folder Changed', r.path);
                } catch (err) { UI.Island.error(err); }
            }
            renderData();

            body.append(section('data', 'Data',
                h('div.group',
                    h('div.cell', h('span.grow', h('div.t', 'Game Files and Java'), h('div.d', 'Minecraft versions, each pack’s game folder (worlds, configs, screenshots) and downloaded Java.'))),
                    h('div.cell', dataPath,
                        dataReset,
                        h('button.btn.sm', { on: { click: () => call('shell:reveal', { path: dataPath.textContent }).catch(UI.Island.error) } }, 'Open'),
                        h('button.btn.sm', { on: { click: async () => { const dir = await call('dialog:folder', { title: 'Choose Where Incursion Stores Game Files' }); if (dir) changeDataDir(dir); } } }, 'Change…'))),
                h('div.group',
                    h('div.cell', h('span.k', 'API cache'), cacheInfo, h('button.btn.sm', { on: { click: async () => { await call('cache:clear'); await refreshCache(); UI.Island.toast('Cache Cleared', 'Fresh data loads on next use.'); } } }, 'Clear'))),
                h('p.hint', 'Search results refresh every 15 minutes. Update checks always use live data.'),
                h('div.group',
                    h('div.cell', h('span.grow', h('div.t', 'App Logs'), h('div.d', 'What Incursion did: downloads, updates, launches and errors. Include them when reporting a problem.')),
                        h('button.btn.sm', { on: { click: () => call('app:logs').catch(UI.Island.error) } }, 'Open'))),
                h('div.group', { style: { marginTop: '14px' } },
                    h('div.cell', img('icon.svg', 'avatar'), h('span.grow', h('div.t', `Incursion ${info.version || ''}`), h('div.d', 'Modpacks for CurseForge and Modrinth, built and played in one place.'))))));

            if (focus) setTimeout(() => body.querySelector(`#set-${focus}`)?.scrollIntoView(), 50);
            return { destroy() {} };
        }
    };

    window.SettingsView = SettingsView;
})();
