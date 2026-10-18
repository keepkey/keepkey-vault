/**
 * BIP-174 PSBT v0 for Bitcoin mainnet single-sig accounts (p2pkh, p2sh-p2wpkh,
 * p2wpkh). Pure: no device, no network, no RPC.
 *
 * Trust model: the PSBT is hostile. Ownership is proven only by re-deriving
 * each pubkey AND scriptPubKey from Desktop's own account xpub; fingerprints
 * and PSBT_GLOBAL_XPUB are hints at most. Change rules mirror the firmware
 * (signing.c check_change_bip32_path, first qualifying output only) so every
 * output row says exactly what the KeepKey will show.
 */
import * as btc from '@scure/btc-signer'
import { RawPSBTV0 } from '@scure/btc-signer/psbt'
import { HDKey } from '@scure/bip32'
import { base64, hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { secp256k1 } from '@noble/curves/secp256k1'
import { b58check } from './codec'

export type BtcPsbtScriptType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh'

export interface BtcPsbtAccount {
  scriptType: BtcPsbtScriptType
  /** Account path, depth 3, e.g. [84', 0', 0'] */
  path: number[]
  /** Standard xpub (0488b21e), base58 or the 78 serialized bytes */
  xpub: string | Uint8Array
  /** Real BIP32 master fingerprint, when known */
  masterFingerprint?: Uint8Array
}

export const MAX_MONEY = 2_100_000_000_000_000n
const MAX_ENCODED_BYTES = 1024 * 1024
const MAX_IO = 100
const MAX_DERIVATIONS = 4
const MAX_OP_RETURN = 220 // firmware types.options op_return_data
const CHANGE_GAP = 1000
const MAX_CHANGE_INDEX = 1_000_000 // firmware signing.c BIP32_MAX_LAST_ELEMENT
const SCAN_LIMIT = 200 // per chain, only for inputs that carry no derivation at all (~0.4 ms per key)
const H = 0x80000000
const PURPOSE: Record<BtcPsbtScriptType, number> = { p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84 }
const MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff]
const EMPTY = new Uint8Array(0)

type RawTx = ReturnType<typeof btc.RawTx.decode>
type InputUpdate = Parameters<btc.Transaction['updateInput']>[1]
type Derivation = NonNullable<ReturnType<btc.Transaction['getInput']>['bip32Derivation']>

export type Decoded =
  | { kind: 'psbt'; tx: btc.Transaction; bytes: Uint8Array }
  | { kind: 'rawtx'; tx: RawTx; bytes: Uint8Array }

export interface AnalyzedInput {
  txid: string
  vout: number
  sequence: number
  amount: bigint
  /** Amount proven by a hash-checked NON_WITNESS_UTXO */
  amountVerified: boolean
  scriptType: BtcPsbtScriptType
  accountPath: number[]
  addressNList: number[]
  address: string
  pubkey: Uint8Array
  prevTxHex?: string
}

export interface AnalyzedOutput {
  index: number
  amount: bigint
  scriptHex: string
  address?: string
  opReturn?: { hex: string; text: string }
  /** payment: not ours. own: ours but shown on the device (not change by firmware rules) */
  kind: 'payment' | 'change' | 'own' | 'op-return'
  deviceWillShow: 'hidden-change' | 'address' | 'op-return'
  owner?: { accountPath: number[]; scriptType: BtcPsbtScriptType; addressNList: number[] }
}

export interface PsbtAnalysis {
  psbtBytes: Uint8Array
  version: number
  locktime: number
  inputs: AnalyzedInput[]
  outputs: AnalyzedOutput[]
  totalIn: bigint
  totalOut: bigint
  fee: bigint
  /** Hidden change (at most one output) */
  change: bigint
  /** Everything the device shows as leaving: outputs minus hidden change */
  sent: bigint
  /** What the KeepKey's total screen shows: to_spend - change_spend, fee included */
  deviceTotal: bigint
  estVsize: number
  satPerVbyte: number
  feePercent: number | null
  flags: {
    nonZeroLocktime: boolean
    rbf: boolean
    unusualVersion: boolean
    noChange: boolean
    multiAccount: boolean
    unverifiedAmounts: boolean
    ownOutputShown: boolean
  }
}

/** hdwallet-keepkey BTCSignTxKK shape (modules/hdwallet/packages/hdwallet-core/src/bitcoin.ts) */
export interface PsbtSignTx {
  coin: 'Bitcoin'
  version: number
  locktime: number
  inputs: Array<{
    addressNList: number[]
    scriptType: BtcPsbtScriptType
    amount: string
    vout: number
    txid: string
    sequence: number
    hex?: string
  }>
  outputs: Array<
    | { address: string; amount: string; addressType: 'spend' }
    | { addressNList: number[]; scriptType: BtcPsbtScriptType; amount: string; isChange: true; addressType: 'change' }
    | { opReturnData: Uint8Array; amount: '0'; addressType: 'spend' }
  >
}

