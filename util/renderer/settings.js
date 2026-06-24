window.SettingsManager = {
    init: () => {
        document.getElementById('showApiKeysBtn').addEventListener('click', async () => {
            const keys = await window.api.getApiKeys();
            document.getElementById('cfKeyInput').value = keys.curseforge || '';
            document.getElementById('mrKeyInput').value = keys.modrinth || '';
            UI.switchView('apiKeys', AppViews);
        });

        document.getElementById('saveApiKeysBtn').addEventListener('click', async () => {
            const btn = document.getElementById('saveApiKeysBtn');
            btn.innerText = 'Saving...';
            btn.disabled = true;

            const cf = document.getElementById('cfKeyInput').value.trim();
            const mr = document.getElementById('mrKeyInput').value.trim();
            
            const res = await window.api.saveApiKeys({ curseforge: cf, modrinth: mr });
            
            if (res.success) {
                btn.innerText = 'Saved!';
                setTimeout(() => { btn.innerText = 'Save API Keys'; btn.disabled = false; }, 2000);
            } else {
                UI.showError("Failed to save API keys.");
                btn.innerText = 'Save API Keys';
                btn.disabled = false;
            }
        });
    }
};