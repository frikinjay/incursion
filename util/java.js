const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { request } = require('./http');
const cache = require('./cache');
const storage = require('./storage');

const isWin = process.platform === 'win32';
const exe = (name) => (isWin ? `${name}.exe` : name);
let managedRoot = null;

const DAY = 24 * 3600 * 1000;

const datadir = require('./datadir');
const sharedRoot = () => path.join(datadir.get(), 'java');

function init(userData) {
    managedRoot = process.env.INCURSION_JAVA_DIR || sharedRoot();
    const legacy = userData && path.join(userData, 'java');
    if (legacy && path.resolve(legacy) !== path.resolve(managedRoot)) migrateFrom(legacy).catch(() => {});
}

function refreshRoot() {
    if (!process.env.INCURSION_JAVA_DIR) managedRoot = sharedRoot();
    scanCache = null;
}

async function migrateFrom(legacy) {
    for (const dir of await childDirs(legacy)) {
        const dest = path.join(managedRoot, path.basename(dir));
        if (await fs.pathExists(dest)) continue;
        await fs.ensureDir(managedRoot);
        await fs.move(dir, dest).catch(() => fs.copy(dir, dest));
    }
    scanCache = null;
}

const launcherRuntimes = () => path.join(path.dirname(managedRoot), 'runtime');

async function requiredMajor(gameVersion) {
    try {
        return await cache.wrap(`java:required:${gameVersion}`, { ttl: 30 * DAY, stale: 365 * DAY }, async () => {
            const manifest = await cache.wrap('mojang:manifest', { ttl: DAY, stale: 30 * DAY }, () => request('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'));
            const entry = manifest.versions.find(v => v.id === gameVersion);
            if (!entry) throw new Error('unknown version');
            const json = await request(entry.url);
            return json.javaVersion?.majorVersion || 8;
        });
    } catch {
        const [a, b, c] = String(gameVersion).split('.').map(Number);
        if (a >= 26) return 25;
        if (a === 1 && (b > 20 || (b === 20 && (c || 0) >= 5))) return 21;
        if (a === 1 && b >= 18) return 17;
        if (a === 1 && b === 17) return 16;
        return 8;
    }
}

async function probe(home) {
    const bin = path.join(home, 'bin', exe('java'));
    if (!(await fs.pathExists(bin))) return null;
    let version = null, vendor = null, imageType = null;
    try {
        const rel = await fs.readFile(path.join(home, 'release'), 'utf8');
        version = rel.match(/^JAVA_VERSION="([^"]+)"/m)?.[1] || null;
        vendor = rel.match(/^IMPLEMENTOR="([^"]+)"/m)?.[1] || null;
        imageType = rel.match(/^IMAGE_TYPE="([^"]+)"/m)?.[1] || null;
    } catch {}
    if (!version) {
        version = await new Promise((resolve) => execFile(bin, ['-version'], { timeout: 8000, windowsHide: true }, (err, out, errOut) => {
            resolve((String(errOut) + String(out)).match(/version "([^"]+)"/)?.[1] || null);
        }));
    }
    if (!version) return null;
    const major = version.startsWith('1.') ? Number(version.split('.')[1]) : Number(version.split(/[.+-]/)[0]);
    const javaw = path.join(home, 'bin', exe('javaw'));
    return {
        home, version, major, vendor, imageType,
        path: isWin && (await fs.pathExists(javaw)) ? javaw : bin,
        managed: !!managedRoot && [managedRoot, launcherRuntimes()].some(r => path.resolve(home).toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep))
    };
}

async function childDirs(dir) {
    try { return (await fs.readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => path.join(dir, d.name)); }
    catch { return []; }
}

async function whichJava() {
    return new Promise((resolve) => execFile(isWin ? 'where' : 'which', ['-a', 'java'], { timeout: 5000, windowsHide: true }, (err, out) => {
        resolve(String(out || '').split(/\r?\n/).filter(Boolean).map(p => path.dirname(path.dirname(p))));
    }));
}

