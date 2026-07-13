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

  const scan = async (descs: string[], range: number): Promise<BtcUtxo[]> => {
    const objs = await Promise.all(descs.map(async (d) => ({ desc: await checksummed(d), range })))
    const res = await coreRpc(cfg, 'scantxoutset', ['start', objs], SCAN_TIMEOUT)
    return (res?.unspents || [])
      .map((u: any): BtcUtxo => ({ txid: u.txid, vout: u.vout, value: btcToSats(u.amount) }))
      .filter((u: BtcUtxo) => u.value > 0)
  }

  return {
    kind: 'core',
    capabilities: { history: false, push: true }, // scantxoutset = balance+UTXO only, no history

    async listUnspent({ xpub, address }) {
      if (address) return scan([`addr(${address})`], 1)
      if (xpub) {
        const { stdXpub, script } = xpubToDescriptorParts(xpub)
        return scan([descriptorFor(script, stdXpub, 0), descriptorFor(script, stdXpub, 1)], 1000)
      }
      return []
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
