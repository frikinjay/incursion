(() => {
    const { h, icon } = Lib;
    const layer = () => document.getElementById('layer');

    const Island = (() => {
        const el = document.getElementById('island');
        const label = el.querySelector('.island-label');
        const detail = el.querySelector('.island-detail');
        const bar = el.querySelector('.bar');
        const glyph = el.querySelector('.island-glyph use');
        const tasks = new Map();
        let flash = null, flashTimer = null;
        const CIRC = 50.27;

        function render() {
            const running = [...tasks.values()].filter(t => t.state === 'running');
            const item = flash || running[running.length - 1];
            if (!item) { el.classList.remove('show'); return; }
            const wasHidden = !el.classList.contains('show');
            el.classList.add('show');
            el.classList.toggle('done', item.state === 'done');
            el.classList.toggle('error', item.state === 'error');
            el.classList.toggle('indeterminate', item.state === 'running' && (item.progress === null || item.progress === undefined));
            glyph.setAttribute('href', item.state === 'error' ? '#i-x' : '#i-check');
            bar.style.strokeDashoffset = item.state === 'running' && item.progress != null ? String(CIRC * (1 - item.progress)) : '';
            label.textContent = item.label;
            const extra = running.length > 1 && !flash ? ` +${running.length - 1}` : '';
            detail.textContent = (item.detail || '') + extra;
            const inner = el.firstElementChild;
            el.style.width = `${Math.min(440, inner.scrollWidth + 2)}px`;
            if (!wasHidden && item.state !== 'running') { el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); }
        }

        function showFlash(item, ms = 2600) {
            flash = item;
            clearTimeout(flashTimer);
            flashTimer = setTimeout(() => { flash = null; render(); }, ms);
            render();
        }

        return {
            task(t) {
                if (t.state === 'running') tasks.set(t.id, t);
                else { tasks.delete(t.id); showFlash(t, t.state === 'error' ? 5000 : 2600); }
                render();
            },
            toast(labelText, detailText = '', kind = 'done') { showFlash({ label: labelText, detail: detailText, state: kind }, kind === 'error' ? 5000 : 2400); },
            error(err) { showFlash({ label: typeof err === 'string' ? err : err.message, detail: '', state: 'error' }, 5000); }
        };
    })();

    let openLayers = [];
    function pushLayer(close) { openLayers.push(close); }
    function popLayer(close) { openLayers = openLayers.filter(c => c !== close); }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && openLayers.length) { e.preventDefault(); openLayers[openLayers.length - 1](); }
    });

    function scrim(onClick) {
        const s = h('div.scrim', { on: { click: onClick } });
        layer().append(s);
        requestAnimationFrame(() => s.classList.add('show'));
        return s;
    }

    function trapFocus(container) {
        container.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            const f = [...container.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, [tabindex="0"]')].filter(x => x.offsetParent);
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        });
    }

    function drawer({ content, narrow = false, onClose }) {
        const prevFocus = document.activeElement;
        const el = h(`div.drawer${narrow ? '.narrow' : ''}`, { role: 'dialog', 'aria-modal': 'true' }, content);
        let closed = false;
        const close = () => {
            if (closed) return; closed = true;
            popLayer(close);
            el.classList.remove('show'); s.classList.remove('show');
            setTimeout(() => { el.remove(); s.remove(); }, 450);
            onClose?.();
            prevFocus?.focus?.();
        };
        const s = scrim(close);
        layer().append(el);
        trapFocus(el);
        pushLayer(close);
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
        return { el, close };
    }

    function dialog({ content, small = false, wide = false, onClose }) {
        const prevFocus = document.activeElement;
        const el = h(`div.dialog${small ? '.small' : ''}${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true' }, content);
        let closed = false;
        const close = () => {
            if (closed) return; closed = true;
            popLayer(close);
            el.classList.remove('show'); s.classList.remove('show');
            setTimeout(() => { el.remove(); s.remove(); }, 350);
            onClose?.();
            prevFocus?.focus?.();
        };
        const s = scrim(close);
        layer().append(el);
        trapFocus(el);
        pushLayer(close);
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
        return { el, close };
    }

    function choose({ title, message, choices }) {
        return new Promise((resolve) => {
            let answer = null;
            const btns = choices.map((c, i) => h(`button.btn${i === 0 ? '.primary' : ''}${c.danger ? '.danger' : ''}`, { on: { click: () => { answer = c.value; d.close(); } } }, c.label));
            const d = dialog({
                small: true,
                onClose: () => resolve(answer),
                content: [
                    h('div.dialog-body', h('h2', title), h('p', message)),
                    h('div.dialog-foot.stacked', ...btns, h('button.btn', { on: { click: () => d.close() } }, 'Cancel'))
                ]
            });
            setTimeout(() => btns[0]?.focus(), 50);
        });
    }

    function confirm({ title, message, confirmLabel = 'Continue', danger = false }) {
        return new Promise((resolve) => {
            let answer = false;
            const ok = h(`button.btn${danger ? '.danger' : '.primary'}`, { on: { click: () => { answer = true; d.close(); } } }, confirmLabel);
            const d = dialog({
                small: true,
                onClose: () => resolve(answer),
                content: [
                    h('div.dialog-body', h('h2', title), h('p', message)),
                    h('div.dialog-foot', h('button.btn', { on: { click: () => d.close() } }, 'Cancel'), ok)
                ]
            });
            setTimeout(() => ok.focus(), 50);
        });
    }

    function menu(anchor, items, { align = 'right', minWidth, className = '' } = {}) {
        if (anchor.__menuClose) { anchor.__menuClose(); return; }
        let closed = false;
        const anyChecked = items.some(it => it && it.checked !== undefined);
        const m = h(`div.menu${className ? `.${className}` : ''}`, { role: 'menu' }, items.filter(Boolean).map(it => {
            if (it === 'sep') return h('hr');
            if (it.heading) return h('div.menu-label', it.heading);
            return h(`button${it.danger ? '.danger' : ''}`, {
                role: anyChecked ? 'menuitemradio' : 'menuitem', disabled: !!it.disabled, 'aria-checked': it.checked ? 'true' : undefined,
                dataset: it.value !== undefined ? { value: String(it.value) } : undefined,
                on: { click: () => { close(); it.onClick?.(); } }
            }, it.icon ? icon(it.icon) : null, h('span.lbl.grow', it.label), it.checked ? icon('check', 'check') : anyChecked ? h('span.spacer-i') : null);
        }));
        if (minWidth) m.style.minWidth = `${minWidth}px`;
        layer().append(m);
        const r = anchor.getBoundingClientRect();
        const mw = m.offsetWidth, mh = m.offsetHeight;
        let left = align === 'right' ? r.right - mw : align === 'stretch' ? r.left : r.left;
        let top = r.bottom + 6;
        let fromBottom = false;
        if (top + mh > innerHeight - 8) { top = Math.max(8, r.top - mh - 6); fromBottom = true; }
        left = Math.max(8, Math.min(left, innerWidth - mw - 8));
        Object.assign(m.style, { left: `${left}px`, top: `${top}px` });
        m.style.setProperty('--ox', `${r.left + r.width / 2 - left}px`);
        m.style.setProperty('--oy', fromBottom ? `${mh}px` : '0px');
        m.style.setProperty('--from-sx', Math.min(1, r.width / mw).toFixed(3));
        m.style.setProperty('--from-sy', Math.min(1, r.height / mh).toFixed(3));
        m.classList.add('morph-in');
        anchor.setAttribute('aria-expanded', 'true');
        anchor.__menuClose = close;

        function close() {
            if (closed) return;
            closed = true;
            if (anchor.__menuClose === close) anchor.__menuClose = null;
            popLayer(close);
            document.removeEventListener('pointerdown', outside, true);
            anchor.setAttribute('aria-expanded', 'false');
            m.classList.remove('morph-in');
            m.classList.add('morph-out');
            setTimeout(() => m.remove(), 240);
        }
        const outside = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) close(); };
        setTimeout(() => document.addEventListener('pointerdown', outside, true));
        pushLayer(close);
        const checked = m.querySelector('button[aria-checked="true"]');
        (checked || m.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
        checked?.scrollIntoView({ block: 'nearest' });
        let typed = '', typedAt = 0;
        m.addEventListener('keydown', (e) => {
            const btns = [...m.querySelectorAll('button:not(:disabled)')];
            const i = btns.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
            else if (e.key === 'Home') { e.preventDefault(); btns[0]?.focus(); }
            else if (e.key === 'End') { e.preventDefault(); btns[btns.length - 1]?.focus(); }
            else if (e.key === 'Tab') { e.preventDefault(); close(); anchor.focus(); }
            else if (e.key.length === 1 && /\S/.test(e.key)) {
                typed = Date.now() - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
                typedAt = Date.now();
                btns.find(b => b.textContent.trim().toLowerCase().startsWith(typed))?.focus();
            }
        });
        return close;
    }

    function segmented(options, value, onChange) {
        const thumb = h('span.thumb');
        const root = h('div.segmented', { role: 'tablist' }, thumb);
        const buttons = options.map(o => {
            const b = h('button', { role: 'tab', type: 'button', dataset: { value: o.value }, on: { click: () => { if (!dragged) set(o.value, true); } } },
                typeof o.label === 'string' ? h('span.lbl', o.label) : o.label,
                o.badge != null ? h('span.badge', { class: o.badgeClass || '' }, o.badge) : null);
            root.append(b);
            return b;
        });
        let dragged = false;
        function place(x) {
            const b = buttons.find(x2 => x2.dataset.value === value);
            if (!b || !b.offsetWidth) return;
            thumb.style.width = `${b.offsetWidth}px`;
            thumb.style.transform = `translateX(${x ?? b.offsetLeft}px)`;
        }
        function set(v, user) {
            value = v;
            buttons.forEach(b => { b.classList.toggle('on', b.dataset.value === v); b.setAttribute('aria-selected', b.dataset.value === v); });
            place();
            if (user) onChange(v);
        }
        thumb.style.pointerEvents = 'none';
        root.addEventListener('pointerdown', (e) => {
            const b = e.target.closest('button');
            if (!b || b.dataset.value !== value || e.button !== 0) return;
            const startX = e.clientX, startLeft = b.offsetLeft;
            dragged = false;
            const move = (ev) => {
                const dx = ev.clientX - startX;
                if (!dragged && Math.abs(dx) < 4) return;
                if (!dragged) { dragged = true; thumb.classList.add('lifting'); root.setPointerCapture?.(e.pointerId); }
                const maxX = root.clientWidth - thumb.offsetWidth - 3;
                place(Math.max(3, Math.min(maxX, startLeft + dx)));
            };
            const up = (ev) => {
                removeEventListener('pointermove', move);
                removeEventListener('pointerup', up);
                if (!dragged) return;
                thumb.classList.remove('lifting');
                const x = ev.clientX - root.getBoundingClientRect().left;
                const target = buttons.reduce((best, bt) => (Math.abs(bt.offsetLeft + bt.offsetWidth / 2 - x) < Math.abs(best.offsetLeft + best.offsetWidth / 2 - x) ? bt : best));
                const changed = target.dataset.value !== value;
                set(target.dataset.value, changed);
                setTimeout(() => { dragged = false; }, 0);
            };
            addEventListener('pointermove', move);
            addEventListener('pointerup', up);
        });
        set(value, false);
        new ResizeObserver(() => place()).observe(root);
        root.setBadge = (v, badge, cls) => {
            const b = buttons.find(x => x.dataset.value === v);
            if (!b) return;
            let span = b.querySelector('.badge');
            if (badge == null || badge === 0) { span?.remove(); place(); return; }
            if (!span) { span = h('span.badge'); b.append(span); }
            span.className = `badge ${cls || ''}`;
            span.textContent = badge;
            place();
        };
        root.set = (v) => set(v, false);
        return root;
    }

    function picker({ label, options, value, onChange }) {
        const text = h('span.lbl');
        const btn = h('button.menu-btn', { type: 'button', 'aria-haspopup': 'menu' }, text, icon('chev-down'));
        const sync = () => {
            const o = options.find(x => x.value === value);
            text.textContent = o?.short || o?.label || label;
            btn.classList.toggle('set', value !== options[0].value);
        };
        btn.addEventListener('click', () => menu(btn, [
            { heading: label },
            ...options.map(o => ({ label: o.label, checked: o.value === value, onClick: () => { value = o.value; sync(); onChange(value); } }))
        ]));
        sync();
        return btn;
    }

    function toggle(value, onChange, label = '') {
        const b = h('button.switch', { type: 'button', role: 'switch', 'aria-label': label });
        const set = (v) => { value = !!v; b.classList.toggle('on', value); b.setAttribute('aria-checked', value); };
        b.addEventListener('click', () => { set(!value); onChange(value); });
        set(value);
        b.set = set;
        return b;
    }

    function checkbox(value, onChange) {
        const b = h('button.cbox', { type: 'button', role: 'checkbox' }, icon('check'));
        const set = (v) => { value = !!v; b.classList.toggle('on', value); b.setAttribute('aria-checked', value); };
        b.addEventListener('click', (e) => { e.stopPropagation(); set(!value); onChange?.(value); });
        set(value);
        b.set = set;
        b.get = () => value;
        return b;
    }

    function prompt({ title, message = '', value = '', placeholder = '', confirmLabel = 'OK' }) {
        return new Promise((resolve) => {
            let answer = null;
            const input = h('input.field', { value, placeholder, spellcheck: false });
            const ok = h('button.btn.primary', { on: { click: () => { answer = input.value.trim() || null; d.close(); } } }, confirmLabel);
            // preventDefault, or the same Enter re-activates the button focus returns to.
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } });
            const d = dialog({ small: true, onClose: () => resolve(answer), content: [
                h('div.dialog-body', h('h2', title), message ? h('p', message) : null, input),
                h('div.dialog-foot', h('button.btn', { on: { click: () => d.close() } }, 'Cancel'), ok)
            ] });
            setTimeout(() => { input.focus(); input.select(); }, 60);
        });
    }

    // The native <select> stays in the DOM as the source of truth. The trigger just mirrors it.
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    function enhanceSelect(sel) {
        if (sel._enhanced) return;
        sel._enhanced = true;
        const lbl = h('span.lbl');
        const trigger = h('button.select-trigger', { type: 'button', 'aria-haspopup': 'listbox' }, lbl, h('span.chev', icon('chevrons')));
        sel.after(trigger);
        if (sel.style.width) trigger.style.width = sel.style.width;
        if (sel.style.height) trigger.style.height = sel.style.height;
        const render = () => {
            const o = sel.options[sel.selectedIndex];
            lbl.textContent = o ? o.textContent : '';
            trigger.disabled = sel.disabled;
            trigger.title = lbl.textContent;
        };
        Object.defineProperty(sel, 'value', {
            configurable: true,
            get() { return nativeValue.get.call(this); },
            set(v) { nativeValue.set.call(this, v); render(); }
        });
        new MutationObserver(render).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
        trigger.addEventListener('click', () => {
            if (sel.disabled) return;
            const opts = [...sel.options];
            menu(trigger, opts.map(o => ({
                label: o.textContent, checked: o.selected, disabled: o.disabled, value: o.value,
                onClick: () => { if (sel.value !== o.value) { nativeValue.set.call(sel, o.value); render(); sel.dispatchEvent(new Event('change', { bubbles: true })); } trigger.focus(); }
            })), { align: 'stretch', minWidth: trigger.offsetWidth, className: 'select-menu' });
        });
        trigger.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); trigger.click(); } });
        render();
    }

    function enhanceRange(input) {
        if (input._enhanced) return;
        input._enhanced = true;
        const fill = h('span.slider-fill');
        const knob = h('span.range-knob');
        const ui = h('div.slider', { tabindex: '0', role: 'slider' }, h('span.slider-track', fill), knob);
        input.after(ui);
        const min = () => Number(input.min || 0), max = () => Number(input.max || 100), step = () => Number(input.step || 1);
        const render = () => {
            const p = (Number(input.value) - min()) / ((max() - min()) || 1);
            const x = `${Math.max(0, Math.min(1, p)) * 100}%`;
            fill.style.width = x;
            knob.style.left = `clamp(18px, ${x}, calc(100% - 18px))`;
            ui.setAttribute('aria-valuenow', input.value);
        };
        const setFrom = (clientX, commit) => {
            const r = ui.getBoundingClientRect();
            const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
            const raw = min() + p * (max() - min());
            const v = Math.round(raw / step()) * step();
            if (String(v) !== input.value) { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); }
            render();
            if (commit) input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        ui.addEventListener('pointerdown', (e) => {
            ui.setPointerCapture(e.pointerId);
            knob.classList.add('lifting');
            setFrom(e.clientX, false);
            const move = (ev) => setFrom(ev.clientX, false);
            const up = (ev) => { ui.removeEventListener('pointermove', move); ui.removeEventListener('pointerup', up); knob.classList.remove('lifting'); setFrom(ev.clientX, true); };
            ui.addEventListener('pointermove', move);
            ui.addEventListener('pointerup', up);
        });
        ui.addEventListener('keydown', (e) => {
            const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
            if (!d) return;
            e.preventDefault();
            input.value = Math.max(min(), Math.min(max(), Number(input.value) + d * step()));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            render();
        });
        input.addEventListener('input', render);
        render();
    }

    const tip = h('div.tooltip', { role: 'tooltip' });
    document.body.append(tip);
    let tipTimer = 0, tipFor = null;
    const hideTip = () => { clearTimeout(tipTimer); tip.classList.remove('show'); tipFor = null; };
    document.addEventListener('pointerover', (e) => {
        const el = e.target.closest('[title], [data-tip]');
        if (!el || el === tipFor) return;
        if (el.hasAttribute('title')) { el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title'); }
        if (!el.dataset.tip) return;
        hideTip();
        tipFor = el;
        tipTimer = setTimeout(() => {
            if (tipFor !== el || !el.isConnected) return;
            tip.textContent = el.dataset.tip;
            const r = el.getBoundingClientRect();
            const w = Math.min(280, tip.offsetWidth || 120);
            let left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
            let top = r.bottom + 8;
            if (top + 40 > innerHeight) top = r.top - 40;
            Object.assign(tip.style, { left: `${left}px`, top: `${top}px` });
            tip.classList.add('show');
        }, 550);
    });
    document.addEventListener('pointerout', (e) => { if (tipFor && !tipFor.contains(e.relatedTarget)) hideTip(); });
    document.addEventListener('pointerdown', hideTip, true);

    const upgrade = (node) => {
        // Console lines and list rows show up by the thousand, so skip them early.
        if (!(node instanceof Element) || node.classList.contains('log') || node.classList.contains('row') || node.classList.contains('result')) return;
        for (const s of node.matches?.('select.field') ? [node] : node.querySelectorAll('select.field')) enhanceSelect(s);
        for (const r of node.matches?.('input.range') ? [node] : node.querySelectorAll('input.range')) enhanceRange(r);
    };
    new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) upgrade(n); }).observe(document.body, { childList: true, subtree: true });

    window.UI = { Island, drawer, dialog, confirm, choose, prompt, menu, segmented, picker, toggle, checkbox, enhanceSelect, enhanceRange };
})();
