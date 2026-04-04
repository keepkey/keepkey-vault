/**
 * Test 6: Mnemonic persistence via Keychain — the workaround for the
 * firmware storage key bug.
 *
 * Since the firmware can't decrypt its own stored seed after a restart
 * (storage_deriveWrappingKey uses HW entropy that changes per boot),
 * we save the mnemonic separately in Keychain-encrypted storage and
 * auto-reload it on restart.
 *
 * Tests:
 *   1. saveMnemonic + loadMnemonic round-trip
 *   2. deleteMnemonic removes it
 *   3. Full cycle: boot → loadSeed → save mnemonic → shutdown →
 *      fresh boot → auto-load mnemonic → same xpub
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { EmuHarness, TEST_MNEMONIC } from './harness'

const FLASH_NAME = 'test-mnemonic-persist'

// ── Layer 1: Keychain mnemonic save/load round-trip ──────────────────

describe('Mnemonic Keychain Storage', () => {
  test('saveMnemonic + loadMnemonic round-trip', async () => {
    if (process.platform !== 'darwin') {
      console.log('  SKIPPED: macOS only')
      return
    }
    const { saveMnemonic, loadMnemonic, deleteMnemonic } =
      await import('../../src/bun/emulator-keychain')

    try {
      saveMnemonic(FLASH_NAME, TEST_MNEMONIC)
      const loaded = loadMnemonic(FLASH_NAME)
      expect(loaded).toBe(TEST_MNEMONIC)
      console.log('  Round-trip: mnemonic matches')
    } finally {
      deleteMnemonic(FLASH_NAME)
    }
  })

  test('loadMnemonic returns null when not saved', async () => {
    if (process.platform !== 'darwin') {
      console.log('  SKIPPED: macOS only')
      return
    }
    const { loadMnemonic } = await import('../../src/bun/emulator-keychain')
    const loaded = loadMnemonic('nonexistent-flash-name')
    expect(loaded).toBeNull()
  })

  test('deleteMnemonic cleans up', async () => {
    if (process.platform !== 'darwin') {
      console.log('  SKIPPED: macOS only')
      return
    }
    const { saveMnemonic, loadMnemonic, deleteMnemonic } =
      await import('../../src/bun/emulator-keychain')

    saveMnemonic(FLASH_NAME, TEST_MNEMONIC)
    expect(loadMnemonic(FLASH_NAME)).toBe(TEST_MNEMONIC)
    deleteMnemonic(FLASH_NAME)
    expect(loadMnemonic(FLASH_NAME)).toBeNull()
    console.log('  Delete: mnemonic removed')
  })
})

// ── Layer 2: Full restart cycle with auto-reload ─────────────────────

describe('Mnemonic Auto-Reload on Restart', () => {
  test('boot → seed → save → restart → auto-load → same xpub', async () => {
    if (process.platform !== 'darwin') {
      console.log('  SKIPPED: macOS only')
      return
    }
    const { saveMnemonic, loadMnemonic, deleteMnemonic } =
      await import('../../src/bun/emulator-keychain')

    try {
      // Phase 1: Fresh boot, load seed, derive xpub, save mnemonic
      const h1 = new EmuHarness()
      await h1.boot()
      await h1.connect()
      await h1.loadSeed(TEST_MNEMONIC)
      for (let i = 0; i < 10; i++) h1.pollOnce()
      h1.drain()
      await h1.connect()

      const result1 = await h1.wallet!.getPublicKeys([{
        addressNList: [0x80000000 + 44, 0x80000000 + 0, 0x80000000 + 0],
        coin: 'Bitcoin',
        scriptType: 0,
        curve: 'secp256k1',
      }])
      const xpub1 = result1?.[0]?.xpub
      expect(xpub1).toBeTruthy()
      console.log(`  Phase 1 xpub: ${xpub1?.slice(0, 40)}...`)

      // Save mnemonic to Keychain (what the app should do)
      saveMnemonic(FLASH_NAME, TEST_MNEMONIC)
      h1.shutdown()

      // Phase 2: Fresh boot (simulates restart after stale flash auto-wipe),
      // load mnemonic from Keychain, re-seed, verify same xpub
      const saved = loadMnemonic(FLASH_NAME)
      expect(saved).toBe(TEST_MNEMONIC)

      const h2 = new EmuHarness()
      await h2.boot()  // fresh 0xFF flash (auto-wipe happened)
      await h2.connect()

      const freshFeat = await h2.getFeatures()
      expect(freshFeat.initialized).toBe(false)
      console.log('  Phase 2: fresh boot, initialized=false')

      // Auto-reload the saved mnemonic
      await h2.loadSeed(saved!)
      for (let i = 0; i < 10; i++) h2.pollOnce()
      h2.drain()
      await h2.connect()

      const result2 = await h2.wallet!.getPublicKeys([{
        addressNList: [0x80000000 + 44, 0x80000000 + 0, 0x80000000 + 0],
        coin: 'Bitcoin',
        scriptType: 0,
        curve: 'secp256k1',
      }])
      const xpub2 = result2?.[0]?.xpub
      expect(xpub2).toBeTruthy()
      expect(xpub2).toBe(xpub1)
      console.log(`  Phase 2 xpub: ${xpub2?.slice(0, 40)}...`)
      console.log('  Mnemonic auto-reload: xpubs MATCH')
      h2.shutdown()
    } finally {
      deleteMnemonic(FLASH_NAME)
    }
  })
})
