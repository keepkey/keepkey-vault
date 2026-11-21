import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'
import type { PasskeyInventoryView, PasskeyResetResult, PasskeySlotView, PasskeyStatus } from '../../shared/types'
import { rpcRequest } from '../lib/rpc'
import { useUiTranslation } from '../i18n/ui'

type ResetPhase = 'idle' | 'confirm' | 'working' | 'replug' | 'done'

/** Passkeys on the KeepKey: see the four slots, name a site, delete one, or erase them all.
 * The security-key PIN is held only in this component's memory while the tab is open. */
export function PasskeysView() {
  const uiText = useUiTranslation()
  const [status, setStatus] = useState<PasskeyStatus | null>(null)
  const [inventory, setInventory] = useState<PasskeyInventoryView | null>(null)
  const [error, setError] = useState('')
  const [pinInput, setPinInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<{ rpHash: string; draft: string } | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; confirmed: boolean } | null>(null)
  const [reset, setReset] = useState<ResetPhase>('idle')
  const pin = useRef('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pin.current = '' } }, [])

  const loadStatus = useCallback(async () => {
    try { const s = await rpcRequest<PasskeyStatus>('passkeysStatus', undefined, 15000); if (mounted.current) { setStatus(s); setError('') } }
    catch (e: any) { if (mounted.current) { setStatus(null); setError(e?.message || uiText('Could not reach the KeepKey passkey interface')) } }
  }, [uiText])
  useEffect(() => { void loadStatus() }, [loadStatus])

  const loadList = useCallback(async (usePin: string) => {
    const inv = await rpcRequest<PasskeyInventoryView>('passkeysList', { pin: usePin }, 30000)
    if (mounted.current) { pin.current = usePin; setInventory(inv); setError('') }
  }, [])
  const run = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (e: any) { if (mounted.current) { setError(e?.message || uiText('Something went wrong')); void loadStatus() } }
    finally { if (mounted.current) setBusy(false) }
  }

  const submitPin = () => run(async () => {
    const value = pinInput; setPinInput('')
    if (!status?.pinSet) { await rpcRequest('passkeysSetPin', { pin: value }, 15000); await loadStatus() }
    await loadList(value)
  })
  const saveLabel = () => run(async () => {
    if (!renaming) return
    await rpcRequest('passkeysSetLabel', { rpHash: renaming.rpHash, label: renaming.draft })
    setRenaming(null); await loadList(pin.current)
  })
  const confirmDelete = () => run(async () => {
    if (!deleting) return
    setDeleting({ ...deleting, confirmed: true })
    try { await rpcRequest('passkeysDelete', { pin: pin.current, credentialId: deleting.id }, 60000) } finally { setDeleting(null) }
    await loadList(pin.current); await loadStatus()
  })
  const erase = () => run(async () => {
    setReset('working')
    try {
      let r = await rpcRequest<PasskeyResetResult>('passkeysReset', undefined, 130000)
      if (r.replug) { setReset('replug'); r = await rpcRequest<PasskeyResetResult>('passkeysReset', { waitForReplug: true }, 130000) }
      pin.current = ''; setInventory(null); setReset('done'); await loadStatus()
    } catch (e) { setReset('confirm'); throw e }
  })

  const capacity = inventory ? inventory.used + inventory.remaining : 4
  const slotName = (s: PasskeySlotView) => s.label || uiText('Unknown site')
  const tile = (children: React.ReactNode, key: string, dashed = false) => (
    <Box key={key} border="1px" borderStyle={dashed ? 'dashed' : 'solid'} borderColor="kk.border" borderRadius="md" p="3" minH="64px">{children}</Box>
  )

  return (
    <Box px="5" py="4">
      <Flex direction="column" gap="3">
        <Flex justify="space-between" align="center" gap="3" wrap="wrap">
          <Text fontSize="lg" fontWeight="600" color="kk.textPrimary">{uiText('Passkeys')}</Text>
          {status && <Text fontSize="sm" color="kk.textSecondary">{uiText('Security key PIN')}: {status.pinSet ? `${uiText('set')}${status.pinRetries != null ? ` (${status.pinRetries})` : ''}` : uiText('not set')}</Text>}
        </Flex>
        {error && <Text role="alert" fontSize="sm" color="kk.error">{error}</Text>}

        {!status && <Button size="sm" variant="ghost" alignSelf="start" onClick={() => void loadStatus()}>{uiText('Refresh')}</Button>}

        {status && !status.credMgmt && (
          <Text fontSize="sm" color="kk.textSecondary">{uiText('This KeepKey firmware cannot list or delete single passkeys. Update to firmware 7.17 RC4 or newer.')}</Text>
        )}

        {status?.credMgmt && !inventory && (
          <Flex direction="column" gap="2">
            <Text fontSize="sm" color="kk.textSecondary">
              {status.pinSet ? uiText('Enter your security key PIN to see your passkeys. It is not your KeepKey PIN.') : uiText('Set a security key PIN to manage passkeys. Websites ask for it when you save one. It is not your KeepKey PIN.')}
            </Text>
            <Flex gap="2">
              <Input size="sm" type="password" autoComplete="off" maxW="260px" value={pinInput} onChange={e => setPinInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && pinInput.length >= 4) void submitPin() }}
                aria-label={uiText('Security key PIN')} placeholder={status.pinSet ? uiText('Security key PIN') : uiText('New PIN, 4 or more characters')} />
              <Button size="sm" onClick={() => void submitPin()} disabled={busy || pinInput.length < 4} loading={busy}>
                {status.pinSet ? uiText('Show passkeys') : uiText('Set PIN')}
              </Button>
            </Flex>
          </Flex>
        )}

        {inventory && (
          <Flex direction="column" gap="2">
            <Flex justify="space-between" align="center">
              <Text fontSize="sm" color="kk.textPrimary">{inventory.used} / {capacity} {uiText('slots used')}</Text>
              <Button size="xs" variant="ghost" onClick={() => void run(() => loadList(pin.current))} disabled={busy}>{uiText('Refresh')}</Button>
            </Flex>
            {inventory.slots.map(s => tile(
              <Flex justify="space-between" align="center" gap="3" wrap="wrap">
                <Box minW="0">
                  <Text fontSize="sm" fontWeight="600" color={s.labelSource === 'unknown' ? 'kk.textSecondary' : 'kk.textPrimary'} wordBreak="break-all">{slotName(s)}</Text>
                  <Text fontSize="xs" color="kk.textSecondary" wordBreak="break-all">{s.userName || uiText('No account name')}{s.labelSource === 'unknown' ? ` · ${s.rpHash.slice(0, 8)}…` : ''}</Text>
                </Box>
                {renaming?.rpHash === s.rpHash ? (
                  <Flex gap="2">
                    <Input size="xs" maxW="180px" maxLength={40} value={renaming.draft} onChange={e => setRenaming({ rpHash: s.rpHash, draft: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter') void saveLabel() }} aria-label={uiText('Site name')} autoFocus />
                    <Button size="xs" onClick={() => void saveLabel()} disabled={busy}>{uiText('Save')}</Button>
                    <Button size="xs" variant="ghost" onClick={() => setRenaming(null)}>{uiText('Cancel')}</Button>
                  </Flex>
                ) : deleting?.id === s.credentialId ? (
                  <Flex gap="2" align="center" wrap="wrap">
                    <Text fontSize="xs" color="kk.error">{deleting.confirmed ? uiText('Hold the button on your KeepKey…') : uiText('Delete this passkey? Sign-ins with it stop working.')}</Text>
                    {!deleting.confirmed && <Button size="xs" colorPalette="red" onClick={() => void confirmDelete()} disabled={busy}>{uiText('Delete')}</Button>}
                    {!deleting.confirmed && <Button size="xs" variant="ghost" onClick={() => setDeleting(null)}>{uiText('Cancel')}</Button>}
                  </Flex>
                ) : (
                  <Flex gap="2">
                    <Button size="xs" variant="ghost" onClick={() => setRenaming({ rpHash: s.rpHash, draft: s.label })} disabled={busy}>{uiText('Name')}</Button>
                    <Button size="xs" variant="outline" colorPalette="red" onClick={() => setDeleting({ id: s.credentialId, confirmed: false })} disabled={busy}>{uiText('Delete')}</Button>
                  </Flex>
                )}
              </Flex>, s.credentialId))}
            {Array.from({ length: Math.max(0, capacity - inventory.slots.length) }, (_, i) => tile(<Text fontSize="sm" color="kk.textSecondary">{uiText('Empty')}</Text>, `empty-${i}`, true))}
          </Flex>
        )}

        <Text fontSize="xs" color="kk.textSecondary">{uiText('Your recovery phrase cannot restore passkeys. Keep a backup sign-in on every site.')}</Text>

        <Box borderTop="1px" borderColor="kk.border" pt="3">
          {reset === 'idle' || reset === 'done' ? (
            <Flex gap="3" align="center" wrap="wrap">
              <Button size="sm" colorPalette="red" variant="outline" onClick={() => setReset('confirm')} disabled={busy || !status}>{uiText('Erase all passkeys…')}</Button>
              {reset === 'done' && <Text role="status" fontSize="sm" color="kk.textPrimary">{uiText('Passkeys erased.')}</Text>}
            </Flex>
          ) : (
            <Box role="alertdialog" aria-label={uiText('Erase all passkeys')} border="1px" borderColor="kk.error" borderRadius="md" p="3">
              <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{uiText('Erase all passkeys on this KeepKey?')}</Text>
              <Text fontSize="sm" color="kk.textSecondary" mt="1">{uiText('Every passkey and the security key PIN are deleted, and sites that use this KeepKey as a security key stop recognising it. Funds are not touched.')}</Text>
              {reset === 'replug' && <Text fontSize="sm" color="kk.textPrimary" mt="2">{uiText('Unplug your KeepKey and plug it back in, then hold the button when it asks.')}</Text>}
              {reset === 'working' && <Text fontSize="sm" color="kk.textPrimary" mt="2">{uiText('Hold the button on your KeepKey…')}</Text>}
              <Flex gap="2" mt="3">
                {reset === 'confirm' && <Button size="sm" colorPalette="red" onClick={() => void erase()} disabled={busy}>{uiText('Erase passkeys')}</Button>}
                <Button size="sm" variant="ghost" onClick={() => setReset('idle')} disabled={busy}>{uiText('Cancel')}</Button>
              </Flex>
            </Box>
          )}
        </Box>
      </Flex>
    </Box>
  )
}
