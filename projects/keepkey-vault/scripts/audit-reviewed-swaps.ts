/** Public quote/certificate probes only. No wallet access, signing or broadcast.
 * bun scripts/audit-reviewed-swaps.ts https://oracles.cc
 */
import { parseQuoteResponse } from '../src/bun/swap-parsing'
import { selectSwapRoute, isRelaySolverDeposit } from '../src/bun/swap-route-selection'
import { evmCallRequiresAdvancedMode } from '../src/bun/evm-signing-policy'
import { certifiedEvmEnvelopeVerifies, buildEvmDecoderBody, reviewedSwapTokens } from '../src/bun/evm-certified-schema'
import { PRODUCTION_ROOT_PUBLIC_KEY } from '../src/bun/clearsign-alpha-ceremony'
import { urPrecheck } from '../src/bun/uniswap-ur'
import Pioneer from '@pioneer-platform/pioneer-client'

const origin = (process.argv[2] || 'https://oracles.cc').replace(/\/$/, '')
const key = `vault:reviewed-swaps:${crypto.randomUUID()}:${crypto.randomUUID()}`
async function api(path: string, body: unknown) {
  const response = await fetch(`${origin}/api/v1/${path}`, { method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) })
  const json = await response.json() as any
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${json.message || json.error || 'Request failed'}`)
  return json
}
await api('user/register', { username: `reviewed-swaps-${crypto.randomUUID()}`, queryKey: key })
// Exercise the same generated SDK and Swagger request body as the app.
const sdk = await new Pioneer(`${origin}/spec/swagger.json`, { queryKey: key, timeout: 60_000, overrideHost: new URL(origin).host }).init()
const eth = 'eip155:1/slip44:60', btc = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
const ethAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', btcAddress = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
const fixtures = [
  { name: 'ETH → USDT', sellAsset: eth, buyAsset: 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7', sellAmount: '0.01' },
  { name: 'ETH → Base USDC', sellAsset: eth, buyAsset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', sellAmount: '0.01' },
  { name: 'BTC → ETH', sellAsset: btc, buyAsset: eth, sellAmount: '0.001' },
  { name: 'ETH → BTC', sellAsset: eth, buyAsset: btc, sellAmount: '0.05' },
]
const report: any[] = []
for (const fixture of fixtures.filter(f => !process.argv.includes('--evm-only') || f.sellAsset === eth && f.buyAsset !== btc)) {
  try {
    const response = await sdk.Quote({ ...fixture, senderAddress: fixture.sellAsset === btc ? btcAddress : ethAddress,
      recipientAddress: fixture.buyAsset === btc ? btcAddress : ethAddress, slippage: 1, relayExecutionMode: 'solver-deposit' })
    const outer = response.data || response
    const entries = outer.data || outer
    if (!Array.isArray(entries)) throw new Error('Unexpected quote response')
    const params = { fromCaip: fixture.sellAsset, toCaip: fixture.buyAsset, slippageBps: 100 }
    const quotes = entries.flatMap(entry => { try { return [parseQuoteResponse(entry, params)] } catch { return [] } })
    const coverage = new Map<any, boolean | 'source-deposit'>()
    const routes: any[] = []
    for (const quote of quotes) {
      const tx = quote.relayTx
      if (quote.integration === 'relay') {
        // Both EVM output fixtures have six decimals. Compare integer base
        // units so the provider's floor rounding cannot fail a float check.
        const micro = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6)) }
        if (micro(quote.minimumOutput) < micro(quote.expectedOutput) * 99n / 100n) {
          throw new Error(`Relay minimum is looser than 1%: expected=${quote.expectedOutput}, minimum=${quote.minimumOutput}`)
        }
      }
      let reviewed = false
      if (tx && fixture.sellAsset === eth) {
        const plan = urPrecheck(tx.to, tx.data, BigInt(tx.value), '7.16.0')
        const path = plan ? 'swap' : 'schema'
        const response = await fetch(`https://keepkey-clearsign.bithighlander.workers.dev/v1/evm/${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ chainId: 1, contract: tx.to, selector: tx.data.slice(0, 10),
            ...(plan ? { tokens: plan.tokens } : { calldataLength: (tx.data.length - 2) / 2 }) }),
        })
        const schema = await response.json() as any
        const signatureValid = response.ok && certifiedEvmEnvelopeVerifies(schema.signedPayload, PRODUCTION_ROOT_PUBLIC_KEY)
        if (signatureValid) {
          if (plan) {
            const tokens = reviewedSwapTokens(1, plan.tokens)
            const body = tokens && buildEvmDecoderBody(1, tx.to, plan.selector, tokens)
            const payload = Buffer.from(schema.signedPayload.replace(/^0x/, ''), 'hex')
            if (!body || !payload.subarray(140, -65).equals(body)) throw new Error('Uniswap certificate body mismatch')
          }
          reviewed = !evmCallRequiresAdvancedMode(tx.to, tx.data, 1, false,
            { signedPayload: schema.signedPayload, keyId: schema.keyId }, undefined, '7.16.0', tx.value, [4])
        }
      }
      const scope = reviewed && isRelaySolverDeposit(quote) ? 'source-deposit' : reviewed
      coverage.set(quote, scope)
      routes.push({ integration: quote.integration, swapper: quote.swapper, expectedOutput: quote.expectedOutput, minimumOutput: quote.minimumOutput,
        hostReviewScope: scope === true ? 'swap' : scope === 'source-deposit' ? scope : 'not-verified-by-this-probe',
        ...(tx ? { to: tx.to, selector: tx.data.slice(0, 10), calldataBytes: (tx.data.length - 2) / 2 } : {}), feesBps: quote.fees.totalBps })
    }
    const selected = await selectSwapRoute(quotes, async q => coverage.get(q) || false)
    report.push({ pair: fixture.name, routes, selected: selected.integration })
    if (fixture.name === 'ETH → USDT' && (selected.integration !== 'uniswap' || !routes.some(r => r.integration === 'relay' && r.hostReviewScope === 'source-deposit'))) {
      process.exitCode = 1
    }
  } catch (error: any) { report.push({ pair: fixture.name, error: error.message }); if (fixture.name === 'ETH → USDT') process.exitCode = 1 }
}
const result = { checkedAt: new Date().toISOString(), origin, firmware: '7.16.0', deviceSigningPerformed: false, broadcastPerformed: false, probes: report }
console.log(JSON.stringify(result, null, 2))
await Bun.write('/private/tmp/reviewed-swaps-live.json', JSON.stringify(result, null, 2))
