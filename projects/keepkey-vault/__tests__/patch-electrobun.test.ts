/**
 * patch-electrobun.sh must FAIL LOUDLY when an anchor or target file is missing.
 *
 * The version before this test warned-and-continued, so two macOS Info.plist
 * patches silently no-opped across five Electrobun releases and shipped v1.5.1
 * with no NSCameraUsageDescription at all. A patch that quietly does nothing
 * reintroduces the bug it was written to fix, so every miss must break install.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'patch-electrobun.sh')

const CLI = 'src/cli/index.ts'
const RPC = 'dist/api/shared/rpc.ts'
const PRELOAD = 'dist/api/bun/preload/.generated/compiled.ts'

// Minimal stand-ins carrying only the upstream text each patch anchors to.
// compiled.ts embeds the preload as an escaped string, hence the literal \".
const FIXTURES: Record<string, string> = {
  [CLI]: [
    'const cmd = `zip -y -r -9 ${escapePathForTerminal(zipPath)}`;',
    'execSync(cmd, {',
    '\tcwd: dirname(appOrDmgPath),',
    '});',
  ].join('\n'),
  [RPC]: [
    '} catch (error) {',
    '\t\t\t\tif (!(error instanceof Error)) throw error;',
    '}',
  ].join('\n'),
  [PRELOAD]:
    'initEncryption().catch((err) => console.error(\\"Failed to initialize encryption:\\", err));',
}

function makeTree(overrides: Record<string, string | null> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'patch-ebun-'))
  for (const [rel, contents] of Object.entries({ ...FIXTURES, ...overrides })) {
    if (contents === null) continue // deliberately absent
    const full = join(root, 'node_modules', 'electrobun', rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

function runPatch(root: string) {
  const proc = Bun.spawnSync(['bash', SCRIPT], { cwd: root })
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
    read: (rel: string) => readFileSync(join(root, 'node_modules', 'electrobun', rel), 'utf8'),
  }
}

describe('patch-electrobun.sh', () => {
  test('applies every patch when all anchors are present', () => {
    const root = makeTree()
    try {
      const r = runPatch(root)
      expect(r.code).toBe(0)
      expect(r.read(CLI)).toContain('zip -y -r -q -9')
      expect(r.read(CLI)).toContain('maxBuffer: 50 * 1024 * 1024')
      expect(r.read(RPC)).toContain('kkDeviceErrorText')
      expect(r.read(PRELOAD)).toContain('__ebInitEncRetry')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('is idempotent — a second run re-reports without corrupting', () => {
    const root = makeTree()
    try {
      expect(runPatch(root).code).toBe(0)
      const after = runPatch(root)
      expect(after.code).toBe(0)
      expect(after.out).toContain('already patched')
      // The retry wrapper must not get nested on re-run.
      expect(after.read(PRELOAD).match(/__ebInitEncRetry = /g)?.length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Each of these silently skipped before, shipping an unpatched Electrobun.
  const misses: Array<[string, Record<string, string | null>]> = [
    ['rpc.ts is missing entirely', { [RPC]: null }],
    ['preload compiled.ts is missing entirely', { [PRELOAD]: null }],
    ['the CLI is missing entirely', { [CLI]: null }],
    ['the rpc.ts anchor changed upstream', { [RPC]: 'if (!(error instanceof Error)) rethrow(error);' }],
    ['the zip anchor changed upstream', { [CLI]: 'const cmd = `zip -r -9 ${zipPath}`;' }],
    ['the preload anchor changed upstream', { [PRELOAD]: 'await initEncryption();' }],
  ]

  for (const [label, overrides] of misses) {
    test(`fails when ${label}`, () => {
      const root = makeTree(overrides)
      try {
        const r = runPatch(root)
        expect(r.code).not.toBe(0)
        expect(r.out).toContain('ERROR')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
