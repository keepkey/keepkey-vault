import assert from 'assert'
import { impersonatesNativeIdentity, decideSquatter } from './symbolSquatter'

// impersonatesNativeIdentity: tickers + chain names, case/space-insensitive.
assert.equal(impersonatesNativeIdentity('SOLANA'), true)
assert.equal(impersonatesNativeIdentity(' solana '), true)
assert.equal(impersonatesNativeIdentity('BTC'), true)
assert.equal(impersonatesNativeIdentity('WBTC'), false)   // wrapped != native
assert.equal(impersonatesNativeIdentity('WETH'), false)
assert.equal(impersonatesNativeIdentity('USDT'), false)   // legit token, no impersonation
assert.equal(impersonatesNativeIdentity(undefined), false)

// The scam: unverified ERC-20 named "SOLANA" → squatter.
assert.equal(decideSquatter({ isToken: true, catalogReady: true, knownAsset: false, symbol: 'SOLANA' }), true)

// Native asset (slip44) with the same symbol → legit, never flagged.
assert.equal(decideSquatter({ isToken: false, catalogReady: true, knownAsset: false, symbol: 'SOL' }), false)

// Catalogued token wearing a native ticker (e.g. MATIC's ERC-20) → not flagged.
assert.equal(decideSquatter({ isToken: true, catalogReady: true, knownAsset: true, symbol: 'MATIC' }), false)

// Ordinary token → not flagged.
assert.equal(decideSquatter({ isToken: true, catalogReady: true, knownAsset: false, symbol: 'USDT' }), false)

// Fail open while the catalog is still loading (can't verify → no false alarm).
assert.equal(decideSquatter({ isToken: true, catalogReady: false, knownAsset: false, symbol: 'SOLANA' }), false)

console.log('symbolSquatter: all assertions passed')
