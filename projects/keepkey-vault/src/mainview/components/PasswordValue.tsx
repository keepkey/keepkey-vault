import { useEffect, useRef, useState } from 'react'
import { Button, Flex, Input, Text } from '@chakra-ui/react'
import { rpcRequest } from '../lib/rpc'
import { useUiTranslation } from '../i18n/ui'

/** Native-only reveal. The masked view never fetches the password. */
export function PasswordValue({ id, pending, disabled, beforeReveal }: {
  id: string; pending: boolean; disabled: boolean; beforeReveal: () => Promise<void>
}) {
  const uiText = useUiTranslation()
  const [value, setValue] = useState<{ password: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const sequence = useRef(0)
  const mounted = useRef(true)
  const hide = () => { sequence.current++; setValue(null); setMessage('') }
  useEffect(() => {
    mounted.current = true
    const visibility = () => { if (document.hidden) hide() }
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', visibility)
    return () => { mounted.current = false; sequence.current++; window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', visibility) }
  }, [])
  useEffect(() => {
    if (!value) return
    const timer = setTimeout(hide, Math.max(0, value.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [value])
  const toggle = async () => {
    if (value) { hide(); return }
    if (busy || disabled) return
    const request = ++sequence.current
    setBusy(true); setMessage('')
    try {
      await beforeReveal()
      const next = await rpcRequest<{ password: string; expiresAt: number }>('passwordBankReveal', { id, pending })
      if (mounted.current && sequence.current === request && !document.hidden) setValue(next)
      else if (mounted.current) setMessage(uiText('Ready. Press the eye to show.'))
    } catch (e: any) { if (mounted.current) setMessage(e?.message || uiText('Could not show password')) }
    finally { if (mounted.current) setBusy(false) }
  }
  const copy = async () => {
    if (!value || Date.now() >= value.expiresAt) { hide(); return }
    try { await navigator.clipboard.writeText(value.password); if (mounted.current) setMessage(uiText('Copied')) }
    catch { if (mounted.current) setMessage(uiText('Clipboard unavailable')) }
  }
  return <Flex direction="column" gap="1" mt="3" maxW="370px">
    <Flex gap="1" align="center">
      <Input aria-label={pending ? uiText('New password') : uiText('Saved password')} type={value ? 'text' : 'password'} value={value?.password || '••••••••••••••••'} readOnly autoComplete="off" data-keepkey-secret="true" size="sm" minW="0" fontFamily="mono" />
      <Button size="sm" variant="ghost" color="kk.textSecondary" aria-label={value ? uiText('Hide password') : uiText('Show password')} aria-pressed={!!value} disabled={busy || disabled} onClick={() => void toggle()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{value && <path d="m3 3 18 18" />}</svg>
      </Button>
      <Button size="sm" variant="ghost" color="kk.textSecondary" aria-label={uiText('Copy password')} disabled={busy || disabled || !value} onClick={() => void copy()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3" /></svg>
      </Button>
    </Flex>
    {(busy || message) && <Text role="status" fontSize="xs" color="kk.textSecondary">{busy ? uiText('Confirm on KeepKey if asked') : message}</Text>}
  </Flex>
}
