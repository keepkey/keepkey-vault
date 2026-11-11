import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChakraProvider, Box, Button, Flex, Text } from '@chakra-ui/react'
import { system } from '../../../src/mainview/theme'
import { AssetPage } from '../../../src/mainview/components/AssetPage'
import { CHAINS } from '../../../src/shared/chains'
import { FiatProvider } from '../../../src/mainview/lib/fiat-context'
import { rpcRequest } from '../../../src/mainview/lib/rpc'
import '../../../src/mainview/i18n'
import '../../../src/mainview/index.css'
import '../../../src/mainview/styles/tokens.css'

const chain=CHAINS.find(c=>c.id==='zcash')!
const params=new URLSearchParams(location.search)
const shielded={symbol:'zZEC',name:'Shielded ZEC',caip:chain.caip+'/shielded',type:'shielded' as const,balance:'2',balanceUsd:0,priceUsd:0}
const balance={chainId:'zcash',symbol:'ZEC',balance:'1.25',balanceUsd:0,address:'t1'+'A'.repeat(33),tokens:[]}
function Fixture(){
 const [enabled,setEnabled]=useState(true)
 return <Box maxW="1000px" mx="auto" p="4">
  <Flex gap="3" align="center" mb="4"><Text fontSize="12px">Synthetic Zcash UI — no real wallet</Text><Button size="xs" data-testid="toggle-privacy" onClick={async()=>{await rpcRequest('testSetPrivacy',{enabled:!enabled});setEnabled(!enabled);window.dispatchEvent(new Event('keepkey-settings-changed'))}}>Toggle privacy flag</Button></Flex>
  <AssetPage chain={chain} balance={balance} firmwareVersion={params.has('oldFirmware')?'7.14.0':'7.15.0'} onBack={()=>{}} initialToken={params.has('shielded')?shielded:undefined}
   initialAction={params.has('legacyPrivacy')?'privacy':params.has('send')?'send':'receive'} watchOnly={params.has('watchOnly')}/>
 </Box>
}
createRoot(document.getElementById('root')!).render(<ChakraProvider value={system}><FiatProvider><Fixture/></FiatProvider></ChakraProvider>)
