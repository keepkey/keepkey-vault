import type { EngineController } from './engine-controller'
import type { AuthStore } from './auth'
import { HttpError } from './auth'
import type { SigningRequestInfo, ApiLogEntry, EIP712DecodedInfo } from '../shared/types'
import { decodeEIP712 } from './eip712-decoder'
import { CHAINS } from '../shared/chains'
import {
  initializeOrchard, initializeOrchardFromDevice, scanOrchardNotes, getShieldedBalance,
  buildShieldedTx, finalizeShieldedTx, broadcastShieldedTx,
} from './txbuilder/zcash-shielded'
import { isSidecarReady } from './zcash-sidecar'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as S from './schemas'
import { parseRequest, validateResponse } from './validate'

export interface RestApiCallbacks {
  onApiLog: (entry: ApiLogEntry) => void
  onSigningRequest: (info: SigningRequestInfo) => Promise<boolean>
  onPairRequest: (info: { name: string; url: string; imageUrl: string }) => void
  onPairDismissed?: () => void
  getVersion: () => string
}

function corsHeaders(_req?: Request): Record<string, string> {
  // Use '*' — bearer-token auth model (not cookie-based), so wildcard is safe
  // and prevents browsers from ever sending credentials via CORS.
  // Private-Network-Access headers required for https → localhost (WKWebView, Chrome 104+).
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Access-Control-Request-Private-Network',
    'Access-Control-Allow-Private-Network': 'true',
  }
}

function requireWallet(engine: EngineController) {
  if (!engine.wallet) throw new HttpError(503, 'No device connected')
  return engine.wallet
}

/** SLIP44 coin type → KeepKey firmware coin name (must match firmware coin table) */
const SLIP44_TO_COIN: Record<number, string> = {
  0: 'Bitcoin', 2: 'Litecoin', 3: 'Dogecoin', 5: 'Dash',
  20: 'DigiByte', 60: 'Ethereum', 118: 'Cosmos', 144: 'Ripple',
  145: 'BitcoinCash', 501: 'Solana', 931: 'Rune',
}

// ── Features cache (10s TTL, matches keepkey-desktop) ──────────────────
let featuresCache: { timestamp: number; data: any } | null = null
const FEATURES_TTL_MS = 10_000

async function getCachedFeatures(wallet: any): Promise<any> {
  const now = Date.now()
  if (featuresCache && (now - featuresCache.timestamp) < FEATURES_TTL_MS) {
    return featuresCache.data
  }
  const features = await wallet.getFeatures()
  featuresCache = { timestamp: now, data: features }
  return features
}

/** Clear features cache (call on device disconnect) */
export function clearFeaturesCache() {
  featuresCache = null
}

/**
 * Convert raw hdwallet features (camelCase) to keepkey-desktop REST format (snake_case).
 * Matches the types.Features schema from keepkey-sdk-server swagger spec.
 */
function formatFeatures(f: any): any {
  const decodeB64 = (x: any): string | undefined => {
    if (x === undefined || x === null) return undefined
    if (x instanceof Uint8Array || Buffer.isBuffer(x)) return Buffer.from(x).toString('hex')
    if (typeof x === 'string') {
      if (/^[0-9a-fA-F]+$/.test(x)) return x.toLowerCase()
      return Buffer.from(x, 'base64').toString('hex')
    }
    return undefined
  }

  return {
    vendor: f.vendor,
    major_version: f.majorVersion,
    minor_version: f.minorVersion,
    patch_version: f.patchVersion,
    bootloader_mode: f.bootloaderMode ?? false,
    device_id: f.deviceId,
    pin_protection: f.pinProtection,
    passphrase_protection: f.passphraseProtection,
    language: f.language,
    label: f.label,
    initialized: f.initialized,
    revision: decodeB64(f.revision),
    bootloader_hash: decodeB64(f.bootloaderHash),
    imported: f.imported,
    pin_cached: f.pinCached,
    passphrase_cached: f.passphraseCached,
    policies: Array.isArray(f.policiesList) ? f.policiesList.map((p: any) => ({
      policy_name: p.policyName ?? p.policy_name,
      enabled: p.enabled,
    })) : f.policies,
    model: f.model,
    firmware_variant: f.firmwareVariant,
    firmware_hash: decodeB64(f.firmwareHash),
    no_backup: f.noBackup,
    wipe_code_protection: f.wipeCodeProtection,
    auto_lock_delay_ms: f.autoLockDelayMs,
  }
}

// ── Public key cache (capped) ─────────────────────────────────────────
const MAX_CACHE_SIZE = 500
const pubkeyCache = new Map<string, any>()

// ── Address cache (capped) ────────────────────────────────────────────
const addressCache = new Map<string, string>()

/** Evict oldest entries from a Map (uses insertion-order iteration). */
function evictOldest<K, V>(cache: Map<K, V>, count: number) {
  let removed = 0
  for (const key of cache.keys()) {
    if (removed >= count) break
    cache.delete(key)
    removed++
  }
}

// ── Cosmos-family amino signing helper ─────────────────────────────────
async function cosmosAminoSign(
  wallet: any,
  auth: AuthStore,
  body: any,
  walletMethod: string,
  defaultDenom: string,
  defaultFeeAmount: string,
  defaultGas: string,
): Promise<any> {
  const { signDoc, signerAddress } = body

  // Default fee if not provided
  if (!signDoc.fee || !signDoc.fee.amount || signDoc.fee.amount.length === 0) {
    signDoc.fee = {
      amount: [{ denom: defaultDenom, amount: defaultFeeAmount }],
      gas: defaultGas,
    }
  }

  const msgs = signDoc.msgs || signDoc.msg || []
  if (!Array.isArray(msgs) || msgs.length === 0) throw new HttpError(400, 'signDoc must contain at least one message (msgs or msg)')

  const tx = {
    account_number: String(signDoc.account_number),
    chain_id: signDoc.chain_id,
    fee: signDoc.fee,
    memo: signDoc.memo || '',
    msg: msgs,
    signatures: [],
    sequence: signDoc.sequence,
  }

  const { addressNList } = auth.getAccount(signerAddress)

  const input = {
    tx,
    addressNList,
    chain_id: tx.chain_id,
    account_number: tx.account_number,
    sequence: tx.sequence,
  }

  const response = await (wallet as any)[walletMethod](input)

  return {
    signature: response?.signatures?.[0] ?? response?.signature,
    serialized: response?.serialized,
    signed: signDoc,
  }
}

