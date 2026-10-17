#!/usr/bin/env node
/**
 * fw-716/00 — SETUP: is this the released 7.16.0 device, initialized, with
 * AdvancedMode off? No presses, no Desktop card, no device screen.
 *
 * A wrong device (an RC, the emulator, another label) or AdvancedMode on is a
 * FAIL, never a skip: every later refusal would pass for the wrong reason.
 * Also prints the device addresses and the sentinel nonce the signing suites use.
 */
const { run, notCovered, SENTINEL_NONCE } = require('../_helpers')
const F = require('./_fw716')

/** Desktop maps this hash to v7.16.0 (src/shared/firmware-versions.ts). It is
 *  the hash the device reports, not the payload sha (95f5c152...). */
const FW_HASH_7160 = '99ebac75902b285678c235ec3cb0a9de2d2bc1181c0d47db6a9ae14cf035879c'
const LABEL = process.env.KK716_LABEL || 'New7142signed'
const BOOTLOADER_HASH = (process.env.KK716_BOOTLOADER_HASH || '').toLowerCase()

/** Features.capabilities the later suites rely on (device-protocol messages.proto). */
const REQUIRED_CAPABILITIES = {
  4: 'ERC7730_RUNTIME_REVIEW',
  5: 'EVM_CERTIFIED_INTENT',
  13: 'PERMIT2_REVIEW',
  17: 'SESSION_TRUST_LIFETIME',
  18: 'SOLANA_CERTIFIED_REVIEW',
  25: 'TRON_TRC20_REVIEW',
  26: 'EIP712_CHUNKED_VALUES',
  27: 'CERTIFIED_CONTACTS',
}

run('fw-716/00 device identity (released 7.16.0, AdvancedMode off)', async (getSdk, assert) => {
  const sdk = await getSdk()
  const f = await sdk.system.info.getFeatures()
  const health = await sdk.system.info.getHealth()

  console.log(`  Desktop:          ${health.version} (device_connected ${health.device_connected})`)
  console.log(`  firmware:         ${f.major_version}.${f.minor_version}.${f.patch_version}`)
  console.log(`  firmware_variant: ${f.firmware_variant || '(none)'}`)
  console.log(`  firmware_hash:    ${f.firmware_hash || '(none)'}`)
  console.log(`  bootloader_hash:  ${f.bootloader_hash || '(none)'}`)
  console.log(`  label:            ${f.label || '(none)'}`)
  console.log(`  initialized:      ${f.initialized}`)
  console.log(`  policies:         ${(f.policies || []).map((p) => `${p.policy_name}=${p.enabled}`).join(', ') || '(none)'}`)

  const caps = Array.isArray(f.capabilities) ? f.capabilities : null
  if (caps) console.log(`  capabilities:     [${caps.join(', ')}]`)
  else notCovered('capabilities 4/5/13/17/18/25/26/27 NOT CHECKED: this Desktop does not expose Features.capabilities (it lacks faa3c6da4; rebuild Desktop from a branch that has it)')
  console.log('')

  assert('firmware is exactly 7.16.0', Number(f.major_version) === 7 && Number(f.minor_version) === 16 && Number(f.patch_version) === 0)
  assert("not the emulator (firmware_variant !== 'Emulator')", f.firmware_variant !== 'Emulator')
  assert('firmware_hash is the released 7.16.0 image', String(f.firmware_hash || '').toLowerCase() === FW_HASH_7160)
  assert(`label is '${LABEL}'`, f.label === LABEL)
  assert('device is initialized', f.initialized === true)

  const bl = String(f.bootloader_hash || '').toLowerCase()
  assert('reports a bootloader hash (not empty, not all zeros)', bl.length > 0 && !/^0+$/.test(bl))
  if (BOOTLOADER_HASH) assert('bootloader_hash matches KK716_BOOTLOADER_HASH', bl === BOOTLOADER_HASH)
  else console.log('  bootloader_hash printed only (set KK716_BOOTLOADER_HASH to compare it)')

  const adv = F.advancedMode(f)
  assert('AdvancedMode policy is reported', adv !== undefined)
  assert('AdvancedMode is off', adv === false)

  if (caps) {
    for (const [n, name] of Object.entries(REQUIRED_CAPABILITIES)) {
      assert(`capability ${n} ${name}`, caps.includes(Number(n)))
    }
  }

  if (f.pin_protection && !f.pin_cached) {
    console.log('\n  The device is locked: Desktop asks for the PIN once to derive the addresses (no device press).')
  }
  const addr = await F.deviceAddresses(sdk)
  console.log(`\n  ETH:  ${addr.eth}`)
  console.log(`  SOL:  ${addr.sol}`)
  console.log(`  TRON: ${addr.tron}`)
  console.log(`  sentinel nonce for every EVM signature: ${SENTINEL_NONCE}\n`)
  assert('ETH address derived', /^0x[0-9a-fA-F]{40}$/.test(addr.eth || ''))
  assert('SOL address derived', /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr.sol || ''))
  assert('TRON address derived', /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr.tron || ''))
})
