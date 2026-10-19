import { test, expect } from 'bun:test'
import * as btc from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { sha256 } from '@noble/hashes/sha2'
import { hex } from '@scure/base'
import { analyze, alreadySigned, parseForBroadcast } from './psbt'

// Synthetic public test keys and nonexistent funding: never use on a device or broadcast.
const keys = [1,2,3].map(n => HDKey.fromMasterSeed(new Uint8Array(32).fill(n)))
const pubkeys = keys.map(k => k.publicKey!)
const multisig = btc.p2ms(2, pubkeys)
const destination = btc.p2wpkh(keys[0].deriveChild(1).publicKey!)
for (const type of ['p2sh', 'p2wsh', 'p2sh-p2wsh'] as const) {
  test(`${type}: relay needs no signer; completed PSBT and raw tx agree`, () => {
    const payment = type === 'p2sh' ? btc.p2sh(multisig) : type === 'p2wsh' ? btc.p2wsh(multisig) : btc.p2sh(btc.p2wsh(multisig))
    const prev = btc.RawTx.encode({ version: 2, segwitFlag: false, lockTime: 0, witnesses: undefined,
      inputs: [{ txid: new Uint8Array(32).fill(99), index: 0, sequence: 0xffffffff, finalScriptSig: new Uint8Array() }],
      outputs: [{ script: payment.script, amount: 100_000n }] })
    const tx = new btc.Transaction()
    tx.addInput({ txid: hex.encode(sha256(sha256(prev)).reverse()), index: 0, nonWitnessUtxo: prev, ...payment })
    tx.addOutput({ script: destination.script, amount: 99_000n })
    const unsigned = tx.toPSBT()
    tx.sign(keys[0].privateKey!)
    expect(alreadySigned(tx.toPSBT())).toBeNull()
    tx.sign(keys[1].privateKey!)
    const quorum = parseForBroadcast(tx.toPSBT())
    expect(quorum.fee).toBe(1000n)
    tx.finalize()
    const finalized = parseForBroadcast(tx.toPSBT())
    const raw = parseForBroadcast(hex.encode(tx.extract()))
    expect(finalized.txid).toBe(raw.txid)
    expect(quorum.txid).toBe(raw.txid)
    expect(finalized.fee).toBe(1000n)
    expect(raw.fee).toBeNull() // raw bytes do not prove previous input amounts
    expect(alreadySigned(tx.toPSBT())?.txid).toBe(raw.txid)
    expect(() => analyze(unsigned, [])).toThrow('No Bitcoin accounts loaded')
  })
}
