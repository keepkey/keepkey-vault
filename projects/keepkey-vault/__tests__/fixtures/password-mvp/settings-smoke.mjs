// Run against server.ts. All settings, wallet data and device replies are synthetic.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { expect } = await import(process.env.PLAYWRIGHT_TEST_MODULE || '@playwright/test');
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], writes = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (request.url().endsWith('/__test_rpc')) {
    const { method } = request.postDataJSON();
    if (/^(set|apply|wipe|change|reset|moneroNode(Start|Stop|Configure))/.test(method)) writes.push(method);
  }
});
try {
  await page.request.post('http://127.0.0.1:5198/__test_rpc', { data: { method: 'testReset' } });
  await page.goto('http://127.0.0.1:5198');
  await page.getByRole('button', { name: 'Device Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  const nav = dialog.getByRole('navigation', { name: 'Settings sections' });
  for (const name of ['General', 'Device', 'Security', 'Networks', 'Monero', 'Connections', 'Feature Flags', 'Advanced']) {
    await nav.getByRole('button', { name, exact: true }).click();
    await expect(dialog.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
    await expect(nav.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
    assert(await dialog.locator('section').count() > 0, `${name} has content`);
    assert.equal(await dialog.getByRole('switch', { name: '', exact: true }).count(), 0, 'Every switch is named');
  }
  assert.deepEqual(writes, [], 'Browsing settings performs no mutations');
  await nav.getByRole('button', { name: 'Feature Flags', exact: true }).click();
  const passwords = dialog.getByRole('switch', { name: 'Password manager', exact: true });
  const monero = dialog.getByRole('switch', { name: 'Monero (XMR)', exact: true });
  await expect(passwords).toHaveAttribute('aria-checked', 'false');
  await expect(monero).toHaveAttribute('aria-checked', 'false');
  await monero.click();
  await expect(monero).toHaveAttribute('aria-checked', 'true');
  await expect(passwords).toHaveAttribute('aria-checked', 'false');
  await passwords.click();
  await expect(page.getByRole('button', { name: 'Passwords', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Passwords and seed vault', exact: true })).toHaveCount(1);
  await expect(monero).toHaveAttribute('aria-checked', 'true');
  await passwords.click();
  await expect(page.getByRole('button', { name: 'Passwords', exact: true })).toHaveCount(0);
  await expect(monero).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: './settings-features.png' });
  await nav.getByRole('button', { name: 'Monero', exact: true }).click();
  await expect(dialog.getByText('/Volumes/SSD/keepkey/monero/mainnet', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Storage used: 12 GiB/)).toBeVisible();
  await expect(dialog.getByText(/1,350,000.*3,800,000/)).toBeVisible();
  await page.screenshot({ path: './settings-monero.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['General', 'Security', 'Feature Flags', 'Monero', 'Advanced']) {
    await nav.getByRole('button', { name, exact: true }).click();
    await expect(dialog.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} fits narrow window`);
  }
  await page.screenshot({ path: './settings-narrow.png' });
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(dialog).not.toBeVisible();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ categories: 8, independentLiveFlags: true, noWritesOnNavigation: true, nodeStorageAndHeight: true, narrowWindow: true, pageErrors: errors }, null, 2));
} finally { await browser.close(); }
