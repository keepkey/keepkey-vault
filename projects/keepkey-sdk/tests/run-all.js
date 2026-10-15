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
const SKIP = new Set(['_helpers.js', '_clearsign.js', '_review.js', 'run-all.js'])

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
      if (name === 'fixtures' || name === 'review') continue
      entries.push(...findTests(full, rel))
    } else if (name.endsWith('.js')) {
      entries.push({ path: full, name: rel })
    }
  }
  return entries
}

// KEEPKEY_SUITE_CLASS=real-world,must-warn runs only suites of those classes
// (tests/review/suites.json): the ones that must show something to the user.
const classes = (process.env.KEEPKEY_SUITE_CLASS || '').split(',').filter(Boolean)
const suiteClass = (name) => (require('./review/suites.json')[name] || {}).class
const found = findTests(testsDir).filter(t => !filter || t.name.includes(filter))
  .filter(t => classes.length === 0 || classes.includes(suiteClass(t.name)))
const wipes = found.filter(t => t.name.startsWith(DESTRUCTIVE))
const tests = found.filter(t => !t.name.startsWith(DESTRUCTIVE)).concat(allowWipe ? wipes : [])
if (wipes.length && !allowWipe) {
  console.log(`\n  Skipping ${wipes.length} suite(s) that WIPE the device (${DESTRUCTIVE}*). Set KEEPKEY_ALLOW_WIPE=1 on a test device to run them.`)
}
if (tests.length === 0) {
  console.error('\n  No suites ran.\n')
  process.exit(1)
}

console.log(`\n  Running ${tests.length} test suite(s)${filter ? ` (filter: "${filter}")` : ''}:\n`)

let passed = 0, failed = 0

// What each suite made Desktop and the device show (see _review.js). Without
// the emulator's test tape, suites still run but nothing shown is checked.
const { takeTape, judge } = require('./_review')
const shown = []

async function main() {
  let taping = true
  try { await takeTape(false) } catch (e) {
    taping = false
    console.log(`  NOT REVIEWED: ${e.message}\n`)
  }
  for (const test of tests) {
    console.log(`  ── ${test.name} ──`)
    if (taping) await takeTape(true)
    let ok = true
    try {
      execSync(`node "${test.path}"`, { stdio: 'inherit', timeout: 180000 })
      passed++
    } catch (e) {
      ok = false
      failed++
      console.error(`  FAILED: ${test.name}\n`)
    }
    if (taping) {
      const tape = await takeTape(false)
      const { verdict, problems } = judge(test.name, tape, ok)
      shown.push({ suite: test.name, ok, verdict, problems, cards: tape.filter((e) => e.card).length, screens: tape.filter((e) => e.screen).length })
      for (const p of problems) console.error(`  SHOWN: ${p}`)
    }
  }

  console.log(`\n  ════════════════════════════════════════`)
  console.log(`  Total: ${passed + failed} suites, ${passed} passed, ${failed} failed`)
  if (taping) {
    console.log(`\n  What was shown (cards = Desktop approval cards, screens = device confirmations):`)
    for (const r of shown) console.log(`  ${r.verdict.padEnd(12)} ${r.ok ? 'pass' : 'FAIL'}  cards ${String(r.cards).padStart(2)}  screens ${String(r.screens).padStart(3)}  ${r.suite}`)
  }
  console.log(`  ════════════════════════════════════════\n`)

  const badlyShown = shown.some((r) => r.verdict === 'UNHEALTHY' || r.verdict === 'UNCLASSIFIED')
  process.exit(failed > 0 || badlyShown ? 1 : 0)
}

main()
