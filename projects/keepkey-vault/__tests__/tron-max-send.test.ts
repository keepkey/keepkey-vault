import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { buildTx } from '../src/bun/txbuilder'
import { CHAINS } from '../src/shared/chains'
import { fakeTronGrid } from './fixtures/fake-trongrid'

const tron = CHAINS.find(c => c.id === 'tron')!
const tronAddress = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax'
const usdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

let originalFetch: typeof fetch
beforeEach(() => { originalFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = originalFetch })

describe('TRON max send', () => {
  test('native TRX max sends balance minus the fee reserve', async () => {
    const grid = fakeTronGrid({ balanceSun: 12_345_678 })
    globalThis.fetch = grid.handler

    const result = await buildTx({}, tron, {
      chainId: 'tron', to: tronAddress, amount: '0', isMax: true, fromAddress: tronAddress,
    })

    expect(grid.requests.createtransaction[0].amount).toBe(11_245_678)
    expect(result.unsignedTx.amount).toBe('11245678')
    expect(result.fee).toBe('1.1')
  })

  test('TRC-20 max reserves one token base unit before encoding transfer amount', async () => {
    const grid = fakeTronGrid()
    globalThis.fetch = grid.handler

    const result = await buildTx({}, tron, {
      chainId: 'tron', to: tronAddress, amount: '0', isMax: true, fromAddress: tronAddress,
      caip: `tron:0x2b6653dc/trc20:${usdtContract}`, tokenBalance: '123.45', tokenDecimals: 6,
    })

    const req = grid.requests.triggersmartcontract[0]
    expect(req.contract_address).toBe(usdtContract)
    expect(req.function_selector).toBe('transfer(address,uint256)')
    expect(BigInt(`0x${req.parameter.slice(64)}`)).toBe(123_449_999n)
    expect(result.unsignedTx.tronGridTx.txID).toBe('trc20')
    expect(Number(result.fee)).toBeGreaterThan(0)
  })

  test('recovers the exact USDT contract from the legacy lowercased CAIP', async () => {
    const grid = fakeTronGrid()
    globalThis.fetch = grid.handler

    await buildTx({}, tron, {
      chainId: 'tron', to: tronAddress, amount: '50', fromAddress: tronAddress,
      caip: 'tron:0x2b6653dc/token:tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t', tokenDecimals: 6,
    })

    const req = grid.requests.triggersmartcontract[0]
    expect(req.contract_address).toBe(usdtContract)
    expect(BigInt(`0x${req.parameter.slice(64)}`)).toBe(50_000_000n)
  })

  test('never falls back to native TRX for an unresolvable token CAIP', async () => {
    globalThis.fetch = (async () => { throw new Error('network must not be reached') }) as typeof fetch
    await expect(buildTx({}, tron, {
      chainId: 'tron', to: tronAddress, amount: '50', fromAddress: tronAddress,
      caip: 'tron:0x2b6653dc/token:tinvalidlowercasecontract0000000000', tokenDecimals: 6,
    })).rejects.toThrow(/case-sensitive TRON token contract/)
  })
})
