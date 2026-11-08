// The thread viewer: a snapshot of a running game's threads from its agent (agent/src), compared with the previous one
// to tell which threads are stuck, and in which mod.
const fs = require('fs-extra');
const net = require('net');
const path = require('path');

// The game's own loops. When one of these stops moving, the player sees a freeze.
const MAIN_THREADS = /^(Render thread|Client thread|Server thread|main)$/;
// The viewer's own thread inside the game: not worth showing.
const OWN_THREAD = 'Incursion Thread Viewer';
// Mixin names handlers it merges into Minecraft's classes like handler$zza000$modid$method, so the mod id shows up in
// frames that otherwise look like vanilla code.
const MIXIN_HANDLER = /^(?:handler|redirect|modify|localvar|wrapOperation|wrapMethod|constant|inject)\$[a-z0-9]+\$([a-z][a-z0-9_.-]*)\$/i;

const BUSY_AFTER = 5000;
const STUCK_AFTER = 10000;
const BLOCKED_AFTER = 3000;
const FRAMES_SENT = 30;

// The agent binds 127.0.0.1; an older build of it could end up on ::1, so that's tried as well.
async function sample(agentDir, timeout = 8000) {
    const raw = await fs.readFile(path.join(agentDir, 'threads.port'), 'utf8').catch(() => {
        throw Object.assign(new Error('The thread viewer isn’t running in this game. Start the game again to use it.'), { code: 'NO_AGENT' });
    });
    try { return await ask(raw, '127.0.0.1', timeout); }
    catch (err) { if (err.code !== 'ECONNREFUSED') throw err; }
    return ask(raw, '::1', timeout).catch((err) => { throw err.code === 'ECONNREFUSED' ? new Error('The game isn’t answering. It may have closed.') : err; });
}

function ask(raw, host, timeout) {
    return new Promise((resolve, reject) => {
        const [port, token] = raw.trim().split(/\s+/);
        const chunks = [];
        const s = net.connect(Number(port), host, () => s.write(`${token}\n`));
        s.setTimeout(timeout, () => s.destroy(new Error('The game didn’t answer in time. It may be too busy right now.')));
        s.on('data', (c) => chunks.push(c));
        s.on('error', reject);
        s.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(new Error('The game sent an answer that couldn’t be read.')); }
        });
    });
}

