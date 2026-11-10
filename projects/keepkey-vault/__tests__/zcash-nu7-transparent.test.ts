import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { HDKey } from '@scure/bip32'
// @ts-ignore CJS
import bs58check from 'bs58check'
import { configureZcashNu7WalletAuthorizer, signUtxoTx, signZcashTransparentTx, validateZcashTransparentPlan } from '../src/bun/txbuilder/zcash-transparent'
import { ZCASH_NU7_BRANCH_ID, ZCASH_V6_VERSION_GROUP_ID, zcashNu7SupportError } from '../src/shared/zcash-nu7'
import { deviceOperationContext } from '../src/bun/device-operation'
import { buildUtxoTx } from '../src/bun/txbuilder/utxo'
import rustRequest from '../zcash-cli/tests/fixtures/transparent-nu7-request.json'

const H = 0x80000000
const accountPath = [H + 44, H + 133, H]
// Disposable synthetic key material. No real wallet, device, API or process.
const account = HDKey.fromMasterSeed(new Uint8Array(32).fill(71)).derive("m/44'/133'/0'")
const scriptAt = (change: number, index: number) => {
  const pub = account.deriveChild(change).deriveChild(index).publicKey!
  return `76a914${createHash('ripemd160').update(createHash('sha256').update(pub).digest()).digest('hex')}88ac`
}
const address = bs58check.encode(Buffer.from(`1cb8${'55'.repeat(20)}`, 'hex'))
const raw = `0600008098b684d8d90a1977${'00'.repeat(50)}`
function plan() {
  return {
    coin: 'Zcash', version: 6, zcashTransparent: true, versionGroupId: ZCASH_V6_VERSION_GROUP_ID,
    branchId: ZCASH_NU7_BRANCH_ID, locktime: 0, expiry: 0,
    inputs: [
      { txid: `${'00'.repeat(31)}01`, vout: 2, amount: '60000', addressNList: [...accountPath, 0, 3], scriptType: 'p2pkh', scriptPubkey: scriptAt(0, 3) },
      { txid: `${'ab'.repeat(31)}cd`, vout: 7, amount: '40000', addressNList: [...accountPath, 1, 5], scriptType: 'p2pkh', scriptPubkey: scriptAt(1, 5) },
    ],
    outputs: [
      { address, amount: '50000', addressType: 'spend' },
      { amount: '40000', addressNList: [...accountPath, 1, 8], addressType: 'change', isChange: true, scriptType: 'p2pkh' },
    ],
  }
}
function fixture() {
  const calls: string[] = []
  let authorized = true
  let buildParams: any
  let signRequest: any
  let finalParams: any
  let changeBuild = (_: any) => {}
  let afterSign = () => {}
  const wallet = {
    getFirmwareVersion: async () => { calls.push('firmware'); return 'v7.17.0' },
    getPublicKeys: async (paths: any) => { calls.push('keys'); expect(paths).toEqual([{ addressNList: accountPath, coin: 'Zcash', scriptType: 'p2pkh' }]); return [{ xpub: account.publicExtendedKey }] },
    zcashSignPczt: async (request: any) => {
      calls.push('sign'); signRequest = request; afterSign()
      const signatures: any = []
      signatures._transparentSignatures = ['30' + '11'.repeat(70), '30' + '22'.repeat(70)]
      return signatures
    },
    btcSignTx: async () => { calls.push('legacy'); return 'bitcoin-result' },
  }
  const dependencies = {
    authorizeWallet: () => authorized,
    available: () => true, busy: () => false,
    begin: () => { calls.push('begin') }, end: () => { calls.push('end') },
    start: async () => { calls.push('start') },
    command: async (name: string, params: any) => {
      calls.push(name)
      if (name === 'finalize_transparent') { finalParams = params; return { raw_tx: raw, txid: 'ab'.repeat(32) } }
      buildParams = params
      const response = {
        request_id: 'aa'.repeat(16), account: 0, n_actions: 0, actions: [], target_height: 3_559_308,
        bundle_meta: { flags: 0, value_balance: 0, anchor: '00'.repeat(32) },
        branch_id: ZCASH_NU7_BRANCH_ID,
        header_fields: { expiry_height: 0, lock_time: 0, tx_version: 6, version_group_id: ZCASH_V6_VERSION_GROUP_ID },
        digests: { header: '11'.repeat(32), transparent: '22'.repeat(32), orchard: '33'.repeat(32), ironwood: '44'.repeat(32) },
        transparent_inputs: params.transparent_inputs.map((input: any, index: number) => ({
          index, address_path: input.address_path, amount: input.value,
          prevout_txid: Buffer.from(input.txid, 'hex').reverse().toString('hex'), prevout_index: input.vout,
          sequence: 0xffffffff, script_pubkey: input.script_pubkey,
        })),
        transparent_outputs: params.transparent_outputs.map((output: any, index: number) => ({ index, ...output })),
        display: { amount: '0.0009 ZEC', fee: '0.0001 ZEC' },
      }
      changeBuild(response)
      return response
    },
  }
  return { wallet, dependencies, calls, authorize: (v: boolean) => { authorized = v }, alter: (fn: typeof changeBuild) => { changeBuild = fn }, afterSign: (fn: typeof afterSign) => { afterSign = fn }, values: () => ({ buildParams, signRequest, finalParams }) }
}
afterEach(() => configureZcashNu7WalletAuthorizer(() => false))

