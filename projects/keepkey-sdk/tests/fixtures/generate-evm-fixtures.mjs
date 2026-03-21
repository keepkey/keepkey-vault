#!/usr/bin/env node
/**
 * Generate signed EVM clear-signing fixture blobs for SDK tests.
 *
 * Uses pioneer-insight to create cryptographically signed metadata blobs
 * that the KeepKey firmware can verify and display decoded contract info.
 *
 * Usage: node tests/fixtures/generate-evm-fixtures.mjs
 * Output: tests/fixtures/evm-blobs.json
 */
import { hmac } from '@noble/hashes/hmac'
import { sha256 as _sha256 } from '@noble/hashes/sha256'
import * as secp from '@noble/secp256k1'
secp.etc.hmacSha256Sync = (k, ...m) => hmac(_sha256, k, secp.etc.concatBytes(...m))

import {
  serializeMetadata,
  signPayload,
  deriveSigningKey,
  ARG_FORMAT_ADDRESS,
  ARG_FORMAT_AMOUNT,
  ARG_FORMAT_RAW,
  CLASSIFICATION_VERIFIED,
} from '../../../../projects/pioneer/modules/pioneer/pioneer-insight/lib/index.js'

import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Test mnemonic (standard BIP-39 test vector — same as firmware test key) ──
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const { privateKey, publicKey } = deriveSigningKey(TEST_MNEMONIC, 0)
const KEY_ID = 0

console.log('Signing key:', Buffer.from(publicKey).toString('hex'))

// ── Helpers ──────────────────────────────────────────────────────────

function addr(hex) { return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex')) }
function sel(hex) { return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex')) }
function bigIntToBytes(n, len = 32) {
  const bytes = new Uint8Array(len)
  for (let i = len - 1; i >= 0; i--) { bytes[i] = Number(n & 0xffn); n >>= 8n }
  return bytes
}

const ZERO_HASH = new Uint8Array(32)
const ts = Math.floor(Date.now() / 1000)

async function makeBlob(fields) {
  const payload = serializeMetadata({
    txHash: ZERO_HASH,
    classification: CLASSIFICATION_VERIFIED,
    timestamp: ts,
    keyId: KEY_ID,
    ...fields,
  })
  const signed = await signPayload(payload, privateKey)
  return Buffer.from(signed).toString('hex')
}

// ── Contract addresses ───────────────────────────────────────────────

const UNISWAP_V2_ROUTER = '7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const UNISWAP_V3_ROUTER = 'E592427A0AEce92De3Edee1F18E0157C05861564'
const UNISWAP_V3_ROUTER02 = '68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
const USDC = 'A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = 'C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const RECIPIENT = '742d35Cc6634C0532950a20547b231011e30c8e7'

// ── Generate all fixtures ────────────────────────────────────────────

const fixtures = {}

// Uniswap V2: swapExactETHForTokens
fixtures['uniswap-v2-eth-to-token'] = await makeBlob({
  chainId: 1,
  contractAddress: addr(UNISWAP_V2_ROUTER),
  selector: sel('7ff36ab5'),
  methodName: 'swapExactETHForTokens',
  args: [
    { name: 'amountOutMin', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(9500000n) },
    { name: 'to', format: ARG_FORMAT_ADDRESS, value: addr(RECIPIENT) },
  ],
})

// Uniswap V2: swapExactTokensForETH
fixtures['uniswap-v2-token-to-eth'] = await makeBlob({
  chainId: 1,
  contractAddress: addr(UNISWAP_V2_ROUTER),
  selector: sel('18cbafe5'),
  methodName: 'swapExactTokensForETH',
  args: [
    { name: 'amountIn', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(100000000n) },
    { name: 'amountOutMin', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(3000000000000000n) },
    { name: 'to', format: ARG_FORMAT_ADDRESS, value: addr(RECIPIENT) },
  ],
})

// Uniswap V3: exactInputSingle
fixtures['uniswap-v3-exact-input'] = await makeBlob({
  chainId: 1,
  contractAddress: addr(UNISWAP_V3_ROUTER),
  selector: sel('414bf389'),
  methodName: 'exactInputSingle',
  args: [
    { name: 'tokenIn', format: ARG_FORMAT_ADDRESS, value: addr(WETH) },
    { name: 'tokenOut', format: ARG_FORMAT_ADDRESS, value: addr(USDC) },
    { name: 'amountIn', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(10000000000000000n) },
    { name: 'amountOutMin', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(9500000n) },
  ],
})

// Uniswap V3 Router02: multicall
fixtures['uniswap-v3-multicall'] = await makeBlob({
  chainId: 1,
  contractAddress: addr(UNISWAP_V3_ROUTER02),
  selector: sel('5ae401dc'),
  methodName: 'multicall',
  args: [
    { name: 'protocol', format: ARG_FORMAT_RAW, value: Buffer.from('Uniswap V3') },
  ],
})

// ERC-20: transfer
fixtures['erc20-transfer'] = await makeBlob({
  chainId: 1,
  contractAddress: addr(USDC),
  selector: sel('a9059cbb'),
  methodName: 'transfer',
  args: [
    { name: 'to', format: ARG_FORMAT_ADDRESS, value: addr(RECIPIENT) },
    { name: 'amount', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(1000000n) },
  ],
})

// ERC-20: approve
fixtures['erc20-approve'] = await makeBlob({
  chainId: 1,
  contractAddress: addr(USDC),
  selector: sel('095ea7b3'),
  methodName: 'approve',
  args: [
    { name: 'spender', format: ARG_FORMAT_ADDRESS, value: addr(UNISWAP_V3_ROUTER02) },
    { name: 'amount', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(1000000000n) },
  ],
})

// ERC-20: approve unlimited (MAX_UINT256)
fixtures['erc20-approve-unlimited'] = await makeBlob({
  chainId: 1,
  contractAddress: addr(USDC),
  selector: sel('095ea7b3'),
  methodName: 'approve',
  args: [
    { name: 'spender', format: ARG_FORMAT_ADDRESS, value: addr(UNISWAP_V3_ROUTER02) },
    { name: 'amount', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes((2n ** 256n) - 1n) },
  ],
})

// Write fixtures
const outPath = join(__dirname, 'evm-blobs.json')
writeFileSync(outPath, JSON.stringify(fixtures, null, 2) + '\n')
console.log(`\nWrote ${Object.keys(fixtures).length} fixtures to ${outPath}`)
for (const [k, v] of Object.entries(fixtures)) {
  console.log(`  ${k}: ${v.length / 2} bytes`)
}
