/**
 * REST Sign-Gating Regression Guard
 * ======================================================================
 * Invariant: no REST caller may make the device sign without a gated Vault
 * UI showing what is being signed. The Vault approval overlay is opened by
 * exactly ONE code path — the central signing gate in `src/bun/rest-api.ts`:
 *
 *     if (method === 'POST' && SIGNING_ROUTES.has(path) && callbacks?.onSigningRequest) {
 *        ... empty-probe rejection ...           // <- distinctive error string
 *        const approved = await callbacks.onSigningRequest(signingInfo)  // <- opens overlay
 *     }
 *
 * That block, before it opens the overlay, rejects empty/probe bodies with a
 * DISTINCTIVE error ("Missing signing payload …" / "Empty or invalid signing
 * payload"). A route NOT in SIGNING_ROUTES never enters this block — an empty
 * body falls straight through to the signing handler's own zod check, which
 * fails with "Validation error: …".
 *
 * So an empty-body probe is a deterministic litmus, needing no GUI and no
 * device button:
 *
 *   gate error string present  <=>  route enters the overlay block  (GATED)
 *   "Validation error: …"       <=>  route bypassed the gate, went
 *                                     straight to wallet.*Sign*()     (HOLE)
 *
 * History: /tron/sign-message, /tron/sign-typed-hash, /ton/sign-message and
 * /solana/sign-offchain-message were HOLES — they reached the device with no
 * Vault overlay (only the firmware OLED). This test now asserts they are
 * GATED, locking the fix so a future route addition can't silently regress.
 *
 * Requires: vault on localhost:1646 with REST API enabled + KeepKey connected.
 * Run:  cd projects/keepkey-vault && bun test __tests__/rest-sign-gating.test.ts
 *   or: make test-sign-gating
 */
import { describe, test, expect, beforeAll } from 'bun:test'

const BASE = process.env.VAULT_API_URL || 'http://localhost:1646'
let API_KEY = ''

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

const post = (path: string, data: any) =>
  api(path, { method: 'POST', body: JSON.stringify(data) })

const TRON_PATH = [0x8000002C, 0x800000C3, 0x80000000, 0, 0]

// The central gate's empty-probe rejection strings (rest-api.ts). Their
// presence proves a request entered the overlay-gating block.
const GATE_ERROR = /Missing signing payload|Empty or invalid signing payload/
// The signing handler's own zod failure (validate.ts). Reached only when the
// overlay gate was NOT engaged for this route.
const HANDLER_ERROR = /Validation error/

beforeAll(async () => {
  const health = await api('/api/health').catch(() => null)
  if (!health || health.status !== 200) {
    throw new Error(`Vault not reachable at ${BASE} — start with: make dev (KEEPKEY_REST_API=true)`)
  }
  const pair = await post('/auth/pair', { name: 'rest-sign-gating-guard', url: 'http://localhost' })
  if (pair.status !== 200 || !pair.body?.apiKey) {
    throw new Error(`Pairing failed: ${JSON.stringify(pair.body)} (approve on device if prompted)`)
  }
  API_KEY = pair.body.apiKey
})

// Every POST signing route must enter the overlay-gating block — proven by
// the distinctive gate error on an empty probe. The four message routes at
// the end are the ones this PR fixed.
const GATED_ROUTES = [
  '/eth/sign',
  '/solana/sign-message',
  '/tron/sign-transaction',
  '/ton/sign-transaction',
  // ── newly gated by this PR (were holes) ──
  '/tron/sign-message',
  '/tron/sign-typed-hash',
  '/ton/sign-message',
  '/solana/sign-offchain-message',
]

describe('every sign route is gated by the Vault overlay', () => {
  for (const route of GATED_ROUTES) {
    test(`${route} → empty probe hits the overlay gate`, async () => {
      const { status, body } = await post(route, {})
      const err = String(body?.error ?? '')
      expect(status).toBe(400)
      expect(err).toMatch(GATE_ERROR)        // overlay-gating block ran
      expect(err).not.toMatch(HANDLER_ERROR) // never reached the signing handler
    })
  }
})

describe('auth: every sign route still requires a bearer', () => {
  for (const route of GATED_ROUTES) {
    test(`${route} → 401 without bearer`, async () => {
      const saved = API_KEY
      API_KEY = ''
      try {
        const { status } = await post(route, { message: 'x' })
        expect(status).toBe(401)
      } finally {
        API_KEY = saved
      }
    })
  }
})

// Opt-in live check: a real signature now pops the Vault overlay first.
describe.if(process.env.RUN_LIVE_SIGN === '1')('LIVE: /tron/sign-message routes through the Vault overlay', () => {
  test('the Vault approval window appears before the device prompt; approve both to get a signature', async () => {
    console.log('\n👁  APPROVE in the Vault window first, then on the KeepKey.\n')
    const { status, body } = await post('/tron/sign-message', {
      address_n: TRON_PATH,
      message: 'KeepKey REST sign-gating regression',
      is_text: true,
    })
    expect(status).toBe(200)
    expect(typeof body?.signature).toBe('string')
    expect(body.signature.length).toBeGreaterThan(0)
  }, 300000)
})
