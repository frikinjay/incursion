const content = require('./content');

const MODES = ['scan', 'modrinth', 'curseforge'];

function decide(m, mode = 'scan') {
    if (m.side === 'client') return { server: false, reason: 'Set to client only in this pack' };
    if (m.side === 'server' || m.side === 'both') return { server: true, reason: 'Set to run on the server in this pack' };
    const t = content.typeOf(m);
    if (t.clientOnly) return { server: false, reason: `${t.label} are client-side` };
    const mr = m.environments?.modrinth, cf = m.environments?.curseforge;
    if (mode === 'modrinth') {
        if (!mr) return { server: true, reason: 'No Modrinth side information; kept' };
        return mr.server ? { server: true, reason: 'Modrinth: runs on servers' } : { server: false, reason: 'Modrinth: client only' };
    }
    if (mode === 'curseforge') {
        if (!cf) return { server: true, reason: 'No CurseForge side information; kept' };
        return cf.server ? { server: true, reason: 'CurseForge: runs on servers' } : { server: false, reason: 'CurseForge: client only' };
    }
    // Mod's own declarations first, then code analysis, then the platforms when they agree.
    const side = m.contents?.side;
    if (side?.declared === 'client') return { server: false, reason: 'The mod declares itself client-only' };
    if (side?.serverCrash) return { server: false, reason: `Would crash a server: ${side.serverCrash.charAt(0).toLowerCase()}${side.serverCrash.slice(1)}` };
    if (side?.clientDeps) return { server: false, reason: 'Every dependency it declares is client-side (a client mod)' };
    if (side?.declared === 'server') return { server: true, reason: 'The mod declares itself server-side' };
    if (mr && cf && !mr.server && !cf.server) return { server: false, reason: 'Modrinth and CurseForge both mark it client only' };
    if (mr && !cf && !mr.server) return { server: false, reason: 'Modrinth marks it client only (not on CurseForge)' };
    if (cf && !mr && !cf.server) return { server: false, reason: 'CurseForge marks it client only (not on Modrinth)' };
    return { server: true, reason: 'No sign it is client-only' };
}

function split(mods, mode = 'scan') {
    const included = [], excluded = [];
    for (const m of mods) { const d = decide(m, mode); (d.server ? included : excluded).push({ m, reason: d.reason }); }
    return { included, excluded };
}

module.exports = { MODES, decide, split };
