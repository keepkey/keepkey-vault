/** Native-window regression driver. Runs in a child process so module mocks
 * cannot replace Electrobun or the emulator in unrelated backend tests. */
import { mock } from 'bun:test'
import { strict as assert } from 'node:assert'

const stateDir = process.env.KK_EMULATOR_WINDOW_TEST_DIR
if (!stateDir) throw new Error('A temporary emulator-window test directory is required')

class FakeWindow {
  static instances: FakeWindow[] = []
  handlers = new Map<string, () => void>()
  packets: string[] = []
  webview = {
    executeJavascript: (script: string) => { this.packets.push(script) },
    loadHTML: (html: string) => { this.options.html = html },
  }
  constructor(public options: any) { FakeWindow.instances.push(this) }
  on(event: string, callback: () => void) { this.handlers.set(event, callback) }
  getFrame() { return this.options.frame }
  close() { /* Native close notifications arrive later, after replacement. */ }
  emitClose() { this.handlers.get('close')?.() }
}

const bridges: Array<{ fetch: (request: Request) => Response | Promise<Response>; stopped: boolean }> = []
const frames: Uint8Array[] = []
let frameReads = 0
const originalServe = Bun.serve
Bun.serve = ((options: any) => {
  const bridge = { fetch: options.fetch, stopped: false }
  bridges.push(bridge)
  return { port: 41000 + bridges.length, stop() { bridge.stopped = true } }
}) as typeof Bun.serve

mock.module('electrobun/bun', () => ({ BrowserWindow: FakeWindow, BrowserView: { defineRPC: () => ({}) } }))
mock.module('os', () => ({ homedir: () => stateDir }))
mock.module('../emulator', () => ({
  getActiveFlashName: () => 'fixture-wallet',
  emuPopFrames: () => { frameReads++; return frames.splice(0) },
}))
mock.module('../test-review-tape', () => ({ recordReviewScreen() {}, reviewTapeRecording: () => false }))

const emulatorWindow = await import('../emulator-window')
const ready = (index: number, overrideLoadId?: string) => {
  // Simulate the ready message emitted by this window's current HTML, including
  // a replacement HTML load if recovery retried before the view became ready.
  const loadId = /postBridge\('\/_emu\/ready', \{ loadId: '([^']+)' \}\)/.exec(FakeWindow.instances[index].options.html)?.[1]
  assert(loadId, 'the emulator HTML includes its ready-message load ID')
  return bridges[index].fetch(new Request('http://127.0.0.1/_emu/ready', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loadId: overrideLoadId ?? loadId }),
  }))
}

try {
  // Close before the display module's dynamic import settles, then replace it.
  emulatorWindow.openEmulatorWindow()
  const oldWindow = FakeWindow.instances[0]
  emulatorWindow.closeEmulatorWindow()
  emulatorWindow.openEmulatorWindow()
  const replacement = FakeWindow.instances[1]
  assert.equal((await ready(1, 'a-retired-html-load')).status, 410, 'a stale HTML load cannot mark the replacement view ready')
  emulatorWindow.displayPinPrompt('current')
  assert(!replacement.packets.some(packet => packet.includes('pin-request')), 'a stale ready message must not enable script injection')
  await ready(1)
  oldWindow.emitClose()
  assert.equal(emulatorWindow.isEmulatorWindowOpen(), true, 'late old close must preserve the replacement window')
  assert.equal(bridges[1].stopped, false, 'late old close must preserve the replacement bridge')

  emulatorWindow.displayPinPrompt('current')
  assert(replacement.packets.some(packet => packet.includes('pin-request')), 'replacement still receives prompt instructions')
  assert.equal((await ready(0)).status, 410, 'a retired bridge cannot mark another window ready')

  frames.push(new Uint8Array(2048).fill(0x55))
  await Bun.sleep(180)
  assert(replacement.packets.some(packet => packet.includes('display-update')), 'replacement receives live firmware frames after the late close')

  replacement.emitClose()
  assert.equal(emulatorWindow.isEmulatorWindowOpen(), false, 'current native close retires the active window')
  assert.equal(bridges[1].stopped, true, 'current native close retires its bridge')

  // A pending import must not restart polling after an immediate close.
  emulatorWindow.openEmulatorWindow()
  emulatorWindow.closeEmulatorWindow()
  await Bun.sleep(100)
  const readsAfterClose = frameReads
  await Bun.sleep(150)
  assert.equal(frameReads, readsAfterClose, 'a cancelled display start must not resurrect polling')
  console.log('emulator window lifecycle: late close, bridge ownership, frame playback, and cancelled start passed')
} finally {
  emulatorWindow.closeEmulatorWindow()
  emulatorWindow.stopDisplayPoll()
  Bun.serve = originalServe
}
