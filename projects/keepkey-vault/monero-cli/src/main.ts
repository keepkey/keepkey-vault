#!/usr/bin/env bun
/** Watch-only NDJSON worker. It never opens USB or accepts spend keys/seeds. */
import { MAX_IPC_LINE, MONERO_VERSION, PublicError, SIDECAR_VERSION } from './protocol'
import { verifiedHostAdapter, verifiedWalletRpc, stopToolVersionProbe } from './tools'
import { MoneroWatchService } from './wallet'

if (process.argv.includes('--version')) {
  process.stdout.write(JSON.stringify({ name: 'keepkey-monero-cli', version: SIDECAR_VERSION, moneroVersion: MONERO_VERSION }) + '\n')
  process.exit(0)
}

const write = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n')
let service: MoneroWatchService | null = null
let stopping = false
const quit = async () => {
  if (stopping) return
  stopping = true
  stopToolVersionProbe()
  try { await service?.stop() } finally { process.exit(0) }
}
process.on('SIGTERM', () => { void quit() })
process.on('SIGINT', () => { void quit() })
process.on('uncaughtException', () => { void quit() })
process.on('unhandledRejection', () => { void quit() })

try {
  const binary = await verifiedWalletRpc()
  service = new MoneroWatchService(binary, await verifiedHostAdapter(binary))
  write({ ok: true, ready: true, version: SIDECAR_VERSION, binaryVersion: MONERO_VERSION, configured: false, sendReady: service.sendReady })
} catch {
  write({ ok: false, ready: false, error: 'Verified Monero host tools are unavailable' })
  process.exit(1)
}

let queue = Promise.resolve(), buffer = ''
const decoder = new TextDecoder('utf-8', { fatal: true })
async function dispatch(raw: string) {
  let value: any = null
  try {
    value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !Number.isSafeInteger(value._req_id) || value._req_id <= 0 ||
        Object.keys(value).some(k => !['cmd', '_req_id', 'params'].includes(k))) throw new Error('request')
    let result: unknown
    switch (value.cmd) {
      case 'configure_watch': result = await service!.configure(value.params); break
      case 'get_status': result = service!.getStatus(); break
      case 'refresh': void service!.refresh().catch(() => {}); result = service!.getStatus(); break
      case 'export_outputs': result = await service!.exportOutputs(); break
      case 'import_key_images': result = await service!.importKeyImages(value.params); break
      case 'create_transfer': result = await service!.createTransfer(value.params); break
      case 'relay_tx': result = await service!.relay(value.params); break
      default: throw new Error('unsupported')
    }
    write({ ok: true, _req_id: value._req_id, result })
  } catch (error) {
    write({ ok: false, _req_id: Number.isSafeInteger(value?._req_id) ? value._req_id : undefined,
      error: error instanceof PublicError ? error.message : 'The watch-only Monero operation could not complete' })
  } finally {
    if (value?.params && typeof value.params === 'object') value.params.viewKey = ''
    raw = ''
  }
}

try {
  for await (const data of Bun.stdin.stream()) {
    buffer += decoder.decode(data, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      if (Buffer.byteLength(line) > MAX_IPC_LINE) throw new Error('bound')
      if (!line.trim()) continue
      // Shutdown bypasses any long scan/configuration queue and kills owned RPC.
      try {
        const candidate = JSON.parse(line)
        if (candidate?.cmd === 'quit' && Object.keys(candidate).every(k => ['cmd', '_req_id'].includes(k))) { await quit(); break }
      } catch { /* dispatch returns a sanitized error */ }
      queue = queue.then(() => dispatch(line))
    }
    if (Buffer.byteLength(buffer) > MAX_IPC_LINE) throw new Error('bound')
  }
  await queue
} catch { /* Malformed/oversized stdin closes the owned worker safely. */ }
await quit()
