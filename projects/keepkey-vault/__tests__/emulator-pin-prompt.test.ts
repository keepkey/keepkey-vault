import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The emulator window showed "Enter current PIN" after the PIN was already in.
test('the emulator PIN instructions clear once the device stops asking', () => {
  const index = readFileSync(join(import.meta.dir, '../src/bun/index.ts'), 'utf8')
  const win = readFileSync(join(import.meta.dir, '../src/bun/emulator-window.ts'), 'utf8')
  const listener = index.slice(index.indexOf("engine.on('state-change', (state) => {\n\tif (!emulatorPinPromptShown"), index.indexOf("engine.on('pin-error'"))
  expect(listener).toContain('if (!emulatorPinPromptShown || state.pinPromptOpen) return')
  expect(listener).toContain('clearPinPrompt()')
  expect(win.slice(win.indexOf('export function clearPinPrompt'), win.indexOf('export function clearPinPrompt') + 120)).toContain("sendToWindow('confirm-dismiss', {})")
  // the engine closes the prompt when the PIN is sent and when the device refuses it
  const engine = readFileSync(join(import.meta.dir, '../src/bun/engine-controller.ts'), 'utf8')
  expect(engine.slice(engine.indexOf('async sendPin('), engine.indexOf('async sendPin(') + 500)).toContain('this.setPinPromptOpen(false)')
})
