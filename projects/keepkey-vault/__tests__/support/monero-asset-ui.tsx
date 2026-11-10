/** Driver for monero-asset-ui.test.ts: renders the XMR row and the Monero sections of the
 * standard asset page in jsdom with a fake monero client, clicks them, and prints what a
 * user sees and what was sent. Runs in its own process so DOM globals stay out of other suites. */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const g = globalThis as any
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  g[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
g.window.matchMedia ??= () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
g.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n/index')
const { CHAINS } = await import('../../src/shared/chains')
const { MoneroChainRow, MoneroReceiveSection, MoneroSendSection, MoneroHeaderBalance } = await import('../../src/mainview/components/MoneroAssetSections')

const WALLET = '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR'
const SUBADDRESS = '84AxZu7xYb7fi7hnQrgTBdHFyP2xz6vdrZbLaJxbe73JJTWj6JG4cV8cbNnEhMvvi9PxSHvGnXQiaaLf2HNXJfzFKtWqk3H'
const RECIPIENT = '4Ahp23WfMrMFK3wYL2hLWQFGt87ZTeRkufS6JoQZu6MEFDokAQeGWmu9MA3GFq1yVLSJQbKJqVAn9F9DLYGpRzRAEXqAXKM'
const monero = CHAINS.find(c => c.id === 'monero')!
const notConnected = { available: false, network: 'mainnet', address: '', balanceAtomic: '0', unlockedBalanceAtomic: '0', walletHeight: 0, transactions: [],
  monitorReady: false, syncState: 'not-connected', canSend: false, spendStateKnown: false }
const connected = (over: Record<string, unknown> = {}) => ({ ...notConnected, available: true, address: WALLET, balanceAtomic: '84653050000',
  unlockedBalanceAtomic: '84653050000', walletHeight: 3_300_000, daemonHeight: 3_300_000, restoreHeight: 0, monitorReady: true, syncState: 'ready',
  updatedAt: new Date().toISOString(), sendBlocked: 'key-images', ...over })

function fakeClient(initial: any, settingsHeight = 0) {
  const calls: any[] = []
  let current = initial
  let releaseConnect: (() => void) | undefined
  const client = {
    holdConnect: false, releaseConnect: () => releaseConnect?.(),
    calls, set(next: any) { current = next },
    getStatus: async () => current,
    getSettings: async () => ({ moneroDaemonUrl: 'https://node.example', moneroRestoreHeight: settingsHeight }),
    suggestRestoreHeight: async () => ({ tipHeight: 3_300_000, restoreHeight: 3_294_960, marginBlocks: 5040 }),
    connect: async (height?: number) => { calls.push(['connect', height]); if (client.holdConnect) await new Promise<void>(resolve => { releaseConnect = resolve }); current = connected(); return current },
    getAddress: async (minor: number, showDisplay: boolean) => { calls.push(['getAddress', minor, showDisplay]); return { address: minor ? SUBADDRESS : WALLET, network: 'mainnet', displayed: showDisplay, minor } },
    syncKeyImages: async () => { calls.push(['sync']); const receiveOnly = ['emulator', 'adapter'].includes(current.sendBlocked); current = connected({ ...current, canSend: !receiveOnly, sendBlocked: receiveOnly ? current.sendBlocked : undefined, keyImagesSynced: true, keyImagesStale: false, spendStateKnown: true }); return current },
    prepareSend: async (params: any) => { calls.push(['prepare', params]); return { prepareId: 'ab'.repeat(16), max: !!params.max, recipient: params.address,
      amountAtomic: params.max ? '84633049999' : params.amountAtomic, feeAtomic: '20000000', changeAtomic: '1', totalAtomic: '84653049999', inputCount: 1,
      outputs: [{ role: 'recipient', address: params.address, amountAtomic: '84633049999' }, { role: 'change', address: WALLET, amountAtomic: '1' }] } },
    send: async () => ({ txid: 'cd'.repeat(32) }),
    retryRelay: async () => { calls.push(['retry']); return { txid: 'ef'.repeat(32) } },
    discardPending: async () => { calls.push(['discard']); return { outcome: 'discarded', txid: 'cd'.repeat(32) } },
  }
  return client
}

async function render(element: any) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(ChakraProvider, { value: defaultSystem }, element)) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  return { container, unmount: () => act(async () => root.unmount()) }
}
const text = (el: Element | null) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
const q = (c: Element, selector: string) => c.querySelector(selector) as HTMLElement | null
async function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
}
async function type(input: Element | null, value: string) {
  if (!input) throw new Error('no input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
/** The page state hook, held by a tiny host so a section renders as AssetPage renders it. */
const { useMoneroStatus } = await import('../../src/mainview/hooks/useMoneroStatus')
function Host({ Section, client, extra }: any) {
  const state = useMoneroStatus(true, client)
  return React.createElement(Section, { monero: state, client, chain: monero, privateMode: false, ...extra })
}

const out: Record<string, unknown> = {}

// Hidden-wallet status is actionable and cannot start the automatic connect flow.
{
  const { MONERO_STANDARD_WALLET_REQUIRED } = await import('../../src/shared/monero-wallet-policy')
  const client = fakeClient({ ...notConnected, error: MONERO_STANDARD_WALLET_REQUIRED })
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroReceiveSection, client }))
  out.hiddenWallet = { text: text(q(container, '[data-monero-connect]')), calls: client.calls,
    buttons: container.querySelectorAll('[data-monero-connect] button').length, prompts: text(container).includes('Confirm on KeepKey') }
  await unmount()
}

