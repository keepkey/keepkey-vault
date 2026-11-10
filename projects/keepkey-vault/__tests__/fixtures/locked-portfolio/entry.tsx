import { createRoot } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { system } from '../../../src/mainview/theme'
import App from '../../../src/mainview/App'
import '../../../src/mainview/i18n'
import '../../../src/mainview/index.css'
import '../../../src/mainview/styles/tokens.css'
createRoot(document.getElementById('root')!).render(<ChakraProvider value={system}><App /></ChakraProvider>)
