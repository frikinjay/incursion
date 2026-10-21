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
