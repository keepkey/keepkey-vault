#!/usr/bin/env node
/**
 * Generate signed EVM clear-signing fixture blobs using production key.
 *
 * Reads INSIGHT_MNEMONIC from pioneer-insight/.env via dotenv.
 * Output: tests/fixtures/evm-blobs.json
 *
 * Usage: node tests/fixtures/generate-evm-fixtures.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../../projects/pioneer/modules/pioneer/pioneer-insight/.env') })

const { hmac } = require('@noble/hashes/hmac')
const { sha256 } = require('@noble/hashes/sha256')
const secp = require('@noble/secp256k1')
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m))

const {
  serializeMetadata, signPayload, deriveSigningKey,
  ARG_FORMAT_ADDRESS, ARG_FORMAT_AMOUNT, ARG_FORMAT_RAW,
  CLASSIFICATION_VERIFIED,
} = require('../../../../projects/pioneer/modules/pioneer/pioneer-insight/lib/index.js')

const fs = require('fs')
const path = require('path')

const MNEMONIC = process.env.INSIGHT_MNEMONIC
if (!MNEMONIC) { console.error('ERROR: INSIGHT_MNEMONIC not found in .env'); process.exit(1) }

const KEY_ID = 0
const { privateKey, publicKey } = deriveSigningKey(MNEMONIC, KEY_ID)
console.log('Derived pubkey:', Buffer.from(publicKey).toString('hex'))
console.log('Firmware key 0: 0218621d9c14473458713bd3e672e53480aa7032ca9b67356395e88709bb45226a')
const match = Buffer.from(publicKey).toString('hex') === '0218621d9c14473458713bd3e672e53480aa7032ca9b67356395e88709bb45226a'
console.log('Match:', match ? 'YES' : 'NO — fixtures will fail verification on device!')
if (!match) { console.error('Key mismatch — check INSIGHT_MNEMONIC'); process.exit(1) }

function addr(hex) { return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex')) }
function sel(hex) { return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex')) }
function bigIntToBytes(n, len) {
  len = len || 32
  const bytes = new Uint8Array(len)
  for (let i = len - 1; i >= 0; i--) { bytes[i] = Number(n & 0xffn); n >>= 8n }
  return bytes
}

const ZERO_HASH = new Uint8Array(32)
const ts = Math.floor(Date.now() / 1000)

async function makeBlob(fields) {
  const payload = serializeMetadata({ txHash: ZERO_HASH, classification: CLASSIFICATION_VERIFIED, timestamp: ts, keyId: KEY_ID, ...fields })
  const signed = await signPayload(payload, privateKey)
  return Buffer.from(signed).toString('hex')
}

async function main() {
  const f = {}

  f['uniswap-v2-eth-to-token'] = await makeBlob({
    chainId: 1, contractAddress: addr('7a250d5630B4cF539739dF2C5dAcb4c659F2488D'), selector: sel('7ff36ab5'),
    methodName: 'swapExactETHForTokens',
    args: [
      { name: 'amountOutMin', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(9500000n) },
      { name: 'to', format: ARG_FORMAT_ADDRESS, value: addr('742d35Cc6634C0532950a20547b231011e30c8e7') },
    ],
  })

  f['uniswap-v2-token-to-eth'] = await makeBlob({
    chainId: 1, contractAddress: addr('7a250d5630B4cF539739dF2C5dAcb4c659F2488D'), selector: sel('18cbafe5'),
    methodName: 'swapExactTokensForETH',
    args: [
      { name: 'amountIn', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(100000000n) },
      { name: 'amountOutMin', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(3000000000000000n) },
      { name: 'to', format: ARG_FORMAT_ADDRESS, value: addr('742d35Cc6634C0532950a20547b231011e30c8e7') },
    ],
  })

  f['uniswap-v3-exact-input'] = await makeBlob({
    chainId: 1, contractAddress: addr('E592427A0AEce92De3Edee1F18E0157C05861564'), selector: sel('414bf389'),
    methodName: 'exactInputSingle',
    args: [
      { name: 'tokenIn', format: ARG_FORMAT_ADDRESS, value: addr('C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2') },
      { name: 'tokenOut', format: ARG_FORMAT_ADDRESS, value: addr('A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') },
      { name: 'amountIn', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(10000000000000000n) },
      { name: 'amountOutMin', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(9500000n) },
    ],
  })

  f['uniswap-v3-multicall'] = await makeBlob({
    chainId: 1, contractAddress: addr('68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'), selector: sel('5ae401dc'),
    methodName: 'multicall',
    args: [{ name: 'protocol', format: ARG_FORMAT_RAW, value: Buffer.from('Uniswap V3') }],
  })

  f['erc20-transfer'] = await makeBlob({
    chainId: 1, contractAddress: addr('A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), selector: sel('a9059cbb'),
    methodName: 'transfer',
    args: [
      { name: 'to', format: ARG_FORMAT_ADDRESS, value: addr('742d35Cc6634C0532950a20547b231011e30c8e7') },
      { name: 'amount', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(1000000n) },
    ],
  })

  f['erc20-approve'] = await makeBlob({
    chainId: 1, contractAddress: addr('A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), selector: sel('095ea7b3'),
    methodName: 'approve',
    args: [
      { name: 'spender', format: ARG_FORMAT_ADDRESS, value: addr('68b3465833fb72A70ecDF485E0e4C7bD8665Fc45') },
      { name: 'amount', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes(1000000000n) },
    ],
  })

  f['erc20-approve-unlimited'] = await makeBlob({
    chainId: 1, contractAddress: addr('A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), selector: sel('095ea7b3'),
    methodName: 'approve',
    args: [
      { name: 'spender', format: ARG_FORMAT_ADDRESS, value: addr('68b3465833fb72A70ecDF485E0e4C7bD8665Fc45') },
      { name: 'amount', format: ARG_FORMAT_AMOUNT, value: bigIntToBytes((2n ** 256n) - 1n) },
    ],
  })

  const outPath = path.join(__dirname, 'evm-blobs.json')
  fs.writeFileSync(outPath, JSON.stringify(f, null, 2) + '\n')
  console.log('\nWrote ' + Object.keys(f).length + ' fixtures to evm-blobs.json')
  for (const [k, v] of Object.entries(f)) console.log('  ' + k + ': ' + (v.length / 2) + ' bytes')
}

main().catch(e => { console.error(e); process.exit(1) })
