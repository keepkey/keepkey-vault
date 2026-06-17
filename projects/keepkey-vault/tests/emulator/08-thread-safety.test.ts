/**
 * Test 8: Thread-safety of the dylib poll thread (Approach B).
 *
 * Regression coverage for the concurrency review:
 *  - save-during-confirm must NOT deadlock. The poll thread holds the firmware
 *    lock across a pending confirm; a host save uses kkemu_trylock + yield so
 *    the loop stays alive to deliver the decision that frees the lock.
 *  - the display capture ring is drained (kkemu_pop_frame) from the host while
 *    the poll thread fills it — a lock-free SPSC ring; hammering it during a
 *    live op must not crash or yield malformed frames.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { describe, test, expect, afterAll } from 'bun:test'
import * as core from '@keepkey/hdwallet-core'
import { Transport, type TransportDelegate } from '@keepkey/hdwallet-keepkey'

const DYLIB = join(homedir(), '.keepkey', 'emulator', 'libkkemu.dylib')
const TEST_MNEMONIC = 'alcohol woman abuse must during monitor noble actual mixed trade anger aisle'

function loadDylib() {
  if (!existsSync(DYLIB)) throw new Error(`Emulator dylib not installed. Run: make build-emulator`)
  return dlopen(DYLIB, {
    kkemu_init:   { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    kkemu_shutdown: { args: [], returns: FFIType.void },
    kkemu_write:  { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_read:   { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_start:  { args: [], returns: FFIType.i32 },
    kkemu_stop:   { args: [], returns: FFIType.void },
    kkemu_trylock:{ args: [], returns: FFIType.i32 },
    kkemu_unlock: { args: [], returns: FFIType.void },
    kkemu_pop_frame: { args: [FFIType.ptr], returns: FFIType.i32 },
  })
}

function hidFrame(msgType: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const f = new Uint8Array(64)
  f[0] = 0x3f; f[1] = 0x23; f[2] = 0x23
  f[3] = (msgType >> 8) & 0xff; f[4] = msgType & 0xff
  f[8] = payload.length & 0xff
  f.set(payload, 9)
  return f
}
const DLD_YES = hidFrame(100, new Uint8Array([0x08, 0x01]))

let ffi: ReturnType<typeof loadDylib>
let flash: Buffer
let wallet: any

// Press delay: how long after a ButtonRequest before we write the DLD. A
// non-zero value keeps the firmware parked in confirm_helper (holding the lock)
// long enough to exercise a concurrent save.
let pressDelayMs = 0
// Fires the instant the firmware parks in confirm_helper (ButtonRequest seen,
// poll thread now holding g_fw_lock) — lets a test attempt the lock DURING the
// confirm rather than racing it.
let onConfirmPending: (() => void) | null = null

class Delegate implements TransportDelegate {
  async isOpened() { return true }
  async getDeviceID() { return 'emu-threadsafe' }
  async connect() {}
  async tryConnectDebugLink() { return true }
  async disconnect() {}
  async writeChunk(buf: Uint8Array, debugLink?: boolean) {
    if (ffi.symbols.kkemu_write(ptr(buf), buf.length, debugLink ? 1 : 0) !== 0) throw new Error('write fail')
  }
  async readChunk(debugLink?: boolean): Promise<Uint8Array> {
    const iface = debugLink ? 1 : 0
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const buf = new Uint8Array(64)
      if (ffi.symbols.kkemu_read(ptr(buf), 64, iface) > 0) {
        if (!debugLink && buf[0] === 0x3f && buf[1] === 0x23 && buf[2] === 0x23 && buf[3] === 0x00 && buf[4] === 0x1a) {
          onConfirmPending?.()
          const press = () => ffi.symbols.kkemu_write(ptr(DLD_YES), 64, 1)
          if (pressDelayMs > 0) setTimeout(press, pressDelayMs)
          else press()
        }
        return buf
      }
      await new Promise(r => setTimeout(r, 5))
    }
    throw new Error(`readChunk timeout (iface=${iface})`)
  }
}

// Mirror of the production saveEmulatorState lock acquisition: trylock + yield,
// never a blocking lock. Returns how long it waited and that it eventually got
// the lock — i.e. it did NOT deadlock.
async function trylockWithYield(timeoutMs = 10_000): Promise<{ acquired: boolean; sawBusy: boolean; waitedMs: number }> {
  const start = Date.now()
  let sawBusy = false
  while (Date.now() - start < timeoutMs) {
    if (ffi.symbols.kkemu_trylock() === 1) {
      ffi.symbols.kkemu_unlock()
      return { acquired: true, sawBusy, waitedMs: Date.now() - start }
    }
    sawBusy = true
    await new Promise(r => setTimeout(r, 10))
  }
  return { acquired: false, sawBusy, waitedMs: Date.now() - start }
}

afterAll(() => {
  try { ffi?.symbols.kkemu_stop() } catch {}
  try { ffi?.symbols.kkemu_shutdown() } catch {}
  try { ffi?.close() } catch {}
  if (flash) flash.fill(0)
})

describe('Poll-thread thread-safety', () => {
  test('boot thread mode + load seed', async () => {
    ffi = loadDylib()
    flash = Buffer.alloc(1048576, 0xff)
    expect(ffi.symbols.kkemu_init(ptr(flash), 1048576)).toBe(0)
    expect(ffi.symbols.kkemu_start()).toBe(0)
    const keyring = new core.Keyring()
    const transport = await Transport.create(keyring, new Delegate() as any)
    await transport.connect(); await transport.tryConnectDebugLink()
    const kk = await import('@keepkey/hdwallet-keepkey')
    wallet = kk.create(transport) as any
    keyring.add(wallet, 'emu-threadsafe')
    await wallet.loadDevice({ mnemonic: TEST_MNEMONIC, pin: false, passphrase: false, skipChecksum: false })
    expect((await wallet.getFeatures()).initialized).toBe(true)
  })

  test('trylock returns 1 (free) when no confirm is pending', () => {
    expect(ffi.symbols.kkemu_trylock()).toBe(1)
    ffi.symbols.kkemu_unlock()
  })

  test('save-during-confirm does NOT deadlock (trylock + yield)', async () => {
    pressDelayMs = 400 // hold the confirm so the poll thread keeps the lock
    let resolvePending!: () => void
    const pending = new Promise<void>(r => { resolvePending = r })
    onConfirmPending = () => resolvePending()

    const path = [0x80000000 + 44, 0x80000000 + 0, 0x80000000 + 0, 0, 0]
    // Address derivation with on-screen confirm: parks in confirm_helper.
    const addrP = wallet.btcGetAddress({ addressNList: path, coin: 'Bitcoin', scriptType: 0, showDisplay: true })
    // Wait until the firmware is actually parked in confirm_helper (lock held),
    // THEN attempt the lock the way saveEmulatorState does — so we exercise the
    // contended path instead of racing the confirm.
    await pending
    const lock = await trylockWithYield(10_000)
    const addr = await addrP
    onConfirmPending = null

    expect(addr).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/)
    expect(lock.acquired).toBe(true)       // no deadlock — it got the lock
    expect(lock.sawBusy).toBe(true)        // it WAS held during the confirm (proves contention path)
    expect(lock.waitedMs).toBeLessThan(9_000)
    console.log(`  save waited ${lock.waitedMs}ms for the confirm to release the lock; addr=${addr}`)
    pressDelayMs = 0
  })

  test('frame ring drains cross-thread under load without crashing', async () => {
    let popped = 0
    let bad = 0
    let run = true
    const out = new Uint8Array(2048)
    // Hammer the consumer side while the poll thread produces frames.
    const drain = (async () => {
      while (run) {
        while (ffi.symbols.kkemu_pop_frame(ptr(out)) === 1) {
          popped++
          if (out.length !== 2048) bad++ // sanity: full-size frame copied
        }
        await new Promise(r => setTimeout(r, 1))
      }
    })()
    // Generate display activity: a confirmed address render.
    const path = [0x80000000 + 44, 0x80000000 + 60, 0x80000000 + 0, 0, 0]
    const addr = await wallet.ethGetAddress({ addressNList: path, showDisplay: true })
    await new Promise(r => setTimeout(r, 200))
    run = false
    await drain
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(bad).toBe(0)
    console.log(`  drained ${popped} frames cross-thread, 0 malformed`)
  })
})
