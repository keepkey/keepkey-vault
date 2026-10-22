/** Offline Taproot interoperability using the Drongo classes from Sparrow.
 * SPARROW_CLASSES=/path/to/extracted/runtime/modules SPARROW_JDK=/path/to/jdk bun scripts/test-btc-sparrow.ts
 * Extract the installed app with: jimage extract --dir <classes> <Sparrow runtime>/lib/modules
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { mnemonicToSeedSync } from 'bip39'
import * as btc from '@scure/btc-signer'
import { sha256 } from '@noble/hashes/sha2'
import { analyze, buildPsbt, deriveAddress, finalizeSigned, parseForBroadcast } from '../src/bun/btc-psbt/psbt'

const classes = process.env.SPARROW_CLASSES
const jdk = process.env.SPARROW_JDK
if (!classes || !jdk) throw new Error('Set SPARROW_CLASSES and SPARROW_JDK (see script header)')
const dir = mkdtempSync(join(tmpdir(), 'keepkey-sparrow-interop-'))
const cp = [dir, ...readdirSync(classes).map(n => join(classes, n))].join(process.platform === 'win32' ? ';' : ':')
// Public BIP39 vector, never a device seed or real funds.
const master = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'))
const path = [0x80000056, 0x80000000, 0x80000000]
const key = path.reduce((k, i) => k.deriveChild(i), master)
const fixtures: any[] = []
const accounts = new Map<string, any>()
for (const known of [true, false]) {
  const name = known ? 'p2tr-origin' : 'p2tr-bare'
  const account = { scriptType: 'p2tr' as const, path, xpub: key.publicExtendedKey, ...(known ? { masterFingerprint: hex.decode('73c5da0a') } : {}) }
  accounts.set(name, account)
  const addresses = Array.from({ length: 5 }, (_, i) => deriveAddress(account, 0, i))
  const prev = btc.RawTx.encode({ version: 2, segwitFlag: false, lockTime: 0, witnesses: undefined,
    inputs: [{ txid: sha256(new TextEncoder().encode(name)), index: 0, sequence: 0xffffffff, finalScriptSig: new Uint8Array() }],
    outputs: [0, 1].map(i => ({ amount: 50_000n, script: btc.OutScript.encode(btc.Address().decode(addresses[i])) })) })
  const txid = hex.encode(sha256(sha256(prev)).reverse())
  const built = buildPsbt({ account, utxos: [0, 1].map(i => ({ txid, vout: i, value: 50_000n, path: [...path, 0, i], scriptType: 'p2tr' as const })),
    prevTxs: { [txid]: hex.encode(prev) }, outputs: [{ address: addresses[2], value: 60_000n }], change: { path: [...path, 1, 0], value: 39_000n } })
  writeFileSync(join(dir, `${name}-unsigned.psbt`), built.psbtBytes)
  const tx = btc.Transaction.fromPSBT(built.psbtBytes)
  for (let i = 0; i < 2; i++) tx.signIdx(key.deriveChild(0).deriveChild(i).privateKey!, i)
  tx.finalize()
  const final = finalizeSigned(built.analysis, hex.encode(tx.extract()))
  writeFileSync(join(dir, `${name}-signed.psbt`), final.psbtBytes)
  fixtures.push({ name, xpub: key.publicExtendedKey, addresses, txid: final.txid, privateKeys: [0, 1].map(i => hex.encode(key.deriveChild(0).deriveChild(i).privateKey!)) })
}
writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(fixtures))
execFileSync(join(jdk, 'bin', 'javac'), ['-cp', cp, '-d', dir, join(import.meta.dir, 'SparrowPsbtCheck.java')], { stdio: 'inherit' })
execFileSync(join(jdk, 'bin', 'java'), ['-cp', cp, 'SparrowPsbtCheck', dir], { stdio: 'inherit' })
for (const f of fixtures) {
  const a = analyze(readFileSync(join(dir, `${f.name}-sparrow-unsigned.psbt`)), [accounts.get(f.name)])
  const signed = parseForBroadcast(readFileSync(join(dir, `${f.name}-sparrow-signed.psbt`)))
  if (signed.fee !== 1000n) throw new Error('Fee changed')
  finalizeSigned(a, signed.txHex)
  console.log(`${f.name}: Desktop accepted Sparrow's PSBT and verified its Schnorr signatures`)
}
console.log(`Sparrow Taproot interoperability: 2 round trips passed; artifacts: ${dir}`)
