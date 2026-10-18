/** Opt-in, offline hardware check. Synthetic coins only; never broadcasts or reads a seed. */
import { Keyring, Events } from '@keepkey/hdwallet-core'
import { NodeWebUSBKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodewebusb'
import * as btc from '@scure/btc-signer'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { masterFingerprintFromDepth1Xpub, toStandardXpub, writeElectrumWallet, formatPath } from '../src/bun/btc-psbt/codec'
import { buildPsbt, deriveAddress, finalizeSigned, toSignTx, type BtcPsbtAccount } from '../src/bun/btc-psbt/psbt'

const out = process.env.BTC_PSBT_EVIDENCE_DIR
if (!out) throw new Error('Set BTC_PSBT_EVIDENCE_DIR to an empty evidence directory (contains public wallet data)')
mkdirSync(out, { recursive: true })
const sign = process.argv.includes('--sign')
const adapter = NodeWebUSBKeepKeyAdapter.useKeyring(new Keyring())
const wallet = await adapter.pairDevice()
if (!wallet) throw new Error('No KeepKey connected')
let confirmations = 0
wallet.transport.on(String(Events.BUTTON_REQUEST), () => console.log(`Device confirmation ${++confirmations}: review and press the KeepKey button`))
for (const event of [Events.PIN_REQUEST, Events.PASSPHRASE_REQUEST]) {
  wallet.transport.on(String(event), () => {
    console.error('Unlock the standard wallet in Desktop first, then close Desktop and retry this check')
    process.exit(2)
  })
}
try {
  const features: any = await wallet.getFeatures()
  console.log(JSON.stringify({ firmware: `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`, initialized: features.initialized, pinCached: features.pinCached }))
  if (!features.initialized) throw new Error('Device not initialized: complete setup in Desktop first')
  const H = 0x80000000
  const keys = await wallet.getPublicKeys([{ addressNList: [84 + H], coin: 'Bitcoin', scriptType: 'p2wpkh', curve: 'secp256k1', showDisplay: false }])
  const fingerprint = masterFingerprintFromDepth1Xpub(keys![0]!.xpub!)
  console.log('Master fingerprint:', hex.encode(fingerprint))
  const reports: unknown[] = []
  for (const [scriptType, purpose] of [['p2wpkh', 84], ['p2sh-p2wpkh', 49], ['p2pkh', 44], ['p2tr', 86]] as const) {
    const only = process.argv.find(a => a.startsWith('--only='))?.slice(7)
    if (only && only !== scriptType) continue
    const path = [purpose + H, H, H]
    const pubkeys = await wallet.getPublicKeys([{ addressNList: path, coin: 'Bitcoin', scriptType, curve: 'secp256k1', showDisplay: false }])
    const account: BtcPsbtAccount & { masterFingerprint: Uint8Array } = { scriptType, path, xpub: toStandardXpub(pubkeys![0]!.xpub!).xpub, masterFingerprint: fingerprint }
    const addresses: string[] = []
    for (let index = 0; index < 5; index++) {
      const expected = deriveAddress(account, 0, index)
      const got = await wallet.btcGetAddress({ addressNList: [...path, 0, index], coin: 'Bitcoin', scriptType, showDisplay: false })
      if (got !== expected) throw new Error(`${scriptType}/${index}: device/host address mismatch`)
      addresses.push(expected)
    }
    if (scriptType !== 'p2tr') writeFileSync(join(out, `${scriptType}-electrum.json`), writeElectrumWallet(account, 'KeepKey hardware QA'))
    else writeFileSync(join(out, 'p2tr-account.json'), JSON.stringify({ scriptType, xpub: account.xpub, path: formatPath(path), fingerprint: hex.encode(fingerprint), addresses }, null, 2))
    const fundingScript = btc.OutScript.encode(btc.Address().decode(addresses[0]))
    const raw = btc.RawTx.encode({
      version: 2, segwitFlag: false, lockTime: 0, witnesses: undefined,
      inputs: [{ txid: sha256(new TextEncoder().encode(`KeepKey synthetic QA ${scriptType}`)), index: 0, sequence: 0xffffffff, finalScriptSig: new Uint8Array() }],
      outputs: [{ amount: 100_000n, script: fundingScript }],
    })
    const txid = hex.encode(sha256(sha256(raw)).reverse())
    const built = buildPsbt({ account, utxos: [{ txid, vout: 0, value: 100_000n, path: [...path, 0, 0], scriptType }], prevTxs: { [txid]: hex.encode(raw) },
      outputs: [{ address: addresses[1], value: 60_000n }], change: { path: [...path, 1, 0], value: 39_000n } })
    writeFileSync(join(out, `${scriptType}-unsigned.psbt`), built.psbtBytes)
    const report: any = { scriptType, path: formatPath(path), fingerprint: hex.encode(fingerprint), addresses, fee: '1000', deviceTotal: '61000', signed: false }
    if (sign) {
      confirmations = 0
      console.log(`${scriptType}: synthetic transaction, recipient ${addresses[1]}, 60000 sats; hidden change 39000 sats; total 61000 sats; fee 1000 sats`)
      const result = await wallet.btcSignTx(toSignTx(built.analysis) as any)
      const final = finalizeSigned(built.analysis, result!.serializedTx)
      writeFileSync(join(out, `${scriptType}-signed.psbt`), final.psbtBytes)
      report.signed = true
      report.txid = final.txid
      report.confirmations = confirmations
      console.log(`${scriptType}: device signature verified; ${confirmations} confirmation requests`)
    }
    reports.push(report)
    writeFileSync(join(out, 'hardware-report.json'), JSON.stringify(reports, null, 2))
    console.log(`${scriptType}: first five addresses match device; account export and synthetic PSBT saved`)
  }
} finally {
  await wallet.disconnect()
}
