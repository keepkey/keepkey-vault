/**
 * evm-eip712/uniswap-permit-prod.js — production-captured EIP-712 regression suite
 *
 * Walks every entry in tests/fixtures/eip712-blobs.json:
 *
 *   1. OFFLINE — if the blob carries `knownGoodSignature`, recover the
 *      signer from the captured typed data + sig and assert it matches
 *      `expectedSigner`. Proves the captured payload is internally
 *      consistent (no fixture rot, no missing field, no JSON drift).
 *
 *   2. ONLINE — sign the typed data via the SDK against the local vault,
 *      then recover the signer and assert it matches the device's address
 *      at `addressNList`. Proves the BEX → vault → firmware path is intact
 *      for THIS exact payload. If this fails on a payload that PASSED the
 *      offline check, the regression is in the vault or firmware.
 *
 * The fixture file is the single source of truth — paste new failing
 * blobs from the BEX background console into it and re-run.
 */
const { readFileSync } = require('fs')
const { join } = require('path')
const { run } = require('../_helpers')
const { utils } = require('/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/node_modules/ethers')

const FIXTURES_PATH = join(__dirname, '..', 'fixtures', 'eip712-blobs.json')

function stripDomain(types) {
  const out = { ...types }
  delete out.EIP712Domain
  return out
}

function fmtAddr(a) { return a ? a.toLowerCase() : a }

function dumpDigest(label, domain, types, message) {
  const noDomain = stripDomain(types)
  const domainSep = utils._TypedDataEncoder.hashDomain(domain)
  const structHash = utils._TypedDataEncoder.from(noDomain).hash(message)
  const digest = utils._TypedDataEncoder.hash(domain, noDomain, message)
  console.log(`  ${label} domainSeparator: ${domainSep}`)
  console.log(`  ${label} structHash:      ${structHash}`)
  console.log(`  ${label} digest:          ${digest}`)
}

run('Uniswap Permit2 production regression suite', async (getSdk, assert) => {
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'))
  const sdk = await getSdk()

  for (const [name, blob] of Object.entries(fixtures)) {
    if (name.startsWith('_')) continue
    console.log(`\n  ── ${name} ──`)
    console.log(`  ${blob.context || ''}`)

    const { typedData, expectedSigner, addressNList, knownGoodSignature } = blob
    const noDomain = stripDomain(typedData.types)

    dumpDigest('expected', typedData.domain, typedData.types, typedData.message)

    // ── OFFLINE check: known-good sig recovers to expectedSigner ──
    if (knownGoodSignature) {
      try {
        const recovered = utils.verifyTypedData(typedData.domain, noDomain, typedData.message, knownGoodSignature)
        const ok = fmtAddr(recovered) === fmtAddr(expectedSigner)
        assert(`[offline] knownGoodSignature recovers to expectedSigner (${name})`, ok)
        if (!ok) {
          console.log(`    recovered: ${recovered}`)
          console.log(`    expected:  ${expectedSigner}`)
        }
      } catch (e) {
        assert(`[offline] knownGoodSignature recovery did not throw (${name})`, false)
        console.log(`    threw: ${e.message}`)
      }
    }

    // ── ONLINE check: sign via vault + recover ──
    const { address } = await sdk.address.ethGetAddress({ address_n: addressNList })
    const addrMatchesFixture = fmtAddr(address) === fmtAddr(expectedSigner)
    assert(`[online] device address matches fixture expectedSigner (${name})`, addrMatchesFixture)
    if (!addrMatchesFixture) {
      console.log(`    device:   ${address}`)
      console.log(`    fixture:  ${expectedSigner}`)
      console.log(`    skipping sign — wrong wallet plugged in`)
      continue
    }

    console.log(`\n  >>> APPROVE on device for ${name} <<<\n`)
    const result = await sdk.eth.ethSignTypedData({ address, typedData })
    const sig = typeof result === 'string' ? result : result.signature
    assert(`[online] got signature back (${name})`, !!sig)
    if (!sig) continue

    console.log(`  fresh sig: ${sig}`)
    let recovered
    try {
      recovered = utils.verifyTypedData(typedData.domain, noDomain, typedData.message, sig)
    } catch (e) {
      assert(`[online] fresh sig recovery did not throw (${name})`, false)
      console.log(`    threw: ${e.message}`)
      continue
    }
    const ok = fmtAddr(recovered) === fmtAddr(address)
    assert(`[online] fresh sig recovers to device address (${name})`, ok)
    if (!ok) {
      console.log(`    recovered: ${recovered}`)
      console.log(`    device:    ${address}`)
      console.log(`\n  ❌ DATA DRIFT detected for ${name}:`)
      console.log(`     The vault hashed something other than the fixture above.`)
      console.log(`     Capture the firmware-side domainSeparator/digest and diff`)
      console.log(`     against the "expected" values printed above.`)
    }
  }
})
