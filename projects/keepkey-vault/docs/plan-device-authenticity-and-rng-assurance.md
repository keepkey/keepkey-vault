# Plan — Device authenticity + RNG assurance

Status: proposal, 2026-08-10. Owner: vault + firmware.
Audience: this ships as a public claim. Every sentence here is written to be
read by someone trying to disprove it.

---

## 0. The rule this plan is built on

**Never state a guarantee the code does not enforce.** Where a check is
corroboration rather than proof, the UI says so in the same breath. The
credibility of the whole feature comes from the disclaimers, not from the
checkmarks — anyone can print a green tick.

Concretely: two of the four things in this plan **would not have caught the
Coldcard incident**, and the UI says which two. That admission is the feature.

---

## 1. What each layer actually proves

| Layer | Where it runs | What it proves | What it does **not** prove |
|---|---|---|---|
| Bootloader signature check | On device, every boot | The running firmware carries 3 valid distinct signatures from KeepKey's pubkey set. Unsigned/expired → "Unrecognized firmware" + hash on the OLED + forced button press. | That the signed firmware is *honest* or *correct*. |
| On-device firmware hash → pinned release table | Host (vault) | Exactly which published build is running. | Nothing on its own if the firmware is hostile — the running firmware self-reports this hash. |
| Reproducible build | Third party (WalletScrutiny) | The released binary matches the published source. | That the source is free of defects. **Coldcard's source built reproducibly to the broken binary.** |
| RNG health test (≤8 MB) | Host | The generator is not obviously broken: no stuck bits, no bias, no linear recurrence, and the collision detector demonstrably works. | Unpredictability. A CSPRNG with a 40-bit seed passes every check by construction. |
| Cross-power-cycle determinism | Host | The generator does not restart from a fixed state. | That the seed pool is large. |
| Compile-time RNG guards (`#error`) | Build | The hardware RNG is the compiled source, or the build fails. | Anything about a binary you did not build. |
| RNG source attestation (proposed) | Device, unconditional | The peripheral is enabled and live at seed time. | Anything against a firmware that lies. Scope: **accidental** substitution. |

### Read this table against Coldcard

Coldcard's July 2026 failure was a build-configuration slip:
`MICROPY_HW_ENABLE_RNG` was defined-but-zero, libngu tested only definedness,
and a software PRNG seeded with ~40 bits generated seeds from March 2021.

- Signature check: **passes.** The binary was correctly signed by Coinkite.
- Hash → release lookup: **passes.** It was a genuine published release.
- Reproducible build: **passes.** Binary matched source; the source was wrong.
- 8 MB RNG health test: **passes.** By construction — that is what a CSPRNG is.
- Cross-power-cycle: **passes.** Their ~40 bits varied per boot.
- Compile-time guard: **FAILS THE BUILD.** ← the only pre-existing layer that stops it.
- RNG source attestation: **FAILS AT SEED TIME.** ← the only runtime layer that stops it.

Detecting a small internal state from output alone requires searching the seed
space. By collision, a 2^40 pool needs ~2^20 *independent seedings* — a million
power cycles — which is why this is a build-time problem, not a testable one.
This number goes in the UI.

---

## 2. What we already have

- **Bootloader enforcement.** `tools/bootloader/main.c:257` — `signatures_ok()`
  requires 3 valid *distinct* signature indices before boot; failure shows
  "Unrecognized firmware"/"Expired firmware" plus the firmware hash and demands
  a button press. This is the root of trust and it is not host software.
- **A real on-device hash.** `Features.firmware_hash` =
  `SHA256(META_MAGIC ‖ meta_descriptor ‖ app_code[codelen])`
  (`lib/board/memory.c:232`), which equals the full-file SHA-256 of the released
  `.bin`. Because the meta descriptor includes the signature slots, this hash
  pins the exact signed artifact.
- **A pinned hash table.** `src/shared/firmware-versions.ts:183`
  `ONDEVICE_FIRMWARE_HASHES` — 40 entries, compiled into the vault bundle, so a
  compromised update server cannot rewrite it.
- **Bootloader hash verification that is real** — `verifyHashes()` looks the
  device's bootloader hash up in `manifest.hashes.bootloader`.
- **Reproducible builds**, documented, and independently reproduced by
  WalletScrutiny for 7.14.1.
- **`ReproducibleBuildNotice.tsx`** — already shown before *installing*
  firmware, verifying the download's payload hash before flashing.

## 3. What is overclaimed or wrong today — fix before any press

