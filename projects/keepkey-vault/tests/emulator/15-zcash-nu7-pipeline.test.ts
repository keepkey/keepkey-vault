/** NU7 transparent sends through Desktop's actual pipeline on released
 * firmware 7.16.0 (physical route) or the reviewed 7.17 alpha emulator (alpha
 * route): buildUtxoTx (synthetic UTXOs of the public all×12 wallet)
 * → signZcashTransparentTx → hdwallet zcashSignPczt →
 * the real zcash-cli sidecar in transparent-only mode, which reads the live
 * mainnet lightwalletd tip and branch (GetLightdInfo only) and finalizes.
 * Fresh RAM flash, no app engine, profile or broadcast. Each finished
 * transaction is checked by an independent Python parser/verifier and by the
 * zcash_primitives 0.31 reference crate.
 *
 * KK_EMU_DYLIB is identified by its bytes: keepkey-firmware CI run 38849341361's
 * libkkemu for tag v7.16.0 (4f94a63b, artifact 12024737133), or a library in
 * emulator-bundle/manifest.json. Run: make test-emu-zcash-nu7-pipeline */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { HDKey } from '@scure/bip32'
import { bech32m } from '@scure/base'
// @ts-ignore CJS
import bs58check from 'bs58check'
import emulatorManifest from '../../emulator-bundle/manifest.json'
import { EmuHarness } from './harness'
import { CHAINS } from '../../src/shared/chains'
import { buildUtxoTx } from '../../src/bun/txbuilder/utxo'
import { signZcashTransparentTx } from '../../src/bun/txbuilder/zcash-transparent'
import { decodeTexAddress } from '../../src/bun/txbuilder/zcash-tex'
import { sendCommand, stopSidecar } from '../../src/bun/zcash-sidecar'

const Ec = require('elliptic').ec
const ec = new Ec('secp256k1')
const RELEASE_716_LIBKKEMU = '80da93845d8c767a2b7f512482348a3b222323d475e7d2d119d385ee46fabdac'
const ALL12 = 'all all all all all all all all all all all all'
// Firmware audit 2026-11-10 (reference-vectors.json): all×12 at m/44'/133'/0'/0/0.
const AUDIT_PUBKEY_0_0 = '022f5c53b6d2e1b64c37d85716dbef318bd398ad7d2a03d94960af060402380658'
const H = 0x80000000
const RELEASES: Record<string, { version: string; route: 'physical' | 'alpha-emulator' }> = {
  [RELEASE_716_LIBKKEMU]: { version: '7.16.0', route: 'physical' },
  ...Object.fromEntries(Object.values(emulatorManifest.files).map(file => [file.sha256, { version: emulatorManifest.version, route: 'alpha-emulator' as const }])),
}
const path = process.env.KK_EMU_DYLIB
if (!path) throw new Error('Set KK_EMU_DYLIB to the v7.16.0 CI emulator or the reviewed alpha emulator; no installed-wallet default is used')
const librarySha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
const release = RELEASES[librarySha256]
if (!release) throw new Error(`Not a qualified emulator library: ${librarySha256}`)
const on716 = release.version === '7.16.0'
const evidenceDir = process.env.NU7_EVIDENCE_DIR || mkdtempSync(join(tmpdir(), 'nu7-716-evidence-'))
mkdirSync(join(evidenceDir, 'screens'), { recursive: true })
// The sidecar inherits this; transparent-only mode opens no profile anyway.
const realHome = process.env.HOME
process.env.HOME = mkdtempSync(join(tmpdir(), 'nu7-716-home-'))

let h: EmuHarness
let lib: ReturnType<typeof dlopen>
let account: HDKey
let accountXpub: string
let pump: ReturnType<typeof setInterval>
let latestFrame: Uint8Array | null = null
let confirmations = 0
let caseName = 'setup'
const screens: Array<{ case: string; index: number; file: string }> = []
const evidence: any[] = []
const summary: any = { library: { path, sha256: librarySha256, ...release }, cases: [] as any[] }

