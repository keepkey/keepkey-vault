#!/usr/bin/env node
/**
 * fw-716/01 — SETUP: the production ClearSign worker. Network only: no Desktop
 * call, no device, no presses.
 *
 * Checks health, the signed catalog (474 entries, batch 1 + batch 2), one
 * production delegate envelope, and prints which entries the later suites
 * need. An unreachable worker is a FAIL: every certified suite depends on it.
 * A missing entry is only printed here; the suite that needs it SKIPs.
 */
const { run, short } = require('../_helpers')
const F = require('./_fw716')

/** First 4 bytes of the production ClearSign root public key. */
const PRODUCTION_ROOT_PREFIX = '027c1fde'
/** Released 7.16.0 firmware: tag byte, then a 139-byte root cert
 *  (CLEARSIGN_CERT_LEN), then the inner body. Printed, never asserted. */
const INNER_BODY_OFFSET = 1 + 139
const RELAY_BRIDGE = { kind: 'schema', chainId: 1, selector: '0x49290c1c', method: 'bridgeDeposit' }
const UR_BASE = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const UR_SPENDER_ETH = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af'

run('fw-716/01 production ClearSign worker (catalog, envelope identity)', async (_getSdk, assert) => {
  console.log(`  worker: ${F.WORKER}`)
  console.log("  WARNING: Desktop's own CLEARSIGN_SERVICE_URL is not visible over REST; this is the worker the suites query.\n")

  let health
  try {
    health = await F.worker('/health')
  } catch (e) {
    assert(`worker reachable (${e.message || e})`, false)
    return
  }
  console.log(`  /health: ${health.status} ${JSON.stringify(health.body).slice(0, 160)}`)
  assert('/health answers 200 ok', health.status === 200 && health.body?.ok === true)

  const status = await F.worker('/v1/status')
  const root = String(status.body?.trust?.rootPublicKey || '')
  console.log(`  /v1/status: ${status.status} environment=${status.body?.environment} status=${status.body?.status} root=${short(root)}`)
  assert("environment is 'production'", status.status === 200 && status.body?.environment === 'production')
  assert(`trust root is the production root ${PRODUCTION_ROOT_PREFIX}…`, root.toLowerCase().startsWith(PRODUCTION_ROOT_PREFIX))

  const entries = await F.catalogEntries()
  const byKind = {}
  for (const e of entries) {
    const key = `${e.kind || e.family}${e.chainId ? ` chain ${e.chainId}` : ''}`
    byKind[key] = (byKind[key] || 0) + 1
  }
  console.log(`\n  catalog: ${entries.length} entries`)
  for (const [k, n] of Object.entries(byKind).sort()) console.log(`    ${String(n).padStart(4)}  ${k}`)
  assert('catalog has >= 474 entries', entries.length >= 474)
  // Solana entries carry family 'solana' and no kind.
  const kinds = new Set(entries.map((e) => e.kind || e.family))
  for (const k of ['uniswap-ur', 'intent', 'name', 'schema', 'solana']) assert(`catalog has kind '${k}'`, kinds.has(k))

  const relay = await F.findEvmEntry(RELAY_BRIDGE)
  assert('catalog has Relay bridgeDeposit chain 1 (needed for the envelope probe)', !!relay)
  if (relay) {
    const { status: s, body } = await F.evmSchema(1, relay.contract, RELAY_BRIDGE.selector, 68)
    const payload = String(body?.signedPayload || '')
    console.log(`\n  /v1/evm/schema Relay bridgeDeposit ${relay.contract}: ${s}`)
    console.log(`    classification=${body?.classification} version=${body?.version} keyId=${body?.keyId} alias='${body?.alias}' fingerprint=${body?.fingerprint}`)
    console.log(`    signedPayload ${short(payload)}`)
    const bodyByte = payload.slice(2 + 2 * INNER_BODY_OFFSET, 4 + 2 * INNER_BODY_OFFSET)
    console.log(`    body-type byte (offset ${INNER_BODY_OFFSET} per released 7.16.0, not asserted): 0x${bodyByte || '??'}`)
    assert('classification VERIFIED', body?.classification === 'VERIFIED')
    assert('version 3', body?.version === 3)
    assert('keyId 128 (certified delegate)', body?.keyId === F.CERTIFIED_KEY_ID)
    assert("alias 'KeepKey ClearSign'", body?.alias === 'KeepKey ClearSign')
    assert(`fingerprint ${F.EXPECT_FINGERPRINT}`, body?.fingerprint === F.EXPECT_FINGERPRINT)
    assert('signedPayload starts with 0x03', payload.startsWith('0x03'))
  }

  const lc = (x) => String(x || '').toLowerCase()
  const solana = (id) => entries.find((e) => e.family === 'solana' && e.id === id)
  const needed = [
    ['Relay bridgeDeposit chain 1 (30)', relay],
    ['Base USDC Token transfer (31)', await F.findEvmEntry({ kind: 'intent', chainId: 8453, contract: F.USDC_BASE, title: 'Token transfer' })],
    ['Base USDC Token approval (32)', await F.findEvmEntry({ kind: 'intent', chainId: 8453, contract: F.USDC_BASE, title: 'Token approval' })],
    ['Base USDC Shared approval to Permit2 (32)', await F.findEvmEntry({ kind: 'intent', chainId: 8453, contract: F.USDC_BASE, title: 'Shared approval', pinned: F.PERMIT2 })],
    ['Base Relay depositNative (33)', await F.findEvmEntry({ kind: 'intent', chainId: 8453, method: 'depositNative' })],
    ['Base Relay depositErc20 USDC (33)', await F.findEvmEntry({ kind: 'intent', chainId: 8453, method: 'depositErc20', pinned: F.USDC_BASE })],
    ['Base UR 0x3fc91a3a USDC/WETH (38)', entries.find((e) => e.kind === 'uniswap-ur' && e.chainId === 8453 && lc(e.contract) === UR_BASE
      && [F.USDC_BASE, WETH_BASE].every((t) => (e.tokens || []).some((x) => lc(x.address) === t)))],
    [`chain-1 UR name for ${UR_SPENDER_ETH} (37)`, await F.certifiedName(1, UR_SPENDER_ETH)],
    ['Solana Relay depositNative (39)', solana('solana:relayDepositNative')],
    ['Solana Pump AMM buy (39)', solana('solana:pumpAmmBuy')],
  ]
  console.log('\n  entries the later suites need (missing = that suite SKIPs):')
  for (const [name, hit] of needed) {
    const detail = typeof hit === 'string' ? ` '${hit}'` : hit ? ` ${hit.id}` : ''
    console.log(`    ${hit ? 'present' : 'MISSING'}  ${name}${detail}`)
  }
  console.log('')
})
