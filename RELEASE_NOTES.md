# Incursion 2.10.1: Update Fixes

## Fixes
- Windows updates now find their checksum. GitHub renames the installer when it's uploaded (spaces become dots), which would have made every Windows update fail its check.
- Release builds verify Electron against the checksums that ship with it and keep their downloads between runs, and a build that fails on a download is retried, so short GitHub outages don't stop a release.

---

# Incursion 2.10.0: App Updates, Duplicate Packs and Loader Changes

## Highlights
- **Incursion updates itself.** It checks GitHub for a new release when it starts and every hour after that. When one is out, a notice shows in the top bar. Press Update and it downloads, checks the file against the release's SHA-256 checksums, and asks whether to restart now or later. If you pick later, the update installs the next time you quit.
- **Duplicate a pack** from the library card's menu or the pack's More menu. The copy gets every file, config and setting, sits in its own folder next to the original (or wherever you choose), and has its own game folder.
- **Change a pack's loader**, not just its Minecraft version. Every mod moves to its file for the new loader on each platform. A mod with no file for the new loader is turned off and marked incompatible in the list, so you can see what to replace.

## Details
- Updates are installed only after the downloaded file matches the release's checksum. A download that fails or doesn't match is thrown away, and the running app is never touched until then.
- A verified update survives a crash or a restart, and Incursion cleans up the installer once the new version runs.
- Nothing installs while a game is running, since updating closes Incursion and the game with it.
- Windows installs silently. On macOS the new app replaces the old one in place. Linux AppImages are swapped in place, and .deb installs ask for your password. Where Incursion can't install by itself, the notice links to the release page.
- Settings → Updates shows the current version with a Check Now button, and lets you turn off automatic checks.
- Moving a pack to another version or loader now keeps the files that did move for a mod, even when its other platform has none.
- Mods added by hand that are built for the other loader family (Fabric or Quilt in a Forge or NeoForge pack, or the other way round) are flagged as incompatible.
- A duplicate is copied to a temporary folder first and only appears once the copy is complete, so a failed copy leaves nothing behind. Publishing projects aren't copied, so a release from the copy can't land on the original's pages.

---

# Incursion 2.9.4: CurseForge Licenses

## Fixes
- CurseForge does have a license field, I missed it somehow. Licenses now come from both Modrinth and CurseForge, and when the two list different licenses, both are shown with their platform. Only when neither lists one does Incursion use the license the mod file itself declares.
- Packs pick up their CurseForge licenses in the background the next time they're opened.
- Licenses written differently on each site, like "MIT" and "MIT License" or "LGPL-3.0-only" and "GNU Lesser General Public License version 3 (LGPLv3)", count as the same license.

---

# Incursion 2.9.3: Thread Viewer, Licenses, Local Files and Install Folders

## Highlights

### See what a frozen game is doing
- The game console has a new **Threads** view while a pack runs. It shows the game's threads in plain words: running, waiting, stuck in a loop, waiting for a lock, or deadlocked.
- When the game freezes, it says which thread stopped, for how long, and which mod's code it's stuck in. Click the mod to open it in the pack.
- Open a thread to see where it is, with the pack's mods highlighted. Quiet background threads are folded away.
- It works with any Java, adds nothing to the game until you open the view, and only answers Incursion on this computer.

### Licenses
- Each item in a pack's content list shows its license next to the author, and its details show it too (click it to read the license on Modrinth).
- A license listed on Modrinth is used first. CurseForge doesn't publish licenses, so otherwise the license comes from what the mod file declares, shown for each platform's file when they differ.
- Filter the list by license, or sort by it, from the new **License** menu.

### Add local files
- The new file button next to **Add Content** adds mods, resource packs, shaders and data packs from your computer. The type is detected and can be changed.
- Files Modrinth or CurseForge recognise are added as normal projects, so updates keep working, using your copy instead of downloading it again. Others are kept as local files in both editions.

### Install folders for resource and data packs
- Choose where resource packs and data packs go inside the game folder, for example `config/paxi/datapacks` for a global pack loader: for the whole pack in Settings → Content, or for one item in its details.
- Play puts them there and cleans up the old folder when it changes. Modrinth, Prism and packwiz exports and server packs use the folder; CurseForge exports bundle those files in overrides, since CurseForge can only install to the usual folders.

