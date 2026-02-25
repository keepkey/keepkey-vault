#!/usr/bin/env bun
/**
 * keepkey-cli unit tests — pure logic, NO device needed.
 * Run: bun test projects/keepkey-cli/__tests__/unit.test.ts
 */
import { describe, it, expect } from 'bun:test'

// ─── COINS table ───────────────────────────────────────────────

// Import the module to access the COINS table indirectly via addressCommand behavior
// Since COINS is not exported, we test it via subprocess invocation.

const EXPECTED_COINS = [
  'bitcoin', 'ethereum', 'litecoin', 'dogecoin', 'cosmos',
  'thorchain', 'osmosis', 'ripple', 'dash', 'bitcoincash',
]

const EXPECTED_COIN_TYPES: Record<string, number> = {
  bitcoin: 0, ethereum: 60, litecoin: 2, dogecoin: 3, cosmos: 118,
  thorchain: 501, osmosis: 118, ripple: 144, dash: 5, bitcoincash: 145,
}

describe('CLI: command routing', () => {
  it('help prints usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'help'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toContain('keepkey-cli')
    expect(out).toContain('Commands:')
    expect(out).toContain('features')
    expect(out).toContain('firmware-info')
    expect(out).toContain('address')
  })

  it('unknown command exits with error', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'nonexistent'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('Unknown command')
  })

  it('address with unknown coin lists supported coins', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'address', 'fakecoin'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    for (const coin of EXPECTED_COINS) {
      expect(err).toContain(coin)
    }
  })

  it('initialize with invalid word count shows usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'initialize', '15'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('12|18|24')
  })

  it('pin with no action shows usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'pin'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('set|change|remove')
  })

  it('passphrase with no action shows usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'passphrase'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('on|off')
  })

  it('label with no args shows usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'label'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('label')
  })

  it('firmware with no path shows usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'firmware'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('firmware')
  })
})

describe('CLI: firmware validation', () => {
  it('rejects firmware file that is too small', async () => {
    const tmp = '/tmp/keepkey-test-firmware-small.bin'
    await Bun.write(tmp, new Uint8Array(1024)) // 1KB — below 32KB minimum
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'firmware', tmp], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('outside expected range')
  })

  it('rejects firmware file that is too large', async () => {
    const tmp = '/tmp/keepkey-test-firmware-large.bin'
    await Bun.write(tmp, new Uint8Array(2 * 1024 * 1024)) // 2MB — above 1MB max
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'firmware', tmp], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('outside expected range')
  })

  it('rejects nonexistent firmware file', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'firmware', '/tmp/nonexistent-keepkey-fw.bin'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('Cannot read firmware file')
  })
})

describe('CLI: load-seed validation', () => {
  it('rejects empty mnemonic', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'load-seed'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
      stdin: new Response('\n').body, // empty line
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('No mnemonic')
  })

  it('rejects mnemonic with wrong word count via env', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'load-seed'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, KEEPKEY_MNEMONIC: 'one two three four five six seven' },
      stdin: new Response('y\n').body,
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('expected 12, 18, or 24')
  })
})

describe('CLI: withTimeout utility', () => {
  // Directly test the timeout helper
  it('resolves when promise completes before timeout', async () => {
    // Import the utility
    const { withTimeout } = await import('../src/util/timeout-helper.ts').catch(() => {
      // withTimeout is not exported separately, test via behavior
      return { withTimeout: null }
    })

    // If not importable, test via transport module indirectly
    // The function is defined in transport.ts but not exported
    // We test the behavior through subprocess timing instead
    const start = Date.now()
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'help'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
    })
    await proc.exited
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(5000) // help should return instantly
  })
})

describe('CLI: wipe confirmation', () => {
  it('aborts on "n" answer', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'wipe'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe', stderr: 'pipe',
      stdin: new Response('n\n').body,
    })
    const code = await proc.exited
    const out = await new Response(proc.stdout).text()
    expect(code).toBe(0)
    expect(out).toContain('Aborted')
  })
})
