# KeepKey Firmware Reference

Reference firmware binaries for development, testing, and flashing.

## Directory Structure

```
firmware/
├── signed/         # Official signed releases (from GitHub releases)
│   └── .gitkeep
├── unsigned/       # Dev/unsigned builds (from local firmware compilation)
│   └── .gitkeep
├── manifest.json   # Known firmware + bootloader versions with hashes
├── download.ts     # Script to fetch official releases
└── README.md
```

## Usage

### Download official firmware

```bash
make firmware-download           # Download latest signed firmware + bootloader
```

### Check what's on your device

```bash
make cli ARGS=firmware-info      # Compare device firmware against manifest
```

### Flash firmware (device must be in bootloader mode)

```bash
make firmware-flash FW_PATH=firmware/signed/firmware-v7.10.0.bin
```

### Build unsigned firmware from source

```bash
make firmware-build              # Builds via Docker → outputs to modules/keepkey-firmware/
```

## Manifest

`manifest.json` tracks all known firmware and bootloader versions with their SHA-256 hashes. This is fetched from the [keepkey-desktop releases.json](https://raw.githubusercontent.com/keepkey/keepkey-desktop/master/firmware/releases.json) and stored locally for offline reference.

## Naming Convention

- Signed firmware: `firmware-v{VERSION}.bin` (e.g., `firmware-v7.10.0.bin`)
- Signed bootloader updater: `blupdater-v{VERSION}.bin`
- Unsigned firmware: `firmware-v{VERSION}-unsigned.bin`

## Binary Structure & Hash Verification

Firmware `.bin` files have a **256-byte header** followed by the payload:

```
[0x00-0x03] Magic: "KPKY" (0x4B 0x50 0x4B 0x59)
[0x04-0xFF] Metadata (version, flags, padding)
[0x100-EOF] Firmware payload
```

**Critical**: The manifest SHA-256 hashes cover the **payload only** (bytes 256+), NOT the full file. This matches what the device stores in `features.firmwareHash` (base64-encoded, convert to hex for comparison).

Bootloader updater binaries (`blupdater-*.bin`) do NOT have this header — their hashes cover the full file.

The `firmware-info` CLI command reads the device's firmware/bootloader hashes (base64 → hex) and cross-references them against the manifest to determine whether the running firmware is officially signed or a dev/unsigned build.

## Important Notes

- **Do NOT commit large .bin files** — use `make firmware-download` to fetch them
- The `signed/` and `unsigned/` dirs are gitignored except for `.gitkeep`
- `manifest.json` IS tracked in git as the source of truth for hash verification
- Manifest hashes = firmware payload hash (skip 256-byte header), NOT full file hash
