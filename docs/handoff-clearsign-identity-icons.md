# Handoff — Clearsign Identity Icons (persistent) + Protocol Icons (transient)

**Status:** design + feasibility verified against `BitHighlander/keepkey-firmware@origin/develop`
(== rc4, 7.15.0). Not yet implemented. This is the spec to build against. Post-7.15.0-release,
opt-in / feature-gated. Pioneer catalog signing is a *separate*, later track (see
`handoff-pioneer-server-clearsign-metadata.md`).

**Author intent (verbatim):** the device is *now a "KeepKey + identity" device*. A clearsign
**identity** (the entity whose key vouches for clearsign metadata) must be a first-class,
**persistent** trust anchor: users need the assurance that their identity provider is still the
one they approved/trusted. That assurance is delivered by showing the loaded identities **on boot**
(click-through) and by leading **every** clearsign with the identity's logo + name instead of a
scary "NOT verified by KeepKey" warning.

---

## 1. Two distinct concepts — do not conflate

| | **Identity** (clearsign signer / provider) | **Protocol** (relay, Aave, …) |
|---|---|---|
| What | The secp256k1 signer whose attestation vouches for clearsign metadata | The dApp/contract being clear-signed in a given tx |
| Trust | The trust anchor — user approved it once, must stay stable | Display aid, under the identity's attestation umbrella |
| Persistence | **PERSISTENT** — survives reboot, stored in flash | **TRANSIENT** — supplied by the Vault per-clearsign |
| Icon source | Loaded once via `LoadClearsignSigner` (+ icon), kept in flash | Sent by the Vault app at clearsign time, not persisted |
| Shown | On boot (click-through) + as the header of every clearsign it vouches for | Beside the method/protocol during the clearsign pages |
| Count | up to `METADATA_MAX_KEYS = 4` slots | 1 per tx |

The identity is the security-relevant piece. The protocol icon is cosmetic — its trust derives from
the identity that attested the metadata, which is why the identity is shown **first**.

---

## 2. Requirements

1. A clearsign **identity** has a loaded **icon** (logo), loaded together with its pubkey+alias.
2. Loaded identities display **on boot**, with a **click-through** (carousel) so the user can review
   each trusted provider before use — the "is my provider still the one I trusted?" check.
3. **Remove** the "Signer '…' NOT verified by KeepKey" warning. **Replace** it with the identity's
   **logo + name** shown at the **start of every clearsign** it vouches for.
4. **Multiple identities:** handle N loaded identities — cascade/click-through the boot review; each
   individual clearsign is vouched by exactly ONE identity (the `key_id` that signed the blob), so
   the clearsign header shows THAT identity.
5. **Protocol icons** (e.g. relay) are loaded from the **Vault app** per-clearsign and rendered
   alongside the method — transient, never persisted.
6. Verify **storage space** + **icon format** fit the device (done below).

---

## 3. Feasibility — verified numbers (origin/develop)

**Display.** OLED is `256 × 64`, 1bpp mono (`KEEPKEY_DISPLAY_{WIDTH,HEIGHT}`). The layout engine
**already** supports a left icon column: `layout.h` has `TITLE_WIDTH_WITH_ICON`,
`BODY_WIDTH_WITH_ICON`, `LEFT_MARGIN_WITH_ICON`, and `review_with_icon()` is already used for the
built-in "Verified" trust indicator. Image format is 1bpp mono, RLE-compressed
(`draw_bitmap_mono_rle(Canvas*, AnimationFrame*, …)`, `draw.h`), frames carry `uint16 width/height`.

**Icon size budget.** Recommend a fixed **48 × 48** identity glyph:
- 48×48 mono **raw** = 288 B; 64×64 = 512 B; 32×32 = 128 B.
- Stored RLE-compressed with a hard cap (reject larger at load). Cap suggestion: **384 B** per icon
  (comfortably fits a 48×48, most logos compress well below raw).

**Flash storage.** Config lives in a **16 KiB** sector (`FLASH_STORAGE_LEN = 0x4000`), wear-leveled
across sectors 1–3. `storage.c` has a **compile-time guard**:
`_Static_assert(sizeof(ConfigFlash) <= FLASH_STORAGE_LEN, …)` — so any addition that overflows 16 KiB
**fails the build**, never bricks. Current large consumers: `V17_ENCSEC_SIZE = 1024` (encrypted
secret), `mnemonic[241]`, `authBlock[512]`, policies, cache — total is well under 16 KiB with several
KiB headroom (exact figure prints at build; confirm with the assert).

