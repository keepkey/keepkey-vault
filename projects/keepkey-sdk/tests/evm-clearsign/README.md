# EVM clear-sign QA: 7.15 runtime signer vs 7.16 KeepKey certification

This SOP applies to **signed-metadata schema screens**, not every readable
transaction screen. Firmware can natively describe pinned ERC-20 and router
calls without either signed-metadata path. Record the firmware version, source
commit, signer tier, Advanced Mode state, transaction bytes, and every device
screen before judging a test.

## Establish the test target

1. Run `node tests/fw-715/00-capabilities.js` with Vault running. For the Vault
   emulator, expect `7.16.0`, variant `Emulator`, and Advanced Mode off. The
   emulator has no device firmware hash: record the **built source commit** and
   installed dylib hash instead. A physical device must report a nonzero
   firmware hash.
2. For the current alpha emulator, source is firmware `7151ba3bfd1541e5e27f10517793f106225c8e92`
   (merged PR #760). Confirm the installed `~/.keepkey/emulator/libkkemu.dylib`
   is the library built from that commit; a version string alone is insufficient.
3. Keep Advanced Mode **off** for certified 7.16 tests. Use a disposable wallet
   and do not broadcast test signatures.

## 7.16: KeepKey-certified path

Run `make test-sdk filter=fw-716/30-` (moved to
`tests/fw-716/30-certified-relay-bridge.js`). Desktop requests the v3 envelope
from the ClearSign service itself, with reserved `keyId=0x80`; the suite sends no
`txMetadata` and **does not call `LoadClearsignSigner`**. The device checks
the root-signed delegate certificate, delegate signature, scope, and schema
against the transaction. A valid certified path starts with the positive
**“Verified by KeepKey”** identity screen (the exact firmware wording; do not
rename it “Approved by KeepKey” in evidence), then shows the method, full
contract address, decoded arguments, value and fees as applicable. The
certified tier can replace raw calldata review only when the device's binding
and completeness checks allow it. A bad certificate, wrong chain/contract/
selector, altered argument, or incomplete schema must fail closed; no
signature and no certified badge.

This is the target experience for the full 7.16 release. The badge authenticates
the describing signer and schema; it does **not** mean KeepKey endorses the
economic value or safety of the transaction. A human still checks the actual
asset, spender/recipient, amount or allowance, protocol, route, and fees.

## 7.15: session-loaded signer path

Use an actual 7.15 target for this comparison, not the 7.16 emulator with a
different metadata mode. Turn Advanced Mode **on**, then run
`node tests/evm-clearsign/loadsigner-sign-flows.js` or
`node tests/evm-clearsign/clearsign-signer-flows.js`. Before signing, the host
must send `LoadClearsignSigner` and the user must approve the on-device
**“Load Clearsigner”** consent naming the alias and fingerprint and saying
**“NOT verified by KeepKey.”** The loaded key is session RAM state and is gone
after reboot. Each later metadata transaction shows the loaded **Identity**
(alias/fingerprint), then **Clearsign** method and argument pages. The runtime
tier is annotation only: it must **not** show “Verified by KeepKey” and must
retain the raw/opaque review. Without a loaded signer, or with Advanced Mode
off, signed metadata is rejected rather than acquiring certified authority.

The 7.15 release source (`af979cd50`) has no v3 root-certified envelope path:
its signed-metadata key lookup resolves only loaded session keys. A readable
native firmware screen does not prove a runtime signer was loaded.

## Screen and adversarial evidence

For each proposed human summary, write the exact transaction bytes and the
claim a malicious host might make (for example “swap 1 token” while calldata
grants unlimited allowance). Capture **every** confirmation page before
approving or rejecting. From an authenticated SDK test, `POST /emulator/capture`
returns the live OLED PNG as `dataUrl`; the Vault RPC `emulatorCaptureFrame`
can save the same frame. Compare screen text to the signed bytes, not to the
host's label. Record the image, page order, trust tier, whether raw review
appeared, and the final signature/rejection. For negative cases, reject on the
device and assert that the host receives no signature. Never auto-approve a
screen merely to make a test pass.

At minimum, challenge a benign swap label with (1) a changed recipient,
(2) unlimited or wrong-spender approval, (3) different chain or contract,
(4) changed route/intermediate asset, and (5) hidden native value or fee.
Pass only when the device rejects the mismatch or the *actual* dangerous
parameter is plainly visible before the user can sign. A generic “contract
interaction” or a provider-supplied friendly sentence is not sufficient
evidence that a human could defeat the deception.

## Verification recorded for this alpha handoff

- The mounted emulator reported `7.16.0`, variant `Emulator`, initialized,
  Taproot enabled, and Advanced Mode off; `00-capabilities.js` passed 5/5.
- The merged 7.16 source has the v3 `keyId=0x80` certified path and the
  “Verified by KeepKey” screen. The 7.15 release source at `af979cd50` has
  only session-loaded metadata verification keys and requires Advanced Mode.
- Twelve focused alpha unit tests passed, covering the root certificate and
  runtime metadata being inert outside Advanced Mode. The full firmware CI
  gate passed on the backport PR before merge.
- A live certified-transaction screenshot and a live 7.15 hardware comparison
  are **still pending**. Source and unit evidence establish the protocol
  distinction; they do not substitute for visual sign-off of every screen.
