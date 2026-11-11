#!/usr/bin/env bun
/** Offline mainnet-genesis smoke with an upstream public test wallet, no coins. */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createMoneroSidecarManager } from '../src/bun/monero-sidecar'
import { DigestWalletRpc, RpcFailure } from './src/digest'
import { verifiedWalletRpc } from './src/tools'

const daemon = process.argv.find(v => v.startsWith('--daemon-bin='))?.slice(13)
const daemonHash = process.argv.find(v => v.startsWith('--daemon-sha256='))?.slice(16)
if (!daemon || !daemonHash || !/^[0-9a-f]{64}$/.test(daemonHash)) {
  throw new Error('Pass the verified official monerod path and SHA256 explicitly for this offline test')
}
const info = await lstat(daemon)
if (!info.isFile() || info.isSymbolicLink() || createHash('sha256').update(new Uint8Array(await readFile(daemon))).digest('hex') !== daemonHash) {
  throw new Error('The offline daemon does not match the supplied verified hash')
}
const rpcBinary = await verifiedWalletRpc()
const root = await mkdtemp(join(tmpdir(), 'keepkey-monero-offline-smoke-'))
await chmod(root, 0o700)
const reserve = () => {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = listener.port; listener.stop(true)
  if (!port) throw new Error('Cannot reserve loopback test port')
  return port
}
const daemonPort = reserve(), p2pPort = reserve(), rpcPort = reserve()
const processes: Array<ReturnType<typeof Bun.spawn>> = []
const sidecar = createMoneroSidecarManager()
let digest: DigestWalletRpc | null = null
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const publicAddress = '4Ahp23WfMrMFK3wYL2hLWQFGt87ZTeRkufS6JoQZu6MEFDokAQeGWmu9MA3GFq1yVLSJQbKJqVAn9F9DLYGpRzRAEXqAXKM'
const publicView = '8722520a581e2a50cc1adab4a1692401effd37b0d63b9d9b60fd7f34ea2b950e'
// Public upstream Trezor fixture: test_msg_monero_getwatchkey.py, MNEMONIC12.
try {
  const node = Bun.spawn([resolve(daemon), '--offline', '--data-dir', join(root, 'daemon'),
    '--p2p-bind-ip', '127.0.0.1', '--p2p-bind-port', String(p2pPort), '--rpc-bind-ip', '127.0.0.1',
    '--rpc-bind-port', String(daemonPort), '--rpc-ssl', 'disabled', '--no-zmq', '--non-interactive', '--no-igd',
    '--disable-dns-checkpoints', '--check-updates', 'disabled', '--log-level', '0', '--log-file', join(root, 'daemon.log')],
    { cwd: root, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  processes.push(node)
  let ready = false
  for (let attempt = 0; attempt < 300; attempt++) {
    if (node.exitCode !== null) throw new Error('Offline mainnet daemon exited')
    try {
      const value: any = await (await fetch(`http://127.0.0.1:${daemonPort}/json_rpc`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }), signal: AbortSignal.timeout(1000) })).json()
      if (value.result?.nettype === 'mainnet' && value.result.height === 1 && value.result.offline === true) { ready = true; break }
    } catch {}
    await pause(100)
  }
  if (!ready) throw new Error('Offline mainnet genesis daemon did not become ready')
  // Exercise repeated Digest requests against the actual verified Core binary.
  const wallet = Bun.spawn([rpcBinary, '--wallet-dir', root, '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(rpcPort),
    '--rpc-ssl', 'disabled', '--daemon-address', `http://127.0.0.1:${daemonPort}`, '--daemon-ssl', 'disabled',
    '--untrusted-daemon', '--no-initial-sync', '--log-level', '0', '--log-file', join(root, 'rpc.log')],
    { cwd: root, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  processes.push(wallet)
  let authenticationError = ''
  for (let attempt = 0; attempt < 15; attempt++) {
    if (wallet.exitCode !== null) throw new Error('Offline wallet RPC exited')
    try {
      const login = (await readFile(join(root, `monero-wallet-rpc.${rpcPort}.login`), 'utf8')).trim()
      const split = login.indexOf(':'); digest = new DigestWalletRpc(rpcPort, login.slice(0, split), login.slice(split + 1))
      await digest.call('get_version', {}, 1000); break
    } catch (error) { authenticationError = error instanceof Error ? error.message : 'unknown'; digest?.close(); digest = null; await pause(100) }
  }
  if (!digest) throw new Error('Actual Core Digest authentication failed: ' + authenticationError)
  for (let count = 0; count < 5; count++) await digest.call('get_version')
  await digest.call('generate_from_keys', { filename: 'public-fixture', address: publicAddress, viewkey: publicView,
    spendkey: '', password: randomBytes(32).toString('hex'), restore_height: 0, language: 'English' })
  if ((await digest.call('get_address', { account_index: 0 })).address !== publicAddress) throw new Error('Public fixture address mismatch')
  try { await digest.call('query_key', { key_type: 'spend_key' }); throw new Error('A spend key was unexpectedly available') }
  catch (error) { if (!(error instanceof RpcFailure) || error.code !== -29) throw error }
  await digest.call('refresh', {}, 30000)
  const balance = await digest.call('get_balance', { account_index: 0 })
  if (balance.balance !== '0' || balance.unlocked_balance !== '0') throw new Error('The no-funds fixture unexpectedly has a balance')
  await sidecar.start()
  const configured = await sidecar.configureWatch({ walletId: 'public-offline-mainnet-fixture', network: 'mainnet',
    address: publicAddress, viewKey: new Uint8Array(Buffer.from(publicView, 'hex')), restoreHeight: 0,
    daemonUrl: `http://127.0.0.1:${daemonPort}` })
  if (configured.address !== publicAddress || configured.canSend !== false) throw new Error('Managed watch wallet binding failed')
  await sidecar.refresh()
  let status = await sidecar.getWalletStatus()
  for (let attempt = 0; attempt < 100 && status.walletHeight < 1; attempt++) {
    await pause(100); status = await sidecar.getWalletStatus()
  }
  if (status.walletHeight !== 1 || status.balanceAtomic !== '0' || status.unlockedBalanceAtomic !== '0') {
    throw new Error('Managed offline mainnet refresh failed')
  }
  console.log(JSON.stringify({ status: 'pass', network: 'mainnet', daemonOffline: true, daemonHeight: 1,
    digestRepeatedRequests: 6, watchOnlyVerified: true, managedCliConfigured: true,
    managedWalletHeight: status.walletHeight, balanceAtomic: status.balanceAtomic, canSend: false,
    publicTestFixtureOnly: true, actualPrivateProfileAccessed: false, physicalDeviceAccessed: false, fundsSent: 0 }))
} finally {
  sidecar.stop(); digest?.close()
  for (const proc of processes.reverse()) {
    if (proc.exitCode === null) {
      proc.kill(); const timer = setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL') }, 3000)
      await proc.exited; clearTimeout(timer)
    }
  }
  await rm(root, { recursive: true, force: true })
}
