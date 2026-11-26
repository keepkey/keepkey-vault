# Password bank MVP release handoff

The MVP adds a default-off **Password manager** switch in **Settings → Feature Flags**. Switching it on adds **Passwords** inside the existing lock button’s **Vault** panel immediately, alongside **Seed vault (BIP-85)**. Switching it off removes that section and clears the unlocked bank and password cache immediately. No restart or reload is required for either operation.

This flag is independent of Monero. Turning it off clears the unlocked Password Bank and cache. Desktop is a plain password manager: Add creates a password on the KeepKey, each entry shows when it was created and last changed, and Change password replaces it in one step. Users set passwords on websites themselves.

The initial isolated password branch and package remain available for historical reproduction.

## Simple list, recovery and native reveal

The default view contains **Add password** and the saved account list. With KeepKey approval, Vault derives the required slots and encrypts the assigned accounts and rotation state before saving them to its database. **Open website** records submission before opening the site or making the new password available. If the database write fails, the website stays closed. Final activation requires a verified sign-in with the generated password.

**Options** includes lock and restore. Earlier encrypted recovery files remain readable. Recovery after loss of the database requires a copy of the database or an existing recovery file along with the same seed and wallet passphrase.

Each staged or verified password has a masked field, eye control and copy control. **Copy** works while the password is masked. Reveal lasts at most 30 seconds and ends on window blur, page hiding or expiry. Copy and reveal require an unlocked bank. When the cache expires, Vault requests KeepKey approval to fetch the password again.

The original preview passed 61 password/emulator tests (39 focused password checks plus emulator session, PIN and startup-recovery checks). Synthetic UI checks cover the simple list, automatic backup, failed-backup blocking, eye masking, explicit clipboard copy, blur/expiry hiding, narrow layout, both lock-panel tools, focus restoration and live feature flags. No new TypeScript file/code diagnostics were introduced against the 803-diagnostic existing baseline. Native eye/reveal and clipboard behavior was also confirmed by the owner in the preview.

The native test exposed an intermittent blank emulator window: the firmware process remained running, but its WebView never posted readiness. Reopening only its display recovered the session without replacing the wallet. Startup now retries unready HTML loads within the existing deadline, stops on readiness/close/replacement, and uses a per-load identifier so a stale readiness response cannot enable JavaScript delivery into a newer load. The bridge uses its bound IPv4 loopback address directly.

## Native emulator acceptance on November 8

Password manager and BIP-85 now share the existing lock button’s Vault panel. No Passwords tab is added to the top navigation. The independent flag shows or hides the password section immediately; BIP-85 remains available with the flag off.

Fixed the missing emulator approval controls: password derivation now uses the existing interactive emulator confirmation gate. Physical KeepKeys retain firmware confirmation. All 36 password tests pass, including three new approval/cancellation regressions; the browser fixture covers both tools behind the lock, backup and verification gates, and live feature disable. TypeScript remains at 803 existing diagnostics.

The running development preview passed 19 native checks on the fresh disposable `password-mvp-qa-20261108` emulator wallet. These covered visible Confirm/Reject controls, rejected generation without a usable entry, three separately approved entries, test-account assignment, backup-gated staging and cancellation before website changes, owner-only encrypted backups, lock/unlock, cache eviction, one-minute expiry, approved rehydration, live disable and hidden agent tools, independent Monero state, and encrypted SQLite metadata. At this initial checkpoint, no website credential was changed and no password value was printed. Physical hardware and real-service acceptance remain separate.

Local evidence is under `/private/tmp/vault-develop-evidence-20261108/`; encrypted test backups are owner-only under `/private/tmp/vault-password-manager-test-20261108/` and must not be committed. The test bank remains bound to the disposable wallet; it is not a bank for the funded Monero wallet.

## Included functionality

