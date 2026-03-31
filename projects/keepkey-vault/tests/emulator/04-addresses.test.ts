/**
 * Test 4: Address derivation — BTC, ETH, Cosmos, Thorchain.
 *
 * Each chain exercises a different firmware message handler.
 * Requires test 3 (key derivation) to pass first.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { EmuHarness, TEST_MNEMONIC } from './harness'

const h = new EmuHarness()

afterAll(() => h.shutdown())

describe('Address Derivation', () => {
  test('setup: boot + connect + loadDevice + reconnect', async () => {
    await h.boot()
    await h.connect()
    await h.loadSeed(TEST_MNEMONIC)
    // Flush stale messages + reconnect clean
    for (let i = 0; i < 10; i++) h.pollOnce()
    h.drain()
    await h.connect()
    const feat = await h.getFeatures()
    expect(feat.initialized).toBe(true)
  })

  test('btcGetAddress: m/44\'/0\'/0\'/0/0', async () => {
    try {
      const addr = await h.wallet!.btcGetAddress({
        addressNList: [0x80000000 + 44, 0x80000000 + 0, 0x80000000 + 0, 0, 0],
        coin: 'Bitcoin',
        scriptType: 0,
        showDisplay: false,
      })
      expect(addr).toBeTruthy()
      expect(addr).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/) // P2PKH
      console.log(`  BTC: ${addr}`)
    } catch (err: any) {
      console.error('  BTC address FAILED:', err?.message?.message || err?.message)
      throw err
    }
  })

  test('ethGetAddress: m/44\'/60\'/0\'/0/0', async () => {
    try {
      const addr = await h.wallet!.ethGetAddress({
        addressNList: [0x80000000 + 44, 0x80000000 + 60, 0x80000000 + 0, 0, 0],
        showDisplay: false,
      })
      expect(addr).toBeTruthy()
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
      console.log(`  ETH: ${addr}`)
    } catch (err: any) {
      console.error('  ETH address FAILED:', err?.message?.message || err?.message)
      throw err
    }
  })

  test('cosmosGetAddress: m/44\'/118\'/0\'/0/0', async () => {
    try {
      const addr = await h.wallet!.cosmosGetAddress({
        addressNList: [0x80000000 + 44, 0x80000000 + 118, 0x80000000 + 0, 0, 0],
        showDisplay: false,
      })
      expect(addr).toBeTruthy()
      expect(addr).toMatch(/^cosmos1/)
      console.log(`  Cosmos: ${addr}`)
    } catch (err: any) {
      console.error('  Cosmos address FAILED:', err?.message?.message || err?.message)
      throw err
    }
  })

  test('thorchainGetAddress: m/44\'/931\'/0\'/0/0', async () => {
    try {
      const addr = await h.wallet!.thorchainGetAddress({
        addressNList: [0x80000000 + 44, 0x80000000 + 931, 0x80000000 + 0, 0, 0],
        showDisplay: false,
      })
      expect(addr).toBeTruthy()
      expect(addr).toMatch(/^thor1/)
      console.log(`  Thorchain: ${addr}`)
    } catch (err: any) {
      console.error('  Thorchain address FAILED:', err?.message?.message || err?.message)
      throw err
    }
  })
})
