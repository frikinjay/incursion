const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { request } = require('./http');
const storage = require('./storage');
const { loaderInfo } = require('./loaders');

const MR = 'https://api.modrinth.com/v2';
const CF_UPLOAD = 'https://minecraft.curseforge.com/api';

async function check({ meta, tokens }) {
    const out = { modrinth: null, curseforge: null };
    const p = meta.publish || {};
    if (p.modrinthProjectId) {
        try {
            if (!tokens.modrinth) throw new Error('Add a Modrinth token with the "Create versions" scope.');
            const project = await request(`${MR}/project/${encodeURIComponent(p.modrinthProjectId)}`, { headers: { Authorization: tokens.modrinth } });
            if (project.project_type !== 'modpack') throw new Error(`“${project.title}” is a ${project.project_type}, not a modpack project.`);
            const [me, members] = await Promise.all([
                request(`${MR}/user`, { headers: { Authorization: tokens.modrinth } }).catch(() => null),
                request(`${MR}/project/${project.id}/members`, { headers: { Authorization: tokens.modrinth } })
            ]);
            if (me && !members.some(m => m.user?.id === me.id)) throw new Error(`You are not a member of “${project.title}”.`);
            out.modrinth = { ok: true, title: project.title, id: project.id, url: `https://modrinth.com/modpack/${project.slug}` };
        } catch (err) { out.modrinth = { ok: false, message: err.status === 404 ? 'Project not found' : err.message }; }
    }
    if (p.curseforgeProjectId) {
        try {
            if (!tokens.curseforgeUpload) throw new Error('Add a CurseForge upload token (curseforge.com → Account → API tokens).');
            const ids = await cfGameVersionIds(meta.gameVersion, tokens.curseforgeUpload);
            if (!ids.length) throw new Error(`CurseForge doesn't list Minecraft ${meta.gameVersion} yet.`);
            out.curseforge = { ok: true, id: Number(p.curseforgeProjectId), url: `https://www.curseforge.com/projects/${p.curseforgeProjectId}` };
        } catch (err) { out.curseforge = { ok: false, message: err.status === 401 || err.status === 403 ? 'Upload token rejected' : err.message }; }
    }
    return out;
}

async function cfGameVersionIds(gameVersion, token) {
    const headers = { 'X-Api-Token': token };
    const [types, versions] = await Promise.all([
        request(`${CF_UPLOAD}/game/version-types`, { headers }),
        request(`${CF_UPLOAD}/game/versions`, { headers })
    ]);
    const mcTypes = new Set(types.filter(t => /^minecraft-\d/.test(t.slug)).map(t => t.id));
    return versions.filter(v => mcTypes.has(v.gameVersionTypeID) && v.name === gameVersion).map(v => v.id);
}

async function uploadServerPack({ meta, tokens, targets, release, ids, sidedness = 'scan', dryRun = false, tmp }, onProgress = () => {}) {
    const results = {};
    const exported = await storage.exportServer({ ...meta, version: release.version }, tmp, () => {}, { sidedness });
    const file = exported.path;
    const size = (await fs.stat(file)).size;
    const summary = { file: path.basename(file), size, count: exported.count, excluded: exported.excluded, sidedness };
    for (const target of targets) {
        onProgress(target, 0.7);
        if (target === 'modrinth') {
            const versionId = ids?.modrinth;
            if (!versionId && !dryRun) throw new Error(`Version ${release.version} has no Modrinth upload to attach the server pack to.`);
            if (dryRun) { results.modrinth = { dryRun: true, ...summary, to: versionId || '(the new version)' }; continue; }
            const form = new FormData();
            form.append('data', JSON.stringify({}));
            form.append('server', new Blob([await fs.readFile(file)], { type: 'application/zip' }), path.basename(file));
            await request(`${MR}/version/${encodeURIComponent(versionId)}/file`, { method: 'POST', headers: { Authorization: tokens.modrinth }, body: form, timeout: 300000, retries: 0 });
            results.modrinth = { ok: true, versionId, file: path.basename(file) };
        } else if (target === 'curseforge') {
            const parent = Number(ids?.curseforge);
            if (!parent && !dryRun) throw new Error(`Version ${release.version} has no CurseForge upload to attach the server pack to.`);
            const metadata = { changelog: release.changelog || '', changelogType: 'markdown', displayName: `${meta.name} ${release.version} Server Pack`, parentFileID: parent || 0, releaseType: release.versionType || 'release' };
            if (dryRun) { results.curseforge = { dryRun: true, ...summary, metadata }; continue; }
            const form = new FormData();
            form.append('metadata', JSON.stringify(metadata));
            form.append('file', new Blob([await fs.readFile(file)], { type: 'application/zip' }), path.basename(file));
            const r = await request(`${CF_UPLOAD}/projects/${Number(meta.publish.curseforgeProjectId)}/upload-file`, { method: 'POST', headers: { 'X-Api-Token': tokens.curseforgeUpload }, body: form, timeout: 300000, retries: 0 });
            results.curseforge = { ok: true, fileId: r.id, parentFileId: parent, file: path.basename(file) };
        }
    }
    return results;
}

