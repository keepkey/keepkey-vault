import { describe, expect, test } from 'bun:test'
import { selfHostChangeIndex } from './utxo'

const query = { network: 'btc', xpub: 'xpub-test', scriptType: 'p2wpkh' }

describe('self-host change-address policy', () => {
  test('Core may build a transaction that has no change output', async () => {
    await expect(selfHostChangeIndex({ kind: 'core' }, query, false)).resolves.toBe(0)
  })

  test('Core fails closed when a change output needs history', async () => {
    await expect(selfHostChangeIndex({ kind: 'core' }, query, true)).rejects.toThrow(/cannot prove an unused change address/)
  })

  test('Blockbook supplies the history-derived change index', async () => {
    await expect(selfHostChangeIndex({
      kind: 'blockbook',
      addressIndices: async () => ({
        receiveIndex: 4,
        changeIndex: 9,
        discoveryAvailable: true,
        source: 'blockbook',
      }),
    }, query, true)).resolves.toBe(9)
  })

  test('an unavailable or malformed discovery result fails closed', async () => {
    await expect(selfHostChangeIndex({
      kind: 'blockbook',
      addressIndices: async () => ({
        receiveIndex: 0,
        changeIndex: -1,
        discoveryAvailable: false,
        source: 'blockbook',
      }),
    }, query, true)).rejects.toThrow(/trustworthy unused change index/)
  })
})
