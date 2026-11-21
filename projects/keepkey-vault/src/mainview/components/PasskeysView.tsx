import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Text } from '@chakra-ui/react'
import type { PasskeyStatus } from '../../shared/types'
import { rpcRequest } from '../lib/rpc'
import { useUiTranslation } from '../i18n/ui'

/** Status and reset for the KeepKey's built-in passkeys. Sites register and sign in with the
 * device directly; firmware 7.17 cannot list or delete a single passkey, so reset is the only
 * management action and the copy says so. */
export function PasskeysView() {
  const uiText = useUiTranslation()
  const [status, setStatus] = useState<PasskeyStatus | null>(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [done, setDone] = useState(false)
  const mounted = useRef(true)
  const load = useCallback(async () => {
    setError('')
    try { const next = await rpcRequest<PasskeyStatus>('passkeysStatus', undefined, 15000); if (mounted.current) setStatus(next) }
    catch (e: any) { if (mounted.current) { setStatus(null); setError(e?.message || uiText('Could not reach the KeepKey passkey interface')) } }
  }, [uiText])
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false } }, [load])
  const reset = async () => {
    setResetting(true); setError(''); setDone(false)
    try { await rpcRequest('passkeysReset', undefined, 50000); if (mounted.current) { setDone(true); setConfirming(false) } }
    catch (e: any) { if (mounted.current) setError(e?.message || uiText('Reset did not complete')) }
    finally { if (mounted.current) { setResetting(false); void load() } }
  }
  return (
    <Box px="5" py="4">
      <Flex direction="column" gap="4">
        <Flex justify="space-between" align="center" gap="3" wrap="wrap">
          <Text fontSize="lg" fontWeight="600" color="kk.textPrimary">{uiText('Passkeys')}</Text>
          {status && <Text fontSize="sm" color="kk.textSecondary">{uiText('Ready')} · {uiText('Security key PIN')}: {status.pinSet ? `${uiText('set')}${status.pinRetries != null ? ` (${status.pinRetries})` : ''}` : uiText('not set')}</Text>}
        </Flex>
        <Text fontSize="sm" color="kk.textSecondary">{uiText('Sites save passkeys on your KeepKey, up to 4. A full KeepKey refuses new ones.')}</Text>
        <Text fontSize="sm" color="kk.textPrimary">{uiText('Your recovery phrase cannot restore passkeys. Keep a backup sign-in on every site.')}</Text>
        {error && <Text role="alert" fontSize="sm" color="kk.error">{error}</Text>}
        <Flex gap="2" wrap="wrap">
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={resetting}>{uiText('Refresh')}</Button>
          {!confirming && <Button size="sm" colorPalette="red" variant="outline" onClick={() => { setConfirming(true); setDone(false) }} disabled={resetting || !status}>{uiText('Reset passkeys…')}</Button>}
        </Flex>
        {done && <Text role="status" fontSize="sm" color="kk.textPrimary">{uiText('Passkeys erased. The KeepKey is ready for new ones.')}</Text>}
        {confirming && (
          <Box role="alertdialog" aria-label={uiText('Reset passkeys')} border="1px solid" borderColor="kk.error" borderRadius="md" p="3">
            <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{uiText('Erase all passkeys on this KeepKey?')}</Text>
            <Text fontSize="sm" color="kk.textSecondary" mt="1">{uiText('Every passkey and the security key PIN are deleted, and sites that use this KeepKey as a security key stop recognising it. Funds are not touched. You confirm on the KeepKey.')}</Text>
            <Flex gap="2" mt="3">
              <Button size="sm" colorPalette="red" onClick={() => void reset()} loading={resetting}>{resetting ? uiText('Confirm on your KeepKey…') : uiText('Erase passkeys')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={resetting}>{uiText('Cancel')}</Button>
            </Flex>
          </Box>
        )}
      </Flex>
    </Box>
  )
}
