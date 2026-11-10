# Zcash Nu7 — alpha emulator candidate

## Delivery scope

Transparent Zcash sends now use the reviewed **7.17 alpha emulator** and a
Nu7-compatible v6 transaction builder. The existing bundled emulator already
implements the required zero-action PCZT signing protocol; this change qualifies
those exact bytes and integrates the complete build/sign/finalize path into
Vault. It does not introduce or flash a physical firmware candidate.

The user explicitly chose emulator-only delivery. Physical-device Nu7 transparent
signing is blocked, including a device reporting 7.17. Receiving and balance monitoring
remain available. The Send screen says:

> Zcash sending requires the 7.17 alpha emulator. Hardware support is not available yet.

Alpha firmware opt-in remains off by default. The backend requires the active
emulator transport, current wallet, a running emulator instance, the opt-in,
firmware 7.17 or later, and the exact reviewed bundled library provenance.
Request flags, version labels and imported firmware metadata confer no trust.
Unsupported Desktop requests fail before acquiring the device or requesting its
PIN. The legacy REST Zcash signing schema is intentionally unsupported; use the
Desktop send flow.

The base is develop **cb5b8f981200469dc260628a212325c08b17d780**, containing the
previously reviewed PRs #634–#642. The original password-manager worktree and the
running Vault preview were left in place.

## Failure and consensus requirement

The user's transparent send reached approval but the selected Pioneer provider
rejected broadcast with HTTP 400 and `error.code = utxo_error`:

> transaction version 4 not supported by the network upgrade Nu7

The prior UI reduced that response to “Bad Request.” Structured provider
rejections now retain their bounded error message. Broadcast still makes one
call to the selected provider; it does not retry or change providers.

