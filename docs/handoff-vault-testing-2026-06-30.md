# Handoff — Vault testing phase (2026-06-30, for context-clear)

**Next session's job:** get on latest `develop`, then run **automated (keepkey-sdk) + manual (on-device) testing** in vault. develop just absorbed a 10-PR sweep + this session's recovery/test work.

---

## develop is at `132a23d7`

Top of develop (newest first): #299 utxo-altcoin recover · #276 zcash sync · #301 wc camera-qr · #298 non-btc addresses · #303 clear-sign over-gating · #275/#282 zcash · #297 windows-build · #304 fw-release SOP · #305 hive notes · cb03bf82 wrong-word fix · #307 dashboard.
This session also landed **#306** (recovery cipher exposure) + `c2e3eafc` (SDK tests) further back.

## Sync your tree first (main tree is 10 behind, on `fix/fresh-wallet-receive-blocked`, dirty)
```
# 1) the merged branch is done (#307) — get onto develop
git checkout develop && git branch -D fix/fresh-wallet-receive-blocked
# 2) TWO dirty files conflict with the sweep — decide per file:
#    projects/keepkey-vault/src/bun/calldata-decoder.ts  (touched by #303 clear-sign)
#    projects/keepkey-sdk/package.json                    (touched by the sweep)
#    -> if your local edits ARE the now-merged work, discard: git checkout -- <file>
#    -> if they're separate WIP, stash: git stash push -- <file>
# 3) other dirt (modules/*, swagger.json) doesn't conflict — leave or clean as you like
git pull            # -> 132a23d7
```
(Pre-existing dirt is accumulated WIP from prior sessions — NOT from this session's work.)

---

## What this session delivered (all on develop)

- **#305** — Hive listed as a v7.15.0 upgrade-preview feature (`firmware-versions.ts`).
- **#306** — **Recovery cipher character entry exposed over REST + SDK.** New: `POST /system/recovery/character{,/delete,/done}`, `GET /system/recovery/state` (`{active,word_pos,character_pos,seq}`); SDK `sdk.system.recovery.sendCharacter/sendCharacterDelete/sendCharacterDone/getRecoveryState`; engine tracks last CharacterRequest + seq, resets on disconnect; long device ops use the 600s signing timeout. (Reviewed + fixed: namespace, committed lib, state reset, timeout.)
- **`c2e3eafc`** — committed 7 previously-untracked SDK tests: `tests/evm-firmware/` (6 clear-sign verifiers for #255/#260/#261) + `tests/recovery/load-verify.js`.
- **`cb03bf82`** — `tests/recovery/wrong-word.js` corrected to the real on-device rejection.

## ✅ On-device validation DONE this session
- 7.15.0 RC flashed; `getFeatures` confirms **version 7.15.0**.
- **#272 recovery validation CONFIRMED on real device**: recovery driven entirely through the new SDK/REST endpoints → device entered the cipher → invalid input rejected on-device with **"Words were not entered correctly. Make sure you are using the substitution cipher."** Full SDK→REST→firmware pipeline works.

---

## Test infrastructure (keepkey-sdk)
- Location: `projects/keepkey-sdk/tests/`. Runner: `npm run build && node tests/run-all.js [category]` (build first — `lib/` is a build artifact).
- Needs: vault serving `localhost:1646` + a **TEST device** (recovery/wipe tests are destructive); SDK auto-pairs on first connect (approve on device).
- Suites: `recovery/` (wrong-word #272, load-verify), `evm-firmware/` (6), plus tracked `evm-clearsign/`, `evm-adversarial/`, `chain/`, `zcash/`, `thorchain/`, `ton/`, `sweep/`.

## Testing plan (next phase)
**Automated (keepkey-sdk):** `node tests/run-all.js recovery` · `evm-firmware` · `evm-clearsign` · `chain`. Rebuild/restart the vault from synced develop first so the #306 endpoints are live.

**Manual / on-device priorities (from the 10-PR sweep):**
1. **#299 (UTXO account-N recovery) — CRITICAL, merged UNVERIFIED.** Verify before any release/master. Checklist on PR #299:
   - Spend: account-1-funded LTC/DOGE/DASH (acct 0 empty) → Send → signature must recover to the device address.
   - Re-track migration: anything tracked pre-fix must be re-tracked once.
   - Swap send-max: NEAR Intents MAX from that altcoin → deposit net-of-fee.
   - **If spend (1) or swap (3) fail → revert `d7f6cf22` / `cfb14ff3` before promoting.**
2. #276 (zcash sync), #301 (wc camera QR) — light smokes; failure modes self-healing/UX, not fund-loss.
3. **Firmware RC gating:** `docs/handoff-firmware-rc-7x-test-matrix.md` — the #272 seed/wipe G1–G12 (dry-run-no-wipe G4 is the critical one). RC is `release/7.15.0-rc1` (`e4208305`), version 7.15.0.

---

## ⚠️ KNOWN GOTCHAS (bit us this session — read before testing)
- **USB transport wedges after recovery/wipe ops.** Symptom: `fetch failed` / `other side closed` / `Unknown message` on device calls, while `/api/health` + pairing still work. **Fix: replug the device.** Start recovery tests from an **already-empty** device (the corrected wrong-word.js skips the wipe when empty) to avoid the reboot churn.
- **Unsigned RC boot gate.** Every reboot (incl. post-wipe) stops at the bootloader "unofficial firmware — take the risk?" gate → app not running → `Unknown message` for app calls. Confirm to boot, or use a **signed build** for smooth wipe/recovery cycles.
- **Recovery cipher automation ceiling.** Only the REJECTION path is scriptable (garbage → rejected). Entering a SPECIFIC seed needs the OLED scramble (human or DebugLink build). `wrong-word.js` hits the anti-non-cipher guard (5 identical chars), not the literal "Word not found in wordlist" path.
- **Contended main tree.** Lots of pre-existing uncommitted dirt. Never `git commit -a`; **verify the current BRANCH (not just the worktree) before committing** — this session I committed to `fix/fresh-wallet-receive-blocked` thinking it was develop (recovered; develop is clean).

## Open follow-ups
- In-app `engine.recoverDevice()` should also set `recoveryActive` so `/system/recovery/state.active` reflects UI-driven recovery, not just REST.
- Firmware RC release train: `release/7.15.0-rc1` → real upstream merge gated on device-protocol **#111** + python-keepkey **#196** (keepkey masters, days-long). RC needs clear-sign (#255–261) + hive + zcash firmware batches staged for a *real* 7.15.0.
