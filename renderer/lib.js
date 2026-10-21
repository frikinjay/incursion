(() => {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    // Skip null / undefined / false children so "cond ? node : null" doesn't render as text.
    for (const proto of [Element.prototype, DocumentFragment.prototype]) {
        for (const name of ['append', 'prepend', 'replaceChildren']) {
            const native = proto[name];
            proto[name] = function (...nodes) { return native.apply(this, nodes.filter(n => n != null && n !== false)); };
        }
    }

    // Strings become text nodes, never HTML.
    function h(tag, props, ...children) {
        if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
        const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
        const el = document.createElement(name || 'div');
        for (const part of rest.match(/[.#][^.#]+/g) || []) {
            if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
        }
        if (props) for (const [k, v] of Object.entries(props)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
            else if (k === 'class') el.className += ` ${v}`;
            else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
            else if (k === 'dataset') Object.assign(el.dataset, v);
            else if (k in el && typeof v !== 'string') el[k] = v;
            else el.setAttribute(k, v === true ? '' : v);
        }
        append(el, children);
        return el;
    }
    function append(el, children) {
        for (const c of children.flat(Infinity)) {
            if (c === null || c === undefined || c === false) continue;
            el.append(c instanceof Node ? c : document.createTextNode(String(c)));
        }
        return el;
    }

    // Same rule as util/content.js: the pack's choice, else CurseForge unless Modrinth has more of its entries.
    function playPlatform(meta) {
        const chosen = meta.launch?.platform;
        if (chosen === 'modrinth' || chosen === 'curseforge') return chosen;
        const mods = meta.mods || [];
        return mods.filter(m => m.ids?.modrinth).length > mods.filter(m => m.ids?.curseforge).length ? 'modrinth' : 'curseforge';
    }

    function icon(name, cls = '') {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', `i ${cls}`.trim());
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `#i-${name}`);
        svg.append(use);
        return svg;
    }

    function img(src, cls = '', alt = '', { lazy = false } = {}) {
        const el = h('img', { class: cls, alt, loading: lazy ? 'lazy' : 'eager', decoding: 'async', draggable: false });
        el.src = src || 'icon.svg';
        el.addEventListener('error', () => { if (!el.src.endsWith('icon.svg')) el.src = 'icon.svg'; }, { once: true });
        return el;
    }

    async function call(channel, payload) {
        const res = await window.incursion.invoke(channel, payload);
        if (!res.ok) throw Object.assign(new Error(res.error || 'Something went wrong'), { code: res.code });
        return res.data;
    }

    function store(initial) {
        let state = initial;
        const subs = new Set();
        return {
            get: () => state,
            set(patch) { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; subs.forEach(fn => fn(state)); },
            sub(fn) { subs.add(fn); return () => subs.delete(fn); }
        };
    }

    const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
    const rafThrottle = (fn) => { let q = false; return (...a) => { if (q) return; q = true; requestAnimationFrame(() => { q = false; fn(...a); }); }; };

    const nf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    const fmt = {
        count: (n) => nf.format(n || 0),
        plural: (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`,
        ago(ts) {
            if (!ts) return 'never';
            const s = (Date.now() - new Date(ts).getTime()) / 1000;
            if (s < 45) return 'just now';
            const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
            for (const [unit, sec] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
                if (s >= sec) return rtf.format(-Math.floor(s / sec), unit);
            }
            return 'just now';
        },
        bytes(b) {
            if (!b) return '—';
            const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
            while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
            return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`;
        }
    };

    const LOADERS = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
    const modKey = (m) => String(m.ids.curseforge || m.ids.modrinth);
    const modTitle = (m) => m.names?.curseforge || m.names?.modrinth || 'Unknown Mod';
    const modIcon = (m) => m.icons?.modrinth || m.icons?.curseforge || null;

    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    function transition(update) {
        if (!document.startViewTransition || reduceMotion.matches || document.documentElement.classList.contains('booting')) { update(); return Promise.resolve(); }
        const t = document.startViewTransition(update);
        t.ready.catch(() => {});
        return t.finished.catch(() => {});
    }

    function themeTransition(x, y, update) {
        if (!document.startViewTransition || reduceMotion.matches || document.documentElement.dataset.motion === 'off') { update(); return; }
        const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
        const root = document.documentElement;
        root.style.setProperty('--vt-x', `${x}px`);
        root.style.setProperty('--vt-y', `${y}px`);
        root.style.setProperty('--vt-r', `${r}px`);
        root.classList.add('theme-switch');
        const t = document.startViewTransition(update);
        t.ready.catch(() => {});
        t.finished.catch(() => {}).finally(() => root.classList.remove('theme-switch'));
    }

    const PRESETS = ['plain'];
    const LEGACY_PRESETS = ['aurora', 'ocean', 'sunset', 'forest', 'graphite'];   // old gradient wallpapers show as plain
    // #0088ff was the old default and counts as unset.
    const accentOf = (prefs) => (!prefs.accent || prefs.accent.toLowerCase() === '#0088ff' ? '' : prefs.accent.toLowerCase());
    function applyAppearance(prefs = {}) {
        const root = document.documentElement;
        const accent = accentOf(prefs);
        if (accent) root.style.setProperty('--accent', accent); else root.style.removeProperty('--accent');
        root.dataset.motion = prefs.motion === false ? 'off' : 'on';
        const bd = document.getElementById('backdrop');
        if (!bd) return;
        const bg = !prefs.background || LEGACY_PRESETS.includes(prefs.background) ? 'plain' : prefs.background;
        const layer = bd.querySelector('.layer-img');
        if (PRESETS.includes(bg)) { bd.dataset.preset = bg; layer.style.backgroundImage = ''; }
        else { bd.dataset.preset = 'image'; layer.style.backgroundImage = `url("${String(bg).replace(/"/g, '%22')}")`; }
        bd.style.setProperty('--bg-dim', String(prefs.dim ?? (PRESETS.includes(bg) ? 0 : 0.35)));
        bd.style.setProperty('--bg-blur', `${prefs.blur ?? 0}px`);
    }

    const TYPES = {
        mod: { id: 'mod', label: 'Mods', one: 'mod', many: 'mods', icon: 'cube' },
        resourcepack: { id: 'resourcepack', label: 'Resource Packs', one: 'resource pack', many: 'resource packs', icon: 'image' },
        shader: { id: 'shader', label: 'Shaders', one: 'shader', many: 'shaders', icon: 'sun' },
        datapack: { id: 'datapack', label: 'Data Packs', one: 'data pack', many: 'data packs', icon: 'database' }
    };
    const typeOf = (m) => TYPES[typeof m === 'string' ? m : m?.type] || TYPES.mod;
    const contentSummary = (mods) => {
        const n = {};
        for (const m of mods) n[typeOf(m).id] = (n[typeOf(m).id] || 0) + 1;
        return Object.keys(TYPES).filter(k => n[k]).map(k => fmt.plural(n[k], TYPES[k].one, TYPES[k].many));
    };

    window.Lib = { playPlatform, TYPES, typeOf, contentSummary, h, append, icon, img, call, store, debounce, rafThrottle, fmt, LOADERS, modKey, modTitle, modIcon, transition, themeTransition, applyAppearance, PRESETS, LEGACY_PRESETS, accentOf };
})();