test('modern send preserves per-input ownership, outpoint byte order, change, fee and one-shot finalization', async () => {
  const f = fixture()
  const result = await signZcashTransparentTx(f.wallet, plan(), f.dependencies)
  expect(result.serializedTx).toBe(raw)
  const { buildParams, signRequest, finalParams } = f.values()
  expect(buildParams.transparent_inputs.map((i: any) => i.address_path)).toEqual(plan().inputs.map(i => i.addressNList))
  expect(signRequest.transparent_inputs[0].prevoutTxid).toBe(`01${'00'.repeat(31)}`)
  expect(signRequest.transparent_inputs[1].prevoutIndex).toBe(7)
  expect(signRequest.transparent_outputs[1]).toEqual({ index: 1, value: 40000, script_pubkey: scriptAt(1, 8) })
  expect(finalParams.request_id).toBe('aa'.repeat(16))
  expect(finalParams.compressed_pubkeys).toEqual([
    Buffer.from(account.deriveChild(0).deriveChild(3).publicKey!).toString('hex'),
    Buffer.from(account.deriveChild(1).deriveChild(5).publicKey!).toString('hex'),
  ])
  expect(f.calls).toEqual(['firmware', 'begin', 'start', 'keys', 'build_transparent_pczt', 'sign', 'finalize_transparent', 'end'])
})

test('actual mature coin selection preserves a two-input send, unused change path and ZIP-317 fee through signing', async () => {
  const f = fixture()
  const original = plan()
  const tx = await buildUtxoTx({
    ListUnspent: async () => ({ data: original.inputs.map(input => ({
      txid: input.txid, vout: input.vout, value: input.amount, confirmations: 12,
      path: `m/44'/133'/0'/${input.addressNList[3]}/${input.addressNList[4]}`,
      scriptPubKey: input.scriptPubkey,
    })) }),
    GetFeeRateByNetwork: async () => ({ data: { slow: 1, average: 1, fast: 1 } }),
    GetPubkeyInfo: async () => ({ data: { tokens: [{ path: "m/44'/133'/0'/1/7", name: address, transfers: 1 }] } }),
  }, { id: 'zcash', coin: 'Zcash', symbol: 'ZEC', networkId: 'bip122:00040fe8ec8471911baa1db1266ea15d', decimals: 8, scriptType: 'p2pkh' } as any,
  { to: address, amount: '0.00075', xpub: account.publicExtendedKey })
  expect(tx.inputs).toHaveLength(2)
  expect(tx.outputs).toHaveLength(2)
  expect(tx.outputs[1]).toMatchObject({ amount: '15000', addressNList: [...accountPath, 1, 8], isChange: true })
  expect(tx.fee).toBe('0.0001')
  await signZcashTransparentTx(f.wallet, tx, f.dependencies)
  expect(f.values().signRequest.transparent_outputs.map((o: any) => o.value)).toEqual([75000, 15000])
  expect(f.calls.filter(c => c === 'sign')).toHaveLength(1)
})

