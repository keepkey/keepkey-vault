import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'
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
  CERTIFIED_EVM_CATALOG,
  CERTIFIED_METADATA_KEY_ID,
  findCertifiedEvmSchemaByShape,
} from '../../src/bun/evm-certified-schema'
import { signCertifiedSolanaLutAttestation } from '../../src/bun/solana-certified-lut'
import {
  CERTIFIED_SOLANA_CATALOG,
  signCertifiedSolanaSchema,
  solanaSchemaCoverage,
} from '../../src/bun/solana-certified-schema'
import { resolveCanonicalLutAccounts } from '../../src/bun/solana-lut-resolver'
import { createRpcAltFetcher, DEFAULT_SOLANA_RPC_ENDPOINT } from '../../src/bun/solana-alt'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from '../../src/bun/solana-tx'

interface Env {
  CLEARSIGN_ENVIRONMENT?: string
  CLEARSIGN_DELEGATE_PRIVATE_KEY?: string
  CLEARSIGN_CERTIFICATE_HEX?: string
  CLEARSIGN_SOLANA_CERTIFICATE_HEX?: string
  CLEARSIGN_SOLANA_RPC_ENDPOINT?: string
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

function reviewedCatalog() {
  const evm = Object.values(CERTIFIED_EVM_CATALOG).map((spec) => ({
    id: `eip155:${spec.chainId}:${spec.contract}:${spec.selector}`,
    family: 'evm',
    network: 'Ethereum',
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
    provenance: spec.provenance || { protocol: PROVENANCE.protocol, security: PROVENANCE.protocolSecurity },
  }))
  const solana = Object.entries(CERTIFIED_SOLANA_CATALOG).map(([key, spec]) => ({
    id: `solana:${key}`,
    family: 'solana',
    network: 'Solana',
    protocol: 'Relay',
    maintainedBy: 'Relay',
    action: 'Deposit funds for a cross-chain swap',
    method: spec.instructionName,
    program: spec.programId,
    discriminator: spec.discriminator.toString('hex'),
    instructionLength: solanaSchemaCoverage(spec),
    fieldsShownByKeepKey: [
      ...(spec.args || []).map((arg) => arg.label),
      ...(spec.accounts || []).map((account) => account.label),
    ],
    provenance: { protocol: PROVENANCE.protocol, security: PROVENANCE.protocolSecurity },
  }))
  return [...evm, ...solana]
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

  let privateKeyValid = false
  if (!env.CLEARSIGN_DELEGATE_PRIVATE_KEY) {
    issues.push('delegate signing key pending')
  } else if (!/^[0-9a-fA-F]{64}$/.test(env.CLEARSIGN_DELEGATE_PRIVATE_KEY)) {
    issues.push('delegate signing key invalid')
  } else {
    try {
      const key = new ethersUtils.SigningKey(`0x${env.CLEARSIGN_DELEGATE_PRIVATE_KEY}`)
      privateKeyValid = ethersUtils.computePublicKey(key.publicKey, true).slice(2).toLowerCase() === ALPHA_DELEGATE_PUBLIC_KEY
      if (!privateKeyValid) issues.push('delegate signing key does not match reviewed fingerprint')
    } catch {
      issues.push('delegate signing key invalid')
    }
  }

  return {
    ready: Boolean((evmCertificate || solanaCertificate) && privateKeyValid),
    evmReady: Boolean(evmCertificate && privateKeyValid),
    solanaReady: Boolean(solanaCertificate && privateKeyValid),
    evmCertificate,
    solanaCertificate,
    privateKeyValid,
    issues,
  }
}

function publicStatus(env: Env, origin: string) {
  const state = provisioning(env)
  const expires = [state.evmCertificate?.notAfter, state.solanaCertificate?.notAfter].filter(Boolean) as number[]
  return {
    service: SERVICE,
    environment: env.CLEARSIGN_ENVIRONMENT || 'production',
    status: state.ready ? 'ready' : 'provisioning',
    message: state.ready
      ? 'KeepKey can authenticate transaction descriptions for every scope marked ready below, without blind signing.'
      : 'The service is online, but no certified signing scope is active yet.',
    endpoints: {
      status: `${origin}/v1/status`,
      catalog: `${origin}/v1/catalog`,
      evmSchema: `${origin}/v1/evm/schema`,
      solanaCertify: `${origin}/v1/solana/certify`,
    },
    scopes: {
      ethereum: state.evmReady ? 'ready' : 'provisioning',
      solana: state.solanaReady ? 'ready' : 'provisioning',
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
      ethereumRequest: ['chainId', 'contract', 'selector', 'calldataLength'],
      solanaRequest: ['unsigned transaction', 'reviewed catalog id'],
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

function home(env: Env, origin: string): Response {
  const status = publicStatus(env, origin)
  const ready = status.status === 'ready'
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SERVICE}</title><style>body{margin:0;background:#0b0d10;color:#eef2f5;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:820px;margin:0 auto;padding:56px 24px}h1{font-size:28px;margin:0 0 8px}.muted{color:#929aa5}.card{border:1px solid #29313a;background:#11151a;border-radius:14px;padding:20px;margin:18px 0}.pill{display:inline-block;border:1px solid ${ready ? '#42d392' : '#e7b84b'};color:${ready ? '#42d392' : '#e7b84b'};border-radius:999px;padding:3px 10px;font-size:12px}dt{color:#929aa5}dd{margin:0 0 10px;word-break:break-all}a{color:#7dd3fc}code{color:#d9b75f}</style></head>
<body><main><span class="pill">${escapeHtml(status.status)}</span><h1>KeepKey ClearSign</h1><p class="muted">Human-readable transaction details, authenticated by the KeepKey in your hand.</p>
<section class="card"><h2>What happens</h2><p>${escapeHtml(status.message)}</p><p>The service recognizes a reviewed protocol action and signs a description. Your KeepKey independently checks the root certificate, signer fingerprint, program or contract, decoded fields, and the exact transaction binding. You still approve the final transaction on the device.</p></section>
<section class="card"><h2>Trust status</h2><dl><dt>Device label</dt><dd>${escapeHtml(status.trust.label)}</dd><dt>Signer</dt><dd>${escapeHtml(status.trust.signerAlias)} · ${escapeHtml(status.trust.signerFingerprint)}</dd><dt>Ethereum</dt><dd>${escapeHtml(status.scopes.ethereum)}</dd><dt>Solana</dt><dd>${escapeHtml(status.scopes.solana)}</dd><dt>Earliest certificate expiry</dt><dd>${escapeHtml(status.trust.certificateExpiresAt || 'Pending')}</dd></dl></section>
<section class="card"><h2>Reviewed protocols</h2><p><strong>Relay</strong> · Ethereum and Solana deposits for cross-chain swaps.</p><p><strong>Portals</strong> · Native ETH swaps through the verified Ethereum router. KeepKey reads the output token, minimum output, recipient, and input amount from the transaction itself.</p><p>Only exact catalog matches are certified. Unknown programs, contracts, selectors, instruction sizes, or lookup-table accounts are refused.</p><a href="/v1/catalog">View the machine-readable catalog</a></section>
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: commonHeaders })
    if (request.method === 'GET' && url.pathname === '/') return home(env, url.origin)
    if (request.method === 'GET' && url.pathname === '/health') {
      const state = provisioning(env)
      return json({ ok: true, ready: state.ready, service: 'keepkey-clearsign', fingerprint: ALPHA_DELEGATE_FINGERPRINT })
    }
    if (request.method === 'GET' && (url.pathname === '/ready' || url.pathname === '/v1/status')) {
      const status = publicStatus(env, url.origin)
      return json(status, url.pathname === '/ready' && status.status !== 'ready' ? 503 : 200)
    }
    if (request.method === 'GET' && url.pathname === '/v1/catalog') {
      return json({ version: 1, entries: reviewedCatalog(), provenance: PROVENANCE }, 200, 'public, max-age=300')
    }
    if (request.method === 'GET' && url.pathname === '/signer') {
      const status = publicStatus(env, url.origin)
      return json({ status: status.status, alias: status.trust.signerAlias, fingerprint: ALPHA_DELEGATE_FINGERPRINT, publicKeyHex: ALPHA_DELEGATE_PUBLIC_KEY, keyId: CERTIFIED_METADATA_KEY_ID, scopes: status.scopes, certificateExpiresAt: status.trust.certificateExpiresAt })
    }

    if (request.method === 'POST' && (url.pathname === '/v1/evm/schema' || url.pathname === '/sign')) {
      let body: any
      try { body = await readJson(request) } catch (error: any) {
        return json({ error: error.message }, error.message === 'request too large' ? 413 : 400)
      }
      const spec = findCertifiedEvmSchemaByShape(Number(body?.chainId), String(body?.contract || body?.to || ''), String(body?.selector || ''), Number(body?.calldataLength))
      if (!spec) return json({ classification: 'OPAQUE', error: 'contract, selector, or calldata shape is not in the reviewed catalog' }, 422)
      const state = provisioning(env)
      if (!state.evmReady || !env.CLEARSIGN_CERTIFICATE_HEX || !env.CLEARSIGN_DELEGATE_PRIVATE_KEY) {
        return json({ classification: 'UNAVAILABLE', error: 'Ethereum certified signing is not provisioned' }, 503)
      }
      try {
        const signed = buildCertifiedEvmEnvelope(spec, env.CLEARSIGN_CERTIFICATE_HEX, env.CLEARSIGN_DELEGATE_PRIVATE_KEY)
        return json({ success: true, classification: 'VERIFIED', version: 3, ...signed, method: spec.method, chainId: spec.chainId, contract: spec.contract, selector: spec.selector, expectedCalldataLength: spec.expectedCalldataLength, decoder: spec.decoder, provenance: spec.provenance || PROVENANCE })
      } catch {
        return json({ error: 'certified Ethereum schema could not be produced' }, 500)
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/solana/certify') {
      let body: any
      try { body = await readJson(request) } catch (error: any) {
        return json({ error: error.message }, error.message === 'request too large' ? 413 : 400)
      }
      const catalogKey = String(body?.catalogKey || '')
      const spec = CERTIFIED_SOLANA_CATALOG[catalogKey]
      if (!spec) return json({ classification: 'OPAQUE', error: 'catalogKey is not in the reviewed catalog' }, 422)

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

      const programBytes = Buffer.from(bs58.decode(spec.programId))
      const expectedLength = solanaSchemaCoverage(spec)
      const matchesInstruction = message.instructions.some((instruction) => {
        const programKey = message.staticAccounts[instruction.programIdIndex]
        if (!programKey || !Buffer.from(programKey).equals(programBytes)) return false
        if ((spec.accounts || []).some((account) => account.index >= instruction.accountIndices.length)) return false
        const data = Buffer.from(instruction.data)
        return data.length === expectedLength && data.subarray(0, spec.discriminator.length).equals(spec.discriminator)
      })
      if (!matchesInstruction) {
        return json({ classification: 'OPAQUE', error: `catalog entry ${catalogKey} does not exactly match an instruction in this transaction` }, 422)
      }

      const state = provisioning(env)
      if (!state.solanaReady || !env.CLEARSIGN_SOLANA_CERTIFICATE_HEX || !env.CLEARSIGN_DELEGATE_PRIVATE_KEY) {
        return json({ classification: 'UNAVAILABLE', error: 'Solana certified signing is not provisioned' }, 503)
      }

      try {
        const schema = signCertifiedSolanaSchema(env.CLEARSIGN_SOLANA_CERTIFICATE_HEX, env.CLEARSIGN_DELEGATE_PRIVATE_KEY, spec)
        const response: any = {
          success: true,
          classification: 'VERIFIED',
          schema: { payload: schema.schemaPayload, signature: schema.schemaSignature, signerKeyId: schema.keyId },
          certificate: `0x${env.CLEARSIGN_SOLANA_CERTIFICATE_HEX.replace(/^0x/i, '')}`,
          alias: schema.alias,
          fingerprint: schema.fingerprint,
          transactionShape: message.version,
          lookupTableCount: message.altEntries.length,
          provenance: PROVENANCE,
        }
        if (message.altEntries.length === 0) return json(response)

        const resolution = await resolveCanonicalLutAccounts(
          message,
          createRpcAltFetcher(env.CLEARSIGN_SOLANA_RPC_ENDPOINT || DEFAULT_SOLANA_RPC_ENDPOINT),
        )
        const messageHash = createHash('sha256').update(messageBytes).digest()
        const proof = signCertifiedSolanaLutAttestation(env.CLEARSIGN_SOLANA_CERTIFICATE_HEX, env.CLEARSIGN_DELEGATE_PRIVATE_KEY, messageHash, resolution.accounts)
        response.lutProof = {
          accounts: resolution.accounts.map((account) => account.toString('base64')),
          signature: proof.lutSignature,
          signerKeyId: proof.keyId,
        }
        response.writableCount = resolution.writableCount
        response.readonlyCount = resolution.readonlyCount
        return json(response)
      } catch {
        return json({ error: 'certified Solana proof could not be produced' }, 500)
      }
    }
    return json({ error: 'not found' }, 404)
  },
}