// ── ETH account scanning (scan first 5 accounts) ──────────────────────
async function findEthAddressNList(
  wallet: any,
  auth: AuthStore,
  fromAddress: string,
): Promise<number[]> {
  const lower = fromAddress.toLowerCase()

  // Check cache first
  try {
    return auth.getAccount(lower).addressNList
  } catch { /* not cached */ }

  // Scan first 5 account indices
  for (let i = 0; i < 5; i++) {
    const addressNList = [0x8000002C, 0x8000003C, 0x80000000 + i, 0, 0]
    const result = await wallet.ethGetAddress({ addressNList, showDisplay: false })
    const addr = (typeof result === 'string' ? result : result?.address || '').toLowerCase()
    if (addr) {
      auth.saveAccount(addr, addressNList)
      if (addr === lower) return addressNList
    }
  }
  throw new HttpError(400, `Could not find addressNList for ${fromAddress} (scanned 5 accounts)`)
}

// ── Load swagger.json once ─────────────────────────────────────────────
let swaggerContent: string | null = null
function getSwagger(): string {
  if (!swaggerContent) {
    try {
      swaggerContent = readFileSync(join(__dirname, 'swagger.json'), 'utf-8')
    } catch {
      swaggerContent = JSON.stringify({ error: 'swagger.json not found' })
    }
  }
  return swaggerContent
}

