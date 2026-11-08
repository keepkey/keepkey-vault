import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChakraProvider, Box } from '@chakra-ui/react'
import { system } from '../../../src/mainview/theme'
import { TopNav, type NavTab } from '../../../src/mainview/components/TopNav'
import { DeviceSettingsDrawer } from '../../../src/mainview/components/DeviceSettingsDrawer'
import { VaultToolsButton } from '../../../src/mainview/components/VaultToolsButton'
import { FiatProvider } from '../../../src/mainview/lib/fiat-context'
import '../../../src/mainview/i18n'
import '../../../src/mainview/index.css'
import '../../../src/mainview/styles/tokens.css'

function Fixture() {
  const [settings, setSettings] = useState(false)
  const [tab, setTab] = useState<NavTab>('vault')
  return <>
    <TopNav connected label="Synthetic test KeepKey" activeTab={tab} onTabChange={setTab} onSettingsToggle={() => setSettings(v => !v)} settingsOpen={settings} />
    <Box pt="70px"><p data-testid="fixture-home">Synthetic test wallet. No real device or passwords.</p><VaultToolsButton seedVaultAvailable /></Box>
    <DeviceSettingsDrawer open={settings} onClose={() => setSettings(false)} onChooseNetworks={() => {}} deviceState={{ state: 'ready', activeTransport: 'webusb', updatePhase: 'idle', bootloaderMode: false, needsBootloaderUpdate: false, needsFirmwareUpdate: false, needsInit: false, initialized: true, passphraseProtection: false, isOob: false, isEmulator: false, firmwareVersion: '7.17.0', label: 'Synthetic test KeepKey' }} />
  </>
}
createRoot(document.getElementById('root')!).render(<ChakraProvider value={system}><FiatProvider><Fixture /></FiatProvider></ChakraProvider>)
