# Windows QA prep + update-flow safety (2026-08-11/12)

Working doc for the Windows QA push. Records what shipped, what changed in the
update flow and why, and what is still open.

---

## 1. Shipped and pushed (branch `develop`, `592a3a61..b51819b6`)

| Commit | What |
|---|---|
| `2bf6546d` | Pin pioneer-discovery `10.3.1 → 10.3.2`; add `spamFilter.test.ts` |
| `67fc9868` | Send form: native balance was labelled as the gas cost; low-gas gate rewritten |
| `b51819b6` | Dashboard: `"No balance"` → `0 BTC` / `0 ETH` |

### Scam filter (the reported bug)

Vault's spam filter treats *"is this CAIP in the pioneer-discovery catalog"* as the
only thing separating a real asset from a scam, so catalog defects are security
defects. Two were live and both are fixed in discovery `10.3.2`:

- **USDT on Gnosis** (`0x4ecaba58…`) was missing entirely — the catalog had zero
  USDT entries for `eip155:100` — so a real $110 balance rendered under
  "Suspected spam" with a `SCAM` badge.
- **`eip155:56/bep20:0x5e0a1d87…`** was present *as* `USDT` while the contract
  declares `USD.T` / "TENTER USD.T" and is unlisted on CoinGecko. We were
  whitelisting a Tether lookalike on BSC and promoting it into the real ticker.

`src/shared/spamFilter.test.ts` covers the 16 canonical USDT/USDC issuer contracts
across every documented chain, plus the TENTER contract as a regression case.

The repeatable gate lives in the pioneer repo:
`modules/pioneer/pioneer-discovery/scripts/audit-symbol-integrity.mjs` — 129
high-risk-symbol entries checked against on-chain `symbol()`/`decimals()` on 9
chains, exit 1 on any unexplained mismatch. Publish/rollout steps:
`/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer/HANDOFF-DISCOVERY-STABLECOIN-INTEGRITY-PUBLISH.md`

### Send-form gas

`Gas: 0.022306 ETH` was rendering `balance.balance` — the user's ETH balance, not a
fee. Relabelled to "Balance". The low-gas gate keyed off `nativeBalanceUsd`, which
is derived by subtraction (chain total − tokens − defi) and collapses to ~0 when
token USD is double-counted, so it warned users who had plenty of gas. It now gates
on native balance being zero; real sufficiency is enforced in `buildEvmTx`, which
throws with actual `gasPrice * gasLimit` numbers.

**Behaviour change to QA:** a *dust* native balance (nonzero but under the fee) no
longer warns up front. It fails at Build with an accurate message
(`Insufficient ETH for gas: have X, need ~Y`).

---

## 2. Firmware finding — EIP-1559 signing is broken on shipped firmware

Diagnosed from a failed Base swap via BEX. **Not a vault or BEX bug.**

- Device-reported digest `0x805495…` recovers to the correct account.
- Host-serialized digest `0xe0b77f…` recovers to garbage `0xa047…`.
- Device pre-image reconstructed byte-exactly as `0x02 || f84c || 05 || …`: the RLP
  list header is sized for a 3-byte chainId (`0x82 0x21 0x05`) but only the LSB
  `0x05` is hashed.

Ruled out first: chainId values 0–70k, legacy-vs-1559 shapes, swapped fee fields,
zero-padded/non-minimal encodings, accessList variants, list-length deltas ±10.

**Scope:** chainId ≥ 256 only — Base (8453), Arbitrum (42161), Avalanche (43114).
Ethereum/Optimism/BSC/Polygon/Gnosis/Monad are unaffected.

**Status:** fix commit `ed6db167c` (2026-05-20) is **NOT in v7.14.1**, the current
public release. Earliest tag containing it is `v7.15.0-rc17`. Only `v7.14.0` and
`v7.14.1` exist on the 7.14 line, so **every user on shipped firmware is affected**
until 7.15 ships.

Vault is immune by construction — `src/bun/txbuilder/evm.ts` only ever emits legacy
`gasPrice`. **BEX is the exposed surface** because it sends `maxFeePerGas`. Until
7.15 releases, the only remedy for shipped users is the host-side guard: force
legacy `gasPrice` when `chainId >= 256`, as the vault swap paths already do.

---

## 3. Update flow — "it looks like my KeepKey was wiped" (MOST SENSITIVE)

### Root cause

`engine-controller.ts`, `getDeviceState()`:

```ts
const initialized = features ? (features.initialized ?? false) : true
```

The featureless gap (device detached/reconnecting) was already handled. The
remaining hole: features arriving **with `initialized` undefined** — a partial read
during the post-flash reboot — resolved to `false`, so `needsInit` became true and
the wizard auto-navigated to `init-choose` ("set up your wallet"). Nothing had
happened to the seed; the user simply updated firmware and was shown a screen
offering to create a wallet.

