/**
 * Typed data after ClearSession, through the pinned hdwallet's real
 * KeepKeyHDWallet and Transport against a scripted 7.16.0 device, with the
 * real 4900-byte Safe{Wallet} batch that aborted on the 7.16.0 emulator
 * after REST /system/clear-session ("over the 1024-byte wire limit").
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '@keepkey/hdwallet-core'
import { KeepKeyHDWallet, Transport } from '@keepkey/hdwallet-keepkey'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import * as Ethereum from '@keepkey/device-protocol/lib/messages-ethereum_pb'
import corpus from '../../__tests__/fixtures/safe/pyk-eip712-corpus-safetx.json'
import { signTypedDataWithFeatures } from './typed-data-sign'

const MT = Messages.MessageType
const PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
const doc = corpus.documents.find((d) => d.id === 'safe-SafeTx-multisend-4900')!.typedData
const DATA_LENGTH = (doc.message.data.length - 2) / 2
type Frame = { type: number; body: Uint8Array }

function packets({ type, body }: Frame): Uint8Array[] {
  const first = new Uint8Array(64)
  const view = new DataView(first.buffer)
  first.set([0x3f, 0x23, 0x23])
  view.setUint16(3, type)
  view.setUint32(5, body.length)
  first.set(body.slice(0, 55), 9)
  const out = [first]
  for (let i = 55; i < body.length; i += 63) {
    const next = new Uint8Array(64)
    next[0] = 0x3f
    next.set(body.slice(i, i + 63), 1)
    out.push(next)
  }
  return out
}

/** Firmware 7.16.0 with CAPABILITY_EIP712_CHUNKED_VALUES: asks for SafeTx.data in 1 KB chunks. */
function device716() {
  const frames: Frame[] = []
  const outbox: Uint8Array[] = []
  let pending: number[] = []
  let offset = 0
  const respond = (host: Frame): Frame => {
    if (host.type === MT.MESSAGETYPE_GETFEATURES) {
      const f = new Messages.Features()
      f.setVendor('keepkey.com'); f.setMajorVersion(7); f.setMinorVersion(16); f.setPatchVersion(0)
      f.setCapabilitiesList([Messages.Features.Capability.CAPABILITY_EIP712_CHUNKED_VALUES])
      return { type: MT.MESSAGETYPE_FEATURES, body: f.serializeBinary() }
    }
    if (host.type === MT.MESSAGETYPE_CLEARSESSION) return { type: MT.MESSAGETYPE_SUCCESS, body: new Messages.Success().serializeBinary() }
    if (host.type === MT.MESSAGETYPE_ETHEREUMSIGNTYPEDDATA || offset + 1024 < DATA_LENGTH) {
      if (host.type !== MT.MESSAGETYPE_ETHEREUMSIGNTYPEDDATA) offset += 1024
      const req = new Ethereum.EthereumTypedDataValueRequest()
      req.setMemberPathList([1, 2])
      if (offset) req.setValueOffset(offset)
      return { type: MT.MESSAGETYPE_ETHEREUMTYPEDDATAVALUEREQUEST, body: req.serializeBinary() }
    }
    const sig = new Ethereum.EthereumTypedDataSignature()
    sig.setAddress('0x3f2329C9ADFbcCd9A84f52c906E936A42dA18CB8')
    sig.setSignature(new Uint8Array(65).fill(0x33))
    return { type: MT.MESSAGETYPE_ETHEREUMTYPEDDATASIGNATURE, body: sig.serializeBinary() }
  }
  const transport = new Transport(new core.Keyring(), {
    isOpened: async () => true,
    getDeviceID: async () => 'fake-716',
    connect: async () => undefined,
    disconnect: async () => undefined,
    writeChunk: async (chunk: Uint8Array) => {
      pending.push(...Array.from(chunk.slice(1)))
      const length = new DataView(Uint8Array.from(pending.slice(0, 8)).buffer).getUint32(4)
      if (pending.length < 8 + length) return
      const frame = { type: (pending[2] << 8) | pending[3], body: Uint8Array.from(pending.slice(8, 8 + length)) }
      pending = []
      frames.push(frame)
      outbox.push(...packets(respond(frame)))
    },
    readChunk: async () => {
      const next = outbox.shift()
      if (!next) throw new Error('host read with nothing queued')
      return next
    },
  } as any)
  return { frames, wallet: new KeepKeyHDWallet(transport) }
}

describe('typed data after ClearSession on 7.16 (eth-multisend-4900-corpus leg)', () => {
  test('the pinned hdwallet (keepkey/hdwallet#83) reads Features again itself after ClearSession', async () => {
    const { frames, wallet } = device716()
    await wallet.getFeatures()
    await wallet.clearSession()
    const signed = await wallet.ethSignTypedData({ addressNList: PATH, typedData: doc })
    expect(signed.signature).toBe(`0x${'33'.repeat(65)}`)
    expect(frames.map((f) => f.type).slice(0, 4)).toEqual([
      MT.MESSAGETYPE_GETFEATURES, MT.MESSAGETYPE_CLEARSESSION, MT.MESSAGETYPE_GETFEATURES, MT.MESSAGETYPE_ETHEREUMSIGNTYPEDDATA,
    ])
  })
  test('Desktop reads Features again first, and the batch is sent in 1 KB chunks', async () => {
    const { frames, wallet } = device716()
    await wallet.getFeatures()
    await wallet.clearSession()
    const signed = await signTypedDataWithFeatures(wallet, { addressNList: PATH, typedData: doc })
    expect(signed.signature).toBe(`0x${'33'.repeat(65)}`)
    expect(frames.map((f) => f.type)).toEqual([
      MT.MESSAGETYPE_GETFEATURES, MT.MESSAGETYPE_CLEARSESSION, MT.MESSAGETYPE_GETFEATURES,
      MT.MESSAGETYPE_ETHEREUMSIGNTYPEDDATA, ...Array(Math.ceil(DATA_LENGTH / 1024)).fill(MT.MESSAGETYPE_ETHEREUMTYPEDDATAVALUEACK),
    ])
    expect(Ethereum.EthereumTypedDataValueAck.deserializeBinary(frames[4].body).getValueTotalLength()).toBe(4900)
  })
  test('with Features cached it does not ask again', async () => {
    const { frames, wallet } = device716()
    await wallet.getFeatures()
    await signTypedDataWithFeatures(wallet, { addressNList: PATH, typedData: doc })
    expect(frames.filter((f) => f.type === MT.MESSAGETYPE_GETFEATURES)).toHaveLength(1)
  })
  test('every typed-data signing in Desktop goes through it (REST, WalletConnect, RPC)', () => {
    const direct = readdirSync(__dirname).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && f !== 'typed-data-sign.ts')
      .filter((f) => /wallet!?\.ethSignTypedData\(/.test(readFileSync(join(__dirname, f), 'utf8')))
    expect(direct).toEqual([])
    for (const f of ['rest-api.ts', 'index.ts']) expect(readFileSync(join(__dirname, f), 'utf8')).toContain('signTypedDataWithFeatures(')
  })
})
