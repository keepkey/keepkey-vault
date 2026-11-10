// Actual SwapDialog with delayed in-memory RPC replies. No app profile, device or network.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { expect } = await import(process.env.PLAYWRIGHT_TEST_MODULE || '@playwright/test')
const base = `http://127.0.0.1:${process.env.CORE_QA_PORT || 5201}`
const out = process.env.CORE_QA_EVIDENCE || '.'
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true })
const checks = {}, failures = [], errors = []
const ownerAddress = '0x000000000000000000000000000000000000dEaD'
const ethRow = (amount = '2', updatedAt = Date.now()) => ({ chainId: 'ethereum', symbol: 'ETH', balance: amount, balanceUsd: Number(amount) * 2500, nativeBalanceUsd: Number(amount) * 2500, priceUsd: 2500, address: ownerAddress, tokens: [], syncState: 'confirmed', updatedAt })
const owner = row => ({ addresses: [{ addressIndex: 0, address: ownerAddress, balanceUsd: row?.balanceUsd || 0, chainBalances: row ? { ethereum: row } : {} }], selectedIndex: 0, totalBalanceUsd: row?.balanceUsd || 0 })
const reply = payload => ({ success: true, payload })
let page, held, mode, calls, ownerAnswer, aggregateAnswer
const fulfill = (route, response) => route.fulfill({ json: response }).catch(() => {})
const open = async (scenario = 'delayed') => {
 if (page) await page.close()
 held = { owner: [], aggregate: [], cache: [] }; calls = []; mode = scenario
 ownerAnswer = scenario === 'cached' ? reply(owner(ethRow('3'))) : scenario === 'route' ? reply(owner(ethRow('2'))) : null
 aggregateAnswer = null
 page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
 page.on('pageerror', error => errors.push(error.stack || error.message))
 await page.addInitScript(() => {
  window.__balanceWarnings = []
  new MutationObserver(() => {
   const text = document.body?.innerText || ''
   if (/ETH balance was not returned|Could not reach this chain/.test(text)) window.__balanceWarnings.push(text)
  }).observe(document, { childList: true, subtree: true, characterData: true })
 })
 await page.route('**/*', async route => {
  const req = route.request(), url = req.url()
  if (!url.startsWith(base)) return req.resourceType() === 'image'
   ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#e9c46a"/></svg>' }) : route.abort()
  if (url.endsWith('/__test_rpc') && req.method() === 'POST') {
   const packet = req.postDataJSON(); calls.push(packet)
   if (packet.method === 'getSwapQuote' && mode === 'route') return fulfill(route, reply({ quoteId: 'synthetic-network-route', quoteCreatedAt: Date.now(), quoteExpiresAt: Date.now() + 60000, expectedOutput: String(Number(packet.params.amount) * .995), minimumOutput: String(Number(packet.params.amount) * .98505), minimumOutputSource: 'quote', fees: { affiliate: '0', outbound: '0', totalBps: 50 }, estimatedTime: 20, integration: 'relay' }))
   if (packet.method === 'getCachedBalances') {
    if (mode === 'cached') return new Promise(resolve => held.cache.push(response => resolve(fulfill(route, response))))
    const response = await route.fetch(), json = await response.json()
    if (mode !== 'manual-owner') json.payload.balances = json.payload.balances.filter(row => row.chainId !== 'ethereum')
    return route.fulfill({ response, json })
   }
   if (packet.method === 'getEvmAddresses') {
    if (ownerAnswer) return fulfill(route, ownerAnswer)
    return new Promise(resolve => held.owner.push(response => resolve(fulfill(route, response))))
   }
   if (packet.method === 'getBalances') {
    if (aggregateAnswer) return fulfill(route, aggregateAnswer)
    return new Promise(resolve => held.aggregate.push(response => resolve(fulfill(route, response))))
   }
  }
  return route.continue()
 })
 await page.goto(base + '/?chain=ethereum&retainSwap=1')
 await expect(page.getByRole('button', { name: 'Close swap', exact: true })).toBeVisible()
 await expect.poll(() => calls.filter(call => call.method === 'getSwapAssets').length).toBeGreaterThan(0)
 await expect(dialog().getByRole('button', { name: 'MAX', exact: true })).toBeVisible()
}
const dialog = () => page.getByRole('dialog', { name: 'Swap', exact: true })
const max = () => dialog().getByRole('button', { name: 'MAX', exact: true })
const spinner = () => dialog().getByLabel('Checking your KeepKey balances...', { exact: true })
const loadingText = () => dialog().getByText('Loading ETH balance… MAX is available once it arrives.', { exact: true })
const noWarning = async () => assert.deepEqual(await page.evaluate(() => window.__balanceWarnings), [], 'A completed-failure warning flashed before the balance read settled')
const release = (kind, response) => { for (const done of held[kind].splice(0)) done(response) }
const settleOwner = response => { ownerAnswer = response; release('owner', response) }
const settleAggregate = response => { aggregateAnswer = response; release('aggregate', response) }
const command = cmd => page.evaluate(cmd => window.__qaSwapCommand(cmd), cmd)
const settledOwner2 = () => { const snapshot = owner(ethRow('2')); snapshot.addresses[0].addressIndex = 2; snapshot.addresses[0].address = '0x2222222222222222222222222222222222222222'; snapshot.selectedIndex = 2; return reply(snapshot) }
const check = async (name, fn) => {
 try { await fn(); checks[name] = true; console.log('PASS ' + name) }
 catch (error) { checks[name] = false; failures.push({ name, error: error.message }); console.log('FAIL ' + name + ': ' + error.message.slice(0, 800)); await page?.screenshot({ path: path.join(out, name + '-failure.png'), fullPage: true }).catch(() => {}) }
}
try {
 await check('pending-owner-and-aggregate-stay-neutral-until-verified', async () => {
  await open()
  await expect(loadingText()).toBeVisible(); await expect(spinner()).toBeVisible(); await expect(max()).toBeDisabled()
  await noWarning()
  settleOwner(reply(owner()))
  await expect.poll(() => held.aggregate.length).toBeGreaterThan(0)
  await expect(loadingText()).toBeVisible(); await expect(max()).toBeDisabled(); await noWarning()
  // The aggregate includes ETH, but only the selected owner's snapshot can enable MAX.
  ownerAnswer = null
  settleAggregate(reply([ethRow('99')]))
  await expect.poll(() => held.owner.length).toBeGreaterThan(0)
  await expect(loadingText()).toBeVisible(); await expect(max()).toBeDisabled(); await noWarning()
  settleOwner(reply(owner(ethRow('2'))))
  await expect(dialog().getByText('2.0000 ETH', { exact: true })).toBeVisible()
  await expect(max()).toBeEnabled(); await expect(spinner()).toHaveCount(0); await noWarning()
  await page.screenshot({ path: path.join(out, 'balance-owner-loaded.png'), fullPage: true })
 })
 await check('known-owner-value-survives-pending-cache', async () => {
  await open('cached')
  await expect(dialog().getByText('3.0000 ETH', { exact: true })).toBeVisible()
  await expect(max()).toBeEnabled(); await expect(spinner()).toBeVisible(); await noWarning()
  release('cache', reply({ balances: [], updatedAt: Date.now(), staleReasons: [] }))
  await expect.poll(() => held.aggregate.length).toBeGreaterThan(0)
  await expect(dialog().getByText('3.0000 ETH', { exact: true })).toBeVisible(); await expect(max()).toBeEnabled()
  settleAggregate(reply([]))
  await expect(spinner()).toHaveCount(0); await expect(dialog().getByText('3.0000 ETH', { exact: true })).toBeVisible(); await noWarning()
 })
 await check('completed-missing-balance-warns-only-after-read', async () => {
  await open()
  settleOwner(reply(owner()))
  await expect.poll(() => held.aggregate.length).toBeGreaterThan(0)
  await expect(loadingText()).toBeVisible(); await noWarning()
  settleAggregate({ success: false, error: 'Synthetic balance server unavailable' })
  await expect(dialog().getByText(/^ETH balance was not returned by the last refresh/)).toBeVisible()
  await expect(max()).toBeDisabled(); await expect(spinner()).toHaveCount(0)
 })
 await check('local-device-contention-is-not-a-server-failure', async () => {
  await open()
  settleOwner(reply(owner()))
  await expect.poll(() => held.aggregate.length).toBeGreaterThan(0)
  settleAggregate({ success: false, error: 'KeepKey is busy with another request. Wait for it to finish, then try again.' })
  await expect(dialog().getByText('Balance unverified', { exact: true })).toBeVisible()
  await expect(max()).toBeDisabled(); await expect(spinner()).toHaveCount(0); await noWarning()
 })
 await check('closing-reopening-retires-old-balance-reply', async () => {
  await open()
  settleOwner(reply(owner()))
  await expect.poll(() => held.aggregate.length).toBeGreaterThan(0)
  const oldReads = held.aggregate.splice(0)
  await page.getByRole('button', { name: 'Close swap', exact: true }).click()
  await page.getByTestId('fixture-retained-swap').click()
  await expect.poll(() => held.aggregate.length).toBeGreaterThan(0)
  for (const finish of oldReads) finish(reply([ethRow('99')]))
  await expect(max()).toBeDisabled(); await expect(loadingText()).toBeVisible(); await noWarning()
  settleOwner(reply(owner(ethRow('4'))))
  settleAggregate(reply([ethRow('4')]))
  await expect(dialog().getByText('4.0000 ETH', { exact: true })).toBeVisible(); await expect(max()).toBeEnabled()
  await expect(dialog().getByText('99.0000 ETH', { exact: true })).toHaveCount(0)
 })
 await check('manual-source-quote-waits-for-selected-owner', async () => {
  await open('manual-owner')
  await command({ kind: 'set', fromAsset: 'ETH.ETH', toAsset: 'BTC.BTC', amount: '.1', inputMode: 'crypto' })
  await expect(dialog().getByText('Preparing your ETH send address…', { exact: true })).toBeVisible()
  await page.waitForTimeout(1000)
  assert(!calls.some(call => call.method === 'getSwapQuote'), 'Pending EVM owner must not quote a cached address with index zero')
  settleOwner(settledOwner2())
  await expect.poll(() => calls.filter(call => call.method === 'getSwapQuote').length).toBeGreaterThan(0)
  const quote = calls.find(call => call.method === 'getSwapQuote')
  assert.equal(quote.params.fromAddress, '0x2222222222222222222222222222222222222222')
  assert.equal(quote.params.fromEvmAddressIndex, 2)
 })
 await check('manual-destination-quote-waits-for-selected-owner', async () => {
  await open('manual-owner')
  await command({ kind: 'set', fromAsset: 'BTC.BTC', toAsset: 'ETH.ETH', amount: '.01', inputMode: 'crypto' })
  await expect(dialog().getByText('Preparing your ETH receive address…', { exact: true })).toBeVisible()
  await page.waitForTimeout(1000)
  assert(!calls.some(call => call.method === 'getSwapQuote'), 'Pending EVM destination owner must not use an aggregate cached address')
  settleOwner(settledOwner2())
  await expect.poll(() => calls.filter(call => call.method === 'getSwapQuote').length).toBeGreaterThan(0)
  const quote = calls.find(call => call.method === 'getSwapQuote')
  assert.equal(quote.params.toAddress, '0x2222222222222222222222222222222222222222')
 })
 await check('same-symbol-route-restores-animation-and-network-identities', async () => {
  await open('route')
  const destination = { asset: 'ETH.ETH', chainId: 'arbitrum', symbol: 'ETH', name: 'Ethereum on Arbitrum', chainFamily: 'evm', decimals: 18, caip: 'eip155:42161/slip44:60' }
  await command({ kind: 'set', fromAsset: 'ETH.ETH', toAsset: destination.caip, toAssetDefinition: destination, amount: '.1', inputMode: 'crypto' })
  await expect.poll(() => calls.filter(call => call.method === 'getSwapQuote').length).toBeGreaterThan(0)
  await expect(dialog().getByRole('button', { name: 'Review Swap', exact: true })).toBeVisible()
  await command({ kind: 'advance' })
  const summary = dialog().locator('[data-trade-summary]')
  await expect(summary).toHaveCount(1)
  await expect(summary.locator('[data-trade-route-map] svg')).toBeVisible()
  await expect(summary.locator('[data-trade-route-map] animateMotion')).toHaveCount(1)
  await expect(summary.locator('[data-trade-from-network]')).toHaveText('Ethereum')
  await expect(summary.locator('[data-trade-to-network]')).toHaveText('Arbitrum')
  await expect(summary.getByText('eip155:1', { exact: true })).toBeVisible()
  await expect(summary.getByText('eip155:42161', { exact: true })).toBeVisible()
  for (const label of ['You send', 'Expected receive', 'Minimum receive', 'Estimated swap cost']) await expect(dialog().getByText(label, { exact: true })).toHaveCount(1)
  await page.screenshot({ path: path.join(out, 'ethereum-to-arbitrum-route.png'), fullPage: true })
  await dialog().getByRole('button', { name: /^Fees & details/ }).click()
  await expect(dialog().locator('[data-trade-from-caip]')).toHaveText('eip155:1/slip44:60')
  await expect(dialog().locator('[data-trade-to-caip]')).toHaveText(destination.caip)
  const quote = calls.findLast(call => call.method === 'getSwapQuote')
  assert.equal(quote.params.toCaip, destination.caip)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(summary.locator('animateMotion')).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
 })
 await check('conflicting-network-identity-blocks-quoting', async () => {
  await open('route')
  const mismatch = { asset: 'ETH.ETH', chainId: 'ethereum', symbol: 'ETH', name: 'Incorrect identity fixture', chainFamily: 'evm', decimals: 18, caip: 'eip155:42161/slip44:60' }
  await command({ kind: 'set', fromAsset: 'ETH.ETH', toAsset: mismatch.caip, toAssetDefinition: mismatch, amount: '.1', inputMode: 'crypto' })
  await expect(dialog().getByText('The asset and network do not match. Select the asset again.', { exact: true })).toBeVisible()
  const before = calls.filter(call => call.method === 'getSwapQuote').length
  await page.waitForTimeout(1000)
  assert.equal(calls.filter(call => call.method === 'getSwapQuote').length, before)
 })
 assert.deepEqual(errors, [], 'Browser runtime errors')
 assert(!calls.some(call => /executeSwap|signTx|broadcastTx/.test(call.method)), 'This regression check must not sign or execute')
} catch (error) { failures.push({ name: 'runner', error: error.message }) }
finally {
 fs.writeFileSync(path.join(out, 'swap-balance-loading-results.json'), JSON.stringify({ checks, failures, browserErrors: errors, fixtureOnly: true, realTransactions: false }, null, 2) + '\n')
 console.log(JSON.stringify({ checks, failures, browserErrors: errors }, null, 2))
 await browser.close()
}
if (failures.length) process.exitCode = 1
