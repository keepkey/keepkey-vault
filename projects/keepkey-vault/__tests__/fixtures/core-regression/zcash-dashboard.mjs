// Actual Dashboard -> AssetPage navigation. Zcash is enabled only in browser
// RPC replies for this explicit regression; the fixture's stored flags stay off.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { expect } = await import(process.env.PLAYWRIGHT_TEST_MODULE || '@playwright/test')
const base = `http://127.0.0.1:${process.env.CORE_QA_PORT || 5211}`
const out = process.env.CORE_QA_EVIDENCE || '.'
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const checks = {}, errors = [], packets = []
const optional = ['passwordManagerEnabled', 'moneroEnabled', 'btcMultisigEnabled', 'walletConnectEnabled', 'emulatorEnabled', 'hiveEnabled', 'alphaFirmware', 'preReleaseUpdates']
const rpc = async (method, params) => (await (await page.request.post(base + '/__test_rpc', { data: { method, params } })).json()).payload
const address = 't1' + 'A'.repeat(33)
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  const request = route.request(), url = request.url()
  if (!url.startsWith(base)) return request.resourceType() === 'image'
    ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#e9c46a"/></svg>' }) : route.abort()
  if (url.endsWith('/__test_rpc') && request.method() === 'POST') {
    const packet = request.postDataJSON(); packets.push(packet)
    if (packet.method === 'getAppSettings') {
      const response = await route.fetch(), result = await response.json()
      assert.equal(result.payload.zcashPrivacyEnabled, false)
      for (const flag of optional) assert.equal(result.payload[flag], false, flag)
      return route.fulfill({ response, json: { ...result, payload: { ...result.payload, zcashPrivacyEnabled: true } } })
    }
    if (packet.method === 'zcashShieldedStatus') return route.fulfill({ json: { success: true, payload: { ready: true, fvk_loaded: true, verified: true, synced: true, synced_to: 3_300_000, address: 'u1' + 'q'.repeat(140) } } })
    if (packet.method === 'zcashShieldedBalance') return route.fulfill({ json: { success: true, payload: { confirmed: 200_000_000, pending: 0, spendable_confirmed: 200_000_000, max_send: 199_990_000, synced_to: 3_300_000 } } })
  }
  return route.continue()
})
const privacy = () => page.getByRole('button', { name: 'Privacy', exact: true })
const openDashboardZcash = async () => {
  await rpc('testReset')
  await page.goto(base + '/?page=dashboard')
  const chain = page.getByRole('button', { name: /ZEC Zcash/ })
  await expect(chain).toBeVisible({ timeout: 15_000 })
  await chain.click()
  await expect(page.getByRole('button', { name: 'Receive', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  await expect(privacy()).toHaveCount(0)
}
try {
  await openDashboardZcash()
  checks.dashboardUsesStandardActionsWithoutPrivacyShortcut = true
  await page.screenshot({ path: path.join(out, 'zcash-dashboard-actions.png'), fullPage: true })
  for (const action of ['Receive', 'Send']) {
    if (action === 'Send') await openDashboardZcash()
    await page.getByRole('button', { name: action, exact: true }).click()
    await expect(page.getByRole('button', { name: 'Transparent · public', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Shielded · private', exact: true })).toBeEnabled()
    await expect(privacy()).toHaveCount(0)
    if (action === 'Receive') await expect(page.getByText(address, { exact: true })).toBeVisible()
    else await expect(page.getByPlaceholder('Address', { exact: true })).toBeVisible()
    checks[`dashboard${action}OpensUnifiedPoolSelector`] = true
    await page.screenshot({ path: path.join(out, `zcash-dashboard-${action.toLowerCase()}.png`), fullPage: true })
  }
  const { settings } = await rpc('testState')
  assert.equal(settings.zcashPrivacyEnabled, false)
  for (const flag of optional) assert.equal(settings[flag], false, flag)
  checks.fixtureFlagsRemainDisabled = true
  assert(!packets.some(packet => /(?:sign|broadcast|executeSwap|ShieldedInit|ShieldedScan|Deshield|ShieldZec|buildTx|^set)/i.test(packet.method)), 'Navigation must not initiate a device, transaction or settings mutation')
  checks.navigationDoesNotInitiatePrivateOrSigningOperations = true
  assert.deepEqual(errors, []); checks.noPageErrors = true
  console.log(JSON.stringify(checks, null, 2))
} catch (error) {
  await page.screenshot({ path: path.join(out, 'zcash-dashboard-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  fs.writeFileSync(path.join(out, 'zcash-dashboard-results.json'), JSON.stringify({ checks, browserErrors: errors, fixtureOnly: true, realWalletMutations: false }, null, 2) + '\n')
  await browser.close()
}
