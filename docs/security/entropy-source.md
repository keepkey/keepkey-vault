# KeepKey entropy source — design description

**Status:** design description, not a validation. See "What this document is
not" before citing it anywhere.

This is the part of NIST SP 800-90B §3.2.2 (entropy source design
documentation) that a vendor can satisfy by writing it down honestly. It is
published so the claims we make about randomness can be checked against the
mechanism, and so the claims we *cannot* make are on the record too.

---

## 1. The source

**Silicon:** STM32F205 hardware TRNG. Analog noise from ring oscillators is
clocked into a linear feedback shift register; firmware reads the result from
the `RNG_DR` data register.

**Firmware path:** `lib/rand/rng.c` → `random32()` → `random_buffer()` in
`deps/crypto/trezor-firmware/crypto/rand.c`. There is **no software
conditioning** — no hash, no DRBG, no whitening between `RNG_DR` and the
bytes a caller receives. What the peripheral produces is what the seed and
the `GetEntropy` message get.

**Raw noise is not accessible.** The pre-LFSR analog samples cannot be read
on production silicon — not from firmware, not from a debugger, not over the
wire. ST states this directly for the same architecture family in CMVP
public-use document E262 (STM32U0xx): *"The GetNoise interface is available
for certification purposes only… The raw data of the noise source is never
available when using standard STM32U0xx microcontrollers."*

## 2. How the seed is built

```
int_entropy  = 32 bytes from RNG_DR                        (reset.c)
[optional]   int_entropy = SHA256(int_entropy ‖ dice_rolls)  (dice, fw 7.15+)
             device sends EntropyRequest  ← commits here
ext_entropy  = 32 bytes from the host CSPRNG
seed         = SHA256(int_entropy ‖ ext_entropy)  truncated to strength/8
```

The ordering is the security property: the device fixes its contribution
**before** it asks the host for anything, so a host cannot grind `ext_entropy`
to steer the result. The seed is unpredictable if **either** party is honest.

Dice, when used, are entered on the device with its button and never
transmitted. 50/75/99 rolls carry up to ~255.9 bits at log2(6) ≈ 2.585 bits
per roll. This is the only entropy in the construction whose lower bound
depends on neither the device RNG nor the host.

## 3. What we do NOT claim

**We state no min-entropy rate.** Not per sample, not per byte. Producing one
would require assessing the raw noise source, which is inaccessible (§1).
Any number we published would describe the LFSR, not the noise.

**We hold no SP 800-90B validation, and we inherit none.** ST holds ESV
certificates for STM32WBA5x, U5x and U0xx. **Not for the F2 family we ship.**
There is no upstream certificate to cite and no vendor entropy rate to
inherit.

**The Shannon entropy figure our audit reports is not min-entropy.** It is
the empirical entropy of the observed byte distribution in one sample. A
counter passed through a good PRNG scores ~8.000 bits/byte.

## 4. What the Randomness Audit does and does not establish

The audit (`vault: src/bun/rng-audit.ts`) samples `GetEntropy` output and
runs output health checks. Formally it is a **Device RNG Output Health Check
(host-observed)**.

**It can detect:** stuck or repeated output; duplicated blocks; gross bias;
byte values never appearing; a broken transport or a caching layer; a
collision detector that silently does nothing; and — because we apply no
conditioning — a **free-running LFSR after the analog source has died**,
via Berlekamp–Massey linear complexity. That last one is invisible to every
other check in the suite, and would be completely hidden by a vendor that
hashed its RNG output before returning it.

**It cannot establish:** that the generator is unpredictable; how much
entropy its internal state holds; that the device is not backdoored; or that
the RNG used during seed generation is the one we sampled. A
cryptographically strong PRNG seeded with 40 bits of hidden state passes
every check in the suite. That is exactly the failure class that produced the
Coldcard incident, and no amount of output analysis closes it.

**Sample size governs which checks mean anything.** The 4-byte collision
control expects `blocks²/2³³` hits: 0.03 at 64 KB, 8 at 1 MB, 512 at 8 MB.
Below ~1 MB a zero result is indistinguishable from a detector that does
nothing, and the audit reports that check as **not run** rather than as a
pass.

## 5. Known gaps

Recorded because omitting them would make this document marketing.

- **Single source, no diversity.** One TRNG. No secure element, no second
  independent noise source to XOR against.
- **No fail-closed path.** `random32()` returns a `uint32_t` with no error
  channel, and the STM32 seed-error latch (`SEIS`/`CEIS`) is cleared and
  sampling continues rather than propagating a fault.
- **No SP 800-90B §4.4 continuous health tests** (Repetition Count, Adaptive
  Proportion) on the source. The only continuous check is the FIPS
  repeated-word test inherent in the read loop.
- **No start-up test** over a fixed sample count at boot.
- **Dice ingestion is verifiable; dice *use* is not.** The device shows
  `SHA256(rolls)` so the user can confirm the rolls it received. Proving the
  mix reached the seed would require revealing seed pre-image material, which
  is deliberately not exposed.

## 6. What this document is not

It is **not** an SP 800-90B validation, entropy assessment, certification, or
any claim of compliance. Validation requires an NVLAP-accredited laboratory
and an ESV submission reviewed under CAVP/CMVP. We have not done that, and
this document does not substitute for it.

**Language that must never be used** about KeepKey randomness, in UI, release
notes, reports or marketing:

- "NIST validated / certified / compliant"
- "we measured N bits of min-entropy"
- "Shannon entropy 7.99x, therefore good"
- "we ran the NIST tests and passed"
- "zero collisions, therefore ≥ k bits"
- "this proves the device is not backdoored"
- any entropy score, star rating, or percentage

Permitted: "Randomness Audit" (UI), "Device RNG Output Health Check
(host-observed)" (reports), and "SP 800-90B §4.4-*style*" when describing
health tests that are modelled on but not validated against the standard.

## 7. References

- NIST SP 800-90B — https://csrc.nist.gov/pubs/sp/800/90/b/final
  (§3.1.4 restart tests, §4.4 health tests, §6.3.2 collision estimate)
- CMVP public-use document E262 (STM32U0xx TRNG) — raw noise inaccessible on
  production parts
- Firmware: `lib/rand/rng.c`, `lib/firmware/reset.c`,
  `lib/firmware/fsm_msg_common.h` (`fsm_msgGetEntropy`)
- Vault: `projects/keepkey-vault/src/bun/rng-audit.ts`
