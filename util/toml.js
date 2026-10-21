
function parse(text) {
    const root = {};
    let table = root;
    const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    let i = 0;

    const err = (msg) => { throw new Error(`TOML: ${msg} on line ${src.slice(0, i).split('\n').length}`); };
    const ws = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++; };
    const wsnl = () => {
        for (;;) {
            ws();
            if (src[i] === '#') { while (i < src.length && src[i] !== '\n') i++; }
            if (src[i] === '\n') { i++; continue; }
            break;
        }
    };
    const eol = () => { ws(); if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++; if (i < src.length && src[i] !== '\n') err('unexpected text'); i++; };

    function key() {
        const parts = [];
        for (;;) {
            ws();
            if (src[i] === '"' || src[i] === "'") parts.push(string());
            else {
                const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
                if (!m) err('expected a key');
                parts.push(m[0]); i += m[0].length;
            }
            ws();
            if (src[i] === '.') { i++; continue; }
            return parts;
        }
    }
    const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    function string() {
        const q = src[i];
        const multi = src.startsWith(q.repeat(3), i);
        i += multi ? 3 : 1;
        if (multi && src[i] === '\n') i++;
        let out = '';
        for (;;) {
            if (i >= src.length) err('unterminated string');
            if (multi ? src.startsWith(q.repeat(3), i) : src[i] === q) { i += multi ? 3 : 1; return out; }
            if (!multi && src[i] === '\n') err('newline in string');
            if (q === '"' && src[i] === '\\') {
                const c = src[i + 1];
                if (ESC[c]) { out += ESC[c]; i += 2; }
                else if (c === 'u' || c === 'U') { const n = c === 'u' ? 4 : 8; out += String.fromCodePoint(parseInt(src.substr(i + 2, n), 16)); i += 2 + n; }
                else if (multi && c === '\n') { i += 2; while (/[\s]/.test(src[i])) i++; }
                else err('bad escape');
                continue;
            }
            out += src[i++];
        }
    }
    function value() {
        ws();
        const c = src[i];
        if (c === '"' || c === "'") return string();
        if (c === '[') {
            i++; const arr = [];
            for (;;) { wsnl(); if (src[i] === ']') { i++; return arr; } arr.push(value()); wsnl(); if (src[i] === ',') { i++; continue; } wsnl(); if (src[i] === ']') { i++; return arr; } err('expected , or ]'); }
        }
        if (c === '{') {
            i++; const obj = {};
            ws(); if (src[i] === '}') { i++; return obj; }
            for (;;) { const k = key(); ws(); if (src[i] !== '=') err('expected ='); i++; assign(obj, k, value()); ws(); if (src[i] === ',') { i++; continue; } if (src[i] === '}') { i++; return obj; } err('expected , or }'); }
        }
        const m = /^[^\s,\]}#]+/.exec(src.slice(i, i + 64));
        if (!m) err('expected a value');
        i += m[0].length;
        const v = m[0];
        if (v === 'true') return true;
        if (v === 'false') return false;
        if (/^[+-]?(inf|nan)$/.test(v)) return v.endsWith('inf') ? (v[0] === '-' ? -Infinity : Infinity) : NaN;
        if (/^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{2}:\d{2}/.test(v)) {
            // Date-times may continue after a space ("1979-05-27 07:32:00Z").
            const more = /^ \d{2}:\d{2}[^\s,\]}#]*/.exec(src.slice(i, i + 40));
            if (more) { i += more[0].length; return v + more[0]; }
            return v;
        }
        const num = v.replace(/_/g, '');
        if (/^[+-]?0x[0-9a-f]+$/i.test(num)) return parseInt(num, 16);
        if (/^[+-]?0o[0-7]+$/i.test(num)) return parseInt(num.replace(/0o/i, ''), 8);
        if (/^[+-]?0b[01]+$/i.test(num)) return parseInt(num.replace(/0b/i, ''), 2);
        if (/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+)$/.test(num)) return Number(num);
        err(`can't read ${v}`);
    }
    function assign(obj, path, v) {
        let o = obj;
        for (const p of path.slice(0, -1)) { if (o[p] == null) o[p] = {}; if (typeof o[p] !== 'object' || Array.isArray(o[p])) err(`${p} is not a table`); o = o[p]; }
        const last = path[path.length - 1];
        if (last === '__proto__' || last === 'constructor' || last === 'prototype') return;
        o[last] = v;
    }
    function open(path, arrayItem) {
        let o = root;
        path.forEach((p, n) => {
            if (p === '__proto__' || p === 'constructor' || p === 'prototype') err('bad key');
            const isLast = n === path.length - 1;
            if (isLast && arrayItem) { if (!Array.isArray(o[p])) o[p] = []; const t = {}; o[p].push(t); o = t; return; }
            if (o[p] == null) o[p] = {};
            o = Array.isArray(o[p]) ? o[p][o[p].length - 1] : o[p];
            if (typeof o !== 'object') err(`${p} is not a table`);
        });
        return o;
    }

    for (;;) {
        wsnl();
        if (i >= src.length) break;
        if (src[i] === '[') {
            const arr = src[i + 1] === '[';
            i += arr ? 2 : 1;
            const k = key();
            if (src[i] !== ']' || (arr && src[i + 1] !== ']')) err('expected ]');
            i += arr ? 2 : 1;
            table = open(k, arr);
            eol();
            continue;
        }
        const k = key();
        ws();
        if (src[i] !== '=') err('expected =');
        i++;
        assign(table, k, value());
        eol();
    }
    return root;
}

module.exports = { parse };
