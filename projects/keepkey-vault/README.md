# React + Tailwind + Vite Electrobun Template

A fast Electrobun desktop app template with React, Tailwind CSS, and Vite for hot module replacement (HMR).

## License

KeepKey Vault is licensed under the **GNU Lesser General Public License, version 3
only** (`LGPL-3.0-only`). See [LICENSE](../../LICENSE) for the LGPLv3 terms and
[COPYING](../../COPYING) for the GPLv3 terms incorporated by LGPLv3. Separately
licensed components retain their own licenses and copyright notices.

## KeepKey volumes

The Volumes tab is off by default. To enable it in a development build, set `VITE_ENABLE_VOLUMES=true` when building the Vault frontend.

Open **Vault → Volumes** and click **Create volume** beside the storage location you want to use. Enter a name and size, then approve on a compatible physical KeepKey. Vault creates an encrypted disk image in the `KeepKey Volumes` folder on that computer or drive. Existing files elsewhere on the drive remain outside the encrypted image.

Creation leaves the protected volume locked. Choose **Unlock with KeepKey** on that volume to mount it and open its protected files in the system file manager. Save private files in this mounted volume. **Open protected volume** takes you back there. **Open drive** opens the outer storage device, where the encrypted image and public recovery file live.

During creation and unlock, the KeepKey displays **Encrypt Key Value** and `KeepKey Volume v1 <ID>`. Compare that ID with the device prompt shown in Vault. Both actions ask the device to reproduce a credential for that ID. The operating system uses the credential to create or mount the image. Renaming the volume folder leaves its ID and recovery credential intact.

Once mounted, applications can work with the protected files and you can disconnect the KeepKey. Choose **Lock** before ejecting the SSD. A busy volume can require closing files first. After reconnecting, unlocking requires another device approval.

To discard a practice volume, choose **Delete volume** on its row and confirm the name and storage location. This permanently removes that volume and its protected files. The drive stays available for other files or a new volume with the same name. Deletion works without the KeepKey, including after an unsuccessful unlock, once Vault can confirm the image is detached.

On macOS, Vault prepares external volumes locally, copies the encrypted image to the drive, and verifies the copy with the approved credential before it reports success. An image created directly on exFAT by an earlier development build can report an authentication error even with the correct KeepKey. Keep the original package if that happens. Use a new name for a fresh practice volume, and verify a file survives locking and unlocking before entrusting data to it.

| Desktop | Encrypted volume | Requirements |
| --- | --- | --- |
| macOS | AES-256 encrypted sparse disk image containing APFS | Open the mounted volume in Finder. |
| Windows 10/11 | BitLocker-encrypted NTFS in a VHDX | Use a BitLocker-capable edition with the Storage and BitLocker PowerShell modules. Approve the Windows prompt from the same administrator account that opened Vault. Windows Home supports drive browsing. |
| Linux | LUKS2 image containing ext4 | The desktop requires UDisks2, Python D-Bus bindings, and ext4 formatting support. The system may prompt for storage authorization. |

### Recover on a replacement computer

Keep the entire `.kkvolume` folder together. It contains the native encrypted image and a small public `recovery.json` file. Vault can read that file from the SSD while the image is locked. The version and random ID in this file are required to reproduce the image credential.

On another computer with the same supported operating system, install Vault and connect the SSD. For a copied backup, place the whole package in `KeepKey Volumes` in your home folder or at the root of a mounted external data volume. Restore a compatible multi-chain KeepKey using the same recovery words and the exact wallet passphrase used at creation, if any. Open **Volumes** and approve the unlock on that device. The original device ID, PIN, and computer are independent of the volume credential.

For a practice run, put a recognizable file in a small test volume, lock it, and reconnect the SSD. Cancel the first unlock to verify the volume stays locked. Then open the file on a fresh Vault installation with a different KeepKey restored from the same **test** words. Keep your original copy of the data until this succeeds on the equipment you plan to use.

Developers can run `KEEPKEY_TEST_NATIVE_VOLUMES=1 bun test __tests__/volume-macos-native.test.ts` from this directory on macOS. The test creates a temporary exFAT disk image and checks the protected volume's native write, lock, and readback flow with a synthetic credential.

## Linux support

Vault ships three Linux x86_64 formats with each release: `.AppImage`, `.deb`, and a self-contained `.tar.zst`. ARM64 Linux is not built.

### Tested distributions

