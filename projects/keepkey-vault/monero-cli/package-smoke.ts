#!/usr/bin/env bun
/** Verify the real packaged worker can locate its bundled tools, without wallets or network. */
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { createMoneroSidecarManager } from '../src/bun/monero-sidecar'

const argument = process.argv.find(value => value.startsWith('--app-dir='))?.slice(10)
if (!argument) throw new Error('Pass --app-dir=/path/to/app/resources/app')
const worker = join(resolve(argument), process.platform === 'win32' ? 'monero-cli.exe' : 'monero-cli')
if (!existsSync(worker)) throw new Error('Packaged Monero worker is missing')
const env = { ...process.env }
delete env.MONERO_TOOLS_DIR
delete env.MONERO_CLI_BIN
let child: ReturnType<typeof Bun.spawn> | null = null
const manager = createMoneroSidecarManager({ spawn: () => {
  const process = Bun.spawn([worker], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env })
  child = process
  return process
} })
try {
  await manager.start()
  const status = manager.status()
  if (status.state !== 'ready' || status.configured || status.binaryVersion !== '0.18.5.4') throw new Error('Packaged sidecar did not report an unconfigured ready state')
  console.log(JSON.stringify({ packagedSidecarReady: true, toolsOverrideUsed: false, walletConfigured: false, version: status.binaryVersion }))
} finally {
  manager.stop()
  if (child) await (child as ReturnType<typeof Bun.spawn>).exited
}
