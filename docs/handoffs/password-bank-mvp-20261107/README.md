# Password bank MVP release handoff

The MVP adds a default-off **Password manager** switch in **Settings → Feature Flags**. Switching it on adds **Passwords** inside the existing lock button’s **Vault** panel immediately, alongside **Seed vault (BIP-85)**. Switching it off removes that section and clears the unlocked bank and password cache immediately. No restart or reload is required for either operation.

This flag is independent of Monero: `password_manager_enabled` is never inferred from `monero_enabled`. Integrating the MVP into the Monero development build does not enable passwords or change Monero settings. Password tools disappear from MCP discovery when disabled; calling them cannot unlock a bank or contact hardware. The metadata status endpoint can still report `disabled` with no account list.

The simplified password UI and automatic backups build on the integrated Desktop implementation. The compatible BEX is now included in the reviewed local `keepkey-client` **develop** candidate `8322d6f`. It is built into that repository's existing `dist` folder, so the existing unpacked Chrome extension entry can be reloaded. Its `docs/develop-candidate-20261108.json` records all 16 open PR dispositions: 14 integrated, two dependency upgrades held. The initial isolated password branch/package remains available for historical reproduction. No release tag, signed app, store upload or production deployment was made.

## Simple list, recovery and native reveal

The default view contains **Add password** and the saved account list. Adding an account automatically unlocks/creates the bank, generates the required entries with KeepKey approval, assigns the login domain and account, and saves encrypted backups. Changing a password prepares its new location automatically; opening its website saves the backup before recording submission. A disk failure blocks the website step. Final activation still requires an explicitly verified password sign-in. Passkey/Touch ID login does not verify the generated password.

Backups are written to **Documents/KeepKey Password Backups**: directory mode 0700, exclusive random-named files mode 0600, file and directory fsync before revision acknowledgment. Earlier exports remain available. Recovery instructions, manual save, restore and lock controls are under **Options**. A local backup still needs to be copied to separate storage alongside the recovery plan.

Each staged or verified password has a masked field, eye control and copy control. Masking fetches no secret. Only an explicit native eye action fetches its temporary value; copy becomes available after revealing. The value is hidden on window blur, page hiding, or expiry (at most 30 seconds). Native agent APIs still cannot reveal passwords or activate rotations.

All 61 affected password/emulator tests pass (39 focused password checks plus emulator session, PIN and startup-recovery checks). Synthetic UI checks cover the simple list, automatic backup, failed-backup blocking, eye masking, explicit clipboard copy, blur/expiry hiding, narrow layout, both lock-panel tools, focus restoration and live feature flags. No new TypeScript file/code diagnostics were introduced against the 803-diagnostic existing baseline. Native eye/reveal and clipboard behavior was also confirmed by the owner in the preview.

The native test exposed an intermittent blank emulator window: the firmware process remained running, but its WebView never posted readiness. Reopening only its display recovered the session without replacing the wallet. Startup now retries unready HTML loads within the existing deadline, stops on readiness/close/replacement, and uses a per-load identifier so a stale readiness response cannot enable JavaScript delivery into a newer load. The bridge uses its bound IPv4 loopback address directly.

## Native emulator acceptance on November 8

Password manager and BIP-85 now share the existing lock button’s Vault panel. No Passwords tab is added to the top navigation. The independent flag shows or hides the password section immediately; BIP-85 remains available with the flag off.

Fixed the missing emulator approval controls: password derivation now uses the existing interactive emulator confirmation gate. Physical KeepKeys retain firmware confirmation. All 36 password tests pass, including three new approval/cancellation regressions; the browser fixture covers both tools behind the lock, backup and verification gates, and live feature disable. TypeScript remains at 803 existing diagnostics.

The running development preview passed 19 native checks on the fresh disposable `password-mvp-qa-20261108` emulator wallet. These covered visible Confirm/Reject controls, rejected generation without a usable entry, three separately approved entries, test-account assignment, backup-gated staging and cancellation before website changes, owner-only encrypted backups, lock/unlock, cache eviction, one-minute expiry, approved rehydration, live disable and hidden agent tools, independent Monero state, and encrypted SQLite metadata. At this initial checkpoint, no website credential was changed and no password value was printed. Physical hardware and real-service acceptance remain separate.