- Create/unlock a hardware-derived password bank using existing multi-chain KeepKey firmware's `CipherKeyValue` command. Each derivation requires device confirmation. Bitcoin-only firmware is refused.
- Generate 1–8 ready entries per request. Newly allocated passwords have 24 characters, including uppercase and lowercase letters, digits, and exactly one symbol from `!@#$%^&*`. Previously allocated slots reproduce their original passwords. Assign each slot to one exact HTTPS domain and account. Retired or cancelled slots are never reused.
- Persist the account registry and rotation journal only as authenticated AES-256-GCM ciphertext. No metadata-unwrapping key or password is persisted. SQLite compare-and-swap prevents another Vault instance from overwriting a stale bank or reusing its allocation range.
- Keep generated passwords in a session cache, with selectable 1/5/15-minute lifetime and a fifteen-minute absolute unlock limit. Lock, disconnect, wallet-session change, feature disable or app exit evicts that session. Rehydrate an assigned entry through another device confirmation.
- Restore an existing encrypted recovery manifest when the local bank is missing. Updated Vault opens both backup versions. Import preserves any existing local bank.
- Track account review intervals and guide changes through stage → record submission in the database → begin website change → verify fresh sign-in → activate. An uncertain submitted change retains both locations and cannot be casually cancelled.
- Open bundled Google, GitHub and Microsoft security-page guides. These are guided workflows, not automated password-changing scripts.

