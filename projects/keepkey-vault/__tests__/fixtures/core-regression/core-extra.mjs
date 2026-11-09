// Additional real-component main-flow regressions, synthetic local backend only.
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
page.setDefaultTimeout(10000)
const errors = [], checks = {}, failures = []
page.on('pageerror', e => errors.push(e.message))
await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.request().resourceType() === 'image' ? r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#e9c46a"/></svg>' }) : r.abort())
const rpc = async (method, params) => { const response = await (await page.request.post(base + '/__test_rpc', { data: { method, params } })).json(); if (!response.success) throw new Error(response.error); return response.payload }
const load = async query => { await rpc('testReset', {}); await page.goto(base + '/?' + query); await expect(page.getByTestId('fixture-ethereum')).toBeVisible() }
const noSigning = async () => assert.equal((await rpc('testCalls')).some(c => /(?:SignTx|broadcast|executeSwap|wipeDevice|loadDevice)/i.test(c.method)), false)
const check = async (name, work) => {
 try { await work(); checks[name] = true; console.log('PASS ' + name) }
 catch (error) { checks[name] = false; failures.push({ name, error: error.message }); console.log('FAIL ' + name + ': ' + error.message.slice(0, 450)); await page.screenshot({ path: path.join(out, name + '-failure.png'), fullPage: true }).catch(() => {}) }
}
try {
 await check('pin-grid-backspace-submit-uses-only-synthetic-positions', async () => {
  await load('screen=pin&chain=ethereum')
  const unlock = page.getByRole('button', { name: 'Unlock', exact: true }), backspace = page.getByRole('button', { name: 'Backspace', exact: true })
  await expect(unlock).toBeDisabled(); await expect(backspace).toBeDisabled()
  const pad = page.getByRole('button', { name: '•', exact: true }); await expect(pad).toHaveCount(9)
  await pad.nth(0).click(); await pad.nth(4).click(); await pad.nth(8).click()
  await expect(unlock).toBeEnabled(); await backspace.click(); await backspace.click(); await backspace.click()
  await expect(unlock).toBeDisabled(); await expect(backspace).toBeDisabled()
  await page.keyboard.type('123'); await unlock.click()
  await expect(page.getByTestId('fixture-pin-result')).toHaveText('Synthetic PIN accepted')
  await expect(page.getByTestId('fixture-pin-result')).toHaveAttribute('data-pin-length', '3')
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toHaveCount(0)
  await noSigning()
 })
 await check('pin-cancel-returns-to-disconnected-without-mutation', async () => {
  await load('screen=pin&chain=ethereum'); await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId('fixture-disconnected')).toBeVisible()
  await expect(page.getByTestId('fixture-pin-result')).toHaveText('PIN cancelled')
  await noSigning()
 })
 await check('eth-invalid-recipient-blocks-build', async () => {
  await load('chain=ethereum&action=send')
  await page.getByPlaceholder('Address', { exact: true }).fill('invalid-recipient')
  await page.getByPlaceholder('0.00', { exact: true }).fill('0.1')
  await expect(page.getByRole('button', { name: 'Build Transaction', exact: true })).toBeDisabled()
  assert.equal((await rpc('testCalls')).some(c => c.method === 'buildTx'), false)
  await noSigning()
 })
 await check('eth-build-review-back-stops-before-signing', async () => {
  await load('chain=ethereum&action=send')
  await page.getByPlaceholder('Address', { exact: true }).fill('0x0000000000000000000000000000000000000001')
  await page.getByPlaceholder('0.00', { exact: true }).fill('0.1')
  // The existing unsaved-recipient check deliberately asks before building.
  const notNow = page.getByRole('button', { name: 'Not now', exact: true }); await expect(notNow).toBeVisible(); await notNow.click()
  const build = page.getByRole('button', { name: 'Build Transaction', exact: true }); await expect(build).toBeEnabled(); await build.click()
  await expect(page.getByText('Transaction Ready', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign on Device', exact: true })).toBeVisible()
  const built = (await rpc('testCalls')).filter(c => c.method === 'buildTx'); assert.equal(built.length, 1); assert.equal(built[0].params.amount, '0.1'); assert.equal(built[0].params.chainId, 'ethereum')
  await page.getByRole('button', { name: 'Back', exact: true }).last().click()
  await expect(build).toBeVisible(); await expect(page.getByPlaceholder('Address', { exact: true })).toHaveValue('0x0000000000000000000000000000000000000001')
  await noSigning()
 })
 await check('main-settings-narrow-layout-default-features-remain-off', async () => {
  await page.setViewportSize({ width: 390, height: 844 }); await load('chain=ethereum')
  await page.getByRole('button', { name: /Device Settings/i }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true }), nav = settings.getByRole('navigation', { name: 'Settings sections' })
  for (const category of ['General', 'Device', 'Security', 'Networks', 'Connections']) {
   await nav.getByRole('button', { name: category, exact: true }).click()
   await expect(settings.getByRole('heading', { level: 2, name: category, exact: true })).toBeVisible()
   assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), category + ' fits')
  }
  await page.getByRole('button', { name: 'Close settings', exact: true }).click(); await expect(settings).toHaveCount(0)
  const { settings: flags } = await rpc('testState')
  for (const flag of ['passwordManagerEnabled', 'moneroEnabled', 'zcashPrivacyEnabled', 'btcMultisigEnabled', 'walletConnectEnabled', 'emulatorEnabled']) assert.equal(flags[flag], false)
  assert.equal((await rpc('testCalls')).some(c => /^(set|apply|wipe|change|reset|moneroNode)/.test(c.method)), false)
  await noSigning()
 })
 const result = { checks, failures, pageErrors: errors, allOptionalFeaturesOff: true, pinBoundary: 'Real PinEntry UI; synthetic callback only, no hardware PIN verification', realSignatures: 0, realBroadcasts: 0 }
 fs.writeFileSync(path.join(out, 'core-extra-results.json'), JSON.stringify(result, null, 2) + '\n')
 console.log(JSON.stringify(result, null, 2))
 if (failures.length || errors.length) process.exitCode = 1
} finally { await browser.close() }