// ── Branded Swagger UI HTML ───────────────────────────────────────────
function getSwaggerUiHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KeepKey Vault API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; background: #1a1a2e; }
    .kk-header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border-bottom: 2px solid #C0A860;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .kk-header svg { flex-shrink: 0; }
    .kk-header h1 {
      margin: 0; color: #C0A860; font-family: system-ui, sans-serif;
      font-size: 18px; font-weight: 600;
    }
    .kk-header span { color: #8a8a9a; font-size: 13px; font-family: system-ui, sans-serif; }
    /* Dark theme overrides */
    .swagger-ui { background: #1a1a2e; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui .info .title { color: #e0e0e0; }
    .swagger-ui .info p, .swagger-ui .info li { color: #b0b0c0; }
    .swagger-ui .opblock-tag { color: #e0e0e0 !important; border-bottom-color: #333 !important; }
    .swagger-ui .opblock { border-color: #333; background: rgba(255,255,255,0.03); }
    .swagger-ui .opblock .opblock-summary { border-color: #333; }
    .swagger-ui .opblock .opblock-summary-description { color: #b0b0c0; }
    .swagger-ui .opblock .opblock-summary-method { font-weight: 700; }
    .swagger-ui .opblock.opblock-get .opblock-summary-method { background: #2563EB; }
    .swagger-ui .opblock.opblock-post .opblock-summary-method { background: #C0A860; color: #000; }
    .swagger-ui .opblock.opblock-get { background: rgba(37,99,235,0.06); border-color: rgba(37,99,235,0.3); }
    .swagger-ui .opblock.opblock-post { background: rgba(192,168,96,0.06); border-color: rgba(192,168,96,0.3); }
    .swagger-ui .btn { border-radius: 4px; }
    .swagger-ui .btn.execute { background: #C0A860; color: #000; border: none; }
    .swagger-ui .btn.execute:hover { background: #d4bc6a; }
    .swagger-ui .model-box, .swagger-ui .models { background: rgba(255,255,255,0.03); }
    .swagger-ui .model { color: #b0b0c0; }
    .swagger-ui table thead tr th { color: #b0b0c0; border-bottom-color: #333; }
    .swagger-ui table tbody tr td { color: #e0e0e0; border-bottom-color: #222; }
    .swagger-ui .parameter__name { color: #e0e0e0; }
    .swagger-ui .parameter__type { color: #C0A860; }
    .swagger-ui input[type=text], .swagger-ui textarea, .swagger-ui select {
      background: #0d1117; color: #e0e0e0; border-color: #333;
    }
    .swagger-ui .scheme-container { background: #1a1a2e; box-shadow: none; }
    .swagger-ui .loading-container .loading::after { color: #C0A860; }
    .swagger-ui section.models { border-color: #333; }
    .swagger-ui section.models h4 { color: #e0e0e0; }
    .swagger-ui .response-col_status { color: #e0e0e0; }
    .swagger-ui .response-col_description { color: #b0b0c0; }
    .swagger-ui .responses-inner h4, .swagger-ui .responses-inner h5 { color: #e0e0e0; }
    .swagger-ui .opblock-description-wrapper p { color: #b0b0c0; }
    .swagger-ui .opblock-section-header { background: rgba(255,255,255,0.02); }
    .swagger-ui .opblock-section-header h4 { color: #e0e0e0; }
    .swagger-ui .highlight-code { background: #0d1117; }
    .swagger-ui .microlight { background: #0d1117 !important; color: #e0e0e0 !important; }
  </style>
</head>
<body>
  <div class="kk-header">
    <svg width="28" height="28" viewBox="0 0 100 100" fill="none">
      <rect width="100" height="100" rx="16" fill="#C0A860"/>
      <path d="M30 70V30h10v15l15-15h14L52 47l18 23H56L43 53l-3 3v14H30z" fill="#1a1a2e"/>
    </svg>
    <div>
      <h1>KeepKey Vault API</h1>
      <span>Interactive documentation &mdash; localhost:1646</span>
    </div>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/spec/swagger.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
    })
  </script>
</body>
</html>`
}

/** Convert addressNList to BIP32 string, e.g. [0x8000002C, 0x80000000, 0x80000000] → "m/44'/0'/0'" */
function addressNListToBIP32(addressNList: number[]): string {
  return 'm/' + addressNList.map(n => n >= 0x80000000 ? `${n - 0x80000000}'` : String(n)).join('/')
}

/** Start time for uptime calculation */
const startTime = Date.now()

/** Set of signing endpoints that require user approval */
const SIGNING_ROUTES = new Set([
  '/eth/sign-transaction', '/eth/sign-typed-data', '/eth/sign',
  '/utxo/sign-transaction', '/xrp/sign-transaction', '/solana/sign-transaction', '/solana/sign-message',
  '/cosmos/sign-amino', '/cosmos/sign-amino-delegate', '/cosmos/sign-amino-undelegate',
  '/cosmos/sign-amino-redelegate', '/cosmos/sign-amino-withdraw-delegator-rewards-all',
  '/cosmos/sign-amino-ibc-transfer',
  '/osmosis/sign-amino', '/osmosis/sign-amino-delegate', '/osmosis/sign-amino-undelegate',
  '/osmosis/sign-amino-redelegate', '/osmosis/sign-amino-withdraw-delegator-rewards-all',
  '/osmosis/sign-amino-ibc-transfer', '/osmosis/sign-amino-lp-remove',
  '/osmosis/sign-amino-lp-add', '/osmosis/sign-amino-swap',
  '/thorchain/sign-amino-transfer', '/thorchain/sign-amino-deposit',
  '/mayachain/sign-amino-transfer', '/mayachain/sign-amino-deposit',
])

export function startRestApi(engine: EngineController, auth: AuthStore, port = 1646, callbacks?: RestApiCallbacks) {
  // Invalidate features cache on device disconnect
  engine.on('state-change', (state) => {
    if (state.state === 'disconnected') clearFeaturesCache()
  })

  const server = Bun.serve({
    reusePort: true,
    port,
    maxRequestBodySize: 1024 * 1024, // 1 MB max (addresses/signing payloads are small)
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method
      const requestStart = Date.now()

      // Resolve app info from bearer token (or 'public')
      const resolveAppInfo = (): { appName: string; imageUrl: string } => {
        const token = auth.extractBearerToken(req)
        if (!token) return { appName: 'public', imageUrl: '' }
        const entry = auth.validate(token)
        return { appName: entry?.info?.name || 'paired', imageUrl: entry?.info?.imageUrl || '' }
      }

      // Request-scoped body capture (set by POST handlers before json() is called)
      let reqBody: any = undefined

      // Per-request response helpers (capture req for CORS origin check)
      const json = (data: unknown, status = 200) => {
        const resp = new Response(JSON.stringify(data), {
          status, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
        })
        // Log the request with body + response + duration
        if (callbacks?.onApiLog) {
          const { appName, imageUrl } = resolveAppInfo()
          callbacks.onApiLog({
            method, route: path, timestamp: requestStart,
            durationMs: Date.now() - requestStart,
            status, appName, imageUrl: imageUrl || undefined,
            requestBody: reqBody,
            responseBody: data,
          })
        }
        return resp
      }

      // CORS preflight
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(req) })
      }

      // ═══════════════════════════════════════════════════════════════
      // WC DAPP REVERSE PROXY — serves external WC dapp as same-origin
      // Avoids WKWebView mixed-content block (https iframe → http://localhost).
      //
      // All intentional proxy access goes through /wc/*.
      // Next.js emits absolute paths (/_next/, /chain-logos/, /icons/) that
      // can't be prefixed — so we Referer-gate them: only proxy when the
      // request originates from the WC panel.
      // ═══════════════════════════════════════════════════════════════
      const WC_ORIGIN = 'https://wallet-connect-dapp-ochre.vercel.app'

      // Allowlist of upstream path prefixes the proxy may serve
      const WC_ALLOWED_PREFIXES = ['/_next/', '/chain-logos/', '/icons/', '/favicon.ico']

      // Primary: everything under /wc/ is always proxied
      const isWcPrimaryPath = path === '/wc' || path.startsWith('/wc/')

      // Secondary: absolute paths leaked by Next.js — only proxy when
      // the Referer proves the request came from the WC panel iframe
      const referer = req.headers.get('Referer') || ''
      const isWcRefererPath = referer.includes('/wc') &&
        WC_ALLOWED_PREFIXES.some(p => path.startsWith(p) || path === p)

      if (isWcPrimaryPath || isWcRefererPath) {
        // Only allow GET — the proxy serves static assets, not API calls
        if (method !== 'GET') {
          return new Response(JSON.stringify({ error: 'Method not allowed on proxy' }), {
            status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
          })
        }

        // /wc/* → strip prefix; Referer-gated paths pass through as-is
        const upstreamPath = path.startsWith('/wc/')
          ? path.slice(3) // "/wc/foo" → "/foo"
          : path === '/wc' ? '/' : path

        // Denylist: never proxy paths that look like vault API routes
        if (upstreamPath.startsWith('/api/') || upstreamPath.startsWith('/auth/') || upstreamPath.startsWith('/system/')) {
          return json({ error: 'Not found', path }, 404)
        }

        const upstreamUrl = WC_ORIGIN + upstreamPath + url.search
        const proxyStart = Date.now()
        try {
          const upstream = await fetch(upstreamUrl, {
            method: 'GET',
            headers: { 'Accept': req.headers.get('Accept') || '*/*' },
            redirect: 'follow',
          })
          // Pass through content-type, cache-control, and status
          const respHeaders: Record<string, string> = { ...corsHeaders(req) }
          const ct = upstream.headers.get('Content-Type')
          if (ct) respHeaders['Content-Type'] = ct
          const cc = upstream.headers.get('Cache-Control')
          if (cc) respHeaders['Cache-Control'] = cc

          // Audit log proxy requests
          if (callbacks?.onApiLog) {
            callbacks.onApiLog({
              method, route: path, timestamp: proxyStart,
              durationMs: Date.now() - proxyStart,
              status: upstream.status, appName: 'wc-proxy',
            })
          }

          return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
        } catch {
          if (callbacks?.onApiLog) {
            callbacks.onApiLog({
              method, route: path, timestamp: proxyStart,
              durationMs: Date.now() - proxyStart,
              status: 502, appName: 'wc-proxy',
            })
          }
          return new Response(JSON.stringify({ error: 'WC proxy unavailable' }), {
            status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
          })
        }
      }

      // Capture POST body for audit logging (Bun caches req.json(), so parseRequest still works)
      if (method === 'POST') {
        try { reqBody = await req.clone().json() } catch { /* not JSON or empty */ }
      }

      try {
        // ═══════════════════════════════════════════════════════════════
        // SPEC (public)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/spec/swagger.json' && method === 'GET') {
          if (callbacks?.onApiLog) {
            callbacks.onApiLog({ method, route: path, timestamp: requestStart, durationMs: Date.now() - requestStart, status: 200, appName: 'public' })
          }
          return new Response(getSwagger(), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // HEALTH (public — privacy-safe, no deviceId/label)
        // ═══════════════════════════════════════════════════════════════
        if ((path === '/api/health' || path === '/api/v1/health') && method === 'GET') {
          const ds = engine.getDeviceState()
          return json({
            ready: ds.state === 'ready',
            status: 'healthy',
            syncing: engine.isSyncing,
            apiVersion: 2,
            supportedChains: CHAINS.map(c => c.networkId),
            device_connected: engine.wallet !== null,
            version: callbacks?.getVersion?.() || 'unknown',
            connected: engine.wallet !== null,
            uptime: Math.floor((Date.now() - startTime) / 1000),
            // Report at least 1 when wallet is connected — signals to SDK that
            // the batch endpoint is functional and will fetch on-demand from device.
            // SDK skips batch call entirely when cached_pubkeys === 0.
            cached_pubkeys: engine.wallet ? Math.max(pubkeyCache.size, 1) : 0,
            frontload_progress: { status: 'complete', can_operate_offline: false },
          })
        }

        if (path === '/api/v1/health/fast' && method === 'GET') {
          return json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) })
        }

        // ═══════════════════════════════════════════════════════════════
        // SDK DETECTION (public — used by keepkey-website-v7 + Pioneer)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/info/ping' && method === 'GET') {
          return json({ message: 'pong' })
        }

        if (path === '/system/info/ping' && method === 'POST') {
          return json({ message: 'pong' })
        }

        if (path === '/admin/info' && method === 'GET') {
          return json({
            version: callbacks?.getVersion?.() || 'unknown',
            connected: engine.wallet !== null,
            uptime: Math.floor((Date.now() - startTime) / 1000),
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // SWAGGER UI (public — branded API docs)
        // ═══════════════════════════════════════════════════════════════
        if ((path === '/docs' || path === '/docs/') && method === 'GET') {
          if (callbacks?.onApiLog) {
            callbacks.onApiLog({ method, route: path, timestamp: requestStart, durationMs: Date.now() - requestStart, status: 200, appName: 'public' })
          }
          return new Response(getSwaggerUiHtml(), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(req) },
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // AUTH — pairing requires user approval via Electrobun UI
        // ═══════════════════════════════════════════════════════════════
        if (path === '/auth/pair') {
          if (method === 'GET') {
            // Graceful verify — SDK checks pairing status via GET /auth/pair.
            // Return { paired: false } instead of 403 so the SDK knows to re-pair.
            const token = auth.extractBearerToken(req)
            if (!token) return json({ paired: false, message: 'No bearer token provided' }, 401)
            const entry = auth.validate(token)
            if (!entry) return json({ paired: false, message: 'Token expired or invalid' }, 401)
            return json({ paired: true, ...entry.info })
          }
          if (method === 'POST') {
            const body = await parseRequest(req, S.PairRequest)
            // Notify UI about the incoming pair request
            if (callbacks?.onPairRequest) {
              callbacks.onPairRequest({ name: body.name, url: body.url || '', imageUrl: body.imageUrl || '' })
            }
            // requestPair requires user approval via UI — NOT auto-granted
            try {
              const apiKey = await auth.requestPair(body)
              return json({ apiKey })
            } finally {
              // Dismiss UI overlay + restore window level on approve, reject, or timeout
              callbacks?.onPairDismissed?.()
            }
          }
        }

        // ═══════════════════════════════════════════════════════════════
        // SIGNING APPROVAL GATE — auth required, then user must approve
        // ═══════════════════════════════════════════════════════════════
        if (method === 'POST' && SIGNING_ROUTES.has(path) && callbacks?.onSigningRequest) {
          auth.requireAuth(req)
          const { appName } = resolveAppInfo()
          const id = crypto.randomUUID()
          const signingInfo: SigningRequestInfo = { id, method: path, appName }

          // Try to extract useful details from the body without consuming it
          // (we'll parse body again in the handler below — Bun caches it)
          try {
            const preview = await req.clone().json() as any
            signingInfo.chain = path.split('/')[1] // e.g. "eth", "cosmos"

            if (path === '/eth/sign-typed-data') {
              // EIP-712: address + typedData structure (no from/to/value/data)
              signingInfo.from = preview.address
              signingInfo.chainId = preview.typedData?.domain?.chainId ? Number(preview.typedData.domain.chainId) : undefined
              if (preview.typedData) {
                signingInfo.typedDataDecoded = decodeEIP712(preview.typedData)
              }
            } else {
              signingInfo.from = preview.from || preview.signerAddress
              signingInfo.to = preview.to
              signingInfo.value = preview.value
              signingInfo.chainId = preview.chainId || preview.chain_id
              signingInfo.data = preview.data ? (preview.data.length > 66 ? preview.data.slice(0, 66) + '...' : preview.data) : undefined
            }
          } catch { /* body parse failed, non-fatal */ }

          const approved = await callbacks.onSigningRequest(signingInfo)
          if (!approved) {
            return json({ error: 'Signing rejected by user' }, 403)
          }
        }

        // ── List paired apps (public — shows connected dApps, keys stripped) ──
        if (path === '/auth/paired-apps' && method === 'GET') {
          const apps = auth.listPairedApps().map(({ apiKey: _k, ...safe }) => safe)
          return json({ apps, total: apps.length })
        }

        // ═══════════════════════════════════════════════════════════════
        // All remaining endpoints require auth
        // ═══════════════════════════════════════════════════════════════

        // ── ADDRESSES (9 endpoints) ──────────────────────────────────
        if (path === '/addresses/utxo' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.btcGetAddress({
            addressNList: body.address_n,
            coin: body.coin || 'Bitcoin',
            scriptType: body.script_type,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/cosmos' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.cosmosGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/osmosis' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = 'osmo:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.osmosisGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/eth' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.ethGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/tendermint' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.cosmosGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/thorchain' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = 'thor:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.thorchainGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/mayachain' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = 'maya:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.mayachainGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/xrp' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.rippleGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/solana' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = 'sol:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.solanaGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : (result as any)?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        // ── ETH SIGNING (4 endpoints) ────────────────────────────────
        if (path === '/eth/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.EthSignTransactionRequest)

          // Resolve addressNList from body or by scanning
          let addressNList = body.addressNList || body.address_n_list
          if (!addressNList && body.from) {
            addressNList = await findEthAddressNList(wallet, auth, body.from)
          }

          // chainId: default to 1 if 0 or missing
          let chainId = body.chainId ?? body.chain_id ?? 1
          if (typeof chainId === 'string') {
            chainId = chainId.startsWith('0x') ? parseInt(chainId, 16) : parseInt(chainId, 10)
          }
          if (!chainId || chainId === 0) chainId = 1

          const msg: any = {
            addressNList,
            to: body.to,
            value: body.value || '0x0',
            data: body.data || '0x',
            nonce: body.nonce || '0x0',
            gasLimit: body.gas || body.gasLimit || '0x5208',
            chainId,
          }

          // EIP-1559 fields
          if (body.maxFeePerGas || body.max_fee_per_gas) {
            msg.maxFeePerGas = body.maxFeePerGas || body.max_fee_per_gas
            msg.maxPriorityFeePerGas = body.maxPriorityFeePerGas || body.max_priority_fee_per_gas || '0x0'
          } else {
            msg.gasPrice = body.gasPrice || body.gas_price || '0x0'
          }

          const result = await wallet.ethSignTx(msg)
          return json(validateResponse(result, S.EthSignTransactionResponse, path))
        }

        if (path === '/eth/sign-typed-data' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.EthSignTypedDataRequest)

          // Address resolution: cache first, then scan accounts
          let addressNList: number[]
          try {
            addressNList = auth.getAccount(body.address).addressNList
          } catch {
            addressNList = await findEthAddressNList(wallet, auth, body.address)
          }

          try {
            const result = await wallet.ethSignTypedData({ addressNList, typedData: body.typedData })
            return json(result)
          } catch (err: any) {
            // Distinguish user cancellation from actual failures
            const msg = String(err?.message || err || '').toLowerCase()
            if (msg.includes('cancel') || msg.includes('rejected') || msg.includes('denied') || msg.includes('action cancelled')) {
              return json({ error: 'User cancelled signing on device' }, 403)
            }
            throw err
          }
        }

        if (path === '/eth/sign' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.EthSignRequest)
          const { addressNList } = auth.getAccount(body.address)
          // hdwallet expects message as a hex string (isHexString check), not Buffer
          const result = await wallet.ethSignMessage({ addressNList, message: body.message })
          return json(result)
        }

        if (path === '/eth/verify' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.EthVerifyRequest)
          const msgBytes = Buffer.from(body.message.replace(/^0x/, ''), 'hex')
          const result = await wallet.ethVerifyMessage({
            address: body.address,
            message: msgBytes,
            signature: body.signature,
          })
          return json(result)
        }

        // ── UTXO SIGNING (1 endpoint) ────────────────────────────────
        if (path === '/utxo/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.UtxoSignTransactionRequest)
          const coin = body.coin || 'Bitcoin'

          // BCH: prepend bitcoincash: prefix to output addresses
          if (coin === 'BitcoinCash' && body.outputs) {
            for (const out of body.outputs) {
              if (out.address && !out.address.startsWith('bitcoincash:')) {
                out.address = 'bitcoincash:' + out.address
              }
            }
          }

          const result = await wallet.btcSignTx({
            coin,
            inputs: body.inputs,
            outputs: body.outputs,
            version: body.version ?? 1,
            locktime: body.locktime ?? 0,
            ...(body.overwintered !== undefined ? { overwintered: body.overwintered } : {}),
            ...(body.expiry !== undefined ? { expiry: body.expiry } : {}),
            ...(body.versionGroupId !== undefined ? { versionGroupId: body.versionGroupId } : {}),
            ...(body.branchId !== undefined ? { branchId: body.branchId } : {}),
          })
          return json(validateResponse(result, S.UtxoSignTransactionResponse, path))
        }

        // ── COSMOS SIGNING (6 endpoints) ──────────────────────────────
        if (path === '/cosmos/sign-amino' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-delegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-undelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-redelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-withdraw-delegator-rewards-all' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-ibc-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }

        // ── OSMOSIS SIGNING (9 endpoints) ────────────────────────────
        if (path === '/osmosis/sign-amino' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-delegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-undelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-redelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-withdraw-delegator-rewards-all' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-ibc-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-lp-remove' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-lp-add' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-swap' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }

        // ── THORCHAIN SIGNING (2 endpoints) ──────────────────────────
        if (path === '/thorchain/sign-amino-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'thorchainSignTx', 'rune', '0', '500000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/thorchain/sign-amino-deposit' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'thorchainSignTx', 'rune', '0', '500000000'), S.CosmosAminoSignResponse, path))
        }

        // ── MAYACHAIN SIGNING (2 endpoints) ──────────────────────────
        if (path === '/mayachain/sign-amino-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'mayachainSignTx', 'cacao', '0', '500000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/mayachain/sign-amino-deposit' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'mayachainSignTx', 'cacao', '0', '500000000'), S.CosmosAminoSignResponse, path))
        }

        // ── XRP SIGNING (1 endpoint) ─────────────────────────────────
        if (path === '/xrp/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.XrpSignRequest)
          const result = await wallet.rippleSignTx(body)
          return json(result)
        }

        // ── SOLANA SIGNING (1 endpoint) ────────────────────────────────
        if (path === '/solana/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.SolanaSignRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x800001F5, 0x80000000, 0x80000000]
          const result = await wallet.solanaSignTx({
            addressNList,
            rawTx: body.raw_tx,
          })
          // Assemble signed tx: replace dummy 64-byte signature in rawTx with real signature
          if (result?.signature && body.raw_tx) {
            const rawBytes = Buffer.from(body.raw_tx, 'base64')
            const sigBytes = result.signature instanceof Uint8Array
              ? result.signature
              : Buffer.from(result.signature, 'base64')
            if (rawBytes.length > 65 && sigBytes.length === 64) {
              sigBytes.forEach((b: number, i: number) => { rawBytes[1 + i] = b })
              return json({ signature: Buffer.from(sigBytes).toString('base64'), serializedTx: rawBytes.toString('base64') })
            }
          }
          return json(result)
        }

        // ── SOLANA MESSAGE SIGNING (firmware type 754) ──────────────────
        if (path === '/solana/sign-message' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.SolanaSignMessageRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x800001F5, 0x80000000, 0x80000000]
          const result = await wallet.solanaSignMessage({
            addressNList,
            message: body.message,
            showDisplay: body.show_display !== false,
          })
          // result: { publicKey: Uint8Array, signature: Uint8Array }
          return json({
            signature: result.signature instanceof Uint8Array
              ? Buffer.from(result.signature).toString('base64')
              : result.signature,
            publicKey: result.publicKey instanceof Uint8Array
              ? Buffer.from(result.publicKey).toString('base64')
              : result.publicKey,
          })
        }

        // ── DEVICE INFO (2 endpoints — read-only) ────────────────────
        if (path === '/system/info/get-features' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const features = await getCachedFeatures(wallet)
          return json(validateResponse(formatFeatures(features), S.FeaturesResponse, path))
        }

        if (path === '/system/info/get-public-key' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.GetPublicKeyRequest)
          const cacheKey = JSON.stringify(body)
          const cached = pubkeyCache.get(cacheKey)
          if (cached) return json(cached)
          const result = await wallet.getPublicKeys([{
            addressNList: body.address_n,
            curve: body.ecdsa_curve_name || 'secp256k1',
            showDisplay: body.show_display ?? false,
            coin: body.coin_name || 'Bitcoin',
            scriptType: body.script_type,
          }])
          const xpub = result?.[0]?.xpub
          const out = { xpub }
          if (pubkeyCache.size >= MAX_CACHE_SIZE) evictOldest(pubkeyCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          pubkeyCache.set(cacheKey, out)
          return json(validateResponse(out, S.GetPublicKeyResponse, path))
        }

        // ═══════════════════════════════════════════════════════════════
        // V2 DEVICE MANAGEMENT (5 endpoints — require auth, single-device mode)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/api/v2/devices' && method === 'GET') {
          auth.requireAuth(req)
          const ds = engine.getDeviceState()
          const devices = ds.deviceId ? [{
            device_id: ds.deviceId,
            is_active: true,
            state: ds.state,
            name: ds.label || 'KeepKey',
          }] : []
          return json({ devices, total: devices.length })
        }

        if (path === '/api/v2/devices/active' && method === 'GET') {
          auth.requireAuth(req)
          const ds = engine.getDeviceState()
          if (!ds.deviceId) return json({ error: 'No active device' }, 404)
          return json({ device_id: ds.deviceId, state: ds.state })
        }

        if (path === '/api/v2/devices/paired' && method === 'GET') {
          auth.requireAuth(req)
          const ds = engine.getDeviceState()
          const devices = ds.deviceId ? [{
            device_id: ds.deviceId,
            is_connected: true,
            is_active: true,
            total_frontloads: 0,
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString(),
          }] : []
          return json({
            total_paired: devices.length,
            total_connected: devices.length,
            devices,
          })
        }

        if (path === '/api/v2/devices/select' && method === 'POST') {
          auth.requireAuth(req)
          const ds = engine.getDeviceState()
          return json({
            success: true,
            device_id: ds.deviceId || null,
            message: 'Single-device mode — device selected',
          })
        }

        // /api/v2/devices/:id — must come AFTER specific paths above
        if (path.startsWith('/api/v2/devices/') && method === 'GET') {
          auth.requireAuth(req)
          const id = path.split('/').pop()
          const ds = engine.getDeviceState()
          if (!ds.deviceId || ds.deviceId !== id) {
            return json({ error: 'Device not found' }, 404)
          }
          return json({ device_id: ds.deviceId, is_active: true, state: ds.state })
        }

        // ═══════════════════════════════════════════════════════════════
        // SDK-CALLED ENDPOINTS (cache, portfolio, batch pubkeys)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/api/cache/status' && method === 'GET') {
          return json({
            available: true,
            cached_pubkeys: pubkeyCache.size,
            cached_addresses: addressCache.size,
          })
        }

        if (path === '/api/portfolio' && method === 'GET') {
          const ds = engine.getDeviceState()
          return json({
            devices: ds.deviceId ? [{ state: ds.state }] : [],
            total_value_usd: 0,
            message: 'Portfolio aggregation not implemented — use Pioneer API for balances',
          })
        }

        if (path.startsWith('/api/portfolio/') && method === 'GET') {
          auth.requireAuth(req)
          const deviceId = path.split('/').pop()
          const ds = engine.getDeviceState()
          if (!ds.deviceId || ds.deviceId !== deviceId) {
            return json({ error: 'Device not found' }, 404)
          }
          return json({
            device_id: ds.deviceId,
            state: ds.state,
            total_value_usd: 0,
            message: 'Portfolio not implemented — use Pioneer API for balances',
          })
        }

        if (path === '/api/pubkeys/batch' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.BatchPubkeysRequest)
          const paths = body.paths || []
          const results: any[] = []

          for (const p of paths) {
            if (!p.address_n || !Array.isArray(p.address_n)) continue

            // ── Address-type paths (non-UTXO: XRP, ETH, Cosmos, etc.) ──
            // SDK sends type='address' for chains that need actual addresses, not xpubs.
            if (p.type === 'address') {
              const primaryNetwork = (p.networks || [])[0] || ''
              const addrCacheKey = `batch-addr:${JSON.stringify(p.address_n)}:${primaryNetwork}`
              const cachedAddr = addressCache.get(addrCacheKey)
              if (cachedAddr) {
                results.push({
                  pubkey: cachedAddr,
                  address: cachedAddr,
                  path: addressNListToBIP32(p.address_n),
                  pathMaster: addressNListToBIP32(p.address_n.slice(0, 3)),
                  scriptType: p.script_type || 'p2pkh',
                  networks: p.networks || [],
                  type: 'address',
                  note: p.note,
                  addressNList: p.address_n,
                })
                continue
              }

              try {
                const coinType = p.address_n.length >= 2 ? (p.address_n[1] >= 0x80000000 ? p.address_n[1] - 0x80000000 : p.address_n[1]) : 0
                // Extend account-level path (3 elements) to full derivation path
                const addrNList = p.address_n.length <= 3 ? [...p.address_n, 0, 0] : p.address_n
                let address = ''

                if (coinType === 60) {
                  const r = await wallet.ethGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (coinType === 144) {
                  const r = await wallet.rippleGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (primaryNetwork.includes('thorchain')) {
                  const r = await wallet.thorchainGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (primaryNetwork.includes('maya')) {
                  const r = await wallet.mayachainGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (primaryNetwork.includes('osmosis')) {
                  const r = await wallet.osmosisGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (coinType === 118 || coinType === 931) {
                  const r = await wallet.cosmosGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (coinType === 501) {
                  // Solana uses ed25519 with 4-element path (m/44'/501'/0'/0') — don't extend to 5
                  const solNList = p.address_n
                  const r = await wallet.solanaGetAddress({ addressNList: solNList, showDisplay: false })
                  address = typeof r === 'string' ? r : (r as any)?.address || ''
                }

                if (address) {
                  if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
                  addressCache.set(addrCacheKey, address)
                  auth.saveAccount(address, addrNList)
                }

                results.push({
                  pubkey: address,
                  address,
                  path: addressNListToBIP32(p.address_n),
                  pathMaster: addressNListToBIP32(p.address_n.slice(0, 3)),
                  scriptType: p.script_type || 'p2pkh',
                  networks: p.networks || [],
                  type: 'address',
                  note: p.note,
                  addressNList: p.address_n,
                })
              } catch (err: any) {
                console.warn(`[REST] batch address failed for path ${JSON.stringify(p.address_n)}:`, err?.message)
              }
              continue
            }

            // ── xpub/ypub/zpub-type paths (UTXO chains) ──
            const cacheKey = JSON.stringify({ address_n: p.address_n, script_type: p.script_type })
            const cached = pubkeyCache.get(cacheKey)
            if (cached) {
              results.push({
                pubkey: cached.xpub || '',
                address: '',
                path: addressNListToBIP32(p.address_n),
                pathMaster: addressNListToBIP32(p.address_n.slice(0, 3)),
                scriptType: p.script_type || 'p2pkh',
                networks: p.networks || [],
                type: p.type || 'xpub',
                note: p.note,
                addressNList: p.address_n,
              })
              continue
            }
            const coinType = p.address_n.length >= 2 ? (p.address_n[1] >= 0x80000000 ? p.address_n[1] - 0x80000000 : p.address_n[1]) : 0
            const coin = p.coin || SLIP44_TO_COIN[coinType] || 'Bitcoin'
            try {
              const result = await wallet.getPublicKeys([{
                addressNList: p.address_n,
                curve: 'secp256k1',
                showDisplay: false,
                coin,
                scriptType: p.script_type,
              }])
              const xpub = result?.[0]?.xpub || ''
              const out = { xpub }
              if (pubkeyCache.size >= MAX_CACHE_SIZE) evictOldest(pubkeyCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
              pubkeyCache.set(cacheKey, out)
              results.push({
                pubkey: xpub,
                address: '',
                path: addressNListToBIP32(p.address_n),
                pathMaster: addressNListToBIP32(p.address_n.slice(0, 3)),
                scriptType: p.script_type || 'p2pkh',
                networks: p.networks || [],
                type: p.type || 'xpub',
                note: p.note,
                addressNList: p.address_n,
              })
            } catch (err: any) {
              console.warn(`[REST] batch pubkey failed for path ${JSON.stringify(p.address_n)} coin=${coin} scriptType=${p.script_type}:`, err?.message)
            }
          }

          return json({
            pubkeys: results,
            cached_count: results.length,
            total_requested: paths.length,
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // SYSTEM MANAGEMENT (keepkey-desktop compatible — require auth)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/system/info/list-coins' && method === 'POST') {
          auth.requireAuth(req)
          return json(CHAINS.map(c => ({
            coin_name: c.coin,
            coin_shortcut: c.symbol,
            chain: c.chain,
            chain_family: c.chainFamily,
            network_id: c.networkId,
            caip: c.caip,
            decimals: c.decimals,
          })))
        }

        if (path === '/system/apply-settings' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.ApplySettingsRequest)
          const settings: any = {}
          if (body.label !== undefined) settings.label = body.label
          if (body.use_passphrase !== undefined) settings.usePassphrase = body.use_passphrase
          if (body.autolock_delay_ms !== undefined) settings.autoLockDelayMs = body.autolock_delay_ms
          await wallet.applySettings(settings)
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/change-pin' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.ChangePinRequest).catch(() => ({} as any))
          if (body.remove) {
            await wallet.removePin()
          } else {
            await wallet.changePin()
          }
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/apply-policies' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.ApplyPoliciesRequest)
          await wallet.applyPolicy(body)
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/wipe-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          await wallet.wipe()
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/clear-session' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          await wallet.clearSession()
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/initialize/reset-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.ResetDeviceRequest)
          await wallet.reset({
            entropy: body.word_count ? ({ 12: 128, 18: 192, 24: 256 } as Record<number, number>)[body.word_count] || 128 : 128,
            label: body.label || 'KeepKey',
            pin: body.pin_protection ?? true,
            passphrase: body.passphrase_protection ?? false,
            autoLockDelayMs: 600000,
          })
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/initialize/recover-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.RecoverDeviceRequest)
          await wallet.recover({
            entropy: body.word_count ? ({ 12: 128, 18: 192, 24: 256 } as Record<number, number>)[body.word_count] || 128 : 128,
            label: body.label || 'KeepKey',
            pin: body.pin_protection ?? true,
            passphrase: body.passphrase_protection ?? false,
            autoLockDelayMs: 600000,
          })
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/initialize/load-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.LoadDeviceRequest)
          await wallet.loadDevice(body)
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/recovery/pin' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.SendPinRequest)
          await wallet.sendPin(body.pin)
          return json({ success: true })
        }

        // ── Zcash Shielded (Orchard) ────────────────────────────────

        if (path === '/api/zcash/shielded/status' && method === 'GET') {
          return json({ ready: isSidecarReady() })
        }

        if (path === '/api/zcash/shielded/init' && method === 'POST') {
          auth.requireAuth(req)
          const body = await req.json() as { seed_hex?: string; from_device?: boolean; account?: number }
          if (body.from_device) {
            const wallet = requireWallet(engine)
            const result = await initializeOrchardFromDevice(wallet, body.account ?? 0)
            return json(result)
          }
          if (!body.seed_hex) return json({ error: 'Missing seed_hex or from_device flag' }, 400)
          const result = await initializeOrchard(body.seed_hex, body.account ?? 0)
          return json(result)
        }

        if (path === '/api/zcash/shielded/scan' && method === 'POST') {
          auth.requireAuth(req)
          const body = await req.json() as { start_height?: number }
          const result = await scanOrchardNotes(body.start_height)
          return json(result)
        }

        if (path === '/api/zcash/shielded/balance' && method === 'GET') {
          auth.requireAuth(req)
          const result = await getShieldedBalance()
          return json(result)
        }

        if (path === '/api/zcash/shielded/build' && method === 'POST') {
          auth.requireAuth(req)
          const body = await req.json() as { recipient: string; amount: number; account?: number }
          if (!body.recipient || !body.amount) return json({ error: 'Missing recipient or amount' }, 400)
          const result = await buildShieldedTx(body)
          return json(result)
        }

        if (path === '/api/zcash/shielded/finalize' && method === 'POST') {
          auth.requireAuth(req)
          const body = await req.json() as { signatures: string[] }
          if (!body.signatures?.length) return json({ error: 'Missing signatures' }, 400)
          const result = await finalizeShieldedTx(body.signatures)
          return json(result)
        }

        if (path === '/api/zcash/shielded/broadcast' && method === 'POST') {
          auth.requireAuth(req)
          const body = await req.json() as { raw_tx: string }
          if (!body.raw_tx) return json({ error: 'Missing raw_tx' }, 400)
          const result = await broadcastShieldedTx(body.raw_tx)
          return json(result)
        }

        // ── Catch-all ────────────────────────────────────────────────
        // Sequential if/else routing is fine for ~60 localhost-only endpoints.
        // A Map-based router adds complexity with no measurable perf gain here.
        return json({ error: 'Not found', path }, 404)

      } catch (err: any) {
        if (err.status) {
          return json({ error: err.message }, err.status)
        }
        console.error('[REST] Error:', err)
        return json({ error: 'Internal error' }, 500)
      }
    },
  })

  console.log(`[REST] API server listening on http://localhost:${port}`)
  return server
}
