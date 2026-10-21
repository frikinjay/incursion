(() => {
    const { h, call } = Lib;

    function details() {
        return h('div.share-details',
            h('div.share-col',
                h('div.t', 'Shared'),
                h('ul',
                    h('li', 'The two project ids you link (one CurseForge, one Modrinth), or that a project isn’t on the other platform'),
                    h('li', 'Whether it’s a mod, resource pack, shader or data pack'))),
            h('div.share-col',
                h('div.t', 'Never shared'),
                h('ul',
                    h('li', 'Your packs, their names, files or folders'),
                    h('li', 'Your Minecraft username, account id or IP address (the service keeps only a one-way code per account)'),
                    h('li', 'Your Microsoft or Minecraft login: it is only used with Mojang, the same way joining a server uses it'),
                    h('li', 'Links Incursion found by itself, or links that came with a pack'))));
    }

    let showing = false;
    async function notice() {
        if (showing) return;
        showing = true;
        const answer = await new Promise((resolve) => {
            let value = null;
            const keep = h('button.btn.primary', { on: { click: () => { value = true; d.close(); } } }, 'Keep Sharing');
            const d = UI.dialog({
                onClose: () => resolve(value),
                content: [
                    h('div.dialog-body',
                        h('h2', 'Share the Links You Make?'),
                        h('p', 'When you link a CurseForge project to its Modrinth twin, Incursion can add your link as an anonymous vote. Links most players agree on are reviewed and then shared with everyone, so mods match up better and searches need fewer requests.'),
                        details(),
                        h('p.hint', 'Only Microsoft accounts can vote; offline accounts never send anything. You can turn this off at any time in Settings → Community Links.')),
                    h('div.dialog-foot', h('button.btn', { on: { click: () => { value = false; d.close(); } } }, 'Turn Off Sharing'), keep)
                ]
            });
            setTimeout(() => keep.focus(), 50);
        });
        showing = false;
        // Closing the notice without choosing keeps sharing on and counts as seen.
        await App.setPrefs({ linksNoticeSeen: true, shareLinks: answer !== false }).catch(() => {});
        UI.Island.toast(answer === false ? 'Link Sharing Turned Off' : 'Sharing Your Links', answer === false ? 'Nothing was sent.' : 'Change this in Settings → Community Links.');
    }

    window.Sharing = { notice, details };
})();
