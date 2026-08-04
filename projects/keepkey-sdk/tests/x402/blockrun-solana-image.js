#!/usr/bin/env node
/**
 * Live, API-keyless BlockRun image generation through KeepKey + x402 on Solana.
 *
 * Safety boundaries:
 *   challenge  validate the live 402 response (no device, no spend)
 *   probe      derive the KeepKey address and read Solana USDC balance (no signing)
 *   generate   sign one capped payment, submit it exactly once, verify settlement,
 *              and save one detected image format without overwriting a file
 */
const { createPublicKey, verify } = require('crypto')
const { dirname, extname, resolve } = require('path')
const { existsSync, statSync, writeFileSync } = require('fs')
const { tmpdir } = require('os')
const { run, SOLANA_PATH } = require('../_helpers')

const BLOCKRUN_ORIGIN = 'https://sol.blockrun.ai'
const IMAGE_PATH = '/api/v1/images/generations'
const IMAGE_URL = `${BLOCKRUN_ORIGIN}${IMAGE_PATH}`
const IMAGE_MODEL = 'zai/cogview-4'
const IMAGE_SIZE = '512x512'
const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDC_DECIMALS = 6
const HARD_MAX_IMAGE_USD = 0.03
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const command = process.argv[2] || 'help'
const cliArgs = process.argv.slice(3)

function usage() {
  console.log(`
KeepKey × BlockRun Solana x402 image test

Live challenge only (no device, no spend):
  npm run test:x402:blockrun-solana -- challenge

Wallet address + Solana USDC balance (device derivation, no signing or spend):
  npm run test:x402:blockrun-solana -- probe

One hardware-reviewed Solana USDC payment and image (maximum charge: $0.03):
  npm run test:x402:blockrun-solana -- generate --confirm-image-spend=0.03

Optional:
  --output=/absolute/or/relative/image.png
  BLOCKRUN_IMAGE_PROMPT='your prompt'
  SOLANA_RPC_URL='https://your-solana-rpc.example'

No BlockRun API key, raw private key, or SOL balance is required. The x402
facilitator is the fee payer; the KeepKey wallet only needs Solana USDC.
`)
}

function hardGuard(condition, message) {
  if (!condition) throw new Error(`SAFETY STOP: ${message}`)
}

