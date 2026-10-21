const storage = require('./storage');

const TICK = 15 * 60 * 1000;
let timer = null, running = false;

function start({ packs, launcher, getPrefs, emit }) {
    const run = async () => {
        if (running) return;
        running = true;
        try {
            const prefs = await getPrefs();
            const mode = prefs.autoUpdate || 'check';
            if (mode === 'off') return;
            const every = Math.max(1, Number(prefs.autoUpdateHours) || 24) * 3600 * 1000;
            for (const p of await packs.library()) {
                if (!p.available) continue;
                const pending = await storage.loadPending(p.path).catch(() => ({}));
                if (Date.now() - (pending?.checkedAt || 0) < every) continue;
                try {
                    const r = await packs.checkUpdates(p.path, { quiet: true });
                    if (mode === 'install' && r.count && !launcher.packBusy(p.path)) {
                        const a = await packs.applyUpdates(p.path);
                        if (a.updated) emit('notice', { kind: 'auto-updated', packPath: p.path, count: a.updated, failed: a.failed.length });
                    }
                } catch {}
            }
        } finally { running = false; }
    };
    clearInterval(timer);
    timer = setInterval(run, TICK);
    setTimeout(run, 60 * 1000);
    return { run };
}

module.exports = { start };
