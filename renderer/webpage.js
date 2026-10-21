(() => {
    const { h, icon, call } = Lib;
    let current = null;

    const PLATFORM = {
        modrinth: { label: 'Modrinth', mark: 'i-modrinth' },
        curseforge: { label: 'CurseForge', mark: 'i-curseforge' }
    };
    const brand = (id) => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'brand-i');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `#${PLATFORM[id].mark}`);
        svg.append(use);
        return svg;
    };

    function open(url, { platform = /curseforge/.test(url) ? 'curseforge' : 'modrinth', title = '' } = {}) {
        if (!url) return;
        if (current) { current.navigate(url, platform, title); return; }
        const titleEl = h('span.webframe-title', title || PLATFORM[platform].label);
        const hostEl = h('span.webframe-host.mono');
        const back = h('button.btn.ghost.sm.icon', { title: 'Back', 'aria-label': 'Back', disabled: true, on: { click: () => call('web:nav', { action: 'back' }) } }, icon('chev-left'));
        const fwd = h('button.btn.ghost.sm.icon', { title: 'Forward', 'aria-label': 'Forward', disabled: true, on: { click: () => call('web:nav', { action: 'forward' }) } }, icon('chev'));
        const reload = h('button.btn.ghost.sm.icon', { title: 'Reload', 'aria-label': 'Reload', on: { click: () => call('web:nav', { action: 'reload' }) } }, icon('refresh'));
        const mark = h('span.webframe-mark', brand(platform));
        const loading = h('div.webframe-loading', h('span.spinner'), h('span', 'Loading Page'));
        const body = h('div.webframe-body', loading);
        const scrim = h('div.scrim', { on: { click: () => close() } });
        const el = h('div.webframe', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${PLATFORM[platform].label} page` },
            h('div.webframe-head',
                mark,
                h('div.webframe-titles', titleEl, hostEl),
                h('div.webframe-nav', back, fwd, reload),
                h('button.btn.sm', { on: { click: () => call('web:nav', { action: 'external' }) } }, icon('export'), h('span.lbl', 'Open in Browser')),
                h('button.btn.ghost.sm.icon', { title: 'Close (Esc)', 'aria-label': 'Close', on: { click: () => close() } }, icon('x'))),
            body);
        const layer = document.getElementById('layer');
        layer.append(scrim, el);
        requestAnimationFrame(() => { scrim.classList.add('show'); el.classList.add('show'); });

        const bounds = () => { const r = body.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
        // Only show the native view once the frame's entrance animation is done, or it floats ahead of it.
        let shown = false;
        const ro = new ResizeObserver(() => { if (shown) call('web:bounds', { bounds: bounds() }).catch(() => {}); });
        ro.observe(body);
        const onWinResize = () => { if (shown) call('web:bounds', { bounds: bounds() }).catch(() => {}); };
        addEventListener('resize', onWinResize);
        const unsub = window.incursion.on(({ type, payload }) => {
            if (type !== 'webpage' || !current) return;
            if (payload.closeRequested || !payload.open) { if (payload.closeRequested) close(); return; }
            titleEl.textContent = (payload.title || PLATFORM[platform].label).replace(/\s*[-|]\s*(Modrinth|CurseForge)\s*$/i, '');
            try { hostEl.textContent = new URL(payload.url).host + new URL(payload.url).pathname; } catch {}
            back.disabled = !payload.canGoBack;
            fwd.disabled = !payload.canGoForward;
            loading.classList.toggle('hidden', !payload.loading);
        });
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
        document.addEventListener('keydown', onKey, true);

        function close() {
            if (!current) return;
            current = null;
            ro.disconnect();
            removeEventListener('resize', onWinResize);
            document.removeEventListener('keydown', onKey, true);
            unsub();
            call('web:close').catch(() => {});
            el.classList.remove('show'); scrim.classList.remove('show');
            setTimeout(() => { el.remove(); scrim.remove(); }, 300);
        }
        current = {
            close,
            navigate(u, pl, t) {
                mark.replaceChildren(brand(pl));
                titleEl.textContent = t || PLATFORM[pl].label;
                call('web:open', { url: u, bounds: bounds() }).catch(UI.Island.error);
            }
        };
        setTimeout(() => {
            if (!current) return;
            shown = true;
            call('web:open', { url, bounds: bounds() }).catch((err) => { UI.Island.error(err); close(); });
        }, 260);
    }

    window.PageViewer = { open, brand, close: () => current?.close() };
})();
