const fs = require('fs-extra');
const path = require('path');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function analyse(texts, mods, keyOf) {
    const all = [texts.report, texts.log, texts.console].filter(Boolean).join('\n');
    const lines = all.split(/\r?\n/);
    const scores = new Map();

    const byId = new Map(), byJar = new Map(), byName = new Map();
    for (const m of mods) {
        for (const id of m.contents?.ids || []) if (id.id && !/\$\{/.test(id.id)) byId.set(norm(id.id), m);
        for (const pl of ['modrinth', 'curseforge']) if (m.installedFiles?.[pl]) byJar.set(m.installedFiles[pl].toLowerCase(), m);
        for (const n of [m.names?.modrinth, m.names?.curseforge, m.slugs?.modrinth, m.slugs?.curseforge]) if (n) byName.set(norm(n), m);
    }
    const find = (token) => {
        const t = String(token || '').trim();
        if (!t) return null;
        return byId.get(norm(t)) || byJar.get(path.basename(t).toLowerCase()) || byName.get(norm(t)) || null;
    };
    const blame = (token, weight, reason) => {
        const m = find(token);
        if (!m) return;
        const k = keyOf(m);
        const e = scores.get(k) || { m, score: 0, reasons: new Set() };
        e.score += weight;
        e.reasons.add(reason);
        scores.set(k, e);
    };

    const description = (all.match(/^Description: (.+)$/m) || [])[1] || null;
    const exception = (lines.find(l => /^(?:Caused by: )?[\w.$]+(?:Exception|Error)(?::|$)/.test(l.trim())) || '').trim() || null;

    const suspectedBlock = all.match(/Suspected Mods?:\s*\n((?:[ \t]+.+\n?)+)/);
    if (suspectedBlock) for (const m of suspectedBlock[1].matchAll(/\(([\w-]+)\),\s*Version/g)) blame(m[1], 10, 'Named as the suspected mod in the crash report');
    for (const m of all.matchAll(/-- Mod loading issue for: ([\w-]+) --/g)) blame(m[1], 10, 'Failed while loading');
    for (const m of all.matchAll(/Mod File: (.+\.jar)/g)) blame(m[1], 6, 'Its file is named in the crash report');
    for (const m of all.matchAll(/Mod ID: '([\w-]+)', Requested by: '([\w-]+)'/g)) { blame(m[2], 9, `Needs “${m[1]}”, which is missing or the wrong version`); }
    for (const m of all.matchAll(/Mod '[^']+' \(([\w-]+)\) [^\n]*? requires [^\n]*?(?:of|any version of) (?:mod )?'?([^'\n,]+)'?(?: \(([\w-]+)\))?[^\n]*?(?:which is missing|but only the wrong version is present)/g)) {
        blame(m[1], 9, `Requires ${m[3] || m[2]}, which is missing or the wrong version`);
    }
    for (const m of all.matchAll(/Mod '[^']+' \(([\w-]+)\) [^\n]*? is incompatible with [^\n]*?'([^']+)' \(([\w-]+)\)/g)) {
        blame(m[1], 8, `Incompatible with ${m[2]}`);
        blame(m[3], 8, `Incompatible with ${m[1]}`);
    }
    for (const m of all.matchAll(/(?:Mixin|mixin)[^\n]*?from mod ([\w-]+)/g)) blame(m[1], 7, 'One of its mixins failed to apply');
    for (const m of all.matchAll(/([\w-]+)\.mixins\.json/g)) blame(m[1], 3, 'Its mixin config appears in the error');
    const frames = lines.filter(l => /^\s+at /.test(l)).slice(0, 80);
    for (const f of frames) {
        const jar = (f.match(/\[([^\]\s:]+\.jar)[:\]]/) || [])[1];
        if (jar && !/^(minecraft|client|server|forge|neoforge|fabric-loader|loader|javafmllanguage|fmlcore|fmlloader|securejarhandler|bootstraplauncher)/i.test(jar)) blame(jar, 2, 'Appears in the crash stack trace');
    }

    const suspects = [...scores.entries()].map(([key, e]) => ({
        key,
        title: e.m.names?.modrinth || e.m.names?.curseforge || key,
        score: e.score,
        confidence: e.score >= 9 ? 'high' : e.score >= 5 ? 'medium' : 'low',
        reasons: [...e.reasons]
    })).sort((a, b) => b.score - a.score).slice(0, 6);

    const at = lines.findIndex(l => l.trim() === exception);
    const excerpt = at >= 0 ? lines.slice(at, at + 12) : [];

    let cause = null;
    if (/OutOfMemoryError/.test(all)) cause = 'The game ran out of memory. Give the pack more memory in its settings.';
    else if (/UnsupportedClassVersionError|class file version/.test(all)) cause = 'A mod was built for a newer Java than the one used. Pick a newer Java in the pack’s settings.';
    else if (/requires version .* of (?:minecraft|java)/i.test(all)) cause = 'A mod needs a different Minecraft or Java version.';

    return { headline: description || exception || 'Minecraft stopped unexpectedly', exception, cause, suspects, excerpt };
}

async function readSources({ crashReportsDir, logsPath, since = 0, consoleLines = [] }) {
    let report = null;
    try {
        const files = (await fs.readdir(crashReportsDir)).filter(f => f.endsWith('.txt'));
        const stats = await Promise.all(files.map(async f => ({ f, t: (await fs.stat(path.join(crashReportsDir, f))).mtimeMs })));
        const newest = stats.filter(s => s.t >= since - 5000).sort((a, b) => b.t - a.t)[0];
        if (newest) report = await fs.readFile(path.join(crashReportsDir, newest.f), 'utf8');
    } catch {}
    let log = null;
    try {
        // An older latest.log belongs to an earlier session, so skip it.
        if ((await fs.stat(logsPath)).mtimeMs >= since - 5000) log = (await fs.readFile(logsPath, 'utf8')).split(/\r?\n/).slice(-4000).join('\n');
    } catch {}
    return { report, log, console: consoleLines.slice(-3000).join('\n') };
}

module.exports = { analyse, readSources };