[ZIP 259](https://zips.z.cash/zip-0259) specifies Nu7 mainnet activation at
**3,543,405**, testnet at **4,465,026**, branch **0x77190AD9**.
[ZIP 2003](https://zips.z.cash/zip-2003) disallows all v4 transactions after
activation, including transparent-only payments. Versions 5 and 6 remain valid.
[Zebra 7.0.0](https://github.com/ZcashFoundation/zebra/releases/tag/v7.0.0)
implements activation; the ZIP pages still carry a formal Proposed status.

The integration uses complete v6 serialization and signature digests rather
than changing a version field on the old v4 serializer. The production Rust
dependency cohort and lockfile remain unchanged. A separate locked reference
crate uses Nu7-aware zcash_protocol 0.11 / zcash_primitives 0.31 to verify the
result independently.

## Implementation and boundaries

- The ordinary UTXO builder retains coin selection, fees, maturity and change
  selection. Zcash plans dispatch explicitly to the transparent PCZT signer.
  Generic Bitcoin signing cannot serialize a modern Zcash plan accidentally.
- The host validates all inputs, outputs, ownership paths, account, totals and
  ZIP-317 fee before signing. A fresh device account xpub verifies every input
  script and change script. The host compares the Rust request to the original
  plan and checks owner/session again after each await.
- The Rust builder validates the node's mainnet, height and branch snapshot;
  constructs canonical v6 components; supplies required empty-bundle metadata;
  verifies every DER signature and public-key ownership; and finalizes once with
  a matching request ID. Stale or overlapping TEX work cannot consume a pending
  native transaction.
- New transparent-only sidecar startup does not open a wallet database or request
  a viewing key. A persistent command allowlist rejects private-wallet commands
  before their handlers. Old sidecars are rejected without executing them; a
  paired SHA-256 capability manifest binds the verified file to its launch.
- Packaging regenerates the sidecar manifest after signing. Re-signed bundled
  emulator libraries use a fixed-path receipt tied to the compiled certified
  source manifest and actual loaded bytes. macOS seals that receipt with the
  outer app signature. Windows receipt integrity relies on the installed package
  in the same way as bundled application code; the JSON is not independently
  Authenticode signed.
- UI readiness is read-only. Device/seed/transport changes revoke stale work;
  ordinary PIN or lock transitions on the same wallet do not invalidate an
  approval already in progress. A neutral spinner covers readiness checks.

This candidate supports **transparent mainnet P2PKH inputs**, 1–8 inputs and
outputs, one standard BIP44 Zcash account, and transparent P2PKH/P2SH or TEX
recipients. It rejects memos/OP_RETURN clearly. Memo-dependent swap routes are
not qualified. Change is verified by the host and displayed as its real address
on the emulator; firmware 7.17's scope-2 hint is not misused as ordinary change.

Shielded, deshielding and shielded-to-TEX Nu7 sends remain **unqualified** and
retain their existing branch guards. Transparent success does not establish
private-pool support. This work does not claim physical 7.17 support.

## Qualification

- Core isolated regressions: **1,672 passed**, 93 script assertions, zero failures
  across 131 files, including the final REST admission fixture. The evidence runner
  rejects live API test sources and uses an unreachable API endpoint.
- Native bundled alpha emulator: **3 tests / 12 assertions**, using a fresh RAM
  wallet and the existing public test mnemonic. Both signatures of a two-input
  Nu7 payment verify independently. A second payment signs from the prior change
  path. Conflicting header metadata is rejected before approval/signature.
- Native Rust suite: **91 passed**, one pre-existing ignored test, plus **3 actual
  child-process startup/stdio tests**. Transparent-only startup and command
  rejection leave the temporary wallet profile absent.
- Independent modern Rust reference: **5 passed**, covering full parsing,
  transaction ID, each input signature digest, changed amounts/scripts/outputs/
  branch, and the v4/v5/v6 consensus boundary. A changed expected hash fails.
- Receipt, binary and packaging tests: **13 passed / 72 assertions**, including
  real runtime verifier behavior and simulated signing steps. These do not claim
  real Windows/Authenticode artifact qualification.
- REST admission regression: **10 passed / 38 assertions** (included above).
  Unsupported Zcash requests never acquire/unlock/read/sign or ask for approval;
  authentication and ordinary Bitcoin signing are preserved. The old source
  fails seven of these tests. Related demand-unlock tests pass **22 / 114**.
- All 15 locale files pass the i18n check. Frontend and backend builds pass.
  TypeScript retains the **799 existing diagnostics**, with no added diagnostic
  families; it is not a clean typecheck baseline.

Native test source is `tests/emulator/14-zcash-nu7.test.ts`; it requires an
explicit reviewed `KK_EMU_DYLIB`, uses only RAM flash, and never imports the live
app engine. CI runs it against the certified bundled emulator on macOS. The
independent reference lives under `zcash-cli/tests/nu7-reference/` with its own
lockfile so production dependency resolution remains unchanged.

Local evidence is retained under `/private/tmp/keepkey-release-core-20261110/`,
`/private/tmp/keepkey-nu7-emulator-native-20261110.log`,
`/private/tmp/keepkey-zcash-nu7-rust-evidence-20261110.json`, and
`/private/tmp/keepkey-nu7-reference-api-20261110/`. Do not include wallet secrets,
serialized user payments, pairing tokens or private profile data in evidence.

## Remaining release qualification

No user transaction was retried or broadcast, no physical device was flashed,
and no real wallet was changed. There is **no funded Nu7 node acceptance test**
in this qualification. Native emulator signing and independent verification
establish signature/serialization compatibility, not mined-chain acceptance.
Keep emulator support alpha until a disposable funded-chain test and packaged
platform qualification complete. The Intel derivative intentionally omits the
Zcash helper, so Nu7 sending is unavailable there. No public release/tag was created.

One pre-fix negative-control test invoked `diagnose_anchor` in a disposable
temporary HOME before its network behavior was identified. That handler attempts
a default lightwallet connection. Whether it established an outbound connection
is unknown; do not claim all tests made zero network attempts. It did not use a
user profile, application API, device, signing request or broadcast. Final tests
reject the command before dispatch; the unsafe negative control was not repeated.
