# Zcash Nu7 — reviewed alpha emulator integration

## Scope and current source

PR #643 is adapted onto the current 1.7 develop implementation, preserving native
send safety, Cosmos/XRP chain-result confirmation, gateway caching and Monero fixes.
Zcash capability metadata now starts at firmware **7.17.0**. Nu7 transparent signing
retains the reviewed alpha emulator and admits any physical KeepKey on firmware
>= 7.17.0 (owner decision, audit v8 S1: the earlier single-image SHA256 pin was
removed). Other native state checks (real wallet, hid/webusb, initialized, not
bootloader) still apply.
Receiving and balance monitoring remain available on supported builds.

The latest checked-in certified emulator pin was verified against canonical
history on 2026-11-16. It is version 7.17.0, firmware source **97236a794**, certified
workflow **42312167033**, dispatched from Vault source
**c19a995b4045704494959f7885fc3ade63c32a19**. This emulator contains no Monero
implementation; the separate public physical 7.17 firmware is not inferred to
have this emulator's signing protocol.

- macOS: `8e8d1219e4c88f82c001a1ac2a21a6694f4f00d63b269abf9a3f6b07ab2e518a`, universal arm64/x86_64.
- Windows: `859b4d64065c0030181c162c7bd06383d37e676816cd192b350d1ae2810fb101`, PE x64.

The ignored local emulator binaries were replaced with these verified inputs;
tracked firmware/submodule contents were not changed. There was no signing,
release, device update, app restart or user transaction in this integration.

## Protocol and admission

[ZIP 259](https://zips.z.cash/zip-0259) specifies Nu7 mainnet activation at
**3,543,405**, branch **0x77190AD9**. [ZIP 2003](https://zips.z.cash/zip-2003)
disallows v4 transactions after activation. The ZIP pages retain Proposed status.
The implementation uses canonical v6 serialization and signature digests, rather
than changing a version field on the old serializer. Production Rust dependencies
and their lockfile remain unchanged; a separate locked reference crate verifies
bytes and input signature hashes using Nu7-aware upstream libraries.

The backend binds emulator authorization to the current wallet, actual emulator
transport, running instance, alpha opt-in and reviewed loaded library digest.
Physical alpha admission binds the current wallet, actual HID/WebUSB transport,
initialized non-bootloader state and exact device-reported image hash. The
firmware picker opt-in is not needed for a physical image already installed.
Signing rechecks its wallet/session token after every awaited step, including
PIN transitions and approval; device, seed, transport or firmware changes revoke
the previous request. Request flags, semver alone and imported firmware metadata
confer no trust. Unsupported Desktop
requests fail before device acquisition/PIN. Legacy REST Zcash signing fails
before approval; Desktop owns the supported Nu7 transparent flow.

The ordinary UTXO builder retains coin selection, maturity, fees and change. The
host verifies each input and change against a fresh device account xpub, validates
all paths/amounts/scripts/fees, compares the complete Rust request with the selected
plan and rechecks cancellation and wallet ownership after awaits. Rust validates
the live node's mainnet/height/branch, requires an exact request ID, verifies every
DER signature and public-key ownership, and finalizes once. Generic Bitcoin
serialization cannot accidentally handle a modern Zcash plan.

Supported scope is mainnet P2PKH inputs, 1–8 inputs and outputs, one BIP44 account,
and P2PKH/P2SH or TEX recipients. Memos/OP_RETURN are rejected, so memo-dependent
swap routes are unqualified. Private-pool and physical release qualification remain
separate work; the pinned physical alpha is available for live operator testing.
Structured provider rejections preserve a bounded reason;
broadcast still makes one call to the selected provider.

A new transparent-only sidecar process opens no wallet profile or viewing key;
a persistent allowlist rejects private-wallet commands. A paired capability/hash
manifest verifies the executable without executing older binaries. Concurrent
TEX work cannot replace pending transparent transaction state. UI readiness is
read-only and revokes retired device/seed/transport sessions, while normal PIN
transitions on the same wallet preserve a legitimate approval.

## Packaging boundary

The sidecar's `.nu7.json` must be regenerated after any executable mutation.
Signed macOS emulator bytes use a fixed-path receipt tied to the compiled source
manifest; the outer app signature must authenticate that receipt. Read-only
archive verification checks both the helper pair and emulator provenance without
rewriting Hutch's packed tar or update manifests. Intel excludes both the helper
and its manifest.

Windows Authenticode does not seal adjacent JSON. Runtime signed-byte emulator
receipts are therefore disabled on Windows; only exact pristine certified DLL
bytes qualify until authenticated Windows provenance is implemented and tested.
A signed Windows Nu7 artifact remains unqualified. The Windows signing input gate
requires pristine certified bytes even when skipping the app build.

## Local qualification, 2026-11-16

- Production Rust suite: **91 passed**, one pre-existing ignored test; **3 actual
  child-process IPC tests passed**, including profile-free startup and rejection
  of private-wallet commands without creating wallet storage.
- Independent reference crate: **5 passed**, covering canonical bytes, txid,
  every input sighash and commitments to amounts/scripts/outputs/consensus branch.
- Actual certified emulator: **3 passed / 12 assertions**, using disposable RAM
  flash and the public fixture mnemonic. Two input signatures verify independently;
  spending prior change uses its real path; altered header is rejected before
  approval. No app engine, USB device or wallet profile is loaded.
- Focused host/render/admission/packaging tests pass, including retired sessions,
  mismatched plans, old sidecars, REST admission, structured broadcast failures,
  current SendForm safety and signed-byte receipt rejection. These use synthetic
  signing commands and do not claim real platform signing qualification.
- All 15 locale catalogs pass the existing i18n check. The existing TypeScript
  baseline is **795** diagnostics; a virtual HEAD comparison found no added Nu7
  diagnostic family. This is not a clean typecheck claim.

Evidence logs are under `/private/tmp/vault-nu7-*-20261116.log` and the emulator
input check is `node scripts/verify-certified-emulator.mjs`. Native tests require
an explicit reviewed `KK_EMU_DYLIB`. No funded Nu7 node acceptance test or final
signed platform artifact was produced. Keep 1.7.0 on hold until release
qualification is complete; local protocol proof does not establish mined-chain
acceptance.