test('physical wallets remain blocked even at 7.17 and caller flags cannot authorize them', async () => {
  const f = fixture()
  await expect(signUtxoTx(f.wallet, { ...plan(), isAlphaEmulator: true })).rejects.toThrow('physical support is not yet available')
  expect(f.calls).toEqual([])
  expect(zcashNu7SupportError('7.17.0', true)).toContain('alpha emulator')
  expect(zcashNu7SupportError('7.17.0', true, true)).toBeUndefined()
})

test('older alpha firmware and missing sidecar fail before public-key or signing calls', async () => {
  const f = fixture()
  await expect(signZcashTransparentTx(f.wallet, plan(), { ...f.dependencies, firmwareVersion: '7.16.0' })).rejects.toThrow('7.17.0')
  await expect(signZcashTransparentTx(f.wallet, plan(), { ...f.dependencies, available: () => false })).rejects.toThrow('transaction builder')
  expect(f.calls).toEqual(['firmware'])
})

test('invalid legacy plans, duplicate inputs, memo and foreign account/change paths cannot reach the device', async () => {
  const f = fixture()
  const variants = [
    { ...plan(), version: 4 }, { ...plan(), branchId: 0x37a5165b }, { ...plan(), memo: 'payment' },
    { ...plan(), inputs: [plan().inputs[0], plan().inputs[0]] },
    { ...plan(), inputs: [{ ...plan().inputs[0], addressNList: [...accountPath, H, 0] }] },
    { ...plan(), outputs: [plan().outputs[0], { ...plan().outputs[1], addressNList: [H + 44, H + 133, H + 1, 1, 8] }] },
    { ...plan(), inputs: [{ ...plan().inputs[0], amount: '2100000000000001' }] },
    { ...plan(), inputs: [{ ...plan().inputs[0], amount: '2100000000000000' }, plan().inputs[1]] },
  ]
  for (const tx of variants) await expect(signZcashTransparentTx(f.wallet, tx, f.dependencies)).rejects.toThrow('Zcash Nu7')
  expect(f.calls).toEqual([])
})

test('input script must match the public child of the fresh device account key', async () => {
  const f = fixture()
  const tx = plan(); tx.inputs[0].scriptPubkey = scriptAt(0, 99)
  await expect(signZcashTransparentTx(f.wallet, tx, f.dependencies)).rejects.toThrow('does not belong')
  expect(f.calls).not.toContain('sign')
  expect(f.calls).not.toContain('build_transparent_pczt')
  expect(f.calls.at(-1)).toBe('end')
})

for (const [name, alter] of Object.entries({
  branch: (r: any) => { r.branch_id = 0x37a5165b },
  version: (r: any) => { r.header_fields.tx_version = 5 },
  actions: (r: any) => { r.n_actions = 2 },
  recipient: (r: any) => { r.transparent_outputs[0].script_pubkey = scriptAt(0, 1) },
  change: (r: any) => { r.transparent_outputs[1].value-- },
  input: (r: any) => { r.transparent_inputs[1].address_path = [...accountPath, 0, 0] },
  endian: (r: any) => { r.transparent_inputs[0].prevout_txid = plan().inputs[0].txid },
  correlation: (r: any) => { delete r.request_id },
  shielded: (r: any) => { r.bundle_meta.value_balance = 1 },
  metadata: (r: any) => { delete r.bundle_meta },
})) test(`sidecar ${name} mismatch is rejected before the device prompt`, async () => {
  const f = fixture(); f.alter(alter)
  await expect(signZcashTransparentTx(f.wallet, plan(), f.dependencies)).rejects.toThrow('Zcash Nu7')
  expect(f.calls).not.toContain('sign')
  expect(f.calls).not.toContain('finalize_transparent')
})

