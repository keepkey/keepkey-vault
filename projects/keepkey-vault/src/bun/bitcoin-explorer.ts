/** Bitcoin.com mainnet record reads. Explorer summaries describe the entire record, not wallet net flow. */
export const BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const ORIGIN = 'https://www.bitcoin.com'
type Kind = 'tx' | 'block' | 'address'
export interface BitcoinExplorerRecord {
  kind: Kind
  id: string
  explanation: string
  url: string
  asOf: string
  data: Record<string, any>
}
export class BitcoinExplorerError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAt?: number) { super(message) }
}
function satoshis(value: unknown, signed = false) {
  if (typeof value !== 'string' || !(signed ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(value)
    || value.length > 17 || BigInt(value) > 2_100_000_000_000_000n || BigInt(value) < -2_100_000_000_000_000n)
    throw new Error('Bitcoin.com returned an invalid satoshi amount')
}
function integer(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Bitcoin.com returned an invalid count')
}
function identifier(kind: Kind, input: string) {
  if (typeof input !== 'string') throw new Error('Invalid Bitcoin record identifier')
  if (kind === 'tx' || kind === 'block' && /^[0-9a-f]{64}$/i.test(input)) {
    if (!/^[0-9a-f]{64}$/i.test(input)) throw new Error('Enter a 64-character Bitcoin transaction or block hash')
    return input.toLowerCase()
  }
  if (kind === 'block') {
    if (!/^(0|[1-9]\d{0,9})$/.test(input)) throw new Error('Enter a Bitcoin block height or hash')
    return input
  }
  // This client accepts individual mainnet addresses only; extended public keys are never sent.
  if (!/^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[ac-hj-np-z02-9]{11,87})$/.test(input))
    throw new Error('Enter a Bitcoin mainnet address')
  return input
}
function validate(kind: Kind, id: string, input: any): BitcoinExplorerRecord {
  const url = `${ORIGIN}/explorer/btc/${kind}/${id}/`
  if (!input || input.kind !== kind || input.id !== id || input.url !== url
    || typeof input.explanation !== 'string' || input.explanation.length > 4000
    || typeof input.asOf !== 'string' || !Number.isFinite(Date.parse(input.asOf))
    || !input.data || typeof input.data !== 'object' || Array.isArray(input.data))
    throw new Error('Bitcoin.com returned a different or malformed record')
  const d = input.data
  if (kind === 'tx') {
    if (d.txid !== id || !Array.isArray(d.vin) || !Array.isArray(d.vout)) throw new Error('Bitcoin.com returned a different transaction')
    for (const key of ['value', 'valueIn', 'fees']) satoshis(d[key])
    integer(d.confirmations)
    for (const row of [...d.vin, ...d.vout]) {
      if (!row || typeof row !== 'object') throw new Error('Bitcoin.com returned malformed transaction entries')
      if (row.value !== undefined) satoshis(row.value)
      if (row.addresses !== undefined && (!Array.isArray(row.addresses) || row.addresses.some((a: unknown) => typeof a !== 'string')))
        throw new Error('Bitcoin.com returned malformed transaction addresses')
    }
    for (const row of d.vout) satoshis(row.value)
  } else if (kind === 'address') {
    if (d.address !== id) throw new Error('Bitcoin.com returned a different address')
    for (const key of ['balance', 'totalReceived', 'totalSent']) satoshis(d[key])
    satoshis(d.unconfirmedBalance, true)
    for (const key of ['txs', 'unconfirmedTxs', 'utxoCount']) integer(d[key])
  } else {
    if (!/^[0-9a-f]{64}$/.test(d.hash) || (id.length === 64 ? d.hash !== id : String(d.height) !== id))
      throw new Error('Bitcoin.com returned a different block')
    integer(d.height); integer(d.nTx); satoshis(d.totalFees)
  }
  return input
}
export class BitcoinExplorer {
  private cache = new Map<string, { until: number; value: BitcoinExplorerRecord }>()
  private inFlight = new Map<string, Promise<BitcoinExplorerRecord>>()
  private requests: number[] = []
  private retryAt = 0
  constructor(private request: typeof fetch = fetch, private now: () => number = Date.now) {}
  async record(kind: Kind, input: string): Promise<BitcoinExplorerRecord> {
    const id = identifier(kind, input), key = `${kind}/${id}`
    const cached = this.cache.get(key)
    if (cached && cached.until > this.now()) return structuredClone(cached.value)
    const existing = this.inFlight.get(key)
    if (existing) return structuredClone(await existing)
    if (this.now() < this.retryAt) throw new BitcoinExplorerError('Bitcoin.com rate limit; retry later', 429, this.retryAt)
    this.requests = this.requests.filter(at => this.now() - at < 60_000)
    if (this.requests.length >= 55) throw new BitcoinExplorerError('Bitcoin.com local request limit; retry later', 429, this.requests[0]! + 60_000)
    this.requests.push(this.now())
    const work = (async () => {
      // ?format=json is CDN-cacheable; the Accept header also prevents accidental HTML handling.
      const response = await this.request(`${ORIGIN}/explorer/btc/${kind}/${id}/?format=json`, {
        headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 429) {
        const retry = response.headers.get('Retry-After') || ''
        const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now()
        this.retryAt = this.now() + Math.max(1000, Number.isFinite(delay) ? delay : 60_000)
        throw new BitcoinExplorerError('Bitcoin.com rate limit; retry later', 429, this.retryAt)
      }
      if (!response.ok) throw new BitcoinExplorerError(`Bitcoin.com HTTP ${response.status}`, response.status)
      const body = await response.text()
      if (body.length > 8_000_000) throw new Error('Bitcoin.com record exceeds the size limit')
      const value = validate(kind, id, JSON.parse(body))
      for (const [key, cached] of this.cache) if (cached.until <= this.now()) this.cache.delete(key)
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { until: this.now() + 30_000, value })
      return value
    })()
    this.inFlight.set(key, work)
    try { return structuredClone(await work) } finally { this.inFlight.delete(key) }
  }
}
export const bitcoinExplorer = new BitcoinExplorer()

/** Public default-mode transaction reads only. Explicit node/offline backends do not call this. */
export async function publicBitcoinTxDetail(network: string, txid: string, fallback: () => Promise<any>, explorer = bitcoinExplorer) {
  if (network !== BITCOIN_MAINNET) return fallback()
  try {
    const record = await explorer.record('tx', txid)
    return { ...record.data, explorer: { provider: 'bitcoin.com', url: record.url, asOf: record.asOf, explanation: record.explanation } }
  }
  catch { return fallback() }
}