// A view-only total can include spent change; it must not look like verified balance.
const { moneroBalanceView } = await import('../../src/shared/monero-asset')
for (const [name, verified, privateMode] of [['headerUnverified', false, false], ['headerVerified', true, false], ['headerPrivate', true, true]] as const) {
  const {container, unmount} = await render(React.createElement(MoneroHeaderBalance, {view:moneroBalanceView(connected({spendStateKnown:verified})),privateMode}))
  out[name] = text(q(container,'[data-monero-header-balance]'))
  await unmount()
}

// ── The Dashboard row: "—" until known, never fiat, the last balance when the node is down ──
for (const [name, status] of [['rowNotConnected', notConnected], ['rowReady', connected({ spendStateKnown: true, keyImagesSynced: true })], ['rowScanning', connected({ syncState: 'scanning', walletHeight: 3_297_480, restoreHeight: 3_294_960, monitorReady: false })],
  ['rowUnreachable', connected({ syncState: 'unreachable', monitorReady: false, spendStateKnown: true })], ['rowUnverified', connected()]] as const) {
  let opened = 0
  const { container, unmount } = await render(React.createElement(MoneroChainRow, { chain: monero, iconSrc: '', privateMode: false, onOpen: () => { opened++ }, client: fakeClient(status) }))
  out[name] = { balance: text(q(container, '[data-monero-row-balance]')), fiat: text(q(container, '[data-monero-row-fiat]')), state: text(q(container, '[data-monero-row-state]')) }
  await click(q(container, '[data-monero-row]'))
  out[`${name}Opened`] = opened
  await unmount()
}

// ── Opening XMR connects once; technical choices are disclosed only on request ──
{
  const client = fakeClient(notConnected)
  client.holdConnect = true
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroReceiveSection, client }))
  out.connectText = text(q(container, '[data-monero-connect]'))
  out.connectCalls = client.calls.filter(c => c[0] === 'connect')
  out.connectButtons = [...container.querySelectorAll('[data-monero-connect] button')].map(text)
  out.settingsClosed = !(q(container, '[data-monero-connection-details]') as HTMLDetailsElement | null)?.open
  out.scanChoices = container.querySelectorAll('input[name="monero-scan-start"]').length
  client.set({ ...notConnected, connectionPhase: 'wallet' })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)) })
  out.walletOpeningText = text(q(container, '[data-monero-connect]'))
  await act(async () => { client.releaseConnect() })
  out.technicalReceiveHidden = !q(container, '[data-receive-technical]')
  out.afterConnect = { balance: text(q(container, '[data-monero-balance]')), note: q(container, '[data-monero-note]')?.getAttribute('data-monero-note') }
  await click(container.querySelector('[aria-label="Next subaddress"]'))
  out.subaddressShown = text(q(container, '[data-monero-subaddress]'))
  out.subaddressAddress = [...container.querySelectorAll('*')].some(el => el.children.length === 0 && text(el) === SUBADDRESS)
  const verify = [...container.querySelectorAll('button')].find(b => /Verify/i.test(text(b)))
  await click(verify ?? null)
  out.subaddressCalls = client.calls.filter(c => c[0] === 'getAddress')
  out.verified = /Address confirmed on KeepKey/.test(text(container))
  await unmount()
}
{
  const client = fakeClient(notConnected, 3_000_000)
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroReceiveSection, client }))
  out.storedHeightCalls = client.calls.filter(c => c[0] === 'connect')
  await unmount()
}

