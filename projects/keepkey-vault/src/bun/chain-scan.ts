/**
 * Generalized per-chain address derivation + explorer helpers for the Audit
 * wizard's per-chain walkthrough. Lets the wizard scan ANY chain at account/
 * index "level" N and link to a block explorer, reusing the dispatch the
 * getBalances handler already uses (ChainDef.rpcMethod + defaultPath).
 *
 * The functions here are PURE (no device/Pioneer/db) so they're unit-testable;
 * the RPC handler in index.ts performs the actual wallet[method]() and Pioneer
 * calls using what these return.
 */
import { evmAddressPath, type ChainDef } from '../shared/chains'

// Families with no single-receive-address scheme custom-path derivation can walk:
//  - zcash-shielded: Orchard FVK, not an address
//  - hive: getPublicKey returns a key, not a spendable address
const DEEP_SCAN_EXCLUDED = new Set(['zcash-shielded', 'hive'])

/** Custom-path derivation (auditDeriveCustom) is possible for a chain. */
export function chainSupportsDeepScan(chain: ChainDef): boolean {
  return !DEEP_SCAN_EXCLUDED.has(chain.chainFamily)
}

/**
 * Whether the per-account LEVEL scan (auditScanLevels) is meaningful.
 *
 * Excludes UTXO: a single-receive-address balance check would misread an account
 * whose receive index 0 is empty as a funded tree empty. BTC higher accounts are
 * discovered correctly by the initial sweep (xpub-aware, all script types,
 * receive 0/1/2 + change) and recovered via addBtcAccount — the level scan would
 * be both redundant and less accurate.
 */
export function chainSupportsLevelScan(chain: ChainDef): boolean {
  return chain.chainFamily !== 'utxo' && chainSupportsDeepScan(chain)
}

/**
 * Derivation path for a chain at account/index "level" N. EVM bumps the hardened
 * BIP44 account element [2] via evmAddressPath (m/44'/60'/N'/0/0, last element
 * stays 0) — exactly what addEvmAddressIndex tracks, so the scanned path equals
 * the tracked path. Every other family also bumps account element [2] of its
 * defaultPath. (NB: AuditCustomPath's guided EVM stepper varies the same [2]
 * element; only the advanced raw field can reach arbitrary paths.)
 */
export function chainLevelPath(chain: ChainDef, level: number): number[] {
  if (chain.chainFamily === 'evm') return evmAddressPath(level)
  const path = [...chain.defaultPath]
  // [2] is the BIP44 account index across every non-EVM family (verified in chains.ts).
  if (path.length > 2) path[2] = 0x80000000 + level
  return path
}

/** The wallet method + params to derive an address for `path` on `chain`. */
export function deriveAddressParams(chain: ChainDef, path: number[]): { method: string; params: Record<string, any> } {
  // ChainDef names the XRP method 'xrpGetAddress', but the hdwallet method is 'rippleGetAddress'.
  const method = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
  const params: Record<string, any> = { addressNList: path, showDisplay: false, coin: chain.coin }
  if (chain.scriptType) params.scriptType = chain.scriptType
  if (chain.chainFamily === 'ton') params.bounceable = false
  return { method, params }
}

/** Normalize the varied wallet getAddress return shapes to a plain address. */
export function extractAddress(result: any): string {
  if (typeof result === 'string') return result
  return result?.address || result?.publicKey || ''
}

/** Native (human-readable) balance from a Pioneer GetBalanceAddressByNetwork response. */
export function parseNativeBalance(resp: any): { native: string; hasBalance: boolean } {
  const data = resp?.data || resp || {}
  const native = String(data.nativeBalance ?? data.balance ?? '0')
  const n = parseFloat(native)
  return { native, hasBalance: Number.isFinite(n) && n > 0 }
}

export function explorerAddressUrl(chain: ChainDef, address: string): string | null {
  if (!chain.explorerAddressUrl || !address) return null
  return chain.explorerAddressUrl.replace('{{address}}', address)
}

export function pathToBip32(path: number[]): string {
  return 'm/' + path.map(n => (n >= 0x80000000 ? `${n - 0x80000000}'` : String(n))).join('/')
}

/**
 * Parse a BIP32 path string ("m/44'/60'/0'/0/5", apostrophe or `h` for
 * hardened) into a number array. Returns null on anything malformed — the
 * advanced raw custom-path entry must never feed the device a bad list.
 */
export function parseBip32Path(input: string): number[] | null {
  const trimmed = input.trim().replace(/^m\//i, '')
  if (!trimmed) return null
  const parts = trimmed.split('/')
  const out: number[] = []
  for (const raw of parts) {
    const hardened = /['h]$/i.test(raw)
    const numStr = hardened ? raw.slice(0, -1) : raw
    if (!/^\d+$/.test(numStr)) return null
    const num = parseInt(numStr, 10)
    if (!Number.isInteger(num) || num < 0 || num >= 0x80000000) return null
    out.push(hardened ? num + 0x80000000 : num)
  }
  if (out.length < 2 || out.length > 10) return null
  return out
}
