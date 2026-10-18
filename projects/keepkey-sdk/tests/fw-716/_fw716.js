/**
 * Shared helpers for tests/fw-716/*. Not a suite: run-all.js skips files that
 * start with '_'. Requiring this file does nothing on its own: no device I/O,
 * no network.
 *
 * Target: a production-root 7.16.0 KeepKey holding REAL FUNDS. Every signing
 * suite signs only (never broadcasts) and uses SENTINEL_NONCE.
 */
const { ETH_PATH, SOLANA_PATH, SENTINEL_NONCE, skip, atEnd, notCovered, assertSignedByDevice } = require('../_helpers')

/** m/44'/195'/0'/0/0 */
const TRON_PATH = [0x80000000 + 44, 0x80000000 + 195, 0x80000000, 0, 0]

/** Production ClearSign worker. Desktop's own CLEARSIGN_SERVICE_URL is not
 *  visible over REST; this is the one the suites query directly. */
const WORKER = (process.env.KK716_CLEARSIGN_URL || 'https://keepkey-clearsign.bithighlander.workers.dev').replace(/\/$/, '')
/** Delegate fingerprint the production envelopes carry. */
const EXPECT_FINGERPRINT = process.env.KK716_EXPECT_FINGERPRINT || 'fdd258ec'
/** keyId of the KeepKey-certified delegate. */
const CERTIFIED_KEY_ID = 0x80
/** Desktop caches features for 10 s (rest-api.ts FEATURES_TTL_MS). */
const FEATURES_WAIT_MS = 11_000

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Device ───────────────────────────────────────────────────────────

/** The device's ETH, SOL and TRON addresses, derived with showDisplay false. */
async function deviceAddresses(sdk) {
  const eth = (await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })).address
  const sol = (await sdk.address.solanaGetAddress({ address_n: SOLANA_PATH, show_display: false })).address
  const tron = (await sdk.address.tronGetAddress({ address_n: TRON_PATH, show_display: false })).address
  return { eth, sol, tron }
}

/** The AdvancedMode policy as Desktop reports it: true, false, or undefined
 *  when the policy is missing from the features. */
function advancedMode(features) {
  const p = (features.policies || []).find((x) => x.policy_name === 'AdvancedMode')
  return p ? p.enabled === true : undefined
}

/** Features read after the 10 s cache has expired, so a policy change shows. */
async function waitFeatures(sdk) {
  await sleep(FEATURES_WAIT_MS)
  return sdk.system.info.getFeatures()
}

/** AdvancedMode on (or missing) at the start is a FAIL, never a skip: every
 *  refusal later in the suite would pass for the wrong reason. */
async function requireAdvancedModeOff(sdk, assert) {
  const on = advancedMode(await sdk.system.info.getFeatures())
  assert('AdvancedMode is off at the start', on === false)
  if (on !== false) {
    console.error('  AdvancedMode is on or missing. Lock the device (or run fw-716/00) and start again.')
    process.exit(1)
  }
}

/**
 * Turn AdvancedMode back off. clearSession first: no press and no flash write
 * (session_clear(true) clears AdvancedMode and runtime signers). applyPolicies
 * false only if it still reads on, because every ApplyPolicies is a
 * storage_commit on this device. Returns the final state (false = off).
 */
async function restoreAdvancedMode(sdk) {
  await sdk.system.device.clearSession()
  let on = advancedMode(await waitFeatures(sdk))
  if (on !== false) {
    console.log('  AdvancedMode still on after clearSession. OWNER: confirm "Disable" on the device and enter the PIN.')
    await sdk.system.device.applyPolicies({ policyName: 'AdvancedMode', enabled: false })
    on = advancedMode(await waitFeatures(sdk))
  }
  return on
}

/**
 * Gate for suites whose pass is "signed with AdvancedMode off" (41-43): SKIP on
 * firmware before 7.16.0, on a missing capability `cap` (when Desktop reports
 * capabilities), and on AdvancedMode on or missing: then a blind call signs
 * too, so a signature proves nothing. The suite never changes AdvancedMode.
 */
async function requireClearSignOnly(sdk, cap) {
  const f = await sdk.system.info.getFeatures()
  const version = `${f.major_version}.${f.minor_version}.${f.patch_version}`
  if (Number(f.major_version) < 7 || (Number(f.major_version) === 7 && Number(f.minor_version) < 16)) {
    skip(`firmware ${version} predates 7.16.0`)
  }
  const caps = Array.isArray(f.capabilities) ? f.capabilities : undefined
  if (cap != null && caps && !caps.includes(cap)) skip(`device does not report capability ${cap}: [${caps.join(', ')}]`)
  const on = advancedMode(f)
  if (on !== false) {
    skip(`AdvancedMode reads ${on === undefined ? 'missing' : 'ON'}: a blind call would sign too, so a signature proves nothing. `
      + 'This suite never changes it: lock the device (it is session state on 7.16) and rerun')
  }
  console.log(`  firmware ${version}, AdvancedMode off, capabilities ${caps ? `[${caps.join(', ')}]` : '(not reported by this Desktop)'}`)
  return f
}

