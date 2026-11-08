import { useState } from 'react'
import { Button, Flex, Text } from '@chakra-ui/react'
import type { PasswordBrowserTarget } from '../../shared/password-bank'
import { rpcRequest } from '../lib/rpc'
import { useUiTranslation } from '../i18n/ui'

/** Explicit field selection on a discovered, exact-origin browser document. */
export function PasswordBrowserFill({ id, pending, disabled, beforeFill }: { id: string; pending: boolean; disabled: boolean; beforeFill?: () => Promise<void> }) {
  const uiText = useUiTranslation()
  const [targets, setTargets] = useState<PasswordBrowserTarget[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const fields = targets.flatMap(target => target.targets.map(field => ({ target, field })))
  const discover = async () => {
    setBusy(true); setMessage(''); setSelected(''); setTargets([])
    try {
      await beforeFill?.()
      const found = await rpcRequest<PasswordBrowserTarget[]>('passwordBankBrowserTargets', { id }, 30000)
      setTargets(found)
      const fields = found.flatMap(target => target.targets.map(field => ({ target, field })))
      if (fields.length === 1) { await fillMatch(fields[0]); return }
      if (!found.length) setMessage(uiText('No matching password field found. Open the saved login domain in BEX, enable Agent mode, and use the compatible extension update.'))
    } catch (e: any) { setMessage(e?.message || uiText('Could not reach BEX')) }
    finally { setBusy(false) }
  }
  const fillMatch = async (match: { target: PasswordBrowserTarget; field: PasswordBrowserTarget['targets'][number] }) => {
    setBusy(true); setMessage('')
    try {
      const { target, field } = match
      const { grant } = await rpcRequest<{ grant: string }>('passwordBankBrowserGrant', { id, pending, browser: target.browser, tabId: target.tabId, documentToken: target.documentToken, ref: field.ref })
      await rpcRequest('passwordBankBrowserFill', { grant })
      setMessage(uiText('Filled. Review the browser to continue.'))
    } catch (e: any) { setMessage(e?.message || uiText('Password fill failed. Review the field again.')) }
    finally { setTargets([]); setSelected(''); setBusy(false) }
  }
  return <Flex direction="column" gap="2">
    <Flex gap="2" wrap="wrap" align="center">
      <Button size="xs" disabled={disabled || busy} onClick={() => void discover()}>{busy ? uiText('Connecting…') : uiText('Fill in browser')}</Button>
      {!!fields.length && <>
        <select aria-label={uiText('Browser password field')} value={selected} disabled={busy} style={{ background: '#17171b', color: '#eee', padding: 6, maxWidth: 500 }} onChange={e => setSelected(e.target.value)}>
          <option value="">{uiText('Choose the exact browser and password field')}</option>
          {fields.map(({ target, field }, index) => <option key={`${target.browser}:${target.tabId}:${field.ref}`} value={index}>{new URL(target.origin).hostname} · {target.title} · {field.label}</option>)}
        </select>
        <Button size="xs" disabled={disabled || busy || selected === ''} onClick={() => { const match = fields[Number(selected)]; if (match && selected !== '') void fillMatch(match) }}>{uiText('Fill selected field')}</Button>
      </>}
    </Flex>
    {message && <Text role="status" fontSize="sm" color="kk.textSecondary">{message}</Text>}
  </Flex>
}
