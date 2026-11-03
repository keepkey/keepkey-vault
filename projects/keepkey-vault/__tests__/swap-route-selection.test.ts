import { describe, expect, test } from 'bun:test'
import type { SwapQuote } from '../src/shared/types'
import { isRelaySolverDeposit, selectSwapRoute } from '../src/bun/swap-route-selection'
import { extractRelayRequestId } from '../src/shared/relay-utils'

function quote(output: string, integration: string): SwapQuote {
  return { expectedOutput: output, minimumOutput: output, inboundAddress: '', memo: '',
    fees: { affiliate: '0', outbound: '0', totalBps: 0 }, estimatedTime: 4, slippageBps: 100, integration }
}

describe('firmware-aware swap selection', () => {
  test('prefers device review over a larger opaque output, regardless of provider name', async () => {
    const opaque = quote('25', 'relay')
    const supported = quote('24.9', 'uniswap')
    expect(await selectSwapRoute([opaque, supported], async q => q === supported)).toBe(supported)
  })
  test('chooses the best output among reviewable routes and preserves normal fallback', async () => {
    const low = quote('24', 'relay'), high = quote('25', 'uniswap')
    expect(await selectSwapRoute([low, high], async () => true)).toBe(high)
    expect(await selectSwapRoute([low, high], async () => false)).toBe(high)
  })
  test('prefers a reviewed atomic swap over a deposit whose destination terms are off chain', async () => {
    const deposit = quote('25', 'relay'), atomic = quote('24.99', 'uniswap')
    expect(await selectSwapRoute([deposit, atomic], async q => q === deposit ? 'source-deposit' : true)).toBe(atomic)
  })
  test('a failed certificate lookup never grants a route review support', async () => {
    const supported = quote('24', 'relay'), unavailable = quote('25', 'other')
    expect(await selectSwapRoute([unavailable, supported], async q => {
      if (q === unavailable) throw new Error('lookup offline')
      return true
    })).toBe(supported)
  })
})

describe('Relay solver deposit review scope and tracking', () => {
  const id = 'ab'.repeat(32)
  const native = `0x49290c1c${'0'.repeat(64)}${id}`
  const erc20 = `0xe8017952${'0'.repeat(192)}${id}`
  const deposit = (data: string, to = '0x4cd00e387622c35bddb9b4c962c136462338bc31') => ({
    ...quote('24', 'untrusted-label'), relayTx: { to, data, value: '0', chainId: 1 },
  } as SwapQuote)
  test('recognizes actual source deposits without trusting provider labels', () => {
    expect(isRelaySolverDeposit(deposit(native))).toBe(true)
    expect(isRelaySolverDeposit(deposit(erc20))).toBe(true)
    expect(isRelaySolverDeposit(deposit(native, '0x' + '1'.repeat(40)))).toBe(false)
    expect(isRelaySolverDeposit(deposit(`${native}00`))).toBe(false)
    expect(isRelaySolverDeposit(deposit('0xcd6e13f7' + '0'.repeat(128)))).toBe(false)
  })
  test('extracts the order ID from native and exact-amount ERC-20 deposits', () => {
    expect(extractRelayRequestId(native)).toBe(`0x${id}`)
    expect(extractRelayRequestId(erc20)).toBe(`0x${id}`)
    expect(extractRelayRequestId(`${native}${'0'.repeat(64)}`)).toBeUndefined()
    expect(extractRelayRequestId(native.replace(id, '0'.repeat(64)))).toBeUndefined()
    expect(extractRelayRequestId(native.replace(id, 'z'.repeat(64)))).toBeUndefined()
  })
})