{
 const client = fakeClient(connected({balanceAtomic:'0',unlockedBalanceAtomic:'0'}))
 const {container,unmount}=await render(React.createElement(Host,{Section:MoneroReceiveSection,client}))
 out.zeroBalanceChecks=client.calls.filter(call=>call[0]==='sync').length
 out.zeroBalanceNote=text(q(container,'[data-monero-note]'))
 await unmount()
}

// Physical/receive-only wallets still need a spent-output check to show a balance.
for (const blocker of ['emulator', 'adapter']) {
 const client = fakeClient(connected({canSend:false,sendBlocked:blocker}))
 client.syncKeyImages = async () => {
  client.calls.push(['sync'])
  const verified = connected({canSend:false,sendBlocked:blocker,keyImagesSynced:true,spendStateKnown:true})
  client.set(verified)
  return verified
 }
 function BalanceHost() {
  const state = useMoneroStatus(true, client)
  return <><MoneroHeaderBalance view={moneroBalanceView(state.status)} privateMode={false} /><MoneroReceiveSection monero={state} client={client} chain={monero} privateMode={false} /><MoneroSendSection monero={state} client={client} /></>
 }
 const {container,unmount}=await render(<BalanceHost />)
 out[`receiveOnlyBalance_${blocker}`] = {
  checks:client.calls.filter(call=>call[0]==='sync').length,
  balance:text(q(container,'[data-monero-header-balance]')),
  blocked:q(container,'[data-monero-send-blocked]')?.getAttribute('data-monero-send-blocked'),
  prepared:client.calls.some(call=>call[0]==='prepare'),
 }
 await unmount()
}

// A new node/session reimports known outputs, while a declined device prompt stays declined.
for(const cancel of [false,true]) {
 const initial=connected({connection:{activeNode:'https://first.example',preferredNode:'https://first.example',sessionId:1,automaticFailover:true,state:'connected',attempts:[]}})
 const client=fakeClient(initial)
 if(cancel)client.syncKeyImages=async()=>{client.calls.push(['sync']);throw Error('The KeepKey rejected or cancelled the Monero request')}
 let update!:(status:any)=>void
 function SessionHost(){const [status,setStatus]=React.useState(initial);update=setStatus;return <MoneroReceiveSection monero={{status,setStatus,refresh:async()=>{},refreshing:false,refreshError:null}} client={client} chain={monero} privateMode={false}/>}
 const {unmount}=await render(<SessionHost />)
 const next=connected({connection:{activeNode:'https://second.example',preferredNode:'https://first.example',sessionId:2,automaticFailover:true,state:'connected',attempts:[]}})
 client.set(next);await act(async()=>{update(next);await new Promise(r=>setTimeout(r,20))})
 out[cancel?'declinedAcrossFailover':'reverifiedAfterFailover']=client.calls.filter(c=>c[0]==='sync').length
 await unmount()
}

// Public diagnostics name the active fallback and retain the failed node's reason.
{
 const client=fakeClient(connected({spendStateKnown:true,keyImagesSynced:true,connection:{preferredNode:'https://first.example',activeNode:'https://second.example',automaticFailover:true,state:'connected',attempts:[{url:'https://first.example',state:'failed',checkedAt:'2026-11-08T12:00:00Z',error:'The node did not respond within 10 seconds.'},{url:'https://second.example',state:'responding',height:3801979,lastResponseAt:'2026-11-08T12:00:10Z',latencyMs:120}]}}))
 const {container,unmount}=await render(<Host Section={MoneroReceiveSection} client={client} />)
 out.connectionDiagnostics={text:text(q(container,'[data-monero-connection-info]')),detailsClosed:!(q(container,'[data-monero-connection-info] details') as HTMLDetailsElement).open}
 await unmount()
}

