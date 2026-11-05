import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'

// Exercise the real controller and event handlers without loading native USB
// drivers or communicating with a wallet.
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({
  HIDKeepKeyAdapter: { useKeyring: () => ({}) },
}))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({
  NodeWebUSBKeepKeyAdapter: { useKeyring: () => ({}) },
}))
mock.module('usb', () => ({ usb: new EventEmitter() }))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: '/tmp/kk-settings-test-unused' } } }))

const { EngineController } = await import('../src/bun/engine-controller')

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const engine = new EngineController()
  const internal = engine as any
  const pin = deferred()
  const features = { initialized: true, majorVersion: 7, minorVersion: 17, patchVersion: 0,
    pinProtection: true, pinCached: true, deviceId: 'fixture-only', label: 'Fixture' }
  const operations: string[] = []
  const transport = Object.assign(new EventEmitter(), {
    call: async () => { throw new Error('Unexpected second device request') },
    lockDuring: async (fn: () => Promise<unknown>) => fn(),
    write: async () => {},
  })
  const wallet = {
    transport,
    applySettings: async () => {
      operations.push('settings')
      transport.emit(String(Messages.MessageType.MESSAGETYPE_PINMATRIXREQUEST), { message: { type: 1 } })
      await pin.promise
      operations.push('settings-complete')
    },
    sendPin: async () => { operations.push('pin'); pin.resolve() },
    getFeatures: async () => { operations.push('features'); return features },
  }
  internal.wallet = wallet
  internal.activeTransport = 'emulator'
  internal.cachedFeatures = features
  internal.lastState = 'ready'
  internal.attachTransportListeners()
  // An auto-prompt here would queue GetPublicKey under ApplySettings and race
  // the caller's reconnect. Record it without permitting actual device I/O.
  engine.promptPin = async () => { operations.push('auto-unlock'); return { status: 'unlocked', message: '' } }
  return { engine, internal, pin, wallet, operations }
}

describe('settings PIN ownership', () => {
  test('label PIN belongs to ApplySettings until its final reply; reconnect has no queued unlock', async () => {
    const { engine, internal, operations } = fixture()
    const prompts: unknown[] = []
    engine.on('pin-request', event => prompts.push(event))
    const settings = engine.applySettings({ label: 'Renamed', skipRefresh: true })
    await Bun.sleep(5) // allow a wrongly scheduled auto-prompt to run
    expect(prompts).toEqual([{ type: 'current' }])
    expect(internal.setupInProgress).toBe(true)
    expect(operations).toEqual(['settings'])
    await engine.sendPin('fixture-pin')
    await settings
    operations.push('reconnect')
    await Bun.sleep(5)
    expect(operations).toEqual(['settings', 'pin', 'settings-complete', 'reconnect'])
    expect(internal.setupInProgress).toBe(false)
  })

  test('failed settings release ownership without issuing a feature request or auto-unlock', async () => {
    const { engine, internal, pin, operations } = fixture()
    const settings = engine.applySettings({ label: 'Renamed', skipRefresh: true })
    settings.catch(() => {})
    pin.reject(new Error('PIN cancelled'))
    await expect(settings).rejects.toThrow('PIN cancelled')
    await Bun.sleep(5)
    expect(internal.setupInProgress).toBe(false)
    expect(operations).toEqual(['settings'])
  })

  test('a wallet swap cannot refresh or overwrite the replacement connection', async () => {
    const { engine, internal, pin, operations } = fixture()
    const settings = engine.applySettings({ label: 'Renamed' })
    const replacement = { getFeatures: () => { throw new Error('Replacement wallet was used') } }
    internal.wallet = replacement
    internal.setupInProgress = false // disconnect clears ownership
    pin.resolve()
    await expect(settings).rejects.toThrow('Device changed while applying settings')
    expect(internal.wallet).toBe(replacement)
    expect(operations).toEqual(['settings', 'settings-complete'])
    expect(internal.setupInProgress).toBe(false)
  })

  test('enabling passphrase starts its legitimate unlock only after settings and feature refresh finish', async () => {
    const { engine, internal, pin, wallet, operations } = fixture()
    internal.activeTransport = 'hid'
    Object.assign(wallet, {
      initialize: async () => { operations.push('initialize') },
      getFeatures: async () => {
        operations.push('features')
        return { initialized: true, majorVersion: 7, minorVersion: 17, patchVersion: 0,
          pinProtection: true, pinCached: true, passphraseProtection: true, passphraseCached: false }
      },
    })
    engine.promptPin = async () => {
      expect(internal.setupInProgress).toBe(false)
      operations.push('passphrase-unlock')
      return { status: 'unlocked', message: '' }
    }
    const settings = engine.applySettings({ usePassphrase: true })
    pin.resolve()
    await settings
    await Bun.sleep(5)
    expect(operations).toEqual(['settings', 'settings-complete', 'initialize', 'features', 'passphrase-unlock'])
    expect(engine.getDeviceState().state).toBe('needs_passphrase')
  })
})
