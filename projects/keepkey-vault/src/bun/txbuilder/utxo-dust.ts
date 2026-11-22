/**
 * Dust limits for change outputs on UTXO chains.
 *
 * coinselect only adds change above 148 × feeRate (444 sat at 3 sat/vB), which
 * is below what nodes accept for most scripts, so a change output a node
 * rejects as dust could be created. These limits follow each node's own policy:
 * GetDustThreshold = dustRelayFee × (output size + size of spending it).
 */

// Bytes for the output plus the input that later spends it, as GetDustThreshold
// counts them (the witness part of a SegWit spend at a quarter weight: 32+4+1+26+4).
const DUST_SPEND_BYTES: Record<string, number> = {
  p2pkh: 34 + 148,
  'p2sh-p2wpkh': 32 + 148, // P2SH is not a witness program, so it is counted as a legacy spend
  p2wpkh: 31 + 67,
  p2tr: 43 + 67,
}

// DUST_RELAY_TX_FEE in sat per byte (sat/kvB ÷ 1000), from each node's policy.h.
const DUST_RELAY_SAT_PER_BYTE: Record<string, number> = {
  bitcoin: 3,
  bitcoincash: 3, // BCHN: 1000 sat/kB × 3
  dash: 3,
  litecoin: 30,
  digibyte: 30,
}

// Dogecoin Core sets a flat limit; outputs under 0.01 DOGE need extra fee to relay.
const DOGE_DUST_LIMIT = 1_000_000

/** Smallest change output a node of this chain relays, for the change script type. */
export function changeDustLimit(chainId: string, scriptType: string): number {
  if (chainId === 'dogecoin') return DOGE_DUST_LIMIT
  // An unknown script type gets the legacy size, the largest of the four.
  const bytes = DUST_SPEND_BYTES[scriptType] ?? DUST_SPEND_BYTES.p2pkh
  // An unknown chain gets the higher relay fee, so we never emit dust there.
  const rate = DUST_RELAY_SAT_PER_BYTE[chainId] ?? 30
  return bytes * rate
}

/**
 * Drop a change output below the dust limit and add its value to the fee.
 * Outputs without an address are change; spend outputs are never touched.
 */
export function foldDustChange<O extends { address?: string; value?: number }>(
  outputs: O[],
  fee: number,
  dustLimit: number,
): { outputs: O[]; fee: number; folded: number } {
  let folded = 0
  const kept = outputs.filter(output => {
    if (output.address || !output.value || output.value >= dustLimit) return true
    folded += output.value
    return false
  })
  return { outputs: kept, fee: fee + folded, folded }
}
