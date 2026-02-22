import type { EngineController } from './engine-controller'
import type { AuthStore } from './auth'
import type { SigningRequestInfo, ApiLogEntry } from '../shared/types'
import { readFileSync } from 'fs'
import { join } from 'path'

export interface RestApiCallbacks {
  onApiLog: (entry: ApiLogEntry) => void
  onSigningRequest: (info: SigningRequestInfo) => Promise<boolean>
  onPairRequest: (info: { name: string; url: string; imageUrl: string }) => void
  isPairingEnabled: () => boolean
  getVersion: () => string
}

/** Matches any http/https origin on localhost or 127.0.0.1 (any port) */
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

/** Custom header required on all non-GET/OPTIONS requests to prevent CSRF */
const CSRF_HEADER = 'x-keepkey-sdk'

/** Sliding-window rate limiter for /auth/pair — 5 attempts per 60s */
const PAIR_RATE_LIMIT = 5
const PAIR_RATE_WINDOW_MS = 60_000
const pairAttempts: number[] = []

function corsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': LOCALHOST_ORIGIN_RE.test(origin) ? origin : 'http://localhost:1646',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, Authorization, ${CSRF_HEADER}`,
    'Vary': 'Origin',
  }
}

function requireWallet(engine: EngineController) {
  if (!engine.wallet) throw { status: 503, message: 'No device connected' }
  return engine.wallet
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
  if (!signDoc) throw { status: 400, message: 'Missing signDoc' }
  if (!signerAddress) throw { status: 400, message: 'Missing signerAddress' }

  // Default fee if not provided
  if (!signDoc.fee || !signDoc.fee.amount || signDoc.fee.amount.length === 0) {
    signDoc.fee = {
      amount: [{ denom: defaultDenom, amount: defaultFeeAmount }],
      gas: defaultGas,
    }
  }

  const msgs = signDoc.msgs || signDoc.msg || []
  if (!Array.isArray(msgs) || msgs.length === 0) throw { status: 400, message: 'signDoc must contain at least one message (msgs or msg)' }

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
  throw { status: 400, message: `Could not find addressNList for ${fromAddress} (scanned 5 accounts)` }
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

/** Start time for uptime calculation */
const startTime = Date.now()

/** Set of signing endpoints that require user approval */
const SIGNING_ROUTES = new Set([
  '/eth/sign-transaction', '/eth/sign-typed-data', '/eth/sign',
  '/utxo/sign-transaction', '/xrp/sign-transaction',
  '/bnb/sign-transaction',
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

      // Resolve app name from bearer token (or 'public')
      const resolveAppName = (): string => {
        const token = auth.extractBearerToken(req)
        if (!token) return 'public'
        const entry = auth.validate(token)
        return entry?.info?.name || 'paired'
      }

      // Per-request response helpers (capture req for CORS origin check)
      const json = (data: unknown, status = 200) => {
        const resp = new Response(JSON.stringify(data), {
          status, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
        })
        // Log the request
        if (callbacks?.onApiLog) {
          callbacks.onApiLog({ method, route: path, timestamp: requestStart, status, appName: resolveAppName() })
        }
        return resp
      }

      // CORS preflight
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(req) })
      }

      // CSRF protection: require custom header on all mutating requests
      if (method !== 'GET') {
        if (!req.headers.get(CSRF_HEADER)) {
          return json({ error: `Missing ${CSRF_HEADER} header` }, 403)
        }
      }

      try {
        // ═══════════════════════════════════════════════════════════════
        // SPEC (public)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/spec/swagger.json' && method === 'GET') {
          if (callbacks?.onApiLog) {
            callbacks.onApiLog({ method, route: path, timestamp: requestStart, status: 200, appName: 'public' })
          }
          return new Response(getSwagger(), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // HEALTH (public — privacy-safe, no deviceId/label)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/api/health' && method === 'GET') {
          return json({
            version: callbacks?.getVersion?.() || 'unknown',
            connected: engine.wallet !== null,
            uptime: Math.floor((Date.now() - startTime) / 1000),
          })
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
        if (path === '/docs' && method === 'GET') {
          if (callbacks?.onApiLog) {
            callbacks.onApiLog({ method, route: path, timestamp: requestStart, status: 200, appName: 'public' })
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
            const entry = auth.requireAuth(req)
            return json(entry.info)
          }
          if (method === 'POST') {
            // Check if pairing is enabled
            if (callbacks?.isPairingEnabled && !callbacks.isPairingEnabled()) {
              return json({ error: 'Pairing disabled' }, 403)
            }

            // Sliding-window rate limit
            const now = Date.now()
            while (pairAttempts.length > 0 && now - pairAttempts[0] > PAIR_RATE_WINDOW_MS) pairAttempts.shift()
            if (pairAttempts.length >= PAIR_RATE_LIMIT) {
              return json({ error: 'Too many pairing attempts. Try again later.' }, 429)
            }
            pairAttempts.push(now)

            const body = await req.json() as any
            if (!body.name) throw { status: 400, message: 'Missing name in pairing request' }
            // Notify UI about the incoming pair request
            if (callbacks?.onPairRequest) {
              callbacks.onPairRequest({ name: body.name, url: body.url || '', imageUrl: body.imageUrl || '' })
            }
            // requestPair requires user approval via UI — NOT auto-granted
            const apiKey = await auth.requestPair(body)
            return json({ apiKey })
          }
        }

        // ═══════════════════════════════════════════════════════════════
        // SIGNING APPROVAL GATE — user must approve signing requests
        // ═══════════════════════════════════════════════════════════════
        if (method === 'POST' && SIGNING_ROUTES.has(path) && callbacks?.onSigningRequest) {
          const appName = resolveAppName()
          const id = crypto.randomUUID()
          const signingInfo: SigningRequestInfo = { id, method: path, appName }

          // Try to extract useful details from the body without consuming it
          // (we'll parse body again in the handler below — Bun caches it)
          try {
            const preview = await req.clone().json() as any
            signingInfo.from = preview.from || preview.signerAddress
            signingInfo.to = preview.to
            signingInfo.value = preview.value
            signingInfo.chain = path.split('/')[1] // e.g. "eth", "cosmos"
            signingInfo.chainId = preview.chainId || preview.chain_id
            signingInfo.data = preview.data ? (preview.data.length > 66 ? preview.data.slice(0, 66) + '...' : preview.data) : undefined
          } catch { /* body parse failed, non-fatal */ }

          const approved = await callbacks.onSigningRequest(signingInfo)
          if (!approved) {
            return json({ error: 'Signing rejected by user' }, 403)
          }
        }

        // ═══════════════════════════════════════════════════════════════
        // All remaining endpoints require auth
        // ═══════════════════════════════════════════════════════════════

        // ── ADDRESSES (9 endpoints) ──────────────────────────────────
        if (path === '/addresses/utxo' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
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
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
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
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
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
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
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
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
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
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
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
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
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
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
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

        if (path === '/addresses/bnb' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
          const cacheKey = 'bnb:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.binanceGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        // ── ETH SIGNING (4 endpoints) ────────────────────────────────
        if (path === '/eth/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any

          // Resolve addressNList from body or by scanning
          let addressNList = body.addressNList || body.address_n_list
          if (!addressNList && body.from) {
            addressNList = await findEthAddressNList(wallet, auth, body.from)
          }
          if (!addressNList) throw { status: 400, message: 'Missing from address or addressNList' }

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
          return json(result)
        }

        if (path === '/eth/sign-typed-data' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address) throw { status: 400, message: 'Missing address' }
          if (!body.typedData) throw { status: 400, message: 'Missing typedData' }
          const { addressNList } = auth.getAccount(body.address)
          const result = await wallet.ethSignTypedData({ addressNList, typedData: body.typedData })
          return json(result)
        }

        if (path === '/eth/sign' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address) throw { status: 400, message: 'Missing address' }
          if (!body.message) throw { status: 400, message: 'Missing message' }
          if (typeof body.message !== 'string' || !/^0x[0-9a-fA-F]*$/.test(body.message)) {
            throw { status: 400, message: 'Message must be a 0x-prefixed hex string' }
          }
          const { addressNList } = auth.getAccount(body.address)
          const msgBytes = Buffer.from(body.message.slice(2), 'hex')
          const result = await wallet.ethSignMessage({ addressNList, message: msgBytes })
          return json(result)
        }

        if (path === '/eth/verify' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address || !body.message || !body.signature) {
            throw { status: 400, message: 'Missing address, message, or signature' }
          }
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
          const body = await req.json() as any
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
          })
          return json(result)
        }

        // ── COSMOS SIGNING (6 endpoints) ──────────────────────────────
        if (path === '/cosmos/sign-amino' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }
        if (path === '/cosmos/sign-amino-delegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }
        if (path === '/cosmos/sign-amino-undelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }
        if (path === '/cosmos/sign-amino-redelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }
        if (path === '/cosmos/sign-amino-withdraw-delegator-rewards-all' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }
        if (path === '/cosmos/sign-amino-ibc-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'))
        }

        // ── OSMOSIS SIGNING (9 endpoints) ────────────────────────────
        if (path === '/osmosis/sign-amino' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-delegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-undelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-redelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-withdraw-delegator-rewards-all' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-ibc-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-lp-remove' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-lp-add' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }
        if (path === '/osmosis/sign-amino-swap' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'))
        }

        // ── THORCHAIN SIGNING (2 endpoints) ──────────────────────────
        if (path === '/thorchain/sign-amino-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'thorchainSignTx', 'rune', '0', '500000000'))
        }
        if (path === '/thorchain/sign-amino-deposit' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'thorchainSignTx', 'rune', '0', '500000000'))
        }

        // ── MAYACHAIN SIGNING (2 endpoints) ──────────────────────────
        if (path === '/mayachain/sign-amino-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'mayachainSignTx', 'cacao', '0', '500000000'))
        }
        if (path === '/mayachain/sign-amino-deposit' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          return json(await cosmosAminoSign(wallet, auth, body, 'mayachainSignTx', 'cacao', '0', '500000000'))
        }

        // ── XRP SIGNING (1 endpoint) ─────────────────────────────────
        if (path === '/xrp/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const result = await wallet.rippleSignTx(body)
          return json(result)
        }

        // ── BNB SIGNING (1 endpoint) ─────────────────────────────────
        if (path === '/bnb/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          const result = await wallet.binanceSignTx(body)
          return json(result)
        }

        // ── DEVICE INFO (2 endpoints — read-only) ────────────────────
        if (path === '/system/info/get-features' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const features = await getCachedFeatures(wallet)
          return json(features)
        }

        if (path === '/system/info/get-public-key' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as any
          if (!body.address_n) throw { status: 400, message: 'Missing address_n' }
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
          return json(out)
        }

        // ── Catch-all ────────────────────────────────────────────────
        // Sequential if/else routing is fine for ~35 localhost-only endpoints.
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