**Persistent-identity cost** (worst case, 4 slots, 384 B icon cap):
`4 × (33 pubkey + 32 alias + 384 icon + ~4 len/flags) ≈ 4 × 453 ≈ 1.8 KiB` added to `ConfigFlash`.
Very likely fits; the `_Static_assert` is the authoritative gate. If tight, drop persistent slots to
2–3 (RAM slots can stay 4) or cap icons at 32×32.

**Conclusion: feasible.** Icons = 1bpp mono RLE, ≤384 B; persistent identity store ≈1.8 KiB fits the
16 KiB sector; the build-time assert guarantees we never overflow.

---

## 4. Current state (what exists today, origin/develop)

- Signers are **RAM-only**: `loaded_pubkeys[METADATA_MAX_KEYS][33]`,
  `loaded_aliases[METADATA_MAX_KEYS][31+1]` in `lib/firmware/signed_metadata.c` — **cleared on reboot
  and on WipeDevice**. No icon, no persistence.
- The warning to replace: `signed_metadata_confirm()` (`signed_metadata.c:565`) prints
  `"Signer '%s' (%s) … NOT verified by KeepKey."` then a plain "Call: <method>" screen. The built-in
  (phase-2) path uses `review_with_icon()` with a trust indicator.
- `LoadClearsignSigner` = msg **117**. NOTE: device-protocol submodule does **not** contain msg 117
  as a real `.proto` — hdwallet uses a **hand-written jspb** class. Adding an icon field means adding
  117 (with the icon field) to the **device-protocol fork** properly, then regenerating.
- Boot/home screen: `lib/firmware/home_sm.c` (`layoutHome`, `layoutHomeForced`, screensaver states).

---

## 5. Changes required (staged)

### Stage 0 — device-protocol (fork only; NEVER upstream keepkey)
- Add `LoadClearsignSigner` (msg 117) to the fork `.proto` with fields:
  `key_id=1 (uint32)`, `pubkey=2 (bytes,33)`, `alias=3 (string,≤31)`, **`icon=4 (bytes, ≤384, mono
  RLE 48×48)`**, optional `icon_w=5`, `icon_h=6`. Regenerate; replace hdwallet's hand-written jspb.

### Stage 1 — firmware storage (the migration; highest care)
- Move identities RAM → flash: add a `ClearsignIdentity identities[N]` array to `Storage.Public`
  (`storagepb.h`): `{ bool present; uint8_t pubkey[33]; char alias[32]; uint16_t icon_len;
  uint8_t icon[384]; }`. Pick `N` (start with 2–3 persistent; keep 4 RAM slots for ephemeral).
- **Bump `STORAGE_VERSION`** and add a migration in `storage_versions.inc` / `storage.c` that
  zero-initializes the new field for existing devices (no data loss). Verify the `_Static_assert`
  still passes (this is the space gate).
- Load path: `signed_metadata_store_signer()` writes to flash (persistent slot) vs RAM (ephemeral) —
  decide policy (e.g. a `persist` flag on msg 117, or all loads persist). WipeDevice clears them.

### Stage 2 — firmware rendering + messaging
- Store/validate icon at load (`signed_metadata_signer_valid` + a new icon validator: length ≤ cap,
  decodes as valid mono RLE at the fixed dims). Load-confirm screen shows the **icon + alias +
  fingerprint** ("Trust identity '<alias>'?").
- **Replace** the `signed_metadata_confirm()` warning branch: instead of "NOT verified by KeepKey",
  lead with `review_with_icon(identity.icon, "Identity: <alias>")` as the FIRST clearsign page, then
  the method/protocol pages (protocol icon beside the method — see Stage 3). Keep the fingerprint
  reachable (e.g. on the identity page) so a swapped provider is detectable.

### Stage 3 — boot click-through (home_sm)
- On boot / at home, if ≥1 persistent identity is present, add a reviewable panel: "Trusted clearsign
  identities (N)" → click-through each `icon + alias + fingerprint`. This is the trust-anchor check.
  Gate behind the feature flag. Screensaver/idle interactions per existing `home_sm` states.

### Stage 4 — Vault (protocol icons + identity icon upload)
- **Identity icon:** when the user loads an identity, the Vault sends the icon bytes in msg 117
  (`POST /eth/clearsign/load-signer` grows an `icon` field → hdwallet `ethLoadClearsignSigner`).
