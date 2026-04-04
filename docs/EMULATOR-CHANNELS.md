# Emulator Channels SOP

KeepKey Vault bundles three emulator channels, each tracking a different firmware branch. Before every release, emulators must be rebuilt from their source branches to ensure they match the latest firmware state.

## Channel Definitions

| Channel | Source Repo | Branch | Purpose |
|---------|-------------|--------|---------|
| **alpha** | `BitHighlander/keepkey-firmware` | `release/7.14.0` | Latest development builds — may include untested features |
| **beta** | `BitHighlander/keepkey-firmware` | `release/7.14.0` | Pre-release testing — same source as alpha, pinned manually |
| **release** | `keepkey/keepkey-firmware` | `master` | Stable upstream builds — matches what ships on real devices |

Alpha and beta currently point to the same fork branch. The distinction is operational: alpha auto-updates on every build, while beta is pinned manually when a candidate is deemed ready for wider testing.

## Directory Layout

```
firmware/emulators/
├── manifest.json              # Channel definitions + source metadata
├── 7.14.0-alpha/
│   ├── kkemu                  # CLI emulator binary
│   └── libkkemu.dylib         # FFI shared library (loaded by vault)
├── 7.14.0-beta/
│   ├── kkemu
│   └── libkkemu.dylib
└── 7.14.0-release/
    ├── kkemu
    └── libkkemu.dylib
```

## Building Emulators

### Build all channels
```bash
make build-emulators
```

### Build a single channel
```bash
make build-emulator-alpha    # BitHighlander fork, release/7.14.0
make build-emulator-beta     # BitHighlander fork, release/7.14.0
make build-emulator-release  # Upstream keepkey/keepkey-firmware master
```

### Download pre-built binaries (if published)
```bash
make download-emulators
make download-emulator-alpha
```

### Check status
```bash
make emulator-status
```

## Build Requirements

- macOS (ARM64 or x86_64)
- CMake 3.x
- A C/C++ compiler toolchain (Xcode CLI tools)
- The firmware submodule initialized: `git submodule update --init modules/keepkey-firmware`

The build uses `PB_NO_PACKED_STRUCTS=1` for ARM64 nanopb alignment compatibility.

## Release Verification Checklist

Before cutting a vault release, verify all three emulators are fresh:

### 1. Rebuild all channels from source
```bash
make clean-emulators
make build-emulators
```

### 2. Verify each channel loads correctly
Start the vault in dev mode and open the emulator panel:
```bash
make dev
```
In the Emulators panel (bottom-right), select each channel and verify:
- [ ] **Alpha** loads and reaches the onboarding screen
- [ ] **Beta** loads and reaches the onboarding screen
- [ ] **Release** loads and reaches the onboarding screen

### 3. Verify source branches are current
```bash
# Alpha/Beta source
git -C modules/keepkey-firmware fetch origin
git -C modules/keepkey-firmware log --oneline origin/release/7.14.0 -3

# Release source
git -C modules/keepkey-firmware fetch keepkey
git -C modules/keepkey-firmware log --oneline keepkey/master -3
```

### 4. Check binary architectures
```bash
file firmware/emulators/7.14.0-alpha/kkemu
file firmware/emulators/7.14.0-beta/kkemu
file firmware/emulators/7.14.0-release/kkemu
```

All should match the target platform (e.g., `Mach-O 64-bit executable arm64`).

### 5. Run emulator tests per channel
```bash
# Test with each channel's kkemu binary
./firmware/emulators/7.14.0-alpha/kkemu &
# ... run tests, then kill
```

## How Channel Selection Works

1. User opens the Emulators panel in the vault UI
2. Three channel buttons appear: **ALPHA**, **BETA**, **RELEASE**
3. User selects a channel, then starts/imports a wallet
4. The vault loads the corresponding `libkkemu.dylib` via FFI
5. Channel selection is locked while an emulator is running (must stop first to switch)

## Manifest Format

The `manifest.json` defines each emulator entry with source tracking:

```json
{
  "emulators": [
    {
      "version": "7.14.0-alpha",
      "channel": "alpha",
      "source": {
        "repo": "BitHighlander/keepkey-firmware",
        "branch": "release/7.14.0"
      }
    }
  ],
  "channels": {
    "alpha": {
      "description": "Latest development builds",
      "repo": "BitHighlander/keepkey-firmware",
      "branch": "release/7.14.0",
      "autoUpdate": true
    }
  }
}
```

## Troubleshooting

### "Emulator dylib not installed for channel X"
The channel's binary hasn't been built yet. Run:
```bash
make build-emulator-<channel>
```

### Build fails with nanopb alignment errors
Ensure `PB_NO_PACKED_STRUCTS=1` is set. The Makefile handles this automatically.

### CMake can't find the firmware submodule
```bash
git submodule update --init --recursive modules/keepkey-firmware
```

### Wrong architecture (x86_64 binary on ARM64 Mac)
Clean and rebuild:
```bash
make clean-emulators
make build-emulators
```
