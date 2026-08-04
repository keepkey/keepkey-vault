#!/usr/bin/env node
/**
 * Live, API-keyless Venice image generation through KeepKey + x402.
 *
 * This test has deliberately separate safety boundaries:
 *   challenge  fetch and validate Venice's public 402 challenge (no device)
 *   probe      SIWE-authenticate and read the wallet's Venice balance (no spend)
 *   top-up     authorize exactly the challenged Base USDC amount (real spend)
 *   generate   buy one capped z-image-turbo image from existing balance
 *   all        probe, top up only if needed, then generate one image
 *
 * No stage auto-confirms another. Real-spend stages require dollar-valued CLI
 * gates that are checked against both hard caps and the live response.
 */
const { randomBytes } = require('crypto')
const { dirname, resolve } = require('path')
const { tmpdir } = require('os')
const { existsSync, statSync, writeFileSync } = require('fs')
const { verifyMessage } = require('ethers')
const { run, ETH_PATH } = require('../_helpers')

const VENICE_ORIGIN = 'https://api.venice.ai'
const TOP_UP_PATH = '/api/v1/x402/top-up'
const IMAGE_PATH = '/api/v1/image/generate'
const BASE_CHAIN_ID = 8453
const BASE_NETWORK = 'eip155:8453'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const USDC_DECIMALS = 6
const HARD_MAX_TOP_UP_USD = 5
const IMAGE_MODEL = 'z-image-turbo'
const HARD_MAX_IMAGE_USD = 0.02
const AUTH_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000

const command = process.argv[2] || 'help'
const cliArgs = process.argv.slice(3)

