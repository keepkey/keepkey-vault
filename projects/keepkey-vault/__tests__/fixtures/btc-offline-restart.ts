/** Separate-process restart check. Public test key only, synthetic coins, no USB or public broadcast. */
import { mock } from 'bun:test'
import { join } from 'node:path'
import { HDKey } from '@scure/bip32'
import * as btc from '@scure/btc-signer'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { mnemonicToSeedSync } from 'bip39'
import { writePublicWallet } from '../../src/bun/btc-psbt/public-wallet'
import { parseWatchOnlyImport } from '../../src/bun/btc-psbt/watch-only-import'
import { analyze, finalizeSigned, parseForBroadcast, toSignTx } from '../../src/bun/btc-psbt/psbt'
import { buildWatchOnlyPsbt } from '../../src/bun/btc-psbt/watch-only-build'
import { formatPath } from '../../src/bun/btc-psbt/codec'
import { getWatchOnlyBtcBackend, setBtcNodeConfig } from '../../src/bun/btc-backend'
import type { BtcBackend } from '../../src/bun/btc-backend/types'
import { CHAINS } from '../../src/shared/chains'

const [dir, phase] = process.argv.slice(2)
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: join(dir, 'online-profile') } } }))
const db = await import('../../src/bun/db')
const file = (name: string) => join(dir, name)
const master = () => HDKey.fromMasterSeed(new Uint8Array(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')))
const path = [0x80000054, 0x80000000, 0x80000000]

if (phase === 'export') {
  // Represents exporting on the offline machine. Online phases only use this public file.
  await Bun.write(file('wallet.json'), writePublicWallet({ path, scriptType: 'p2wpkh', xpub: master().derive(formatPath(path)).publicExtendedKey, masterFingerprint: hex.decode('73c5da0a') }))
} else if (phase === 'build') {
  db.initDb()
  const w = parseWatchOnlyImport(await Bun.file(file('wallet.json')).text())
  db.saveImportedWatchOnlyWallet({ id: w.id, label: 'Public test wallet', featuresJson: JSON.stringify({ firmwareVariant: 'KeepKeyBTC', watchOnlyImport: true, deviceVerified: false }), masterFp: w.fingerprint, path: formatPath(w.path), key: w.key, scriptType: w.scriptType })
  db.setSetting('btc_node_enabled', '1')
  db.setSetting('btc_node_type', 'blockbook')
  db.setSetting('btc_node_url', 'http://127.0.0.1:9')
  // Synthetic blockchain data; building uses only the account public key.
  const key = HDKey.fromExtendedKey(w.xpub).deriveChild(0).deriveChild(0).publicKey!
  const prev = btc.RawTx.encode({ version: 2, segwitFlag: false, lockTime: 0, witnesses: undefined, inputs: [{ txid: new Uint8Array(32).fill(7), index: 0, finalScriptSig: new Uint8Array(), sequence: 0xffffffff }], outputs: [{ amount: 100000n, script: btc.p2wpkh(key).script }] })
  const txid = hex.encode(sha256(sha256(prev)).reverse())
  const backend: BtcBackend = {
    kind: 'blockbook', capabilities: { history: true, push: true },
    async listUnspent() { return [{ txid, vout: 0, value: 100000, path: "m/84'/0'/0'/0/0", scriptType: 'p2wpkh' }] },
    async feeRate() { return { slow: 1, average: 2, fast: 3 } },
    async rawTxHex() { return hex.encode(prev) },
    async addressIndices() { return { receiveIndex: 1, changeIndex: 0, discoveryAvailable: true, source: 'blockbook' } },
    async broadcast() { throw new Error('This test must never broadcast') },
  }
  const built = await buildWatchOnlyPsbt(backend, CHAINS.find(c => c.id === 'bitcoin')!, w, { to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '0.0006', isMax: false, feeLevel: 3 })
  await Bun.write(file('unsigned.psbt'), built.psbtBytes)
  await Bun.write(file('expected-fee.txt'), built.analysis.fee.toString())
} else if (phase === 'sign') {
  const w = parseWatchOnlyImport(await Bun.file(file('wallet.json')).text())
  const a = analyze(new Uint8Array(await Bun.file(file('unsigned.psbt')).arrayBuffer()), [w])
  const tx = btc.Transaction.fromPSBT(a.psbtBytes)
  toSignTx(a).inputs.forEach((input, i) => tx.signIdx(master().derive(formatPath(input.addressNList)).privateKey!, i))
  tx.finalize()
  await Bun.write(file('signed.psbt'), finalizeSigned(a, hex.encode(tx.extract())).psbtBytes)
} else if (phase === 'review') {
  db.initDb() // A fresh process; no account/device/PSBT review state is inherited.
  const w = parseWatchOnlyImport(await Bun.file(file('wallet.json')).text())
  const snapshot = db.getDeviceSnapshotById(w.id)
  if (snapshot?.masterFp !== w.fingerprint || db.getCachedPubkeys(w.id)[0]?.xpub !== w.key) throw new Error('Public wallet did not survive restart')
  if (db.getSetting('btc_node_enabled') !== '1' || db.getSetting('btc_node_type') !== 'blockbook') throw new Error('Node settings did not survive restart')
  setBtcNodeConfig({ type: 'blockbook', url: db.getSetting('btc_node_url')! })
  if (getWatchOnlyBtcBackend(true).kind !== 'blockbook') throw new Error('Restart switched the wallet provider')
  const parsed = parseForBroadcast(new Uint8Array(await Bun.file(file('signed.psbt')).arrayBuffer()))
  if (parsed.fee?.toString() !== await Bun.file(file('expected-fee.txt')).text() || parsed.outputs[0].amount !== 60000n) throw new Error('Signed-file review changed after restart')
  console.log('Restart recovery passed: public wallet, node settings, unsigned/signed files and fee review')
} else throw new Error('Unknown restart-test phase')
db.getDb()?.close()
