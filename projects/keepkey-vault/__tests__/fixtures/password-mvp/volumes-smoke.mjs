// Browser regression for the Vault tools dialog. Start this fixture's server.ts first.
// Every storage request is answered in memory, including native approval and Finder.
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true })

function pending() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { release, promise }
}

async function observed(signal, description) {
  let timer
  try {
    return await Promise.race([signal.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for ' + description)), 15_000)
    })])
  } finally { clearTimeout(timer) }
}

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  const imageId = 'Practice.kkvolume'
  const destination = { id: 'disk7s1', uuid: 'fixture-volume' }
  const inventory = {
    supported: true,
    local: { name: 'Macintosh HD', availableBytes: 156e9, totalBytes: 512e9, fileVault: 'on' },
    drives: [{ id: 'disk7', name: 'ProductCode 3.0', sizeBytes: 268.4e9, volumes: [
      { ...destination, name: 'KK-PRACTICE', format: 'exFAT', mountPoint: '/Volumes/KK-PRACTICE', writable: true,
        availableBytes: 1048576 * 512, encrypted: false, locked: false },
    ] }],
  }
  const images = []
  const creates = []
  const deletions = []
  const methods = []
  let cancel = true
  let deviceAvailable = true
  let holdRefresh = false
  const createStarted = pending(), finishCreate = pending()
  const refreshStarted = pending(), finishRefresh = pending()
  const unlockStarted = pending(), finishUnlock = pending()
  const lockStarted = pending(), finishLock = pending()
  const openedAfterUnlock = pending()
  const deleteStarted = pending(), finishDelete = pending()

  await page.route('**/__test_rpc', async route => {
    const { method, params } = route.request().postDataJSON()
    let payload
    switch (method) {
      case 'getAppSettings': {
        const response = await route.fetch()
        const settings = await response.json()
        return route.fulfill({ json: { ...settings, payload: { ...settings.payload, passwordManagerEnabled: true, passkeysEnabled: true } } })
      }
      case 'volumeDeviceStatus': payload = deviceAvailable ? { available: true, reason: 'ready' } : { available: false, reason: 'disconnected' }; break
      case 'getVolumeInventory': payload = inventory; break
      case 'listVolumeImages':
        if (holdRefresh) {
          holdRefresh = false
          refreshStarted.release()
          await finishRefresh.promise
        }
        payload = images
        break
      case 'createVolumeImage': {
        const { operationId, ...details } = params
        assert.ok(operationId)
        creates.push(details)
        if (params.destination) {
          createStarted.release(operationId)
          await finishCreate.promise
          holdRefresh = true
        }
        images.push({ id: params.name + '.kkvolume', name: params.name, unlockMethod: 'keepkey', state: 'locked',
          destination: params.destination, deleteToken: 'created-' + creates.length })
        break
      }
      case 'deleteVolumeImage': {
        deletions.push(params)
        const index = images.findIndex(image => image.id === params.id && image.destination?.uuid === params.destination?.uuid)
        assert.notEqual(index, -1, 'Delete must target a listed image on this drive')
        assert.equal(params.deleteToken, images[index].deleteToken, 'Delete must include the selected image identity')
        if (deletions.length === 1) {
          images[index].state = 'unavailable'
          return route.fulfill({ json: { success: false, error: 'The volume could not be deleted.' } })
        }
        deleteStarted.release()
        await finishDelete.promise
        images.splice(index, 1)
        break
      }
      case 'unlockVolumeImage': {
        const { operationId, ...target } = params
        assert.ok(operationId)
        assert.deepEqual(target, { id: imageId, destination })
        if (cancel) {
          cancel = false
          return route.fulfill({ json: { success: false, error: 'Cancelled on KeepKey.' } })
        }
        unlockStarted.release(operationId)
        await finishUnlock.promise
        images[0].state = 'mounted'
        break
      }
      case 'openExternalVolume':
        assert.deepEqual(params, destination)
        break
      case 'openVolumeImage':
        assert.equal(images[0].state, 'mounted', 'Finder must open the protected volume only after unlock')
        assert.deepEqual(params, { id: imageId, destination })
        openedAfterUnlock.release()
        break
      case 'lockVolumeImage':
        assert.deepEqual(params, { id: imageId, destination })
        lockStarted.release()
        await finishLock.promise
        images[0].state = 'locked'
        break
      default: return route.continue()
    }
    methods.push(method)
    return route.fulfill({ json: { success: true, payload } })
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const sendProgress = (operationId, phase, keyLabel) => page.evaluate(payload => {
    window.__electrobun.receiveMessageFromBun({ type: 'message', id: 'volume-progress', payload })
  }, { operationId, phase, keyLabel })
  async function clickTwice(locator) {
    await locator.click({ trial: true })
    await locator.evaluate(element => { element.click(); element.click() })
  }
  const dialog = page.getByRole('dialog', { name: 'Vault', exact: true })
  await page.goto('http://127.0.0.1:5198/?volumes')
  await button('Vault tools').click()
  await button('Passwords').waitFor()
  await button('Passkeys').waitFor()
  await button('Volumes').click()
  const local = page.getByRole('group', { name: 'Macintosh HD', exact: true })
  const external = page.getByRole('group', { name: 'KK-PRACTICE', exact: true })
  const practice = external.getByRole('group', { name: 'Practice', exact: true })
  const deleteButton = practice.getByRole('button', { name: 'Delete volume', exact: true })
  const confirmation = practice.getByRole('alertdialog', { name: 'Delete Practice from KK-PRACTICE?', exact: true })
  const confirmDelete = confirmation.getByRole('button', { name: 'Delete permanently', exact: true })
  const startCreate = group => group.getByRole('button', { name: 'Create volume', exact: true }).click()
  await startCreate(external)
  assert.equal(await page.getByRole('combobox', { name: 'Save on' }).count(), 0)
  await external.getByLabel('Name', { exact: true }).fill('Practice')
  const size = external.getByLabel('Maximum size (MiB)')
  await size.fill('513')
  assert.ok(await button('Create').isDisabled())
  await size.fill('256')
  await clickTwice(button('Create'))
  const createId = await observed(createStarted, 'external create RPC')
  const waiting = external.getByText('Waiting for KeepKey approval…', { exact: true })
  await waiting.waitFor()
  const keyLabel = 'KeepKey Volume v1 0123456789abcdef0123456789abcdef'
  const cipherTitle = external.getByText('Encrypt Key Value', { exact: true })
  await sendProgress(createId, 'approval', keyLabel)
  await external.getByText('To create Practice, confirm the matching prompt on your KeepKey.').waitFor()
  await cipherTitle.waitFor()
  await external.getByText(keyLabel, { exact: true }).waitFor()
  await sendProgress('stale-previous-request', 'creating')
  await waiting.waitFor()
  await sendProgress(createId, 'creating')
  const creating = external.getByText('Creating volume…', { exact: true })
  await creating.waitFor()
  assert.equal(await cipherTitle.count(), 0)
  if (process.env.VOLUMES_CREATING_SCREENSHOT) await dialog.screenshot({ path: process.env.VOLUMES_CREATING_SCREENSHOT })
  finishCreate.release()
  await observed(refreshStarted, 'post-create inventory refresh')
  assert.ok(await external.getByRole('status').filter({ hasText: /creating|checking/i }).isVisible(),
    'Creation or verification progress stays visible through native state refresh')
  finishRefresh.release()
  await external.getByText('Practice was created. Unlock it to add protected files.', { exact: true }).waitFor()
  assert.equal(await button('Open protected volume').count(), 0)
  await button('Open drive').click()
  const lockedHint = external.getByText('Unlock this volume to access its protected files.', { exact: true })
  await lockedHint.waitFor()
  await button('Unlock with KeepKey').click()
  await external.getByRole('alert').filter({ hasText: 'Cancelled on KeepKey.' }).waitFor()
  await button('Unlock with KeepKey').click({ trial: true })
  assert.equal(await lockedHint.count(), 0)
  await clickTwice(button('Unlock with KeepKey'))
  const unlockId = await observed(unlockStarted, 'second unlock RPC')
  assert.notEqual(createId, unlockId)
  await waiting.waitFor()
  await sendProgress(createId, 'creating')
  await waiting.waitFor()
  await sendProgress(unlockId, 'approval', keyLabel)
  await external.getByText('To unlock Practice, confirm the matching prompt on your KeepKey.').waitFor()
  await external.getByText(keyLabel, { exact: true }).waitFor()
  await sendProgress(unlockId, 'unlocking')
  await external.getByText('Unlocking volume…', { exact: true }).waitFor()
  finishUnlock.release()
  await observed(openedAfterUnlock, 'Finder opening the newly unlocked volume')
  await button('Open protected volume').click()
  assert.ok(await deleteButton.isDisabled(), 'A mounted volume must be locked before deletion')
  if (process.env.VOLUMES_UNLOCKED_SCREENSHOT) {
    await external.getByRole('button', { name: 'Lock', exact: true }).click({ trial: true })
    await external.scrollIntoViewIfNeeded()
    await dialog.screenshot({ path: process.env.VOLUMES_UNLOCKED_SCREENSHOT })
  }
  await clickTwice(button('Lock'))
  await observed(lockStarted, 'lock RPC')
  await external.getByText('Locking volume…', { exact: true }).waitFor()
  finishLock.release()
  await button('Unlock with KeepKey').waitFor()
  assert.equal(await button('Open protected volume').count(), 0)
  if (process.env.VOLUMES_SCREENSHOT) {
    await page.getByRole('heading', { name: 'Volumes', exact: true }).evaluate(node => node.scrollIntoView({ block: 'start' }))
    await dialog.screenshot({ path: process.env.VOLUMES_SCREENSHOT })
  }
  // A second volume with the same name on another disk must survive the entire retry.
  images.push({ id: imageId, name: 'Practice', state: 'locked', unlockMethod: 'keepkey', deleteToken: 'local-copy' })
  deviceAvailable = false
  await button('Refresh').click()
  await local.getByRole('group', { name: 'Practice', exact: true }).waitFor()
  await deleteButton.click()
  await confirmation.getByText('/Volumes/KK-PRACTICE/KeepKey Volumes/Practice.kkvolume', { exact: true }).waitFor()
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await confirmation.count(), 0)
  assert.equal(deletions.length, 0)

  await deleteButton.click()
  await confirmation.waitFor()
  images[0].deleteToken = 'replacement-image'
  await button('Refresh').click()
  await confirmation.waitFor({ state: 'detached' })
  assert.equal(deletions.length, 0, 'Refreshing after an image is replaced must discard its confirmation')

  await deleteButton.click()
  await confirmDelete.click()
  await practice.getByRole('alert').filter({ hasText: 'The volume could not be deleted.' }).waitFor()
  await practice.getByText(/Unavailable/).waitFor()
  assert.equal(images.length, 2)
  await deleteButton.click()
  await clickTwice(confirmDelete)
  await observed(deleteStarted, 'confirmed delete for an unavailable volume')
  await practice.getByText('Deleting volume…', { exact: true }).waitFor()
  finishDelete.release()
  await external.getByText('Practice was deleted from KK-PRACTICE.', { exact: true }).waitFor()
  assert.equal(await practice.count(), 0)
  await local.getByRole('group', { name: 'Practice', exact: true }).waitFor()
  const expectedDelete = { id: imageId, destination, deleteToken: 'replacement-image' }
  assert.deepEqual(deletions, [expectedDelete, expectedDelete])

  deviceAvailable = true
  await button('Refresh').click()
  await startCreate(external)
  await external.getByLabel('Name', { exact: true }).fill('Practice')
  await external.getByRole('button', { name: 'Create', exact: true }).click()
  await external.getByText('Practice was created. Unlock it to add protected files.', { exact: true }).waitFor()
  await practice.waitFor()
  await startCreate(external)
  await external.getByLabel('Name', { exact: true }).fill('Interrupted')
  assert.ok(await button('Create').isEnabled())
  // macOS can reuse a device identifier for a replacement partition after unplugging a USB drive.
  const partition = inventory.drives[0].volumes[0]
  partition.uuid = 'replacement-uuid'
  partition.name = 'Replacement'
  await button('Refresh').click()
  const replacement = page.getByRole('group', { name: 'Replacement', exact: true })
  await replacement.waitFor()
  assert.equal(await page.getByLabel('Name', { exact: true }).count(), 0)
  await startCreate(local)
  await local.getByLabel('Name', { exact: true }).fill('Local practice')
  await local.getByRole('button', { name: 'Create', exact: true }).click()
  await local.getByText('Local practice', { exact: true }).waitFor()
  assert.deepEqual(creates, [
    { name: 'Practice', sizeMiB: 256, destination },
    { name: 'Practice', sizeMiB: 256, destination },
    { name: 'Local practice', sizeMiB: 256 },
  ])
  assert.deepEqual(methods.filter(method => ['createVolumeImage', 'unlockVolumeImage', 'lockVolumeImage', 'openExternalVolume', 'openVolumeImage', 'deleteVolumeImage'].includes(method)),
    ['createVolumeImage', 'openExternalVolume', 'unlockVolumeImage', 'openVolumeImage', 'openVolumeImage', 'lockVolumeImage', 'deleteVolumeImage', 'createVolumeImage', 'createVolumeImage'])
  console.log('Volume creation, approval, unlock, Finder, lock, scoped delete confirmation and retry passed.')
} finally { await browser.close() }
