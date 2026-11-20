// One chain's failed read is a miss for that chain, never "Balance server
// unavailable": a pioneer-error without a severity is the hard outage banner
// (rpc-schema.ts). Only the full portfolio read may claim the server is down.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const file = new URL('../src/bun/index.ts', import.meta.url)
const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
let body = ''
ts.forEachChild(source, node => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'getChainBalance') body = node.getText(source)
})

test('getChainBalance never sends the hard (severity-less) outage error', () => {
  expect(body).not.toBe('')
  expect(body).not.toContain("rpc.send['pioneer-error']")
})

test('a failed chain read is reported as a per-chain warning', () => {
  const catches = body.split('} catch (e: any) {').slice(1).join('')
  expect(catches).toMatch(/sendPortfolioFault\(\{[^}]*severity: 'warning'[^}]*degradedChainIds: \[chain\.id\]/s)
})