Local evidence is under `/private/tmp/vault-develop-evidence-20261108/`; encrypted test backups are owner-only under `/private/tmp/vault-password-manager-test-20261108/` and must not be committed. The test bank remains bound to the disposable wallet; it is not a bank for the funded Monero wallet.

## Included functionality

- Create/unlock a hardware-derived password bank using existing multi-chain KeepKey firmware's `CipherKeyValue` command. Each derivation requires device confirmation. Bitcoin-only firmware is refused.
- Generate 1–8 ready entries per request. Passwords contain 24 Base64URL characters. Assign each slot to one exact HTTPS domain and account; retired/cancelled slots are never reused.
- Persist the account registry and rotation journal only as authenticated AES-256-GCM ciphertext. No metadata-unwrapping key or password is persisted. SQLite compare-and-swap prevents another Vault instance from overwriting a stale bank or reusing its allocation range.
- Keep generated passwords in a session cache, with selectable 1/5/15-minute lifetime and a fifteen-minute absolute unlock limit. Lock, disconnect, wallet-session change, feature disable or app exit evicts that session. Rehydrate an assigned entry through another device confirmation.
- Export and restore an encrypted recovery manifest. Recovery needs the same seed, wallet passphrase and manifest. Imports cannot overwrite an existing local bank.
- Track account review intervals and guide changes through stage → save backup → begin website change → manually verify fresh sign-in → activate. An uncertain submitted change retains both locations and cannot be casually cancelled.
- Open bundled Google, GitHub and Microsoft security-page guides. These are guided workflows, not automated password-changing scripts.
- Discover compatible BEX password fields, choose a browser/document/field, and explicitly fill the current or staged password through a one-use, thirty-second UI grant. Fill does not explicitly submit the form. Exact trusted login/settings origins are checked in Vault, extension background and content script; cross-origin forms and stale documents are refused.
- Reserve the private BEX fill namespace from MCP. Generic agent tools do not receive the password. The companion extension redacts password/OTP fields and known secret echoes, suppresses diagnostic reads on protected documents, and blocks screenshots of protected password documents, including after background-worker restart.
- Expose paired, loopback-only password agent operations through MCP and `/api/v1/passwords`: bounded metadata inventory, separate cache/refill and account rotation status, versioned Google/GitHub/Microsoft helpers, generation/assignment/rehydration, backup and rotation staging. Password values and final activation are not agent operations. A requested fill must be approved in native Vault for each exact browser/document/field.
- Record explicitly user-reported compromised/reused/weak findings with provenance and prioritize them. Findings resolve when the affected password is replaced and verified; unknown remains not assessed. Chrome's private compromise API is not exposed to ordinary BEX, and the MVP does not scan Chrome's saved credentials.

