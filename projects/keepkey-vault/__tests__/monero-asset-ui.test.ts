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

describe('C1/C2: the XMR row in the chain list', () => {
  test('not connected and scanning show "—", never 0; fiat always says not included', () => {
    expect(ui.rowNotConnected).toEqual({ balance: '— XMR', fiat: 'not included', state: 'Not connected' })
    expect(ui.rowScanning).toEqual({ balance: '— XMR', fiat: 'not included', state: 'Syncing 50%' })
  })
  test('synced shows the balance; node down keeps the last known balance and says so', () => {
    expect(ui.rowReady).toEqual({ balance: '0.08465305 XMR', fiat: 'not included', state: '' })
    expect(ui.rowUnreachable).toEqual({ balance: '0.08465305 XMR', fiat: 'not included', state: 'Node unreachable' })
  })
  test('clicking the row opens the asset page', () => {
    for (const name of ['rowNotConnected', 'rowReady', 'rowScanning', 'rowUnreachable']) expect(ui[`${name}Opened`]).toBe(1)
  })
})

describe('C4: connecting asks where the scan starts and names the node', () => {
  test('an unset (legacy) scan start means an existing wallet scanned from 0, never a guessed week', () => {
    expect(ui.defaultChoice).toBe('existing')
    expect(ui.defaultHeight).toBe('0')
    expect(ui.connectText).toContain('0 scans the whole chain: it takes hours, and it finds every payment')
    expect(ui.connectText).toContain('Node: https://node.example')
    expect(ui.connectText).toContain('A node you run yourself')
  })
  test('"never received XMR" is a deliberate choice, warned, with the tip said to come from the unverified node', () => {
    expect(ui.connectText).toContain("start at block 3,294,960, a week before block 3,300,000, the current height the node reports (KeepKey can't verify it)")
    expect(ui.warningBeforeNew).toBe(false)
    expect(ui.warningAfterNew).toContain('Anything received before this block will not appear')
    expect(ui.connectCalls).toEqual([['connect', 3294960]])
  })
  test('a guessed start is never shown as complete; an old figure says when it is from', () => {
    expect(ui.partial).toContain('Scanned from block 3,294,960: XMR received before that block is not shown')
    expect(ui.rowPartial).toBe('Synced from block 3,294,960')
    expect(ui.staleScanning.balance).toBe('0.084653050000 XMR')
    expect(ui.staleScanning.stale).toStartWith('Last updated ')
  })
  test('a scan start already chosen in Settings is kept, not replaced', () => {
    expect(ui.storedHeightField).toBe('3000000')
    expect(ui.storedHeightCalls).toEqual([['connect', 3000000]])
  })
})

describe('C2: balance states on the page', () => {
  test('connected: the balance, marked not yet verified as spendable', () => {
    expect(ui.afterConnect).toEqual({ balance: '0.084653050000 XMR', note: 'unverified' })
  })
  test('scanning: "—" and where the scan is', () => {
    expect(ui.scanning.balance).toBe('—')
    expect(ui.scanning.note).toContain('Scanning the chain from block 3,294,960')
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
  test('no form until key images are synced', () => {
    expect(ui.sendBlockedBefore).toBe('key-images')
    expect(ui.formBeforeSync).toBe(false)
    expect(ui.formAfterSync).toBe(true)
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
    expect(ui.discardedNote).toContain('You discarded transaction efefefefefef…')
  })
  test('without the signing emulator, Send says receive-only instead of a dead form', () => {
    expect(ui.receiveOnly).toContain('Receiving works.')
  })
})
