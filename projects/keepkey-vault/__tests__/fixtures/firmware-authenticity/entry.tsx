import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChakraProvider, Text } from '@chakra-ui/react'
import { system } from '../../../src/mainview/theme'
import { OobSetupWizard } from '../../../src/mainview/components/OobSetupWizard'
import '../../../src/mainview/i18n'
import '../../../src/mainview/index.css'
import '../../../src/mainview/styles/tokens.css'

// The production wizard and hooks run unchanged against index.html's synthetic
// transport. This entry cannot connect to Vault, native USB or an app database.
function Fixture() {
  const [complete, setComplete] = useState(false)
  return complete
    ? <Text data-testid="fixture-complete">Synthetic wizard complete</Text>
    : <OobSetupWizard onComplete={() => setComplete(true)} />
}

createRoot(document.getElementById('root')!).render(
  <ChakraProvider value={system}><Fixture /></ChakraProvider>,
)
