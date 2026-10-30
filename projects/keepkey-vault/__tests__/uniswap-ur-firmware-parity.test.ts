import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'

import { UR_KINDS, UR_RULES_717, UR_V4_ROUTERS_717, urDecode, urPrecheck, urRules, urSummarize, urTokenSet, type UrPlan, type UrSummary } from '../src/bun/uniswap-ur'

/**
 * Differential test: the Desktop's Universal Router decoder against the
 * firmware's own (uniswap_ur.c), on every call the firmware's model test reads:
 * the 1,000-call D-021 sample (real Base UR 2.1.2 traffic, incl. V4), the 250
 * vectors (UR 1.2 / 2.0 / 2.1.2), the 10 V4 vectors and 2,048 mutated V4
 * calls. Each expected line is the firmware's output for that call
 * (scripts/uniswap-fw-oracle/gen-fixture.sh; the generator also checked it
 * against the firmware's independent Python model). Accept/refuse, every
 * plan step, the hooks and the whole review must be identical.
 */
const fixture = JSON.parse(Buffer.from(Bun.gunzipSync(readFileSync(new URL('./fixtures/uniswap/ur-firmware-parity.json.gz', import.meta.url)))).toString()) as {
  source: string
  summary: { cases: number; reviewed: number; mutantsRefusedOnlyByDevice: number }
  calls: Record<string, [string, string, string]>
  cases: [string, string | null, [number, number][] | null, string][]
}

const h = (n: bigint, bytes: number) => n.toString(16).padStart(2 * bytes, '0')
const a = (x: string) => x.slice(2)

/** The decode and review in the firmware harness's line format (7.17 adds
 * the TRANSFER fee amount after the bips). */
function line(plan: UrPlan | null, s: UrSummary | null, feeAmount = false): string {
  if (!plan) return 'D 0'
  const out = ['D', '1', String(plan.steps.length)]
  for (const t of plan.steps) {
    out.push(String(UR_KINDS.indexOf(t.kind)), a(t.tokenIn), a(t.tokenOut), a(t.recipient), h(t.amount, 32), h(t.limit, 32),
      t.payerIsUser ? '1' : '0', String(t.expiration))
  }
  out.push('H', String(plan.hooks.length), ...plan.hooks.map(a))
  if (!s) return [...out, 'S', '0'].join(' ')
  const zero = '0'.repeat(40)
  out.push('S', '1', s.exactIn ? '1' : '0', s.inIsEth ? '1' : '0', s.outIsEth ? '1' : '0', a(s.tokenIn), a(s.tokenOut),
    h(s.amountIn, 32), h(s.amountOut, 32), a(s.recipient), s.recipientIsSender ? '1' : '0',
    s.permit ? '1' : '0', s.permit ? a(s.permit.token) : zero, h(s.permit?.amount ?? 0n, 32), String(s.permit?.expiration ?? 0n),
    s.fee ? '1' : '0', String(s.fee?.bips ?? 0), ...(feeAmount ? [h(s.fee?.amount ?? 0n, 32)] : []), s.fee ? a(s.fee.recipient) : zero,
    'R', String(s.hooks.length), ...s.hooks.map(a))
  return out.join(' ')
}

function call(key: string, base: string | null, edits: [number, number][] | null) {
  const [router, value, cd] = fixture.calls[base ?? key]
  const bytes = Buffer.from(cd, 'hex')
  for (const [at, v] of edits ?? []) bytes[at] = v
  return { router: `0x${router}`, value: BigInt(`0x${value}`), bytes }
}

