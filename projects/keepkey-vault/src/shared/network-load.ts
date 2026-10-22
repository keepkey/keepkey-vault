/**
 * First-load estimate for the network picker. Every number is a measured cost
 * from a real first dashboard load after connecting (the `[getBalances] timing`
 * and `derived in` log lines), never a guess.
 *
 * ponytail: one device, one run (MEASURED_ON). Re-measure when the load path
 * changes; per-device calibration from those log lines if estimates drift.
 */
export const MEASURED_ON = 'KeepKey, firmware 7.16.0, first load after launch, 2026-10-22 (35.7 s total)'

/** Paid with any choice: Bitcoin accounts (6.3 s), the seed identity check,
 *  which also reads the EVM address, and the Pioneer call. */
export const BASE_MS = 10525

/** Device time each network adds. Bitcoin-style chains share one batched call at
 *  ~1.3 s per path (Litecoin reads 4 script types). EVM networks are absent: they
 *  reuse the address the seed check already read, so turning them off saves none. */
export const NETWORK_MS: Record<string, number> = {
  litecoin: 5203,
  dogecoin: 1301,
  bitcoincash: 1301,
  dash: 1301,
  digibyte: 1301,
  zcash: 1301,
  cosmos: 1656,
  thorchain: 1660,
  mayachain: 1657,
  osmosis: 1476,
  ripple: 1653,
  solana: 1142,
  tron: 1653,
  ton: 1315,
  hive: 1291,
}

export function estimateLoadMs(enabled: Iterable<{ id: string }>): number {
  let ms = BASE_MS
  for (const c of enabled) ms += NETWORK_MS[c.id] ?? 0
  return ms
}
