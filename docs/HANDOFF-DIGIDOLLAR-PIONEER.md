# Handoff: Pioneer work required for DigiDollar

Vault PR #451 and firmware PR #846 establish the host safety guard and the
firmware 7.17 DigiByte Taproot capability. DigiDollar must remain hidden until
Pioneer provides the following backend pieces.

## Existing staging work

The Pioneer `feat/taproot` worktree contains commit `bbe0aa19b`, which adds a
separate `FEATURE_TAPROOT_DGB` gate and the BIP-86 account
`m/86'/20'/0'`. Its path test passes. This commit has deliberately not been
opened as a Pioneer PR.

The same worktree contains `HANDOFF-DGB-DD-INDEXING.md` with the indexer and
node contract. DigiDollar needs a dedicated indexer because DD value is stored
in transaction metadata on zero-satoshi P2TR outputs and is invisible to the
normal Blockbook balance model.

## Required before Vault exposure

- Ship the DGB BIP-86 path and `tr(xpub)` Blockbook discovery behind a device
  firmware check for 7.17.0 or newer.
- Provide DD balances, confirmed DD UTXOs, transaction history, collateral
  positions, oracle price, and indexer health through authenticated Pioneer
  endpoints.
- Preserve integer cents end to end. Do not represent DD amounts as DGB
  satoshis or floating-point dollars.
- Exclude zero-satoshi DD carrier outputs and locked collateral from ordinary
  DGB spendable balances.
- Do not expose mint or redeem until firmware supports and reviews the required
  Taproot script paths. Key-path transfer support does not imply script-path
  redemption support.

## Acceptance

1. `FEATURE_TAPROOT_DGB` off returns only existing DGB accounts.
2. The gate on returns exactly `m/86'/20'/0'` as `p2tr` with a plain xpub.
3. A known `tr(xpub)` resolves to matching `dgb1p` addresses on the self-hosted
   Blockbook backend.
4. A known DD transfer reports the exact cent balance and never enters the DGB
   UTXO selector.
5. The API refuses or withholds DigiDollar signing flows for firmware below
   7.17.0.

## Emulator evidence (2026-09-21)

Vault loaded the full-firmware dylib from firmware PR #846 at commit
`f3d6883c5`, reported firmware `7.17.0`, and passed its live key-derivation
smoke test. With `FEATURE_TAPROOT_DGB=true`, a portfolio scan sent two DGB
accounts to Pioneer: the legacy account as a plain xpub and the BIP-86 account
as `tr(xpub...)`. Pioneer returned a native DGB balance entry for each; both
were zero for the test wallet.

This proves firmware gating, DGB account derivation, descriptor transport, and
ordinary DGB balance lookup. It does not prove a DigiDollar balance: Pioneer
still has no DD indexer endpoint, and a DD receive address uses the protocol's
`DD...` encoding rather than the ordinary `dgb1p` display address.
