import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'
import { useUiTranslation } from '../i18n/ui'
import { rpcRequest } from '../lib/rpc'
import type { AppSettings } from '../../shared/types'
import { MONERO_LOCAL_URL, type MoneroNodeStatus } from '../../shared/monero-node'

type NodeSettings = Pick<AppSettings, 'moneroDaemonUrl' | 'moneroRestoreHeight' | 'moneroNodeMode'>
export interface MoneroNodeClient {
  settings(): Promise<NodeSettings>
  save(settings: NodeSettings & { mode: 'local' | 'remote'; daemonUrl: string; restoreHeight: number }): Promise<NodeSettings>
  status(): Promise<MoneroNodeStatus>
  configure(dataDir: string): Promise<MoneroNodeStatus>
  start(): Promise<MoneroNodeStatus>
  stop(): Promise<MoneroNodeStatus>
}
const nodeClient: MoneroNodeClient = {
  settings: () => rpcRequest('getAppSettings'),
  save: settings => rpcRequest('setMoneroNode', settings),
  status: () => rpcRequest('moneroNodeStatus', undefined, 15000),
  configure: dataDir => rpcRequest('moneroNodeConfigure', { dataDir }, 15000),
  start: () => rpcRequest('moneroNodeStart', undefined, 30000),
  stop: () => rpcRequest('moneroNodeStop', undefined, 45000),
}
const bytes = (n: number | null) => n === null ? '—' : `${(n / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 })} GiB`

