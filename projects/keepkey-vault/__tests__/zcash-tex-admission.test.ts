import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function fixture() {
  const path = new URL('../src/bun/index.ts', import.meta.url)
  const source = ts.createSourceFile('index.ts', readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'texRecovery')!
  const js = ts.transpileModule(fn.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const state = { active: 0, viewingReads: 0 }
  let reject!: (error: Error) => void
  const pending = new Promise<void>((_, no) => { reject = no })
  const recovery = new Function('zcashPrivacyEnabled', 'engine', 'isZcashSendInFlight', 'beginZcashSend', 'endZcashSend', 'ensureFvkLoaded', `${js}; return texRecovery`)(
    true, { wallet: {}, isEmulator: false }, () => state.active > 0,
    () => { state.active++ }, () => { state.active-- },
    () => { state.viewingReads++; return pending },
  )
  return { recovery, state, reject }
}

test('TEX recovery cannot touch a viewing key or pending native PCZT while a send is active', async () => {
  const f = fixture(); f.state.active = 1
  await expect(f.recovery('complete', 0)).rejects.toThrow('already in progress')
  expect(f.state).toEqual({ active: 1, viewingReads: 0 })
})
test('the whole TEX operation reserves before its first await and releases after preparation failure', async () => {
  const f = fixture()
  const operation = f.recovery('shieldBack', 0)
  expect(f.state).toEqual({ active: 1, viewingReads: 1 })
  await expect(f.recovery('complete', 1)).rejects.toThrow('already in progress')
  expect(f.state.viewingReads).toBe(1)
  f.reject(new Error('synthetic preparation failure'))
  await expect(operation).rejects.toThrow('synthetic preparation failure')
  expect(f.state.active).toBe(0)
})
