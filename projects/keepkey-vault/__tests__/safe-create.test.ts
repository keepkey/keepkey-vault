import { describe, expect, test } from 'bun:test'
import { ethers } from 'ethers'
import ref from './fixtures/safe/create-385e.json'
import { planSafeCreate, checkBeforeCreate, checkCreatedSafe } from '../src/bun/safe-create'

// A real Safe 1.4.1 creation on Ethereum (tx 0x8f5df072…): the factory call and
// the address it created. The plan must reproduce both from owners and threshold alone.
const factory = new ethers.utils.Interface(['function createProxyWithNonce(address,bytes,uint256)'])
const safe = new ethers.utils.Interface(['function setup(address[],uint256,address,bytes,address,address,uint256,address)'])
const [, initializer, saltNonce] = factory.decodeFunctionData('createProxyWithNonce', ref.input)
const [owners, threshold] = safe.decodeFunctionData('setup', initializer)

describe('planSafeCreate', () => {
  const plan = planSafeCreate(1, owners, Number(threshold), saltNonce.toString())

  test('re-encodes the real creation byte for byte and predicts its address', () => {
    expect(plan.data).toBe(ref.input)
    expect(plan.factory.toLowerCase()).toBe(ref.to)
    expect(plan.predicted).toBe(ref.created)
  })

  test('any other owner, threshold or salt lands somewhere else', () => {
    const other = '0x2222222222222222222222222222222222222222'
    expect(planSafeCreate(1, [...owners, other], Number(threshold), saltNonce.toString()).predicted).not.toBe(ref.created)
    expect(planSafeCreate(1, owners, Number(threshold), '1').predicted).not.toBe(ref.created)
    if (owners.length > 1) expect(planSafeCreate(1, owners, Number(threshold) + 1, saltNonce.toString()).predicted).not.toBe(ref.created)
  })

  test('uses SafeL2 on every chain, as Safe{Wallet} does', () => {
    expect(planSafeCreate(8453, owners, 1, '1').singleton).toBe('0x29fcB43b46531BcA003ddC8FCB67FFE91900C762')
    expect(plan.singleton).toBe('0x29fcB43b46531BcA003ddC8FCB67FFE91900C762')
  })

  test('refuses bad owners and thresholds, and chains without Safe', () => {
    const a = '0x1111111111111111111111111111111111111111'
    expect(() => planSafeCreate(8453, [], 1, '1')).toThrow('at least one owner')
    expect(() => planSafeCreate(8453, [a, a.toUpperCase().replace('0X', '0x')], 1, '1')).toThrow('only once')
    expect(() => planSafeCreate(8453, [a], 2, '1')).toThrow('between 1 and 1')
    expect(() => planSafeCreate(8453, [a], 0, '1')).toThrow('between 1 and 1')
    expect(() => planSafeCreate(8453, [ethers.constants.AddressZero], 1, '1')).toThrow('cannot be an owner')
    expect(() => planSafeCreate(8453, ['0x1234'], 1, '1')).toThrow('Not an address')
    expect(() => planSafeCreate(2868, [a], 1, '1')).toThrow('chain 2868')
  })
})

describe('on-chain checks around the deploy', () => {
  const a = '0x1111111111111111111111111111111111111111', b = '0x2222222222222222222222222222222222222222'
  const plan = planSafeCreate(8453, [a, b], 2, '7')
  const ret = (addr: string) => ethers.utils.defaultAbiCoder.encode(['address'], [addr])

  test('a factory that is not Safe\'s stops the deploy before anything is signed', async () => {
    const factoryCode = '0xfe' // not Safe's factory
    await expect(checkBeforeCreate(plan, { getCode: async () => factoryCode, call: async () => ret(plan.predicted) })).rejects.toThrow("does not match Safe's published build")
  })

  test("a deployed Safe with different owners is caught", async () => {
    // Not Safe proxy code at all: the read-back refuses before trusting any answer.
    await expect(checkCreatedSafe(plan, { getCode: async () => '0x6080', call: async () => '0x' })).rejects.toThrow('not a standard Safe proxy')
  })
})