// ── helpers ────────────────────────────────────────────────────────────

const sha256d = (...parts: Uint8Array[]) => sha256(sha256(btc.utils.concatBytes(...parts)))
const eq = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i])
const u32be = (b: Uint8Array) => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
const isTaproot = (s: Uint8Array) => s.length === 34 && s[0] === 0x51 && s[1] === 0x20
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

function startsWithMagic(b: Uint8Array): boolean {
  return b.length >= 5 && MAGIC.every((x, i) => b[i] === x)
}

/** txid of a raw tx: hash of the non-witness serialization */
function txidOf(tx: RawTx): string {
  const bytes = btc.RawTx.encode({ ...tx, segwitFlag: false, witnesses: undefined })
  return hex.encode(sha256d(bytes).reverse())
}

function checkAmount(v: bigint, what: string): bigint {
  if (v < 0n || v > MAX_MONEY) throw new Error(`${what}: amount ${v} sats is outside 0..21M BTC, refusing`)
  return v
}

function sats(v: bigint | number | string, what: string): bigint {
  let n: bigint
  try { n = BigInt(v) } catch { throw new Error(`${what}: amount must be whole satoshis`) }
  return checkAmount(n, what)
}

/** Firmware re-encodes OP_RETURN as 6a + op_push(len) + data (transaction.c); anything else can't be reproduced. */
function opReturnData(script: Uint8Array): Uint8Array | undefined {
  if (script[0] !== 0x6a || script.length < 3) return undefined
  const pushdata1 = script[1] === 0x4c
  const len = pushdata1 ? script[2] : script[1]
  const data = script.subarray(pushdata1 ? 3 : 2)
  if (len < 1 || len > MAX_OP_RETURN || data.length !== len) return undefined
  if (pushdata1 !== len >= 0x4c) return undefined // only the minimal length prefix
  return data
}

function printable(data: Uint8Array): string {
  // Printable ASCII only: drops control, bidi and every other non-ASCII byte.
  return String.fromCharCode(...data.filter((c) => c >= 0x20 && c <= 0x7e))
}

/** Address from the script (never from PSBT strings). Refuses scripts the device can't pay or that burn funds. */
function scriptToAddress(script: Uint8Array): string {
  let out: ReturnType<typeof btc.OutScript.decode>
  try { out = btc.OutScript.decode(script) } catch { throw new Error('non-standard output script') }
  // pkh/sh, witness v0 with a 20/32-byte program, witness v1 with a 32-byte program.
  // Everything else (bare multisig, v1 non-32, v2+) is refused: the firmware would encode it and the coins would burn.
  if (out.type !== 'pkh' && out.type !== 'sh' && out.type !== 'wpkh' && out.type !== 'wsh' && out.type !== 'tr') {
    throw new Error(`unsupported output script (${out.type})`)
  }
  // btc-signer accepts non-minimal pushes (00 4c 14 ..); the address would name a different script.
  if (!eq(btc.OutScript.encode(out), script)) throw new Error('non-canonical output script')
  return btc.Address(btc.NETWORK).encode(out)
}

// ── accounts and derivation ────────────────────────────────────────────

interface Derived { pubkey: Uint8Array; script: Uint8Array; redeemScript?: Uint8Array }
interface Acct {
  scriptType: BtcPsbtScriptType
  path: number[]
  hd: HDKey
  /** hash160(account pubkey)[0:4], the fingerprint Electrum writes for a bare xpub */
  fp: number
  master?: number
  chains: Map<number, HDKey>
  cache: Map<string, Derived>
}
interface Owned extends Derived { acct: Acct; chain: number; index: number }

function loadAccount(a: BtcPsbtAccount): Acct {
  const xpub = typeof a.xpub === 'string' ? a.xpub : b58check.encode(a.xpub)
  let hd: HDKey
  try { hd = HDKey.fromExtendedKey(xpub) } catch { throw new Error('Account key is not a standard mainnet xpub') }
  if (hd.privateKey) throw new Error('Refusing a private key')
  const purpose = PURPOSE[a.scriptType]
  if (purpose === undefined) throw new Error(`Unsupported account script type: ${a.scriptType}`)
  if (a.path.length !== 3 || a.path[0] !== purpose + H || a.path[1] !== H || a.path[2] < H) {
    throw new Error(`Account path must be m/${purpose}'/0'/n' for ${a.scriptType}`)
  }
  if (hd.depth !== 3 || hd.index !== a.path[2]) throw new Error('Account xpub does not match its path')
  if (a.masterFingerprint && a.masterFingerprint.length !== 4) throw new Error('Master fingerprint must be 4 bytes')
  return {
    scriptType: a.scriptType, path: a.path, hd, fp: hd.fingerprint,
    master: a.masterFingerprint ? u32be(a.masterFingerprint) : undefined,
    chains: new Map(), cache: new Map(),
  }
}

