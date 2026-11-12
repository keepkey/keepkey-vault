// Synthetic actual-App check; start server.ts first. No wallet, credentials or device.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { expect } = await import(process.env.PLAYWRIGHT_TEST_MODULE || '@playwright/test')
const base = `http://127.0.0.1:${process.env.LOCK_UI_QA_PORT || 5208}`
const out = process.env.LOCK_UI_QA_EVIDENCE || '.'
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const checks = {}, failures = [], browserErrors = []
page.on('pageerror', e => browserErrors.push(e.message))
await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort())
const load = async (initial = 'ready') => { await page.goto(base + '/?initial=' + initial); await expect(initial === 'ready' ? page.getByTestId('portfolio') : page.getByTestId('splash')).toBeVisible() }
const push = changes => page.evaluate(changes => window.__setDevice(changes), changes)
const pin = () => page.getByText('Enter PIN', { exact: true }).locator('..')
const calls = () => page.evaluate(() => window.__calls)
const unlock = () => page.getByRole('button', { name: 'Unlock', exact: true })
const submitPin = async () => { await page.keyboard.type('1'); await pin().getByRole('button', { name: 'Unlock', exact: true }).click() }
const check = async (name, run) => {
 try { await run(); checks[name] = true; console.log('PASS ' + name) }
 catch (e) { checks[name] = false; failures.push({ name, error: e.message }); console.log('FAIL ' + name + ': ' + e.message.slice(0, 600)); await page.screenshot({ path: path.join(out, name + '-failure.png'), fullPage: true }).catch(() => {}) }
}
try {
 await check('locked-portfolio-keeps-mounted-normal-device-actions', async () => {
  await load(); const instance = await page.getByTestId('portfolio').getAttribute('data-instance')
  await push({ state: 'needs_pin' })
  await expect(page.getByText('KeepKey locked', { exact: true })).toBeVisible()
  await expect(pin()).toHaveCount(0)
  assert.equal(await page.getByTestId('portfolio').getAttribute('data-instance'), instance)
  await expect(page.getByTestId('portfolio')).toHaveAttribute('data-watch-only', 'false')
  await expect(page.getByTestId('nav')).toHaveAttribute('data-connected', 'true')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__deviceAction), 1)
  assert(!(await calls()).some(c => c.method === 'requestDeviceUnlock'))
  await page.screenshot({ path: path.join(out, 'portfolio-locked.png'), fullPage: true })
 })
 await check('explicit-unlock-opens-real-device-prompt-and-resumes', async () => {
  await unlock().click(); await expect(pin()).toBeVisible()
  assert.equal((await calls()).filter(c => c.method === 'requestDeviceUnlock').length, 1)
  await submitPin(); await expect(pin()).toHaveCount(0)
  await expect(page.getByText('KeepKey locked', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('portfolio')).toBeVisible()
 })
 await check('cancel-does-not-reopen-an-unasked-pin', async () => {
  await push({ state: 'needs_pin' }); await unlock().click(); await expect(pin()).toBeVisible()
  await pin().getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(pin()).toHaveCount(0); await expect(unlock()).toBeEnabled()
  assert.equal((await calls()).filter(c => c.method === 'cancelDeviceSigning').length, 1)
  await page.waitForTimeout(400)
  await expect(pin()).toHaveCount(0)
 })
 await check('wrong-pin-is-visible-and-user-can-retry', async () => {
  await page.evaluate(() => { window.__wrongPin = true })
  await unlock().click(); await expect(pin()).toBeVisible(); await submitPin()
  await expect(pin()).toHaveCount(0); await expect(page.getByText('Incorrect PIN', { exact: true })).toBeVisible()
  await expect(unlock()).toBeEnabled(); await unlock().click(); await expect(pin()).toBeVisible()
  await submitPin(); await expect(pin()).toHaveCount(0); await expect(page.getByTestId('portfolio')).toBeVisible()
 })
 await check('cold-locked-start-opens-pin-without-a-click', async () => {
  await load('needs_pin'); await expect(page.getByTestId('portfolio')).toHaveCount(0)
  await expect(pin()).toBeVisible(); await expect(page.getByTestId('splash').getByRole('button', { name: 'Unlock', exact: true })).toHaveCount(0)
  assert.equal((await calls()).filter(c => c.method === 'requestDeviceUnlock').length, 1)
 })
 await check('cancelled-auto-unlock-offers-unlock-and-never-reopens', async () => {
  await pin().getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(pin()).toHaveCount(0); await expect(page.getByTestId('splash').getByRole('button', { name: 'Unlock', exact: true })).toBeEnabled()
  await page.waitForTimeout(400); await expect(pin()).toHaveCount(0)
  assert.equal((await calls()).filter(c => c.method === 'requestDeviceUnlock').length, 1)
  await page.getByTestId('splash').getByRole('button', { name: 'Unlock', exact: true }).click(); await expect(pin()).toBeVisible()
 })
 await check('quick-same-id-replug-does-not-inherit-verification', async () => {
  await load(); await page.evaluate(() => { window.__setDevice({ state: 'disconnected' }); window.__setDevice({ state: 'needs_pin' }) })
  await expect(page.getByTestId('portfolio')).toHaveCount(0); await expect(page.getByTestId('splash')).toBeVisible()
  await expect(pin()).toBeVisible() // the replugged connection asks for its own PIN
  assert.equal((await calls()).filter(c => c.method === 'requestDeviceUnlock').length, 1)
 })
 await check('quick-replug-retires-a-live-pin-matrix-before-another-device', async () => {
  await load(); await push({ state: 'needs_pin' }); await unlock().click(); await expect(pin()).toBeVisible()
  await page.evaluate(() => { window.__setDevice({ state: 'disconnected', pinPromptOpen: false }); window.__setDevice({ state: 'needs_pin', pinPromptOpen: false }) })
  // The old matrix is retired; the new connection opens exactly one fresh prompt.
  await expect(page.getByTestId('splash')).toBeVisible(); await expect(pin()).toBeVisible()
  assert.equal((await calls()).filter(c => c.method === 'requestDeviceUnlock').length, 2)
 })
 await check('different-locked-device-does-not-show-prior-portfolio', async () => {
  await load(); await push({ state: 'needs_pin', deviceId: 'synthetic-b' })
  await expect(page.getByTestId('portfolio')).toHaveCount(0); await expect(page.getByTestId('splash')).toBeVisible()
 })
 await check('seed-purge-invalidates-locked-continuity', async () => {
  await load(); await page.evaluate(() => { window.__push('wallet-data-purged', { reason: 'seed-changed' }); window.__setDevice({ state: 'needs_pin' }) })
  await expect(page.getByTestId('portfolio')).toHaveCount(0); await expect(page.getByTestId('splash')).toBeVisible()
 })
 await check('hidden-wallet-pin-continuity-ends-at-passphrase-boundary', async () => {
  await load(); await push({ state: 'ready', isHiddenWallet: true }); await push({ state: 'needs_pin' })
  await expect(page.getByTestId('portfolio')).toBeVisible()
  await push({ state: 'needs_passphrase' }); await expect(page.getByTestId('portfolio')).toHaveCount(0)
  await expect(page.getByTestId('splash')).toBeVisible(); await expect(page.getByText('Enter Passphrase', { exact: true })).toHaveCount(0)
 })
 await check('setup-still-replaces-the-portfolio', async () => {
  await load(); await push({ state: 'needs_init', initialized: false })
  await expect(page.getByTestId('setup')).toBeVisible(); await expect(page.getByTestId('portfolio')).toHaveCount(0)
 })
 assert.deepEqual(browserErrors, [])
} catch (e) { failures.push({ name: 'runner', error: e.message }) }
finally { fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checks, failures, browserErrors, syntheticOnly: true }, null, 2)); await browser.close() }
if (failures.length) process.exitCode = 1
