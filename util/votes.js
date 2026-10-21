// Votes carry only the content type and the two project ids. No pack, files, paths or account name. The account is
// checked through Mojang's own session check and stored as a one-way hash. Nothing is sent until the notice has been
// seen.
const fs = require('fs-extra');
const path = require('path');
const { request } = require('./http');

const MAX_QUEUE = 1000;
const MAX_AGE = 30 * 24 * 3600 * 1000;
const BATCH = 50;

let o = { userData: null, serviceUrl: () => null, account: async () => null, enabled: () => false, noticeSeen: () => false };
let queue = null;
let timer = null;
let sending = null;

const file = () => path.join(o.userData, 'link-votes.json');
const passFile = () => path.join(o.userData, 'link-vote-pass.json');

function init(opts) { o = { ...o, ...opts }; queue = null; }

async function load() {
    if (queue) return queue;
    const data = await require('./storage').readJsonSafe(file(), { votes: [] }).catch(() => ({ votes: [] }));
    queue = (Array.isArray(data.votes) ? data.votes : []).filter(v => v && Date.now() - (v.at || 0) < MAX_AGE);
    return queue;
}
const save = () => require('./storage').writeJsonAtomic(file(), { votes: queue }, { pretty: false });

// A newer vote on the same project replaces an unsent older one.
const keyOf = (v) => (v.op === 'link' ? `${v.type}|cf|${v.cf}` : `${v.type}|${v.side}|${v.id}`);

async function record(vote) {
    if (!o.enabled()) return;
    const q = await load();
    const v = { ...vote, at: Date.now() };
    const k = keyOf(v);
    const rest = q.filter(x => keyOf(x) !== k && !(v.op === 'link' && x.op !== 'link' && ((x.side === 'cf' && String(x.id) === String(v.cf)) || (x.side === 'mr' && x.id === v.mr))));
    rest.push(v);
    queue = rest.slice(-MAX_QUEUE);
    await save();
    schedule();
}

function schedule(ms = 8000) {
    clearTimeout(timer);
    timer = setTimeout(() => flush().catch(() => {}), ms);
}

async function clear() {
    clearTimeout(timer);
    queue = [];
    await fs.remove(file()).catch(() => {});
    await fs.remove(passFile()).catch(() => {});
}

// Mojang's session server confirms the account owns Minecraft (we "join" with a challenge from the service), then the
// service issues a 24-hour pass.
async function getPass(base, account, fresh) {
    if (!fresh) {
        const saved = await fs.readJson(passFile()).catch(() => null);
        if (saved?.pass && saved.expiresAt > Date.now() + 60000 && saved.uuid === account.uuid) return saved.pass;
    }
    const { challenge, serverId } = await request(`${base}/links/challenge`, { method: 'POST', body: {}, retries: 0 });
    await request('https://sessionserver.mojang.com/session/minecraft/join', {
        method: 'POST', as: 'response', retries: 0,
        body: { accessToken: account.accessToken, selectedProfile: String(account.uuid).replace(/-/g, ''), serverId }
    });
    const r = await request(`${base}/links/session`, { method: 'POST', body: { challenge, username: account.name }, retries: 0 });
    await require('./storage').writeJsonAtomic(passFile(), { pass: r.pass, expiresAt: r.expiresAt, uuid: account.uuid });
    return r.pass;
}

async function flush() {
    if (sending) return sending;
    sending = (async () => {
        // Yield first: an early return must not reach `finally` before `sending` is assigned.
        await null;
        try {
            if (!o.enabled()) return clear();
            if (!o.noticeSeen()) return;
            const q = await load();
            if (!q.length) return;
            const base = o.serviceUrl();
            if (!base) return;
            const account = await o.account().catch(() => null);
            if (!account?.accessToken || account.meta?.type !== 'msa') return;
            let pass = await getPass(base, account, false);
            while (queue.length) {
                const batch = queue.slice(0, BATCH);
                const votes = batch.map(({ at, ...v }) => v);
                try {
                    await request(`${base}/links/vote`, { method: 'POST', headers: { Authorization: `Bearer ${pass}` }, body: { votes }, retries: 0 });
                } catch (err) {
                    if (err.status === 401) { pass = await getPass(base, account, true); continue; }
                    if (err.status === 400) { queue = queue.slice(batch.length); await save(); continue; }
                    throw err;
                }
                queue = queue.slice(batch.length);
                await save();
            }
        } catch { schedule(15 * 60 * 1000); }   // offline, rate limited or a check failed: try again later
        finally { sending = null; }
    })();
    return sending;
}

const pending = async () => (await load()).length;

module.exports = { init, record, flush, clear, pending, schedule };
