import { expect, test } from 'bun:test'
import { DEFAULT_PIONEER_API_BASE, isActivePioneerServer, resolvePioneerApiBase } from '../src/shared/pioneer-server'

test('an unset in-app selection uses the official API', () => {
  for (const saved of [undefined, null, '', '  ']) expect(resolvePioneerApiBase(saved)).toBe(DEFAULT_PIONEER_API_BASE)
})

test('an in-app selection remains authoritative and normalizes trailing slashes', () => {
  expect(resolvePioneerApiBase(' https://selected.example/// ')).toBe('https://selected.example')
  expect(resolvePioneerApiBase('http://localhost:9001/')).toBe('http://localhost:9001')
})

test('an unlisted active URL never marks the first saved server active', () => {
  const actual = 'https://selected.example'
  expect(isActivePioneerServer(actual, DEFAULT_PIONEER_API_BASE)).toBe(false)
  expect(isActivePioneerServer(actual, actual + '/')).toBe(true)
  expect(isActivePioneerServer('', DEFAULT_PIONEER_API_BASE)).toBe(false)
})