// ── A guessed scan start never reads as complete; an old figure carries its time ──
{
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroReceiveSection, client: fakeClient(connected({ restoreHeight: 3_294_960, updatedAt: new Date().toISOString() })) }))
  out.partial = text(q(container, '[data-monero-note]'))
  await unmount()
  const row = await render(React.createElement(MoneroChainRow, { chain: monero, iconSrc: '', privateMode: false, onOpen() {}, client: fakeClient(connected({ restoreHeight: 3_294_960, spendStateKnown: true, keyImagesSynced: true })) }))
  out.rowPartial = text(q(row.container, '[data-monero-row-state]'))
  await row.unmount()
  const old = await render(React.createElement(Host, { Section: MoneroReceiveSection, client: fakeClient(connected({ restoreHeight: 0, syncState: 'scanning', monitorReady: false, updatedAt: '2026-11-06T12:00:00.000Z' })) }))
  out.staleScanning = { balance: text(q(old.container, '[data-monero-balance]')), stale: text(q(old.container, '[data-monero-stale]')) }
  await old.unmount()
}

// ── Node down after connect: the last known balance, labelled ──
{
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroReceiveSection, client: fakeClient(connected({ syncState: 'unreachable', monitorReady: false, updatedAt: '2026-11-06T12:00:00.000Z' })) }))
  out.unreachable = { balance: text(q(container, '[data-monero-balance]')), note: text(q(container, '[data-monero-note]')) }
  await unmount()
}
{
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroReceiveSection, client: fakeClient(connected({ syncState: 'scanning', walletHeight: 0, restoreHeight: 3_294_960, monitorReady: false, balanceAtomic: '0', unlockedBalanceAtomic: '0' })) }))
  out.scanning = { balance: text(q(container, '[data-monero-balance]')), note: text(q(container, '[data-monero-note]')) }
  await unmount()
}