> **Update 2026-08-10 — items 1 and 2 are done, and doing them found a live bug.**
> Switching to the hash check exposed that the pinned table itself was wrong:
> **v7.14.1, the current shipping release, had the wrong hash** (`32155c11…`
> instead of `f40fe1b7…`), as did v7.5.1. The version-string check had masked
> both. `scripts/verify-firmware-hashes.ts` now recomputes every entry from its
> published release asset — **34 verified, 0 mismatched, 0 unverifiable, 0
> unpinned**. It also removed a phantom `v7.9.0` row: no such tag or artifact
> has ever existed, so its only possible effect was to bless unknown firmware
> as a release that does not exist. **This script is the answer to "where did
> these constants come from"; CI gates on it via
> `.github/workflows/firmware-hashes.yml`.**
>
> Also settled: the device reports the **full-file** sha256. The releases'
> `HASHES.txt` labels the *payload* hash (`tail -c +257`) "device-verifiable
> build hash" — that label is wrong and should be corrected in the firmware
> release tooling. Proof: v7.14.0 and v7.10.0 full-file hashes match their
> pinned entries exactly; the payload hashes match nothing.

1. **`firmwareVerified` is a version-string lookup, not a hash check.**
   `engine-controller.ts:700-708` sets `firmwareVerified = knownVersions.includes('v'+version)`.
   A modified firmware reporting `7.15.0` is marked verified. **This is the
   smoke-and-mirrors item.** The correct check —
   `ONDEVICE_FIRMWARE_HASHES[firmwareHash]` — already exists and is currently
   used only in bootloader mode.
2. **The hash table has gaps.** It ends mid-7.x and has no btc-only lineage
   (noted in its own `ponytail:` comment). An unknown hash must render as
   *"unrecognized — this may be a legitimate build we have not pinned yet"*,
   never as *"tampered"*. Getting this wrong on launch day means every
   btc-only user sees a red screen.
3. **`messages.proto:297,305` says "double sha256". The code is single SHA-256.**
   Fix the comment; never repeat "double" in docs or press.
4. `ReproducibleBuildNotice.tsx` uses `target="_blank"` — a dead click in
   Electrobun. Route through the `openUrl` RPC.

---

## 4. Phase 1 — Firmware authenticity (vault)

### 4.1 Placement

- **Always-visible, non-blocking:** a firmware row in the device header —
  `v7.15.0 · verified` — click for detail. Present on every connect.
- **Blocking full-screen step:** only (a) as the first step of the OOB wizard,
  before the tutorial pages, and (b) any time the result is not
  `matched-known-release`.

> Rationale, and it is a security argument, not a UX one: a modal on every
> plug-in trains users to dismiss it unread. A dismissed-by-reflex dialog is
> worth less than no dialog, because it manufactures a false memory of having
> checked. Persistent badge + escalation on anomaly is the design that keeps
> the signal meaningful.

### 4.2 States

| State | Condition | Presentation |
|---|---|---|
| `matched` | device hash ∈ pinned table | green, version + release link |
| `unrecognized` | hash not in table | amber. "We don't recognise this build." Offer: bootloader screen check, hash to compare manually. Not an accusation. |
| `unreported` | firmware too old to send `firmware_hash` | grey, "this firmware version does not report a hash" — **never green** |
| `bootloader-mode` | device in bootloader | use the bootloader's own reported hash, note it is the stronger source |

Fail closed on every axis: missing field ≠ pass. (Firmware silently ignores
unknown proto fields, so host-side gating is the only gate.)

### 4.3 Detail panel — the "verify us" surface

- Firmware version, `firmware_variant`, full 64-hex device-reported hash,
  selectable and copyable.
- Matched release → link to `github.com/keepkey/keepkey-firmware/releases/tag/vX.Y.Z`.
- Bootloader hash + its verification state.
- **The exact commands to check us**, copyable:
  ```
  # what the device reports must equal the released binary, byte for byte
  sha256sum firmware.keepkey.bin

  # to compare your own reproducible build against the signed release,
  # strip the 256-byte signature header from BOTH sides first
  tail -c +257 firmware.keepkey.bin | sha256sum
  ```
- One sentence stating the limit, verbatim:
  *"This compares what the device reports against a list built into this app.
  The check that actually stops unsigned firmware runs in the bootloader, on
  the device, every time it powers on."*

### 4.4 P2 — showing the actual signature

Today the host cannot see the signature bytes or key indices; the meta
descriptor is not exposed over the wire. To honour "show the exact signature"
we need a proto addition returning the 256-byte meta descriptor (magic,
codelen, 3 signature indices, 3×64-byte signatures). Then a published verifier
lets anyone check those signatures against `pubkeys.h` offline. That is the
strongest artifact in this plan and it is the one piece that is not yet built.
Until it ships, the UI says "3 signature slots, verified by the bootloader" —
not "signature shown".

---

## 5. Phase 2 — Cross-power-cycle determinism (vault + copy)

### 5.1 Mechanics