function flagValue(name) {
  const prefix = `--${name}=`
  const match = cliArgs.find(arg => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : undefined
}

function dollarGate(name, hardMaximum) {
  const raw = flagValue(name)
  if (raw === undefined) return undefined
  hardGuard(/^\d+(\.\d{1,6})?$/.test(raw), `--${name} must be a positive decimal dollar amount`)
  const value = Number(raw)
  hardGuard(Number.isFinite(value) && value > 0, `--${name} must be greater than zero`)
  hardGuard(value <= hardMaximum, `--${name} exceeds the hard test cap of $${hardMaximum.toFixed(2)}`)
  return value
}

function unitsToUsd(units) {
  return Number(BigInt(units)) / (10 ** USDC_DECIMALS)
}

async function timedFetch(url, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: init.signal || controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function responseBody(response) {
  const text = await response.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

function apiError(response, body) {
  const detail = body && typeof body === 'object'
    ? body.error || body.message || body.code || JSON.stringify(body)
    : String(body || '')
  return `BlockRun returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`
}

function base58Decode(value) {
  hardGuard(typeof value === 'string' && value.length >= 32 && value.length <= 44, `invalid Solana address: ${value}`)
  let number = 0n
  for (const char of value) {
    const digit = BASE58.indexOf(char)
    hardGuard(digit >= 0, `invalid base58 character in ${value}`)
    number = number * 58n + BigInt(digit)
  }
  const output = []
  while (number > 0n) {
    output.unshift(Number(number & 0xffn))
    number >>= 8n
  }
  for (const char of value) {
    if (char !== '1') break
    output.unshift(0)
  }
  hardGuard(output.length <= 32, `Solana address exceeds 32 bytes: ${value}`)
  while (output.length < 32) output.unshift(0)
  return Buffer.from(output)
}

function base58Encode(bytes) {
  let number = 0n
  for (const byte of bytes) number = number * 256n + BigInt(byte)
  let encoded = ''
  while (number > 0n) {
    encoded = BASE58[Number(number % 58n)] + encoded
    number /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    encoded = `1${encoded}`
  }
  return encoded || '1'
}

function validateSolanaAddress(value, label) {
  try {
    base58Decode(value)
  } catch (error) {
    throw new Error(`SAFETY STOP: invalid ${label}: ${error.message}`)
  }
}

function readShortVec(bytes, start) {
  let value = 0
  let shift = 0
  let offset = start
  while (offset < bytes.length) {
    const byte = bytes[offset++]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: offset }
    shift += 7
    hardGuard(shift <= 28, 'Solana shortvec is too large')
  }
  throw new Error('SAFETY STOP: truncated Solana shortvec')
}

function parseSignedV0Transaction(encoded) {
  const wire = Buffer.from(encoded, 'base64')
  const signatureCount = readShortVec(wire, 0)
  const signatureStart = signatureCount.next
  const messageStart = signatureStart + signatureCount.value * 64
  hardGuard(messageStart < wire.length, 'truncated Solana transaction signatures')

  const message = wire.subarray(messageStart)
  hardGuard((message[0] & 0x80) !== 0 && (message[0] & 0x7f) === 0, 'payment is not a Solana v0 transaction')
  const requiredSignatures = message[1]
  hardGuard(signatureCount.value === requiredSignatures, 'signature wrapper does not match the v0 message header')

  const accountCount = readShortVec(message, 4)
  let offset = accountCount.next
  const accounts = []
  for (let i = 0; i < accountCount.value; i++) {
    hardGuard(offset + 32 <= message.length, 'truncated Solana static account list')
    accounts.push(base58Encode(message.subarray(offset, offset + 32)))
    offset += 32
  }
  hardGuard(offset + 32 <= message.length, 'truncated Solana blockhash')
  offset += 32

  const instructionCount = readShortVec(message, offset)
  offset = instructionCount.next
  const instructions = []
  for (let i = 0; i < instructionCount.value; i++) {
    hardGuard(offset < message.length, 'truncated Solana instruction')
    const programIndex = message[offset++]
    const accountIndices = readShortVec(message, offset)
    offset = accountIndices.next
    hardGuard(offset + accountIndices.value <= message.length, 'truncated Solana instruction accounts')
    const instructionAccounts = [...message.subarray(offset, offset + accountIndices.value)]
    offset += accountIndices.value
    const dataLength = readShortVec(message, offset)
    offset = dataLength.next
    hardGuard(offset + dataLength.value <= message.length, 'truncated Solana instruction data')
    const data = message.subarray(offset, offset + dataLength.value)
    offset += dataLength.value
    hardGuard(programIndex < accounts.length, 'Solana instruction program index is out of range')
    hardGuard(instructionAccounts.every(index => index < accounts.length), 'Solana instruction account index is out of range')
    instructions.push({
      program: accounts[programIndex],
      accounts: instructionAccounts.map(index => accounts[index]),
      data,
    })
  }

  const lookupCount = readShortVec(message, offset)
  offset = lookupCount.next
  hardGuard(lookupCount.value === 0, 'payment uses address lookup tables; firmware must refuse it')
  hardGuard(offset === message.length, 'unexpected bytes after Solana address lookup table list')

  const signatures = []
  for (let i = 0; i < signatureCount.value; i++) {
    const start = signatureStart + i * 64
    signatures.push(wire.subarray(start, start + 64))
  }
  return { accounts, instructions, signatures, message, requiredSignatures }
}

function validateSignedPaymentTransaction(encoded, requirement, walletAddress, assert) {
  const tx = parseSignedV0Transaction(encoded)
  hardGuard(tx.requiredSignatures === 2, `expected sponsor + wallet signatures, found ${tx.requiredSignatures}`)
  hardGuard(tx.accounts[0] === requirement.extra.feePayer, 'transaction fee payer differs from the 402 challenge')
  hardGuard(requirement.extra.feePayer !== walletAddress, 'wallet unexpectedly became the transaction fee payer')
  hardGuard(tx.instructions.length === 4, `expected 4 inspectable x402 instructions, found ${tx.instructions.length}`)
  hardGuard(tx.instructions[0].program === COMPUTE_BUDGET_PROGRAM, 'instruction 1 is not SetComputeUnitLimit')
  hardGuard(tx.instructions[1].program === COMPUTE_BUDGET_PROGRAM, 'instruction 2 is not SetComputeUnitPrice')
  hardGuard(tx.instructions[2].program === TOKEN_PROGRAM, 'instruction 3 is not the SPL Token program')
  hardGuard(tx.instructions[3].program === MEMO_PROGRAM, 'instruction 4 is not the x402 uniqueness memo')

  const transfer = tx.instructions[2]
  hardGuard(transfer.accounts.length === 4, `TransferChecked has ${transfer.accounts.length} accounts instead of 4`)
  hardGuard(transfer.accounts[1] === requirement.asset, 'TransferChecked mint differs from the 402 challenge')
  hardGuard(transfer.accounts[3] === walletAddress, 'TransferChecked authority differs from the KeepKey wallet')
  hardGuard(transfer.data.length === 10 && transfer.data[0] === 12, 'instruction 3 is not TransferChecked')
  hardGuard(transfer.data.readBigUInt64LE(1).toString() === requirement.amount, 'TransferChecked amount differs from the 402 challenge')
  hardGuard(transfer.data[9] === USDC_DECIMALS, 'TransferChecked decimals are not canonical USDC decimals')
  hardGuard(tx.instructions[3].data.length >= 16, 'x402 uniqueness memo is too short')

  const walletSignerIndex = tx.accounts.slice(0, tx.requiredSignatures).indexOf(walletAddress)
  hardGuard(walletSignerIndex >= 0, 'KeepKey wallet is not a required signer')
  const sponsorSignerIndex = tx.accounts.slice(0, tx.requiredSignatures).indexOf(requirement.extra.feePayer)
  hardGuard(sponsorSignerIndex >= 0, 'fee payer is not a required signer')
  hardGuard(tx.signatures[sponsorSignerIndex].equals(Buffer.alloc(64)), 'facilitator signature slot was unexpectedly populated by the client')
  hardGuard(!tx.signatures[walletSignerIndex].equals(Buffer.alloc(64)), 'KeepKey signature slot is empty')

  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), base58Decode(walletAddress)]),
    format: 'der',
    type: 'spki',
  })
  hardGuard(verify(null, tx.message, publicKey, tx.signatures[walletSignerIndex]), 'KeepKey signature does not verify over the exact v0 message')

  assert('signed transaction is v0 with zero address lookup tables', true)
  assert('transaction contains compute limit, compute price, TransferChecked, and memo only', true)
  assert('TransferChecked amount, mint, decimals, authority, and fee payer match the challenge', true)
  assert('KeepKey signature verifies and the sponsor slot remains unsigned', true)

  return {
    sourceTokenAccount: transfer.accounts[0],
    destinationTokenAccount: transfer.accounts[2],
    memo: tx.instructions[3].data.toString('utf8'),
  }
}