| Distribution         | glibc | AppImage | .deb | tar.zst |
|----------------------|:-----:|:--------:|:----:|:-------:|
| Debian 12 (Bookworm) | 2.36  |    ✅    |  ✅  |   ✅    |
| Debian 13 (Trixie)   | 2.41  |    ✅    |  ✅  |   ✅    |
| Ubuntu 22.04 LTS     | 2.35  |    ✅    |  ✅  |   ✅    |
| Ubuntu 24.04 LTS     | 2.39  |    ✅    |  ✅  |   ✅    |
| Linux Mint 21.x      | 2.35  |    ✅    |  ✅  |   ✅    |
| Pop!_OS 22.04        | 2.35  |    ✅    |  ✅  |   ✅    |
| Fedora 38+           | 2.37  |    ✅    | n/a  |   ✅    |
| RHEL/Rocky/Alma 9    | 2.34  |    ⚠️    | n/a  |   ⚠️    |

Minimum glibc target is **2.35**, set by the Electrobun WebKitGTK wrapper we build on Ubuntu 22.04. RHEL 9 (glibc 2.34) is one minor below the floor — it works for many users but isn't a release gate.

### Installing

**`.deb`** (Debian / Ubuntu / Mint / Pop!_OS):

```bash
sudo apt install ./keepkey-vault_<version>_amd64.deb
```

Installs to `/opt/keepkey-vault/`, drops a launcher at `/usr/bin/keepkey-vault`, registers a `.desktop` entry, and installs `udev` rules so non-root users can talk to the device.

**`.AppImage`**:

```bash
chmod +x KeepKey-Vault-x86_64.AppImage
./KeepKey-Vault-x86_64.AppImage
```

You will likely need udev rules separately so the AppImage can see the KeepKey:

```bash
sudo tee /etc/udev/rules.d/51-keepkey.rules >/dev/null <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="2b24", MODE="0666", GROUP="plugdev"
KERNEL=="hidraw*", ATTRS{idVendor}=="2b24", MODE="0666", GROUP="plugdev"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger
```

**`.tar.zst`** (any distro, manual install):

```bash
tar --use-compress-program=unzstd -xf stable-linux-x64-keepkey-vault.tar.zst
./keepkey-vault/bin/launcher
```

### Common runtime dependencies

The `.deb` declares these as `Depends`, so apt installs them for you. The `.AppImage` bundles the tray stack (Ayatana AppIndicator + dbusmenu) but still needs GTK 3 and WebKitGTK 4.1 from the system — WebKitGTK is too large and too host-coupled (helper subprocesses, GStreamer, Mesa) to bundle, which is also why Tauri-style apps keep it a system dependency. If it is missing, the AppImage shows a dialog naming the exact package for your distro.

For `.AppImage` and `.tar.zst`, install manually if missing:

- Debian/Ubuntu: `sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0` (plus `libayatana-appindicator3-1` for `.tar.zst`)
- Fedora/RHEL: `sudo dnf install gtk3 webkit2gtk4.1` (plus `libayatana-appindicator-gtk3` for `.tar.zst`)
- openSUSE: `sudo zypper install libwebkit2gtk-4_1-0` (plus `libayatana-appindicator3-1` for `.tar.zst`)
- Arch: `sudo pacman -S webkit2gtk-4.1` (plus `libayatana-appindicator` for `.tar.zst`)

WebKitGTK is preinstalled on GNOME-based systems; KDE and minimal installs (e.g. Fedora KDE) usually need it installed.

## Getting Started

```bash
# Install dependencies
bun install

# Development without HMR (uses bundled assets)
bun run dev

# Development with HMR (recommended)
bun run dev:hmr

# Build for production
bun run build

# Build for production release
bun run build:prod
```

## How HMR Works

When you run `bun run dev:hmr`:

1. **Vite dev server** starts on `http://localhost:5173` with HMR enabled
2. **Electrobun** starts and detects the running Vite server
3. The app loads from the Vite dev server instead of bundled assets
4. Changes to React components update instantly without full page reload

When you run `bun run dev` (without HMR):

1. Electrobun starts and loads from `views://mainview/index.html`
2. You need to rebuild (`bun run build`) to see changes

## Project Structure

```
├── src/
│   ├── bun/
│   │   └── index.ts        # Main process (Electrobun/Bun)
│   └── mainview/
│       ├── App.tsx         # React app component
│       ├── main.tsx        # React entry point
│       ├── index.html      # HTML template
│       └── index.css       # Tailwind CSS
├── electrobun.config.ts    # Electrobun configuration
├── vite.config.ts          # Vite configuration
├── tailwind.config.js      # Tailwind configuration
└── package.json
```

## Customizing

- **React components**: Edit files in `src/mainview/`
- **Tailwind theme**: Edit `tailwind.config.js`
- **Vite settings**: Edit `vite.config.ts`
- **Window settings**: Edit `src/bun/index.ts`
- **App metadata**: Edit `electrobun.config.ts`