Service recipes were checked against official account settings. [Google](https://support.google.com/accounts/answer/41078) · [GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/updating-your-github-access-credentials) · [Microsoft](https://support.microsoft.com/en-us/accounts-billing/manage/change-your-microsoft-account-password)

After adding an account, set and verify the generated password on the website. Complete the website’s existing-password authentication and MFA yourself.

## Try the actual app

1. Build/run the feature branch with `make dev` using the normal Vault workflow.
2. Open **Settings → Feature Flags → Password manager**. The switch is initially off. Enable it and observe the lock button update before closing settings.
3. Open the lock button → **Passwords** → **Add password**, enter the login domain/account, and select **Create password**. Approve the requested device operations.
4. Vault saves the encrypted bank to its database automatically.
5. Choose **Open website** to record submission and begin the change. Complete current-password authentication and MFA. Copy the staged password and paste it into the website’s new and confirmation fields before submitting the change.
6. Test a fresh sign-in using the generated password. In Vault, check the successful-sign-in acknowledgment and select **Finish** only when that password works. Vault saves the verified rotation in the database. Until then both locations remain recorded.
7. Use the eye when you want to see the staged or verified password. **Copy** is available while it is masked. Values hide on blur or timeout. Disabling the feature immediately removes Passwords and locks the bank.

Use test accounts and a test wallet for initial acceptance. Physical KeepKey behavior and replacement-device recovery have not been exercised in this implementation session.

## Chrome saved credential inventory boundary

Ordinary webpages and extensions cannot enumerate Chrome's saved-password vault, including a metadata-only list of every saved account matching the current page. Chromium restricts its `passwordsPrivate` permission to browser components; it is not a permission BEX can acquire through its manifest. Chrome's autofill chooser is browser UI, separate from the webpage DOM. [Chromium permission definitions](https://raw.githubusercontent.com/chromium/chromium/main/chrome/common/extensions/api/_permission_features.json), [extension security boundaries](https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/security_faq.md).

View saved entries in Chrome Password Manager. Chrome’s CSV export contains actual password values. [Chrome import/export documentation](https://support.google.com/chrome/answer/13068232?hl=en)

## Recovery and expiry contract

The bank retains the **`keepkey-ckv-base64url-v1`** identifier and uses KeepKey's `CipherKeyValue` command on existing firmware. Derivation does not export a seed or a bank-wide password derivation root.

For bank ID `b` and slot `i`:

```text
Metadata path: m/10016'/11'/0'
Metadata label: "KeepKey Password Bank v1 " + b + " unlock"
Password path: m/10016'/11'/1'/i'
Password label: "KeepKey Password Bank v1 " + b + " slot " + decimal(i)

CipherKeyValue: encrypt=true, ask_on_encrypt=true, ask_on_decrypt=true
               value=32 zero bytes, explicit IV=16 zero bytes

Metadata AEAD key: SHA256(UTF8("keepkey-password-bank/v1/metadata") || device_output)
Password entropy: SHA256(UTF8("keepkey-password-bank/v1/password") || device_output)
Legacy password: Base64URL(password_entropy)[0:24]
```

The device cipher's E1/D1 flags participate in its key derivation. The random 128-bit bank ID is retained in the backup envelope. AES-GCM uses a fresh 96-bit IV and binds `keepkey-password-bank/<version>/<bankId>` as associated data. The envelope contains format/version, bank ID, IV, ciphertext and tag. Account labels, locations and the format boundary are encrypted.

Vault saves the first slot allocated with the symbol format in the version 2 manifest before asking the device for that slot. Slots below that boundary retain the legacy format, including previously staged and ready passwords. For slots at or above the boundary, Vault uses a byte stream of HMAC-SHA256 blocks keyed by the password entropy. Each block's UTF-8 input is `keepkey-password-bank/v2/symbol-password/<counter>` with a decimal counter starting at 0. Rejection sampling chooses the symbol position and a character from `!@#$%^&*`, then chooses the other characters from `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`. Vault redraws the nonsymbol characters until all three alphanumeric classes are present.

A frozen software vector uses the public BIP39 `abandon` × 11 + `about` mnemonic with an empty passphrase, bank ID `00000000000000000000000000000001`, and slot 7. Firmware-compatible CKV output is `f175ad6c34511e75dda60261f56eb57a6bf72384d793e014c62f880530692175`; the password is `mtzY2TVqtboJQbQv9lwjlIrT`. This is a public test fixture, never a wallet for funds. Preserve this recipe and vector in future releases.

Expiry evicts Vault’s cache. Rehydration reproduces the password for the same active slot. A copied clipboard value has its own lifetime outside Vault’s cache.

## Reproduce the current manual workflow

The Password Bank tests in `make test-unit` cover device confirmation, wallet isolation, encrypted backup recovery, legacy and current password generation, rotation journaling, cache expiry and newest-first ordering. The MCP tests verify that retired password operations are rejected.

Run `bun __tests__/fixtures/password-mvp/server.ts` from the Vault package to start the in-memory UI fixture. Then run `smoke.mjs` in the same directory to check masked Copy, database failure handling and the one-step password change. The smoke runner accepts `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_TEST_MODULE` and `CHROME_EXECUTABLE` overrides.

## Historical automated validation (November 2026)

- The November MVP included tests for browser fill and agent operations.
- The full `make test-unit` suite passed: **3,036 Bun tests, zero failures**, plus the standalone flag checks. Tests that bind local REST ports required execution outside the filesystem/network sandbox.
- Vault frontend production build and backend bundle passed.
- BEX content/background TypeScript checks passed, and the complete nine-task production build passed.
- Headless Chrome exercised the actual settings drawer, navigation, bank generation/assignment, backup download/acknowledgment, guided rotation and live disable without page reload: zero page errors. [UI results](ui-results.json), [synthetic screenshot](ui.png).
- Ten BEX browser security assertions passed on intercepted synthetic HTTPS pages; no real account request was made. [Browser results](bex-browser-results.json).
- The i18n integrity/safety checks passed. New experimental text uses English fallback in other languages, recorded explicitly in the existing translation-debt baseline.
- Repository-wide TypeScript is not clean on the starting commit: the isolated baseline and MVP each reported 809 diagnostics. The newly added modules had no diagnostics. This is not represented as a passing repository typecheck.

## November 7 integration history

### Monero development integration (2026-11-07)

Integrated onto `feat/xmr-own-node` in `/Users/highlander/keepkey-toolchain/vault-xmr`, preserving its `20c6a339b` Monero baseline. Code candidate: `02e93e130`. Built and launched `_build/dev-macos-arm64/keepkey-vault-dev.app` from that checkout; the previously running node-development copy was closed gracefully. Both use the same existing application identifier and profile. No flag value or Monero configuration was migrated or auto-enabled. The paired live API confirmed Password Manager disabled, no bank and no profiles. No real website credential was changed.

- The combined password, provider lifecycle, and Monero settings and node checks passed **74 tests**. The November 7 branch included nine tests for the retired agent operations.
- The native package and frontend builds passed along with the localization audit. The synthetic browser UI test passed live enable and disable, backup gating and verification, with zero page errors.
- Eight [live API boundary checks](live-api-results.json) passed, including unauthenticated/browser-origin rejection, no CORS, no-store, hidden password tools while off and refusal to generate while off. The live flag was never enabled during these checks.
- The root full unit suite passed 3,036 tests before integration; the added agent group was also tested separately. Root TypeScript remains at the same 809 pre-existing diagnostics; no new password-module diagnostics remain.
- The full Monero checkout suite is **not green**: seven failing assertions were reproduced on unchanged `20c6a339b` with identical dependencies (three device-wipe transport cases, three typed-data/hdwallet cases and a static loopback-test check on the existing Monero node fixture). The isolated device-wipe process stalled after the failures and was terminated. Two Linux launcher timeouts in the concurrent build run passed when rerun alone. One provider lifecycle source-order assertion affected by integration was fixed and its whole group passed. Do not treat this as a clean signed-release candidate.

### Settings and physical Monero connection follow-up (2026-11-07)

`81b0e945f` fixes a reproduced mainnet watch-wallet startup race: Core's idle auto-refresh could take its RPC thread immediately after wallet creation, before Vault's address and watch-only checks. Vault disables idle auto-refresh before creation and schedules scanning itself. Removing that call reproduces the regression. A disposable public-address probe opened in about 2.5 seconds with the fix; the physical candidate then completed device consent and opened its watch wallet in the native app. The physical wallet was still scanning at handoff, from the previously saved block 3,799,129. Its address differs from the funded emulator profile; no payment was prepared, signed or broadcast.

Settings now has responsive category navigation, consistent cards and switches, readable system typography, a dedicated Monero node/storage/history page, and independent Monero and Password Manager feature switches. All 201 affected tests passed. The browser acceptance flows passed eight-category navigation, narrow layouts, live independent flags, password generation/assignment, backup/verification gates and live disable, with no page errors. The native app showed Monero on and Password Manager off; all eight live API boundary checks passed again without enabling passwords. Frontend, backend, worker and native packaging passed; i18n integrity passed with English fallback debt recorded. TypeScript still reports 806 existing diagnostics, the same as unchanged integrated source with identical dependencies; no new normalized diagnostic messages were introduced.

`0f6d56064` gives every feature row a matching icon badge. Its browser checks and frontend build passed. The updated frontend is staged for the next launch; the active Monero scan was left running. This follow-up does not satisfy the password hardware/recovery or real-service migration gates below.

Later physical-wallet follow-up: the user restored the funded wallet and set its PIN. Vault completed address/view-key/key-image approval and showed **Synced, 0.08465305 XMR, unlocked** at `44J3pVF3…`. `13419cd75` fixes automatic balance verification on receive-only hardware; `f9833f887` implements encrypted monitoring persistence. The feature-row icons are loaded in the native preview. No real payment was prepared, signed or broadcast. The [firmware subaddress handoff](../monero-subaddress-firmware-20261107/README.md) covers the remaining Feather destination support and hardware qualification.

Remaining hardware recovery, native supported-platform and real-service migration gates below still apply. Keep the password switch off until the operator explicitly enables a test.

1. On physical test hardware, check device labels/confirmations, PIN/passphrase handling, cancel, unplug, firmware compatibility and repeated derivation. Match the frozen vector where possible.
2. Restore a backup on a second/recovered test device and confirm active and staged passwords match exactly. Verify wrong passphrase and tampered backup failure. Check interrupted/cancelled generation preserves or burns the correct slots.
3. On dedicated test accounts, verify actual login and manual rotation, including form rejection, ambiguous submission and MFA. Confirm the Google, GitHub and Microsoft settings links open the expected pages.
4. Check the live toggle and lock cleanup in native Electrobun on supported release platforms, plus clipboard and secret-field behavior. The automated UI test used Chrome with a synthetic native-RPC bridge.
5. Record the release candidate hashes and test evidence before following the normal signing and release process. Keep the flag off by default.

## Deliberate MVP limits

Banks are scoped to the connected KeepKey and its verified wallet. Passwords have a fixed length and character policy. A website may require another password policy.

There is no persistent OS-keychain cache, mobile refill, iOS/Android credential provider, automatic rotation script library, imported-password storage or passkey recovery implementation in this MVP. Current mobile watch-only pairing is unchanged and does not carry secrets. Current firmware passkeys retain their separate recovery limitations. These are follow-up work, not functionality unlocked by the new switch.
