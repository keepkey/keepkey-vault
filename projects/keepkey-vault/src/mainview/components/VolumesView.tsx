import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, Button, Flex, Input, Spinner, Text } from '@chakra-ui/react'
import { FaCheckCircle, FaDesktop, FaFolderOpen, FaHdd, FaLock, FaPlus, FaSyncAlt, FaUnlock } from 'react-icons/fa'
import { VOLUME_APPROVAL_TITLE } from '../../shared/volume-key'
import type { ConnectedVolume, VolumeDestination, VolumeDeviceStatus, VolumeImage, VolumeInventory, VolumeProgress } from '../../shared/volumes'
import { useUiTranslation } from '../i18n/ui'
import { useNumberLocale } from '../lib/number-locale'
import { IS_MAC, IS_WINDOWS } from '../lib/platform'
import { onRpcMessage, rpcRequest } from '../lib/rpc'

type Activity = {
  scope: string
  phase: 'system-prompt' | 'keepkey' | 'working' | 'creating' | 'unlocking' | 'locking' | 'opening' | 'deleting' | 'checking'
  operationId?: string
  approval?: { action: 'create' | 'unlock'; name: string; keyLabel?: string }
}
type Notice = { scope: string; text: string; error: boolean }

// Some desktop WebViews expose getRandomValues but not randomUUID on their internal URL scheme.
function hardwareActivity(scope: string, action: 'create' | 'unlock', name: string): Activity {
  const operationId = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')
  return { scope, operationId, phase: 'keepkey', approval: { action, name } }
}

const card = { bg: 'kk.cardBg', border: '1px solid', borderColor: 'kk.borderAlt', borderRadius: 'lg', p: '4' } as const
const secondary = { color: 'kk.textSecondary', fontSize: 'sm' } as const
const heading = { fontSize: 'md', fontWeight: '600', color: 'kk.textPrimary' } as const

function diskSize(bytes: number, locale: string) {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte']
  const index = Math.max(0, Math.min(4, Math.floor(Math.log10(Math.max(1, bytes)) / 3)))
  return new Intl.NumberFormat(locale, { style: 'unit', unit: units[index], maximumFractionDigits: 1 }).format(bytes / 1000 ** index)
}

function writableVolumeKey(volume: ConnectedVolume) {
  return volume.writable && volume.mountPoint && volume.uuid && !volume.locked ? volume.id + '/' + volume.uuid : null
}

function imageScope(image: VolumeImage) {
  return JSON.stringify([image.destination?.id, image.destination?.uuid, image.id])
}

function volumeFolder(path: string) {
  const separator = IS_WINDOWS ? '\\' : '/'
  return path.replace(/[\\/]+$/, '') + separator + 'KeepKey Volumes' + separator
}

function VolumeCreateForm({ path, freeBytes, busy, ready, progress, onCreate, onCancel }: {
  path: string; freeBytes: number | null; busy: boolean; ready: boolean; progress: ReactNode
  onCreate: (name: string, sizeMiB: number) => void; onCancel: () => void
}) {
  const uiText = useUiTranslation()
  const [name, setName] = useState('')
  const [size, setSize] = useState('256')
  const sizeMiB = Number(size)
  const nameValid = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _-]{0,63}$/u.test(name.trim().normalize('NFC'))
  const maxMiB = Math.min(65536, freeBytes === null ? 65536 : Math.floor(freeBytes / 1048576))
  const sizeValid = Number.isInteger(sizeMiB) && sizeMiB >= 128 && sizeMiB <= maxMiB
  const canSubmit = ready && nameValid && sizeValid

  if (progress) return <Box mt="3" p="3" borderRadius="md" border="1px solid" borderColor="kk.borderAlt">
    <Flex align="center" gap="2"><FaLock aria-hidden /><Text fontWeight="600">{name.trim()}</Text></Flex>
    {progress}
  </Box>

  return <Box as="form" aria-label={uiText('New KeepKey volume')} mt="3" p="3" borderRadius="md" border="1px solid" borderColor="kk.borderAlt"
    onSubmit={event => { event.preventDefault(); if (canSubmit) onCreate(name.trim(), sizeMiB) }}>
    <Text as="h4" fontWeight="600">{uiText('New KeepKey volume')}</Text>
    <Text {...secondary}>{uiText('Approve creation on your KeepKey. Each unlock requires one device approval.')}</Text>
    <Flex gap="3" mt="3" wrap="wrap">
      <Box flex="2 1 200px">
        <label htmlFor="volume-name">{uiText('Name')}</label>
        <Input id="volume-name" autoFocus size="sm" maxLength={64} value={name} onChange={e => setName(e.target.value)} disabled={busy} />
      </Box>
      <Box flex="1 1 130px">
        <label htmlFor="volume-size">{uiText('Maximum size (MiB)')}</label>
        <Input id="volume-size" size="sm" type="number" min={128} max={maxMiB} step={1} value={size} onChange={e => setSize(e.target.value)} disabled={busy} />
      </Box>
    </Flex>
    <Text color="kk.textMuted" fontSize="xs" mt="2" overflowWrap="anywhere">{volumeFolder(path)}</Text>
    {name.trim() && !nameValid && <Text {...secondary}>{uiText('Start with a letter or number. Use letters, numbers, spaces, hyphens or underscores.')}</Text>}
    {!sizeValid && <Text {...secondary}>{uiText('Choose 128–65,536 MiB within the available space.')}</Text>}
    <Flex gap="2" mt="3">
      <Button size="sm" disabled={!canSubmit} type="submit">{uiText('Create')}</Button>
      <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={onCancel}>{uiText('Cancel')}</Button>
    </Flex>
  </Box>
}

