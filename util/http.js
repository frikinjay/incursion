// One limiter per upstream, so a slow CurseForge never starves Modrinth and neither bursts past its quota.
const { version } = require('../package.json');

const USER_AGENT = `Incursion/${version} (github.com/incursion-modpacks; modpack manager)`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = require('./log').scope('http');
const RETRY = Symbol('retry');

class HttpError extends Error {
    constructor(status, url, body) {
        super(`HTTP ${status} for ${new URL(url).host}${new URL(url).pathname}`);
        this.status = status;
        this.body = body;
    }
}

class Limiter {
    constructor({ name, concurrency, perMinute }) {
        this.name = name;
        this.concurrency = concurrency;
        this.capacity = perMinute || Infinity;
        this.tokens = this.capacity;
        this.refillPerMs = perMinute ? perMinute / 60000 : 0;
        this.lastRefill = Date.now();
        this.active = 0;
        this.queue = [];
        this.pausedUntil = 0;
        this.stats = { requests: 0, retries: 0, throttled: 0 };
    }

    _refill() {
        if (this.capacity === Infinity) return;
        const now = Date.now();
        this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
        this.lastRefill = now;
    }

    // Trust the server's remaining budget (Modrinth X-Ratelimit-*) over our own estimate.
    observe(headers) {
        const remaining = Number(headers.get('x-ratelimit-remaining'));
        const reset = Number(headers.get('x-ratelimit-reset'));
        if (this.capacity !== Infinity && Number.isFinite(remaining) && headers.has('x-ratelimit-remaining')) {
            this._refill();
            this.tokens = Math.min(this.tokens, remaining);
            if (remaining <= 2 && reset > 0) this.pauseFor(reset * 1000);
        }
    }

    pauseFor(ms) {
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
        this.stats.throttled++;
    }

    schedule(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this._pump();
        });
    }

    _pump() {
        if (this._timer) return;
        while (this.queue.length && this.active < this.concurrency) {
            const now = Date.now();
            if (now < this.pausedUntil) return this._wake(this.pausedUntil - now);
            this._refill();
            if (this.tokens < 1) return this._wake(Math.ceil((1 - this.tokens) / this.refillPerMs));
            this.tokens -= 1;
            const job = this.queue.shift();
            this.active++;
            this.stats.requests++;
            Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => {
                this.active--;
                this._pump();
            });
        }
    }

    _wake(ms) {
        const delay = Number.isFinite(ms) ? Math.min(Math.max(10, ms), 60000) : 1000;
        this._timer = setTimeout(() => { this._timer = null; this._pump(); }, delay);
    }
}

const limiters = {
    modrinth: new Limiter({ name: 'modrinth', concurrency: 6, perMinute: 240 }),   // hard limit is 300/min/IP
    curseforge: new Limiter({ name: 'curseforge', concurrency: 4, perMinute: 180 }),
    maven: new Limiter({ name: 'maven', concurrency: 2, perMinute: 60 }),
    // File CDNs have no API quota, so each gets its own lane.
    cdnModrinth: new Limiter({ name: 'cdn-modrinth', concurrency: 8 }),
    cdnCurseForge: new Limiter({ name: 'cdn-curseforge', concurrency: 8 }),
    cdn: new Limiter({ name: 'cdn', concurrency: 4 })
};

// The CF service is really the CurseForge API, so it shares that limiter.
const curseforgeAliases = new Set();
function limiterFor(url) {
    const host = new URL(url).host;
    if (curseforgeAliases.has(host)) return limiters.curseforge;
    if (host.endsWith('modrinth.com')) return host.startsWith('cdn.') ? limiters.cdnModrinth : limiters.modrinth;
    if (host === 'api.curseforge.com' || host === 'minecraft.curseforge.com') return limiters.curseforge;
    if (host.includes('forgecdn') || host.includes('curseforge')) return limiters.cdnCurseForge;
    if (host.includes('maven') || host.includes('meta.')) return limiters.maven;
    return limiters.cdn;
}

async function request(url, { method = 'GET', headers = {}, body, as = 'json', timeout = 20000, retries = 3, stream = false } = {}) {
    const limiter = limiterFor(url);
    const init = {
        method,
        headers: { 'User-Agent': USER_AGENT, Accept: as === 'text' || as === 'buffer' ? '*/*' : 'application/json', ...headers },
        body: body === undefined ? undefined : (typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body))
    };
    // FormData sets its own multipart boundary.
    if (body !== undefined && !(body instanceof FormData) && !init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
        let res;
        // With stream the timeout covers only the headers: the body can take as long as it takes, and the caller watches
        // it for stalls. A plain 'response' keeps the timeout running over its body.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeout);
        timer.unref?.();
        try {
            res = await limiter.schedule(() => fetch(url, { ...init, signal: ctrl.signal }));
            if (stream) clearTimeout(timer);
        } catch (err) {
            clearTimeout(timer);
            if (attempt >= retries) { log.warn(`${method} ${new URL(url).host}${new URL(url).pathname} failed: ${err.cause?.code || err.message}`); throw new Error(`Network error reaching ${new URL(url).host}: ${err.cause?.code || err.message}`); }
            log.debug(`${method} ${new URL(url).host}: ${err.cause?.code || err.message}; retry ${attempt + 1}`);
            limiter.stats.retries++;
            await sleep(500 * 2 ** attempt);
            continue;
        }
        try {
            const out = await handleResponse(res, attempt);
            if (out !== RETRY) return out;
        } finally { if (as !== 'response' || stream) clearTimeout(timer); }
    }

    async function handleResponse(res, attempt) {
        limiter.observe(res.headers);

        if (res.status === 429 || res.status >= 500) {
            if (attempt >= retries) { log.warn(`${method} ${new URL(url).host}${new URL(url).pathname}: HTTP ${res.status} after ${attempt + 1} tries`); throw new HttpError(res.status, url, await res.text().catch(() => '')); }
            const retryAfter = Number(res.headers.get('retry-after'));
            const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
            if (res.status === 429) limiter.pauseFor(wait);
            limiter.stats.retries++;
            await res.body?.cancel().catch(() => {});
            log.debug(`${method} ${new URL(url).host}: HTTP ${res.status}; retry in ${wait} ms`);
            await sleep(wait);
            return RETRY;
        }
        if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
        if (as === 'response') return res;
        if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
        return as === 'text' ? res.text() : res.json();
    }
}

const aliasCurseForge = (url) => { try { curseforgeAliases.add(new URL(url).host); } catch {} };

module.exports = { request, limiters, Limiter, HttpError, USER_AGENT, aliasCurseForge };
