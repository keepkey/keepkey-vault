# 06 — Signing idle-timeout fix (consecutive signs)

**What:** `Bun.serve` had no `idleTimeout` → default 120s. A human-gated sign
blocks the response while the user confirms; on the SECOND consecutive sign the
wait exceeded the socket idle window, Bun closed the connection
(`other side closed`), aborting the in-flight sign mid-confirm (device returned
home). Set `idleTimeout: 0` — device signing must not time out at the socket.

**Where:** vault `#342` (OPEN) —
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/rest-api.ts`
(`Bun.serve({ idleTimeout: 0, … })`). Test helper: `CLEARSIGN_FLOW=<key>` runs a
single flow in `clearsign-signer-flows.js`.

## Test
- Emulator + rc7, Vault with #342: run the FULL 3-flow suite (no `CLEARSIGN_FLOW`):
  `node tests/evm-clearsign/clearsign-signer-flows.js`.

## Verify
- [ ] All **3 consecutive** flows (aave-supply, erc20-transfer,
      erc20-approve-unlimited) sign in one run — the 2nd no longer hangs /
      `other side closed`.
- [ ] Each single flow via `CLEARSIGN_FLOW=<key>` also passes (already confirmed
      erc20-transfer + approve-unlimited individually this session).

## Status / gotchas
- **Root cause vs symptom:** idle-timeout removes the socket-close *symptom*. If
  the 2nd sign STILL hangs (no close, just stuck), there's a deeper emulator
  poll-thread/transport state bug — that was the original "busy/queue" report and
  is NOT yet root-caused. Confirm 3-in-a-row genuinely completes before closing.
</content>