function scriptsFor(scriptType: BtcPsbtScriptType, pubkey: Uint8Array): Derived {
  if (scriptType === 'p2pkh') return { pubkey, script: btc.p2pkh(pubkey).script }
  if (scriptType === 'p2wpkh') return { pubkey, script: btc.p2wpkh(pubkey).script }
  const p = btc.p2sh(btc.p2wpkh(pubkey))
  return { pubkey, script: p.script, redeemScript: p.redeemScript }
}

function derive(acct: Acct, chain: number, index: number): Derived {
  const key = `${chain}/${index}`
  let d = acct.cache.get(key)
  if (!d) {
    let node = acct.chains.get(chain)
    if (!node) { node = acct.hd.deriveChild(chain); acct.chains.set(chain, node) }
    d = scriptsFor(acct.scriptType, node.deriveChild(index).publicKey!)
    acct.cache.set(key, d)
  }
  return d
}

/** Which of our accounts a BIP32 origin could point at. Full paths match by account prefix; Electrum's bare-xpub m/c/i by fingerprint. */
function candidates(fingerprint: number, path: number[], accts: Acct[]): Array<{ acct: Acct; chain: number; index: number }> {
  if (path.length > 5) throw new Error('Derivation path deeper than 5 levels, refusing')
  let list: Array<{ acct: Acct; chain: number; index: number }> = []
  if (path.length === 5) {
    if (path[3] >= H || path[4] >= H) throw new Error('Hardened change/index step in derivation path, refusing')
    list = accts.filter((a) => a.path.every((p, i) => p === path[i])).map((acct) => ({ acct, chain: path[3], index: path[4] }))
  } else if (path.some((p) => p >= H)) {
    throw new Error('Relative derivation path with hardened steps, refusing')
  } else if (path.length === 2) {
    list = accts.filter((a) => fingerprint === a.fp || fingerprint === 0).map((acct) => ({ acct, chain: path[0], index: path[1] }))
  }
  return list.filter((c) => c.chain === 0 || c.chain === 1)
}

/** First derivation entry that re-derives to its pubkey. 'mismatch' = our key on a script it doesn't produce. */
function matchDerivation(entries: Derivation, script: Uint8Array, accts: Acct[]): Owned | 'mismatch' | undefined {
  for (const [pubkey, { fingerprint, path }] of entries) {
    for (const c of candidates(fingerprint, path, accts)) {
      const d = derive(c.acct, c.chain, c.index)
      if (!eq(d.pubkey, pubkey)) continue
      return eq(d.script, script) ? { ...c, ...d } : 'mismatch'
    }
  }
  return undefined
}

/** Bounded gap scan for PSBTs stripped of derivations (Electrum "strip sensitive metadata", some exports). */
function scanScripts(wanted: Set<string>, accts: Acct[]): Map<string, Owned> {
  const found = new Map<string, Owned>()
  for (let index = 0; index < SCAN_LIMIT && found.size < wanted.size; index++) {
    for (const acct of accts) {
      for (const chain of [0, 1]) {
        const d = derive(acct, chain, index)
        const s = hex.encode(d.script)
        if (wanted.has(s) && !found.has(s)) found.set(s, { acct, chain, index, ...d })
      }
    }
  }
  return found
}

// ── decode ─────────────────────────────────────────────────────────────

function decodeRawTx(bytes: Uint8Array): RawTx {
  let tx: RawTx
  try { tx = btc.RawTx.decode(bytes) } catch (e) { throw new Error(`Not a valid transaction: ${msg(e)}`) }
  if (!tx.inputs.length || !tx.outputs.length) throw new Error('Transaction has no inputs or no outputs')
  if (tx.inputs.length > MAX_IO || tx.outputs.length > MAX_IO) throw new Error(`More than ${MAX_IO} inputs or outputs, refusing`)
  tx.outputs.forEach((o, i) => checkAmount(o.amount, `Output #${i}`))
  return tx
}