// Jar file names and mod ids to the pack's items, for naming the mod a frame belongs to.
function modIndex(meta) {
    const jars = new Map(), ids = new Map();
    for (const m of meta?.mods || []) {
        const item = { key: String(m.ids?.curseforge || m.ids?.modrinth || m.ids?.local), title: m.names?.curseforge || m.names?.modrinth || 'Unknown mod' };
        for (const f of Object.values(m.installedFiles || {})) if (f) jars.set(f.toLowerCase().replace(/\.disabled$/, ''), item);
        for (const id of m.contents?.ids || []) if (id?.id && !/\$\{/.test(id.id)) ids.set(id.id.toLowerCase(), item);
    }
    return { jars, ids };
}

function modOf(frame, index) {
    if (frame.j) {
        const hit = index.jars.get(frame.j.toLowerCase());
        if (hit) return { ...hit, via: 'jar' };
    }
    const mixin = MIXIN_HANDLER.exec(frame.m || '');
    if (mixin) {
        const hit = index.ids.get(mixin[1].toLowerCase());
        return hit ? { ...hit, via: 'mixin' } : { key: null, title: mixin[1], via: 'mixin' };
    }
    return null;
}

const signature = (t) => (t.stack || []).slice(0, 8).map(f => `${f.c}.${f.m}:${f.l}`).join('|');
const seconds = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.round(ms / 1000)} s`);

// history: { time, threads: Map(id -> { sig, since, cpu }) } from the previous call, or null. Returns the readable view
// and the history for the next call.
function analyse(snap, history, meta) {
    const index = modIndex(meta);
    const prev = history?.threads || new Map();
    const dt = history ? snap.time - history.time : 0;
    const next = new Map();
    const threads = snap.threads.filter(t => t.name !== OWN_THREAD).map((t) => {
        const sig = signature(t);
        const was = prev.get(t.id);
        const since = was && was.sig === sig ? was.since : snap.time;
        const cpuPct = was && dt > 0 && t.cpu >= 0 && was.cpu >= 0 ? Math.max(0, Math.min(100, ((t.cpu - was.cpu) / 1e6 / dt) * 100)) : null;
        next.set(t.id, { sig, since, cpu: t.cpu });
        const sameFor = snap.time - since;
        const main = MAIN_THREADS.test(t.name);
        const stack = (t.stack || []).slice(0, FRAMES_SENT).map(f => ({ ...f, mod: modOf(f, index) }));
        const culprit = stack.find(f => f.mod)?.mod || null;

        let status = 'running', level = 'ok', label = 'Running';
        if (t.deadlocked) { status = 'deadlock'; level = 'bad'; label = `Deadlocked with ${t.lockOwner || 'another thread'}`; }
        else if (t.state === 'BLOCKED' && sameFor >= BLOCKED_AFTER) { status = 'blocked'; level = main ? 'bad' : 'warn'; label = `Waiting ${seconds(sameFor)} for ${t.lockOwner || 'a lock'}`; }
        else if (t.state === 'RUNNABLE' && !t.inNative && cpuPct != null && cpuPct > 60 && sameFor >= BUSY_AFTER) { status = 'busy'; level = main ? 'bad' : 'warn'; label = `Stuck in a loop for ${seconds(sameFor)}`; }
        else if (t.state === 'RUNNABLE' && sameFor >= STUCK_AFTER && (cpuPct == null || cpuPct < 5) && main) { status = 'stuck'; level = 'bad'; label = `Not responding for ${seconds(sameFor)}`; }
        else if (t.state === 'WAITING' || t.state === 'TIMED_WAITING') { status = 'idle'; label = 'Waiting'; }
        else if (t.state === 'BLOCKED') { status = 'idle'; label = 'Waiting for a lock'; }
        // The main loops sit waiting between frames and ticks; only a long unchanged wait is worth a mention.
        if (main && status === 'idle' && t.state === 'WAITING' && sameFor >= STUCK_AFTER * 3 && /^(Render thread|Client thread)$/.test(t.name)) { status = 'stuck'; level = 'warn'; label = `Waiting for ${seconds(sameFor)}`; }

        return {
            id: t.id, name: t.name, state: t.state, status, level, label, main, cpuPct: cpuPct == null ? null : Math.round(cpuPct),
            sameFor, culprit, lockOwner: t.lockOwner || null, lockOwnerId: t.lockOwnerId ?? null, inNative: !!t.inNative, depth: t.depth, stack
        };
    });

    const rank = { bad: 0, warn: 1, ok: 2 };
    threads.sort((a, b) => rank[a.level] - rank[b.level] || (b.main - a.main) || ((b.cpuPct || 0) - (a.cpuPct || 0)) || a.name.localeCompare(b.name));

    const problems = threads.filter(t => t.level !== 'ok');
    const frozen = problems.find(t => t.main && t.level === 'bad');
    const dead = problems.filter(t => t.status === 'deadlock');
    const where = (t) => (t.culprit ? ` in ${t.culprit.title}` : '');
    let summary;
    if (dead.length) summary = { level: 'bad', text: `${dead.map(t => t.name).join(' and ')} are deadlocked: each waits for the other${where(dead[0])}.` };
    else if (frozen) summary = { level: 'bad', text: `The game looks frozen: ${frozen.name} ${frozen.label.charAt(0).toLowerCase()}${frozen.label.slice(1)}${where(frozen)}.` };
    else if (problems.length) summary = { level: 'warn', text: `${problems.length === 1 ? `${problems[0].name} looks stuck` : `${problems.length} threads look stuck`}${where(problems[0])}. The game itself is still responding.` };
    else summary = { level: 'ok', text: history ? 'Everything is running normally.' : 'Looking at the threads… stuck threads show up after a few seconds.' };

    return {
        view: { time: snap.time, uptime: snap.uptime, heap: { used: snap.heapUsed, max: snap.heapMax }, summary, threads },
        history: { time: snap.time, threads: next }
    };
}

module.exports = { sample, analyse, modIndex, modOf };
