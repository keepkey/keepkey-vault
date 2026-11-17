# Monero signing artifact packaging

Desktop uses the public streamed firmware protocol (1810–1825) when the connected device reports signing capability31. The complete app flow requires the managed wallet RPC, reviewed plan decoder, and independent Core verifier. The app must not offer a deposit address when the complete signing toolchain is unavailable.

## Reviewed independent verifier

`projects/keepkey-vault/monero-cli/core-verifier-manifest.json` is the controlling record. The current macOS ARM64 verifier is built from Monero Core0.18.5.4, with a **13.0 deployment target**, and exposes only `monero_core_verify` and `monero_core_plan_size`. Its only dynamic dependencies are Apple's `libc++` and `libSystem`. It contains no wallet-key, device transport, signing, or network entry point. The full plan ABI remains7544 bytes, supporting up to four inputs and two signing outputs.

The native wrapper is checked in under `projects/keepkey-vault/native/monero-core-verifier/`. Core verification checks canonical transaction serialization, prefix, fee, reviewed rings, sorted key images, CLSAG signatures, and Bulletproof+ proofs. Desktop separately binds the returned output keys, amounts, commitments and payment-proof keys to the reviewed destination plan before relay.

The earlier research verifier linked Homebrew libraries and carried a15.0 floor. It is not the packaged artifact. The new verifier and used Core/Boost/libsodium code are compiled for13.0; changing a Mach-O version field was not used to lower the floor.

## Build and stage

The build script requires six explicitly supplied archives with SHA256 values recorded in the manifest: Core, RandomX, RapidJSON, SUPERCOP, Boost1.90.0, and libsodium1.0.22. It does not download, sign, access a device, or accept private wallet inputs.

```sh
python3 scripts/build-monero-core-verifier.py \
  --archive-dir /path/to/pinned-archives \
  --work-dir /path/to/empty-build-directory \
  --output /path/to/new/libmonero_core_verify.dylib
bun projects/keepkey-vault/scripts/stage-monero-core-verifier.ts \
  --source /path/to/reviewed/libmonero_core_verify.dylib
```

The build checks archive pins, exported symbols, deployment target, UUID and system-only dependencies, and records its actual hash and tool inputs. A changed compiler or changed native bytes need a new vector qualification and manifest pin. Staging accepts only the exact reviewed hash, size and regular-file permissions; build labels and adjacent JSON cannot authorize another artifact.

## Bundle and signing

The Core verifier is bundled independently of `KEEPKEY_INCLUDE_MONERO_EMULATOR`. The research host prover and research emulators remain excluded from normal builds. The reviewed plan adapter also ships independently of that flag, with its own authenticated raw artifact pin and receipt.

Local Developer ID builds sign a disposable verifier copy, preserving the reviewed raw input. A receipt records the raw pin and the signed bytes' hash. Hutch's signing shim preserves those exact signed bytes, and the final outer app signature seals the receipt. Runtime accepts a changed hash only at the fixed `Resources/app/monero-device/` location after verifying the actual outer app signature. Arbitrary developer directories cannot self-attest with adjacent receipts. Third-party licenses ship beside the verifier.

## Qualification

The actual native verifier accepts the public firmware's standard, subaddress and zero-change sweep vectors and rejects corrupted signatures/proofs. Host tests cover unsupported platforms/OS versions, hash/size mismatches, symlinks and unsafe permissions, signed-copy receipt tampering, and failure before any signing operation. These tests use public fixture bytes; they do not sign with a real device or relay a funded transaction.

The native artifact currently covers macOS ARM64. Other platform artifacts need independent build and runtime qualification. The macOS13 floor is enforced by compilation and dependency audits; a physical macOS13 runtime test remains part of platform qualification. No release was signed or published as part of this app fix.