/** Binary (psbt\xff), base64 (cHNidP8), hex (70736274ff) PSBT, or raw tx hex. Caps and structural refusals only. */
export function decode(input: Uint8Array | string): Decoded {
  if (input.length > MAX_ENCODED_BYTES) throw new Error('Input is larger than 1 MB, refusing')
  let bytes: Uint8Array
  if (typeof input !== 'string' && startsWithMagic(input)) {
    bytes = input
  } else {
    const text = (typeof input === 'string' ? input : new TextDecoder().decode(input)).replace(/\s+/g, '')
    try {
      if (text.startsWith('cHNidP8')) bytes = base64.decode(text)
      else if (/^(?:[0-9a-fA-F]{2})+$/.test(text)) bytes = hex.decode(text.toLowerCase())
      else throw new Error('expected a binary, base64 or hex PSBT, or raw transaction hex')
    } catch (e) {
      throw new Error(`Not a PSBT or transaction: ${msg(e)}`)
    }
  }
  if (!startsWithMagic(bytes)) return { kind: 'rawtx', tx: decodeRawTx(bytes), bytes }

  let tx: btc.Transaction
  try { tx = btc.Transaction.fromPSBT(bytes) } catch (e) { throw new Error(`Invalid PSBT: ${msg(e)}`) }
  if (tx.opts.PSBTVersion !== 0) throw new Error('Only PSBT version 0 is supported')
  if (tx.inputsLength > MAX_IO || tx.outputsLength > MAX_IO) throw new Error(`More than ${MAX_IO} inputs or outputs, refusing`)
  const seen = new Set<string>()
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i)
    const outpoint = `${hex.encode(inp.txid!)}:${inp.index}`
    if (seen.has(outpoint)) throw new Error(`Input #${i} spends the same coin as an earlier input, refusing`)
    seen.add(outpoint)
    if ((inp.bip32Derivation?.length ?? 0) > MAX_DERIVATIONS || (inp.tapBip32Derivation?.length ?? 0) > MAX_DERIVATIONS) {
      throw new Error(`Input #${i} has more than ${MAX_DERIVATIONS} key paths (multisig is not supported)`)
    }
    if (inp.witnessUtxo) checkAmount(inp.witnessUtxo.amount, `Input #${i}`)
    if (inp.nonWitnessUtxo) checkAmount(inp.nonWitnessUtxo.outputs[inp.index!].amount, `Input #${i}`)
  }
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)
    checkAmount(out.amount!, `Output #${i}`)
    if ((out.bip32Derivation?.length ?? 0) > MAX_DERIVATIONS || (out.tapBip32Derivation?.length ?? 0) > MAX_DERIVATIONS) {
      throw new Error(`Output #${i} has more than ${MAX_DERIVATIONS} key paths`)
    }
  }
  return { kind: 'psbt', tx, bytes }
}

// ── analyze ────────────────────────────────────────────────────────────

/** Previous output of input #i. Amount comes from NON_WITNESS_UTXO when present, after hash and witness_utxo checks. */
function prevOut(tx: btc.Transaction, i: number): { amount: bigint; script: Uint8Array; verified: boolean; prevTxHex?: string } {
  const inp = tx.getInput(i)
  const txid = hex.encode(inp.txid!)
  if (inp.nonWitnessUtxo) {
    if (txidOf(inp.nonWitnessUtxo) !== txid) throw new Error(`Input #${i}: previous transaction does not hash to ${txid}, refusing`)
    const out = inp.nonWitnessUtxo.outputs[inp.index!]
    if (!out) throw new Error(`Input #${i}: previous transaction has no output ${inp.index}`)
    if (inp.witnessUtxo && (inp.witnessUtxo.amount !== out.amount || !eq(inp.witnessUtxo.script, out.script))) {
      throw new Error(`Input #${i}: witness UTXO disagrees with the previous transaction, refusing`)
    }
    return { amount: out.amount, script: out.script, verified: true, prevTxHex: hex.encode(btc.RawTx.encode(inp.nonWitnessUtxo)) }
  }
  if (inp.witnessUtxo) return { amount: inp.witnessUtxo.amount, script: inp.witnessUtxo.script, verified: false }
  throw new Error(`Input #${i} carries no UTXO information`)
}

function estimateVsize(inputs: BtcPsbtScriptType[], outputScripts: Uint8Array[]): number {
  // Weight units; signatures counted at 72 bytes (DER + sighash byte).
  const varint = (n: number) => (n < 0xfd ? 1 : 3)
  const IN: Record<BtcPsbtScriptType, number> = { p2pkh: 4 * 148, 'p2sh-p2wpkh': 4 * 64 + 108, p2wpkh: 4 * 41 + 108 }
  let w = 4 * (4 + varint(inputs.length) + varint(outputScripts.length) + 4)
  if (inputs.some((t) => t !== 'p2pkh')) w += 2
  for (const t of inputs) w += IN[t]
  for (const s of outputScripts) w += 4 * (8 + varint(s.length) + s.length)
  return Math.ceil(w / 4)
}

