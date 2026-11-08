# Main-agent handoff: unified Zcash UI and password MVP

User requested a handoff and to move on. Stop feature work here; this document records the completed work and remaining verification. Do not resume real-account password rotation without a new instruction.

## Current repositories and integration

- Source workspace: `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11`, branch `feat/password-bank-mvp`.
- Zcash implementation commit: `5fcd04eae` — `feat: unify Zcash pools under standard asset actions with collapsed tools`.
- User's active development checkout: `/Users/highlander/keepkey-toolchain/vault-xmr`, branch `feat/xmr-own-node`.
- Integrated Zcash commit: `d817a51bc`. It remains an ancestor of the active checkout's HEAD.
- At handoff inspection, active HEAD was `6d44b3b95` (`docs: record live Monero saved-access and candidate preview verification`). That checkout has since accumulated substantial **uncommitted Monero work owned by another task**, including backend, UI, translations, tests, subaddress fixtures and handoff evidence. Preserve it. Do not reset, stash, overwrite, or reapply this integration blindly.
- The source workspace has unrelated untracked handoff directories. They were left untouched. Zcash implementation files are committed.

## User intent and resulting Zcash behavior

The user wanted the separate Zcash Privacy experience combined with the normal transparent asset page, using the rest of Vault's UI and hiding most custom Zcash controls by default.

Implemented:

- One Zcash asset page with normal **Receive / Send** actions; removed the separate **Privacy** action pill.
- Explicit **Transparent · public** and **Shielded · private** balance/source buttons. Standard Zcash entry defaults to transparent. Existing shielded-token deep links select the shielded pool in this same page.
- Both balances stay distinct. Missing or unverified private balance remains unknown, not zero; transparent refresh is not represented as a private scan.
- Shielded Receive uses the normal asset styling: unified address, QR, copy, device verification and a concise verification-time hint.
- Shielded Send retains existing transaction builders, address validation, public-recipient/TEX warnings, memo restrictions, signing progress, and device review. Its extra summary is collapsed under **Transaction details**.
- Shield/unshield, sync, history and technical controls are behind **Zcash tools and details**, closed by default. Explicit legacy `privacy` deep links open the tools within the unified page.
- Selecting shielded never falls through to transparent Receive/Send when the privacy flag is disabled, firmware is unsupported, or a wallet is watch-only. An unavailable message stays in the selected private context until an explicit pool change.
- The fixed shielded account is shown as account 0; the transparent account selector and public-address explorer link are hidden while using the shielded pool.
- The synthetic shielded coin is no longer repeated as another token row within this Zcash page. Dashboard links still work.
- Embedded shielded forms use shared app fonts/colors and no longer inject Google Fonts. No new backend transaction behavior or feature flag was introduced. Existing Zcash privacy enablement is preserved.

## Files

All under `projects/keepkey-vault/`:

- `src/mainview/components/AssetPage.tsx`: shared actions, pool selection, deep-link handling, guarded rendering, header and token-list integration.
- `src/mainview/components/ZcashBalanceSummary.tsx`: compact, selectable public/private balances.
- `src/mainview/components/ZcashPrivacyTab.tsx`: embedded presentation, controlled page navigation, collapsed tools/details, simplified receive card. Standalone presentation remains available internally.
- `src/mainview/components/zcash-v2-styles.ts`: shared-token styles for embedded mode; scoped button/layout/mobile adjustments.
- `src/shared/zcash-privacy.ts`: shared pool type.
- `src/shared/chains.ts` and `src/mainview/components/SendForm.tsx`: comments updated for the unified flow.
- `src/mainview/i18n/locales/en/ui.json` and `scripts/i18n-baseline.json`: five new experimental English strings; other languages use the established, explicitly recorded fallback policy.
- `__tests__/fixtures/zcash-unified/{server.ts,entry.tsx,index.html,smoke.mjs}`: repeatable browser fixture exercising real components with synthetic native RPC. It does not load the app DB, device or real funds. Its mocked signing/building operations refuse execution.

## Validation completed

- Zcash balance, pending/maturity, capability and transaction-builder tests: **45 passed, zero failures** across eight files.
- Source workspace asset/watch-only/selected-token guard tests: **34 passed, zero failures** across three matched test files.
- Integrated checkout Zcash/Monero asset UI, shared routing and balance checks: **71 passed, zero failures**, 232 assertions across seven files.
- Integrated UI catalog integrity passed for all 15 languages.
- Integrated `bun run build` passed, including backend bundle, frontend production build, dependency collection, Electrobun app packaging and bundle patching. This was an unsigned development build.
- The synthetic browser workflow passed **13 checks** against the integrated checkout, including public/private routing, default-collapsed controls, visible public-recipient warnings, live disable in Send and Receive, explicit pool changes, watch-only and unsupported-firmware deep links, legacy privacy links, and a 390px layout with no horizontal overflow. Zero page errors. See [results](ui-results.json), [desktop](shielded.png), [mobile](mobile.png), and [transparent](transparent.png). Images and addresses are synthetic; the fixture substitutes a simple Zcash logo for remote image requests.
- Root repository TypeScript had 809 pre-existing diagnostics before this work. A check during this change reported 806 after removing three pre-existing unused/bad imports; the new pool-selector type errors found during implementation were fixed. This is **not** a passing repository-wide typecheck.
- No real Zcash transaction, device address verification or Google password change was performed during this UI task.

