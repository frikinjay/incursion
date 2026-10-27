// Runs a launch in a utility process so EML's file checks, downloads and installers never block the main process.
const path = require('path');
const port = process.parentPort;

const FORWARD = ['launch_compute_download', 'launch_download', 'launch_install_loader', 'launch_check_java', 'launch_launch',
    'launch_debug', 'launch_close', 'download_error', 'launch_crash'];

// Batch game output: modded startups print thousands of lines a second.
let lines = [], lineTimer = null;
const flushLines = () => { clearTimeout(lineTimer); lineTimer = null; if (lines.length) { port.postMessage({ type: 'lines', lines }); lines = []; } };

let lastProgress = 0;

const plain = (v) => { try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return String(v); } };

port.on('message', async ({ data: msg }) => {
    if (msg?.type !== 'launch') return;
    try {
        const { Launcher } = (await import('eml-lib')).default;
        const lib = new Launcher(msg.config);
        lib.config.root = msg.root;   // EML only knows %APPDATA%/.<name>, but our folder can live anywhere
        // EML starts Java in the shared root, so latest.log, crash dumps and configs from mods that write relative to the
        // working directory pile up there. Run in the pack's game folder like the vanilla launcher, with the log4j config
        // (a path relative to the root) made absolute.
        const run = lib.run.bind(lib);
        lib.run = (javaPath, args) => {
            const gameDir = path.join(msg.root, msg.config.profile.slug);
            const LOG4J = '-Dlog4j.configurationFile=';
            const fixed = args.map(a => (a.startsWith(LOG4J) && !path.isAbsolute(a.slice(LOG4J.length)) ? LOG4J + path.join(msg.root, a.slice(LOG4J.length)) : a));
            fixed.unshift(`-XX:ErrorFile=${path.join(gameDir, 'logs', 'hs_err_pid%p.log')}`);
            lib.config.root = gameDir;
            return run(javaPath, fixed);
        };
        for (const name of FORWARD) lib.on(name, (data) => { flushLines(); port.postMessage({ type: 'event', name, data: plain(data) }); });
        lib.on('launch_data', (line) => { lines.push(String(line)); if (!lineTimer) lineTimer = setTimeout(flushLines, 50); });
        lib.on('download_progress', (data) => {
            const now = Date.now();
            if (now - lastProgress < 250) return;
            lastProgress = now;
            port.postMessage({ type: 'event', name: 'download_progress', data: plain(data) });
        });
        await lib.launch();
        flushLines();
        port.postMessage({ type: 'done' });
    } catch (err) {
        flushLines();
        port.postMessage({ type: 'error', message: err?.message || String(err), code: err?.code || null });
    }
});
