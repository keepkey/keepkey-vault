/**
 * CoreBackend — self-host Bitcoin Core (and Core-compatible) node over JSON-RPC.
 * Isolation: imports only types + bs58check, NEVER ../pioneer. Enabling a node
 * routes BTC data here instead of Pioneer, with NO auto-fallback — a failed node
 * throws a verbose, actionable error so the user fixes their node (sovereignty
 * stance, see design doc).
 *
 * Bitcoin Core indexes by outpoint, not address, so we SCAN: scantxoutset over a
 * descriptor built from the xpub/address (pruned-OK, gives balance+UTXOs, no
 * history). estimatesmartfee / sendrawtransaction / getrawtransaction round it
 * out. getrawtransaction needs txindex=1 (for spending legacy inputs).
 */
import type { BtcBackend, BtcUtxo, BtcFeeRates } from './types'
import bs58check from 'bs58check'

export interface CoreConfig {
  url: string        // http://host:port
  auth?: string      // "rpcuser:rpcpassword" (or cookie file contents)
  timeoutMs?: number
}

const DEFAULT_TIMEOUT = 30_000
const SCAN_TIMEOUT = 300_000 // scantxoutset walks the whole UTXO set — can take minutes

// Bitcoin Core runs ONE scantxoutset at a time, process-wide (it's a global node op).
// Concurrent balance/fee/send scans otherwise collide with -8 "Scan already in
// progress". Serialize every scan through this single chain so they queue instead.
// ponytail: one global lock — fine, the node itself is the bottleneck (one scan max).
let scanLock: Promise<unknown> = Promise.resolve()

// Live scan progress for the status bar. scantxoutset gives no callback, but its
// 'status' action can be polled on a separate connection while a scan runs.
let scanState: { scanning: boolean; progress: number } = { scanning: false, progress: 0 }
export function getCoreScanState(): { scanning: boolean; progress: number } { return scanState }

// UTXO cache. A Core scantxoutset walks the entire UTXO set (minutes); without this,
// one send = three full scans (balance + fee estimate + build) and the UI is unusable.
// The dashboard balance load scans and warms this, so a send within the TTL reuses it
// instead of re-scanning — that's the "scan on load, not at send time" behaviour.
// Broadcast clears it so a just-spent UTXO is never re-selected (double-spend guard).
// ponytail: 2-min TTL trades ≤2-min-stale balance for a usable node; refresh/send is
// always live after that. Longer window → add an explicit "rescan" button.
const SCAN_CACHE_TTL = 120_000
const utxoCache = new Map<string, { at: number; utxos: BtcUtxo[] }>()

// ── Pure helpers (exported for unit test; no network) ─────────────────────────

/** SLIP-132 version bytes → the script function Core needs. We re-encode to a
 *  standard xpub (0x0488b21e) so Core's descriptor parser accepts it. */
const SLIP132_SCRIPT: Record<string, 'wpkh' | 'sh_wpkh' | 'pkh'> = {
  '0488b21e': 'pkh',     // xpub  — legacy p2pkh
  '049d7cb2': 'sh_wpkh', // ypub  — p2sh-wrapped segwit
  '04b24746': 'wpkh',    // zpub  — native segwit
}

export function xpubToDescriptorParts(xpub: string): { stdXpub: string; script: 'wpkh' | 'sh_wpkh' | 'pkh' } {
  const data = Buffer.from(bs58check.decode(xpub))
  const version = data.subarray(0, 4).toString('hex')
  const script = SLIP132_SCRIPT[version]
  if (!script) throw new Error(`Unsupported xpub version bytes ${version} — self-host supports mainnet xpub/ypub/zpub`)
  const std = Buffer.concat([Buffer.from('0488b21e', 'hex'), data.subarray(4)])
  return { stdXpub: bs58check.encode(std), script }
}

export function descriptorFor(script: 'wpkh' | 'sh_wpkh' | 'pkh', xpub: string, branch: number): string {
  const inner = `${xpub}/${branch}/*`
  return script === 'wpkh' ? `wpkh(${inner})` : script === 'sh_wpkh' ? `sh(wpkh(${inner}))` : `pkh(${inner})`
}

/** Core reports amounts in BTC (float); UTXO values are integer sats. */
export function btcToSats(amount: number): number {
  return Math.round(amount * 1e8)
}

/** scantxoutset returns a `desc` per unspent with the key-origin path baked in,
 *  e.g. `wpkh([fp/84h/0h/0h/0/18]02ab..)#cs`. Pull out the m/… path (needed to
 *  sign) and the scriptType (from the descriptor wrapper). Core emits hardened as
 *  `h` OR `'` depending on version — normalize both to `'`. */