/** For suites that never turn AdvancedMode on but show a card whose main
 *  button can: at the end (also after a crash or a kill) it must still read
 *  off; if not, turn it off and FAIL. */
function guardAdvancedModeOff(sdk, assert) {
  atEnd(async () => {
    console.log(`\n  waiting ${FEATURES_WAIT_MS / 1000} s for Desktop's features cache...`)
    const on = advancedMode(await waitFeatures(sdk))
    if (on === false) return assert('AdvancedMode is still off at the end', true)
    const after = await restoreAdvancedMode(sdk)
    throw new Error(`AdvancedMode read ${on} at the end (now ${after}); this suite never turns it on`)
  })
}

// ── ClearSign report ─────────────────────────────────────────────────

/** Desktop's red line. */
const isRed = (line) => line.severity === 'danger'
const hasRed = (report) => [...report.findings, ...report.limitations].some(isRed)
const hasLimitation = (report, code) => report.limitations.some((l) => l.code === code)

/** One line a person can read: level, source, codes. */
function describeReport(report) {
  const d = report.descriptor || {}
  const codes = [...report.findings, ...report.limitations].map((l) => `${l.code}${isRed(l) ? '(red)' : ''}`)
  return `${report.protectionLevel} source=${d.source} authenticated=${d.authenticated}${d.format ? ` format=${d.format}` : ''} [${codes.join(', ')}]`
}

/** A report built without a device is useless here: FAIL, never skip. */
function assertDeviceConnected(assert, report, label) {
  assert(`${label}: Desktop saw the device`, !hasLimitation(report, 'DEVICE_NOT_CONNECTED'))
}

// ── ClearSign worker ─────────────────────────────────────────────────

/** GET/POST the worker. Returns { status, body } and never throws on HTTP
 *  errors; a network failure throws. */
async function worker(path, body) {
  const resp = await fetch(`${WORKER}${path}`, body === undefined
    ? { signal: AbortSignal.timeout(20_000) }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  const text = await resp.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: resp.status, body: parsed }
}

let _catalog = null
/** The signed catalog's entries. Solana entries have family 'solana' and no kind. */
async function catalogEntries() {
  if (_catalog) return _catalog
  const { status, body } = await worker('/v1/catalog')
  if (status !== 200 || !Array.isArray(body?.entries)) throw new Error(`worker /v1/catalog answered ${status}`)
  _catalog = body.entries
  return _catalog
}

/** EVM catalog entry, matched on lower-cased fields. `title` matches the
 *  intent title ('Token transfer', 'Token approval', 'Shared approval'),
 *  `pinned` an address the entry pins. */
async function findEvmEntry({ kind, chainId, contract, selector, title, method, pinned }) {
  const lc = (x) => String(x || '').toLowerCase()
  return (await catalogEntries()).find((e) => e.family === 'evm'
    && (!kind || e.kind === kind)
    && (!chainId || e.chainId === chainId)
    && (!contract || lc(e.contract) === lc(contract))
    && (!selector || lc(e.selector) === lc(selector))
    && (!title || e.title === title)
    && (!method || e.method === method)
    && (!pinned || (e.pinned || []).map(lc).includes(lc(pinned))))
}

/** Catalog entry by kind and chain, or SKIP naming it. */
async function requireEvmEntry(name, query) {
  const entry = await findEvmEntry(query)
  if (!entry) skip(`no catalog entry '${name}' (${JSON.stringify(query)})`)
  return entry
}

/** Certified name record for an address (/v1/evm/name), or null. */
async function certifiedName(chainId, address) {
  const entry = (await catalogEntries()).find((e) => e.kind === 'name' && e.chainId === chainId
    && e.address.toLowerCase() === address.toLowerCase())
  return entry ? entry.name : null
}

/** POST /v1/evm/schema. Returns the worker body ({ classification, keyId,
 *  alias, fingerprint, signedPayload, ... }) and the HTTP status. */
async function evmSchema(chainId, contract, selector, calldataLength) {
  return worker('/v1/evm/schema', { chainId, contract, selector, calldataLength })
}

