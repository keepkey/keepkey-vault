import { addressIndicesFromTokens } from './address-discovery'

let pass = 0
function eq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`FAIL ${label}: got ${String(actual)} want ${String(expected)}`)
  pass++
}

const result = addressIndicesFromTokens([
  { path: "m/84'/0'/0'/0/0", transfers: 2 },
  { path: "m/84'/0'/0'/0/8", transfers: 1 },
  { path: "m/84'/0'/0'/1/3", transfers: 5 },
  { path: "m/84'/0'/0'/1/99", transfers: 0 },
  { path: "m/84'/0'/0'/2/7", transfers: 9 },
  { path: "m/84'/0'/0'/0/not-a-number", transfers: 1 },
  null,
], 'blockbook')

eq(result.receiveIndex, 9, 'highest used receive + 1')
eq(result.changeIndex, 4, 'highest used change + 1')
eq(result.discoveryAvailable, true, 'discovery marked available')
eq(result.source, 'blockbook', 'source preserved')

const empty = addressIndicesFromTokens([], 'pioneer')
eq(empty.receiveIndex, 0, 'empty receive starts at zero')
eq(empty.changeIndex, 0, 'empty change starts at zero')

console.log(`[btc-backend] address discovery OK — ${pass} assertions passed`)
