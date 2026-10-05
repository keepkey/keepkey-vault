import { createHash } from 'node:crypto'
import { SigningKey, computePublicKey } from '@ethersproject/signing-key'
import bs58 from 'bs58'

import {
  ALPHA_DELEGATE_FINGERPRINT,
  ALPHA_DELEGATE_PUBLIC_KEY,
  ALPHA_ROOT_PUBLIC_KEY,
  CLEARSIGN_SCOPE_ETHEREUM,
  CLEARSIGN_SCOPE_SOLANA,
  inspectAlphaCertificate,
} from '../../src/bun/clearsign-alpha-ceremony'
import {
  buildCertifiedEvmEnvelope,
  buildCertifiedEvmNameEnvelope,
  buildCertifiedEvmDecoderEnvelope,
  EVM_DECODER_UNISWAP_UR,
  expectedUniswapScreens,
  findReviewedUniversalRouter,
  REVIEWED_UNIVERSAL_ROUTERS,
  urV4Router,
  reviewedSwapTokens,
  UR_MAX_TOKENS,
  UR_METHOD,
  UR_SELECTORS,
  UR_TITLE,
  findEvmNameRecord,
  UNIVERSAL_ROUTER_PROVENANCE,
  CERTIFIED_EVM_CATALOG,
  CERTIFIED_METADATA_KEY_ID,
  ERC20_APPROVE,
  ERC20_TRANSFER,
  EVM_ARG_ADDRESS_PINNED,
  expectedEvmScreens,
  findCertifiedEvmSchemaByShape,
  findReviewedTokenSchema,
  PERMIT2_ADDRESS,
  PERMIT2_PROVENANCE,
  REVIEWED_EVM_TOKENS,
  type EvmSchemaSpec,
} from '../../src/bun/evm-certified-schema'
import { signCertifiedSolanaLutAttestation } from '../../src/bun/solana-certified-lut'
import {
  CERTIFIED_SOLANA_CATALOG,
  signCertifiedSolanaSchema,
  solanaSchemaCoverage,
} from '../../src/bun/solana-certified-schema'
import { certifiedSolanaSchemaApplies, solanaInstructionMatchesSchema } from '../../src/bun/solana-certified-match'
import { resolveCanonicalLutAccounts } from '../../src/bun/solana-lut-resolver'
import { createResilientSolanaAltFetcher, solanaRpcHealth, SolanaRpcUnavailableError } from './solana-rpc'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from '../../src/bun/solana-tx'
import { certifySchemaTokens } from './solana-token'

interface Env {
  CLEARSIGN_ENVIRONMENT?: string
  CLEARSIGN_DELEGATE_PRIVATE_KEY?: string
  CLEARSIGN_CERTIFICATE_HEX?: string
  CLEARSIGN_SOLANA_CERTIFICATE_HEX?: string
  /** {"<chainId>": "<certificate hex>"} for EVM chains other than Ethereum. */
  CLEARSIGN_EVM_CERTIFICATES_JSON?: string
  CLEARSIGN_SOLANA_RPC_ENDPOINT?: string
  CLEARSIGN_SOLANA_RPC_ENDPOINTS?: string
  CLEARSIGN_SOURCE_REVISION?: string
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string }
}

const SERVICE = 'KeepKey ClearSign'
const REQUEST_LIMIT = 64 * 1024
const PROVENANCE = {
  operator: 'KeepKey',
  firmware: 'https://github.com/keepkey/keepkey-firmware',
  vault: 'https://github.com/keepkey/keepkey-vault',
  protocol: 'https://docs.relay.link/references/protocol/how-it-works',
  protocolSecurity: 'https://docs.relay.link/references/protocol/security',
  portals: 'https://docs.portals.fi/',
  portalsRouter: 'https://eth.blockscout.com/address/0xbf5A7F3629fB325E2a8453D595AB103465F75E62?tab=contract',
} as const

const commonHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
}

function json(value: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...commonHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  })
}

