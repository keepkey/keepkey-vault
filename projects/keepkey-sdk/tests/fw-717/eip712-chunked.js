#!/usr/bin/env node
const { ETH_PATH, run, skip } = require('../_helpers')
const { verifyTypedData } = require('ethers')

const PREFIX = 'BEGIN CHUNKED MEMO'
const TAILS = ['ALPHA TAIL ONE', 'ALPHA TAIL TWO']
const DOMAIN = { name: 'KeepKey SDK Test', chainId: 1 }
const TYPES = { Note: [{ name: 'memo', type: 'string' }] }

function chunkedScreens(tape) {
  const problems = []
  const reviews = []
  for (const entry of tape) {
    if (entry.card === '/eth/sign-typed-data') {
      reviews.push({ card: entry, screens: [] })
    } else if (entry.screen === 'ethSignTypedData' && reviews.length) {
      reviews.at(-1).screens.push(entry.lines.join(' '))
    }
  }
  if (reviews.length !== TAILS.length) return ['expected two Desktop typed-data approval cards']
  const normalize = text => text.replace(/\s+/g, '').toUpperCase()
  // The firmware escapes space in a string leaf as \x20 so whitespace stays visible.
  const rendered = text => normalize(text.replaceAll(' ', '\\x20'))
  for (const [index, { card, screens }] of reviews.entries()) {
    if (!card.window?.length || card.blind) problems.push(`typed-data review ${index + 1} did not show a structured approval card`)
    const lines = normalize(screens.join(' '))
    const prefix = lines.indexOf(rendered(PREFIX))
    const tail = lines.indexOf(rendered(TAILS[index]))
    const approval = lines.indexOf('SIGNTYPEDDATA')
    if (prefix < 0 || tail <= prefix || approval <= tail || lines.includes(rendered(TAILS[1 - index]))) {
      problems.push(`typed-data review ${index + 1} did not show the memo prefix and its matching post-chunk tail in order`)
    }
  }
  return problems
}

module.exports = { chunkedScreens }

if (require.main === module) {
  if (process.env.KEEPKEY_SDK_ALPHA !== '1') skip('Set KEEPKEY_SDK_ALPHA=1 on a disposable 7.17 emulator')
  if (process.env.KEEPKEY_SUITE_RECORDING !== '1') {
    throw new Error('Run through tests/run-all.js with the emulator review tape')
  }
  run('7.17 alpha EIP-712 long values over SDK REST', async (getSdk, assert) => {
    const sdk = await getSdk()
    const features = await sdk.system.info.getFeatures()
    const version = [features.major_version, features.minor_version, features.patch_version].join('.')
    if (version !== '7.17.0' || features.firmware_variant !== 'Emulator' || !features.initialized ||
        !features.capabilities?.includes(26)) {
      throw new Error('This suite requires an initialized 7.17.0 emulator reporting capability 26')
    }
    const advanced = features.policies?.find(policy => policy.policy_name === 'AdvancedMode')
    if (advanced?.enabled !== false) throw new Error('AdvancedMode must be off during both signatures')

    const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })
    const signatures = []
    for (const tail of TAILS) {
      const message = { memo: `${PREFIX} ${'x '.repeat(505)}${tail}` }
      const typedData = {
        types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], ...TYPES },
        domain: DOMAIN,
        primaryType: 'Note',
        message,
      }
      const result = await sdk.eth.ethSignTypedData({ address, typedData })
      const signature = typeof result === 'string' ? result : result?.signature
      assert(`signature covers the complete memo with ${tail}`, typeof signature === 'string' &&
        verifyTypedData(DOMAIN, TYPES, message, signature).toLowerCase() === address.toLowerCase())
      signatures.push(signature)
    }
    assert('changing only the post-chunk tail changes the signature', signatures[0] !== signatures[1])
  })
}
