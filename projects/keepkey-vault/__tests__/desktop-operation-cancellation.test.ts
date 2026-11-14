/** Real EngineController + hdwallet signer/transport; scripted memory-only wire.
 * Run in isolation because native device adapters are mocked before import. */
import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as core from '@keepkey/hdwallet-core'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import * as Ethereum from '@keepkey/device-protocol/lib/messages-ethereum_pb'
import { Transport, create, type TransportDelegate } from '@keepkey/hdwallet-keepkey'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: { useKeyring: () => ({}) } }))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({ NodeWebUSBKeepKeyAdapter: { useKeyring: () => ({}) } }))
mock.module('usb', () => ({ usb: new EventEmitter() }))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: '/tmp/kk-desktop-cancellation-unused' } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: '/tmp/kk-desktop-cancellation-unused' } }))
const { EngineController } = await import('../src/bun/engine-controller')
const { restRequest } = await import('../src/bun/device-gate')

const T = Messages.MessageType
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const sleep = (ms = 2) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  const end = Date.now() + 2000
  while (!check() && Date.now() < end) await sleep()
  expect(check()).toBe(true)
}
const signParams = { addressNList: [0x8000002c, 0x8000003c, 0x80000000, 0, 0], message: '0x6869' }
const desktopOptions = { origin: 'desktop' as const, unlock: true, rejectIfBusy: true }

class MemoryKeepKey implements TransportDelegate {
  readonly received: number[] = []
  private replies: Uint8Array[] = []
  private open = true
  holdSign = false
  constructor(readonly deviceId = 'synthetic-a') {}
  async isOpened() { return this.open }
  async getDeviceID() { return this.deviceId }
  async connect() {}
  async tryConnectDebugLink() { return false }
  async disconnect() { this.open = false }
  reply(type: number, message: { serializeBinary(): Uint8Array }) {
    const payload = message.serializeBinary()
    const frame = new Uint8Array(8 + payload.length)
    frame.set([0x23, 0x23, type >> 8, type & 255])
    new DataView(frame.buffer).setUint32(4, payload.length)
    frame.set(payload, 8)
    for (let offset = 0; offset < frame.length; offset += 63) {
      const packet = new Uint8Array(64)
      packet[0] = 0x3f
      packet.set(frame.slice(offset, offset + 63), 1)
      this.replies.push(packet)
    }
  }
  requestButton() { this.reply(T.MESSAGETYPE_BUTTONREQUEST, new Messages.ButtonRequest()) }
  finishSign() {
    const signature = new Ethereum.EthereumMessageSignature()
    signature.setAddress(new Uint8Array(20).fill(0x11))
    signature.setSignature(new Uint8Array(65).fill(0x22))
    this.reply(T.MESSAGETYPE_ETHEREUMMESSAGESIGNATURE, signature)
  }
  async writeChunk(packet: Uint8Array) {
    const type = (packet[3] << 8) | packet[4]
    this.received.push(type)
    if (type === T.MESSAGETYPE_GETFEATURES) {
      const features = new Messages.Features()
      features.setMajorVersion(7); features.setMinorVersion(17); features.setPatchVersion(0)
      features.setInitialized(true); features.setDeviceId(this.deviceId)
      this.reply(T.MESSAGETYPE_FEATURES, features)
    } else if (type === T.MESSAGETYPE_ETHEREUMSIGNMESSAGE && !this.holdSign) this.finishSign()
    // ButtonAck is deliberately held until finishSign(), like a physical button.
  }
  async readChunk() {
    while (this.open) {
      const next = this.replies.shift()
      if (next) return next
      await sleep()
    }
    throw new Error('Synthetic transport closed')
  }
}

async function fixture() {
  const device = new MemoryKeepKey()
  const transport = await Transport.create(new core.Keyring(), device)
  const wallet = create(transport)
  const engine = new EngineController()
  Object.assign(engine, { wallet, activeTransport: 'webusb', lastState: 'ready', seedEthAddress: 'seed-a',
    cachedFeatures: { initialized: true, deviceId: device.deviceId, majorVersion: 7, minorVersion: 17, patchVersion: 0 } })
  ;(engine as any).attachTransportListeners()
  return { engine, device, transport, wallet }
}

