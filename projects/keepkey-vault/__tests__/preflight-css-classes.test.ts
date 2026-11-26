import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// .kk-pf-num is NumberNode's class (round timeline/step nodes). A rule that
// styles it on its own — the swap's value field once did — flattens every
// timeline node in the app into a square with a bottom border.
test('PreflightConsole: .kk-pf-num is only ever styled as a NumberNode', () => {
  const src = readFileSync(join(import.meta.dir, '../src/mainview/components/preflight/PreflightConsole.tsx'), 'utf8')
  const selectors = [...src.matchAll(/^\s*([^{}\n@/][^{}\n]*)\{/gm)].map(m => m[1]!.trim())
  const offending = selectors.flatMap(s => s.split(',').map(x => x.trim())).filter(x => /\.kk-pf-num\b/.test(x) && !/\.kk-pf-node\.kk-pf-num\b/.test(x))
  expect(offending).toEqual([])
  expect(src).toContain('.kk-pf-field {')
})