function usage() {
  console.log(`
KeepKey × Venice x402 image test

Safe discovery (no device, no spend):
  npm run test:x402:venice -- challenge

Wallet authentication and balance only (device confirmation, no spend):
  npm run test:x402:venice -- probe

Real 5 USDC top-up (device ClearSign + on-chain settlement):
  npm run test:x402:venice -- top-up --confirm-top-up=5

One image from existing Venice balance (maximum accepted charge: $0.02):
  npm run test:x402:venice -- generate --confirm-image-spend=0.02

Full flow; top-up is skipped when the wallet already has enough balance:
  npm run test:x402:venice -- all --confirm-top-up=5 --confirm-image-spend=0.02

Optional:
  --output=/absolute/or/relative/image.png

No Venice API key is read or sent.
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

function toHex(utf8) {
  return `0x${Buffer.from(utf8, 'utf8').toString('hex')}`
}

function unwrapData(value) {
  return value && typeof value === 'object' && value.data !== undefined ? value.data : value
}

async function responseBody(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function apiError(response, body) {
  const detail = body && typeof body === 'object'
    ? body.error || body.message || body.code || JSON.stringify(body)
    : String(body || '')
  return `Venice returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`
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

function makeSiweMessage(address, resourceUrl) {
  const now = new Date()
  const expiration = new Date(now.getTime() + AUTH_TTL_MS)
  const nonce = randomBytes(8).toString('hex')
  return {
    timestamp: now.getTime(),
    message: [
      'api.venice.ai wants you to sign in with your Ethereum account:',
      address,
      '',
      'Sign in to Venice AI',
      '',
      `URI: ${resourceUrl}`,
      'Version: 1',
      `Chain ID: ${BASE_CHAIN_ID}`,
      `Nonce: ${nonce}`,
      `Issued At: ${now.toISOString()}`,
      `Expiration Time: ${expiration.toISOString()}`,
    ].join('\n'),
  }
}

async function makeVeniceAuthHeader(sdk, address, resourceUrl) {
  const siwe = makeSiweMessage(address, resourceUrl)
  console.log(`\n  SIWE resource: ${resourceUrl}`)
  console.log('  Vault will show readable SIWE; current firmware renders multiline SIWE as bytes.')
  console.log('  >>> REVIEW IN VAULT AND APPROVE THE AUTHENTICATION ON KEEPKEY <<<\n')

  const result = await sdk.eth.ethSignMessage({
    address,
    addressNList: ETH_PATH,
    message: toHex(siwe.message),
  })
  const signature = result?.signature || result?.sig
  hardGuard(/^0x[0-9a-fA-F]{130}$/.test(signature || ''), 'KeepKey returned an invalid SIWE signature')
  const recovered = verifyMessage(siwe.message, signature)
  hardGuard(recovered.toLowerCase() === address.toLowerCase(), 'SIWE signature does not recover the KeepKey address')

  return Buffer.from(JSON.stringify({
    address,
    message: siwe.message,
    signature,
    timestamp: siwe.timestamp,
    chainId: BASE_CHAIN_ID,
  }), 'utf8').toString('base64')
}

async function authenticatedRequest(sdk, address, path, init = {}) {
  const url = `${VENICE_ORIGIN}${path}`
  const auth = await makeVeniceAuthHeader(sdk, address, url)
  const headers = new Headers(init.headers)
  headers.set('SIGN-IN-WITH-X', auth)
  return timedFetch(url, { ...init, headers })
}

async function readBalance(sdk, address) {
  const response = await authenticatedRequest(
    sdk,
    address,
    `/api/v1/x402/balance/${address}`,
  )
  const body = await responseBody(response)
  if (!response.ok) throw new Error(apiError(response, body))
  const balance = unwrapData(body)
  hardGuard(balance && Number.isFinite(Number(balance.balanceUsd)), 'Venice returned no numeric balanceUsd')
  return {
    ...balance,
    balanceUsd: Number(balance.balanceUsd),
    minimumTopUpUsd: Number(balance.minimumTopUpUsd),
    suggestedTopUpUsd: Number(balance.suggestedTopUpUsd),
  }
}

async function readTransactions(sdk, address) {
  const response = await authenticatedRequest(
    sdk,
    address,
    `/api/v1/x402/transactions/${address}?limit=20&offset=0`,
  )
  const body = await responseBody(response)
  if (!response.ok) throw new Error(apiError(response, body))
  const ledger = unwrapData(body)
  hardGuard(ledger && Array.isArray(ledger.transactions), 'Venice returned no transaction ledger')
  return ledger.transactions
}

async function readImagePrice() {
  // Venice's model catalog is public. Checking it does not require a wallet
  // signature and lets us stop before spending if the price changes.
  const response = await timedFetch(`${VENICE_ORIGIN}/api/v1/models?type=image`)
  const body = await responseBody(response)
  if (!response.ok) throw new Error(apiError(response, body))
  const models = unwrapData(body)
  hardGuard(Array.isArray(models), 'Venice returned no image model catalog')
  const model = models.find(candidate => candidate.id === IMAGE_MODEL)
  hardGuard(model, `${IMAGE_MODEL} is not available`)
  const priceUsd = Number(model.model_spec?.pricing?.generation?.usd)
  hardGuard(Number.isFinite(priceUsd) && priceUsd > 0, `Venice returned no fixed generation price for ${IMAGE_MODEL}`)
  hardGuard(model.model_spec?.offline !== true, `${IMAGE_MODEL} is currently offline`)
  return priceUsd
}

function prepareOutputPath() {
  const output = resolve(flagValue('output') || `${tmpdir()}/keepkey-venice-x402-${Date.now()}.png`)
  hardGuard(!existsSync(output), `output already exists: ${output}`)
  hardGuard(existsSync(dirname(output)) && statSync(dirname(output)).isDirectory(), `output directory does not exist: ${dirname(output)}`)
  return output
}

async function loadX402() {
  const [{ x402Client }, { ExactEvmScheme }, http] = await Promise.all([
    import('@x402/core/client'),
    import('@x402/evm/exact/client'),
    import('@x402/core/http'),
  ])
  return {
    x402Client,
    ExactEvmScheme,
    decodePaymentRequiredHeader: http.decodePaymentRequiredHeader,
    encodePaymentSignatureHeader: http.encodePaymentSignatureHeader,
  }
}

async function getTopUpChallenge() {
  const response = await timedFetch(`${VENICE_ORIGIN}${TOP_UP_PATH}`, { method: 'POST' })
  hardGuard(response.status === 402, `expected top-up challenge HTTP 402, received ${response.status}`)
  const encoded = response.headers.get('PAYMENT-REQUIRED')
  hardGuard(encoded, 'Venice omitted the PAYMENT-REQUIRED header')

  const { decodePaymentRequiredHeader } = await loadX402()
  const paymentRequired = decodePaymentRequiredHeader(encoded)
  hardGuard(paymentRequired.x402Version === 2, `expected x402 v2, received v${paymentRequired.x402Version}`)
  hardGuard(Array.isArray(paymentRequired.accepts), 'Venice challenge has no accepts array')

  const requirement = paymentRequired.accepts.find(candidate => (
    candidate.scheme === 'exact'
    && String(candidate.network).toLowerCase() === BASE_NETWORK
    && String(candidate.asset).toLowerCase() === BASE_USDC
  ))
  hardGuard(requirement, 'Venice did not offer exact Base-mainnet USDC')
  hardGuard(/^0x[0-9a-fA-F]{40}$/.test(requirement.payTo), 'Venice returned an invalid Base payTo address')
  hardGuard(/^\d+$/.test(requirement.amount), 'Venice returned an invalid USDC amount')
  hardGuard(requirement.extra?.name === 'USD Coin', 'unexpected EIP-712 token domain name')
  hardGuard(String(requirement.extra?.version) === '2', 'unexpected EIP-712 token domain version')
  hardGuard(
    requirement.extra?.assetTransferMethod === undefined
      || requirement.extra.assetTransferMethod === 'eip3009',
    'Venice requested a transfer method that firmware cannot ClearSign',
  )

  return { paymentRequired, requirement, amountUsd: unitsToUsd(requirement.amount) }
}

function printChallenge(challenge) {
  console.log('  Venice live x402 challenge:')
  console.log(`    version:  v${challenge.paymentRequired.x402Version}`)
  console.log(`    network:  ${challenge.requirement.network}`)
  console.log(`    asset:    ${challenge.requirement.asset}`)
  console.log(`    amount:   $${challenge.amountUsd.toFixed(2)} USDC`)
  console.log(`    payTo:    ${challenge.requirement.payTo}`)
  console.log(`    timeout:  ${challenge.requirement.maxTimeoutSeconds}s`)
}

async function topUp(sdk, address, confirmedUsd, assert) {
  const challenge = await getTopUpChallenge()
  printChallenge(challenge)
  hardGuard(challenge.amountUsd <= HARD_MAX_TOP_UP_USD, `live top-up is $${challenge.amountUsd}, above the $${HARD_MAX_TOP_UP_USD} test cap`)
  hardGuard(confirmedUsd !== undefined, `top-up requires --confirm-top-up=${challenge.amountUsd}`)
  hardGuard(confirmedUsd === challenge.amountUsd, `--confirm-top-up must exactly match the live $${challenge.amountUsd.toFixed(2)} challenge`)

  console.log('\n  REAL PAYMENT: this authorizes and settles the amount above.')
  console.log('  Expected KeepKey ClearSign: x402 TransferWithAuthorization, amount and payTo above.')
  console.log('  >>> VERIFY THE USDC AMOUNT AND RECIPIENT, THEN APPROVE ON KEEPKEY <<<\n')

  const { x402Client, ExactEvmScheme, encodePaymentSignatureHeader } = await loadX402()
  const signer = await sdk.x402.evm.createSigner({ addressNList: ETH_PATH })
  hardGuard(signer.address.toLowerCase() === address.toLowerCase(), 'x402 signer address changed during the test')

  const normalizedRequired = {
    ...challenge.paymentRequired,
    resource: challenge.paymentRequired.resource || {
      url: `${VENICE_ORIGIN}${TOP_UP_PATH}`,
      description: 'Venice x402 top-up',
      mimeType: 'application/json',
    },
    accepts: [challenge.requirement],
  }
  const client = new x402Client((_version, requirements) => requirements[0])
    .register('eip155:*', new ExactEvmScheme(signer))
  const payload = await client.createPaymentPayload(normalizedRequired)
  hardGuard(payload.accepted?.amount === challenge.requirement.amount, 'signed payload amount changed')
  hardGuard(payload.accepted?.payTo.toLowerCase() === challenge.requirement.payTo.toLowerCase(), 'signed payload recipient changed')
  const paymentHeader = encodePaymentSignatureHeader(payload)

  // Venice currently documents X-402-Payment for the top-up retry. Never
  // retry a submitted authorization under a second header automatically.
  const response = await timedFetch(`${VENICE_ORIGIN}${TOP_UP_PATH}`, {
    method: 'POST',
    headers: { 'X-402-Payment': paymentHeader },
  })
  const body = await responseBody(response)
  if (!response.ok) throw new Error(apiError(response, body))
  assert('Venice accepted the hardware-signed x402 top-up', response.ok)

  const balance = await readBalance(sdk, address)
  assert('Venice reports spendable balance after top-up', balance.canConsume === true && balance.balanceUsd > 0)
  console.log(`  Spendable Venice balance: $${balance.balanceUsd.toFixed(6)}`)
  return balance
}

function imageBytes(body) {
  const unwrapped = unwrapData(body)
  const encoded = Array.isArray(unwrapped?.images)
    ? unwrapped.images[0]
    : Array.isArray(unwrapped)
      ? unwrapped[0]?.b64_json
      : unwrapped?.b64_json
  hardGuard(typeof encoded === 'string' && encoded.length > 100, 'Venice returned no base64 image')
  const base64 = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded
  return Buffer.from(base64, 'base64')
}

async function generateImage(sdk, address, confirmedMaxUsd, livePriceUsd, balanceBefore, output, assert) {
  hardGuard(confirmedMaxUsd !== undefined, `image generation requires --confirm-image-spend=${HARD_MAX_IMAGE_USD}`)
  hardGuard(livePriceUsd <= confirmedMaxUsd, `live ${IMAGE_MODEL} price $${livePriceUsd.toFixed(6)} exceeds the confirmed $${confirmedMaxUsd.toFixed(6)} cap`)
  hardGuard(confirmedMaxUsd <= HARD_MAX_IMAGE_USD, `image spend cap exceeds the $${HARD_MAX_IMAGE_USD.toFixed(2)} hard limit`)
  hardGuard(balanceBefore.balanceUsd >= livePriceUsd, 'Venice balance is too low; top up explicitly first')

  const prompt = process.env.VENICE_IMAGE_PROMPT
    || 'A studio product photograph of a KeepKey hardware wallet beside a tiny HTTP 402 payment receipt, dark background, crisp cinematic lighting, no logos or text'
  const startedAt = Date.now()
  console.log(`\n  REAL BALANCE CHARGE: requesting one ${IMAGE_MODEL} image.`)
  console.log(`  Live catalog price: $${livePriceUsd.toFixed(2)}; confirmed maximum: $${confirmedMaxUsd.toFixed(2)}`)
  console.log(`  Prompt: ${prompt}`)

  const response = await authenticatedRequest(sdk, address, IMAGE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      width: 512,
      height: 512,
      format: 'png',
      variants: 1,
      return_binary: false,
      safe_mode: true,
      hide_watermark: false,
    }),
  })
  const body = await responseBody(response)
  if (!response.ok) throw new Error(apiError(response, body))

  const bytes = imageBytes(body)
  hardGuard(bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'response is not a PNG image')
  writeFileSync(output, bytes, { flag: 'wx' })
  assert('Venice returned a valid PNG image', true)
  console.log(`  Image saved: ${output} (${bytes.length} bytes)`)

  const remainingHeader = response.headers.get('X-Balance-Remaining')
  if (remainingHeader !== null) {
    const remaining = Number(remainingHeader)
    const debit = balanceBefore.balanceUsd - remaining
    assert('response balance decreased by no more than the confirmed cap', Number.isFinite(debit) && debit >= 0 && debit <= confirmedMaxUsd + 1e-9)
    console.log(`  Balance remaining header: $${remaining.toFixed(6)} (debit $${debit.toFixed(6)})`)
  }

  const transactions = await readTransactions(sdk, address)
  const charge = transactions.find(transaction => (
    transaction.type === 'CHARGE'
    && Date.parse(transaction.createdAt) >= startedAt - 5000
  ))
  assert('Venice ledger contains a new CHARGE for this request', !!charge)
  if (charge) {
    const chargedUsd = Math.abs(Number(charge.amount))
    assert('ledger charge is within the confirmed maximum', Number.isFinite(chargedUsd) && chargedUsd > 0 && chargedUsd <= confirmedMaxUsd + 1e-9)
    if (charge.modelId) assert('ledger records the requested image model', charge.modelId === IMAGE_MODEL)
    console.log(`  Ledger charge: $${chargedUsd.toFixed(6)} (${charge.modelId || 'model not reported'})`)
  }
}

if (command === 'help' || command === '--help' || command === '-h') {
  usage()
  process.exit(0)
}

const validCommands = new Set(['challenge', 'probe', 'top-up', 'generate', 'all'])
if (!validCommands.has(command)) {
  usage()
  console.error(`Unknown command: ${command}`)
  process.exit(2)
}

run(`Venice x402 — ${command}`, async (getSdk, assert) => {
  if (command === 'challenge') {
    const [challenge, imagePrice] = await Promise.all([getTopUpChallenge(), readImagePrice()])
    printChallenge(challenge)
    assert('challenge is exact EIP-3009-compatible Base USDC', true)
    assert(`${IMAGE_MODEL} live catalog price is within the $${HARD_MAX_IMAGE_USD.toFixed(2)} cap`, imagePrice <= HARD_MAX_IMAGE_USD)
    console.log(`  ${IMAGE_MODEL} live catalog price: $${imagePrice.toFixed(2)}`)
    console.log('  No device used and nothing signed or spent.')
    return
  }

  const confirmedTopUp = dollarGate('confirm-top-up', HARD_MAX_TOP_UP_USD)
  const confirmedImage = dollarGate('confirm-image-spend', HARD_MAX_IMAGE_USD)
  if (command === 'top-up' || command === 'all') {
    hardGuard(confirmedTopUp !== undefined, `command ${command} requires --confirm-top-up=${HARD_MAX_TOP_UP_USD}`)
  }
  if (command === 'generate' || command === 'all') {
    hardGuard(confirmedImage !== undefined, `command ${command} requires --confirm-image-spend=${HARD_MAX_IMAGE_USD}`)
  }

  const needsImage = command === 'generate' || command === 'all'
  const liveImagePrice = needsImage ? await readImagePrice() : undefined
  if (liveImagePrice !== undefined) {
    hardGuard(liveImagePrice <= confirmedImage, `live ${IMAGE_MODEL} price $${liveImagePrice.toFixed(6)} exceeds the confirmed $${confirmedImage.toFixed(6)} cap`)
  }
  const output = needsImage ? prepareOutputPath() : undefined

  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  hardGuard(/^0x[0-9a-fA-F]{40}$/.test(address), 'KeepKey returned an invalid EVM address')
  console.log(`  KeepKey wallet: ${address}`)

  if (command === 'probe') {
    const balance = await readBalance(sdk, address)
    assert('read wallet-bound Venice balance without an API key', Number.isFinite(balance.balanceUsd))
    console.log(`  Spendable balance: $${balance.balanceUsd.toFixed(6)}`)
    console.log(`  Can consume: ${balance.canConsume}`)
    console.log('  Nothing was spent.')
    return
  }

  if (command === 'top-up') {
    await topUp(sdk, address, confirmedTopUp, assert)
    return
  }

  let balance = await readBalance(sdk, address)
  console.log(`  Current spendable balance: $${balance.balanceUsd.toFixed(6)}`)

  if (command === 'all' && balance.balanceUsd < liveImagePrice) {
    balance = await topUp(sdk, address, confirmedTopUp, assert)
  }

  await generateImage(sdk, address, confirmedImage, liveImagePrice, balance, output, assert)
})