/** True only for a production envelope: VERIFIED, keyId 0x80, our fingerprint. */
function isProductionEnvelope(body) {
  return body?.classification === 'VERIFIED' && body.keyId === CERTIFIED_KEY_ID
    && body.fingerprint === EXPECT_FINGERPRINT && String(body.signedPayload || '').startsWith('0x03')
}

// ── ERC-7730 (02 and 40 share this list) ─────────────────────────────

/** Candidates probed for a served calldata definition. Only the word-aligned,
 *  non-approve ones (a, b) can ever make 02/40 pass. */
const ERC7730_CANDIDATES = [
  { id: 'a', name: 'Base USDC transfer', chainId: 8453, to: USDC_BASE, selector: '0xa9059cbb', wordAligned: true, refused: false },
  { id: 'b', name: 'Aave v3 supply (chain 1)', chainId: 1, to: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', selector: '0x617ba037', wordAligned: true, refused: false },
  { id: 'c', name: 'chain-1 USDC approve (refused selector)', chainId: 1, to: USDC_ETH, selector: '0x095ea7b3', wordAligned: true, refused: true },
  { id: 'd', name: 'non-word-aligned call', chainId: 1, to: USDC_ETH, selector: '0xa9059cbb', wordAligned: false, refused: false },
]

/** GET /v1/erc7730/definition for one candidate: { status, code, body }. */
async function probeErc7730(c) {
  const q = `kind=calldata&chainId=${c.chainId}&contract=${c.to}&selector=${c.selector}`
  const { status, body } = await worker(`/v1/erc7730/definition?${q}`)
  return { status, code: body?.code, body }
}

/** Is a candidate served at all? Exit 3 (SKIP) when none of (a)/(b) answers 200. */
async function servedErc7730Candidates() {
  const results = []
  for (const c of ERC7730_CANDIDATES) results.push({ ...c, probe: await probeErc7730(c) })
  return results
}

// ── Sign cases with AdvancedMode off (41-43) ─────────────────────────

/** POST /v1/evm/schema with the body Desktop sends (evm-schema-registry.ts):
 *  the call shape, plus the spender for an approve. */
async function probeEvmSchema({ chainId, to, selector, spender }) {
  const { status, body } = await worker('/v1/evm/schema', { chainId, contract: to, selector, calldataLength: 68, ...(spender ? { spender } : {}) })
  const t = body?.tokenIdentity
  return {
    route: 'POST /v1/evm/schema', status, ok: status === 200 && body?.classification === 'VERIFIED',
    note: `${body?.classification || body?.code || ''} '${body?.method || ''}' entry=${body?.entry || '-'} fingerprint=${body?.fingerprint || '-'}${t ? ` tokenIdentity=${t.symbol}/${t.decimals} ${t.source}` : ''}`,
  }
}

/** GET /v1/erc7730/definition, as Desktop asks for a calldata definition. */
async function probeErc7730Case({ chainId, to, selector }) {
  const p = await probeErc7730({ chainId, to, selector })
  const embedded = p.body?.embeddedCalls === true
  return {
    route: 'GET /v1/erc7730/definition', status: p.status, ok: p.status === 200 && !embedded,
    note: `${p.code || ''}${p.body?.definitionId ? ` definition ${String(p.body.definitionId).slice(0, 18)}...` : ''}${embedded ? ' embeddedCalls (Desktop never sends these on 7.16)' : ''}`,
  }
}

/**
 * Sign each case on the device with AdvancedMode off; the suite sends no
 * txMetadata, Desktop attaches any description itself. A case whose worker
 * route has no answer is NOT COVERED with the gap named (a 'native' case signs
 * anyway). Pass per case: the signature recovers to the device on its chain
 * with the sentinel nonce, and the signed report's source is one `expect`
 * lists. Signs only: nothing is broadcast.
 *
 * case: { id, name, chainId, to, data(device), value?, gasLimit?, probe(),
 *         expect: ['certified'] | ['native', 'certified'] | ['erc7730'], screens(device) }
 */
async function signCases(getSdk, assert, cases, { cap, minBudgetMs } = {}) {
  const budget = Number(process.env.KEEPKEY_SUITE_TIMEOUT_MS) || 180_000
  if (minBudgetMs && budget < minBudgetMs) {
    skip(`needs KEEPKEY_SUITE_TIMEOUT_MS=${minBudgetMs}: run-all.js would kill it at ${budget} ms mid-sign`)
  }
  // The worker first: no Desktop contact when nothing can attach.
  for (const c of cases) {
    const w = await c.probe()
    console.log(`  ${c.id} ${c.name}: worker ${w.route} ${w.status} ${w.note}`)
    if (!w.ok && !c.expect.includes('native')) c.gap = `${c.id} ${c.name}: worker ${w.route} answers ${w.status} ${w.note}`.trim()
  }
  if (cases.every((c) => c.gap)) skip(cases.map((c) => c.gap).join('; '))

  const sdk = await getSdk()
  await requireClearSignOnly(sdk, cap)
  // The fallback card (no description, or the device refused one) offers Advanced Mode.
  guardAdvancedModeOff(sdk, assert)
  const { eth: device } = await deviceAddresses(sdk)
  console.log(`  device: ${device}`)

  for (const c of cases) {
    console.log(`\n  ── ${c.id} ${c.name} ──`)
    if (c.gap) { notCovered(c.gap); continue }
    const tx = evmTx({ from: device, to: c.to, data: c.data(device), value: c.value, chainId: c.chainId, gasLimit: c.gasLimit })
    const pre = await sdk.clearsign.report(reportBody(tx))
    assertDeviceConnected(assert, pre, `${c.id} pre-report`)
    console.log(`  pre-report: ${describeReport(pre)}`)
    const want7730 = c.expect.includes('erc7730')
    const found = want7730 ? pre.descriptor.source === 'erc7730' : !hasLimitation(pre, 'DEVICE_SHOWS_RAW_DATA')
    assert(`${c.id} pre-report: Desktop found the description (${want7730 ? "source 'erc7730'" : 'no DEVICE_SHOWS_RAW_DATA'})`, found)
    if (!found) {
      console.error('  not signing: the card would offer Advanced Mode. Check the Desktop log ([clearsign] / [erc7730] lines).')
      continue
    }

    console.log('  OWNER: approve the Desktop card (never Enable Advanced Mode), then confirm on the device:')
    for (const s of c.screens(device)) console.log(`    - ${s}`)
    console.log('  A SECOND card for the same call (offering Advanced Mode) means the device refused the description: Reject it.')
    let out
    try {
      out = await sdk.eth.ethSignTransaction(tx)
    } catch (e) {
      console.error(`  sign refused: ${String(e?.message || e).slice(0, 300)}`)
      assert(`${c.id} device signed`, false)
      continue
    }
    assertSignedByDevice(assert, out, device, c.chainId)
    const r = out.clearSignReport
    assert(`${c.id} response carries clearSignReport`, !!r)
    if (!r) continue
    console.log(`  signed report: ${describeReport(r)}`)
    assert(`${c.id} signed report source is ${c.expect.join(' or ')} (read '${r.descriptor.source}')`, c.expect.includes(r.descriptor.source))
    if (want7730) assert(`${c.id} no ERC7730_DEFINITION_REFUSED`, !hasLimitation(r, 'ERC7730_DEFINITION_REFUSED'))
  }
}

// ── Builders ─────────────────────────────────────────────────────────

const word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0')
const randomHex = (bytes) => '0x' + require('crypto').randomBytes(bytes).toString('hex')
const randomAddress = () => randomHex(20)

/** EIP-1559 fields every signing suite shares. */
function evmTx({ from, to, data = '0x', value = '0x0', chainId, gasLimit = '0x30d40' }) {
  return {
    from, addressNList: ETH_PATH, to, data, value, chainId,
    nonce: SENTINEL_NONCE, gasLimit,
    maxFeePerGas: '0x' + (30e9).toString(16), maxPriorityFeePerGas: '0x' + (1.5e9).toString(16),
  }
}

/** /clearsign/report body for the same tx. */
function reportBody(tx) {
  return {
    chain: 'evm', chainId: tx.chainId, from: tx.from, to: tx.to, data: tx.data, value: tx.value,
    nonce: tx.nonce, gas: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  }
}

module.exports = {
  TRON_PATH, WORKER, EXPECT_FINGERPRINT, CERTIFIED_KEY_ID, FEATURES_WAIT_MS,
  USDC_BASE, USDC_ETH, PERMIT2,
  sleep, deviceAddresses, advancedMode, waitFeatures, requireAdvancedModeOff, requireClearSignOnly, restoreAdvancedMode, guardAdvancedModeOff,
  isRed, hasRed, hasLimitation, describeReport, assertDeviceConnected,
  worker, catalogEntries, findEvmEntry, requireEvmEntry, certifiedName, evmSchema, isProductionEnvelope,
  ERC7730_CANDIDATES, probeErc7730, servedErc7730Candidates,
  probeEvmSchema, probeErc7730Case, signCases,
  word, randomHex, randomAddress, evmTx, reportBody,
}
