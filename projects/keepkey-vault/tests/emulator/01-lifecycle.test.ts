/**
 * Test 1: Emulator lifecycle — boot, initialize, features, shutdown.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { EmuHarness } from './harness'

const h = new EmuHarness()

afterAll(() => h.shutdown())

describe('Emulator Lifecycle', () => {
  test('boot: kkemu_init succeeds with fresh flash', async () => {
    await h.boot()
    // If boot throws, test fails
  })

  test('connect: hdwallet transport pairs successfully', async () => {
    await h.connect()
    expect(h.wallet).not.toBeNull()
  })

  test('getFeatures: returns valid Features with initialized=false', async () => {
    const feat = await h.getFeatures()
    expect(feat).toBeDefined()
    expect(feat.initialized).toBe(false)
    expect(feat.majorVersion).toBeDefined()
    expect(feat.deviceId).toBeTruthy()
    console.log(`  FW: ${feat.majorVersion}.${feat.minorVersion}.${feat.patchVersion}`)
    console.log(`  Device ID: ${feat.deviceId}`)
    console.log(`  Initialized: ${feat.initialized}`)
  })

  test('getFeatures: second call also succeeds (transport reuse)', async () => {
    const feat = await h.getFeatures()
    expect(feat.initialized).toBe(false)
  })
})