### Decisions taken (product calls, confirmed)

1. **Ambiguous read → assume initialized.** Only an explicit `initialized === false`
   means "no wallet". The two errors are not symmetric: wrongly offering setup
   terrifies people about lost funds; wrongly skipping it just means a genuine new
   device continues into the app and sets up from there. Fail closed.
2. **Never auto-navigate to create/recover after a firmware update.** Always land on
   a neutral "Update complete" card; reaching setup takes a deliberate click.
3. **Guard the create path.** A device seen initialized this session requires an
   explicit confirm that names the wipe risk.
4. **Skip copy:** lead with why updating matters, then state plainly that skipping
   is safe and reversible.

### Implemented

- `engine-controller.ts` — `features.initialized !== false`. Genuine out-of-box
  devices are still detected via `isOob`, which uses firmware presence/version and
  does not depend on this field.
- `OobSetupWizard.tsx` — new `update-done` step. Both post-flash routes (the reboot
  effect and the post-flash auto-advance) now land there instead of branching on
  `needsInit`. The card states the wallet is untouched *before* the user can reach
  anything mentioning wallet creation; Continue routes onward.
- `OobSetupWizard.tsx` — `everSeenInitializedRef` (sticky for the session). The
  Create tile checks it and raises a confirm naming the wipe risk, with "Go back" as
  the primary action.
- `OobSetupWizard.tsx` — firmware skip is now "Skip for now", wrapped in a why-update
  line above and a skipping-is-safe line below.

New copy uses inline `defaultValue`, so nothing breaks untranslated. **Locale files
were deliberately not touched** — `en/setup.json` and 16 others are mid-edit by the
device-authenticity work. Keys to add later:
`firmware.whyUpdate`, `firmware.skipForNow`, `firmware.skipIsSafe`,
`updateDone.title`, `updateDone.reassure`, `updateDone.continue`,
`initChoose.wipeConfirm{Title,Body,Cancel,Proceed}`, `stepDescriptions.updateDone`,
`btcAccountType.{recommendation,learnMore,hide,explainer}`.

### QA script for this flow

1. Initialized device on old firmware → update → **must** land on "Update complete",
   never on create/recover.
2. Same, but yank and replug during the reboot window (forces the partial features
   read) → still must not offer setup.
3. Genuine OOB device (factory 4.0.0) → update → Continue → **must** reach setup.
4. Wiped device → must still offer setup (explicit `initialized === false`).
5. From `init-choose` on a device with a wallet → Create → confirm appears, "Go back"
   is primary, "Replace wallet" proceeds.

---

## 4. Bitcoin account types — "which one is right?"

`BtcXpubSelector.tsx` now carries a recommendation plus an expandable explainer:
default to Native SegWit (bc1…) for lowest fees and broadest modern support; SegWit
(3…) for services that reject bc1; Legacy (1…) works everywhere but costs most.
States explicitly that all three hold real bitcoin from the same recovery phrase and
switching is not risky — replacing "there's no wrong answer", which users read as the
app dodging the question.

---

## 5. Windows installer — NOT started, needs the installer source

Both remaining issues happen **before the app runs**, so `SplashScreen.tsx` cannot
help and no fix belongs in this repo as far as I can tell — there is no NSIS/installer
script under `scripts/` and no `taskkill`/`bun.exe` handling anywhere.

1. **Defender scan 4–5 min with no window.** Installer shows nothing while Defender
   scans, so the app appears hung. Needs an installer-level splash/progress UI.
   Worth testing whether signing/reputation or an exclusion shortens the scan at all
   — the 4–5 min figure should be measured on a clean VM, not assumed.
2. **`bun` survives a double install.** A second install does not kill the running
   `bun` process, the install fails, and the user has to reboot. Installer needs to
   detect and terminate running processes (or refuse cleanly with an explanatory
   message) instead of failing halfway.

**Blocked on:** pointer to the Windows installer repo/config, and a Windows box for
verification. Both are install-time-only and will dominate first impressions in QA,
so they are the highest-value remaining items.

---

## Open / not done

- Windows installer items above (§5) — blocked.
- Locale keys for the new copy (§3) — deferred to avoid conflicting with in-flight
  locale edits.
- BEX host-side `chainId >= 256` legacy guard (§2) — different repo; not started.
- Hyperliquid is unaudited by the discovery integrity gate: `chains.ts` lists chainId
  **2868** but HyperEVM is **999**, and CoinGecko's hyperliquid USDC "address" is
  32 hex chars, not an EVM address. Nothing on that chain is verified.
- None of §3/§4 has been exercised on a real device yet — `make vault` is a user-run
  step. The QA script in §3 is the intended verification.
