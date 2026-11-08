// The build settings live in package.json under "build". This only adds the Electron checksums that ship inside the
// installed electron package, so each build checks the Electron zip against those instead of downloading
// SHASUMS256.txt from GitHub every time. With the zip in the cache, building needs no GitHub download at all.
const { build } = require('./package.json');
const checksums = require('electron/checksums.json');

module.exports = { ...build, electronDownload: { ...(build.electronDownload || {}), mirrorOptions: build.electronDownload?.mirrorOptions || {}, checksums } };