let scanCache = null;
async function detect({ force = false } = {}) {
    if (scanCache && !force && Date.now() - scanCache.at < 60000) return scanCache.list;
    const homes = new Set();
    const add = (h) => h && homes.add(path.resolve(h));
    add(process.env.JAVA_HOME);
    for (const h of await whichJava()) add(h);
    const roots = [];
    if (isWin) {
        for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean)) {
            for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'AdoptOpenJDK', 'Temurin']) roots.push(path.join(pf, vendor));
        }
    } else {
        roots.push('/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', '/opt');
    }
    roots.push(path.join(os.homedir(), '.jdks'), path.join(os.homedir(), '.sdkman', 'candidates', 'java'));
    if (managedRoot) roots.push(managedRoot, launcherRuntimes());
    for (const r of roots) for (const d of await childDirs(r)) {
        add(d);
        add(path.join(d, 'Contents', 'Home'));
        for (const inner of await childDirs(d)) add(inner);
    }
    const found = (await Promise.all([...homes].map(h => probe(h).catch(() => null)))).filter(Boolean);
    const seen = new Set();
    const list = found.filter(j => { const k = j.path.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => b.major - a.major || Number(b.managed) - Number(a.managed));
    scanCache = { at: Date.now(), list };
    return list;
}

async function install(major, onProgress = () => {}) {
    const existing = (await detect({ force: true })).find(j => j.managed && j.major === Number(major));
    if (existing) { onProgress(1); return existing; }
    const archMap = { x64: 'x64', arm64: 'aarch64', ia32: 'x32' };
    const osName = isWin ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    const arch = archMap[process.arch] || 'x64';
    let asset = null;
    for (const image of ['jre', 'jdk']) {
        const list = await request(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=${image}&os=${osName}&vendor=eclipse`);
        if (list.length) { asset = list[0]; break; }
    }
    if (!asset) throw new Error(`No Temurin ${major} build exists for this system.`);
    const pkg = asset.binary.package;
    const dest = path.join(managedRoot, `temurin-${major}`);
    const tmp = path.join(managedRoot, `.download-${major}-${Date.now()}`);
    const archive = path.join(tmp, pkg.name);
    await fs.ensureDir(tmp);
    try {
        let got = 0;
        // Adoptium publishes the archive's SHA-256, so verify after download.
        await storage.download(pkg.link, archive, { onBytes: (n) => { got += n; onProgress(Math.min(0.95, got / pkg.size)); } });
        const crypto = require('crypto');
        const hash = crypto.createHash('sha256');
        await new Promise((resolve, reject) => fs.createReadStream(archive).on('data', d => hash.update(d)).on('end', resolve).on('error', reject));
        if (pkg.checksum && hash.digest('hex') !== pkg.checksum) throw new Error('Java download failed its checksum. Try again.');
        const extractTo = path.join(tmp, 'x');
        await fs.ensureDir(extractTo);
        const tar = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
        await new Promise((resolve, reject) => execFile(tar, ['-xf', archive, '-C', extractTo], { windowsHide: true, timeout: 300000 }, (err) => (err ? reject(new Error(`Could not unpack Java: ${err.message}`)) : resolve())));
        const [inner] = await childDirs(extractTo);
        await fs.remove(dest);
        await fs.move(inner || extractTo, dest);
        onProgress(1);
    } finally {
        await fs.remove(tmp).catch(() => {});
    }
    scanCache = null;
    const probed = await probe(dest) || await probe(path.join(dest, 'Contents', 'Home'));
    if (!probed) throw new Error('Java was downloaded but could not be started.');
    return probed;
}

async function uninstall(major) {
    await fs.remove(path.join(managedRoot, `temurin-${major}`));
    scanCache = null;
}

async function resolveFor(gameVersion, preference = 'managed', { allowDownload = true, onProgress } = {}) {
    const major = await requiredMajor(gameVersion);
    if (preference && preference !== 'managed' && preference !== 'system') {
        const j = await probe(path.dirname(path.dirname(preference))) || null;
        if (!j) throw new Error(`The Java set for this pack no longer exists: ${preference}`);
        return { java: j, major };
    }
    const all = await detect();
    const exact = (j) => j.major === major;
    if (preference === 'system') {
        const j = all.find(x => exact(x) && !x.managed) || all.find(exact);
        if (j) return { java: j, major };
    } else {
        const j = all.find(x => exact(x) && x.managed);
        if (j) return { java: j, major };
    }
    if (!allowDownload) return { missing: major };
    return { java: await install(major, onProgress), major };
}

module.exports = { init, refreshRoot, requiredMajor, detect, install, uninstall, resolveFor, probe, managedDir: () => managedRoot };
