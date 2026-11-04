import { describe, expect, test } from 'bun:test'
import { createWalletMonitorRegistry, type WalletMonitorOwner } from '../src/bun/wallet-monitor-registry'

const owner: WalletMonitorOwner = { deviceId: 'standard-device', walletScope: 'vault:standard-scope', base: 'https://EXAMPLE.com:443/api/', queryKey: 'fixture-key' }
function setup() {
  let value: string | undefined, reads = 0, writes = 0
  const settings = { read: () => { reads++; return value }, write: (json: string) => { writes++; value = json } }
  return { settings, registry: createWalletMonitorRegistry(settings), get value() { return value }, get reads() { return reads }, get writes() { return writes } }
}

describe('standard background monitoring ownership registry', () => {
  test('persists minimal normalized descriptors across registry recreation', () => {
    const h = setup()
    h.registry.remember({ ...owner, wallet: { secret: 'must-not-persist' }, addresses: ['private-address'], publicKey: 'private-public-key' } as any)
    expect(h.registry.list()).toEqual([{ ...owner, base: 'https://example.com/api' }])
    expect(createWalletMonitorRegistry(h.settings).list()).toEqual(h.registry.list())
    expect(h.value).not.toContain('must-not-persist'); expect(h.value).not.toContain('private-address'); expect(h.value).not.toContain('publicKey')
  })

  test('hidden sessions do not read or write persistent ownership', () => {
    const h = setup()
    h.registry.remember({ ...owner, deviceId: 'hidden-identifier' }, true)
    expect(h.reads).toBe(0); expect(h.writes).toBe(0); expect(h.value).toBeUndefined()
  })

  test('deduplicates equivalent provider URLs while retaining past keys and providers', () => {
    const h = setup()
    h.registry.remember(owner)
    h.registry.remember({ ...owner, base: 'https://example.com/api' })
    expect(h.writes).toBe(1)
    h.registry.remember({ ...owner, queryKey: 'rotated-key' })
    h.registry.remember({ ...owner, base: 'https://second.invalid' })
    h.registry.remember({ ...owner, walletScope: 'vault:another-standard-scope' })
    expect(h.registry.list(owner.deviceId)).toHaveLength(4)
  })

  test('device-specific forget inventory and global Offline inventory remain separate', () => {
    const h = setup(); h.registry.remember(owner); h.registry.remember({ ...owner, deviceId: 'other-device', walletScope: 'vault:other' })
    expect(h.registry.list()).toHaveLength(2); expect(h.registry.list(owner.deviceId)).toHaveLength(1)
    h.registry.remove(owner)
    expect(h.registry.list()).toEqual([{ ...owner, deviceId: 'other-device', walletScope: 'vault:other', base: 'https://example.com/api' }])
  })

  test('failed remote disable preserves ownership; success removes only that registration', async () => {
    const h = setup(); h.registry.remember(owner); h.registry.remember({ ...owner, queryKey: 'other-key' })
    await expect(h.registry.revoke(owner, async () => { throw new Error('provider unavailable') })).rejects.toThrow('provider unavailable')
    expect(h.registry.list()).toHaveLength(2)
    let revoked: WalletMonitorOwner | undefined
    await h.registry.revoke(owner, async descriptor => { revoked = descriptor })
    expect(revoked).toEqual({ ...owner, base: 'https://example.com/api' })
    expect(h.registry.list().map(record => record.queryKey)).toEqual(['other-key'])
  })

  test('silent settings failure blocks initial registration ownership', () => {
    const registry = createWalletMonitorRegistry({ read: () => undefined, write: () => {} })
    expect(() => registry.remember(owner)).toThrow('could not be saved')
  })

  test('malformed saved state fails clearly instead of silently forgetting remote owners', () => {
    let raw = '{corrupt'
    const registry = createWalletMonitorRegistry({ read: () => raw, write: json => { raw = json } })
    expect(() => registry.list()).toThrow('could not be read')
    expect(() => registry.remember(owner)).toThrow('could not be read')
    expect(raw).toBe('{corrupt')
  })

  test('caller mutation cannot alter saved descriptors; authenticated URL credentials are rejected', () => {
    const h = setup(); h.registry.remember(owner)
    h.registry.list()[0].queryKey = 'mutated'
    expect(h.registry.list()[0].queryKey).toBe('fixture-key')
    expect(() => h.registry.remember({ ...owner, base: 'https://user:password@example.com' })).toThrow('provider')
    expect(() => h.registry.remember({ ...owner, base: 'https://example.com?key=secret' })).toThrow('provider')
  })
})
