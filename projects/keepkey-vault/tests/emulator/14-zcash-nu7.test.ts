/** Actual bundled alpha firmware, disposable RAM flash, no app/profile/network. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { dlopen, FFIType } from 'bun:ffi'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { HDKey } from '@scure/bip32'
import emulatorManifest from '../../emulator-bundle/manifest.json'
import { EmuHarness, TEST_MNEMONIC } from './harness'

const Ec = require('elliptic').ec
const ec = new Ec('secp256k1')
const H = 0x80000000
const account = [H + 44, H + 133, H]
const path = process.env.KK_EMU_DYLIB
if (!path) throw new Error('Set KK_EMU_DYLIB explicitly to the reviewed alpha emulator; no installed-wallet default is used')
const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
if (!Object.values(emulatorManifest.files).some(file => file.sha256 === hash)) throw new Error('Native Nu7 proof requires the reviewed bundled emulator bytes')

let h: EmuHarness
let thread: ReturnType<typeof dlopen>
let root: HDKey
let confirmations = 0

beforeAll(async () => {
  h = new EmuHarness()
  await h.boot(); await h.connect(); h.pausePoll()
  thread = dlopen(path, {
    kkemu_start: { args: [], returns: FFIType.i32 },
  })
  // The production library owns polling on its thread. Only this test's RAM
  // device receives automatic decisions; it never imports the live app engine.
  const delegate = (h as any).transportDelegate
  const read = delegate.readChunk.bind(delegate)
  delegate.readChunk = async (debug = false) => {
    const packet: Uint8Array = await read(debug)
    if (!debug && packet[0] === 0x3f && packet[1] === 0x23 && packet[2] === 0x23
      && ((packet[3] << 8) | packet[4]) === 26) {
      const decision = new Uint8Array(64)
      decision.set([0x3f, 0x23, 0x23, 0, 100, 0, 0, 0, 2, 8, 1])
      if (!h.rawWrite(decision, 1)) throw new Error('Synthetic emulator approval could not be queued')
      confirmations++
    }
    return packet
  }
  expect(thread.symbols.kkemu_start()).toBe(0)
  const features = await h.getFeatures()
  expect(`${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`).toBe('7.17.0')
  await h.wallet!.loadDevice({ mnemonic: TEST_MNEMONIC, pin: false, passphrase: false, skipChecksum: false })
  const keys = await h.wallet!.getPublicKeys([{ addressNList: account, curve: 'secp256k1', coin: 'Zcash', scriptType: 'p2pkh', showDisplay: false }])
  expect(keys[0]?.xpub).toBeTruthy()
  root = HDKey.fromExtendedKey(keys[0].xpub)
}, 20_000)

afterAll(() => { h?.shutdown(); thread?.close() })

function own(index: number, change: number) {
  const publicKey = root.deriveChild(change).deriveChild(index).publicKey!
  const digest = createHash('ripemd160').update(createHash('sha256').update(publicKey).digest()).digest('hex')
  return { publicKey, script: `76a914${digest}88ac`, path: [...account, change, index] }
}

function request(previousChangeTxid?: string) {
  const keys = previousChangeTxid ? [own(0, 1)] : [own(0, 0), own(0, 1)]
  const inputs = keys.map((key, index) => ({
    index, address_path: key.path, amount: previousChangeTxid || index ? 300_000 : 200_000,
    prevout_txid: previousChangeTxid || Buffer.from(Array.from({ length: 32 }, (_, byte) => byte + index * 32)).toString('hex'),
    prevout_index: previousChangeTxid ? 1 : 0,
    sequence: 0xffffffff, script_pubkey: key.script,
  }))
  const outputs = previousChangeTxid ? [
    { index: 0, value: 200_000, script_pubkey: `76a914${'44'.repeat(20)}88ac` },
    { index: 1, value: 90_000, script_pubkey: own(1, 1).script },
  ] : [
    { index: 0, value: 190_000, script_pubkey: `76a914${'33'.repeat(20)}88ac` },
    { index: 1, value: 300_000, script_pubkey: keys[1].script },
  ]
  const reference = Bun.spawnSync(['python3', new URL('./nu7-digests.py', import.meta.url).pathname], {
    stdin: new TextEncoder().encode(JSON.stringify({ inputs, outputs })), stdout: 'pipe', stderr: 'pipe',
  })
  if (reference.exitCode) throw new Error(reference.stderr.toString())
  const expected = JSON.parse(reference.stdout.toString())
  return { keys, expected, signing: {
    n_actions: 0, pool: 'orchard' as const, account: 0, branch_id: 0x77190ad9,
    header_fields: { tx_version: 6, version_group_id: 0xd884b698, lock_time: 0, expiry_height: 0 },
    bundle_meta: { flags: 0, value_balance: 0, anchor: '00'.repeat(32) },
    digests: expected.digests, actions: [], transparent_inputs: inputs.map(input => ({
      index: input.index, addressNList: input.address_path, amount: input.amount,
      prevoutTxid: input.prevout_txid, prevoutIndex: input.prevout_index,
      sequence: input.sequence, scriptPubkey: input.script_pubkey,
    })),
    transparent_outputs: outputs, display: { amount: previousChangeTxid ? '0.00290000 ZEC' : '0.00490000 ZEC', fee: '0.00010000 ZEC' },
  } }
}

test('reviewed 7.17 alpha firmware signs every Nu7 transparent input with independently verified hashes', async () => {
  const fixture = request()
  const before = confirmations
  const result = await h.wallet!.zcashSignPczt(fixture.signing, '')
  const signatures: string[] = (result as any)._transparentSignatures
  expect(result).toHaveLength(0)
  expect(signatures).toHaveLength(2)
  for (let index = 0; index < signatures.length; index++) {
    expect(ec.verify(Buffer.from(fixture.expected.input_sighashes[index], 'hex'), Buffer.from(signatures[index], 'hex'), fixture.keys[index].publicKey)).toBe(true)
    const changed = Buffer.from(fixture.expected.input_sighashes[index], 'hex'); changed[0] ^= 1
    expect(ec.verify(changed, Buffer.from(signatures[index], 'hex'), fixture.keys[index].publicKey)).toBe(false)
  }
  expect(confirmations - before).toBeGreaterThanOrEqual(2)
}, 20_000)

test('Nu7 alpha signing can spend the prior change output at its actual change path', async () => {
  const previous = request()
  const fixture = request(previous.expected.txid_internal)
  const result = await h.wallet!.zcashSignPczt(fixture.signing, '')
  const signatures: string[] = (result as any)._transparentSignatures
  expect(signatures).toHaveLength(1)
  expect(ec.verify(Buffer.from(fixture.expected.input_sighashes[0], 'hex'), Buffer.from(signatures[0], 'hex'), fixture.keys[0].publicKey)).toBe(true)
  expect(fixture.signing.transparent_inputs[0].addressNList[3]).toBe(1)
}, 20_000)

test('a conflicting header is rejected before an approval or a signature', async () => {
  const fixture = request()
  fixture.signing.header_fields.expiry_height = 1
  const before = confirmations
  let rejected: any
  try { await h.wallet!.zcashSignPczt(fixture.signing, '') } catch (error) { rejected = error }
  expect(rejected?.message).toMatchObject({ code: 9, message: 'Header digest mismatch' })
  expect(confirmations).toBe(before)
}, 20_000)
