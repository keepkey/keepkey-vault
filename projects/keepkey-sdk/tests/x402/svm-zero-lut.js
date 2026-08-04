#!/usr/bin/env node
/**
 * Manual x402 SVM boundary test. Signs only; never broadcasts or settles.
 * Uses an intentionally fake blockhash, so the transaction cannot land.
 */
const { createPublicKey, verify } = require('crypto')
const { run, SOLANA_PATH } = require('../_helpers')

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PAY_TO = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'
const DESTINATION_ATA = '7woc3ajaGMMXczFYjxon4aQoHH3j126fMUR9c58eHRsK'

function base58Decode(value) {
  let number = 0n
  for (const char of value) {
    const digit = BASE58.indexOf(char)
    if (digit < 0) throw new Error(`invalid base58 character: ${char}`)
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
  if (output.length > 32) throw new Error('Solana public key exceeds 32 bytes')
  while (output.length < 32) output.unshift(0)
  return Buffer.from(output)
}

function le32(value) {
  const output = Buffer.alloc(4)
  output.writeUInt32LE(value)
  return output
}

function le64(value) {
  const output = Buffer.alloc(8)
  output.writeBigUInt64LE(BigInt(value))
  return output
}

function instruction(programIndex, accountIndices, data) {
  if (accountIndices.length >= 128 || data.length >= 128) throw new Error('fixture shortvec overflow')
  return Buffer.concat([
    Buffer.from([programIndex, accountIndices.length, ...accountIndices, data.length]),
    data,
  ])
}

function buildX402Transaction(authority) {
  const accounts = [
    Buffer.alloc(32, 0x10), // sponsor / fee payer
    authority,
    Buffer.alloc(32, 0x30), // source token account
    base58Decode(DESTINATION_ATA),
    base58Decode(USDC_MINT),
    base58Decode('ComputeBudget111111111111111111111111111111'),
    base58Decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    base58Decode('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
  ]
  const memo = Buffer.from('00112233445566778899aabbccddeeff', 'utf8')
  const message = Buffer.concat([
    // v0; sponsor writable signer, authority readonly signer; mint/programs readonly
    Buffer.from([0x80, 2, 1, 4, accounts.length]),
    ...accounts,
    Buffer.alloc(32, 0xbb), // intentionally fake/expired blockhash
    Buffer.from([4]),
    instruction(5, [], Buffer.concat([Buffer.from([2]), le32(20000)])),
    instruction(5, [], Buffer.concat([Buffer.from([3]), le64(1)])),
    instruction(6, [2, 4, 3, 1], Buffer.concat([Buffer.from([12]), le64(2000), Buffer.from([6])])),
    instruction(7, [], memo),
    Buffer.from([0]), // zero address lookup tables: fully inspectable offline
  ])
  return {
    message,
    wire: Buffer.concat([Buffer.from([2]), Buffer.alloc(128), message]),
  }
}

run('x402 SVM exact — zero-LUT sponsored USDC payment', async (getSdk, assert) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.solanaGetAddress({ address_n: SOLANA_PATH })
  const authority = base58Decode(address)
  const fixture = buildX402Transaction(authority)

  console.log(`  Device Solana address: ${address}`)
  console.log('  Fixture: sponsored v0, zero LUT, TransferChecked 0.002 USDC')
  console.log(`  Merchant payTo: ${PAY_TO}`)
  console.log(`  Verified destination ATA: ${DESTINATION_ATA}`)
  console.log('  Fake blockhash; no transaction will be broadcast or submitted.')
  console.log('\n  Expected device review:')
  console.log('    Compute limit: 20000')
  console.log('    Compute unit price: 1 microlamport')
  console.log('    Amount: 0.002 USDC (not "2000 tokens")')
  console.log(`    Recipient owner/payTo: ${PAY_TO}`)
  console.log('\n  >>> VERIFY EVERY FIELD, THEN APPROVE ON KEEPKEY <<<\n')

  const payload = await sdk.x402.svm.signPayment({
    addressNList: SOLANA_PATH,
    transaction: fixture.wire.toString('base64'),
    paymentRequirements: { asset: USDC_MINT, payTo: PAY_TO },
    token: { symbol: 'USDC', decimals: 6 },
  })

  const signed = Buffer.from(payload.transaction, 'base64')
  const sponsorSignature = signed.subarray(1, 65)
  const authoritySignature = signed.subarray(65, 129)
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      authority,
    ]),
    format: 'der',
    type: 'spki',
  })

  assert('returned the original wire transaction length', signed.length === fixture.wire.length)
  assert('left the sponsor slot unsigned', sponsorSignature.equals(Buffer.alloc(64)))
  assert('filled the KeepKey authority slot', !authoritySignature.equals(Buffer.alloc(64)))
  assert('authority signature verifies over the exact v0 message', verify(null, fixture.message, publicKey, authoritySignature))
  console.log(`  Authority signature: ${authoritySignature.toString('hex').slice(0, 40)}...`)
})
