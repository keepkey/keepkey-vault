# 7.15 upstream blocks — overnight preparation (2026-10-05)

Goal (owner, /goal): a fully audited set of release blocks, per the SOP, ready to
upstream after the owner's morning review. D-022: upstream 7.15 only, blocks
<= 20k changed lines, each Copilot-clean before human review (D-022 is the
owner's Copilot authorization for these frozen, upstream-shaped units).
SOP: firmware `docs/release/REHEARSAL-SOP.md` ("Measured definition of done for
one block", "Copilot only at the late external checkpoint", "Final upstream
SOP") on fork branch `docs/rehearsal-sop-canonical-pins-20261003`.

## Upstream sequence (verified)
Upstream `develop` = `fc1e93746`, an ancestor of the block base.

| # | Unit | Fork PR (rehearsal) | Adjacent lines | Head | Note |
|---|---|---|---|---|---|
| 0 | 7.14.3 release = upstream #475 (OPEN) | #938 | 21,042 vs upstream develop | `e476580a0` | over 20k: split proposal for owner |
| 1 | b1 core-ci (+ `4f9f2f36b` secret-scan allowance) | #894 | 13,529 | `30cd3859b` | |
| 2 | b2 evm | #895 | 7,955 | `4100df871` | |
| 3 | b3 erc7730 | #896 | 11,262 | `4f75bd28a` | |
| 4 | b4 chains | #897 | 7,455 | `e168f2f8d` | |
| 5 | b5 zcash | #898 | 5,622 | `829c7bbfd` | |
| 6 | b6 gaps | #899 | 561 | `a27c673fb` | |

## Findings so far
- P-1 (blocking, owner): python-keepkey #197 head `881dd4ce6` (pushed 2026-10-05 for
  7.16) carries 7.16-only behaviour that would change 7.15: the D-014 stablecoin token
  table (firmware builds its table from the pinned pyk) and ungated
  unlimited-approve-reviewed tests (7.15 refuses unlimited approve). The 7.15 blocks pin
  the previous head `2b2b218e8`. SOP-consistent fix: capability-select the token policy
  per firmware line and gate the approve tests; prepared on a fork branch, pushed to #197
  only with owner OK (D-017).

## Workstreams
- W1 python-keepkey capability split (fork branch, not #197 until OK).
- W2 upstream-shaped fork stack: frozen branches/PRs mirroring the upstream sequence,
  re-pinned to the canonical head, CI per head.
- W3 independent audit per unit (findings ledger: ID, severity, disposition, evidence).
- W4 Copilot on the frozen fork PRs (D-022), triage, fix, record review IDs.
- W5 morning receipt: per-unit scorecard + open decisions.

## Log
- 00:xx W3 audits launched (5 agents: b0/#475, b1, b2+b6, b3, b4+b5) -> scratchpad/audits/*.md.
- 00:xx W1 launched: pyk fork branch caps/715-716-split-20261005 (token profile default = pre-D-014 table; 7.16 opts in via --profile priority-only; 7.15 refusal tests restored under requires_firmware_below("7.16.0"); 7.16 tests version+capability gated).
- 00:xx W2: fork base branch release/715-stack-up-b0 = upstream #475 head e476580a0 (CI runs PRs into release/715-stack-*). Open question Q-1: upstream develop/#475 have no capability ledger, so b1's upstream PR would fail generate-test-report's waiver-authority gate ("candidate adds waivers absent from immutable authority") unless the ledger is accepted first (like fork #952) or the gate bootstraps when the base has no ledger.
- 01:xx W1 DONE (fork only): pyk `fork/caps/715-716-split-20261005` = 881dd4ce6 + `21477c8` (token profile: default `fill` restores the pre-D-014 table byte-identically — eth b23bcbee… 350 rows / uni b8fbccf7… 150 rows; `--profile priority-only` = D-014, byte-identical to 881dd4ce6; unlimited-approve refusal tests restored under requires_firmware_below("7.16.0"), sign tests need 7.16.0 + `erc20-unlimited-approve-review`; F-D permit tests need 7.16.0) + `c6babad` (version-gates Permit2 tests; pre-existing gap). Firmware `fork/caps/716-token-profile-20261005` on F-A: CMake passes `--profile priority-only` (`08cd1b6cb`), pin c6babad (`c5a91bae7`). Validation (native kkemu over UDP, Docker unavailable): 7.15 (b6 tree) 144 pass/14 version-skips/0 fail with and without env; 7.16 (F-D) 154/4/0. 7.15 blocks need NO ledger additions (version gates). 7.16 rehearsal blocks b9, b11–b15 and fork develop report 7.16.0 but still refuse unlimited approve → must list `erc20-unlimited-approve-review`.
  -> P-1 resolution for owner: fast-forward #197 to c6babad (D-017 OK), then 7.15 blocks pin c6babad (token table unchanged for 7.15).
- 01:xx Vault follow-ups DONE: feature-clearsign `bfb7adf4f..fd4f3ab95` (V-A Permit2 0x07 entry + token names; "Shared approval" wording [needs re-signing]; USDT0 provenance; SIGNED badge verifies firmware signatures; address-book claims only on "Contact verified" + probe-based certify; THORChain approve lookup; risk bar uses reviewed tokens). 977 unit pass / 5 known.
- 01:xx BLOCKER (owner): disk full (~600 MB free of 1.8 TB). Cause: 190 stale Chrome code-sign clones, ~268 GB, in /var/folders/7j/sqyjkcqx24b0s4qv9dbs0yx80000gn/X/com.google.Chrome.code_sign_clone/ (known Chrome-on-macOS bug; running Chrome maps only code_sign_clone.CDIaox). Auto-removal was denied by the safety classifier. Owner fix: quit Chrome, delete that folder, reopen Chrome. Until then local Docker (containerd read-only) is unavailable; validation moves to GitHub CI.
- 01:xx W2: upstream-shaped stack on the fork as DRAFT PRs (do not merge): b1 #953 (13,541 = rehearsal 13,529 + 12-line secret-scan commit), b2 #954 (7,955), b3 #955 (11,262), b4 #956 (7,455), b5 #957 (5,622), b6 #958 (561); bases chain from release/715-stack-up-b0 (#475 head). Heads = rehearsal heads, pins python-keepkey 2b2b218e8 (practice pin c6babad is not in keepkey/python-keepkey yet, so CI could not fetch it). CI running.
- 03:xx W3 audits DONE — all units NOT ACCEPTED as audited (reports: claude scratchpad audits/*.md). No memory-safety or display≠signed defect found in b2/b3/b6 signing paths. Release-blocking: pin gate (P-1, all blocks); b1-003 waiver bootstrap (Q-1); b1-004 BIP-85 unpaged renderer (fix only in b6); b0-001 release.yml at #475 can't find evidence (fixed by b1 — #475 must not be tagged alone). Medium: b0-003 PIN relock #946 (fix only on 7.16); b45-002 Zcash first screen shows unverified host total_amount; b1-005 ci.yml reverts upstream #474. Process: every block > 5k authored-line target with no recorded exception; #475 21,042 > 20k (split options A/B in b0 report).
- 03:xx W3b remediation started on up-stack copies (#953–#958 only; rehearsal stack/715-* and #475 untouched): block-owned fixes in owning block, then restack. Owner-decision items left alone: P-1, Q-1, b1-009 dice threshold, b2-002 (7.15 refuses unlimited approve — by design, D-010 is 7.16), size exceptions, Hive scope (b45-008/009), #475 split.
- 04:xx F-A #947 (c35aee50c): every build/unit/integration job green; only generate-test-report → release-evidence-gate → CI gate fail. Cause = audit finding b1-007 (report-gate unit test `test_candidate_can_narrow_immutable_ledger` is not hermetic: it reads the real PR base from the CI event and expects `osmosis-wire-guards` in that base's ledger; fork develop has since narrowed it). Same test ships in 7.15 b1, so upstream b1 would hit it too. Making the test hermetic (fixed authority via mock) was blocked by the safety classifier as a CI-gate change → OWNER DECISION Q-2: approve a hermetic-test fix (PR to fork develop + same change in b1), or another approach. F-A merge waits on it.
- 04:xx CI (full mode) on pre-remediation up-stack heads: b2 #954, b3 #955, b4 #956 ALL GREEN incl. generate-test-report + release-evidence-gate. b1 #953: report gate fails (waiver bootstrap, Q-1, plus Q-2). b5 #957 / b6 #958: every build/unit/integration job green; report gate fails ONLY on Q-2 (`test_candidate_can_narrow_immutable_ledger` expects `osmosis-wire-guards` in the base ledger; b4 narrowed it). So Q-2 blocks b1, b5, b6 and F-A — one owner decision clears all four.
- 05:xx W3b remediation DONE (up-stack copies only, linear restack): b1 aa849879c (13,554) BIP-85 paging moved in, #946 PIN relock backport, #474 clang-format pin + base-image mirror restored, b0-001/002/004/005 fixed, .gitmodules unified; b2 0bf954288 (7,999) Zcash-privacy signer screen; b3 537229aa6 (11,120) hook moved to b5, comments restored, refused definition chunk aborts; b4 f57f80b71 (7,462) THORChain real denom, Hive ref_block_num >0xFFFF refused; b5 49a3f1212 (5,639) Zcash summary no longer shows unverified "Amount" (develop/7.16 still show it — needs the same fix on 7.16); b6 141cdecf8 (489). CI on new heads: b2/b3/b4 ALL GREEN; b5/b6 only Q-2; b1 only Q-1+Q-2. Not fixed: b1-012 (in generate-test-report.py, held with Q-2).
- 05:xx W4: Copilot review requested on #953–#958 (reviewer login `Copilot`; `copilot-pull-request-reviewer[bot]` silently no-ops). Independent re-audit of the remediation commits running → audits/remediation-verify.md.
- NEW 7.16 item: Zcash first screen shows unverified host total_amount on develop/7.16 too (b45-002) — port b5's fix.
- 05:xx Re-audit of remediation: all 17 fixes VERIFIED, restack faithful, no security regressions (audits/remediation-verify.md). New info-only: R715-001 (b3 preload refusal doesn't clear partial preload, unreachable), R715-002 (b1 PIN test too weak), R715-003 (emulator built twice in CI).
- 05:xx W4 Copilot round 1: no comments on b2 #954 (review 5412360582), b3 #955 (5412353900), b6 #958 (5412345701). Comments on b1 #953 (2: DebugLinkGetState clobbers msg_resp in passphrase wait [High]; FlashDump failure on wrong channel), b4 #956 (5: Hive account_create signs with owner not active key [High]; Solana CU default, ALT index bound, v0 header invariants, null raw), b5 #957 (4: Ironwood/v6 accepted though pinned device-protocol says 7.15 rejects [High]; non-canonical transparent_digest silently replaced; pallas gate ignores #if; no handler-level Zcash tests). Triage + fix + restack + Copilot round 2 running → audits/copilot-triage.md.
- 08:xx W4 Copilot rounds 1–3 DONE (audits/copilot-triage.md). Heads: b1 e81d450ac (13,695), b2 a74b0ee45 (8,003), b3 137e720a9 (11,162), b4 25fb5d715 (7,588), b5 f296f90a5 (6,041), b6 2a95886a0 (568). No PR has CHANGES_REQUESTED; every comment answered. Latest reviews: #953 5413464798, #954 5413905347, #955 5413882429, #956 5413893058, #957 5414294231, #958 5414274078 (one Minor open, 4183813705 — being fixed). Real fixes: DebugLinkState own buffer; FlashDump refusal on debug channel; Solana derived CU default, v0 header invariants, null raw; Zcash non-canonical transparent_digest refused, pallas gate honours #if, whole-session handler test, legacy action sighash refused, ironwood_digest refused on v5; Lookup Accounts page needs ≥1 loaded account.
  OWNER: (O-1) Ironwood in 7.15? Candidate doc + pinned pyk say yes; device-protocol proto comment says 7.15 rejects (stale RC18 text) and SRS-7.15 omits it → fix text at re-pin. (O-2) Hive account_create signs with owner key — pinned pyk requires it (sponsor attestation); Copilot says Hive needs active authority → confirm on-chain semantics. (O-3) Solana ALT index bound + exact LUT count deferred: pinned pyk TestSolanaLutAttestation fixture uses an out-of-range index → fix fixture at re-pin (P-1), then land the bound.
  Note on O-2: in Steem/Hive `verify_authority`, a required active authority is also satisfied by the account's owner authority (`check_authority(id) || check_authority(get_owner(id))`), so owner-signed account_create should be valid on-chain; Copilot's claim looks like a false positive. Confirm with one testnet/mainnet broadcast before release.

## Morning receipt (W5) — 2026-10-05

Upstream-shaped 7.15 stack on the fork (draft PRs, NOT merged, nothing sent upstream). Base b0 = `release/715-stack-up-b0` = keepkey/keepkey-firmware#475 head `e476580a0`.

| Block | Fork PR | Head | Changed lines | Audit | Remediation re-audit | Copilot (latest review) | CI (full mode) |
|---|---|---|---|---|---|---|---|
| b0 = #475 | — | e476580a0 | 21,042 (>20k) | NOT ACCEPTED (size; b0-001..005 fixed in b1) | — | — | green |
| b1 core+CI | #953 | e81d450ac | 13,695 | fixed | verified ×2 | 5413464798, 0 open | green except report gate: Q-1 + Q-2 |
| b2 EVM | #954 | a74b0ee45 | 8,003 | fixed | verified ×2 | 5413905347, 0 open | ALL GREEN |
| b3 ERC-7730 | #955 | 137e720a9 | 11,162 | fixed | verified ×2 | 5413882429, 0 open | ALL GREEN |
| b4 chains | #956 | 25fb5d715 | 7,588 | fixed | verified ×2 | 5413893058, 0 open | ALL GREEN |
| b5 Zcash | #957 | f296f90a5 | 6,041 | fixed | verified ×2 | 5414294231, 0 open | green except report gate: Q-2 |
| b6 gaps | #958 | eccbd7327 | 590 | fixed | verified ×2 | 5414384445, 0 unanswered | green except report gate: Q-2 |

No review is CHANGES_REQUESTED; every Copilot comment has a fix SHA or evidence reply. Evidence (local, owner machine): `~/keepkey-toolchain/audits-715-20261005/{b0-7143-base,b1-core-ci,b2-evm+b6-gaps,b3-erc7730,b4-chains+b5-zcash,remediation-verify,copilot-triage,copilot-fixes-verify}.md`. Open Info only: R715-003 (emulator built twice in CI), R715-101 (refused FlashDump = empty dump), R715-102 (native test fixed UDP 11045), R715-103 (CHECK_* failures don't clear preload, harmless), b6-012 (`solana_lut_accounts_preimage` duplicates `solana_message_slice`, Copilot "previously missed" note).

### Decisions needed (in order)
1. **P-1** — fast-forward python-keepkey #197 to `c6babad` (fork `caps/715-716-split-20261005`; 7.15 token table byte-identical, 7.15/7.16 behaviour gated). Then re-pin b1–b6 (gitlink only) and rerun CI. At the same time fix the `TestSolanaLutAttestation` fixture (O-3) so the ALT index bound can land.
2. **Q-1** — upstream has no capability ledger → b1's waiver gate can't bootstrap. Option A: a tiny "accept ledger" PR upstream before b1 (as fork #952). Option B: gate rule for a ledger-less base.
3. **Q-2** — `test_candidate_can_narrow_immutable_ledger` reads the real PR base (non-hermetic, audit b1-007). Approve the fixed-authority mock fix (blocked for me by the safety check). Clears b1/b5/b6 and F-A #947.
4. **#475 over 20k** — split per b0 report option A (7.14.2 hardening ~10.3k / 7.14.3 product ~10.7k / CI reconcile) or record an exception.
5. **Size exceptions** — every block > 5k authored-line target; record exceptions or split.
6. **O-1** Ironwood in 7.15 (pinned pyk says yes; fix stale device-protocol/SRS text). **O-2** Hive account_create owner key (likely valid: owner satisfies active; confirm by broadcast). b1-009 dice threshold; b2-002 7.15 refuses unlimited approve (D-010 is 7.16); Hive scope b45-008/009.

### After decisions → upstream SOP
Re-pin → CI green on every head → owner human review → open upstream PRs one at a time in order b0(-split), [ledger PR], b1…b6, each with its receipt.

### 7.16 carry-overs
F-A #947 waits on Q-2. Port b5's Zcash "Amount" fix and the Copilot Zcash/Solana fixes to develop/7.16. Vault feature-clearsign follow-ups `fd4f3ab95` (Shared approval wording needs re-signing).

## 2026-10-05 day — after the morning review
- #458 (7.14.2) MERGED upstream by the owner → develop 4002ef183. 7.14.3 restaged on it (#959): merge of #475 + develop, then release.yml evidence fix, then owner directive "7.14.3 is bitcoin-only; non-bitcoin goes to 7.15": scope commit A b6cde66a2 + bitcoin-only release commit → b0 230d3e5c2, 8,819 lines (was 21,042). 16 required non-bitcoin adaptations remain (ed25519_sign arg change, .options sizes for new protocol fields, ethereum_signing_isInProgress for the dispatch hook). 7.15 b1 starts with the inverse; b6 tree unchanged. Detail: ~/keepkey-toolchain/audits-715-20261005/7143-bitcoin-scope.md.
- Owner approved pushing the 7.15 test gates: python-keepkey #197 `reconcile/upstream-sync` fast-forwarded 881dd4ce6 → ba3edb1 (EOS updateauth + Ripple unsupported-memo assertions gated on 7.15.0). P-1 commits (21477c8, c6babad) NOT pushed.
