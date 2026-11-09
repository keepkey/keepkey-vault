import { lazy, Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChakraProvider, Box, Button, Flex, Text } from '@chakra-ui/react'
import { system } from '../../../src/mainview/theme'
import { AssetPage } from '../../../src/mainview/components/AssetPage'
import { Dashboard } from '../../../src/mainview/components/Dashboard'
import { TopNav, type NavTab } from '../../../src/mainview/components/TopNav'
import { DeviceSettingsDrawer } from '../../../src/mainview/components/DeviceSettingsDrawer'
import { PinEntry } from '../../../src/mainview/components/device/PinEntry'
import { SwapHistoryDialog } from '../../../src/mainview/components/SwapHistoryDialog'
import { CHAINS } from '../../../src/shared/chains'
import { dispatchLocalRpcMessage } from '../../../src/mainview/lib/rpc'
import { FiatProvider } from '../../../src/mainview/lib/fiat-context'
import type { ChainBalance, DeviceStateInfo, PendingSwap } from '../../../src/shared/types'
import '../../../src/mainview/i18n'
import '../../../src/mainview/index.css'
import '../../../src/mainview/styles/tokens.css'

const RetainedSwap = lazy(() => import('../../../src/mainview/components/SwapDialog').then(module => ({ default: module.SwapDialog })))
const params = new URLSearchParams(location.search)
;(window as any).__qaSwapCommand = (cmd: unknown) => dispatchLocalRpcMessage('swap-cmd', cmd)
const publicAddresses = {
  bitcoin: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  ethereum: '0x000000000000000000000000000000000000dEaD',
  zcash: 't1' + 'A'.repeat(33),
}
const balances: ChainBalance[] = [
  { chainId: 'bitcoin', symbol: 'BTC', balance: '0.25', balanceUsd: 16250, nativeBalanceUsd: 16250, priceUsd: 65000, address: publicAddresses.bitcoin, tokens: [], syncState: 'confirmed' },
  { chainId: 'ethereum', symbol: 'ETH', balance: '2', balanceUsd: 5000, nativeBalanceUsd: 5000, priceUsd: 2500, address: publicAddresses.ethereum, tokens: [], syncState: 'confirmed' },
  { chainId: 'zcash', symbol: 'ZEC', balance: '1.25', balanceUsd: 50, nativeBalanceUsd: 50, priceUsd: 40, address: publicAddresses.zcash, tokens: [], syncState: 'confirmed' },
]
const readyDevice: DeviceStateInfo = {
  state: 'ready', activeTransport: 'webusb', updatePhase: 'idle', bootloaderMode: false,
  needsBootloaderUpdate: false, needsFirmwareUpdate: false, needsInit: false,
  initialized: true, passphraseProtection: false, isOob: false, isEmulator: false,
  firmwareVersion: '7.17.0', label: 'Synthetic regression wallet',
}
const otherReceipt: PendingSwap = {
  txid: 'c'.repeat(64), fromChainId: 'bitcoin', toChainId: 'ethereum',
  fromAsset: 'BTC.BTC', toAsset: 'ETH.ETH',
  fromCaip: CHAINS.find(c => c.id === 'bitcoin')!.caip,
  toCaip: CHAINS.find(c => c.id === 'ethereum')!.caip,
  fromSymbol: 'BTC', toSymbol: 'ETH', fromAmount: '0.125',
  expectedOutput: '3', minimumOutput: '2.9', status: 'pending',
  confirmations: 0, requiredConfirmations: 1, createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000, estimatedTime: 60,
  memo: 'SYNTHETIC RESUMED RECEIPT', inboundAddress: publicAddresses.bitcoin,
  integration: 'thorchain',
}
function Fixture() {
  const [chainId, setChainId] = useState(params.get('chain') || 'ethereum')
  const [page, setPage] = useState(params.get('page') || 'asset')
  const [screen, setScreen] = useState(params.get('screen') || 'ready')
  const [settings, setSettings] = useState(false)
  const [history, setHistory] = useState(false)
  const [retainedSwapOpen, setRetainedSwapOpen] = useState(true)
  const [retainedResumeSwap, setRetainedResumeSwap] = useState<PendingSwap | null>(null)
  const [nav, setNav] = useState<NavTab>('vault')
  const [pinResult, setPinResult] = useState('')
  const [pinLength, setPinLength] = useState(0)
  const [pinSequence, setPinSequence] = useState(0)
  const chain = CHAINS.find(c => c.id === chainId) || CHAINS.find(c => c.id === 'ethereum')!
  const initialAction = params.get('action') as 'send' | 'receive' | 'swap' | undefined
  const device = screen === 'ready' ? readyDevice : { ...readyDevice, state: 'disconnected' as const }
  const changeScreen = (next: string) => {
    setScreen(next)
    ;(window as any).__fixturePush('device-state', next === 'ready' ? readyDevice : { ...readyDevice, state: next === 'pin' ? 'pin' : 'disconnected' })
  }
  return <>
    <TopNav connected={screen === 'ready'} label="Synthetic regression wallet" activeTab={nav} onTabChange={tab => { setNav(tab); setPage('dashboard') }} onSettingsToggle={() => setSettings(v => !v)} settingsOpen={settings} />
    <Box pt="70px" maxW="1440px" mx="auto" px="4">
      <Flex gap="2" align="center" wrap="wrap" mb="3" data-testid="fixture-controls">
        <Text fontSize="xs">Synthetic core QA — no real wallet, signing or remote network</Text>
        <Button size="xs" data-testid="fixture-portfolio" onClick={() => setPage('dashboard')}>Portfolio</Button>
        {['bitcoin', 'ethereum', 'zcash'].map(id => <Button key={id} size="xs" data-testid={`fixture-${id}`} onClick={() => { setChainId(id); setPage('asset') }}>{id}</Button>)}
        {params.has('retainSwap') && <Button size="xs" data-testid="fixture-retained-swap" onClick={() => setRetainedSwapOpen(true)}>Open retained swap</Button>}
        {params.has('retainSwap') && <Button size="xs" data-testid="fixture-resume-receipt" onClick={() => { setRetainedResumeSwap(otherReceipt); setRetainedSwapOpen(true) }}>Open another receipt</Button>}
        <Button size="xs" data-testid="fixture-history" onClick={() => setHistory(true)}>Swap history</Button>
        <Button size="xs" data-testid="fixture-disconnect" onClick={() => changeScreen('disconnected')}>Simulate disconnect</Button>
        <Button size="xs" data-testid="fixture-reconnect" onClick={() => changeScreen('ready')}>Simulate reconnect</Button>
        <Button size="xs" data-testid="fixture-pin" onClick={() => { setPinSequence(n => n + 1); changeScreen('pin') }}>Simulate PIN request</Button>
      </Flex>
      {pinResult && <Text data-testid="fixture-pin-result" data-pin-length={pinLength}>{pinResult}</Text>}
      {screen === 'disconnected' ? <Box data-testid="fixture-disconnected"><Text>KeepKey disconnected</Text><Button onClick={() => changeScreen('ready')}>Connect test device</Button></Box>
        : screen === 'pin' ? <PinEntry type="current" requestSeq={pinSequence} onSubmit={pin => { setPinLength(pin.length); setPinResult('Synthetic PIN accepted'); changeScreen('ready') }} onCancel={() => { setPinResult('PIN cancelled'); changeScreen('disconnected') }} />
        : page === 'dashboard' ? <Dashboard firmwareVersion="7.17.0" onOpenSettings={() => setSettings(true)} />
        : <AssetPage key={chain.id} chain={chain} balance={balances.find(b => b.chainId === chain.id)} firmwareVersion="7.17.0" initialAction={initialAction || 'receive'} watchOnly={params.has('watchOnly')} onBack={() => setPage('dashboard')} />}
    </Box>
    {params.has('retainSwap') && <Suspense fallback={null}><RetainedSwap open={retainedSwapOpen} onClose={() => { setRetainedSwapOpen(false); setRetainedResumeSwap(null) }} resumeSwap={retainedResumeSwap} chain={chain} balance={balances.find(b => b.chainId === chain.id)} address={balances.find(b => b.chainId === chain.id)?.address} /></Suspense>}
    <DeviceSettingsDrawer open={settings} onClose={() => setSettings(false)} onChooseNetworks={() => {}} deviceState={device} />
    <SwapHistoryDialog open={history} onClose={() => setHistory(false)} onResumeSwap={() => {}} />
  </>
}
createRoot(document.getElementById('root')!).render(<ChakraProvider value={system}><FiatProvider><Fixture /></FiatProvider></ChakraProvider>)
