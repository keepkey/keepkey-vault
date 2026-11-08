import { useState } from 'react'
import { Button, Flex, Text } from '@chakra-ui/react'
import type { PasswordBrowserTarget } from '../../shared/password-bank'
import { rpcRequest } from '../lib/rpc'
import { useUiTranslation } from '../i18n/ui'

/** Explicit field selection on a discovered, exact-origin browser document. */
export function PasswordBrowserFill({ id, pending, disabled }: { id: string; pending: boolean; disabled: boolean }) {
  const uiText = useUiTranslation()
  const [targets, setTargets] = useState<PasswordBrowserTarget[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const fields = targets.flatMap(target => target.targets.map(field => ({ target, field })))
  const discover = async () => {
    setBusy(true); setMessage(''); setSelected(''); setTargets([])
    try {
      const found = await rpcRequest<PasswordBrowserTarget[]>('passwordBankBrowserTargets', { id }, 30000)
      setTargets(found)
      if (!found.length) setMessage(uiText('No matching password field found. Open the saved login domain in BEX, enable Agent mode, and use the compatible extension update.'))
    } catch (e: any) { setMessage(e?.message || uiText('Could not reach BEX')) }
    finally { setBusy(false) }
  }
  const fill = async () => {
    const match = fields[Number(selected)]
    if (!match || selected === '') return
    setBusy(true); setMessage('')
    try {
      const { target, field } = match
      const { grant } = await rpcRequest<{ grant: string }>('passwordBankBrowserGrant', { id, pending, browser: target.browser, tabId: target.tabId, documentToken: target.documentToken, ref: field.ref })
      await rpcRequest('passwordBankBrowserFill', { grant })
      setMessage(uiText('Password filled. Review the browser and submit the form yourself.'))
    } catch (e: any) { setMessage(e?.message || uiText('Password fill failed. Review the field again.')) }
    finally { setTargets([]); setSelected(''); setBusy(false) }
  }
  return <Flex direction="column" gap="2" mt="3">
    <Flex gap="2" wrap="wrap" align="center">
      <Button size="xs" disabled={disabled || busy} onClick={() => void discover()}>{pending ? uiText('Find BEX field for staged password') : uiText('Find BEX login field')}</Button>
      {!!fields.length && <>
        <select aria-label={uiText('Browser password field')} value={selected} disabled={busy} style={{ background: '#17171b', color: '#eee', padding: 6, maxWidth: 500 }} onChange={e => setSelected(e.target.value)}>
          <option value="">{uiText('Choose the exact browser and password field')}</option>
          {fields.map(({ target, field }, index) => <option key={`${target.browser}:${target.tabId}:${field.ref}`} value={index}>{target.browser} · {target.origin} · {target.title} · {field.label}</option>)}
        </select>
        <Button size="xs" disabled={disabled || busy || selected === ''} onClick={() => void fill()}>{uiText('Fill selected field')}</Button>
      </>}
    </Flex>
    {message && <Text role="status" fontSize="sm" color="kk.textSecondary">{message}</Text>}
  </Flex>
}
