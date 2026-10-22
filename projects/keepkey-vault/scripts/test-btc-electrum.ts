/** Offline interoperability check against an installed Electrum source checkout.
 * ELECTRUM_SOURCE=/path/to/electrum ELECTRUM_PYTHON=/path/to/venv/bin/python bun scripts/test-btc-electrum.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { mnemonicToSeedSync } from 'bip39'
import * as btc from '@scure/btc-signer'
import { sha256 } from '@noble/hashes/sha2'
import { formatPath, writeElectrumWallet } from '../src/bun/btc-psbt/codec'
import { analyze, buildPsbt, deriveAddress, finalizeSigned, parseForBroadcast, type BtcPsbtAccount } from '../src/bun/btc-psbt/psbt'
import { parseWatchOnlyImport } from '../src/bun/btc-psbt/watch-only-import'

if (!process.env.ELECTRUM_SOURCE || !process.env.ELECTRUM_PYTHON) throw new Error('Set ELECTRUM_SOURCE and ELECTRUM_PYTHON (see script header)')
const dir = mkdtempSync(join(tmpdir(), 'keepkey-electrum-interop-'))
// Public BIP39 test vector, never a device seed or real funds.
const master = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'))
const masterFingerprint = hex.decode('73c5da0a')
const H = 0x80000000
const fixtures: any[] = []
for (const [scriptType, purpose] of [['p2wpkh', 84], ['p2sh-p2wpkh', 49], ['p2pkh', 44]] as const) {
  const path = [purpose + H, H, H]
  const key = master.derive(formatPath(path))
  for (const known of [true, false]) {
    const name = `${scriptType}-${known ? 'origin' : 'bare'}`
    const account: BtcPsbtAccount = { scriptType, path, xpub: key.publicExtendedKey, ...(known ? { masterFingerprint } : {}) }
    const addresses = Array.from({ length: 5 }, (_, i) => deriveAddress(account, 0, i))
    const wallet = JSON.parse(writeElectrumWallet({ ...account, masterFingerprint }, 'Interop QA'))
    if (!known) { delete wallet.keystore.root_fingerprint; delete wallet.keystore.derivation }
    writeFileSync(join(dir, `${name}-wallet.json`), JSON.stringify(wallet))
    const raw = btc.RawTx.encode({ version: 2, segwitFlag: false, lockTime: 0, witnesses: undefined,
      inputs: [{ txid: sha256(new TextEncoder().encode(name)), index: 0, finalScriptSig: new Uint8Array(), sequence: 0xffffffff }],
      outputs: [{ amount: 100_000n, script: btc.OutScript.encode(btc.Address().decode(addresses[0])) }] })
    const txid = hex.encode(sha256(sha256(raw)).reverse())
    const built = buildPsbt({ account, utxos: [{ txid, vout: 0, value: 100_000n, path: [...path, 0, 0], scriptType }], prevTxs: { [txid]: hex.encode(raw) },
      outputs: [{ address: addresses[1], value: 60_000n }], change: { path: [...path, 1, 0], value: 39_000n } })
    writeFileSync(join(dir, `${name}-unsigned.psbt`), built.psbtBytes)
    const tx = btc.Transaction.fromPSBT(built.psbtBytes)
    tx.signIdx(key.deriveChild(0).deriveChild(0).privateKey!, 0)
    tx.finalize()
    const final = finalizeSigned(built.analysis, hex.encode(tx.extract()))
    writeFileSync(join(dir, `${name}-signed.psbt`), final.psbtBytes)
    fixtures.push({ name, addresses, fingerprint: known ? hex.encode(masterFingerprint) : null, path: known ? formatPath(path) : null, accountXprv: key.privateExtendedKey, account, txid: final.txid, txHex: final.txHex })
  }
}
// The xprvs here are solely the public test vector above, for independent Electrum signing.
writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(fixtures))
execFileSync(process.env.ELECTRUM_PYTHON, [join(import.meta.dir, 'test-btc-electrum.py'), dir], {
  env: { ...process.env, PYTHONPATH: process.env.ELECTRUM_SOURCE }, stdio: 'inherit',
})
for (const f of fixtures) {
  const account = { ...f.account, ...(f.fingerprint ? { masterFingerprint } : {}) }
  const upgraded = parseWatchOnlyImport(readFileSync(join(dir, `${f.name}-upgraded.json`), 'utf8'))
  if (upgraded.fingerprint !== f.fingerprint) throw new Error(`${f.name}: fingerprint changed on import`)
  const unsigned = analyze(readFileSync(join(dir, `${f.name}-electrum-unsigned.psbt`)), [account])
  const signed = parseForBroadcast(readFileSync(join(dir, `${f.name}-electrum-signed.psbt`)))
  if (signed.fee !== 1000n) throw new Error(`${f.name}: fee mismatch`)
  finalizeSigned(unsigned, signed.txHex)
  console.log(`${f.name}: Desktop accepted Electrum's wallet and PSBT, verified Electrum's signatures`)
}
console.log(`Electrum interoperability: 6 round trips passed; artifacts: ${dir}`)
