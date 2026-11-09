// Real wallet components with in-memory RPC replies. No real wallet/device is used.
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
const errors = [], checks = {}, failures = []
page.on('pageerror', e => errors.push(e.message))
await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.request().resourceType() === 'image' ? r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#e9c46a"/></svg>' }) : r.abort())
await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } }) })
const rpc = async (method, params) => (await (await page.request.post(base + '/__test_rpc', { data: { method, params } })).json()).payload
const load = async (query = '', scenario = 'normal') => { await rpc('testReset', { scenario }); await page.goto(base + query); await expect(page.getByTestId('fixture-ethereum')).toBeVisible() }
const dialog = () => page.getByRole('dialog', { name: 'Swap', exact: true })
const close = () => page.getByRole('button', { name: 'Close swap', exact: true })
const check = async (name, run) => {
 try { await run(); checks[name] = true; console.log('PASS ' + name) }
 catch (e) { checks[name] = false; failures.push({ name, error: e.message }); console.log('FAIL ' + name + ': ' + e.message.slice(0, 450)); await page.screenshot({ path: path.join(out, name + '-failure.png'), fullPage: true }).catch(() => {}) }
}
try {
 await check('swap-visible-close-and-focus-return', async () => {
  await load('?chain=zcash'); const opener = page.getByRole('button', { name: 'Swap', exact: true }); await opener.click()
  await expect(close()).toBeVisible(); const box = await close().boundingBox(); assert(box.width >= 35 && box.height >= 35)
  assert.equal(await close().locator('svg').count(), 1)
  await close().click(); await expect(dialog()).toHaveCount(0); await expect(opener).toBeFocused()
  await opener.click(); await expect(close()).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog()).toHaveCount(0)
 })
 if (process.env.CORE_QA_CLOSE_ONLY === '1') {
  if (failures.length) throw new Error('Close regression reproduced')
 } else {
  for (const scenario of ['assets-stall', 'assets-error', 'quote-stall', 'quote-error']) await check('swap-exit-' + scenario, async () => {
   await load('?chain=ethereum&action=swap&scenario=' + scenario, scenario)
   await expect(close()).toBeVisible(); await close().click(); await expect(dialog()).toHaveCount(0)
  })
  await check('swap-backdrop-dismissal', async () => {
   await load('?chain=ethereum&action=swap'); await expect(close()).toBeVisible(); await page.getByTestId('swap-backdrop').click({ position: { x: 5, y: 90 } }); await expect(dialog()).toHaveCount(0)
  })
  await check('swap-review-exit-without-signing', async () => {
   await load('?chain=ethereum&action=swap'); await expect(page.getByRole('button', { name: 'Review Swap', exact: true })).toBeEnabled({ timeout: 15000 }); await page.getByRole('button', { name: 'Review Swap', exact: true }).click()
   await expect.poll(async () => (await rpc('testSwapState'))?.phase).toBe('review')
   await close().click(); await expect(dialog()).toHaveCount(0)
   assert(!(await rpc('testCalls')).some(c => /executeSwap|signTx|broadcastTx|cancelDeviceSigning/.test(c.method)))
  })
  await check('swap-close-visible-after-scroll-narrow', async () => {
   await page.setViewportSize({ width: 390, height: 640 }); await load('?chain=zcash&action=swap'); await expect(close()).toBeVisible()
   await dialog().evaluate(el => { el.scrollTop = el.scrollHeight }); await page.waitForTimeout(100)
   const b = await close().boundingBox(); assert(b.x >= 0 && b.x + b.width <= 390 && b.y >= 0 && b.y + b.height <= 640, JSON.stringify(b))
   assert(await close().evaluate(el => { const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) }))
   await page.screenshot({ path: path.join(out, 'swap-narrow-close.png'), fullPage: true }); await close().click(); await expect(dialog()).toHaveCount(0)
   await page.setViewportSize({ width: 1280, height: 900 })
  })
  await check('swap-keyboard-focus-contained', async () => {
   await load('?chain=ethereum&action=swap'); await expect(close()).toBeVisible(); await dialog().focus(); await page.keyboard.press('Shift+Tab')
   assert(await dialog().evaluate(el => el.contains(document.activeElement)))
   await page.keyboard.press('Tab'); assert(await dialog().evaluate(el => el.contains(document.activeElement)))
   await page.keyboard.press('Escape'); await expect(dialog()).toHaveCount(0)
  })
  await check('swap-nested-picker-escape-keeps-swap-open', async () => {
   await load('?chain=ethereum&action=swap'); await expect(close()).toBeVisible(); await page.getByRole('button', { name: 'Change', exact: true }).first().click()
   await expect(page.getByText('Select asset to swap from', { exact: true })).toBeVisible(); await page.keyboard.press('Escape')
   await expect(page.getByText('Select asset to swap from', { exact: true })).toHaveCount(0); await expect(close()).toBeVisible(); await close().click()
  })
  await check('swap-route-details-escape-keeps-swap-open', async () => {
   await load('?chain=ethereum&action=swap'); await expect(page.getByRole('button', { name: /THORChain/ })).toBeVisible(); await page.getByRole('button', { name: /THORChain/ }).click()
   await expect(page.getByText('Route details', { exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByText('Route details', { exact: true })).toHaveCount(0); await expect(close()).toBeVisible(); await close().click()
  })
  for (const chain of ['ethereum', 'bitcoin', 'zcash']) await check('receive-' + chain, async () => {
   await load('?chain=' + chain + '&action=receive'); await expect(page.getByRole('button', { name: /copy/i }).first()).toBeVisible()
   const address = chain === 'ethereum' ? '0x000000000000000000000000000000000000dEaD' : chain === 'bitcoin' ? 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' : 't1'+'A'.repeat(33); await expect.poll(async () => (await page.locator('body').innerText()).includes(address)).toBe(true)
   assert(!(await rpc('testCalls')).some(c => /monero|passwordBank|zcashShielded|multisig|emulator/i.test(c.method)))
  })
  await check('portfolio-assets-and-balances', async () => {
   await load('?page=dashboard'); await expect(page.getByRole('button', { name: /BTC Bitcoin/ })).toBeVisible({ timeout: 15000 })
   const text = await page.locator('body').innerText(); assert(!text.includes('Monero')); assert(!text.includes('Password manager'))
   await page.screenshot({ path: path.join(out, 'core-portfolio.png'), fullPage: true })
  })
  await check('send-invalid-recipient-stays-before-signing', async () => {
   await load('?chain=ethereum&action=send'); const input = page.getByPlaceholder(/address/i).first(); await expect(input).toBeVisible(); await input.fill('invalid-recipient')
   await page.getByPlaceholder('0.00').first().fill('0.01').catch(() => {})
   assert(!(await rpc('testCalls')).some(c => /signTx|broadcastTx|executeSwap/.test(c.method)))
   await page.getByRole('button', { name: 'Receive', exact: true }).first().click(); await expect(page.getByRole('button', { name: /copy/i }).first()).toBeVisible()
  })
  await check('history-open-close', async () => {
   await load('?chain=ethereum'); await page.getByTestId('fixture-history').click(); await expect(page.getByText('Swap history', { exact: true }).last()).toBeVisible(); await page.getByRole('button', { name: '×', exact: true }).click(); await expect(page.getByRole('button', { name: '×', exact: true })).toHaveCount(0)
  })
  await check('settings-main-sections-without-mutations', async () => {
   await load('?chain=ethereum'); await page.getByRole('button', { name: 'Device settings', exact: true }).click()
   const d = page.getByRole('dialog', { name: 'Settings', exact: true }), nav = d.getByRole('navigation', { name: 'Settings sections' })
   for (const name of ['General', 'Device', 'Security', 'Networks', 'Connections', 'Advanced']) { await nav.getByRole('button', { name, exact: true }).click(); await expect(d.getByRole('heading', { name, exact: true, level: 2 })).toBeVisible() }
   const mutations = (await rpc('testCalls')).filter(c => /^(set|apply|wipe|reset|loadDevice)/.test(c.method)); assert.equal(mutations.length, 0, JSON.stringify(mutations))
   await page.getByRole('button', { name: 'Close settings', exact: true }).click(); await expect(d).toHaveCount(0)
  })
  await check('disconnect-reconnect-navigation', async () => {
   await load('?chain=ethereum'); await page.getByTestId('fixture-disconnect').click(); await expect(page.getByTestId('fixture-disconnected')).toBeVisible(); await page.getByTestId('fixture-reconnect').click(); await expect(page.getByRole('button', { name: 'Receive', exact: true })).toBeVisible()
  })
  await check('optional-features-remain-off', async () => {
   const { settings } = await rpc('testState')
   for (const key of ['moneroEnabled','passwordManagerEnabled','zcashPrivacyEnabled','btcMultisigEnabled','walletConnectEnabled','emulatorEnabled','hiveEnabled','alphaFirmware','preReleaseUpdates']) assert.equal(settings[key], false, key)
   assert.equal(await page.getByRole('button', { name: 'Passwords and seed vault', exact: true }).count(), 0)
  })
 }
 assert.deepEqual(errors, [], 'Browser runtime errors')
} catch (e) { failures.push({ name: 'runner', error: e.message }) }
finally {
 const result = { checks, failures, browserErrors: errors, optionalFeaturesEnabled: false, realTransactions: false, testSource: 'real React components with synthetic native RPC' }
 fs.writeFileSync(path.join(out, 'core-ui-results.json'), JSON.stringify(result, null, 2)+'\n'); console.log(JSON.stringify(result, null, 2)); await browser.close()
}
if (failures.length) process.exitCode = 1
