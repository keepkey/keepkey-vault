import { describe, expect, test } from 'bun:test'
import { utxoPreview } from './utxoPreview'

describe('UTXO signing preview', () => {
  test('shows all economic effects and signed swap memo without claiming vault verification', () => {
    const memo = '=:ETH.ETH:0x1111111111111111111111111111111111111111:198939164:keep:30'
    const preview = utxoPreview({ coin: 'Bitcoin',
      inputs: [{ amount: '100002712' }], outputs: [
        { address: 'bc1vault', amount: '6000000' },
        { addressType: 'change', isChange: true, addressNList: [0x80000054, 0x80000000, 0x80000000, 1, 0], amount: '94000000' },
        { amount: '0', opReturnData: btoa(memo) },
      ] })
    expect(preview?.sends).toEqual([{ address: 'bc1vault', amount: '0.06000000 BTC' }])
    expect(preview?.change).toEqual(['0.94000000 BTC'])
    expect(preview?.fee).toBe('0.00002712 BTC')
    expect(preview?.swap?.minimum).toBe('1.98939164 ETH')
    expect(preview?.swap?.affiliate).toBe('0.30%')
    expect(preview?.warning).toContain('not independently verified')
  })

  test('does not invent a fee or readable memo from missing or binary input', () => {
    const preview = utxoPreview({ coin: 'Bitcoin', inputs: [{}], outputs: [
      { address: 'bc1vault', amount: '1' }, { amount: '0', opReturnData: btoa('\x00\x01') },
    ] })
    expect(preview?.fee).toBeUndefined()
    expect(preview?.memo).toBeUndefined()
    expect(preview?.warning).toContain('cannot be shown')
  })
  test('uses Litecoin units for a two-output vault deposit', () => {
    const memo = '=:ETH.ETH:0x1111111111111111111111111111111111111111:100000000'
    const preview = utxoPreview({coin:'Litecoin',inputs:[{amount:'12001152'}],outputs:[
      {address:'ltc1vault',amount:'12000000'},
      {amount:'0',opReturnData:btoa(memo)},
    ]})
    expect(preview?.coin).toBe('Litecoin')
    expect(preview?.sends[0].amount).toBe('0.12000000 LTC')
    expect(preview?.fee).toBe('0.00001152 LTC')
    expect(preview?.warning).toContain('LTC vault address')
  })
})

describe('change must be derived by the KeepKey (KEEPKEY-156)', () => {
  test('a change output with addressNList stays change', () => {
    const preview = utxoPreview({ coin: 'Bitcoin', inputs: [{ amount: '100000000' }], outputs: [
      { address: 'bc1dest', amount: '6000000' },
      { addressType: 'change', isChange: true, addressNList: [0x80000054, 0x80000000, 0x80000000, 1, 0], amount: '93990000' },
    ] })
    expect(preview?.change).toEqual(['0.93990000 BTC'])
    expect(preview?.sends).toEqual([{ address: 'bc1dest', amount: '0.06000000 BTC' }])
    expect(preview?.warning).toBeUndefined()
  })

  test('a "change" output without addressNList is listed as an unverified send, with its address and a warning', () => {
    const preview = utxoPreview({ coin: 'Bitcoin', inputs: [{ amount: '100000000' }], outputs: [
      { address: 'bc1dest', amount: '6000000' },
      { address: 'bc1attacker', addressType: 'change', isChange: true, amount: '93990000' },
    ] })
    expect(preview?.change).toEqual([])
    expect(preview?.sends).toEqual([
      { address: 'bc1dest', amount: '0.06000000 BTC' },
      { address: 'bc1attacker', amount: '0.93990000 BTC', unverified: true },
    ])
    expect(preview?.warning).toContain('unverified')
  })

  test('an empty addressNList is not a derivation path', () => {
    const preview = utxoPreview({ coin: 'Bitcoin', inputs: [{ amount: '2' }], outputs: [{ address: 'bc1x', isChange: true, addressNList: [], amount: '1' }] })
    expect(preview?.sends[0]?.unverified).toBe(true)
  })

  test('keeps the swap warning and adds the unverified-change note', () => {
    const memo = '=:ETH.ETH:0x1111111111111111111111111111111111111111:1'
    const preview = utxoPreview({ coin: 'Bitcoin', inputs: [{ amount: '3' }], outputs: [
      { address: 'bc1vault', amount: '1' }, { address: 'bc1x', addressType: 'change', amount: '1' }, { amount: '0', opReturnData: btoa(memo) },
    ] })
    expect(preview?.warning).toContain('not independently verified')
    expect(preview?.warning).toContain('unverified')
  })
})
