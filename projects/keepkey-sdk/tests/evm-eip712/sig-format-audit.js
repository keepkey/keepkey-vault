/**
 * evm-eip712/sig-format-audit.js — byte-level audit of what the SDK
 * returns to the BEX (and ultimately the dApp).
 *
 * The signing math is correct (byte-identical to captured production
 * sig, recovers cleanly via ethers). This test asserts the WIRE-FORMAT
 * properties that downstream validators (Permit2 contract, Uniswap's
 * /v1/swap server-side, viem-based dApp validators) actually check:
 *
 *   1. Signature is 65 bytes (r 32 ‖ s 32 ‖ v 1) — exactly 132 hex chars
 *   2. v ∈ {27, 28} — EIP-712 standard, NOT 0/1 (some servers reject)
 *   3. s ≤ N/2 — EIP-2 low-S, malleability guard. Permit2 contract's
 *      ECDSA recover allows high-S, but viem 2.x rejects it by default
 *   4. r, s ≠ 0 — sanity
 *   5. address is EIP-55 checksum case — some validators string-match
 *
 * Run:
 *   KEEPKEY_API_KEY=<bearer> node tests/evm-eip712/sig-format-audit.js
 */
const { readFileSync } = require('fs')
const { join } = require('path')
const { run } = require('../_helpers')
const { utils, BigNumber } = require('/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/node_modules/ethers')

const FIXTURES_PATH = join(__dirname, '..', 'fixtures', 'eip712-blobs.json')

// secp256k1 curve order N
const SECP256K1_N = BigNumber.from('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const SECP256K1_N_HALF = SECP256K1_N.div(2)

function splitSig(sigHex) {
  const hex = sigHex.replace(/^0x/, '')
  return {
    raw: '0x' + hex,
    length: hex.length,
    bytes: hex.length / 2,
    r: '0x' + hex.slice(0, 64),
    s: '0x' + hex.slice(64, 128),
    v: parseInt(hex.slice(128, 130), 16),
  }
}

run('EIP-712 signature wire-format audit', async (getSdk, assert) => {
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'))
  const sdk = await getSdk()

  for (const [name, blob] of Object.entries(fixtures)) {
    if (name.startsWith('_')) continue
    console.log(`\n  ── ${name} ──`)
    const { typedData, expectedSigner, addressNList } = blob

    const { address } = await sdk.address.ethGetAddress({ address_n: addressNList })
    if (address.toLowerCase() !== expectedSigner.toLowerCase()) {
      console.log(`  skipping — wrong device (got ${address})`)
      continue
    }

    console.log(`  >>> APPROVE on device for ${name} <<<`)
    const result = await sdk.eth.ethSignTypedData({ address, typedData })
    const sig = typeof result === 'string' ? result : result.signature
    const returnedAddress = typeof result === 'object' ? result.address : null

    const split = splitSig(sig)
    console.log(`  raw:    ${split.raw}`)
    console.log(`  bytes:  ${split.bytes}`)
    console.log(`  r:      ${split.r}`)
    console.log(`  s:      ${split.s}`)
    console.log(`  v:      ${split.v} (0x${split.v.toString(16)})`)
    if (returnedAddress) console.log(`  addr:   ${returnedAddress}`)

    assert(`[${name}] sig is exactly 65 bytes (130 hex chars)`, split.bytes === 65)
    assert(`[${name}] v ∈ {27, 28} (EIP-712 standard)`, split.v === 27 || split.v === 28)
    assert(`[${name}] r ≠ 0`, BigNumber.from(split.r).gt(0))
    assert(`[${name}] s ≠ 0`, BigNumber.from(split.s).gt(0))
    assert(`[${name}] s ≤ N/2 (EIP-2 low-S; viem 2.x rejects high-S)`, BigNumber.from(split.s).lte(SECP256K1_N_HALF))
    assert(`[${name}] r < N`, BigNumber.from(split.r).lt(SECP256K1_N))
    assert(`[${name}] s < N`, BigNumber.from(split.s).lt(SECP256K1_N))

    if (returnedAddress) {
      const checksummed = utils.getAddress(returnedAddress)
      assert(`[${name}] returned address is EIP-55 checksum case`, returnedAddress === checksummed)
    }

    // Recovery sanity — already proven by uniswap-permit-prod.js, but
    // re-run here so this test is self-contained.
    const noDomain = { ...typedData.types }
    delete noDomain.EIP712Domain
    const recovered = utils.verifyTypedData(typedData.domain, noDomain, typedData.message, sig)
    assert(`[${name}] recovers to device address`, recovered.toLowerCase() === address.toLowerCase())

    // Compact (EIP-2098) format check — some Uniswap paths use this.
    // yParity = v - 27 packed into top bit of s
    const yParity = split.v - 27
    const sBN = BigNumber.from(split.s)
    const compactS = yParity ? sBN.or(BigNumber.from(2).pow(255)) : sBN
    const compactSig = split.r + compactS.toHexString().slice(2).padStart(64, '0')
    console.log(`  compact (EIP-2098, 64 bytes): ${compactSig}`)
    assert(`[${name}] compact sig is 64 bytes`, compactSig.replace(/^0x/, '').length === 128)
  }
})
