#!/usr/bin/env bun
/**
 * keepkey-cli live device integration tests — REQUIRES a connected KeepKey.
 *
 * These tests perform non-destructive read-only operations against a real device.
 * No PIN/passphrase prompts, no state changes, no button presses needed.
 *
 * Prerequisites:
 *   - KeepKey connected via USB
 *   - Device initialized (has a seed)
 *   - Device NOT PIN-protected (or PIN already cached/unlocked)
 *
 * Run: bun test projects/keepkey-cli/__tests__/live-device.test.ts
 */
import { describe, it, expect, beforeAll } from 'bun:test'

const CLI_CWD = import.meta.dir + '/..'
const TIMEOUT = 30_000

/** Run a CLI command and return { code, stdout, stderr } */
async function runCli(...args: string[]): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    cwd: CLI_CWD,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

// ─── Connectivity check ──────────────────────────────────────
describe('Device connectivity', () => {
  it(
    'features command succeeds',
    async () => {
      const { code, stdout, stderr } = await runCli('features')
      if (code !== 0) {
        console.error('Device not reachable. stderr:', stderr)
      }
      expect(code).toBe(0)
      expect(stdout).toContain('KeepKey Device Features')
      expect(stdout).toContain('Device ID:')
      expect(stdout).toContain('Firmware:')
    },
    TIMEOUT,
  )

  it(
    'features output has expected fields',
    async () => {
      const { stdout } = await runCli('features')
      const fields = [
        'Transport:',
        'Device ID:',
        'Label:',
        'Firmware:',
        'Bootloader:',
        'Initialized:',
        'PIN:',
        'Passphrase:',
        'Model:',
        'Vendor:',
      ]
      for (const field of fields) {
        expect(stdout).toContain(field)
      }
    },
    TIMEOUT,
  )
})

// ─── Address derivation (all 10 coins) ──────────────────────
const COIN_TESTS: Array<{
  coin: string
  // Regex that the address should match
  pattern: RegExp
}> = [
  { coin: 'bitcoin', pattern: /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/ },
  { coin: 'ethereum', pattern: /^0x[0-9a-fA-F]{40}$/ },
  { coin: 'litecoin', pattern: /^(ltc1|[LM3])[a-zA-HJ-NP-Z0-9]{25,62}$/ },
  { coin: 'dogecoin', pattern: /^D[5-9A-HJ-NP-U][a-zA-HJ-NP-Z0-9]{32}$/ },
  { coin: 'cosmos', pattern: /^cosmos1[a-z0-9]{38}$/ },
  { coin: 'thorchain', pattern: /^thor1[a-z0-9]{38}$/ },
  { coin: 'osmosis', pattern: /^osmo1[a-z0-9]{38}$/ },
  { coin: 'ripple', pattern: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/ },
  { coin: 'dash', pattern: /^X[a-zA-HJ-NP-Z0-9]{33}$/ },
  { coin: 'bitcoincash', pattern: /^(bitcoincash:)?[qp][a-z0-9]{41}$|^[13][a-zA-HJ-NP-Z0-9]{25,34}$/ },
]

describe('Address derivation', () => {
  for (const { coin, pattern } of COIN_TESTS) {
    it(
      `${coin}: returns valid address`,
      async () => {
        const { code, stdout, stderr } = await runCli('address', coin)
        if (code !== 0) {
          console.error(`${coin} address failed:`, stderr)
        }
        expect(code).toBe(0)
        const address = stdout.trim()
        expect(address.length).toBeGreaterThan(10)
        // Log for human inspection even if pattern doesn't match
        if (!pattern.test(address)) {
          console.warn(`${coin} address format unexpected: ${address} (pattern: ${pattern})`)
        }
        // We still assert — if the regex is wrong, fix the test
        expect(address).toMatch(pattern)
      },
      TIMEOUT,
    )
  }

  it(
    'address command is deterministic (same seed = same address)',
    async () => {
      const { stdout: addr1 } = await runCli('address', 'bitcoin')
      const { stdout: addr2 } = await runCli('address', 'bitcoin')
      expect(addr1.trim()).toBe(addr2.trim())
    },
    TIMEOUT,
  )
})

// ─── Firmware info ───────────────────────────────────────────
describe('Firmware info', () => {
  it(
    'firmware-info returns diagnostic output',
    async () => {
      const { code, stdout, stderr } = await runCli('firmware-info')
      if (code !== 0) {
        console.error('firmware-info failed:', stderr)
      }
      expect(code).toBe(0)
      expect(stdout).toContain('Firmware Diagnostic')
      expect(stdout).toContain('Hash (hex):')
      expect(stdout).toContain('Bootloader Analysis')
      expect(stdout).toContain('Firmware Analysis')
    },
    TIMEOUT,
  )

  it(
    'firmware-info detects signed vs unsigned',
    async () => {
      const { stdout } = await runCli('firmware-info')
      // Should contain either SIGNED or NOT IN MANIFEST for firmware
      const hasSigned = stdout.includes('SIGNED (official)')
      const hasUnsigned = stdout.includes('NOT IN MANIFEST')
      expect(hasSigned || hasUnsigned).toBe(true)
    },
    TIMEOUT,
  )
})

// ─── Edge cases ──────────────────────────────────────────────
describe('Live edge cases', () => {
  it(
    'features runs twice without error (transport reuse)',
    async () => {
      const r1 = await runCli('features')
      const r2 = await runCli('features')
      expect(r1.code).toBe(0)
      expect(r2.code).toBe(0)
    },
    TIMEOUT * 2,
  )

  it(
    'address then features in sequence works',
    async () => {
      const r1 = await runCli('address', 'ethereum')
      const r2 = await runCli('features')
      expect(r1.code).toBe(0)
      expect(r2.code).toBe(0)
    },
    TIMEOUT * 2,
  )
})
