/**
 * BlockbookBackend — self-host via a Trezor blockbook indexer (what Pioneer itself
 * speaks). Thin REST client over /api/v2. xpub-NATIVE: blockbook does the gap scan
 * and understands SLIP-132 (zpub/ypub) directly, so no descriptor/bs58check dance
 * like Core needs. Archival indexer → full history, balance, UTXO, fee, broadcast.
 *
 * Isolation: imports only types, never ../pioneer. Optional headers carry a
 * Cloudflare-Access service token for a gated public URL (e.g. btc-nodes.keepkey.info);
 * a tailnet/localhost blockbook needs none.
 */
import type { BtcBackend, BtcUtxo, BtcFeeRates } from './types'

export interface BlockbookConfig {
  url: string                          // base, no trailing slash — e.g. http://host:9130
  headers?: Record<string, string>     // optional CF-Access-Client-Id / -Secret
  timeoutMs?: number
}

const DEFAULT_TIMEOUT = 30_000

function base(cfg: BlockbookConfig): string {
  return cfg.url.replace(/\/+$/, '')
}

async function bbFetch(cfg: BlockbookConfig, path: string, init?: RequestInit): Promise<any> {
  let res: Response
  try {
    res = await fetch(`${base(cfg)}${path}`, {
      ...init,
      headers: { ...(cfg.headers || {}), ...(init?.headers || {}) },
      signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT),
    })
  } catch (e: any) {
    throw new Error(`Blockbook unreachable at ${base(cfg)} — ${e?.name === 'TimeoutError' ? 'timed out' : (e?.message || 'network error')}`)
  }
  if (res.status === 401 || res.status === 403) throw new Error(`Blockbook rejected the request (HTTP ${res.status}) — check the URL or Cloudflare-Access token`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Blockbook HTTP ${res.status} on ${path}${body ? `: ${body.slice(0, 180)}` : ''}`)
  }
  const json = await res.json().catch(() => null)
  if (json?.error) throw new Error(`Blockbook error on ${path}: ${typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error))}`)
  return json
}

export function makeBlockbookBackend(cfg: BlockbookConfig): BtcBackend {
  return {
    kind: 'blockbook',
    capabilities: { history: true, push: true },

    async listUnspent({ xpub, address }) {
      const key = xpub ?? address
      if (!key) return []
      const utxos = await bbFetch(cfg, `/api/v2/utxo/${encodeURIComponent(key)}`)
      return (Array.isArray(utxos) ? utxos : [])
        .map((u: any): BtcUtxo => ({ txid: u.txid, vout: u.vout, value: parseInt(u.value, 10) || 0 }))
        .filter((u) => u.value > 0)
    },

    async feeRate(): Promise<BtcFeeRates> {
      // estimatefee returns { result: "<BTC/kB>" } → sat/vB (×1e5), floor 1.
      const conv = (r: any) => Math.max(1, Math.ceil(parseFloat(r?.result ?? '0') * 1e5))
      const [s, a, f] = await Promise.all([6, 3, 1].map((n) => bbFetch(cfg, `/api/v2/estimatefee/${n}`).catch(() => null)))
      return { slow: conv(s), average: conv(a), fast: conv(f) }
    },

    async broadcast({ rawTxHex }) {
      const res = await bbFetch(cfg, `/api/v2/sendtx/`, { method: 'POST', body: rawTxHex, headers: { 'content-type': 'text/plain' } })
      const txid = res?.result
      if (!txid) throw new Error(`Blockbook broadcast returned no txid: ${JSON.stringify(res).slice(0, 180)}`)
      return { txid }
    },

    async rawTxHex({ txid }) {
      try { return (await bbFetch(cfg, `/api/v2/tx-specific/${txid}`))?.hex } catch { return undefined }
    },

    async tipHeight() {
      const s = await bbFetch(cfg, `/api/`)
      return s?.backend?.blocks ?? s?.blockbook?.bestHeight ?? 0
    },
  }
}

/** "Test connection" probe — reports chain/height + sync state for the config panel. */
export async function testBlockbookNode(cfg: BlockbookConfig): Promise<{
  ok: boolean; error?: string; chain?: string; blocks?: number; inSync?: boolean
}> {
  try {
    const s = await bbFetch({ ...cfg, timeoutMs: 10_000 }, `/api/`)
    return { ok: true, chain: s?.backend?.chain, blocks: s?.backend?.blocks ?? s?.blockbook?.bestHeight, inSync: s?.blockbook?.inSync }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'connection failed' }
  }
}
