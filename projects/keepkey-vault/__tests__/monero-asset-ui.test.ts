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

test('hidden wallets show the standard-wallet action without automatic consent or new buttons', () => {
  expect(ui.hiddenWallet).toEqual({ text: 'Monero is unavailable in hidden wallets. Switch to your standard wallet to use Monero.', calls: [], buttons: 0, prompts: false })
})

test('the main balance is hidden until verified and still respects private mode', () => {
  expect(ui.headerUnverified).toBe('—')
  expect(ui.headerVerified).toBe('0.08465305')
  expect(ui.headerPrivate).toBe('••••••')
})

test('a saved XMR total is visible at startup, during scanning and offline with its original time', () => {
  for (const state of ['startup', 'scanning', 'offline']) {
    expect(ui[`cachedRow_${state}`].balance).toBe('0.08465305 XMR')
    expect(ui[`cachedHeader_${state}`].balance).toBe('0.08465305')
    for (const surface of ['Row', 'Header']) {
      expect(ui[`cached${surface}_${state}`].source).toStartWith('Last known balance · ')
      expect(ui[`cached${surface}_${state}`].source).toContain('2026')
    }
  }
  expect(ui.cachedRow_scanning.state).toBe('Syncing 50%')
  expect(ui.cachedRow_offline.state).toBe('Node unreachable')
})

test('saved zero is labelled as saved; a current scanned zero replaces an older nonzero total', () => {
  expect(ui.cachedRow_savedZero.balance).toBe('0.0 XMR')
  expect(ui.cachedRow_savedZero.source).toStartWith('Last known balance · ')
  expect(ui.cachedHeader_savedZero.balance).toBe('0.0')
  expect(ui.cachedRow_currentZero).toEqual({ balance: '0.0 XMR', source: '', state: '' })
  expect(ui.cachedHeader_currentZero).toEqual({ balance: '0.0', source: '' })
})

test('the startup connection card shows a private-mode-safe saved total without receive or spend controls', () => {
  expect(ui.cachedConnect_false).toMatchObject({ balance: '0.084653050000 XMR', receiveAddress: false, addressOptions: false, signing: 0 })
  expect(ui.cachedConnect_false.source).toStartWith('Last known balance · ')
  expect(ui.cachedConnect_true).toMatchObject({ balance: '••••••', receiveAddress: false, addressOptions: false, signing: 0 })
})

test('disconnect, wallet changes and purge clear old funds immediately and ignore old status replies', () => {
  expect(ui.cachedOwnerBenign).toEqual({ balance: '0.08465305', reads: 0 })
  for (const state of ['Disconnected', 'OldReply', 'Reconnect', 'Hidden', 'Purged']) expect(ui[`cachedOwner${state}`]).toBe('—')
  expect(ui.cachedOwnerNewReply).toBe('0.09')
})

