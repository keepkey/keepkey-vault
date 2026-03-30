/**
 * Test: sweep.startScan + sweep.getScanStatus
 *
 * Requires device connected — scans non-standard BTC paths for stuck funds.
 * This test starts a scan and polls until complete, then validates results.
 */
const { run } = require('../_helpers')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

run('Sweep — Scan non-standard BTC paths', async (getSdk, assert) => {
  const sdk = await getSdk()

  // ── Start scan (limited scope for faster test) ─────────────────
  const { scanId } = await sdk.sweep.startScan({
    accountRange: [0, 1],     // just accounts 0-1 (not 0-4)
    mismatchAccounts: 1,      // only check mismatches for account 0
  })
  assert('Got scanId', typeof scanId === 'string' && scanId.length > 0)

  // ── Poll until complete ────────────────────────────────────────
  let status
  let polls = 0
  const MAX_POLLS = 60  // 2 minutes max

  while (polls < MAX_POLLS) {
    status = await sdk.sweep.getScanStatus(scanId)
    assert(`Poll ${polls + 1}: status=${status.status}, progress=${status.progress.current}/${status.progress.total} (${status.progress.phase})`, true)

    if (status.status === 'complete' || status.status === 'error') break
    await sleep(2000)
    polls++
  }

  assert('Scan completed', status.status === 'complete')
  assert('Has results array', Array.isArray(status.results))
  assert(`Total found: ${status.totalFoundSats} sats`, status.totalFoundSats >= 0)

  console.log(`\n  Scan summary:`)
  console.log(`    Duration: ${((status.completedAt - status.startedAt) / 1000).toFixed(1)}s`)
  console.log(`    Addresses scanned: ${status.progress.total}`)
  console.log(`    Funded addresses: ${status.results.length}`)
  console.log(`    Total sats found: ${status.totalFoundSats}`)

  if (status.results.length > 0) {
    console.log(`\n  Funded addresses:`)
    for (const r of status.results) {
      console.log(`    ${r.address} (${r.path} as ${r.scriptType}) [${r.category}] = ${r.balanceSats} sats, ${r.utxoCount} UTXOs`)
    }
  }

  // ── Dry run sweep (if funds found) ─────────────────────────────
  if (status.totalFoundSats > 0) {
    console.log(`\n  Running dry-run sweep...`)
    const dryRun = await sdk.sweep.execute({
      scanId,
      dryRun: true,
    })
    assert('Dry run returned destination', typeof dryRun.destination === 'string')
    assert('Dry run returned fee', typeof dryRun.fee === 'number')
    assert('Dry run returned unsignedTx', dryRun.unsignedTx !== undefined)
    console.log(`    Destination: ${dryRun.destination}`)
    console.log(`    Inputs: ${dryRun.inputCount}`)
    console.log(`    Total: ${dryRun.totalSweptSats || dryRun.totalInputSats} sats`)
    console.log(`    Fee: ${dryRun.fee} sats`)
    console.log(`    Output: ${dryRun.outputSats} sats`)
  }
})
