/**
 * Test 3: Key derivation — GetPublicKey for BTC (secp256k1).
 *
 * This is the critical test that exposes the storage_getRootNode failure.
 * If the firmware can derive a BTC xpub, the sec section is accessible.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { EmuHarness, TEST_MNEMONIC } from './harness'

const h = new EmuHarness()

afterAll(() => h.shutdown())

describe('Key Derivation (secp256k1)', () => {
  test('setup: boot + connect + loadDevice', async () => {
    await h.boot()
    await h.connect()
    await h.loadSeed(TEST_MNEMONIC)
    // Drain stale ButtonAck left by transport's auto-response
    // Process stale messages through firmware, then drain output
    for (let i = 0; i < 10; i++) h.pollOnce()
    h.drain()
  })

  test('getPublicKeys: BTC m/44\'/0\'/0\' returns xpub', async () => {
    // Re-establish clean transport after drain
    await h.connect()
    const feat = await h.getFeatures()
    expect(feat.initialized).toBe(true)

    try {
      const result = await h.wallet!.getPublicKeys([{
        addressNList: [0x80000000 + 44, 0x80000000 + 0, 0x80000000 + 0],
        coin: 'Bitcoin',
        scriptType: 0, // p2pkh
        curve: 'secp256k1',
      }])
      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)
      const xpub = result[0]?.xpub
      expect(xpub).toBeTruthy()
      console.log(`  BTC xpub: ${xpub?.slice(0, 30)}...`)
    } catch (err: any) {
      const msg = err?.message?.message || err?.message || String(err)
      if (msg.includes('not initialized') || msg.includes('passphrase')) {
        console.error('  EXPECTED FAILURE: storage sec section not accessible')
        console.error('  Root cause: HW entropy changes between kkemu_init calls')
        console.error('  Fix needed: stable emulator hardware entropy')
      }
      throw err
    }
  })
})
