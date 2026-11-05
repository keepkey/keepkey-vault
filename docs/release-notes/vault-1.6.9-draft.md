# KeepKey Desktop v1.6.9

Published prerelease: https://github.com/keepkey/keepkey-vault/releases/tag/v1.6.9

## Fixes and improvements

- Litecoin receive details and device address verification follow the selected
  Legacy, Wrapped SegWit or Native SegWit account. Switching accounts no longer
  lets an older address or account-key response replace the current selection.
- Correct Litecoin extended-key classification when building transactions, and
  recognize supported Litecoin account paths in Audit recovery.
- Refresh balances automatically after sending, confirmation and incoming
  activity. Preserve newer balances when refreshes overlap.
- Keep the selected Pioneer server consistent across balances, history, swap
  providers and live connections.
- Improve swap route selection, fee disclosure, error messages and completion
  tracking. Provider quote labels describe the requested quote's availability.
- Separate Zcash transparent and shielded balances, improve pending and scan
  status, and add direct Shield, Unshield and Scan navigation.
- Add DeFi position details and make the Audit support handoff visible.

## Known limitations

The later NEAR Intents refund-address and memo safety fix (`c4ab07162`) is excluded from this original tagged build. Avoid NEAR Intents swaps from XRP or TRON (including USDT-TRON) in this prerelease.

## Downloads

| Platform | Download | SHA-256 |
| --- | --- | --- |
| macOS Apple Silicon | [KeepKey-Vault-1.6.9-arm64.dmg](https://github.com/keepkey/keepkey-vault/releases/download/v1.6.9/KeepKey-Vault-1.6.9-arm64.dmg) | `1ac8c749f30474b4435ff538c31be9c14ebcaee5d058f8e4bb5f5229e2668199` |
| macOS Intel | [KeepKey-Vault-1.6.9-x86_64.dmg](https://github.com/keepkey/keepkey-vault/releases/download/v1.6.9/KeepKey-Vault-1.6.9-x86_64.dmg) | `f7d93183d1e3ec4327ea3d81c8a60b0fd817b27aaddd36003d2b52e22ecde480` |
| Linux AppImage | [KeepKey-Vault-x86_64.AppImage](https://github.com/keepkey/keepkey-vault/releases/download/v1.6.9/KeepKey-Vault-x86_64.AppImage) | `76501565acd4a8b0082bfa23b934a471ced9960b849882c27647ac881ce06c61` |
| Linux Debian/Ubuntu | [keepkey-vault_1.6.9_amd64.deb](https://github.com/keepkey/keepkey-vault/releases/download/v1.6.9/keepkey-vault_1.6.9_amd64.deb) | `47c2aca087e7129c6b39bf51ba784192a9ddbe971c7d515c562663fbced0090e` |

The Windows installer is supplied by the separate Windows release process. Its checksum is in `SHA256SUMS-windows.txt`; the Mac/Linux verification below does not attest the Windows build.

## Validation

- Built from signed tag `v1.6.9` at `6e12d01ea23ebfa24f8e6f7358efcccd3b224484`, on the pushed `release/1.6.9` branch.
- Linux and macOS CI passed, including native Intel application startup.
- Both final Mac DMGs are signed, notarized, stapled, and accepted by Gatekeeper. Both signed update archives passed signature, architecture, macOS 13, and Bun entitlement checks. DMG application contents match the corresponding update archives.
- The packaged emulator is 7.17.0; its executable code matches the certified universal library. A smoke test using the extracted packaged library passed Litecoin Legacy/Wrapped/Native address checks, OLED output, seed persistence across an in-memory restart, and three consecutive verified message signatures. No transactions were broadcast.
- 2,458 unit tests and 17 script checks passed. The existing typecheck baseline gate passed with 813 diagnostics against a baseline of 1,033; this is not a clean typecheck.
- Interactive app-level emulator setup, encrypted flash persistence, and the certified ETH-to-SOL ClearSign swap review remain pending for this prerelease. The library smoke test does not replace those UI checks or physical-device testing.

## Verify your download

Download `SHA256SUMS.txt` alongside the desired package and compare its SHA-256 checksum (`shasum -a 256 <filename>` on macOS, `sha256sum <filename>` on Linux). The checksum files were regenerated from the bytes served by this release after signing. `SHA256SUMS-macos.txt` contains the Mac packages only.
