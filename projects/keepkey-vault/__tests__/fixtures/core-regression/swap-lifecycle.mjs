// Synthetic real-component lifecycle regression; never connects to Vault/device.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { expect } = await import(process.env.PLAYWRIGHT_TEST_MODULE || '@playwright/test')
const base = `http://127.0.0.1:${process.env.CORE_QA_PORT || 5203}`
const out = process.env.CORE_QA_EVIDENCE || '.'
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = [], checks = {}, failures = []
page.on('pageerror', e => errors.push(e.message))
await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.request().resourceType() === 'image' ? r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#e9c46a"/></svg>' }) : r.abort())
await page.addInitScript(() => { window.__qaReceiptEvents = []; window.addEventListener('keepkey-swap-executed', e => window.__qaReceiptEvents.push(e.detail)) })
const rpc = async (method, params) => { const response = await (await page.request.post(base + '/__test_rpc', { data: { method, params } })).json(); if (!response.success) throw new Error(response.error); return response.payload }
const state = () => rpc('testSwapState')
const dialog = () => page.getByRole('dialog', { name: 'Swap', exact: true })
const close = () => page.getByRole('button', { name: 'Close swap', exact: true })
const command = cmd => page.evaluate(cmd => window.__qaSwapCommand(cmd), cmd)
const load = async ({ retained = false, scenario = 'normal' } = {}) => {
 await rpc('testReset', { scenario })
 await page.goto(base + `/?chain=ethereum&${retained ? 'retainSwap=1' : 'action=swap'}&scenario=${scenario}`)
 await expect(close()).toBeVisible()
 await expect.poll(async () => (await state())?.fromAsset).toBe('ETH.ETH')
}
const quote = async () => {
 await command({ kind: 'set', fromAsset: 'ETH.ETH', toAsset: 'BTC.BTC', amount: '.1', inputMode: 'crypto' })
 await expect.poll(async () => !!(await state())?.quote).toBe(true)
 await command({ kind: 'advance' })
 await expect.poll(async () => (await state())?.phase).toBe('review')
 await expect.poll(async () => !!(await state())?.previewBuild?.unsignedTx).toBe(true)
}
const openOtherReceiptDuringExecution = async () => {
 await load({ retained: true, scenario: 'execute-stall' }); await quote(); await command({ kind: 'confirm' })
 await expect.poll(async () => (await rpc('testState')).pendingExecution).toBe(true)
 await close().click(); await expect(dialog()).toHaveCount(0)
 await expect.poll(async () => (await state())?.phase).toBe('closed')
 await page.getByTestId('fixture-resume-receipt').click(); await expect(close()).toBeVisible()
 await expect.poll(async () => (await state())?.txid).toBe('c'.repeat(64))
}
const finishExecution = async params => {
 const reply = page.waitForResponse(response => response.url().endsWith('/__test_rpc') && response.request().postDataJSON()?.method === 'executeSwap')
 await rpc('testFinishExecution', params)
 await (await reply).finished()
 // Let the real RPC continuation, React render and mirror effect all commit.
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
const expectOtherReceipt = async () => {
 await expect.poll(async () => {
  const snapshot = await state()
  return { phase: snapshot?.phase, txid: snapshot?.txid, from: snapshot?.fromAsset, to: snapshot?.toAsset,
   amount: snapshot?.amount, expectedOutput: snapshot?.quote?.expectedOutput, error: snapshot?.error }
 }).toEqual({ phase: 'submitted', txid: 'c'.repeat(64), from: 'BTC.BTC', to: 'ETH.ETH', amount: '0.125', expectedOutput: '3', error: null })
}
const check = async (name, work) => {
 try { await work(); checks[name] = true; console.log('PASS ' + name) }
 catch (error) { checks[name] = false; failures.push({ name, error: error.message }); console.log('FAIL ' + name + ': ' + error.message.slice(0, 500)); await page.screenshot({ path: path.join(out, name + '-failure.png'), fullPage: true }).catch(() => {}) }
}
try {
 await check('retained-dialog-closes-and-reopens-state-mirror', async () => {
  await load({ retained: true }); await close().click(); await expect(dialog()).toHaveCount(0)
  await expect.poll(async () => (await state())?.phase).toBe('closed')
  await page.getByTestId('fixture-retained-swap').click(); await expect(close()).toBeVisible()
  await expect.poll(async () => (await state())?.phase).toBe('input')
  assert.equal((await rpc('testCalls')).some(c => c.method === 'cancelDeviceSigning'), false)
 })
 await check('closing-swap-does-not-steal-higher-overlay-focus', async () => {
  await load({ retained: true }); await expect(close()).toBeVisible()
  await page.evaluate(() => { const overlay = document.createElement('button'); overlay.id = 'qa-higher-overlay'; overlay.textContent = 'Synthetic device overlay'; document.body.appendChild(overlay); overlay.focus() })
  await command({ kind: 'close' }); await expect(dialog()).toHaveCount(0); await expect(page.locator('#qa-higher-overlay')).toBeFocused()
  await page.locator('#qa-higher-overlay').evaluate(el => el.remove())
 })
 await check('pending-execution-close-retains-backend-receipt-and-event', async () => {
  await load({ scenario: 'execute-stall' }); await quote(); await command({ kind: 'confirm' })
  await expect.poll(async () => (await rpc('testState')).pendingExecution).toBe(true)
  await expect.poll(async () => (await state())?.phase).toBe('signing')
  await close().click(); await expect(dialog()).toHaveCount(0)
  await expect.poll(async () => (await state())?.phase).toBe('closed')
  assert.equal((await rpc('testCalls')).some(c => c.method === 'cancelDeviceSigning'), false)
  await rpc('testFinishExecution')
  await expect.poll(async () => (await page.evaluate(() => window.__qaReceiptEvents)).length).toBe(1)
  const saved = await rpc('testState'); assert.equal(saved.pendingSwaps.length, 1); assert.equal(saved.pendingSwaps[0].txid, 'e'.repeat(64))
  assert.equal(saved.calls.filter(c => c.method === 'executeSwap').length, 1)
  assert.equal(saved.calls.filter(c => c.method === 'executeSwap')[0].fixtureOnly, true)
  assert.equal(saved.calls.some(c => /SignTx|broadcastTx|wipeDevice|loadDevice/.test(c.method)), false)
 })
 await check('retained-pending-execution-reopens-submitted-receipt', async () => {
  await load({ retained: true, scenario: 'execute-stall' }); await quote(); await command({ kind: 'confirm' })
  await expect.poll(async () => (await rpc('testState')).pendingExecution).toBe(true)
  await close().click(); await expect(dialog()).toHaveCount(0)
  await expect.poll(async () => (await state())?.phase).toBe('closed')
  await rpc('testFinishExecution')
  await expect.poll(async () => (await page.evaluate(() => window.__qaReceiptEvents)).length).toBe(1)
  assert.equal((await state()).phase, 'closed')
  await page.getByTestId('fixture-retained-swap').click(); await expect(close()).toBeVisible()
  await expect.poll(async () => (await state())?.phase).toBe('submitted')
  assert.equal((await state()).txid, 'e'.repeat(64))
  await page.keyboard.press('Escape'); await expect(dialog()).toHaveCount(0)
 })
 await check('old-execution-success-keeps-newly-resumed-receipt', async () => {
  await openOtherReceiptDuringExecution()
  await finishExecution()
  await expect.poll(async () => (await page.evaluate(() => window.__qaReceiptEvents)).length).toBe(1)
  await expectOtherReceipt()
  const events = await page.evaluate(() => window.__qaReceiptEvents)
  assert.equal(events[0].txid, 'e'.repeat(64)); assert.equal(events[0].fromChainId, 'ethereum'); assert.equal(events[0].toChainId, 'bitcoin')
  const saved = await rpc('testState'); assert.equal(saved.pendingSwaps[0].txid, 'e'.repeat(64))
  assert.equal(saved.calls.filter(c => c.method === 'executeSwap').length, 1)
 })
 for (const [kind, error] of [
  ['failure', 'Synthetic execution failed'],
  ['blind-signing-refusal', 'SOLANA_BLIND_SIGNING_REQUIRED {}'],
  ['device-policy-refusal', 'AdvancedMode is required'],
 ]) await check(`old-execution-${kind}-keeps-newly-resumed-receipt`, async () => {
  await openOtherReceiptDuringExecution()
  await finishExecution({ error })
  await expectOtherReceipt()
  assert.equal((await page.evaluate(() => window.__qaReceiptEvents)).length, 0)
  assert.equal((await rpc('testState')).pendingSwaps.length, 0)
 })
 await check('idempotent-input-edit-does-not-strand-quote-generation', async () => {
  await load({ retained: true })
  await command({ kind: 'set', fromAsset: 'ETH.ETH', toAsset: 'BTC.BTC', amount: '.1', inputMode: 'crypto' })
  await expect.poll(async () => (await state())?.phase).toBe('quoting')
  await command({ kind: 'set', amount: '.1' })
  await expect.poll(async () => !!(await state())?.quote).toBe(true)
  await expect.poll(async () => (await state())?.phase).toBe('input')
  assert.equal((await state()).amount, '.1')
 })
 if (errors.length) failures.push({ name: 'browser-runtime', error: errors.join('\n') })
 const result = { checks, failures, pageErrors: errors, allOptionalFeaturesOff: true, syntheticExecutionOnly: true, realSignatures: 0, realBroadcasts: 0 }
 fs.writeFileSync(path.join(out, 'swap-lifecycle-results.json'), JSON.stringify(result, null, 2) + '\n')
 console.log(JSON.stringify(result, null, 2))
 if (failures.length) process.exitCode = 1
} finally { await browser.close() }