### Faster and lighter
- Packs open faster: loading starts when you rest the pointer on a pack, a pack you've opened before appears straight away, and opening no longer rescans the pack's folders first.
- Packs not used for a while are released from memory once more than three are open.

## Fixes
- Buttons, rows, tabs and other clickable things show the hand cursor, and text fields the text cursor.
- The search box in a pack's content list shrinks instead of dropping to its own line on narrower windows.
- On mid-sized windows, a pack's details at the top no longer squeeze into a narrow column next to its buttons.

---

# Incursion 2.9.2: Change Minecraft Versions, Compatibility Flags and Reliable Downloads

Everything new since 2.8.0. Version 2.9.1 contained most of this but was published without release notes.

## Highlights

### Change a pack's Minecraft version
- Edit Pack now lets you change the Minecraft version of a pack that already has content. The loader version switches to the recommended build for the new version, and you can pick another.
- Before anything changes you see how many mods move to their file for the new version, which ones have none (they're turned off, not removed) and which hand-added files to check yourself.
- Every new file is downloaded first. If any download fails, nothing in the pack changes.
- The loader version can still be changed on its own. The loader itself stays fixed once a pack has content, since every file is built for one loader.

### Compatibility flags
- Mods whose file doesn't fit the pack are flagged in the list: **Wrong Minecraft**, **Wrong Loader** or **Needs Other NeoForge/Fabric/…**. The platform mark turns red for the platform whose file is the problem, and the tooltip says why, for example "Needs NeoForge 26.2.0.67 or newer".
- Two checks per platform: the Minecraft versions and loaders the site lists for the installed file, and the Minecraft and loader version ranges the jar itself requires.
- A new **Incompatible** filter shows only flagged mods, the Issues tab lists them, and a mod's details show the reason for each platform.
- Existing packs fill in this information in the background the first time they're opened.

### Release channel per pack
- A new **Mod Versions** card in a pack's Settings chooses its release channel: **Releases and Betas** (the default) or **Releases Only**. It applies to updates, Add Content, Change Version and moving to another Minecraft version, on both CurseForge and Modrinth.
- With Releases and Betas, newer beta files are offered as updates. Before, CurseForge updates only ever offered stable releases, so newer betas never showed up.
- With Releases Only, betas are never offered or listed. A mod that only has betas can't be added until you switch, and says so. Alpha files are never offered on either channel.

### Downloads that finish
- Downloads no longer fail after a fixed two minutes. A download only gives up when the server sends nothing at all for 30 seconds, five times in a row.
- A stalled connection picks up from the last byte received instead of starting again.
- Larger files download in up to four parallel parts, which is much faster when a CDN is congested or throttles each connection (seen with Modrinth's CDN in some regions).
- Downloads through CurseForge's redirector work the same way, and servers that don't support partial downloads still work.
- When a download does fail, the message says which site stopped sending and suggests trying later or from another network.

### Download progress
- A Downloads panel under the status pill shows a progress bar for every file: size, speed and when it's reconnecting. It opens by itself for downloads that take more than a moment, and clicking the status pill hides or shows it.
- Updating mods shows progress in megabytes, so a slow update visibly moves instead of sitting at "0 of 5".
- Minecraft's own game files appear in the panel while a pack launches.

### App logs
- Incursion keeps a log of downloads, updates, launches and errors (5 MB, last three kept). Open it from Settings → Data → App Logs. Tokens and keys are masked.

### Game files folder stays tidy
- Minecraft now runs inside each pack's own game folder. Before, its logs, crash dumps and some mod configs landed in the shared game files folder, and crash analysis couldn't find the latest log.

## Fixes
- The Updates filter no longer says "Everything Is Up to Date" when updates exist but your search or other filters hide them. It now says how many don't match.
- **Update All** counts only mods still in the pack, so its number matches the Updates filter.
- The Stop button in a pack's header no longer sits lower than the buttons next to it.

## Releases
- Pushing a commit to `main` whose title contains the version (for example `v2.9.2`) builds and publishes the release. Other commits, including ones that only bump the version, don't.
- Each release's description now comes from its section of `RELEASE_NOTES.md`. A release stops before building if that section is missing, instead of being published without notes.

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
