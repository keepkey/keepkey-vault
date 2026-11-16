/** Nu7 transparent sends use Rust's canonical v6 construction and the existing
 * plaintext PCZT device protocol. No JavaScript transaction signing or private
 * key material is involved. The ordinary UTXO builder owns coin selection. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { HDKey } from '@scure/bip32'
// @ts-ignore CJS dependency, also used by the ordinary UTXO builder.
import bs58check from 'bs58check'
import { assertZcashNu7Support, ZCASH_NU7_ACTIVATION_HEIGHT, ZCASH_NU7_BRANCH_ID, ZCASH_V6_VERSION_GROUP_ID } from '../../shared/zcash-nu7'
import { deviceOperationContext } from '../device-operation'
import { decodeTexAddress, isTexAddress, p2pkhScript } from './zcash-tex'

const H = 0x80000000
const MAX_MONEY = 21_000_000 * 100_000_000
const EMPTY_BUNDLE_META = { flags: 0, value_balance: 0, anchor: '00'.repeat(32) }
const fail = (message: string): never => { throw new Error(`Zcash Nu7: ${message}`) }
const current = () => deviceOperationContext.getStore()?.assertCurrent()
let walletAuthorizer: (wallet: unknown) => boolean = () => false
/** Set only by the native host, using its active wallet/transport and loaded
 * reviewed alpha-firmware provenance. Caller transaction fields are ignored. */
export function configureZcashNu7WalletAuthorizer(authorize: (wallet: unknown) => boolean): void { walletAuthorizer = authorize }
const equal = isDeepStrictEqual
const hex = (value: unknown, bytes: number) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(value)
const pathValid = (p: unknown): p is number[] => Array.isArray(p) && p.length === 5
  && p.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)
  && p[0] === H + 44 && p[1] === H + 133 && p[2] >= H && p[3] <= 2 && p[4] < H
function amount(value: unknown): number {
  if (!/^[1-9]\d*$/.test(String(value))) return fail('every input and output needs a positive integer amount')
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n > MAX_MONEY) return fail('amount exceeds the Zcash monetary range')
  return n
}
function ownScript(publicKey: Uint8Array): string {
  const sha256 = new Uint8Array(createHash('sha256').update(publicKey).digest())
  return p2pkhScript(new Uint8Array(createHash('ripemd160').update(sha256).digest()))
}
function recipientScript(address: string): { script: string; tex: boolean } {
  if (isTexAddress(address)) return { script: p2pkhScript(decodeTexAddress(address)), tex: true }
  let payload: Uint8Array
  try { payload = new Uint8Array(bs58check.decode(address)) } catch { return fail('invalid transparent recipient address') }
  if (payload.length !== 22 || payload[0] !== 0x1c) return fail('recipient must be a mainnet transparent Zcash address')
  const hash = Buffer.from(payload.slice(2)).toString('hex')
  if (payload[1] === 0xb8) return { script: `76a914${hash}88ac`, tex: false }
  if (payload[1] === 0xbd) return { script: `a914${hash}87`, tex: false }
  return fail('recipient must be a mainnet transparent Zcash address')
}

/** Validate untrusted renderer/REST input before any device lookup. The marker
 * selects a protocol, but conveys no authority over paths, amounts or outputs. */
export function validateZcashTransparentPlan(tx: any): void {
  if (tx?.coin !== 'Zcash' || tx.zcashTransparent !== true || tx.version !== 6
    || tx.versionGroupId !== ZCASH_V6_VERSION_GROUP_ID || tx.branchId !== ZCASH_NU7_BRANCH_ID
    || tx.locktime !== 0 || tx.expiry !== 0) fail('legacy or unsupported transaction plan; rebuild this send in the updated Vault')
  if (tx.opReturnData || tx.memo?.trim()) fail('transparent sends cannot include a memo in this build; clear the memo and rebuild')
  if (!Array.isArray(tx.inputs) || !tx.inputs.length || tx.inputs.length > 8
    || !Array.isArray(tx.outputs) || !tx.outputs.length || tx.outputs.length > 8) fail('a transaction must have 1–8 inputs and outputs')
  const seen = new Set<string>()
  let account: number | undefined
  let totalIn = 0
  let totalOut = 0
  for (const input of tx.inputs) {
    if (!pathValid(input.addressNList) || input.scriptType !== 'p2pkh'
      || !hex(input.txid, 32) || !Number.isInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff
      || typeof input.scriptPubkey !== 'string' || !/^76a914[0-9a-f]{40}88ac$/i.test(input.scriptPubkey)) fail('input is missing its verified P2PKH script, outpoint or standard Zcash path')
    if (account !== undefined && account !== input.addressNList[2]) fail('all inputs and change must belong to the same Zcash account')
    account = input.addressNList[2]
    const outpoint = `${input.txid.toLowerCase()}:${input.vout}`
    if (seen.has(outpoint)) fail('duplicate input outpoint')
    seen.add(outpoint)
    totalIn += amount(input.amount)
  }
  let payees = 0
  for (const output of tx.outputs) {
    totalOut += amount(output.amount)
    if (output.isChange === true || output.addressType === 'change') {
      if (!pathValid(output.addressNList) || output.addressNList[2] !== account
        || output.addressNList[3] !== 1 || output.scriptType !== 'p2pkh' || output.address) fail('invalid change ownership path')
    } else {
      if (output.addressType !== 'spend' || output.addressNList || typeof output.address !== 'string') fail('invalid recipient output')
      recipientScript(output.address)
      payees++
    }
  }
  if (!payees || !Number.isSafeInteger(totalIn) || !Number.isSafeInteger(totalOut)
    || totalIn > MAX_MONEY || totalOut > MAX_MONEY) fail('invalid transaction totals')
  const fee = totalIn - totalOut
  const floor = 5000 * Math.max(2, tx.inputs.length, tx.outputs.length)
  if (fee < floor || fee > totalOut) fail('fee is below ZIP-317 or exceeds the value delivered')
}

