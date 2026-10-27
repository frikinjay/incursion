// One rolling log for the main process at <userData>/logs/incursion.log. When it passes 5 MB it becomes .1 and the
// older ones shift down, keeping three. Lines written before init() are buffered so startup isn't lost.
const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX = 5 * 1024 * 1024;
const KEEP = 3;
const NAME = 'incursion.log';

let dir = null, stream = null, size = 0;
let early = [];

// Tokens and keys can end up in error messages and URLs, so mask anything that looks like one.
const SECRET = /\b(access_?token|refresh_?token|token|api[_-]?key|x-api-key|secret|password|authorization)(["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s"',}&]+/gi;

function format(a) {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    return util.inspect(a, { depth: 4, breakLength: Infinity });
}

function open() {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, NAME);
    try { size = fs.statSync(file).size; } catch { size = 0; }
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => { stream = null; });
}

function rotate() {
    stream?.end();
    stream = null;
    const file = path.join(dir, NAME);
    try {
        fs.rmSync(`${file}.${KEEP}`, { force: true });
        for (let i = KEEP - 1; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        fs.renameSync(file, `${file}.1`);
    } catch {}
    open();
}

function write(level, scope, args) {
    const text = args.map(format).join(' ').replace(SECRET, '$1$2***');
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}\n`;
    if (!dir) { early.push(line); if (early.length > 1000) early.shift(); return; }
    if (!stream) return;
    stream.write(line);
    size += Buffer.byteLength(line);
    if (size > MAX) rotate();
}

function scope(name) {
    return {
        debug: (...a) => write('debug', name, a),
        info: (...a) => write('info', name, a),
        warn: (...a) => write('warn', name, a),
        error: (...a) => write('error', name, a)
    };
}

// Console output from our code and from libraries goes to the file too, and still reaches the terminal.
function captureConsole() {
    for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
        const original = console[method].bind(console);
        console[method] = (...a) => { write(level, 'console', a); try { original(...a); } catch {} };
    }
}

function init(logDir) {
    if (dir) return;
    dir = logDir;
    try { open(); } catch { return; }
    if (size > MAX) rotate();
    for (const line of early) { stream?.write(line); size += Buffer.byteLength(line); }
    early = [];
    captureConsole();
}

module.exports = { init, scope, dir: () => dir, file: () => (dir ? path.join(dir, NAME) : null) };
