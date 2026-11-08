// Production OOB wizard, synthetic state and RPC only. No real flash is possible.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { expect } = await import(process.env.PLAYWRIGHT_TEST_MODULE || '@playwright/test')
const base = `http://127.0.0.1:${process.env.FIRMWARE_QA_PORT || 5204}`
const out = process.env.FIRMWARE_QA_EVIDENCE || '.'
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
const errors = [], checks = {}, failures = [], recordedCalls = {}
page.on('pageerror', e => errors.push(e.message))
await page.route('**/*', route => route.request().url().startsWith(base)
  ? route.continue()
  : route.request().resourceType() === 'image'
    ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>' })
    : route.abort())
const rpc = async (method, params) => {
  const response = await (await page.request.post(base + '/__test_rpc', { data: { method, params } })).json()
  assert(response.success, response.error)
  return response.payload
}
const install = () => page.getByRole('button', { name: 'Install official firmware', exact: true })
const proceed = () => page.getByRole('button', { name: 'Continue with this build', exact: true })
const load = async (scenario = 'normal') => {
  await rpc('testReset', { scenario })
  await page.goto(base + '?scenario=' + scenario)
  await expect(page.getByText(scenario === 'verified' ? 'Genuine KeepKey' : 'Firmware not in the release list', { exact: true })).toBeVisible()
}
const steps = async () => (await rpc('testCalls')).filter(c => c.method === 'logOnboarding').map(c => c.params?.event)
const expectStep = async step => expect.poll(steps).toContain('wizard step=' + step)
const assertNoNativeMutation = calls => {
  const unsafe = calls.filter(c => !['getDeviceState', 'getAppSettings', 'getFeatures', 'logOnboarding'].includes(c.method) && !c.method.startsWith('test'))
  assert.deepEqual(unsafe, [], 'No flash, wallet reset, wipe or other native mutation may be requested')
  assert.deepEqual(calls.filter(c => c.blocked), [], 'No denied native RPC may be attempted')
}
const check = async (name, run) => {
  try {
    await run()
    const calls = await rpc('testCalls'); recordedCalls[name] = calls; assertNoNativeMutation(calls)
    checks[name] = true; console.log('PASS ' + name)
  } catch (error) {
    checks[name] = false; failures.push({ name, error: error.message })
    recordedCalls[name] = await rpc('testCalls').catch(() => [])
    console.log('FAIL ' + name + ': ' + error.message.slice(0, 650))
    await page.screenshot({ path: path.join(out, name + '-failure.png'), fullPage: true }).catch(() => {})
  }
}
try {
  await check('official-action-visible-with-continue-wide', async () => {
    await load(); await expect(install()).toBeEnabled(); await expect(proceed()).toBeEnabled()
    for (const button of [install(), proceed()]) {
      const box = await button.boundingBox()
      assert(box.x >= 0 && box.x + box.width <= 1280 && box.y >= 0 && box.y + box.height <= 900, JSON.stringify(box))
    }
    await page.screenshot({ path: path.join(out, 'authenticity-wide.png'), fullPage: true })
  })
  if (process.env.FIRMWARE_QA_ACTION_ONLY !== '1') {
    await check('explicit-install-stays-on-updater-for-newer-custom-firmware', async () => {
      await load(); await install().click(); await expectStep('firmware')
      await expect(page.getByText('Firmware Update', { exact: true })).toBeVisible()
      const device = await rpc('testSetDeviceState', { needsFirmwareUpdate: false, firmwareVersion: '7.99.0' })
      await page.evaluate(state => window.__fixturePush('device-state', state), device)
      // The real detection poll also sees the newer version and false update flag.
      await page.waitForTimeout(2300)
      await expect(page.getByText('Firmware Update', { exact: true })).toBeVisible()
      assert(!(await steps()).some(step => /wizard step=(init-choose|complete|intro)$/.test(step)))
      await page.screenshot({ path: path.join(out, 'official-update-instructions.png'), fullPage: true })
    })
    await check('continue-retains-normal-onboarding-route', async () => {
      await load(); await proceed().click(); await expectStep('intro')
      assert(!(await steps()).some(step => /wizard step=(firmware|bootloader)$/.test(step)))
    })
    await check('disconnected-actions-disabled', async () => {
      await load('disconnected'); await expect(install()).toBeDisabled(); await expect(proceed()).toBeDisabled()
      assert.deepEqual(await steps(), ['wizard step=authenticity'])
    })
    await check('official-install-respects-bootloader-prerequisite', async () => {
      await load('needs-bootloader'); await install().click()
      // Devices that need a bootloader retain their existing coin-choice stage.
      await expect.poll(async () => (await steps()).some(step => /wizard step=(coin-choice|bootloader)$/.test(step))).toBe(true)
      if (await page.getByText('Choose your KeepKey firmware', { exact: true }).isVisible()) {
        await page.getByRole('button', { name: 'Continue with Multi-chain', exact: true }).click()
      }
      await expectStep('bootloader')
      await expect(page.getByText('Put Your Device in Bootloader Mode', { exact: true })).toBeVisible()
      const device = await rpc('testSetDeviceState', { state: 'bootloader', bootloaderMode: true, initialized: false })
      await page.evaluate(state => window.__fixturePush('device-state', state), device)
      await expect(page.getByRole('button', { name: 'Update Bootloader to v2.1.4', exact: true })).toBeDisabled()
      await page.screenshot({ path: path.join(out, 'official-bootloader-backup-gate.png'), fullPage: true })
    })
    await check('unknown-lineage-requires-explicit-firmware-choice', async () => {
      await load('unknown-lineage'); await install().click(); await expectStep('coin-choice')
      await expect(page.getByRole('button', { name: 'Choose Bitcoin-only or Multi-chain', exact: true })).toBeDisabled()
      await page.getByRole('button', { name: /^Multi-chain/ }).click()
      await page.getByRole('button', { name: 'Continue with Multi-chain', exact: true }).click()
      await expectStep('firmware'); await expect(page.getByText('Firmware Update', { exact: true })).toBeVisible()
    })
    await check('verified-release-retains-normal-continue', async () => {
      await load('verified'); await expect(install()).toHaveCount(0)
      await page.getByRole('button', { name: 'Continue', exact: true }).click(); await expectStep('intro')
    })
    await check('bootloader-install-keeps-existing-wipe-acknowledgement', async () => {
      await load(); await install().click(); await expectStep('firmware')
      const device = await rpc('testSetDeviceState', { state: 'bootloader', bootloaderMode: true, initialized: false, needsFirmwareUpdate: false })
      await page.evaluate(state => window.__fixturePush('device-state', state), device)
      const firmwareInstall = page.getByRole('button', { name: /^Install .*firmware v7\.16\.0$/i })
      await expect(firmwareInstall).toBeVisible(); await expect(firmwareInstall).toBeDisabled()
      await page.screenshot({ path: path.join(out, 'official-install-wipe-gate.png'), fullPage: true })
    })
    await check('official-and-continue-actions-accessible-narrow', async () => {
      await page.setViewportSize({ width: 390, height: 844 }); await load()
      for (const button of [install(), proceed()]) {
        await button.scrollIntoViewIfNeeded(); await expect(button).toBeVisible()
        const box = await button.boundingBox()
        assert(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, JSON.stringify(box))
        assert(await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }))
      }
      await page.screenshot({ path: path.join(out, 'authenticity-narrow.png'), fullPage: true })
      await page.setViewportSize({ width: 1280, height: 900 })
    })
    await check('optional-features-and-alpha-remain-disabled', async () => {
      const { settings } = await rpc('testState')
      for (const [key, value] of Object.entries(settings)) if (typeof value === 'boolean') assert.equal(value, false, key)
    })
  }
  assert.deepEqual(errors, [], 'Browser runtime errors')
} catch (error) { failures.push({ name: 'runner', error: error.message }) }
finally {
  const result = { checks, failures, browserErrors: errors, recordedCalls, optionalFeaturesEnabled: false, realDeviceUsed: false, firmwareFlashed: false, testSource: 'Real OobSetupWizard with synthetic native RPC' }
  fs.writeFileSync(path.join(out, 'firmware-authenticity-results.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ checks, failures, browserErrors: errors }, null, 2))
  await browser.close()
}
if (failures.length) process.exitCode = 1