function requestBody() {
  return {
    model: IMAGE_MODEL,
    prompt: process.env.BLOCKRUN_IMAGE_PROMPT
      || 'A friendly robot inspecting a tiny HTTP 402 receipt on Solana, cinematic studio lighting, no text, square composition',
    size: IMAGE_SIZE,
    n: 1,
  }
}

async function loadX402() {
  const [{ x402Client }, { ExactSvmScheme }, http] = await Promise.all([
    import('@x402/core/client'),
    import('@x402/svm/exact/client'),
    import('@x402/core/http'),
  ])
  return {
    x402Client,
    ExactSvmScheme,
    decodePaymentRequiredHeader: http.decodePaymentRequiredHeader,
    decodePaymentResponseHeader: http.decodePaymentResponseHeader,
    encodePaymentSignatureHeader: http.encodePaymentSignatureHeader,
  }
}

async function getChallenge(body) {
  const response = await timedFetch(IMAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  hardGuard(response.status === 402, `expected image challenge HTTP 402, received ${response.status}`)
  const encoded = response.headers.get('PAYMENT-REQUIRED')
    || response.headers.get('X-PAYMENT-REQUIRED')
  hardGuard(encoded, 'BlockRun omitted the PAYMENT-REQUIRED header')

  const { decodePaymentRequiredHeader } = await loadX402()
  const paymentRequired = decodePaymentRequiredHeader(encoded)
  hardGuard(paymentRequired.x402Version === 2, `expected x402 v2, received v${paymentRequired.x402Version}`)
  hardGuard(paymentRequired.resource?.url === IMAGE_URL, `challenge resource changed to ${paymentRequired.resource?.url}`)
  hardGuard(Array.isArray(paymentRequired.accepts), 'challenge has no accepts array')

  const requirement = paymentRequired.accepts.find(candidate => (
    candidate.scheme === 'exact'
    && candidate.network === SOLANA_MAINNET
    && candidate.asset === SOLANA_USDC
  ))
  hardGuard(requirement, 'BlockRun did not offer exact Solana-mainnet USDC')
  hardGuard(/^\d+$/.test(requirement.amount) && BigInt(requirement.amount) > 0n, 'challenge has an invalid USDC amount')
  validateSolanaAddress(requirement.payTo, 'merchant payTo')
  hardGuard(requirement.extra && typeof requirement.extra.feePayer === 'string', 'challenge omitted the sponsored fee payer')
  validateSolanaAddress(requirement.extra.feePayer, 'fee payer')

  const amountUsd = unitsToUsd(requirement.amount)
  hardGuard(amountUsd <= HARD_MAX_IMAGE_USD, `live image price $${amountUsd.toFixed(6)} exceeds the $${HARD_MAX_IMAGE_USD.toFixed(2)} hard cap`)
  return { paymentRequired, requirement, amountUsd }
}

function printChallenge(challenge) {
  console.log('  BlockRun live x402 challenge:')
  console.log(`    version:    v${challenge.paymentRequired.x402Version}`)
  console.log(`    network:    ${challenge.requirement.network}`)
  console.log(`    asset:      ${challenge.requirement.asset}`)
  console.log(`    amount:     $${challenge.amountUsd.toFixed(6)} USDC`)
  console.log(`    payTo:      ${challenge.requirement.payTo}`)
  console.log(`    fee payer:  ${challenge.requirement.extra.feePayer}`)
  console.log(`    timeout:    ${challenge.requirement.maxTimeoutSeconds}s`)
}

async function rpcCall(method, params) {
  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL
  const response = await timedFetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await responseBody(response)
  hardGuard(response.ok, `Solana RPC returned HTTP ${response.status}`)
  hardGuard(body && !body.error, `Solana RPC ${method} failed: ${body?.error?.message || 'empty response'}`)
  return body.result
}

async function readUsdcBalance(walletAddress) {
  const result = await rpcCall('getTokenAccountsByOwner', [
    walletAddress,
    { mint: SOLANA_USDC },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ])
  hardGuard(result && Array.isArray(result.value), 'Solana RPC returned no token accounts')
  const atomic = result.value.reduce((sum, entry) => {
    const amount = entry?.account?.data?.parsed?.info?.tokenAmount?.amount
    return /^\d+$/.test(amount || '') ? sum + BigInt(amount) : sum
  }, 0n)
  return { atomic, usd: unitsToUsd(atomic.toString()), accounts: result.value.length }
}

function parsedAccountKeys(message) {
  if (!Array.isArray(message?.accountKeys)) return []
  return message.accountKeys.map(entry => (typeof entry === 'string' ? entry : entry?.pubkey))
}

function tokenBalanceAmount(balances, accountIndex, requirement) {
  const balance = Array.isArray(balances)
    ? balances.find(entry => (
      entry?.accountIndex === accountIndex
      && entry?.mint === requirement.asset
      && entry?.uiTokenAmount?.decimals === USDC_DECIMALS
    ))
    : null
  const amount = balance?.uiTokenAmount?.amount
  return /^\d+$/.test(amount || '') ? BigInt(amount) : null
}

function matchesConfirmedPayment(result, signature, signed, requirement, walletAddress) {
  if (!result || result.version !== 0 || result.meta?.err !== null) return false
  const transaction = result.transaction
  const message = transaction?.message
  if (!message || transaction?.signatures?.[0] !== signature) return false
  if (!Array.isArray(message.addressTableLookups) || message.addressTableLookups.length !== 0) return false

  const keys = parsedAccountKeys(message)
  if (keys[0] !== requirement.extra.feePayer || !keys.includes(walletAddress)) return false
  const instructions = message.instructions
  if (!Array.isArray(instructions) || instructions.length !== 4) return false
  if (instructions[0]?.programId !== COMPUTE_BUDGET_PROGRAM) return false
  if (instructions[1]?.programId !== COMPUTE_BUDGET_PROGRAM) return false
  if (instructions[2]?.programId !== TOKEN_PROGRAM) return false
  if (instructions[3]?.programId !== MEMO_PROGRAM || instructions[3]?.parsed !== signed.memo) return false

  const transfer = instructions[2]?.parsed
  if (transfer?.type !== 'transferChecked') return false
  const info = transfer.info
  if (info?.source !== signed.sourceTokenAccount) return false
  if (info?.destination !== signed.destinationTokenAccount) return false
  if (info?.mint !== requirement.asset || info?.authority !== walletAddress) return false
  if (info?.tokenAmount?.amount !== requirement.amount || info?.tokenAmount?.decimals !== USDC_DECIMALS) return false

  const sourceIndex = keys.indexOf(signed.sourceTokenAccount)
  const destinationIndex = keys.indexOf(signed.destinationTokenAccount)
  if (sourceIndex < 0 || destinationIndex < 0) return false
  const sourceBefore = tokenBalanceAmount(result.meta?.preTokenBalances, sourceIndex, requirement)
  const sourceAfter = tokenBalanceAmount(result.meta?.postTokenBalances, sourceIndex, requirement)
  const destinationBefore = tokenBalanceAmount(result.meta?.preTokenBalances, destinationIndex, requirement)
  const destinationAfter = tokenBalanceAmount(result.meta?.postTokenBalances, destinationIndex, requirement)
  const amount = BigInt(requirement.amount)
  if (sourceBefore === null || sourceAfter === null || sourceBefore - sourceAfter !== amount) return false
  if (destinationBefore === null || destinationAfter === null || destinationAfter - destinationBefore !== amount) return false

  const destinationOwner = result.meta?.postTokenBalances?.find(entry => entry.accountIndex === destinationIndex)?.owner
  return destinationOwner === requirement.payTo
}

async function confirmedTransaction(signature, signed, requirement, walletAddress) {
  const result = await rpcCall('getTransaction', [
    signature,
    { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ])
  return matchesConfirmedPayment(result, signature, signed, requirement, walletAddress)
}

async function verifySettlementOnChain(reportedTransaction, signed, requirement, walletAddress) {
  const candidates = new Set()
  if (typeof reportedTransaction === 'string' && reportedTransaction.length >= 64) {
    candidates.add(reportedTransaction)
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const signatures = await rpcCall('getSignaturesForAddress', [
      signed.sourceTokenAccount,
      { limit: 12, commitment: 'confirmed' },
    ])
    for (const entry of signatures || []) {
      if (!entry?.err && typeof entry?.signature === 'string') candidates.add(entry.signature)
    }

    for (const signature of candidates) {
      if (await confirmedTransaction(signature, signed, requirement, walletAddress)) return signature
    }
    if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 1500))
  }
  throw new Error('SAFETY STOP: could not prove the exact x402 payment on Solana')
}