describe('Universal Router decoder: Desktop = firmware on every call', () => {
  it('fixture is the full firmware model set', () => {
    expect(fixture.source).toContain('51f85368e')
    expect(fixture.cases).toHaveLength(3308)
    expect(fixture.summary.mutantsRefusedOnlyByDevice).toBe(24)
  })

  it('accepts, refuses, plans and reviews exactly as the device does', () => {
    const mismatches: string[] = []
    let reviewed = 0, sampleReviewed = 0, v4Reviewed = 0, longReviewed = 0
    for (const [key, base, edits, device] of fixture.cases) {
      const c = call(key, base, edits)
      const plan = urDecode(c.bytes)
      const s = plan && urSummarize(plan, c.router, c.value)
      const got = line(plan, s)
      if (got !== device) mismatches.push(`${key}${base ? ` (${base} ${JSON.stringify(edits)})` : ''}\n  desktop ${got.slice(0, 160)}\n  device  ${device.slice(0, 160)}`)
      if (s) {
        reviewed++
        if (key.startsWith('0x')) sampleReviewed++
        if (plan!.steps.some((t) => t.kind.startsWith('V4_'))) v4Reviewed++
        if (c.bytes.length > 1472) longReviewed++ // past 7.16's held-calldata buffer
      }
    }
    expect(mismatches.slice(0, 5).join('\n')).toBe('')
    expect(reviewed).toBe(fixture.summary.reviewed)
    expect(sampleReviewed).toBe(990) // D-021: 990 of the 1,000 sample calls
    expect(v4Reviewed).toBeGreaterThan(200)
    expect(longReviewed).toBeGreaterThan(100) // no buffer: the device streams (D-021)
  })

  it('the certified entry names only the paid and delivered tokens (and the permit token): never ETH, never an intermediate, at most 4', () => {
    let multiHop = 0
    for (const [key, base, edits] of fixture.cases) {
      if (base) continue
      const c = call(key, base, edits)
      const plan = urDecode(c.bytes)
      const s = plan && urSummarize(plan, c.router, c.value)
      if (!s) continue
      const tokens = urTokenSet(s)
      expect(tokens.length).toBeLessThanOrEqual(4)
      expect(tokens).not.toContain(`0x${'0'.repeat(40)}`)
      const named = new Set([...(s.inIsEth ? [] : [s.tokenIn]), ...(s.outIsEth ? [] : [s.tokenOut]), ...(s.permit ? [s.permit.token] : [])])
      expect(new Set(tokens)).toEqual(named)
      const touched = new Set(plan!.steps.flatMap((t) => (t.kind.includes('SWAP') ? [t.tokenIn, t.tokenOut] : [])))
      if ([...touched].some((t) => t !== `0x${'0'.repeat(40)}` && !named.has(t) && t !== s.tokenIn && t !== s.tokenOut)) multiHop++
    }
    expect(multiHop).toBeGreaterThan(0) // routes through intermediates exist, and are left out
  })

  it('V4 is reviewed only for UR 2.1.2 (0xd614, Base): the same calls to UR 2.0 are refused', () => {
    const ur20 = '0x6ff5693b99212da76ad316178a184ab56d299b43'
    let v4 = 0
    for (const [key, base, edits] of fixture.cases) {
      if (base || !key.startsWith('0x')) continue
      const c = call(key, base, edits)
      const plan = urDecode(c.bytes)
      if (!plan?.steps.some((t) => t.kind.startsWith('V4_SWAP')) || !urSummarize(plan, c.router, c.value)) continue
      v4++
      expect(urSummarize(plan, ur20, c.value)).toBeNull()
    }
    expect(v4).toBeGreaterThan(200)
  })
})

/**
 * The same, against firmware 7.17 (alpha 296aa1e2c): V4_SWAP read by router
 * (UR 2.0 without minHopPriceX36, UR 2.1.1, UR 2.1.2 on Ethereum, Base and
 * Arbitrum), exact-output V4 only on UR 2.1.2, 8 plan steps, the exact-output
 * fee as a TRANSFER of the output token, no fee to the payer. Cases: the
 * firmware's model set (less uniswap_ur_v4_routers.h, one wallet's swaps),
 * the 142 public rw calls, and every V4 sample call sent to each other router
 * (device lines only). scripts/uniswap-fw-oracle/gen-fixture.sh <fw> 296aa1e2c
 * __tests__/fixtures/uniswap/ur-firmware-parity-717.json.gz
 */
