import { describe, expect, test } from 'bun:test'
import { normalizeBlockbookHistoryTx } from '../src/bun/btc-backend/blockbook'

describe('Blockbook xpub history normalization', () => {
  const own = new Set(['mine-in', 'mine-change', 'mine-receive'])

  test('computes outgoing value after change and preserves the fee', () => {
    const tx = normalizeBlockbookHistoryTx({
      txid: 'abc', blockTime: 100, confirmations: 3, blockHeight: 10, fees: '1000',
      vin: [{ addresses: ['mine-in'], value: '100000' }],
      vout: [
        { addresses: ['merchant'], value: '59000' },
        { addresses: ['mine-change'], value: '40000', isOwn: true },
      ],
    }, own)!
    expect(tx.direction).toBe('sent')
    expect(tx.value).toBe('60000')
    expect(tx.fee).toBe('1000')
    expect(tx.to).toEqual(['merchant'])
  })

  test('computes incoming value and receiving address', () => {
    const tx = normalizeBlockbookHistoryTx({
      txid: 'def', vin: [{ addresses: ['sender'], value: '50000' }],
      vout: [{ addresses: ['mine-receive'], value: '50000', isOwn: true }],
    }, own)!
    expect(tx.direction).toBe('received')
    expect(tx.value).toBe('50000')
    expect(tx.from).toEqual(['sender'])
    expect(tx.to).toEqual(['mine-receive'])
  })
})
