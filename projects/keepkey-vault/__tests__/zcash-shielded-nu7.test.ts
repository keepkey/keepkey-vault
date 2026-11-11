import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { ZCASH_NU7_ACTIVATION_HEIGHT, ZCASH_SHIELDED_NU7_REFUSAL, zcashShieldedNu7Refusal } from '../src/shared/zcash-nu7'

const source = (path: string) => {
  const file = new URL(path, import.meta.url)
  return ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

test('a known chain height at or past NU7 refuses every shielded build; unknown defers to the sidecar', () => {
  // The next block (the inclusion height) is what decides the branch.
  expect(zcashShieldedNu7Refusal(ZCASH_NU7_ACTIVATION_HEIGHT - 2)).toBeUndefined()
  expect(zcashShieldedNu7Refusal(ZCASH_NU7_ACTIVATION_HEIGHT - 1)).toBe(ZCASH_SHIELDED_NU7_REFUSAL)
  expect(zcashShieldedNu7Refusal(3_559_307)).toBe(ZCASH_SHIELDED_NU7_REFUSAL)
  for (const unknown of [null, undefined, NaN, 3_559_307.5]) expect(zcashShieldedNu7Refusal(unknown as any)).toBeUndefined()
})

test('the refusal is plain language and identical in the host and the Rust sidecar', () => {
  const rust = readFileSync(new URL('../zcash-cli/src/pczt_builder.rs', import.meta.url), 'utf8')
  const constant = rust.match(/pub const SHIELDED_NU7_REFUSAL: &str = "([^"]+)";/)
  expect(constant?.[1]).toBe(ZCASH_SHIELDED_NU7_REFUSAL)
  expect(ZCASH_SHIELDED_NU7_REFUSAL).not.toMatch(/0x|branch|PCZT|Ironwood/)
  // The raw developer message this replaces.
  expect(rust).not.toContain('Ironwood transactions require NU6.3 branch')
})

test('every Desktop shielded operation refuses before its first await (viewing-key export, PIN, device or proof)', () => {
  const index = source('../src/bun/index.ts')
  const handlers = new Map<string, ts.Block>()
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
      && ['zcashShieldedSend', 'zcashShieldZec', 'zcashDeshieldZec'].includes(node.name.text)
      && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body)) handlers.set(node.name.text, node.initializer.body)
    ts.forEachChild(node, visit)
  }
  visit(index)
  expect([...handlers.keys()].sort()).toEqual(['zcashDeshieldZec', 'zcashShieldZec', 'zcashShieldedSend'])
  const hasAwait = (node: ts.Node): boolean => ts.isAwaitExpression(node) || ts.forEachChild(node, hasAwait) === true
  for (const [name, body] of handlers) {
    const guard = body.statements.findIndex(s => s.getText(index) === 'refuseShieldedUnderNu7()')
    expect(guard, name).toBeGreaterThan(-1)
    expect(body.statements.slice(0, guard).some(hasAwait), name).toBe(false)
    expect(body.statements.slice(0, guard).map(s => s.getText(index)).join('\n'), name).not.toContain('ensureFvkLoaded')
  }
  const guard = index.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'refuseShieldedUnderNu7')!
  expect(guard.getText(index)).toContain('zcashShieldedNu7Refusal(getScanState().syncedTo)')
})
