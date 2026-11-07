/**
 * What the user sees on the XMR row and the Monero parts of the standard asset page
 * (stability plan C1, C2, C3, C4). Rendered in jsdom and clicked, in a child process.
 *
 * Before: XMR was a separate "Monero" tab and a dashboard button opening MoneroPanel; the
 * scan start silently defaulted to block 0 (hours of scanning); there was no Max, no
 * subaddress to move funds to, and the unknown-broadcast block vanished on restart.
 *
 * Run: bun test __tests__/monero-asset-ui.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test'

const RECIPIENT = '4Ahp23WfMrMFK3wYL2hLWQFGt87ZTeRkufS6JoQZu6MEFDokAQeGWmu9MA3GFq1yVLSJQbKJqVAn9F9DLYGpRzRAEXqAXKM'
let ui: Record<string, any>

beforeAll(() => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/monero-asset-ui.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  ui = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)
}, 120_000)

test('the main balance is hidden until verified and still respects private mode', () => {
  expect(ui.headerUnverified).toBe('—')
  expect(ui.headerVerified).toBe('0.08465305')
  expect(ui.headerPrivate).toBe('••••••')
})

test('local node syncing waits without device prompts or public fallback; a ready node connects automatically', () => {
 expect(ui.nodeWaitCalls).toBe(0)
 expect(ui.nodeWaitText).toContain('Waiting for your node')
 expect(ui.nodeWaitText).not.toContain('Confirm on KeepKey')
 expect(ui.nodeReadyConnects).toBe(1)
})

describe('C1/C2: the XMR row in the chain list', () => {
  test('not connected and scanning show "—", never 0; fiat always says not included', () => {
    expect(ui.rowNotConnected).toEqual({ balance: '— XMR', fiat: 'not included', state: 'Not connected' })
    expect(ui.rowScanning).toEqual({ balance: '— XMR', fiat: 'not included', state: 'Syncing 50%' })
  })
  test('synced shows the balance; node down keeps the last known balance and says so', () => {
    expect(ui.rowUnverified).toEqual({ balance: '— XMR', fiat: 'not included', state: 'Balance needs verification' })
    expect(ui.rowReady).toEqual({ balance: '0.08465305 XMR', fiat: 'not included', state: '' })
    expect(ui.rowUnreachable).toEqual({ balance: '0.08465305 XMR', fiat: 'not included', state: 'Node unreachable' })
  })
  test('clicking the row opens the asset page', () => {
    for (const name of ['rowNotConnected', 'rowReady', 'rowScanning', 'rowUnreachable']) expect(ui[`${name}Opened`]).toBe(1)
  })
})

describe('XMR opens without a setup checklist', () => {
  test('connects once automatically with complete history by default', () => {
    expect(ui.connectCalls).toEqual([['connect', 0]])
    expect(ui.connectButtons).toEqual([])
    expect(ui.scanChoices).toBe(0)
    expect(ui.connectText).toContain('Confirm on KeepKey')
    expect(ui.settingsClosed).toBe(true)
    expect(ui.technicalReceiveHidden).toBe(true)
  })
  test('respects a previously chosen scan start', () => {
    expect(ui.storedHeightCalls).toEqual([['connect', 3000000]])
  })
  test('a partial scan still says that older payments can be missing', () => {
    expect(ui.partial).toContain('Earlier payments may be missing')
    expect(ui.rowPartial).toBe('Synced')
    expect(ui.staleScanning.balance).toBe('0.084653050000 XMR')
    expect(ui.staleScanning.stale).toStartWith('Last updated ')
  })
})

test('an empty scanned wallet needs no balance confirmation and shows no false prompt', () => {
 expect(ui.zeroBalanceChecks).toBe(0)
 expect(ui.zeroBalanceNote).toBe('')
})

describe('C2: balance states on the page', () => {
  test('connected: verifies the balance automatically', () => {
    expect(ui.afterConnect).toEqual({ balance: '0.084653050000 XMR' })
  })
  test('scanning: "—" and where the scan is', () => {
    expect(ui.scanning.balance).toBe('—')
    expect(ui.scanning.note).toContain('Syncing your Monero wallet')
  })
  test('node down: the last known balance with its time', () => {
    expect(ui.unreachable.balance).toBe('0.084653050000 XMR')
    expect(ui.unreachable.note).toContain("The Monero node can't be reached. Showing the last known balance, from ")
  })
})

describe('Receive: subaddresses come from the device and verify on it', () => {
  test('stepping to #1 reads it from KeepKey and shows it; Verify shows it on the device', () => {
    expect(ui.subaddressShown).toBe('Subaddress #1')
    expect(ui.subaddressAddress).toBe(true)
    expect(ui.subaddressCalls).toEqual([['getAddress', 1, false], ['getAddress', 1, true]])
    expect(ui.verified).toBe(true)
  })
})

describe('C3: Send', () => {
  test('checks the balance automatically on opening and prepares without another manual sync', () => {
    expect(ui.formBeforeSync).toBe(true)
    expect(ui.syncBeforeReview).toBe(1)
    expect(ui.syncPrepareOrder).toEqual(['sync', 'prepare'])
    expect(ui.syncDetailsClosed).toBe(true)
  })
  test('my own main address and more than the unlocked balance are explained before anything is built', () => {
    expect(ui.ownAddressProblem).toContain('send to one of its subaddresses')
    expect(ui.moreThanUnlocked).toBe('This is more than your unlocked balance (0.084653050000 XMR).')
    expect(ui.reviewDisabledOverBalance).toBe(true)
  })
  test('Max asks the backend for a max send and the review shows the amount it built', () => {
    expect(ui.maxPrepare).toEqual(['prepare', { address: RECIPIENT, max: true }])
    expect(ui.reviewAmount).toBe('0.084633049999 XMR')
  })
  test('an unknown broadcast blocks the form and offers only Retry broadcast', () => {
    expect(ui.unrelayedShown).toBe('cd'.repeat(32))
    expect(ui.formWhileUnrelayed).toBe(false)
    expect(ui.retryCalls).toBe(1)
    expect(ui.discardWithoutCheck).toBe(false)
  })
  test('discard is offered only after the node says unknown with unspent inputs, and asks first', () => {
    expect(ui.checkText).toContain('it does not have this transaction, and its inputs are still unspent')
    expect(ui.discardCallsBeforeConfirm).toBe(0)
    expect(ui.discardConfirmText).toContain('Discard only if you are sure it was never broadcast')
    expect(ui.discardCalls).toBe(1)
    expect(ui.discardNotice).toContain('Discarded')
    expect(ui.notDiscardable.button).toBe(false)
    expect(ui.notDiscardable.text).toContain('Wait for that to settle')
    expect(ui.discardConfirmText).toContain('the next send from this wallet must reuse one of its inputs')
  })
  test('a check answered by a different node than the one the tx went to says so; a discarded tx is named', () => {
    expect(ui.otherNode).toContain('It was sent to https://a.example, but https://b.example answered this check')
    expect(ui.sameNode).toBe(false)
    expect(ui.discardedNote).toBe('Your discarded send will be checked before another payment.')
  })
  test('without the signing emulator, Send says receive-only instead of a dead form', () => {
    expect(ui.receiveOnly).toContain('Receiving works.')
  })
})


test('private mode hides the available balance in the send form as well as the header', () => {
 expect(ui.sendPrivateText).not.toContain('0.084653050000')
})
