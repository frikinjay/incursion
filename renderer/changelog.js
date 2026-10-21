// Changelogs are rebuilt as DOM nodes from a short allow-list. Platform markup is never inserted as HTML.
(() => {
    const { h, icon, call, fmt } = Lib;
    const NAME = { curseforge: 'CurseForge', modrinth: 'Modrinth' };

    const safeUrl = (u) => { try { const x = new URL(u, 'https://invalid.example/'); return x.protocol === 'https:' && x.hostname !== 'invalid.example' ? x.toString() : null; } catch { return null; } };
    function anchor(text, url) {
        const safe = safeUrl(url);
        if (!safe) return document.createTextNode(text);
        return h('a', { href: '#', title: safe, on: { click: (e) => { e.preventDefault(); call('shell:open', { url: safe }); } } }, text);
    }

    function inline(text) {
        const out = [];
        const re = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\s][^*]*)\*|(?<![\w])_([^_\s][^_]*)_(?![\w])|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https:\/\/[^>\s]+)>|(https:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
        let last = 0, m;
        while ((m = re.exec(text))) {
            if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
            if (m[2] != null) out.push(h('code', m[2]));
            else if (m[3] != null || m[4] != null) out.push(h('strong', ...inline(m[3] ?? m[4])));
            else if (m[5] != null) out.push(h('s', ...inline(m[5])));
            else if (m[6] != null || m[7] != null) out.push(h('em', ...inline(m[6] ?? m[7])));
            else if (m[9] != null) out.push(m[0].startsWith('!') ? anchor(m[8] || 'Image', m[9]) : anchor(m[8] || m[9], m[9]));
            else out.push(anchor(m[10] || m[11], m[10] || m[11]));
            last = re.lastIndex;
        }
        if (last < text.length) out.push(document.createTextNode(text.slice(last)));
        return out;
    }

    function markdown(src) {
        const root = h('div.rich');
        const lines = String(src || '').replace(/\r\n?/g, '\n').replace(/<br\s*\/?>/gi, '\n').split('\n');
        let i = 0, para = [];
        const flush = () => { if (para.length) { root.append(h('p', ...inline(para.join(' ')))); para = []; } };
        while (i < lines.length) {
            const line = lines[i];
            const fence = line.match(/^\s*(```|~~~)/);
            if (fence) {
                flush();
                const body = [];
                for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
                root.append(h('pre', h('code', body.join('\n'))));
                i++; continue;
            }
            const head = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
            if (head) { flush(); root.append(h(`h${Math.min(6, head[1].length + 2)}`, ...inline(head[2]))); i++; continue; }
            if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); root.append(h('hr')); i++; continue; }
            if (/^\s*>/.test(line)) {
                flush();
                const body = [];
                for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''));
                root.append(h('blockquote', ...markdown(body.join('\n')).childNodes));
                continue;
            }
            if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
                flush();
                const ordered = /^\s*\d/.test(line);
                const list = h(ordered ? 'ol' : 'ul');
                for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
                    const depth = lines[i].match(/^\s*/)[0].length;
                    const li = h('li', ...inline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')));
                    if (depth >= 2) li.classList.add('nested');
                    list.append(li);
                }
                root.append(list);
                continue;
            }
            if (!line.trim()) { flush(); i++; continue; }
            para.push(line.trim().replace(/<\/?[a-z][^>]*>/gi, ''));
            i++;
        }
        flush();
        return root;
    }

    // Parse inertly, then rebuild from allowed elements. Only safe links keep an attribute.
    const KEEP = new Set(['p', 'br', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th']);
    const UNWRAP = new Set(['div', 'span', 'font', 'section', 'article', 'small', 'big', 'center', 'sup', 'sub', 'details', 'summary']);
    const HEADING = { h1: 'h3', h2: 'h4', h3: 'h5', h4: 'h6', h5: 'h6', h6: 'h6' };
    function html(src) {
        const doc = new DOMParser().parseFromString(String(src || ''), 'text/html');
        const root = h('div.rich');
        const walk = (node, into) => {
            for (const n of node.childNodes) {
                if (n.nodeType === Node.TEXT_NODE) { into.append(document.createTextNode(n.textContent)); continue; }
                if (n.nodeType !== Node.ELEMENT_NODE) continue;
                const tag = n.tagName.toLowerCase();
                if (tag === 'a') { const a = anchor(n.textContent || n.getAttribute('href') || '', n.getAttribute('href') || ''); into.append(a); continue; }
                if (tag === 'img') { const alt = n.getAttribute('alt'); if (alt) into.append(document.createTextNode(alt)); continue; }
                if (KEEP.has(tag)) { const el = document.createElement(HEADING[tag] || tag); walk(n, el); into.append(el); continue; }
                if (UNWRAP.has(tag)) { walk(n, into); if (tag === 'div') into.append(document.createElement('br')); continue; }
            }
        };
        walk(doc.body, root);
        return root;
    }

    const render = (format, text) => (!String(text || '').trim() ? h('p.muted', 'No changelog was published for this build.') : format === 'html' ? html(text) : markdown(text));

    function open(snap, m) {
        const key = Lib.modKey(m);
        const title = m.names?.curseforge || m.names?.modrinth || 'Mod';
        const platforms = ['modrinth', 'curseforge'].filter(pl => m.ids[pl]);
        const upd = snap.updates[key] || {};
        let platform = platforms.find(pl => upd[pl]) || platforms[0];
        let offset = 0, loaded = [], meta = null;
        const list = h('div.cl-list');
        const more = h('button.btn.hidden', 'Show Older Versions');
        const seg = platforms.length > 1 ? UI.segmented(platforms.map(pl => ({ value: pl, label: h(`span.plat.${pl === 'modrinth' ? 'mr' : 'cf'}`, NAME[pl]) })), platform, (v) => { platform = v; offset = 0; loaded = []; load(); }) : null;
        const d = UI.dialog({ wide: true, content: [
            h('div.dialog-body.cl-body',
                h('h2', `${title} Changelog`),
                h('p', `Builds for Minecraft ${snap.meta.gameVersion}, newest first. The update and everything since the installed build come first.`),
                seg, list, h('div.cl-more', more)),
            h('div.dialog-foot',
                Object.keys(upd).length ? h('button.btn.green', { on: { click: () => { call('packs:apply', { path: snap.meta.path, keys: [key] }).catch(UI.Island.error); d.close(); } } }, icon('arrow-up'), 'Install Update') : null,
                h('button.btn', { on: { click: () => d.close() } }, 'Close'))
        ] });

        function badge(v) {
            const id = String(v.id);
            if (meta.updateId != null && id === String(meta.updateId)) return h('span.chip.sm.green', 'Update');
            if (meta.installedId != null && id === String(meta.installedId)) return h('span.chip.sm.accent', 'Installed');
            if (v.newer) return h('span.chip.sm', 'New');
            return null;
        }
        function paint() {
            const idx = loaded.findIndex(v => meta.installedId != null && String(v.id) === String(meta.installedId));
            loaded.forEach((v, i) => { v.newer = idx === -1 ? !!meta.updateId && i === 0 : i < idx; });
            list.replaceChildren(...loaded.map((v, i) => {
                const body = render(meta.format, v.changelog);
                const older = idx !== -1 && i > idx;
                const sec = h(`section.cl-ver${older ? '.older' : ''}`,
                    h('button.cl-head', { 'aria-expanded': String(!older), on: { click: (e) => { const open = sec.classList.toggle('collapsed'); e.currentTarget.setAttribute('aria-expanded', String(!open)); } } },
                        h('span.cl-name', v.label), badge(v), v.type !== 'release' ? h(`span.chip.sm.${v.type === 'beta' ? 'amber' : 'red'}`, v.type) : null,
                        h('span.grow'), h('span.faint.cl-date', v.date ? new Date(v.date).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''), icon('chev')),
                    h('div.cl-text', body));
                if (older) sec.classList.add('collapsed');
                return sec;
            }));
            if (!loaded.length) list.replaceChildren(h('div.empty', h('h3', 'No Builds Found'), h('p', `${NAME[platform]} has no builds of this project for this Minecraft version and loader.`)));
            more.classList.toggle('hidden', loaded.length >= meta.total);
        }
        async function load() {
            if (!loaded.length) list.replaceChildren(...Array.from({ length: 3 }, () => h('div.cl-ver', h('div.sk', { style: { height: '14px', width: '40%', margin: '14px' } }))));
            more.disabled = true;
            try {
                const r = await call('mods:changelog', { path: snap.meta.path, key, platform, offset });
                meta = r;
                loaded = loaded.concat(r.versions);
                offset = loaded.length;
                if (r.installedId != null && !loaded.some(v => String(v.id) === String(r.installedId)) && loaded.length < r.total && loaded.length < 40) return load();
                paint();
            } catch (err) { list.replaceChildren(h('div.empty', h('h3', 'Couldn’t Load Changelogs'), h('p', err.message))); }
            more.disabled = false;
        }
        more.addEventListener('click', load);
        load();
    }

    window.Changelogs = { open, markdown, html };
})();
