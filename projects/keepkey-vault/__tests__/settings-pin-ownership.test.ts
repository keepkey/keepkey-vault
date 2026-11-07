import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'
import { TransportTimeoutError } from '@keepkey/hdwallet-keepkey/dist/transport'
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
    read: async () => new Uint8Array(64),
  })
  const wallet = {
    transport,
    applySettings: async () => {
      operations.push('settings')
      transport.emit(String(Messages.MessageType.MESSAGETYPE_PINMATRIXREQUEST), { message: { type: 1 } })
      ;(transport as any).awaitingInput = 'pin' // what device-gate.ts records when it reads that request
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


describe('PIN setup recovery', () => {
  function pinSetup() {
    const f = fixture()
    f.internal.confirmDeviceSetup = async (operation: () => Promise<unknown>) => operation()
    const change = deferred()
    Object.assign(f.wallet, { changePin: async () => {
      f.operations.push('change-pin')
      f.internal.setPinPromptOpen(true)
      return change.promise
    } })
    return { ...f, change }
  }

  test('a timed-out emulator PIN setup reconnects before offering another attempt', async () => {
    const { engine, internal, operations, change } = pinSetup()
    const replacement = { getFeatures: async () => { operations.push('new-features'); return { pinProtection: true } },
      changePin: async () => { operations.push('new-change-pin') } }
    engine.connectEmulator = async () => {
      expect(internal.setupInProgress).toBe(false)
      expect(internal.pinRequestCount).toBe(0)
      operations.push('reconnect')
      internal.wallet = replacement
      internal.setPinPromptOpen(false)
    }
    const first = engine.changePin()
    first.catch(() => {})
    change.reject(new TransportTimeoutError('device response', 300000))
    await expect(first).rejects.toThrow('PIN setup timed out')
    expect(internal.wallet).toBe(replacement)
    expect(engine.getDeviceState().pinPromptOpen).toBe(false)
    expect(internal.setupInProgress).toBe(false)
    await engine.changePin()
    expect(operations).toEqual(['change-pin', 'reconnect', 'new-change-pin', 'new-features'])
  })

  test('an old setup timeout cannot reconnect a wallet selected in the meantime', async () => {
    const { engine, internal, operations, change } = pinSetup()
    engine.connectEmulator = async () => { operations.push('unexpected-reconnect') }
    const first = engine.changePin()
    first.catch(() => {})
    const replacement = { getFeatures: async () => { operations.push('unexpected-features') } }
    internal.wallet = replacement
    internal.setupInProgress = true // a new operation owns the replacement connection
    internal.pinRequestCount = 2
    change.reject(new TransportTimeoutError('device response', 300000))
    await expect(first).rejects.toThrow()
    expect(internal.wallet).toBe(replacement)
    expect(internal.setupInProgress).toBe(true)
    expect(internal.pinRequestCount).toBe(2)
    expect(operations).toEqual(['change-pin'])
  })

  test('successful setup cannot read features from a replacement wallet', async () => {
    const { engine, internal, operations, change } = pinSetup()
    const first = engine.changePin()
    first.catch(() => {})
    internal.wallet = { getFeatures: async () => { operations.push('unexpected-features') } }
    internal.setupInProgress = true
    change.resolve()
    await expect(first).rejects.toThrow('Device changed while setting PIN')
    expect(internal.setupInProgress).toBe(true)
    expect(operations).toEqual(['change-pin'])
  })

  test('hardware and ordinary PIN cancellation never reconnect the emulator', async () => {
    for (const [transport, error] of [
      ['emulator', new Error('PIN cancelled')],
      ['hid', new TransportTimeoutError('device response', 300000)],
    ] as const) {
      const { engine, internal, operations, change } = pinSetup()
      internal.activeTransport = transport
      engine.connectEmulator = async () => { operations.push('unexpected-reconnect') }
      const first = engine.changePin()
      first.catch(() => {})
      change.reject(error)
      await expect(first).rejects.toThrow(error.message)
      expect(internal.setupInProgress).toBe(false)
      expect(operations).toEqual(['change-pin'])
    }
  })

  test('a failed reconnect gives an actionable emulator error and releases setup ownership', async () => {
    const { engine, internal, change } = pinSetup()
    engine.connectEmulator = async () => { throw new Error('Emulator not running') }
    const first = engine.changePin()
    first.catch(() => {})
    change.reject(new TransportTimeoutError('device response', 300000))
    await expect(first).rejects.toThrow('Stop and start the emulator')
    expect(internal.setupInProgress).toBe(false)
    expect(engine.getDeviceState().pinPromptOpen).toBe(false)
  })
})
