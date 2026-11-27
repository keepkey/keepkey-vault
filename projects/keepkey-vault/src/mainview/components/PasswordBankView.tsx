import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'
import { PASSWORD_CACHE_MAX_MINUTES, type PasswordBankView as BankView } from '../../shared/password-bank'
import { orderedPasswordProfiles } from '../../shared/password-inventory'
import { onRpcMessage, rpcRequest } from '../lib/rpc'
import { useUiTranslation } from '../i18n/ui'
import { PasswordValue } from './PasswordValue'
import { getDateLocale } from '../lib/date-locale'

type Profile = BankView['profiles'][number]
export function PasswordBankView() {
  const uiText = useUiTranslation()
  const [bank, setBank] = useState<BankView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [savedTo, setSavedTo] = useState('')
  const [adding, setAdding] = useState(false)
  const [details, setDetails] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [origin, setOrigin] = useState('')
  const [account, setAccount] = useState('')
  const mounted = useRef(true)
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++revision.current
    const next = await rpcRequest<BankView>('passwordBankStatus')
    if (mounted.current && revision.current === current) setBank(next)
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh().catch(() => { if (mounted.current) setError(uiText('Could not load passwords')) })
    const invalidate = () => {
      setBank(null)
      setAdding(false)
      setConfirming(null)
      setOrigin('')
      setAccount('')
      setError('')
      void refresh().catch(() => {})
    }
    const removeDeviceListener = onRpcMessage('device-state', state => {
      if (state.state !== 'ready') invalidate()
    })
    const removeWalletListener = onRpcMessage('wallet-data-purged', invalidate)
    const timer = setInterval(() => { void refresh().catch(() => {}) }, 2000)
    return () => { mounted.current = false; revision.current++; clearInterval(timer); removeDeviceListener(); removeWalletListener() }
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
  const ready = async (forReplacement = false) => {
    const current = await rpcRequest<BankView>('passwordBankStatus')
    if (!current.readySlots.some(slot => !forReplacement || slot.symbolFormat)) {
      await deviceCall('passwordBankGenerate', { count: 1, ttlMinutes: PASSWORD_CACHE_MAX_MINUTES })
    }
  }
  const ensureCached = async (p: Profile) => {
    const status = await rpcRequest<BankView>('passwordBankStatus')
    const current = status.profiles.find(profile => profile.id === p.id)
    if (!current) throw new Error(uiText('Unlock with KeepKey'))
    if ((current.cachedUntil || 0) <= Date.now()) {
      await deviceCall('passwordBankRehydrate', { id: p.id, ttlMinutes: PASSWORD_CACHE_MAX_MINUTES })
    }
  }
  const add = () => run(async () => {
    if (!bank?.unlocked) await deviceCall('passwordBankUnlock', { create: !bank?.exists })
    await ready()
    await rpcRequest<BankView>('passwordBankAssign', { origin, account, reviewDays: 90 })
    setAdding(false); setOrigin(''); setAccount('')
  })
  const change = (p: Profile) => run(async () => {
    await ready(true)
    await rpcRequest('passwordBankChange', { id: p.id })
    setConfirming(null)
  })
  const day = (ms: number) => new Date(ms).toLocaleDateString(getDateLocale())
  const importBackup = (file?: File) => {
    if (!file) return
    void run(async () => {
      if (file.size > 2_000_000) throw new Error(uiText('Backup file is too large'))
      await deviceCall('passwordBankImport', { json: await file.text() })
    })
  }
  const card = { bg: 'kk.cardBg', border: '1px solid', borderColor: 'kk.border', borderRadius: 'xl', p: '4' } as const
  return <Box w="100%" mx="auto" p={{ base: '4', md: '6' }} data-testid="password-bank">
    <Flex justify="space-between" align="center" gap="3" mb="5" wrap="wrap">
      <Text fontSize="2xl" fontWeight="600">{uiText('Passwords')}</Text>
      <Flex gap="2">
        {bank?.enabled && !bank.walletPending && <Button size="sm" disabled={busy} onClick={() => setAdding(v => !v)}>{uiText('Add password')}</Button>}
        <Button size="sm" variant="ghost" color="kk.textSecondary" aria-expanded={details} onClick={() => setDetails(v => !v)}>{uiText('Options')}</Button>
      </Flex>
    </Flex>
    {error && <Box role="alert" border="1px solid" borderColor="red.600" p="3" mb="4" borderRadius="md"><Text color="red.300">{error}</Text></Box>}
    {busy && <Text role="status" color="kk.gold" mb="4">{progress || uiText('Saving…')}</Text>}
    {!bank && <Text>{uiText('Loading passwords…')}</Text>}
    {bank && !bank.enabled && <Text>{uiText('Password manager is disabled. Enable it in Settings → Feature flags.')}</Text>}
    {adding && bank?.enabled && !bank.walletPending && <Box {...card} mb="4">
      <form onSubmit={e => { e.preventDefault(); void add() }}>
        <Flex direction="column" gap="3">
          <Input aria-label={uiText('Website')} placeholder={uiText('Login domain, for example accounts.google.com')} value={origin} onChange={e => setOrigin(e.target.value)} disabled={busy} required />
          <Input aria-label={uiText('Account name')} placeholder={uiText('Account name or email')} value={account} onChange={e => setAccount(e.target.value)} disabled={busy} required />
          <Text fontSize="sm" color="kk.textSecondary">{uiText('KeepKey creates the password. Use it when you sign up or change it on the website.')}</Text>
          <Flex gap="2"><Button type="submit" disabled={busy || !origin.trim() || !account.trim()}>{uiText('Create password')}</Button><Button variant="ghost" color="kk.textSecondary" disabled={busy} onClick={() => setAdding(false)}>{uiText('Cancel')}</Button></Flex>
        </Flex>
      </form>
    </Box>}
    {bank?.enabled && !bank.unlocked && (!adding || bank.walletPending) && <Box {...card}>
      <Text color="kk.textSecondary" mb="3">{bank.exists || bank.walletPending ? uiText('Unlock to see your saved passwords.') : uiText('Your saved passwords will appear here.')}</Text>
      {(bank.exists || bank.walletPending) && <Button disabled={busy} onClick={() => void run(() => deviceCall('passwordBankUnlock', { create: false }))}>{uiText('Unlock with KeepKey')}</Button>}
    </Box>}
    {bank?.unlocked && <>
      {!bank.profiles.length && !adding && <Box {...card}><Text color="kk.textSecondary">{uiText('No saved passwords yet.')}</Text></Box>}
      <Flex direction="column" gap="3">
        {orderedPasswordProfiles(bank.profiles).map(p => <Box {...card} key={p.id}>
          <Flex justify="space-between" align="center" gap="3" wrap="wrap">
            <Box minW="0" flex="1">
              <Text fontWeight="600" overflowWrap="anywhere">{p.account}</Text>
              <Text fontSize="sm" color="kk.textSecondary" overflowWrap="anywhere">{new URL(p.origin).hostname}</Text>
              <Text fontSize="xs" color="kk.textMuted">{uiText('Created {{date}}', { date: day(p.createdAt) })}{p.changedAt ? ` · ${uiText('Changed {{date}}', { date: day(p.changedAt) })}` : ''}</Text>
            </Box>
            <Button size="sm" variant="ghost" color="kk.textSecondary" disabled={busy} aria-expanded={confirming === p.id} onClick={() => setConfirming(confirming === p.id ? null : p.id)}>{uiText('Change password')}</Button>
          </Flex>
          <PasswordValue key={`${p.id}:${p.slot}`} id={p.id} disabled={busy} beforeReveal={() => ensureCached(p)} />
          {confirming === p.id && <Box mt="4" pt="4" borderTop="1px solid" borderColor="kk.border">
            <Text fontSize="sm" color="kk.textSecondary" mb="3">{uiText('KeepKey creates a new password for this entry. The current one is no longer shown here, so copy it first if the website asks for it.')}</Text>
            <Button size="sm" disabled={busy} onClick={() => void change(p)}>{uiText('Create new password')}</Button>
            <Button ml="2" size="sm" variant="ghost" color="kk.textSecondary" disabled={busy} onClick={() => setConfirming(null)}>{uiText('Cancel')}</Button>
          </Box>}
        </Box>)}
      </Flex>
    </>}
    {details && <Box {...card} mt="5">
      <Text fontWeight="600" mb="2">{uiText('Recovery and privacy')}</Text>
      <Text fontSize="sm" color="kk.textSecondary" mb="3">{uiText('Vault stores the encrypted password bank in its local database. Recovery requires the bank data and the same seed and wallet passphrase.')}</Text>
      <Flex gap="2" wrap="wrap">
        {bank?.unlocked && <Button size="sm" disabled={busy} onClick={() => void run(() => rpcRequest('passwordBankLock'))}>{uiText('Lock now')}</Button>}
        {bank?.unlocked && <Button size="sm" disabled={busy} onClick={() => void run(async () => { setSavedTo((await rpcRequest<{ filePath: string }>('passwordBankSaveBackup')).filePath) })}>{uiText('Save encrypted backup')}</Button>}
        {bank?.enabled && !bank.exists && !bank.walletPending && <>
          <Box as="label" p="2" cursor="pointer">{uiText('Restore encrypted backup')}<input aria-label={uiText('Restore encrypted backup')} type="file" accept="application/json,.json" disabled={busy} style={{ display: 'none' }} onChange={e => { importBackup(e.target.files?.[0]); e.target.value = '' }} /></Box>
          <Button size="sm" disabled={busy} onClick={() => void run(() => deviceCall('passwordBankUnlock', { recoverLegacy: true }))}>{uiText('Restore previous password bank')}</Button>
        </>}
      </Flex>
      {savedTo && <Text fontSize="sm" color="kk.textSecondary" mt="3" wordBreak="break-all">{uiText('Encrypted backup saved to {{path}}', { path: savedTo })}</Text>}
    </Box>}
  </Box>
}
