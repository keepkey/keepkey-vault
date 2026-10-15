import { describe, it, expect } from 'bun:test'
import { newEmulatorWalletNameError, emulatorWalletDetail } from './emulatorWallets'

describe('emulator wallets', () => {
  it('a new wallet needs a plain name that is not taken', () => {
    expect(newEmulatorWalletNameError('swap-qa', ['default'])).toBeNull()
    for (const bad of ['', '  ', 'Swap QA', '../x', '-x', 'a'.repeat(33), 'build-abc', 'default', 'x.mnemonic']) {
      expect(newEmulatorWalletNameError(bad, ['default'])).toBeString()
    }
    expect(newEmulatorWalletNameError('default', ['Default'])).toBeString()
  })

  it('the detail line separates two wallets with the same device label', () => {
    const now = 1_000 * 3_600_000
    const base = { hasMnemonic: true, isActive: false, label: 'KeepKey', firmwareVersion: '7.16.0' }
    const a = emulatorWalletDetail({ ...base, name: 'a', deviceId: '550E8EEDA3E5F8C2F32F8EF9', lastUsed: now - 3 * 3_600_000 }, now)
    const b = emulatorWalletDetail({ ...base, name: 'b', deviceId: 'A12D2DE698C9989A4AF4C73F', lastUsed: now - 72 * 3_600_000 }, now)
    expect(a).toBe('label "KeepKey" · fw 7.16.0 · id …2F8EF9 · used 3h ago')
    expect(b).toBe('label "KeepKey" · fw 7.16.0 · id …F4C73F · used 3d ago')
    expect(emulatorWalletDetail({ name: 'c', hasMnemonic: false, isActive: false })).toBe('never started')
  })
})
