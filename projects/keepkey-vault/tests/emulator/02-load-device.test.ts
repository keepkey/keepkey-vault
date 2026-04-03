/**
 * Test 2: LoadDevice — load a mnemonic, verify initialization state.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { EmuHarness, TEST_MNEMONIC } from './harness'

const h = new EmuHarness()

afterAll(() => h.shutdown())

describe('LoadDevice', () => {
  test('boot + connect', async () => {
    await h.boot()
    await h.connect()
    const feat = await h.getFeatures()
    expect(feat.initialized).toBe(false)
  })

  test('loadDevice: mnemonic accepted, no error', async () => {
    await h.loadSeed(TEST_MNEMONIC)
    // If loadSeed throws, test fails
    console.log('  loadDevice completed successfully')
  })

  test('after load: features show initialized=true', async () => {
    // Drain stale ButtonAck left by transport's auto-response,
    // then reconnect for a clean transport.
    for (let i = 0; i < 5; i++) h.pollOnce()
    h.drain()
    await h.connect()

    const feat = await h.getFeatures()
    expect(feat.initialized).toBe(true)
    console.log(`  Label: ${feat.label || '(none)'}`)
    console.log(`  Initialized: ${feat.initialized}`)
  })
})
