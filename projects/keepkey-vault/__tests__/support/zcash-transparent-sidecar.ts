import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ZCASH_NU7_BUILDER_CAPABILITY } from '../../src/bun/zcash-nu7-binary'

// The actual lifecycle and binary verifier run; every child process and stream
// is synthetic. A regression cannot execute a native binary or touch a wallet.
globalThis.fetch = (() => { throw new Error('Network forbidden in sidecar fixture') }) as any
const directory = mkdtempSync(join(tmpdir(), 'zcash-transparent-start-'))
const binary = join(directory, 'synthetic-zcash-cli')
writeFileSync(binary, ZCASH_NU7_BUILDER_CAPABILITY)
const writeManifest = (bytes = ZCASH_NU7_BUILDER_CAPABILITY) => writeFileSync(`${binary}.nu7.json`, JSON.stringify({
  schemaVersion: 1, capability: ZCASH_NU7_BUILDER_CAPABILITY,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}))
process.env.ZCASH_CLI_BIN = binary
const originalSpawn = Bun.spawn
let launches: string[][] = []
let quits = 0
let readyCapability: string | undefined = ZCASH_NU7_BUILDER_CAPABILITY
Bun.spawn = ((args: string[]) => {
  launches.push(args)
  let stdout: ReadableStreamDefaultController<Uint8Array>
  let stderr: ReadableStreamDefaultController<Uint8Array>
  let resolveExit: (code: number) => void
  let ended = false
  const exited = new Promise<number>(resolve => { resolveExit = resolve })
  const finish = () => {
    if (ended) return
    ended = true; stdout.close(); stderr.close(); resolveExit(0)
  }
  return {
    stdout: new ReadableStream({ start(controller) {
      stdout = controller
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, ready: true, transparent_capability: readyCapability, transparent_only: args.includes('--transparent-only') }) + '\n'))
    } }),
    stderr: new ReadableStream({ start(controller) { stderr = controller } }),
    stdin: { write(value: string) { if (value.includes('quit')) { quits++; finish() } }, flush() {} },
    exited, kill: finish,
  }
}) as any

const sidecar = await import('../../src/bun/zcash-sidecar')
const result: Record<string, unknown> = {}
try {
  try { await sidecar.startSidecar({ transparentOnly: true }) } catch (error: any) { result.oldBinary = error.message }
  result.oldBinaryLaunches = launches.length
  writeManifest()
  await sidecar.startSidecar({ transparentOnly: true })
  result.native = { argv: launches.at(-1), ready: sidecar.isSidecarReady() }
  sidecar.stopSidecar()
  await Bun.sleep(0)

  readyCapability = undefined
  await sidecar.startSidecar()
  const before = { count: launches.length, quits }
  try { await sidecar.startSidecar({ transparentOnly: true }) } catch (error: any) { result.profileMode = error.message }
  result.profilePreserved = sidecar.isSidecarReady() && launches.length === before.count && quits === before.quits
  sidecar.stopSidecar()
  await Bun.sleep(0)

  readyCapability = undefined
  const ordinaryStart = sidecar.startSidecar()
  const nativeStart = sidecar.startSidecar({ transparentOnly: true })
  await ordinaryStart
  try { await nativeStart } catch (error: any) { result.concurrent = error.message }
  result.concurrentPreserved = sidecar.isSidecarReady()
  sidecar.stopSidecar()
  await Bun.sleep(0)

  readyCapability = ZCASH_NU7_BUILDER_CAPABILITY
  await sidecar.startSidecar()
  const qualifiedBefore = { count: launches.length, quits }
  await sidecar.startSidecar({ transparentOnly: true })
  result.modernProfileReused = sidecar.isSidecarReady() && launches.length === qualifiedBefore.count && quits === qualifiedBefore.quits
  const changedBytes = ZCASH_NU7_BUILDER_CAPABILITY + ':changed'
  writeFileSync(binary, changedBytes); writeManifest(changedBytes)
  try { await sidecar.startSidecar({ transparentOnly: true }) } catch (error: any) { result.changedBinary = error.message }
  result.changedBinaryPreserved = sidecar.isSidecarReady() && launches.length === qualifiedBefore.count && quits === qualifiedBefore.quits
  sidecar.stopSidecar()
  await Bun.sleep(0)
  writeFileSync(binary, ZCASH_NU7_BUILDER_CAPABILITY); writeManifest()

  readyCapability = undefined
  try { await sidecar.startSidecar({ transparentOnly: true }) } catch (error: any) { result.badReady = error.message }
  result.badReadyRetired = !sidecar.isSidecarReady()
} finally {
  sidecar.stopSidecar()
  Bun.spawn = originalSpawn
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify(result))