1. Pull 4 KB, hash it, keep the hash only.
2. Prompt: unplug, replug. (Uninitialized devices have no stable id — hold the
   state in the panel, reset on `disconnected` like `rngVerdict` does.)
3. Pull 4 KB again. Assert the two differ; also assert no shared 8-byte block.
4. Report pass/fail as an additional check in the existing report.

Cost is a few seconds and one replug. It is the cheapest test in the
determinism > bias > collisions ranking and the only one of the three we do not
currently run.

**This is not the post-audit power-cycle gate that was rejected.** That one
re-drew entropy after a passing audit on the theory that the host knowing the
sample mattered; the threat intersection was empty. This measures a different
thing — whether the generator restarts from the same state — and has a real
detection target.

### 5.2 The wording, and why it is not what was asked for

The request was for copy saying this step would not pass if a Coldcard-like
issue were present. **It would pass, and we cannot write that sentence.**
Coldcard's generator was seeded from a small pool that *varied per boot*, so two
boots produce two different streams and this check goes green. Shipping the
requested sentence hands a reviewer a one-line refutation of the entire
feature on the day it is most read.

What is true, and what ships instead:

> **Different every boot.** Two power cycles produced unrelated output. This
> rules out a generator that restarts from the same state each time it powers
> on — the failure mode that leaks identical seeds to every user.
>
> It does not rule out a generator seeded from a small but *varying* pool. That
> was the shape of the Coldcard failure of July 2026, and no output test detects
> it at any sample size: finding a 40-bit seed pool by collision would take
> roughly a million power cycles. What prevents that failure here is upstream of
> this screen — a firmware build that will not compile if the hardware random
> number generator is absent, and a device that checks the generator is live
> before it creates your seed.

That paragraph is longer than a green tick and it is the entire point.

---

## 6. Phase 3 — RNG source attestation (firmware) — the real Coldcard answer

The only runtime layer that catches an accidentally-substituted generator.

1. **Compiled unconditionally**, outside every RNG config macro — if it sits
   behind the same `#ifdef` that went wrong, it disappears with the thing it
   was meant to check. This is *the* design constraint.
2. At seed time, before `random_buffer(int_entropy, 32)`: verify the RNG
   peripheral clock is enabled, `RNG_CR_RNGEN` is set, `RNG_SR` carries no
   seed/clock error, and run SP 800-90B RCT + APT over raw `RNG_DR` reads.
3. Latch failures in storage so a fault survives a reboot and cannot be walked
   past by replugging.
4. Report source + peripheral state + last self-test result to the host; vault
   renders it in the RNG panel and treats *absent* as unknown, never as pass.

Pair with the two compile-time guards. Per the last audit: fw #332 is on the
7.15 line but **`origin/develop` still has `return random();`**, and
`feature/715-18-rand-platform-guard` is unmerged. Confirm both are on the
release line before any of this is announced — a guard that is not on the
shipping branch is decoration. Add a CI grep so a later config edit cannot
silently undo them.

---

## 7. Claims we will not make

- ❌ "Verified authentic" as a bare phrase, with no statement of by whom and against what.
- ❌ "This would have caught Coldcard" attached to the RNG panel or the power-cycle step.
- ❌ "Proves your device's randomness is secure."
- ❌ Any green state derived from a *missing* field, an unknown hash, or a version string.
- ❌ "Double SHA-256" (the code is single).

## 8. What a reviewer should be able to do, and get right

1. Read `firmware_hash` off the device, `sha256sum` the GitHub release asset, get the same value.
2. Rebuild the firmware from source per `ReproducibleBuilds.md`, `tail -c +257` both sides, match.
3. Flash unsigned firmware, watch the bootloader refuse to boot it silently — and watch the vault drop to `unrecognized`.
4. Point at any green checkmark and find, within one screen, a sentence stating what it does not prove.

If (4) fails anywhere, the feature is not ready.

## 9. Order

| | Work | Why first |
|---|---|---|
| P0 | Replace version-string `firmwareVerified` with the pinned-hash check; backfill the table incl. btc-only | Removes the only actual misstatement in the shipping product |
| P0 | Confirm both RNG compile guards on the release line + CI grep | The actual Coldcard defense |
| P1 | Authenticity step: badge + wizard step + detail panel + copyable verify commands | The user-facing feature |
| P1 | Power-cycle check + the copy in §5.2 | Cheap, and carries the honest Coldcard framing |
| P2 | Firmware RNG source attestation + fault latch | Strongest runtime claim; needs a firmware release |
| P2 | Expose the meta descriptor so signatures can be verified offline | Strongest artifact; converts trust into verification |
| P3 | Multi-offset Berlekamp–Massey (today only the first 512 bytes of an 8 MB pull are tested) | Cosmetic; changes nothing about the Coldcard question |
