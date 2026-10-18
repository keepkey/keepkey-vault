import { describe, expect, it } from 'bun:test'
import * as btc from '@scure/btc-signer'
import { RawPSBTV0 } from '@scure/btc-signer/psbt'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { mnemonicToSeedSync } from 'bip39'
import type { BtcBackend, BtcUtxo } from '../btc-backend/types'
import { estimatefeeToSatVb } from '../btc-backend/blockbook'
import { feerateToSatVb } from '../btc-backend/core'
import { formatPath } from './codec'
import { feeFromPrevTxs, parseForBroadcast, toSignTx, type BtcPsbtAccount } from './psbt'
import { buildWatchOnlyPsbt } from './watch-only-build'

// Public BIP-39 test mnemonic (BIP84 test vectors). Never real funds.
const MASTER = HDKey.fromMasterSeed(new Uint8Array(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')))
const H = 0x80000000
const PATH = [84 + H, H, H]
// BIP84 test vectors: account 0 zpub, m/84'/0'/0'/0/0 and m/84'/0'/0'/1/0.
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const NETWORK = 'bip122:000000000019d6689c085ae165831e93'
const BITCOIN = { id: 'bitcoin', coin: 'Bitcoin', symbol: 'BTC', networkId: NETWORK, decimals: 8, scriptType: 'p2wpkh' } as any

const keyAt = (path: number[]) => MASTER.derive(formatPath(path))
const scriptAt = (path: number[]) => btc.p2wpkh(keyAt(path).publicKey!).script

function account(withFp: boolean): BtcPsbtAccount & { xpub: string } {
  return { scriptType: 'p2wpkh', path: PATH, xpub: keyAt(PATH).publicExtendedKey, ...(withFp ? { masterFingerprint: hex.decode('73c5da0a') } : {}) }
}

/** A synthetic funding tx paying `amount` to our key at chain/index, vout 1 (vout 0 is a decoy). */
function funding(chain: number, index: number, amount: bigint, seed: string) {
  const raw = btc.RawTx.encode({
    version: 2, segwitFlag: false, lockTime: 0, witnesses: undefined,
    inputs: [{ txid: sha256(new TextEncoder().encode(seed)), index: 0, finalScriptSig: new Uint8Array(0), sequence: 0xffffffff }],
    outputs: [{ amount: 1234n, script: scriptAt([84 + H, H, 9 + H, 0, 0]) }, { amount, script: scriptAt([...PATH, chain, index]) }],
  })
  return { hex: hex.encode(raw), txid: hex.encode(sha256(sha256(raw)).reverse()) }
}

/** Fixed chain data (real test-key scripts) behind the BtcBackend interface: the unit seam only. */
function fixture(coins: Array<{ chain: number; index: number; value: number; seed: string }>, over: Partial<BtcBackend> = {}) {
  const prevTxs: Record<string, string> = {}
  const utxos: BtcUtxo[] = coins.map((c) => {
    const f = funding(c.chain, c.index, BigInt(c.value), c.seed)
    prevTxs[f.txid] = f.hex
    return { txid: f.txid, vout: 1, value: c.value, path: `m/84'/0'/0'/${c.chain}/${c.index}`, scriptType: 'p2wpkh' }
  })
  const calls: string[] = []
  const backend: BtcBackend = {
    kind: 'blockbook',
    capabilities: { history: true, push: true },
    async listUnspent(q) { calls.push(`listUnspent:${q.xpub}`); return utxos.map((u) => ({ ...u })) },
    async feeRate() { calls.push('feeRate'); return { slow: 2, average: 5, fast: 10 } },
    async broadcast() { throw new Error('tests never broadcast') },
    async rawTxHex({ txid }) { calls.push(`rawTxHex:${txid}`); return prevTxs[txid] },
    async addressIndices() { calls.push('addressIndices'); return { receiveIndex: 2, changeIndex: 0, discoveryAvailable: true, source: 'blockbook' } },
    ...over,
  }
  return { backend, utxos, prevTxs, calls }
}

const COINS = [{ chain: 0, index: 0, value: 50_000, seed: 'a' }, { chain: 0, index: 1, value: 40_000, seed: 'b' }]
const PAY = { to: RECIPIENT, amount: '0.0006', isMax: false, feeLevel: 5 }

describe('watch-only Create PSBT', () => {
  it('builds a BIP86 Taproot PSBT from the saved xpub through the selected backend', async () => {
    const path = [86 + H, H, H]
    const key = MASTER.derive(formatPath(path))
    const script = btc.p2tr(key.deriveChild(0).deriveChild(0).publicKey!.subarray(1)).script
    const prev = btc.RawTx.encode({ version: 2, segwitFlag: false, lockTime: 0, witnesses: undefined,
      inputs: [{ txid: new Uint8Array(32).fill(7), index: 0, finalScriptSig: new Uint8Array(), sequence: 0xffffffff }],
      outputs: [{ amount: 100_000n, script }] })
    const txid = hex.encode(sha256(sha256(prev)).reverse())
    const f = fixture([], {
      async listUnspent(q) {
        expect(q.scriptType).toBe('p2tr')
        return [{ txid, vout: 0, value: 100_000, path: "m/86'/0'/0'/0/0", scriptType: 'p2tr' }]
      },
      async rawTxHex() { return hex.encode(prev) },
    })
    const built = await buildWatchOnlyPsbt(f.backend, BITCOIN, { scriptType: 'p2tr', path, xpub: key.publicExtendedKey }, PAY)
    expect(built.analysis.inputs[0].scriptType).toBe('p2tr')
    expect(built.analysis.outputs[1].kind).toBe('change')
    expect(built.analysis.outputs[1].address!.startsWith('bc1p')).toBe(true)
    expect(toSignTx(built.analysis).inputs[0].addressNList).toEqual([...path, 0, 0])
    const tx = btc.Transaction.fromPSBT(built.psbtBytes)
    expect(tx.getInput(0).tapBip32Derivation![0][1].der.path).toEqual([0, 0])
    tx.signIdx(key.deriveChild(0).deriveChild(0).privateKey!, 0)
    tx.finalize()
    expect(parseForBroadcast(tx.toPSBT(0)).fee).toBe(built.analysis.fee)
  })

  it('derives the public BIP84 test vectors from the account key', () => {
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(scriptAt([...PATH, 0, 0])))).toBe(RECEIVE_0)
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(scriptAt([...PATH, 1, 0])))).toBe(CHANGE_0)
  })

  it('builds from backend data only: full paths, previous txs, change the KeepKey hides', async () => {
    const f = fixture(COINS)
    const { psbtBytes, analysis } = await buildWatchOnlyPsbt(f.backend, BITCOIN, account(true), PAY)
    expect(f.calls).toContain(`listUnspent:${ZPUB}`)
    expect(f.calls).toContain('feeRate')
    expect(f.calls).toContain('addressIndices')
    expect(analysis.inputs.every((i) => i.amountVerified)).toBe(true)
    const pay = analysis.outputs.find((o) => o.kind === 'payment')!
    const change = analysis.outputs.find((o) => o.kind === 'change')!
    expect(pay.address).toBe(RECIPIENT)
    expect(pay.amount).toBe(60_000n)
    expect(change.address).toBe(CHANGE_0)
    expect(analysis.fee).toBe(analysis.totalIn - 60_000n - change.amount)
    expect(analysis.satPerVbyte).toBeGreaterThanOrEqual(10)
    const tx = btc.Transaction.fromPSBT(psbtBytes)
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i)
      expect(inp.nonWitnessUtxo).toBeDefined()
      expect(inp.witnessUtxo).toBeDefined()
      expect(inp.bip32Derivation![0][1].fingerprint).toBe(0x73c5da0a)
      expect(inp.bip32Derivation![0][1].path.length).toBe(5)
    }
    expect(RawPSBTV0.decode(psbtBytes).global.xpub).toBeUndefined()
  })

  it('without the master fingerprint writes Electrum-style origins plus the global xpub', async () => {
    const { psbtBytes } = await buildWatchOnlyPsbt(fixture(COINS).backend, BITCOIN, account(false), PAY)
    const tx = btc.Transaction.fromPSBT(psbtBytes)
    const [, origin] = tx.getInput(0).bip32Derivation![0]
    expect(origin.path.length).toBe(2)
    expect(origin.fingerprint).toBe(keyAt(PATH).fingerprint)
    expect(RawPSBTV0.decode(psbtBytes).global.xpub?.length).toBe(1)
  })

  it('send max spends everything with no change output', async () => {
    const { analysis } = await buildWatchOnlyPsbt(fixture(COINS).backend, BITCOIN, account(true), { ...PAY, isMax: true })
    expect(analysis.outputs.length).toBe(1)
    expect(analysis.totalIn).toBe(90_000n)
    expect(analysis.outputs[0].amount + analysis.fee).toBe(90_000n)
  })

  it('a fee-rate failure is an error, never a default fee', async () => {
    const f = fixture(COINS, { async feeRate() { throw new Error('fee endpoint down') } })
    await expect(buildWatchOnlyPsbt(f.backend, BITCOIN, account(true), PAY)).rejects.toThrow('refusing to guess a fee rate')
  })

  it('a node with no fee estimate is refused, not floored to a made-up rate', async () => {
    // The real node conversions: Blockbook estimatefee "-1", Core estimatesmartfee with only errors.
    const bb = fixture(COINS, { async feeRate() { return { slow: estimatefeeToSatVb({ result: '-1' }), average: 1, fast: 1 } } })
    await expect(buildWatchOnlyPsbt(bb.backend, BITCOIN, account(true), PAY)).rejects.toThrow('refusing to guess a fee rate')
    const core = fixture(COINS, { async feeRate() { return { slow: feerateToSatVb(undefined, ['Insufficient data or no feerate found']), average: 1, fast: 1 } } })
    await expect(buildWatchOnlyPsbt(core.backend, BITCOIN, account(true), PAY)).rejects.toThrow('Insufficient data')
    for (const result of ['Infinity', '0.0001junk', '', null, true]) expect(() => estimatefeeToSatVb({ result })).toThrow('could not estimate')
    for (const rate of [Infinity, NaN, -1, 0]) expect(() => feerateToSatVb(rate)).toThrow('could not estimate')
  })

  it('refuses when the change index cannot be proven', async () => {
    const noIndex = fixture(COINS, { addressIndices: undefined })
    await expect(buildWatchOnlyPsbt(noIndex.backend, BITCOIN, account(true), PAY)).rejects.toThrow('cannot prove an unused change address')
    const unsure = fixture(COINS, { async addressIndices() { return { receiveIndex: 0, changeIndex: 0, discoveryAvailable: false, source: 'blockbook' } } })
    await expect(buildWatchOnlyPsbt(unsure.backend, BITCOIN, account(true), PAY)).rejects.toThrow('trustworthy unused change index')
    const failing = fixture(COINS, { async addressIndices() { throw new Error('GetPubkeyInfo failed') } })
    await expect(buildWatchOnlyPsbt(failing.backend, BITCOIN, account(true), PAY)).rejects.toThrow('GetPubkeyInfo failed')
  })

  it('refuses change more than 10 past the highest used change address', async () => {
    // The backend's history says no change address was used, yet it lists coins on change 0..10.
    const coins = Array.from({ length: 11 }, (_, i) => ({ chain: 1, index: i, value: 20_000, seed: `c${i}` }))
    const f = fixture(coins)
    await expect(buildWatchOnlyPsbt(f.backend, BITCOIN, account(true), { ...PAY, amount: '0.0019' })).rejects.toThrow('more than 10 past')
  })

  it('refuses a missing or wrong previous transaction', async () => {
    const missing = fixture(COINS, { async rawTxHex() { return undefined } })
    await expect(buildWatchOnlyPsbt(missing.backend, BITCOIN, account(true), PAY)).rejects.toThrow('no previous transaction')
    const other = funding(0, 0, 50_000n, 'other').hex
    const wrong = fixture(COINS, { async rawTxHex() { return other } })
    await expect(buildWatchOnlyPsbt(wrong.backend, BITCOIN, account(true), PAY)).rejects.toThrow('does not hash')
  })

  it('takes input values from the previous transaction, not the listing', async () => {
    const f = fixture(COINS)
    f.backend.listUnspent = async () => f.utxos.map((u, i) => ({ ...u, value: i === 0 ? 60_000 : u.value }))
    await expect(buildWatchOnlyPsbt(f.backend, BITCOIN, account(true), PAY)).rejects.toThrow('differs from the previous transaction')
  })

  it('refuses a UTXO without a path, or a path whose key is not the coin owner', async () => {
    const f = fixture(COINS)
    f.backend.listUnspent = async () => f.utxos.map(({ path, ...u }) => u)
    await expect(buildWatchOnlyPsbt(f.backend, BITCOIN, account(true), PAY)).rejects.toThrow('without its derivation path')
    const g = fixture(COINS)
    g.backend.listUnspent = async () => g.utxos.map((u) => ({ ...u, path: "m/84'/0'/0'/0/7" }))
    await expect(buildWatchOnlyPsbt(g.backend, BITCOIN, account(true), PAY)).rejects.toThrow('script does not match')
  })

  it('accepts mainnet recipients only, and sane amounts', async () => {
    const f = fixture(COINS)
    for (const to of ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 'not an address']) {
      await expect(buildWatchOnlyPsbt(f.backend, BITCOIN, account(true), { ...PAY, to })).rejects.toThrow()
    }
    for (const amount of ['0', '0.000000001', '1e-4', '-1', '']) {
      await expect(buildWatchOnlyPsbt(f.backend, BITCOIN, account(true), { ...PAY, amount })).rejects.toThrow('Amount')
    }
    expect(f.calls).toEqual([])
  })
})

