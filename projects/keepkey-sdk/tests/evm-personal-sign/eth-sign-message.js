/**
 * evm-personal-sign/eth-sign-message.js — EIP-191 personal_sign
 *
 * End-to-end coverage of the `/eth/sign` endpoint plus the Vault's new
 * EIP-191 decoding path (rest-api.ts preview branch + EthMessageSection in
 * the approval dialog).
 *
 * Two cases are covered because firmware + vault render them differently:
 *
 *   A) Single-line, all-ASCII-printable message
 *      - Firmware (`fsm_msgEthereumSignMessage` in lib/firmware/fsm_msg_ethereum.h):
 *        every byte passes `isprint()` → shows "Sign Message" + plaintext.
 *      - Vault: EthMessageSection shows the UTF-8 text prominently.
 *
 *   B) Multi-line SIWE-style message (contains `\n` = 0x0A, not printable)
 *      - Firmware: `isprint()` fails on the first newline → flips to
 *        "Sign Bytes" mode and renders the whole message as hex. This
 *        is the *typical* case for real dApp login challenges (EIP-4361
 *        mandates multi-line), which means the device physically cannot
 *        show the text — the user has no way to verify what they're
 *        signing without the Vault's decoded view.
 *      - Vault: EthMessageSection decodes the hex back to UTF-8 and shows
 *        the login challenge as readable text. This is the only place the
 *        user can actually read it.
 *
 * The test exercises both so a regression in either path fails loudly.
 *
 * Round-trip: every signed message is fed back to `/eth/verify` so we
 * assert the device's own verify endpoint accepts the signature we just
 * produced. That's the strongest proof that (address, message, signature)
 * form a consistent triple — r/s/v formatting, the
 * "\x19Ethereum Signed Message:\n{len}{msg}" prefix, and key derivation
 * all match between sign and verify.
 *
 * Pioneer: not needed (no contract calldata involved).
 *
 * Runs: `npm run test:device` or
 *       `node tests/evm-personal-sign/eth-sign-message.js`
 *
 * Requires: vault running on 1646 with REST enabled, KeepKey connected
 * and unlocked. If KEEPKEY_API_KEY is not set the SDK auto-pairs (expect
 * a pair-approval prompt in the Vault before any signing).
 */
const { run, ETH_PATH } = require('../_helpers')

// Case A: single-line, every byte is ASCII printable. Firmware will
//   display "Sign Message" + the plaintext on-device.
const PLAINTEXT_SIMPLE = 'KeepKey SDK test: sign this string nonce DEADBEEF'

// Case B: the shape of a real SIWE login challenge. Embedded `\n` bytes
//   force the firmware into "Sign Bytes" (hex) mode — the vault is the
//   only surface where the user can read this as text.
const PLAINTEXT_SIWE =
  'Sign in to KeepKey SDK Tests\n\n' +
  'This message proves you control the wallet.\n' +
  'Nonce: 0xDEADBEEF'

function toHex(utf8) {
  return '0x' + Buffer.from(utf8, 'utf8').toString('hex')
}

async function signAndVerify({ sdk, address, label, plaintext, assert }) {
  const messageHex = toHex(plaintext)
  console.log(`\n  -- Case: ${label} --`)
  console.log(`     Text: ${JSON.stringify(plaintext)}`)
  console.log(`     Hex:  ${messageHex}`)
  console.log('\n     >>> APPROVE in Vault + on device <<<\n')

  const result = await sdk.eth.ethSignMessage({
    address,
    addressNList: ETH_PATH,
    message: messageHex,
  })

  const sig = result?.signature || result?.sig
  assert(`[${label}] got sign result`, !!result)
  assert(`[${label}] has signature field`, typeof sig === 'string' && sig.length > 0)
  assert(`[${label}] signature is 0x-prefixed`, /^0x[0-9a-fA-F]+$/.test(sig))
  assert(`[${label}] signature is 65 bytes (130 hex chars + 0x)`, sig.length === 132)
  console.log(`     Signature: ${sig}`)

  // Cross-check: the device echoes which address signed. If it disagrees
  // with our derived address the UI is showing the wrong signer in the
  // approval dialog — catch that here instead of in production.
  if (result.address) {
    assert(
      `[${label}] device-reported address matches derived`,
      result.address.toLowerCase() === address.toLowerCase(),
    )
  }

  console.log('\n     >>> APPROVE "Verify message" on device <<<\n')
  const ok = await sdk.eth.ethVerifyMessage({
    address,
    message: messageHex,
    signature: sig,
  })
  assert(`[${label}] signature verifies against the signer`, ok === true)
}

run('EIP-191 personal_sign (simple + SIWE shapes)', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  assert('Got ETH address', address && address.startsWith('0x'))
  console.log(`  Signer: ${address}`)

  // Case A — firmware should render "Sign Message" with the plaintext.
  await signAndVerify({ sdk, address, label: 'simple', plaintext: PLAINTEXT_SIMPLE, assert })

  // Case B — firmware will render "Sign Bytes" (hex) because of the
  // embedded newlines. The Vault dialog must still show decoded UTF-8 so
  // the user can read what they're approving.
  await signAndVerify({ sdk, address, label: 'siwe', plaintext: PLAINTEXT_SIWE, assert })
})
