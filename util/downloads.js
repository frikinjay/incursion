// File transfers and the list of downloads the renderer shows, one bar per file.
//
// A download only fails when the server stops sending: no bytes for STALL_MS drops the connection and resumes from the
// last byte with a Range request, and it gives up after MAX_IDLE attempts in a row that got nothing. Files over
// SEGMENT_MIN are fetched as up to SEGMENTS ranges in parallel, since a congested CDN edge often throttles each
// connection rather than the whole client.
const fs = require('fs-extra');
const crypto = require('crypto');
const { request, HttpError } = require('./http');
const log = require('./log').scope('download');

const STALL_MS = 30000;
const HEADERS_MS = 30000;
const MAX_IDLE = 5;
const SEGMENT_MIN = 1024 * 1024;
const SEGMENTS = 4;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- tracker -------------------------------------------------------------------------------------------------------

let emit = () => {};
let seq = 0;
let timer = null;
const items = new Map();

function publish() {
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        const now = Date.now();
        for (const d of items.values()) {
            const dt = (now - d.sampledAt) / 1000;
            if (dt >= 0.5) {
                const rate = (d.received - d.sampledBytes) / dt;
                d.speed = d.speed == null ? rate : d.speed * 0.6 + rate * 0.4;
                d.sampledAt = now; d.sampledBytes = d.received;
            }
        }
        emit('downloads', { items: [...items.values()].map(({ id, name, host, received, total, speed, state, note, startedAt }) => ({ id, name, host, received, total, speed, state, note, startedAt })) });
    }, 200);
}

function track(name, url) {
    let host = '';
    try { host = new URL(url).host; } catch {}
    const d = { id: `d${++seq}`, name, host, received: 0, total: null, speed: null, state: 'running', note: '', startedAt: Date.now(), sampledAt: Date.now(), sampledBytes: 0 };
    items.set(d.id, d);
    publish();
    const end = (state, note) => {
        d.state = state; d.note = note || '';
        publish();
        setTimeout(() => { items.delete(d.id); publish(); }, state === 'error' ? 8000 : 2500);
    };
    return {
        progress(received, total) { if (received > d.received) d.note = ''; d.received = received; if (total) d.total = total; publish(); },
        note(text) { d.note = text; publish(); },
        done() {
            const secs = (Date.now() - d.startedAt) / 1000;
            log.info(`${name} from ${host}: ${mb(d.received)} in ${secs.toFixed(1)} s (${mb(d.received / Math.max(secs, 0.001))}/s)`);
            end('done');
        },
        fail(err) { log.warn(`${name} from ${host} failed after ${((Date.now() - d.startedAt) / 1000).toFixed(1)} s: ${err.message}`); end('error', err.message); }
    };
}

// For downloads made elsewhere (the game's own files) that still belong in the list.
function external(name, url) { return track(name, url); }

