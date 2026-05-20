/**
 * Run all SDK test suites sequentially.
 * Usage: node tests/run-all.js [filter]
 *
 * Examples:
 *   node tests/run-all.js           # run all
 *   node tests/run-all.js chain     # run only chain/* tests
 *   node tests/run-all.js sweep     # run only sweep/* tests
 */
const { execSync } = require('child_process')
const { readdirSync, statSync } = require('fs')
const { join } = require('path')

const filter = process.argv[2] || ''
const testsDir = __dirname

// Discover all .js test files (skip _helpers, run-all, fixtures)
const SKIP = new Set(['_helpers.js', 'run-all.js'])

function findTests(dir, prefix = '') {
  const entries = []
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) {
      if (name === 'fixtures') continue
      entries.push(...findTests(full, rel))
    } else if (name.endsWith('.js')) {
      entries.push({ path: full, name: rel })
    }
  }
  return entries
}

const tests = findTests(testsDir).filter(t => !filter || t.name.includes(filter))

console.log(`\n  Running ${tests.length} test suite(s)${filter ? ` (filter: "${filter}")` : ''}:\n`)

let passed = 0, failed = 0

for (const test of tests) {
  console.log(`  ── ${test.name} ──`)
  try {
    execSync(`node "${test.path}"`, { stdio: 'inherit', timeout: 180000 })
    passed++
  } catch (e) {
    failed++
    console.error(`  FAILED: ${test.name}\n`)
  }
}

console.log(`\n  ════════════════════════════════════════`)
console.log(`  Total: ${passed + failed} suites, ${passed} passed, ${failed} failed`)
console.log(`  ════════════════════════════════════════\n`)

process.exit(failed > 0 ? 1 : 0)
