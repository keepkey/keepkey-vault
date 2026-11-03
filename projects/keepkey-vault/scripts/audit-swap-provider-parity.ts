/** Compare deployed swap APIs with public fixtures. Never signs or broadcasts.
 * Run: bun scripts/audit-swap-provider-parity.ts /private/tmp/swap-parity-live.json
 * Quotes may allocate unused provider deposit addresses. API keys are ephemeral
 * and remain in memory; wallet data and local credentials are never read.
 */
import { bech32, base58 } from '@scure/base'
import { createHash } from 'node:crypto'

const out = process.argv[2] || '/private/tmp/swap-parity-live.json'
const eth = 'eip155:1/slip44:60'
const btc = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
const ltc = 'bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2'
const zec = 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
const sol = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501'
const pubHash = Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex')
const segwit = (prefix: string) => bech32.encode(prefix, [0, ...bech32.toWords(pubHash)])
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest()
const zecPayload = Buffer.concat([Buffer.from([0x1c, 0xb8]), pubHash])
const addresses: Record<string, string> = {
  [eth]: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  [btc]: segwit('bc'), [ltc]: segwit('ltc'),
  [zec]: base58.encode(Buffer.concat([zecPayload, sha256(sha256(zecPayload)).subarray(0, 4)])),
  [sol]: '11111111111111111111111111111111',
}
const fixtures: Array<{ name: string; sellAsset: string; buyAsset: string; sellAmount: string; memoless?: boolean; relayExecutionMode?: 'solver-deposit' }> = [
  { name: 'ETH to LTC', sellAsset: eth, buyAsset: ltc, sellAmount: '0.021319' },
  { name: 'ETH to LTC native precision', sellAsset: eth, buyAsset: ltc, sellAmount: '0.012345678912345678' },
  { name: 'LTC to ETH', sellAsset: ltc, buyAsset: eth, sellAmount: '1' },
  { name: 'BTC to ETH', sellAsset: btc, buyAsset: eth, sellAmount: '0.001' },
  { name: 'ETH to BTC', sellAsset: eth, buyAsset: btc, sellAmount: '0.021319' },
  { name: 'ETH to USDT', sellAsset: eth, buyAsset: 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7', sellAmount: '0.013118195' },
  { name: 'ETH to Base USDC', sellAsset: eth, buyAsset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', sellAmount: '0.013118195' },
  { name: 'SOL to ETH', sellAsset: sol, buyAsset: eth, sellAmount: '0.25' },
  { name: 'ZEC to ETH', sellAsset: zec, buyAsset: eth, sellAmount: '0.042103' },
  { name: 'BTC to LTC memoless', sellAsset: btc, buyAsset: ltc, sellAmount: '0.001', memoless: true },
  { name: 'ETH to Base USDC solver deposit', sellAsset: eth, buyAsset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', sellAmount: '0.013118195', relayExecutionMode: 'solver-deposit' },
  { name: 'ETH to USDT solver deposit', sellAsset: eth, buyAsset: 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7', sellAmount: '0.013118195', relayExecutionMode: 'solver-deposit' },
]
const origins = ['https://api.keepkey.info', 'https://oracles.cc']
const keys = new Map<string, string>()
const report: any = {
  startedAt: new Date().toISOString(), publicFixturesOnly: true, signed: false, broadcast: false,
  limitations: ['Quote responses and instruction shapes do not prove a funded swap or device signing succeeds.', 'Local source revisions and deployed API versions are recorded separately.'],
  servers: {}, cases: [],
}
async function request(origin: string, path: string, body?: unknown) {
  const response = await fetch(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(keys.has(origin) ? { Authorization: keys.get(origin)! } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000),
  })
  return { httpStatus: response.status, body: await response.json() as any }
}
function unwrap(body: any): any { return body?.data?.data || body?.data || body }
function normalizedQuote(entry: any) {
  const q = entry.quote || entry
  const txs = q.txs || []
  const raw = q.raw || {}
  return {
    integration: entry.integration, swapper: q.swapper || q.swapperName || q.source,
    amountOut: q.amountOut || q.buyAmount, amountOutMin: q.amountOutMin,
    expiry: q.expiry || raw.expiry, quoteMode: q.meta?.quoteMode,
    fees: raw.fees || q.fees,
    feeBreakdown: q.meta?.feeBreakdown,
    nearAppFees: raw.quoteRequest?.appFees,
    sourceTransactionShapes: txs.map((tx: any) => { const p = tx.txParams || {}; return {
      type: tx.type, chain: tx.chain, chainId: p.chainId,
      hasMemo: !!p.memo, hasDestination: !!(p.to || p.recipientAddress),
      dataBytes: typeof p.data === 'string' ? Math.max(0, (p.data.length - 2) / 2) : undefined,
      hasSerializedTransaction: !!(p.serializedTx || p.serializedTransaction),
      instructionCount: Array.isArray(p.instructions) ? p.instructions.length : undefined,
      nativeValueBaseUnits: p.value, decimalAmount: p.amount,
    } }),
  }
}
for (const origin of origins) {
  const key = `vault:route-parity:${crypto.randomUUID()}:${crypto.randomUUID()}`
  const registration = await request(origin, '/user/register', { username: `route-parity-${crypto.randomUUID()}`, queryKey: key })
  if (registration.httpStatus >= 400) throw new Error(`${origin}: public fixture registration HTTP ${registration.httpStatus}`)
  keys.set(origin, key)
  const capabilities = await Promise.allSettled(['/health', '/swap/health', '/swappers/supported-chains', '/swap/available-assets'].map(async path => {
    const r = await request(origin, path)
    const body = unwrap(r.body)
    if (path === '/health') return { path, httpStatus: r.httpStatus, service: body.service, version: body.version, revision: body.revision, status: body.status }
    if (path === '/swap/health') return { path, httpStatus: r.httpStatus, integrations: body.integrations }
    if (path === '/swappers/supported-chains') return { path, httpStatus: r.httpStatus, supportedChains: body }
    const assets = Array.isArray(body) ? body : body.assets || []
    return { path, httpStatus: r.httpStatus, keys: Object.keys(body), assetCount: assets.length, integrationKeys: Object.keys(body.integrations || {}) }
  }))
  report.servers[origin] = capabilities.map(r => r.status === 'fulfilled' ? r.value : { error: String(r.reason) })
}
await Bun.write(out, JSON.stringify(report, null, 2) + '\n')
// One fixture at a time; compare both servers concurrently with identical input.
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice('--only='.length)
for (const fixture of fixtures.filter(fixture => !only || new RegExp(only, 'i').test(fixture.name))) {
  const recipientAddress = addresses[fixture.buyAsset] || addresses[eth]
  const payload = { sellAsset: fixture.sellAsset, buyAsset: fixture.buyAsset, sellAmount: fixture.sellAmount,
    senderAddress: addresses[fixture.sellAsset], recipientAddress, slippage: 3,
    ...(fixture.memoless ? { memoless: true } : {}), ...(fixture.relayExecutionMode ? { relayExecutionMode: fixture.relayExecutionMode } : {}) }
  const results = await Promise.all(origins.map(async origin => {
    const started = Date.now()
    try {
      const r = await request(origin, '/quote', payload)
      const body = unwrap(r.body)
      const entries = Array.isArray(body) ? body : Array.isArray(body.quotes) ? body.quotes : undefined
      return { origin, httpStatus: r.httpStatus, elapsedMs: Date.now() - started,
        ...(entries ? { quotes: entries.map(normalizedQuote) } : { error: body.error || body.message || body }) }
    } catch (error) { return { origin, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) } }
  }))
  report.cases.push({ ...fixture, checkedAt: new Date().toISOString(), results })
  await Bun.write(out, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ case: fixture.name, results: results.map((r: any) => ({ origin: r.origin, status: r.httpStatus, routes: r.quotes?.map((q: any) => `${q.integration}:${q.swapper}`), error: r.error?.message || r.error })) }))
}
report.completedAt = new Date().toISOString()
report.parityRegressions = report.cases.flatMap((testCase: any) => {
  const [legacy, gateway] = testCase.results
  const failures: string[] = []
  if (legacy.httpStatus === 200 && legacy.quotes?.length && !(gateway.httpStatus === 200 && gateway.quotes?.length)) failures.push('legacy_quote_lost')
  if (testCase.memoless && gateway.quotes?.some((q: any) => q.sourceTransactionShapes.some((tx: any) => tx.hasMemo))) failures.push('memoless_request_ignored')
  return failures.map(reason => ({ case: testCase.name, reason }))
})
await Bun.write(out, JSON.stringify(report, null, 2) + '\n')
console.log(`Saved quote comparison to ${out}`)
if (process.argv.includes('--check-parity') && report.parityRegressions.length) process.exitCode = 1