function crc32(data: Uint8Array): number {
  let crc = ~0
  for (const byte of data) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return ~crc >>> 0
}
function png(frame: Uint8Array): Buffer {
  const W = 512, Hh = 128
  const rows: Buffer[] = []
  for (let y = 0; y < Hh; y++) {
    const row = Buffer.alloc(1 + W)
    for (let x = 0; x < W; x++) row[1 + x] = (frame[(x >> 1) + ((y >> 1) >> 3) * 256] >> ((y >> 1) & 7)) & 1 ? 255 : 0
    rows.push(row)
  }
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0); typed.copy(out, 4); out.writeUInt32BE(crc32(typed), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(Hh, 4); ihdr[8] = 8
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

beforeAll(async () => {
  h = new EmuHarness()
  await h.boot(); await h.connect(); h.pausePoll()
  lib = dlopen(path, {
    kkemu_start: { args: [], returns: FFIType.i32 },
    kkemu_pop_frame: { args: [FFIType.ptr], returns: FFIType.i32 },
  })
  const frame = new Uint8Array(2048)
  pump = setInterval(() => { while (lib.symbols.kkemu_pop_frame(ptr(frame)) === 1) latestFrame = frame.slice() }, 4)
  // Only this RAM device receives automatic approvals; the live app engine is never imported.
  const delegate = (h as any).transportDelegate
  const read = delegate.readChunk.bind(delegate)
  delegate.readChunk = async (debug = false) => {
    const packet: Uint8Array = await read(debug)
    if (!debug && packet[0] === 0x3f && packet[1] === 0x23 && packet[2] === 0x23 && ((packet[3] << 8) | packet[4]) === 26) {
      confirmations++
      await new Promise(resolve => setTimeout(resolve, 120)) // let the confirm screen land in the ring
      if (latestFrame) {
        const file = `${caseName}-${String(confirmations).padStart(2, '0')}.png`
        writeFileSync(join(evidenceDir, 'screens', file), png(latestFrame))
        screens.push({ case: caseName, index: confirmations, file })
      }
      const decision = new Uint8Array(64)
      decision.set([0x3f, 0x23, 0x23, 0, 100, 0, 0, 0, 2, 8, 1])
      if (!h.rawWrite(decision, 1)) throw new Error('Synthetic emulator approval could not be queued')
    }
    return packet
  }
  expect(lib.symbols.kkemu_start()).toBe(0)
  const features = await h.getFeatures()
  summary.features = { version: `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`, variant: features.firmwareVariant, revision: features.revision }
  expect(summary.features.version).toBe(release.version)
  await h.wallet!.loadDevice({ mnemonic: ALL12, pin: false, passphrase: false, skipChecksum: false })
  const keys = await h.wallet!.getPublicKeys([{ addressNList: [H + 44, H + 133, H], curve: 'secp256k1', coin: 'Zcash', scriptType: 'p2pkh', showDisplay: false }])
  accountXpub = keys[0].xpub
  account = HDKey.fromExtendedKey(accountXpub)
  expect(Buffer.from(account.deriveChild(0).deriveChild(0).publicKey!).toString('hex')).toBe(AUDIT_PUBKEY_0_0)
}, 30_000)

afterAll(() => {
  clearInterval(pump)
  stopSidecar()
  h?.shutdown(); lib?.close()
  writeFileSync(join(evidenceDir, 'reference-evidence.json'), JSON.stringify(evidence, null, 2))
  writeFileSync(join(evidenceDir, 'summary.json'), JSON.stringify({ ...summary, screens }, null, 2))
  console.log(`NU7_716_EVIDENCE_DIR:${evidenceDir}`)
})

const own = (change: number, index: number) => {
  const publicKey = account.deriveChild(change).deriveChild(index).publicKey!
  const hash = createHash('ripemd160').update(createHash('sha256').update(publicKey).digest()).digest()
  return { publicKey, script: `76a914${hash.toString('hex')}88ac`, path: `m/44'/133'/0'/${change}/${index}` }
}
const zcash = CHAINS.find(chain => chain.id === 'zcash')!
type Utxo = { txid: string; vout: number; value: number; change: number; index: number }

async function send(name: string, utxos: Utxo[], to: string, amount: string, usedChange: number) {
  caseName = name
  const before = confirmations
  const pioneer = {
    ListUnspent: async () => ({ data: utxos.map(u => ({ txid: u.txid, vout: u.vout, value: String(u.value), confirmations: 12, path: own(u.change, u.index).path, scriptPubKey: own(u.change, u.index).script })) }),
    GetFeeRateByNetwork: async () => ({ data: { slow: 1, average: 1, fast: 1 } }),
    GetPubkeyInfo: async () => ({ data: { tokens: [{ path: `m/44'/133'/0'/1/${usedChange}`, name: 'used-change', transfers: 1 }] } }),
  }
  const plan: any = await buildUtxoTx(pioneer as any, zcash, { to, amount, xpub: accountXpub })
  expect(plan).not.toHaveProperty('branchId')
  const sidecar: Record<string, any> = {}
  const deviceRequests: any[] = []
  const wallet = Object.create(h.wallet!)
  wallet.zcashSignPczt = (request: any, sighash: string) => { deviceRequests.push(structuredClone(request)); return h.wallet!.zcashSignPczt(request, sighash) }
  const signed = await signZcashTransparentTx(wallet, plan, {
    // The admission matrix is unit-tested; this run takes the library's route.
    authorizeWallet: () => ({ route: release.route }),
    command: async (command, params) => (sidecar[command] = await sendCommand(command, params)),
  })
  const build = sidecar.build_transparent_pczt, finalized = sidecar.finalize_transparent
  expect(deviceRequests).toHaveLength(1)
  expect(deviceRequests[0].branch_id).toBe(0x77190ad9)
  expect(build.branch_id).toBe(0x77190ad9)
  expect(build.target_height).toBeGreaterThanOrEqual(3_543_405)

  const verify = Bun.spawnSync(['python3', '-I', new URL('./nu7-verify-tx.py', import.meta.url).pathname], {
    stdin: new TextEncoder().encode(JSON.stringify({
      raw_tx: signed.serializedTx, txid: finalized.txid, branch_id: 0x77190ad9,
      prevouts: plan.inputs.map((input: any) => ({ value: Number(input.amount), script_pubkey: input.scriptPubkey })),
    })), stdout: 'pipe', stderr: 'pipe',
  })
  if (verify.exitCode) throw new Error(verify.stderr.toString())
  const independent = JSON.parse(verify.stdout.toString())
  expect(independent.header).toEqual({ version: 0x80000006, version_group_id: 0xd884b698, branch_id: 0x77190ad9, lock_time: 0, expiry_height: 0 })
  expect(independent.trailing).toBe('00000000')
  expect(independent.txid_matches_sidecar).toBe(true)
  expect(independent.outputs.map((o: any) => o.value)).toEqual(plan.outputs.map((o: any) => Number(o.amount)))
  independent.inputs.forEach((input: any, i: number) => {
    expect([input.signature_valid, input.key_matches_script, input.sighash_type]).toEqual([true, true, 1])
    expect(input.signature).toBe(signed.signatures[i])
    // Third implementation (elliptic) against the device-derived key.
    const key = own(plan.inputs[i].addressNList[3], plan.inputs[i].addressNList[4]).publicKey
    expect(ec.verify(Buffer.from(input.sighash, 'hex'), Buffer.from(signed.signatures[i], 'hex'), key)).toBe(true)
    const changed = Buffer.from(input.sighash, 'hex'); changed[0] ^= 1
    expect(ec.verify(changed, Buffer.from(signed.signatures[i], 'hex'), key)).toBe(false)
  })
  evidence.push({
    branch_id: 0x77190ad9, tx_version: 6, version_group_id: 0xd884b698, lock_time: 0, expiry_height: 0,
    raw_tx: signed.serializedTx, txid: finalized.txid,
    inputs: independent.inputs.map((i: any) => ({ prevout_hash: i.prevout_hash, prevout_index: i.prevout_index, value: i.value, sequence: i.sequence, script_pubkey: i.script_pubkey, sighash: i.sighash })),
    outputs: independent.outputs,
  })
  const record = {
    case: name, inclusion_height: build.target_height, branch_id: `0x${build.branch_id.toString(16)}`,
    txid_display: independent.txid_display, confirmations: confirmations - before,
    inputs: plan.inputs.map((i: any) => i.addressNList.slice(3).join('/')), outputs: plan.outputs.map((o: any) => o.address || `change ${o.addressNList.slice(3).join('/')}`),
    amounts: plan.outputs.map((o: any) => o.amount), fee_zat: plan.inputs.reduce((s: number, i: any) => s + Number(i.amount), 0) - plan.outputs.reduce((s: number, o: any) => s + Number(o.amount), 0),
  }
  summary.cases.push(record)
  writeFileSync(join(evidenceDir, `${name}.json`), JSON.stringify({ record, plan, build, deviceRequest: deviceRequests[0], signed, finalized, independent }, null, 2))
  return { plan, signed, finalized, independent, deviceRequest: deviceRequests[0], record }
}

const t1 = bs58check.encode(Buffer.from(`1cb8${'33'.repeat(20)}`, 'hex'))
const t3 = bs58check.encode(Buffer.from(`1cbd${'44'.repeat(20)}`, 'hex'))
const tex = bech32m.encode('tex', bech32m.toWords(new Uint8Array(20).fill(0x55)))
let first: Awaited<ReturnType<typeof send>>

test(`${release.version} signs a two-input NU7 payment (receive and one-time scopes) to a t1 address with change`, async () => {
  first = await send('t1-two-inputs', [
    { txid: '01'.repeat(32), vout: 0, value: 300_000, change: 0, index: 0 },
    { txid: '02'.repeat(32), vout: 1, value: 200_000, change: 2, index: 0 },
  ], t1, '0.0045', 0)
  expect(first.signed.signatures).toHaveLength(2)
  expect(first.record.inputs.sort()).toEqual(['0/0', '2/0'])
  // 7.16 screens: summary (2 pages: fee and inputs, outputs), each output
  // (recipient, then the own change address shown as a plain t1 output),
  // the fee, then one "Sign transparent input?" per input.
  if (on716) expect(first.record.confirmations).toBe(2 + 2 + 1 + 2)
}, 60_000)

test(`${release.version} spends that change output (change scope) to a TEX address`, async () => {
  expect(decodeTexAddress(tex)).toEqual(new Uint8Array(20).fill(0x55))
  const changeIndex = first.plan.outputs.findIndex((o: any) => o.isChange)
  const change = first.plan.outputs[changeIndex]
  const result = await send('tex-from-change', [
    { txid: first.independent.txid_display, vout: changeIndex, value: Number(change.amount), change: 1, index: change.addressNList[4] },
  ], tex, '0.0003', change.addressNList[4])
  expect(result.deviceRequest.transparent_outputs.find((o: any) => o.is_tex)).toBeTruthy()
  expect(result.independent.inputs[0].prevout_hash).toBe(first.finalized.txid)
  // A TEX recipient takes two pages (address, then amount); no change here.
  if (on716) expect(result.record.confirmations).toBe(2 + 2 + 1 + 1)
}, 60_000)

test(`${release.version} signs an NU7 payment to a t3 (P2SH) address`, async () => {
  const result = await send('t3-p2sh', [{ txid: '03'.repeat(32), vout: 2, value: 100_000, change: 0, index: 1 }], t3, '0.0005', 2)
  expect(result.independent.outputs[0].script_pubkey).toBe(`a914${'44'.repeat(20)}87`)
  if (on716) expect(result.record.confirmations).toBe(2 + 2 + 1 + 1)
}, 60_000)

test('a request whose branch disagrees with its header digest gets no approval prompt and no signature', async () => {
  caseName = 'tampered-branch'
  const request = structuredClone(first.deviceRequest)
  request.branch_id = 0x37a5165b
  const before = confirmations
  let rejected: any
  try { await h.wallet!.zcashSignPczt(request, '') } catch (error) { rejected = error }
  expect(rejected?.message).toMatchObject({ code: 9, message: 'Header digest mismatch' })
  expect(confirmations).toBe(before)
}, 30_000)

test('the zcash_primitives 0.31 reference reads every finished transaction as canonical NU7 with the same sighashes', () => {
  const file = join(evidenceDir, 'reference-evidence.json')
  writeFileSync(file, JSON.stringify(evidence, null, 2))
  const run = Bun.spawnSync(['cargo', 'test', '--locked', '--manifest-path', new URL('../../zcash-cli/tests/nu7-reference/Cargo.toml', import.meta.url).pathname,
    '--', '--ignored', 'external_evidence', '--nocapture'], { env: { ...process.env, HOME: realHome, KEEPKEY_NU7_EVIDENCE: file }, stdout: 'pipe', stderr: 'pipe' })
  const output = run.stdout.toString() + run.stderr.toString()
  writeFileSync(join(evidenceDir, 'reference-crate.log'), output)
  expect(run.exitCode).toBe(0)
  expect(output).toContain(`NU7_EVIDENCE_VERIFIED:${evidence.length} transactions`)
  expect(evidence).toHaveLength(3)
}, 240_000)
