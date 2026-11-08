import { Box, Text } from '@chakra-ui/react'
import type { MoneroStatus } from '../../shared/types'
import { useUiTranslation } from '../i18n/ui'
import { getNumberLocale } from '../lib/number-locale'

/** Public connection diagnostics only. No view key, credentials or protocol details. */
export function MoneroConnectionDetails({status}:{status:MoneroStatus|null}) {
 const uiText=useUiTranslation(),info=status?.connection
 if(!info)return null
 const current=info.attempts.find(node=>node.url===info.activeNode)
 const time=(value:string)=>new Date(value).toLocaleTimeString(getNumberLocale())
 const state=info.state==='checking'?uiText('Checking remote node…'):info.state==='switching'?uiText('Trying another remote node…')
  :info.state==='waiting'?uiText('No remote node is responding. Automatic retry is scheduled.')
  :info.state==='failed'?uiText('The current node did not respond.')
  :info.state==='connected'?uiText('Wallet synced'):info.state==='scanning'?uiText('Node connected; scanning wallet history.'):null
 return <Box data-monero-connection-info="" fontSize="12px" color="var(--text-2)" mb="3">
  {state&&<Text role="status">{state}</Text>}
  <Text>{uiText('Active node')}: {info.activeNode}</Text>
  {info.automaticFailover&&<Text>{uiText('Automatic remote failover is on.')}</Text>}
  {info.retryAt&&<Text>{uiText('Next retry')}: {time(info.retryAt)}</Text>}
  {info.pausedForTransaction&&<Text>{uiText('Automatic node changes are paused while a transaction review or broadcast is pending.')}</Text>}
  <details><summary style={{cursor:'pointer',marginTop:8}}>{uiText('Connection status and recent attempts')}</summary>
   {current?.height!==undefined&&<Text>{uiText('Node height (reported)')}: {current.height.toLocaleString(getNumberLocale())}</Text>}
   {current?.lastResponseAt&&<Text>{uiText('Last successful node response')}: {time(current.lastResponseAt)}{current.latencyMs===undefined?'':` · ${current.latencyMs} ms`}</Text>}
   <Text>{uiText('Wallet scan height')}: {status?.walletHeight?status.walletHeight.toLocaleString(getNumberLocale()):uiText('Not reported yet')}</Text>
   {status?.updatedAt&&<Text>{uiText('Last wallet update')}: {time(status.updatedAt)}</Text>}
   {info.attempts.map(node=><Box key={node.url} mt="2"><Text>{node.url}</Text><Text>{node.state==='untested'?uiText('Not tried yet'):node.state==='checking'?uiText('Checking…'):node.state==='responding'?uiText('Responding'):uiText('Failed')}{node.checkedAt?` · ${time(node.checkedAt)}`:''}</Text>{node.error&&<Text>{node.error}</Text>}</Box>)}
  </details>
 </Box>
}
