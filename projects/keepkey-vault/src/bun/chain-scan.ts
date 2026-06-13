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
import type { AuditToken } from '../shared/types'

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
 * whose receive index 0 is empty as a funded tree empty. UTXO chains (incl. BTC)
 * use the xpub-based per-account scan instead (auditScanUtxoAccounts) — Pioneer
 * gap-scans the whole account tree server-side, which is both faster and accurate.
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

/**
 * Account-level derivation paths (m/purpose'/coinType'/account') for a UTXO
 * chain, one per supported script type. Mirrors the dashboard's utxoPubKeyPaths
 * (getBalances) so an audit account scan matches what the portfolio tracks.
 * Bitcoin and Litecoin walk all three script types (legacy/segwit/native-segwit);
 * the rest use their single configured type. coinType comes from the chain's own
 * defaultPath[1]. Deriving the xpub per account lets Pioneer gap-scan the whole
 * account tree server-side — far faster than walking individual addresses.
 */
export function utxoAccountScriptPaths(chain: ChainDef, account: number): Array<{ scriptType: string; path: number[] }> {
  const scriptTypes = (chain.id === 'litecoin' || chain.id === 'bitcoin')
    ? [{ scriptType: 'p2pkh', purpose: 44 }, { scriptType: 'p2sh-p2wpkh', purpose: 49 }, { scriptType: 'p2wpkh', purpose: 84 }]
    : [{ scriptType: chain.scriptType || 'p2pkh', purpose: 44 }]
  return scriptTypes.map(st => ({
    scriptType: st.scriptType,
    path: [st.purpose + 0x80000000, chain.defaultPath[1], 0x80000000 + account],
  }))
}

/**
 * Native (human-readable) balance for `caip` from already-unwrapped portfolio
 * entries — the cross-family GetPortfolioBalances path the dashboard uses for
 * EVERY chain. Filters to native entries on the chain (by caip prefix), prefers
 * the exact caip, and reads its balance.
 *
 * Use this for ALL families. Do NOT use Pioneer's GetBalanceAddressByNetwork:
 * despite the name it is EVM-only (route /evm/balance → ETH JSON-RPC), so a
 * non-EVM networkId (bip122/cosmos/ripple) routes a foreign address into the
 * Ethereum provider, which 500s ("Invalid Ethereum address") — every non-EVM
 * single-address balance silently read 0.
 *
 * PURE and honesty-preserving: it never decides "couldn't verify". A degraded
 * (200-but-failed) response is the CALLER's job to map to balanceError.
 */
export function parseNativeScanResult(entries: any[], caip: string): { native: string; hasBalance: boolean } {
  const list: any[] = Array.isArray(entries) ? entries : []
  const prefix = String(caip).split('/')[0]
  const natives = list.filter(e => String(e?.caip || '').split('/')[0] === prefix && !isTokenEntry(e))
  const match = natives.find(e => e?.caip === caip) || natives[0]
  const native = String(match?.balance ?? '0')
  const n = parseFloat(native)
  return { native, hasBalance: Number.isFinite(n) && n > 0 }
}

/** A portfolio entry is a token (not the chain's native coin) when its CAIP
 *  asset part is present and is neither `slip44:` nor `native:`, or it's flagged
 *  as a token by type/contract. Mirrors the getBalances classifier in index.ts
 *  (Gate 2) so the audit and the dashboard agree on what "native" means. */
function isTokenEntry(e: any): boolean {
  const caipPath = String(e?.caip || '').split('/')[1] || ''
  const byCaip = !!caipPath && !caipPath.startsWith('slip44:') && !caipPath.startsWith('native:')
  const byType = e?.type === 'token' || (e?.isNative === false && !!e?.contract)
  return byCaip || byType
}

/**
 * Classify the already-unwrapped portfolio entries (natives + tokens) for ONE
 * EVM address into native + tokens. hasBalance is true when native > 0 OR any
 * token has a positive balance — so a token-only account (e.g. $0 ETH but $500
 * USDC) is correctly surfaced as funded, not a false empty. Native balance is
 * human-readable (Pioneer normalizes it), matching the dashboard.
 *
 * Takes entries (from unwrapPortfolioResponse), NOT the raw response, so its
 * entry-extraction can't diverge from the unwrap the rest of the codebase uses.
 *
 * PURE — and honesty-preserving: it NEVER decides "couldn't verify". A degraded
 * (200-but-failed) or thrown response is the CALLER's job to map to balanceError;
 * this only reports what was actually present.
 */
export function parseEvmScanResult(entries: any[]): { native: string; hasBalance: boolean; tokens: AuditToken[] } {
  const list: any[] = Array.isArray(entries) ? entries : []
  let native = '0'
  const tokens: AuditToken[] = []
  for (const e of list) {
    const bal = String(e?.balance ?? '0')
    if (isTokenEntry(e)) {
      if (parseFloat(bal) > 0) {
        tokens.push({
          symbol: e?.symbol || '???',
          name: e?.name || e?.symbol || 'Token',
          balance: bal,
          balanceUsd: Number(e?.valueUsd ?? 0),
          caip: String(e?.caip || ''),
        })
      }
    } else {
      // Native entry for this chain. We request a single caip+pubkey, so there's
      // at most one; if Pioneer returns several, the funded one wins.
      if (parseFloat(bal) > 0 || native === '0') native = bal
    }
  }
  const n = parseFloat(native)
  const hasBalance = (Number.isFinite(n) && n > 0) || tokens.length > 0
  return { native, hasBalance, tokens }
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