// ── Send: key-image gate, form checks, Max, unknown broadcast ──
{
  const client = fakeClient(connected())
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroSendSection, client }))
  out.sendBlockedBefore = q(container, '[data-monero-send-blocked]')?.getAttribute('data-monero-send-blocked')
  out.syncDetailsClosed = !(q(container, '[data-monero-send-details]') as HTMLDetailsElement | null)?.open
  out.formBeforeSync = !!q(container, '[data-monero-send-address]')
  out.syncBeforeReview = client.calls.filter(c => c[0] === 'sync').length
  await type(q(container, '[data-monero-send-address]'), WALLET)
  out.ownAddressProblem = text(q(container, '[data-monero-problem="address"]'))
  await type(q(container, '[data-monero-send-address]'), RECIPIENT)
  await type(q(container, '[data-monero-send-amount]'), '1')
  out.moreThanUnlocked = text(q(container, '[data-monero-problem="amount"]'))
  out.reviewDisabledOverBalance = (q(container, '[data-monero-review-send]') as HTMLButtonElement).disabled
  await click(q(container, '[data-monero-max]'))
  await click(q(container, '[data-monero-review-send]'))
  out.maxPrepare = client.calls.filter(c => c[0] === 'prepare').at(-1)
  out.syncPrepareOrder = client.calls.filter(c => c[0] === 'sync' || c[0] === 'prepare').map(c => c[0])
  out.reviewAmount = text(q(container, '[data-monero-review-amount]'))
  await unmount()
}
{
  const client = fakeClient(connected({ unrelayedTxid: 'cd'.repeat(32), sendBlocked: 'unrelayed' }))
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroSendSection, client }))
  out.unrelayedShown = text(q(container, '[data-monero-unrelayed]'))
  out.formWhileUnrelayed = !!q(container, '[data-monero-send-address]')
  await click(q(container, '[data-monero-retry-relay]'))
  out.retryCalls = client.calls.filter(c => c[0] === 'retry').length
  out.discardWithoutCheck = !!q(container, '[data-monero-discard]')
  await unmount()
}
{
  const client = fakeClient(connected({ unrelayedTxid: 'cd'.repeat(32), sendBlocked: 'unrelayed', unrelayedCheck: { state: 'unknown', discardable: true, checkedAt: new Date().toISOString() } }))
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroSendSection, client }))
  out.checkText = text(q(container, '[data-monero-unrelayed-check]'))
  await click(q(container, '[data-monero-discard]'))
  out.discardCallsBeforeConfirm = client.calls.filter(c => c[0] === 'discard').length
  out.discardConfirmText = text(q(container, '[data-monero-discard-confirm]'))
  await click(q(container, '[data-monero-discard-yes]'))
  out.discardCalls = client.calls.filter(c => c[0] === 'discard').length
  out.discardNotice = text(q(container, '[data-monero-notice]'))
  await unmount()
}
{
  const client = fakeClient(connected({ unrelayedTxid: 'cd'.repeat(32), sendBlocked: 'unrelayed', unrelayedCheck: { state: 'unknown', discardable: false, checkedAt: new Date().toISOString() } }))
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroSendSection, client }))
  out.notDiscardable = { button: !!q(container, '[data-monero-discard]'), text: text(q(container, '[data-monero-unrelayed-check]')) }
  await unmount()
}
{
  const client = fakeClient(connected({ unrelayedTxid: 'cd'.repeat(32), sendBlocked: 'unrelayed',
    unrelayedCheck: { state: 'unknown', discardable: true, checkedAt: new Date().toISOString(), relayNode: 'https://a.example', checkedNode: 'https://b.example' } }))
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroSendSection, client }))
  out.otherNode = text(q(container, '[data-monero-other-node]'))
  await unmount()
  const same = await render(React.createElement(Host, { Section: MoneroSendSection, client: fakeClient(connected({ unrelayedTxid: 'cd'.repeat(32), sendBlocked: 'unrelayed',
    unrelayedCheck: { state: 'unknown', discardable: true, checkedAt: new Date().toISOString(), relayNode: 'https://a.example', checkedNode: 'https://a.example' } })) }))
  out.sameNode = !!q(same.container, '[data-monero-other-node]')
  await same.unmount()
  const guarded = await render(React.createElement(Host, { Section: MoneroSendSection, client: fakeClient(connected({ canSend: true, sendBlocked: undefined, keyImagesSynced: true, spendStateKnown: true, discardedTxid: 'ef'.repeat(32) })) }))
  out.discardedNote = text(q(guarded.container, '[data-monero-discarded]'))
  await guarded.unmount()
}
{
  const { container, unmount } = await render(React.createElement(Host, { Section: MoneroSendSection, client: fakeClient(connected({ sendBlocked: 'emulator' })) }))
  out.receiveOnly = text(q(container, '[data-monero-send-blocked]'))
  await unmount()
}

{
 const client=fakeClient(connected({canSend:true,sendBlocked:undefined,keyImagesSynced:true,spendStateKnown:true}))
 const {container,unmount}=await render(React.createElement(Host,{Section:MoneroSendSection,client,extra:{privateMode:true}}))
 out.sendPrivateText=text(container);await unmount()
}

{
 const client = fakeClient(notConnected) as any
 let ready = false
 client.getSettings = async () => ({moneroDaemonUrl:'http://127.0.0.1:18081',moneroRestoreHeight:0,moneroNodeMode:'local'})
 client.getNodeStatus = async () => ({state:ready?'ready':'syncing'})
 const {container,unmount}=await render(React.createElement(Host,{Section:MoneroReceiveSection,client}))
 out.nodeWaitCalls=client.calls.length;out.nodeWaitText=text(container)
 ready=true
 await act(async()=>{window.dispatchEvent(new Event('keepkey-settings-changed'));await new Promise(resolve=>setTimeout(resolve,30))})
 out.nodeReadyConnects=client.calls.filter((call:any[])=>call[0]==='connect').length
 await unmount()
}
console.log(JSON.stringify(out))