The shared AssetPage merge explicitly retained Monero's imports, header balances/status, standard Send/Receive sections, node panel, and the newer multisig gating. It did not restore an obsolete multisig flag state. The integrated UI tests and browser fixture were run after resolving these conflicts.

## Runtime status: needs inspection before any further action

The app package built successfully at:

`/Users/highlander/keepkey-toolchain/vault-xmr/projects/keepkey-vault/_build/dev-macos-arm64/keepkey-vault-dev.app`

The then-running development backend, PID `51459`, was gracefully sent SIGTERM after the build and tests passed. A subsequent tool cell attempted to launch the rebuilt app, check the password flag through the paired local API, and stop the synthetic server. **The turn was interrupted while that cell was pending.** Its launch/verification/cleanup results were not received. `/private/tmp/zcash-unified-live.log` exists, but no successful REST-start marker was established in the handoff inspection. Do not claim the updated app is currently running based on this task's evidence. The other Monero task may have rebuilt or relaunched it since then.

If runtime work is resumed, first identify the current app process, port 1646 owner and checkout. Coordinate with the main agent's newer Monero work. Do not use the stale PID or replace a running app without checking current state. The synthetic server, if still present, is `bun __tests__/fixtures/zcash-unified/server.ts` on port 5199; it is separate from the real app.

Temporary validation logs (may be removed later):

- `/private/tmp/zcash-unified-integrated-smoke.log`
- `/private/tmp/zcash-unified-xmr-tests.log`
- `/private/tmp/zcash-unified-xmr-build.log`
- `/private/tmp/zcash-unified-tests.log`
- `/private/tmp/zcash-unified-tsc-final.log`

To repeat the browser fixture, run `bun __tests__/fixtures/zcash-unified/server.ts` from the desired Vault package, then run its `smoke.mjs` from a writable artifact directory. It accepts `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_TEST_MODULE` and `CHROME_EXECUTABLE`. Existing Playwright packages were available under `/private/tmp/keepkey-support-venice-20261107/node_modules/`; Chrome was `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

Remaining UI verification is native Electrobun inspection on supported platforms and physical-device/real-wallet validation. No signed release, tag, push, store upload or deployment was made. The active checkout's newer changes have not been revalidated by this task.

## Password work to preserve

The earlier password implementation and audit are described in [password MVP release handoff](../password-bank-mvp-20261107/README.md) and the existing `docs/handoffs/passwords-passkeys-mobile-20261107/` audit/design directory in the source workspace. The latter directory remains untracked; do not discard it.

- User explicitly required **Password Manager to have its own default-OFF, live feature flag**, independent of Monero. `password_manager_enabled` must never be inferred from `monero_enabled`. Turning it on/off updates the UI without restarting; off locks the bank/cache and hides agent tools.
- The user confirmed `coinmastersguild@gmail.com` as the Google practice account, but **no actual password was changed**. Leave this work inactive while the user moves on.
- Password inventory separates cache expiry/rehydration from website rotation. Device-derived entries and an encrypted recovery manifest are required for recovery; seed alone does not identify the random bank/assigned locations. Native approval protects opaque BEX fills; the agent does not receive password values. Rotation requires backup, submission journaling and fresh-login verification before activation.
- Product-distributed helper skill: `skills/keepkey-password-migration/SKILL.md`; compact service recipes for Google/GitHub/Microsoft are exposed by the password agent API.
- Chrome's ordinary extension APIs do not expose the entire saved-password or private compromise inventory. Findings in this MVP are explicitly user-reported with provenance, not an automatic Chrome scan.
- Compatible load-unpacked BEX package: source workspace `artifacts/password-bank-mvp/bex`; ZIP and build metadata sit beside it. Companion source checkout: `/private/tmp/keepkey-password-bank-bex`, commit `b3bc0258813fa34b0eb6060ba3b5d03206fd5da6` (protected fill implementation `ece6fff`).
- A paired local-agent token exists in source workspace `artifacts/password-migration-agent/token.json`, owner-only. It is intentionally uncommitted. **Do not print, copy into a handoff, or commit this token.** CLI path: `projects/keepkey-vault/scripts/password-agent-cli.ts`.
- The previously completed password live check showed disabled with no bank/profiles; the final interrupted restart did not re-establish that live result. Preserve the default-off requirement in future builds.

Historical release qualification: the password handoff records pre-existing Monero suite failures, physical recovery and real-service test gates. Those observations predate the other task's latest Monero changes; reassess current state rather than assuming they still fail or have been fixed.