export function analyze(input: Uint8Array | string, accounts: BtcPsbtAccount[]): PsbtAnalysis {
  const d = decode(input)
  if (d.kind !== 'psbt') throw new Error('This is a raw transaction, not a PSBT; there is nothing to sign')
  const tx = d.tx
  if (!tx.inputsLength || !tx.outputsLength) throw new Error('PSBT has no inputs or no outputs')
  const accts = accounts.map(loadAccount)
  if (!accts.length) throw new Error('No Bitcoin accounts loaded')

  // Inputs: refuse anything already signed, foreign sighash, then prove ownership.
  const prevs: Array<ReturnType<typeof prevOut>> = []
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i)
    if (inp.finalScriptSig?.length || inp.finalScriptWitness?.length || inp.partialSig?.length || inp.tapKeySig || inp.tapScriptSig?.length) {
      throw new Error(`Input #${i} is already signed or finalized, refusing`)
    }
    const prev = prevOut(tx, i)
    const sh = inp.sighashType
    const okSighash = sh === undefined || sh === btc.SigHash.ALL || (isTaproot(prev.script) && sh === btc.SigHash.DEFAULT)
    if (!okSighash) throw new Error(`Input #${i} asks for sighash ${sh}; KeepKey only signs SIGHASH_ALL`)
    prevs.push(prev)
  }
  const owned: Array<Owned | undefined> = prevs.map((prev, i) => {
    const entries = tx.getInput(i).bip32Derivation
    if (!entries?.length) return undefined
    const m = matchDerivation(entries, prev.script, accts)
    if (m === 'mismatch') throw new Error(`Input #${i}: our key path does not produce this coin's script, refusing`)
    return m
  })
  const unpathed = prevs.flatMap((p, i) => (tx.getInput(i).bip32Derivation?.length ? [] : [hex.encode(p.script)]))
  if (unpathed.length) {
    const found = scanScripts(new Set(unpathed), accts)
    prevs.forEach((p, i) => { if (!tx.getInput(i).bip32Derivation?.length) owned[i] = found.get(hex.encode(p.script)) })
  }
  const mine = owned.filter((o): o is Owned => !!o)
  if (!mine.length) throw new Error('Not this wallet. Wrong passphrase or account not added?')
  if (mine.length !== owned.length) {
    throw new Error(`Inputs ${owned.flatMap((o, i) => (o ? [] : [`#${i}`])).join(', ')} are not from this wallet; KeepKey cannot sign a transaction with foreign inputs`)
  }
  // Accounts are mainnet-only (loadAccount), so every input shares coin type 0'.

  // Amounts (CVE-2020-14199 class): the firmware trusts host-supplied segwit v0 amounts.
  prevs.forEach((p, i) => {
    if (owned[i]!.acct.scriptType === 'p2pkh' && !p.verified) {
      throw new Error(`Input #${i} spends a legacy (1...) coin. KeepKey needs that coin's full previous transaction and this file doesn't include it. Re-export with full previous transactions.`)
    }
  })
  const unverified = prevs.some((p) => !p.verified)
  if (unverified && prevs.length > 1 && !prevs.some((p) => isTaproot(p.script))) {
    throw new Error('Several inputs without their previous transactions: the fee cannot be verified. Re-export with full previous transactions.')
  }

  const inputs: AnalyzedInput[] = owned.map((o, i) => {
    const inp = tx.getInput(i)
    return {
      txid: hex.encode(inp.txid!), vout: inp.index!, sequence: inp.sequence!,
      amount: prevs[i].amount, amountVerified: prevs[i].verified,
      scriptType: o!.acct.scriptType, accountPath: o!.acct.path, addressNList: [...o!.acct.path, o!.chain, o!.index],
      address: scriptToAddress(o!.script), pubkey: o!.pubkey, prevTxHex: prevs[i].prevTxHex,
    }
  })

  // Outputs: change only under the firmware's rules, narrowed to the inputs' single account and a sane gap.
  const single = mine.every((o) => o.acct === mine[0].acct) ? mine[0].acct : undefined
  const maxIndex = (chain: number) => Math.max(-1, ...mine.filter((o) => o.chain === chain).map((o) => o.index))
  let changeTaken = false
  const outputs: AnalyzedOutput[] = []
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)
    const script = out.script!
    const amount = out.amount!
    const base = { index: i, amount, scriptHex: hex.encode(script) }
    if (script[0] === 0x6a) {
      const data = opReturnData(script)
      if (!data) throw new Error(`Output #${i}: OP_RETURN must be a single push of 1..${MAX_OP_RETURN} bytes`)
      if (amount !== 0n) throw new Error(`Output #${i}: OP_RETURN output carries value, refusing`)
      outputs.push({ ...base, opReturn: { hex: hex.encode(data), text: printable(data) }, kind: 'op-return', deviceWillShow: 'op-return' })
      continue
    }
    let address: string
    try { address = scriptToAddress(script) } catch (e) { throw new Error(`Output #${i}: ${msg(e)}, refusing`) }
    const m = out.bip32Derivation?.length ? matchDerivation(out.bip32Derivation, script, accts) : undefined
    if (m === 'mismatch') throw new Error(`Output #${i}: change mismatch (our key path, different script), refusing`)
    if (!m) { outputs.push({ ...base, address, kind: 'payment', deviceWillShow: 'address' }); continue }
    const owner = { accountPath: m.acct.path, scriptType: m.acct.scriptType, addressNList: [...m.acct.path, m.chain, m.index] }
    const isChange = !changeTaken && m.acct === single && m.index <= Math.min(maxIndex(m.chain) + CHANGE_GAP, MAX_CHANGE_INDEX)
    if (isChange) changeTaken = true
    outputs.push({ ...base, address, owner, kind: isChange ? 'change' : 'own', deviceWillShow: isChange ? 'hidden-change' : 'address' })
  }

  const totalIn = checkAmount(inputs.reduce((s, x) => s + x.amount, 0n), 'Total input')
  const totalOut = checkAmount(outputs.reduce((s, x) => s + x.amount, 0n), 'Total output')
  const fee = totalIn - totalOut
  if (fee < 0n) throw new Error('Outputs spend more than the inputs, refusing')
  const change = outputs.filter((o) => o.kind === 'change').reduce((s, x) => s + x.amount, 0n)
  const sent = totalOut - change
  const estVsize = estimateVsize(inputs.map((x) => x.scriptType), outputs.map((o) => hex.decode(o.scriptHex)))
  return {
    psbtBytes: d.bytes,
    version: tx.version,
    locktime: tx.lockTime,
    inputs,
    outputs,
    totalIn, totalOut, fee, change, sent,
    deviceTotal: totalIn - change,
    estVsize,
    satPerVbyte: Math.round((Number(fee) * 100) / estVsize) / 100,
    feePercent: sent > 0n ? Number((fee * 10000n) / sent) / 100 : null,
    flags: {
      nonZeroLocktime: tx.lockTime !== 0,
      rbf: inputs.some((x) => x.sequence < 0xfffffffe),
      unusualVersion: tx.version !== 1 && tx.version !== 2,
      noChange: !changeTaken,
      multiAccount: !single,
      unverifiedAmounts: unverified,
      ownOutputShown: outputs.some((o) => o.kind === 'own'),
    },
  }
}