export function VolumesView() {
  const uiText = useUiTranslation()
  const locale = useNumberLocale()
  const [inventory, setInventory] = useState<VolumeInventory | null>(null)
  const [device, setDevice] = useState<VolumeDeviceStatus | null>()
  const [images, setImages] = useState<VolumeImage[]>([])
  const [inventoryErrors, setInventoryErrors] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [refreshing, setRefreshing] = useState(true)
  const [busy, setBusy] = useState<Activity | null>(null)
  const [creatingAt, setCreatingAt] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<(VolumeImage & { deleteToken: string }) | null>(null)
  const mounted = useRef(false)
  const actionPending = useRef(false)
  const requestId = useRef(0)
  const scanning = useRef(false)
  const deviceRequestId = useRef(0)

  const refreshDevice = useCallback(async () => {
    const id = ++deviceRequestId.current
    try {
      const status = await rpcRequest<VolumeDeviceStatus>('volumeDeviceStatus')
      if (mounted.current && id === deviceRequestId.current) setDevice(status)
    } catch {
      if (mounted.current && id === deviceRequestId.current) setDevice(null)
    }
  }, [])

  const refresh = useCallback(async (background = false) => {
    if (background && (scanning.current || actionPending.current || document.hidden)) return
    const id = ++requestId.current
    scanning.current = true
    if (!background) setRefreshing(true)
    void refreshDevice()
    const [drives, localImages] = await Promise.allSettled([
      rpcRequest<VolumeInventory>('getVolumeInventory'),
      rpcRequest<VolumeImage[]>('listVolumeImages'),
    ])
    if (!mounted.current || id !== requestId.current) return
    scanning.current = false
    if (drives.status === 'fulfilled') {
      const next = drives.value
      setInventory(next)
      setCreatingAt(key => {
        if (!key || !next.supported || next.unavailableReason) return null
        if (key === 'local') return next.local ? key : null
        return next.drives.some(drive => drive.volumes.some(volume => writableVolumeKey(volume) === key)) ? key : null
      })
    }
    if (localImages.status === 'fulfilled') {
      setImages(localImages.value)
      setDeleting(selected => selected && localImages.value.some(image => imageScope(image) === imageScope(selected) &&
        image.deleteToken === selected.deleteToken && (image.state === 'locked' || image.state === 'unavailable')) ? selected : null)
    }
    setInventoryErrors([...new Set([drives, localImages].flatMap(result =>
      result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : uiText('Something went wrong')] : []
    ))])
    setRefreshing(false)
  }, [uiText, refreshDevice])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const onFocus = () => { if (!actionPending.current) void refresh() }
    // A USB drive can appear or disappear while this window stays focused.
    const timer = window.setInterval(() => void refresh(true), 10_000)
    const offDevice = onRpcMessage('device-state', state => {
      if (state?.state === 'disconnected') setDevice({ available: false, reason: 'disconnected' })
      void refreshDevice()
    })
    const offProgress = onRpcMessage('volume-progress', (event: VolumeProgress) => {
      setBusy(active => {
        if (active?.phase !== 'keepkey' || active.operationId !== event.operationId || !active.approval) return active
        if (event.phase === 'approval') return { ...active, approval: { ...active.approval, keyLabel: event.keyLabel } }
        return { ...active, phase: event.phase }
      })
    })
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      mounted.current = false
      requestId.current++
      deviceRequestId.current++
      offDevice()
      offProgress()
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh, refreshDevice])

  async function run(operation: () => Promise<void>, activity: Activity = { scope: 'general', phase: 'working' }, completed?: () => void) {
    if (actionPending.current) return
    actionPending.current = true
    // A background inventory started before this action can still contain the former lock state.
    requestId.current++
    setBusy(activity)
    setNotice(null)
    setDeleting(null)
    let success = false
    try {
      await operation()
      success = true
    } catch (e) {
      if (mounted.current) setNotice({ scope: activity.scope, text: e instanceof Error ? e.message : uiText('Something went wrong'), error: true })
    } finally {
      if (mounted.current) {
        if (activity.scope !== 'general') setBusy({ ...activity, phase: 'checking' })
        await refresh()
      }
      actionPending.current = false
      if (mounted.current) {
        if (success) completed?.()
        setBusy(null)
      }
    }
  }

  const local = inventory?.local
  const managementAvailable = inventory?.supported && !inventory.unavailableReason
  const blocked = busy !== null || refreshing

  function progressAt(scope: string) {
    if (!busy || busy.scope !== scope) return null
    const labels = {
      keepkey: uiText('Waiting for KeepKey approval…'), creating: uiText('Creating volume…'),
      unlocking: uiText('Unlocking volume…'), locking: uiText('Locking volume…'),
      opening: uiText('Opening protected volume…'), checking: uiText('Checking volume status…'),
      deleting: uiText('Deleting volume…'),
      'system-prompt': uiText('Look for the system password prompt — it may be behind this window.'),
      working: uiText('Working…'),
    }
    return <Box role="status" mt="2">
      <Flex align="center" gap="2" color="kk.gold" fontSize="sm">
        <Spinner size="sm" flexShrink={0} aria-hidden /><Text>{labels[busy.phase]}</Text>
      </Flex>
      {busy.phase === 'keepkey' && busy.approval?.keyLabel && <Box mt="2">
        <Text fontSize="sm">{busy.approval.action === 'create'
          ? uiText('To create {{name}}, confirm the matching prompt on your KeepKey.', { name: busy.approval.name })
          : uiText('To unlock {{name}}, confirm the matching prompt on your KeepKey.', { name: busy.approval.name })}</Text>
        <Box mt="2" px="3" py="2" bg="kk.bg" borderRadius="md" fontFamily="mono" dir="ltr">
          <Text fontSize="sm" fontWeight="600">{VOLUME_APPROVAL_TITLE}</Text>
          <Text fontSize="sm" overflowWrap="anywhere">{busy.approval.keyLabel}</Text>
        </Box>
      </Box>}
      {IS_WINDOWS && ['creating', 'unlocking', 'locking'].includes(busy.phase) &&
        <Text mt="1" {...secondary}>{uiText('Approve the Windows storage prompt if it appears.')}</Text>}
    </Box>
  }

  function noticeAt(scope: string) {
    if (!notice || notice.scope !== scope) return null
    return <Flex mt="2" align="center" gap="2" role={notice.error ? 'alert' : 'status'} color={notice.error ? 'kk.error' : 'kk.success'} fontSize="sm">
      {!notice.error && <FaCheckCircle aria-hidden />}<Text>{notice.text}</Text>
    </Flex>
  }

  function createButton(key: string) {
    if (!managementAvailable || creatingAt === key) return null
    return <Button size="xs" bg="kk.gold" color="kk.bg" _hover={{ bg: 'kk.goldHover' }} disabled={blocked}
      onClick={() => { setDeleting(null); setNotice(null); setCreatingAt(key) }}>
      <FaPlus aria-hidden />{uiText('Create volume')}
    </Button>
  }

  function createForm(key: string, path: string, freeBytes: number | null, destination?: VolumeDestination) {
    const scope = 'storage:' + key
    return <>
      {managementAvailable && creatingAt === key && <VolumeCreateForm key={key} path={path} freeBytes={freeBytes}
        progress={progressAt(scope)} busy={!!busy} ready={!blocked && device?.available === true}
        onCancel={() => { setCreatingAt(null); setNotice(null) }} onCreate={(name, sizeMiB) => {
          const activity = hardwareActivity(scope, 'create', name)
          void run(() => rpcRequest('createVolumeImage', { name, sizeMiB, destination, operationId: activity.operationId }, 0), activity, () => {
            setCreatingAt(null)
            setNotice({ scope, text: uiText('{{name}} was created. Unlock it to add protected files.', { name }), error: false })
          })
        }} />}
      {noticeAt(scope)}
    </>
  }

  let deviceHelp = ''
  if (device === undefined) deviceHelp = uiText('Checking…')
  else if (!device) deviceHelp = uiText('Could not check KeepKey availability. Refresh to retry.')
  else if (!device.available) {
    if (device.reason === 'unsupported') deviceHelp = uiText('Volume approval requires multi-chain KeepKey firmware.')
    else deviceHelp = uiText('Connect a physical KeepKey to create or unlock a KeepKey volume.')
  }
  // If the USB disappears while an action is pending, its row can no longer show the outcome.
  function hasFeedbackRow(scope: string) {
    if (!inventory?.supported || scope === 'general') return false
    if (scope === 'storage:local') return !!local
    const partitions = inventory.drives.flatMap(drive => drive.volumes)
    if (scope.startsWith('storage:')) return partitions.some(volume => writableVolumeKey(volume) === scope.slice(8))
    const image = images.find(item => imageScope(item) === scope)
    if (!image) return false
    const dest = image.destination
    return !dest || partitions.some(volume => volume.id === dest.id && volume.uuid === dest.uuid)
  }

  function renderImage(image: VolumeImage, location: string, path: string | null, storageKey: string | null) {
    const hardware = image.unlockMethod === 'keepkey'
    const params = { id: image.id, destination: image.destination }
    const scope = imageScope(image)
    const unlocked = image.state === 'mounted'
    const attached = unlocked || image.state === 'attached'
    const deleteToken = image.deleteToken
    const confirming = deleting && imageScope(deleting) === scope && deleteToken === deleting.deleteToken &&
      !attached && managementAvailable && storageKey && path ? deleting : null
    function confirmState(state: VolumeImage['state']) {
      if (mounted.current) setImages(items => items.map(item => imageScope(item) === scope ? { ...item, state } : item))
    }
    function unlock() {
      const activity: Activity = hardware ? hardwareActivity(scope, 'unlock', image.name) : { scope, phase: 'system-prompt' }
      void run(async () => {
        await rpcRequest('unlockVolumeImage', { ...params, operationId: activity.operationId }, 0)
        if (!mounted.current) return
        confirmState('mounted')
        setBusy({ scope, phase: 'opening' })
        try { await rpcRequest('openVolumeImage', params) } catch {
          throw new Error(uiText('The volume unlocked. Choose Open protected volume to try opening it again.'))
        }
      }, activity)
    }
    return <Box key={image.id} role="group" aria-label={image.name} mt="3" px="3" py="3" borderRadius="md" border="1px solid" borderColor={unlocked ? 'kk.success' : 'kk.borderAlt'}>
      <Flex align="center" justify="space-between" gap="3" wrap="wrap">
        <Flex align="center" gap="3" minW="0">
          <Box color={unlocked ? 'kk.success' : 'kk.textMuted'}>
            {image.state === 'locked' ? <FaLock aria-hidden /> : unlocked ? <FaUnlock aria-hidden /> : <FaHdd aria-hidden />}
          </Box>
          <Box minW="0">
            <Text fontWeight="600" fontSize="sm" overflowWrap="anywhere">{image.name}</Text>
            <Text color="kk.textSecondary" fontSize="xs">{uiText('Protected volume')} · {hardware ? 'KeepKey' : uiText('Disk password')} · {unlocked ? uiText('Unlocked') : image.state === 'locked' ? uiText('Locked') : image.state === 'attached' ? uiText('Attached, unmounted') : uiText('Unavailable')}</Text>
          </Box>
        </Flex>
        {!confirming && <Flex gap="2" wrap="wrap">
          {unlocked && managementAvailable && <Button size="xs" bg="kk.gold" color="kk.bg" _hover={{ bg: 'kk.goldHover' }} disabled={blocked}
            onClick={() => void run(() => rpcRequest('openVolumeImage', params), { scope, phase: 'opening' })}><FaFolderOpen aria-hidden />{uiText('Open protected volume')}</Button>}
          {image.state === 'locked'
            ? <Button size="xs" variant="outline" disabled={blocked || !managementAvailable || (hardware && !device?.available)} onClick={unlock}>{hardware ? uiText('Unlock with KeepKey') : uiText('Unlock')}</Button>
            : image.state !== 'unavailable' && <Button size="xs" variant="outline" disabled={blocked || !managementAvailable}
              onClick={() => void run(async () => {
                await rpcRequest('lockVolumeImage', params, 0)
                confirmState('locked')
              }, { scope, phase: 'locking' })}>{uiText('Lock')}</Button>}
          {deleteToken && managementAvailable && storageKey && path && <Button size="xs" variant="ghost" colorPalette="red"
            disabled={blocked || attached} title={attached ? uiText('Lock this volume before deleting it.') : undefined}
            onClick={() => { setNotice(null); setDeleting({ ...image, deleteToken }) }}>
            {uiText('Delete volume')}
          </Button>}
        </Flex>}
      </Flex>
      {confirming && path && <Box role="alertdialog" aria-label={uiText('Delete {{name}} from {{location}}?', { name: image.name, location })}
        mt="3" p="3" border="1px solid" borderColor="kk.error" borderRadius="md"
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setDeleting(null) } }}>
        <Text fontSize="sm" fontWeight="600">{uiText('Delete {{name}} from {{location}}?', { name: image.name, location })}</Text>
        <Text {...secondary}>{uiText('This permanently deletes the encrypted volume and its protected files.')}</Text>
        <Text mt="1" color="kk.textMuted" fontFamily="mono" fontSize="xs" overflowWrap="anywhere">{volumeFolder(path) + confirming.id}</Text>
        <Flex gap="2" mt="3" wrap="wrap">
          <Button autoFocus size="xs" variant="outline" onClick={() => setDeleting(null)}>{uiText('Cancel')}</Button>
          <Button size="xs" colorPalette="red" disabled={blocked} onClick={() => {
            const { id, destination, deleteToken } = confirming
            void run(() => rpcRequest('deleteVolumeImage', { id, destination, deleteToken }, 0), { scope, phase: 'deleting' }, () => {
              setImages(items => items.filter(item => imageScope(item) !== scope || item.deleteToken !== deleteToken))
              setNotice({ scope: 'storage:' + storageKey, text: uiText('{{name}} was deleted from {{location}}.', { name: image.name, location }), error: false })
            })
          }}>{uiText('Delete permanently')}</Button>
        </Flex>
      </Box>}
      {busy?.scope === scope ? progressAt(scope) : !confirming && !(notice?.scope === scope && notice.error) && (unlocked || image.state === 'locked') &&
        <Text mt="2" {...secondary}>{unlocked ? uiText('Files saved in this volume are protected when you lock it.') : uiText('Unlock this volume to access its protected files.')}</Text>}
      {noticeAt(scope)}
    </Box>
  }

  return <Flex direction="column" px="5" py="4" gap="4" color="kk.textPrimary">
    <Flex justify="space-between" align="center">
      <Text as="h2" fontSize="lg" fontWeight="600">{uiText('Volumes')}</Text>
      <Button size="xs" variant="ghost" disabled={blocked} onClick={() => void refresh()}>
        <FaSyncAlt aria-hidden />{uiText('Refresh')}
      </Button>
    </Flex>
    {inventoryErrors.map(error => <Text key={error} role="alert" color="kk.error" fontSize="sm">{error}</Text>)}
    {notice && !hasFeedbackRow(notice.scope) && noticeAt(notice.scope)}
    {busy && !hasFeedbackRow(busy.scope) && progressAt(busy.scope)}
    {refreshing && !inventory && !busy && <Text role="status" {...secondary}>{uiText('Loading…')}</Text>}
    {inventory && !managementAvailable && <Text {...secondary}>{inventory.unavailableReason ? uiText(inventory.unavailableReason) : uiText('Volume management is unavailable on this computer.')}</Text>}
    {inventory?.supported && <>
      {managementAvailable && deviceHelp && <Text role="status" {...secondary}>{deviceHelp}</Text>}
      <Box {...card} role="group" aria-label={local?.name ?? (IS_MAC ? uiText('On this Mac') : uiText('On this computer'))}>
        <Flex align="center" justify="space-between" gap="3" wrap="wrap">
          <Flex align="center" gap="2" color="kk.gold">
            <FaDesktop aria-hidden /><Text as="h3" {...heading}>{IS_MAC ? uiText('On this Mac') : uiText('On this computer')}</Text>
          </Flex>
          {local && createButton('local')}
        </Flex>
        {local && <Text fontSize="sm" color="kk.textSecondary" mt="1">{local.name} · {uiText('{{free}} of {{total}} available', { free: diskSize(local.availableBytes, locale), total: diskSize(local.totalBytes, locale) })}</Text>}
        {local && local.totalBytes > 0 && <Box h="1" bg="kk.borderAlt" mt="3" borderRadius="full" overflow="hidden" aria-hidden>
          <Box h="full" bg="kk.gold" opacity={0.7} w={Math.min(100, Math.max(0, (1 - local.availableBytes / local.totalBytes) * 100)) + '%'} />
        </Box>}

        {local && createForm('local', IS_WINDOWS ? '%USERPROFILE%' : '~', local.availableBytes)}
        {images.filter(image => !image.destination).map(image => renderImage(image, local?.name ?? uiText('On this computer'),
          IS_WINDOWS ? '%USERPROFILE%' : '~', local ? 'local' : null))}
      </Box>
      <Box>
        <Text as="h3" {...heading} mb="2">{uiText('Connected drives')}</Text>
        {inventory.drives.length === 0 && <Text {...secondary}>{uiText('No external drives connected.')}</Text>}
        <Flex direction="column" gap="2">
          {inventory.drives.map(drive => <Box {...card} key={drive.id}>
            <Flex align="center" gap="2" justify="space-between">
              <Flex align="center" minW="0" gap="2">
                <Box color="kk.gold"><FaHdd aria-hidden /></Box>
                <Text fontWeight="600" overflowWrap="anywhere">{drive.name}</Text>
              </Flex>
              <Text fontSize="sm" color="kk.textMuted" whiteSpace="nowrap">{diskSize(drive.sizeBytes, locale)}</Text>
            </Flex>
            {!drive.volumes.length && <Text {...secondary} mt="2">{uiText('No data volumes found.')}</Text>}
            {drive.volumes.map(volume => {
              const key = writableVolumeKey(volume)
              return <Box key={volume.id} role="group" aria-label={volume.name}>
                <Flex mt="2" pt="2" borderTop="1px solid" borderColor="kk.borderAlt" align="center" justify="space-between" gap="3" wrap="wrap">
                  <Box minW="0">
                    <Text fontSize="sm" fontWeight="500" overflowWrap="anywhere">{volume.name}</Text>
                    <Text color="kk.textSecondary" fontSize="xs">{[volume.format, volume.encrypted === true ? uiText('Encrypted') : volume.encrypted === false ? uiText('Unencrypted') : null,
                      volume.locked === true ? uiText('Locked') : volume.mountPoint ? uiText('Mounted') : uiText('Unmounted'),
                      volume.availableBytes != null && uiText('Free space') + ' ' + diskSize(volume.availableBytes, locale)].filter(Boolean).join(' · ')}</Text>
                  </Box>
                  <Flex align="center" gap="2" wrap="wrap">
                    {volume.mountPoint && (!IS_WINDOWS || volume.uuid) && <Button size="xs" variant="outline" disabled={blocked} onClick={() => void run(() => rpcRequest('openExternalVolume', { id: volume.id, uuid: volume.uuid }))}>{uiText('Open drive')}</Button>}
                    {key && createButton(key)}
                  </Flex>
                </Flex>
                {key && volume.uuid && volume.mountPoint && createForm(key, volume.mountPoint, volume.availableBytes, { id: volume.id, uuid: volume.uuid })}
                <Box ps="3">{images.filter(image => image.destination?.id === volume.id && image.destination.uuid === volume.uuid)
                  .map(image => renderImage(image, volume.name, volume.mountPoint, key))}</Box>
              </Box>
            })}
          </Box>)}
        </Flex>
      </Box>
      {IS_MAC && local && <Flex align="center" justify="space-between" wrap="wrap" gap="3">
        <Box>
          <Text {...heading}>{uiText('Startup disk')}</Text>
          <Text {...secondary}>{local.fileVault === 'on' ? uiText('FileVault is on') : local.fileVault === 'off' ? uiText('FileVault is off') : uiText('FileVault status unknown')}</Text>
        </Box>
        <Button size="xs" variant="outline" disabled={blocked} onClick={() => void run(() => rpcRequest('openVolumeFileVaultSettings'))}>{uiText('Open System Settings')}</Button>
      </Flex>}
      {managementAvailable && <Box borderTop="1px solid" borderColor="kk.borderAlt" pt="3">
        <Text as="h3" fontSize="sm" fontWeight="600">{uiText('Recovery details')}</Text>
        <Text {...secondary} mt="1">{uiText('Keep the entire KeepKey volume folder. Its recovery file sits beside the encrypted image so Vault can read it before unlock. On a replacement computer, use the same operating system and a compatible KeepKey restored with your recovery phrase and the same optional wallet passphrase.')}</Text>
      </Box>}
    </>}
  </Flex>
}
