import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ELECTROBUN_FIX_MARKERS, electrobunFixProblems } from '../scripts/electrobun-fixes'

const fork = join(import.meta.dir, '../../../modules/electrobun/package/src')
const work = mkdtempSync(join(tmpdir(), 'kk-electrobun-fixes-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

let n = 0
function resources(files: Record<string, string>): string {
  const dir = join(work, String(n++))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

// Bundle the pinned fork's sources the way the app's bun/index.js carries them.
async function bundled(entry: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [join(fork, entry)], target: 'bun' })
  if (!result.success) throw new Error(result.logs.join('\n'))
  return result.outputs[0].text()
}

const UPSTREAM_RPC = `      } catch (error) {
        if (!(error instanceof Error))
          throw error;
        response = {
          type: "response",
          id,
          success: false,
          error: error.message
        };
      }`

describe('Electrobun fork fixes in the packed app', () => {
  test('the marker list is pinned', () => {
    expect(ELECTROBUN_FIX_MARKERS.map(m => [m.file, m.optional ?? false, m.present, m.absent.map(String)])).toEqual([
      ['app/bun/index.js', false, ['function errorText(error)', 'error: errorText(error)'], ['/if \\(!\\(error instanceof Error\\)\\)\\s*throw error;/']],
      ['app/bun/index.js', false, ['crypto.subtle unavailable after'], []],
      ['preload-full.js', true, ['crypto.subtle unavailable after'], []],
    ])
  })

  test('the pinned fork, bundled, passes', async () => {
    const backend = (await bundled('shared/rpc.ts')) + (await bundled('preload/encryption.ts'))
    expect(electrobunFixProblems(resources({ 'app/bun/index.js': backend }))).toEqual([])
  })

  test("upstream's RPC dispatcher fails the release", async () => {
    const preload = await bundled('preload/encryption.ts')
    const problems = electrobunFixProblems(resources({ 'app/bun/index.js': UPSTREAM_RPC + preload }))
    expect(problems).toHaveLength(3)
    expect(problems.every(p => p.startsWith('RPC answers a handler that throws a non-Error'))).toBe(true)
    expect(problems.some(p => p.includes("still has upstream's"))).toBe(true)
  })

  test("upstream's preload fails the release, in the backend and in preload-full.js", async () => {
    const rpc = await bundled('shared/rpc.ts')
    expect(electrobunFixProblems(resources({ 'app/bun/index.js': rpc }))).toEqual([
      'preload waits for crypto.subtle before RPC encryption (fork 96586066): app/bun/index.js lacks "crypto.subtle unavailable after"',
    ])
    const preload = await bundled('preload/encryption.ts')
    expect(electrobunFixProblems(resources({ 'app/bun/index.js': rpc + preload, 'preload-full.js': 'initEncryption()' }))).toEqual([
      'preload waits for crypto.subtle before RPC encryption (fork 96586066): preload-full.js lacks "crypto.subtle unavailable after"',
    ])
  })

  test('a missing backend fails the release', () => {
    expect(electrobunFixProblems(resources({}))).toHaveLength(2)
  })
})
