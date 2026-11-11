import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const configured = process.env.PLAYWRIGHT_MODULE || process.env.PLAYWRIGHT_TEST_MODULE || '@playwright/test'
const specifier = /^(?:\.|\/|[A-Za-z]:[\\/])/.test(configured) ? pathToFileURL(resolve(configured)).href : configured
const { chromium } = await import(specifier)
const story = resolve(process.env.UPDATE_BANNER_STORY_DIR || join(tmpdir(), 'keepkey-update-banner-story'))
const evidence = resolve(process.env.CORE_QA_EVIDENCE || join(tmpdir(), 'keepkey-update-banner-evidence'))
const manifest = JSON.parse(fs.readFileSync(join(story, 'manifest.json'), 'utf8'))
const script = fs.readFileSync(join(story, manifest.script), 'utf8')
const styles = fs.readFileSync(join(story, manifest.styles), 'utf8')
fs.mkdirSync(evidence, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) })
const results = [], errors = []
let callbackChecks = 0, timeoutChecks = 0
const phases = [
  { phase: 'available', key: 'newVersionAvailable' },
  { phase: 'downloading', key: 'downloadingWithProgress', progress: 65 },
  { phase: 'downloading', key: 'downloading', progress: null },
  { phase: 'ready', key: 'readyToInstall' }, { phase: 'applying', key: 'applying' },
]
try {
  for (const width of [320, 390, 1280]) for (const locale of ['en', 'long', 'stress']) {
    const page = await browser.newPage({ viewport: { width, height: 700 } })
    page.on('pageerror', error => errors.push({ width, locale, error: error.message }))
    await page.route('**/*', route => route.abort()) // Includes fonts: supported offline fallback geometry.
    try {
      await page.setContent(`<style>${styles}</style><style>body{background:var(--ink-0)}</style><div id="root"></div>`)
      await page.addScriptTag({ type: 'module', content: script })
      await page.waitForFunction(() => !!window.__updateBanner)
      for (const { phase, key, progress } of phases) {
        await page.evaluate(options => window.__updateBanner.render(options), { phase, locale, progress })
        const status = page.locator('[role="status"]')
        await status.waitFor()
        await page.waitForFunction(({ locale, key }) => document.querySelector('[role="status"] p')?.textContent === window.__updateBanner.words[locale][key].replace('{{progress}}', '65'), { locale, key })
        const metrics = await status.evaluate(element => {
          const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
          const title = element.querySelector('p')
          return { documentWidth: document.documentElement.scrollWidth, status: box(element), copy: box(title.parentElement),
            title: { ...box(title), text: title.textContent, scrollWidth: title.scrollWidth, clientWidth: title.clientWidth },
            buttons: [...element.querySelectorAll('button')].map(button => ({ ...box(button), text: button.textContent, scrollWidth: button.scrollWidth, clientWidth: button.clientWidth })),
          }
        })
        const failures = []
        if (metrics.documentWidth > width + 1) failures.push('document overflow')
        if (metrics.status.x < -1 || metrics.status.right > width + 1) failures.push('banner outside viewport')
        if (metrics.title.width < 80 || metrics.title.scrollWidth > metrics.title.clientWidth + 1) failures.push('title clipped or crushed')
        if (metrics.buttons.length !== (phase === 'available' || phase === 'ready' ? 2 : 0)) failures.push('wrong action count')
        for (const button of metrics.buttons) {
          if (button.x < metrics.status.x - 1 || button.right > metrics.status.right + 1) failures.push('button outside banner')
          if (button.scrollWidth > button.clientWidth + 1) failures.push('button label overflow')
          if (width < 768 && button.y < metrics.copy.bottom - 1) failures.push('actions overlap copy row')
        }
        results.push({ width, locale, phase, progress, ...metrics, failures })
        if (phase === 'available' || phase === 'ready') {
          await page.screenshot({ path: join(evidence, `${phase}-${locale}-${width}.png`) })
          await status.locator('button').nth(0).click()
          await status.locator('button').nth(1).click()
          assert.deepEqual(await page.evaluate(() => window.__updateBanner.calls), ['dismiss', phase === 'ready' ? 'apply' : 'download'])
          callbackChecks++
        }
      }
      for (const phase of ['idle', 'checking']) {
        await page.evaluate(options => window.__updateBanner.render(options), { phase, locale })
        await page.waitForFunction(() => !document.querySelector('[role="status"]'))
      }
      for (const phase of ['warning', 'error']) {
        await page.evaluate(options => window.__updateBanner.render(options), { phase, locale })
        const dismiss = page.getByRole('button', { name: '✕' })
        await dismiss.waitFor(); await dismiss.click()
        assert.deepEqual(await page.evaluate(() => window.__updateBanner.calls), ['dismiss'])
        callbackChecks++
      }
      if (width === 320 && locale === 'en') {
        await page.clock.install()
        await page.evaluate(() => window.__updateBanner.render({ phase: 'warning' }))
        await page.getByRole('button', { name: '✕' }).waitFor()
        await page.clock.fastForward(20_001)
        await page.waitForFunction(() => window.__updateBanner.calls.length === 1)
        assert.deepEqual(await page.evaluate(() => window.__updateBanner.calls), ['dismiss'])
        await page.getByRole('button', { name: '✕' }).waitFor({ state: 'detached' })
        timeoutChecks++
      }
    } finally { await page.close() }
  }
} finally {
  await browser.close()
  fs.writeFileSync(join(evidence, 'layout.json'), JSON.stringify({ results, errors, callbackChecks, timeoutChecks }, null, 2) + '\n')
}
const failures = results.filter(result => result.failures.length)
console.log(JSON.stringify({ states: results.length, layoutFailures: failures, errors, callbackChecks, timeoutChecks, evidence }, null, 2))
assert.equal(results.length, 45)
assert.deepEqual(failures, [])
assert.deepEqual(errors, [])
assert.equal(callbackChecks, 36)
assert.equal(timeoutChecks, 1)