test('late connect and key-image verification replies cannot restore funds or deposit controls after a wallet purge', () => {
  for (const action of ['connect', 'sync']) expect(ui[`lateAction_${action}`]).toEqual({ balance: '—', receiveAddress: false,
    addressOptions: false, sendForm: false, actions: 1 })
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
  test('after device consent, progress names wallet preparation instead of requesting more button presses', () => {
    expect(ui.walletOpeningText).toContain('Opening Monero wallet')
    expect(ui.walletOpeningText).toContain('no further device confirmation is needed')
    expect(ui.walletOpeningText).not.toContain('Confirm on KeepKey')
  })
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

test('wallet scanning shows accessible measured progress from the saved start on Receive and Send',()=>{
 for(const name of ['known','send']){
  const scan=ui[`walletScan_${name}`]
  expect(scan).toMatchObject({present:true,role:'progressbar',value:'50',ariaNow:'50',label:'Monero wallet sync progress'})
  expect(scan.text).toContain('Syncing 50%')
  expect(scan.text).toContain('Wallet scan height: 3,250,000')
  expect(scan.text).toContain('Node height (reported): 3,300,000')
  expect(scan.text).toContain('Scan start block: 3,200,000')
 }
})

test('unknown heights, invalid ranges and a caught-up wallet not yet ready use an honest indeterminate bar',()=>{
 for(const name of ['zeroWallet','unknownTarget','invalidRange','caughtUp']){
  const scan=ui[`walletScan_${name}`]
  expect(scan.present).toBe(true)
  expect(scan.value).toBeNull();expect(scan.ariaNow).toBeNull()
  expect(scan.text).not.toMatch(/\d+%/)
  expect(scan.stateText).toContain('Syncing your Monero wallet')
  expect(scan.stateText).not.toContain("can't be reached")
 }
 expect(ui.walletScan_zeroWallet.text).toContain('Wallet scan height: Not reported yet')
 expect(ui.walletScan_unknownTarget.text).toContain('Node height (reported): Not reported yet')
})

test('the scan bar disappears when ready and is not shown for an unreachable node',()=>{
 expect(ui.walletScan_ready.present).toBe(false)
 expect(ui.walletScan_unreachable.present).toBe(false)
 expect(ui.walletScan_unreachable.stateText).toContain("The Monero node can't be reached")
 expect(ui.walletScanCompleted).toEqual({initial:true,remaining:false})
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
  test('missing signing infrastructure gives a repair action without a receive-only fallback', () => {
    expect(ui.signingUnavailable).toContain('Update KeepKey Desktop and firmware, then reconnect.')
    expect(ui.signingUnavailable).not.toContain('Receiving works')
  })
})


test('private mode hides the available balance in the send form as well as the header', () => {
 expect(ui.sendPrivateText).not.toContain('0.084653050000')
})

for (const blocker of ['firmware', 'emulator', 'adapter']) {
 test(`unavailable signing (${blocker}) retains existing funds without offering deposits`, () => {
  expect(ui[`unavailableBalance_${blocker}`]).toEqual({checks:1,balance:'0.08465305',blocked:true,receiveAddress:false,addressOptions:false,addresses:0,prepared:false})
 })
}


test('remote failover shows the active node, failures and last successful response in collapsed details',()=>{
 expect(ui.connectionDiagnostics.text).toContain('Active node: https://second.example')
 expect(ui.connectionDiagnostics.text).toContain('Preferred node: https://first.example')
 expect(ui.connectionDiagnostics.text).toContain('Automatic remote failover is on.')
 expect(ui.connectionDiagnostics.text).toContain('The node did not respond within 10 seconds.')
 expect(ui.connectionDiagnostics.text).toContain('Last successful node response')
 expect(ui.connectionDiagnostics.text).toContain('120 ms')
 expect(ui.connectionDiagnostics.detailsClosed).toBe(true)
})

test('failed or still-checking nodes are not described as active, and saved preference is labelled consistently',()=>{
 for(const state of ['waiting','failed','checking']){
  expect(ui[`connection_${state}`].info).not.toContain('Active node:')
  expect(ui[`connection_${state}`].info).toContain('Preferred node: https://first.example')
  expect(ui[`connection_${state}`].details).toContain('Preferred node: https://first.example')
  expect(ui[`connection_${state}`].details).not.toContain('Preferred node: https://second.example')
 }
})

test('scheduled retry is idle rather than a spinning connection or device approval, and a later scan start warns about history',()=>{
 const waiting=ui.connection_waiting
 expect(waiting.headline).toBe('Node unreachable')
 expect(waiting.spinner).toBe(false)
 expect(waiting.text).toContain('Automatic retry is scheduled.')
 expect(waiting.text).not.toContain('Confirm on KeepKey')
 expect(waiting.text).not.toContain('Vault is checking remote nodes')
 expect(waiting.details).toContain('Scan start block: 3799129')
 expect(waiting.details).toContain('Earlier payments may be missing.')
 expect(ui.connection_checking.headline).toBe('Connecting to a remote node')
 expect(ui.connection_checking.spinner).toBe(true)
})

test('a responding node with failed local wallet setup reports the wallet error without a false outage or device prompt',()=>{
 const failed=ui.walletOpenFailure
 expect(failed.headline).toBe("Monero couldn't open")
 expect(failed.spinner).toBe(false)
 expect(failed.info).toContain('node responded, but Vault could not open the local watch wallet')
 expect(failed.info).toContain('Responding')
 expect(failed.info).toContain('Last successful node response')
 expect(failed.info).toContain('Next retry:')
 expect(failed.alerts.some((message:string)=>message.includes('could not open the local watch wallet'))).toBe(true)
 expect(failed.text).not.toContain('The current node did not respond.')
 expect(failed.text).not.toContain('No remote node is responding.')
 expect(failed.text).not.toContain('Confirm on KeepKey')
 expect(failed.text).not.toContain('Vault is checking remote nodes')
 expect(ui.connection_failed.info).toContain('The current node did not respond.')
})


test('failover rechecks known outputs automatically and preserves a declined device approval',()=>{
 expect(ui.reverifiedAfterFailover).toBe(2)
 expect(ui.declinedAcrossFailover).toBe(1)
})


test('streamed proving progress is shown while keeping the full recipient visible', () => {
 expect(ui.provingText).toBe('KeepKey is proving the Monero transaction…')
 expect(ui.provingRecipient).toBe(true)
})

test('new Monero access requires signing readiness before consent or receive controls',()=>{
 for(const ready of ['false','undefined']){
  expect(ui[`unavailableConnect_${ready}`]).toMatchObject({calls:0,addressOptions:false})
  expect(ui[`unavailableConnect_${ready}`].text).not.toContain('receive payments')
  expect(ui[`unavailableConnect_${ready}`].text).not.toContain('Confirm on KeepKey')
 }
})

test('losing signing readiness revokes the deposit address while retaining funds',()=>{
 expect(ui.readinessRevoked).toEqual({before:true,addressOptions:false,address:false,balance:'0.084653050000 XMR'})
})

test('pending transaction recovery remains available without a signer',()=>{
 expect(ui.recoveryWithoutSigner).toEqual({retries:1,form:false})
})