test('retired emulator/session after approval cannot finalize into its replacement', async () => {
  const f = fixture(); f.afterSign(() => f.authorize(false))
  await expect(signZcashTransparentTx(f.wallet, plan(), f.dependencies)).rejects.toThrow('alpha emulator')
  expect(f.calls).not.toContain('finalize_transparent')
  expect(f.calls.at(-1)).toBe('end')
})

test('operation cancellation after sidecar preparation prevents a later signing write', async () => {
  const f = fixture(); let cancelled = false
  f.alter(() => { cancelled = true })
  await expect(deviceOperationContext.run({ assertCurrent: () => { if (cancelled) throw new Error('cancelled owner') } },
    () => signZcashTransparentTx(f.wallet, plan(), f.dependencies))).rejects.toThrow('cancelled owner')
  expect(f.calls).not.toContain('sign')
})

test('the explicit dispatcher preserves ordinary Bitcoin signing and rejects unmarked Zcash', async () => {
  const f = fixture()
  expect(await signUtxoTx(f.wallet, { coin: 'Bitcoin' })).toBe('bitcoin-result')
  await expect(signUtxoTx(f.wallet, { coin: 'Zcash', version: 4 }, f.dependencies)).rejects.toThrow('rebuild')
  expect(f.calls).toEqual(['legacy'])
  expect(() => validateZcashTransparentPlan(plan())).not.toThrow()
})

test('the actual generic signing dispatcher cannot send a Zcash plan through another coin', async () => {
  const path = '../src/bun/txbuilder/index.ts'
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'signTx')!
  const js = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const calls: any[] = []
  const sign = new Function('signUtxoTx', `${js}; return signTx`)(async (_wallet: any, tx: any) => { calls.push(tx); return 'modern' })
  await expect(sign({}, { id: 'zcash', chainFamily: 'utxo' }, { ...plan(), coin: 'Bitcoin' })).rejects.toThrow('selected signing network')
  await expect(sign({}, { id: 'bitcoin', chainFamily: 'utxo' }, plan())).rejects.toThrow('selected signing network')
  expect(calls).toEqual([])
  expect(await sign({}, { id: 'zcash', chainFamily: 'utxo' }, plan())).toBe('modern')
  expect(calls).toHaveLength(1)
})

test('the actual Rust IPC snapshot conforms to the host plan policy without JSON key-order assumptions', () => {
  const tx = {
    coin: 'Zcash', zcashTransparent: true, version: rustRequest.header_fields.tx_version,
    versionGroupId: rustRequest.header_fields.version_group_id, branchId: rustRequest.branch_id,
    locktime: rustRequest.header_fields.lock_time, expiry: rustRequest.header_fields.expiry_height,
    inputs: rustRequest.transparent_inputs.map(i => ({
      txid: Buffer.from(i.prevout_txid, 'hex').reverse().toString('hex'), vout: i.prevout_index,
      amount: String(i.amount), addressNList: i.address_path, scriptType: 'p2pkh', scriptPubkey: i.script_pubkey,
    })),
    outputs: rustRequest.transparent_outputs.map(o => ({
      address: bs58check.encode(Buffer.from(`1cb8${o.script_pubkey.slice(6, 46)}`, 'hex')),
      amount: String(o.value), addressType: 'spend',
    })),
  }
  expect(() => validateZcashTransparentPlan(tx)).not.toThrow()
  expect(() => validateZcashTransparentPlan({ ...tx, version: 4, versionGroupId: 0x892f2085 })).toThrow('legacy')
})
