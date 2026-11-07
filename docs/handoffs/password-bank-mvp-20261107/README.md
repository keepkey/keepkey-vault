# Password bank MVP release handoff

The MVP adds a default-off **Password manager** switch in **Settings → Feature Flags**. Switching it on inserts the **Passwords** tab immediately. Switching it off removes the tab and clears the unlocked bank and password cache immediately. No restart or reload is required for either operation.

Vault implementation branch: `feat/password-bank-mvp`, based on Desktop 1.6.10. Companion BEX branch: `feat/password-bank-mvp` in the `keepkey-client` repository, commit `ece6fff`. Its isolated checkout is `/private/tmp/keepkey-password-bank-bex`; the complete unpacked build is in its `dist` directory. Release both changes together for browser fill. No release tag, signed app, store upload or production deployment was made.

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

New account assignment does not import an existing website password or change it. The generated candidate must be installed and verified through guided setup. Existing password entry/reauthentication and MFA remain the user's responsibility. Current-password BEX login fill stays unavailable in the UI until the user confirms setup.

## Try the actual app

1. Build/run the feature branch with `make dev` using the normal Vault workflow.
2. Open **Settings → Feature Flags → Password manager**. The switch is initially off. Enable it and observe the new navigation tab before closing settings.
3. Open **Passwords**, connect a test KeepKey, and select **Create with KeepKey**. Approve the device request. Generate a small bank and approve each entry.
4. Assign the exact login domain and account. Export the recovery backup, save it separately, and acknowledge that it was saved.
5. Use **Stage next password** to start guided setup/rotation. Export the updated backup containing both locations. Choose **Backup saved — begin website change** before submitting the site change. This records an uncertain/submitted state before the external mutation.
6. Open the account settings guide. Complete existing-password and MFA challenges yourself, set the staged password, and test a fresh sign-in. Check the sign-in acknowledgment in Vault and activate it only when it works. Save the new backup afterward.
7. Disable the switch while the password tab is open. The UI returns to the wallet and the bank locks, without restarting.

Use test accounts and a test wallet for initial acceptance. Physical KeepKey behavior and replacement-device recovery have not been exercised in this implementation session.

## Try BEX fill

Load `/private/tmp/keepkey-password-bank-bex/dist` as an unpacked extension in a dedicated Chrome profile, or build its branch normally with `pnpm build`. Pair it with this Vault and enable the existing **Agent mode** bridge. This MVP does not add a page-provider API, a generic password-reveal REST endpoint, or a new permission for arbitrary websites.

Open a matching HTTPS login/security page with a visible password field. In Vault, use **Find BEX login field** or, after starting a backed-up change, **Find BEX field for staged password**. Select the exact browser and field, then **Fill selected field**. Review and submit in the browser yourself. Fields expire after thirty seconds or navigation; discover them again when necessary.

The compatible extension is required: an older BEX has neither private field discovery/fill nor the new redaction behavior. Keep Agent mode's existing authorization separate from permission to change an account password. Browser fill is initiated only by this Vault UI, not by an agent request.

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

1. On physical test hardware, check device labels/confirmations, PIN/passphrase handling, cancel, unplug, firmware compatibility and repeated derivation. Match the frozen vector where possible.
2. Restore a backup on a second/recovered test device and confirm active and staged passwords match exactly. Verify wrong passphrase and tampered backup failure. Check interrupted/cancelled generation preserves or burns the correct slots.
3. On dedicated test accounts, verify actual login and guided rotation with the compatible extension, including browser navigation, form rejection, ambiguous submission and MFA. Confirm the actual Google/GitHub/Microsoft account settings match their guide.
4. Check the live toggle and lock cleanup in native Electrobun on supported release platforms, plus clipboard and secret-field behavior. The automated UI test used Chrome with a synthetic native-RPC bridge.
5. Merge and version the coordinated Vault/BEX changes, attach exact-candidate hashes and test evidence, then follow the normal signing/release process. Keep the flag off by default.

## Deliberate MVP limits

One bank per Vault installation; multi-chain firmware only; fixed 24-character Base64URL format; top-level light-DOM password fields only; user-confirmed guided website changes; no automatic username filling, unattended site submission or scheduled rotation. A website may require another password policy.

There is no persistent OS-keychain cache, mobile refill, iOS/Android credential provider, automatic rotation script library, imported-password storage or passkey recovery implementation in this MVP. Current mobile watch-only pairing is unchanged and does not carry secrets. Current firmware passkeys retain their separate recovery limitations. These are follow-up work, not functionality unlocked by the new switch.