- **Protocol icons:** per clearsign, the Vault supplies the protocol glyph (relay/Aave/…) for the
  method screen — transient. Wire via a companion field on the sign request (display-only; NOT
  persisted, NOT part of the signed blob). Source glyphs from the existing coin/asset icon pipeline.
  ⚠ A protocol icon is unsigned display — safe only because the **identity** (shown first) attests the
  metadata; do not present a protocol icon as a trust signal on its own.

---

## 5b. LOCKED DECISIONS + progress (2026-07-07)

**Decisions (author):** **2 persistent** identity slots (RAM ephemeral stays 4); icons **48×48**
1bpp mono, RLE-stored, **384 B cap**. Persistent-store cost ≈ **2 × 454 ≈ 0.9 KiB** — comfortable in
the 16 KiB sector.

**Stage 0 — DONE.** device-protocol fork branch `feat/clearsign-signer-icon` (commit `33521a8`):
`LoadClearsignSigner` (msg 117) gained `icon` (bytes, `max_size:384`), `icon_width`, `icon_height`,
`persist`. Firmware re-pins to this in Stage 1.

**Stage 1 — storage migration recipe (reverse-engineered from `storage.c`, ready to implement):**
1. `include/keepkey/firmware/storage.h` — add to `struct Public`:
   ```c
   typedef struct {
     bool present;
     uint8_t pubkey[33];
     char    alias[32];
     uint8_t icon_w, icon_h;   // <= 64 (48 today)
     uint16_t icon_len;        // RLE bytes, <= 384
     uint8_t icon[384];        // 1bpp mono RLE
   } ClearsignIdentity;                 /* ~454 B */
   #define PERSISTENT_IDENTITY_COUNT 2
   // in struct Public:  ClearsignIdentity clearsign_identities[PERSISTENT_IDENTITY_COUNT];
   ```
2. Bump `STORAGE_VERSION` 17 → **18** (storage.h) + `storage_versions.inc`: change `LAST(17)` to
   `ENTRY(17)` + `LAST(18)`.
3. `storage_fromFlash()` (storage.c ~1184): the migration is **free** for existing devices —
   `memzero(dst, sizeof(*dst))` at the top already zero-inits the new array (⇒ present=false ⇒ no
   identities ⇒ no data loss). Add `case StorageVersion_17:` fallthrough into the current reader so a
   v17 device loads + is stamped v18 (`SUS_Updated`). Add a `case StorageVersion_18` that reads the
   new persistent field via a new `storage_readV18` (extends `storage_readV17`, then reads the
   identities block); add matching `storage_writeV18` to persist it. Mind the Public serialization is
   offset-based (`storage_readV17`/write pair) — append the identities block at the end, never reorder
   existing fields.
4. The existing `_Static_assert(sizeof(ConfigFlash) <= FLASH_STORAGE_LEN)` (storage.c:90) is the
   space gate — if 0.9 KiB overflowed, build fails (it won't).
5. **TEST (mandatory before merge):** storage upgrade matrix — seed a device on v17, flash v18, assert
   keys/label/policies intact + identities empty; then load an identity, reboot, assert it persists;
   WipeDevice clears it. Unit-test the reader/writer round-trip in `unittests/firmware/storage*`.

**Stages 2–4** unchanged (handler/render/messaging, boot click-through, vault) — see §5.

## 6. Open questions (need author decision)
1. Persistent identity slot count `N` (2? 3? 4?) — trades flash for how many providers persist.
2. Icon dims: 48×48 (recommended) vs 32×32 (cheaper) vs 64×64 (crisper, 512 B).
3. Do ALL loaded identities persist, or is persistence opt-in per load (a `persist` flag on msg 117)?
4. Protocol-icon trust: leave display-only, or eventually fold the protocol icon into the v2 schema
   so the identity attests it too? (Cleaner but bloats the signed blob.)
5. Feature flag name + default (off for 7.15.0; enable post-release).

## 7. Risks
- **Storage migration is brick-adjacent.** A bad `STORAGE_VERSION` migration can lose keys on upgrade.
  Stage 1 needs the full storage upgrade-path test matrix (old→new on a seeded device) before merge.
- device-protocol msg 117 must be added **fork-only** (never PR to keepkey/device-protocol).
- The `_Static_assert` is the space gate — if it fails, shrink icon cap or slot count, don't raise the
  sector size.

Related: [[clearsign-v2-static-schema]], [[clearsign-phase1-and-pdf]], [[keepkey-sdk-clearsign-coverage]],
`docs/relay-v2-schema-payload/` (the on-device v2 demo this builds on).
