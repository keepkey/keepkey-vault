import { describe, expect, it } from 'bun:test'
import * as btc from '@scure/btc-signer'
import { _DebugPSBT, RawPSBTV0 } from '@scure/btc-signer/psbt'
import { HDKey } from '@scure/bip32'
import { base64, hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { mnemonicToSeedSync } from 'bip39'
import vectors from './bip174-vectors.json'
import { b58check, formatPath } from './codec'
import {
  MAX_MONEY, alreadySigned, analyze, buildPsbt, decode, finalizeSigned, parseForBroadcast, toSignTx,
  type BtcPsbtAccount, type BtcPsbtScriptType, type PsbtAnalysis,
} from './psbt'

// Public BIP-39 test mnemonic (BIP84/BIP86 test vectors). Never real funds.
const MASTER = HDKey.fromMasterSeed(new Uint8Array(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')))
const MASTER_FP = hex.decode('73c5da0a')
const H = 0x80000000
const PURPOSE: Record<BtcPsbtScriptType, number> = { p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84, p2tr: 86 }
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const UNKNOWN = { allowUnknownOutputs: true }

function account(scriptType: BtcPsbtScriptType, withFp = true, acct = 0): BtcPsbtAccount {
  const path = [PURPOSE[scriptType] + H, H, acct + H]
  return { scriptType, path, xpub: MASTER.derive(formatPath(path)).publicExtendedKey, ...(withFp ? { masterFingerprint: MASTER_FP } : {}) }
}

function keyAt(path: number[]) {
  return MASTER.derive(formatPath(path))
}

function scriptAt(scriptType: BtcPsbtScriptType, path: number[]): Uint8Array {
  const pub = keyAt(path).publicKey!
  if (scriptType === 'p2pkh') return btc.p2pkh(pub).script
  if (scriptType === 'p2wpkh') return btc.p2wpkh(pub).script
  if (scriptType === 'p2tr') return btc.p2tr(pub.subarray(1)).script
  return btc.p2sh(btc.p2wpkh(pub)).script
}

const txid = (raw: Uint8Array) => hex.encode(sha256(sha256(raw)).reverse())

/** A synthetic funding tx paying `amount` to `script` at vout 1 (vout 0 is a decoy). */
function fundingTx(script: Uint8Array, amount: bigint, seed: string): { hex: string; txid: string } {
  const raw = btc.RawTx.encode({
    version: 2, segwitFlag: false, lockTime: 0, witnesses: undefined,
    inputs: [{ txid: sha256(new TextEncoder().encode(seed)), index: 0, finalScriptSig: new Uint8Array(0), sequence: 0xffffffff }],
    outputs: [{ amount: 1234n, script: btc.p2wpkh(keyAt([84 + H, H, 9 + H, 0, 0]).publicKey!).script }, { amount, script }],
  })
  return { hex: hex.encode(raw), txid: txid(raw) }
}

interface Coin { chain: number; index: number; value: bigint; seed: string }

function build(scriptType: BtcPsbtScriptType, coins: Coin[], opts: { withFp?: boolean; pay?: bigint; change?: { index: number; value: bigint } } = {}) {
  const acct = account(scriptType, opts.withFp ?? true)
  const prevTxs: Record<string, string> = {}
  const utxos = coins.map((c) => {
    const path = [...acct.path, c.chain, c.index]
    const f = fundingTx(scriptAt(scriptType, path), c.value, c.seed)
    prevTxs[f.txid] = f.hex
    return { txid: f.txid, vout: 1, value: c.value, path, scriptType }
  })
  const change = opts.change ? { path: [...acct.path, 1, opts.change.index], value: opts.change.value } : undefined
  return { acct, ...buildPsbt({ account: acct, utxos, prevTxs, outputs: [{ address: RECIPIENT, value: opts.pay ?? 60_000n }], change }) }
}

/** What the KeepKey does: sign each input at the addressNList Desktop sends, return serializedTx. */
function signLikeDevice(a: PsbtAnalysis): string {
  const req = toSignTx(a)
  const tx = btc.Transaction.fromPSBT(a.psbtBytes, UNKNOWN)
  req.inputs.forEach((inp, i) => tx.signIdx(keyAt(inp.addressNList).privateKey!, i))
  tx.finalize()
  return hex.encode(tx.extract())
}

function mutate(psbt: Uint8Array, fn: (tx: btc.Transaction) => void): Uint8Array {
  const tx = btc.Transaction.fromPSBT(psbt, UNKNOWN)
  fn(tx)
  return tx.toPSBT(0)
}

/** Point output #idx at our key `path` (script + derivation), replacing its old derivation. */
function replaceOutput(tx: btc.Transaction, idx: number, scriptType: BtcPsbtScriptType, path: number[]) {
  tx.updateOutput(idx, { bip32Derivation: undefined })
  tx.updateOutput(idx, { script: scriptAt(scriptType, path), bip32Derivation: [[keyAt(path).publicKey!, { fingerprint: 0x73c5da0a, path }]] })
}

const TWO_COINS: Coin[] = [
  { chain: 0, index: 0, value: 50_000n, seed: 'a' },
  { chain: 0, index: 1, value: 40_000n, seed: 'b' },
]

describe('decode', () => {
  it('rejects every BIP-174 invalid vector', () => {
    for (const v of vectors.invalid) {
      // The first vector is a plain network transaction: decoded as raw tx, never as a PSBT.
      let kind: string | undefined
      try { kind = decode(v.hex).kind } catch { kind = undefined }
      expect(kind, v.case).not.toBe('psbt')
      expect(() => analyze(v.hex, [account('p2wpkh')]), v.case).toThrow()
    }
  })

  it('parses every BIP-174 valid vector as PSBT v0', () => {
    for (const v of vectors.valid) {
      const d = decode(v.hex)
      expect(d.kind, v.case).toBe('psbt')
    }
  })

  it('detects binary, base64, base64 file bytes and hex encodings', () => {
    const bytes = hex.decode(vectors.valid[0].hex)
    const b64 = base64.encode(bytes)
    for (const input of [bytes, b64, new TextEncoder().encode(`${b64}\n`), vectors.valid[0].hex, vectors.valid[0].hex.toUpperCase()]) {
      const d = decode(input)
      expect(d.kind).toBe('psbt')
      expect(hex.encode(d.bytes)).toBe(vectors.valid[0].hex)
    }
  })

  it('treats a network transaction as raw tx and refuses garbage and oversize input', () => {
    expect(decode(vectors.invalid[0].hex).kind).toBe('rawtx')
    expect(() => decode('hello world')).toThrow(/Not a PSBT/)
    expect(() => decode('a'.repeat(1024 * 1024 + 2))).toThrow(/1 MB/)
  })

  it('refuses PSBT version 2', () => {
    const tx = new btc.Transaction({ PSBTVersion: 2 })
    const f = fundingTx(scriptAt('p2wpkh', [84 + H, H, H, 0, 0]), 10_000n, 'v2')
    tx.addInput({ txid: f.txid, index: 1, nonWitnessUtxo: f.hex })
    tx.addOutputAddress(RECIPIENT, 5_000n, btc.NETWORK)
    expect(() => decode(tx.toPSBT(2))).toThrow(/version 0/)
  })
})

describe('round trip with the test mnemonic', () => {
  it('BIP86 Taproot: x-only origins, derived change and verified Schnorr signatures', () => {
    for (const withFp of [true, false]) {
      const { acct, psbtBytes, analysis } = build('p2tr', TWO_COINS, { withFp, change: { index: 0, value: 29_000n } })
      expect(analysis.inputs[0].address).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr')
      expect(analysis.outputs[1].deviceWillShow).toBe('hidden-change')
      const input = btc.Transaction.fromPSBT(psbtBytes).getInput(0)
      expect(input.tapInternalKey).toHaveLength(32)
      expect(input.tapBip32Derivation![0][0]).toEqual(input.tapInternalKey!)
      expect(input.tapBip32Derivation![0][1].hashes).toEqual([])
      expect(input.tapBip32Derivation![0][1].der.path).toEqual(withFp ? [86 + H, H, H, 0, 0] : [0, 0])
      expect(toSignTx(analysis).inputs[0].scriptType).toBe('p2tr')
      expect(toSignTx(analysis).outputs[1]).toMatchObject({ scriptType: 'p2tr', addressNList: [86 + H, H, H, 1, 0] })
      const signed = signLikeDevice(analysis)
      const fin = finalizeSigned(analysis, signed)
      expect(btc.RawTx.decode(hex.decode(signed)).witnesses![0][0]).toHaveLength(64)
      expect(parseForBroadcast(fin.psbtBytes).fee).toBe(1000n)
      expect(alreadySigned(fin.psbtBytes)?.txid).toBe(fin.txid)
      // BIP371 permits witness UTXOs alone for Taproot: all values and scripts
      // are bound by every SIGHASH_DEFAULT signature.
      const witnessOnly = mutate(psbtBytes, tx => { for (let i = 0; i < 2; i++) tx.updateInput(i, { nonWitnessUtxo: undefined }, true) })
      const a = analyze(witnessOnly, [acct])
      expect(a.flags.unverifiedAmounts).toBe(true)
      expect(finalizeSigned(a, signLikeDevice(a)).txHex).toHaveLength(signed.length)
      const wrongAmount = { ...analysis, inputs: analysis.inputs.map((x, i) => ({ ...x, amount: x.amount + (i === 1 ? 1n : 0n) })) }
      expect(() => finalizeSigned(wrongAmount, signed)).toThrow(/Taproot signature does not verify/)
    }
  })

  it('Taproot rejects unsupported sighashes, script trees, wrong internal keys and altered signatures', () => {
    const { acct, psbtBytes, analysis } = build('p2tr', TWO_COINS, { change: { index: 0, value: 29_000n } })
    for (const sighashType of [btc.SigHash.ALL, btc.SigHash.NONE, btc.SigHash.SINGLE, btc.SigHash.ALL_ANYONECANPAY]) {
      expect(() => analyze(mutate(psbtBytes, t => t.updateInput(0, { sighashType }, true)), [acct])).toThrow(/SIGHASH_DEFAULT/)
    }
    expect(() => analyze(mutate(psbtBytes, t => t.updateInput(0, { tapMerkleRoot: new Uint8Array(32) }, true)), [acct])).toThrow(/no script trees/)
    expect(() => analyze(mutate(psbtBytes, t => {
      const [[key, v]] = t.getInput(0).tapBip32Derivation!
      t.updateInput(0, { tapBip32Derivation: undefined }, true)
      t.updateInput(0, { tapBip32Derivation: [[key, { ...v, hashes: [new Uint8Array(32)] }]] }, true)
    }), [acct])).toThrow(/no script trees/)
    expect(() => analyze(mutate(psbtBytes, t => t.updateInput(0, { tapInternalKey: keyAt([86 + H, H, H, 0, 1]).publicKey!.subarray(1) }, true)), [acct])).toThrow(/internal key/)
    const signed = btc.RawTx.decode(hex.decode(signLikeDevice(analysis)))
    signed.witnesses![0][0][0] ^= 1
    expect(() => finalizeSigned(analysis, hex.encode(btc.RawTx.encode(signed)))).toThrow(/Taproot signature does not verify/)
    signed.witnesses![0].push(new Uint8Array([0x50]))
    expect(() => finalizeSigned(analysis, hex.encode(btc.RawTx.encode(signed)))).toThrow(/Taproot witness/)
  })

  it('signs mixed Taproot and native SegWit inputs with full previous transactions', () => {
    const segwit = build('p2wpkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    const taproot = build('p2tr', [{ chain: 0, index: 0, value: 10000n, seed: 'mixed-taproot' }], { pay: 9000n })
    const tx = btc.Transaction.fromPSBT(segwit.psbtBytes)
    tx.addInput(btc.Transaction.fromPSBT(taproot.psbtBytes).getInput(0))
    const a = analyze(tx.toPSBT(0), [segwit.acct, taproot.acct])
    expect(a.flags.multiAccount).toBe(true)
    expect(a.outputs[1].deviceWillShow).toBe('address')
    expect(parseForBroadcast(finalizeSigned(a, signLikeDevice(a)).psbtBytes).fee).toBe(11000n)
  })

  it('p2wpkh, full paths: build -> analyze -> toSignTx -> sign -> finalize -> broadcast', () => {
    const { psbtBytes, psbtBase64, analysis } = build('p2wpkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    expect(base64.decode(psbtBase64)).toEqual(psbtBytes)

    // Real master fingerprint + full path on inputs and change; no global xpub (it would only leak the account).
    const tx = btc.Transaction.fromPSBT(psbtBytes)
    expect(tx.getInput(0).bip32Derivation![0][1]).toEqual({ fingerprint: 0x73c5da0a, path: [84 + H, H, H, 0, 0] })
    expect(tx.getOutput(1).bip32Derivation![0][1]).toEqual({ fingerprint: 0x73c5da0a, path: [84 + H, H, H, 1, 0] })
    expect(tx.getInput(0).nonWitnessUtxo).toBeDefined()
    expect(tx.getInput(0).witnessUtxo!.amount).toBe(50_000n)
    expect((tx as any).global.xpub).toBeUndefined()

    // BIP84 test vector addresses.
    expect(analysis.inputs[0].address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')
    expect(analysis.inputs[1].address).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g')
    expect(analysis.outputs[1].address).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el')
    expect(analysis.outputs.map((o) => [o.kind, o.deviceWillShow])).toEqual([['payment', 'address'], ['change', 'hidden-change']])
    expect(analysis.fee).toBe(1_000n)
    expect(analysis.sent).toBe(60_000n)
    expect(analysis.deviceTotal).toBe(61_000n)
    expect(analysis.inputs.every((i) => i.amountVerified)).toBe(true)
    expect(analysis.flags).toEqual({ nonZeroLocktime: false, rbf: false, unusualVersion: false, noChange: false, multiAccount: false, unverifiedAmounts: false, ownOutputShown: false })
    expect(analysis.estVsize).toBe(209)

    const req = toSignTx(analysis)
    expect(req).toEqual({
      coin: 'Bitcoin',
      version: 2,
      locktime: 0,
      inputs: analysis.inputs.map((i) => ({
        addressNList: i.addressNList, scriptType: 'p2wpkh', amount: String(i.amount), vout: 1, txid: i.txid, sequence: 0xffffffff, hex: i.prevTxHex,
      })),
      outputs: [
        { address: RECIPIENT, amount: '60000', addressType: 'spend' },
        { addressNList: [84 + H, H, H, 1, 0], scriptType: 'p2wpkh', amount: '29000', isChange: true, addressType: 'change' },
      ],
    })

    const serializedTx = signLikeDevice(analysis)
    const fin = finalizeSigned(analysis, serializedTx)
    // Electrum requires an explicit empty scriptSig on native SegWit inputs.
    expect(RawPSBTV0.decode(fin.psbtBytes).inputs[0].finalScriptSig).toEqual(new Uint8Array())
    expect(fin.txHex).toBe(serializedTx)
    const done = btc.Transaction.fromPSBT(fin.psbtBytes)
    expect(done.isFinal).toBe(true)
    expect(Object.keys(done.getInput(0)).sort()).toEqual(['finalScriptSig', 'finalScriptWitness', 'index', 'nonWitnessUtxo', 'sequence', 'txid', 'witnessUtxo'])

    const b = parseForBroadcast(fin.psbtBase64)
    expect(b).toEqual({
      txHex: serializedTx, txid: fin.txid, fee: 1_000n,
      outputs: [
        { amount: 60_000n, scriptHex: analysis.outputs[0].scriptHex, address: RECIPIENT },
        { amount: 29_000n, scriptHex: analysis.outputs[1].scriptHex, address: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el' },
      ],
    })
    const raw = parseForBroadcast(serializedTx)
    expect(raw.txid).toBe(fin.txid)
    expect(raw.fee).toBeNull()
    // witness_utxo alone is editable after signing: fee unknown.
    const noPrev = mutate(fin.psbtBytes, (t) => { for (let i = 0; i < 2; i++) t.updateInput(i, { nonWitnessUtxo: undefined }, true) })
    expect(parseForBroadcast(noPrev).fee).toBeNull()
  })

  it('p2wpkh, Electrum relative paths when only the account xpub is known', () => {
    const { acct, psbtBytes, analysis } = build('p2wpkh', TWO_COINS, { withFp: false, change: { index: 0, value: 29_000n } })
    const accountFp = HDKey.fromExtendedKey(acct.xpub as string).fingerprint
    const tx = btc.Transaction.fromPSBT(psbtBytes)
    expect(tx.getInput(1).bip32Derivation![0][1]).toEqual({ fingerprint: accountFp, path: [0, 1] })
    expect(tx.getOutput(1).bip32Derivation![0][1]).toEqual({ fingerprint: accountFp, path: [1, 0] })
    // Electrum's form: depth, parent fingerprint and child number zeroed so depth == path length (BIP-174).
    const [[xpubBytes, xpubOrigin]] = (tx as any).global.xpub
    expect(xpubOrigin).toEqual({ fingerprint: accountFp, path: [] })
    const real = HDKey.fromExtendedKey(acct.xpub as string)
    const g = HDKey.fromExtendedKey(b58check.encode(xpubBytes))
    expect([g.depth, g.parentFingerprint, g.index]).toEqual([xpubOrigin.path.length, 0, 0])
    expect(g.publicKey).toEqual(real.publicKey)
    expect(g.chainCode).toEqual(real.chainCode)
    expect(analysis.inputs[1].addressNList).toEqual([84 + H, H, H, 0, 1])
    expect(analysis.outputs[1].kind).toBe('change')
    expect(finalizeSigned(analysis, signLikeDevice(analysis)).txid).toHaveLength(64)
  })

  it('p2sh-p2wpkh: scriptSig is the push of our redeem script', () => {
    const { analysis } = build('p2sh-p2wpkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    expect(analysis.inputs[0].address).toBe('37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf')
    const signed = signLikeDevice(analysis)
    expect(finalizeSigned(analysis, signed).txHex).toBe(signed)
    expect(parseForBroadcast(signed).txid).toBe(finalizeSigned(analysis, signed).txid)
  })

  it('p2pkh: previous tx goes to the device and legacy signatures verify', () => {
    const { analysis } = build('p2pkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    expect(analysis.inputs[0].address).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA')
    expect(toSignTx(analysis).inputs.every((i) => i.hex && i.hex.length > 0)).toBe(true)
    const signed = signLikeDevice(analysis)
    expect(finalizeSigned(analysis, signed).txHex).toBe(signed)
  })

  it('accepts Electrum legacy finalization with empty witnesses, preserving the transaction and fee', () => {
    const { analysis } = build('p2pkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    const fin = finalizeSigned(analysis, signLikeDevice(analysis))
    const raw = _DebugPSBT.decode(fin.psbtBytes)
    raw.items[1]['08'] = new Uint8Array([0])
    raw.items[2]['08'] = new Uint8Array([0])
    const electrum = _DebugPSBT.encode(raw)
    expect(parseForBroadcast(electrum)).toEqual(parseForBroadcast(fin.psbtBytes))
    expect(alreadySigned(electrum)?.txid).toBe(fin.txid)
    expect(() => analyze(electrum, [account('p2pkh')])).toThrow(/already signed/)
  })

  it('does not discard an empty witness on a SegWit input or a missing legacy signature', () => {
    for (const scriptType of ['p2wpkh', 'p2pkh'] as const) {
      const { analysis } = build(scriptType, TWO_COINS, { change: { index: 0, value: 29_000n } })
      const fin = finalizeSigned(analysis, signLikeDevice(analysis))
      const raw = _DebugPSBT.decode(fin.psbtBytes)
      raw.items[1]['08'] = new Uint8Array([0])
      if (scriptType === 'p2pkh') delete raw.items[1]['07']
      expect(() => parseForBroadcast(_DebugPSBT.encode(raw))).toThrow()
    }
  })

  it('accepts zero fingerprints (full path) and PSBTs with no derivation at all', () => {
    const { psbtBytes } = build('p2wpkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    const acct = account('p2wpkh', false)
    const zeroFp = mutate(psbtBytes, (tx) => {
      for (let i = 0; i < 2; i++) {
        const [[pub, der]] = tx.getInput(i).bip32Derivation!
        tx.updateInput(i, { bip32Derivation: undefined }, true)
        tx.updateInput(i, { bip32Derivation: [[pub, { fingerprint: 0, path: der.path }]] }, true)
      }
    })
    expect(analyze(zeroFp, [acct]).inputs.map((i) => i.addressNList[4])).toEqual([0, 1])

    const stripped = mutate(psbtBytes, (tx) => {
      for (let i = 0; i < 2; i++) tx.updateInput(i, { bip32Derivation: undefined }, true)
      tx.updateOutput(1, { bip32Derivation: undefined })
    })
    const a = analyze(stripped, [acct])
    expect(a.inputs.map((i) => i.addressNList)).toEqual([[84 + H, H, H, 0, 0], [84 + H, H, H, 0, 1]])
    // The bounded scan gives up on a wallet that isn't ours.
    expect(() => analyze(stripped, [account('p2wpkh', false, 1)])).toThrow(/Not this wallet/)
    // Change without a key path is shown on the device as an address, never hidden.
    expect(a.outputs[1].deviceWillShow).toBe('address')
    expect(finalizeSigned(a, signLikeDevice(a)).txHex).toHaveLength(signLikeDevice(a).length)
  })

  it('foreign-fingerprint decoy entries are skipped; our fingerprint on a key we did not derive is refused', () => {
    const { psbtBytes } = build('p2wpkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    const other = keyAt([84 + H, H, 9 + H, 0, 0]).publicKey!
    const withEntries = (f: (pub: Uint8Array, path: number[]) => Array<[Uint8Array, { fingerprint: number; path: number[] }]>) => mutate(psbtBytes, (tx) => {
      for (let i = 0; i < 2; i++) {
        const [[pub, der]] = tx.getInput(i).bip32Derivation!
        tx.updateInput(i, { bip32Derivation: undefined }, true)
        tx.updateInput(i, { bip32Derivation: f(pub, der.path) }, true)
      }
    })
    const decoy = withEntries((pub, path) => [[other, { fingerprint: 0xdeadbeef, path }], [pub, { fingerprint: 0x73c5da0a, path }]])
    expect(analyze(decoy, [account('p2wpkh')]).inputs.map((i) => i.addressNList[4])).toEqual([0, 1])
    const forged = withEntries((_pub, path) => [[other, { fingerprint: 0x73c5da0a, path }]])
    expect(() => analyze(forged, [account('p2wpkh')])).toThrow(/Not this wallet/)
  })
})

describe('refusals and device parity', () => {
  it('refuses multi-input segwit without previous txs, allows a single input', () => {
    const { psbtBytes } = build('p2wpkh', TWO_COINS)
    const noPrev = mutate(psbtBytes, (tx) => { for (let i = 0; i < 2; i++) tx.updateInput(i, { nonWitnessUtxo: undefined }, true) })
    expect(() => analyze(noPrev, [account('p2wpkh')])).toThrow(/full previous transactions/)

    const one = build('p2wpkh', [TWO_COINS[0]], { pay: 40_000n })
    const single = mutate(one.psbtBytes, (tx) => tx.updateInput(0, { nonWitnessUtxo: undefined }, true))
    const a = analyze(single, [account('p2wpkh')])
    expect(a.flags.unverifiedAmounts).toBe(true)
    expect(a.inputs[0].amountVerified).toBe(false)
    expect(toSignTx(a).inputs[0].hex).toBeUndefined()
  })

  it('refuses a mismatched NON_WITNESS_UTXO', () => {
    const { psbtBytes } = build('p2wpkh', TWO_COINS)
    const other = fundingTx(scriptAt('p2wpkh', [84 + H, H, H, 0, 0]), 50_000n, 'not-a')
    const bad = mutate(psbtBytes, (tx) => tx.updateInput(0, { nonWitnessUtxo: other.hex }, true))
    expect(() => analyze(bad, [account('p2wpkh')])).toThrow(/does not hash/)

    // btc-signer refuses these at decode; prevOut repeats the check as a backstop.
    const w = btc.Transaction.fromPSBT(psbtBytes).getInput(0).witnessUtxo!
    const lowAmount = mutate(psbtBytes, (tx) => tx.updateInput(0, { witnessUtxo: { ...w, amount: w.amount - 1n } }, true))
    expect(() => analyze(lowAmount, [account('p2wpkh')])).toThrow(/witness UTXO disagrees|witnessUtxo different from nonWitnessUtxo/)
    const otherScript = mutate(psbtBytes, (tx) => tx.updateInput(0, { witnessUtxo: { ...w, script: scriptAt('p2wpkh', [84 + H, H, H, 0, 1]) } }, true))
    expect(() => analyze(otherScript, [account('p2wpkh')])).toThrow(/witness UTXO disagrees|witnessUtxo different from nonWitnessUtxo/)
  })

  it('refuses non-minimal pushes that btc-signer reads as a standard address', () => {
    const { psbtBytes } = build('p2wpkh', TWO_COINS)
    const h20 = '11'.repeat(20)
    for (const s of [`004c14${h20}`, `76a94c14${h20}88ac`]) {
      const bad = mutate(psbtBytes, (tx) => tx.addOutput({ script: hex.decode(s), amount: 1000n }))
      expect(() => analyze(bad, [account('p2wpkh')])).toThrow(/non-canonical/)
      // A raw tx paying it shows the script, never a look-alike address.
      expect(parseForBroadcast(fundingTx(hex.decode(s), 1000n, s).hex).outputs[1]).toEqual({ amount: 1000n, scriptHex: s })
    }
  })

  it('refuses a swapped change script', () => {
    const { psbtBytes } = build('p2wpkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    const bad = mutate(psbtBytes, (tx) => tx.updateOutput(1, { script: btc.OutScript.encode(btc.Address(btc.NETWORK).decode(RECIPIENT)) }))
    expect(() => analyze(bad, [account('p2wpkh')])).toThrow(/change mismatch/)
  })

  it('shows change beyond the gap, in another purpose, or a second change output as an address', () => {
    const { psbtBytes } = build('p2wpkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    const far = [84 + H, H, H, 1, 1001]
    const beyondGap = mutate(psbtBytes, (tx) => replaceOutput(tx, 1, 'p2wpkh', far))
    let a = analyze(beyondGap, [account('p2wpkh')])
    expect([a.outputs[1].kind, a.outputs[1].deviceWillShow, a.flags.noChange]).toEqual(['own', 'address', true])
    expect(toSignTx(a).outputs[1]).toEqual({ address: a.outputs[1].address!, amount: '29000', addressType: 'spend' })

    const legacy = [44 + H, H, H, 1, 0]
    const otherPurpose = mutate(psbtBytes, (tx) => replaceOutput(tx, 1, 'p2pkh', legacy))
    a = analyze(otherPurpose, [account('p2wpkh'), account('p2pkh')])
    expect([a.outputs[1].kind, a.outputs[1].deviceWillShow]).toEqual(['own', 'address'])

    const second = [84 + H, H, H, 1, 1]
    const twoChange = mutate(psbtBytes, (tx) => tx.addOutput({
      script: scriptAt('p2wpkh', second), amount: 500n, bip32Derivation: [[keyAt(second).publicKey!, { fingerprint: 0x73c5da0a, path: second }]],
    }))
    a = analyze(twoChange, [account('p2wpkh')])
    expect(a.outputs.map((o) => o.deviceWillShow)).toEqual(['address', 'hidden-change', 'address'])
    expect(a.flags.ownOutputShown).toBe(true)
  })

  it('refuses a foreign input', () => {
    const { psbtBytes } = build('p2wpkh', TWO_COINS)
    const foreignPath = [84 + H, H, 5 + H, 0, 0]
    const f = fundingTx(scriptAt('p2wpkh', foreignPath), 70_000n, 'foreign')
    const bad = mutate(psbtBytes, (tx) => tx.addInput({
      txid: f.txid, index: 1, nonWitnessUtxo: f.hex,
      bip32Derivation: [[keyAt(foreignPath).publicKey!, { fingerprint: 0x73c5da0a, path: foreignPath }]],
    }))
    expect(() => analyze(bad, [account('p2wpkh')])).toThrow(/#2 are not from this wallet/)
    expect(() => analyze(psbtBytes, [account('p2wpkh', true, 1)])).toThrow(/Not this wallet/)
  })

  it('names a Taproot input instead of calling it foreign', () => {
    const { psbtBytes } = build('p2wpkh', TWO_COINS)
    const f = fundingTx(btc.p2tr(keyAt([86 + H, H, H, 0, 0]).publicKey!.subarray(1)).script, 70_000n, 'taproot')
    const bad = mutate(psbtBytes, (tx) => tx.addInput({ txid: f.txid, index: 1, nonWitnessUtxo: f.hex }))
    expect(() => analyze(bad, [account('p2wpkh')])).toThrow(/Input #2 is a Taproot \(bc1p\) coin/)
  })

  it('refuses sighash NONE, already-signed inputs, duplicate outpoints and amounts above MAX_MONEY', () => {
    const { psbtBytes, analysis } = build('p2wpkh', TWO_COINS)
    const acct = [account('p2wpkh')]
    expect(() => analyze(mutate(psbtBytes, (tx) => tx.updateInput(0, { sighashType: btc.SigHash.NONE }, true)), acct)).toThrow(/SIGHASH_ALL/)
    expect(() => analyze(mutate(psbtBytes, (tx) => tx.signIdx(keyAt(analysis.inputs[0].addressNList).privateKey!, 0)), acct)).toThrow(/already signed/)
    expect(() => analyze(mutate(psbtBytes, (tx) => tx.addInput(tx.getInput(0))), acct)).toThrow(/same coin/)
    expect(() => analyze(mutate(psbtBytes, (tx) => tx.updateOutput(0, { amount: MAX_MONEY + 1n })), acct)).toThrow(/outside 0\.\.21M/)
  })

  it('refuses a legacy input without its previous transaction', () => {
    const { psbtBytes } = build('p2pkh', [TWO_COINS[0]], { pay: 40_000n })
    const bad = mutate(psbtBytes, (tx) => {
      const out = tx.getInput(0).nonWitnessUtxo!.outputs[1]
      tx.updateInput(0, { nonWitnessUtxo: undefined, witnessUtxo: out }, true)
    })
    expect(() => analyze(bad, [account('p2pkh')])).toThrow(/legacy/)
  })

  it('passes OP_RETURN through in order with printable text, refuses witness v2 outputs', () => {
    const { psbtBytes } = build('p2wpkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    const data = new Uint8Array([...new TextEncoder().encode('hi'), 0x07, 0xe2, 0x80, 0xae, ...new TextEncoder().encode('there')])
    const withMemo = mutate(psbtBytes, (tx) => tx.addOutput({ script: new Uint8Array([0x6a, data.length, ...data]), amount: 0n }))
    const a = analyze(withMemo, [account('p2wpkh')])
    expect(a.outputs[2]).toMatchObject({ kind: 'op-return', deviceWillShow: 'op-return', opReturn: { hex: hex.encode(data), text: 'hithere' } })
    expect(toSignTx(a).outputs[2]).toEqual({ opReturnData: data, amount: '0', addressType: 'spend' })

    const v2 = mutate(psbtBytes, (tx) => tx.addOutput({ script: new Uint8Array([0x52, 20, ...new Uint8Array(20).fill(1)]), amount: 1000n }))
    expect(() => analyze(v2, [account('p2wpkh')])).toThrow(/unsupported output script/)
  })

  it('refuses a device output that differs from the PSBT or whose signature does not verify', () => {
    const { analysis } = build('p2wpkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    const signed = btc.RawTx.decode(hex.decode(signLikeDevice(analysis)))

    const moreToRecipient = btc.RawTx.encode({ ...signed, outputs: [{ ...signed.outputs[0], amount: 61_000n }, signed.outputs[1]] })
    expect(() => finalizeSigned(analysis, hex.encode(moreToRecipient))).toThrow(/output #0/)

    const sig = signed.witnesses![0][0].slice()
    sig[10] ^= 1
    const badSig = btc.RawTx.encode({ ...signed, witnesses: [[sig, signed.witnesses![0][1]], signed.witnesses![1]] })
    expect(() => finalizeSigned(analysis, hex.encode(badSig))).toThrow(/does not verify/)

  })
})

describe('alreadySigned', () => {
  it('returns the transaction of a fully signed PSBT, null while any input is unsigned', () => {
    const { psbtBytes, analysis } = build('p2wpkh', TWO_COINS, { change: { index: 0, value: 29_000n } })
    expect(alreadySigned(psbtBytes)).toBeNull()
    const halfSigned = mutate(psbtBytes, (tx) => tx.signIdx(keyAt(analysis.inputs[0].addressNList).privateKey!, 0))
    expect(alreadySigned(halfSigned)).toBeNull()

    const fin = finalizeSigned(analysis, signLikeDevice(analysis))
    expect(alreadySigned(fin.psbtBytes)).toMatchObject({ txHex: fin.txHex, txid: fin.txid })
    expect(alreadySigned(fin.psbtBase64)?.txid).toBe(fin.txid)
  })
})