const fx717 = JSON.parse(Buffer.from(Bun.gunzipSync(readFileSync(new URL('./fixtures/uniswap/ur-firmware-parity-717.json.gz', import.meta.url)))).toString()) as {
  source: string
  summary: { cases: number; reviewed: number; mutantsRefusedOnlyByDevice: number; retargeted: number }
  calls: Record<string, [string, string, string]>
  cases: [string, string | null, [number, number][] | null, string, string?][]
}

describe('Universal Router decoder: Desktop = firmware 7.17 on every call', () => {
  const call717 = (key: string, base: string | null, edits: [number, number][] | null, router?: string) => {
    const [r, value, cd] = fx717.calls[base ?? key]
    const bytes = Buffer.from(cd, 'hex')
    for (const [at, v] of edits ?? []) bytes[at] = v
    return { router: `0x${router ?? r}`, value: BigInt(`0x${value}`), bytes }
  }

  it('fixture is alpha 296aa1e2c', () => {
    expect(fx717.source).toContain('296aa1e2c')
    expect(fx717.cases).toHaveLength(fx717.summary.cases)
    expect(fx717.summary.retargeted).toBeGreaterThan(1000)
  })

  it('accepts, refuses, plans and reviews exactly as the device does', () => {
    const mismatches: string[] = []
    let reviewed = 0, transferFee = 0, longPlans = 0
    const v4ByRouter: Record<string, number> = {}
    for (const [key, base, edits, device, router] of fx717.cases) {
      const c = call717(key, base, edits, router)
      const plan = urDecode(c.bytes, c.router, UR_RULES_717)
      const s = plan && urSummarize(plan, c.router, c.value, UR_RULES_717)
      const got = line(plan, s, true)
      if (got !== device) mismatches.push(`${key}${base ? ` (${base} ${JSON.stringify(edits)})` : ''}\n  desktop ${got.slice(0, 160)}\n  device  ${device.slice(0, 160)}`)
      if (s) {
        reviewed++
        if (s.fee?.amount !== undefined) transferFee++
        if (plan!.steps.length > 6) longPlans++
        if (plan!.steps.some((t) => t.kind.startsWith('V4_SWAP'))) v4ByRouter[c.router] = (v4ByRouter[c.router] ?? 0) + 1
      }
    }
    expect(mismatches.slice(0, 5).join('\n')).toBe('')
    expect(reviewed).toBe(fx717.summary.reviewed)
    expect(transferFee).toBeGreaterThan(0) // the app's exact-output fee
    expect(longPlans).toBeGreaterThan(0) // 7 and 8 plan steps
    // V4 is reviewed on every UR 2.1.x router, and refused on UR 1.2.
    for (const r of Object.keys(UR_V4_ROUTERS_717).filter((x) => UR_V4_ROUTERS_717[x] & 2)) expect([r, (v4ByRouter[r] ?? 0) > 0]).toEqual([r, true])
    expect(v4ByRouter['0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad']).toBeUndefined()
  })

  it('firmware version picks the rules: 7.16 keeps V4 on Base UR 2.1.2 only', () => {
    expect(urRules('7.17.0')).toBe(UR_RULES_717)
    expect(urRules('v7.18.2')).toBe(UR_RULES_717)
    expect(urRules('7.16.0')).not.toBe(UR_RULES_717)
    expect(urRules(undefined)).not.toBe(UR_RULES_717)
    let v4 = 0
    for (const [key, base, edits, , router] of fx717.cases) {
      if (!router || !key.startsWith('rt') || router !== '23617e59a5925b2a4bf75d73ff6711cd0b29de85') continue
      const c = call717(key, base, edits, router)
      const hex = c.bytes.toString('hex')
      if (!urPrecheck(c.router, hex, c.value, '7.17.0')) continue
      v4++
      // Ethereum UR 2.1.2: a 7.17 review, refused by 7.16 (and unknown firmware).
      expect(urPrecheck(c.router, hex, c.value, '7.16.0')).toBeNull()
      expect(urPrecheck(c.router, hex, c.value)).toBeNull()
    }
    expect(v4).toBeGreaterThan(100)
  })
})