// ── device request ─────────────────────────────────────────────────────

export function toSignTx(a: PsbtAnalysis): PsbtSignTx {
  return {
    coin: 'Bitcoin',
    version: a.version, // hdwallet only sends it when set; the proto default is 1
    locktime: a.locktime,
    inputs: a.inputs.map((x) => ({
      addressNList: x.addressNList,
      scriptType: x.scriptType,
      amount: x.amount.toString(),
      vout: x.vout,
      txid: x.txid,
      sequence: x.sequence,
      ...(x.prevTxHex ? { hex: x.prevTxHex } : {}),
    })),
    outputs: a.outputs.map((o) => {
      const amount = o.amount.toString()
      if (o.deviceWillShow === 'hidden-change') {
        return { addressNList: o.owner!.addressNList, scriptType: o.owner!.scriptType, amount, isChange: true as const, addressType: 'change' as const }
      }
      // Output-level opReturnData keeps the PSBT's output order (top-level opReturnData is appended last).
      if (o.opReturn) return { opReturnData: hex.decode(o.opReturn.hex), amount: '0' as const, addressType: 'spend' as const }
      return { address: o.address!, amount, addressType: 'spend' as const }
    }),
  }
}

// ── finalize ───────────────────────────────────────────────────────────

/** Legacy SIGHASH_ALL digest (public btc-signer API has no legacy preimage). */
function legacySighash(tx: btc.Transaction, idx: number, script: Uint8Array): Uint8Array {
  const inputs = Array.from({ length: tx.inputsLength }, (_, j) => {
    const x = tx.getInput(j)
    return { txid: x.txid!, index: x.index!, sequence: x.sequence!, finalScriptSig: j === idx ? script : EMPTY }
  })
  const outputs = Array.from({ length: tx.outputsLength }, (_, j) => {
    const o = tx.getOutput(j)
    return { amount: o.amount!, script: o.script! }
  })
  const raw = btc.RawTx.encode({ version: tx.version, segwitFlag: false, inputs, outputs, witnesses: undefined, lockTime: tx.lockTime })
  return sha256d(raw, new Uint8Array([btc.SigHash.ALL, 0, 0, 0]))
}

const FINAL_KEYS = new Set(['txid', 'index', 'sequence', 'witnessUtxo', 'nonWitnessUtxo', 'unknown'])

/**
 * Check the device's serializedTx against the PSBT field by field (not by txid:
 * a legacy txid includes the scriptSig), verify every signature against the
 * PSBT's amounts, then write final_scriptSig / final_scriptwitness (BIP174 finalizer).
 */
