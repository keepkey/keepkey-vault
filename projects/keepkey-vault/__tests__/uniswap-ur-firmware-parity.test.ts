import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'

import { UR_KINDS, urDecode, urSummarize, urTokenSet, type UrPlan, type UrSummary } from '../src/bun/uniswap-ur'

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

/** The decode and review in the firmware harness's line format. */
function line(plan: UrPlan | null, s: UrSummary | null): string {
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
    s.fee ? '1' : '0', String(s.fee?.bips ?? 0), s.fee ? a(s.fee.recipient) : zero,
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
