// First run: where Incursion keeps game files, Java and each pack's game folder.
(() => {
    const { h, icon, call, fmt } = Lib;

    const Setup = {
        open() {
            return new Promise((resolve) => {
                let chosen = null;
                let defaults = null;
                const pathEl = h('div.setup-path.mono.ellipsis');
                const note = h('p.hint.hidden');
                const reset = h('button.btn.sm.ghost.hidden', { on: { click: () => pick(null) } }, 'Use Default');
                const done = h('button.btn.primary', 'Continue');

                async function pick(dir) {
                    note.classList.add('hidden');
                    if (dir) {
                        try {
                            const info = await call('data:inspect', { dir });
                            if (info.exists && !info.empty && !info.incursion) {
                                note.textContent = `This folder already has ${fmt.plural(info.entries, 'item')} in it. Incursion adds its own folders next to them and never touches the rest.`;
                                note.classList.remove('hidden');
                            }
                        } catch (err) { UI.Island.error(err); return; }
                    }
                    chosen = dir;
                    pathEl.textContent = dir || defaults.defaultPath;
                    pathEl.title = pathEl.textContent;
                    reset.classList.toggle('hidden', !dir);
                }
                const browse = async () => {
                    const dir = await call('dialog:folder', { title: 'Choose Where Incursion Keeps Game Files' }).catch(UI.Island.error);
                    if (dir) pick(dir);
                };

                const d = UI.dialog({
                    onClose: () => call('app:setup-done').catch(() => {}).finally(resolve),
                    content: [
                        h('div.dialog-body.setup',
                            h('div.setup-hero', Lib.img('icon.svg', 'squircle'), h('div', h('h2', 'Welcome to Incursion'), h('p', 'Build one modpack for CurseForge and Modrinth, then play it.'))),
                            h('div.group-title', 'Game Files Folder'),
                            h('div.group',
                                h('div.cell.col', h('div.d', 'Minecraft versions, each pack’s game folder (worlds, configs, screenshots) and downloaded Java go here. It can take several gigabytes.')),
                                h('div.cell', icon('folder'), pathEl, reset, h('button.btn.sm', { on: { click: browse } }, 'Choose…'))),
                            note,
                            h('p.hint', 'You can move it later in Settings → Data.')),
                        h('div.dialog-foot', done)
                    ]
                });
                done.addEventListener('click', async () => {
                    done.disabled = true;
                    try {
                        if (chosen) await call('data:set-dir', { dir: chosen, move: false });
                        d.close();
                    } catch (err) { UI.Island.error(err); done.disabled = false; }
                });
                call('data:info').then(info => { defaults = info; pick(null); setTimeout(() => done.focus(), 50); }).catch(UI.Island.error);
            });
        }
    };
    window.Setup = Setup;
})();