const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`;

// ---- transfer ------------------------------------------------------------------------------------------------------

class StallError extends Error {}
class NoRangeError extends Error {}
class StoppedError extends Error {}

function rangeStart(res) {
    const m = /bytes (\d+)-/.exec(res.headers.get('content-range') || '');
    return m ? Number(m[1]) : null;
}

async function open(url, from, to) {
    const headers = { Accept: '*/*', 'Accept-Encoding': 'identity' };
    if (from > 0 || to != null) headers.Range = `bytes=${from}-${to ?? ''}`;
    return request(url, { as: 'response', stream: true, timeout: HEADERS_MS, headers });
}

// Writes the response into fh at seg.pos until the body ends or the segment is full.
async function pump(res, seg, fh, onBytes, ctx) {
    const reader = res.body.getReader();
    try {
        for (;;) {
            let stall;
            const next = await Promise.race([
                reader.read(),
                new Promise((_, reject) => { stall = setTimeout(() => reject(new StallError(`no data for ${ctx.stallMs / 1000} s`)), ctx.stallMs); })
            ]).finally(() => clearTimeout(stall));
            if (next.done) return;
            if (ctx.stop) throw new StoppedError('stopped');
            let chunk = next.value;
            if (seg.end != null && seg.pos + chunk.length > seg.end + 1) chunk = chunk.subarray(0, seg.end + 1 - seg.pos);
            await fh.write(chunk, 0, chunk.length, seg.pos);
            seg.pos += chunk.length;
            onBytes();
            if (seg.end != null && seg.pos > seg.end) return;
        }
    } finally {
        reader.cancel().catch(() => {});
    }
}

async function runSegment(url, seg, fh, { res, ranges, onBytes, onRetry, ctx }) {
    let idle = 0;
    for (;;) {
        if (ctx.stop) { res?.body?.cancel().catch(() => {}); throw new StoppedError('stopped'); }
        const before = seg.pos;
        try {
            if (!res) {
                if (ranges) {
                    // Some redirectors refuse ranges their CDN accepts (edge.forgecdn.net answers 404), so any client
                    // error here means "do it in one piece" rather than a failed download.
                    res = await open(url, seg.pos, seg.end).catch((err) => {
                        throw err instanceof HttpError && err.status >= 400 && err.status < 500 ? new NoRangeError(`range request refused (HTTP ${err.status})`) : err;
                    });
                    if (res.status !== 206 || rangeStart(res) !== seg.pos) throw new NoRangeError('server ignored the range request');
                } else res = await open(url, 0, null);
            }
            await pump(res, seg, fh, onBytes, ctx);
            res = null;
            if (seg.end == null || seg.pos > seg.end) return;
            throw new Error('connection closed early');
        } catch (err) {
            if (res) res.body?.cancel().catch(() => {});
            res = null;
            if (err instanceof NoRangeError || err instanceof StoppedError) throw err;
            if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408) throw err;
            idle = seg.pos > before ? 0 : idle + 1;
            if (idle >= MAX_IDLE) throw err;
            if (!ranges) seg.pos = seg.start;   // can't resume, start this file again
            onRetry(err, idle);
            await sleep(Math.min(8000, 1000 * 2 ** idle));
        }
    }
}

// Downloads url into file (overwritten) and returns { sha1, size }. onProgress(received, total) may go down when a
// server without range support has to start again.
async function fetchFile(url, file, { onProgress = () => {}, onRetry = () => {}, stallMs = STALL_MS } = {}) {
    const first = await open(url, 0, null);
    // Ranges go straight to where the redirects ended up.
    const target = first.url || url;
    const len = Number(first.headers.get('content-length'));
    const total = first.status === 200 && Number.isFinite(len) && len > 0 ? len : null;
    const ranges = /bytes/i.test(first.headers.get('accept-ranges') || '') && total != null;
    const count = ranges && total >= SEGMENT_MIN ? Math.min(SEGMENTS, Math.ceil(total / SEGMENT_MIN)) : 1;

    const segs = [];
    if (count === 1) segs.push({ start: 0, pos: 0, end: total != null ? total - 1 : null });
    else {
        const size = Math.ceil(total / count);
        for (let i = 0; i < count; i++) segs.push({ start: i * size, pos: i * size, end: Math.min(total, (i + 1) * size) - 1 });
    }
    const received = () => segs.reduce((n, s) => n + (s.pos - s.start), 0);
    const onBytes = () => onProgress(received(), total);

    const fh = await fs.promises.open(file, 'w');
    try {
        // When one segment fails the rest stop too, and nothing touches the file until all of them have.
        const ctx = { stop: false, stallMs };
        const running = segs.map((seg, i) => runSegment(target, seg, fh, { res: i === 0 ? first : null, ranges, onBytes, onRetry, ctx }));
        try {
            await Promise.all(running);
        } catch (err) {
            ctx.stop = true;
            await Promise.allSettled(running);
            if (!(err instanceof NoRangeError)) throw err;
            // The CDN advertised ranges but didn't honour them: fall back to one plain stream.
            log.warn(`${new URL(target).host}: ${err.message}; downloading in one piece`);
            await fh.truncate(0);
            segs.length = 0;
            segs.push({ start: 0, pos: 0, end: total != null ? total - 1 : null });
            await runSegment(url, segs[0], fh, { res: null, ranges: false, onBytes, onRetry, ctx: { stop: false, stallMs } });
        }
        if (total != null && received() !== total) throw new Error(`Download incomplete (${received()} of ${total} bytes)`);
        await fh.truncate(received());
        await fh.sync();   // so a sudden shutdown can't leave a truncated file under the final name
    } finally {
        await fh.close();
    }
    const hash = crypto.createHash('sha1');
    await new Promise((resolve, reject) => fs.createReadStream(file).on('data', d => hash.update(d)).on('end', resolve).on('error', reject));
    return { sha1: hash.digest('hex'), size: received() };
}

module.exports = { fetchFile, track, external, setEmitter: (fn) => { emit = fn; }, STALL_MS };
