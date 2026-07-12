/**
 * Unit test for CoreBackend's pure helpers — SLIP-132 xpub conversion, descriptor
 * building, and the BTC↔sat / feerate math (the parts that silently corrupt money
 * if wrong). No network. Run: bun src/bun/btc-backend/core.test.ts
 */
import { xpubToDescriptorParts, descriptorFor, btcToSats, feerateToSatVb } from './core'

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

// Unsupported version bytes must throw, not silently mis-scan
let threw = false
try { xpubToDescriptorParts('xpubGARBAGE') } catch { threw = true }
ok(threw, 'garbage xpub throws')

// Descriptor shapes per script type + branch
eq(descriptorFor('wpkh', 'XP', 0), 'wpkh(XP/0/*)', 'wpkh receive descriptor')
eq(descriptorFor('sh_wpkh', 'XP', 1), 'sh(wpkh(XP/1/*))', 'sh(wpkh) change descriptor')
eq(descriptorFor('pkh', 'XP', 0), 'pkh(XP/0/*)', 'pkh descriptor')

// BTC float → integer sats (the classic rounding trap)
eq(btcToSats(0.00099705), 99705, 'btcToSats sub-BTC')
eq(btcToSats(0.00000001), 1, 'btcToSats one sat')
eq(btcToSats(1), 100000000, 'btcToSats 1 BTC')

// estimatesmartfee BTC/kB → sat/vB, floor 1
eq(feerateToSatVb(0.0001), 10, 'feerate 0.0001 BTC/kB → 10 sat/vB')
eq(feerateToSatVb(0.00000141), 1, 'tiny feerate floors to 1')
eq(feerateToSatVb(undefined), 1, 'missing feerate → 1')

console.log(`[btc-backend] core OK — ${pass} assertions passed`)