export function finalizeSigned(a: PsbtAnalysis, serializedTxHex: string): { psbtBytes: Uint8Array; psbtBase64: string; txHex: string; txid: string } {
  const signedHex = serializedTxHex.trim().toLowerCase()
  let signed: RawTx
  try { signed = btc.RawTx.decode(hex.decode(signedHex)) } catch (e) { throw new Error(`Device returned an unreadable transaction: ${msg(e)}`) }
  const tx = btc.Transaction.fromPSBT(a.psbtBytes)
  const fail = (what: string): never => { throw new Error(`Signed transaction differs from the PSBT (${what}), refusing`) }
  if (signed.version !== tx.version) fail('version')
  if (signed.lockTime !== tx.lockTime) fail('locktime')
  if (signed.inputs.length !== tx.inputsLength || signed.inputs.length !== a.inputs.length) fail('input count')
  if (signed.outputs.length !== tx.outputsLength) fail('output count')
  signed.outputs.forEach((o, i) => {
    const p = tx.getOutput(i)
    if (o.amount !== p.amount || !eq(o.script, p.script)) fail(`output #${i}`)
  })

  signed.inputs.forEach((s, i) => {
    const p = tx.getInput(i)
    const ai = a.inputs[i]
    if (!eq(s.txid, p.txid) || s.index !== p.index || s.sequence !== p.sequence) fail(`input #${i} outpoint or sequence`)
    const witness = signed.witnesses?.[i] ?? []
    const pub = ai.pubkey
    let sig: Uint8Array
    let digest: Uint8Array
    if (ai.scriptType === 'p2pkh') {
      const parts = btc.Script.decode(s.finalScriptSig)
      const [sg, pk] = parts
      if (witness.length || parts.length !== 2 || !(sg instanceof Uint8Array) || !(pk instanceof Uint8Array) || !eq(pk, pub)) {
        return fail(`input #${i} scriptSig`)
      }
      if (!eq(btc.Script.encode([sg, pub]), s.finalScriptSig)) fail(`input #${i} scriptSig encoding`)
      sig = sg
      digest = legacySighash(tx, i, btc.p2pkh(pub).script)
    } else {
      // p2sh-p2wpkh scriptSig must be exactly the push of OUR derived redeem script.
      const expected = ai.scriptType === 'p2sh-p2wpkh' ? btc.Script.encode([btc.p2wpkh(pub).script]) : EMPTY
      if (!eq(s.finalScriptSig, expected)) fail(`input #${i} scriptSig`)
      if (witness.length !== 2 || !eq(witness[1], pub)) fail(`input #${i} witness`)
      sig = witness[0]
      digest = tx.preimageWitnessV0(i, btc.p2pkh(pub).script, btc.SigHash.ALL, ai.amount)
    }
    if (sig[sig.length - 1] !== btc.SigHash.ALL) fail(`input #${i} sighash`)
    let ok = false
    try { ok = secp256k1.verify(sig.subarray(0, -1), digest, pub, { prehash: false, format: 'der' }) } catch { ok = false }
    if (!ok) throw new Error(`Input #${i}: signature does not verify. Wrong seed or passphrase? Refusing.`)

    const clear: Record<string, undefined> = {}
    for (const k of Object.keys(p)) if (!FINAL_KEYS.has(k)) clear[k] = undefined
    tx.updateInput(i, { ...clear, finalScriptSig: s.finalScriptSig, finalScriptWitness: witness.length ? witness : undefined } as InputUpdate, true)
  })

  const txHex = hex.encode(tx.extract())
  if (txHex !== signedHex) throw new Error('Re-assembled transaction differs from the device output, refusing')
  const psbtBytes = tx.toPSBT(0)
  return { psbtBytes, psbtBase64: base64.encode(psbtBytes), txHex, txid: tx.id }
}

// ── watch-only build ───────────────────────────────────────────────────

export interface BuildPsbtParams {
  account: BtcPsbtAccount
  utxos: Array<{ txid: string; vout: number; value: bigint | string; path: number[]; scriptType: BtcPsbtScriptType }>
  /** Raw previous transactions by txid (hex); required for every input */
  prevTxs: Record<string, string>
  outputs: Array<{ address: string; value: bigint | string }>
  change?: { path: number[]; value: bigint | string }
}

function chainIndex(acct: Acct, path: number[], what: string): { chain: number; index: number } {
  const ok = path.length === 5 && acct.path.every((p, i) => p === path[i]) && (path[3] === 0 || path[3] === 1) && path[4] < H
  if (!ok) throw new Error(`${what}: path is not in this account`)
  return { chain: path[3], index: path[4] }
}

/** Full origin when the master fingerprint is known; otherwise Electrum's bare-xpub form (account fingerprint, m/c/i). */
function origin(acct: Acct, chain: number, index: number) {
  return acct.master !== undefined
    ? { fingerprint: acct.master, path: [...acct.path, chain, index] }
    : { fingerprint: acct.fp, path: [chain, index] }
}

