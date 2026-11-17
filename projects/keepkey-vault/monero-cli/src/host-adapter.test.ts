import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkHostAdapterFile, hostAdapterArtifact, verifiedHostAdapterIn } from './host-adapter'
import { runHostAdapter, verifiedHostAdapter } from './tools'
import { parseExactJson, PublicError, validateOutputs, validatePlan, validateTransferDraft } from './protocol'
import { MoneroWatchService } from './wallet'
import { stageMoneroAdapter } from '../../scripts/stage-monero-adapter'
import expected from '../../src/bun/monero-send.fixtures.json'

const folders: string[] = []
const folder = () => { const path = mkdtempSync(join(tmpdir(), 'vault-monero-adapter-')); folders.push(path); return path }
const metadata = (directory: string, extra = {}) => writeFileSync(join(directory, 'monero-tools.json'), JSON.stringify({
  version: '0.18.5.4', platform: 'darwin-arm64', ...extra,
}))
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('Monero host adapter admission', () => {
  test('optional absence is explicit; required absence and a supplied wrong pin fail', () => {
    const directory = folder()
    expect(stageMoneroAdapter({ directory, platform: 'darwin-arm64', ifAvailable: true }).staged).toBe(false)
    expect(() => stageMoneroAdapter({ directory, platform: 'darwin-arm64' })).toThrow('reviewed bytes')
    expect(() => stageMoneroAdapter({ directory, platform: 'darwin-arm64', sha256: '0'.repeat(64), ifAvailable: true })).toThrow('reviewed platform pin')
    expect(stageMoneroAdapter({ directory, platform: 'win32-x64', ifAvailable: true }).staged).toBe(false)
    expect(() => stageMoneroAdapter({ directory, platform: 'win32-x64' })).toThrow('No reviewed')
  })

  test('corrupt bytes are rejected even in optional mode; metadata cannot approve another executable', async () => {
    const directory = folder(), artifact = hostAdapterArtifact('darwin-arm64')!
    writeFileSync(join(directory, artifact.filename), 'an unrelated executable', { mode: 0o755 })
    metadata(directory, { hostAdapterSha256: artifact.sha256 })
    expect(() => stageMoneroAdapter({ directory, platform: 'darwin-arm64', ifAvailable: true })).toThrow('reviewed bytes')
    expect(verifiedHostAdapterIn(directory, 'darwin-arm64')).toBeNull()
    expect(await verifiedHostAdapter(join(directory, 'monero-wallet-rpc'))).toBeNull()
  })

  test('file verification checks bytes, size, permissions and symlinks before execution', () => {
    const directory = folder(), path = join(directory, 'decoder'), bytes = Buffer.from('fixture decoder bytes')
    const artifact = { filename: 'decoder', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    writeFileSync(path, bytes, { mode: 0o755 })
    expect(checkHostAdapterFile(path, artifact)).toBe(true)
    expect(checkHostAdapterFile(path, { ...artifact, size: artifact.size + 1 })).toBe(false)
    expect(checkHostAdapterFile(path, { ...artifact, sha256: '0'.repeat(64) })).toBe(false)
    const link = join(directory, 'link'); symlinkSync(path, link)
    expect(checkHostAdapterFile(link, artifact)).toBe(false)
    if (process.platform !== 'win32') { chmodSync(path, 0o777); expect(checkHostAdapterFile(path, artifact)).toBe(false) }
  })
})

// Optional native fixture suite: only the reviewed decoder executes; no RPC, daemon,
// device, signing or relay. The request credentials are published upstream test data.
const toolsDirectory = resolve(import.meta.dir, '../vendor', `${process.platform}-${process.arch}`)
const nativeSource = process.env.KEEPKEY_TEST_MONERO_HOST_ADAPTER || verifiedHostAdapterIn(toolsDirectory)
const artifact = hostAdapterArtifact()
const nativeAvailable = !!(nativeSource && artifact && checkHostAdapterFile(nativeSource, artifact))
const sweepCases = ['sweep-standard-dummy-first', 'sweep-standard-dummy-last', 'sweep-subaddress-dummy-first', 'sweep-subaddress-dummy-last'] as const
const requestFixture = (name: string): Record<string, string> => JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures/host-adapter', `${name}-request.json`), 'utf8'))
function expectedSweepPlan(name: typeof sweepCases[number]) {
  const base = name.includes('subaddress') ? 'subaddress' : 'base'
  const value = parseExactJson(JSON.stringify(expected.cases[base].adapterPlan))
  value.outputs = parseExactJson(readFileSync(resolve(import.meta.dir, '../fixtures/host-adapter', `${name}-expected-outputs.json`), 'utf8'))
  return validatePlan(value)
}
describe.skipIf(!nativeAvailable)('reviewed native Monero decoder (public fixtures)', () => {
  test('stages independently of an emulator flag and remains usable beside wallet RPC', async () => {
    const directory = folder(); metadata(directory)
    const result = stageMoneroAdapter({ directory, source: nativeSource!, platform: 'darwin-arm64' })
    expect(result).toMatchObject({ staged: true, sha256: artifact!.sha256 })
    expect(await verifiedHostAdapter(join(directory, 'monero-wallet-rpc'))).toBe(result.path!)
    const again = stageMoneroAdapter({ directory, platform: 'darwin-arm64', ifAvailable: true })
    expect(again.path).toBe(result.path)
    metadata(directory, { hostAdapterSha256: '0'.repeat(64) })
    expect(await verifiedHostAdapter(join(directory, 'monero-wallet-rpc'))).toBeNull()
    rmSync(join(directory, 'monero-tools.json'))
    const other = join(folder(), 'metadata'); writeFileSync(other, '{}'); symlinkSync(other, join(directory, 'monero-tools.json'))
    expect(() => stageMoneroAdapter({ directory, platform: 'darwin-arm64' })).toThrow('metadata file')
  })

  test('runtime accepts a sealed re-sign receipt, but raw staging never accepts changed bytes', async () => {
    const directory = folder(); metadata(directory)
    const installed = stageMoneroAdapter({ directory, source: nativeSource!, platform: 'darwin-arm64' }).path!
    const changed = Buffer.concat([readFileSync(installed), Buffer.from('PUBLIC-MOCK-SIGNATURE')])
    writeFileSync(installed, changed)
    metadata(directory, { hostAdapterRawSha256: artifact!.sha256, hostAdapterSha256: createHash('sha256').update(changed).digest('hex') })
    expect(await verifiedHostAdapter(join(directory, 'monero-wallet-rpc'))).toBe(installed)
    expect(() => stageMoneroAdapter({ directory, platform: 'darwin-arm64' })).toThrow('reviewed bytes')
    metadata(directory, { hostAdapterRawSha256: '0'.repeat(64), hostAdapterSha256: createHash('sha256').update(changed).digest('hex') })
    expect(await verifiedHostAdapter(join(directory, 'monero-wallet-rpc'))).toBeNull()
  })

  for (const name of ['base', 'subaddress', 'four-inputs-reversed-selection'] as const) {
    test(`${name}: authenticated unsigned plan and complete output metadata match independent fixtures`, async () => {
      const input = JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures/host-adapter', `${name}-request.json`), 'utf8'))
      const planRequest = { ...input }, plan = await runHostAdapter(nativeSource!, planRequest)
      expect(validatePlan(plan)).toEqual(validatePlan(parseExactJson(JSON.stringify(expected.cases[name].adapterPlan))))
      expect(planRequest.view_key).toBe('')
      const outputsRequest = { ...input, op: 'outputs' }, outputs = await runHostAdapter(nativeSource!, outputsRequest)
      expect(validateOutputs(outputs)).toEqual(validateOutputs(parseExactJson(JSON.stringify(expected.cases[name].adapterOutputs))))
      expect(outputsRequest.view_key).toBe('')
    })
  }

  for (const name of sweepCases) {
    test(`${name}: Core-authenticated Max keeps the zero dummy and the exact recipient amount`, async () => {
      const request = requestFixture(name)
      expect(validatePlan(await runHostAdapter(nativeSource!, request))).toEqual(expectedSweepPlan(name))
      expect(request.view_key).toBe('')
    })
  }

  test('watch-worker transfer, native decoder and IPC validation preserve standard/subaddress Max in either output order', async () => {
    const directory = folder(); metadata(directory)
    const adapter = stageMoneroAdapter({ directory, source: nativeSource!, platform: 'darwin-arm64' }).path!
    for (const name of sweepCases) {
      const fixture = requestFixture(name), plan = expectedSweepPlan(name)
      const recipient = plan.outputs.find(output => output.amountAtomic !== '0')!
      const calls: Array<{ method: string; params: any }> = [], keyReply = { key: fixture.view_key }
      const service = new MoneroWatchService('/unused-wallet-rpc', adapter)
      ;(service as any).session = { address: fixture.address, sendable: true, rpc: { call: async (method: string, params: unknown) => {
        calls.push({ method, params })
        if (method === 'transfer') return { unsigned_txset: fixture.unsigned_txset, fee: plan.feeAtomic, amount: recipient.amountAtomic }
        if (method === 'export_outputs') return { outputs_data_hex: fixture.outputs_data_hex }
        if (method === 'query_key') return keyReply
        throw new Error('Unexpected RPC in offline public fixture test')
      } } }
      const reply = await service.createTransfer({ address: recipient.address, amountAtomic: recipient.amountAtomic, priority: 0 })
      // Exercise the serialized worker reply as consumed by the Desktop bridge.
      expect(validateTransferDraft(JSON.parse(JSON.stringify(reply)))).toEqual({ feeAtomic: plan.feeAtomic, amountAtomic: recipient.amountAtomic, plan })
      expect(calls).toEqual([
        { method: 'transfer', params: { destinations: [{ address: recipient.address, amount: BigInt(recipient.amountAtomic) }],
          account_index: 0, priority: 0, ring_size: 16, unlock_time: 0, do_not_relay: true } },
        { method: 'export_outputs', params: { all: true } },
        { method: 'query_key', params: { key_type: 'view_key' } },
      ])
      expect(keyReply.key).toBe('')
    }
  })

  test('authenticated malformed dummy outputs and forged positive change remain refused with a scrubbed public diagnostic', async () => {
    for (const name of ['invalid-sweep-mismatched-dummy', 'invalid-sweep-positive-change', 'invalid-sweep-subaddress-dummy',
      'invalid-sweep-all-zero', 'invalid-sweep-multiple-dummy', 'invalid-sweep-three-outputs', 'invalid-forged-positive-change']) {
      const request = requestFixture(name)
      let failure: unknown
      try { await runHostAdapter(nativeSource!, request) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(PublicError)
      expect((failure as Error).message).toBe('The Monero transaction decoder refused the unsigned transaction')
      expect(request.view_key).toBe('')
    }
  })

  test('watch-worker preserves the decoder-stage public failure and clears the returned view key', async () => {
    const fixture = requestFixture('invalid-sweep-mismatched-dummy'), keyReply = { key: fixture.view_key }
    const plan = expectedSweepPlan('sweep-standard-dummy-last'), recipient = plan.outputs.find(output => output.amountAtomic !== '0')!
    const service = new MoneroWatchService('/unused-wallet-rpc', nativeSource!)
    ;(service as any).session = { address: fixture.address, sendable: true, rpc: { call: async (method: string) => {
      if (method === 'transfer') return { unsigned_txset: fixture.unsigned_txset, fee: plan.feeAtomic, amount: recipient.amountAtomic }
      if (method === 'export_outputs') return { outputs_data_hex: fixture.outputs_data_hex }
      if (method === 'query_key') return keyReply
      throw new Error('Unexpected RPC in offline public fixture test')
    } } }
    let failure: unknown
    try { await service.createTransfer({ address: recipient.address, amountAtomic: recipient.amountAtomic, priority: 0 }) }
    catch (error) { failure = error }
    expect(failure).toBeInstanceOf(PublicError)
    expect((failure as Error).message).toBe('The Monero transaction decoder refused the unsigned transaction')
    expect(keyReply.key).toBe('')
  })

  test('tampered authenticated containers and spend-key fields are refused', async () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures/host-adapter/base-request.json'), 'utf8'))
    for (const field of ['outputs_data_hex', 'unsigned_txset']) {
      const request = { ...fixture }, bytes = Buffer.from(request[field], 'hex'); bytes[bytes.length - 1] ^= 1; request[field] = bytes.toString('hex')
      await expect(runHostAdapter(nativeSource!, request)).rejects.toThrow('refused')
      expect(request.view_key).toBe('')
    }
    await expect(runHostAdapter(nativeSource!, { ...fixture, spendkey: 'not accepted' })).rejects.toThrow('refused')
  })
})