function prepareOutputPath() {
  const output = resolve(flagValue('output') || `${tmpdir()}/keepkey-blockrun-solana-x402-${Date.now()}.png`)
  hardGuard(!existsSync(output), `output already exists: ${output}`)
  hardGuard(existsSync(dirname(output)) && statSync(dirname(output)).isDirectory(), `output directory does not exist: ${dirname(output)}`)
  return output
}

function parseJsonHeader(value) {
  if (!value) return null
  try { return JSON.parse(value) } catch { /* try base64 */ }
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) } catch { return null }
}

async function imageBytes(body) {
  const data = Array.isArray(body?.data) ? body.data[0] : null
  const encoded = data?.b64_json || body?.b64_json
  if (typeof encoded === 'string' && encoded.length > 100) {
    const base64 = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded
    return Buffer.from(base64, 'base64')
  }

  const imageUrl = data?.url || body?.url || body?.output_url
  hardGuard(typeof imageUrl === 'string', 'BlockRun returned neither an image URL nor base64 image data')
  const parsed = new URL(imageUrl)
  hardGuard(parsed.protocol === 'https:', `refusing non-HTTPS image URL: ${imageUrl}`)
  const response = await timedFetch(imageUrl)
  hardGuard(response.ok, `image download returned HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function detectedImageFormat(bytes) {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { extension: '.png', label: 'PNG' }
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: '.jpg', label: 'JPEG' }
  }
  if (bytes.length > 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: '.webp', label: 'WebP' }
  }
  if (bytes.length > 12 && bytes.subarray(4, 12).toString('ascii').startsWith('ftypavi')) {
    return { extension: '.avif', label: 'AVIF' }
  }
  return null
}

function formatOutputPath(requestedOutput, format) {
  const requestedExtension = extname(requestedOutput).toLowerCase()
  const compatible = requestedExtension === format.extension
    || (format.extension === '.jpg' && requestedExtension === '.jpeg')
  if (compatible) return requestedOutput
  const stem = requestedExtension ? requestedOutput.slice(0, -requestedExtension.length) : requestedOutput
  const corrected = `${stem}${format.extension}`
  hardGuard(!existsSync(corrected), `detected ${format.label}, but corrected output already exists: ${corrected}`)
  console.log(`  BlockRun returned ${format.label}; saving as ${corrected}`)
  return corrected
}

async function generateImage(sdk, challenge, walletAddress, confirmedMaxUsd, output, assert) {
  hardGuard(confirmedMaxUsd !== undefined, `image generation requires --confirm-image-spend=${HARD_MAX_IMAGE_USD}`)
  hardGuard(challenge.amountUsd <= confirmedMaxUsd, `live price $${challenge.amountUsd.toFixed(6)} exceeds the confirmed $${confirmedMaxUsd.toFixed(6)} cap`)

  const balance = await readUsdcBalance(walletAddress)
  console.log(`  Solana USDC balance: $${balance.usd.toFixed(6)} across ${balance.accounts} token account(s)`)
  hardGuard(balance.atomic >= BigInt(challenge.requirement.amount), `wallet needs at least $${challenge.amountUsd.toFixed(6)} USDC on Solana`)

  console.log('\n  REAL SOLANA PAYMENT: the facilitator sponsors network fees.')
  console.log(`  Expected KeepKey ClearSign: ${challenge.amountUsd.toFixed(6)} USDC to merchant owner ${challenge.requirement.payTo}.`)
  console.log('  The device must show the merchant owner, not its associated token account.')
  console.log('  >>> VERIFY AMOUNT, USDC, AND RECIPIENT OWNER, THEN APPROVE ON KEEPKEY <<<\n')

  const { x402Client, ExactSvmScheme, encodePaymentSignatureHeader, decodePaymentResponseHeader } = await loadX402()
  const signer = await sdk.x402.svm.createSigner({
    addressNList: SOLANA_PATH,
    paymentRequirements: {
      asset: challenge.requirement.asset,
      payTo: challenge.requirement.payTo,
    },
    token: { symbol: 'USDC', decimals: USDC_DECIMALS },
  })
  hardGuard(String(signer.address) === walletAddress, 'x402 signer address changed during the test')

  const client = new x402Client((_version, requirements) => {
    const selected = requirements.find(candidate => (
      candidate.scheme === 'exact'
      && candidate.network === SOLANA_MAINNET
      && candidate.asset === SOLANA_USDC
    ))
    if (!selected) throw new Error('No approved Solana USDC payment requirement')
    return selected
  }).register('solana:*', new ExactSvmScheme(signer, {
    rpcUrl: process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL,
  }))

  const payload = await client.createPaymentPayload(challenge.paymentRequired)
  hardGuard(payload.accepted?.amount === challenge.requirement.amount, 'signed payload amount changed')
  hardGuard(payload.accepted?.payTo === challenge.requirement.payTo, 'signed payload recipient changed')
  hardGuard(typeof payload.payload?.transaction === 'string', 'x402 client returned no Solana transaction')
  const signed = validateSignedPaymentTransaction(payload.payload.transaction, challenge.requirement, walletAddress, assert)

  const paymentHeader = encodePaymentSignatureHeader(payload)
  const response = await timedFetch(IMAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': paymentHeader,
    },
    body: JSON.stringify(requestBody()),
  })
  const body = await responseBody(response)
  // Never resubmit a signed payment automatically. A 202 also stops: the
  // selected CogView path is expected to settle synchronously, and automated
  // polling with a signed header expands the test's payment surface.
  hardGuard(response.status !== 202, 'BlockRun returned an async job; payment was not resubmitted or polled')
  if (!response.ok) throw new Error(apiError(response, body))

  const encodedSettlement = response.headers.get('PAYMENT-RESPONSE')
    || response.headers.get('X-PAYMENT-RESPONSE')
  let settlement = null
  if (encodedSettlement) {
    try { settlement = decodePaymentResponseHeader(encodedSettlement) } catch { /* fall through */ }
  }
  const receipt = parseJsonHeader(response.headers.get('X-PAYMENT-RECEIPT'))
  const reportedTransaction = settlement?.transaction
    || receipt?.transaction
    || receipt?.tx_hash
    || body?.payment?.transaction
    || body?.payment?.tx_hash
  const settledNetwork = settlement?.network || receipt?.network || body?.payment?.network
  hardGuard(settlement?.success !== false, `BlockRun reported failed settlement: ${settlement?.errorReason || settlement?.errorMessage || 'unknown reason'}`)
  hardGuard(!settledNetwork || settledNetwork === SOLANA_MAINNET || settledNetwork === 'solana', `settlement reported unexpected network ${settledNetwork}`)
  if (!reportedTransaction) console.log('  BlockRun omitted PAYMENT-RESPONSE; verifying the exact payment via Solana RPC...')
  const transaction = await verifySettlementOnChain(
    reportedTransaction,
    signed,
    challenge.requirement,
    walletAddress,
  )
  assert('BlockRun settled the exact x402 payment on Solana', true)
  console.log(`  Settlement transaction: ${transaction}`)

  const bytes = await imageBytes(body)
  const format = detectedImageFormat(bytes)
  hardGuard(format, 'response is not a recognized PNG, JPEG, WebP, or AVIF image')
  const finalOutput = formatOutputPath(output, format)
  writeFileSync(finalOutput, bytes, { flag: 'wx' })
  assert(`BlockRun returned a valid ${format.label} image`, true)
  console.log(`  Image saved: ${finalOutput} (${bytes.length} bytes)`)
}

if (command === 'help' || command === '--help' || command === '-h') {
  usage()
  process.exit(0)
}

const validCommands = new Set(['challenge', 'probe', 'generate'])
if (!validCommands.has(command)) {
  usage()
  console.error(`Unknown command: ${command}`)
  process.exit(2)
}

run(`BlockRun Solana x402 — ${command}`, async (getSdk, assert) => {
  const body = requestBody()
  const challenge = await getChallenge(body)
  printChallenge(challenge)
  assert('challenge is exact x402 v2 on Solana mainnet USDC', true)
  assert(`live image price is within the $${HARD_MAX_IMAGE_USD.toFixed(2)} hard cap`, challenge.amountUsd <= HARD_MAX_IMAGE_USD)

  if (command === 'challenge') {
    console.log('  No device used and nothing signed or spent.')
    return
  }

  const sdk = await getSdk()
  const { address } = await sdk.address.solanaGetAddress({ address_n: SOLANA_PATH })
  validateSolanaAddress(address, 'KeepKey wallet address')
  console.log(`  KeepKey Solana wallet: ${address}`)
  const balance = await readUsdcBalance(address)

  if (command === 'probe') {
    assert('read canonical Solana USDC balance without signing', true)
    console.log(`  Spendable Solana USDC: $${balance.usd.toFixed(6)} across ${balance.accounts} token account(s)`)
    console.log('  Nothing was signed or spent.')
    return
  }

  const confirmedMaxUsd = dollarGate('confirm-image-spend', HARD_MAX_IMAGE_USD)
  hardGuard(confirmedMaxUsd !== undefined, `command generate requires --confirm-image-spend=${HARD_MAX_IMAGE_USD}`)
  const output = prepareOutputPath()
  await generateImage(sdk, challenge, address, confirmedMaxUsd, output, assert)
})
