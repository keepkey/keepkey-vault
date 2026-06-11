/**
 * Pure seed-staleness decision used to detect when the in-memory account
 * managers (btcAccounts / evmAddresses) hold addresses from a DIFFERENT seed
 * than the one currently active on the device.
 *
 * Lives here (shared/, no I/O imports) — modeled on device-switch.ts — so the
 * decision is unit-testable without the bun + USB/HID + sqlite stack.
 * src/bun/index.ts wires it into getBalances and the 'ready' state handler.
 *
 * Why this exists: the managers are reset by INFERRING seed changes from
 * scattered events, and every trigger has a blind spot:
 *  - 'needs_passphrase' reset    — skipped on reconnect with a pre-cached
 *                                  passphrase (device goes straight to ready).
 *  - device-switch reset         — skipped when the deviceId is unchanged.
 *  - 'seed-changed' reset        — skipped on hidden→standard transitions:
 *                                  hidden wallets never persist seed_eth_<id>
 *                                  (privacy), so the stored identity is the
 *                                  standard wallet's and matches once the
 *                                  device returns to it. No event fires.
 *  - passphrase toggle           — applySettings + clearSession changes the
 *                                  effective seed but resets only the engine's
 *                                  fingerprint/identity, not the managers.
 * Net effect (recurring customer bug): UI shows addresses/balances of the
 * previous wallet while the device OLED shows the current one.
 *
 * The fix checks the RESULT instead of the cause. The seed-identity address
 * the engine derives on every ready (ETH m/44'/60'/0'/0/0) is bit-for-bit the
 * same path as evmAddressPath(0), so the managers' index-0 address MUST equal
 * it. Any mismatch ⇒ the managers belong to another seed ⇒ purge and
 * re-derive. One invariant covers every cause, including future ones.
 */

/** True IFF both addresses are known and differ (case-insensitive) — i.e. the
 *  in-memory managers verifiably hold a different wallet than the device.
 *  Missing data on either side returns false: never purge on uncertainty
 *  (cold start, derivation failure, watch-only) — a wrongful purge would drop
 *  good data and force a pointless re-derivation. */
export function isManagerSeedStale(
  deviceSeedAddress: string | null | undefined,
  managerIndex0Address: string | null | undefined,
): boolean {
  if (!deviceSeedAddress || !managerIndex0Address) return false
  return deviceSeedAddress.toLowerCase() !== managerIndex0Address.toLowerCase()
}
