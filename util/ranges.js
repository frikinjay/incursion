
// Release > pre-release, build metadata (+mc1.21.1) is ignored, numeric parts compare as numbers.
function parse(v) {
    const s = String(v).trim().replace(/^v/i, '').split('+')[0];
    const m = s.match(/^([0-9][0-9.]*)(?:[-.]?((?:alpha|beta|rc|pre|snapshot|a|b)[\w.-]*))?/i);
    if (!m) return null;
    return { nums: m[1].split('.').filter(Boolean).map(Number), pre: m[2] ? m[2].toLowerCase() : null };
}

function compare(a, b) {
    const x = typeof a === 'string' ? parse(a) : a, y = typeof b === 'string' ? parse(b) : b;
    if (!x || !y) return null;
    for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
        const d = (x.nums[i] || 0) - (y.nums[i] || 0);
        if (d) return d;
    }
    if (x.pre && !y.pre) return -1;
    if (!x.pre && y.pre) return 1;
    if (x.pre && y.pre) return x.pre.localeCompare(y.pre, undefined, { numeric: true });
    return 0;
}

function mavenSatisfies(v, range) {
    const intervals = [...range.matchAll(/([[(])\s*([^,\])]*?)\s*(?:,\s*([^\])]*?)\s*)?([\])])/g)];
    if (!intervals.length) {
        // A bare version is a soft requirement, so treat it as ">= version".
        const c = compare(v, range);
        return c === null ? null : c >= 0;
    }
    let unknown = false;
    for (const [, open, lo, hiRaw, close] of intervals) {
        const exact = hiRaw === undefined;
        const hi = exact ? lo : hiRaw;
        const loOk = !lo || lo === '*' ? true : (() => { const c = compare(v, lo); if (c === null) return null; return open === '[' ? c >= 0 : c > 0; })();
        const hiOk = !hi || hi === '*' ? true : (() => { const c = compare(v, hi); if (c === null) return null; return close === ']' ? c <= 0 : c < 0; })();
        if (loOk === null || hiOk === null) { unknown = true; continue; }
        if (loOk && hiOk) return true;
    }
    return unknown ? null : false;
}

function fabricPredicate(v, p) {
    p = p.trim();
    if (!p || p === '*') return true;
    const m = p.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/);
    const op = m[1] || '', target = m[2];
    if (/\.x$|\.\*$/.test(target)) {
        const base = target.replace(/\.(x|\*)$/, '');
        const pv = parse(v), pb = parse(base);
        if (!pv || !pb) return null;
        return pb.nums.every((n, i) => pv.nums[i] === n);
    }
    const c = compare(v, target);
    if (c === null) return null;
    if (op === '>=') return c >= 0;
    if (op === '<=') return c <= 0;
    if (op === '>') return c > 0;
    if (op === '<') return c < 0;
    const pv = parse(v), pt = parse(target);
    if (op === '^') return c >= 0 && pv.nums[0] === pt.nums[0];
    if (op === '~') return c >= 0 && pv.nums[0] === pt.nums[0] && (pv.nums[1] || 0) === (pt.nums[1] || 0);
    return c === 0;
}

function satisfies(version, range) {
    const r = String(range ?? '*').trim();
    if (!r || r === '*' || r === '[0,)' || r === '[*,)') return true;
    if (!version || /\$\{/.test(version) || !parse(version)) return null;
    let unknown = false;
    for (const alt of r.split('||')) {
        const a = alt.trim();
        let res;
        if (/[[(]/.test(a)) res = mavenSatisfies(version, a);
        else {
            res = true;   // space-separated predicates must all hold
            for (const pred of a.split(/\s+/).filter(Boolean)) {
                const x = fabricPredicate(version, pred);
                if (x === false) { res = false; break; }
                if (x === null) res = null;
            }
        }
        if (res === true) return true;
        if (res === null) unknown = true;
    }
    return unknown ? null : false;
}

module.exports = { satisfies, compare, parse };
