import { useEffect, useState } from 'react'
import { Box, Button, Flex, Text } from '@chakra-ui/react'
import type { PasswordAgentApproval } from '../../shared/password-bank'
import { onRpcMessage, rpcRequest } from '../lib/rpc'
import { useUiTranslation } from '../i18n/ui'
import { Z } from '../lib/z-index'

export function PasswordAgentApprovalDialog() {
  const uiText = useUiTranslation()
  const [request, setRequest] = useState<PasswordAgentApproval | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => onRpcMessage('password-agent-approval', value => { setRequest(value.approval as PasswordAgentApproval | null); setError(''); setBusy(false) }), [])
  useEffect(() => {
    if (!request) return
    const timer = setTimeout(() => setRequest(null), Math.max(0, request.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [request])
  if (!request) return null
  const decide = async (approve: boolean) => {
    setBusy(true); setError('')
    try { await rpcRequest(approve ? 'passwordAgentApproveFill' : 'passwordAgentRejectFill', { id: request.id }); setRequest(null) }
    catch (e: any) { setError(e?.message || uiText('Could not resolve the password request')); setBusy(false) }
  }
  return <Box position="fixed" inset="0" zIndex={Z.dialog + 5} bg="blackAlpha.800" display="grid" placeItems="center">
    <Box role="dialog" aria-modal="true" aria-label={uiText('Approve agent password fill')} bg="kk.bg" color="kk.textPrimary" border="1px solid" borderColor="kk.gold" borderRadius="xl" p="6" maxW="520px" w="90vw">
      <Text fontSize="xl" fontWeight="600" mb="3">{uiText('Approve agent password fill')}</Text>
      <Text mb="2">{request.account}</Text>
      <Text color="kk.gold" mb="2">{request.origin}</Text>
      <Text fontSize="sm" color="kk.textSecondary">{uiText('Browser')}: {request.browser} · {uiText('Tab')}: {request.tabId}</Text>
      <Text fontSize="sm" color="kk.textSecondary">{uiText('Field')}: {request.fieldLabel}</Text>
      <Text fontSize="sm" mt="3">{request.pending ? uiText('Fill the staged password for this rotation.') : uiText('Fill the current password for this account.')}</Text>
      <Text fontSize="sm" mt="2" color="kk.textMuted">{uiText('The agent receives only the result. This fills one field and does not explicitly submit the form.')}</Text>
      {error && <Text role="alert" color="red.300" mt="3">{error}</Text>}
      <Flex justify="flex-end" gap="3" mt="5"><Button disabled={busy} onClick={() => void decide(false)}>{uiText('Reject')}</Button><Button disabled={busy} onClick={() => void decide(true)}>{uiText('Approve this fill')}</Button></Flex>
    </Box>
  </Box>
}
