# Zcash shielded — real-device smoke checklist (stable-promotion gate)

**Status for v1.4.6:** ⛔ NOT YET RUN. v1.4.6 shipped as a **prerelease** validated entirely
by local/static checks (Orchard proof verify, BatchValidator, sighash-divergence, `cargo
audit`, notarization, backend boot smoke). **Do not promote v1.4.6 from prerelease →
`--latest`/stable until this checklist passes on a physical KeepKey.**

## Why this gate exists

The shielded send/scan core is a Rust sidecar that builds + finalizes Orchard PCZTs. Every
guard we added (local proof verification, BatchValidator, the device-signed-vs-consensus
sighash check, the per-flow transparent digest) runs **locally** — and the NU6.2 incident
proved that a tx can pass every local check and still be rejected by every node on the
network (pre-fork proofs validated locally but were rejected on broadcast). **Only a real
broadcast that gets mined confirms correctness.** Equally, the new fail-closed validation
could *false-abort* a legitimate send (e.g. a wrong transparent-digest assumption) — which
also only shows up when a real send either completes or refuses on hardware.

A prerelease is the correct vehicle for getting this in front of a real device. Stable is not.

## Preconditions

- A physical KeepKey on firmware **≥ 7.15.0** (Orchard support).
- Vault **v1.4.6** (the prerelease build, not a dev build).
- A wallet holding a small amount of **shielded ZEC** and a small amount of **transparent ZEC**.
- Mainnet; at least one lightwalletd node reachable.
- A second shielded (Orchard/unified) address and a transparent address to send to (the
  device's own next address is fine).

## Checklist

> Each item lists the code path it exercises and the specific risk it closes. Record the
> on-chain txid for every broadcast so a reviewer can independently confirm it mined.

- [ ] **1. Shielded balance is device-verified.** Open the Privacy tab. The shielded balance
  shows and matches the explorer.
  _Exercises:_ `ensureZcashDeviceMatch` + the fail-closed balance gate.
  _Pass:_ balance shown; no "not verified against the connected device" error for the
  connected wallet.

- [ ] **2. z→z shielded send.** Send a small amount shielded→shielded.
  _Exercises:_ `build_pczt` + `finalize_pczt` (Orchard proof verify + BatchValidator +
  consensus-sighash check) + multi-node broadcast.
  _Pass:_ device OLED shows recipient + amount; physical button required; tx broadcasts and
  **mines** (no "could not validate orchard proof"); the validation did **not** false-abort
  a legitimate send. Record txid: `__________`.

- [ ] **3. Shield (t→z).** Move transparent ZEC into a shielded note.
  _Exercises:_ `build_shield_pczt` + `finalize_shield_pczt` (hybrid
  `validate_hybrid_orchard_consensus` with transparent **inputs + outputs**).
  _Pass:_ device confirm; broadcasts and mines; no false-abort. Record txid: `__________`.

- [ ] **4. Deshield (z→t).** Move shielded ZEC out to a transparent address.
  _Exercises:_ `build_deshield_pczt` (per-spend Merkle-root==anchor guard) +
  `finalize_deshield_pczt` (hybrid validation, transparent **outputs only**).
  _Pass:_ device confirm; broadcasts and mines; no false-abort. Record txid: `__________`.

- [ ] **5. Anti-bleed across a passphrase / hidden-wallet toggle.** With a device-verified
  shielded balance showing, activate a hidden wallet (passphrase) on the **same** device.
  _Exercises:_ `resetSeedManagers` flag reset (FS-1) + forced spend-path re-derive.
  _Pass:_ the shielded balance does **not** keep showing the previous wallet's value — it
  fail-closes / re-derives for the active wallet. A send while in the hidden wallet builds
  against the **active** wallet's notes, not the previous wallet's.

- [ ] **6. Address book in private send.** Save a shielded recipient, then reuse it from the
  picker on a subsequent send.
  _Pass:_ saved address round-trips and sends to the correct recipient.

- [ ] **7. Memo + amount bounds (sanity).** Send with a normal memo; confirm the memo on the
  explorer matches what was typed. Attempt an absurd amount.
  _Pass:_ memo on chain == memo entered (no silent truncation); over-supply / non-positive
  amounts are rejected before signing.

## If any item fails

Do **not** promote v1.4.6 to stable. File the failure (with the txid / device behavior),
fix on `develop`, cut a `release/1.4.x` patch, and re-run this checklist. The published
prerelease can stay up for continued testing.

## On pass

Promote: `gh release edit v1.4.6 --repo keepkey/keepkey-vault --latest --prerelease=false`
(keep this checklist's completed copy, with txids, attached to the release or PR for the
audit trail).
