# Develop integration and password manager acceptance

The November 8 integration brings the completed Monero hardware and node work, unified Zcash asset page, shared settings and independent password-manager feature flag into one develop candidate. The corrected code is `43a5ff1f1`; the following fixture-only update makes the Zcash browser check finish its normal address-book prompt before navigating.

## Integrated changes

- Monero node management, public-preset failover, connection diagnostics, USB recovery, encrypted monitoring access and signed key-image persistence.
- Qualified hardware signing for standard Monero addresses and subaddresses, with the existing bounded transaction shape and independent host verification. The prior user-approved hardware-to-Feather payment remains documented in the [Monero handoff](../monero-subaddress-firmware-20261107/README.md).
- Unified transparent/shielded Zcash actions and default-collapsed tools, preserving the latest Monero asset integration.
- Shared settings navigation, consistently named switches and feature icons.
- Password bank, protected browser-fill bridge and agent metadata API. `password_manager_enabled` remains independent of `monero_enabled`, defaults off, and applies immediately. Disabling it locks the bank and clears cached secrets.
- Published hdwallet dependency `bf68a3ff9c6572a0897e165ffae69eed519183e5`, which starts the PIN response deadline after submission. [Dependency PR 84](https://github.com/keepkey/hdwallet/pull/84) tracks that change separately.

The original Monero checkout and all 28 snapshotted working files were left unchanged. Only explicit integration paths were staged; dependency symlinks and local tokens were excluded.

## Open Vault PR review

| PR | Review and integration result |
| --- | --- |
| [Public 621](https://github.com/keepkey/keepkey-vault/pull/621) | Integrated the tray-library packaging and precise missing-package diagnostics. Seven launcher tests pass. Fixed a test's macOS temporary-path canonicalization. Its original target is master; this integration targets develop. The real Linux CI package-download step still needs platform CI. |
| [Public 609](https://github.com/keepkey/keepkey-vault/pull/609) | Its complete head `219d0cd4c` is already an ancestor of develop. Retained the separate draft release PR and its release gates. |
| [Fork 4](https://github.com/BitHighlander/keepkey-vault/pull/4) | Integrated hosted-assessment validation and publisher attribution. Retained newer risk tests, translations and shared transaction previews during conflict resolution. |
| [Fork 5](https://github.com/BitHighlander/keepkey-vault/pull/5) | Integrated assessment display and WalletConnect enrichment. Fixed the unresolved resource-timeout finding: one abort signal cancels HTTP deployment scans, and cancelled scans start no further RPCs. Optional enrichment skips the installed SDK's uncancellable transport; explicit audits retain that transport. A new regression fails before this fix and passes afterward. |
| [Fork 2](https://github.com/BitHighlander/keepkey-vault/pull/2) | Integrated the historical firmware 7.15 review packet and PDF, including its explicit handler-test gaps. This is historical evidence, not new firmware release approval. |

Original PRs retain their existing target branches. Integrating their commits here does not publish a release or merge master. The fork PRs' Vercel failures concern the unrelated Next.js deployment configuration; local Vault build and tests were assessed directly.

## Validation

- `make test-unit`: **3,435 pass, zero failures**, across 36 Bun groups, plus the script-style checks. The five optional native cases are skipped without their external candidate inputs.
- With the pinned native inputs: **17 subaddress tests pass**, including all five firmware HID and independent Core verification cases. These use disposable public fixtures and no physical device.
- Password, audit and Linux focused group: **141 pass, zero failures**. PIN transport group: **11 pass, zero failures** and also included in the full gate.
- Password browser flow passes live enable/disable, generation/assignment and backup/verification gates. Settings passes eight sections, independent flags, no writes while browsing, node storage/height display and narrow windows.
- Unified Zcash browser fixture passes **13 checks**, including disabled/watch-only/unsupported-firmware guards and a 390px layout. It now supports a separate port and explicitly dismisses the new-recipient address-book prompt.
- i18n integrity passes for 15 languages; seven safety/font tests pass. Six audit-display strings use explicitly recorded English fallback.
- TypeScript remains at **803 diagnostics**, matching the preceding baseline count, with no additional file/diagnostic-code pairs. Dependency paths and generated translation-key unions change some message text. This is not a clean typecheck.
- Backend, frontend, native macOS development packaging and bundle patching pass. The packaged app contains the PIN fix, password flag, node failover and bounded audit lookup. Both Monero host-library hashes match the qualified candidate.

See [structured results](results.json), [password UI](password-ui.png), [feature flags](feature-flags.png), [narrow settings](settings-narrow.png), and [mobile Zcash](zcash-mobile.png). All screenshots use synthetic accounts and balances. Detailed local logs are under `/private/tmp/vault-develop-evidence-20261108/`.

## Next password manager test

The unified preview is `/private/tmp/vault-develop-integration-20261108/projects/keepkey-vault/_build/dev-macos-arm64/keepkey-vault-dev.app`. It is a development build containing research Monero libraries, not a signed release. It has not replaced the running Vault; both Vault and Feather sessions remain open.

1. When the current wallet session can be closed, launch this preview. Unlock with the user's own PIN. No wipe, recovery or seed reload is needed.
2. Enable **Settings → Feature Flags → Password manager**. Verify Monero retains its setting and the Passwords tab appears immediately.
3. Create/unlock the bank, approve the KeepKey derivation prompt, and generate a small batch. Exercise cancellation and reconnect before using real account credentials.
4. Assign a dedicated test account and save the encrypted recovery manifest separately. Check expiry/rehydration and recovery with the same wallet and manifest; the seed alone does not identify the random bank and assigned slots.
5. Use the compatible load-unpacked BEX from the password MVP handoff for approved field fills. Test exact origin/document/field binding and native fill approval on a dedicated test account. A real password change requires a backed-up staged entry and verified fresh sign-in before activation.
6. Disable the flag while Passwords is open. Verify immediate navigation removal, bank lock and hidden agent tools; Monero stays enabled if it was enabled.

Physical password derivation, replacement-device recovery and actual service login/rotation remain acceptance steps. No website password was changed during integration. The compatible BEX source remains at `b3bc0258813fa34b0eb6060ba3b5d03206fd5da6` in `/private/tmp/keepkey-password-bank-bex`; its packaged test extension and coordinated release requirements are in the [password MVP handoff](../password-bank-mvp-20261107/README.md).
