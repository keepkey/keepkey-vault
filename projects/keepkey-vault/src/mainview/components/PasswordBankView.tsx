import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'
import { PASSWORD_ROTATION_GUIDES, type PasswordBankView as BankView } from '../../shared/password-bank'
import { passwordInventory } from '../../shared/password-inventory'
import { rpcRequest } from '../lib/rpc'
import { useUiTranslation } from '../i18n/ui'
import { PasswordBrowserFill } from './PasswordBrowserFill'
import { PasswordValue } from './PasswordValue'

type Profile = BankView['profiles'][number]
export function PasswordBankView() {
  const uiText = useUiTranslation()
  const [bank, setBank] = useState<BankView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [adding, setAdding] = useState(false)
  const [details, setDetails] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [origin, setOrigin] = useState('')
  const [account, setAccount] = useState('')
  const [backupPath, setBackupPath] = useState('')
  const [verified, setVerified] = useState<Record<string, boolean>>({})
  const mounted = useRef(true)
  const revision = useRef(0)
  const autoBackupAttempt = useRef('')
  const refresh = useCallback(async () => {
    const current = ++revision.current
    const next = await rpcRequest<BankView>('passwordBankStatus')
    if (mounted.current && revision.current === current) setBank(next)
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh().catch(() => { if (mounted.current) setError(uiText('Could not load passwords')) })
    const timer = setInterval(() => { void refresh().catch(() => {}) }, 2000)
    return () => { mounted.current = false; revision.current++; clearInterval(timer) }
  }, [refresh, uiText])
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(''); setProgress('')
    try { await work() }
    catch (e: any) { if (mounted.current) setError(e?.message || uiText('Password operation failed')) }
    finally { if (mounted.current) { setBusy(false); setProgress(''); void refresh().catch(() => {}) } }
  }
  const deviceCall = async <T,>(method: string, params?: unknown) => {
    setProgress(uiText('Confirm on KeepKey'))
    return rpcRequest<T>(method, params, 600000)
  }
  const saveBackup = async () => {
    setProgress(uiText('Saving encrypted backup…'))
    const receipt = await rpcRequest<{ filePath: string }>('passwordBankSaveBackup')
    if (mounted.current) setBackupPath(receipt.filePath)
  }
  const ready = async () => {
    const current = await rpcRequest<BankView>('passwordBankStatus')
    if (!current.readySlots.length) await deviceCall('passwordBankGenerate', { count: 1, ttlMinutes: 15 })
  }
  const ensureCached = async (p: Profile, pending: boolean) => {
    const status = await rpcRequest<BankView>('passwordBankStatus')
    const current = status.profiles.find(profile => profile.id === p.id)
    if (!current) throw new Error(uiText('Unlock with KeepKey'))
    if (((pending ? current.pendingCachedUntil : current.cachedUntil) || 0) <= Date.now()) {
      await deviceCall('passwordBankRehydrate', { id: p.id, pending, ttlMinutes: 15 })
    }
  }
  const prepare = async (p: Profile) => {
    if (p.pendingSlot === undefined) {
      await ready()
      await rpcRequest('passwordBankRotate', { id: p.id, action: 'prepare' })
    }
    await saveBackup()
    setExpanded(p.id)
  }
  const add = () => run(async () => {
    if (!bank?.unlocked) await deviceCall('passwordBankUnlock', { create: !bank?.exists })
    await ready()
    const assigned = await rpcRequest<BankView>('passwordBankAssign', { origin, account, reviewDays: 90 })
    const profile = assigned.profiles.find(p => !bank?.profiles.some(old => old.id === p.id))
    setAdding(false); setOrigin(''); setAccount('')
    // Save the assignment even if a later device approval is cancelled.
    await saveBackup()
    if (profile) await prepare(profile)
  })
  const begin = (p: Profile) => run(async () => {
    await ensureCached(p, true)
    await saveBackup()
    if (p.rotationState === 'prepared') {
      await rpcRequest('passwordBankRotate', { id: p.id, action: 'submitted' })
      await saveBackup()
    }
    const guide = PASSWORD_ROTATION_GUIDES.find(g => g.loginOrigin === p.origin)
    await rpcRequest('openExternal', { url: guide?.settingsUrl || p.origin })
  })
  const finish = (p: Profile) => run(async () => {
    await rpcRequest('passwordBankRotate', { id: p.id, action: 'verify', confirmed: verified[p.id] === true })
    setVerified(v => ({ ...v, [p.id]: false }))
    await saveBackup()
    setExpanded(null)
  })
  const importBackup = (file?: File) => {
    if (!file) return
    void run(async () => {
      if (file.size > 2_000_000) throw new Error(uiText('Backup file is too large'))
      await deviceCall('passwordBankImport', { json: await file.text() })
      await saveBackup()
    })
  }
  useEffect(() => {
    if (!bank?.unlocked || !bank.backupRequired || busy) return
    const attempt = `${bank.bankId}:${bank.revision}`
    if (autoBackupAttempt.current === attempt) return
    autoBackupAttempt.current = attempt
    void run(saveBackup)
    // Retry once per revision; a storage failure offers an explicit retry.
  }, [bank?.bankId, bank?.revision, bank?.unlocked, bank?.backupRequired, busy])
  const card = { bg: 'kk.cardBg', border: '1px solid', borderColor: 'kk.border', borderRadius: 'xl', p: '4' } as const
  return <Box w="100%" mx="auto" p={{ base: '4', md: '6' }} data-testid="password-bank">
    <Flex justify="space-between" align="center" gap="3" mb="5" wrap="wrap">
      <Text fontSize="2xl" fontWeight="600">{uiText('Passwords')}</Text>
      <Flex gap="2">
        {bank?.enabled && <Button size="sm" disabled={busy} onClick={() => setAdding(v => !v)}>{uiText('Add password')}</Button>}
        <Button size="sm" variant="ghost" color="kk.textSecondary" aria-expanded={details} onClick={() => setDetails(v => !v)}>{uiText('Options')}</Button>
      </Flex>
    </Flex>
    {error && <Box role="alert" border="1px solid" borderColor="red.600" p="3" mb="4" borderRadius="md"><Text color="red.300">{error}</Text></Box>}
    {busy && <Text role="status" color="kk.gold" mb="4">{progress || uiText('Saving…')}</Text>}
    {!bank && <Text>{uiText('Loading passwords…')}</Text>}
    {bank && !bank.enabled && <Text>{uiText('Password manager is disabled. Enable it in Settings → Feature flags.')}</Text>}
    {adding && bank?.enabled && <Box {...card} mb="4">
      <form onSubmit={e => { e.preventDefault(); void add() }}>
        <Flex direction="column" gap="3">
          <Input aria-label={uiText('Website')} placeholder={uiText('Login domain, for example accounts.google.com')} value={origin} onChange={e => setOrigin(e.target.value)} disabled={busy} required />
          <Input aria-label={uiText('Account name')} placeholder={uiText('Account name or email')} value={account} onChange={e => setAccount(e.target.value)} disabled={busy} required />
          <Text fontSize="sm" color="kk.textSecondary">{uiText('Create a password with KeepKey, then set it on the website.')}</Text>
          <Flex gap="2"><Button type="submit" disabled={busy || !origin.trim() || !account.trim()}>{uiText('Create password')}</Button><Button variant="ghost" color="kk.textSecondary" disabled={busy} onClick={() => setAdding(false)}>{uiText('Cancel')}</Button></Flex>
        </Flex>
      </form>
    </Box>}
    {bank?.enabled && !bank.unlocked && !adding && <Box {...card}>
      <Text color="kk.textSecondary" mb="3">{bank.exists ? uiText('Unlock to see your saved passwords.') : uiText('Your saved passwords will appear here.')}</Text>
      {bank.exists && <Button disabled={busy} onClick={() => void run(() => deviceCall('passwordBankUnlock', { create: false }))}>{uiText('Unlock with KeepKey')}</Button>}
    </Box>}
    {bank?.unlocked && <>
      {bank.backupRequired && <Flex {...card} mb="4" gap="3" align="center" wrap="wrap"><Text>{uiText('Encrypted backup needs saving.')}</Text><Button size="sm" disabled={busy} onClick={() => void run(saveBackup)}>{uiText('Save backup')}</Button></Flex>}
      {!bank.profiles.length && !adding && <Box {...card}><Text color="kk.textSecondary">{uiText('No saved passwords yet.')}</Text></Box>}
      <Flex direction="column" gap="3">
        {passwordInventory(bank).profiles.map(item => bank.profiles.find(p => p.id === item.id)!).map(p => {
          const pending = p.pendingSlot !== undefined
          const open = expanded === p.id
          return <Box {...card} key={p.id}>
            <Flex justify="space-between" align="center" gap="3" wrap="wrap">
              <Box minW="0" flex="1"><Text fontWeight="600" overflowWrap="anywhere">{p.account}</Text><Text fontSize="sm" color="kk.textSecondary" overflowWrap="anywhere">{new URL(p.origin).hostname}</Text><Text fontSize="xs" color={pending || !p.changedAt ? 'kk.gold' : 'kk.textMuted'}>{pending ? uiText('Finish password change') : p.changedAt ? uiText('Ready') : uiText('Needs setup')}</Text></Box>
              <Flex gap="2" wrap="wrap">
                {!pending && p.changedAt && <PasswordBrowserFill id={p.id} pending={false} disabled={busy} beforeFill={() => ensureCached(p, false)} />}
                <Button size="sm" variant="ghost" color="kk.textSecondary" disabled={busy} aria-expanded={open} onClick={() => pending ? setExpanded(open ? null : p.id) : void run(() => prepare(p))}>{pending ? uiText('Continue') : p.changedAt ? uiText('Change password') : uiText('Set up')}</Button>
              </Flex>
            </Flex>
            {(pending || p.changedAt) && <PasswordValue key={`${p.id}:${pending ? p.pendingSlot : p.slot}`} id={p.id} pending={pending} disabled={busy} beforeReveal={() => ensureCached(p, pending)} />}
            {open && pending && <Box mt="4" pt="4" borderTop="1px solid" borderColor="kk.border">
              {p.rotationState === 'prepared' ? <>
                <Text fontSize="sm" color="kk.textSecondary" mb="3">{uiText('Open the website to change your password. KeepKey will fill it securely.')}</Text>
                <Button size="sm" disabled={busy} onClick={() => void begin(p)}>{uiText('Open website')}</Button>
                <Button ml="2" size="sm" variant="ghost" color="kk.textSecondary" disabled={busy} onClick={() => void run(async () => { await rpcRequest('passwordBankRotate', { id: p.id, action: 'cancel' }); await saveBackup(); setExpanded(null) })}>{uiText('Cancel change')}</Button>
              </> : <>
                <Text fontSize="sm" color="kk.textSecondary" mb="3">{uiText('Fill the new password on the website, then test a fresh sign-in.')}</Text>
                <PasswordBrowserFill id={p.id} pending disabled={busy} beforeFill={() => ensureCached(p, true)} />
                <Box mt="4"><label><input type="checkbox" checked={verified[p.id] || false} onChange={e => setVerified(v => ({ ...v, [p.id]: e.target.checked }))} /> {uiText('I successfully signed in with the new password')}</label></Box>
                <Button mt="3" size="sm" disabled={busy || !verified[p.id]} onClick={() => void finish(p)}>{uiText('Finish')}</Button>
                <Text fontSize="xs" mt="3" color="kk.textMuted">{uiText('Not sure it worked? Leave this open. Both passwords are kept until you verify.')}</Text>
              </>}
            </Box>}
          </Box>
        })}
      </Flex>
    </>}
    {details && <Box {...card} mt="5">
      <Text fontWeight="600" mb="2">{uiText('Recovery and privacy')}</Text>
      <Text fontSize="sm" color="kk.textSecondary" mb="3">{uiText('Keep your seed, wallet passphrase and encrypted backup to recover passwords. Backups are saved in Documents/KeepKey Password Backups. Copy that folder somewhere safe.')}</Text>
      {backupPath && <Text fontSize="xs" overflowWrap="anywhere" mb="3">{backupPath}</Text>}
      <Flex gap="2" wrap="wrap">
        {bank?.unlocked && <><Button size="sm" disabled={busy} onClick={() => void run(saveBackup)}>{uiText('Save encrypted backup')}</Button><Button size="sm" disabled={busy} onClick={() => void run(() => rpcRequest('passwordBankLock'))}>{uiText('Lock now')}</Button></>}
        {bank?.enabled && !bank.exists && <Box as="label" p="2" cursor="pointer">{uiText('Restore encrypted backup')}<input aria-label={uiText('Restore encrypted backup')} type="file" accept="application/json,.json" disabled={busy} style={{ display: 'none' }} onChange={e => { importBackup(e.target.files?.[0]); e.target.value = '' }} /></Box>}
      </Flex>
    </Box>}
  </Box>
}
