import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { WalletCacheSession, WalletSessionChangedError, WalletSessionMap } from './wallet-session-cache'

class Device extends EventEmitter {
  wallet: object | null = {}
  currentSeedEthAddress: string | null = 'wallet-a'
  deviceId = 'same-device'
  state = 'ready'
  getDeviceState() { return { state: this.state, deviceId: this.deviceId } }
  transition(state: string) { this.state = state; this.emit('state-change', this.getDeviceState()) }
  switchWallet(seed: string) { this.currentSeedEthAddress = seed; this.emit('wallet-scope-ready', {}) }
}

function fixture() {
  const device = new Device()
  const session = new WalletCacheSession()
  const addresses = new WalletSessionMap<string>(session)
  const pubkeys = new WalletSessionMap<string>(session)
  session.bind(device)
  return { device, session, addresses, pubkeys }
}

describe('REST wallet session caches', () => {
  test('retains stable-wallet cache hits across repeated ready notifications', () => {
    const { device, session, addresses } = fixture()
    const key = session.key('eth', [44, 60, 0])
    addresses.set(key, 'address-a')
    device.transition('ready')
    device.switchWallet('WALLET-A')
    expect(addresses.get(session.key('eth', [44, 60, 0]))).toBe('address-a')
  })

  test('same-device seed changes invalidate both addresses and pubkeys', () => {
    const { device, session, addresses, pubkeys } = fixture()
    addresses.set(session.key('eth', []), 'address-a')
    pubkeys.set(session.key('xpub', []), 'xpub-a')
    device.switchWallet('wallet-b')
    expect(addresses.size).toBe(0)
    expect(pubkeys.size).toBe(0)
    expect(addresses.get(session.key('eth', []))).toBeUndefined()
  })

  test('hidden -> standard changes scope without a seed-changed event', () => {
    const { device, session, addresses } = fixture()
    device.switchWallet('hidden-wallet')
    addresses.set(session.key('eth', []), 'hidden-address')
    device.switchWallet('wallet-a')
    expect(addresses.get(session.key('eth', []))).toBeUndefined()
  })

  test.each(['needs_passphrase', 'needs_init', 'disconnected'])('%s invalidates even before seed identity updates', (state) => {
    const { device, session, addresses } = fixture()
    const key = session.key('eth', [])
    addresses.set(key, 'address-a')
    device.transition(state)
    expect(addresses.size).toBe(0)
    expect(() => addresses.set(key, 'late-address-a')).toThrow(WalletSessionChangedError)
  })

  test('rejects an old in-flight derivation after the current wallet cache is populated', async () => {
    const { device, session, addresses } = fixture()
    const oldKey = session.key('eth', [])
    let finish!: (address: string) => void
    const pending = new Promise<string>(resolve => { finish = resolve }).then(address => addresses.set(oldKey, address))
    device.switchWallet('wallet-b')
    const newKey = session.key('eth', [])
    addresses.set(newKey, 'address-b')
    finish('address-a')
    await expect(pending).rejects.toBeInstanceOf(WalletSessionChangedError)
    expect(addresses.get(newKey)).toBe('address-b')
    expect(addresses.size).toBe(1)
  })

  test('rejects a mixed-wallet batch even if its last item used the new scope', () => {
    const { device, session, addresses } = fixture()
    const batch = session.key('batch-request', [])
    addresses.set(session.key('eth', [0]), 'address-a')
    device.switchWallet('wallet-b')
    addresses.set(session.key('eth', [1]), 'address-b-1')
    expect(() => session.assertCurrent(batch)).toThrow(WalletSessionChangedError)
  })

  test('observes a changed live identity before its event is emitted', () => {
    const { device, session, addresses } = fixture()
    const key = session.key('eth', [])
    device.currentSeedEthAddress = 'wallet-b'
    expect(() => addresses.set(key, 'late-address-a')).toThrow(WalletSessionChangedError)
  })

  test('changing wallet handles or devices rejects old results even with the same seed', () => {
    const { device, session, pubkeys } = fixture()
    const key = session.key('xpub', [])
    device.wallet = {}
    expect(() => pubkeys.set(key, 'old-xpub')).toThrow(WalletSessionChangedError)
    const nextKey = session.key('xpub', [])
    device.deviceId = 'other-device'
    expect(() => pubkeys.set(nextKey, 'old-xpub')).toThrow(WalletSessionChangedError)
  })

  test('explicit cache clear also rejects in-flight writes', () => {
    const { session, addresses } = fixture()
    const key = session.key('eth', [])
    session.invalidate()
    expect(() => addresses.set(key, 'late-address')).toThrow(WalletSessionChangedError)
  })

  test('a stale write cannot evict current-wallet entries from a full cache', () => {
    const { device, session } = fixture()
    const cache = new WalletSessionMap<string>(session, 2)
    const stale = session.key('eth', [0])
    device.switchWallet('wallet-b')
    cache.set(session.key('eth', [0]), 'b-0')
    cache.set(session.key('eth', [1]), 'b-1')
    expect(() => cache.set(stale, 'a-0')).toThrow(WalletSessionChangedError)
    expect([...cache.values()]).toEqual(['b-0', 'b-1'])
    cache.set(session.key('eth', [2]), 'b-2')
    expect([...cache.values()]).toEqual(['b-1', 'b-2'])
  })
})