const EVM_NETWORKS: Record<number, string> = { 1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum' }

/** Certificate for an EVM chain: Ethereum's own secret, others from the JSON map. */
function evmCertificateHex(env: Env, chainId: number): string | undefined {
  if (chainId === CLEARSIGN_SCOPE_ETHEREUM) return env.CLEARSIGN_CERTIFICATE_HEX
  try {
    const value = JSON.parse(env.CLEARSIGN_EVM_CERTIFICATES_JSON || '{}')[String(chainId)]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function reviewedTokenEntries(): EvmSchemaSpec[] {
  return Object.entries(REVIEWED_EVM_TOKENS).flatMap(([key]) => {
    const [chainId, contract] = key.split(':')
    return ([[ERC20_APPROVE, PERMIT2_ADDRESS], [ERC20_APPROVE, undefined], [ERC20_TRANSFER, undefined]] as const)
      .map(([selector, spender]) => findReviewedTokenSchema(Number(chainId), contract, selector, 68, spender)!)
      .map((spec) => ({
        ...spec,
        displayFields: spec.args.map((arg) => arg.name),
        provenance: {
          protocol: 'https://eips.ethereum.org/EIPS/eip-20',
          tokenList: 'https://tokens.uniswap.org',
          review: 'Uniswap Labs Default list v22.24.0 agrees with the contract symbol() and decimals(), 2026-10-03',
          ...(spec.args.some((arg) => arg.pinned) ? { spender: PERMIT2_PROVENANCE } : {}),
        },
      }))
  })
}

const uniswapEntryId = (chainId: number, router: string) => `eip155:${chainId}:${router.toLowerCase()}:uniswap-ur`

const isPinnedSpender = (spec: EvmSchemaSpec) => spec.args.some((arg) => arg.format === EVM_ARG_ADDRESS_PINNED)
const evmEntryId = (spec: EvmSchemaSpec) =>
  `eip155:${spec.chainId}:${spec.contract}:${spec.selector}${isPinnedSpender(spec) ? ':permit2' : ''}`

function reviewedCatalog() {
  const evm = [...Object.values(CERTIFIED_EVM_CATALOG), ...reviewedTokenEntries()].map((spec) => ({
    id: evmEntryId(spec),
    family: 'evm',
    network: EVM_NETWORKS[spec.chainId] || `EVM ${spec.chainId}`,
    protocol: spec.protocol || 'Relay',
    maintainedBy: spec.maintainedBy || 'Relay',
    action: spec.action || 'Deposit funds for a cross-chain swap',
    method: spec.method,
    contract: spec.contract,
    selector: spec.selector,
    ...(spec.expectedCalldataLength !== undefined
      ? { calldataLength: spec.expectedCalldataLength }
      : { calldataLength: { min: spec.minimumCalldataLength, max: spec.maximumCalldataLength, alignment: 'selector + ABI words' } }),
    fieldsShownByKeepKey: spec.displayFields || spec.args.map((arg) => arg.name),
    ...(isPinnedSpender(spec) ? { spender: PERMIT2_ADDRESS } : {}),
    ...(spec.intent ? { title: spec.intent.title, template: spec.intent.template } : {}),
    // What the device shows, in order (signed_metadata_build_intent_review).
    screens: expectedEvmScreens(spec) || [],
    ...(spec.intent ? {} : {
      screensNote: 'No intent. Firmware 7.16 parses inner versions 0x01, 0x02, 0x05, 0x06 and 0x07 only; this 0x04 decoder schema cannot verify on 7.16, and a certified envelope carrying it is refused, not downgraded.',
    }),
    provenance: spec.provenance || { protocol: PROVENANCE.protocol, security: PROVENANCE.protocolSecurity },
  }))
  // One entry per reviewed router; the request names the selector and tokens.
  const swaps = REVIEWED_UNIVERSAL_ROUTERS.map((router) => ({
    id: uniswapEntryId(router.chainId, router.address),
    family: 'evm',
    network: EVM_NETWORKS[router.chainId] || `EVM ${router.chainId}`,
    protocol: 'Uniswap',
    maintainedBy: 'Uniswap Labs',
    action: 'Swap tokens through the Uniswap Universal Router',
    method: UR_METHOD,
    contract: router.address,
    selectors: [...UR_SELECTORS],
    calldataLength: { note: 'any length: the device decodes the call as its chunks arrive (firmware 7.16 builds before the streaming decoder held at most 1472 bytes)' },
    decoder: { id: EVM_DECODER_UNISWAP_UR, name: 'Uniswap Universal Router', innerVersion: 7 },
    title: UR_TITLE,
    supportedShape: `up to 6 steps, read as token flow through the router: [PERMIT2_PERMIT naming this router] then V2/V3${urV4Router(router.chainId, router.address) ? '/V4 (V4_SWAP: SWAP_EXACT_IN/OUT with SETTLE, TAKE, optional TAKE_PORTION; empty hookData; at most 3 distinct hooks, each shown)' : ''} swaps, WRAP_ETH, UNWRAP_WETH, SWEEP and one PAY_PORTION; the user pays one asset (msg.value or one Permit2 token), one asset reaches one recipient (leftover ETH may go back to it), router-paid swaps (splits, multi-hop) are free to the user; all swaps exact-in or all exact-out; no allow-revert flags${urV4Router(router.chainId, router.address) ? '' : '; V4_SWAP refused (decoded only for UR 2.1.2 on Base)'}`,
    tokens: 'every token the review names, and only those: the paid token (unless ETH, from msg.value), the delivered token (unless ETH), and the Permit2 token; never native ETH or a route\'s intermediate tokens; each a reviewed token on this chain; 1-4 per entry',
    fieldsShownByKeepKey: ['Input amount', 'Output limit', 'Recipient', 'Permit2 allowance', 'Fee', ...(urV4Router(router.chainId, router.address) ? ['Pool hooks'] : [])],
    screens: expectedUniswapScreens(router.chainId, router.address),
    provenance: {
      protocol: 'https://github.com/Uniswap/universal-router',
      deployment: `${UNIVERSAL_ROUTER_PROVENANCE} (${router.source})`,
      tokenList: 'https://tokens.uniswap.org',
    },
  }))
  const solana = Object.entries(CERTIFIED_SOLANA_CATALOG).map(([key, spec]) => ({
    id: `solana:${key}`,
    family: 'solana',
    network: 'Solana',
    protocol: spec.protocol || 'Relay',
    maintainedBy: spec.protocol || 'Relay',
    action: spec.action || 'Deposit funds for a cross-chain swap',
    method: spec.instructionName,
    program: spec.programId,
    discriminator: spec.discriminator.toString('hex'),
    instructionLength: solanaSchemaCoverage(spec),
    fieldsShownByKeepKey: [
      ...(spec.args || []).map((arg) => arg.label),
      ...(spec.accounts || []).map((account) => account.label),
    ],
    provenance: spec.provenance || { protocol: PROVENANCE.protocol, security: PROVENANCE.protocolSecurity },
  }))
  return [...evm, ...swaps, ...solana]
}

function provisioning(env: Env) {
  const issues: string[] = []
  let evmCertificate: ReturnType<typeof inspectAlphaCertificate> | undefined
  let solanaCertificate: ReturnType<typeof inspectAlphaCertificate> | undefined

  const inspectScope = (value: string | undefined, scope: number, label: string) => {
    if (!value) {
      issues.push(`${label} certificate pending`)
      return undefined
    }
    try {
      const certificate = inspectAlphaCertificate(value)
      if (certificate.chainId !== scope) throw new Error('wrong scope')
      return certificate
    } catch {
      issues.push(`${label} certificate invalid, expired, or wrong-scope`)
      return undefined
    }
  }

  evmCertificate = inspectScope(env.CLEARSIGN_CERTIFICATE_HEX, CLEARSIGN_SCOPE_ETHEREUM, 'Ethereum')
  solanaCertificate = inspectScope(env.CLEARSIGN_SOLANA_CERTIFICATE_HEX, CLEARSIGN_SCOPE_SOLANA, 'Solana')
  const evmChains: number[] = evmCertificate ? [CLEARSIGN_SCOPE_ETHEREUM] : []
  let extraEvm: Record<string, unknown> = {}
  try {
    extraEvm = JSON.parse(env.CLEARSIGN_EVM_CERTIFICATES_JSON || '{}')
  } catch {
    issues.push('EVM certificate map is not valid JSON')
  }
  for (const [chain, hex] of Object.entries(extraEvm)) {
    const chainId = Number(chain)
    if (typeof hex === 'string' && inspectScope(hex, chainId, `EVM ${chain}`)) evmChains.push(chainId)
  }

  let privateKeyValid = false
  if (!env.CLEARSIGN_DELEGATE_PRIVATE_KEY) {
    issues.push('delegate signing key pending')
  } else if (!/^[0-9a-fA-F]{64}$/.test(env.CLEARSIGN_DELEGATE_PRIVATE_KEY)) {
    issues.push('delegate signing key invalid')
  } else {
    try {
      const key = new SigningKey(`0x${env.CLEARSIGN_DELEGATE_PRIVATE_KEY}`)
      privateKeyValid = computePublicKey(key.publicKey, true).slice(2).toLowerCase() === ALPHA_DELEGATE_PUBLIC_KEY
      if (!privateKeyValid) issues.push('delegate signing key does not match reviewed fingerprint')
    } catch {
      issues.push('delegate signing key invalid')
    }
  }

  return {
    ready: Boolean((evmCertificate || solanaCertificate) && privateKeyValid),
    evmReady: Boolean(evmChains.length && privateKeyValid),
    evmChains,
    solanaReady: Boolean(solanaCertificate && privateKeyValid),
    evmCertificate,
    solanaCertificate,
    privateKeyValid,
    issues,
  }
}

async function publicStatus(env: Env, origin: string) {
  const state = provisioning(env)
  const rpc = state.solanaReady ? await solanaRpcHealth(env) : undefined
  const dependencyUnavailable = rpc?.status === 'unavailable'
  const expires = [state.evmCertificate?.notAfter, state.solanaCertificate?.notAfter].filter(Boolean) as number[]
  return {
    service: SERVICE,
    environment: env.CLEARSIGN_ENVIRONMENT || 'production',
    status: !state.ready ? 'provisioning' : dependencyUnavailable ? 'degraded' : 'ready',
    build: { sourceRevision: env.CLEARSIGN_SOURCE_REVISION || null, version: env.CF_VERSION_METADATA || null },
    dependencies: { solanaRpc: rpc || { status: 'not-configured' } },
    message: dependencyUnavailable
      ? 'Solana lookup-table verification is temporarily unavailable. Ethereum signing remains independently available.'
      : state.ready
      ? 'KeepKey can authenticate transaction descriptions for every scope marked ready below, without blind signing.'
      : 'The service is online, but no certified signing scope is active yet.',
    endpoints: {
      status: `${origin}/v1/status`,
      catalog: `${origin}/v1/catalog`,
      evmSchema: `${origin}/v1/evm/schema`,
      evmSwap: `${origin}/v1/evm/swap`,
      solanaCertify: `${origin}/v1/solana/certify`,
    },
    scopes: {
      ethereum: state.evmReady ? 'ready' : 'provisioning',
      solana: !state.solanaReady ? 'provisioning' : dependencyUnavailable ? 'degraded' : 'ready',
      evmChains: state.privateKeyValid ? state.evmChains : [],
    },
    trust: {
      label: state.ready ? 'Authenticated by KeepKey' : 'Certificate pending',
      signerAlias: state.evmCertificate?.alias || state.solanaCertificate?.alias || 'KeepKey Vault',
      signerFingerprint: ALPHA_DELEGATE_FINGERPRINT,
      signerPublicKey: ALPHA_DELEGATE_PUBLIC_KEY,
      rootPublicKey: ALPHA_ROOT_PUBLIC_KEY,
      certificateExpiresAt: expires.length ? new Date(Math.min(...expires) * 1000).toISOString() : null,
      deviceChecksCertificate: true,
      deviceChecksTransactionBinding: true,
    },
    privacy: {
      applicationStorage: false,
      ethereumRequest: ['chainId', 'contract', 'selector', 'calldataLength', 'spender (ERC-20 approve only, optional)'],
      ethereumSwapRequest: ['chainId', 'router', 'selector', 'token addresses the device review names (Uniswap swap only)'],
      ethereumNote: 'For an ERC-20 approve, the spender address may be sent so the service can return the matching description (Uniswap Permit2 or a generic approval). No amount or other argument is sent.',
      solanaRequest: ['unsigned transaction', 'reviewed catalog id (optional)'],
      note: 'Solana lookup-table certification sends the unsigned transaction to this service so it can resolve and bind the exact accounts. No seed, private key, PIN, passphrase, or device signature is sent.',
    },
    catalogEntries: reviewedCatalog().length,
    provisioning: state.issues,
    provenance: PROVENANCE,
  }
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

async function home(env: Env, origin: string): Promise<Response> {
  const status = await publicStatus(env, origin)
  const ready = status.status === 'ready'
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SERVICE}</title><style>body{margin:0;background:#0b0d10;color:#eef2f5;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:820px;margin:0 auto;padding:56px 24px}h1{font-size:28px;margin:0 0 8px}.muted{color:#929aa5}.card{border:1px solid #29313a;background:#11151a;border-radius:14px;padding:20px;margin:18px 0}.pill{display:inline-block;border:1px solid ${ready ? '#42d392' : '#e7b84b'};color:${ready ? '#42d392' : '#e7b84b'};border-radius:999px;padding:3px 10px;font-size:12px}dt{color:#929aa5}dd{margin:0 0 10px;word-break:break-all}a{color:#7dd3fc}code{color:#d9b75f}</style></head>
<body><main><span class="pill">${escapeHtml(status.status)}</span><h1>KeepKey ClearSign</h1><p class="muted">Human-readable transaction details, authenticated by the KeepKey in your hand.</p>
<section class="card"><h2>What happens</h2><p>${escapeHtml(status.message)}</p><p>The service recognizes a reviewed protocol action and signs a description. Your KeepKey independently checks the root certificate, signer fingerprint, program or contract, decoded fields, and the exact transaction binding. You still approve the final transaction on the device.</p></section>
<section class="card"><h2>Trust status</h2><dl><dt>Device label</dt><dd>${escapeHtml(status.trust.label)}</dd><dt>Signer</dt><dd>${escapeHtml(status.trust.signerAlias)} · ${escapeHtml(status.trust.signerFingerprint)}</dd><dt>Ethereum</dt><dd>${escapeHtml(status.scopes.ethereum)}</dd><dt>Solana</dt><dd>${escapeHtml(status.scopes.solana)}</dd><dt>Earliest certificate expiry</dt><dd>${escapeHtml(status.trust.certificateExpiresAt || 'Pending')}</dd></dl></section>
<section class="card"><h2>Reviewed protocols</h2><p><strong>Relay</strong> · Ethereum and Solana deposits for cross-chain swaps.</p><p><strong>Portals</strong> · Native ETH swaps through the verified Ethereum router. KeepKey reads the output token, minimum output, recipient, and input amount from the transaction itself.</p><p><strong>Pump AMM</strong> · Token buys with base output units, maximum quote input units, token mints, and receive/pay accounts decoded on your KeepKey.</p><p><strong>SoltoshiDICE</strong> · Blackjack table joins with the round, seat, token buy-in, session key, session length, allowance, and maximum wager decoded on your KeepKey.</p><p>Only exact catalog matches are certified. Unknown programs, contracts, selectors, instruction sizes, or lookup-table accounts are refused.</p><a href="/v1/catalog">View the machine-readable catalog</a></section>
<section class="card"><h2>Privacy and provenance</h2><p>Ethereum requests contain only transaction shape. Solana lookup-table requests contain the unsigned transaction so this service can resolve and bind its accounts. Wallet seeds, private keys, PINs, passphrases, and device signatures never leave your KeepKey. This service writes no transaction database.</p><p><a href="${PROVENANCE.protocol}">How Relay works</a> · <a href="${PROVENANCE.protocolSecurity}">Relay security</a> · <a href="${PROVENANCE.portals}">Portals documentation</a> · <a href="${PROVENANCE.portalsRouter}">Verified Portals router</a> · <a href="${PROVENANCE.firmware}">KeepKey firmware</a> · <a href="${PROVENANCE.vault}">Vault source</a></p></section>
</main></body></html>`
  return new Response(html, {
    headers: {
      ...commonHeaders,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  })
}

async function readJson(request: Request): Promise<any> {
  const contentLength = Number(request.headers.get('content-length') || 0)
  if (!Number.isFinite(contentLength) || contentLength > REQUEST_LIMIT) throw new Error('request too large')
  const text = await request.text()
  if (text.length > REQUEST_LIMIT) throw new Error('request too large')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('invalid JSON')
  }
}

function decodeCanonicalBase64(value: unknown): Buffer {
  const encoded = String(value || '')
  if (!encoded || encoded.length > REQUEST_LIMIT || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('rawTx must be canonical base64')
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (!decoded.length || decoded.toString('base64') !== encoded) throw new Error('rawTx must be canonical base64')
  return decoded
}

/** PumpSwap AMM (official IDL): buy carries two volume accumulators before
 * the fee config, so its fee program is at 22; sell's is at 20. */
const PUMP_AMM_PINS: Record<string, { minAccounts: number, feeProgramIndex: number }> = {
  pumpAmmBuy: { minAccounts: 23, feeProgramIndex: 22 },
  pumpAmmSell: { minAccounts: 21, feeProgramIndex: 20 },
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: commonHeaders })
    if (request.method === 'GET' && url.pathname === '/') return home(env, url.origin)
    if (request.method === 'GET' && url.pathname === '/health') {
      const status = await publicStatus(env, url.origin)
      return json({ ok: true, ready: status.status === 'ready', service: 'keepkey-clearsign', fingerprint: ALPHA_DELEGATE_FINGERPRINT, build: status.build, dependencies: status.dependencies })
    }
    if (request.method === 'GET' && (url.pathname === '/ready' || url.pathname === '/v1/status')) {
      const status = await publicStatus(env, url.origin)
      return json(status, url.pathname === '/ready' && status.status !== 'ready' ? 503 : 200)
    }
    if (request.method === 'GET' && url.pathname === '/v1/catalog') {
      return json({ version: 1, entries: reviewedCatalog(), provenance: PROVENANCE }, 200, 'public, max-age=300')
    }
    if (request.method === 'GET' && url.pathname === '/signer') {
      const status = await publicStatus(env, url.origin)
      return json({ status: status.status, alias: status.trust.signerAlias, fingerprint: ALPHA_DELEGATE_FINGERPRINT, publicKeyHex: ALPHA_DELEGATE_PUBLIC_KEY, keyId: CERTIFIED_METADATA_KEY_ID, scopes: status.scopes, certificateExpiresAt: status.trust.certificateExpiresAt })
    }

    if (request.method === 'POST' && (url.pathname === '/v1/evm/schema' || url.pathname === '/sign')) {
      let body: any
      try { body = await readJson(request) } catch (error: any) {
        return json({ error: error.message }, error.message === 'request too large' ? 413 : 400)
      }
      // Optional, approve only: the spender word picks the Permit2 or generic entry.
      const spender = body?.spender === undefined ? undefined : String(body.spender)
      if (spender !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(spender)) {
        return json({ error: 'spender must be a 20-byte 0x address' }, 400)
      }
      const spec = findCertifiedEvmSchemaByShape(Number(body?.chainId), String(body?.contract || body?.to || ''), String(body?.selector || ''), Number(body?.calldataLength), spender)
      if (!spec) return json({ classification: 'OPAQUE', error: 'contract, selector, or calldata shape is not in the reviewed catalog' }, 422)
      const state = provisioning(env)
      const certificate = evmCertificateHex(env, spec.chainId)
      if (!state.evmChains.includes(spec.chainId) || !certificate || !state.privateKeyValid || !env.CLEARSIGN_DELEGATE_PRIVATE_KEY) {
        return json({ classification: 'UNAVAILABLE', entry: evmEntryId(spec), error: `certified signing is not provisioned for chain ${spec.chainId}` }, 503)
      }
      try {
        const signed = buildCertifiedEvmEnvelope(spec, certificate, env.CLEARSIGN_DELEGATE_PRIVATE_KEY)
        return json({ success: true, classification: 'VERIFIED', version: 3, entry: evmEntryId(spec), ...signed, method: spec.method, ...(isPinnedSpender(spec) ? { spender: PERMIT2_ADDRESS } : {}), chainId: spec.chainId, contract: spec.contract, selector: spec.selector, expectedCalldataLength: spec.expectedCalldataLength, decoder: spec.decoder, provenance: spec.provenance || PROVENANCE })
      } catch {
        return json({ error: 'certified Ethereum schema could not be produced' }, 500)
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/evm/swap') {
      let body: any
      try { body = await readJson(request) } catch (error: any) {
        return json({ error: error.message }, error.message === 'request too large' ? 413 : 400)
      }
      const tokens = body?.tokens
      if (!Array.isArray(tokens) || !tokens.every((t: unknown) => typeof t === 'string' && /^0x[0-9a-fA-F]{40}$/.test(t))) {
        return json({ error: 'tokens must be an array of 20-byte 0x addresses' }, 400)
      }
      const chainId = Number(body?.chainId)
      const router = findReviewedUniversalRouter(chainId, String(body?.contract || ''))
      const selector = String(body?.selector || '').toLowerCase()
      if (!router || !(UR_SELECTORS as readonly string[]).includes(selector)) {
        return json({ classification: 'OPAQUE', error: 'router or selector is not a reviewed Universal Router execute()' }, 422)
      }
      const identities = reviewedSwapTokens(chainId, tokens)
      if (!identities) {
        return json({ classification: 'OPAQUE', error: `tokens must be 1-${UR_MAX_TOKENS} distinct reviewed tokens on chain ${chainId}` }, 422)
      }
      const entry = uniswapEntryId(chainId, router.address)
      const state = provisioning(env)
      const certificate = evmCertificateHex(env, chainId)
      if (!state.evmChains.includes(chainId) || !certificate || !state.privateKeyValid || !env.CLEARSIGN_DELEGATE_PRIVATE_KEY) {
        return json({ classification: 'UNAVAILABLE', entry, error: `certified signing is not provisioned for chain ${chainId}` }, 503)
      }
      try {
        const signed = buildCertifiedEvmDecoderEnvelope(chainId, router.address, selector, identities, certificate, env.CLEARSIGN_DELEGATE_PRIVATE_KEY)
        return json({ success: true, classification: 'VERIFIED', version: 7, entry, ...signed, chainId, contract: router.address, selector, method: UR_METHOD, decoder: EVM_DECODER_UNISWAP_UR, title: UR_TITLE, tokens: identities, provenance: { source: UNIVERSAL_ROUTER_PROVENANCE, entry: router.source } })
      } catch {
        return json({ error: 'certified swap entry could not be produced' }, 500)
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/evm/name') {
      let body: any
      try { body = await readJson(request) } catch (error: any) {
        return json({ error: error.message }, error.message === 'request too large' ? 413 : 400)
      }
      const record = findEvmNameRecord(Number(body?.chainId), String(body?.address || ''))
      if (!record) return json({ classification: 'OPAQUE', error: 'address is not in the reviewed name catalog' }, 422)
      const state = provisioning(env)
      const certificate = evmCertificateHex(env, record.chainId)
      if (!state.evmChains.includes(record.chainId) || !certificate || !state.privateKeyValid || !env.CLEARSIGN_DELEGATE_PRIVATE_KEY) {
        return json({ classification: 'UNAVAILABLE', error: `certified signing is not provisioned for chain ${record.chainId}` }, 503)
      }
      try {
        const signed = buildCertifiedEvmNameEnvelope(record, certificate, env.CLEARSIGN_DELEGATE_PRIVATE_KEY)
        return json({ success: true, classification: 'VERIFIED', version: 6, ...signed, chainId: record.chainId, address: record.address, name: record.name, provenance: { source: UNIVERSAL_ROUTER_PROVENANCE, entry: record.source } })
      } catch (error: any) {
        // The only certificate held is scoped to one chain; other chains need their own.
        return json({ classification: 'UNAVAILABLE', error: String(error?.message || 'name could not be certified') }, 422)
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/solana/certify') {
      let body: any
      try { body = await readJson(request) } catch (error: any) {
        return json({ error: error.message }, error.message === 'request too large' ? 413 : 400)
      }
      const requestedKey = body?.catalogKey === undefined ? undefined : String(body.catalogKey)
      if (requestedKey !== undefined && !Object.hasOwn(CERTIFIED_SOLANA_CATALOG, requestedKey)) {
        return json({ classification: 'OPAQUE', error: 'catalogKey is not in the reviewed catalog' }, 422)
      }

      let fullTx: Buffer
      let messageBytes: Uint8Array
      let message: ReturnType<typeof parseSolanaMessage>
      try {
        fullTx = decodeCanonicalBase64(body?.rawTx)
        const parsedTx = parseSolanaTx(fullTx)
        messageBytes = solanaMessageSlice(fullTx, parsedTx)
        message = parseSolanaMessage(messageBytes)
      } catch (error: any) {
        return json({ classification: 'OPAQUE', error: error?.message || 'malformed Solana transaction' }, 422)
      }

      const candidates = Object.entries(CERTIFIED_SOLANA_CATALOG).filter(([key]) => requestedKey === undefined || key === requestedKey)
      // Every (entry, instruction) pair that matches. Firmware refuses a schema
      // that matches two instructions, so exactly one pair may certify.
      const matches = candidates.flatMap(([key, spec]) => message.instructions.filter((instruction) => {
        if (!solanaInstructionMatchesSchema(message, instruction, spec)) return false
        const pump = PUMP_AMM_PINS[key]
        if (pump) {
          if (instruction.accountIndices.length < pump.minAccounts) return false
          if (key === 'pumpAmmBuy' && instruction.data[24] > 1) return false
          // Pin the official IDL's fixed program accounts and required user
          // signer; an arbitrary program label cannot certify another CPI.
          const fixedAccounts: Record<number, string> = {
            13: '11111111111111111111111111111111',
            14: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
            16: spec.programId,
            [pump.feeProgramIndex]: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
          }
          if (instruction.accountIndices[1] >= message.header.numRequiredSignatures) return false
          for (const [index, expected] of Object.entries(fixedAccounts)) {
            const account = message.staticAccounts[instruction.accountIndices[Number(index)]]
            if (!account || bs58.encode(account) !== expected) return false
          }
        }
        return true
      }).map((instruction) => [key, spec, instruction] as const))
      if (matches.length !== 1) {
        return json({ classification: 'OPAQUE', error: 'transaction does not uniquely match a reviewed Solana catalog entry' }, 422)
      }
      const [catalogKey, spec, instruction] = matches[0]
      // Without a catalog key this is a dapp's own transaction. The device
      // refuses a certified envelope its certified rule does not apply to,
      // with no blind-sign fallback, while the caller's opaque path could
      // still sign it. So certify it only when that rule holds.
      if (requestedKey === undefined &&
          certifiedSolanaSchemaApplies(message, spec) !== message.instructions.indexOf(instruction)) {
        return json({ classification: 'OPAQUE', error: 'firmware would not apply the reviewed schema to this transaction (instruction count or companion instructions)' }, 422)
      }

      const state = provisioning(env)
      if (!state.solanaReady || !env.CLEARSIGN_SOLANA_CERTIFICATE_HEX || !env.CLEARSIGN_DELEGATE_PRIVATE_KEY) {
        return json({ classification: 'UNAVAILABLE', error: 'Solana certified signing is not provisioned' }, 503)
      }

      let proofStage = 'schema'
      try {
        const schema = signCertifiedSolanaSchema(env.CLEARSIGN_SOLANA_CERTIFICATE_HEX, env.CLEARSIGN_DELEGATE_PRIVATE_KEY, spec)
        const response: any = {
          catalogKey,
          success: true,
          classification: 'VERIFIED',
          schema: { payload: schema.schemaPayload, signature: schema.schemaSignature, signerKeyId: schema.keyId },
          certificate: `0x${env.CLEARSIGN_SOLANA_CERTIFICATE_HEX.replace(/^0x/i, '')}`,
          alias: schema.alias,
          fingerprint: schema.fingerprint,
          transactionShape: message.version,
          lookupTableCount: message.altEntries.length,
          provenance: spec.provenance || PROVENANCE,
        }
        // Firmware indexes static accounts, then the resolved lookup accounts.
        let accountKeys: Uint8Array[] = message.staticAccounts
        if (message.altEntries.length > 0) {
          proofStage = 'lookup-resolution'
          const resolution = await resolveCanonicalLutAccounts(
            message,
            createResilientSolanaAltFetcher(env),
          )
          proofStage = 'lookup-signature'
          const messageHash = createHash('sha256').update(messageBytes).digest()
          const proof = signCertifiedSolanaLutAttestation(env.CLEARSIGN_SOLANA_CERTIFICATE_HEX, env.CLEARSIGN_DELEGATE_PRIVATE_KEY, messageHash, resolution.accounts)
          response.lutProof = {
            accounts: resolution.accounts.map((account) => account.toString('base64')),
            signature: proof.lutSignature,
            signerKeyId: proof.keyId,
          }
          response.writableCount = resolution.writableCount
          response.readonlyCount = resolution.readonlyCount
          accountKeys = [...message.staticAccounts, ...resolution.accounts]
        }

        proofStage = 'token-identity'
        Object.assign(response, await certifySchemaTokens(env, catalogKey, spec, instruction, accountKeys, env.CLEARSIGN_DELEGATE_PRIVATE_KEY))
        return json(response)
      } catch (error) {
        const code = error instanceof SolanaRpcUnavailableError ? error.code : 'SOLANA_PROOF_FAILED'
        console.error(`[clearsign] Solana certification failed: stage=${proofStage} code=${code}`)
        return json({ classification: 'UNAVAILABLE', code, error: error instanceof SolanaRpcUnavailableError ? error.message : 'certified Solana proof could not be produced' }, error instanceof SolanaRpcUnavailableError ? 503 : 500)
      }
    }
    return json({ error: 'not found' }, 404)
  },
}
