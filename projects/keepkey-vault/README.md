# React + Tailwind + Vite Electrobun Template

A fast Electrobun desktop app template with React, Tailwind CSS, and Vite for hot module replacement (HMR).

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

The `.deb` declares these as `Depends`. For `.AppImage` and `.tar.zst`, install them manually if missing:

- `libgtk-3-0`
- `libwebkit2gtk-4.1-0` (or `libwebkit2gtk-4.0-37` on Ubuntu 22.04)
- `libayatana-appindicator3-1` (or `libappindicator3-1`)

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
