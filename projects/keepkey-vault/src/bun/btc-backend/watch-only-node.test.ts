import { afterEach, describe, expect, it } from 'bun:test'
import { getBtcBackend, getWatchOnlyBtcBackend, getPsbtBroadcastRoute, isBtcNodeActive, setBtcBackendOffline, setBtcNodeConfig, setBtcNodeDeviceEligible, setBtcNodeWatchOnlyEligible } from './index'

// No request is made: the selector only builds the backend object.
const NODE = { type: 'blockbook' as const, url: 'http://127.0.0.1:9' }

afterEach(() => {
  setBtcNodeConfig(null)
  setBtcNodeDeviceEligible(false)
  setBtcNodeWatchOnlyEligible(false)
  setBtcBackendOffline(false)
})

describe('own-node eligibility: btc-only device OR btc-only watch-only wallet', () => {
  it('requires a selected wallet for generic signed-file broadcast when a node is configured', () => {
    setBtcNodeConfig(NODE)
    expect(() => getPsbtBroadcastRoute()).toThrow(/Open its saved Bitcoin-only wallet/)
    setBtcNodeWatchOnlyEligible(true)
    expect(getPsbtBroadcastRoute().backend.kind).toBe('blockbook')
    setBtcNodeDeviceEligible(false)
    expect(getPsbtBroadcastRoute().backend.kind).toBe('blockbook')
    setBtcBackendOffline(true)
    expect(getPsbtBroadcastRoute().backend.kind).toBe('device-only')
  })

  it('invalidates a broadcast review when a node changes to another node of the same type', () => {
    setBtcNodeConfig(NODE)
    setBtcNodeWatchOnlyEligible(true)
    const first = getPsbtBroadcastRoute()
    setBtcNodeConfig({ ...NODE, url: 'http://127.0.0.1:10' })
    const second = getPsbtBroadcastRoute()
    expect(first.backend.kind).toBe(second.backend.kind)
    expect(first.id).not.toBe(second.id)
    expect(first.backend).not.toBe(second.backend)
  })
  it('uses the named wallet before any UI notification and after reloading settings without a device', () => {
    for (const type of ['blockbook', 'core'] as const) {
      setBtcNodeConfig({ type, url: NODE.url })
      expect(getWatchOnlyBtcBackend(true).kind).toBe(type)
      setBtcNodeDeviceEligible(false)
      expect(getWatchOnlyBtcBackend(true).kind).toBe(type)
      setBtcNodeConfig(null) // process state discarded at restart
      setBtcNodeConfig({ type, url: NODE.url }) // persisted node restored
      expect(getWatchOnlyBtcBackend(true).kind).toBe(type)
    }
  })

  it('does not borrow eligibility from another wallet or device, and offline always wins', () => {
    setBtcNodeConfig(NODE)
    setBtcNodeDeviceEligible(true)
    setBtcNodeWatchOnlyEligible(true)
    expect(getWatchOnlyBtcBackend(false).kind).toBe('pioneer')
    setBtcBackendOffline(true)
    expect(getWatchOnlyBtcBackend(true).kind).toBe('device-only')
    expect(getWatchOnlyBtcBackend(false).kind).toBe('device-only')
  })

  it('an unreachable selected node rejects rather than using Pioneer', async () => {
    setBtcNodeConfig(NODE)
    const backend = getWatchOnlyBtcBackend(true)
    await expect(backend.listUnspent({ network: 'bip122:000000000019d6689c085ae165831e93', xpub: 'xpub-test' })).rejects.toThrow()
    expect(getWatchOnlyBtcBackend(true).kind).toBe('blockbook')
  })
  it('a configured node stays off with neither', () => {
    setBtcNodeConfig(NODE)
    expect(getBtcBackend().kind).toBe('pioneer')
    expect(isBtcNodeActive()).toBe(false)
  })

  it('a Bitcoin-only watch-only wallet uses the node with no device', () => {
    setBtcNodeConfig(NODE)
    setBtcNodeWatchOnlyEligible(true)
    expect(getBtcBackend().kind).toBe('blockbook')
  })

  it('a device state change does not switch watch-only off (and vice versa)', () => {
    setBtcNodeConfig(NODE)
    setBtcNodeWatchOnlyEligible(true)
    setBtcNodeDeviceEligible(false) // e.g. a multichain device connecting or a disconnect
    expect(getBtcBackend().kind).toBe('blockbook')
    setBtcNodeWatchOnlyEligible(false)
    expect(getBtcBackend().kind).toBe('pioneer')
    setBtcNodeDeviceEligible(true)
    expect(getBtcBackend().kind).toBe('blockbook')
  })

  it('offline mode wins, and no node configured means Pioneer', () => {
    setBtcNodeConfig(NODE)
    setBtcNodeWatchOnlyEligible(true)
    setBtcBackendOffline(true)
    expect(getBtcBackend().kind).toBe('device-only')
    setBtcBackendOffline(false)
    setBtcNodeConfig(null)
    expect(getBtcBackend().kind).toBe('pioneer')
  })
})
