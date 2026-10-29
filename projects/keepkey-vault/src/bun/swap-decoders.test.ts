/**
 * 0x Settler, CoW EthFlow and Relay Router swaps (G05 Desktop half, G06, G07):
 * real captured requests through the Desktop signing path and the pre-sign
 * report, network cut. Each must read as a swap Desktop decoded (P2), calm when
 * the output comes back to the signer and red when it does not, and never as a
 * payment of ETH to a contract.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SigningRequestInfo } from '../shared/types'
import { assessSigningRisk } from '../shared/clearsign-risk'
import { buildEvmPresignReport, prepareEvmTxSigningInfo } from './evm-presign-report'
import { simulateEvmEffects } from './evm-effects'
import { uniswapReportFindingsWithState } from './uniswap-report'
import { resolvePromotedEvmArtifact } from './clearsign-artifact-resolver'
import { decodeSwapCall } from './swap-decoders'

type Tx = { name: string; chainId: number; from: string; to: string; value: string; data: string }
const fixtures: Tx[] = require('../../__tests__/fixtures/swap/swap-decoders.json').requests
const tx = (name: string) => fixtures.find((f) => f.name === name)!
const OTHER = '0x1111111111111111111111111111111111111111'
/** The same request with every copy of the signer's address replaced. */
const redirected = (t: Tx): Tx => ({ ...t, data: t.data.split(t.from.slice(2)).join(OTHER.slice(2)) })

const originalFetch = globalThis.fetch
beforeEach(() => { globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch })
afterEach(() => { globalThis.fetch = originalFetch })

async function review(t: Tx, firmwareVersion = '7.16.0') {
  const info: SigningRequestInfo = {
    id: t.name, method: '/eth/sign-transaction', appName: 'app', chain: 'eth',
    from: t.from, to: t.to, value: t.value, chainId: t.chainId, data: t.data, firmwareVersion,
  }
  await prepareEvmTxSigningInfo(info, t, firmwareVersion)
  const endpoint = 'http://127.0.0.1:9/'
  const report = buildEvmPresignReport({
    signingInfo: info, deviceConnected: true,
    simulation: await simulateEvmEffects(t, endpoint),
    universalRouterFindings: await uniswapReportFindingsWithState(t.data, t.chainId, t.to, t.from, endpoint),
    artifactResolution: resolvePromotedEvmArtifact(t.chainId, t.to, t.data),
  })
  const risk = assessSigningRisk(info)!
  const field = (n: string) => info.calldataDecoded?.fields.find((f) => f.name === n)?.value
  return { info, report, risk, field, text: risk.reasons.map((r) => r.text).join('\n') }
}

function expectCalmSwap(r: Awaited<ReturnType<typeof review>>, protocol: string) {
  expect(r.info.needsBlindSigning).toBe(true) // advice only: the device still shows raw data
  expect(r.report.protectionLevel).toBe('P2')
  expect(r.report.descriptor.label).toBe(`${protocol} swap`)
  expect(r.risk.tier).toBe('yellow')
  expect(r.risk.level).toBe('medium')
  expect(r.text).toContain(`Swap through ${protocol}`)
  expect(r.text).toContain('sent to your account')
  expect(r.text).not.toMatch(/Sends [\d.]+ ETH to the contract/)
  expect(r.text).not.toContain('signing blind')
}

describe('0x AllowanceHolder.exec into Settler.execute (G06)', () => {
  test('swaps.pro 10 ETH → USDC: Settler slippage decoded, calm, P2', async () => {
    const r = await review(tx('swapspro-0x-eth-to-usdc'))
    expect(r.field('Action')).toBe('Swap 10 ETH for at least 22632.193356 USDC')
    expect(r.field('Minimum output')).toBe('22632.193356 USDC')
    expect(r.field('Output asset')).toBe('USDC')
    expect(r.field('Output destination')).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94')
    expect(r.field('Settler')).toStartWith('0x0cef320d0c5793ade37964e2661a033771e53cd5 (0x Settler deployment 20 ')
    expectCalmSwap(r, '0x Settler')
    expect(r.text).toContain('pays 10 ETH for at least 22632.193356 USDC')
  })

  test('real token → ETH swap (USDC → ETH)', async () => {
    const r = await review(tx('0x-usdc-to-eth'))
    expect(r.field('Action')).toBe('Swap 101.411487 USDC for at least 0.04348267050452889 ETH')
    expectCalmSwap(r, '0x Settler')
  })

  test('Base: genuine Settler for chain 8453; this real swap pays someone else, so red', async () => {
    const r = await review(tx('base-0x-cbeth-to-usdc-other-recipient'))
    expect(r.field('Action')).toBe('Swap 0.618 cbETH for at least 1600.029946 USDC')
    expect(r.field('Settler')).toContain('(0x Settler deployment 21 ')
    expect(r.risk.tier).toBe('red')
    expect(r.text).toContain('The swap output goes to 0xd5283cabd64fd553f58da2cc64ec9ab5224c14a1, which is NOT the account signing this')
  })

  test('recipient changed to another address: red', async () => {
    const r = await review(redirected(tx('swapspro-0x-eth-to-usdc')))
    expect(r.field('Output destination')).toBe(OTHER)
    expect(r.risk.tier).toBe('red')
    expect(r.text).toContain(`The swap output goes to ${OTHER}, which is NOT the account signing this`)
  })

  test('fails closed: a Settler 0x did not deploy, an unpinned AllowanceHolder, a value mismatch', () => {
    const t = tx('swapspro-0x-eth-to-usdc')
    const settler = '0cef320d0c5793ade37964e2661a033771e53cd5'
    expect(decodeSwapCall(t.to, t.data, 1, t.value)).not.toBeNull()
    expect(decodeSwapCall(t.to, t.data.split(settler).join('2'.repeat(40)), 1, t.value)).toBeNull()
    expect(decodeSwapCall(OTHER, t.data, 1, t.value)).toBeNull()
    expect(decodeSwapCall(t.to, t.data, 1, '0x1')).toBeNull()
    expect(decodeSwapCall(t.to, t.data, 8453, t.value)).toBeNull() // that Settler is not deployment N on Base
  })
})