async function publishServerPack({ meta, tokens, targets, release, ids, sidedness, dryRun = false }, onProgress = () => {}) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'incursion-publish-'));
    try { return await uploadServerPack({ meta, tokens, targets, release, ids, sidedness, dryRun, tmp }, onProgress); }
    finally { await fs.remove(tmp).catch(() => {}); }
}

async function publish({ meta, tokens, targets, release, serverPack = null, dryRun = false }, onProgress = () => {}) {
    const l = loaderInfo(meta.loader);
    const p = meta.publish || {};
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'incursion-publish-'));
    const results = {};
    try {
        const name = `${meta.name} ${release.version}`;
        for (const target of targets) {
            onProgress(target, 0.1);
            if (target === 'modrinth') {
                if (!p.modrinthProjectId) throw new Error('Set the Modrinth project in the publish settings.');
                const { path: file, bundled } = await storage.exportModrinth({ ...meta, version: release.version }, tmp);
                const data = {
                    project_id: p.modrinthProjectId, name, version_number: release.version, changelog: release.changelog,
                    dependencies: [], game_versions: [meta.gameVersion], version_type: release.versionType || 'release',
                    loaders: [l.mr], featured: true, status: 'listed', file_parts: ['pack'], primary_file: 'pack'
                };
                if (dryRun) { results.modrinth = { dryRun: true, data, file: path.basename(file), size: (await fs.stat(file)).size, bundled }; }
                else {
                    const form = new FormData();
                    form.append('data', JSON.stringify(data));
                    form.append('pack', new Blob([await fs.readFile(file)], { type: 'application/x-modrinth-modpack+zip' }), path.basename(file));
                    onProgress(target, 0.5);
                    const v = await request(`${MR}/version`, { method: 'POST', headers: { Authorization: tokens.modrinth }, body: form, timeout: 300000, retries: 0 });
                    results.modrinth = { ok: true, id: v.id, url: `https://modrinth.com/modpack/${p.modrinthProjectId}/version/${v.id}` };
                }
            } else if (target === 'curseforge') {
                if (!p.curseforgeProjectId) throw new Error('Set the CurseForge project in the publish settings.');
                const gameVersions = await cfGameVersionIds(meta.gameVersion, tokens.curseforgeUpload);
                if (!gameVersions.length) throw new Error(`CurseForge doesn't list Minecraft ${meta.gameVersion}.`);
                const { path: file, bundled } = await storage.exportCurseForge({ ...meta, version: release.version }, tmp);
                const metadata = { changelog: release.changelog, changelogType: 'markdown', displayName: name, gameVersions, releaseType: release.versionType || 'release' };
                if (dryRun) { results.curseforge = { dryRun: true, metadata, file: path.basename(file), size: (await fs.stat(file)).size, bundled }; }
                else {
                    const form = new FormData();
                    form.append('metadata', JSON.stringify(metadata));
                    form.append('file', new Blob([await fs.readFile(file)], { type: 'application/zip' }), path.basename(file));
                    onProgress(target, 0.5);
                    const r = await request(`${CF_UPLOAD}/projects/${Number(p.curseforgeProjectId)}/upload-file`, { method: 'POST', headers: { 'X-Api-Token': tokens.curseforgeUpload }, body: form, timeout: 300000, retries: 0 });
                    results.curseforge = { ok: true, id: r.id, url: `https://www.curseforge.com/projects/${p.curseforgeProjectId}` };
                }
            }
            if (serverPack) {
                const ids = { modrinth: results.modrinth?.id, curseforge: results.curseforge?.id };
                // Don't lose the version that was just published: report the failure, and the server pack can be
                // retried from Releases.
                try {
                    const sp = await uploadServerPack({ meta, tokens, targets: [target], release, ids, sidedness: serverPack.sidedness, dryRun, tmp }, onProgress);
                    results[target].serverPack = sp[target];
                } catch (err) { results[target].serverPack = { ok: false, error: err.message }; }
            }
            onProgress(target, 1);
        }
        return results;
    } finally {
        await fs.remove(tmp).catch(() => {});
    }
}

module.exports = { check, publish, publishServerPack };