describe('broadcast parsing', () => {
  async function signed() {
    const f = fixture(COINS)
    const { analysis } = await buildWatchOnlyPsbt(f.backend, BITCOIN, account(true), PAY)
    const tx = btc.Transaction.fromPSBT(analysis.psbtBytes)
    toSignTx(analysis).inputs.forEach((inp, i) => tx.signIdx(keyAt(inp.addressNList).privateKey!, i))
    tx.finalize()
    return { f, analysis, psbt: tx.toPSBT(0), rawHex: hex.encode(tx.extract()), txid: tx.id }
  }

  it('a signed PSBT carries a proven fee and its txid', async () => {
    const s = await signed()
    const p = parseForBroadcast(s.psbt)
    expect(p.txid).toBe(s.txid)
    expect(p.txHex).toBe(s.rawHex)
    expect(p.fee).toBe(s.analysis.fee)
  })

  it('raw hex: fee only from hash-checked previous transactions, else unknown', async () => {
    const s = await signed()
    const p = parseForBroadcast(s.rawHex)
    expect(p.fee).toBeNull()
    expect(p.txid).toBe(s.txid)
    expect(await feeFromPrevTxs(p.txHex, async (txid) => s.f.prevTxs[txid])).toBe(s.analysis.fee)
    expect(await feeFromPrevTxs(p.txHex, async () => undefined)).toBeNull()
    expect(await feeFromPrevTxs(p.txHex, async () => { throw new Error('OFFLINE') })).toBeNull()
    expect(await feeFromPrevTxs(p.txHex, () => new Promise<undefined>(() => {}), 20)).toBeNull() // a slow backend: unknown, not a stuck review
    const other = funding(0, 0, 50_000n, 'other').hex
    await expect(feeFromPrevTxs(p.txHex, async () => other)).rejects.toThrow('does not hash')
  })
})
