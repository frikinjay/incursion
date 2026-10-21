(() => {
    const { h, img, icon, call, fmt, debounce, modKey, modTitle } = Lib;

    const bump = (v) => {
        const parts = String(v || '1.0.0').split('.');
        const last = parts.length - 1;
        if (/^\d+$/.test(parts[last])) parts[last] = String(Number(parts[last]) + 1);
        else parts.push('1');
        return parts.join('.');
    };

    function diffList(changes) {
        const rows = [
            ...changes.added.map(x => h('div.d.add', icon('plus'), h('span.ellipsis', x.title), h('span.ver', x.version))),
            ...changes.updated.map(x => h('div.d.up', icon('arrow-up'), h('span.ellipsis', x.title), h('span.ver', `${x.from} → ${x.to}`))),
            ...changes.removed.map(x => h('div.d.rem', icon('minus'), h('span.ellipsis', x.title), h('span.ver', x.version)))
        ];
        return rows.length ? h('div.diff', rows) : h('p.muted', 'No mod changes since the last release.');
    }

    function releases(container, snapshot) {
        let snap = snapshot;
        const releasesList = () => [...(snap.meta.releases || [])].reverse();
        const last = releasesList()[0];
        const version = h('input.field', { value: last ? bump(last.version) : (snap.meta.version || '1.0.0'), spellcheck: false });
        const notes = h('textarea.field', { placeholder: 'Highlights, fixes, anything players should know…' });
        const preview = h('div');
        const summary = h('p.muted');
        const cfgPreview = h('div.cfg-preview');
        let draft = null;
        const trackToggle = UI.toggle(snap.meta.releaseOptions?.trackConfigs !== false, (v) =>
            call('packs:info', { path: snap.meta.path, fields: { releaseOptions: { trackConfigs: v } } }).then(() => refresh()).catch(UI.Island.error));

        const refresh = debounce(async () => {
            try {
                draft = await call('packs:release', { path: snap.meta.path, version: version.value, notes: notes.value, dryRun: true });
                const c = draft.changes;
                const cfg = draft.configs;
                summary.textContent = (draft.previous ? `Compared with ${draft.previous}: ${c.added.length} added, ${c.updated.length} updated, ${c.removed.length} removed.` : `First release: ${fmt.plural(c.added.length, 'mod')}.`)
                    + (cfg ? ` ${fmt.plural(cfg.values, 'config value')} changed in ${fmt.plural(cfg.files, 'file')}.` : '');
                preview.replaceChildren(diffList(c));
                cfgPreview.replaceChildren(
                    !draft.tracking ? h('p.muted', 'Config changes aren’t tracked for this pack.')
                        : cfg ? Changelogs.markdown(cfg.lines.join('\n'))
                            : h('p.muted', draft.configNote || (draft.previous ? 'No config changes since the last release.' : 'The first release records the configs; the next changelog lists what changed.')));
            } catch (err) { preview.replaceChildren(h('p.err-text', err.message)); }
        }, 250);
        version.addEventListener('input', refresh);
        notes.addEventListener('input', refresh);

        const saveBtn = h('button.btn', { on: { click: async () => {
            try {
                const r = await call('packs:release', { path: snap.meta.path, version: version.value, notes: notes.value });
                UI.Island.toast('Release Saved', r.version);
                version.value = bump(r.version); notes.value = ''; refresh();
            } catch (err) { UI.Island.error(err); }
        } } }, icon('tag'), 'Save Release');
        const publishBtn = h('button.btn.primary', { on: { click: () => Publish.open(snap, { version: version.value, notes: notes.value, markdown: draft?.markdown || '' }) } }, icon('upload'), 'Publish…');

        const history = h('div');
        function renderHistory() {
            const list = releasesList();
            history.replaceChildren(...(list.length ? list.map(r => {
                const md = h('pre.md.hidden', changelogOf(r));
                return h('div.release',
                    h('div.release-head', h('b', r.version), h('span.faint', new Date(r.date).toLocaleDateString(undefined, { dateStyle: 'medium' })), h('span.grow'),
                        h('span.chip.sm.green', `+${r.changes.added.length}`), h('span.chip.sm.accent', `↑${r.changes.updated.length}`), h('span.chip.sm.red', `−${r.changes.removed.length}`),
                        r.configs ? h('span.chip.sm', { title: `${fmt.plural(r.configs.values, 'config value')} in ${fmt.plural(r.configs.files, 'file')}` }, icon('edit'), String(r.configs.values)) : null,
                        h('button.btn.ghost.sm', { on: { click: (e) => { md.classList.toggle('hidden'); e.currentTarget.textContent = md.classList.contains('hidden') ? 'Changelog' : 'Hide'; } } }, 'Changelog'),
                        h('button.btn.ghost.sm.icon', { title: 'Copy Changelog', on: { click: () => { navigator.clipboard.writeText(md.textContent); UI.Island.toast('Changelog Copied'); } } }, icon('copy'))),
                    r.notes ? h('p.muted', { style: { margin: '6px 0 0' } }, r.notes) : null,
                    publishedRow(r),
                    md);
            }) : [h('p.muted', 'No releases yet. Saving one records exactly which mod versions it shipped, so the next changelog writes itself.')]));
        }

        function publishedRow(r) {
            const pub = r.published;
            if (!pub?.modrinth && !pub?.curseforge) return null;
            const sp = pub.serverPack;
            const spDone = sp && ['modrinth', 'curseforge'].some(k => sp[k]?.ok);
            return h('div.row-flex', { style: { marginTop: '8px', flexWrap: 'wrap' } },
                pub.modrinth ? h('span.chip.sm', h('span.plat.mr', 'Published')) : null,
                pub.curseforge ? h('span.chip.sm', h('span.plat.cf', 'Published')) : null,
                spDone ? h('span.chip.sm.green', icon('server'), 'Server Pack Published') : null,
                h('span.grow'),
                h('button.btn.sm', { on: { click: () => ServerPublish.open(snap, r) } }, icon('server'), spDone ? 'Publish Server Pack Again…' : 'Publish Server Pack…'));
        }

        container.append(h('div.cards',
            h('section.card',
                h('h3', 'Next Release'),
                h('p', 'Write release notes; the mod changes since the last release are listed for you.'),
                h('div.form-grid',
                    h('div', h('label.label', 'Version'), version),
                    h('div', h('label.label', 'Compared With'), h('div.field', { style: { display: 'flex', alignItems: 'center', color: 'var(--text-2)' } }, last ? last.version : 'Nothing Yet')),
                    h('div.full', h('label.label', 'Notes'), notes)),
                h('div.section-title', { style: { margin: '18px 4px 8px' } }, 'Changes'),
                summary, preview,
                h('div.cell.cfg-track', h('span.grow', h('div.t', 'Track Config Changes'), h('div.d', 'Lists config values that changed since the last release (files in overrides/config and overrides/defaultconfigs).')), trackToggle),
                cfgPreview,
                h('div.row-flex', { style: { justifyContent: 'flex-end', marginTop: '16px' } }, saveBtn, publishBtn)),
            h('section.card', h('h3', 'History'), h('p', 'Every saved release with its changelog.'), history)));
        refresh();
        renderHistory();
        const sigOf = () => snap.meta.mods.length + ':' + JSON.stringify((snap.meta.releases || []).map(r => [r.version, r.published?.at || 0])) + ':' + snap.meta.mods.reduce((n, m) => n + (m.updatedAt || 0), 0);
        let sig = sigOf();
        return { update(next) {
            snap = next;
            const nsig = sigOf();
            if (nsig !== sig) { sig = nsig; renderHistory(); refresh(); }
        } };
    }

    function changelogOf(r) {
        const lines = [`## ${r.version}`, ''];
        if (r.notes) lines.push(r.notes, '');
        const sec = (t, items, f) => { if (items.length) lines.push(`### ${t}`, ...items.map(f), ''); };
        sec('Added', r.changes.added, x => `- ${x.title} ${x.version}`);
        sec('Updated', r.changes.updated, x => `- ${x.title}: ${x.from} → ${x.to}`);
        sec('Removed', r.changes.removed, x => `- ${x.title}`);
        if (r.configs?.lines?.length) lines.push(...r.configs.lines, '');
        return lines.join('\n').trim();
    }

    const SIDEDNESS = [
        { value: 'scan', label: 'Incursion Scan (Recommended)', hint: 'Leaves out only mods that declare themselves client-only, would crash a server at startup, or are marked client-only by both platforms.' },
        { value: 'modrinth', label: 'Modrinth Side Information', hint: 'Uses each mod’s server-side setting on Modrinth.' },
        { value: 'curseforge', label: 'CurseForge Side Information', hint: 'Uses the Client and Server tags on each CurseForge file.' }
    ];
    function serverPackOptions(snap) {
        let mode = snap.meta.publish?.serverSidedness || 'scan';
        const sel = h('select.field', ...SIDEDNESS.map(o => h('option', { value: o.value }, o.label)));
        sel.value = mode;
        const hint = h('p.hint');
        const summary = h('div.row-flex', { style: { marginTop: '10px', flexWrap: 'wrap' } });
        const list = h('div.review-list.hidden', { style: { marginTop: '10px', maxHeight: '240px' } });
        const toggle = h('button.btn.ghost.sm', 'Show Left-Out Mods');
        toggle.addEventListener('click', () => { list.classList.toggle('hidden'); toggle.textContent = list.classList.contains('hidden') ? 'Show Left-Out Mods' : 'Hide Left-Out Mods'; });
        async function render() {
            hint.textContent = SIDEDNESS.find(o => o.value === mode).hint;
            summary.replaceChildren(h('span.spinner'), h('span.muted', 'Checking which mods run on a server…'));
            try {
                const r = await call('packs:server-preview', { path: snap.meta.path, mode });
                const mods = r.excluded.filter(x => x.type === 'mod');
                const other = r.excluded.length - mods.length;
                summary.replaceChildren(...[   // replaceChildren would print "null" for a missing item
                    h('span.chip.green', `${fmt.plural(r.included.filter(x => x.type === 'mod').length, 'Mod', 'Mods')} Included`),
                    h(`span.chip${mods.length ? '.amber' : ''}`, `${fmt.plural(mods.length, 'Mod', 'Mods')} Left Out`),
                    other ? h('span.chip', `${other} Client-Side Packs Left Out`) : null,
                    mods.length ? toggle : null].filter(Boolean));
                list.replaceChildren(...mods.map(x => h('div.review-row', { style: { gridTemplateColumns: 'minmax(0, 1fr)' } }, h('div', h('div.t', x.title), h('div.d', x.reason)))));
            } catch (err) { summary.replaceChildren(h('span.err-text', err.message)); }
        }
        sel.addEventListener('change', () => {
            mode = sel.value;
            call('packs:info', { path: snap.meta.path, fields: { publish: { ...(snap.meta.publish || {}), serverSidedness: mode } } }).catch(() => {});
            render();
        });
        render();
        return { el: h('div', h('label.label', 'Side Detection'), sel, hint, summary, list), mode: () => mode };
    }

    const Publish = {
        async open(snap, { version, notes, markdown }) {
            const p = snap.meta.publish || {};
            if (!p.modrinthProjectId && !p.curseforgeProjectId) {
                const go = await UI.confirm({ title: 'Connect Your Projects First', message: 'Add your Modrinth and CurseForge project IDs in this pack’s Settings tab, then publish from here.', confirmLabel: 'Open Pack Settings' });
                if (go) document.querySelector('.tabs-bar .segmented button[data-value="settings"]')?.click();
                return;
            }
            const targets = { modrinth: !!p.modrinthProjectId, curseforge: !!p.curseforgeProjectId };
            const status = { modrinth: h('span.status', 'Checking…'), curseforge: h('span.status', 'Checking…') };
            const changelog = h('textarea.field', { style: { minHeight: '180px', fontFamily: 'var(--mono)', fontSize: '12px' } });
            changelog.value = markdown || `## ${version}\n\n${notes || ''}`;
            let type = 'release';
            const typeSeg = UI.segmented([{ value: 'release', label: 'Release' }, { value: 'beta', label: 'Beta' }, { value: 'alpha', label: 'Alpha' }], type, (v) => { type = v; });
            const out = h('div');
            let withServer = !!snap.meta.publish?.serverPackDefault;
            const spOptions = serverPackOptions(snap);
            const spBox = h('div', { class: withServer ? '' : 'hidden', style: { marginTop: '12px' } }, spOptions.el);
            const spCheck = UI.checkbox(withServer, (v) => { withServer = v; spBox.classList.toggle('hidden', !v); call('packs:info', { path: snap.meta.path, fields: { publish: { ...(snap.meta.publish || {}), serverPackDefault: v } } }).catch(() => {}); });
            const serverSection = h('div.group', { style: { margin: '0 0 14px', padding: '12px 14px' } },
                h('label.row-flex', spCheck, h('span.grow', h('div.t', 'Also Publish a Server Pack'), h('div.d', 'Uploaded as an additional file of this release on each site.'))),
                spBox);
            const target = (k, label, cls, id) => id ? h('div.cell', UI.checkbox(targets[k], (v) => { targets[k] = v; }), h('span.plat', { class: cls }, label), h('span.faint.mono', String(id)), h('span.grow'), status[k]) : null;
            const publishBtn = h('button.btn.primary', icon('upload'), `Publish ${version}`);
            const dryBtn = h('button.btn', 'Preview Upload');
            const d = UI.dialog({ wide: true, content: [
                h('div.dialog-body',
                    h('h2', `Publish ${snap.meta.name} ${version}`),
                    h('p', 'Incursion exports fresh pack files and uploads them as a new version on each site you pick.'),
                    h('div.group', { style: { margin: '0 0 14px' } },
                        target('modrinth', 'Modrinth', 'mr', p.modrinthProjectId),
                        target('curseforge', 'CurseForge', 'cf', p.curseforgeProjectId)),
                    serverSection,
                    h('div.row-flex', { style: { marginBottom: '12px' } }, h('span.label', { style: { margin: 0 } }, 'Release Channel'), typeSeg),
                    h('label.label', 'Changelog (Markdown)'), changelog, out),
                h('div.dialog-foot', h('button.btn', { on: { click: () => d.close() } }, 'Cancel'), dryBtn, publishBtn)
            ] });

            call('publish:check', { path: snap.meta.path }).then(res => {
                for (const k of ['modrinth', 'curseforge']) if (res[k]) { status[k].className = `status ${res[k].ok ? 'ok' : 'bad'}`; status[k].textContent = res[k].ok ? (res[k].title || 'Ready') : res[k].message; }
            }).catch(() => {});

            const chosen = () => Object.entries(targets).filter(([, v]) => v).map(([k]) => k);
            const release = () => ({ version, changelog: changelog.value, versionType: type });
            dryBtn.addEventListener('click', async () => {
                dryBtn.disabled = true;
                try {
                    const r = await call('publish:run', { path: snap.meta.path, targets: chosen(), release: release(), serverPack: withServer ? { sidedness: spOptions.mode() } : null, dryRun: true });
                    out.replaceChildren(h('div.section-title', 'Ready to Upload'), ...Object.entries(r).flatMap(([k, v]) => [
                        h('div.cell', h('span.plat', { class: k === 'modrinth' ? 'mr' : 'cf' }, k === 'modrinth' ? 'Modrinth' : 'CurseForge'), h('span.mono.grow', v.file), h('span.faint', fmt.bytes(v.size))),
                        v.serverPack ? h('div.cell', h('span.chip.sm', 'Server Pack'), h('span.mono.grow', v.serverPack.file || v.serverPack.error), v.serverPack.size ? h('span.faint', fmt.bytes(v.serverPack.size)) : null) : null]).filter(Boolean));
                } catch (err) { out.replaceChildren(h('p.err-text', err.message)); }
                dryBtn.disabled = false;
            });
            publishBtn.addEventListener('click', async () => {
                const list = chosen();
                if (!list.length) return;
                const ok = await UI.confirm({ title: `Publish to ${list.map(x => x === 'modrinth' ? 'Modrinth' : 'CurseForge').join(' and ')}?`, message: `Version ${version}${withServer ? ' and its server pack' : ''} become${withServer ? '' : 's'} public on ${list.length === 2 ? 'both sites' : 'that site'}. This can’t be undone from Incursion.`, confirmLabel: 'Publish' });
                if (!ok) return;
                publishBtn.disabled = true;
                try {
                    const r = await call('publish:run', { path: snap.meta.path, targets: list, release: release(), serverPack: withServer ? { sidedness: spOptions.mode() } : null, notes });
                    const spFail = Object.values(r).map(x => x?.serverPack).find(x => x && x.ok === false);
                    if (spFail) UI.Island.toast('Published Without Server Pack', `${spFail.error} Publish it again from Releases.`, 'error');
                    else UI.Island.toast('Published', withServer ? `${version} with server pack` : version);
                    d.close();
                    for (const v of Object.values(r)) if (v.url) call('shell:open', { url: v.url });
                } catch (err) { out.replaceChildren(h('p.err-text', err.message)); publishBtn.disabled = false; }
            });
        }
    };

    const ServerPublish = {
        open(snap, rel) {
            const pub = rel.published || {};
            const targets = { modrinth: !!pub.modrinth, curseforge: !!pub.curseforge };
            const opts = serverPackOptions(snap);
            const out = h('div');
            const warn = h('div');
            const target = (k, label, cls, id) => id ? h('div.cell', UI.checkbox(targets[k], (v) => { targets[k] = v; }), h('span.plat', { class: cls }, label), h('span.faint.mono', String(id))) : null;
            const publishBtn = h('button.btn.primary', icon('server'), 'Publish Server Pack');
            const dryBtn = h('button.btn', 'Preview Upload');
            const chosen = () => Object.entries(targets).filter(([, v]) => v).map(([k]) => k);
            const d = UI.dialog({ wide: true, content: [
                h('div.dialog-body',
                    h('h2', `Server Pack for ${snap.meta.name} ${rel.version}`),
                    h('p', 'Built from the pack’s current files and uploaded as an additional file of this release.'),
                    warn,
                    h('div.group', { style: { margin: '0 0 14px' } },
                        target('modrinth', 'Modrinth', 'mr', pub.modrinth?.versionId),
                        target('curseforge', 'CurseForge', 'cf', pub.curseforge?.fileId)),
                    opts.el, out),
                h('div.dialog-foot', h('button.btn', { on: { click: () => d.close() } }, 'Cancel'), dryBtn, publishBtn)
            ] });
            // The pack may have changed since this version shipped, in which case the server pack wouldn't match it.
            call('publish:server', { path: snap.meta.path, version: rel.version, checkOnly: true }).then(r => {
                if (r.changed) warn.replaceChildren(h('div.update-note', { style: { margin: '0 0 14px', color: 'var(--color-warn)', background: 'var(--color-warn-wash)', borderColor: 'var(--color-warn)' } },
                    h('span', `The pack has ${fmt.plural(r.changed, 'change', 'changes')} since ${rel.version} was released. The server pack is built from the current files, so it won’t match ${rel.version} exactly.`)));
            }).catch(() => {});
            dryBtn.addEventListener('click', async () => {
                dryBtn.disabled = true;
                try {
                    const r = await call('publish:server', { path: snap.meta.path, version: rel.version, targets: chosen(), sidedness: opts.mode(), dryRun: true });
                    out.replaceChildren(h('div.section-title', 'Ready to Upload'), ...['modrinth', 'curseforge'].filter(k => r[k]).map(k => h('div.cell', h('span.plat', { class: k === 'modrinth' ? 'mr' : 'cf' }, k === 'modrinth' ? 'Modrinth' : 'CurseForge'), h('span.mono.grow', r[k].file), h('span.faint', fmt.bytes(r[k].size)))));
                } catch (err) { out.replaceChildren(h('p.err-text', err.message)); }
                dryBtn.disabled = false;
            });
            publishBtn.addEventListener('click', async () => {
                const list = chosen();
                if (!list.length) return;
                const ok = await UI.confirm({ title: `Publish the ${rel.version} Server Pack?`, message: `It becomes public as an additional file of ${rel.version} on ${list.length === 2 ? 'both sites' : list[0] === 'modrinth' ? 'Modrinth' : 'CurseForge'}. This can’t be undone from Incursion.`, confirmLabel: 'Publish' });
                if (!ok) return;
                publishBtn.disabled = true;
                try {
                    await call('publish:server', { path: snap.meta.path, version: rel.version, targets: list, sidedness: opts.mode() });
                    UI.Island.toast('Server Pack Published', rel.version);
                    d.close();
                } catch (err) { out.replaceChildren(h('p.err-text', err.message)); publishBtn.disabled = false; }
            });
        }
    };

    function issues(container, snapshot) {
        let snap = snapshot;
        const listCard = h('section.card');
        const depsCard = h('section.card');
        container.append(h('div.cards', listCard, depsCard));
        const byKey = () => new Map(snap.meta.mods.map(m => [modKey(m), m]));

        function renderIssues() {
            const mods = byKey();
            const items = snap.issues;
            listCard.replaceChildren(
                h('h3', 'Problems'),
                h('p', 'Conflicts declared by the platforms or inside the mod files, duplicate mods, missing files, and jars added to the pack folders by hand.'),
                items.length ? h('div.group', { style: { margin: 0 } }, items.map(i => h('div.issue',
                    h(`div.ic.${i.severity}`, icon(i.kind === 'conflict' ? 'bug' : i.kind === 'missing' ? 'download' : i.kind === 'untracked' ? 'import' : 'layers')),
                    h('div', { style: { minWidth: 0 } }, h('div.t', i.title), h('div.d', i.detail)),
                    i.kind === 'untracked'
                        ? h('button.btn.tinted.sm', { on: { click: () => JarReview.open(snap) } }, 'Review')
                        : i.kind === 'missing'
                        ? h('button.btn.tinted.sm', { on: { click: () => call('packs:redownload', { path: snap.meta.path, mode: 'missing' }).catch(UI.Island.error) } }, 'Repair')
                        : i.mergeable
                        ? h('button.btn.tinted.sm', { title: 'Combine into one entry with both platform versions', on: { click: () => call('packs:merge', { path: snap.meta.path, keys: i.keys }).then(() => UI.Island.toast('Merged into One Entry')).catch(UI.Island.error) } }, 'Merge')
                        : h('button.btn.sm', { on: { click: (e) => UI.menu(e.currentTarget, i.keys.map(k => mods.get(k)).filter(Boolean).map(m => ({ label: modTitle(m), onClick: () => Inspector.open(m) }))) } }, 'Review')))) :
                    h('div.issue', h('div.ic.ok', icon('check')), h('div', h('div.t', 'No Problems Found'), h('div.d', 'No conflicts, duplicates or missing files.')), h('span')));
        }

        async function checkDeps() {
            depsCard.replaceChildren(h('h3', 'Required Dependencies'), h('p', 'Looking through every mod’s requirements…'), h('div.row-flex', h('span.spinner'), h('span.muted', 'Checking')));
            try {
                const deps = await call('packs:deps', { path: snap.meta.path });
                DepsPicker.render(depsCard, deps, snap, { title: 'Required Dependencies', empty: 'Every required dependency is in the pack.', onDone: checkDeps });
            } catch (err) {
                depsCard.replaceChildren(h('h3', 'Required Dependencies'), h('p.err-text', err.message), h('button.btn', { on: { click: checkDeps } }, 'Try Again'));
            }
        }
        depsCard.append(h('h3', 'Required Dependencies'), h('p', 'Find mods your pack needs but doesn’t include. Mods another jar already bundles are marked, so you can skip them.'),
            h('button.btn.primary', { on: { click: checkDeps } }, icon('search'), 'Check Dependencies'));
        renderIssues();
        call('packs:untracked-refresh', { path: snap.meta.path }).catch(() => {});
        return { update(next) { snap = next; renderIssues(); } };
    }

    const PLAN_TEXT = {
        link: () => 'Both the Modrinth and CurseForge files are present. It will be added to the pack as one mod.',
        copy: (i) => `The same file is on ${i.missing === 'curseforge' ? 'CurseForge' : 'Modrinth'}: it is copied into ${i.missing}/mods.`,
        download: (i) => `${i.missing === 'curseforge' ? 'CurseForge' : 'Modrinth'} has this mod with a different file: its newest build for this pack can be downloaded.`,
        single: (i) => `Only on ${i.missing === 'curseforge' ? 'Modrinth' : 'CurseForge'}. It is added for that platform only.`,
        stray: () => 'This mod is already in the pack. This file is an extra or outdated copy.',
        unknown: () => 'Neither Modrinth nor CurseForge recognises this file.'
    };
    const JarReview = {
        async open(snap) {
            const body = h('div.review-list', h('div.row-flex', h('span.spinner'), h('span.muted', 'Identifying files on Modrinth and CurseForge…')));
            const addBtn = h('button.btn.primary', { disabled: true }, 'Add Selected');
            const trashBtn = h('button.btn.danger.hidden', 'Move to Recycle Bin');
            const d = UI.dialog({ wide: true, content: [
                h('div.dialog-body', h('h2', 'Mod Files Added Outside Incursion'), h('p', 'These files are in the pack’s platform folders but not in the pack. Pick what to add; nothing changes until you confirm.'), body),
                h('div.dialog-foot', trashBtn, h('span.grow'), h('button.btn', { on: { click: () => d.close() } }, 'Close'), addBtn)
            ] });
            let items;
            try { items = await call('packs:untracked', { path: snap.meta.path }); }
            catch (err) { body.replaceChildren(h('p.err-text', err.message)); return; }
            if (!items.length) { body.replaceChildren(h('p.muted', 'Every file in this pack’s mod folders is already part of the pack.')); return; }
            const picked = new Set(items.filter(i => ['link', 'copy', 'download', 'single'].includes(i.plan)).map(i => i.id));
            const trash = new Set();
            const mode = Object.fromEntries(items.map(i => [i.id, 'both']));
            const sync = () => {
                addBtn.disabled = !picked.size;
                addBtn.textContent = picked.size ? `Add ${picked.size}` : 'Add Selected';
                trashBtn.classList.toggle('hidden', !trash.size);
                trashBtn.textContent = `Move ${fmt.plural(trash.size, 'File', 'Files')} to Recycle Bin`;
            };
            const rows = items.map(i => {
                const adoptable = ['link', 'copy', 'download', 'single'].includes(i.plan);
                const set = adoptable ? picked : trash;
                const extra = (i.plan === 'copy' || i.plan === 'download')
                    ? h('label.review-opt', UI.checkbox(true, (v) => { mode[i.id] = v ? 'both' : 'single'; }), h('span', i.plan === 'copy' ? `Also copy into ${i.missing}/mods` : `Also download the ${i.missing === 'curseforge' ? 'CurseForge' : 'Modrinth'} file`))
                    : null;
                return h('div.review-row',
                    UI.checkbox(set.has(i.id), (v) => { if (v) set.add(i.id); else set.delete(i.id); sync(); }),
                    img(i.icon || 'icon.svg', 'squircle'),
                    h('div', { style: { minWidth: 0 } },
                        h('div.t', i.title, h('span.twins', h(`span.twin.mr${i.ids.modrinth ? '.on' : ''}`), h(`span.twin.cf${i.ids.curseforge ? '.on' : ''}`))),
                        h('div.d', PLAN_TEXT[i.plan](i)),
                        h('div.files.mono', i.files.map(f => `${f.platform}/mods/${f.name}`).join('  ·  ')),
                        extra),
                    h(`span.chip.sm${adoptable ? '.accent' : i.plan === 'stray' ? '.amber' : ''}`, adoptable ? 'Add' : i.plan === 'stray' ? 'Leftover' : 'Unknown'));
            });
            body.replaceChildren(...rows);
            sync();
            addBtn.addEventListener('click', async () => {
                addBtn.disabled = true;
                try {
                    const r = await call('packs:adopt', { path: snap.meta.path, ids: [...picked], choices: mode });
                    UI.Island.toast(`Added ${fmt.plural(r.added, 'Item', 'Items')} to the Pack`);
                    d.close();
                } catch (err) { UI.Island.error(err); sync(); }
            });
            trashBtn.addEventListener('click', async () => {
                const files = items.filter(i => trash.has(i.id)).flatMap(i => i.files);
                try { await call('packs:trash-jars', { path: snap.meta.path, files }); UI.Island.toast(`Moved ${fmt.plural(files.length, 'File', 'Files')} to the Recycle Bin`); d.close(); }
                catch (err) { UI.Island.error(err); }
            });
        }
    };
    window.JarReview = JarReview;

    const DepsPicker = {
        render(container, deps, snap, { title, empty, onDone, compact = false } = {}) {
            const picked = new Set(deps.filter(d => !d.providedBy?.length).map(d => d.key));
            const addBtn = h('button.btn.primary', icon('plus'), 'Add Selected');
            const sync = () => { addBtn.disabled = !picked.size; addBtn.lastChild.textContent = picked.size ? `Add ${picked.size}` : 'Add Selected'; };
            const rows = deps.map(d => {
                const note = d.providedBy?.length
                    ? h('div.note.bundled', `Already ${d.bundledOnly ? 'bundled inside' : 'provided by'} ${d.providedBy.map(p => `${p.title}${p.version ? ` (${p.id} ${p.version})` : ''}`).slice(0, 2).join(', ')}`)
                    : h('div.note', [d.platforms.modrinth ? 'Modrinth' : null, d.platforms.curseforge ? 'CurseForge' : null].filter(Boolean).join(' and '));
                return h('div.dep',
                    UI.checkbox(picked.has(d.key), (v) => { if (v) picked.add(d.key); else picked.delete(d.key); sync(); }),
                    img(d.icon), h('div', { style: { minWidth: 0 } }, h('div.title.ellipsis', d.title), note),
                    h('span.twins', h(`span.twin.mr${d.platforms.modrinth ? '.on' : ''}`), h(`span.twin.cf${d.platforms.curseforge ? '.on' : ''}`)));
            });
            addBtn.addEventListener('click', async () => {
                addBtn.disabled = true;
                try {
                    const items = deps.filter(d => picked.has(d.key));
                    const r = await call('packs:add', { path: snap.meta.path, items });
                    UI.Island.toast(`Added ${fmt.plural(r.added.length, 'Dependency', 'Dependencies')}`);
                    onDone?.(r);
                } catch (err) { UI.Island.error(err); addBtn.disabled = false; }
            });
            sync();
            container.replaceChildren(
                h(compact ? 'div.row-flex' : 'h3', compact ? [icon('link'), h('b', title)] : title),
                deps.length ? h('div.stack', rows) : h('p.muted', empty),
                deps.length ? h('div.row-flex', { style: { justifyContent: 'flex-end', marginTop: '6px' } }, compact ? h('button.btn', { on: { click: () => container.remove() } }, 'Not Now') : null, addBtn) : null);
        }
    };

    function settings(container, snapshot) {
        let snap = snapshot;
        const m = snap.meta;
        const save = debounce((fields) => call('packs:info', { path: m.path, fields }).then(() => UI.Island.toast('Saved')).catch(UI.Island.error), 500);
        const launch = { ...(m.launch || {}) };
        const publish = { ...(m.publish || {}) };
        const links = { ...(m.links || {}) };

        const javaSel = h('select.field', h('option', { value: 'default' }, 'Use the App Default'), h('option', { value: 'managed' }, 'Incursion’s Java (Downloaded When Needed)'), h('option', { value: 'system' }, 'Java Installed on This PC (Best Match)'));
        const javaInfo = h('p.hint');
        (async () => {
            try {
                const [list, need] = await Promise.all([call('java:list'), call('java:required', { gameVersion: m.gameVersion })]);
                javaInfo.textContent = `Minecraft ${m.gameVersion} needs Java ${need}. ${list.some(j => j.major === need) ? 'A matching Java is installed.' : 'No matching Java is installed yet; Incursion can download one.'}`;
                for (const j of list) javaSel.append(h('option', { value: j.path }, `Java ${j.version} · ${j.vendor || 'Unknown'}${j.managed ? ' (Incursion)' : ''}${j.major !== need ? ` (needs ${need})` : ''}`));
                javaSel.append(h('option', { value: '__pick' }, 'Choose a Java Executable…'));
                javaSel.value = launch.java || 'default';
                if (javaSel.value !== (launch.java || 'default')) { javaSel.append(h('option', { value: launch.java }, launch.java)); javaSel.value = launch.java; }
            } catch (err) { javaInfo.textContent = err.message; }
        })();
        javaSel.addEventListener('change', async () => {
            if (javaSel.value === '__pick') {
                try {
                    const j = await call('dialog:java');
                    if (!j) { javaSel.value = launch.java || 'default'; return; }
                    javaSel.append(h('option', { value: j.path }, `Java ${j.version} · ${j.path}`));
                    javaSel.value = j.path;
                } catch (err) { UI.Island.error(err); javaSel.value = launch.java || 'default'; return; }
            }
            launch.java = javaSel.value === 'default' ? undefined : javaSel.value;
            save({ launch });
        });

        const mem = h('input.range', { type: 'range', min: 1024, max: 16384, step: 512 });
        mem.value = launch.memoryMax || 4096;
        const memLabel = h('b', { style: { fontVariantNumeric: 'tabular-nums', minWidth: '64px', textAlign: 'right' } });
        const showMem = () => { memLabel.textContent = `${(mem.value / 1024).toFixed(mem.value % 1024 ? 1 : 0)} GB`; };
        mem.addEventListener('input', showMem);
        mem.addEventListener('change', () => { launch.memoryMax = Number(mem.value); save({ launch }); });
        showMem();

        const jvm = h('textarea.field', { placeholder: '-XX:+UseG1GC -Dsome.flag=true', style: { fontFamily: 'var(--mono)', fontSize: '12px', minHeight: '70px' } });
        jvm.value = launch.jvmArgs || '';
        jvm.addEventListener('change', () => { launch.jvmArgs = jvm.value.trim(); save({ launch }); });
        const aikar = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1';

        const mrId = h('input.field', { value: publish.modrinthProjectId || '', placeholder: 'Project ID or slug, e.g. my-pack', spellcheck: false });
        const cfId = h('input.field', { value: publish.curseforgeProjectId || '', placeholder: 'Numeric project ID, e.g. 123456', spellcheck: false });
        const pubStatus = h('div.stack', { style: { gap: '6px', marginTop: '10px' } });
        const savePub = () => { publish.modrinthProjectId = mrId.value.trim() || undefined; publish.curseforgeProjectId = cfId.value.trim() ? Number(cfId.value.trim()) || cfId.value.trim() : undefined; save({ publish }); };
        mrId.addEventListener('change', savePub);
        cfId.addEventListener('change', savePub);

        const profilesList = h('div.group', { style: { margin: 0 } });
        const profilesCard = h('section.card',
            h('h3', 'Profiles'),
            h('p', 'Lighter or alternative versions of this pack. Play and exports use the profile picked next to Play.'),
            profilesList,
            h('button.btn', { style: { marginTop: '12px' }, on: { click: async () => {
                const name = await UI.prompt({ title: 'New Profile', message: 'Start with everything, then choose what to leave out.', placeholder: 'e.g. Lite', confirmLabel: 'Create' });
                if (!name?.trim()) return;
                const list = [...(snap.meta.profiles || []), { id: `p${Date.now().toString(36)}`, name: name.trim(), exclude: [] }];
                await saveProfiles(list);
                ProfileEditor.open(snap, list.at(-1), saveProfiles);
            } } }, icon('plus'), 'New Profile'));
        const saveProfiles = (list) => call('packs:info', { path: m.path, fields: { profiles: list } }).catch(UI.Island.error);
        function renderProfiles() {
            const list = snap.meta.profiles || [];
            const total = snap.meta.mods.length;
            profilesList.replaceChildren(
                h('div.cell', h('span.grow', h('div.t', 'Full'), h('div.d', `Everything · ${total}`)), h('span.chip.sm', 'Always Available')),
                ...list.map(p => h('div.cell',
                    h('span.grow', h('div.t', p.name), h('div.d', `${total - p.exclude.length} of ${total} · leaves out ${p.exclude.length}`)),
                    h('button.btn.sm', { on: { click: () => ProfileEditor.open(snap, p, saveProfiles) } }, 'Edit'),
                    h('button.btn.ghost.sm.icon', { title: 'More', 'aria-label': `More for ${p.name}`, on: { click: (e) => UI.menu(e.currentTarget, [
                        { label: 'Rename…', icon: 'edit', onClick: async () => { const n = await UI.prompt({ title: 'Rename Profile', value: p.name, confirmLabel: 'Rename' }); if (n?.trim()) saveProfiles(list.map(x => x.id === p.id ? { ...x, name: n.trim() } : x)); } },
                        { label: 'Delete', icon: 'trash', danger: true, onClick: () => saveProfiles(list.filter(x => x.id !== p.id)) }
                    ], { align: 'right' }) } }, icon('more')))));
        }

        const linkField = (k, ph) => { const f = h('input.field', { value: links[k] || '', placeholder: ph, spellcheck: false }); f.addEventListener('change', () => { links[k] = f.value.trim() || undefined; save({ links }); }); return f; };
        const license = h('input.field', { value: m.license || '', placeholder: 'e.g. MIT or All rights reserved' });
        license.addEventListener('change', () => save({ license: license.value.trim() }));

        // A pack from someone else carries its own links, which win over yours unless you say otherwise.
        const linksBody = h('div');
        const policySeg = UI.segmented([{ value: 'pack', label: 'This Pack’s Links' }, { value: 'local', label: 'My Links' }], m.linkPolicy === 'local' ? 'local' : 'pack',
            (v) => call('packs:info', { path: m.path, fields: { linkPolicy: v } }).then(() => { UI.Island.toast('Saved'); renderLinks(); }).catch(UI.Island.error));
        async function renderLinks() {
            try {
                const info = await call('links:info', { path: m.path });
                const NAME = (id, pl) => (pl === 'curseforge' ? `CurseForge ${id}` : `Modrinth ${id}`);
                const side = (r) => [r.cf ? NAME(r.cf, 'curseforge') : 'Not on CurseForge', r.mr ? NAME(r.mr, 'modrinth') : 'Not on Modrinth'].join(' ↔ ');
                linksBody.replaceChildren(
                    h('p.hint', `${fmt.plural(info.packLinks, 'link')} saved in this pack · ${fmt.plural(info.stats.manual, 'link')} made by you across all packs · ${fmt.plural(info.stats.auto + info.stats.pack, 'other link')} found automatically or from packs.`),
                    info.conflicts.length ? h('div.group', { style: { margin: '10px 0 0' } },
                        h('div.cell', h('span.grow', h('div.t', `${fmt.plural(info.conflicts.length, 'Link Differs', 'Links Differ')} From Yours`), h('div.d', 'Choose which link to keep for each mod.'))),
                        ...info.conflicts.map(c => h('div.cell',
                            h('span.grow', h('div.t', c.pack.title || c.mine.title || 'Mod'), h('div.d', `This pack: ${side(c.pack)}`), h('div.d', `Yours: ${side(c.mine)}`)),
                            h('button.btn.sm', { on: { click: () => call('links:settle', { path: m.path, cf: c.pack.cf, mr: c.pack.mr, choice: 'mine' }).then(renderLinks).catch(UI.Island.error) } }, 'Use Mine'),
                            h('button.btn.ghost.sm', { title: 'Save this pack’s link as yours for every pack', on: { click: () => call('links:settle', { path: m.path, cf: c.pack.cf, mr: c.pack.mr, choice: 'pack' }).then(renderLinks).catch(UI.Island.error) } }, 'Use Pack’s Everywhere')))) : null);
            } catch (err) { linksBody.replaceChildren(h('p.err-text', err.message)); }
        }
        const linksCard = h('section.card',
            h('h3', 'Platform Links'),
            h('p', 'Which CurseForge and Modrinth projects are the same mod. Links you make in this pack are saved in it and shared with everyone who imports it. Use Link Platforms on a mod or in Add Content to change one.'),
            h('label.label', 'When This Pack and You Disagree, Use'), policySeg,
            linksBody);

        container.append(h('div.cards',
            h('section.card',
                h('h3', 'Launch'),
                h('p', 'How Minecraft starts for this pack. Other packs keep their own settings.'),
                h('label.label', 'Java'), javaSel, javaInfo,
                h('label.label', { style: { marginTop: '16px' } }, 'Memory'),
                h('div.row-flex', mem, memLabel),
                h('p.hint', 'Large packs (200+ mods) usually want 6–8 GB. Leave room for the rest of your system.'),
                h('label.label', { style: { marginTop: '16px' } }, 'JVM arguments'), jvm,
                h('div.row-flex', { style: { marginTop: '8px' } }, h('button.btn.sm', { on: { click: () => { jvm.value = aikar; jvm.dispatchEvent(new Event('change')); } } }, 'Apply Recommended Arguments'), h('button.btn.ghost.sm', { on: { click: () => { jvm.value = ''; jvm.dispatchEvent(new Event('change')); } } }, 'Clear'))),
            h('div.stack', { style: { gap: 'var(--gap)' } },
                h('section.card',
                    h('h3', 'Publishing'),
                    h('p', 'Where “Publish” uploads new versions of this pack.'),
                    h('label.label.label-with-logo', icon('modrinth'), 'Modrinth Project'), mrId,
                    h('p.hint', 'Create the modpack project on ', h('a', { on: { click: () => call('shell:open', { url: 'https://modrinth.com/dashboard/projects' }) } }, 'modrinth.com'), ' first. The token needs the “Create versions” scope.'),
                    h('label.label.label-with-logo', { style: { marginTop: '14px' } }, icon('curseforge'), 'CurseForge Project ID'), cfId,
                    h('p.hint', 'Shown in the “About Project” box on your project page. Uploads use a CurseForge API token, set in Settings.'),
                    h('button.btn.sm', { style: { marginTop: '12px' }, on: { click: async () => {
                        savePub();
                        pubStatus.replaceChildren(h('span.status', 'Checking…'));
                        await new Promise(r => setTimeout(r, 600));
                        try {
                            const r = await call('publish:check', { path: m.path });
                            pubStatus.replaceChildren(...Object.entries(r).filter(([, v]) => v).map(([k, v]) => h(`span.status.${v.ok ? 'ok' : 'bad'}`, `${k === 'modrinth' ? 'Modrinth' : 'CurseForge'}: ${v.ok ? (v.title || 'ready') : v.message}`)));
                            if (!pubStatus.childElementCount) pubStatus.replaceChildren(h('span.status', 'Add a Project First'));
                        } catch (err) { pubStatus.replaceChildren(h('span.status.bad', err.message)); }
                    } } }, 'Check Access'),
                    pubStatus),
                h('section.card',
                    h('h3', 'Links'),
                    h('p', 'Shown to players in exports and changelogs.'),
                    h('div.form-grid',
                        h('div', h('label.label', 'Website'), linkField('website', 'https://')),
                        h('div', h('label.label', 'Source'), linkField('source', 'https://github.com/…')),
                        h('div', h('label.label', 'Issues'), linkField('issues', 'https://')),
                        h('div', h('label.label', 'Discord'), linkField('discord', 'https://discord.gg/…')),
                        h('div.full', h('label.label', 'License'), license))),
                profilesCard,
                linksCard)));
        renderProfiles();
        renderLinks();
        return { update(next) { const relink = JSON.stringify(next.meta.modLinks || []) !== JSON.stringify(snap.meta.modLinks || []); snap = next; renderProfiles(); if (relink) renderLinks(); } };
    }

    const REASONS = { manual: 'Manual', launch: 'Before Launch', 'before-restore': 'Before Restore' };
    function backups(container, snapshot) {
        let snap = snapshot;
        const m = () => snap.meta;
        const listEl = h('div.group', { style: { margin: 0 } });
        const presentEl = h('p');
        const nowBtn = h('button.btn.primary', icon('download'), 'Back Up Now');
        const launch = { ...(m().launch || {}) };
        const keepSel = h('select.field', ...[3, 5, 10, 20].map(n => h('option', { value: String(n) }, `Keep the Newest ${n}`)));
        keepSel.value = String(launch.backupKeep || 5);
        const saveLaunch = () => call('packs:info', { path: m().path, fields: { launch } }).catch(UI.Island.error);
        keepSel.addEventListener('change', () => { launch.backupKeep = Number(keepSel.value); saveLaunch(); });
        const autoToggle = UI.toggle(!!launch.backupOnLaunch, (v) => { launch.backupOnLaunch = v; keepSel.disabled = !v; saveLaunch(); });
        keepSel.disabled = !launch.backupOnLaunch;

        async function render() {
            let r;
            try { r = await call('backups:list', { path: m().path }); }
            catch (err) { listEl.replaceChildren(h('div.issue', h('div.ic.error', icon('warn')), h('div', h('div.t', 'Backups Unavailable'), h('div.d', err.message)), h('span'))); return; }
            presentEl.textContent = r.present.length
                ? `Includes ${r.present.map(x => x === 'saves' ? 'worlds' : x).join(', ')}. Saved in the data folder, outside the pack, so exports never include them.`
                : 'Nothing to back up yet: play the pack once to create its worlds and configs.';
            nowBtn.disabled = !r.present.length;
            listEl.replaceChildren(...(r.list.length ? r.list.map(b => h('div.issue',
                h('div.ic', { class: b.reason === 'manual' ? 'ok' : 'warn' }, icon(b.reason === 'manual' ? 'download' : 'refresh')),
                h('div', { style: { minWidth: 0 } },
                    h('div.t', new Date(b.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })),
                    h('div.d', `${REASONS[b.reason] || b.reason} · ${fmt.bytes ? fmt.bytes(b.size) : `${(b.size / 1048576).toFixed(1)} MB`}${b.items.length ? ` · ${b.items.map(x => x === 'saves' ? 'worlds' : x).join(', ')}` : ''}`)),
                h('div.row-flex',
                    h('button.btn.sm', { on: { click: () => restore(b) } }, 'Restore'),
                    h('button.btn.ghost.sm.icon', { title: 'Move to Recycle Bin', 'aria-label': 'Delete backup', on: { click: async () => {
                        if (!(await UI.confirm({ title: 'Delete this backup?', message: 'It goes to the Recycle Bin.', confirmLabel: 'Delete', danger: true }))) return;
                        try { await call('backups:delete', { path: m().path, name: b.name }); render(); } catch (err) { UI.Island.error(err); }
                    } } }, icon('trash'))))) : [h('div.issue', h('div.ic', icon('download')), h('div', h('div.t', 'No Backups Yet'), h('div.d', 'Back up before big changes, or turn on backups before every launch.')), h('span'))]));
        }
        async function restore(b) {
            const ok = await UI.confirm({ title: `Restore the backup from ${new Date(b.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}?`, message: `Worlds and configs in it replace the current ones. The current state is backed up first, so you can go back.`, confirmLabel: 'Restore' });
            if (!ok) return;
            try { await call('backups:restore', { path: m().path, name: b.name }); UI.Island.toast('Backup Restored'); render(); } catch (err) { UI.Island.error(err); }
        }
        nowBtn.addEventListener('click', async () => {
            nowBtn.disabled = true;
            try { await call('backups:create', { path: m().path }); render(); } catch (err) { UI.Island.error(err); nowBtn.disabled = false; }
        });

        container.append(h('div.cards',
            h('section.card',
                h('h3', 'World and Config Backups'),
                presentEl,
                h('div.row-flex', nowBtn, h('button.btn', { on: { click: () => call('backups:reveal', { path: m().path }) } }, icon('folder'), 'Show Folder')),
                h('div.group', { style: { margin: '18px 0 0' } },
                    h('div.cell', h('span.grow', h('div.t', 'Back Up Before Every Launch'), h('div.d', 'Older automatic backups are removed; manual ones are kept.')), autoToggle),
                    h('div.cell', h('span.k', 'Automatic'), keepSel))),
            h('section.card', h('h3', 'Backups'), h('p', 'Newest first.'), listEl)));
        render();
        return { update(next) { snap = next; } };
    }

    const ProfileEditor = {
        open(snap, profile, save) {
            const out = new Set(profile.exclude);
            const search = h('input.field', { type: 'search', placeholder: 'Filter', spellcheck: false });
            const list = h('div.review-list');
            const count = h('span.muted');
            const rows = snap.meta.mods.map(m => {
                const k = modKey(m);
                const cb = UI.checkbox(!out.has(k), (v) => { if (v) out.delete(k); else out.add(k); sync(); });
                const row = h('div.review-row', cb, img(Lib.modIcon(m), 'squircle'),
                    h('div', { style: { minWidth: 0 } }, h('div.t', modTitle(m)), h('div.d', [Lib.typeOf(m).one, m.optional ? 'optional' : null].filter(Boolean).join(' · '))), h('span'));
                row._m = m; row._cb = cb;
                return row;
            });
            const sync = () => { count.textContent = `${snap.meta.mods.length - out.size} of ${snap.meta.mods.length} included`; };
            const refresh = () => rows.forEach(r => r._cb.set(!out.has(modKey(r._m))));
            const bulk = (pred, include) => { for (const m of snap.meta.mods) if (pred(m)) { if (include) out.delete(modKey(m)); else out.add(modKey(m)); } refresh(); sync(); };
            search.addEventListener('input', Lib.debounce(() => { const q = search.value.trim().toLowerCase(); rows.forEach(r => r.classList.toggle('hidden', !!q && !modTitle(r._m).toLowerCase().includes(q))); }, 80));
            list.append(...rows);
            sync();
            const d = UI.dialog({ wide: true, content: [
                h('div.dialog-body', h('h2', `Profile: ${profile.name}`), h('p', 'Ticked entries are part of this profile. Worlds and configs are shared with the full pack.'),
                    h('div.row-flex', { style: { marginBottom: '10px', flexWrap: 'wrap' } }, h('label.search', { style: { flex: 1, minWidth: '200px' } }, icon('search'), search),
                        h('button.btn.sm', { on: { click: () => bulk(m => Lib.typeOf(m).id === 'shader', false) } }, 'Exclude Shaders'),
                        h('button.btn.sm', { on: { click: () => bulk(m => Lib.typeOf(m).id === 'resourcepack', false) } }, 'Exclude Resource Packs'),
                        h('button.btn.sm', { on: { click: () => bulk(m => m.optional, false) } }, 'Exclude Optional Content'),
                        h('button.btn.sm.ghost', { on: { click: () => bulk(() => true, true) } }, 'Include All')),
                    list),
                h('div.dialog-foot', count, h('span.grow'), h('button.btn', { on: { click: () => d.close() } }, 'Cancel'),
                    h('button.btn.primary', { on: { click: async () => {
                        const all = (snap.meta.profiles || []).map(p => p.id === profile.id ? { ...p, exclude: [...out] } : p);
                        await save(all);
                        UI.Island.toast('Profile Saved', `${profile.name}: ${snap.meta.mods.length - out.size} included`);
                        d.close();
                    } } }, 'Save Profile'))
            ] });
        }
    };

    window.PackTabs = { releases, issues, settings, backups };
    window.DepsPicker = DepsPicker;
    window.Publish = Publish;
})();
