import type { EngineController } from './engine-controller'
import type { AuthStore } from './auth'
import { readFileSync } from 'fs'
import { join } from 'path'

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

export function startRestApi(engine: EngineController, auth: AuthStore, port = 1646) {
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

      // Per-request response helpers (capture req for CORS origin check)
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
      })

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
          return new Response(getSwagger(), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // HEALTH (public)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/api/health' && method === 'GET') {
          return json({ status: 'ok', connected: engine.wallet !== null })
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
            // Sliding-window rate limit
            const now = Date.now()
            while (pairAttempts.length > 0 && now - pairAttempts[0] > PAIR_RATE_WINDOW_MS) pairAttempts.shift()
            if (pairAttempts.length >= PAIR_RATE_LIMIT) {
              return json({ error: 'Too many pairing attempts. Try again later.' }, 429)
            }
            pairAttempts.push(now)

            const body = await req.json() as any
            if (!body.name) throw { status: 400, message: 'Missing name in pairing request' }
            // requestPair requires user approval via UI — NOT auto-granted
            const apiKey = await auth.requestPair(body)
            return json({ apiKey })
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
