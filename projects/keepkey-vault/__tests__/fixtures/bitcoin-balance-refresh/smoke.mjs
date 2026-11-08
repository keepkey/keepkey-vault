// Real Dashboard, held synthetic refresh. No real wallet or network requests.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { expect } = await import(process.env.PLAYWRIGHT_TEST_MODULE || '@playwright/test')
const base = `http://127.0.0.1:${process.env.BALANCE_QA_PORT || 5205}`
const out = process.env.BALANCE_QA_EVIDENCE || '.'
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
const checks = {}, failures = [], errors = [], recordedCalls = {}
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue()
  : route.request().resourceType() === 'image' ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#e9c46a"/></svg>' }) : route.abort())
const rpc = async (method, params) => {
  const response = await (await page.request.post(base + '/__test_rpc', { data: { method, params } })).json()
  assert(response.success, response.error); return response.payload
}
const btc = () => page.getByRole('button').filter({ has: page.getByText('Bitcoin', { exact: true }) }).first()
const eth = () => page.getByRole('button').filter({ has: page.getByText('Ethereum', { exact: true }) }).first()
const all = () => page.getByRole('button').filter({ has: page.getByText('All Chains', { exact: true }) }).first()
const spinner = locator => locator.getByLabel('Refreshing balance', { exact: true })
const load = async (scenario = 'cached-zero', knownEmpty = true) => {
  await rpc('testReset', { scenario })
  await page.goto(base + (knownEmpty ? '?knownEmpty' : ''))
  await expect(btc()).toBeVisible()
  await expect.poll(async () => (await rpc('testState')).pending).toBe(true)
}
const row = (chainId, balance = '0', syncState = 'confirmed') => ({ chainId, symbol: chainId === 'bitcoin' ? 'BTC' : 'ETH',
  balance, balanceUsd: 0, nativeBalanceUsd: 0, address: 'synthetic', tokens: [], syncState })
const finish = async params => { await rpc('testCompleteRefresh', params); await expect(spinner(btc())).toHaveCount(0) }
const check = async (name, run) => {
  try {
    await run(); const calls = await rpc('testCalls'); recordedCalls[name] = calls
    assert.deepEqual(calls.filter(c => c.blocked), [], 'No native RPC attempted')
    checks[name] = true; console.log('PASS ' + name)
  } catch (error) {
    checks[name] = false; failures.push({ name, error: error.message }); recordedCalls[name] = await rpc('testCalls').catch(() => [])
    console.log('FAIL ' + name + ': ' + error.message.slice(0, 550))
    await page.screenshot({ path: path.join(out, name + '-failure.png'), fullPage: true }).catch(() => {})
  }
}
try {
  await check('cached-bitcoin-zero-shows-refreshing-without-clearing-value', async () => {
    await load(); await expect(btc()).toContainText('0 BTC'); await expect(spinner(btc())).toBeVisible()
    await expect(eth()).toContainText('0 ETH'); await expect(all()).toContainText('$0')
    await page.screenshot({ path: path.join(out, 'cached-bitcoin-refreshing.png'), fullPage: true })
  })
  if (process.env.BALANCE_QA_REFRESH_ONLY !== '1') {
    await check('confirmed-empty-bitcoin-stops-refreshing', async () => {
      await load(); await finish(); await expect(btc()).toContainText('0 BTC')
      await expect(spinner(btc())).toHaveCount(0); await expect.poll(() => btc().evaluate(el => getComputedStyle(el).opacity)).toBe('0.55')
    })
    await check('all-cached-aggregate-keeps-amount-and-shows-refreshing', async () => {
      await load('all-cached'); await expect(all()).toContainText('$0'); await expect(spinner(all())).toBeVisible()
      await expect(spinner(btc())).toBeVisible(); await expect(spinner(eth())).toBeVisible()
      await finish(); await expect(spinner(all())).toHaveCount(0)
    })
    await check('partial-result-marks-missing-chain-unavailable-without-spinning', async () => {
      await load(); await finish({ rows: [row('bitcoin')] }); await expect(eth()).toContainText('— ETH')
      await expect(spinner(eth())).toHaveCount(0); await expect(all()).toContainText('≥')
    })
    await check('degraded-bitcoin-without-cache-is-unavailable-not-zero', async () => {
      await load('cold-empty', false); await finish({ rows: [row('bitcoin', '0', 'degraded'), row('ethereum')] })
      await expect(btc()).toContainText('— BTC'); await expect(btc()).not.toContainText('0 BTC'); await expect(spinner(btc())).toHaveCount(0)
    })
    await check('failed-refresh-preserves-cached-funded-bitcoin-and-stops-spinner', async () => {
      await load('cached-positive', false); await expect(btc()).toContainText(/0\.50* BTC/); await expect(spinner(btc())).toBeVisible()
      await finish({ error: true }); await expect(btc()).toContainText(/0\.50* BTC/); await expect(spinner(btc())).toHaveCount(0)
      await expect(eth()).toContainText('— ETH')
    })
    await check('degraded-refresh-does-not-replace-cached-funded-bitcoin', async () => {
      await load('cached-positive', false); await finish({ rows: [row('bitcoin', '0', 'degraded'), row('ethereum')] })
      await expect(btc()).toContainText(/0\.50* BTC/); await expect(spinner(btc())).toHaveCount(0)
    })
    await check('optional-feature-flags-stay-off', async () => {
      const { settings } = await rpc('testState')
      for (const key of ['passwordManagerEnabled', 'moneroEnabled', 'zcashPrivacyEnabled', 'btcMultisigEnabled', 'walletConnectEnabled', 'emulatorEnabled', 'hiveEnabled']) assert.equal(settings[key], false, key)
    })
  }
  assert.deepEqual(errors, [], 'Browser runtime errors')
} catch (error) { failures.push({ name: 'runner', error: error.message }) }
finally {
  fs.writeFileSync(path.join(out, 'bitcoin-balance-results.json'), JSON.stringify({ checks, failures, browserErrors: errors,
    recordedCalls, nativeMutationAttempts: 0, realDeviceUsed: false, optionalFeaturesEnabled: false }, null, 2) + '\n')
  console.log(JSON.stringify({ checks, failures, browserErrors: errors }, null, 2)); await browser.close()
}
if (failures.length) process.exitCode = 1
