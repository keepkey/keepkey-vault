import { createRoot } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { Dashboard } from '../../../src/mainview/components/Dashboard'
import { system } from '../../../src/mainview/theme'
import { FiatProvider } from '../../../src/mainview/lib/fiat-context'
import '../../../src/mainview/i18n'
import '../../../src/mainview/index.css'
import '../../../src/mainview/styles/tokens.css'

// Real dashboard, synthetic transport. This fixture has no native bridge.
createRoot(document.getElementById('root')!).render(
  <ChakraProvider value={system}><FiatProvider>
    <Dashboard firmwareVersion="7.17.0" knownEmpty={new URLSearchParams(location.search).has('knownEmpty')} />
  </FiatProvider></ChakraProvider>,
)