The repository-distributed [migration skill](../../../skills/keepkey-password-migration/SKILL.md) uses `projects/keepkey-vault/scripts/password-agent-cli.ts`. `save-backup NEW_FILE` writes the encrypted manifest with exclusive creation, owner-only permissions and fsync before acknowledging the saved revision. Tokens and backups must not be committed or printed. Service recipes were checked against official [Google](https://support.google.com/accounts/answer/41078), [GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/updating-your-github-access-credentials), and [Microsoft](https://support.microsoft.com/en-us/accounts-billing/manage/change-your-microsoft-account-password) instructions; exact forms still require live testing.

New account assignment does not import an existing website password or change it. The generated candidate must be installed and verified through guided setup. Existing password entry/reauthentication and MFA remain the user's responsibility. Current-password BEX login fill stays unavailable in the UI until the user confirms setup.

## Try the actual app

1. Build/run the feature branch with `make dev` using the normal Vault workflow.
2. Open **Settings → Feature Flags → Password manager**. The switch is initially off. Enable it and observe the lock button update before closing settings.
3. Open the lock button → **Passwords** → **Add password**, enter the login domain/account, and select **Create password**. Approve the requested device operations.
4. Vault saves encrypted recovery backups automatically. Copy the backup folder to separate storage; recovery needs this manifest as well as the wallet seed/passphrase.
5. Choose **Open website** to begin the backed-up change. Complete current-password authentication/MFA yourself. Use **Fill in browser** for the new and confirmation fields, review the account, and submit the website change.
6. Test a fresh sign-in using the generated password. In Vault, check the successful-sign-in acknowledgment and select **Finish** only when that password works. Vault saves the updated backup automatically. Until then both locations remain recorded.
7. Use the eye to reveal the staged/verified password and the copy icon to copy it. Values hide on blur or timeout. Disabling the feature immediately removes Passwords and locks the bank; BIP-85 remains available.

Use test accounts and a test wallet for initial acceptance. Physical KeepKey behavior and replacement-device recovery have not been exercised in this implementation session.

## Try BEX fill

Reload the existing unpacked entry pointing to the sibling `keepkey-client/dist` candidate and enable its existing **Agent mode**. The version remains 0.0.38; `dist/keepkey-develop-candidate.json` records the source commit and artifact hashes. This adds no page-provider password API or generic password-reveal REST endpoint.

Open the matching HTTPS login/security page. In Vault choose **Fill in browser**. A single matching field is filled directly from that explicit action; multiple fields require selection. Native generation/rehydration runs before field discovery so approval time does not consume a discovered field's short lifetime. Agent-initiated fills still require individual approval in native Vault. Fields expire after thirty seconds or navigation; discover again when necessary.

The compatible extension is required: an older BEX has neither private field discovery/fill nor the new redaction behavior. Keep Agent mode's existing authorization separate from permission to change an account password. Agent requests can queue a fill but cannot approve themselves; only native Vault approval permits the exact document-bound fill.

## Chrome saved credential inventory boundary

Ordinary webpages and extensions cannot enumerate Chrome's saved-password vault, including a metadata-only list of every saved account matching the current page. Chromium restricts its `passwordsPrivate` permission to browser components; it is not a permission BEX can acquire through its manifest. Chrome's autofill chooser is browser UI, separate from the webpage DOM. [Chromium permission definitions](https://raw.githubusercontent.com/chromium/chromium/main/chrome/common/extensions/api/_permission_features.json), [extension security boundaries](https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/security_faq.md).

An extension with host access can inspect the page's login fields and values after fill; masking an input visually does not make its value secret from the destination page. BEX redacts password values from agent observations and does not turn an observed username into an assertion that it knows every saved account for that site.

For a rotation inventory, a separate native Vault importer could read only site/account metadata from a user-selected, supported Chrome profile database, subject to operating-system file access and schema compatibility. This is an inference from Chromium's separate URL/username/encrypted-password columns; it is not a supported extension API and is not implemented by this build. [Chromium login database](https://raw.githubusercontent.com/chromium/chromium/main/components/password_manager/core/browser/password_store/login_database.cc).

The user can also view saved entries in Chrome Password Manager. Chrome's CSV export contains actual password values, so it must not be described as a metadata-only export. [Chrome import/export documentation](https://support.google.com/chrome/answer/13068232?hl=en).

## Recovery and expiry contract

The implemented scheme is **`keepkey-ckv-base64url-v1`**, not BIP85. It intentionally works with existing firmware and does not export a seed or a bank-wide password derivation root.

For bank ID `b` and slot `i`:

```text
Metadata path: m/10016'/11'/0'
Metadata label: "KeepKey Password Bank v1 " + b + " unlock"
Password path: m/10016'/11'/1'/i'
Password label: "KeepKey Password Bank v1 " + b + " slot " + decimal(i)

CipherKeyValue: encrypt=true, ask_on_encrypt=true, ask_on_decrypt=true
               value=32 zero bytes, explicit IV=16 zero bytes

Metadata AEAD key: SHA256(UTF8("keepkey-password-bank/v1/metadata") || device_output)
Password: Base64URL(SHA256(UTF8("keepkey-password-bank/v1/password") || device_output))[0:24]
```

The device cipher's E1/D1 flags participate in its key derivation; they are part of the immutable recipe. The random 128-bit bank ID is retained in the encrypted backup envelope. AES-GCM uses a fresh 96-bit IV and binds `keepkey-password-bank/1/<bankId>` as associated data. The envelope contains format/version, bank ID, IV, ciphertext and tag; account labels and locations are encrypted.

A frozen software vector uses the public BIP39 `abandon` × 11 + `about` mnemonic with an empty passphrase, bank ID `00000000000000000000000000000001`, and slot 7. Firmware-compatible CKV output is `f175ad6c34511e75dda60261f56eb57a6bf72384d793e014c62f880530692175`; the password is `mtzY2TVqtboJQbQv9lwjlIrT`. This is a public test fixture, never a wallet for funds. Preserve this recipe and vector in future releases.

Expiry evicts Vault's cache; it does not change the website password. Rehydration reproduces the same active slot. A copied clipboard value or a value filled into a website is outside that cache's lifetime. The browser keeps redaction context for a protected document until navigation; no password bank is stored in browser localStorage or extension sync storage.

## Automated validation

- The password-bank and fill tests are included in `make test-unit`: default-off/no-device-access, live disable, frozen derivation vector, encrypted metadata, replacement-session recovery, wrong seed, tamper rejection, expiry/rehydration, stale wallet and in-flight feature changes, backup/rotation journaling, concurrent bank access, exact-origin matching, document/browser binding, one-use/expired grants, stale-slot grants and the private MCP boundary.
- The full `make test-unit` suite passed: **3,036 Bun tests, zero failures**, plus the standalone flag checks. Tests that bind local REST ports required execution outside the filesystem/network sandbox.
- Vault frontend production build and backend bundle passed.
- BEX content/background TypeScript checks passed, and the complete nine-task production build passed.
- Headless Chrome exercised the actual settings drawer, navigation, bank generation/assignment, backup download/acknowledgment, guided rotation and live disable without page reload: zero page errors. [UI results](ui-results.json), [synthetic screenshot](ui.png).
- Ten BEX browser security assertions passed on intercepted synthetic HTTPS pages; no real account request was made. [Browser results](bex-browser-results.json).
- The i18n integrity/safety checks passed. New experimental text uses English fallback in other languages, recorded explicitly in the existing translation-debt baseline.
- Repository-wide TypeScript is not clean on the starting commit: the isolated baseline and MVP each reported 809 diagnostics. The newly added modules had no diagnostics. This is not represented as a passing repository typecheck.

The repeatable synthetic UI fixture is `projects/keepkey-vault/__tests__/fixtures/password-mvp/server.ts`; it runs a separate in-memory bank and never opens the app database. Run it with Bun from the Vault package. `smoke.mjs` in the same directory accepts `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_TEST_MODULE` and `CHROME_EXECUTABLE` overrides. The BEX branch includes `scripts/test-password-bank-browser.mjs` and its test-only bundling entry; it accepts `PLAYWRIGHT_MODULE` and `CHROME_EXECUTABLE`.

## Before the next signed release

### Monero development integration (2026-11-07)

Integrated onto `feat/xmr-own-node` in `/Users/highlander/keepkey-toolchain/vault-xmr`, preserving its `20c6a339b` Monero baseline. Code candidate: `02e93e130`. Built and launched `_build/dev-macos-arm64/keepkey-vault-dev.app` from that checkout; the previously running node-development copy was closed gracefully. Both use the same existing application identifier and profile. No flag value or Monero configuration was migrated or auto-enabled. The paired live API confirmed Password Manager disabled, no bank and no profiles. No real website credential was changed.

- Final combined password, provider lifecycle, and Monero settings/node checks: **74 passed, zero failures**. The nine new agent tests include independent default-off flags, live MCP catalog visibility, metadata filtering, no secret output, revision checks, native approval, rejection/expiry and disabled fill rejection.
- Integrated backend/native package build and frontend production build passed; combined i18n integrity passed. The synthetic browser UI test again passed live enable/disable without reload and guided backup/verification gates, with zero page errors. The migration skill passed its format validator.
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
3. On dedicated test accounts, verify actual login and guided rotation with the compatible extension, including browser navigation, form rejection, ambiguous submission and MFA. Confirm the actual Google/GitHub/Microsoft account settings match their guide.
4. Check the live toggle and lock cleanup in native Electrobun on supported release platforms, plus clipboard and secret-field behavior. The automated UI test used Chrome with a synthetic native-RPC bridge.
5. Merge and version the coordinated Vault/BEX changes, attach exact-candidate hashes and test evidence, then follow the normal signing/release process. Keep the flag off by default.

## Deliberate MVP limits

One bank per Vault installation; multi-chain firmware only; fixed 24-character Base64URL format; top-level light-DOM password fields only; user-confirmed guided website changes; no automatic username filling, unattended site submission or scheduled rotation. A website may require another password policy.

There is no persistent OS-keychain cache, mobile refill, iOS/Android credential provider, automatic rotation script library, imported-password storage or passkey recovery implementation in this MVP. Current mobile watch-only pairing is unchanged and does not carry secrets. Current firmware passkeys retain their separate recovery limitations. These are follow-up work, not functionality unlocked by the new switch.
