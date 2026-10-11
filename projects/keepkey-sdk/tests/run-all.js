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

// Discover all .js test files (skip helpers, run-all, fixtures)
const SKIP = new Set(['_helpers.js', '_clearsign.js', 'run-all.js'])

// recovery/* WIPES the connected device. Never part of a normal run: it needs
// KEEPKEY_ALLOW_WIPE=1 and runs last, because it leaves the device empty.
const DESTRUCTIVE = 'recovery/'
const allowWipe = process.env.KEEPKEY_ALLOW_WIPE === '1'

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

const found = findTests(testsDir).filter(t => !filter || t.name.includes(filter))
const wipes = found.filter(t => t.name.startsWith(DESTRUCTIVE))
const tests = found.filter(t => !t.name.startsWith(DESTRUCTIVE)).concat(allowWipe ? wipes : [])
if (wipes.length && !allowWipe) {
  console.log(`\n  Skipping ${wipes.length} suite(s) that WIPE the device (${DESTRUCTIVE}*). Set KEEPKEY_ALLOW_WIPE=1 on a test device to run them.`)
}

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