export function buildPsbt(p: BuildPsbtParams): { psbtBytes: Uint8Array; psbtBase64: string; analysis: PsbtAnalysis } {
  const acct = loadAccount(p.account)
  if (!p.utxos.length || !p.outputs.length) throw new Error('Nothing to spend or nobody to pay')
  const tx = new btc.Transaction({ version: 2, lockTime: 0 })
  p.utxos.forEach((u, i) => {
    const what = `Input #${i}`
    if (u.scriptType !== acct.scriptType) throw new Error(`${what}: script type ${u.scriptType} is not this account's`)
    const { chain, index } = chainIndex(acct, u.path, what)
    const prevHex = p.prevTxs[u.txid]
    if (!prevHex) throw new Error(`${what}: previous transaction ${u.txid} is missing`)
    const prevBytes = hex.decode(prevHex)
    const prev = btc.RawTx.decode(prevBytes)
    if (txidOf(prev) !== u.txid) throw new Error(`${what}: previous transaction does not hash to ${u.txid}`)
    const out = prev.outputs[u.vout]
    if (!out) throw new Error(`${what}: previous transaction has no output ${u.vout}`)
    if (out.amount !== sats(u.value, what)) throw new Error(`${what}: value ${u.value} differs from the previous transaction (${out.amount})`)
    const d = derive(acct, chain, index)
    if (!eq(d.script, out.script)) throw new Error(`${what}: script does not match the key at its path, refusing`)
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      nonWitnessUtxo: prevBytes,
      ...(acct.scriptType !== 'p2pkh' ? { witnessUtxo: { script: out.script, amount: out.amount } } : {}),
      ...(d.redeemScript ? { redeemScript: d.redeemScript } : {}),
      bip32Derivation: [[d.pubkey, origin(acct, chain, index)]],
    })
  })
  p.outputs.forEach((o, i) => tx.addOutputAddress(o.address, sats(o.value, `Output #${i}`), btc.NETWORK))
  if (p.change) {
    const { chain, index } = chainIndex(acct, p.change.path, 'Change')
    const d = derive(acct, chain, index)
    tx.addOutput({
      script: d.script,
      amount: sats(p.change.value, 'Change'),
      ...(d.redeemScript ? { redeemScript: d.redeemScript } : {}),
      bip32Derivation: [[d.pubkey, origin(acct, chain, index)]],
    })
  }
  // PSBT_GLOBAL_XPUB only for a bare xpub, as Electrum's get_xpub_to_be_used_in_partial_tx writes it:
  // (account fp, empty path) with depth, parent fingerprint and child number zeroed so depth == path length.
  let psbtBytes = tx.toPSBT(0)
  if (acct.master === undefined) {
    const raw = RawPSBTV0.decode(psbtBytes)
    const xpubBytes = b58check.decode(acct.hd.publicExtendedKey).slice()
    xpubBytes.fill(0, 4, 13)
    raw.global.xpub = [[xpubBytes, { fingerprint: acct.fp, path: [] }]]
    psbtBytes = RawPSBTV0.encode(raw)
  }

  const analysis = analyze(psbtBytes, [p.account])
  if (p.change && !analysis.outputs.some((o) => o.kind === 'change')) {
    throw new Error('Change output would not be recognised as change by the KeepKey, refusing')
  }
  return { psbtBytes, psbtBase64: base64.encode(psbtBytes), analysis }
}

// ── broadcast ──────────────────────────────────────────────────────────

export interface BroadcastOutput { amount: bigint; scriptHex: string; address?: string; opReturnHex?: string }

function describeOutput(o: { amount: bigint; script: Uint8Array }): BroadcastOutput {
  const out: BroadcastOutput = { amount: o.amount, scriptHex: hex.encode(o.script) }
  const data = opReturnData(o.script)
  if (data) out.opReturnHex = hex.encode(data)
  else { try { out.address = scriptToAddress(o.script) } catch { /* shown as script hex */ } }
  return out
}

/** Signed/finalized PSBT (finalized here if every input has its signatures) or raw tx hex, ready for broadcastBtcTx. */
export function parseForBroadcast(input: Uint8Array | string): { txHex: string; txid: string; outputs: BroadcastOutput[]; fee: bigint | null } {
  const d = decode(input)
  if (d.kind === 'rawtx') {
    // A raw tx carries no input amounts: fee unknown, never a guess.
    return { txHex: hex.encode(d.bytes), txid: txidOf(d.tx), outputs: d.tx.outputs.map(describeOutput), fee: null }
  }
  const tx = d.tx
  if (!tx.isFinal) {
    try { tx.finalize() } catch (e) { throw new Error(`PSBT is not fully signed: ${msg(e)}`) }
  }
  // Only hash-checked NON_WITNESS_UTXO amounts count: witness_utxo can be edited after signing.
  let totalIn: bigint | null = 0n
  for (let i = 0; i < tx.inputsLength && totalIn !== null; i++) {
    const prev = tx.getInput(i).nonWitnessUtxo ? prevOut(tx, i) : undefined
    totalIn = prev?.verified ? totalIn + prev.amount : null
  }
  const outputs = Array.from({ length: tx.outputsLength }, (_, i) => {
    const o = tx.getOutput(i)
    return { amount: o.amount!, script: o.script! }
  })
  const totalOut = outputs.reduce((s, o) => s + o.amount, 0n)
  const fee = totalIn === null ? null : totalIn - totalOut
  if (fee !== null && fee < 0n) throw new Error('Outputs spend more than the inputs, refusing')
  return { txHex: hex.encode(tx.toBytes(true, true)), txid: tx.id, outputs: outputs.map(describeOutput), fee }
}
