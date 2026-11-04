/**
 * Desktop's Solana signing path against a firmware 7.17 kkemu over UDP:
 * signSolanaWireTransaction -> hdwallet solanaSignTx -> SolanaSignTx.
 *
 * A real mainnet Jupiter v0 swap (fee payer swapped for the emulator's key so
 * it is a signer). On 7.17 Desktop sends the 41 lookup-table accounts it
 * resolved; the device accepts them only if they match the signed lookup
 * indexes, then shows the decoded instructions before the blind-sign screen.
 * The control passes firmware 7.16.0 to the same code: no accounts are sent
 * and the device shows fewer screens.
 *
 * Runs ONLY against a UDP emulator, never USB:
 *   KK_FORCE_UDP=1 KK_EMU_UDP_PORT=<main port> bun test tests/emulator/10-solana-host-lut.test.ts
 * (make test-emu-solana-lut KK_EMU_UDP_PORT=<port>). The emulator must be
 * fresh: the test loads a seed and turns on AdvancedMode.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPublicKey, verify } from 'crypto'
import dgram from 'dgram'
import bs58 from 'bs58'
import * as core from '@keepkey/hdwallet-core'
import { Transport, type TransportDelegate } from '@keepkey/hdwallet-keepkey'
import fixture from '../../__tests__/fixtures/solana/jupiter-v0-lookup-tables.json'
import { signSolanaWireTransaction } from '../../src/bun/solana-signing'
import type { AltAccountFetcher } from '../../src/bun/solana-alt'

const PORT = Number(process.env.KK_EMU_UDP_PORT || 0)
const ENABLED = process.env.KK_FORCE_UDP === '1' && PORT > 0
const PATH = [0x8000002c, 0x800001f5, 0x80000000, 0x80000000]
const MNEMONIC = 'all all all all all all all all all all all all'

class UdpDelegate implements TransportDelegate {
  private sockets: dgram.Socket[] = []
  private queues: Uint8Array[][] = [[], []]
  private waiters: Array<Array<(b: Uint8Array) => void>> = [[], []]

  constructor(private port: number) {
    for (const iface of [0, 1]) {
      const s = dgram.createSocket('udp4')
      s.on('message', (msg) => {
        const w = this.waiters[iface].shift()
        if (w) w(new Uint8Array(msg))
        else this.queues[iface].push(new Uint8Array(msg))
      })
      s.bind(0, '127.0.0.1')
      this.sockets.push(s)
    }
  }
  async isOpened() { return true }
  async getDeviceID() { return `udp-${this.port}` }
  async connect() {}
  async tryConnectDebugLink() { return true }
  async disconnect() { for (const s of this.sockets) s.close() }
  async writeChunk(buf: Uint8Array, debugLink?: boolean) {
    const iface = debugLink ? 1 : 0
    await new Promise<void>((res, rej) =>
      this.sockets[iface].send(buf, this.port + iface, '127.0.0.1', (e) => (e ? rej(e) : res())))
  }
  async readChunk(debugLink?: boolean): Promise<Uint8Array> {
    const iface = debugLink ? 1 : 0
    const q = this.queues[iface].shift()
    if (q) return q
    return await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`UDP read timeout (iface ${iface})`)), 60_000)
      this.waiters[iface].push((b) => { clearTimeout(t); res(b) })
    })
  }
}

const realFetcher: AltAccountFetcher = async (keys) => keys.map((k) => {
  const t = fixture.tables.find((x) => x.key === k)
  return t ? { owner: t.owner, data: Buffer.from(t.dataBase64, 'base64') } : null
})

describe.skipIf(!ENABLED)('7.17 kkemu over UDP: Desktop sends Solana lookup accounts', () => {
  let delegate: UdpDelegate
  let wallet: any
  let firmwareVersion: string
  let payer: string
  let buttons = 0

  beforeAll(async () => {
    delegate = new UdpDelegate(PORT)
    const keyring = new core.Keyring()
    const transport = await Transport.create(keyring, delegate)
    await transport.connect()
    await transport.tryConnectDebugLink()
    const keepkey = await import('@keepkey/hdwallet-keepkey')
    wallet = keepkey.create(transport)
    transport.on(core.Events.BUTTON_REQUEST, () => { buttons++; void wallet.pressYes() })
    const features = await wallet.initialize()
    expect(features.initialized).toBe(false) // fresh emulator only
    firmwareVersion = (await wallet.getFirmwareVersion()).replace(/^v/, '')
    await wallet.loadDevice({ mnemonic: MNEMONIC, pin: false, passphrase: false, skipChecksum: false })
    await wallet.applyPolicy({ policyName: 'AdvancedMode', enabled: true })
    payer = await wallet.solanaGetAddress({ addressNList: PATH, showDisplay: false })
  }, 120_000)

  afterAll(async () => { await delegate?.disconnect() })

  async function signJupiter(version: string) {
    const message = Buffer.from(fixture.messageHex, 'hex')
    Buffer.from(bs58.decode(payer)).copy(message, 5) // v0 prefix, header, key count
    const rawTx = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64')
    let sentAccounts: Uint8Array[] | undefined
    buttons = 0
    const result = await signSolanaWireTransaction(
      { addressNList: PATH, rawTx },
      (params) => { sentAccounts = params.lutAccounts; return wallet.solanaSignTx(params) },
      async (path) => wallet.solanaGetAddress({ addressNList: path, showDisplay: false }),
      'emu:solanaSignTx',
      () => version,
      realFetcher,
    )
    const pub = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(bs58.decode(payer)).toString('base64url') },
      format: 'jwk',
    })
    return {
      buttons,
      sentAccounts,
      validSignature: verify(null, message, pub, Buffer.from(result.signature)),
    }
  }

  test('the emulator is 7.17 or later', () => {
    expect(firmwareVersion.split('.').map(Number)).toEqual(expect.arrayContaining([7]))
    expect(Number(firmwareVersion.split('.')[1])).toBeGreaterThanOrEqual(17)
  })

  test('7.17: device accepts Desktop\'s 41 accounts, shows the decoded review, signs', async () => {
    const withKeys = await signJupiter(firmwareVersion)
    const without = await signJupiter('7.16.0')
    console.log(`[emu] Jupiter v0 swap: ${withKeys.buttons} screens with lookup accounts, ${without.buttons} without`)
    expect(withKeys.sentAccounts?.map((k) => Buffer.from(k).toString('hex'))).toEqual(fixture.loadedHex)
    expect(withKeys.validSignature).toBe(true)
    expect(without.sentAccounts).toBeUndefined()
    expect(without.validSignature).toBe(true)
    // "Lookup Accounts ... NOT verified by KeepKey" plus the decoded
    // instructions come before the blind-sign screens.
    expect(withKeys.buttons).toBeGreaterThan(without.buttons + 1)
  }, 180_000)
})
