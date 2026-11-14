#!/usr/bin/env bun
/**
 * Electrobun fixes KeepKey Desktop depends on that live only in our fork
 * (keepkey/electrobun keepkey/2.x). Upstream v2.0.6 still has both bugs, so a
 * fork rebase that loses either must stop the release, as 1.x's
 * prune-app-bundle.ts did. Each marker is text only the fixed code contains,
 * looked up in the packed app's Resources directory.
 *
 * Usage: bun scripts/electrobun-fixes.ts <app Resources dir>
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ElectrobunFixMarker {
  fix: string
  /** Relative to the app's Resources directory. */
  file: string
  /** Optional files are checked only when the app carries them. */
  optional?: boolean
  present: string[]
  absent: RegExp[]
}

const RPC_FIX = 'RPC answers a handler that throws a non-Error (fork 9d2751eb)'
const PRELOAD_FIX = 'preload waits for crypto.subtle before RPC encryption (fork 96586066)'

export const ELECTROBUN_FIX_MARKERS: ElectrobunFixMarker[] = [
  {
    fix: RPC_FIX,
    file: 'app/bun/index.js',
    present: ['function errorText(error)', 'error: errorText(error)'],
    // Upstream's dispatcher: re-throws, so no response is ever sent.
    absent: [/if \(!\(error instanceof Error\)\)\s*throw error;/],
  },
  {
    // The Bun API embeds the preload it injects into every webview.
    fix: PRELOAD_FIX,
    file: 'app/bun/index.js',
    present: ['crypto.subtle unavailable after'],
    absent: [],
  },
  {
    // The devkit's standalone copy, for native SDK hosts.
    fix: PRELOAD_FIX,
    file: 'preload-full.js',
    optional: true,
    present: ['crypto.subtle unavailable after'],
    absent: [],
  },
]

/** Problems with the fork fixes in an app's Resources directory; empty when all shipped. */
export function electrobunFixProblems(resources: string): string[] {
  const problems: string[] = []
  for (const { fix, file, optional, present, absent } of ELECTROBUN_FIX_MARKERS) {
    const path = join(resources, file)
    if (!existsSync(path)) {
      if (!optional) problems.push(`${fix}: ${file} missing`)
      continue
    }
    const code = readFileSync(path, 'utf8')
    for (const text of present) if (!code.includes(text)) problems.push(`${fix}: ${file} lacks ${JSON.stringify(text)}`)
    for (const pattern of absent) if (pattern.test(code)) problems.push(`${fix}: ${file} still has upstream's ${pattern}`)
  }
  return problems
}

if (import.meta.main) {
  const resources = process.argv[2]
  if (!resources) throw new Error('usage: bun scripts/electrobun-fixes.ts <app Resources dir>')
  const problems = electrobunFixProblems(resources)
  for (const problem of problems) console.error(`[electrobun-fixes] FAIL: ${problem}`)
  if (problems.length > 0) process.exit(1)
  console.log(`[electrobun-fixes] RPC and preload fork fixes present in ${resources}`)
}
