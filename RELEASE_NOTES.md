# Incursion 2.9.0: Change Minecraft Versions, Compatibility Flags and Reliable Downloads

## Highlights

### Change a pack's Minecraft version
- Edit Pack now lets you change the Minecraft version of a pack that already has content. The loader version switches to the recommended build for the new version, and you can pick another.
- Before anything changes you see how many mods move to their file for the new version, which ones have none (they're turned off, not removed) and which hand-added files to check yourself.
- Every new file is downloaded first. If any download fails, nothing in the pack changes.
- The loader version can be changed on its own as before. The loader itself stays fixed once a pack has content.

### Compatibility flags
- Mods whose file doesn't fit the pack are flagged in the list: **Wrong Minecraft**, **Wrong Loader** or **Needs Other NeoForge/Fabric/…**. The platform mark turns red for the platform whose file is the problem, and the tooltip says why.
- Two checks per platform: the Minecraft versions and loaders the site lists for the installed file, and the Minecraft and loader version ranges the jar itself requires.
- A new **Incompatible** filter shows only flagged mods, the Issues tab lists them, and a mod's details show the reason for each platform.
- Existing packs fill in the information in the background the first time they're opened.

### Downloads that finish
- Downloads no longer fail after a fixed two minutes. A download only gives up when the server sends nothing at all for 30 seconds, five times in a row.
- A stalled connection picks up from the last byte received instead of starting again.
- Larger files download in up to four parallel parts, which is much faster when a CDN is congested or throttles each connection (seen with Modrinth's CDN in some regions).
- Downloads from CurseForge's redirector work the same way, and servers that don't support partial downloads still work.
- When a download does fail, the message says which site stopped sending and suggests trying later or from another network.

### Download progress
- A Downloads panel under the status pill shows a progress bar for every file: size, speed and when it's reconnecting. It opens by itself for downloads that take more than a moment, and clicking the status pill hides or shows it.
- Updating mods now shows progress in megabytes, so a slow update visibly moves instead of sitting at "0 of 5".
- Minecraft's own game files appear in the panel while a pack launches.

### App logs
- Incursion now keeps a log of downloads, updates, launches and errors (5 MB, last three kept). Open it from Settings → Data → App Logs. Tokens and keys are masked.

### Fixes
- The Stop button in a pack's header no longer sits lower than the buttons next to it.

### Game files folder stays tidy
- Minecraft now runs inside each pack's own game folder. Before, its logs, crash dumps and some mod configs landed in the shared game files folder, and crash analysis couldn't find the latest log.

---

# Incursion 2.8.0: Manual Mod Files, New Windows Setup and Universal macOS

## Highlights

### Mods added by hand
Some mods are on only one platform, or their authors block app downloads. You can now fill those gaps yourself and Incursion tracks them properly.
- Jars you drop into a pack's `modrinth/mods` or `curseforge/mods` folder are recognised. Exact copies of the other platform's file are adopted automatically.
- From a mod's details: **Use the Modrinth/CurseForge File** (one click) or **Choose a File…**.
- Copied files are never updated automatically. When the original gets a newer version, the mod shows **Copy Outdated** and an **Update from Modrinth/CurseForge** button. Use it once that version is fine to ship on the other platform.
- CurseForge mods whose authors block app downloads now appear in search, marked with a warning dot. Adding one shows **Download Needed**, with a button to open the download page; the jar you download is picked up automatically.
- Jars neither site recognises can be kept as a **Local File** mod, used by both editions.
- A hand-added file shows a blue dot on its platform mark, and there's a new **Files Added by Hand** filter and Issues rows for them.
- Play includes hand-added files in each edition. Exports bundle them in `overrides/mods`, and publishing reminds you to check their licences.

### Dependencies
- Required Dependencies now shows which mods need each one and which versions they accept, for example "Needed by Sodium Extra (0.8.13 or newer), Iris Shaders (0.6.x)".

### New Windows setup
- Choose the install folder, and install for everyone or just you.
- Choose whether to add a Start menu folder and a desktop shortcut. Your choices are remembered for updates.
- New dark look to match the app.

### Game files folder
- First launch asks where to keep game files, Java and pack game folders. You can change it later in Settings → Data.
- The folder is now called `.incursion` on Windows, macOS and Linux. Existing macOS installs keep their current folder.

### macOS
- One download for both Intel and Apple Silicon Macs (`Incursion-<version>-universal.dmg`).

## Security and releases
- The app is locked down further: it can't be run as plain Node.js or debugged from outside, its bundled code is checked on start, and saved cookies are encrypted.
- Camera, microphone, location and notification requests are always refused.
- Each release includes `SHA256SUMS.txt`, and you can check where a download was built with `gh attestation verify <file> --repo frikinjay/incursion`.
- Incursion is now licensed under the **GNU Affero General Public License v3.0**.
