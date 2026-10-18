import { afterEach, describe, expect, it } from 'bun:test'
import { getBtcBackend, isBtcNodeActive, setBtcBackendOffline, setBtcNodeConfig, setBtcNodeDeviceEligible, setBtcNodeWatchOnlyEligible } from './index'

// No request is made: the selector only builds the backend object.
const NODE = { type: 'blockbook' as const, url: 'http://127.0.0.1:9' }

afterEach(() => {
  setBtcNodeConfig(null)
  setBtcNodeDeviceEligible(false)
  setBtcNodeWatchOnlyEligible(false)
  setBtcBackendOffline(false)
})

describe('own-node eligibility: btc-only device OR btc-only watch-only wallet', () => {
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
