# Bundled Firmware

Firmware binaries and manifest that ship inside the vault app bundle.

## Contents

```
firmware-bundle/
├── releases.json              # Bundled manifest (parallel to keepkey-desktop's releases.json)
├── v7.10.0/firmware.keepkey.bin
├── v7.14.0/firmware.keepkey.bin
└── bl_v2.1.4/blupdater.bin
```

## Why bundle?

- **Stronger chain of custody**: Apple-notarized DMG → firmware inside the signed bundle. Tampering with any bundled binary breaks the DMG signature. Stronger than downloading + hash-checking at runtime (which trusts a JSON file on GitHub).
- **Offline installs**: Users on air-gapped machines can flash without network access.
- **Alpha channel**: Ships 7.14.0 inside the app — alpha testers flip the toggle, no remote manifest update required.

## Runtime behavior

At startup, `EngineController.fetchFirmwareManifest()`:

1. Loads `releases.json` from this directory (bundled, always works)
2. Fetches `https://raw.githubusercontent.com/keepkey/keepkey-desktop/master/firmware/releases.json`
3. **Merges**: for each channel (latest, beta), picks the entry with the higher version
4. When downloading: if the selected version's `.bin` exists here, reads from disk; else fetches over HTTPS
5. Hash verification runs against the manifest hash regardless of source

## Updating the bundle

```bash
# Replace a firmware binary
cp <signed-binary> firmware-bundle/vX.Y.Z/firmware.keepkey.bin

# Regenerate the hash in releases.json
tail -c +257 firmware-bundle/vX.Y.Z/firmware.keepkey.bin | shasum -a 256
# Paste into releases.json: latest.firmware.hash (or beta.firmware.hash)
# Add to hashes.firmware: "<hash>": "vX.Y.Z"
```

## Hash format

- **Firmware (`firmware.keepkey.bin`)**: SHA-256 of the payload (first 256 bytes stripped — that's the KPKY header). Same format keepkey-desktop uses.
- **Bootloader (`blupdater.bin`)**: SHA-256 of the full binary (no header).

## Git tracking

Binaries are committed to git. They're small (~600KB firmware, ~315KB bootloader) and change rarely. The bundle must match what ships in the DMG for the signing chain to mean anything — git is the source of truth.