describe('CoW EthFlow createOrder (G07)', () => {
  test('swaps.pro 10 ETH → USDC: all nine order fields, calm, P2', async () => {
    const r = await review(tx('swapspro-cow-ethflow-eth-to-usdc'))
    expect(r.field('Action')).toBe('Swap 10 ETH for at least 23072.465013 USDC')
    expect(r.field('Output asset')).toBe('USDC') // buyToken
    expect(r.field('Output destination')).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94') // receiver
    expect(r.field('Sell amount')).toBe('10 ETH')
    expect(r.field('Minimum output')).toBe('23072.465013 USDC') // buyAmount
    expect(r.field('Valid until')).toStartWith('2026-10-29 22:00:00 UTC')
    expect(r.field('App data')).toBe('0x048680e79dfa12d06c2362b19faa34b7c754a3ed153d204656c48f82e84d4e60')
    expect(r.field('Fee amount')).toBe('0 ETH')
    expect(r.field('Partially fillable')).toBe('No')
    expect(r.field('Quote id')).toBe('2678013810')
    expectCalmSwap(r, 'CoW EthFlow')
    expect(r.text).toContain('This places a CoW order')
  })

  test('real on-chain order ETH → USDT', async () => {
    const r = await review(tx('cow-ethflow-eth-to-usdt'))
    expect(r.field('Action')).toBe('Swap 20 ETH for at least 45522.644007 USDT')
    expectCalmSwap(r, 'CoW EthFlow')
  })

  test('receiver changed to another address: red', async () => {
    const r = await review(redirected(tx('swapspro-cow-ethflow-eth-to-usdc')))
    expect(r.risk.tier).toBe('red')
    expect(r.text).toContain(`The swap output goes to ${OTHER}, which is NOT the account signing this`)
  })

  test('fails closed: ETH sent ≠ sellAmount + feeAmount, trailing bytes, another contract', () => {
    const t = tx('swapspro-cow-ethflow-eth-to-usdc')
    expect(decodeSwapCall(t.to, t.data, 1, '0x1')).toBeNull()
    expect(decodeSwapCall(t.to, `${t.data}00`, 1, t.value)).toBeNull()
    expect(decodeSwapCall(OTHER, t.data, 1, t.value)).toBeNull()
  })
})

describe('Relay Router swaps Desktop builds from a Pioneer quote (G05)', () => {
  test('router multicall: Relay fee, KyberSwap, payout to the signer; calm, P2', async () => {
    const r = await review(tx('relay-v32-router-kyber-eth-to-usdt'))
    expect(r.field('Action')).toBe('Swap 1.74966049 ETH for at least 3957.520044 USDT')
    expect(r.field('Relay fee')).toBe("0.008048438254 ETH to Relay's solver 0xf70da97812cb96acdf810712aa562db8dfa3dbef")
    expect(r.field('Leftover refund to')).toBe('the sending account')
    expectCalmSwap(r, 'Relay Router')
  })

  test('router multicall routing through 0x Settler', async () => {
    const r = await review(tx('relay-v32-router-0x-eth-to-usdt'))
    expect(r.field('Action')).toBe('Swap 1 ETH for at least 2268.997365 USDT')
    expectCalmSwap(r, 'Relay Router')
  })

  test('ApprovalProxy transferAndMulticall: pays WETH, names the unlisted output token as a warning', async () => {
    const r = await review(tx('relay-v32-proxy-kyber-weth-to-unlisted'))
    expect(r.field('Input amount')).toBe('4.300057618 WETH')
    expect(r.field('Token warning')).toBe("Token 0xa0df17b5ac76ababa36e1450e2cbcd18a620c845 is not on KeepKey's reviewed list")
    expect(r.report.protectionLevel).toBe('P2')
    expect(r.risk.tier).toBe('red') // the existing unrecognized-token rule, as for Uniswap
  })

  test('payout or refund redirected to another address: red', async () => {
    for (const name of ['relay-v32-router-kyber-eth-to-usdt', 'relay-v32-proxy-kyber-weth-to-unlisted']) {
      const r = await review(redirected(tx(name)))
      expect(r.risk.tier).toBe('red')
      expect(r.text).toContain(`The swap output goes to ${OTHER}, which is NOT the account signing this`)
    }
  })

  test('fails closed: a step it cannot read, a failure-allowed step, an unpinned router', () => {
    const t = tx('relay-v32-router-kyber-eth-to-usdt')
    expect(decodeSwapCall(t.to, t.data, 1, t.value)).not.toBeNull()
    // Point the KyberSwap step at another contract.
    expect(decodeSwapCall(t.to, t.data.replace('6131b5fae19ea4f9d964eac0408e4408b66337b5', OTHER.slice(2)), 1, t.value)).toBeNull()
    // allowFailure = true on the first call.
    const calls = 10 + 2 * (Number(BigInt(`0x${t.data.slice(10, 74)}`)) + 32)
    const first = calls + 2 * Number(BigInt(`0x${t.data.slice(calls, calls + 64)}`))
    const flag = first + 64 + 62
    expect(t.data.slice(flag, flag + 2)).toBe('00')
    expect(decodeSwapCall(t.to, `${t.data.slice(0, flag)}01${t.data.slice(flag + 2)}`, 1, t.value)).toBeNull()
    expect(decodeSwapCall(OTHER, t.data, 1, t.value)).toBeNull()
  })
})
