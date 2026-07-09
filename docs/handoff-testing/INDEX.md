# New-feature test handoffs (session 2026-07-08)

Every NEW feature/fix from this session, each with its own handoff below. Test
in roughly this order (device-independent first, then emulator, then swaps).
Full paths per repo convention.

| # | Feature | Repo / PR | Merged? | Needs |
|---|---------|-----------|---------|-------|
| 01 | Persistent clear-sign identities + logo render | firmware #299, hdwallet #53, vault #342 | all OPEN (rc7) | emulator + device |
| 02 | Clearsign vendored allowlist + LoadClearsignSigner endpoint | vault #337 | merged | device (blind-sign gating) |
| 03 | Emulator never-dead-click | vault #338 | merged | emulator (failure path) |
| 04 | Emulator capture-frame + seed-reveal/version tooling | vault #339 | merged | emulator |
| 05 | LoadClearsignSigner emulator confirm button | vault #341 | merged | emulator |
| 06 | Signing idle-timeout fix (consecutive signs) | vault #342 | OPEN | emulator (3 consecutive signs) |
| 07 | Clear-sign icon encoder + catalog tooling | vault #342 | OPEN | local (self-test) + emulator |
| 08 | keepkey-sdk clear-sign test train | vault #340 | merged | local (offline) + device |
| 09 | Vault↔API perf telemetry | vault #334, pioneer #164 | merged | deploy + data-flow |
| 10 | RUJI dashboard icon (CDN) | CDN upload | live | dashboard eyeball |
| 11 | Rujira THORNode failover | pioneer #165 | merged | RUJI/TCY swap quote |
| 12 | Firmware emulator-ABI graft (testable dylib) | firmware feat/clearsign-plus-emu-dylib | rc7 branch | prerequisite for 01/03/04/05 |

## Environment prerequisites
- Emulator dylib: `~/.keepkey/emulator/libkkemu.dylib` must be built from a
  firmware branch that has **both** clear-sign AND the emu ABI (`kkemu_start`).
  That is `feat/clearsign-persistent-identity-icons` / `release/7.15.0-rc7`
  (handoff 12). Rebuild: `cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11 && make build-emulator`, then **reload the emulator in Vault**.
- Vault on :1646 built from a checkout that has vault #342 (icon route +
  idle-timeout). `make vault` from
  `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11`.
- Real device: a `release/7.15.0-rc7` DEBUG_LINK build for the automated
  python/SDK suites (they wipe + load the public test seed — never real funds).

## Known open items (not per-feature)
- Consecutive-sign root cause: idle-timeout (06) removes the socket-close
  symptom; confirm 3 signs in a row actually complete before calling it done.
- Firmware #299 SOP gate: CI green + device-protocol **upstream**-pin swap
  before the final release (rc is fork-pinned).
</content>
