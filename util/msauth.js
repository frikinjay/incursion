// EML's sign-in window wipes live.com cookies every time. This one keeps a persistent session, so "Stay signed in",
// the account picker and passkeys work.
const { BrowserWindow, session } = require('electron');

const CLIENT_ID = '00000000402b5328';
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
const PARTITION = 'persist:microsoft-login';

function loginSession() {
    const ses = session.fromPartition(PARTITION);
    // Look like plain Chrome so Microsoft serves the full sign-in (passkeys, account picker).
    ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|incursion)\/\S+/gi, ''));
    return ses;
}

function openWindow(parent) {
    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            parent, modal: !process.env.INCURSION_HIDDEN, width: 520, height: 720, resizable: false, minimizable: false, maximizable: false,
            title: 'Sign in with Microsoft', backgroundColor: '#ffffff', autoHideMenuBar: true, show: false,
            webPreferences: { session: loginSession(), sandbox: true, contextIsolation: true, nodeIntegration: false }
        });
        win.setMenu(null);
        let settled = false;
        const finish = (fn, v) => { if (settled) return; settled = true; fn(v); if (!win.isDestroyed()) win.close(); };
        const check = (url) => {
            if (!url.startsWith(REDIRECT)) return;
            const params = new URL(url).searchParams;
            if (params.get('code')) finish(resolve, params.get('code'));
            else finish(reject, new Error(params.get('error_description') || 'Microsoft sign-in was cancelled.'));
        };
        win.webContents.on('will-redirect', (_e, url) => check(url));
        win.webContents.on('did-navigate', (_e, url) => check(url));
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.once('ready-to-show', () => {
            if (!process.env.INCURSION_HIDDEN) return win.show();
            win.setPosition(-4000, 40);
            win.showInactive();
        });
        win.on('closed', () => { if (!settled) { settled = true; reject(Object.assign(new Error('Microsoft sign-in was cancelled.'), { code: 'CANCELLED' })); } });
        const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: 'XboxLive.signin offline_access', prompt: 'select_account', cobrandid: '8058f65d-ce06-4c30-9559-473c9275a65d' });
        win.loadURL(`https://login.live.com/oauth20_authorize.srf?${q}`);
    });
}

async function signIn(parent, eml) {
    const code = await openWindow(parent);
    const res = await fetch('https://login.live.com/oauth20_token.srf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, code, grant_type: 'authorization_code', redirect_uri: REDIRECT }).toString()
    });
    if (!res.ok) throw new Error(`Microsoft sign-in failed (HTTP ${res.status}).`);
    const tokens = await res.json();
    const auth = new eml.MicrosoftAuth(parent, CLIENT_ID);
    const account = await auth.getAccount(tokens);
    if (!account?.uuid) throw new Error('That Microsoft account does not own Minecraft: Java Edition.');
    return account;
}

async function forgetBrowserSession() {
    await session.fromPartition(PARTITION).clearStorageData();
}

module.exports = { signIn, forgetBrowserSession };
