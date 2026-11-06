/**
 * An emulator connection's reads and writes end with the connection.
 *
 * Dev log 2026-11-06: a PIN read stayed alive for 240 s after its connection was
 * dropped, polling the FFI rings every connection shares. It took the next
 * wallet's Features ("ethAddress.hasAddressStr is not a function") and held the
 * wallet switch until the UI's RPC timed out.
 *
 * Run: bun test __tests__/emulator-transport-abort.test.ts
 */
import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test'

let instance = 1
let pending: Uint8Array[] = []
const writes: Uint8Array[] = []
mock.module('../src/bun/emulator', () => ({
  emuWrite: (data: Uint8Array) => { writes.push(data); return true },
  emuRead: () => pending.shift() ?? null,
  getEmulatorStatus: () => ({ state: instance ? 'running' : 'stopped' }),
  getEmulatorInstance: () => instance,
}))
const { EmulatorTransportDelegate } = await import('../src/bun/emulator-transport')

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function outcome(p: Promise<unknown>, ms: number) {
  return Promise.race([
    p.then(() => 'resolved', (e: any) => `rejected: ${e?.message}`),
    sleep(ms).then(() => 'pending'),
  ])
}

afterEach(() => { instance = 1; pending = []; writes.length = 0; setSystemTime() })

describe('EmulatorTransportDelegate', () => {
  test('a pending read ends within a poll of disconnect, and nothing more is written', async () => {
    const delegate = new EmulatorTransportDelegate()
    await delegate.connect()
    const read = delegate.readChunk(false)
    await sleep(20)
    await delegate.disconnect()
    expect(await outcome(read, 200)).toContain('rejected: [emu-transport] Read aborted: transport disconnected')
    await expect(delegate.writeChunk(new Uint8Array(64))).rejects.toThrow('Write refused')
    expect(writes).toHaveLength(0)
  })

  test('a pending read ends when the emulator it connected to stops, even if it boots again', async () => {
    const delegate = new EmulatorTransportDelegate()
    await delegate.connect()
    const read = delegate.readChunk(false)
    await sleep(20)
    instance = 2 // stopEmulator() then initEmulator() in one tick, as emulatorSwitchWallet does
    pending = [new Uint8Array(64).fill(0x3f)] // the next boot's reply must stay in the ring
    expect(await outcome(read, 200)).toContain('rejected: [emu-transport] Read aborted: emulator stopped')
    expect(pending).toHaveLength(1)
    await expect(delegate.writeChunk(new Uint8Array(64))).rejects.toThrow('Write refused: emulator stopped')
  })

  test('a connected read still returns frames, and no time ends it', async () => {
    const delegate = new EmulatorTransportDelegate()
    await delegate.connect()
    const read = delegate.readChunk(false)
    // Ten minutes pass: past the old 240 s and 360 s delegate deadlines, and past the
    // 512 s wrong-PIN countdown at 9 failures. Callers own their deadlines.
    setSystemTime(new Date(Date.now() + 600_000))
    await sleep(30)
    expect(await outcome(read, 10)).toBe('pending')
    const frame = new Uint8Array(64).fill(7)
    pending = [frame]
    expect(await read).toBe(frame)
    await delegate.writeChunk(new Uint8Array(64))
    expect(writes).toHaveLength(1)
  })
})