describe('Desktop cancellation fences future device dispatch', () => {
  test('Cancel during asynchronous preflight prevents the real hdwallet sign write', async () => {
    const { engine, wallet, device } = await fixture()
    const entered = deferred(), preflight = deferred()
    const work = engine.withDeviceOperation(async () => {
      entered.resolve(); await preflight.promise
      return wallet.ethSignMessage(signParams)
    }, desktopOptions)
    const outcome = work.then(value => value, error => error)
    await entered.promise
    expect(engine.cancelDesktopDeviceOperation()).toBe(true)
    preflight.resolve()
    const result = await outcome
    expect(device.received).toEqual([T.MESSAGETYPE_GETFEATURES])
    expect(result).toMatchObject({ status: 499 })
  })

  test('an earlier admitted read does not authorize a sign started after Cancel', async () => {
    const { engine, wallet, device } = await fixture()
    const entered = deferred(), preflight = deferred()
    const work = engine.withDeviceOperation(async () => {
      await wallet.getFeatures()
      entered.resolve(); await preflight.promise
      return wallet.ethSignMessage(signParams)
    }, desktopOptions)
    const outcome = work.then(value => value, error => error)
    await entered.promise
    expect(engine.cancelDesktopDeviceOperation()).toBe(true)
    preflight.resolve()
    const result = await outcome
    expect(device.received).toEqual([T.MESSAGETYPE_GETFEATURES, T.MESSAGETYPE_GETFEATURES])
    expect(result).toMatchObject({ status: 499 })
  })

  test('a later lockDuring block gets a fresh admission check', async () => {
    const { engine, transport, device } = await fixture()
    const entered = deferred(), preflight = deferred()
    const work = engine.withDeviceOperation(async () => {
      await transport.lockDuring(() => transport.call(T.MESSAGETYPE_GETFEATURES, new Messages.GetFeatures(), { omitLock: true }))
      entered.resolve(); await preflight.promise
      return transport.lockDuring(() => transport.call(T.MESSAGETYPE_ETHEREUMSIGNMESSAGE, new Ethereum.EthereumSignMessage(), { omitLock: true }))
    }, desktopOptions)
    const outcome = work.then(value => value, error => error)
    await entered.promise
    expect(engine.cancelDesktopDeviceOperation()).toBe(true)
    preflight.resolve()
    const result = await outcome
    expect(device.received).toEqual([T.MESSAGETYPE_GETFEATURES, T.MESSAGETYPE_GETFEATURES])
    expect(result).toMatchObject({ status: 499 })
  })

  test('an admitted signing exchange drains its automatic ack before a separate REST owner enters', async () => {
    const { engine, wallet, device } = await fixture()
    device.holdSign = true
    const work = engine.withDeviceOperation(() => wallet.ethSignMessage(signParams), desktopOptions)
    await until(() => device.received.includes(T.MESSAGETYPE_ETHEREUMSIGNMESSAGE))
    // The first write is already on the wire; the button request has not arrived.
    expect(engine.cancelDesktopDeviceOperation()).toBe(true)
    let restEntered = false
    const rest = restRequest.run({ whileLocked: false }, async () => {
      const release = await engine.acquireDeviceOperation()
      try { restEntered = true; await wallet.getFeatures() } finally { release() }
    })
    device.requestButton()
    await until(() => device.received.includes(T.MESSAGETYPE_BUTTONACK))
    expect(restEntered).toBe(false)
    await expect(engine.withDeviceOperation(async () => {}, desktopOptions)).rejects.toMatchObject({ status: 409 })
    device.finishSign()
    expect((await work).signature).toBe('0x' + '22'.repeat(65))
    await rest
    expect(restEntered).toBe(true)
    expect(device.received.filter(type => type === T.MESSAGETYPE_CANCEL)).toHaveLength(0)
  })

  test('a protocol reply cannot admit a cancelled action into a new raw signing flow', async () => {
    const { engine, transport, device } = await fixture()
    const entered = deferred(), preflight = deferred()
    const work = engine.withDeviceOperation(async () => {
      entered.resolve(); await preflight.promise
      await transport.call(T.MESSAGETYPE_BUTTONACK, new Messages.ButtonAck(), { omitLock: true, noWait: true })
      return transport.call(T.MESSAGETYPE_ETHEREUMSIGNMESSAGE, new Ethereum.EthereumSignMessage(), { omitLock: true })
    }, desktopOptions)
    const outcome = work.then(value => value, error => error)
    await entered.promise
    engine.cancelDesktopDeviceOperation(); preflight.resolve()
    const result = await outcome
    expect(device.received).toEqual([T.MESSAGETYPE_GETFEATURES, T.MESSAGETYPE_BUTTONACK])
    expect(result).toMatchObject({ status: 499 })
  })

  test.each(['wallet', 'deviceId', 'seed'] as const)('a retired %s cannot start signing after asynchronous preparation', async retired => {
    const { engine, device } = await fixture()
    const entered = deferred(), preflight = deferred()
    const work = engine.withDeviceOperation(async () => {
      entered.resolve(); await preflight.promise
      return engine.wallet!.ethSignMessage(signParams)
    }, desktopOptions)
    const outcome = work.then(value => value, error => error)
    await entered.promise
    let replacement: MemoryKeepKey | undefined
    if (retired === 'wallet') {
      replacement = new MemoryKeepKey('synthetic-b')
      const transport = await Transport.create(new core.Keyring(), replacement)
      Object.assign(engine, { wallet: create(transport), cachedFeatures: { deviceId: replacement.deviceId }, seedEthAddress: 'seed-b' })
      ;(engine as any).attachTransportListeners()
    } else if (retired === 'deviceId') (engine as any).cachedFeatures.deviceId = 'synthetic-b'
    else (engine as any).seedEthAddress = 'seed-b'
    preflight.resolve()
    const result = await outcome
    expect(device.received).toEqual([T.MESSAGETYPE_GETFEATURES])
    expect(replacement?.received ?? []).toEqual([])
    expect(result).toMatchObject({ status: 409 })
  })
})