const DESC_SCRIPT: Record<string, string> = { wpkh: 'p2wpkh', 'sh(wpkh': 'p2sh-p2wpkh', pkh: 'p2pkh' }
export function parseDescriptor(desc?: string): { path?: string; scriptType?: string } {
  if (!desc) return {}
  const origin = desc.match(/\[[0-9a-fA-F]{8}((?:\/\d+[h']?)+)\]/)
  const path = origin ? `m${origin[1].replace(/h/g, "'")}` : undefined
  const wrapper = desc.startsWith('sh(wpkh') ? 'sh(wpkh' : desc.startsWith('wpkh') ? 'wpkh' : desc.startsWith('pkh') ? 'pkh' : undefined
  return { path, scriptType: wrapper ? DESC_SCRIPT[wrapper] : undefined }
}

const SCRIPT_TO_TYPE = { wpkh: 'p2wpkh', sh_wpkh: 'p2sh-p2wpkh', pkh: 'p2pkh' } as const
const SCRIPT_PURPOSE = { wpkh: 84, sh_wpkh: 49, pkh: 44 } as const
type ScriptKind = keyof typeof SCRIPT_PURPOSE

/** Core scans an account-level xpub, so scantxoutset reports paths RELATIVE to it
 *  (e.g. m/0/18 — just branch/index). Rebuild the full BIP44/49/84 path with account
 *  0 — matching what Blockbook returns — so the txbuilder's account-rewrite works
 *  identically for both. Signing with the raw relative path derives the WRONG key
 *  (OP_EQUALVERIFY / script-verify failure at broadcast), so this MUST be correct. */
export function coreUtxoPath(desc: string | undefined, script: ScriptKind): string | undefined {
  const rel = parseDescriptor(desc).path
  if (!rel) return undefined
  const segs = rel.replace('m/', '').split('/')
  const index = segs[segs.length - 1], branch = segs[segs.length - 2]
  if (branch === undefined || index === undefined) return undefined
  return `m/${SCRIPT_PURPOSE[script]}'/0'/0'/${branch}/${index}`
}

/** estimatesmartfee returns BTC/kB → sat/vByte (×1e8 ÷1000 = ×1e5), floor 1. */
export function feerateToSatVb(feerate?: number): number {
  return Math.max(1, Math.ceil((typeof feerate === 'number' ? feerate : 0) * 1e5))
}

// ── JSON-RPC ──────────────────────────────────────────────────────────────────

async function coreRpc(cfg: CoreConfig, method: string, params: any[] = [], timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT): Promise<any> {
  let res: Response
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.auth ? { authorization: `Basic ${btoa(cfg.auth)}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'vault', method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e: any) {
    throw new Error(`Bitcoin node unreachable at ${cfg.url} — ${e?.name === 'TimeoutError' ? 'timed out' : (e?.message || 'network error')}`)
  }
  if (res.status === 401) throw new Error('Bitcoin node rejected credentials (HTTP 401) — check rpcuser/rpcpassword or the cookie')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Bitcoin node HTTP ${res.status} on ${method}${body ? `: ${body.slice(0, 180)}` : ''}`)
  }
  const text = await res.text().catch(() => '')
  let json: any
  try { json = JSON.parse(text) } catch {
    const looksHtml = /^\s*</.test(text)
    throw new Error(
      `Expected Bitcoin Core JSON-RPC but got ${looksHtml ? 'an HTML page' : 'a non-JSON response'} on ${method}. ` +
      `Is this a Bitcoin Core RPC URL (usually :8332)? A Blockbook or web URL (e.g. :9130) won't work with the "Bitcoin Core" type — switch the node type to Blockbook.`,
    )
  }
  if (json.error) throw new Error(`Bitcoin node RPC error on ${method}: ${json.error.message || JSON.stringify(json.error)}`)
  return json.result
}

// ── Backend ─────────────────────────────────────────────────────────────────

export function makeCoreBackend(cfg: CoreConfig): BtcBackend {
  const checksummed = async (desc: string): Promise<string> =>
    (await coreRpc(cfg, 'getdescriptorinfo', [desc])).descriptor

  const startScan = async (objs: any[]): Promise<any> => {
    scanState = { scanning: true, progress: 0 }
    const poll = setInterval(() => {
      coreRpc(cfg, 'scantxoutset', ['status'], 10_000)
        .then((st: any) => {
          // Core reports progress as a percent (0–100); normalize to a 0–1 fraction.
          if (st && typeof st.progress === 'number') {
            const p = st.progress > 1 ? st.progress / 100 : st.progress
            scanState = { scanning: true, progress: Math.min(1, Math.max(0, p)) }
          }
        })
        .catch(() => {})
    }, 2000)
    ;(poll as any).unref?.()
    try {
      try {
        return await coreRpc(cfg, 'scantxoutset', ['start', objs], SCAN_TIMEOUT)
      } catch (e: any) {
        // A leftover scan from a crashed/aborted call blocks new ones — abort it once and retry.
        if (/already in progress/i.test(e?.message || '')) {
          await coreRpc(cfg, 'scantxoutset', ['abort']).catch(() => {})
          return await coreRpc(cfg, 'scantxoutset', ['start', objs], SCAN_TIMEOUT)
        }
        throw e
      }
    } finally {
      clearInterval(poll)
      scanState = { scanning: false, progress: 0 }
    }
  }

  const scan = async (descs: string[], range: number, script?: ScriptKind): Promise<BtcUtxo[]> => {
    const objs = await Promise.all(descs.map(async (d) => ({ desc: await checksummed(d), range })))
    // Queue behind any in-flight scan (success or failure) so we never collide.
    const run = scanLock.then(() => startScan(objs), () => startScan(objs))
    scanLock = run.catch(() => {})
    const res = await run
    return (res?.unspents || [])
      .map((u: any): BtcUtxo => ({
        txid: u.txid, vout: u.vout, value: btcToSats(u.amount),
        path: script ? coreUtxoPath(u.desc, script) : parseDescriptor(u.desc).path,
        scriptType: script ? SCRIPT_TO_TYPE[script] : parseDescriptor(u.desc).scriptType,
      }))
      .filter((u: BtcUtxo) => u.value > 0)
  }

  /** Legacy (p2pkh) inputs need the raw prev-tx to sign; segwit does not. Fetch
   *  hex only for those, via getrawtransaction (needs txindex=1). */
  const withLegacyHex = async (utxos: BtcUtxo[]): Promise<BtcUtxo[]> => {
    await Promise.all(utxos.map(async (u) => {
      if (u.scriptType === 'p2pkh' && !u.hex) {
        u.hex = await coreRpc(cfg, 'getrawtransaction', [u.txid, false]).catch(() => undefined)
      }
    }))
    return utxos
  }

  return {
    kind: 'core',
    capabilities: { history: false, push: true }, // scantxoutset = balance+UTXO only, no history

    async listUnspent({ xpub, address }) {
      const key = xpub || address
      if (!key) return []
      const hit = utxoCache.get(key)
      if (hit && Date.now() - hit.at < SCAN_CACHE_TTL) return hit.utxos
      let utxos: BtcUtxo[]
      if (address) {
        utxos = await withLegacyHex(await scan([`addr(${address})`], 1))
      } else {
        const { stdXpub, script } = xpubToDescriptorParts(xpub!)
        utxos = await withLegacyHex(await scan([descriptorFor(script, stdXpub, 0), descriptorFor(script, stdXpub, 1)], 1000, script))
      }
      utxoCache.set(key, { at: Date.now(), utxos })
      return utxos
    },

    async feeRate(): Promise<BtcFeeRates> {
      const [s, a, f] = await Promise.all([
        coreRpc(cfg, 'estimatesmartfee', [6]).catch(() => null),
        coreRpc(cfg, 'estimatesmartfee', [3]).catch(() => null),
        coreRpc(cfg, 'estimatesmartfee', [1]).catch(() => null),
      ])
      return { slow: feerateToSatVb(s?.feerate), average: feerateToSatVb(a?.feerate), fast: feerateToSatVb(f?.feerate) }
    },

    async broadcast({ rawTxHex }) {
      const txid = await coreRpc(cfg, 'sendrawtransaction', [rawTxHex])
      if (!txid) throw new Error('Bitcoin node accepted the transaction but returned no txid')
      utxoCache.clear() // spent UTXOs are now stale — never re-select them
      return { txid }
    },

    async rawTxHex({ txid }) {
      // Needs txindex=1 (or the tx in mempool/a wallet). undefined = not available;
      // the interface treats that as "no hex", matching Pioneer.
      try { return await coreRpc(cfg, 'getrawtransaction', [txid, false]) } catch { return undefined }
    },

    async tipHeight() {
      return (await coreRpc(cfg, 'getblockchaininfo'))?.blocks ?? 0
    },
  }
}

/** "Test connection" probe — reports the node's health + capabilities so the UI
 *  can warn about pruning (no history) and missing txindex (can't spend legacy). */
export async function testCoreNode(cfg: CoreConfig): Promise<{
  ok: boolean; error?: string; chain?: string; blocks?: number; headers?: number; pruned?: boolean; txindex?: boolean
  syncing?: boolean; progress?: number
}> {
  try {
    const info = await coreRpc({ ...cfg, timeoutMs: 10_000 }, 'getblockchaininfo')
    let txindex: boolean | undefined
    try {
      const idx = await coreRpc({ ...cfg, timeoutMs: 10_000 }, 'getindexinfo')
      txindex = !!idx?.txindex
    } catch { txindex = undefined } // getindexinfo absent on old Core — unknown
    const progress = typeof info?.verificationprogress === 'number' ? info.verificationprogress : undefined
    const syncing = !!info?.initialblockdownload || (progress !== undefined && progress < 0.9999)
    return { ok: true, chain: info?.chain, blocks: info?.blocks, headers: info?.headers, pruned: !!info?.pruned, txindex, syncing, progress }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'connection failed' }
  }
}
