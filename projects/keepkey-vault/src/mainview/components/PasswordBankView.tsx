import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'
import { PASSWORD_ROTATION_GUIDES, type PasswordBankView as BankView } from '../../shared/password-bank'
import { rpcRequest } from '../lib/rpc'
import { useUiTranslation } from '../i18n/ui'
import { PasswordBrowserFill } from './PasswordBrowserFill'

export function PasswordBankView() {
  const uiText = useUiTranslation()
  const [bank, setBank] = useState<BankView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [count, setCount] = useState(3)
  const [ttlMinutes, setTtlMinutes] = useState(15)
  const [origin, setOrigin] = useState('')
  const [account, setAccount] = useState('')
  const [reviewDays, setReviewDays] = useState(90)
  const [backupRevision, setBackupRevision] = useState<number | null>(null)
  const [verified, setVerified] = useState<Record<string, boolean>>({})
  const [reveal, setReveal] = useState<{ id: string; pending: boolean; password: string; expiresAt: number } | null>(null)
  const mounted = useRef(true)
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++revision.current
    const next = await rpcRequest<BankView>('passwordBankStatus')
    if (mounted.current && revision.current === current) setBank(next)
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh().catch(() => { if (mounted.current) setError(uiText('Could not load the password bank')) })
    const timer = setInterval(() => { void refresh().catch(() => {}) }, 2000)
    const hide = () => { if (document.hidden) setReveal(null) }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('blur', hide)
    return () => { mounted.current = false; revision.current++; clearInterval(timer); document.removeEventListener('visibilitychange', hide); window.removeEventListener('blur', hide) }
  }, [refresh, uiText])
  useEffect(() => {
    if (!reveal) return
    const timer = setTimeout(() => setReveal(null), Math.max(0, reveal.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [reveal])
  useEffect(() => { if (!bank?.unlocked) setReveal(null) }, [bank?.unlocked])
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(''); setReveal(null)
    try { await work() }
    catch (e: any) { if (mounted.current) setError(typeof e?.message === 'string' ? e.message : uiText('Password operation failed')) }
    finally { if (mounted.current) { setBusy(false); void refresh().catch(() => {}) } }
  }
  const deviceCall = (method: string, params?: unknown) => rpcRequest(method, params, 600000)
  const show = (id: string, pending: boolean) => run(async () => {
    const value = await rpcRequest<{ password: string; expiresAt: number }>('passwordBankReveal', { id, pending })
    if (mounted.current) setReveal({ id, pending, ...value })
  })
  const rotate = (id: string, action: string) => run(async () => {
    await rpcRequest('passwordBankRotate', { id, action, confirmed: verified[id] === true })
    setVerified(v => ({ ...v, [id]: false }))
  })
  const exportBackup = () => run(async () => {
    const result = await rpcRequest<{ json: string; revision: number }>('passwordBankExport')
    const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = `keepkey-password-bank-${Date.now()}.json`
    document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setBackupRevision(result.revision)
  })
  const importBackup = (file?: File) => {
    if (!file) return
    void run(async () => {
      if (file.size > 2_000_000) throw new Error(uiText('Backup file is too large'))
      await deviceCall('passwordBankImport', { json: await file.text() })
    })
  }
  const card = { bg: 'kk.cardBg', border: '1px solid', borderColor: 'kk.border', borderRadius: 'xl', p: '5' } as const
  const selectStyle = { background: '#17171b', color: '#eee', border: '1px solid #36363c', borderRadius: 6, padding: 8 }

  return <Box maxW="1100px" w="100%" mx="auto" p={{ base: '4', md: '7' }} data-testid="password-bank">
    <Flex justify="space-between" align="center" gap="3" mb="2">
      <Box><Text fontSize="2xl" fontWeight="600">{uiText('Passwords')}</Text><Text color="kk.textMuted" fontSize="sm">{uiText('A recoverable password bank, approved by your KeepKey.')}</Text></Box>
      <Text fontSize="xs" color="kk.gold" border="1px solid" borderColor="kk.border" px="2" py="1" borderRadius="md">{uiText('Experimental MVP')}</Text>
    </Flex>
    <Text fontSize="sm" color="kk.textSecondary" mb="5">{uiText('Keep your seed, wallet passphrase and encrypted account backup. All three are needed to restore your assigned passwords.')}</Text>
    {error && <Box role="alert" border="1px solid" borderColor="red.600" p="3" mb="4" borderRadius="md"><Text color="red.300">{error}</Text></Box>}
    {busy && <Text role="status" color="kk.gold" mb="4">{uiText('Working. Confirm any request on your KeepKey. Each generated entry requires approval.')}</Text>}
    {!bank && <Text>{uiText('Loading password bank…')}</Text>}
    {bank && !bank.enabled && <Text>{uiText('Password manager is disabled. Enable it in Settings → Feature flags.')}</Text>}
    {bank?.enabled && !bank.unlocked && <Box {...card}>
      <Text fontSize="lg" fontWeight="600" mb="2">{bank.exists ? uiText('Unlock your password bank') : uiText('Create your password bank')}</Text>
      <Text color="kk.textSecondary" mb="4">{uiText('Connect a KeepKey with multi-chain firmware and confirm on its screen. Passwords stay out of persistent storage; the session cache clears when you lock, disconnect, disable this feature or restart Vault.')}</Text>
      <Flex gap="3" wrap="wrap">
        <Button disabled={busy} onClick={() => void run(() => deviceCall('passwordBankUnlock', { create: !bank.exists }))}>{bank.exists ? uiText('Unlock with KeepKey') : uiText('Create with KeepKey')}</Button>
        {!bank.exists && <Box as="label" cursor={busy ? 'wait' : 'pointer'} p="2" border="1px solid" borderColor="kk.border" borderRadius="md">{uiText('Restore encrypted backup')}<input aria-label={uiText('Restore encrypted backup')} type="file" accept="application/json,.json" disabled={busy} style={{ display: 'none' }} onChange={e => { importBackup(e.target.files?.[0]); e.target.value = '' }} /></Box>}
      </Flex>
    </Box>}
    {bank?.unlocked && <>
      <Flex gap="3" mb="4" align="center" wrap="wrap">
        <Text fontSize="sm" color="kk.textSecondary">{uiText('Session locks after 15 minutes. Cache expiry never changes a website password.')}</Text>
        <Button size="sm" disabled={busy} onClick={() => void run(() => rpcRequest('passwordBankLock'))}>{uiText('Lock now')}</Button>
        <Button size="sm" disabled={busy} onClick={() => void exportBackup()}>{uiText('Export recovery backup')}</Button>
      </Flex>
      {bank.backupRequired && <Box {...card} mb="4" borderColor="kk.gold"><Text fontWeight="600">{uiText('Recovery backup needs updating')}</Text><Text fontSize="sm" color="kk.textSecondary">{uiText('New assignments and pending rotations must be backed up before changing a website password.')}</Text></Box>}
      {backupRevision !== null && <Flex {...card} gap="3" mb="4" align="center"><Text fontSize="sm">{uiText('Save the downloaded backup somewhere separate from this computer.')}</Text><Button size="sm" disabled={busy || backupRevision !== bank.revision} onClick={() => void run(async () => { await rpcRequest('passwordBankBackupSaved', { revision: backupRevision }); setBackupRevision(null) })}>{uiText('I saved the backup')}</Button></Flex>}
      <Flex gap="4" wrap="wrap" mb="6">
        <Box {...card} flex="1" minW="260px">
          <Text fontSize="lg" fontWeight="600" mb="1">{uiText('Ready password bank')}</Text>
          <Text fontSize="sm" color="kk.textSecondary" mb="3">{uiText('Pre-generate unique 24-character passwords. Each account receives its own permanent slot.')}</Text>
          <Text mb="3">{uiText('Ready entries')}: {bank.readySlots.length} · {uiText('Cached now')}: {bank.readySlots.filter(s => s.cachedUntil).length}</Text>
          <Flex gap="2" wrap="wrap" align="center">
            <label>{uiText('Entries')} <select aria-label={uiText('Entries')} value={count} style={selectStyle} disabled={busy} onChange={e => setCount(Number(e.target.value))}>{[1, 3, 5, 8].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
            <label>{uiText('Cache minutes')} <select aria-label={uiText('Cache minutes')} value={ttlMinutes} style={selectStyle} disabled={busy} onChange={e => setTtlMinutes(Number(e.target.value))}>{[1, 5, 15].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
            <Button size="sm" disabled={busy} onClick={() => void run(() => deviceCall('passwordBankGenerate', { count, ttlMinutes }))}>{uiText('Generate on KeepKey')}</Button>
          </Flex>
        </Box>
        <Box {...card} flex="1" minW="260px">
          <Text fontSize="lg" fontWeight="600" mb="3">{uiText('Assign an account')}</Text>
          <Flex direction="column" gap="2">
            <Input aria-label={uiText('Login domain')} placeholder={uiText('Login domain, for example accounts.google.com')} value={origin} onChange={e => setOrigin(e.target.value)} disabled={busy} />
            <Input aria-label={uiText('Account name')} placeholder={uiText('Account name or email')} value={account} onChange={e => setAccount(e.target.value)} disabled={busy} />
            <Flex gap="2" align="center"><Text fontSize="sm">{uiText('Review every')}</Text><Input aria-label={uiText('Review interval in days')} type="number" min={1} max={3650} value={reviewDays} onChange={e => setReviewDays(Number(e.target.value))} w="90px" /><Text fontSize="sm">{uiText('days')}</Text></Flex>
            <Button size="sm" disabled={busy || !bank.readySlots.length || !origin || !account} onClick={() => void run(async () => { await rpcRequest('passwordBankAssign', { origin, account, reviewDays }); setAccount(''); setOrigin('') })}>{uiText('Assign next ready password')}</Button>
          </Flex>
        </Box>
      </Flex>
      <Text fontSize="lg" fontWeight="600" mb="3">{uiText('Accounts and rotation')}</Text>
      {bank.profiles.length === 0 && <Box {...card}><Text color="kk.textSecondary">{uiText('Generate a few entries, then assign a login domain and account. Your accounts and rotation checklist appear here.')}</Text></Box>}
      <Flex direction="column" gap="3">
        {bank.profiles.map(p => {
          const guide = PASSWORD_ROTATION_GUIDES.find(g => g.loginOrigin === p.origin)
          const pending = p.pendingSlot !== undefined
          return <Box {...card} key={p.id}>
            <Flex justify="space-between" align="start" gap="3" wrap="wrap">
              <Box><Text fontWeight="600">{p.account}</Text><Text fontSize="sm" color="kk.textSecondary">{p.origin} · {uiText('Slot')} {p.slot}</Text><Text fontSize="xs" color={p.due ? 'kk.gold' : 'kk.textMuted'}>{p.rotationState === 'submitted' ? uiText('Change submitted — verify the working password') : pending ? uiText('New password staged — old password remains active') : p.due ? uiText('Password setup or review due') : uiText('Last change verified')}</Text></Box>
              <Flex gap="2" wrap="wrap">
                <Button size="xs" disabled={busy} onClick={() => void show(p.id, false)}>{p.changedAt ? uiText('Reveal current') : uiText('Reveal assigned')}</Button>
                <Button size="xs" disabled={busy} onClick={() => void run(() => deviceCall('passwordBankRehydrate', { id: p.id, ttlMinutes }))}>{p.cachedUntil ? uiText('Refresh cache') : uiText('Rehydrate current')}</Button>
                {!pending && <Button size="xs" disabled={busy || !bank.readySlots.length} onClick={() => void rotate(p.id, 'prepare')}>{uiText('Stage next password')}</Button>}
              </Flex>
            </Flex>
            <Text fontSize="xs" mt="2" color="kk.textMuted">{p.cachedUntil ? `${uiText('Cache expires')}: ${new Date(p.cachedUntil).toLocaleTimeString()}` : uiText('Current password is not cached')}</Text>
            {!p.changedAt && <Text fontSize="sm" mt="2" color="kk.textSecondary">{uiText('This generated entry does not import or change the existing website password. Complete guided setup and verify a sign-in before using it for login.')}</Text>}
            <PasswordBrowserFill id={p.id} pending={false} disabled={busy || !p.cachedUntil || !p.changedAt} />
            {reveal?.id === p.id && <Flex mt="3" p="3" bg="kk.bg" borderRadius="md" gap="3" align="center"><input aria-label={reveal.pending ? uiText('Pending password') : uiText('Current password')} type="password" autoComplete="off" data-keepkey-secret="true" readOnly value={reveal.password} style={{ ...selectStyle, flex: 1 }} /><Button size="xs" onClick={() => { void navigator.clipboard.writeText(reveal.password).catch(() => setError(uiText('Clipboard unavailable. Use the password field to copy.'))) }}>{uiText('Copy')}</Button><Button size="xs" onClick={() => setReveal(null)}>{uiText('Hide')}</Button></Flex>}
            {pending && <Box mt="4" pt="3" borderTop="1px solid" borderColor="kk.border">
              <Text fontSize="sm" fontWeight="600">{uiText('Guided rotation')} · {uiText('Pending slot')} {p.pendingSlot}</Text>
              <Text fontSize="sm" color="kk.textSecondary" my="2">{guide ? uiText(guide.note) : uiText('Open the account password settings on its verified website. Check its password rules and complete any MFA yourself. The generated format may not fit every website.')}</Text>
              <Flex gap="2" wrap="wrap" mb="3">
                <Button size="xs" disabled={busy} onClick={() => void run(() => rpcRequest('openExternal', { url: guide?.settingsUrl || p.origin }))}>{uiText('Open account settings')}</Button>
                <Button size="xs" disabled={busy} onClick={() => void show(p.id, true)}>{uiText('Reveal staged password')}</Button>
                <Button size="xs" disabled={busy} onClick={() => void run(() => deviceCall('passwordBankRehydrate', { id: p.id, pending: true, ttlMinutes }))}>{uiText('Rehydrate staged')}</Button>
                {p.rotationState === 'prepared' && <Button size="xs" disabled={busy} onClick={() => void rotate(p.id, 'cancel')}>{uiText('Cancel before submission')}</Button>}
              </Flex>
              {p.rotationState === 'submitted' && <PasswordBrowserFill id={p.id} pending disabled={busy || !p.pendingCachedUntil} />}
              {p.rotationState === 'prepared' ? <Box><Text fontSize="sm" color="kk.textSecondary" mb="2">{uiText('Export and save the recovery backup first. Mark this step before submitting the new password on the website so an interrupted change keeps both locations.')}</Text><Button size="sm" disabled={busy || bank.backupRequired} onClick={() => void rotate(p.id, 'submitted')}>{uiText('Backup saved — begin website change')}</Button></Box> : <Box>
                <Text color="kk.gold" fontSize="sm" mb="2">{uiText('If the website result is uncertain, keep both passwords. Verify a fresh sign-in with the staged password before activating it.')}</Text>
                <label><input type="checkbox" checked={verified[p.id] || false} onChange={e => setVerified(v => ({ ...v, [p.id]: e.target.checked }))} /> {uiText('I successfully signed in with the new password')}</label>
                <Button ml="3" size="sm" disabled={busy || !verified[p.id]} onClick={() => void rotate(p.id, 'verify')}>{uiText('Activate verified password')}</Button>
              </Box>}
            </Box>}
          </Box>
        })}
      </Flex>
      <Box mt="6" {...card}><Text fontWeight="600" mb="1">{uiText('Browser and mobile integration')}</Text><Text color="kk.textSecondary" fontSize="sm">{uiText('BEX autofill requires the compatible extension update and Agent mode. Choose the exact password field; fill never submits a form. Native mobile autofill and scheduled rotation are not included in this MVP.')}</Text></Box>
    </>}
  </Box>
}
