#!/usr/bin/env node
/**
 * fw-716/37 — Permit2 PermitSingle in words (capability 13), with the spender's
 * certified name that Desktop attaches itself (withPermit2SpenderName).
 * 2 Desktop clicks, several presses each.
 *
 * Every permit is unusable on-chain: amount 1 (0.000001 USDC) and sigDeadline
 * 1700000000 (2023-11-14, already past, so Permit2 reverts SignatureExpired).
 *
 *   (a) spender = Uniswap Universal Router (chain 1), expiration now + 30 days
 *   (b) a random, unnamed spender, expiration 0
 *
 * Expiration 0 on released 7.16.0 (eip712_stream.c eip712_permit2_review) reads
 * "until the end of the block that uses this permit", never a date and never
 * "Unix time 0". "Unix time N" appears only for a time past year 9999.
 *
 * Pass = the signature recovers to the device (ethers.verifyTypedData). Which
 * screens appeared, and whether the name showed, is the owner's observation:
 * printed, never asserted. AdvancedMode must be off: Permit2 is reviewed
 * natively, so no blind-sign gate applies.
 */
const { run, ETH_PATH, short } = require('../_helpers')
const { verifyTypedData } = require('ethers')
const F = require('./_fw716')

const UR_CHAIN1 = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af'
const SIG_DEADLINE = 1700000000

/** The firmware's date format: "YYYY-MM-DD HH:MM UTC". */
const utc = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
const shortAddr = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`

function permit({ spender, expiration }) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
    primaryType: 'PermitSingle',
    domain: { name: 'Permit2', chainId: 1, verifyingContract: F.PERMIT2 },
    message: {
      details: { token: F.USDC_ETH, amount: '1', expiration: String(expiration), nonce: '0' },
      spender,
      sigDeadline: String(SIG_DEADLINE),
    },
  }
}

/** What Desktop will attach for the chain-1 router: its 0x07 swap entry if the
 *  worker serves one, else the 0x06 name record. Returns the expected name or null. */
async function expectedName(spender) {
  const swap = await F.worker('/v1/evm/swap', { chainId: 1, contract: spender, selector: '0x3593564c', tokens: [F.USDC_ETH] })
  if (swap.status === 200) {
    console.log('  worker /v1/evm/swap answers 200: Desktop attaches the router\'s swap entry, which names spender and token')
  }
  const { status, body } = await F.worker('/v1/evm/name', { chainId: 1, address: spender })
  const ok = status === 200 && body?.classification === 'VERIFIED' && body.keyId === F.CERTIFIED_KEY_ID
    && body.fingerprint === F.EXPECT_FINGERPRINT && String(body.signedPayload || '').startsWith('0x03')
  console.log(`  worker /v1/evm/name: ${status} ${body?.classification} keyId=${body?.keyId} fingerprint=${body?.fingerprint} name=${body?.name}`)
  if (!ok) {
    console.log('  no certified name record for chain 1 and this spender: the device shows "Not identified". The sign still runs.')
    return null
  }
  return body.name
}

function printExpected({ spenderText, until, named }) {
  console.log('  OWNER: approve the Desktop card. Expected device screens:')
  console.log(`    Permit2: "Allow ${spenderText} to spend 0.000001 USDC from this wallet until ${until}"`)
  console.log('    Limits:  Spender may take 0.000001 USDC')
  console.log(`    Limits:  Allowance expires ${until}`)
  console.log(`    Limits:  Signature valid until ${utc(SIG_DEADLINE)}   (in the past)`)
  console.log('    Token:   USDC + full address; Spender: name or "Not identified" + full address')
  console.log('    Details: Nonce 0; Permit2 contract on chain 1')
  if (named) console.log(`    KeepKey ClearSign: "Spender named by KeepKey ClearSign ${F.EXPECT_FINGERPRINT} certified by KeepKey"`)
  console.log('    (If the firmware token table does not name USDC, the amount reads "1 base units" and Token "Unknown token".)')
}

async function signCase(sdk, assert, device, label, typedData) {
  let out
  try {
    out = await sdk.eth.ethSignTypedData({ address: device, typedData })
  } catch (e) {
    console.log(`  response: HTTP ${e.status ?? '?'} ${String(e.message || e).slice(0, 300)}`)
    assert(`${label}: signed`, false)
    return
  }
  const sig = typeof out === 'string' ? out : out?.signature
  assert(`${label}: 65-byte signature`, typeof sig === 'string' && /^0x[0-9a-fA-F]{130}$/.test(sig))
  if (typeof sig !== 'string') return
  const { EIP712Domain, ...types } = typedData.types
  const recovered = verifyTypedData(typedData.domain, types, typedData.message, sig)
  console.log(`  signature: ${short(sig)} recovered ${recovered}`)
  assert(`${label}: signature recovers to the device`, recovered.toLowerCase() === device.toLowerCase())
}

run('fw-716/37 Permit2 PermitSingle in words (certified spender name)', async (getSdk, assert) => {
  const sdk = await getSdk()
  await F.requireAdvancedModeOff(sdk, assert)
  const { address: device } = await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })
  console.log(`  device: ${device}`)

  // (a) the Universal Router, expiring in 30 days
  console.log('\n  (a) spender = Uniswap Universal Router, expiration now + 30 days')
  const expiration = Math.floor(Date.now() / 1000) + 30 * 86400
  const name = await expectedName(UR_CHAIN1)
  printExpected({ spenderText: name || shortAddr(UR_CHAIN1), until: utc(expiration), named: !!name })
  console.log(`  OWNER: note whether "${name || 'Uniswap Universal Router'}" appeared on the device.`)
  await signCase(sdk, assert, device, '(a) Universal Router', permit({ spender: UR_CHAIN1, expiration }))

  // (b) a random spender no record can name, expiration 0
  const spender = F.randomAddress()
  console.log(`\n  (b) spender = ${spender} (random, unnamed), expiration 0`)
  printExpected({ spenderText: `${shortAddr(spender)} (checksummed)`, until: 'the end of the block that uses this permit', named: false })
  console.log('  OWNER: the Spender screen should read "Not identified"; no ClearSign naming screen.')
  await signCase(sdk, assert, device, '(b) unnamed spender, expiration 0', permit({ spender, expiration: 0 }))
})
