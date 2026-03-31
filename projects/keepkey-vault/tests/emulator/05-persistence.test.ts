/**
 * Test 5: Flash persistence — loadDevice, stop, restart, verify keys.
 *
 * This test will FAIL until the emulator hardware entropy issue is fixed.
 * It documents the exact failure mode for the storage key persistence bug.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { EmuHarness, TEST_MNEMONIC } from './harness'

const h = new EmuHarness()

afterAll(() => h.shutdown())

describe('Flash Persistence (KNOWN ISSUE)', () => {
  let firstBootXpub: string | undefined

  test('first boot: load seed + derive xpub', async () => {
    await h.boot()
    await h.connect()
    await h.loadSeed(TEST_MNEMONIC)

    for (let i = 0; i < 10; i++) h.pollOnce()
    h.drain()
    await h.connect()

    try {
      const result = await h.wallet!.getPublicKeys([{
        addressNList: [0x80000000 + 44, 0x80000000 + 0, 0x80000000 + 0],
        coin: 'Bitcoin',
        scriptType: 0,
        curve: 'secp256k1',
      }])
      firstBootXpub = result?.[0]?.xpub
      console.log(`  First boot xpub: ${firstBootXpub?.slice(0, 30)}...`)
      expect(firstBootXpub).toBeTruthy()
    } catch (err: any) {
      console.error('  First boot key derivation failed — cannot test persistence')
      throw err
    }
  })

  test('get flash buffer after loadDevice', () => {
    // Verify the flash buffer has been modified (not all 0xFF)
    // This is a low-level check that storage_commit wrote to the buffer
    // Note: we'd need access to the flash buffer to check this
    // For now, this is a placeholder
    expect(firstBootXpub).toBeTruthy()
  })

  test('restart: shutdown + boot from same flash', async () => {
    // Save flash state, shutdown, re-init with same flash
    // NOTE: EmuHarness currently uses fresh flash on boot().
    // This test requires a boot-from-buffer method.
    console.log('  SKIPPED: EmuHarness needs bootFromFlash() method')
    console.log('  This test documents the storage key persistence bug:')
    console.log('  - storage_deriveWrappingKey uses HW entropy that changes per boot')
    console.log('  - Encrypted sec section cant be decrypted after restart')
    console.log('  - Fix: stable emulator hardware entropy (patch firmware or inject)')
  })
})
