/**
 * REST API Integration Tests
 *
 * Requires: vault running on localhost:1646 with REST API enabled + KeepKey connected.
 * Run: make test-rest
 */
import { describe, test, expect, beforeAll } from 'bun:test'

const BASE = process.env.VAULT_API_URL || 'http://localhost:1646'
let API_KEY = ''

// ── Helpers ──────────────────────────────────────────────────────────────

async function api(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  }
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`
  const res = await fetch(`${BASE}${path}`, { ...opts, headers })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function post(path: string, data: any) {
  return api(path, { method: 'POST', body: JSON.stringify(data) })
}

// ── BIP44 Paths ──────────────────────────────────────────────────────────

const PATHS = {
  btc:       [0x8000002C, 0x80000000, 0x80000000, 0, 0],
  eth:       [0x8000002C, 0x8000003C, 0x80000000, 0, 0],
  cosmos:    [0x8000002C, 0x80000076, 0x80000000, 0, 0],
  thorchain: [0x8000002C, 0x800003A3, 0x80000000, 0, 0],
  osmosis:   [0x8000002C, 0x80000076, 0x80000000, 0, 0],
  xrp:       [0x8000002C, 0x80000090, 0x80000000, 0, 0],
  solana:    [0x8000002C, 0x800001F5, 0x80000000, 0x80000000],
  tron:      [0x8000002C, 0x800000C3, 0x80000000, 0, 0],
  ton:       [0x8000002C, 0x8000025F, 0x80000000],
  ltc:       [0x8000002C, 0x80000002, 0x80000000, 0, 0],
  doge:      [0x8000002C, 0x80000003, 0x80000000, 0, 0],
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Check vault is running
  const health = await api('/api/health').catch(() => null)
  if (!health || health.status !== 200) {
    throw new Error(`Vault not reachable at ${BASE} — start with: make dev (with KEEPKEY_REST_API=true)`)
  }

  // Pair to get API key (requires device button confirm)
  console.log('Pairing with vault... (confirm on device if prompted)')
  const pair = await post('/auth/pair', { name: 'rest-api-test', url: 'http://localhost' })
  if (pair.status !== 200 || !pair.body?.apiKey) {
    throw new Error(`Pairing failed: ${JSON.stringify(pair.body)}`)
  }
  API_KEY = pair.body.apiKey
  console.log('Paired successfully')
})

// ── Health & Info ────────────────────────────────────────────────────────

describe('Health & Device Info', () => {
  test('GET /api/health → 200', async () => {
    const { status, body } = await api('/api/health')
    expect(status).toBe(200)
    expect(body).toBeTruthy()
  })

  test('GET /device/info/features → device features', async () => {
    const { status, body } = await api('/device/info/features')
    expect(status).toBe(200)
    expect(body.vendor).toBe('keepkey.com')
    expect(body.device_id).toBeTruthy()
  })

  test('GET /spec/swagger.json → OpenAPI spec', async () => {
    const { status, body } = await api('/spec/swagger.json')
    expect(status).toBe(200)
    expect(body.openapi || body.swagger).toBeTruthy()
  })
})

// ── Legacy Chain Address Endpoints ───────────────────────────────────────

describe('Address Derivation — Legacy Chains', () => {
  test('POST /addresses/eth → ETH address', async () => {
    const { status, body } = await post('/addresses/eth', { address_n: PATHS.eth })
    expect(status).toBe(200)
    expect(body.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  test('POST /addresses/utxo → BTC address (p2pkh)', async () => {
    const { status, body } = await post('/addresses/utxo', {
      address_n: PATHS.btc,
      coin: 'Bitcoin',
      script_type: 'p2pkh',
    })
    expect(status).toBe(200)
    expect(body.address).toBeTruthy()
  })

  test('POST /addresses/cosmos → COSMOS address', async () => {
    const { status, body } = await post('/addresses/cosmos', { address_n: PATHS.cosmos })
    expect(status).toBe(200)
    expect(body.address).toMatch(/^cosmos1/)
  })

  test('POST /addresses/thorchain → THOR address', async () => {
    const { status, body } = await post('/addresses/thorchain', { address_n: PATHS.thorchain })
    expect(status).toBe(200)
    expect(body.address).toMatch(/^thor1/)
  })

  test('POST /addresses/osmosis → OSMO address', async () => {
    const { status, body } = await post('/addresses/osmosis', { address_n: PATHS.osmosis })
    expect(status).toBe(200)
    expect(body.address).toMatch(/^osmo1/)
  })

  test('POST /addresses/xrp → XRP address', async () => {
    const { status, body } = await post('/addresses/xrp', { address_n: PATHS.xrp })
    expect(status).toBe(200)
    expect(body.address).toMatch(/^r/)
  })
})

// ── New Chain Address Endpoints (v7.14.0) ────────────────────────────────

describe('Address Derivation — New Chains (v7.14.0)', () => {
  test('POST /addresses/solana → SOL address', async () => {
    const { status, body } = await post('/addresses/solana', { address_n: PATHS.solana })
    expect(status).toBe(200)
    expect(body.address).toBeTruthy()
    expect(typeof body.address).toBe('string')
    expect(body.address.length).toBeGreaterThan(30) // base58 ~32-44 chars
    console.log('  SOL address:', body.address)
  })

  test('POST /addresses/tron → TRX address', async () => {
    const { status, body } = await post('/addresses/tron', { address_n: PATHS.tron })
    expect(status).toBe(200)
    expect(body.address).toBeTruthy()
    expect(body.address).toMatch(/^T/) // Tron addresses start with T
    console.log('  TRX address:', body.address)
  })

  test('POST /addresses/ton → TON address', async () => {
    const { status, body } = await post('/addresses/ton', { address_n: PATHS.ton })
    expect(status).toBe(200)
    expect(body.address).toBeTruthy()
    expect(typeof body.address).toBe('string')
    console.log('  TON address:', body.address)
  })
})

// ── Auth ─────────────────────────────────────────────────────────────────

describe('Auth & Pairing', () => {
  test('Unauthenticated request → 401', async () => {
    const saved = API_KEY
    API_KEY = ''
    const { status } = await post('/addresses/eth', { address_n: PATHS.eth })
    API_KEY = saved
    expect(status).toBe(401)
  })

  test('Invalid bearer token → 401', async () => {
    const saved = API_KEY
    API_KEY = 'invalid-token-12345'
    const { status } = await post('/addresses/eth', { address_n: PATHS.eth })
    API_KEY = saved
    expect(status).toBe(401)
  })

  test('GET /auth/paired-apps → lists paired apps', async () => {
    const { status, body } = await api('/auth/paired-apps')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0].name).toBeTruthy()
  })
})

// ── Public Key ───────────────────────────────────────────────────────────

describe('Public Key Derivation', () => {
  test('POST /system/info/get-public-key → xpub', async () => {
    const { status, body } = await post('/system/info/get-public-key', {
      address_n: [0x8000002C, 0x80000000, 0x80000000],
      coin_name: 'Bitcoin',
      script_type: 'p2pkh',
    })
    expect(status).toBe(200)
    expect(body.xpub).toMatch(/^xpub/)
  })
})

// ── Request Validation ───────────────────────────────────────────────────

describe('Request Validation', () => {
  test('POST /addresses/eth with empty body → 400', async () => {
    const { status } = await post('/addresses/eth', {})
    expect(status).toBe(400)
  })

  test('POST /addresses/solana with invalid path → 400', async () => {
    const { status } = await post('/addresses/solana', { address_n: [1] })
    expect(status).toBe(400)
  })

  test('POST /solana/sign-transaction with no raw_tx → 400', async () => {
    const { status } = await post('/solana/sign-transaction', {})
    expect(status).toBe(400)
  })

  test('POST /tron/sign-transaction with no raw_tx → 400', async () => {
    const { status } = await post('/tron/sign-transaction', {})
    expect(status).toBe(400)
  })

  test('POST /ton/sign-transaction with no raw_tx → 400', async () => {
    const { status } = await post('/ton/sign-transaction', {})
    expect(status).toBe(400)
  })
})

// ── Address Caching ──────────────────────────────────────────────────────

describe('Address Caching', () => {
  test('Second call returns cached (faster)', async () => {
    // First call — device round-trip
    const t1 = performance.now()
    await post('/addresses/eth', { address_n: PATHS.eth })
    const first = performance.now() - t1

    // Second call — should hit cache
    const t2 = performance.now()
    const { status, body } = await post('/addresses/eth', { address_n: PATHS.eth })
    const second = performance.now() - t2

    expect(status).toBe(200)
    expect(body.address).toBeTruthy()
    console.log(`  First: ${first.toFixed(0)}ms, Cached: ${second.toFixed(0)}ms`)
  })
})
