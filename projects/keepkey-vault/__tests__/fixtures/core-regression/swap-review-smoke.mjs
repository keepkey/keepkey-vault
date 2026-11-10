// Real SwapDialog review QA. Start server.ts with CORE_QA_PORT, then run this script.
// Uses only the in-memory fixture and synthetic quote replies; no real wallet or device.
// PLAYWRIGHT_MODULE, PLAYWRIGHT_TEST_MODULE, CHROME_EXECUTABLE and CORE_QA_EVIDENCE
// follow the same environment overrides as smoke.mjs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { expect } = await import(process.env.PLAYWRIGHT_TEST_MODULE || '@playwright/test')
const base = `http://127.0.0.1:${process.env.CORE_QA_PORT || 5201}`
const out = process.env.CORE_QA_EVIDENCE || '.'
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = [], checks = {}, failures = [], quoteReplies = []
let scenario = 'normal'
page.on('pageerror', e => errors.push(e.message))
const riskFor = (inputUsd, expectedUsd, minimumUsd, tier = inputUsd >= 1000 ? 'large' : 'small') => {
 const expectedLossUsd = Math.max(0, inputUsd - expectedUsd), minimumLossUsd = Math.max(0, inputUsd - minimumUsd)
 const expectedLossPct = expectedLossUsd / inputUsd * 100, minimumLossPct = minimumLossUsd / inputUsd * 100
 const blocked = tier === 'large' && expectedLossPct >= 5 - 1e-9
 return { tier, inputUsd, expectedUsd, minimumUsd, expectedLossUsd, minimumLossUsd, expectedLossPct, minimumLossPct,
  allowancePct: (1 - minimumUsd / expectedUsd) * 100, blocked,
  warning: expectedLossPct >= (tier === 'small' ? 10 : .5) - 1e-9,
  requiresAcknowledgment: !blocked && (tier === 'unknown' || tier === 'large' && (expectedLossPct >= 1 - 1e-9 || minimumLossPct >= 2 - 1e-9)),
  quoteMaxAgeMs: tier === 'small' ? 60000 : 30000 }
}
await page.route('**/*', async route => {
 const request = route.request(), url = request.url()
 if (!url.startsWith(base)) return request.resourceType() === 'image'
  ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#e9c46a"/></svg>' })
  : route.abort()
 if (url.endsWith('/__test_rpc') && request.method() === 'POST') {
  const packet = request.postDataJSON()
  if (scenario === 'no-fiat-native' && ['getSwapAssets', 'getSwappableChainIds', 'getAppSettings'].includes(packet.method)) {
   const response = await route.fetch(), reply = await response.json()
   if (reply.success) {
    if (packet.method === 'getSwapAssets') reply.payload.push({ asset: 'BASE.ETH', chainId: 'base', symbol: 'ETH', name: 'Ethereum on Base', chainFamily: 'evm', decimals: 18, caip: 'eip155:8453/slip44:60' })
    if (packet.method === 'getSwappableChainIds') reply.payload.push('base')
    if (packet.method === 'getAppSettings') reply.payload.disabledNetworks = reply.payload.disabledNetworks.filter(id => id !== 'base')
   }
   return route.fulfill({ response, json: reply })
  }
  if (packet.method === 'getSwapQuote') {
   const response = await route.fetch(), reply = await response.json(), q = reply.payload
   if (reply.success) {
    q.quotedSlippageBps = scenario === 'reported-slippage' ? 35 : undefined
    q.fees.reportedTotalBps = 35
    q.fees.items = [
     { kind: 'affiliate', label: 'KeepKey app fee', amount: '0.00015', symbol: 'ETH', bps: 15, recipient: '0x1111111111111111111111111111111111111111' },
     { kind: 'provider', label: 'Provider fee', amount: '0.0002', symbol: 'ETH', bps: 20, recipient: '0x2222222222222222222222222222222222222222' },
     { kind: 'network', label: 'Destination withdrawal fee', amount: '0.00001', symbol: 'BTC' },
    ]
    let inputUsd = Number(packet.params.amount) * 2500, expectedUsd = inputUsd * .995
    if (scenario === 'snapshot') { inputUsd = 251.37; expectedUsd = 248.74875 }
    if (scenario === 'ack') expectedUsd = inputUsd * .99
    if (scenario === 'blocked') expectedUsd = inputUsd * .95
    if (scenario === 'small-warning') expectedUsd = inputUsd * .85
    const minimumUsd = expectedUsd * .99
    q.expectedOutput = String(expectedUsd / 65000); q.minimumOutput = String(minimumUsd / 65000)
    q.minimumOutputSource = scenario === 'estimated' ? 'estimate' : 'quote'
    q.risk = scenario === 'unknown'
     ? { tier: 'unknown', blocked: false, warning: false, requiresAcknowledgment: true, quoteMaxAgeMs: 30000, allowancePct: 1 }
     : riskFor(inputUsd, expectedUsd, minimumUsd)
    if (scenario === 'no-fiat-native') {
     // Same native asset units permit percentage assessment without any fiat price.
     q.expectedOutput = String(Number(packet.params.amount) * .85)
     q.minimumOutput = String(Number(q.expectedOutput) * .99)
     q.risk = { tier: 'unknown', blocked: false, warning: true, requiresAcknowledgment: true, expectedLossPct: 15, minimumLossPct: 15.85, allowancePct: 1, quoteMaxAgeMs: 30000 }
    }
    quoteReplies.push({ scenario, amount: packet.params.amount, risk: q.risk })
   }
   return route.fulfill({ response, json: reply })
  }
 }
 return route.continue()
})
const rpc = async (method, params) => {
 const response = await (await page.request.post(base + '/__test_rpc', { data: { method, params } })).json()
 if (!response.success) throw new Error(response.error)
 return response.payload
}
const state = () => rpc('testSwapState')
const dialog = () => page.getByRole('dialog', { name: 'Swap', exact: true })
const close = () => page.getByRole('button', { name: 'Close swap', exact: true })
const command = cmd => page.evaluate(cmd => window.__qaSwapCommand(cmd), cmd)
const load = async (mode = 'normal', amount = '.1') => {
 scenario = mode
 await rpc('testReset', { scenario: 'normal' })
 await page.goto(base + '/?chain=ethereum&retainSwap=1')
 await expect(close()).toBeVisible()
 await expect.poll(async () => (await state())?.fromAsset).toBe('ETH.ETH')
 await command({ kind: 'set', fromAsset: 'ETH.ETH', toAsset: mode === 'no-fiat-native' ? 'BASE.ETH' : 'BTC.BTC', amount, inputMode: 'crypto' })
 await expect.poll(async () => !!(await state())?.quote).toBe(true)
 await command({ kind: 'advance' })
 await expect.poll(async () => (await state())?.phase).toBe('review')
 await expect.poll(async () => !!(await state())?.previewBuild?.unsignedTx).toBe(true)
 await expect(dialog().getByText('Expected receive', { exact: true })).toBeVisible()
}
const label = text => dialog().getByText(text, { exact: true })
const moneyByLabel = async text => label(text).evaluate(el => {
 let box = el.parentElement
 for (let i = 0; box && i < 4; i++, box = box.parentElement) {
  const values = box.innerText.match(/\$[\d,]+\.\d{2}/g)
  if (values?.length) return values.map(s => Number(s.replace(/[$,]/g, '')))
 }
 return []
})
const check = async (name, run) => {
 try { await run(); checks[name] = true; console.log('PASS ' + name) }
 catch (e) { checks[name] = false; failures.push({ name, error: e.message }); console.log('FAIL ' + name + ': ' + e.message.slice(0, 700)); await page.screenshot({ path: path.join(out, name + '-failure.png'), fullPage: true }).catch(() => {}) }
}
try {
 await check('normal-summary-single-values-and-device-notice', async () => {
  await load()
  for (const text of ['You send','Expected receive','Minimum receive','Estimated swap cost','Source network fee','Estimated time','Review and approve on KeepKey']) await expect(label(text)).toHaveCount(1)
  for (const text of ['Expected after fees','Provider minimum','What this trade can cost','Trade value','Under $1,000','Show details','Address will be verified on your KeepKey device','Address will be verified on your KeepKey device.']) await expect(label(text)).toHaveCount(0)
  await expect(dialog().getByRole('checkbox')).toHaveCount(0)
  await expect(dialog().locator('[data-trade-summary]').getByText('THORChain', { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(out, 'normal-desktop.png'), fullPage: true })
 })
 await check('fees-and-details-collapsed-until-requested', async () => {
  await expect(label('KeepKey app fee')).toHaveCount(0)
  await dialog().getByRole('button', { name: /^Fees & details/ }).click()
  await expect(dialog().getByText('KeepKey app fee', { exact: false })).toBeVisible()
  await expect(label('Slippage tolerance')).toBeVisible()
  await expect(label('Quote slippage')).toHaveCount(0)
  await expect(label('What this trade can cost')).toHaveCount(0)
  await page.screenshot({ path: path.join(out, 'details-desktop.png'), fullPage: true })
 })
 await check('summary-uses-one-backend-pricing-snapshot', async () => {
  await load('snapshot')
  const sent = await moneyByLabel('You send'), expected = await moneyByLabel('Expected receive'), minimum = await moneyByLabel('Minimum receive'), cost = await moneyByLabel('Estimated swap cost')
  assert(sent.includes(251.37), JSON.stringify({ sent }))
  assert(expected.includes(248.75), JSON.stringify({ expected }))
  assert(minimum.includes(246.26), JSON.stringify({ minimum }))
  assert(cost.includes(2.62), JSON.stringify({ cost }))
  assert(Math.abs((251.37 - 248.75) - 2.62) < .011)
 })
 await check('estimated-minimum-is-qualified', async () => {
  await load('estimated')
  await expect(label('Estimated minimum')).toBeVisible()
  await expect(label('Minimum receive')).toHaveCount(0)
 })
 await check('reported-slippage-only-shown-in-details', async () => {
  await load('reported-slippage')
  await expect(label('Quote slippage')).toHaveCount(0)
  await dialog().getByRole('button', { name: /^Fees & details/ }).click()
  await expect(label('Quote slippage')).toBeVisible()
  assert((await label('Quote slippage').locator('..').innerText()).includes('0.35%'))
 })
 await check('large-trade-acknowledgment-visible-and-required', async () => {
  await load('ack', '1')
  const ack = dialog().getByRole('checkbox')
  await expect(ack).toBeVisible()
  await expect(dialog().getByRole('button', { name: 'Review and acknowledge trade cost', exact: true })).toBeDisabled()
  await ack.check()
  await expect(dialog().getByRole('button', { name: 'Confirm Swap', exact: true })).toBeEnabled()
  assert(!(await rpc('testCalls')).some(c => /executeSwap|signTx|broadcastTx/.test(c.method)))
  await page.screenshot({ path: path.join(out, 'large-trade-ack.png'), fullPage: true })
 })
 await check('excessive-cost-route-stays-blocked', async () => {
  await load('blocked', '1')
  await expect(dialog().getByRole('button', { name: 'Route exceeds cost limit', exact: true })).toBeDisabled()
  await expect(dialog().getByText('This route exceeds the 5% cost limit. Change the amount or route and request a new quote.', { exact: true })).toBeVisible()
  await expect(dialog().getByRole('checkbox')).toHaveCount(0)
 })
 await check('unknown-value-acknowledgment-remains-visible', async () => {
  await load('unknown')
  const ack = dialog().getByRole('checkbox')
  await expect(ack).toBeVisible()
  await expect(dialog().getByRole('button', { name: 'Review and acknowledge trade cost', exact: true })).toBeDisabled()
  await ack.check()
  await expect(dialog().getByRole('button', { name: 'Confirm Swap', exact: true })).toBeEnabled()
 })
 await check('native-same-asset-warning-without-fiat-keeps-known-percentage', async () => {
  await load('no-fiat-native')
  await expect(dialog().locator('[data-trade-input-fiat]')).toHaveCount(0)
  await expect(dialog().locator('[data-trade-output-fiat]')).toHaveCount(0)
  await expect(dialog().locator('[data-trade-cost]')).toHaveText('15.00%')
  await expect(dialog().getByText('High swap cost: 15.00%, excluding the source network fee.', { exact: true })).toBeVisible()
  await expect(dialog().getByRole('checkbox')).toBeVisible()
  const text = await dialog().innerText()
  assert(!text.includes('$0.00') && !text.includes('undefined'), text)
  await page.screenshot({ path: path.join(out, 'native-without-fiat.png'), fullPage: true })
 })
 await check('small-trade-cost-warning-is-visible-with-details-closed', async () => {
  await load('small-warning')
  await expect(label('KeepKey app fee')).toHaveCount(0)
  const text = await dialog().innerText()
  assert(/cost|fee/i.test(text) && /15/.test(text), text)
  await page.screenshot({ path: path.join(out, 'small-trade-warning.png'), fullPage: true })
 })
 await check('mobile-summary-fits-and-close-remains-reachable', async () => {
  await page.setViewportSize({ width: 390, height: 740 }); await load()
  const dimensions = await dialog().evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth, x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width }))
  assert(dimensions.scroll <= dimensions.client + 1, JSON.stringify(dimensions))
  assert(dimensions.x >= 0 && dimensions.x + dimensions.width <= 391, JSON.stringify(dimensions))
  await expect(close()).toBeVisible()
  await dialog().evaluate(el => { el.scrollTop = el.scrollHeight })
  const rect = await close().boundingBox(); assert(rect.x >= 0 && rect.x + rect.width <= 390 && rect.y >= 0 && rect.y + rect.height <= 740)
  await page.screenshot({ path: path.join(out, 'normal-mobile.png'), fullPage: true })
  await close().click(); await expect(dialog()).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 900 })
 })
 await check('back-and-close-without-signing', async () => {
  await load(); await dialog().getByRole('button', { name: 'Back', exact: true }).click()
  await expect.poll(async () => (await state())?.phase).toBe('input')
  await close().click(); await expect(dialog()).toHaveCount(0)
  assert(!(await rpc('testCalls')).some(c => /executeSwap|signTx|broadcastTx|cancelDeviceSigning/.test(c.method)))
 })
 assert.deepEqual(errors, [], 'Browser runtime errors')
} catch (e) { failures.push({ name: 'runner', error: e.message }) }
finally {
 const result = { checks, failures, browserErrors: errors, quoteReplies, realTransactions: false, fixtureOnly: true }
 fs.writeFileSync(path.join(out, 'swap-review-results.json'), JSON.stringify(result, null, 2) + '\n')
 console.log(JSON.stringify(result, null, 2)); await browser.close()
}
if (failures.length) process.exitCode = 1
