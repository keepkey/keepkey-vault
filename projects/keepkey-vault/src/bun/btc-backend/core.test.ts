/**
 * Unit test for CoreBackend's pure helpers — SLIP-132 xpub conversion, descriptor
 * building, and the BTC↔sat / feerate math (the parts that silently corrupt money
 * if wrong). No network. Run: bun src/bun/btc-backend/core.test.ts
 */
import { xpubToDescriptorParts, descriptorFor, btcToSats, feerateToSatVb, parseDescriptor, coreUtxoPath } from './core'
import { utxoDiscoveryKey, unwrapUtxoDiscoveryKey } from './types'

let pass = 0
function eq(a: any, b: any, msg: string) {
  if (a !== b) throw new Error(`FAIL ${msg}: got ${a} want ${b}`)
  pass++
}
function ok(c: boolean, msg: string) { if (!c) throw new Error(`FAIL ${msg}`); pass++ }

// SLIP-132: BIP84 account-0 zpub → native segwit, re-encoded as a standard xpub
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
const parts = xpubToDescriptorParts(ZPUB)
eq(parts.script, 'wpkh', 'zpub → wpkh script')
ok(parts.stdXpub.startsWith('xpub'), 'zpub re-encoded to standard xpub prefix')
const taprootParts = xpubToDescriptorParts(parts.stdXpub, 'p2tr')
eq(taprootParts.script, 'tr', 'explicit p2tr + plain xpub → tr script')
eq(taprootParts.stdXpub, parts.stdXpub, 'taproot preserves standard xpub bytes')

// Unsupported version bytes must throw, not silently mis-scan
let threw = false
try { xpubToDescriptorParts('xpubGARBAGE') } catch { threw = true }
ok(threw, 'garbage xpub throws')

// Descriptor shapes per script type + branch
eq(descriptorFor('wpkh', 'XP', 0), 'wpkh(XP/0/*)', 'wpkh receive descriptor')
eq(descriptorFor('sh_wpkh', 'XP', 1), 'sh(wpkh(XP/1/*))', 'sh(wpkh) change descriptor')
eq(descriptorFor('pkh', 'XP', 0), 'pkh(XP/0/*)', 'pkh descriptor')
eq(descriptorFor('tr', 'XP', 1), 'tr(XP/1/*)', 'taproot change descriptor')

eq(utxoDiscoveryKey('XP', 'p2tr'), 'tr(XP)', 'P2TR discovery wraps plain xpub')
eq(utxoDiscoveryKey('tr(XP)', 'p2tr'), 'tr(XP)', 'P2TR discovery wrapping is idempotent')
eq(utxoDiscoveryKey('XP', 'p2wpkh'), 'XP', 'non-P2TR discovery leaves xpub unchanged')
eq(unwrapUtxoDiscoveryKey('tr(XP)'), 'XP', 'discovery descriptor unwraps to plain xpub')

// BTC float → integer sats (the classic rounding trap)
eq(btcToSats(0.00099705), 99705, 'btcToSats sub-BTC')
eq(btcToSats(0.00000001), 1, 'btcToSats one sat')
eq(btcToSats(1), 100000000, 'btcToSats 1 BTC')

// estimatesmartfee BTC/kB → sat/vB, floor 1
eq(feerateToSatVb(0.0001), 10, 'feerate 0.0001 BTC/kB → 10 sat/vB')
eq(feerateToSatVb(0.00000141), 1, 'tiny feerate floors to 1')
eq(feerateToSatVb(undefined), 1, 'missing feerate → 1')

// scantxoutset desc → signing path + scriptType (get this wrong → sign with the
// wrong key → unbroadcastable tx). Cover both hardened notations Core may emit.
const wpkh = parseDescriptor("wpkh([abcd1234/84'/0'/0'/0/18]0289ab)#cs")
eq(wpkh.path, "m/84'/0'/0'/0/18", 'wpkh desc → path')
eq(wpkh.scriptType, 'p2wpkh', 'wpkh desc → p2wpkh')
const shwpkh = parseDescriptor('sh(wpkh([abcd1234/49h/0h/0h/1/5]0289ab))#cs')
eq(shwpkh.path, "m/49'/0'/0'/1/5", "sh(wpkh) desc, h-notation → path with '")
eq(shwpkh.scriptType, 'p2sh-p2wpkh', 'sh(wpkh) desc → p2sh-p2wpkh')
const pkh = parseDescriptor("pkh([abcd1234/44'/0'/0'/0/2]0289ab)#cs")
eq(pkh.path, "m/44'/0'/0'/0/2", 'pkh desc → path')
eq(pkh.scriptType, 'p2pkh', 'pkh desc → p2pkh')
const tr = parseDescriptor("tr([abcd1234/86'/0'/0'/0/3]0289ab)#cs")
eq(tr.path, "m/86'/0'/0'/0/3", 'tr desc → path')
eq(tr.scriptType, 'p2tr', 'tr desc → p2tr')
const none = parseDescriptor(undefined)
ok(none.path === undefined && none.scriptType === undefined, 'undefined desc → empty')

// THE money bug: Core reports paths relative to the account xpub (m/0/18). Signing
// that raw fails at broadcast (OP_EQUALVERIFY). Must rebuild the full account-0 path.
eq(coreUtxoPath('wpkh([abcd1234/0/18]0289ab)#cs', 'wpkh'), "m/84'/0'/0'/0/18", 'relative /0/18 → full BIP84 path')
eq(coreUtxoPath('wpkh([abcd1234/1/4]0289ab)#cs', 'wpkh'), "m/84'/0'/0'/1/4", 'change branch preserved')
eq(coreUtxoPath('pkh([abcd1234/0/2]0289ab)#cs', 'pkh'), "m/44'/0'/0'/0/2", 'legacy → purpose 44')
eq(coreUtxoPath('sh(wpkh([abcd1234/0/7]0289ab))#cs', 'sh_wpkh'), "m/49'/0'/0'/0/7", 'wrapped segwit → purpose 49')
eq(coreUtxoPath('tr([abcd1234/1/6]0289ab)#cs', 'tr'), "m/86'/0'/0'/1/6", 'taproot → purpose 86')
// Already-full origin (if Core ever echoes it) still collapses to account-0 form.
eq(coreUtxoPath("wpkh([abcd1234/84'/0'/0'/0/9]0289ab)#cs", 'wpkh'), "m/84'/0'/0'/0/9", 'full origin → last two segments')
ok(coreUtxoPath('wpkh(0289ab)#cs', 'wpkh') === undefined, 'no origin → undefined (falls back to enrichment)')

console.log(`[btc-backend] core OK — ${pass} assertions passed`)