export interface ZcashTransparentDependencies {
  authorizeWallet?: (wallet: unknown) => boolean
  firmwareVersion?: string
  available?: () => boolean
  start?: () => Promise<void>
  command?: (name: string, params: Record<string, any>) => Promise<any>
  busy?: () => boolean
  begin?: () => void
  end?: () => void
}

export async function signZcashTransparentTx(wallet: any, unsignedTx: any, dependencies: ZcashTransparentDependencies = {}): Promise<any> {
  const tx = structuredClone(unsignedTx)
  validateZcashTransparentPlan(tx)
  const authorize = dependencies.authorizeWallet ?? walletAuthorizer
  const assertSession = () => {
    current()
    if (!authorize(wallet)) fail('sending requires the 7.17 alpha emulator; physical support is not yet available')
  }
  assertSession()
  const firmwareVersion = dependencies.firmwareVersion ?? await wallet.getFirmwareVersion?.()
  assertSession()
  assertZcashNu7Support(firmwareVersion, true, true)
  if (typeof wallet.zcashSignPczt !== 'function' || typeof wallet.getPublicKeys !== 'function') fail('the wallet does not support the required PCZT protocol')
  // Load lazily: merely importing the transaction builder must not start a
  // process, read a user profile or initialize shielded-wallet state.
  const sidecar = await import('../zcash-sidecar')
  assertSession()
  assertZcashNu7Support(firmwareVersion, (dependencies.available ?? (() => !!sidecar.findZcashCliBinary()))(), true)
  const busy = dependencies.busy ?? sidecar.isZcashSendInFlight
  if (busy()) fail('another Zcash transaction is already in progress')
  const begin = dependencies.begin ?? sidecar.beginZcashSend
  const end = dependencies.end ?? sidecar.endZcashSend
  const command = dependencies.command ?? sidecar.sendCommand
  begin()
  try {
    assertSession()
    await (dependencies.start ?? (() => sidecar.startSidecar({ transparentOnly: true })))()
    assertSession()
    const accountPath = tx.inputs[0].addressNList.slice(0, 3)
    const keys = await wallet.getPublicKeys([{ addressNList: accountPath, coin: 'Zcash', scriptType: 'p2pkh' }])
    assertSession()
    const xpub = keys?.[0]?.xpub
    if (typeof xpub !== 'string') fail('device did not return the signing account public key')
    const accountKey = HDKey.fromExtendedKey(xpub)
    if (accountKey.privateKey || accountKey.depth !== 3 || accountKey.index !== accountPath[2]) fail('device returned an unexpected account public key')
    const keyAt = (path: number[]): Uint8Array => {
      const key = accountKey.deriveChild(path[3]).deriveChild(path[4]).publicKey
      if (!key) return fail('could not derive the public signing key')
      return key
    }
    const publicKeys = tx.inputs.map((input: any) => {
      const key = keyAt(input.addressNList)
      if (ownScript(key) !== input.scriptPubkey.toLowerCase()) fail('selected input does not belong to its device-derived path')
      return Buffer.from(key).toString('hex')
    })
    const inputs = tx.inputs.map((input: any) => ({
      txid: input.txid.toLowerCase(), vout: input.vout, value: amount(input.amount),
      script_pubkey: input.scriptPubkey.toLowerCase(), address_path: input.addressNList,
    }))
    const outputs = tx.outputs.map((output: any) => output.isChange || output.addressType === 'change'
      ? { value: amount(output.amount), script_pubkey: ownScript(keyAt(output.addressNList)), tex: false }
      : { value: amount(output.amount), script_pubkey: recipientScript(output.address).script, tex: isTexAddress(output.address) })
    assertSession()
    const build = await command('build_transparent_pczt', {
      transparent_inputs: inputs, transparent_outputs: outputs.map(({ value, script_pubkey }: any) => ({ value, script_pubkey })),
      account: accountPath[2] - H,
    })
    assertSession()
    if (!hex(build.request_id, 16) || build.n_actions !== 0 || !equal(build.actions, [])
      || build.account !== accountPath[2] - H || !equal(build.bundle_meta, EMPTY_BUNDLE_META) || (build.pool != null && build.pool !== 'orchard')
      || build.branch_id !== ZCASH_NU7_BRANCH_ID || !Number.isSafeInteger(build.target_height) || build.target_height < ZCASH_NU7_ACTIVATION_HEIGHT
      || !equal(build.header_fields, { tx_version: 6, version_group_id: ZCASH_V6_VERSION_GROUP_ID, lock_time: 0, expiry_height: 0 })
      || !hex(build.digests?.header, 32) || !hex(build.digests?.transparent, 32)
      || !hex(build.digests?.orchard, 32) || !hex(build.digests?.ironwood, 32)) fail('sidecar returned an unsupported transaction header or shielded component')
    const expectedInputs = inputs.map((input: any, index: number) => ({
      index, address_path: input.address_path, amount: input.value,
      prevout_txid: Buffer.from(input.txid, 'hex').reverse().toString('hex'), prevout_index: input.vout,
      sequence: 0xffffffff, script_pubkey: input.script_pubkey,
    }))
    const expectedOutputs = outputs.map((output: any, index: number) => ({ index, value: output.value, script_pubkey: output.script_pubkey }))
    if (!equal(build.transparent_inputs, expectedInputs) || !equal(build.transparent_outputs, expectedOutputs)) fail('sidecar changed the selected inputs, recipient, change or fee')
    const request = {
      n_actions: 0, actions: [], account: accountPath[2] - H,
      branch_id: build.branch_id, header_fields: build.header_fields,
      bundle_meta: { ...EMPTY_BUNDLE_META },
      digests: { header: build.digests.header, transparent: build.digests.transparent, orchard: build.digests.orchard, ironwood: build.digests.ironwood },
      display: {
        amount: `${(outputs.reduce((sum: number, output: any) => sum + output.value, 0) / 1e8).toFixed(8)} ZEC`,
        fee: `${((inputs.reduce((sum: number, input: any) => sum + input.value, 0) - outputs.reduce((sum: number, output: any) => sum + output.value, 0)) / 1e8).toFixed(8)} ZEC`,
      },
      transparent_inputs: expectedInputs.map((input: any) => ({
        index: input.index, addressNList: input.address_path, amount: input.amount,
        prevoutTxid: input.prevout_txid, prevoutIndex: input.prevout_index,
        sequence: input.sequence, scriptPubkey: input.script_pubkey,
      })),
      // Firmware 7.17's address_n hint denotes one-time scope 2, not ordinary
      // change. The host verifies change against the fresh device account key;
      // the device displays its real t-address and checks all output values.
      transparent_outputs: expectedOutputs.map((output: any, index: number) => ({ ...output, ...(outputs[index].tex ? { is_tex: true } : {}) })),
    }
    const signatures = await wallet.zcashSignPczt(request, '')
    assertSession()
    const transparentSignatures = signatures?._transparentSignatures
    if (!Array.isArray(signatures) || signatures.length || !Array.isArray(transparentSignatures)
      || transparentSignatures.length !== inputs.length || transparentSignatures.some((sig: unknown) => typeof sig !== 'string' || !/^30[0-9a-f]{12,142}$/i.test(sig))) fail('device returned an invalid transparent signature set')
    const finalized = await command('finalize_transparent', {
      request_id: build.request_id, transparent_signatures: transparentSignatures, compressed_pubkeys: publicKeys,
    })
    assertSession()
    if (typeof finalized.raw_tx !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(finalized.raw_tx)
      || !finalized.raw_tx.toLowerCase().startsWith('0600008098b684d8d90a1977') || !hex(finalized.txid, 32)) fail('sidecar returned an invalid Nu7 serialized transaction')
    return { serializedTx: finalized.raw_tx, signatures: transparentSignatures }
  } finally { end() }
}

/** Explicit routing protects every caller from accidentally sending the modern
 * plan to the generic legacy Bitcoin/Zcash serializer. */
export async function signUtxoTx(wallet: any, params: any, dependencies?: ZcashTransparentDependencies): Promise<any> {
  return params?.coin === 'Zcash'
    ? signZcashTransparentTx(wallet, params, dependencies)
    : wallet.btcSignTx(params)
}