/** One primary node action; storage/connection controls are disclosed on demand. */
export function MoneroNodePanel({ client = nodeClient, compact = false }: { client?: MoneroNodeClient; compact?: boolean }) {
  const uiText = useUiTranslation()
  const [settings, setSettings] = useState<NodeSettings | null>(null)
  const [node, setNode] = useState<MoneroNodeStatus | null>(null)
  const [folder, setFolder] = useState(''), [remote, setRemote] = useState('')
  const [draftMode, setDraftMode] = useState<'local' | 'remote' | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    try {
      const [next, config] = await Promise.all([client.status(), client.settings()])
      if (!mounted.current) return
      setNode(next); setSettings(config)
      setFolder(current => current || next.dataDir)
      if (config.moneroNodeMode === 'remote') setRemote(current => current || config.moneroDaemonUrl)
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Unable to read node status') }
  }, [client])
  useEffect(() => {
    mounted.current = true; void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    window.addEventListener('keepkey-settings-changed', refresh)
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('keepkey-settings-changed', refresh) }
  }, [refresh])
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError(null)
    try { await fn(); window.dispatchEvent(new Event('keepkey-settings-changed')); await refresh() }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Unable to update the Monero node') }
    finally { if (mounted.current) setBusy(false) }
  }
  const mode = draftMode ?? settings?.moneroNodeMode ?? (settings?.moneroDaemonUrl && settings.moneroDaemonUrl !== MONERO_LOCAL_URL ? 'remote' : 'local')
  const running = node && !['stopped', 'error'].includes(node.state)
  const stopping = node?.state === 'stopping'
  const state = node?.state === 'ready' ? uiText('Fully synced') : node?.state === 'syncing' ? uiText('Syncing blockchain')
    : node?.state === 'starting' ? uiText('Starting node…') : stopping ? uiText('Stopping node…') : node?.state === 'error' ? uiText('Node needs attention') : uiText('Node stopped')
  const nodeView = <Box data-monero-node="" mt={compact ? '0' : '3'}>
    <Flex align="center" justify="space-between" gap="3">
      <Box><Text fontSize="sm" fontWeight="500">{uiText('Your Monero node')}</Text><Text data-node-state="" role="status" fontSize="xs" color="var(--text-2)">{state}</Text></Box>
      <Button data-node-toggle="" size="xs" disabled={busy || !node?.available || stopping || !node} onClick={() => { void action(async () => { setNode(running ? await client.stop() : await client.start()) }) }}>
        {stopping ? uiText('Stopping…') : running ? uiText('Stop node') : uiText('Start node')}
      </Button>
    </Flex>
    {!node?.available && node && <Text fontSize="xs" mt="2">{uiText('Local node support is unavailable in this build.')}</Text>}
    {node && <>
      <Text data-node-height="" fontSize="xs" mt="2">{uiText('Block height')}: {node.height?.toLocaleString() ?? '—'} / {node.targetHeight?.toLocaleString() ?? '—'}{node.percent === null ? '' : ` · ${node.percent.toFixed(1)}%`}</Text>
      {running && <progress aria-label={uiText('Blockchain sync by block height')} max={100} {...(node.percent === null ? {} : { value: node.percent })} style={{ width: '100%', accentColor: 'var(--teal)', height: 5 }} />}
      <Text fontSize="xs" color="var(--text-2)">{uiText('Storage used')}: {bytes(node.diskBytes)} · {uiText('Free space')}: {bytes(node.freeBytes)}</Text>
      <Text data-node-location="" fontSize="xs" color="var(--text-3)" overflowWrap="anywhere" mt="1">{node.dataDir}</Text>
      <Text fontSize="xs" color="var(--text-3)" mt="2">{uiText('The first sync can take days. Your wallet connects when the node is ready. Closing Vault pauses the node; Start resumes from the saved blocks.')}</Text>
      <details style={{ marginTop: 12 }}><summary style={{ cursor: 'pointer', fontSize: 12 }}>{uiText('Storage and node details')}</summary>
        <Text fontSize="xs" mt="2">{uiText('Pruned blockchain')}: {uiText('about {{size}}; grows over time', { size: bytes(node.estimatedBytes) })}</Text>
        <Text fontSize="xs">{uiText('Free-space reserve')}: {bytes(node.reserveBytes)}</Text>
        <Text fontSize="xs">{uiText('Peers')}: {node.peers ?? '—'}</Text>
        <Text fontSize="xs" overflowWrap="anywhere">{uiText('Node log')}: {node.logPath}</Text>
        <Text fontSize="xs" mt="2">{uiText('Block progress is approximate; later blocks can take longer. Wallet scanning is a separate step.')}</Text>
        <label htmlFor={compact ? 'asset-node-folder' : 'settings-node-folder'} style={{ fontSize: 12, marginTop: 12, display: 'block' }}>{uiText('Blockchain folder')}</label>
        <Input id={compact ? 'asset-node-folder' : 'settings-node-folder'} data-node-folder="" size="sm" value={folder} disabled={!!running || busy} onChange={e => setFolder(e.target.value)} />
        <Button data-node-folder-save="" size="xs" mt="2" variant="outline" disabled={!!running || busy || folder === node.dataDir || !folder.trim()} onClick={() => { void action(async () => { setNode(await client.configure(folder)) }) }}>{uiText('Use this folder')}</Button>
        <Text fontSize="xs" mt="2">{uiText('Stop the node before changing folders. Choosing a folder does not move or delete existing blockchain data.')}</Text>
      </details>
      {node.error && <Text role="alert" mt="2" color="var(--rose)" fontSize="xs">{node.error}</Text>}
    </>}
  </Box>
  return <Box data-monero-node-panel="" fontSize="sm">
    {!compact && <>
      <Text fontSize="xs" color="var(--text-2)" mb="2">{uiText('Run your own node for the most private connection. Vault manages its storage and sync for you.')}</Text>
      <select aria-label={uiText('Monero connection')} value={mode} disabled={busy || !settings} onChange={event => {
        const next = event.target.value as 'local' | 'remote'
        if (next === 'remote') { setDraftMode('remote'); return }
        setDraftMode(null)
        void action(async () => { const nextSettings = await client.save({ ...settings!, mode: 'local', daemonUrl: MONERO_LOCAL_URL, restoreHeight: settings!.moneroRestoreHeight }); setSettings(nextSettings) })
      }} style={{ width: '100%', background: 'var(--ink-0)', color: 'var(--text-0)', border: '1px solid var(--line)', borderRadius: 6, padding: 8 }}>
        <option value="local">{uiText('Run your own node (recommended)')}</option><option value="remote">{uiText('Use a remote node')}</option>
      </select>
    </>}
    {mode === 'local' ? compact ? <details><summary style={{ cursor: 'pointer', fontSize: 12 }}>{uiText('Your node')}: {state}</summary><Box mt="3">{nodeView}</Box></details> : nodeView
      : !compact && <Box mt="2">
        <Input aria-label={uiText('Monero daemon URL')} placeholder="https://" size="sm" value={remote} onChange={e => setRemote(e.target.value)} />
        <Text fontSize="xs" mt="2">{uiText('A remote node sees your IP address and can link the spends you verify. Remote connections require HTTPS. Vault never switches to a public node automatically.')}</Text>
        <Button size="xs" mt="2" disabled={busy || !remote.trim()} onClick={() => { void action(async () => { setSettings(await client.save({ ...settings!, mode: 'remote', daemonUrl: remote, restoreHeight: settings!.moneroRestoreHeight })); setDraftMode(null) }) }}>{uiText('Use remote node')}</Button>
      </Box>}
    {error && <Text role="alert" fontSize="xs" color="var(--rose)" mt="2">{error}</Text>}
  </Box>
}
