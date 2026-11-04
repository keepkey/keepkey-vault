/**
 * 0x Settler, CoW EthFlow and Relay Router swaps (G05 Desktop half, G06, G07):
 * real captured requests through the Desktop signing path and the pre-sign
 * report, network cut. Each must read as a swap Desktop decoded (P2), calm when
 * the output comes back to the signer and red when it does not, and never as a
 * payment of ETH to a contract.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { utils } from 'ethers'
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

  test('real USDC → DAI swap: DAI is a reviewed swap token, no fake-token warning', async () => {
    const t = tx('0x-usdc-to-dai')
    const r = await review(t)
    expect(r.field('Action')).toBe('Swap 1000 USDC for at least 997.000015952 DAI')
    expect(r.field('Output asset')).toBe('DAI')
    expect(r.field('Token warning')).toBeUndefined()
    expect(r.text).not.toContain('does not recognize')
    expectCalmSwap(r, '0x Settler')
    // Control: the same request buying a token on no reviewed list still warns.
    const dai = '6b175474e89094c44da98b954eedeac495271d0f'
    const fake = await review({ ...t, data: t.data.split(dai).join('2'.repeat(40)) })
    expect(fake.field('Token warning')).toBe(`Token 0x${'2'.repeat(40)} is not on KeepKey's reviewed list`)
    expect(fake.risk.level).toBe('high')
    expect(fake.text).toContain('Swaps a token KeepKey does not recognize. It may be a fake.')
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

  // alpha-717 CONTROL '0x Settler recipient changed' (round 2): the swaps.pro
  // capture with Settler's recipient word replaced. On 7.17 a ClearSign
  // ERC-7730 definition is attached and the device shows "NOT this wallet";
  // the card must say so too, not stay green.
  test('recipient changed under an attached ERC-7730 definition: still red', async () => {
    const t = tx('swapspro-0x-eth-to-usdc')
    const inner = 2 + 2 * (4 + 32 * 5 + 32)
    expect(t.data.slice(inner, inner + 8)).toBe('1fff991f')
    const control = { ...t, data: `${t.data.slice(0, inner + 8)}${OTHER.slice(2).padStart(64, '0')}${t.data.slice(inner + 72)}` }
    for (const [request, red] of [[t, false], [control, true]] as const) {
      const r = await review(request, '7.17.0')
      r.info.erc7730 = { primaryDefinitionId: `0x${'68'.repeat(32)}`, definitions: [] }
      r.info.erc7730Description = { signedBy: 'KeepKey ClearSign TEST', intent: 'Swap with 0x', fields: [] }
      r.info.needsBlindSigning = false
      const risk = assessSigningRisk(r.info)!
      const text = risk.reasons.map((x) => x.text).join('\n')
      expect(text).toContain('Swap with 0x: your KeepKey shows it from a KeepKey ClearSign description.')
      if (red) {
        expect(risk.tier).toBe('red')
        expect(text).toContain(`The swap output goes to ${OTHER}, which is NOT the account signing this`)
      } else {
        expect(risk.tier).toBe('green')
        expect(text).not.toContain('NOT the account signing this')
      }
    }
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

describe('Relay Router: a later step that spends or re-sweeps the swap output', () => {
  const mc = new utils.Interface(['function multicall((address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata)'])
  const kyber = new utils.Interface(['function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution)'])
  const ah = new utils.Interface(['function exec(address operator,address token,uint256 amount,address target,bytes data)'])
  const erc20 = new utils.Interface([
    'function approve(address,uint256)',
    'function cleanupErc20s(address[] tokens,address[] recipients,uint256[] amounts,bytes metadata)',
  ])
  const KYBER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
  const AH = '0x0000000000001fF3684f28c67538d4D072C22734'
  const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
  const ROUTER = '0x0729E2a4716d9f7dD17858d5d504426D228697f7'
  const ATTACKER = '0x2222222222222222222222222222222222222222'
  const MIN = 3957520044n // the real Kyber step's minReturnAmount of USDT
  type Call = { target: string; allowFailure: boolean; value: unknown; callData: string }
  const call = (target: string, callData: string): Call => ({ target, allowFailure: false, value: 0, callData })

  /** The real Kyber ETH → USDT multicall (fee, swap, sweep USDT to the signer)
   *  with `edit` applied to its calls. */
  function rebuilt(edit: (calls: Call[]) => Call[]) {
    const t = tx('relay-v32-router-kyber-eth-to-usdt')
    const d = mc.decodeFunctionData('multicall', t.data)
    return { ...t, data: mc.encodeFunctionData('multicall', [edit([...d.calls]), d.refundTo, d.nftRecipient, d.metadata]) }
  }
  /** A second Kyber step that sells the router's USDT, paying it to `srcReceiver`. */
  function kyberSellsUsdt(srcReceiver: string) {
    const real = kyber.decodeFunctionData('swap', mc.decodeFunctionData('multicall', tx('relay-v32-router-kyber-eth-to-usdt').data).calls[1].callData).execution
    return kyber.encodeFunctionData('swap', [{
      callTarget: real.callTarget, approveTarget: real.approveTarget, targetData: '0x', clientData: '0x',
      desc: {
        srcToken: USDT, dstToken: WETH, srcReceivers: [srcReceiver], srcAmounts: [MIN], feeReceivers: [], feeAmounts: [],
        dstReceiver: utils.hexZeroPad('0x', 20), amount: MIN, minReturnAmount: 1, flags: 0, permit: '0x',
      },
    }])
  }
  const sweepUsdt = (to: string) => erc20.encodeFunctionData('cleanupErc20s', [[USDT], [to], [0], '0x'])

  test('control: the real request still claims the Kyber minimum', () => {
    const t = rebuilt((c) => c)
    expect(decodeSwapCall(t.to, t.data, 1, t.value)?.fields.find((f) => f.name === 'Minimum output')?.value).toBe('3957.520044 USDT')
  })

  test('a second KyberSwap step sells the swept USDT to another address: blind and red, not "at least 3957 USDT"', async () => {
    const t = rebuilt((c) => [c[0], c[1], call(USDT, erc20.encodeFunctionData('approve', [KYBER, MIN])), call(KYBER, kyberSellsUsdt(ATTACKER)), c[2]])
    expect(decodeSwapCall(t.to, t.data, 1, t.value)).toBeNull()
    const r = await review(t)
    expect(r.risk.tier).toBe('red')
    expect(r.text).not.toContain('sent to your account')
    expect(r.text).not.toContain('3957.520044 USDT')
  })

  test('the same through a second 0x AllowanceHolder step selling the USDT', () => {
    const zx = mc.decodeFunctionData('multicall', tx('relay-v32-router-0x-eth-to-usdt').data).calls[1].callData
    const e = ah.decodeFunctionData('exec', zx)
    // Settler.execute slippage: recipient = the router, buyToken = WETH, minAmountOut = 1.
    const word = (v: string) => v.slice(2).toLowerCase().padStart(64, '0')
    const inner = `${e.data.slice(0, 10)}${word(ROUTER)}${word(WETH)}${word('0x1')}${e.data.slice(10 + 3 * 64)}`
    const sell = ah.encodeFunctionData('exec', [e.operator, USDT, MIN, e.target, inner])
    expect(decodeSwapCall(AH, sell, 1, '0x0')).not.toBeNull() // a step the decoder reads on its own
    const t = rebuilt((c) => [c[0], c[1], call(USDT, erc20.encodeFunctionData('approve', [AH, MIN])), call(AH, sell), c[2]])
    expect(decodeSwapCall(t.to, t.data, 1, t.value)).toBeNull()
  })

  test('only an approval of the swept USDT after the swap: blind', () => {
    const t = rebuilt((c) => [c[0], c[1], call(USDT, erc20.encodeFunctionData('approve', [KYBER, MIN])), c[2]])
    expect(decodeSwapCall(t.to, t.data, 1, t.value)).toBeNull()
  })

  test('USDT swept twice, or swept before the swap that makes it: blind', () => {
    const twice = rebuilt((c) => [c[0], c[1], call(ROUTER, sweepUsdt(ATTACKER)), c[2]])
    expect(decodeSwapCall(twice.to, twice.data, 1, twice.value)).toBeNull()
    const early = rebuilt((c) => [c[0], c[2], c[1]])
    expect(decodeSwapCall(early.to, early.data, 1, early.value)).toBeNull()
  })

  test('an exact USDT payout after the swap lowers the guaranteed minimum of the sweep', () => {
    const fee = erc20.encodeFunctionData('cleanupErc20s', [[USDT], ['0xf70da97812CB96acDF810712Aa562db8dfA3dbEF'], [1000000], '0x'])
    const t = rebuilt((c) => [c[0], c[1], call(ROUTER, fee), c[2]])
    const fields = decodeSwapCall(t.to, t.data, 1, t.value)!.fields
    expect(fields.find((f) => f.name === 'Minimum output')?.value).toBe('3956.520044 USDT')
    expect(fields.filter((f) => f.name === 'Relay fee').map((f) => f.value)).toContain("1 USDT to Relay's solver 0xf70da97812cb96acdf810712aa562db8dfa3dbef")
  })
})
